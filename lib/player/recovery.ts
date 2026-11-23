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
//   2. LESS BITRATE — step DOWN one rung on the current source's own ladder.
//                  Same server, same position, one third of the bandwidth.
//                  Falls back to the ABR ceiling (`maxResolution`) when the
//                  ladder could not be read at all.
//   3. RELOAD    — one soft re-open of the same URL at the same position. This
//                  recovers a wedged pipeline (a decoder that stopped pulling)
//                  without changing server.
//   4. FAILOVER  — another source. Last, because it is the most expensive
//                  remedy and the only one that loses the buffer.
//
// NO IMPORTS, deliberately — same rule as `health.ts`, `speed.ts` and
// `tapArbiter.ts`: pure logic lives where a Node script can load it.

export type RecoveryAction =
  /** Do nothing but keep the ring up. */
  | { kind: 'wait'; because: 'cooldown' | 'downloading' }
  /** Lock the ladder's next-lower variant on the SAME source. */
  | { kind: 'lower-quality'; to: number }
  /** No ladder: cap the adaptive ceiling so the player picks a smaller track. */
  | { kind: 'cap'; height: number }
  /** Re-open the same source, same position. */
  | { kind: 'reload' }
  /** Step to the next source in the walk. */
  | { kind: 'failover' };

export interface RecoveryState {
  /** Remedies carried out since the last rendered frame. Diagnostic + message. */
  actions: number;
  /** Bitrate steps taken. Kept across recoveries — see `noteRecovered`. */
  qualityDrops: number;
  /** ABR ceilings applied. */
  caps: number;
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

/** At most two bitrate steps per episode: 1080 → 720 → 480 is already drastic. */
export const MAX_QUALITY_DROPS = 2;

/** ABR ceilings, in the order they are applied when no ladder is readable. */
export const CAP_HEIGHTS: readonly number[] = [720, 480];

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
  return { actions: 0, qualityDrops: 0, caps: 0, reloads: 0, lastActionAt: 0 };
}

/**
 * The stream produced a frame: the failing stretch is over.
 *
 * `actions` and `reloads` restart because the next stall is a NEW event with a
 * fresh set of remedies. `qualityDrops` and `caps` deliberately do NOT: the
 * reduction is why the frame landed, and re-offering the rung that starved
 * would make the player oscillate up and down every fifteen seconds on exactly
 * the connection least able to absorb a `replaceAsync`. A new EPISODE starts
 * over (`initialRecovery`), and the viewer can always pick Auto by hand.
 */
export function noteRecovered(state: RecoveryState): RecoveryState {
  return { ...state, actions: 0, reloads: 0, lastActionAt: 0 };
}

export interface StallEvidence {
  /** Seconds of media ready ahead, `null` when the pipeline cannot say. */
  ahead: number | null;
  /** How long the playhead has been frozen. */
  frozenMs: number;
  /** `bufferedPosition` advanced since the previous sample. */
  growing: boolean;
  /** The current source exposes a variant ladder (HLS master parsed). */
  hasLadder: boolean;
  /** Index of the next rung DOWN on that ladder, or null when already lowest. */
  nextRung: number | null;
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

  // ── Rule 2: ask for less. ────────────────────────────────────────────────
  //
  // First because it is the cheapest remedy that actually changes the equation:
  // the same server, the same position, a third of the bytes per second. The
  // step is applied as an explicit variant lock (the HLS variant URL), which
  // media3 honours exactly, rather than as a hint.
  if (ev.hasLadder && ev.nextRung != null && state.qualityDrops < MAX_QUALITY_DROPS) {
    return {
      action: { kind: 'lower-quality', to: ev.nextRung },
      state: spend(state, now, { qualityDrops: state.qualityDrops + 1 }),
    };
  }

  // ── Rule 3: no ladder to step down into. Cap the adaptive selection. ─────
  //
  // `maxResolution` is the one knob that changes an ABR stream we cannot see the
  // ladder of (the master read failed on this very connection, which is itself
  // evidence). On Android it is a hard constraint; the player re-selects its own
  // track below it WITHOUT a replace, so this costs no buffer at all.
  if (!ev.hasLadder && state.caps < CAP_HEIGHTS.length) {
    return {
      action: { kind: 'cap', height: CAP_HEIGHTS[state.caps] },
      state: spend(state, now, { caps: state.caps + 1 }),
    };
  }

  // ── Rule 4: soft repair. ─────────────────────────────────────────────────
  //
  // Same URL, same position, one re-open. This is the remedy for a pipeline
  // that has stopped pulling — a decoder wedge, an extractor that gave up —
  // which no amount of waiting or bitrate reduction can fix. Once only: a
  // second reload of a URL that just failed is a repeat, not a repair.
  if (state.reloads < 1) {
    return { action: { kind: 'reload' }, state: spend(state, now, { reloads: state.reloads + 1 }) };
  }

  // ── Rule 5: another server. ──────────────────────────────────────────────
  //
  // Last, and bounded by the failover budget rather than by this module: the
  // walk's wrap is where an episode is declared unplayable (`failover.ts`).
  return { action: { kind: 'failover' }, state: spend(state, now, {}) };
}
