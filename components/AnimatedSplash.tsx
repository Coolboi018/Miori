import { useEffect } from 'react';
import { StyleSheet } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
  runOnJS,
} from 'react-native-reanimated';

/**
 * In-app animated splash.
 *
 * The native splash (expo-splash-screen) is static, so this layer takes over the
 * moment the native one is hidden: it keeps the same logo and background, plays a
 * short scale/fade-in, holds, then fades out and unmounts. No video or Lottie
 * asset is needed — the animation is pure Reanimated on the UI thread.
 */
export function AnimatedSplash({ onFinish }: { onFinish: () => void }) {
  const reduced = useReducedMotion();
  const logoOpacity = useSharedValue(0);
  const logoScale = useSharedValue(0.82);
  const containerOpacity = useSharedValue(1);

  useEffect(() => {
    if (reduced) {
      // Respect "reduce motion": show the logo statically, then leave.
      logoOpacity.value = 1;
      logoScale.value = 1;
      const t = setTimeout(() => {
        containerOpacity.value = withTiming(0, { duration: 200 }, (finished) => {
          if (finished) runOnJS(onFinish)();
        });
      }, 400);
      return () => clearTimeout(t);
    }

    logoOpacity.value = withTiming(1, { duration: 420 });
    logoScale.value = withSpring(1, { damping: 12, stiffness: 120 });

    const hold = setTimeout(() => {
      containerOpacity.value = withTiming(0, { duration: 360 }, (finished) => {
        if (finished) runOnJS(onFinish)();
      });
    }, 1100);

    return () => clearTimeout(hold);
  }, [onFinish, reduced, logoOpacity, logoScale, containerOpacity]);

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
      <Animated.Image
        source={require('../assets/images/splash-icon.png')}
        style={[styles.logo, logoStyle]}
        resizeMode="contain"
      />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: '#000000',
    alignItems: 'center',
    justifyContent: 'center',
  },
  logo: {
    width: 168,
    height: 168,
  },
});