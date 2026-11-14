// Seeking and scrubbing — the tolerance a seek is allowed to land with.
//
// ═══════════════════════════════════════════════════════════════════════════
// REVERSAL (14–16 Oct). A GESTURE MUST NOT LEAVE STATE ON THE PLAYER.
// ═══════════════════════════════════════════════════════════════════════════
//
// This module used to carry a state machine. `beginScrub`/`endScrub` tracked
// `scrubbingModeOptions.scrubbingModeEnabled` and an iOS `wasPlaying` flag, and
// the whole design rested on one rule: whatever the drag writes, some other path
// MUST write back. Every crash and every weird symptom in this file's history is
// that rule failing somewhere nobody looked:
//
//   - Android FREEZES THE PICTURE. `scrubbingModeEnabled: true` suppresses
//     playback. The SDK says so in the property's own doc comment. So the frame
//     under the viewer's finger stopped moving for the whole drag while the
//     audio played on — which reads as a network fault, because that is exactly
//     what it looks like. iOS froze too, via the recommended `pause()`.
//   - TWO CRASHES, both from writing to the player at the wrong moment. One from
//     a screen-level unmount cleanup running after `useVideoPlayer` had already
//     released the native player. One from the bar reporting its own unmount,
//     which the code's comment asserted was safe on the basis that "children
//     unmount before parents" — an ordering React does not guarantee, and the
//     device disproved.
//   - A DRAG THAT SILENTLY DID NOTHING. The chrome auto-hides after 3s and the
//     bar is inside it, so holding a drag still for longer than that unmounted
//     the bar mid-gesture. The release handler never ran, so no seek was issued
//     — the viewer dragged a timeline and nothing happened.
//
// And the rule that motivated all of it did not pay off. The commit seek was
// supposed to happen "while scrubbing mode is still on", which is the one seek
// that mode exists for — but the code did the opposite, because `setScrubbing`
// turned the mode off synchronously and THEN called the seek. The commit ran at
// the viewer's resting tolerance, `exact` by default, which on a long HLS
// episode means ExoPlayer decodes forward from the preceding keyframe and
// discards frames until it reaches the target. That is the "the video restarts"
// report.
//
// WHAT A REAL PLAYER DOES, AND WHY THIS IS IT
//
// The video KEEPS PLAYING while you drag. The knob, the fill and the preview
// clock follow your finger; the picture underneath does not; one seek fires on
// release. No freeze, no state on the player, nothing to leak, nothing to
// clean up, and no way for a gesture to outlive itself.
//
// So the gesture now touches the player ZERO times. The only thing it writes is
// the widened tolerance, it writes it immediately around ONE seek, and it
// restores it in the same tick. There is no second path that has to remember,
// because there is nothing left behind to remember.
//
// This is not continuous seeking — the picture does not follow the finger. That
// is a deliberate trade, and the cost is the reason: on a 24-minute HLS episode
// every seek is a segment fetch and a decoder reset, and a drag fires move
// events at the gesture rate. Desktop players do follow the finger; mobile
// players (the ones this app competes with) jump on release, and they feel fine,
// because the thing a viewer actually judges is whether the timeline responds
// and whether the video keeps running.
//
// NO IMPORTS, DELIBERATELY
//
// `scripts/check-player-scrub.ts` imports this file and runs it under plain
// `tsx` with no React Native and no Expo — same rule as `health.ts`, `speed.ts`
// and `failure.ts`. The `SeekTolerance` shape is duplicated from
// `expo-video/build/VideoPlayer.types.d.ts` rather than imported, and the check
// script asserts it against that file so a drift shows up as a failed check
// rather than as a wrong comment.

/**
 * expo-video's `SeekTolerance`, restated.
 *
 * `toleranceBefore` — how far BEFORE the requested time the player may land.
 * `toleranceAfter` — how far AFTER it may land. Both seconds, both must be
 * non-negative (the SDK says so, and a negative tolerance is a request to seek
 * backwards past where the caller asked).
 */
export interface SeekTolerance {
  toleranceBefore: number;
  toleranceAfter: number;
}

/**
 * How precisely a seek should land, as a user-facing choice.
 *
 * Keys are the stored values, in ascending looseness. `lib/settings/store.ts`
 * holds the labels and hints; the NUMBERS live here because they are rules —
 * how much slop is safe is a property of the pipeline, not of the UI.
 */
export type SeekPrecision = 'exact' | 'fast' | 'rough';

