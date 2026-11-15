// In-app animated splash — the hand-off from the static native splash.
//
// ⚠️ THE LOGO IS INSIDE A PLAIN `Animated.View`, NOT AN ANIMATED IMAGE.
//
// The first attempt wrapped `expo-image` in `Animated.createAnimatedComponent`.
// Reanimated drives a composite component's animated style through props the
// native host never receives in this setup, so the shared values changed, the
// style computed… and nothing moved: the splash sat there as a still picture
// ("did you even animate it?"). A plain `Animated.View` is a host component —
// transforms and opacity land on the UI thread every time, in Expo Go and in a
// release APK. The image itself never needs to animate, so it does not.
//
// ⚠️ AND THE TIMELINE DOES NOT START UNTIL THE LOGO CAN BE PAINTED.
//
// Three different ways this splash has been wrong, and the fixes are separate:
//
//   1. THE DECODE. The logo is a bundled bitmap decoded asynchronously, so a
//      timeline started on mount can finish before the first frame containing
//      the logo is painted — the user sees the end state immediately.
//      `markDecoded` waits for the image's own `onLoad` (with
//      `SPLASH.decodeFallbackMs` as a ceiling, so a hung decode cannot mute the
//      splash).
//
//   2. REDUCE MOTION. `useReducedMotion()` is true on any device whose animator
//      duration scale is 0 — which is battery saver, not just the accessibility
//      toggle — and this path used to hold the logo at FULL opacity and time it
//      to 1. An animation from 1 to 1 is a still frame. It now fades in from
//      `SPLASH.fromOpacity` like the normal path and drops only the zoom, which
//      is the part reduce-motion is actually about.
//
//   3. ✅ THE OVERLAY IS MOUNTED ON THE FIRST FRAME, BUT IT DOES NOT MOVE UNTIL
//      THE NATIVE SPLASH IS GONE. These are two different things and the code
//      used to conflate them: the overlay was mounted only AFTER the hand-off,
//      to keep its entrance from playing behind the native splash — which meant
//      the React tree was on screen WITHOUT a cover for that whole window, and
//      the app's first frame was therefore the home screen. That is the
//      "home, then the splash animation, then home" sequence (15 Nov report):
//      the native splash faded to the live app, and the overlay arrived on a
//      later JS timer, on top of it.
//
//      Now the overlay is up from the first frame and `handoffDone` (owned by
//      the root layout) gates only the TIMELINE. The native splash fades to the
//      overlay's black rather than to the app, and `onEntered` — fired once the
//      entrance has finished — is what releases the app to mount underneath.
//      The app's first render therefore lands on a still frame (the hold),
//      instead of competing with the entrance.
//
// The rest is the low-end work from 14 Nov, kept:
//   - `expo-image` instead of `Animated.Image` (RN's decoder takes the full
//     resolution and adds an implicit ~300ms Android fade on top of ours);
//   - ONE cubic timing curve per property, no per-frame spring solver;
//   - a timeline under a second (see `lib/ui/splash.ts`), not the old ~1.9s;
//   - a watchdog in `app/_layout.tsx` so a delayed completion callback can
//     never leave the overlay covering the app.

import { useCallback, useEffect, useState } from 'react';
import { StyleSheet } from 'react-native';
import { Image } from 'expo-image';
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { SPLASH } from '@/lib/ui/splash';

