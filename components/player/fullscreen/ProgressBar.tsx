// The scrub bar: buffered, played, skip stamps, and the drag handle.
//
// A `PanResponder` over a plain `View`, not a slider library, because the only
// thing this needs to be is a bar the user can hit in landscape on a phone at
// arm's length — and the interaction that makes it work (a tall invisible hit
// area around a 3px line) is easier to get right here than to configure into
// someone else's.
//
// The skip stamps are why this is not just a progress bar. Our sources already
// ship `intro`/`outro` markers (`WatchSource` in `lib/extensions/types.ts`), so
// the segment that is about to be skipped is visible ON the timeline instead of
// being something that only shows up once the button appears.
//
// WHAT MAKES IT FEEL LIKE A REAL PLAYER (the shapes everyone knows from
// YouTube), all of it arriving without costing the architecture anything:
//
//   - The track THICKENS under the finger (3 → 7pt, animated off the same
//     shared value that grows the knob), so touching the bar is an event the
//     eye confirms instead of a 3px line silently waiting.
//   - While a drag is live, a floating time chip rides above the thumb and
//     names the moment the release will commit to. The chip's position runs on
//     the shared values (no renders), and its TEXT refreshes on a 100ms
//     interval inside its own tiny component — the same isolation the clock
//     row uses, ten times the rate.
//   - The knob gains a soft halo while the finger is down, and scales further.
//   - The right-hand clock toggles between the total runtime and the time
//     REMAINING, on a tap — the double-action label YouTube made standard.
//
// ═══════════════════════════════════════════════════════════════════════════
// THE PLAYHEAD IS NOT REACT STATE, AND THAT IS THE POINT
//
// `position` arrives twice a second. It used to arrive as `useState` here, and
// every tick re-rendered this component AND everything above it — the skip slot,
// the gradient, the four trigger chips and their measured slots — because they
// are all siblings in one subtree. `progress.md` §Performance #6 measured that
// at 2 Hz on a screen whose only visible motion is the playhead itself.
//
// So the playhead is a Reanimated shared value the caller writes from a native
// listener, and the fill and the knob are animated styles. React is told about
// the gesture twice (down and up) and about the clock once a second, and about
// the playhead not at all.
//
// TWO CONSTRAINTS THAT DECIDED THE IMPLEMENTATION. Both were read out of
// Reanimated 4.5.1's own `src/common/style/config.ts` rather than from memory,
// and both are load-bearing enough that writing from memory would have produced
// a bar that looks right and never moves:
//
//   1. `width` and `left` are bare pass-throughs (`width: true`, `left: true`)
//      and only `transform` carries a processor (`processTransform`). There is
//      no percentage handling for a worklet's return value, so a style of
//      `` `${frac * 100}%` `` pushes ONE literal string to native on the first
//      frame and is never updated again. Everything below is therefore in
//      NUMBERS: the track's pixel width arrives via `onLayout` into a shared
//      value, the fill animates `width` in points, and the knob animates
//      `transform: [{ translateX }]` with `left: 0` on the element itself.
//   2. Animating `left` would also work, but it re-runs layout on the UI thread
//      every frame. `transform` does not, and it is the difference between a
//      playhead that keeps up with a drag and one that lags it.
//
// THE ONE THING THAT CANNOT LEAVE REACT is the clock label. `Text` content is
// not an animatable style, so `formatClock` needs a real render. It is isolated
// into its own memoised component below so that a clock tick re-renders two
// `Text` nodes and nothing else — and it rounds to whole seconds, so the label
// changes identity once a second rather than twice.

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
} from 'react-native';
import Animated, {
  useAnimatedProps,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';

import { CLOCK_FONT, UNKNOWN_CLOCK, formatClock } from '@/lib/player/format';
import { scrubTarget } from '@/lib/player/scrub';
import { font, radii } from '@/lib/ui/tokens';

/**
 * Hit-area height vs. visual height.
 *
 * 3px of bar in a 480pt-tall landscape window is a target you cannot hit with a
 * thumb without looking. The drawn bar stays hairline-thin (it has to, or it
 * occludes the frame); the TOUCH target is 28pt tall and centred on it.
 */
const TRACK_H = 3;
const HIT_H = 28;

/**
 * Track height while a finger is on the bar.
 *
 * THE YouTube gesture: the thin line answers a touch by thickening, so contact
 * is a visible event rather than a 3px line silently waiting to be aimed at.
 * The hit area keeps its height, and the track is vertically centred inside it,
 * so thickening is symmetric and shifts nothing around it — the chrome's 45pt
 * progress block is a contract (`check-chrome-layout.ts` line-pins it).
 */
const TRACK_H_ACTIVE = 7;

/**
 * Half the estimated width of the drag preview chip, rounded up.
 *
 * It exists only so the chip can be clamped inside the track's own width — near
 * either edge the chip's CENTRE stops following the thumb, which keeps it from
 * poking past the screen. An estimate is fine here: the chip is inside a
 * `pointerEvents="none"` layer over a dark scrim, and a couple of pixels of
 * forgiveness cannot be seen.
 */
const BUBBLE_HALF = 30;

/** How often the preview chip's TEXT refreshes. */
const BUBBLE_REFRESH_MS = 100;

/**
 * How much bigger the knob gets under the finger.
 *
 * A constant rather than a literal so the animated style above and the number a
 * designer would argue about are the same place. See `draggingSV` for why this
 * is animated at all instead of a conditional style.
 */
const HANDLE_GROW = 0.5;

const OPENING_COLOR = '#4CD964';
const ENDING_COLOR = '#FF6B6B';

export interface SkipWindow {
  intro: { start: number; end: number } | null;
  outro: { start: number; end: number } | null;
}

export const ProgressBar = memo(function ProgressBar({
  position,
  duration,
  buffered,
  skip,
  positionKnown,
  onSeek,
  onScrubActive,
  initialTrackWidth,
  onTrackWidth,
}: {
  /**
   * The playhead, as a shared value.
   *
   * A `SharedValue<number>` rather than a plain prop, deliberately: this is the
   * one value on the bar that changes constantly, and taking it as a shared
   * value is what lets the caller write it from a native listener without
   * rendering anything.
   */
  position: SharedValue<number>;
  duration: number;
  buffered: number;
  skip: SkipWindow;
  /**
   * Whether `position` means anything yet.
   *
   * `false` between "the pipeline is ready" and "the stored resume position has
   * been applied" — a window in which the playhead reads 0 and 0 is not where
   * the episode is. Rendering it anyway produced `0:00` with the knob at the
   * start, then a jump to the real position a moment later.
   */
  positionKnown: boolean;
  /**
   * Fires with the target on release, or with `null` when the bar cannot say
   * where the viewer pointed.
   *
   * `null` IS A REAL ANSWER and it is the reason this is not simply
   * `onSeek(seconds)`. Before the first `onLayout`, or on a live stream whose
   * duration never arrives, the pixel→time mapping does not exist. The previous
   * version returned `0` there, and `0` is a legal target — so a tap during the
   * first layout rewound the episode to the beginning. The caller treats `null`
   * as "do nothing". See `scrubTarget`.
   */
  onSeek: (seconds: number | null) => void;
  /**
   * True on grant, false on release and terminate.
   *
   * NOT on unmount, and the absence is deliberate: the callback keeps this bar
   * mounted during a drag, so there is no unmount to report. It used to be a
   * handshake that flipped the player's `scrubbingModeOptions`, which meant every
   * end-of-drag path had to remember to call back — and the two that tried it
   * from a cleanup crashed the screen on the way out.
   *
   * See `setScrubbing` for what it is used for now.
   */
  onScrubActive?: (active: boolean) => void;
  /** Seed for the track width shared value, so a remount does not flash the knob. */
  initialTrackWidth?: number;
  /** Reports the measured track width to the parent. */
  onTrackWidth?: (width: number) => void;
}) {
  /** The track's pixel width, on the UI thread. See the header, rule 1. */
  const trackWidth = useSharedValue(initialTrackWidth ?? 0);
  /** Latest onTrackWidth callback, kept in a ref so `onLayout` stays stable. */
  const onTrackWidthRef = useRef(onTrackWidth);
  onTrackWidthRef.current = onTrackWidth;
  /**
   * The preview position under the finger, or `-1` when no drag is in progress.
   *
   * A shared value, NOT `useState`. A drag fires move events at the gesture's
   * own rate — well above 60 Hz on a 120Hz panel — and the previous version
   * called `setScrub` on every one of them, re-rendering this subtree (and its
   * stamps and its accessibility value) to move a thumb.
   *
   * `-1` rather than `null` because this is read on the UI thread every frame,
   * where a sentinel costs a comparison and a null costs a branch.
   */
  const scrub = useSharedValue(-1);
  /**
   * Whether a drag is live, on the UI thread.
   *
   * A shared value and not `useState`, which is worth a note because it is the
   * opposite of the decision this file made about the playhead. The playhead is
   * React state, so it moved here; this boolean was React state and moved back.
   *
   * It was React state for the enlarged knob — written as a plain
   * `styles.handleActive` carrying `transform: [{ scale }]`, and **a second style
   * entry REPLACES the transform array rather than merging into it**, so the knob
   * snapped to the left edge the instant a drag began. Keeping it in the same
   * animated style as the `translateX` fixes that AND removes the render.
   *
   * The second use — the accessibility readout — is now a `useAnimatedProps`
   * worklet below, for the same reason: reading `scrub.value` during render is
   * what Reanimated's strict mode warns about, correctly, because a render is
   * not a place a shared value is expected to be read.
   */
  const draggingSV = useSharedValue(0);

  /**
   * Whether a drag is live, IN REACT — the one React-level fact the render
   * cannot get from a shared value: whether to mount the preview chip at all.
   *
   * Two setStates per gesture (grant and release) — cheap, and the rest of the
   * gesture stays on the UI thread exactly as before. `setDragging` is a
   * `useState` setter, so its identity is stable and the PinResponder's
   * dependency list does not move because of it.
   */
  const [dragging, setDragging] = useState(false);

  /**
   * The pointer's position ON THE TRACK, in track-local pixels — the last one
   * the preview was drawn from, and the one the release commits to.
   *
   * ⚠️ THIS EXISTS BECAUSE `gestureState.moveX` IS 0 UNTIL A MOVE HAPPENS.
   *
   * `PanResponder._initializeGestureState` sets `gestureState.moveX = 0`, and the
   * only other place RN assigns it is the move handler. Its own docs say so:
   * "If no move event has been observed, then `(moveX, moveY)` is invalid." So a
   * TAP — grant, release, nothing in between — released with `moveX === 0`, and
   * `0 - originX` is a large negative number, which `scrubTarget` clamps to the
   * start of the episode.
   *
   * The symptom was "tapping anywhere on the timeline restarts the episode",
   * which is worse than doing nothing: the viewer aimed at 14:20 and got 0:00,
   * and the only evidence they got was the episode rewinding.
   *
   * So the release target is "the last position the preview was showing" rather
   * than a re-derivation from a gesture field that is documented to be invalid
   * until proven otherwise. Grant seeds it, move keeps it current, release reads
   * it — which also means a release that happens between two move events lands
   * where the knob was drawn, not somewhere the finger never was.
   */
  const localXRef = useRef(0);

  // Refs, not state: the PanResponder is created once and must read the latest
  // width/duration without being rebuilt. Rebuilding it mid-drag detaches the
  // responder and the gesture is dropped on the floor.
  const durationRef = useRef(0);
  /** Grant point in PAGE coordinates, so later `moveX` values can be
   *  re-expressed relative to the bar rather than to the window. */
  const originXRef = useRef(0);
  durationRef.current = duration;

  /**
   * The seconds under `localX`, or null when that cannot be known.
   *
   * Delegates to `scrubTarget` so that the decision "unmeasurable is not zero"
   * lives in the module `scripts/check-player-scrub.ts` exercises, rather than
   * being re-derived here where nothing can assert it.
   */
  const secondsAt = useCallback((localX: number) => {
    return scrubTarget(localX, trackWidth.value, durationRef.current);
  }, [trackWidth]);

  /**
   * Tell the screen a drag started or ended, so it can keep this bar mounted.
   *
   * THAT IS ALL IT IS, and the narrowness is the point. It used to be a two-way
   * handshake that turned the player's `scrubbingModeOptions` on and off, which
   * meant every end-of-drag path - release, terminate, and an unmount cleanup
   * added later after the freeze - had to remember to call back. Three of them
   * did it in three different places and two of them crashed the screen.
   *
   * Now the only thing a drag can end is the drag, so the notification carries a
   * boolean and nothing else. The screen ORs it into `bottomBarUp`, and that
   * solves a bug rather than creating a dependency: the chrome auto-hides after
   * 3s and this bar lives inside it, so holding a finger down for longer than
   * that used to unmount the responder mid-gesture - no release handler, no seek,
   * a timeline that simply did not respond.
   *
   * Held in a ref so the PanResponder's dependency list cannot change identity on
   * every render of the parent. A new callback here would rebuild the responder
   * mid-gesture, which is the one thing that must not happen.
   */
  const activeCb = useRef(onScrubActive);
  activeCb.current = onScrubActive;

  /**
   * One gesture transition, two effects.
   *
   * Grouped because they must not be able to disagree: the knob's enlargement and
   * the notification to the screen. Split across the handlers it would be possible
   * to end the drag on the UI thread and never tell the screen, and a bar the
   * screen believes is mounted while it is not is the 3s auto-hide race above.
   */
  const setScrubbing = useCallback(
    (on: boolean) => {
      // withTiming rather than a snap: one value fans out to THREE surfaces
      // (track height, knob scale, halo fade), and a shared easing across all
      // three is what makes the thickening read as one gesture instead of
      // three unrelated twitches. 140ms — past `snappy`, short of `slow`.
      draggingSV.value = withTiming(on ? 1 : 0, { duration: 140 });
      setDragging(on);
      activeCb.current?.(on);
    },
    [draggingSV]
  );

  const pan = useMemo(
    () =>
      PanResponder.create({
        // Immediate, not "wait for a move": a scrub bar that only engages after
        // you drag means tapping it does nothing at all, which reads as broken.
        // The trade is that a vertical flick started ON the bar scrubs instead
        // of scrolling — acceptable, because the bar is 28pt tall at the very
        // bottom edge and there is nothing behind it to scroll.
        onStartShouldSetPanResponder: () => true,
        onPanResponderGrant: (e) => {
          originXRef.current = e.nativeEvent.pageX - e.nativeEvent.locationX;
          // The tap's own position, recorded before anything can overwrite it.
          // See `localXRef` — `moveX` is 0 until a move event, so a release that
          // read `moveX` would aim at the far left of the screen.
          localXRef.current = e.nativeEvent.locationX;
          const at = secondsAt(localXRef.current);
          // ⚠️ NOT `scrub.value = at ?? 0`.
          //
          // A null here means the bar has no width yet or the runtime is unknown,
          // and `?? 0` turned that into a position of zero — so putting a finger
          // down on an unmeasured bar snapped the knob to the start and the clock
          // to 0:00, which is the second half of the "0:00 then the real position"
          // report: it did it on every touch, not only on open.
          //
          // The move handler already skipped the null. Now grant does too, so the
          // rule is the same on both: an unmeasurable pointer leaves the knob
          // where it is, and the release below issues no seek.
          if (at != null) scrub.value = at;
          setScrubbing(true);
        },
        // NO SEEK HERE, and the absence is deliberate rather than inherited.
        // `components/player/PlayerControls.tsx` — the parked portrait player —
        // does seek on every move event, and that is the wrong shape here: a drag
        // fires move events at the gesture rate, and on a 24-minute HLS episode
        // every seek is a segment fetch and a decoder reset. Sixty a second would
        // be worse than the stutter it is meant to remove, and each one would
        // hand the health monitor a `noteSeek` — so the monitor's own clock would
        // be driven by our own gesture.
        //
        // What the finger gets instead is the PREVIEW: thumb, fill and clock all
        // track the drag at frame rate with no seek at all. The single seek a
        // drag produces happens on release.
        onPanResponderMove: (_e, g) => {
          const localX = g.moveX - originXRef.current;
          localXRef.current = localX;
          const at = secondsAt(localX);
          if (at != null) scrub.value = at;
        },
        onPanResponderRelease: () => {
          // `onSeek` FIRST, and before the preview is dropped. The widened
          // tolerance is written by `seekTo` around its own seek and restored in
          // the same tick, so it is only in effect for that one call — and
          // clearing `scrub.value` first flashes the fill back to the old
          // position. (This used to run in the opposite order, which is why every
          // drag committed at the viewer's resting `exact` tolerance and read as
          // the video restarting. See `seekTo`.)
          const target = secondsAt(localXRef.current);
          onSeek(target);
          scrub.value = -1;
          setScrubbing(false);
        },
        onPanResponderTerminate: () => {
          // No seek: the gesture was taken away from us, so there is no honest
          // position to commit to. The knob snaps back and the picture never
          // moved, which is the least-wrong of the available answers.
          scrub.value = -1;
          setScrubbing(false);
        },
        // Refuse to hand the gesture to a parent mid-drag. Without this the
        // enclosing scroll/gesture surface can claim the move and the handle
        // sticks mid-bar.
        onPanResponderTerminationRequest: () => false,
      }),
    [secondsAt, onSeek, scrub, setScrubbing]
  );

  /**
   * ⚠️ THERE IS NO UNMOUNT HANDOFF HERE, AND THERE WAS ONE TWICE.
   *
   * Reporting "my drag died" from this component's cleanup — by calling
   * `onScrubActive(false)` — put a write to the player's `scrubbingModeOptions`
   * inside a child's unmount, and that crashed the screen on the way out:
   *
   *   useMemo$argument_0 (ProgressBar.tsx:240) ← this file's PanResponder useMemo
   *   callDestroy → commitHookEffectListUnmount
   *   → Cannot use shared object that was already released
   *
   * The premise it rested on was "children unmount before parents, so the player
   * is still alive". That premise was asserted, never demonstrated, and the
   * device said otherwise.
   *
   * The reason it no longer needs a handoff at all is that the screen now
   * PREVENTS the unmount: `onScrubActive` ORs into `bottomBarUp`, so the bar
   * stays mounted for as long as a finger is on it. A gesture ends on release,
   * on terminate, or when this bar is torn down with the whole screen — and in
   * that last case there is nothing on the player that a cleanup could undo,
   * because a drag no longer writes any.
   *
   * Do not grow this into one. If a future change needs the bar to end a drag on
   * unmount, the fix is to keep the bar mounted, not to write to the player from
   * a teardown.
   */

  const onLayout = useCallback(
    (e: LayoutChangeEvent) => {
      const w = e.nativeEvent.layout.width;
      trackWidth.value = w;
      onTrackWidthRef.current?.(w);
    },
    [trackWidth]
  );

  const d = duration > 0 ? duration : 0;
  const bufferedF = d > 0 ? Math.min(1, Math.max(0, buffered / d)) : 0;

  /**
   * The fraction played, resolved ONCE on the UI thread.
   *
   * The drag's preview wins over the live playhead while it exists, which is the
   * thing that stops the bar fighting the incoming `timeUpdate` ticks under the
   * finger — the reason the preview value exists at all.
   *
   * `positionKnown` gates BOTH branches. A preview is a position the viewer just
   * chose, so it is always knowable; a live playhead that has not been resumed
   * yet is not. Without the gate, opening an episode drew the fill at 0 and the
   * knob at the start, and then moved both — which is the same claim in two
   * places.
   */
  const playedFraction = useDerivedValue(() => {
    if (scrub.value >= 0) {
      if (duration <= 0) return 0;
      return Math.min(1, Math.max(0, scrub.value / duration));
    }
    if (!positionKnown || duration <= 0) return 0;
    return Math.min(1, Math.max(0, position.value / duration));
  });
  // ⚠️ NO SECOND ARGUMENT. Reanimated's `dependencies` arrays are web-only
  // ("only relevant without the Babel plugin", its own docs say) and ignored
  // on native — the parameter is `_dependencies`, and the mapper rebuilds
  // from the worklet's captured closure (`__closure`), which already carries
  // `duration` and `positionKnown`. Passing a deps array costs only the dev
  // warning "Dependencies should only be used on the web…".

  // NUMBERS, never percentage strings. See the header, rule 1.
  const playedStyle = useAnimatedStyle(() => ({
    width: playedFraction.value * trackWidth.value,
  }));

  const knobStyle = useAnimatedStyle(() => ({
    // BOTH transforms in one style. A second style entry carrying `scale` would
    // replace this array wholesale rather than merge into it, which is the
    // failure the shared value above exists to avoid.
    transform: [
      { translateX: playedFraction.value * trackWidth.value },
      { scale: 1 + draggingSV.value * HANDLE_GROW },
    ],
  }));

  /**
   * The track's height, off the drag value.
   *
   * `height` numbers, not percentage strings — same rule as the fill's width.
   * This re-runs layout on the tiny track subtree only, and only for the ~five
   * frames a press takes to thicken: the kind of cost `transform` is reserved
   * for, spent once per touch-to-release instead of sixty times a second.
   */
  const trackStyle = useAnimatedStyle(() => ({
    height: TRACK_H + draggingSV.value * (TRACK_H_ACTIVE - TRACK_H),
  }));

  /**
   * The halo: a soft white disc behind the knob that only exists while the
   * finger is down. Same translate as the knob (they must never disagree about
   * where the fill ends) and a fade off `draggingSV` so it breathes in and out
   * with the same timing the track thickens by.
   */
  const haloStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: playedFraction.value * trackWidth.value }],
    opacity: draggingSV.value * 0.22,
  }));

  /**
   * The accessible position, on the UI thread.
   *
   * This was a plain `accessibilityValue={{ … }}` reading `scrub.value` and
   * `position.value` **during render**, which Reanimated's strict mode warns
   * about — and the warning is right, not noise: a shared value is not expected
   * to be read mid-render, and doing so means every render is also a read of
   * mutable state that React knows nothing about.
   *
   * `useAnimatedProps` is the answer, and it is a better one than the warning
   * costs: the value a screen reader hears now tracks the playhead continuously
   * instead of only when something else re-renders the bar. `to-do.md` §3.12
   * flags the missing `adjustable` role as the reason a screen-reader user
   * cannot scrub at all, so this readout is not cosmetic.
   */
  const a11yProps = useAnimatedProps(() => {
    const max = Math.max(0, Math.round(duration));
    // Same rule as the fill: a drag preview is knowable, a playhead that has not
    // been resumed yet is not. Announcing `now: 0` to a screen reader is the same
    // false claim, and it has the added problem that a non-visual user has no way
    // to tell it from a real position.
    const seconds = scrub.value >= 0 ? scrub.value : positionKnown ? position.value : 0;
    return {
      accessibilityValue: {
        min: 0,
        max,
        now: Math.max(0, Math.min(max, Math.round(seconds))),
      },
    };
  });
  // No deps argument — same reason as `playedFraction` above. `duration` and
  // `positionKnown` are captured by the worklet itself, and a deps array here
  // prints Reanimated's web-only dependencies warning on every player open.

  return (
    <View style={styles.wrap}>
      {/* Animated, not a plain View, so the accessibility value can come off the
          same shared values as the fill. The PanResponder handlers and `onLayout`
          are ordinary props and behave identically on `Animated.View`. */}
      <Animated.View
        style={styles.hit}
        onLayout={onLayout}
        {...pan.panHandlers}
        {...a11yProps}
        accessibilityRole="adjustable"
        accessibilityLabel="Playback position"
      >
        <Animated.View style={[styles.track, trackStyle]}>
          <View style={[styles.buffer, { width: `${bufferedF * 100}%` }]} />
          <Animated.View style={[styles.played, playedStyle]} />
          <Stamps skip={skip} duration={d} />
        </Animated.View>
        {/* The preview chip is gated on `dragging` (2 state flips per gesture)
            and on the runtime being known: a drag on an episode whose manifest
            has not parsed yet has no endpoint to name, so there is nothing the
            chip can honestly say. It appears with the exact seek-on-release
            semantics the fibres below already run: a target chosen with a
            finger is knowable by definition. */}
        {dragging && d > 0 ? (
          <ScrubBubble scrub={scrub} trackWidth={trackWidth} duration={d} />
        ) : null}
        {/* Two conditions, and both are "we do not know where we are": an unknown
            runtime means there is no track to place a knob on, and an unresolved
            resume means there is no position to place it at. */}
        {d > 0 && positionKnown ? (
          <>
            {/* Halo first, so the knob draws over it. */}
            <Animated.View pointerEvents="none" style={[styles.halo, haloStyle]} />
            <Animated.View style={[styles.handle, knobStyle]} />
          </>
        ) : null}
      </Animated.View>
      <ClockRow
        position={position}
        scrub={scrub}
        duration={d}
        positionKnown={positionKnown}
        dragging={dragging}
      />
    </View>
  );
});

