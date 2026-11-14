// Schedule screen data layer — the airing list, ONE LOCAL DAY at a time.
//
// WHY PER DAY AND NOT ONE 7-DAY WINDOW. AniList's `Page.airingSchedules`
// accepts a time RANGE and returns it `sort: TIME`, paginated at 50, and the
// screen wants seven days of it. Fetching the whole week in one range is a
// single cache key but still 6–10 sequential requests, and every one of them
// has to land before ANYTHING renders — the old screen's "next 24h" flat list
// became an eight-second spinner in a busy season. Keying by day instead makes
// the unit of work match the unit of display: today's list is one or two
// requests and it paints as soon as it arrives, and the other six stream in
// behind it.
//
// CACHED PER DAY, 10 MINUTES. An airing schedule is one of the most stable
// things the app can fetch — it changes when AniList corrects a time, not when
// you look at it — so the TTL is measured in minutes rather than seconds. A tab
// switch, a screen re-focus or a mode flip all cost zero requests, which is the
// whole point of a tab that is mounted once and revisited all session. Ten
// minutes also covers the midnight rollover's cache generation for free.
//
// PAGED, WITH AN HONEST CEILING. A single day CAN exceed AniList's 50-per-page
// — a Saturday at the end of a heavy season runs to a hundred-plus — so the
// fetcher walks pages until `hasNextPage` is false, capped at
// `SCHEDULE_MAX_PAGES`. The cap is reported back as `truncated` rather than
// silently dropped: a day that shows "200+" instead of "86" is telling the
// truth about its own size, and a schedule that quietly showed half of a
// Saturday would not be one at all.
//
// DAY BOUNDARIES ARE LOCAL MIDNIGHTS, and `addDays` walks the calendar rather
// than adding 86400 seconds. A DST transition makes some days 23 hours and
// others 25; arithmetic would slide the whole week an hour twice a year and
// quietly drop or double the boundary episode.
//
// CACHING LIVES IN `lib/query`. This module walks pages and shapes the result;
// whether the answer came from memory, from disk or from AniList is not its
// business, and making it the business of every module is what produced seven
// requests for one week's worth of data before.

import type { MediaItem } from '../anilist';
import { gql } from '../net/gql';

export interface AiringItem {
  episode: number;
  /** Unix seconds. AniList is UTC; every display converts to local. */
  airingAt: number;
  media: MediaItem;
}

export interface AiringDay {
  /** Local midnight of the day, in seconds. Doubles as the cache key. */
  start: number;
  items: AiringItem[];
  /** AniList had more pages than `SCHEDULE_MAX_PAGES` allowed. */
  truncated: boolean;
}

export const DAY_SECONDS = 86_400;

/** AniList's own page ceiling for this connection. */
export const SCHEDULE_PAGE_SIZE = 50;

/**
 * Four pages = 200 episodes in one day. Past that a single day is not a thing
 * the screen can usefully show, and the cost matters more than the tail: each
 * page is a request against a ~30/minute budget shared by the whole app.
 */
export const SCHEDULE_MAX_PAGES = 4;

const SCHEDULE_QUERY = `
  query ($from: Int, $to: Int, $page: Int, $perPage: Int) {
    Page(page: $page, perPage: $perPage) {
      pageInfo { hasNextPage }
      airingSchedules(airingAt_greater: $from, airingAt_lesser: $to, sort: TIME) {
        episode
        airingAt
        media {
          id
          title { english romaji native }
          coverImage { large extraLarge color }
          bannerImage
          format
          episodes
          status
        }
      }
    }
  }
`;

/** Local midnight of the day containing `ts`, in seconds. */
export function startOfDay(ts: number): number {
  const d = new Date(ts * 1000);
  d.setHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

/**
 * The local midnight `days` after the one containing `ts`.
 *
 * Walks the CALENDAR (`setDate`) instead of adding 86_400 seconds. On a DST
 * boundary a day is 23 or 25 hours long, and arithmetic moves every day after
 * it by an hour — which would slide the whole schedule an hour twice a year and
 * drop or duplicate whatever aired exactly on the boundary.
 */
export function addDays(ts: number, days: number): number {
  const d = new Date(ts * 1000);
  d.setDate(d.getDate() + days);
  d.setHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

async function requestDay(
  start: number,
  page: number
): Promise<{ items: AiringItem[]; hasNextPage: boolean }> {
  const block = await gql<{
    Page?: { airingSchedules?: AiringItem[]; pageInfo?: { hasNextPage?: boolean } };
  }>(SCHEDULE_QUERY, {
    variables: { from: start, to: start + DAY_SECONDS, page, perPage: SCHEDULE_PAGE_SIZE },
  });
  return {
    items: block.Page?.airingSchedules ?? [],
    hasNextPage: block.Page?.pageInfo?.hasNextPage ?? false,
  };
}

/**
 * Every episode airing inside one local day, soonest first.
 *
 * This walks AniList's pages and nothing else. Deduplication, expiry and
 * in-flight sharing are `useAiringDay`'s job now — see `lib/query/hooks.ts` —
 * which matters most for the paging loop below: two callers walking the same
 * day would each spend their own page requests, and the transport's global
 * de-duplication collapses them because the page query is keyed on `start` and
 * `page`, not on who asked.
 */
export async function loadAiringDay(start: number): Promise<AiringDay> {
  const items: AiringItem[] = [];
  const seen = new Set<string>();
  let page = 1;
  let truncated = false;

  while (page <= SCHEDULE_MAX_PAGES) {
    const block = await requestDay(start, page);
    for (const a of block.items) {
      // AniList re-indexes times between two pages of the same fetch, so the
      // same airing can appear on both. Cheap to drop, invisible if we don't.
      const id = `${a.media.id}:${a.episode}:${a.airingAt}`;
      if (seen.has(id)) continue;
      seen.add(id);
      items.push(a);
    }
    if (!block.hasNextPage) break;
    page++;
    if (page > SCHEDULE_MAX_PAGES) truncated = true;
  }

  items.sort((a, b) => a.airingAt - b.airingAt);
  return { start, items, truncated };
}