export function AnimatedSplash({
  handoffDone,
  onEntered,
  onFinish,
}: {
  /**
   * True once the native splash's exit fade has finished — see `handoffMs()`.
   * Gates the TIMELINE only; the overlay itself is already covering the app.
   */
  handoffDone: boolean;
  /**
   * Fired when the entrance has finished, so the app underneath may mount. Any
   * jank from that first render then lands on the still hold rather than on a
   * moving frame.
   */
  onEntered: () => void;
  onFinish: () => void;
}) {
  const reduced = useReducedMotion();
  // Both paths start invisible — see (2) above; only the scale differs, and
  // reduce motion keeps it at 1 so there is no travel at all.
  // The explicit `<number>` is load-bearing: `SPLASH` is `as const`, so
  // `fromOpacity` is the LITERAL type `0` and `SharedValue<0>` cannot be timed
  // to 1.
  const logoOpacity = useSharedValue<number>(SPLASH.fromOpacity);
  const logoScale = useSharedValue(reduced ? 1 : SPLASH.fromScale);
  const containerOpacity = useSharedValue(1);

  /**
   * Armed by the logo's decode, or by the fallback if the decode never reports.
   * A state flag rather than a ref: the timeline below has to run on a commit,
   * and it is the effect's own dependencies that start it exactly once.
   */
  const [decoded, setDecoded] = useState(false);
  const markDecoded = useCallback(() => setDecoded(true), []);

  useEffect(() => {
    const fallback = setTimeout(markDecoded, SPLASH.decodeFallbackMs);
    return () => clearTimeout(fallback);
  }, [markDecoded]);

  useEffect(() => {
    if (!handoffDone || !decoded) return;

    if (reduced) {
      // No zoom (that is the motion being asked for less of) but a real
      // cross-fade from black, because a completely still screen is
      // indistinguishable from a frozen one.
      logoOpacity.value = withTiming(1, {
        duration: SPLASH.reducedFadeMs,
        easing: Easing.out(Easing.quad),
      });
    } else {
      logoOpacity.value = withTiming(1, {
        duration: SPLASH.fadeMs,
        easing: Easing.out(Easing.quad),
      });
      // `back` gives a couple of percent of overshoot — the logo arrives with a
      // settle instead of stopping dead. One curve, not a solver.
      logoScale.value = withTiming(1, {
        duration: SPLASH.enterMs,
        easing: Easing.out(Easing.back(1.1)),
      });
    }

    // THE APP IS RELEASED AS THE ENTRANCE ENDS, not when the overlay goes: the
    // hold that follows is a still frame, so the app's first render costs
    // nothing the user can see, and there is a full exit fade for it to land in.
    const enterMs = reduced ? SPLASH.reducedFadeMs : SPLASH.enterMs;
    const entered = setTimeout(onEntered, enterMs);

    const hold = reduced ? SPLASH.reducedHoldMs : SPLASH.holdMs;
    const exitMs = reduced ? SPLASH.reducedExitMs : SPLASH.exitMs;
    const timer = setTimeout(() => {
      containerOpacity.value = withTiming(0, { duration: exitMs }, (finished) => {
        if (finished) runOnJS(onFinish)();
      });
    }, hold);
    return () => {
      clearTimeout(entered);
      clearTimeout(timer);
    };
  }, [handoffDone, decoded, reduced, logoOpacity, logoScale, containerOpacity, onEntered, onFinish]);

  const logoStyle = useAnimatedStyle(() => ({
    opacity: logoOpacity.value,
    transform: [{ scale: logoScale.value }],
  }));

  const containerStyle = useAnimatedStyle(() => ({
    opacity: containerOpacity.value,
  }));

  return (
    <Animated.View
      style={[StyleSheet.absoluteFill, styles.container, containerStyle]}
      pointerEvents="auto"
      accessibilityRole="image"
      accessibilityLabel="Miori"
    >
      <Animated.View style={[styles.logoBox, logoStyle]}>
        <Image
          source={require('../assets/images/splash-icon.png')}
          style={styles.logo}
          contentFit="contain"
          cachePolicy="memory-disk"
          priority="high"
          // expo-image's own cross-fade would fight the opacity animation above.
          transition={0}
          // The timeline's real trigger. `onError` arms it too: a logo that
          // cannot be decoded must not take the whole splash down with it.
          onLoad={markDecoded}
          onError={markDecoded}
        />
      </Animated.View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    // Matches `expo-splash-screen.backgroundColor` in app.json — any difference
    // between the two is a visible flash at hand-off.
    backgroundColor: '#000000',
    alignItems: 'center',
    justifyContent: 'center',
  },
  logoBox: {
    // Matched by the native splash's `imageWidth`; the check pins the two.
    width: 168,
    height: 168,
    alignItems: 'center',
    justifyContent: 'center',
  },
  logo: { width: '100%', height: '100%' },
});
