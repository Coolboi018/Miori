// The vertical-swipe rules, as PURE functions.
//
// WHAT THIS IS. Sliding up or down anywhere on the video raises or lowers one of
// two values: the LEFT half of the screen and the RIGHT half are a different
// knob, and the settings screen can swap which is which. Extracted from
// `GestureSurface.tsx` for the same reason `tapArbiter.ts` was: the offline
// check drives the REAL decision, not a re-statement of it.
//
// THE ARBITRATION PROBLEM, STATED ONCE. The same surface already owns:
//
//   tap / double-tap   → toggle chrome, seek ±10s   (`tapArbiter`)
//   press-and-hold     → speed boost, driven by dy  (`lib/player/speed.ts`)
//   vertical drag      → volume / brightness        (this file)
//
// Hold and vertical drag are the pair that must not collide: both are "finger
// down, move it vertically". The rule that separates them is TIME, and it is
// already owned by the surface — a press that sits still for `HOLD_MS` becomes a
// speed hold, and the moment it is promoted, vertical is refused for the rest of
// that gesture. So:
//
//   move before the hold timer fires → volume/brightness
//   sit still past the hold timer   → speed (and the later movement is speed)
//
// That is also why the drag needs a SLOP: the first `V_SLOP` points of any
// finger movement are noise (a thumb settling, a screen registering the touch),
// and engaging on the first pixel would turn every tap with a shaky finger into
// a volume change.
//
// DOMINANCE, NOT DIRECTION. `|dy| > |dx| * V_DOMINANCE` rather than plain
// `|dy| > |dx|`: a diagonal swipe is a coin flip for which one the user meant,
// and a 45° thumb arc that drops the volume is worse than one that does nothing.
// Requiring the vertical component to win by a margin makes the intent
// unambiguous before anything moves.
//
// NOTHING IS CLAMPED HERE. `dragFraction` reports the raw travel as a fraction
// of the surface height (positive = up) and the SCREEN adds it to the value the
// drag started from, then clamps. Keeping the fraction honest means the same
// number can be used by a HUD that shows overshoot, and it keeps this module
// free of any notion of what a "volume" is.

export type SwipeKind = 'volume' | 'brightness';

/** Which half of the screen the press started on — and so where the HUD draws. */
export type SwipeSide = 'left' | 'right';

/** Which knob each half of the screen drives. */
export interface SwipeSides {
  left: SwipeKind;
  right: SwipeKind;
}

/** Movement (px) before a drag is allowed to become a volume/brightness swipe. */
export const V_SLOP = 16;

/** How much the vertical component must beat the horizontal one. See above. */
export const V_DOMINANCE = 1.2;

/**
 * The mapping a stored `player.swipeSides` value means.
 *
 * Brightness-left is the convention every phone player uses (YouTube, MX, VLC),
 * so it is the default and it is spelled out here rather than inferred: a
 * "swap" setting whose default is decided by an `else` branch is a setting that
 * silently flips if someone reorders the registry.
 */
export function sidesFor(setting: 'brightness-left' | 'volume-left'): SwipeSides {
  return setting === 'volume-left'
    ? { left: 'volume', right: 'brightness' }
    : { left: 'brightness', right: 'volume' };
}

/**
 * Which half a touch at `x` started on.
 *
 * A touch that starts EXACTLY on the midline goes right, simply because a tie has
 * to resolve somewhere; a screen's width is never an odd number in practice, so
 * this is a formality rather than a rule.
 *
 * This is BOTH the knob selector and the HUD's anchor: the readout appears on the
 * half the finger is on, which is the only place the eye already is.
 */
export function sideForX(x: number, width: number): SwipeSide {
  if (width <= 0) return 'right';
  return x < width / 2 ? 'left' : 'right';
}

/** Which knob a touch at `x` belongs to. Thin wrapper over `sideForX`. */
export function kindForX(
  x: number,
  width: number,
  sides: SwipeSides
): SwipeKind {
  return sides[sideForX(x, width)];
}

/**
 * The half a given knob lives on — the inverse of `sideForX`.
 *
 * Needed by paths that have a KIND but no touch: the mute button showing the
 * volume readout, say. Deriving it from the setting keeps every reader agreeing
 * about the swap without either of them knowing what the setting key is.
 */
export function sideForKind(sides: SwipeSides, kind: SwipeKind): SwipeSide {
  return sides.left === kind ? 'left' : 'right';
}

/**
 * Where the READOUT draws: the OPPOSITE half from the drag.
 *
 * The finger is on the half it started on — that is where the thumb is, and a bar
 * on that half is a bar under the hand. Mirroring it puts the readout on the one
 * piece of screen nobody is touching, and it is what other players do for the
 * same reason. The value still belongs to the half the drag started on; only the
 * display is mirrored.
 */
export function hudSideFor(dragSide: SwipeSide): SwipeSide {
  return dragSide === 'left' ? 'right' : 'left';
}

/**
 * Should this movement engage the vertical swipe?
 *
 * `holding` is the surface's already-promoted speed hold; `locked` is the
 * lock-controls state, where the same rule that refuses a pocket seek refuses a
 * pocket volume/brightness change.
 *
 * THIS ANSWERS "SHOULD A DRAG START", NOT "IS IT STILL GOING". The surface owns
 * the second question with an early return on its own `active` ref, so slop and
 * dominance are START conditions and a swipe that arcs near the end cannot drop
 * out halfway. (There is deliberately no `active` input here: passing it would
 * make this function's answer "no" for a drag that is already running, which is
 * the opposite of what a caller checking it mid-gesture would want.)
 */
export function engagesVertical(
  dx: number,
  dy: number,
  opts: { holding: boolean; locked: boolean }
): boolean {
  if (opts.holding || opts.locked) return false;
  if (Math.abs(dy) <= V_SLOP) return false;
  return Math.abs(dy) > Math.abs(dx) * V_DOMINANCE;
}

/**
 * Travel since the gesture started, as a fraction of the surface height.
 *
 * POSITIVE IS UP (more): screen coordinates grow downward, and a swipe up
 * raising the volume is the direction every player uses. A full-height swipe is
 * exactly 1.0, so the whole range is reachable from the middle of the screen
 * without the value having to leap.
 */
export function dragFraction(startY: number, y: number, height: number): number {
  if (height <= 0) return 0;
  return (startY - y) / height;
}

/** Clamp to the only range a volume or a brightness can have. */
export function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}
