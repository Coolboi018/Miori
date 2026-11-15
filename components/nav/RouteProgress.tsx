// The thin bar at the top of the screen that says "a screen is on its way".
//
// WHY THIS EXISTS. `lib/nav/pushOnce.ts` drops duplicate taps so the same anime
// cannot stack twice. On a low-end phone the reason those duplicate taps happen
// is a stalled JS thread — and a dropped tap leaves NO visible change: the press
// wash under the finger, then nothing. That reads as a frozen app, so the user
// taps again, harder, which is the exact behaviour the guard is absorbing. This
// component closes the loop: the tap is acknowledged even when it is refused.
//
// WHY A TOP BAR AND NOT A CENTRED SPINNER. See `lib/nav/pending.ts` for the
// long version — short one: a spinner with a scrim covers the content on a
// screen that may not be changing at all, and on a warm cache navigation lands
// in ~200ms, so it flashes. A hairline at the edge is what browsers, YouTube
// and Netflix-adjacent apps use for exactly this: motion where the eye already
// looks for "page is coming", content untouched and still usable.
//
// ⚠️ THIS ANIMATION MUST RUN ON THE UI THREAD, WHICH IS THE WHOLE POINT.
// A JS-driven indicator — `Animated` with `useNativeDriver: false`, a
// `setInterval` advancing state, an `ActivityIndicator` swapped by a JS timer —
// stalls at the exact moment the app needs to prove it is alive, because the
// stall IS the JS thread. Reanimated's shared value + `translateX` is a
// compositor transform: it keeps moving while the JS thread is committing a
// 600-view detail page. `scripts/check-nav-dedupe.ts` pins that this file uses a
// transform and not a JS loop.
//
// NO MEASURING, SAME TRICK AS `Shimmer`. The sliver is 28% of the track's width
// and parked at `left: 0`; `translateX` percentages are relative to the
// ELEMENT's own width, so −100% is fully off the left edge and +400% is past the
// right one for any screen width. No `onLayout`, no per-device constant.
//
// REDUCE MOTION is honoured: the bar still appears (it is information, not
// decoration) but parks as a static sliver instead of sweeping.

import { useEffect, useSyncExternalStore } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { usePathname } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/lib/ui/useTheme';
import {
  isNavPending,
  settleNavPending,
  subscribeNavPending,
} from '@/lib/nav/pending';

/** One crossing. Fast enough to read as work, slow enough to read as motion. */
const SWEEP_MS = 950;

/** How much of the track the sliver takes, in percent of the track's width. */
const SLIVER_PCT = 28;

/** Height of the hairline. */
const BAR_HEIGHT = 3;

export function RouteProgress() {
  const { color } = useTheme();
  const insets = useSafeAreaInsets();
  const reduced = useReducedMotion();
  const pending = useSyncExternalStore(subscribeNavPending, isNavPending, isNavPending);
  const pathname = usePathname();

  const run = useSharedValue(0);
  const fade = useSharedValue(0);

  /**
   * STOP WHEN THE SCREEN LANDS.
   *
   * `usePathname` changes on the same React commit that mounts the destination,
   * which is the earliest honest moment to say "it arrived" — earlier than the
   * native transition ending, later than the push being dispatched. Tab switches
   * move the pathname too, but there is nothing pending then, so `settle` is a
   * no-op.
   */
  useEffect(() => {
    settleNavPending();
  }, [pathname]);

  /**
   * SHOW / HIDE. The loop only exists while pending — an idle app runs no
   * animation at all, and unmounting the effect cancels it (see the cleanup).
   */
  useEffect(() => {
    if (!pending) {
      cancelAnimation(run);
      run.value = 0;
      fade.value = withTiming(0, { duration: 160 });
      return;
    }
    fade.value = withTiming(1, { duration: 110 });
    if (reduced) {
      // Static, parked mid-track: "something is happening" without travel.
      run.value = 0.45;
      return;
    }
    run.value = 0;
    run.value = withRepeat(
      withTiming(1, { duration: SWEEP_MS, easing: Easing.inOut(Easing.ease) }),
      -1,
      false
    );
    return () => {
      cancelAnimation(run);
    };
  }, [pending, reduced, run, fade]);

  const bar = useAnimatedStyle(() => ({
    opacity: fade.value,
    // −100% = off the left edge, +400% = past the right one, relative to the
    // sliver's own width. See the note at the top: nothing here is measured.
    transform: [{ translateX: `${-100 + run.value * 400}%` }],
  }));

  return (
    <View
      pointerEvents="none"
      style={[styles.track, { top: insets.top }]}
    >
      <Animated.View
        style={[
          styles.bar,
          {
            width: `${SLIVER_PCT}%`,
            backgroundColor: color.accent.base,
          },
          bar,
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: BAR_HEIGHT,
    // Above the screen, below nothing that matters: sheets and modals are
    // separate hosts with their own layers, and the bar is only ever up while
    // a route is committing.
    zIndex: 1000,
    overflow: 'hidden',
  },
  bar: {
    height: BAR_HEIGHT,
    borderRadius: BAR_HEIGHT / 2,
  },
});
