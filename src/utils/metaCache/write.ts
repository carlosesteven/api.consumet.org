import { IAnimeInfo, IMangaInfo } from '@consumet/extensions/dist/models';

import { pool } from '../db';
import { mediaTypeFromFormat, pickTitleText } from './format';

type MediaLike = (IAnimeInfo | IMangaInfo) & {
  currentEpisode?: number;
  chapters?: unknown[];
};

// Shared by /data/:id (anime) and /manga/info/:id: both call the same
// AniList Media detail query under the hood, so a single row shape covers both.
export const upsertMedia = async (info: MediaLike): Promise<void> => {
  if (!pool) return;

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

  const client = await pool.connect();
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

    const characters = (info as { characters?: any[] }).characters;
    if (Array.isArray(characters)) {
      for (const character of characters) {
        if (character?.id == null) continue;
        const characterId = Number(character.id);

        await client.query(
          `INSERT INTO characters (id, name_first, name_last, name_full, name_native, name_user_preferred, image, image_hash)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (id) DO UPDATE SET
             name_first = EXCLUDED.name_first,
             name_last = EXCLUDED.name_last,
             name_full = EXCLUDED.name_full,
             name_native = EXCLUDED.name_native,
             name_user_preferred = EXCLUDED.name_user_preferred,
             image = EXCLUDED.image,
             image_hash = EXCLUDED.image_hash`,
          [
            characterId,
            character.name?.first ?? null,
            character.name?.last ?? null,
            character.name?.full ?? null,
            character.name?.native ?? null,
            character.name?.userPreferred ?? null,
            character.image ?? null,
            character.imageHash ?? null,
          ],
        );

        await client.query(
          `INSERT INTO media_characters (media_id, character_id, role)
           VALUES ($1,$2,$3)
           ON CONFLICT (media_id, character_id) DO UPDATE SET role = EXCLUDED.role`,
          [id, characterId, character.role ?? null],
        );

        const voiceActors = character.voiceActors as Array<any> | undefined;
        if (Array.isArray(voiceActors)) {
          for (const voiceActor of voiceActors) {
            if (voiceActor?.id == null) continue;
            const voiceActorId = Number(voiceActor.id);

            await client.query(
              `INSERT INTO voice_actors (id, name_first, name_last, name_full, name_native, name_user_preferred, image, image_hash)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
               ON CONFLICT (id) DO UPDATE SET
                 name_first = EXCLUDED.name_first,
                 name_last = EXCLUDED.name_last,
                 name_full = EXCLUDED.name_full,
                 name_native = EXCLUDED.name_native,
                 name_user_preferred = EXCLUDED.name_user_preferred,
                 image = EXCLUDED.image,
                 image_hash = EXCLUDED.image_hash`,
              [
                voiceActorId,
                voiceActor.name?.first ?? null,
                voiceActor.name?.last ?? null,
                voiceActor.name?.full ?? null,
                voiceActor.name?.native ?? null,
                voiceActor.name?.userPreferred ?? null,
                voiceActor.image ?? null,
                voiceActor.imageHash ?? null,
              ],
            );

            await client.query(
              `INSERT INTO media_character_voice_actors (media_id, character_id, voice_actor_id, language)
               VALUES ($1,$2,$3,$4)
               ON CONFLICT (media_id, character_id, voice_actor_id, language) DO NOTHING`,
              [id, characterId, voiceActorId, voiceActor.language ?? null],
            );
          }
        }
      }
    }

    const relations = anime.relations;
    if (Array.isArray(relations)) {
      for (const relation of relations) {
        if (relation?.id == null) continue;

        await client.query(
          `INSERT INTO media_relations (media_id, related_media_id, relation_type, snapshot_title, snapshot_status, snapshot_image, snapshot_type)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (media_id, related_media_id) DO UPDATE SET
             relation_type = EXCLUDED.relation_type,
             snapshot_title = EXCLUDED.snapshot_title,
             snapshot_status = EXCLUDED.snapshot_status,
             snapshot_image = EXCLUDED.snapshot_image,
             snapshot_type = EXCLUDED.snapshot_type`,
          [
            id,
            Number(relation.id),
            (relation as { relationType?: string }).relationType ?? null,
            pickTitleText(relation.title),
            relation.status ?? null,
            relation.image ?? null,
            relation.type ?? null,
          ],
        );
      }
    }

    const recommendations = anime.recommendations;
    if (Array.isArray(recommendations)) {
      for (const recommendation of recommendations) {
        if (recommendation?.id == null) continue;

        await client.query(
          `INSERT INTO media_recommendations (media_id, recommended_media_id, rating, snapshot_title, snapshot_status, snapshot_image, snapshot_type)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (media_id, recommended_media_id) DO UPDATE SET
             rating = EXCLUDED.rating,
             snapshot_title = EXCLUDED.snapshot_title,
             snapshot_status = EXCLUDED.snapshot_status,
             snapshot_image = EXCLUDED.snapshot_image,
             snapshot_type = EXCLUDED.snapshot_type`,
          [
            id,
            Number(recommendation.id),
            recommendation.rating ?? null,
            pickTitleText(recommendation.title),
            recommendation.status ?? null,
            recommendation.image ?? null,
            recommendation.type ?? null,
          ],
        );
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};
