// A one-shot request from one screen to seed another screen's filters.
//
// WHY THIS EXISTS AT ALL. Explore's browse grid keeps its `ExploreFilters` in local
// `useState`, and its `seedFilters` is a closure over that state. That is the right
// design for explore's own section links — they live on the same screen and can
// just call it — but it means nothing else in the app can reach it. Home's rails
// want the identical behaviour ("show me this rail, but all of it"), and there was
// no way to ask.
//
// THE ALTERNATIVES, and why none of them is better here:
//
//   Route params       `router.push('/(tabs)/explore', { params })` works, but a
//                      param on a tab screen is STICKY — it survives tab switches,
//                      so explore would re-apply the seed every time the user came
//                      back to it, yanking the grid out from under whatever they
//                      had since changed. Clearing it after applying is exactly the
//                      bookkeeping this module does for free.
//
//   A shared store     `lib/settings/store.ts` shows the app already does
//   (useSyncExternalStore) for settings. Reachable, but it would mean explore
//                      SUBSCRIBES to a value it only ever reads once, on focus.
//                      A subscription with one reader and one write is a queue with
//                      extra steps.
//
// SO: a plain module-level slot with a write and a take. Read-and-clear is the
// whole mechanism, and it is why a stale seed cannot exist — there is no way to
// read one twice.
//
// NOT A STORE, NOT A CACHE. Nothing here persists, nothing here re-renders
// anything, and nothing here survives a launch. It is a message with exactly one
// reader and one guaranteed delivery.

import type { ExploreFilters } from '@/lib/anilist/explore';

let pending: Partial<ExploreFilters> | null = null;

/**
 * Ask explore's grid to load this filter signature next time it is focused.
 *
 * Overwrites rather than merges. A second request before the first is read means
 * the user tapped a second rail's See all, and that second one is the one they
 * are waiting for — merging would leave the first rail's status filter in place
 * and quietly produce a list belonging to neither.
 */
export function requestBrowse(patch: Partial<ExploreFilters>): void {
  pending = patch;
}

/**
 * Read the pending seed and clear it in the same step.
 *
 * Returns `null` when there is nothing waiting, which is the common case: explore
 * regains focus for a hundred ordinary tab switches, and each of those must not
 * re-seed the grid. The clear is what makes that true, and it happens on READ
 * rather than after applying — so a seed that explore fails to act on is dropped
 * anyway rather than being retried forever.
 */
export function takeBrowse(): Partial<ExploreFilters> | null {
  const out = pending;
  pending = null;
  return out;
}