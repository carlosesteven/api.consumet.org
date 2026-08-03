# Base de datos del cache persistente de AniList (`media` + relacionadas)

Documentación de referencia para inspeccionar/probar la capa de persistencia
descrita en [`plans/meta-persistent-cache.md`](./plans/meta-persistent-cache.md).
Cubre: qué guarda cada tabla, cómo conectarse, y queries para probar el
comportamiento (incluido el fallback cuando AniList está caído).

## Cómo conectarse

Las credenciales viven en tu `.env` local (nunca en este repo — ver
`.env.example` y la sección "Seguridad: credenciales de la DB" del plan).

```bash
source .env  # o exportá las variables manualmente
PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME"
```

Para salir de `psql`: `\q`.

## Cómo se llena esta base

No hay un job de importación masiva. Las filas se crean/actualizan
únicamente como efecto secundario de tráfico real (o de pruebas) contra
estos endpoints:

- `GET /meta/anilist/data/:id` (anime)
- `GET /meta/anilist-manga/info/:id` (manga)

Cada vez que uno de estos dos endpoints logra un fetch en vivo exitoso a
AniList, hace un `UPSERT` de esa ficha completa (ver `src/utils/metaCache/write.ts`).
Los endpoints de búsqueda (`/meta/anilist/advanced-search`,
`/meta/anilist-manga/:query`) **no escriben** en esta base — solo la leen
como fallback (ver `src/utils/metaCache/read.ts` y el plan, sección
"Fallback de búsqueda").

Si la tabla está vacía, primero hacé un par de llamadas reales:

```bash
curl -s http://localhost:3000/meta/anilist/data/185211 > /dev/null
curl -s http://localhost:3000/meta/anilist-manga/info/30013 > /dev/null
```

## Las 7 tablas

### `media`
La tabla principal — una fila por ficha de AniList (anime o manga comparten
el mismo espacio de ids, ver el plan). Columnas más relevantes:

| Columna | Qué es |
|---|---|
| `id` | id de AniList (PK) |
| `media_type` | `ANIME` o `MANGA`, derivado de `format` (ver más abajo) |
| `mal_id` | id equivalente en MyAnimeList, si existe |
| `title_romaji` / `title_english` / `title_native` / `title_user_preferred` | título en sus variantes |
| `synonyms` | array de títulos alternativos (solo anime) |
| `status` | texto tal cual lo devuelve AniList (`"Ongoing"`, `"Completed"`, etc.) |
| `genres`, `studios` | arrays de texto |
| `format` | valor crudo de AniList: `TV`, `MOVIE`, `OVA`... (anime) o `MANGA`, `NOVEL`, `ONE_SHOT`, `COMIC` (manga) — de acá se deriva `media_type` |
| `popularity`, `rating` | métricas de AniList |
| `image`, `cover` (+ sus `_hash`) | URLs de portada/banner |
| `start_year/month/day`, `end_year/month/day` | fecha de emisión/publicación |
| `total_episodes`, `current_episode`, `next_airing_episode` | solo anime |
| `total_chapters` | solo manga (cantidad de capítulos que devolvió el proveedor de lectura en el momento del fetch) |
| `updated_at` | se refresca en cada UPSERT exitoso — es lo que determina qué tan "vieja" es una fila cuando se sirve como `stale` |

### `characters`
Personajes, uno por id de AniList. Reutilizado entre fichas (un personaje
puede aparecer en varios `media`).

### `media_characters`
Tabla puente `media_id` ↔ `character_id`, con el `role` (`MAIN`,
`SUPPORTING`, etc.).

### `voice_actors`
Actores de voz (solo relevante para anime). Mismo patrón que `characters`.

### `media_character_voice_actors`
Tabla puente de 3 vías: qué actor de voz interpretó a qué personaje en qué
media, y en qué idioma (`language`).

### `media_relations`
Media relacionado (secuela, adaptación, spin-off, etc.), con un snapshot
denormalizado (título/estado/imagen/tipo) tal como lo trae AniList inline —
sin necesitar join contra otra fila de `media` que quizás nunca se cacheó.