/**
 * Tolerance per precision.
 *
 * `exact` is `{0, 0}` and is therefore the SDK's own default: "By default, the
 * player seeks to the exact requested time." It is the default here for the same
 * reason it is the default there — an imprecise seek is visibly wrong (you drag
 * to 12:04 and land on 12:06), whereas a slow seek is merely slow, and the slow
 * path is one the viewer only notices when they are on a train.
 *
 * `rough` is 2s in both directions, which is roughly ExoPlayer's own
 * `SeekParameters.DEFAULT` (2500ms) and the smallest value that reliably lands
 * on a neighbouring keyframe rather than decoding forward from the last one.
 */
export const SEEK_TOLERANCES: Record<SeekPrecision, SeekTolerance> = {
  exact: { toleranceBefore: 0, toleranceAfter: 0 },
  fast: { toleranceBefore: 0.25, toleranceAfter: 0.25 },
  rough: { toleranceBefore: 2, toleranceAfter: 2 },
};

/** The precision used when the stored value is missing or unrecognised. */
export const DEFAULT_PRECISION: SeekPrecision = 'exact';

/**
 * Tolerance floors for the ONE seek a drag commits.
 *
 * ASYMMETRIC ON PURPOSE, and the asymmetry is the whole point. A seek lands on
 * a keyframe at or before the target, so a symmetric tolerance mostly buys the
 * "land EARLY" half — and a frame sitting behind the thumb reads as the bar
 * lying about where it is. Allowing twice as much overshoot as undershoot keeps
 * the picture at or just ahead of where the viewer pointed.
 *
 * These are FLOORS, not replacements: a viewer who chose `rough` does not get a
 * more precise seek by dragging.
 *
 * The scope changed with the reversal above. These used to be held for the whole
 * drag, which — because the commit seek was dispatched after the restore — meant
 * they were in effect for NOTHING at all. They now bracket the commit and
 * nothing else, which is the only window in which a tolerance can influence a
 * seek this app makes on its own initiative.
 */
export const SCRUB_BEFORE = 0.5;
export const SCRUB_AFTER = 1;

/**
 * The standing tolerance for a precision, clamped.
 *
 * Clamped rather than trusted because the value can arrive from disk: the
 * settings bag is a JSON blob, and a key removed from `SettingsSchema` leaves
 * whatever was under it in the stored JSON. A negative tolerance is not a
 * smaller tolerance, it is an inverted one, and the SDK's contract is
 * non-negative — so the floor lives here where every caller gets it.
 */
export function toleranceFor(precision: SeekPrecision): SeekTolerance {
  const t = SEEK_TOLERANCES[precision] ?? SEEK_TOLERANCES[DEFAULT_PRECISION];
  return {
    toleranceBefore: clampTolerance(t.toleranceBefore),
    toleranceAfter: clampTolerance(t.toleranceAfter),
  };
}

/**
 * What to write for the duration of a scrub's commit seek.
 *
 * NOT a state and NOT something a caller is expected to hold. It is a pure
 * function of the viewer's own precision, called twice around a single seek:
 *
 *   player.seekTolerance = commitTolerance(precision);
 *   player.seekBy(delta);
 *   player.seekTolerance = toleranceFor(precision);
 *
 * Both writes are in one expression's worth of code and in the same tick, so
 * there is no window in which the widened value survives into an unrelated seek
 * — which is the failure mode of the state machine this replaces, where a
 * dropped `endScrub` left every later double-tap, resume and intro skip landing
 * keyframes away from where the viewer asked.
 *
 * The widest floor matters here more than anywhere else: this is the seek a
 * viewer watches happen, and landing a second and a half away from the bar they
 * just let go of is what "the timeline is not working properly" means.
 */
export function commitTolerance(precision: SeekPrecision): SeekTolerance {
  const base = toleranceFor(precision);
  return {
    toleranceBefore: Math.max(base.toleranceBefore, SCRUB_BEFORE),
    toleranceAfter: Math.max(base.toleranceAfter, SCRUB_AFTER),
  };
}

function clampTolerance(v: number): number {
  if (!Number.isFinite(v) || v < 0) return 0;
  return v;
}

/**
 * Where a pointer at `localX` on a `width`-wide track lands, in seconds.
 *
 * `null` means UNMEASURABLE — and that is a distinct answer from `0`.
 *
 * The first version of this lived in the PanResponder and returned `0` when the
 * bar had not been laid out or the duration was not known yet. `0` is a legal
 * target, so a release with either one missing did the one thing it must never
 * do: it rewound the episode to the beginning, because "I cannot tell where you
 * pointed" and "the beginning" are the same number.
 */
export function scrubTarget(localX: number, width: number, duration: number): number | null {
  if (!Number.isFinite(width) || !Number.isFinite(duration)) return null;
  if (width <= 0 || duration <= 0) return null;
  if (!Number.isFinite(localX)) return null;
  const f = Math.min(1, Math.max(0, localX / width));
  return f * duration;
}