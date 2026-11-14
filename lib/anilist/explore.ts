// Explore screen data layer.
//
// TWO requests fill the whole page:
//
//   1. fetchExploreSections() — every curated section (hero, chart, mosaic,
//      rails, grid) is an ALIAS on ONE query.
//   2. fetchBrowse(filters) — the filterable grid, keyed on the filter
//      signature so flipping between two filters and back costs nothing.
//
// The screen this replaced made TEN requests on mount (one seasonal, six
// format, three status) and blocked the entire UI on all ten, against
// AniList's documented ~30 requests/minute budget.
//
// ONE DISCOVERY WORTH RECORDING: `genre_in` on `Page.media` is an AND, not an
// OR. `genre_in: ["Sci-Fi", "Mecha"]` returns the intersection — 1 result when
// combined with `status: RELEASING`, and 0 once a score floor is added, which
// reads exactly like a network failure. A multi-select genre filter therefore
// cannot be one Page: it is one ALIASED Page per selected genre (still a single
// request), merged round-robin so every picked genre is represented instead of
// the first one filling the whole grid.
//
// `Page.pageInfo.total` is capped at 5000 by AniList, so a browse total is
// "at least N" — hence the `~` the screen puts in front of it.
//
// CACHING LIVES IN `lib/query`. This file is query documents and shape
// normalisation, which is what it should have been all along; the 60s TTL maps
// and inflight maps that used to sit here now live in one place that can see
// every request in the app.

import type { MediaFormat, MediaItem, MediaStatus } from '../anilist';
import { gql } from '../net/gql';

/** Exactly `MediaItem`. Every section and the grid share it. */
const FIELDS = `
        id
        title { english romaji native }
        coverImage { large extraLarge color }
        bannerImage
        genres
        seasonYear
        averageScore
        format
        episodes
        status`;

// ---------------------------------------------------------------------------
// 1. The curated sections — one request
// ---------------------------------------------------------------------------

export interface ExploreSections {
  /** Hero carousel. TRENDING_DESC. */
  trending: MediaItem[];
  /** "Airing this week" chart. RELEASING + trending. */
  airing: MediaItem[];
  /**
   * "Top rated" rail. SCORE_DESC alone surfaces 8.0-scored shows nobody has
   * heard of, so there is a popularity floor — a score you cannot find is not
   * a recommendation.
   */
  topRated: MediaItem[];
  /** "Fan favourites" banner rail. FAVOURITES_DESC — a genuinely different
   *  ordering from popularity, and it is the one AniList maintains best. */
  favourites: MediaItem[];
  /** Five shows for the genre spotlight mosaic (Sci-Fi). */
  spotlight: MediaItem[];
  /** "Feature films" grid. */
  films: MediaItem[];
  /** "Coming soon" rail. */
  upcoming: MediaItem[];
}

const EXPLORE_QUERY = `query {
  trending: Page(page: 1, perPage: 8) {
    media(sort: TRENDING_DESC, type: ANIME, isAdult: false) {${FIELDS} }
  }
  airing: Page(page: 1, perPage: 14) {
    media(status: RELEASING, sort: TRENDING_DESC, type: ANIME, isAdult: false) {${FIELDS} }
  }
  topRated: Page(page: 1, perPage: 14) {
    media(sort: SCORE_DESC, popularity_greater: 2000, type: ANIME, isAdult: false) {${FIELDS} }
  }
  favourites: Page(page: 1, perPage: 14) {
    media(sort: FAVOURITES_DESC, type: ANIME, isAdult: false) {${FIELDS} }
  }
  spotlight: Page(page: 1, perPage: 5) {
    media(genre_in: ["Sci-Fi"], sort: POPULARITY_DESC, type: ANIME, isAdult: false) {${FIELDS} }
  }
  films: Page(page: 1, perPage: 12) {
    media(format: MOVIE, sort: POPULARITY_DESC, type: ANIME, isAdult: false) {${FIELDS} }
  }
  upcoming: Page(page: 1, perPage: 14) {
    media(status: NOT_YET_RELEASED, sort: POPULARITY_DESC, type: ANIME, isAdult: false) {${FIELDS} }
  }
}`;

