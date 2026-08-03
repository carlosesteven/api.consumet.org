import { pool } from '../db';
import { MediaTypeEnum } from './format';

export interface CachedMedia {
  cachedAt: Date;
  data: Record<string, any>;
}

const buildMediaResponse = (row: any): Record<string, any> => ({
  id: String(row.id),
  malId: row.mal_id ?? undefined,
  title: {
    romaji: row.title_romaji ?? undefined,
    english: row.title_english ?? undefined,
    native: row.title_native ?? undefined,
    userPreferred: row.title_user_preferred ?? undefined,
  },
  synonyms: row.synonyms ?? undefined,
  description: row.description ?? undefined,
  status: row.status ?? undefined,
  genres: row.genres ?? undefined,
  studios: row.studios ?? undefined,
  season: row.season ?? undefined,
  countryOfOrigin: row.country_of_origin ?? undefined,
  isAdult: row.is_adult ?? undefined,
  isLicensed: row.is_licensed ?? undefined,
  type: row.format ?? undefined,
  duration: row.duration ?? undefined,
  rating: row.rating ?? undefined,
  popularity: row.popularity ?? undefined,
  color: row.color ?? undefined,
  image: row.image ?? undefined,
  imageHash: row.image_hash ?? undefined,
  cover: row.cover ?? undefined,
  coverHash: row.cover_hash ?? undefined,
  startDate: {
    year: row.start_year ?? undefined,
    month: row.start_month ?? undefined,
    day: row.start_day ?? undefined,
  },
  endDate: {
    year: row.end_year ?? undefined,
    month: row.end_month ?? undefined,
    day: row.end_day ?? undefined,
  },
  trailer: row.trailer_id
    ? {
        id: row.trailer_id,
        site: row.trailer_site ?? undefined,
        thumbnail: row.trailer_thumbnail ?? undefined,
        thumbnailHash: row.trailer_thumbnail_hash ?? undefined,
      }
    : undefined,
  totalEpisodes: row.total_episodes ?? undefined,
  currentEpisode: row.current_episode ?? undefined,
  nextAiringEpisode: row.next_airing_episode ?? undefined,
  totalChapters: row.total_chapters ?? undefined,
});

export const findMediaById = async (id: number): Promise<CachedMedia | null> => {
  if (!pool) return null;

  const { rows } = await pool.query('SELECT * FROM media WHERE id = $1', [id]);
  if (rows.length === 0) return null;
  const row = rows[0];

  const data = buildMediaResponse(row);

  const { rows: characterRows } = await pool.query(
    `SELECT c.*, mc.role
     FROM media_characters mc
     JOIN characters c ON c.id = mc.character_id
     WHERE mc.media_id = $1`,
    [id],
  );

  const voiceActorRows =
    row.media_type === 'ANIME'
      ? (
          await pool.query(
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
    role: c.role ?? undefined,
    name: {
      first: c.name_first ?? undefined,
      last: c.name_last ?? undefined,
      full: c.name_full ?? undefined,
      native: c.name_native ?? undefined,
      userPreferred: c.name_user_preferred ?? undefined,
    },
    image: c.image ?? undefined,
    imageHash: c.image_hash ?? undefined,
    voiceActors: voiceActorRows
      .filter((va: any) => va.character_id === c.id)
      .map((va: any) => ({
        id: va.id,
        language: va.language ?? undefined,
        name: {
          first: va.name_first ?? undefined,
          last: va.name_last ?? undefined,
          full: va.name_full ?? undefined,
          native: va.name_native ?? undefined,
          userPreferred: va.name_user_preferred ?? undefined,
        },
        image: va.image ?? undefined,
        imageHash: va.image_hash ?? undefined,
      })),
  }));

  const { rows: relationRows } = await pool.query(
    'SELECT * FROM media_relations WHERE media_id = $1',
    [id],
  );
  data.relations = relationRows.map((r: any) => ({
    id: r.related_media_id,
    relationType: r.relation_type ?? undefined,
    title: r.snapshot_title ?? undefined,
    status: r.snapshot_status ?? undefined,
    image: r.snapshot_image ?? undefined,
    type: r.snapshot_type ?? undefined,
  }));

  const { rows: recommendationRows } = await pool.query(
    'SELECT * FROM media_recommendations WHERE media_id = $1',
    [id],
  );
  data.recommendations = recommendationRows.map((r: any) => ({
    id: r.recommended_media_id,
    rating: r.rating ?? undefined,
    title: r.snapshot_title ?? undefined,
    status: r.snapshot_status ?? undefined,
    image: r.snapshot_image ?? undefined,
    type: r.snapshot_type ?? undefined,
  }));

  return { cachedAt: row.updated_at, data };
};

// Only searches what already got persisted via findMediaById's write path
// (/data/:id, /manga/info/:id) — not a replica of AniList's full catalog.
export const searchMedia = async (
  mediaType: MediaTypeEnum,
  query: string,
  page = 1,
  perPage = 20,
): Promise<CachedMedia[]> => {
  if (!pool) return [];

  const offset = (Math.max(page, 1) - 1) * perPage;
  const { rows } = await pool.query(
    `SELECT * FROM media
     WHERE media_type = $1
       AND (title_romaji ILIKE '%' || $2 || '%'
            OR title_english ILIKE '%' || $2 || '%'
            OR title_native ILIKE '%' || $2 || '%')
     ORDER BY popularity DESC NULLS LAST
     LIMIT $3 OFFSET $4`,
    [mediaType, query, perPage, offset],
  );

  return rows.map((row: any) => ({ cachedAt: row.updated_at, data: buildMediaResponse(row) }));
};
