// What the player DOES about a stream that has stopped making progress.
//
// ═══════════════════════════════════════════════════════════════════════════
// WHY THIS IS A SEPARATE MODULE FROM `health.ts`
//
// `health.ts` answers "what is happening": it folds samples into a verdict
// (`ok`, `starving`, `rebuffering`, `stalled`, `unknown`, `inactive`) and it is
// deliberately forbidden from acting on any of them. This module is the other
// half — the ladder of remedies, in the order a real player tries them — and it
// is pure so the check battery can drive the shipping decisions without a
// device. `scripts/check-stream-recovery.ts` imports this file directly.
//
// ═══════════════════════════════════════════════════════════════════════════
// THE REPORT THIS EXISTS FOR (23 Nov, slow connection)
//
// "The episode pauses, the source counter moved from 4/7 to 5/7 with no spinner,
// then the app got stuck and closed." Every symptom is this ladder's absence:
//
//   1. A frozen playhead went straight to `failover()`. Hopping servers throws
//      away every byte already buffered — the one thing a starved stream cannot
//      afford — so the next source started from zero on the same thin pipe and
//      stalled again 15s later. The walk could never succeed.
//   2. Nothing ever asked for LESS. A 1080p HLS stream on a connection that can
//      carry 480p stalls forever, and no amount of server-hopping fixes it.
//      Netflix/YouTube/ExoPlayer answer a starved buffer by dropping bitrate;
//      this player had no such step at all (the old auto-downgrade passed a
//      label into a `src:variant` API, changed nothing, and was removed).
//   3. The ring was missing because a *thin* buffer never reported
//      `rebuffering` (`health.ts` returns `starving` first) — fixed there.
//   4. Each hop also re-resolved, and `load()` reset the failover budget, so the
//      walk never gave up: an endless resolve→hop→stall loop on the JS thread.
//      Fixed in `failover.ts` (`budgetOnLoad`), which this ladder relies on to
//      terminate.
//
// ═══════════════════════════════════════════════════════════════════════════
// THE ORDER IS THE DESIGN
//
//   1. WAIT      — bytes are still arriving. A buffer that is filling slowly is
//                  a buffer that is filling; acting here throws away progress.
//                  This is the single most important rule for "slow internet".
//   2. RELOAD    — one soft re-open of the same URL, same position, SAME
//                  QUALITY. This recovers a wedged pipeline (a decoder that
//                  stopped pulling) without changing server or bitrate.
//   3. FAILOVER  — another source at the SAME quality. Last, because it is the
//                  most expensive remedy and the only one that loses the buffer.
//
// ═══════════════════════════════════════════════════════════════════════════
// ⚠️ THE VIEWER'S QUALITY IS NOT OURS TO CHANGE (24 Nov report)
//
// This ladder used to answer a starved buffer by stepping DOWN the variant
// ladder (`lower-quality`) and, when no ladder was readable, by lowering the
// ABR ceiling (`cap`). The device report says exactly why that is wrong:
//
//   "it started loading spinner, then it reloaded and I found it reloaded and
//    started 360p, I had 720p before … we don't want to decrease the quality
//    automatically … I had selected 720p so stay 720p, it should show spinner
//    and load ahead after it gets the internet again"
//
// Every one of those steps was a RE-OPEN on a connection that had nothing to
// spare, and each one also silently rewrote a choice the viewer had made by
// hand. Waiting plus one in-place repair is what a real player does: a hiccup is
// a hiccup, and the stream that was asked for is the stream that resumes.
//
// The remedies that remain therefore change NOTHING about the request: same
// URL, same rung, same source-then-next-source. The single lever for a
// connection that genuinely cannot carry the chosen rung is the viewer's own —
// the picker — and `RECOVERY_EXHAUSTED_MESSAGE` is what points at it.
//
// NO IMPORTS, deliberately — same rule as `health.ts`, `speed.ts` and
// `tapArbiter.ts`: pure logic lives where a Node script can load it.

export type RecoveryAction =
  /** Do nothing but keep the ring up. */
  | { kind: 'wait'; because: 'cooldown' | 'downloading' }
  /** Re-open the same source, same position, same quality. */
  | { kind: 'reload' }
  /** Step to the next source in the walk, at the same quality. */
  | { kind: 'failover' };

export interface RecoveryState {
  /** Remedies carried out since the last rendered frame. Diagnostic + message. */
  actions: number;
  /** In-place reloads tried since the last frame. */
  reloads: number;
  /** When the last remedy ran, ms. 0 = none yet. */
  lastActionAt: number;
}

/**
 * The gap between two remedies.
 *
 * Without it the 1s health tick turns one stall into one `replaceAsync` per
 * second: every tick sees the same frozen playhead, every tick answers it, and
 * the decoder never gets a window to do anything. Eight seconds is a little
 * more than the `REBUFFER_HINT_MS` debounce plus a segment fetch on a slow link
 * — long enough that each remedy is judged on its own result.
 */
export const RECOVERY_COOLDOWN_MS = 8_000;

/**
 * How long a *downloading* stream may stay frozen before we intervene anyway.
 *
 * Bytes arriving is real progress: the buffer is filling, just slower than the
 * playhead wants. On a genuinely thin connection this window is the difference
 * between "it paused for twenty seconds and carried on" and "it hopped servers
 * and started over". 45s is long enough for a multi-megabyte segment on 3G and
 * still short enough that a stream whose buffer will never fill is answered
 * inside a minute.
 */
