-- Persistent fallback cache for AniList meta (anime + manga).
-- See docs/plans/meta-persistent-cache.md for the design rationale.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TYPE media_type_enum AS ENUM ('ANIME', 'MANGA');

CREATE TABLE media (
  id                     INTEGER PRIMARY KEY,        -- id de AniList, global (anime+manga)
  media_type             media_type_enum NOT NULL,   -- leído de Media.type en la respuesta
  mal_id                 INTEGER,
  title_romaji           TEXT,
  title_english          TEXT,
  title_native           TEXT,
  title_user_preferred   TEXT,
  synonyms               TEXT[],
  description            TEXT,
  status                 TEXT,                       -- MediaStatus mapeado (ONGOING, COMPLETED, ...)
  genres                 TEXT[],
  studios                TEXT[],                      -- solo nombres, AniList no da id de studio
  season                 TEXT,
  country_of_origin      TEXT,
  is_adult               BOOLEAN,
  is_licensed            BOOLEAN,
  format                 TEXT,                        -- TV, MOVIE, MANGA, ONE_SHOT, etc.
  duration               INTEGER,                     -- solo anime
  rating                 INTEGER,                     -- averageScore
  popularity             INTEGER,
  color                  TEXT,
  image                  TEXT,
  image_hash             TEXT,
  cover                  TEXT,
  cover_hash             TEXT,
  start_year             INTEGER,
  start_month            INTEGER,
  start_day              INTEGER,
  end_year               INTEGER,
  end_month              INTEGER,
  end_day                INTEGER,
  trailer_id             TEXT,
  trailer_site           TEXT,
  trailer_thumbnail      TEXT,
  trailer_thumbnail_hash TEXT,
  total_episodes         INTEGER,                     -- solo anime
  current_episode        INTEGER,                     -- solo anime
  next_airing_episode    JSONB,                       -- {airingTime, timeUntilAiring, episode} - pequeño, transitorio
  total_chapters         INTEGER,                     -- solo manga
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_media_type ON media (media_type);
CREATE INDEX idx_media_genres ON media USING GIN (genres);
-- para el fallback de búsqueda por texto (ver docs/plans/meta-persistent-cache.md)
CREATE INDEX idx_media_title_trgm ON media USING GIN (
  (coalesce(title_romaji, '') || ' ' || coalesce(title_english, '') || ' ' || coalesce(title_native, '')) gin_trgm_ops
);

CREATE TABLE characters (
  id                  INTEGER PRIMARY KEY,        -- id de character en AniList
  name_first          TEXT,
  name_last           TEXT,
  name_full           TEXT,
  name_native         TEXT,
  name_user_preferred TEXT,
  image               TEXT,
  image_hash          TEXT
);

CREATE TABLE media_characters (
  media_id     INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  role         TEXT,
  PRIMARY KEY (media_id, character_id)
);

CREATE TABLE voice_actors (                       -- solo aplica a anime
  id                  INTEGER PRIMARY KEY,
  name_first          TEXT,
  name_last           TEXT,
  name_full           TEXT,
  name_native         TEXT,
  name_user_preferred TEXT,
  image               TEXT,
  image_hash          TEXT
);

CREATE TABLE media_character_voice_actors (
  media_id       INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  character_id   INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  voice_actor_id INTEGER NOT NULL REFERENCES voice_actors(id) ON DELETE CASCADE,
  language       TEXT,
  PRIMARY KEY (media_id, character_id, voice_actor_id, language)
);

-- sin FK estricta hacia media(id): relations/recommendations pueden apuntar
-- a un id que todavía no se ha cacheado directamente (ni siquiera con el mismo
-- media_type, ya que una relación puede cruzar anime <-> manga)
CREATE TABLE media_relations (
  media_id         INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  related_media_id INTEGER NOT NULL,
  relation_type    TEXT,
  -- snapshot denormalizado: lo que AniList ya entrega inline, sin necesidad de join
  snapshot_title   TEXT,
  snapshot_status  TEXT,
  snapshot_image   TEXT,
  snapshot_type    TEXT,
  PRIMARY KEY (media_id, related_media_id)
);

CREATE TABLE media_recommendations (
  media_id             INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  recommended_media_id INTEGER NOT NULL,
  rating               INTEGER,
  snapshot_title       TEXT,
  snapshot_status      TEXT,
  snapshot_image       TEXT,
  snapshot_type        TEXT,
  PRIMARY KEY (media_id, recommended_media_id)
);