/**
 * Elapsed / total, isolated into its own component.
 *
 * The only thing on this bar that cannot live on the UI thread, because `Text`
 * content is not an animatable style. Split out so its one render a second
 * touches two `Text` nodes instead of the track, the stamps, the knob and the
 * hit area — the split is the whole reason the playhead could leave React.
 *
 * `Math.round` is not cosmetic: the interval is 500ms and the value is compared
 * against the previous one, so an unrounded float would produce two renders per
 * second for a label that only changes once per second.
 */
const ClockRow = memo(function ClockRow({
  position,
  scrub,
  duration,
  positionKnown,
  dragging,
}: {
  position: SharedValue<number>;
  scrub: SharedValue<number>;
  duration: number;
  positionKnown: boolean;
  /**
   * Whether a drag is live, IN REACT.
   *
   * The label below once asked this of `scrub.value` during render, which is
   * the read Reanimated's strict mode warns about. The parent already keeps
   * a React copy for mounting the preview chip (two flips per gesture), and
   * this is that fact passed down — the only render-time-honest way to know
   * whether a drag is live.
   */
  dragging: boolean;
}) {
  // Lazy init from the shared playhead, so a remount (controls toggled) does
  // not flash `0:00` for a frame before the 500ms interval catches up. The
  // playhead is already on the UI thread; reading it synchronously here is the
  // same read the interval does, just without the 500ms delay.
  const [shown, setShown] = useState(() => Math.round(position.value));
  const [showRemaining, setShowRemaining] = useState(false);

  useEffect(() => {
    const id = setInterval(() => {
      // Shared values are readable from JS synchronously, so this reads the
      // same source the animated styles do rather than a second copy of it.
      const seconds = scrub.value >= 0 ? scrub.value : position.value;
      const next = Math.round(seconds);
      setShown((prev) => (next === prev ? prev : next));
    }, 500);
    return () => clearInterval(id);
  }, [position, scrub]);

  return (
    <View style={styles.clockRow}>
      {/* ⚠️ EITHER HALF CAN BE UNKNOWN, AND THEY ARE NOT THE SAME QUESTION.
       *
       *   - The RUNTIME is 0 until the manifest is parsed. `0:00 / 0:00` does not
       *     read as "loading" — it reads as an episode that is zero seconds long.
       *   - The POSITION is 0 until the stored resume has been applied, which is
       *     after the first frame. `0:00 / 24:13` with the knob at the start
       *     reads as "this episode has not been watched", which is the claim the
       *     whole resume feature exists to contradict.
       *
       * The total is shown as soon as it is known; the elapsed only once the
       * position is. A drag preview overrides both, because a position the
       * viewer just chose with their finger is knowable by definition.
       */}
      <Text style={styles.clock}>
        {/* ⚠️ `scrub.value` IS NOT READ HERE. This used to read
            `scrub.value >= 0` during render — which is exactly the read
            Reanimated's strict mode warns about (a render is not a place a
            shared value is expected to be read), and it regressed in with
            the SDK-58 bundle commit after the 14 Oct fix closed the same
            warning once already. Its two non-null branches were identical
            regardless of the read, so the React-level `dragging` prop
            (the parent's own two-flips-per-gesture state, also what mounts
            the preview chip) carries the "is a drag live" fact instead,
            with identical output and no shared-value read. */}
        {dragging || positionKnown
          ? formatClock(Math.max(0, shown))
          : UNKNOWN_CLOCK}
      </Text>
      {/* THE DOUBLE-ACTION LABEL. YouTube's right-hand clock shows the time
          remaining by default and swaps to the total on a tap. Same freedom
          here: the end of a 24-minute episode is a very different question
          from "36 minutes to go", and the answer costs one toggle press —
          which is why the toggle lives on the LABEL, not in the settings. */}
      <Pressable
        onPress={() => setShowRemaining((prev) => !prev)}
        accessibilityRole="togglebutton"
        accessibilityState={{ checked: showRemaining }}
        accessibilityLabel={showRemaining ? 'Show total duration' : 'Show time remaining'}
        hitSlop={12}
      >
        <Text style={styles.clock}>
          {showRemaining
            ? `-${formatClock(Math.max(0, duration - shown))}`
            : duration > 0 ? formatClock(duration) : UNKNOWN_CLOCK}
        </Text>
      </Pressable>
    </View>
  );
});