export const DOWNLOADING_PATIENCE_MS = 45_000;

/**
 * What the error card says when the walk ends after the ladder was used.
 *
 * "No source could play this episode" is the wrong sentence for a connection
 * that played the episode fine until it ran out of headroom — the sources were
 * not the problem and the viewer has one obvious lever (quality) the generic
 * sentence never mentions.
 */
export const RECOVERY_EXHAUSTED_MESSAGE =
  'This episode kept running out of buffer. Try a lower quality, another source, or a stronger connection.';

/** A fresh ladder for a new episode. */
export function initialRecovery(): RecoveryState {
  return { actions: 0, reloads: 0, lastActionAt: 0 };
}

/**
 * The stream produced a frame. That ends the remedy stretch — and NOTHING else.
 *
 * ⚠️ `reloads` IS DELIBERATELY NOT RESET HERE (24 Nov). It used to be, and that
 * made a soft reload unbounded: reload → a frame → stall → reload → a frame → …
 * Every one of those re-opens the native media source, which `expo-video`
 * prepares on the Android MAIN thread (`replaceImpl` → `appContext.mainQueue`).
 * With the disk cache on, that path takes the cache index's `@Synchronized`
 * lock, which a stuck segment download is holding — so the reload loop is what
 * froze the UI thread and got the app killed, on a connection where the UI could
 * least afford it.
 *
 * One soft reload per failing stretch is what the rule always said it was ("a
 * second reload of a URL that just failed is a repeat, not a repair"); it is now
 * also what the code does. `noteStable` is where the budget comes back.
 *
 * `actions` and the cooldown still restart, because the next stall is a NEW
 * event whose cheap remedies deserve to be weighed again.
 */
export function noteRecovered(state: RecoveryState): RecoveryState {
  return { ...state, actions: 0, lastActionAt: 0 };
}

/**
 * The stream PROVED itself — a quiet minute with a playhead that really moved
 * (`provesStable` in `lib/player/failover.ts` decides when).
 *
 * This is the only thing that hands the reload budget back, and it is what keeps
 * a long, healthy episode working: one hiccup mid-episode earns its soft reload,
 * and ten quiet minutes later a second hiccup earns another. A broken source
 * never gets here, so the loop above cannot restart.
 *
 * A new EPISODE still starts completely over (`initialRecovery`).
 */
export function noteStable(state: RecoveryState): RecoveryState {
  return { ...state, actions: 0, reloads: 0, lastActionAt: 0 };
}

export interface StallEvidence {
  /** Seconds of media ready ahead, `null` when the pipeline cannot say. */
  ahead: number | null;
  /** How long the playhead has been frozen. */
  frozenMs: number;
  /** `bufferedPosition` advanced since the previous sample. */
  growing: boolean;
}

export interface RecoveryDecision {
  action: RecoveryAction;
  state: RecoveryState;
}

function spend(state: RecoveryState, now: number, patch: Partial<RecoveryState>): RecoveryState {
  return { ...state, ...patch, actions: state.actions + 1, lastActionAt: now };
}

/**
 * Fold one stall into the ladder and decide what to do next.
 *
 * The order of the returns is the design — each one is a case where every rule
 * below must not run.
 */
export function decideRecovery(
  state: RecoveryState,
  ev: StallEvidence,
  now: number
): RecoveryDecision {
  // ── Rule 0: one remedy at a time. ────────────────────────────────────────
  //
  // Checked before anything else, including the downloading rule, because the
  // ticking monitor will call this every second for as long as the stall lasts.
  if (state.lastActionAt !== 0 && now - state.lastActionAt < RECOVERY_COOLDOWN_MS) {
    return { action: { kind: 'wait', because: 'cooldown' }, state };
  }

  // ── Rule 1: still downloading. Wait. ─────────────────────────────────────
  //
  // THE RULE THAT MAKES SLOW INTERNET SURVIVABLE. A frozen picture whose buffer
  // is still growing is not a broken source and not a broken pipeline: it is a
  // pipe that is too narrow for the segment being fetched, and every remedy
  // below either discards the bytes already received (reload, failover) or
  // re-opens the same item (bitrate step). Waiting is the only answer that
  // keeps the progress.
  if (ev.growing && ev.frozenMs < DOWNLOADING_PATIENCE_MS) {
    return { action: { kind: 'wait', because: 'downloading' }, state };
  }

  // ── Rule 2: soft repair. ────────────────────────────────────────────────
  //
  // Same URL, same position, SAME QUALITY — one re-open. This is the remedy for
  // a pipeline that has stopped pulling (a decoder wedge, an extractor that gave
  // up), which no amount of waiting fixes. Once only: a second reload of a URL
  // that just failed is a repeat, not a repair.
  //
  // ⚠️ IT MUST NOT CHANGE THE RUNG. A repair that comes back at a lower quality
  // is not a repair, it is a decision the viewer did not make.
  if (state.reloads < 1) {
    return { action: { kind: 'reload' }, state: spend(state, now, { reloads: state.reloads + 1 }) };
  }

  // ── Rule 3: another server, same quality. ────────────────────────────────
  //
  // Last, and bounded by the failover budget rather than by this module: the
  // walk's wrap is where an episode is declared unplayable (`failover.ts`).
  return { action: { kind: 'failover' }, state: spend(state, now, {}) };
}
