// The gesture surface: everything you can do by touching the video itself.
//
// Three gestures, arbitrated against each other by a single `PanResponder`
// rather than by nesting `Pressable`s. That is a deliberate departure from the
// obvious approach (a `Pressable` for the tap, a `LongPress` recogniser on top),
// and the reason is ARBITRATION:
//
//   - A `Pressable` and a long-press recogniser competing for the same touch
//     means the tap only fires if the long-press recogniser has already given
//     up — so a hold long enough to boost would ALSO have fired a tap on
//     release. One press, two actions.
//   - Double-tap needs a window, and that window has to survive a press that was
//     a double-tap. Nested responders do not give you that for free.
//
// One responder means one place that decides "was this a tap, a double-tap, or a
// hold", and the three cannot produce more than one action between them.
//
// ═══════════════════════════════════════════════════════════════════════════
// TAP ARBITRATION — the only rule worth reading twice (the ShonenX mirror).
//
// `ShonenX/lib/features/player/presentation/widgets/gesture_overlay.dart`
// solves the same problem by toggling the controls on EVERY `onTapUp` — the
// first tap toggles the chrome, the paired second tap toggles it AGAIN and
// seeks, and its seek branch then calls `onHideControls` to undo what its own
// toggle just did. The residue of that frame is exactly what this app showed:
// repeated double-tap seeks flashing the overlay on and off, and the third tap
// of a fast series occasionally swallowed as a stray toggle.
//
// The rule here: ONE RESOLUTION PER GESTURE, DECIDED ONCE.
//
//   side tap    → waits out `DOUBLE_TAP_MS` of silence. A same-side tap inside
//                 the window converts the pair into ONE seek; silence after the
//                 window promotes the parked tap to a full toggle. A repeated
//                 series therefore produces ONLY seeks — the chrome never
//                 flashes mid-series, and no overlay races its own exit.
//   centre tap  → the dead band can never seek, so it resolves as a tap
//                 immediately (that toggle must not feel laggy).
//   hold / drag / termination / lock → cancels the pending promotion FIRST, so
//                 nothing fires late into a state it no longer describes.
//
// The promotion validates its stamp before firing, so a tap superseded by a
// pair or a new press is never delivered.
//
// THE SPEED MODEL LIVES IN `lib/player/speed.ts`. This file only translates
// gestures into calls on it. It holds no speed value of its own and never
// computes a restore target — that indirection is the whole fix, and a local
// copy of "the speed to go back to" is exactly the bug being avoided.
//
// Exported for `scripts/check-gesture-arbitration.ts` so the arbitration rules
// are pinned by a test that can be read without a device.

import { memo, useCallback, useMemo, useRef, useState } from 'react';
import {
  PanResponder,
  StyleSheet,
  View,
  type GestureResponderEvent,
  type LayoutChangeEvent,
} from 'react-native';

import { SeekHud, SpeedHud } from './Hud';
import { RIPPLE_MS, SeekRipple, SKIP_SECONDS } from '@/components/player/SeekRipple';
import { DOUBLE_TAP_MS, EMPTY_TAP_STATE, deliverMatured, resolveTap, type TapState } from './tapArbiter';

/** Re-exported so call sites keep one import path for this file's constants. */
export { DOUBLE_TAP_MS } from './tapArbiter';

/** A press held this long, without moving, is promoted to a speed hold. */
const HOLD_MS = 320;
/** Movement (px) past this cancels a PENDING hold. */
const HOLD_SLOP = 12;
/** Fraction of the width down the middle where a tap is never a seek. */
const INERT_BAND = 0.2;

export interface GestureHandlers {
  /**
   * A toggled tap — never runs on both halves of a pair. Side taps fire it
   * after `DOUBLE_TAP_MS` of silence (the pair had to be ruled out first);
   * centre taps fire it immediately, because the dead band can never seek.
   */
  onTap: () => void;
  /** Second tap of a pair, alongside the seek it produced. */
  onDoubleTap: () => void;
  onSeek: (deltaSeconds: number, at: { x: number; y: number }) => void;
  onHoldStart: () => void;
  onHoldMove: (dyPx: number) => void;
  onHoldEnd: () => void;
}