/**
 * The preview chip that rides above the thumb during a drag.
 *
 * WHY ONLY ITS TEXT LIVES IN REACT. The chip's position is a shared-value
 * transform exactly like the knob's, and the chip's TEXT is the thing that
 * cannot leave React — Text content is not an animatable style. Isolating both
 * halves here keeps a drag at ZERO renders above this component, same trade the
 * clock row makes at 2 Hz; the chip runs at 10 Hz (BUBBLE_REFRESH_MS), which is
 * the fastest a colour-blind-free time readout needs to flicker to still read
 * as continuous.
 *
 * Mounted only while a drag is live (`dragging && d > 0` above), so nothing
 * runs while the viewer is merely watching: no interval, no worklet.
 */
const ScrubBubble = memo(function ScrubBubble({
  scrub,
  trackWidth,
  duration,
}: {
  scrub: SharedValue<number>;
  trackWidth: SharedValue<number>;
  duration: number;
}) {
  const [label, setLabel] = useState('');

  useEffect(() => {
    const id = setInterval(() => {
      const seconds = scrub.value;
      // A null can't reach here (grant/move skip it), but a release CAN land
      // between two interval ticks — scrub is already -1 — so this returns
      // rather than formatting a sentinel.
      if (seconds < 0) return;
      const next = formatClock(Math.max(0, Math.round(seconds)));
      setLabel((prev) => (next === prev ? prev : next));
    }, BUBBLE_REFRESH_MS);
    return () => clearInterval(id);
  }, [scrub]);

  /**
   * Same translate the knob gets, clamped by the chip's half width.
   *
   * The clamp is what keeps the chip readable over the bar's edges — YouTube's
   * chip stops at the frame too, and clamping the CENTRE (taking the half
   * width as the inward offset) is what reads as "it reached the end and
   * waited" rather than "it slid off the screen".
   */
  const chipStyle = useAnimatedStyle(() => {
    const w = Math.max(0, trackWidth.value);
    const frac =
      scrub.value < 0 || duration <= 0 ? 0 : Math.min(1, Math.max(0, scrub.value / duration));
    const centre = Math.min(
      Math.max(w * frac, BUBBLE_HALF),
      Math.max(BUBBLE_HALF, w - BUBBLE_HALF)
    );
    return { transform: [{ translateX: centre }] };
  });
  // No deps argument (`[duration]` used to be here) — Reanimated ignores deps
  // arrays on native and warns about them in dev; the closure carries `duration`.

  return (
    <View pointerEvents="none" style={styles.bubbleAnchor}>
      <Animated.View style={[styles.bubble, chipStyle]}>
        <Text style={styles.bubbleText}>{label}</Text>
      </Animated.View>
    </View>
  );
});