export async function fetchExploreSections(): Promise<ExploreSections> {
  const d = await gql<Record<string, any>>(EXPLORE_QUERY);
  // A partial failure degrades to empty sections rather than a blank screen:
  // AniList answers with `data` for whatever resolved alongside any errors.
  return {
    trending: d.trending?.media ?? [],
    airing: d.airing?.media ?? [],
    topRated: d.topRated?.media ?? [],
    favourites: d.favourites?.media ?? [],
    spotlight: d.spotlight?.media ?? [],
    films: d.films?.media ?? [],
    upcoming: d.upcoming?.media ?? [],
  };
}

// ---------------------------------------------------------------------------
// 2. The filterable grid — one request per filter signature
// ---------------------------------------------------------------------------

/** AniList `MediaSort` values worth offering. All descending — nobody browsing
 *  a discovery grid wants the weakest show first.
 *
 *  `END_DATE_DESC` is here because home's "Recently completed" rail IS this sort
 *  (see `discoveryAliases` in `lib/anilist.ts`), and its See all seeds this grid.
 *  Without it the button would have to promise one list and deliver another — the
 *  grid can express `status: FINISHED` but nothing ordered the way that rail is.
 *  Nothing in the query builder needed changing: the sort is interpolated
 *  straight into `sort: [...]`, so adding a value here is what makes it real.
 */
export type ExploreSort =
  | 'TRENDING_DESC'
  | 'POPULARITY_DESC'
  | 'SCORE_DESC'
  | 'START_DATE_DESC'
  | 'FAVOURITES_DESC'
  | 'END_DATE_DESC';

export interface ExploreFilters {
  /** 0–3 genres, OR-ed together (see the note at the top of this file). */
  genres: string[];
  format: MediaFormat | null;
  status: MediaStatus | null;
  /** Season year, 0 = any. */
  year: number | null;
  /** `averageScore_greater` floor, null = any. */
  minScore: number | null;
  sort: ExploreSort;
}

/** How many genres a multi-select can hold. Also the alias count per request. */
export const MAX_GENRES = 3;

export const DEFAULT_FILTERS: ExploreFilters = {
  genres: [],
  format: null,
  status: null,
  year: null,
  minScore: null,
  sort: 'TRENDING_DESC',
};

/** Cheap, order-significant cache key. Also what the screen compares to decide
 *  whether a filter change actually changes the query. */
export function filtersKey(f: ExploreFilters): string {
  return [
    f.genres.join('+') || '-',
    f.format ?? '-',
    f.status ?? '-',
    f.year ?? '-',
    f.minScore ?? '-',
    f.sort,
  ].join('|');
}

/** True when anything is narrowed. Drives the Reset button's enabled state. */
export function hasActiveFilters(f: ExploreFilters): boolean {
  return (
    f.genres.length > 0 ||
    f.format != null ||
    f.status != null ||
    f.year != null ||
    f.minScore != null ||
    f.sort !== DEFAULT_FILTERS.sort
  );
}

export interface BrowseResult {
  items: MediaItem[];
  /**
   * AniList's count, capped at 5000 and inflated by overlap when several
   * genres are picked — the screen prefixes it with `~` in that case.
   */
  total: number;
  hasNextPage: boolean;
  /** True when the totals cannot be added honestly (multi-genre). */
  approximate: boolean;
}

/**
 * The filter args shared by every alias, as a GraphQL argument string.
 * The genre is left out: each alias carries its own.
 */
function commonArgs(f: ExploreFilters): string {
  const args: string[] = ['type: ANIME', 'isAdult: false'];
  if (f.format) args.push(`format: ${f.format}`);
  if (f.status) args.push(`status: ${f.status}`);
  if (f.year) args.push(`seasonYear: ${f.year}`);
  // `null` is not a valid literal, so an unset floor simply omits the arg.
  if (f.minScore != null) args.push(`averageScore_greater: ${f.minScore}`);
  args.push(`sort: [${f.sort}]`);
  return args.join(', ');
}

