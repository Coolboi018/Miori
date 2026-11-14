// Every AniList read the app performs, as a hook.
//
// One shape for all of them, so a screen never has to know that some endpoints
// cache and some do not. The three states a screen actually has to distinguish
// are named here and are the reason this file exists at all:
//
//   data === undefined   nothing to show yet — render a skeleton at the REAL
//                        geometry, never a spinner over an empty area
//   data + isFetching    showing stale data while it revalidates — render it
//                        DIMMED, which is the pattern this codebase already used
//                        and the one that stops a tab switch feeling like a
//                        flash of nothing
//   error                only worth showing when there is no data. An error over
//                        good content is noise; `refetchOnError` keeps the old
//                        data in place, so this branch is genuinely rare
//
// A note on the missing loading state. There is deliberately no
// `isLoading -> spinner` path left in any of these: a screen that has cached
// data must never replace it with a spinner, and a screen with no cached data
// has nothing to be impatient about.

import { keepPreviousData, useQuery, type UseQueryResult } from '@tanstack/react-query';
import {
  fetchCharacter,
  fetchCharacters,
  fetchHomeSections,
  fetchMedia,
  type CharacterDetail,
  type CharacterWithVA,
  type HomeSections,
  type MediaDetail,
} from '@/lib/anilist';
import {
  fetchBrowse,
  fetchExploreSections,
  type BrowseResult,
  type ExploreFilters,
  type ExploreSections,
} from '@/lib/anilist/explore';
import { loadAiringDay, addDays, type AiringDay } from '@/lib/anilist/schedule';
import { normaliseQuery, searchAnime, SEARCH_PAGE_SIZE, type SearchResult } from '@/lib/anilist/search';
import { qk } from './keys';

/**
 * The airing schedule's own staleness, which is nothing like everything else's:
 * a day is valid UNTIL THAT DAY IS OVER.
 *
 * The rule is a day, not a number of minutes, because the cache key is the day's
 * local midnight and the window only ever slides FORWARD. Yesterday's entry stops
 * being reachable the moment the window moves past it, so "valid until the day
 * ends" is not a rule that needs enforcing — it is what the key shape already
 * does. Nothing has to expire it, sweep it, or check it.
 *
 * WHY THAT IS THE RIGHT RULE, and it is not only about saving requests. What airs
 * on a given day is a list AniList assembled in advance: the shows are known and
 * the slots are set. Within the day itself the realistic change is a corrected
 * time, and a corrected time is worth less than the requests spent chasing it.
 *
 * THE SLIDING WINDOW IS THE ACTUAL WIN, and it is worth spelling out because it
 * is easy to miss. The screen asks for seven days. Tomorrow it asks for seven
 * days again — and six of them are the same keys it already has. So steady state
 * is ONE new day's fetch per day, not six, however long the app is left open.
 * Every TTL scheme spends more than that: a flat one re-checks days that cannot
 * have changed, and a distance-scaled one still re-checks the far ones on every
 * app resume. This spends exactly the one request that is genuinely new.
 *
 * `addDays` rather than `start + 86_400`, so a DST boundary does not expire a day
 * an hour early or late.
 *
 * FLOORED TO A 15-MINUTE BUCKET on purpose. The raw answer shrinks continuously,
 * and `staleTime` is recomputed on every render of a screen that ticks every 30
 * seconds; quantising means the option is stable within a quarter hour and cannot
 * churn the observer.
 */
const MIN_AIRING_STALE_MS = 5 * 60_000;
const AIRING_STALE_BUCKET_MS = 15 * 60_000;

export function airingStaleTime(start: number): number {
  const now = Date.now() / 1000;
  const untilDayEnds = addDays(start, 1) - now;
  const bucketed =
    Math.floor(untilDayEnds / AIRING_STALE_BUCKET_MS) * AIRING_STALE_BUCKET_MS;
  return Math.max(MIN_AIRING_STALE_MS, bucketed);
}

