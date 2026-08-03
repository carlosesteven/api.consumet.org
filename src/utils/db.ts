import { Pool, PoolConfig } from 'pg';

const baseConfig: PoolConfig | null = process.env.DB_HOST
  ? {
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT) || 5432,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      // Fail fast instead of hanging forever when the pool is saturated —
      // callers already treat DB errors as best-effort (log and move on).
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 30000,
    }
  : null;

// Two separate pools instead of one. upsertMedia (write.ts) can hold a
// connection for hundreds of sequential child-row queries on a single call
// (~500ms for a characters/relations-heavy title). Sharing one pool would
// let a burst of writes starve the Postgres fallback reads (read.ts) — the
// actual safety net used when AniList is down — which must always have a
// connection available.
export const writePool = baseConfig && new Pool({ ...baseConfig, max: 6 });
export const readPool = baseConfig && new Pool({ ...baseConfig, max: 4 });
