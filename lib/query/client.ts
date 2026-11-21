// The query client: every policy decision about when the app is allowed to talk
// to AniList, in one file.
//
// This is where the rate-limit posture is actually expressed. The numbers below
// are not tuning constants — each one is a direct answer to a specific way the
// app used to spend requests it did not need to.
//
//   staleTime 60s      A tab you come back to inside a minute costs NOTHING.
//                      This is the single biggest saver: before, revisiting a
//                      tab always revalidated because each cache expired on its
//                      own sixty-second clock and nothing coordinated them, so
//                      every tab switch was a request.
//
//   gcTime 30m         An entry leaves memory half an hour after the last screen
//                      using it. Long enough that hopping Home → Explore → Home
//                      is three reads of one cached value; short enough that a
//                      session does not accumulate every rail ever viewed.
//
//   retry 1            NOT two, and the transport already retries twice with
//                      backoff (`lib/net/gql.ts`). Retrying at two layers makes a
//                      dead connection cost 9 attempts across 3 of them, which
//                      is exactly the behaviour that earns a rate limit.
//
//   refetchOnReconnect yes  Coming out of a tunnel should refresh. The old code
//                      had no notion of connectivity, so a request fired while
//                      offline failed, surfaced as an error, and left the user
//                      pulling to refresh by hand.
//
//   refetchOnWindowFocus  NO. React Native has no window-focus event; the option
//                      does nothing on a device and enabling it is a habit
//                      imported from the web. Foreground is handled properly by
//                      AppState in `refetchStaleOnForeground`, which can tell
//                      "the user came back" from "the app was never closed".

import { QueryClient, onlineManager } from '@tanstack/react-query';
import {
  getNetworkSnapshot,
  isOfflineError,
  subscribeNetworkStatus,
} from '../net/connectivity';

/**
 * How stale a screen's data may be before a background refetch is worth a
 * request.
 *
 * Sixty seconds is chosen against AniList's budget rather than against how fast
 * the data moves: trending genuinely does not change faster than that, and a
 * longer window would let the home rails visibly rot over a long session.
 */
const DEFAULT_STALE_TIME_MS = 60_000;

/** Half an hour in memory. See the note at the top. */
const DEFAULT_GC_TIME_MS = 30 * 60_000;

/**
 * Cached entries older than this are dropped on restore rather than shown.
 *
 * Seven days. Long enough that opening the app on day three paints real content
 * instantly, short enough that a show which finished airing a fortnight ago is
 * not still on the schedule tab. Past it the screen simply fetches, which is
 * correct behaviour rather than a failure.
 */
export const RESTORE_MAX_AGE_MS = 7 * 24 * 60 * 60_000;

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: DEFAULT_STALE_TIME_MS,
      gcTime: DEFAULT_GC_TIME_MS,
      /**
       * ONE retry, except while the device is offline.
       *
       * The transport already retries transient failures twice, so a second
       * layer here is deliberately shallow (see the note above). An offline
       * error is not transient — there is nothing to retry until the network
       * comes back — so it fails immediately and React Query's pause machinery
       * resumes the query on reconnect instead of burning attempts now.
       */
      retry: (failureCount, error) => !isOfflineError(error) && failureCount < 1,
      refetchOnWindowFocus: false,
      refetchOnReconnect: true,
      /**
       * Every screen here replaces whole sections rather than merging into them,
       * so a structural diff of a 70-item response would cost real milliseconds
       * to arrive at references the code immediately discards anyway.
       *
       * `useHomeSections` OVERRIDES THIS to `true`, and the difference is worth
       * naming because the reasoning above does not hold for it: home renders all
       * seventy items as `memo`'d `PosterCard`s, so preserving identity is exactly
       * what stops a refetch from re-rendering every tile on screen. Home became a
       * refetch-while-visible query when a list write started invalidating it.
       */
      structuralSharing: false,
    },
    mutations: {
      retry: 0,
    },
  },
});

