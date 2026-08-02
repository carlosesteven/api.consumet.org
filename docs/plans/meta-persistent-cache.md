# Plan: capa de persistencia permanente para meta (Anilist anime + manga)

## Problema

Cuando AniList cae por varias horas, el TTL de Redis (`REDIS_TTL`,
`src/utils/cache.ts`) expira y el endpoint vuelve a pegarle en vivo a la API
caída. Confirmado en producción: `/meta/anilist/data/185211` devolvió
`{"statusCode":500,"error":"Internal Server Error","message":"Media not found"}`
mientras AniList respondía 403 ("temporarily disabled due to severe stability
issues").

## Alcance real (confirmado en producción)

Solo 4 endpoints están en uso real, no los 4 archivos completos de `meta/`:

| Endpoint | Función en `@consumet/extensions` | Tipo |
|---|---|---|
| `/meta/anilist/data/:id` | `fetchAnilistInfoById` | ficha (anime) |
| `/meta/anilist/advanced-search?query=...` | `advancedSearch` | búsqueda libre (anime) |
| `/meta/anilist-manga/:query` | `search` | búsqueda libre (manga) |
| `/meta/anilist-manga/info/:id` | `fetchMangaInfo` | ficha (manga) |

`mal.ts` y `tmdb.ts` quedan **fuera de alcance** — no se usan en producción.
`/meta/anilist/info/:id` (con episodios y proveedor) y
`/meta/anilist-manga/chapters|read` tampoco se usan — quedan fuera porque
dependen del proveedor de streaming/lectura y no son solo metadata de AniList.

## Decisión de arquitectura

Vive en **este proyecto** (`scrape.csc-lab-api.xyz`), no en `@consumet/extensions`:
librería genérica y stateless, este proyecto ya tiene la capa de Redis y las
rutas, y la dependencia está fijada a un commit de git (iterar ahí es más
lento que iterar aquí).

## Por qué 1 sola tabla para anime + manga (`media`)

Verificado en `src/utils/queries.ts` — `anilistMediaDetailQuery(id)` es la
**misma query GraphQL** usada por `fetchAnilistInfoById` (anime) y
`fetchMangaInfo` (manga):

```graphql
query ($id: Int = 185211) { Media(id: $id) { id idMal title { ... } type format status ... } }
```

No filtra por `type`. Esto es posible porque en el modelo real de AniList
**el campo `id` es un espacio de numeración único y compartido entre anime y
manga** (a diferencia de MAL, que sí separa los ids por tipo). Es decir: un id
nunca pertenece simultáneamente a un anime y a un manga.

Consecuencias para el esquema:
- `media.id` (el id de AniList) es PK única — **no** hace falta clave
  compuesta con `media_type`, porque no puede haber colisión.
- El `media_type` (ANIME/MANGA) se guarda leyendo el campo `type` que la
  propia respuesta de AniList trae, **no** asumiendo según qué endpoint hizo
  la petición (la query no valida que el id corresponda al tipo esperado por
  el endpoint que la llamó).
- Characters, relations y recommendations son genuinamente cross-type en
  AniList (una adaptación de manga apunta a un id de anime y viceversa), así
  que un modelo unificado además es más correcto que separar en dos tablas.

## Esquema de tablas (7 tablas)

```sql
CREATE TYPE media_type_enum AS ENUM ('ANIME', 'MANGA');

CREATE TABLE media (
  id                 INTEGER PRIMARY KEY,        -- id de AniList, global (anime+manga)
  media_type         media_type_enum NOT NULL,   -- leído de Media.type en la respuesta
  mal_id             INTEGER,
  title_romaji       TEXT,
  title_english      TEXT,
  title_native       TEXT,
  title_user_preferred TEXT,
  synonyms           TEXT[],
  description        TEXT,
  status             TEXT,                       -- MediaStatus mapeado (ONGOING, COMPLETED, ...)
  genres             TEXT[],
  studios            TEXT[],                     -- solo nombres, AniList no da id de studio
  season             TEXT,
  country_of_origin  TEXT,
  is_adult           BOOLEAN,
  is_licensed        BOOLEAN,
  format             TEXT,                       -- TV, MOVIE, MANGA, ONE_SHOT, etc.
  duration           INTEGER,                    -- solo anime
  rating             INTEGER,                    -- averageScore
  popularity         INTEGER,
  color              TEXT,
  image              TEXT,
  image_hash         TEXT,
  cover              TEXT,
  cover_hash         TEXT,
  start_year         INTEGER,
  start_month        INTEGER,
  start_day          INTEGER,
  end_year           INTEGER,
  end_month          INTEGER,
  end_day            INTEGER,
  trailer_id         TEXT,
  trailer_site       TEXT,
  trailer_thumbnail  TEXT,
  trailer_thumbnail_hash TEXT,
  total_episodes     INTEGER,                    -- solo anime
  current_episode    INTEGER,                    -- solo anime
  next_airing_episode JSONB,                     -- {airingTime, timeUntilAiring, episode} - pequeño, transitorio
  total_chapters     INTEGER,                    -- solo manga
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_media_type ON media (media_type);
CREATE INDEX idx_media_genres ON media USING GIN (genres);
-- para el fallback de búsqueda por texto (ver más abajo)
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX idx_media_title_trgm ON media USING GIN (
  (coalesce(title_romaji,'') || ' ' || coalesce(title_english,'') || ' ' || coalesce(title_native,'')) gin_trgm_ops
);

CREATE TABLE characters (
  id                 INTEGER PRIMARY KEY,        -- id de character en AniList
  name_first         TEXT,
  name_last          TEXT,
  name_full          TEXT,
  name_native        TEXT,
  name_user_preferred TEXT,
  image              TEXT,
  image_hash         TEXT
);

CREATE TABLE media_characters (
  media_id           INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  character_id       INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  role               TEXT,
  PRIMARY KEY (media_id, character_id)
);

CREATE TABLE voice_actors (                       -- solo aplica a anime
  id                 INTEGER PRIMARY KEY,
  name_first         TEXT,
  name_last          TEXT,
  name_full          TEXT,
  name_native        TEXT,
  name_user_preferred TEXT,
  image              TEXT,
  image_hash         TEXT
);

CREATE TABLE media_character_voice_actors (
  media_id           INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  character_id       INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  voice_actor_id     INTEGER NOT NULL REFERENCES voice_actors(id) ON DELETE CASCADE,
  language           TEXT,
  PRIMARY KEY (media_id, character_id, voice_actor_id, language)
);

-- sin FK estricta hacia media(id): relations/recommendations pueden apuntar
-- a un id que todavía no se ha cacheado directamente (ni siquiera con el mismo
-- media_type, ya que una relación puede cruzar anime <-> manga)
CREATE TABLE media_relations (
  media_id           INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  related_media_id   INTEGER NOT NULL,
  relation_type      TEXT,
  -- snapshot denormalizado: lo que AniList ya entrega inline, sin necesidad de join
  snapshot_title      TEXT,
  snapshot_status     TEXT,
  snapshot_image      TEXT,
  snapshot_type       TEXT,
  PRIMARY KEY (media_id, related_media_id)
);

CREATE TABLE media_recommendations (
  media_id             INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  recommended_media_id INTEGER NOT NULL,
  rating               INTEGER,
  snapshot_title        TEXT,
  snapshot_status       TEXT,
  snapshot_image        TEXT,
  snapshot_type         TEXT,
  PRIMARY KEY (media_id, recommended_media_id)
);
```

## Fallback de búsqueda (`advanced-search`, `/:query` de manga)

Confirmado en producción (apps Kotlin): estos endpoints se usan con
**texto libre** (`?query=nombre`) y paginación (`?page=N`), no con un `id`
fijo. No es un problema de "cachear una entidad", es un problema de búsqueda.

**No se crea tabla nueva para esto.** El fallback consulta directamente la
tabla `media` ya poblada por las fichas (`/data/:id`, `/info/:id`):

```sql
SELECT * FROM media
WHERE media_type = 'ANIME'
  AND (title_romaji ILIKE '%' || $1 || '%'
       OR title_english ILIKE '%' || $1 || '%'
       OR title_native ILIKE '%' || $1 || '%')
ORDER BY popularity DESC NULLS LAST
LIMIT $2 OFFSET $3;
```

(usando el índice `pg_trgm` de arriba para que no sea un full scan).

**Limitación a aceptar explícitamente:** el fallback de búsqueda solo
encuentra lo que ya pasó antes por `/data/:id` o `/info/:id` de este mismo
API. No es una réplica del catálogo completo de AniList — si cae AniList y
alguien busca algo nunca antes consultado, no hay resultado. Es una
degradación aceptable (mejor que un 500), no una solución completa.

## Orden de resolución (todas las rutas en alcance)

1. Redis (TTL corto, como hoy).
2. Fetch en vivo a AniList.
   - éxito → `UPSERT` en `media` (+ characters/voice_actors/relations/
     recommendations) y se devuelve.
   - falla → paso 3.
3. Postgres:
   - para `/data/:id` e `/info/:id`: `SELECT * FROM media WHERE id = $1`.
   - para `advanced-search`/`/:query`: el `SELECT ... ILIKE` de arriba.
   - si hay resultado → se devuelve con `{ stale: true, cachedAt }`.
   - si no hay nada → se propaga el error original (no inventar 200 vacío).

## Dónde engancharlo (código)

- `routes/meta/anilist.ts`:
  - `/data/:id` (línea ~254) — hoy llama directo a
    `anilist.fetchAnilistInfoById(id)` sin try/catch ni Redis. Envolver con
    el wrapper (Redis + Postgres).
  - `/advanced-search` (línea ~38) — hoy no tiene Redis tampoco. Envolver con
    el wrapper de búsqueda (Redis + fallback `ILIKE` sobre `media`).
- `routes/meta/anilist-manga.ts`:
  - `/info/:id` (línea ~24) — envolver igual que `/data/:id`.
  - `/:query` (línea ~16) — envolver igual que `advanced-search`.

Ambos wrappers (`withPersistentFallback` para ficha,
`withSearchFallback` para búsqueda) comparten la misma tabla `media`, así que
solo hay un mapper de escritura (AniList → filas relacionales) reutilizado
por los dos endpoints de ficha (anime y manga), y un solo query de búsqueda
reutilizado por los dos endpoints de búsqueda.

## Driver de DB

No hay ORM instalado (`package.json` no tiene `pg`/`mysql2`/`prisma`/
`typeorm`). Para este esquema (7 tablas, sin necesidad de migraciones
complejas) alcanza un driver crudo:
- Postgres → `pg` (pool con `pg.Pool`) — **recomendado**, por el uso de
  `pg_trgm`/GIN para el fallback de búsqueda, que es nativo de Postgres.
- MySQL sería más limitado para el fallback de búsqueda por texto (no tiene
  `pg_trgm`; habría que usar `FULLTEXT INDEX` con sintaxis distinta).

## Seguridad: credenciales de la DB

El repo es público, así que ninguna credencial va en código fuente ni en
commits — mismo tratamiento que ya recibe Redis hoy:

- `.env` ya está en `.gitignore` (verificado) — ahí van los valores reales,
  nunca se commitea.
- `.env.example` es el único archivo versionado, y solo lleva **placeholders
  descriptivos**, igual que las variables `REDIS_*` existentes:

```
DB_HOST=Postgres host (optional)
DB_PORT=Postgres port (optional)
DB_USER=Postgres user (optional)
DB_PASSWORD=Postgres password (optional)
DB_NAME=Postgres database name (optional)
```

  (variables separadas, no una `DATABASE_URL` única, para mantener la misma
  convención que ya usa `REDIS_HOST`/`REDIS_PORT`/`REDIS_PASSWORD` en este
  proyecto).
- `src/utils/db.ts` lee esas variables de `process.env` — el pool de conexión
  no debe tener ningún valor por defecto que sea una credencial real (a lo
  sumo `DB_PORT` con default `5432`, que no es secreto).
- Ningún string de conexión ni contraseña se escribe en el plan, en
  migraciones, ni en ningún archivo commiteado — todo entra por entorno en
  tiempo de despliegue (Render/Vercel/appspec, como ya se hace con
  `REDIS_PASSWORD`).

## Pasos de implementación (orden sugerido)

1. Agregar las variables de Postgres (arriba) a `.env.example` y a la tabla
   de variables de entorno en `CLAUDE.md` — solo nombres y descripción, sin
   valores reales.
2. Migración inicial: las 7 tablas + extensión `pg_trgm`.
3. Instalar `pg`, crear `src/utils/db.ts` (pool de conexión).
4. Implementar el mapper de escritura: AniList `Media` response → filas de
   `media` + `media_characters` + `media_character_voice_actors` +
   `media_relations` + `media_recommendations` (una función compartida,
   usada tanto por `/data/:id` como por `/info/:id` de manga).
5. Implementar el mapper de lectura (reconstruir `IAnimeInfo`/`IMangaInfo`
   desde las filas relacionales) para el camino de fallback.
6. Implementar `withPersistentFallback` (ficha) y `withSearchFallback`
   (búsqueda).
7. Enganchar en `/meta/anilist/data/:id` primero (el que ya vimos fallar en
   producción), verificar con AniList caído.
8. Enganchar en `/meta/anilist/advanced-search`,
   `/meta/anilist-manga/info/:id`, `/meta/anilist-manga/:query`.
9. (Opcional, no bloqueante) job de limpieza para filas de `media` sin
   actividad prolongada.

## Fuera de alcance de este plan

- `mal.ts`, `tmdb.ts` — no se usan en producción.
- `/meta/anilist/info/:id` (con episodios) y
  `/meta/anilist-manga/chapters/:id` / `/read` — dependen del proveedor de
  streaming/lectura, no son solo metadata de AniList; quedan fuera porque no
  están en uso real hoy.
- Cambios dentro de `@consumet/extensions` — el fetch en vivo sigue siendo
  responsabilidad de la librería, solo se envuelve desde afuera.
