# Mantenimiento: qué hacer si cambia la metadata de AniList

El cache persistente (`docs/plans/meta-persistent-cache.md`,
`docs/meta-persistent-cache-db.md`) es un **mapeo fijo, escrito a mano**,
no un espejo genérico de lo que devuelve AniList. Esto es una decisión de
diseño (7 tablas concretas, columnas concretas), no un descuido — pero
significa que **nada te avisa automáticamente** si AniList cambia su
esquema. Esta guía es para cuando eso pase.

## Primero: entendé qué tan acoplado está esto

Dos cosas muy distintas pueden cambiar, y cada una tiene un impacto distinto:

1. **AniList agrega/quita/renombra un campo en su API pública** — esto lo
   notarías porque `@consumet/extensions` (la librería, fijada a un commit
   de git en `package.json`) tendría que actualizarse primero para reflejarlo.
   Mientras no actualices esa dependencia, no te afecta.
2. **Actualizás `@consumet/extensions` a un commit más nuevo** y ese commit
   cambió cómo arma `IAnimeInfo`/`IMangaInfo` (la query GraphQL en
   `dist/utils/queries.js`, o el mapeo en `dist/providers/meta/anilist.js`).
   **Este es el disparador real** — acá es donde hay que revisar todo lo
   de abajo, no cuando "AniList cambia algo" en abstracto.

## Qué pasa si no hacés nada (comportamiento actual, sin cambios)

- **Campo nuevo que la librería empieza a devolver:** se ignora en
  silencio. No rompe nada, simplemente no se persiste ni se sirve en el
  fallback hasta que alguien lo agregue a mano (ver checklist abajo).
- **Campo que ya usábamos y la librería deja de devolver (o pasa a
  `undefined`):** la columna en `media` queda `NULL` en las próximas
  escrituras (el `UPSERT` sobreescribe con lo que venga, incluido `null`).
  No crashea — pero perdés ese dato para fichas nuevas/actualizadas
  (las que ya estaban en la DB con el valor viejo lo conservan hasta que
  se vuelvan a escribir).
- **Un nuevo valor de `MediaFormat` que AniList agregue** (ej. un formato
  nuevo tipo "SHORT_MANGA" que no exista hoy): `mediaTypeFromFormat()` en
  `src/utils/metaCache/format.ts` solo reconoce `MANGA`, `NOVEL`,
  `ONE_SHOT`, `COMIC` como manga — cualquier otra cosa cae a `ANIME` por
  default. Si ese formato nuevo en realidad es manga, **se clasificaría
  mal silenciosamente**. Este es el punto más frágil de todo el diseño —
  revisalo primero si algo empieza a verse raro en `media_type`.

## Checklist: agregar un campo nuevo a `media`

Ejemplo: AniList/la librería ahora expone `Media.hashtag` y querés guardarlo.

1. **Migración nueva** — nunca edites `migrations/0001_meta_persistent_cache.sql`
   (ya corrió en test y/o producción). Creá `migrations/0002_<algo>.sql`:
   ```sql
   ALTER TABLE media ADD COLUMN hashtag TEXT;
   ```
2. **`src/utils/metaCache/write.ts`** — agregá la columna a la lista de
   columnas del `INSERT INTO media (...)`, a la cláusula
   `ON CONFLICT ... DO UPDATE SET hashtag = EXCLUDED.hashtag`, y el valor
   correspondiente en el array de parámetros (`info.hashtag ?? null` o
   donde venga en el objeto de la librería).
3. **`src/utils/metaCache/read.ts`** — agregá el campo a
   `buildMediaResponse()` para que el fallback lo devuelva también cuando
   AniList está caído.
4. **Probar** — mismo patrón que ya usamos: pedí una ficha real
   (`curl .../meta/anilist/data/:id`), confirmá con
   `SELECT hashtag FROM media WHERE id = ...` que quedó, y simulá una
   caída de AniList para confirmar que el fallback también lo expone.