/**
 * Teach React Query about the device's connectivity.
 *
 * React Query ships a web-only `online`/`offline` listener; on React Native
 * those events do not exist, so `onlineManager` stays at its default (`true`)
 * and every query keeps retrying into a dead radio. This bridge is what makes
 * `refetchOnReconnect` in the policy above mean something: going offline pauses
 * eligible queries, and coming back flips the manager to online, which is the
 * event React Query already knows how to resume on.
 *
 * 'unknown' is treated as online. It only exists for the first few hundred
 * milliseconds of a cold launch, and pausing the home rails while the native
 * module answers would turn a fast start into a spinner.
 *
 * Returns the unsubscribe so the root layout can own the lifecycle.
 */
export function bindQueryOnlineManager(): () => void {
  const apply = () => {
    onlineManager.setOnline(getNetworkSnapshot().kind !== 'offline');
  };
  apply();
  return subscribeNetworkStatus(apply);
}

/**
 * Refetch ONE query, but only if it is actually stale.
 *
 * ⚠️ WHY THIS EXISTS, AND WHY IT IS NOT A ONE-LINER. `useQuery().refetch()`
 * **bypasses `staleTime` entirely** — it goes straight to the fetch path with no
 * staleness gate. Only the mount path (`shouldFetchOnMount`) respects it. This
 * was got wrong throughout the first pass of the caching work: home and explore
 * each called `refetch()` in a focus effect while a comment claimed it
 * "respects the 60s staleTime", so every single tab switch fired a forced
 * request. The schedule did the same across seven days at once.
 *
 * That is not merely wasteful, it is self-defeating: enough forced requests earn
 * AniList's 429, the transport then waits out `Retry-After`, and the screens sit
 * there doing nothing. Measured on device as tab switching going from 1–2s to
 * 3–4s — the cache was making things *slower* by removing the accidental
 * throttling that had been hiding the request storm.
 *
 * Checking `isStale` first applies the same gate the library applies on mount,
 * and is what makes "revisiting a tab inside a minute costs nothing" true rather
 * than aspirational.
 */
export function refetchIfStale(
  query: { isStale: boolean; refetch: () => unknown } | undefined
): void {
  if (query?.isStale) void query.refetch();
}

/**
 * Refetch what is stale when the app returns to the foreground, and not one
 * request more.
 *
 * A resume into a screen that never unmounted — the common case for a tab app,
 * since tabs stay mounted — produces no mount event, so nothing else would
 * notice the app had been away. Without this, data is only as fresh as it was
 * when the app was backgrounded, which on a phone is however long the user was
 * on a call.
 *
 * Walking the cache for `stale: true` rather than calling `invalidateQueries` is
 * deliberate. `invalidateQueries` marks its matches stale and then refetches
 * every one of them, so it would spend a request on data the user looked at ten
 * seconds ago. (`refetchType` has no `'stale'` value for exactly this reason —
 * that was the first thing tried, and it does not compile.)
 *
 * `fetch` rather than `refetch` so an already-running request is joined instead
 * of duplicated, and `throwOnError: false` because one failing query must not
 * reject the whole sweep and skip the rest.
 */
/**
 * How many resume refetches may be on the wire at once.
 *
 * The sweep used to fire EVERY stale query in one `Promise.all`. The transport's
 * sliding budget stopped that from earning a 429, but not from costing the user
 * something: twenty queued requests put the one screen they are actually looking
 * at behind nineteen they are not. Three at a time keeps the radio busy without
 * ever making the visible screen wait on the invisible ones.
 */
const FOREGROUND_BATCH = 3;

