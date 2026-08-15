import { IAnimeInfo, IMangaInfo } from '@consumet/extensions/dist/models';

import { redis, REDIS_TTL } from '../../main';
import cache from '../cache';
import { MediaTypeEnum } from './format';
import { findMediaById, searchMedia } from './read';
import { upsertMedia } from './write';

interface PersistentFallbackOptions<T> {
  mediaId: number;
  redisKey: string;
  redisTtl?: number;
  fetchLive: () => Promise<T>;
}

// Ficha endpoints (/data/:id, /manga/info/:id): Redis -> live AniList fetch
// (writes through to Redis + Postgres on success, best-effort) -> Postgres by
// id on failure.
//
// Hard rule: a failure in Redis or Postgres (read OR write) must never
// override or mask a result that AniList (or Redis, or Postgres fallback)
// already successfully produced. Every Redis/Postgres call outside of the
// actual "read from Postgres because AniList is down" fallback path is
// wrapped so its errors are logged and swallowed, never thrown upward.
export const withPersistentFallback = async <T extends IAnimeInfo | IMangaInfo>(
  opts: PersistentFallbackOptions<T>,
): Promise<T | (Record<string, any> & { stale: true; cachedAt: Date })> => {
  if (redis) {
    try {
      const cached = await cache.get<T>(redis, opts.redisKey);
      if (cached !== null) return cached;
    } catch (redisErr) {
      console.error('meta-cache redis read failed:', redisErr);
    }
  }

  let live: T;
  try {
    live = await opts.fetchLive();
  } catch (err) {
    // AniList failed. Try Postgres as a last resort. If Postgres *also*
    // fails here, that's a separate, logged failure — the original AniList
    // error (err) is still what gets propagated, never the Postgres one.
    try {
      const fallback = await findMediaById(opts.mediaId);
      if (fallback) return { ...fallback.data, stale: true, cachedAt: fallback.cachedAt };
    } catch (fallbackErr) {
      console.error('meta-cache fallback lookup failed:', fallbackErr);
    }
    throw err;
  }

  // AniList succeeded — `live` is good data. Everything below is best-effort
  // persistence; none of it may affect the value returned to the caller.
  if (redis) {
    cache
      .set(redis, opts.redisKey, () => live, opts.redisTtl ?? REDIS_TTL)
      .catch((redisErr) => console.error('meta-cache redis write failed:', redisErr));
  }
  upsertMedia(live).catch((dbErr) => console.error('meta-cache upsert failed:', dbErr));

  return live;
};

interface SearchFallbackOptions<T> {
  mediaType: MediaTypeEnum;
  query: string;
  page?: number;
  perPage?: number;
  redisKey: string;
  redisTtl?: number;
  fetchLive: () => Promise<T>;
}

// Search endpoints (advanced-search, /manga/:query): Redis -> live AniList
// fetch -> ILIKE over `media` rows already persisted by the ficha endpoints.
// Does not write to Postgres itself (search results are sparse IAnimeResult
// items and would clobber richer rows already saved by the ficha wrapper).
// Same hard rule as withPersistentFallback above.
export const withSearchFallback = async <T>(
  opts: SearchFallbackOptions<T>,
): Promise<T | Record<string, any>> => {
  if (redis) {
    try {
      const cached = await cache.get<T>(redis, opts.redisKey);
      if (cached !== null) return cached;
    } catch (redisErr) {
      console.error('meta-cache redis read failed:', redisErr);
    }
  }

  let live: T;
  try {
    live = await opts.fetchLive();
  } catch (err) {
    try {
      const page = opts.page ?? 1;
      const perPage = opts.perPage ?? 20;
      const { totalResults, items } = await searchMedia(opts.mediaType, opts.query, page, perPage);
      if (items.length > 0) {
        // Same shape AniList's advancedSearch/search return on a real success
        // (currentPage/hasNextPage/totalPages/totalResults/results) — callers
        // that already parse that shape don't need special-case handling for
        // the fallback path.
        const totalPages = perPage > 0 ? Math.ceil(totalResults / perPage) : 0;
        return {
          currentPage: page,
          hasNextPage: page < totalPages,
          totalPages,
          totalResults,
          results: items.map((c) => ({ ...c.data, stale: true, cachedAt: c.cachedAt })),
          stale: true,
        };
      }
    } catch (fallbackErr) {
      console.error('meta-cache search fallback failed:', fallbackErr);
    }
    throw err;
  }

  if (redis) {
    cache
      .set(redis, opts.redisKey, () => live, opts.redisTtl ?? REDIS_TTL)
      .catch((redisErr) => console.error('meta-cache redis write failed:', redisErr));
  }

  return live;
};
