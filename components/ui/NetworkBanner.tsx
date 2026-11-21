// A slim, non-blocking connectivity banner for the whole app.
//
// The player has its own offline pill (it is a landscape, edge-to-edge surface
// where a global banner would sit on the top bar), so `RootLayoutNav` hides
// this one on the watch route rather than stacking two messages.
//
// `pointerEvents="none"` is deliberate: this reports a fact, it is not a
// control. A banner that eats a tap under it would be a second bug on a screen
// the viewer is already trying to use with a broken connection.

import { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { useNetworkStatus } from '@/lib/net/network';
import { font, radii } from '@/lib/ui/tokens';
import { AppIcon } from './AppIcon';

export function NetworkBanner() {
  const net = useNetworkStatus();
  const insets = useSafeAreaInsets();
  const offline = net.kind === 'offline';
  const padding = useMemo(
    () => ({ top: Math.max(insets.top, 8) + 6 }),
    [insets.top]
  );

  if (!offline) return null;

  return (
    <Animated.View
      entering={FadeIn}
      exiting={FadeOut}
      style={[styles.wrap, padding]}
      pointerEvents="none"
    >
      <View style={styles.pill}>
        <AppIcon name="alert" size={13} color="#FFB4A8" strokeWidth={2.2} />
        <Text style={styles.text}>No connection</Text>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
    zIndex: 1000,
    elevation: 1000,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: radii.full,
    backgroundColor: 'rgba(28, 12, 12, 0.92)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255, 107, 107, 0.35)',
  },
  text: {
    color: '#FFB4A8',
    fontFamily: font.semibold,
    fontSize: 12,
  },
});
