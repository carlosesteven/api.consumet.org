# AGENTS.md - Consumet API

## Architecture

- **Runtime**: TypeScript + Node.js (Fastify HTTP server)
- **Entry point**: `src/main.ts` (compiled to `dist/main.js`)
- **Providers**: 8 route modules in `src/routes/` (anime, books, comics, light-novels, manga, meta, movies, news)
- **Cache**: Optional Redis (default TTL: 3600s)
- **Optional**: TMDB API integration via `TMDB_KEY` env var

## Commands

```bash
# Development
npm run dev       # nodemon src/main.ts (auto-reload)

# Build
npm run build     # tsc → dist/

# Lint/format
npm run lint      # prettier --write "src/**/*.ts"

# Production
npm start         # ts-node src/main.ts
```

**Order matters**: `lint → build` before deploying.

## Environment

Required variables (`.env`):
- `PORT` (default: 3000)
- `NODE_ENV` (`DEMO` or `PROD`)
- `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD` (optional cache)
- `TMDB_KEY` (optional, affects `/meta` route)

## Testing/Verification

```bash
# Typecheck
npx tsc

# Lint
npm run lint
```

## Deployment Notes

- Docker builds run `npm install && npm update && npm cache clean`
- Production uses `dist/main.js`, not TypeScript source
- Default port 8000 in PM2 ecosystem config; 3000 in Docker
- Demo mode requires Redis session tracking (5hr expiry)

## Common Pitfalls

- `ts-node` in prod: use `npm start` which compiles to `dist/main.js`
- Redis is optional; warn if `REDIS_HOST` not set
- TMDB meta route breaks without `TMDB_KEY`
- Demo mode (`NODE_ENV=DEMO`) requires IP-based session storage in memory
