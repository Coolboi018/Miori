// The double-tap seek feedback — a ripple that fades, and nothing else.
//
// ⚠️ WHY THIS IS TRANSIENT AND NOT A BUTTON. Seeking by a fixed step is a
// GESTURE on the video (YouTube: double-tap the left or right half), not a
// control that lives in the control chrome. Putting ±10s in `PlayerControls`
// would be wrong twice over — it would take two slots in an already-wide
// transport row, and, worse, those controls auto-hide after 3s, so a seek
// button that disappears with the chrome is a button nobody can find. The
// gesture lives on the video surface; this is the only thing it puts on
// screen, and it is gone in half a second.
//
// WHY IT STILL EXISTS AT ALL, rather than seeking silently. A 10s jump is
// small enough to be missed and fast enough to look like nothing happened —
// the playhead moves while the user's thumb is still down. The ripple is the
// receipt: it lands at the finger, so the eye goes there instead of hunting
// along the timeline for a 10s shift it did not ask for.
//
// Expo-Go-safe: Reanimated only, already a project dependency. Mounted with a
// changing `key` per tap so the animation restarts from 0 every time — the
// alternative (a `runOnJS` reset of a shared value) is a frame of stale ripple
// on the second tap.

import { memo, useEffect } from 'react';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { StyleSheet, Text, View } from 'react-native';
import { AppIcon } from '@/components/ui/AppIcon';
import { font } from '@/lib/ui/tokens';

/**
 * How far a double-tap seeks, in seconds. YouTube's number — the whole point of
 * copying the gesture is inheriting the muscle memory that goes with it.
 */
export const SKIP_SECONDS = 10;

/**
 * Ripple lifetime. Long enough to read, short enough not to be in the way.
 * Exported so the screen can unmount the node when it expires — see
 * `SeekRipple`'s use in `app/watch/[id]/[ep].tsx`. Kept a single constant
 * because a node cleared on a timer longer than the animation shows a frozen
 * frame at the end, and shorter cuts the bloom off mid-bloom.
 */
export const RIPPLE_MS = 520;
/** How far past full size it blooms before it is gone. */
const BLOOM = 1.6;

export const SeekRipple = memo(function SeekRipple({
  dir,
  x,
  y,
}: {
  /** -1 = backwards, +1 = forwards. */
  dir: -1 | 1;
  /** Tap point within the video, so the ripple lands under the finger. */
  x: number;
  y: number;
}) {
  const p = useSharedValue(0);

  useEffect(() => {
    p.value = 0;
    p.value = withTiming(1, { duration: RIPPLE_MS, easing: Easing.out(Easing.quad) });
  }, [p, dir, x, y]);

  const style = useAnimatedStyle(() => ({
    opacity: 1 - p.value,
    // Starts well under full size and blooms past it: a circle that appears at
    // full size and merely fades reads as a button, which is the thing this is
    // replacing.
    transform: [{ scale: 0.45 + p.value * BLOOM }],
  }));

  return (
    // pointerEvents none is what keeps this purely a receipt — it must never
    // eat the next tap, and the parent gesture surface owns the whole video.
    <View style={[styles.box, { left: x - R, top: y - R }]} pointerEvents="none">
      <Animated.View style={[styles.ripple, style]}>
        <View style={styles.inner}>
          <AppIcon
            name={dir < 0 ? 'rewind' : 'fastForward'}
            size={30}
            color="#fff"
            strokeWidth={2}
          />
          {/* The numeral, not just the arrow: a bare circular arrow already
              means "restart" everywhere else in this app (the explore filter's
              reset), and YouTube's own glyph carries the number for a reason. */}
          <Text style={styles.num}>{SKIP_SECONDS}</Text>
        </View>
      </Animated.View>
    </View>
  );
});

const R = 56;

const styles = StyleSheet.create({
  box: {
    position: 'absolute',
    width: R * 2,
    height: R * 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ripple: {
    ...StyleSheet.absoluteFill,
    borderRadius: R,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  // The plate is what the numeral is centred against. `overflow: hidden` would
  // clip nothing here, but keeping the arrow and the number in one 30pt box
  // means they scale as a unit instead of drifting apart under bloom.
  inner: {
    width: 30,
    height: 30,
    alignItems: 'center',
    justifyContent: 'center',
  },
  num: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    textAlign: 'center',
    color: '#fff',
    fontFamily: font.bold,
    fontSize: 10,
    lineHeight: 30,
    includeFontPadding: false,
    fontVariant: ['tabular-nums'],
  },
});