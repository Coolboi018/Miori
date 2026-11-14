/**
 * The resolve's two windows, as one importable decision.
 *
 * Extracted from `PlayerScreen.tsx` because a rule this central cannot live
 * only inside a React component — the check battery has to drive the REAL
 * logic, and a component cannot be imported into a Node script.
 *
 * THE TWO WINDOWS, and why one deadline was not enough.
 *
 * The extensions each carry their own per-request timeouts, so a resolve is
 * bounded by its slowest extension's chain — four extensions each running
 * fetch+probe sequences can legitimately take tens of seconds on a cold
 * connection while still being healthy work in progress.
 *
 * The FIRST window (`RESOLVE_TIMEOUT`) exists for the failure case: an
 * extension that threw, nothing mapped, nothing to play. That verdict must
 * surface promptly, because it is terminal — no amount of waiting fixes a 404.
 *
 * The SECOND window (`RESOLVE_GRACE_MS`) exists because a resolve that merely
 * MISSED the first window has not failed. The old shape rejected at the first
 * deadline and dropped the late answer on the floor: the viewer got "No source
 * answered in time" about an answer that landed seconds later (the 13 Nov
 * slow-connection device report). Now the SAME promise is waited out behind
 * the grace cap — one continuous spinner with no intermediate words is the
 * settled design; the error card waits for the promise that is actually gone.
 */

/** First verdict window — how long a resolve may run before "is it dead?" is asked. */
export const RESOLVE_TIMEOUT = 25_000;

/** How much longer a resolve that missed the first window may keep running. */
export const RESOLVE_GRACE_MS = 30_000;

/**
 * Sentinel the first window rejects with when its deadline (not the work)
 * fires. The catch classifies on it: sentinel → keep waiting; anything else is
 * a REAL failure and surfaces immediately. An extension message cannot collide
 * with it — the string is authored here and never sent over a network.
 */
const SLOW_SENTINEL = 'resolve still running';

/** Deadline a promise, aborting the WAIT but never the work itself. */
export function withDeadline<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(message)), ms);
    work.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

export type ResolveVerdict<T> =
  | { kind: 'applied'; value: T }
  | { kind: 'failed'; error: Error };

/**
 * Run one resolve under both windows. Real failures return promptly; a
 * deadline miss keeps the same promise running behind the grace cap and only
 * reports failure once the promise itself is gone.
 *
 * `firstMs`/`graceMs` are parameters (defaulting to the constants) so the check
 * script can drive the real function in milliseconds instead of seconds.
 */
export async function resolveInTwoWindows<T>(
  work: Promise<T>,
  timeoutLabel: string,
  firstMs: number = RESOLVE_TIMEOUT,
  graceMs: number = RESOLVE_GRACE_MS
): Promise<ResolveVerdict<T>> {
  try {
    return { kind: 'applied', value: await withDeadline(work, firstMs, SLOW_SENTINEL) };
  } catch (e) {
    if ((e as Error)?.message !== SLOW_SENTINEL) {
      return { kind: 'failed', error: e instanceof Error ? e : new Error(String(e)) };
    }
    try {
      return { kind: 'applied', value: await withDeadline(work, graceMs, timeoutLabel) };
    } catch (e2) {
      return {
        kind: 'failed',
        error: e2 instanceof Error ? e2 : new Error(String(e2)),
      };
    }
  }
}
