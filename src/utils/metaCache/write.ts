import { PoolClient } from 'pg';
import { IAnimeInfo, IMangaInfo } from '@consumet/extensions/dist/models';

import { writePool } from '../db';
import { mediaTypeFromFormat, pickTitleText } from './format';

type MediaLike = (IAnimeInfo | IMangaInfo) & {
  currentEpisode?: number;
  chapters?: unknown[];
};

// One multi-row INSERT instead of one query per row. `updateColumns: null`
// means ON CONFLICT DO NOTHING (used for the pure link table, where
// duplicate keys within the same batch are harmless); otherwise DO UPDATE.
// Callers must de-duplicate rows by their conflict key beforehand — Postgres
// rejects a DO UPDATE batch that would affect the same conflict target twice.
const upsertBatch = async (
  client: PoolClient,
  table: string,
  columns: string[],
  conflictColumns: string[],
  updateColumns: string[] | null,
  rows: any[][],
): Promise<void> => {
  if (rows.length === 0) return;

  const values: any[] = [];
  const rowPlaceholders = rows.map((row) => {
    const placeholders = row.map((value) => {
      values.push(value);
      return `$${values.length}`;
    });
    return `(${placeholders.join(',')})`;
  });

  const conflictClause = updateColumns
    ? `ON CONFLICT (${conflictColumns.join(',')}) DO UPDATE SET ${updateColumns
        .map((c) => `${c} = EXCLUDED.${c}`)
        .join(', ')}`
    : `ON CONFLICT (${conflictColumns.join(',')}) DO NOTHING`;

  await client.query(
    `INSERT INTO ${table} (${columns.join(',')}) VALUES ${rowPlaceholders.join(', ')} ${conflictClause}`,
    values,
  );
};

const dedupeById = (items: any[]): any[] => {
  const map = new Map<number, any>();
  for (const item of items) {
    if (item?.id == null) continue;
    map.set(Number(item.id), item);
  }
  return [...map.values()];
};

