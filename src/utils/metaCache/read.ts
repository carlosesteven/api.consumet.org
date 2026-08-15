import { readPool } from '../db';
import { MediaTypeEnum } from './format';

export interface CachedMedia {
  cachedAt: Date;
  data: Record<string, any>;
}

export interface SearchResult {
  totalResults: number;
  items: CachedMedia[];
}

// Every key here uses `?? null`, never `?? undefined`. A JSON.stringify drops
// `undefined` keys entirely, and at least one real consumer (the Android app,
// via org.json's JSONObject.getString) throws on a *missing* key but handles
// an explicit `null` gracefully (it coerces to the literal string "null").
// Omitting a key silently breaks that client; `null` does not.
const buildMediaResponse = (row: any): Record<string, any> => ({
  id: String(row.id),
  malId: row.mal_id ?? null,
  title: {
    romaji: row.title_romaji ?? null,
    english: row.title_english ?? null,
    native: row.title_native ?? null,
    userPreferred: row.title_user_preferred ?? null,
  },
  synonyms: row.synonyms ?? null,
  description: row.description ?? null,
  status: row.status ?? null,
  genres: row.genres ?? null,
  studios: row.studios ?? null,
  season: row.season ?? null,
  countryOfOrigin: row.country_of_origin ?? null,
  isAdult: row.is_adult ?? null,
  isLicensed: row.is_licensed ?? null,
  type: row.format ?? null,
  // Matches the library's `releaseDate: item?.seasonYear ?? item.startDate?.year`
  // for advancedSearch results — some real consumers read this key directly
  // and throw if it's absent (see zoroDirectory/zoroSearch in the Android app).
  releaseDate: row.start_year ?? null,
  duration: row.duration ?? null,
  rating: row.rating ?? null,
  popularity: row.popularity ?? null,
  color: row.color ?? null,
  image: row.image ?? null,
  imageHash: row.image_hash ?? null,
  cover: row.cover ?? null,
  coverHash: row.cover_hash ?? null,
  startDate: {
    year: row.start_year ?? null,
    month: row.start_month ?? null,
    day: row.start_day ?? null,
  },
  endDate: {
    year: row.end_year ?? null,
    month: row.end_month ?? null,
    day: row.end_day ?? null,
  },
  trailer: row.trailer_id
    ? {
        id: row.trailer_id,
        site: row.trailer_site ?? null,
        thumbnail: row.trailer_thumbnail ?? null,
        thumbnailHash: row.trailer_thumbnail_hash ?? null,
      }
    : null,
  totalEpisodes: row.total_episodes ?? null,
  currentEpisode: row.current_episode ?? null,
  nextAiringEpisode: row.next_airing_episode ?? null,
  totalChapters: row.total_chapters ?? null,
});

export const findMediaById = async (id: number): Promise<CachedMedia | null> => {
  if (!readPool) return null;

  const { rows } = await readPool.query('SELECT * FROM media WHERE id = $1', [id]);
  if (rows.length === 0) return null;
  const row = rows[0];

  const data = buildMediaResponse(row);

  const { rows: characterRows } = await readPool.query(
    `SELECT c.*, mc.role
     FROM media_characters mc
     JOIN characters c ON c.id = mc.character_id
     WHERE mc.media_id = $1`,
    [id],
  );

  const voiceActorRows =
    row.media_type === 'ANIME'
      ? (
          await readPool.query(
            `SELECT mcva.character_id, mcva.language, va.*
             FROM media_character_voice_actors mcva
             JOIN voice_actors va ON va.id = mcva.voice_actor_id
             WHERE mcva.media_id = $1`,
            [id],
          )
        ).rows
      : [];

  data.characters = characterRows.map((c: any) => ({
    id: c.id,
    role: c.role ?? null,
    name: {
      first: c.name_first ?? null,
      last: c.name_last ?? null,
      full: c.name_full ?? null,
      native: c.name_native ?? null,
      userPreferred: c.name_user_preferred ?? null,
    },
    image: c.image ?? null,
    imageHash: c.image_hash ?? null,
    voiceActors: voiceActorRows
      .filter((va: any) => va.character_id === c.id)
      .map((va: any) => ({
        id: va.id,
        language: va.language ?? null,
        name: {
          first: va.name_first ?? null,
          last: va.name_last ?? null,
          full: va.name_full ?? null,
          native: va.name_native ?? null,
          userPreferred: va.name_user_preferred ?? null,
        },
        image: va.image ?? null,
        imageHash: va.image_hash ?? null,
      })),
  }));

  const { rows: relationRows } = await readPool.query(
    'SELECT * FROM media_relations WHERE media_id = $1',
    [id],
  );
  data.relations = relationRows.map((r: any) => ({
    id: r.related_media_id,
    relationType: r.relation_type ?? null,
    title: r.snapshot_title ?? null,
    status: r.snapshot_status ?? null,
    image: r.snapshot_image ?? null,
    type: r.snapshot_type ?? null,
  }));

  const { rows: recommendationRows } = await readPool.query(
    'SELECT * FROM media_recommendations WHERE media_id = $1',
    [id],
  );
  data.recommendations = recommendationRows.map((r: any) => ({
    id: r.recommended_media_id,
    rating: r.rating ?? null,
    title: r.snapshot_title ?? null,
    status: r.snapshot_status ?? null,
    image: r.snapshot_image ?? null,
    type: r.snapshot_type ?? null,
  }));

  return { cachedAt: row.updated_at, data };
};

// Only searches what already got persisted via findMediaById's write path
// (/data/:id, /manga/info/:id) — not a replica of AniList's full catalog.
// COUNT(*) OVER() rides along with the same query so callers can rebuild the
// same pagination shape (currentPage/totalPages/totalResults/hasNextPage)
// AniList's advancedSearch normally returns.
export const searchMedia = async (
  mediaType: MediaTypeEnum,
  query: string | undefined,
  page = 1,
  perPage = 20,
): Promise<SearchResult> => {
  if (!readPool) return { totalResults: 0, items: [] };

  const offset = (Math.max(page, 1) - 1) * perPage;

  // No free-text query: this is a filter-only/browse request (e.g. a
  // directory screen with no search term). Fall back to whatever's cached
  // from the current year instead of "most popular ever" — cheap, and
  // production already has a large chunk of the catalog mapped.
  const { rows } = query
    ? await readPool.query(
        `SELECT *, COUNT(*) OVER() AS total_count FROM media
         WHERE media_type = $1
           AND (title_romaji ILIKE '%' || $2 || '%'
                OR title_english ILIKE '%' || $2 || '%'
                OR title_native ILIKE '%' || $2 || '%')
         ORDER BY popularity DESC NULLS LAST
         LIMIT $3 OFFSET $4`,
        [mediaType, query, perPage, offset],
      )
    : await readPool.query(
        `SELECT *, COUNT(*) OVER() AS total_count FROM media
         WHERE media_type = $1
           AND start_year = $2
         ORDER BY popularity DESC NULLS LAST
         LIMIT $3 OFFSET $4`,
        [mediaType, new Date().getFullYear(), perPage, offset],
      );

  const totalResults = rows.length > 0 ? Number(rows[0].total_count) : 0;
  const items = rows.map((row: any) => ({ cachedAt: row.updated_at, data: buildMediaResponse(row) }));

  return { totalResults, items };
};
