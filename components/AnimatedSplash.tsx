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
// The rest is the low-end work from 14 Nov, kept:
//   - `expo-image` instead of `Animated.Image` (RN's decoder takes the full
//     resolution and adds an implicit ~300ms Android fade on top of ours);
//   - ONE cubic timing curve per property, no per-frame spring solver;
//   - a timeline under a second (see `lib/ui/splash.ts`), not the old ~1.9s;
//   - a watchdog in `app/_layout.tsx` so a delayed completion callback can
//     never leave the overlay covering the app.

import { useEffect } from 'react';
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

export function AnimatedSplash({ onFinish }: { onFinish: () => void }) {
  const reduced = useReducedMotion();
  const logoOpacity = useSharedValue(reduced ? 1 : SPLASH.fromOpacity);
  const logoScale = useSharedValue(reduced ? 1 : SPLASH.fromScale);
  const containerOpacity = useSharedValue(1);

  useEffect(() => {
    if (reduced) {
      // Reduce motion: no zoom, but still a short cross-fade — a completely
      // still screen is indistinguishable from a frozen one.
      logoOpacity.value = withTiming(1, { duration: SPLASH.reducedFadeMs });
      logoScale.value = 1;
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

    const hold = reduced ? SPLASH.reducedHoldMs : SPLASH.holdMs;
    const exitMs = reduced ? SPLASH.reducedExitMs : SPLASH.exitMs;
    const timer = setTimeout(() => {
      containerOpacity.value = withTiming(0, { duration: exitMs }, (finished) => {
        if (finished) runOnJS(onFinish)();
      });
    }, hold);
    return () => clearTimeout(timer);
  }, [reduced, logoOpacity, logoScale, containerOpacity, onFinish]);

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