export async function refetchStaleOnForeground(): Promise<void> {
  await queryClient.resumePausedMutations();

  /**
   * WHAT COUNTS AS "STALE" IS NARROWER THAN IT LOOKS, and the two filters below
   * exist for what it does not cover.
   *
   * `Query.isStale()` (query-core 5.104) is `observers.some(isStale)` when a
   * query HAS observers, and `data === undefined || isInvalidated` when it does
   * not — so `findAll({ stale: true })` never returns an unmounted query merely
   * because its `staleTime` expired. It DOES return an unmounted query that was
   * INVALIDATED, which is where the waste actually was:
   *
   * 1. `getObserversCount() > 0` — only what a MOUNTED screen is holding. A
   *    write invalidates `['home']` and `['listEntry', id]` app-wide, so leaving
   *    the list sheet, backgrounding and resuming used to re-fetch entries for
   *    screens that were not open (and would be re-fetched again by their own
   *    mount path if the user went back). `refreshUserListOnForeground` already
   *    scopes itself this way.
   *
   * 2. `pending` + `fetchStatus: 'idle'` — a query NOTHING HAS ASKED FOR. This
   *    is a GUARD, not a repair, and the distinction is worth keeping because it
   *    is the difference between a rule and a superstition: today `isStale()`
   *    reports false for a never-fetched query, so this filter never fires. But
   *    `Query.fetch()` ignores `enabled` entirely — that flag only gates the
   *    observers' automatic fetching — so the day something invalidates the
   *    whole cache, `isStale()` flips to true and six deferred schedule days
   *    become six day-walks on the next resume. One line holding that door shut.
   *
   * An ERRORED query is deliberately still eligible: it has been asked for, it
   * has no data, and a resume is a reasonable moment to try again.
   */
  const eligible = queryClient
    .getQueryCache()
    .findAll({ stale: true })
    .filter((q) => q.getObserversCount() > 0)
    .filter((q) => !(q.state.status === 'pending' && q.state.fetchStatus === 'idle'));

  for (let i = 0; i < eligible.length; i += FOREGROUND_BATCH) {
    await Promise.all(
      eligible.slice(i, i + FOREGROUND_BATCH).map((q) =>
        // One failed query must not reject the sweep and skip the rest, so the
        // rejection is absorbed here rather than left to the caller.
        q.fetch().catch(() => undefined)
      )
    );
  }
}

/**
 * Force the ONE cache slice outside this device's reach: the signed-in user's
 * own data.
 *
 * THE POLICY GAP THIS CLOSES. Everything else in this cache is read-mostly —
 * media, explore, schedule change too slowly for a foreground to matter. But
 * the user's list is EXTERNALLY MUTABLE: they rate an episode on the web, their
 * second device, the AniList site itself, and this app shows the old value
 * until `staleTime` (5 minutes) expires — even though the foreground handler
 * above ran, because a resume "refetches what is stale, and not one request
 * more", and the list entries were not stale yet. A per-app-session view of a
 * thing another device writes is the one cache table the sweep must not be
 * trusted with.
 *
 * So on every ring back to the foreground, `['home']` (keyed with a USER id —
 * the `'anon'` variant is public rails, not a list), `['viewer']` (present
 * only while signed in: sign-out drops it) and any MOUNTED `['listEntry', …]`
 * are re-fetched with `staleTime` bypassed, while everything unmounted is
 * left untouched — an entry nobody is looking at must not cost a burst of
 * per-media requests; the next mount refetches under its own normal rules.
 *
 * The pairing with `refetchStaleOnForeground` is safe specifically because the
 * sweep uses `.fetch()`: an in-flight refresh is JOINED rather than duplicated,
 * so a home query old enough to be caught by both costs one network call.
 */
export async function refreshUserListOnForeground(): Promise<void> {
  const cache = queryClient.getQueryCache();
  const isListSlice = (q: { queryKey: readonly unknown[] }): boolean => {
    const k = q.queryKey[0];
    if (k === 'home') return typeof q.queryKey[1] === 'number';
    if (k === 'viewer') return true;
    if (k === 'listEntry') return typeof q.queryKey[1] === 'number';
    return false;
  };
  await Promise.all(
    cache
      .getAll()
      .filter((q) => q.getObserversCount() > 0 && isListSlice(q))
      .map((q) => q.fetch().catch(() => undefined))
  );
}

/** Drop everything from memory. The settings screen's "clear cache" calls this. */
export function clearCache(): void {
  queryClient.clear();
}

/**
 * What goes to disk.
 *
 * Pending queries are excluded: half-finished requests have nothing worth
 * persisting, and restoring one puts the app into a state that looks like it is
 * loading something it is not. Errors are excluded too — a restored error reads
 * as "AniList is down" when it was true an hour ago, which is worse than
 * starting fresh.
 *
 * Errors are redacted as well as skipped, so a stack trace never lands in
 * AsyncStorage where it would outlive the release that produced it.
 */
export const dehydrateOptions = {
  shouldDehydrateQuery: (query: { state: { status: string } }) =>
    query.state.status === 'success',
  shouldRedactErrors: () => true,
};

/** Restored entries older than this are dropped instead of painted. */
export const hydrateOptions = { maxAge: RESTORE_MAX_AGE_MS };
