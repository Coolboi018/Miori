// The skeleton PLATE, with its light sweep.
//
// Every skeleton in the app is built from these. A skeleton's job is to hold
// the real layout open while data loads; the sweep's job is to say "this is
// loading, not broken" without a spinner.
//
// WHY A TRANSLATE AND NOT A PULSE. An opacity pulse re-draws every plate every
// frame. A translate sweep does not: moving one child horizontally is a
// compositor transform, which runs on the UI thread (Reanimated) and never
// touches the JS thread — the thread that is busy parsing the very response
// this skeleton is standing in for. A skeleton that animates the wrong property
// costs the machine frames at exactly the moment it has none to spare.
//
// THE SWEEP IS PERCENTAGE-TRAVELLED, AND THAT IS WHY THERE IS NO MEASURING.
// The band is the plate's own width, parked at `left: -100%` — fully off the
// left edge. translateX is a percentage of the ELEMENT's own width, so a single
// range of −100% → +200% carries it from fully off-left to fully off-right for
// ANY plate size: a 6px line and a full-screen banner sweep identically, with
// no onLayout round-trip and no per-plate worklet state.
//
// ONE CLOCK FOR THE WHOLE SKELETON, NOT ONE PER PLATE. This is the part that
// makes the sweep look like LIGHT rather than like a row of blinking boxes, and
// it is also cheaper. `ShimmerSweep` runs a single shared value from 0 to
// `1 + span`; each `Shimmer` then works out its own slice of that timeline from
// its `at` offset. Two consequences, both wanted:
//
//   - A WAVE. Plates further along the row start later, so the band travels
//     left to right down a rail instead of every plate flaring on the same
//     frame. Eighty plates in unison read as a CRT malfunction; eighty in a
//     wave read as a screen settling.
//   - ONE animation driver. A per-plate `withRepeat` would mean eighty
//     unbounded animations to start, hold and cancel.
//
// THE CLOCK IS LINEAR AND THE EASE IS PER-PLATE, which sounds backwards and is
// not. A curve on the shared clock would bend every plate's crossing the same
// way, and the staggering would stop reading as travel. So the clock is just a
// position on a timeline, and each plate decelerates its own band (see DECEL).
//
// REDUCE MOTION is honoured by `useReducedMotion`, so a user with the OS setting
// gets static plates and — importantly — no animation running at all. Parking
// the clock past the last window is not an optimisation here, it is the whole
// behaviour: a zero-duration animation inside `withRepeat(-1)` re-fires forever,
// which is an infinite loop of frames changing nothing.
//
// LIFETIME: the repeat is unbounded, and that is correct — the skeleton only
// exists while `LoadingBoundary` says loading, and unmounting it cancels the
// animation with it. Nothing to clean up by hand.
//
// COST, STATED PLAINLY. A plate is three views: the clipping box, the moving
// band, and the gradient. A home-sized skeleton is therefore ~80 plates / ~240
// views, which is more than the ~150-view screen it stands in for. That is the
// price of the sweep and it is paid only while `LoadingBoundary` says loading —
// with the persisted cache that is a genuinely cold first launch, once. The
// alternative is a skeleton with no motion in it, which is the thing this
// component exists to fix.

