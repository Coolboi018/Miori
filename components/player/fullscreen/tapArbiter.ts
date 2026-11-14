// The tap-arbitration decision, as PURE functions.
//
// Extracted from `GestureSurface.tsx` so `scripts/check-gesture-arbitration.ts`
// can drive the EXACT decision the responder makes — same input sequence, same
// rules — without a device, a PanResponder, or React Native at all. A check
// that models the rules in its own copy proves nothing about the code (that
// lesson is already in `progress.md` via `check-nav-dedupe.ts`), so the
// surface DELEGATES here rather than restating the rules: one decision, two
// consumers, no drift possible between what ships and what is checked.
//
// THE RULE (the header of `GestureSurface.tsx` carries the full history): ONE
// RESOLUTION PER GESTURE, DECIDED ONCE.
//
//   side tap    → parked. A same-side tap within `DOUBLE_TAP_MS` converts the
//                 pair into ONE seek. Silence past the window — delivered by
//                 `deliverMatured` on the surface's timer — promotes the parked
//                 tap to a toggle. A repeated series therefore produces ONLY
//                 seeks; the chrome never flashes mid-series.
//   centre tap  → the dead band can never seek, so it toggles immediately.
//   any lone gesture (hold, drag, terminate, lock) → the surface cancels the
//                 pending promotion FIRST, so nothing fires late into a state
//                 it no longer describes.

/** Decision window. Two side taps within this span are ONE seek. */
export const DOUBLE_TAP_MS = 300;
/** How long tap deltas accumulate before the readout clears. */
export const ACCUMULATE_MS = 600;

export interface TapState {
  /** Release time of the parked tap (ms), or `null` when nothing is parked. */
  t: number | null;
  /** Which half the parked tap landed on; 0 = nothing parked. */
  side: -1 | 0 | 1;
}

export const EMPTY_TAP_STATE: TapState = { t: null, side: 0 };

/** At-most-once effects of one resolved gesture. */
export interface TapActions {
  /** The chrome toggle — a confirmed single tap. */
  onToggle: () => void;
  /** The ±10s seek — a confirmed pair. */
  onSeek: () => void;
}

export interface TapInput {
  /** Wall-clock ms of THIS tap's release. */
  now: number;
  /** -1 left, 0 dead band, +1 right (`locationSide()` on the surface). */
  side: -1 | 0 | 1;
  actions: TapActions;
}

/**
 * Resolve one released tap against the parked state; returns the NEXT state.
 *
 * A pair → one seek, state cleared. Anything else while a tap is parked → the
 * parked tap's promise (a toggle) is paid first, because it is now provably
 * lone. A centre tap resolves instantly on top of that; a side tap parks.
 */
export function resolveTap(prev: TapState, input: TapInput): TapState {
  const { now, side, actions } = input;

  const isPair =
    prev.t != null && side !== 0 && prev.side === side && now - prev.t < DOUBLE_TAP_MS;

  if (isPair) {
    actions.onSeek();
    return EMPTY_TAP_STATE;
  }

  // The parked tap is provably lone: pay its toggle before anything else.
  if (prev.t != null) actions.onToggle();

  if (side === 0) {
    // Dead band: can never pair, resolves immediately on top of the delivery.
    actions.onToggle();
    return EMPTY_TAP_STATE;
  }

  return { t: now, side };
}

/**
 * Time itself can resolve a tap: if the parked tap has aged past the window it
 * was a lone tap all along, and its toggle is due. Call from the surface's
 * promotion timer; the surface validates the stamp before calling, so a state
 * superseded by a pair or a new press never reaches here.
 */
export function deliverMatured(prev: TapState, now: number, actions: Pick<TapActions, 'onToggle'>): TapState {
  if (prev.t != null && now - prev.t >= DOUBLE_TAP_MS) {
    actions.onToggle();
    return EMPTY_TAP_STATE;
  }
  return prev;
}