// Shared by /data/:id (anime) and /manga/info/:id: both call the same
// AniList Media detail query under the hood, so a single row shape covers both.
export const upsertMedia = async (info: MediaLike): Promise<void> => {
  if (!writePool) return;

  const id = Number(info.id);
  if (!Number.isFinite(id)) return;

  const format = info.type as string | undefined;
  const mediaType = mediaTypeFromFormat(format);
  if (!mediaType) {
    console.warn(`meta-cache: media ${id} has no recognizable format, skipping persist`);
    return;
  }

  const anime = info as IAnimeInfo;
  const manga = info as IMangaInfo;
  const title = typeof anime.title === 'object' ? anime.title : undefined;

  const client = await writePool.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `INSERT INTO media (
        id, media_type, mal_id, title_romaji, title_english, title_native, title_user_preferred,
        synonyms, description, status, genres, studios, season, country_of_origin, is_adult,
        is_licensed, format, duration, rating, popularity, color, image, image_hash, cover, cover_hash,
        start_year, start_month, start_day, end_year, end_month, end_day,
        trailer_id, trailer_site, trailer_thumbnail, trailer_thumbnail_hash,
        total_episodes, current_episode, next_airing_episode, total_chapters, updated_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,
        $26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39, now()
      )
      ON CONFLICT (id) DO UPDATE SET
        media_type = EXCLUDED.media_type,
        mal_id = EXCLUDED.mal_id,
        title_romaji = EXCLUDED.title_romaji,
        title_english = EXCLUDED.title_english,
        title_native = EXCLUDED.title_native,
        title_user_preferred = EXCLUDED.title_user_preferred,
        synonyms = EXCLUDED.synonyms,
        description = EXCLUDED.description,
        status = EXCLUDED.status,
        genres = EXCLUDED.genres,
        studios = EXCLUDED.studios,
        season = EXCLUDED.season,
        country_of_origin = EXCLUDED.country_of_origin,
        is_adult = EXCLUDED.is_adult,
        is_licensed = EXCLUDED.is_licensed,
        format = EXCLUDED.format,
        duration = EXCLUDED.duration,
        rating = EXCLUDED.rating,
        popularity = EXCLUDED.popularity,
        color = EXCLUDED.color,
        image = EXCLUDED.image,
        image_hash = EXCLUDED.image_hash,
        cover = EXCLUDED.cover,
        cover_hash = EXCLUDED.cover_hash,
        start_year = EXCLUDED.start_year,
        start_month = EXCLUDED.start_month,
        start_day = EXCLUDED.start_day,
        end_year = EXCLUDED.end_year,
        end_month = EXCLUDED.end_month,
        end_day = EXCLUDED.end_day,
        trailer_id = EXCLUDED.trailer_id,
        trailer_site = EXCLUDED.trailer_site,
        trailer_thumbnail = EXCLUDED.trailer_thumbnail,
        trailer_thumbnail_hash = EXCLUDED.trailer_thumbnail_hash,
        total_episodes = EXCLUDED.total_episodes,
        current_episode = EXCLUDED.current_episode,
        next_airing_episode = EXCLUDED.next_airing_episode,
        total_chapters = EXCLUDED.total_chapters,
        updated_at = now()`,
      [
        id,
        mediaType,
        info.malId != null ? Number(info.malId) : null,
        title?.romaji ?? null,
        title?.english ?? null,
        title?.native ?? null,
        title?.userPreferred ?? null,
        anime.synonyms ?? null,
        info.description ?? null,
        info.status ?? null,
        info.genres ?? null,
        anime.studios ?? null,
        anime.season ?? null,
        anime.countryOfOrigin ?? null,
        anime.isAdult ?? null,
        anime.isLicensed ?? null,
        format ?? null,
        anime.duration ?? null,
        info.rating ?? null,
        info.popularity ?? null,
        info.color ?? null,
        info.image ?? null,
        info.imageHash ?? null,
        info.cover ?? null,
        info.coverHash ?? null,
        anime.startDate?.year ?? null,
        anime.startDate?.month ?? null,
        anime.startDate?.day ?? null,
        anime.endDate?.year ?? null,
        anime.endDate?.month ?? null,
        anime.endDate?.day ?? null,
        anime.trailer?.id ?? null,
        anime.trailer?.site ?? null,
        anime.trailer?.thumbnail ?? null,
        anime.trailer?.thumbnailHash ?? null,
        anime.totalEpisodes ?? null,
        info.currentEpisode ?? null,
        anime.nextAiringEpisode ? JSON.stringify(anime.nextAiringEpisode) : null,
        Array.isArray(manga.chapters) ? manga.chapters.length : null,
      ],
    );

    const rawCharacters = ((info as { characters?: any[] }).characters ?? []).filter(
      (c) => c?.id != null,
    );
    const characters = dedupeById(rawCharacters);

    await upsertBatch(
      client,
      'characters',
      ['id', 'name_first', 'name_last', 'name_full', 'name_native', 'name_user_preferred', 'image', 'image_hash'],
      ['id'],
      ['name_first', 'name_last', 'name_full', 'name_native', 'name_user_preferred', 'image', 'image_hash'],
      characters.map((character) => [
        Number(character.id),
        character.name?.first ?? null,
        character.name?.last ?? null,
        character.name?.full ?? null,
        character.name?.native ?? null,
        character.name?.userPreferred ?? null,
        character.image ?? null,
        character.imageHash ?? null,
      ]),
    );

    await upsertBatch(
      client,
      'media_characters',
      ['media_id', 'character_id', 'role'],
      ['media_id', 'character_id'],
      ['role'],
      characters.map((character) => [id, Number(character.id), character.role ?? null]),
    );

    const voiceActorLinks: any[][] = [];
    const rawVoiceActors: any[] = [];
    for (const character of rawCharacters) {
      const voiceActors = character.voiceActors as any[] | undefined;
      if (!Array.isArray(voiceActors)) continue;
      for (const voiceActor of voiceActors) {
        if (voiceActor?.id == null) continue;
        rawVoiceActors.push(voiceActor);
        voiceActorLinks.push([id, Number(character.id), Number(voiceActor.id), voiceActor.language ?? null]);
      }
    }
    const voiceActors = dedupeById(rawVoiceActors);

    await upsertBatch(
      client,
      'voice_actors',
      ['id', 'name_first', 'name_last', 'name_full', 'name_native', 'name_user_preferred', 'image', 'image_hash'],
      ['id'],
      ['name_first', 'name_last', 'name_full', 'name_native', 'name_user_preferred', 'image', 'image_hash'],
      voiceActors.map((voiceActor) => [
        Number(voiceActor.id),
        voiceActor.name?.first ?? null,
        voiceActor.name?.last ?? null,
        voiceActor.name?.full ?? null,
        voiceActor.name?.native ?? null,
        voiceActor.name?.userPreferred ?? null,
        voiceActor.image ?? null,
        voiceActor.imageHash ?? null,
      ]),
    );

    // Link rows can legitimately repeat the same (character, voice actor) if
    // AniList's response ever duplicated an edge — DO NOTHING tolerates that
    // within a single batch (unlike DO UPDATE, which Postgres rejects).
    await upsertBatch(
      client,
      'media_character_voice_actors',
      ['media_id', 'character_id', 'voice_actor_id', 'language'],
      ['media_id', 'character_id', 'voice_actor_id', 'language'],
      null,
      voiceActorLinks,
    );

    const relations = dedupeById(anime.relations ?? []);
    await upsertBatch(
      client,
      'media_relations',
      ['media_id', 'related_media_id', 'relation_type', 'snapshot_title', 'snapshot_status', 'snapshot_image', 'snapshot_type'],
      ['media_id', 'related_media_id'],
      ['relation_type', 'snapshot_title', 'snapshot_status', 'snapshot_image', 'snapshot_type'],
      relations.map((relation) => [
        id,
        Number(relation.id),
        (relation as { relationType?: string }).relationType ?? null,
        pickTitleText(relation.title),
        relation.status ?? null,
        relation.image ?? null,
        relation.type ?? null,
      ]),
    );

    const recommendations = dedupeById(anime.recommendations ?? []);
    await upsertBatch(
      client,
      'media_recommendations',
      ['media_id', 'recommended_media_id', 'rating', 'snapshot_title', 'snapshot_status', 'snapshot_image', 'snapshot_type'],
      ['media_id', 'recommended_media_id'],
      ['rating', 'snapshot_title', 'snapshot_status', 'snapshot_image', 'snapshot_type'],
      recommendations.map((recommendation) => [
        id,
        Number(recommendation.id),
        recommendation.rating ?? null,
        pickTitleText(recommendation.title),
        recommendation.status ?? null,
        recommendation.image ?? null,
        recommendation.type ?? null,
      ]),
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};