/**
 * Intro/outro segments painted onto the track.
 *
 * Rendered ABOVE the played fill so a skipped opening leaves a green mark
 * behind rather than being painted over — it is the evidence that the skip
 * happened. Each is taller than the track (6px vs 3px) so that a green opening
 * mark still reads once white has played over it, and so two translucent marks
 * of one colour do not merge into what looks like a single wider segment.
 */
const Stamps = memo(function Stamps({
  skip,
  duration,
}: {
  skip: SkipWindow;
  duration: number;
}) {
  if (duration <= 0) return null;
  const marks: { key: string; start: number; end: number; color: string }[] = [];
  if (skip.intro && skip.intro.end > skip.intro.start) {
    marks.push({ key: 'intro', ...skip.intro, color: OPENING_COLOR });
  }
  if (skip.outro && skip.outro.end > skip.outro.start) {
    marks.push({ key: 'outro', ...skip.outro, color: ENDING_COLOR });
  }
  if (!marks.length) return null;

  return (
    <>
      {marks.map((m) => {
        const left = (m.start / duration) * 100;
        const w = ((m.end - m.start) / duration) * 100;
        return (
          <View
            key={m.key}
            pointerEvents="none"
            style={[
              styles.stamp,
              {
                left: `${left}%`,
                // 0.6% floor so a 3-second skip on a 24-minute episode is still
                // a visible pixel or two rather than rounding away to nothing.
                width: `${Math.max(w, 0.6)}%`,
                backgroundColor: m.color,
              },
            ]}
          />
        );
      })}
    </>
  );
});

