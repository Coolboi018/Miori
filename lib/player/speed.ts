// Playback speed — the model, in one place, with no room for two truths.
//
// ═══════════════════════════════════════════════════════════════════════════
// WHY THIS FILE EXISTS AT ALL
//
// The ShonenX player has a bug worth not reproducing, and this module exists to
// make it structurally impossible. In `ShonenX/lib/features/player/`:
//
//   - `gesture_overlay.dart:276` restores speed on release with
//         widget.onSetSpeed(widget.baseSpeed)
//     but `baseSpeed` is declared at line 16, DEFAULTED TO 1.0 at line 27, and
//     NEVER PASSED — the only construction site (`player_screen.dart:514-522`)
//     omits it. So the restore target is hardcoded 1x.
//   - `player_screen.dart:519` wires `onSetSpeed: engine.setSpeed` — the RAW
//     engine — while the speed menu goes through
//     `controller.changeSpeed()` (`player_controller.dart:889-892`), which is
//     the ONLY writer of `PlayerState.playbackSpeed`. The UI then reads that
//     state at `top_controls.dart:269`.
//
// So: set 1.25x → long-press to boost → release. The engine gets 1.0, the
// state never changed, and the label still reads "1.25x".
//
// The cause is not an overwrite. It is a STALE MIRROR: two holders of one
// fact, only one of which is on the write path of a gesture.
//
// ═══════════════════════════════════════════════════════════════════════════
// THE FIX
//
// One fact, two fields, and a rule that makes desync unrepresentable:
//
//     committed  — what the user picked. Persisted.
//     boost      — non-null ONLY while a press is held.
//     effective  — boost ?? committed          ← the only value the engine and
//                                               every label ever see.
//
// Releasing sets `boost = null`. It does NOT set a number. The engine falls back
// to `committed` on its own, so "return to 1x when the user had chosen 1.25x"
// is not a thing this model can express. The failure needs a SECOND value to
// overwrite, and there isn't one.
//
// Note what is deliberately NOT here: no `restoreTo`. The old bug lived in the
// gap between "what we will restore" and "what the user actually chose", and
// that gap is where a hardcoded 1.0 goes to hide. There is nothing to restore
// TO — there is only what is currently true.
//
// Persistence covers `committed` only. A user who long-presses and releases must
// not have written a 2x into their preferences.

/** The speeds the overlay menu offers, in menu order. */
export const SPEED_STEPS = [
  0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3,
] as const;

/**
 * What a long-press boosts TO. Not "2x" as a magic number but as a named
 * constant, because it is also the floor the scrub ramps up from.
 */
export const BOOST_START = 2;

/** Longest hold can reach, and the ceiling for any rate. expo-video accepts 0–16; 3x is where audio starts to sound wrong. */
export const MAX_SPEED = 3;

/** Shortest. Below this the video is a slideshow and nobody picks it. */
export const MIN_SPEED = 0.5;

/** Held-scrub sensitivity: pixels of vertical travel per 1.0x of speed. */
const RAMP_PX_PER_X = 120;

/**
 * Held-scrub quantum. Quarter-steps so the number under the thumb matches the
 * steps in the menu — releasing from a scrub to "1.25x" should feel like
 * picking 1.25x, not like landing between two options.
 */
const QUANTUM = 0.25;

/** Pick the nearest menu step to an arbitrary rate (used to seed the menu). */
export function nearestStep(rate: number): number {
  // Annotated `number` rather than left to inference: without it TS narrows to
  // the literal type of `SPEED_STEPS[0]` (which is `0.5`) and then rejects
  // every later assignment in the loop.
  let best: number = SPEED_STEPS[0];
  let bestDelta = Infinity;
  for (const s of SPEED_STEPS) {
    const d = Math.abs(s - rate);
    if (d < bestDelta) {
      bestDelta = d;
      best = s;
    }
  }
  return best;
}

export interface SpeedState {
  /** What the user chose. Persisted. Survives a press-and-release untouched. */
  committed: number;
  /** Non-null only while a long-press is held. Never persisted. */
  boost: number | null;
}

export function initialSpeed(committed = 1): SpeedState {
  return { committed, boost: null };
}

/**
 * THE rate the engine and every visible label must read.
 *
 * There is one call site for this and that is the point — `grep effectiveRate`
 * should find the engine write and the two labels, and nothing else may read
 * `committed` directly.
 */
export function effectiveRate(s: SpeedState): number {
  return s.boost ?? s.committed;
}

/** True while a press is overriding the committed rate. */
export function isBoosting(s: SpeedState): boolean {
  return s.boost !== null;
}

/** The user picked a speed from the menu. Cancels any live boost. */
export function commitSpeed(s: SpeedState, rate: number): SpeedState {
  const clamped = clampSpeed(rate);
  // If a press is held and the menu is tapped, the press wins — otherwise the
  // release would drag the engine back to the value the menu just replaced.
  return s.boost !== null
    ? { committed: clamped, boost: s.boost }
    : { committed: clamped, boost: null };
}

/** Press went down. */
export function beginBoost(s: SpeedState): SpeedState {
  return { ...s, boost: BOOST_START };
}

/** Press is being dragged. `dy` is total upward travel since the press began. */
export function rampBoost(s: SpeedState, dyPx: number): SpeedState {
  if (s.boost === null) return s;
  const raw = BOOST_START + dyPx / RAMP_PX_PER_X;
  const snapped = Math.round(raw / QUANTUM) * QUANTUM;
  const next = clampSpeed(snapped);
  // Float noise makes `clampSpeed` return 1.0000000000000002 often enough to
  // re-trigger a native write on every move event. Compare at 2dp.
  if (Math.abs(next - s.boost) < 0.005) return s;
  return { ...s, boost: next };
}

/**
 * Press released — and this is the line ShonenX gets wrong.
 *
 * It returns to `committed` by BECOMING NULL, not by being assigned a number.
 * There is no restore target to get wrong, and nothing here can reintroduce
 * the "engine at 1x, UI at 1.25x" split, because `committed` was never touched
 * while the press was held.
 */
export function endBoost(s: SpeedState): SpeedState {
  return s.boost === null ? s : { ...s, boost: null };
}

/** Step the committed rate by whole quanta (the volume-style shortcut path). */
export function stepSpeed(s: SpeedState, direction: 1 | -1): SpeedState {
  return commitSpeed(s, s.committed + direction * QUANTUM);
}

function clampSpeed(v: number): number {
  if (!Number.isFinite(v)) return 1;
  return Math.min(MAX_SPEED, Math.max(MIN_SPEED, v));
}

/**
 * How a rate is written on screen: `1`, `1.25`, `2` — no trailing `.0`, and no
 * float spill like `1.2500000000000002`.
 */
export function formatRate(rate: number): string {
  const r = Math.round(rate * 100) / 100;
  return Number.isInteger(r) ? String(r) : String(r.toFixed(2)).replace(/0$/, '');
}