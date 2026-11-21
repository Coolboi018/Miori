/**
 * The resolved episode, kept for a few minutes — the return trip.
 *
 * THE REPORT (21 Nov): open an episode, go back to the details page, tap the
 * SAME episode again, and the player paid for the whole resolve a second time —
 * every extension's catalogue lookup, mapping probe, token mint and playlist
 * fetch — for a list that had worked seconds earlier. A navigation is not a
 * fresh attempt, and real players do not treat it as one.
 *
 * WHAT IS CACHED, AND WHY IT IS SAFE. The rows `resolveEpisode` returns are
 * signed URLs, not eternal ones (the Katana/Bingr token class lives about half
 * an hour), so a cache with no expiry would eventually hand the player a dead
 * URL and *look* like a broken app. Two rules bound it:
 *
 *   1. `CACHE_TTL_MS` (15 min) sits comfortably inside the shortest signed-URL
 *      life this app knows about, so a hit is almost always a live URL.
 *   2. A cache is a HINT, never a verdict. Every source keeps its `refresh()`
 *      hook — the failover walk re-mints before it hops — and a walk that runs
 *      out of sources ends in `load({ fresh: true })`, which ignores this cache
 *      and re-resolves from scratch. `dropResolveCache` is called at the same
 *      moment, so the next visit does not resurrect the dead list either.
 *
 * WHY IN MEMORY, NOT ON DISK. AsyncStorage would survive an app restart — and
 * also every extension reload and app update — and a persisted signed URL is
 * exactly the kind of stale state that turns a working app into "the streams
 * are broken today". The win here is the back-and-forth inside one session, and
 * memory is where that belongs. Being import-free also means
 * `scripts/check-replay.ts` drives this exact logic under plain `tsx`.
 *
 * THE UNIT IS THE EPISODE. Episode 3's list answers episode 3; a different
 * episode is a different resolve. The store is a small LRU (a viewer bounces
 * between a handful of episodes, not a season) so it cannot grow with watch
 * history.
 */

import type { WatchSource } from '@/lib/extensions/types';
import type { FailedSource } from '@/lib/extensions/registry';

export interface CachedResolve {
  sources: WatchSource[];
  failed: FailedSource[];
  /** When the resolve landed, ms. TTL is measured from here. */
  at: number;
}

/** A hit must be younger than this. 15 min is inside every signed-URL life we know. */
export const CACHE_TTL_MS = 15 * 60_000;

/** Episodes kept at once. More than a bounce-back is not what this is for. */
export const CACHE_MAX_ENTRIES = 8;

const entries = new Map<string, CachedResolve>();

const keyOf = (animeId: number, ep: number) => `${animeId}:${ep}`;

/**
 * The cached list for this episode, or null.
 *
 * `now` is injected so the check script can age an entry without waiting; the
 * player never passes it. A hit is re-inserted to the newest end of the Map so
 * the eviction order really is least-recently-USED rather than
 * least-recently-written.
 */
export function readResolveCache(
  animeId: number,
  ep: number,
  now: number = Date.now()
): CachedResolve | null {
  if (!Number.isFinite(animeId) || !Number.isFinite(ep)) return null;
  const key = keyOf(animeId, ep);
  const hit = entries.get(key);
  if (!hit) return null;
  if (now - hit.at > CACHE_TTL_MS) {
    entries.delete(key);
    return null;
  }
  entries.delete(key);
  entries.set(key, hit);
  return hit;
}

/**
 * Remember a resolve, replacing whatever this episode had.
 *
 * Called from the ONE place every fresh resolve flows through
 * (`applyResolve`), so the cache can never describe a list the player is not
 * actually on.
 */
export function writeResolveCache(
  animeId: number,
  ep: number,
  sources: WatchSource[],
  failed: FailedSource[] = [],
  now: number = Date.now()
): void {
  if (!Number.isFinite(animeId) || !Number.isFinite(ep)) return;
  if (!sources.length) return;
  const key = keyOf(animeId, ep);
  entries.delete(key);
  entries.set(key, { sources, failed, at: now });
  while (entries.size > CACHE_MAX_ENTRIES) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined) break;
    entries.delete(oldest);
  }
}

/** Forget one episode — the list it held is known bad. */
export function dropResolveCache(animeId: number, ep: number): void {
  entries.delete(keyOf(animeId, ep));
}

/** Forget everything. Exposed for sign-out and for the check script. */
export function clearResolveCache(): void {
  entries.clear();
}

/** How many episodes are currently held. Diagnostics + the check script. */
export function resolveCacheSize(): number {
  return entries.size;
}