function browseQuery(f: ExploreFilters, page: number, perPage: number): string {
  // Split the page budget across the picked genres so the merged result is
  // still about `perPage` items, and each genre gets at least 4.
  const genres = f.genres.length ? f.genres : [null];
  const each = Math.max(4, Math.ceil(perPage / genres.length));
  const tail = `${commonArgs(f)}) {${FIELDS} }`;
  const aliases = genres
    .map(
      (g, i) =>
        `    g${i}: Page(page: ${page}, perPage: ${each}) {
      pageInfo { hasNextPage total }
      media(${g ? `genre: ${JSON.stringify(g)}, ` : ''}${tail}
    }`
    )
    .join('\n');
  return `query {\n${aliases}\n}`;
}

/**
 * Round-robin merge, de-duped by id.
 *
 * Concatenating the aliases would let the first genre fill the entire grid and
 * leave the other two invisible. Interleaving keeps every picked genre
 * represented, which is the whole point of picking more than one.
 */
function interleave(pages: MediaItem[][], limit: number): MediaItem[] {
  const seen = new Set<number>();
  const out: MediaItem[] = [];
  const longest = pages.reduce((n, p) => Math.max(n, p.length), 0);
  for (let i = 0; i < longest && out.length < limit; i++) {
    for (const page of pages) {
      const m = page[i];
      if (!m || seen.has(m.id)) continue;
      seen.add(m.id);
      out.push(m);
      if (out.length >= limit) break;
    }
  }
  return out;
}

export async function fetchBrowse(
  f: ExploreFilters,
  page = 1,
  perPage = 12
): Promise<BrowseResult> {
  const d = await gql<Record<string, any>>(browseQuery(f, page, perPage));
  const pages = Object.keys(d)
    .sort()
    .map((k) => (d[k]?.media ?? []) as MediaItem[]);
  const infos = Object.keys(d)
    .sort()
    .map((k) => d[k]?.pageInfo ?? { hasNextPage: false, total: 0 });

  return {
    items: interleave(pages, perPage),
    total: infos.reduce((n, i) => n + (i.total ?? 0), 0),
    hasNextPage: infos.some((i) => i.hasNextPage),
    approximate: f.genres.length > 1,
  };
}

// ---------------------------------------------------------------------------
// Option registries — the values the dropdowns offer
// ---------------------------------------------------------------------------

/**
 * AniList's own `GenreCollection`, minus Hentai, in the order a browser wants
 * them (broad strokes first, niche last). Hardcoded on purpose: it is a
 * fixed, adult-free list, and `fetchGenres()` would be a fifth request to
 * redownload a constant.
 */
export const EXPLORE_GENRES = [
  'Action',
  'Adventure',
  'Fantasy',
  'Sci-Fi',
  'Comedy',
  'Drama',
  'Romance',
  'Slice of Life',
  'Supernatural',
  'Mystery',
  'Thriller',
  'Mecha',
  'Sports',
  'Psychological',
  'Horror',
  'Music',
  'Mahou Shoujo',
  'Ecchi',
] as const;

export const FORMAT_OPTIONS: MediaFormat[] = [
  'TV',
  'TV_SHORT',
  'MOVIE',
  'OVA',
  'ONA',
  'SPECIAL',
  'MUSIC',
];

export const STATUS_OPTIONS: MediaStatus[] = [
  'RELEASING',
  'FINISHED',
  'NOT_YET_RELEASED',
  'HIATUS',
  'CANCELLED',
];

/** The newest AniList season year back a couple of decades. */
export function yearOptions(now = new Date().getFullYear()): number[] {
  const out: number[] = [];
  for (let y = now; y >= now - 24; y--) out.push(y);
  return out;
}