import { createContext, memo, useContext, useEffect, type ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withRepeat,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';

/** One sweep across the plate, then a beat before the next. */
const SWEEP_MS = 1050;
const PAUSE_MS = 420;

/**
 * How many of the plate's own widths the band travels per pass: one to reach it,
 * one to cross it, one to clear it. So `eased * TRAVEL - 1` runs from −1 (fully
 * off the left) to +2 (fully off the right).
 */
const TRAVEL = 3;

/**
 * The band's own deceleration, `1 - (1 - t)^k` for k > 1.
 *
 * A highlight leaves and stops; it does not crawl in and out. 2.4 is enough of
 * a curve to read as light moving rather than as a div moving.
 */
const DECEL = 2.4;

/**
 * The default wave, in clock units. One unit is one plate's crossing, so a span
 * of 1 means the last plate in the wave starts as the first one finishes.
 */
export const SWEEP_SPAN = 1;

/**
 * Where plate `i` of `count` sits in the wave, in clock units.
 *
 * Evenly spaced, so a rail of five and a grid of nine both read as one
 * travelling band rather than as N things that happen to be animating. `base`
 * shifts a whole group — used to make each rail of a page trail the one above
 * it, so the wave walks down the screen instead of restarting per row.
 */
export function sweepAt(
  i: number,
  count: number,
  span: number = SWEEP_SPAN,
  base = 0
): number {
  if (count <= 1) return base;
  return base + (i / (count - 1)) * span;
}

/**
 * The shared clock. `null` outside a `ShimmerSweep`, which is the signal for a
 * `Shimmer` to run a clock of its own — that is why `Shimmer` still works
 * standalone and why nothing has to be threaded through a skeleton that only
 * wants one plate.
 */
const SweepContext = createContext<SharedValue<number> | null>(null);

/**
 * Drives every `Shimmer` beneath it from one animation.
 *
 * `span` is how far the wave trails behind its leading plate, in clock units,
 * and it is ALSO the length of the cycle: the clock runs to `1 + span`, so a
 * plate at `span` finishes exactly as the loop restarts. Put the widest
 * `sweepAt` you use in your skeleton here, or the tail of the wave gets cut off
 * — the plates at the end would still be mid-sweep when everything jumped back
 * to zero. (They would not show it: the band is clamped fully off-screen outside
 * its window, so the loop is invisible either way. It just means the tail never
 * arrives.)
 */
export function ShimmerSweep({
  children,
  span = SWEEP_SPAN,
}: {
  children: ReactNode;
  span?: number;
}) {
  const clock = useSharedValue(0);
  const reduced = useReducedMotion();

  useEffect(() => {
    if (reduced) {
      clock.value = 1 + span;
      return;
    }
    clock.value = withDelay(
      PAUSE_MS,
      withRepeat(
        withTiming(1 + span, {
          duration: SWEEP_MS * (1 + span),
          // See the note at the top: linear on purpose.
          easing: Easing.linear,
        }),
        -1
      )
    );
  }, [clock, reduced, span]);

  return <SweepContext.Provider value={clock}>{children}</SweepContext.Provider>;
}

/**
 * The band's colour. A fixed low-alpha white rather than a themed value: it
 * must read on every plate colour (bg.elevated, bg.surface, the banner's
 * near-black) and white at 9% does, in both themes, without the skeleton
 * having to know which plate it is standing on.
 */
const BAND = 'rgba(255,255,255,0.09)';

export const Shimmer = memo(function Shimmer({
  plate,
  style,
  radius = 6,
  at = 0,
}: {
  /** The plate colour — `color.bg.elevated` or `color.bg.surface` from the theme. */
  plate: string;
  /** Size and position. Width/height/flex/margins; the plate fills whatever it is given. */
  style?: StyleProp<ViewStyle>;
  /** Corner radius. Pass `radii.full` for circles and pills. */
  radius?: number;
  /**
   * Where this plate sits in its skeleton's wave — see `sweepAt`. Ignored
   * outside a `ShimmerSweep`, where the plate runs a clock of its own.
   */
  at?: number;
}) {
  const shared = useContext(SweepContext);
  const own = useSharedValue(0);
  const reduced = useReducedMotion();

  // The STANDALONE clock, for a plate that is not inside a Sweep. Started and
  // abandoned with the component, which is what cancels it.
  useEffect(() => {
    if (shared) return;
    if (reduced) {
      own.value = 1;
      return;
    }
    own.value = withDelay(
      PAUSE_MS,
      withRepeat(withTiming(1, { duration: SWEEP_MS, easing: Easing.linear }), -1)
    );
  }, [own, reduced, shared]);

  const sweep = useAnimatedStyle(() => {
    // Where this plate is inside ITS OWN crossing, 0 → 1. Under a shared clock
    // that is the clock minus the plate's offset in the wave; standalone it is
    // the plate's own clock. Both clamp, so a plate outside its window holds the
    // band fully off-screen instead of freezing it mid-plate.
    const t = shared ? Math.min(1, Math.max(0, shared.value - at)) : own.value;
    const eased = 1 - Math.pow(1 - t, DECEL);
    return { transform: [{ translateX: `${(eased * TRAVEL - 1) * 100}%` }] };
  });

  return (
    <View style={[styles.plate, { backgroundColor: plate, borderRadius: radius }, style]}>
      <Animated.View pointerEvents="none" style={[styles.band, sweep]}>
        <LinearGradient
          colors={['transparent', BAND, 'transparent']}
          start={{ x: 0, y: 0.5 }}
          end={{ x: 1, y: 0.5 }}
          style={StyleSheet.absoluteFill}
        />
      </Animated.View>
    </View>
  );
});

const styles = StyleSheet.create({
  plate: { overflow: 'hidden' },
  // The plate's own width, parked fully off the LEFT edge. The percentage
  // transform above does the rest — see the note at the top.
  band: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: '-100%',
    width: '100%',
  },
});
