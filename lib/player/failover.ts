/**
 * The failover budgets, as pure decisions.
 *
 * Extracted from `PlayerScreen.tsx`'s `failover()` for the same reason as
 * `resolveWindow.ts`: the rules that decide whether an episode is declared
 * dead must be script-drivable, and a component cannot be imported into a
 * Node script. The 13 Nov device report ("Playback failed" raised while the
 * video then started playing) was a budget arithmetic bug invisible in normal
 * use — exactly the class of rule the check battery exists for.
 *
 * THE BUDGETS.
 *
 * A round is ONE FULL WALK down the source list — the old code incremented on
 * every failover call, which with a ~7-source list (the anikoto family alone
 * ships four rows) gave up three hops into the first walk. A slow connection
 * where each source legitimately spends most of its 14s first-frame window
 * raised "Playback failed" over sources that were still being tried, while the
 * currently-loading source delivered its frame and played underneath the card.
 *
 * Rounds alone, however, are not fair to both failure shapes: a list that
 * fails FAST (403, expired token — hops are instant) wraps three times in
 * seconds, which is right; a list that fails SLOW (cold CDNs) would spend
 * minutes per walk before the third wrap. The wall clock caps the total
 * patience so a genuinely dead episode is reported in bounded time however it
 * fails, and a slow-but-alive one is rescued by a rendered frame resetting
 * both budgets long before either fires.
 */

/** One full walk down the source list. */
export const MAX_FAILOVER_ROUNDS = 3;

/** Total wall-clock patience for a failing stretch, regardless of walks. */
export const MAX_FAILOVER_WALL_MS = 90_000;

/**
 * The failover budget, as ONE value.
 *
 * It used to be two loose numbers in the screen (`roundsRef`, `failClockRef`),
 * reset by hand at six call sites — and that is exactly how it broke. `load()`
 * reset both at its top, and `wrapLoad()` is a `load()`, so the walk's own
 * re-resolve wiped the budget that was supposed to stop the walk: rounds back to
 * 0, wall clock back to 0, `wrapVerdict` unable to ever return `'giveup'`. A
 * stalled episode then resolved and re-walked the whole source list forever —
 * the device report "the app got stuck and closed itself" (23 Nov).
 *
 * One object with one reset rule means a caller cannot reset half of it.
 */
export interface FailBudget {
  /** Walks already spent. Incremented at a WRAP, never per hop. */
  rounds: number;
  /** When the failing stretch began, ms. 0 = not running. */
  sinceMs: number;
}

/** A budget that has spent nothing and is not running yet. */
export function freshBudget(): FailBudget {
  return { rounds: 0, sinceMs: 0 };
}

/**
 * What a `load()` does to the budget.
 *
 * `keep = true` is for the WRAP-LOAD — the load a `wrapLoad()` starts to mint
 * fresh URLs for a list that has just failed. That load belongs to the stretch
 * that is already failing, so it must inherit the budget. Every other load
 * (mount, Retry, Change source, a viewer's Refresh) is a fresh decision and
 * starts a fresh stretch.
 *
 * This is the whole fix for the endless loop: the walk can now actually reach
 * `MAX_FAILOVER_ROUNDS` and say so.
 */
export function budgetOnLoad(prev: FailBudget, keep: boolean): FailBudget {
  return keep ? prev : freshBudget();
}

/** Start the wall clock on the first failure of a stretch, and never restart it there. */
export function noteFailure(prev: FailBudget, now: number): FailBudget {
  return prev.sinceMs === 0 ? { ...prev, sinceMs: now } : prev;
}

/** One full walk has been spent. */
export function spendRound(prev: FailBudget): FailBudget {
  return { ...prev, rounds: prev.rounds + 1 };
}

export type WrapAction = 'reload' | 'giveup';

/**
 * Should the walk's wrap (the list is exhausted and a fresh resolve is
 * wanted) reload, or is the episode dead?
 *
 * `rounds` is the count of wraps ALREADY spent (not incremented here);
 * `failStartMs` is when the failing stretch began, 0 meaning "not running";
 * `now` is injected so the caller owns the clock and the check script can
 * compress minutes into milliseconds.
 */
export function wrapVerdict(
  rounds: number,
  failStartMs: number,
  now: number,
  maxRounds: number = MAX_FAILOVER_ROUNDS,
  maxWallMs: number = MAX_FAILOVER_WALL_MS
): WrapAction {
  if (rounds >= maxRounds) return 'giveup';
  if (failStartMs !== 0 && now - failStartMs > maxWallMs) return 'giveup';
  return 'reload';
}

/**
 * The first-frame reconcile: what a rendered frame does to a standing error.
 *
 * A rendered frame is the one fact every failure verdict was waiting for, and
 * it outranks all of them. Every error path acts on the evidence of its own
 * moment — the walk budget, the frame watchdog, the resolve deadline — and a
 * verdict that fired while the pipeline was still working leaves the card up
 * over a playing video. The frame heals ALL of those races in one place:
 * if the verdict was right, no frame ever arrives and the card stays; if it
 * was premature, the frame arrives and the card was a lie.
 *
 * `resume` is true only when the error path had PAUSED the player (its own
 * effect does) and the viewer's own wheel wants playback — the pipeline never
 * resumes what the viewer paused.
 */
export function healOnFrame(
  error: string | null,
  desiredPlaying: boolean,
  playing: boolean
): { clearError: boolean; resume: boolean } {
  const clearError = error != null;
  return { clearError, resume: clearError && desiredPlaying && !playing };
}