Si el campo nuevo es una **tabla nueva** (ej. AniList agrega "tags" con
su propia estructura, no un escalar), el patrón es el mismo que ya existe
para `media_relations`/`media_recommendations`: tabla propia, batch
upsert con `upsertBatch()` (ya existe en `write.ts`, reutilizalo en vez de
escribir un loop de queries una por una), y su reconstrucción en `read.ts`.

## Si quitás o renombrás una columna (no solo si agregás)

Esto es tan importante como agregar, y es más fácil que se rompa a medias:
**no hay ningún tipo/ORM que conecte la tabla de Postgres con `write.ts` y
`read.ts`** — son tres listas escritas a mano (la migración, las columnas
del `INSERT` en `write.ts`, y las claves de `buildMediaResponse()` en
`read.ts`) que **nadie valida que coincidan entre sí**. Si tocás una sola
de las tres y no las otras dos, no vas a tener un error obvio:

- **Quitás/renombrás la columna en la migración, pero no en `write.ts`:**
  el `INSERT`/`UPDATE` va a fallar con `column "x" does not exist` —
  **cada vez** que se intente escribir esa ficha. Como `upsertMedia` corre
  fire-and-forget, esto no rompe ninguna respuesta al usuario, pero
  significa que **dejás de persistir todo, silenciosamente, para
  siempre**, hasta que alguien note el `console.error('meta-cache upsert
  failed: ...')` en los logs.
- **Quitás/renombrás la columna en la migración, pero no en `read.ts`:**
  peor todavía, porque `read.ts` no lanza ningún error — `row.esa_columna`
  simplemente da `undefined`, y ese campo desaparece calladamente del
  JSON que se sirve en el fallback (`stale:true`). Nadie se entera salvo
  que compare la respuesta con la que da AniList en vivo.
- **Renombrás algo en `write.ts` pero te olvidás de `read.ts` (o
  viceversa):** cada uno sigue funcionando por separado (uno escribe con
  el nombre viejo o nuevo, el otro lee con el que le corresponda), pero
  quedan desincronizados entre sí sin que nada te avise.

**Regla práctica: cualquier cambio de nombre o eliminación de columna
existente se hace en los tres lugares a la vez, en el mismo commit** —
migración + `write.ts` + `read.ts` — igual que al agregar, pero acá el
riesgo es mayor porque el síntoma es silencioso en vez de un 500 obvio.
Si vas a eliminar una columna, además pensá si de verdad hace falta
borrarla del schema (un `ALTER TABLE ... DROP COLUMN`) o si alcanza con
dejar de escribirla/leerla — dropearla es la única de las tres acciones
que es irreversible sin restaurar un backup.

## Los dos pools (`src/utils/db.ts`) — por qué importan si tocás esto

Todo lo de arriba corre sobre **dos pools de conexión separados**, no uno
solo:

```ts
export const writePool = baseConfig && new Pool({ ...baseConfig, max: 6 });
export const readPool  = baseConfig && new Pool({ ...baseConfig, max: 4 });
```

- `write.ts` (`upsertMedia`, todo lo que inserta/actualiza) usa **`writePool`**.
- `read.ts` (`findMediaById`, `searchMedia` — el fallback que responde
  cuando AniList está caído) usa **`readPool`**.

Se separaron a propósito: `upsertMedia` mantiene **una sola conexión
ocupada** durante toda su transacción (`BEGIN`...`COMMIT`), y aunque el
batching bajó el costo de ~446 queries secuenciales a ~7 (~500ms → ~112ms
medido con Naruto), sigue siendo la operación más "pesada" de las dos. Si
compartiera pool con las lecturas de fallback, un pico de escrituras
podría dejar sin conexión disponible justo a la query que tiene que
responder cuando AniList se cae — que es lo único que este sistema no
puede tolerar. Por eso están separados: un pico de escritura nunca puede
consumir las 4 conexiones reservadas para lectura.

**Qué implica esto si agregás algo nuevo:**
- Si agregás una tabla relacionada nueva (más queries dentro de la misma
  transacción de `upsertMedia`), la conexión de `writePool` queda ocupada
  un poco más de tiempo por escritura — no hace falta tocar el pool por
  esto salvo que empieces a ver timeouts (`connectionTimeoutMillis: 5000`
  en `db.ts` — si se agota el pool, falla a los 5s en vez de colgarse
  para siempre, y ese fallo se loguea y se ignora igual que hoy, nunca
  rompe la respuesta).
