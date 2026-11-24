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
 * ═══════════════════════════════════════════════════════════════════════════
 * A RENDERED FRAME IS NOT PROOF (24 Nov — the freeze that closed the app)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The player used to reset this whole budget on every rendered frame, and that
 * single line is what made the walk endless on a weak connection:
 *
 *     hop → a frame lands → rounds = 0, since = 0 → stall 15s later → hop → …
 *
 * `wrapVerdict` can only ever say `'giveup'` once `rounds` reaches
 * `MAX_FAILOVER_ROUNDS`, so a reset per frame meant it never did. Each pass
 * re-resolved every extension AND re-opened the native media source.
 *
 * That last part is not just wasted bytes. `expo-video` runs `prepare()` on the
 * Android MAIN thread (`VideoModule.replaceImpl` → `appContext.mainQueue` →
 * `ref.prepare()`), and with `useCaching` on — which is the default — building
 * the media source takes `CacheVariantIndex`'s `@Synchronized` lock and reads a
 * file. The cache's own network interceptor takes THE SAME lock on every
 * response. So while a segment is stuck mid-download, a re-open blocks the UI
 * thread behind it: the picture stops, the spinner stops (it is a UI-thread
 * animation), the device sits there, and Android eventually ANRs and closes the
 * app. "The whole app stuck and then it closed by itself" is that lock.
 *
 * So one frame only ends the REMEDY stretch (`recovery.ts`'s `noteRecovered`);
 * it forgives none of this. What forgives a failing stretch is evidence that
 * the stream actually HELD, which is what `provesStable` answers: the playhead
 * really advanced, and the health monitor has not declared a stall for a while.
 * A source that renders a frame and dies ten seconds later — exactly the source
 * the walk exists to leave — earns nothing.
 */

/** How much real playback a heartbeat interval must see to count as progress. */
export const STABLE_PLAY_SEC = 6;

/**
 * How long the stream must go WITHOUT a stall before a heartbeat may forgive.
 *
 * This is the number that bounds the loop. A failing stretch stalls every
 * `STALL_MS` (15s) plus one remedy, so it never accumulates a quiet minute: the
 * walk keeps its rounds and ends at `MAX_FAILOVER_ROUNDS`, as designed. A
 * healthy episode is silent for this long between any two hiccups, so it keeps
 * earning forgiveness for as long as it keeps playing.
 */
export const QUIET_RESET_MS = 60_000;

/**
 * Has the stream PROVEN itself, so the failing-stretch budgets may start over?
 *
 * Two facts, both required, and neither is something a single frame can fake:
 * real playhead movement, and a stretch with no stall verdict in it. `sinceStallMs`
 * may be `Infinity`/very large before any stall has been seen — that is the
 * honest answer for "nothing has gone wrong yet".
 */
export function provesStable(playedSec: number, sinceStallMs: number): boolean {
  return playedSec >= STABLE_PLAY_SEC && sinceStallMs >= QUIET_RESET_MS;
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
