import { MediaFormat, MediaStatus } from '@consumet/extensions/dist/models';

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

// advanced-search's `status` query param uses AniList's raw enum
// (RELEASING/FINISHED/...), but `media.status` stores the library's already
// -translated MediaStatus string ("Ongoing"/"Completed"/...) — same mapping
// write.ts relies on the library to apply on the way in.
const RAW_STATUS_TO_MEDIA_STATUS: Record<string, string> = {
  RELEASING: MediaStatus.ONGOING,
  FINISHED: MediaStatus.COMPLETED,
  NOT_YET_RELEASED: MediaStatus.NOT_YET_AIRED,
  CANCELLED: MediaStatus.CANCELLED,
  HIATUS: MediaStatus.HIATUS,
};

export const mapRawStatusToMediaStatus = (status: string | undefined | null): string | undefined => {
  if (!status) return undefined;
  return RAW_STATUS_TO_MEDIA_STATUS[status];
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
