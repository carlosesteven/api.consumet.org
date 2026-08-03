import { MediaFormat } from '@consumet/extensions/dist/models';

const MANGA_FORMATS: readonly string[] = [
  MediaFormat.MANGA,
  MediaFormat.NOVEL,
  MediaFormat.ONE_SHOT,
  MediaFormat.COMIC,
];

export type MediaTypeEnum = 'ANIME' | 'MANGA';

// AniList's MediaFormat values never overlap between anime and manga, so this
// is equivalent to reading Media.type directly without an extra GraphQL call.
export const mediaTypeFromFormat = (format: string | undefined | null): MediaTypeEnum | null => {
  if (!format) return null;
  return MANGA_FORMATS.includes(format) ? 'MANGA' : 'ANIME';
};

export const pickTitleText = (title: unknown): string | null => {
  if (!title) return null;
  if (typeof title === 'string') return title;

  const t = title as {
    userPreferred?: string;
    english?: string;
    romaji?: string;
    native?: string;
  };
  return t.userPreferred ?? t.english ?? t.romaji ?? t.native ?? null;
};