export const GestureSurface = memo(function GestureSurface({
  enabled,
  locked,
  handlers,
  /** Live boost rate for the HUD, or null when not holding. */
  boostRate,
}: {
  enabled: boolean;
  /** Locked controls: a tap wakes the unlock affordance and nothing else. */
  locked: boolean;
  handlers: GestureHandlers;
  /** Non-null only while a long-press is held. */
  boostRate: number | null;
}) {
  const [ripple, setRipple] = useState<{ dir: -1 | 1; x: number; y: number; id: number } | null>(null);
  const [seekTotal, setSeekTotal] = useState<{ delta: number; side: 'left' | 'right' } | null>(null);

  // Refs for everything the responder reads. The responder is built ONCE, so
  // anything it closes over by value would be stale; anything it must not miss
  // lives behind a ref.
  const hRef = useRef(handlers);
  hRef.current = handlers;
  const lockedRef = useRef(locked);
  lockedRef.current = locked;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  const widthRef = useRef(0);
  /**
   * The parked tap, as the arbiter models it. All side-tap decisions go
   * through `tapArbiter.resolveTap` / `deliverMatured` — see that file for why
   * the decision lives in one pure place (the check script drives THIS
   * decision, not a copy of it).
   */
  const lastTapRef = useRef<TapState>(EMPTY_TAP_STATE);
  const accumRef = useRef<{ seconds: number; timer: ReturnType<typeof setTimeout> | null }>({
    seconds: 0,
    timer: null,
  });
  const holdRef = useRef<{
    active: boolean;
    startY: number;
    timer: ReturnType<typeof setTimeout> | null;
  }>({ active: false, startY: 0, timer: null });
  const rippleIdRef = useRef(0);
  const rippleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * The pending "this was a lone tap, toggle the controls" promotion.
   *
   * A SIDE tap cannot be resolved the moment it lands — it may be the first
   * half of a double-tap seek — so it waits out `DOUBLE_TAP_MS` of silence
   * here and only then promotes to a full tap. This is the one deliberate
   * latency in the surface, and the price is worth stating: showing the
   * chrome instantly and taking it back when the pair confirms (the
   * "provisional" design this replaces) flashes the overlay on EVERY tap of
   * a repeated double-tap series, which is exactly the complaint that
   * brought this file to hand. With the promotion, a series of double-taps
   * produces ONLY seeks — no chrome flash, no half-shown overlay racing its
   * own exit animation. The 300ms wait is invisible for a hide (nothing
   * moved yet) and acceptable for a show; players that do show instantly
   * do it by never arbitrating, and they are the ones with this bug.
   */
  const tapPromoteRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const onLayout = useCallback((e: LayoutChangeEvent) => {
    widthRef.current = e.nativeEvent.layout.width;
  }, []);

  const cancelHoldTimer = useCallback(() => {
    if (holdRef.current.timer) clearTimeout(holdRef.current.timer);
    holdRef.current.timer = null;
  }, []);

  const cancelTapPromotion = useCallback(() => {
    if (tapPromoteRef.current) clearTimeout(tapPromoteRef.current);
    tapPromoteRef.current = null;
  }, []);

  const flashRipple = useCallback((dir: -1 | 1, x: number, y: number) => {
    rippleIdRef.current += 1;
    setRipple({ dir, x, y, id: rippleIdRef.current });
    // Cleared on a timer rather than left to the next tap: a stale ripple left
    // on screen after the animation ends is a frozen frame in the middle of the
    // video. RIPPLE_MS matches the animation, so the node unmounts on the same
    // beat the bloom ends.
    if (rippleTimerRef.current) clearTimeout(rippleTimerRef.current);
    rippleTimerRef.current = setTimeout(() => setRipple(null), RIPPLE_MS);
  }, []);

  const addSeek = useCallback(
    (dir: -1 | 1, e: GestureResponderEvent) => {
      const { locationX, locationY } = e.nativeEvent;
      hRef.current.onSeek(dir * SKIP_SECONDS, { x: locationX, y: locationY });
      flashRipple(dir, locationX, locationY);

      accumRef.current.seconds += dir * SKIP_SECONDS;
      setSeekTotal({ delta: accumRef.current.seconds, side: dir > 0 ? 'right' : 'left' });

      if (accumRef.current.timer) clearTimeout(accumRef.current.timer);
      accumRef.current.timer = setTimeout(() => {
        accumRef.current.seconds = 0;
        setSeekTotal(null);
      }, ACCUMULATE_MS);
    },
    [flashRipple]
  );

  const pan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => enabledRef.current,
        // Keep the gesture once it has started even if the finger leaves the
        // view: sliding off the video mid-hold is still holding the speed.
        onMoveShouldSetPanResponder: () => enabledRef.current,

        onPanResponderGrant: (e) => {
          cancelTapPromotion();
          holdRef.current = { active: false, startY: e.nativeEvent.pageY, timer: null };
          // The hold is CONFIRMED by a timer, not assumed. Until it fires this
          // press is still a tap candidate, which is what lets a quick double-tap
          // stay a double-tap instead of decaying into a hold.
          holdRef.current.timer = setTimeout(() => {
            if (enabledRef.current && !lockedRef.current) {
              holdRef.current.active = true;
              hRef.current.onHoldStart();
            }
          }, HOLD_MS);
        },

        onPanResponderMove: (e) => {
          const y = e.nativeEvent.pageY;
          if (holdRef.current.active) {
            // Promoted: movement IS the speed scrub. Up (negative dy) is faster.
            hRef.current.onHoldMove(holdRef.current.startY - y);
            return;
          }
          // Not yet promoted: movement past the slop means this is a drag, not
          // a hold, so cancel the pending promotion. Without this a swipe across
          // the video would boost the speed as well.
          if (Math.abs(y - holdRef.current.startY) > HOLD_SLOP) cancelHoldTimer();
        },

        onPanResponderRelease: (e) => {
          const wasHolding = holdRef.current.active;
          cancelHoldTimer();
          holdRef.current.active = false;

          // A promoted hold NEVER also becomes a tap. This is the line a nested
          // Pressable + LongPress pairing gets wrong.
          if (wasHolding) {
            hRef.current.onHoldEnd();
            return;
          }

          // Locked: a tap only wakes the unlock affordance. It must not also
          // toggle the chrome, or unlocking would be a two-tap operation.
          // Seeking is refused outright — a pocket press that jumps the
          // playhead is the exact failure the lock is there to prevent.
          if (lockedRef.current) {
            // The pair is dead while locked; do not let a tap AFTER an unlock
            // pair with a tap from before it, or unlocking then tapping fast
            // seeks the video on the same gesture.
            cancelTapPromotion();
            lastTapRef.current = EMPTY_TAP_STATE;
            hRef.current.onTap();
            return;
          }

          const resolvedSide: -1 | 0 | 1 =
            locationSide(e.nativeEvent.locationX, widthRef.current);
          const now = Date.now();

          // THE DECISION lives in `tapArbiter.resolveTap` — same rules, one
          // implementation, and the offline check script drives exactly this
          // function rather than a re-statement of it. The action callbacks
          // map the arbiter's at-most-once effects onto the real chrome. The
          // arbiter runs UNAWARE of the lock because the lock is a screen-level
          // state, already refused above.
          cancelTapPromotion();
          lastTapRef.current = resolveTap(lastTapRef.current, {
            now,
            side: resolvedSide,
            actions: {
              onToggle: () => hRef.current.onTap(),
              onSeek: () => {
                // `resolveTap` only calls `onSeek` for a non-zero side, so the
                // narrowing lives here rather than in the arbiter's signature.
                if (resolvedSide !== 0) addSeek(resolvedSide, e);
                hRef.current.onDoubleTap();
              },
            },
          });

          // A fresh park schedules its own maturity on the SAME window the
          // arbiter decides against. The stamp check is what makes a park
          // superseded by a pair or a newer press never deliver.
          const parked = lastTapRef.current;
          if (parked.t != null) {
            tapPromoteRef.current = setTimeout(() => {
              tapPromoteRef.current = null;
              const l = lastTapRef.current;
              if (l.t !== parked.t || l.side !== parked.side) return;
              lastTapRef.current = deliverMatured(l, Date.now(), {
                onToggle: () => hRef.current.onTap(),
              });
            }, DOUBLE_TAP_MS);
          }
        },

        onPanResponderTerminate: () => {
          const wasHolding = holdRef.current.active;
          cancelHoldTimer();
          cancelTapPromotion();
          holdRef.current.active = false;
          if (wasHolding) hRef.current.onHoldEnd();
        },
      }),
    [addSeek, cancelHoldTimer, cancelTapPromotion]
  );

  return (
    <View style={StyleSheet.absoluteFill} onLayout={onLayout} {...pan.panHandlers}>
      {ripple ? <SeekRipple key={ripple.id} dir={ripple.dir} x={ripple.x} y={ripple.y} /> : null}
      {seekTotal ? <SeekHud delta={seekTotal.delta} side={seekTotal.side} /> : null}
      {boostRate != null ? <SpeedHud rate={boostRate} /> : null}
    </View>
  );
});

/** Tap deltas accumulate across this window — see `SeekHud`. */
const ACCUMULATE_MS = 600;

/**
 * Which half of the surface a tap landed on, with a DEAD BAND down the middle.
 *
 * YouTube's desktop player leaves the middle third inert so a double-tap there
 * cannot be mistaken for a seek. This is a phone held sideways in two hands, so
 * a dead band matters for a different reason: a thumb crossing the frame to
 * reach a control lands near the centre constantly, and an accidental 10s jump
 * is worse than no seek at all. 20% (not 33%) because the horizontal span here
 * is the screen's LONG edge — a band sized for a landscape desktop window is
 * enormous when measured against a thumb's arc.
 *
 * A tap inside the band returns 0 and is therefore never a seek — only a
 * controls toggle.
 */
function locationSide(x: number, width: number): -1 | 0 | 1 {
  if (width <= 0) return 0;
  const dead = width * INERT_BAND;
  if (x < width / 2 - dead) return -1;
  if (x > width / 2 + dead) return 1;
  return 0;
}
