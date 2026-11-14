// Search screen data layer.
//
// ONE request per (query, page), and NO cache of its own — see `lib/query`.
// The old module carried a 60s TTL map plus an in-flight map, and the reason
// that mattered is worth keeping in the record: search is a TAB, so the query
// you typed five minutes ago is the query you type again the moment you come
// back from a show. The second time should cost nothing, and now it costs
// nothing because the response is on disk, not because a timer happened not to
// have expired.
//
// PAGED, NOT APPENDED. The old `searchAnime` hardcoded `page: 1` and threw
// away the `pageInfo { hasNextPage }` its own query already asked for. A list
// that grows forever is a corridor with no end and no way to say "that was
// everything"; a pager is honest about how big the catalogue is and keeps the
// rendered set a constant size.
//
// `total` IS NOT TRUSTED ALONE. AniList's count under `SEARCH_MATCH` is
// unreliable — it reports 0 for plenty of genuine result sets — so the screen
// derives its page count from `hasNextPage` and only uses `total` when it is
// sane. That is why both come back.

import type { MediaItem } from '../anilist';
import { gql } from '../net/gql';

/**
 * Characters before a query is worth sending: THREE, and that is AniList's
 * floor, not this screen's taste.
 *
 * VERIFIED against the live API, not assumed — `Page.media(search:)` under
 * `SEARCH_MATCH` returns `total: 0` for every query shorter than three
 * characters. `"on"` — 0, `"an"` — 0. At three it works: `"cow"` — 3 results,
 * `"one"` — 5000.
 *
 * Which matters because the failure is SILENT. A two-character threshold fires
 * a real request, gets an empty page back, and renders "Nothing matches 'on'"
 * — indistinguishable from a query that genuinely has no results, so a
 * threshold set too low reads to the user as the app being broken rather than
 * as an unfinished word. Three characters is the shortest prefix AniList will
 * answer at all.
 */
export const SEARCH_MIN_CHARS = 3;

/**
 * Results per page. Twenty-four is three full rows of the widest grid the
 * screen ever picks (2-up on a narrow phone, 3-up otherwise), so a page is
 * never a ragged two-tile last row.
 */
export const SEARCH_PAGE_SIZE = 24;

/** Field set shared by every search result — everything a tile or a row shows. */
const FIELDS = `
        id
        title { english romaji native }
        coverImage { large extraLarge color }
        seasonYear
        averageScore
        format
        episodes
        status`;

const SEARCH_QUERY = `
  query ($search: String, $page: Int, $perPage: Int) {
    Page(page: $page, perPage: $perPage) {
      pageInfo { hasNextPage total }
      media(search: $search, type: ANIME, isAdult: false, sort: SEARCH_MATCH) {${FIELDS} }
    }
  }
`;

export interface SearchResult {
  items: MediaItem[];
  /** AniList's own word for "there is more". Always trust this over `total`. */
  hasNextPage: boolean;
  /** AniList's count. Zero on plenty of real result sets — see the header. */
  total: number;
}

/**
 * What the user typed, tidied: trimmed, inner runs of whitespace collapsed to
 * single spaces, CASING INTACT.
 *
 * This is the DISPLAY form — what goes in the field, what a recent-search chip
 * reads, and what the "nothing matches" message quotes. Lowercasing here would
 * put "cowboy bebop" on a chip where the user typed "Cowboy Bebop", which looks
 * like the app failed to keep what they entered.
 */
export function tidyQuery(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ');
}

/**
 * One canonical IDENTITY for a query: `tidyQuery`, lowercased.
 *
 * Used as the cache key AND as the identity of a recent search, so `"  Full
 * Metal "` and `"full metal"` are one entry everywhere rather than two. The
 * screen hands the display form to AniList and this form to its own bookkeeping.
 */
export function normaliseQuery(raw: string): string {
  return tidyQuery(raw).toLowerCase();
}

/** Whether a normalised query is worth a request. See `SEARCH_MIN_CHARS`. */
export function isSearchable(query: string): boolean {
  return query.length >= SEARCH_MIN_CHARS;
}

/**
 * One page of results for one query.
 *
 * No cache and no de-duplication here — both belong to `lib/query`, where they
 * are global. A re-query that races the original (a focus refresh landing while
 * the debounce fires) is joined rather than doubled, because TanStack holds the
 * one in-flight promise for this key; what a per-module map could never know is
 * that another screen wants the same document, and the global one can, because
 * the key IS the document.
 */
export async function searchAnime(
  q: string,
  page = 1,
  perPage = SEARCH_PAGE_SIZE
): Promise<SearchResult> {
  const block = await gql<{
    Page?: { media?: MediaItem[]; pageInfo?: { hasNextPage?: boolean; total?: number } };
  }>(SEARCH_QUERY, { variables: { search: q.trim(), page, perPage } });
  return {
    items: block.Page?.media ?? [],
    hasNextPage: block.Page?.pageInfo?.hasNextPage ?? false,
    total: block.Page?.pageInfo?.total ?? 0,
  };
}

/**
 * How many pages the current result set has.
 *
 * AniList caps `total` at 5000, so it is an UPPER BOUND ("at least N"), never
 * an exact count — "naruto" reports exactly 5000 against a catalogue far
 * larger. `hasNextPage` is the truth about whether more exists right now.
 *
 * Their MINIMUM is the honest answer, and it is why the pager's denominator
 * grows as you page rather than jumping to the final page on page one: the
 * `+1` means the last reachable page is discovered as you reach it, instead of
 * being guessed at in advance. Same honesty as the explore pager.
 */
export function searchPageCount(res: SearchResult, page: number): number {
  const reachable = page + (res.hasNextPage ? 1 : 0);
  const byTotal = res.total > 0 ? Math.ceil(res.total / SEARCH_PAGE_SIZE) : 0;
  return Math.max(1, byTotal > 0 ? Math.min(byTotal, reachable) : reachable);
}