/** Every home rail, in one response. */
export function useHomeSections(
  userId: number | null | undefined,
  opts: { current: boolean; planning: boolean }
): UseQueryResult<HomeSections, Error> {
  return useQuery({
    queryKey: qk.home(userId ?? null, opts.current, opts.planning),
    queryFn: () => fetchHomeSections(userId ?? null, opts),
    /**
     * WAIT FOR THE SESSION, DO NOT ASSUME THE GUEST.
     *
     * `undefined` is "nobody has read the keychain yet" and it means NO query at
     * all. This used to collapse it to `null` and fire the anonymous request
     * immediately, on the reasoning that the guest screen is what a signed-out
     * visitor wants anyway.
     *
     * That reasoning only holds for signed-out visitors. For a signed-in one — the
     * majority of the people who use a list-tracking app — it spends a full 70-item
     * home request on five rails they will never see, moments before the real one
     * for their own account. On every cold start, forever, against a rate limit the
     * rest of this file is careful about.
     *
     * The cost of waiting is one keychain read on the splash screen, where nothing
     * is visible yet — `refreshUserId` is kicked off in the root layout for exactly
     * that reason. By the time home mounts it has usually settled, so this
     * `enabled` gate is nearly always already true and never gates anything.
     */
    enabled: userId !== undefined,
    placeholderData: keepPreviousData,
    /**
     * THE ONE QUERY THAT WANTS STRUCTURAL SHARING, and the reasoning in
     * `client.ts` for turning it off app-wide does not apply here.
     *
     * That note is about screens that replace whole sections and then discard the
     * references — they pay for the deep diff and get nothing. Home is the
     * opposite: it renders all seventy-odd items, and every one of them is a
     * `memo`'d `PosterCard` whose memo compares `media` by identity. Without
     * sharing, a refetch hands every tile a brand new object and all seventy
     * re-render.
     *
     * That used to be a cost nobody paid, because nothing refetched home while it
     * was on screen. Now a list write invalidates it (see `invalidateUserList`), so
     * the cost sits on the hot path of the most common action in the app: long-press
     * a tile, save, watch the rail update. With sharing, the two or three titles that
     * actually changed get new identities and re-render; the other sixty-seven are
     * `===` to what they were and the memo does its job.
     *
     * The deep diff itself walks ~70 items of plain JSON, which is cheap next to
     * re-rendering seventy tiles on a low-end phone. That is the trade.
     */
    structuralSharing: true,
  });
}

/** Explore's curated sections — hero, chart, mosaic, rails. One response. */
export function useExploreSections(): UseQueryResult<ExploreSections, Error> {
  return useQuery({
    queryKey: qk.exploreSections(),
    queryFn: () => fetchExploreSections(),
  });
}

/**
 * One page of the filterable grid.
 *
 * `placeholderData` keeps the PREVIOUS page on screen while the next one loads,
 * which is what makes the pager feel instant. Flipping from page 1 to page 2
 * without it blanks nine tiles for 400ms and the user reads that as a stutter
 * rather than as loading.
 */
export function useBrowseGrid(
  filters: ExploreFilters,
  page: number,
  perPage: number
): UseQueryResult<BrowseResult, Error> {
  return useQuery({
    queryKey: qk.browse(filters, page),
    queryFn: () => fetchBrowse(filters, page, perPage),
    placeholderData: keepPreviousData,
  });
}

/**
 * One local day of airing schedule.
 *
 * `enabled` exists so the window can be a list of days rather than seven
 * separate hooks in a loop with the rules hoisted out — a hook in a `.map` is
 * its own component, and a component per day means a component that mounts and
 * unmounts as the window rolls over at midnight.
 */
export function useAiringDay(
  start: number,
  { enabled = true }: { enabled?: boolean } = {}
): UseQueryResult<AiringDay, Error> {
  return useQuery({
    queryKey: qk.airingDay(start),
    queryFn: () => loadAiringDay(start),
    staleTime: airingStaleTime(start),
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    // A day that already answered does not go back to `loading` on a
    // revalidation. That single line is the difference between "silently
    // refreshed" and "the whole list turned into a skeleton because the user
    // looked at the tab again".
    // The ONE escape hatch from "a day is valid until it is over".
    //
    // Reconnecting refetches regardless of staleness, which is exactly right:
    // coming out of a tunnel or a dead zone is the moment the cached copy is most
    // likely to be behind — the user was away while AniList corrected something —
    // and it is also a moment they are about to look. A manual retry on the
    // error card is the other one.
    refetchOnReconnect: true,
    enabled,
    placeholderData: keepPreviousData,
  });
}

/**
 * One page of search results.
 *
 * `enabled` is false for a query under AniList's three-character floor, so an
 * unfinished word costs nothing. The old code checked the same condition before
 * fetching; putting it in the key means the check lives in one place instead.
 */
export function useSearchResults(
  query: string,
  page: number,
  { enabled = true }: { enabled?: boolean } = {}
): UseQueryResult<SearchResult, Error> {
  const key = normaliseQuery(query);
  return useQuery({
    queryKey: qk.search(key, page),
    queryFn: () => searchAnime(query, page, SEARCH_PAGE_SIZE),
    enabled: enabled && key.length >= 3,
    placeholderData: keepPreviousData,
  });
}

