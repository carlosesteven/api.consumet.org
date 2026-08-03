# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a self-hosted REST API that aggregates multiple entertainment data scrapers (anime, manga, movies, books, comics, light novels, news). It is a fork of [consumet.ts](https://github.com/consumet/api.consumet.org) and depends on `@consumet/extensions` for the actual provider implementations.

## Commands

```bash
npm start          # Run with ts-node (production-like)
npm run dev        # Run with nodemon (hot reload)
npm run build      # Compile TypeScript to dist/
npm run lint       # Format with Prettier
```

No test suite is configured in this project.

## Environment Variables

Copy `.env.example` to `.env`:

| Variable | Purpose |
|---|---|
| `PORT` | Server port (default: 3000) |
| `PROXY` | HTTP proxy for provider requests |
| `REDIS_HOST` / `REDIS_PORT` / `REDIS_PASSWORD` | Redis connection |
| `REDIS_TTL` | Cache TTL in seconds (default: 3600) |
| `DB_HOST` / `DB_PORT` / `DB_USER` / `DB_PASSWORD` / `DB_NAME` | Postgres connection (persistent fallback cache for AniList meta, optional) |
| `TMDB_KEY` | TMDB API key for movie/TV metadata |
| `NODE_ENV` | Set to `DEMO` to enable session-gated access |

## Architecture

### Entry Point

`src/main.ts` — Fastify server that registers all route categories under their respective prefixes (`/anime`, `/manga`, `/movies`, `/meta`, `/books`, `/comics`, `/light-novels`, `/news`, `/utils`).

### Route Structure

Each category follows this two-level pattern:

1. **Category index** (`src/routes/<category>/index.ts`): Registers a root welcome route and dispatches to per-provider sub-routers based on the URL segment. Uses `PROVIDERS_LIST` from `@consumet/extensions` to validate provider names.

2. **Provider file** (`src/routes/<category>/<provider>.ts`): Defines GET endpoints (`/:query`, `/info/:id`, `/watch/:episodeId`, etc.) that instantiate the provider class from `@consumet/extensions` and wrap results in Redis cache.

### Cache Layer

`src/utils/cache.ts` exposes typed `fetch`, `get`, `set`, `del` helpers. The `fetch` helper takes a cache key, a TTL, and an async callback — it returns cached data if present, otherwise calls the callback and caches the result. Cache keys follow the pattern `provider:endpoint:param`.

### Metadata Routes (`src/routes/meta/`)

`anilist.ts`, `mal.ts`, and `tmdb.ts` are special-purpose routes that don't follow the provider dispatch pattern. They expose richer endpoints (e.g., `/meta/anilist/trending`, `/meta/tmdb/info/:id?type=movie`) and hit external metadata APIs rather than scraping.

### Adding a New Provider

1. Create `src/routes/<category>/<provider>.ts` — export a Fastify plugin that registers routes.
2. Register it in `src/routes/<category>/index.ts` using the existing dispatch pattern.
3. The provider implementation itself lives in `@consumet/extensions`, not in this repo.

## Code Style

Prettier config (`.prettierrc.yml`): 2-space indent, single quotes, 90-character line width.