### `media_recommendations`
Igual que `media_relations` pero para recomendaciones, más el campo
`rating` (score de la recomendación en AniList).

## Queries para probar

**Ver todo lo que hay cacheado, lo más reciente primero:**
```sql
SELECT id, media_type, title_romaji, format, status, popularity, updated_at
FROM media
ORDER BY updated_at DESC;
```

**Ficha completa por id:**
```sql
SELECT * FROM media WHERE id = 185211;
```

**Contar filas por tabla:**
```sql
SELECT 'media' AS tabla, count(*) FROM media
UNION ALL SELECT 'characters', count(*) FROM characters
UNION ALL SELECT 'voice_actors', count(*) FROM voice_actors
UNION ALL SELECT 'media_characters', count(*) FROM media_characters
UNION ALL SELECT 'media_character_voice_actors', count(*) FROM media_character_voice_actors
UNION ALL SELECT 'media_relations', count(*) FROM media_relations
UNION ALL SELECT 'media_recommendations', count(*) FROM media_recommendations;
```

**Personajes + actores de voz de una ficha (join completo):**
```sql
SELECT c.name_full AS personaje, mc.role, va.name_full AS actor_voz, mcva.language
FROM media_characters mc
JOIN characters c ON c.id = mc.character_id
LEFT JOIN media_character_voice_actors mcva
  ON mcva.media_id = mc.media_id AND mcva.character_id = mc.character_id
LEFT JOIN voice_actors va ON va.id = mcva.voice_actor_id
WHERE mc.media_id = 185211;
```

**Relaciones y recomendaciones de una ficha:**
```sql
SELECT * FROM media_relations WHERE media_id = 185211;
SELECT * FROM media_recommendations WHERE media_id = 185211;
```

**Simular el fallback de búsqueda** (el mismo `ILIKE` que corre
`/advanced-search` y `/manga/:query` cuando AniList está caído — solo
encuentra lo que ya pasó antes por `/data/:id` o `/manga/info/:id`):
```sql
SELECT id, title_romaji, title_english, popularity
FROM media
WHERE media_type = 'ANIME'
  AND (title_romaji ILIKE '%naruto%'
       OR title_english ILIKE '%naruto%'
       OR title_native ILIKE '%naruto%')
ORDER BY popularity DESC NULLS LAST
LIMIT 10;
```
(cambiar `'ANIME'` por `'MANGA'` para probar el fallback de
`/meta/anilist-manga/:query`)

**Ver qué tan "vieja" está una fila** (para razonar si un `stale:true` que
devolvió la API tiene sentido):
```sql
SELECT id, title_romaji, updated_at, now() - updated_at AS antiguedad
FROM media
ORDER BY updated_at ASC
LIMIT 10;
```

## Probar el flujo completo end-to-end

1. Pedí una ficha real (esto debería insertar/actualizar la fila):
   ```bash
   curl -s http://localhost:3000/meta/anilist/data/185211 | head -c 300
   ```
2. Confirmá que quedó en la base:
   ```sql
   SELECT id, media_type, title_romaji, updated_at FROM media WHERE id = 185211;
   ```
3. Para probar el fallback sin esperar a que AniList realmente se caiga,
   basta con cortar la conectividad de salida hacia `graphql.anilist.co`
   (por ejemplo bloqueando el dominio a nivel de firewall/hosts) y repetir
   el paso 1: debería responder igual, con `"stale": true` y un
   `"cachedAt"` con la fecha del último fetch exitoso — ver "Orden de
   resolución" en [`plans/meta-persistent-cache.md`](./plans/meta-persistent-cache.md).

## Dónde está el código

| Qué | Archivo |
|---|---|
| Pool de conexión | `src/utils/db.ts` |
| Mapper de escritura (UPSERT) | `src/utils/metaCache/write.ts` |
| Mapper de lectura (filas → respuesta) + búsqueda `ILIKE` | `src/utils/metaCache/read.ts` |
| Wrappers Redis → vivo → Postgres | `src/utils/metaCache/fallback.ts` |
| Derivación de `media_type` desde `format` | `src/utils/metaCache/format.ts` |
| Migración de las 7 tablas | `migrations/0001_meta_persistent_cache.sql` |