/**
 * An anime that will never change again, cached for a long time.
 *
 * A FINISHED series has no next episode, no correcting score, no moving popularity
 * and no schedule to shift — every field in `DETAIL_QUERY` is settled. Refetching
 * it is a request that cannot return anything new.
 *
 * A WEEK, not forever. Two things can still legitimately change on a finished
 * title and neither is worth a shorter window on every other anime: AniList's own
 * metadata gets corrected (a wrong episode count, a retitled romanisation), and
 * the user's own list entry is a separate query that revalidates on its own. One
 * week also matches `RESTORE_MAX_AGE_MS` in `client.ts`, so a detail page cannot
 * outlive the persisted cache that holds it.
 *
 * `null` status falls to the short window. An unrecognised status is not evidence
 * of immutability, and the cost of being wrong here is only one request.
 */
const SETTLED_STALE_MS = 7 * 24 * 60 * 60_000;

/**
 * A still-running anime, which is a small minority of any detail page's traffic.
 *
 * See the note on `mediaStaleTime` for why this is not the 60s default.
 */
const AIRING_STALE_MS = 5 * 60_000;

/** Statuses whose detail payload can never change again. */
const SETTLED_STATUSES = new Set(['FINISHED', 'COMPLETED']);

/**
 * How stale one anime's detail may be, decided by whether that anime is finished.
 *
 * A FUNCTION `staleTime` rather than a number, and the reason it costs nothing to
 * compute is the whole trick: the status is already sitting in the cache from the
 * previous fetch, so learning it is free and needs no request of its own. The
 * first visit after a cold restore has no data to read and correctly falls
 * through to the short window; from the second visit on, a finished anime stops
 * refetching.
 *
 * `AIRING_STALE_MS` rather than the 60s default, because this payload carries
 * `nextAiringEpisode` and it moves the moment an episode lands. Sixty seconds was
 * chosen against how fast a RAIL's contents change; an airing schedule is not
 * that. Five minutes still catches a new episode within the same sitting and
 * spends a quarter of the requests on the one anime out of ten that is still
 * running.
 *
 * IMPORTANT: this must stay a function of the CACHED data and never a separate
 * status fetch. A second request to learn the status would cost exactly what the
 * long window saves, and would be one request per detail page visited.
 */
function mediaStaleTime(data: MediaDetail | undefined): number {
  return data?.status && SETTLED_STATUSES.has(data.status) ? SETTLED_STALE_MS : AIRING_STALE_MS;
}

/** One anime's full detail payload. */
export function useMediaDetail(id: number): UseQueryResult<MediaDetail, Error> {
  return useQuery({
    queryKey: qk.media(id),
    queryFn: () => fetchMedia(id),
    staleTime: (query) => mediaStaleTime(query.state.data as MediaDetail | undefined),
  });
}

/**
 * ONE character, for the info sheet — a request the sheet makes, not the cast list.
 *
 * `enabled` is passed rather than inferred so that a CLOSED sheet costs no
 * request, exactly as `ListSheetHost` disables its entry query: the sheet host is
 * mounted at the root for the whole session, and a query that fired on mount would
 * be a request for a character nobody has looked at.
 *
 * A generous `staleTime` because a character's description and stats are close to
 * immutable. Someone who opened a sheet, closed it and reopened it inside the
 * session pays nothing — the same property `prefetchAnime` gives the detail page.
 */
export function useCharacter(
  id: number,
  { enabled = true }: { enabled?: boolean } = {}
): UseQueryResult<CharacterDetail | null, Error> {
  return useQuery({
    queryKey: qk.character(id),
    queryFn: () => fetchCharacter(id),
    enabled: enabled && id > 0,
    staleTime: 10 * 60_000,
  });
}

/** The extended cast — a separate request, on a separate tab of the detail page. */
export function useCharacters(
  id: number,
  { enabled = true }: { enabled?: boolean } = {}
): UseQueryResult<CharacterWithVA[], Error> {
  return useQuery({
    queryKey: qk.characters(id),
    queryFn: () => fetchCharacters(id),
    enabled,
  });
}

/**
 * Why `placeholderData` is `keepPreviousData` on the pagers and on home.
 *
 * It holds the last successful value on screen while a new one is in flight,
 * which is what makes paging feel instant: without it, flipping from page 1 to
 * page 2 blanks nine tiles for 400ms and the user reads that as a stutter
 * rather than as loading.
 *
 * On home the key changes when a rail toggle flips, so it also holds the
 * previous rails under the new query. That is harmless rather than wrong: the
 * five discovery rails are byte-identical between the two queries, and the two
 * list rails are gated on the same flag that caused the key change, so the rail
 * the user just switched off is not drawn regardless of what the placeholder
 * holds.
 */
export { keepPreviousData };