const styles = StyleSheet.create({
  wrap: {
    width: '100%',
  },
  // The touch target. Transparent, 28pt tall, sitting over a 3pt line.
  hit: {
    height: HIT_H,
    justifyContent: 'center',
  },
  track: {
    borderRadius: radii.full,
    backgroundColor: 'rgba(255,255,255,0.22)',
  },
  buffer: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    borderRadius: radii.full,
    backgroundColor: 'rgba(255,255,255,0.28)',
  },
  // `width` is supplied by an animated style in points. See the header.
  played: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    borderRadius: radii.full,
    backgroundColor: '#fff',
  },
  stamp: {
    position: 'absolute',
    // Centred on the track at ANY track height: the track thickens to
    // TRACK_H_ACTIVE under the finger, and a `top:` fixed in points would slide
    // the marks off the centre the moment it does. `top: '50%'` +
    // `marginTop: -half` re-derives on the layout change, which is free.
    top: '50%',
    height: TRACK_H + 3,
    borderRadius: 2,
    marginTop: -(TRACK_H + 3) / 2,
  },
  // The soft disc behind the knob, alive only while a finger is down (its
  // opacity is an animated style). Same no-top centring as the handle: the hit
  // area's `justifyContent` carries both to the track's centre line — Yoga
  // centres an absolute child with no vertical offsets by the parent's rule.
  halo: {
    position: 'absolute',
    left: 0,
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: '#fff',
    // Pulled back by half its width, like the handle, so the two TRANSLATES
    // agree on where the fill ends.
    marginLeft: -13,
  },
  // `left` is gone — the knob is pinned at 0 and moved by `translateX`. See
  // the header, rule 1.
  handle: {
    position: 'absolute',
    left: 0,
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: '#fff',
    // The handle straddles the END of the fill, so it is pulled back by half
    // its width rather than offset per-render.
    marginLeft: -6,
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
    elevation: 3,
  },
  // The drag preview chip. Anchored by its CENTRE: the animated style emits
  // the clamped centre X, and the half-width margin undoes the anchor the way
  // the knob's does. It lives above the whole hit area, so the thickening
  // track and the chip can never push each other around.
  bubbleAnchor: {
    position: 'absolute',
    left: -BUBBLE_HALF,
    bottom: HIT_H + 4,
  },
  bubble: {
    width: BUBBLE_HALF * 2,
    height: 24,
    borderRadius: 12,
    backgroundColor: 'rgba(10,10,14,0.88)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  bubbleText: {
    color: '#fff',
    fontSize: 11,
    ...CLOCK_FONT,
    fontFamily: font.mono,
  },
  clockRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 2,
  },
  clock: {
    color: 'rgba(255,255,255,0.85)',
    fontSize: 12,
    lineHeight: 15,
    ...CLOCK_FONT,
    // Montserrat has no compact figures, and a clock that changes width as the
    // seconds tick makes the whole bar look unstable.
    fontFamily: font.mono,
  },
});