- Si agregás un endpoint nuevo con su propio `withPersistentFallback`/
  `withSearchFallback`, sus lecturas de fallback también van a
  `readPool` automáticamente (no hay que hacer nada) — pero sí sumás
  presión sobre esas mismas 4 conexiones si el tráfico de fallback crece
  mucho (ej. AniList caído por horas y mucho tráfico simultáneo).
- Si en algún momento ves que las escrituras están tardando demasiado
  (revisar con las queries de `docs/meta-persistent-cache-db.md` o
  simplemente cronometrando como hicimos con Naruto), la primera palanca
  es subir `max` en `writePool`, no bajar el aislamiento entre los dos
  pools.

## Checklist: `@consumet/extensions` se actualizó a un commit nuevo

1. `npm install` (o `yarn install`) para traer el nuevo commit.
2. Releé `node_modules/@consumet/extensions/dist/utils/queries.js`,
   específicamente `anilistMediaDetailQuery` — ¿cambió qué campos pide la
   query? ¿Cambió el nombre de algún campo (`type` vs `format`, por
   ejemplo)?
3. Releé `node_modules/@consumet/extensions/dist/providers/meta/anilist.js`
   — buscá `fetchAnilistInfoById` (anime) y `fetchMangaInfo` (manga),
   específicamente cómo mapean `data.data.Media.*` a `animeInfo.*` /
   `mangaInfo.*`. Esto es lo que **realmente** recibe nuestro
   `upsertMedia()` — no la respuesta cruda de AniList, sino lo que esta
   capa de la librería ya transformó.
4. Comparar contra lo que asume `write.ts` hoy — especialmente:
   - `info.type` (se asume que es el `format` crudo de AniList — ver
     `format.ts`, `mediaTypeFromFormat()`). Si la librería empieza a
     poner ahí otra cosa, la derivación de `media_type` se rompe.
   - `character.voiceActors` (se asume que solo existe para anime, no
     manga — ver la sección "Por qué 1 sola tabla" del plan original).
   - `relation.relationType`, `recommendation.rating` — nombres exactos
     de propiedades que `write.ts` lee directo del objeto.
5. Si algo cambió, ajustar `write.ts`/`read.ts`/`format.ts` según
   corresponda, y volver a correr las pruebas del punto anterior.

## Cómo detectar esto en el día a día (no hay alertas automáticas hoy)

No hay validación de esquema ni alerta si un campo esperado viene
`undefined`. Formas prácticas de notarlo:
- Revisar de vez en cuando con la query de
  `docs/meta-persistent-cache-db.md` si hay muchas filas con columnas
  `NULL` que antes no lo estaban.
- Si ves `media_type` mal clasificado (un manga guardado como `ANIME` o
  viceversa), es la primera señal de que apareció un `format` nuevo no
  contemplado en `mediaTypeFromFormat()`.
- El `console.warn('meta-cache: media ... has no recognizable format...')`
  en `write.ts` es la única señal explícita que existe hoy — si empezás a
  verla en los logs, es que la librería está devolviendo un `format`
  vacío/null que antes no pasaba.

## Resumen — dónde tocar qué

| Cambio | Archivo(s) |
|---|---|
| Campo escalar nuevo en `media` | migración nueva + `write.ts` + `read.ts` |
| Quitar o renombrar una columna existente | migración + `write.ts` + `read.ts` **a la vez, mismo commit** (ver sección arriba — el fallo acá es silencioso) |
| Tabla relacionada nueva | migración nueva + `write.ts` (usar `upsertBatch`) + `read.ts` |
| Nuevo valor de `MediaFormat` (anime vs manga) | `src/utils/metaCache/format.ts` |
| Escrituras lentas / pool saturado | `src/utils/db.ts` (`writePool`/`readPool`, ver sección de pools arriba) |
| La librería cambió cómo arma `IAnimeInfo`/`IMangaInfo` | revisar `write.ts` contra `node_modules/@consumet/extensions/dist/providers/meta/anilist.js` |
