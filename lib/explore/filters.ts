// The explore filter registry — labels and glyphs for every value the browse
// grid can be narrowed to.
//
// Presentation, not data: `lib/anilist/explore.ts` owns the VALUES (which are
// AniList enums and must never be prettified) and this file owns how they are
// written and drawn. Splitting them is what lets the query builder stay a pure
// string function and the screen stay free of `if (k === 'TV_SHORT')` ladders.
//
// THE GLYPHS ARE NOT DECORATION. Three dropdown pills sitting in a 360px row
// say "Any / Any / Trending" and are unreadable — the reader cannot tell a
// format from a status from a sort. A clapperboard, a radio and an up-down
// arrow are told apart pre-consciously, before the words are parsed. Same
// reason every genre pill carries a glyph: eighteen text pills is a word wall.
//
// A TYPE-ONLY import of `AppIconName` — erased at compile time, so this stays
// a plain data module with no component in its dependency graph.

import type { AppIconName } from '@/components/ui/AppIcon';
import {
  DEFAULT_FILTERS,
  EXPLORE_GENRES,
  yearOptions,
  type ExploreFilters,
  type ExploreSort,
} from '@/lib/anilist/explore';
import type { MediaFormat, MediaStatus } from '@/lib/anilist';

export interface FilterDef<T> {
  key: T;
  label: string;
  icon: AppIconName;
  /** Quiet right-hand disambiguator inside the sheet. */
  hint?: string;
}

const GENRE_ICONS: Record<string, AppIconName> = {
  Action: 'genreAction',
  Adventure: 'genreAdventure',
  Fantasy: 'genreFantasy',
  'Sci-Fi': 'sciFi',
  Comedy: 'genreComedy',
  Drama: 'genreDrama',
  Romance: 'genreRomance',
  'Slice of Life': 'genreSliceOfLife',
  Supernatural: 'genreSupernatural',
  Mystery: 'genreMystery',
  Thriller: 'crosshair',
  Mecha: 'genreMecha',
  Sports: 'genreSports',
  Psychological: 'genrePsychological',
  Horror: 'genreHorror',
  Music: 'music',
  'Mahou Shoujo': 'genreMahouShoujo',
  Ecchi: 'genreEcchi',
};

/** The genre pill row. Icon per genre, in the registry's own order. */
export const GENRE_PILLS: { key: string; label: string; icon: AppIconName }[] = EXPLORE_GENRES.map(
  (g) => ({ key: g, label: g, icon: GENRE_ICONS[g] ?? 'sparkles' })
);

export const FORMAT_FILTERS: FilterDef<MediaFormat | null>[] = [
  { key: null, label: 'Any format', icon: 'filters' },
  { key: 'TV', label: 'TV Series', icon: 'tv', hint: 'Weekly' },
  { key: 'TV_SHORT', label: 'TV Shorts', icon: 'films', hint: 'Under 30m' },
  { key: 'MOVIE', label: 'Movies', icon: 'clapper', hint: 'Feature' },
  { key: 'OVA', label: 'OVAs', icon: 'sparkles', hint: 'Home video' },
  { key: 'ONA', label: 'ONAs', icon: 'ona', hint: 'Streaming' },
  { key: 'SPECIAL', label: 'Specials', icon: 'star', hint: 'Extra' },
  { key: 'MUSIC', label: 'Music', icon: 'music', hint: 'MV & live' },
];

export const STATUS_FILTERS: FilterDef<MediaStatus | null>[] = [
  { key: null, label: 'Any status', icon: 'filters' },
  { key: 'RELEASING', label: 'Airing now', icon: 'airing', hint: 'Weekly' },
  { key: 'FINISHED', label: 'Finished', icon: 'check', hint: 'Complete' },
  { key: 'NOT_YET_RELEASED', label: 'Upcoming', icon: 'year', hint: 'Announced' },
  { key: 'HIATUS', label: 'On hiatus', icon: 'hourglass', hint: 'Paused' },
  { key: 'CANCELLED', label: 'Cancelled', icon: 'ban', hint: 'Dropped' },
];

export const SORT_FILTERS: FilterDef<ExploreSort>[] = [
  { key: 'TRENDING_DESC', label: 'Trending', icon: 'trending' },
  { key: 'POPULARITY_DESC', label: 'Most popular', icon: 'hot' },
  { key: 'SCORE_DESC', label: 'Top rated', icon: 'topRated' },
  { key: 'FAVOURITES_DESC', label: 'Fan favourites', icon: 'favourites' },
  { key: 'START_DATE_DESC', label: 'Newest first', icon: 'year' },
  // Last, and only because home's "Recently completed" rail seeds this grid with
  // it — see `ExploreSort`. Placed after START_DATE_DESC because both are
  // date-ish and neither is a popularity signal, and the two most recognisable
  // orders stay at the top where the eye lands first.
  { key: 'END_DATE_DESC', label: 'Recently finished', icon: 'check' },
];

export const SCORE_FILTERS: FilterDef<number | null>[] = [
  { key: null, label: 'Any score', icon: 'score' },
  { key: 70, label: '70% and up', icon: 'score' },
  { key: 80, label: '80% and up', icon: 'score' },
  { key: 90, label: '90% and up', icon: 'score' },
];

/** Years, newest first, with the "any" option on top. */
export const YEAR_FILTERS: FilterDef<number | null>[] = [
  { key: null, label: 'Any year', icon: 'year' },
  ...yearOptions().map((y) => ({ key: y as number | null, label: String(y), icon: 'year' as AppIconName })),
];

/** One removable summary of what is narrowing the grid. */
export interface FilterChipDef {
  /** Stable key so the chip list is diffable. */
  id: string;
  /** Uppercase category word: GENRE, FORMAT, STATUS, YEAR, SCORE, SORT. */
  label: string;
  value: string;
  icon: AppIconName;
}

/**
 * Turn the filter object into the chip row. The chips are not decoration —
 * they are the readable form of a state that is otherwise spread across five
 * pills, and each one is a one-tap undo for its own slice.
 */
export function activeChips(f: ExploreFilters): FilterChipDef[] {
  const chips: FilterChipDef[] = [];

  for (const g of f.genres) {
    chips.push({
      id: `genre:${g}`,
      label: 'Genre',
      value: g,
      icon: GENRE_ICONS[g] ?? 'sparkles',
    });
  }
  if (f.format) {
    const d = FORMAT_FILTERS.find((x) => x.key === f.format);
    chips.push({ id: 'format', label: 'Format', value: d?.label ?? f.format, icon: 'clapper' });
  }
  if (f.status) {
    const d = STATUS_FILTERS.find((x) => x.key === f.status);
    chips.push({ id: 'status', label: 'Status', value: d?.label ?? f.status, icon: 'airing' });
  }
  if (f.year) {
    chips.push({ id: 'year', label: 'Year', value: String(f.year), icon: 'year' });
  }
  if (f.minScore != null) {
    chips.push({ id: 'score', label: 'Score', value: `${f.minScore}%+`, icon: 'score' });
  }
  if (f.sort !== DEFAULT_FILTERS.sort) {
    const d = SORT_FILTERS.find((x) => x.key === f.sort);
    chips.push({ id: 'sort', label: 'Sort', value: d?.label ?? f.sort, icon: 'sort' });
  }
  return chips;
}
