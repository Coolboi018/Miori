/**
 * Parsed subtitle tracks, kept by URL — the same return trip as the stream.
 *
 * THE REPORT (21 Nov): the player's source-load effect hands over a fresh
 * `tracks` array on EVERY reload — a quality switch, a failover hop, a
 * reconnect, backing out to details and coming back — and the cue fetch is
 * keyed on that array. So each of those re-downloaded and re-parsed the same
 * `.vtt`, leaving the screen wordless for the length of a round trip on the
 * connection that had just failed. That is the "subtitles take time to sync
 * back" half of the report.
 *
 * WHY A CUE CAN BE CACHED WITHOUT THE EXPIRY THE STREAM NEEDS. A source row is
 * a signed URL that DIES; a subtitle URL is a static file. If a re-mint changes
 * the URL, the key changes, the old entry is simply never asked for again, and
 * nothing wrong can be served. So there is no TTL here — only a bound, because
 * a binge can touch a lot of tracks.
 *
 * WHY IN MEMORY. A season of cues is a few hundred objects; the win is inside
 * one session, and AsyncStorage would make a stale parse survive app updates
 * and extension reloads for no benefit. Being import-free also lets
 * `scripts/check-replay.ts` drive this exact logic under plain `tsx`.
 *
 * IN-FLIGHT DE-DUPE IS PART OF THE CONTRACT, not an optimisation. Two effects
 * can ask for the same URL within a second (a source switch that lands on the
 * same extension, a track pick during a reload). Without it both requests go
 * out, both parse, and the second one can land after the first with the same
 * answer — a duplicate download bought with the viewer's own bad connection.
 */

import type { Cue } from './vtt';

/** Tracks kept at once. Enough for a season's languages, not a season's files. */
export const CUE_CACHE_MAX = 8;

const parsed = new Map<string, Cue[]>();
const inFlight = new Map<string, Promise<Cue[]>>();

/** A parsed track for this URL, or null. Touches LRU order on a hit. */
export function readCueCache(url: string): Cue[] | null {
  const key = (url ?? '').trim();
  if (!key) return null;
  const hit = parsed.get(key);
  if (!hit) return null;
  parsed.delete(key);
  parsed.set(key, hit);
  return hit;
}

/**
 * Remember a parsed track.
 *
 * An EMPTY list is deliberately allowed here but never produced by `cueLoad`:
 * the cache is a store, and the rule about what is worth storing lives at the
 * one place that decides it (see `cueLoad`).
 */
export function writeCueCache(url: string, cues: Cue[]): void {
  const key = (url ?? '').trim();
  if (!key) return;
  parsed.delete(key);
  parsed.set(key, cues);
  while (parsed.size > CUE_CACHE_MAX) {
    const oldest = parsed.keys().next().value;
    if (oldest === undefined) break;
    parsed.delete(oldest);
  }
}

/**
 * The parsed track for `url`, downloading it at most once.
 *
 * A hit is answered immediately; a second caller for a URL already in flight
 * is handed the SAME promise instead of starting a second download. A loader
 * that throws or rejects is not remembered — a 404 or a truncated file must be
 * retried, never pinned.
 */
export function cueLoad(url: string, load: () => Promise<Cue[]>): Promise<Cue[]> {
  const key = (url ?? '').trim();
  if (!key) return Promise.resolve([]);

  const hit = readCueCache(key);
  if (hit) return Promise.resolve(hit);

  const pending = inFlight.get(key);
  if (pending) return pending;

  const run = Promise.resolve()
    .then(load)
    .then(
      (cues) => {
        inFlight.delete(key);
        // AN EMPTY PARSE IS NOT A TRACK. It is far more likely to be a
        // truncated download or an HTML error page than a genuinely silent
        // track, and caching it would make one bad fetch permanent for that
        // episode. Cue-less is retried; the failure path already renders
        // nothing, so a retry costs the viewer nothing they can see.
        if (cues.length) writeCueCache(key, cues);
        return cues;
      },
      (e) => {
        inFlight.delete(key);
        throw e;
      }
    );

  inFlight.set(key, run);
  return run;
}

/** Forget one URL (a track the viewer just proved unreadable). */
export function dropCueCache(url: string): void {
  parsed.delete((url ?? '').trim());
}

/** Forget everything. For the check script and for a hard reset. */
export function clearCueCache(): void {
  parsed.clear();
  inFlight.clear();
}

/** How many tracks are held. Diagnostics + the check script. */
export function cueCacheSize(): number {
  return parsed.size;
}
