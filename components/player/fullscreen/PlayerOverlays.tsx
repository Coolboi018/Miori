// Screen-level overlays that sit outside the chrome: the lock screen's unlock
// affordance, the scrim under the bars, and the floating skip button.
//
// Split out of `PlayerScreen.tsx` (24 Nov). Each component is prop-driven and
// reads nothing from the screen's state directly, which is why they can leave:
// the caller still owns every decision, these only draw it. The reasoning for
// each one (why the button is screen-level, why the scrim is conditional) moved
// with the code rather than staying behind in the screen.

import { memo } from 'react';
import { Pressable, Text, View } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import type { EdgeInsets } from 'react-native-safe-area-context';

import { AppIcon } from '@/components/ui/AppIcon';
import { useChromeVisible } from '@/lib/player/chromeVisibility';

import type { MenuId } from './Chrome';
import { ABOVE_BAR_GAP, SKIP_FORWARD_S } from './playerLayout';
import { styles } from './playerStyles';

/**
 * The lock screen's only affordance: a small unlock button.
 *
 * Deliberately centred-left and small rather than a full-width bar. The lock
 * exists so a phone in a bag does not pocket-seek, and the way out has to be
 * discoverable without being easy to hit by accident — a thumb across the frame
 * should never unlock it.
 */
export function UnlockAffordance({ onUnlock, insets }: { onUnlock: () => void; insets: EdgeInsets }) {
  return (
    <View
      style={[styles.unlockBox, { paddingLeft: insets.left + 28 }]}
      pointerEvents="box-none"
    >
      <Pressable
        onPress={onUnlock}
        accessibilityRole="button"
        accessibilityLabel="Unlock controls"
        style={({ pressed }) => [styles.unlockBtn, pressed ? styles.playPressed : null]}
      >
        <AppIcon name="unlock" size={24} color="#fff" strokeWidth={2} />
      </Pressable>
    </View>
  );
}

export const Scrim = memo(function Scrim({
  locked,
  panelOpen,
  menu,
  scrubActive,
}: {
  locked: boolean;
  panelOpen: boolean;
  menu: MenuId;
  scrubActive: boolean;
}) {
  const visible = useChromeVisible();
  const topUp = visible && !locked && !panelOpen && !menu;
  const bottomBarUp = (visible && !locked && !panelOpen) || scrubActive;
  if (!(topUp || bottomBarUp)) return null;
  return <View style={styles.scrim} pointerEvents="none" />;
});

export const SkipButtonHost = memo(function SkipButtonHost({
  activeSkip,
  locked,
  panelOpen,
  scrubActive,
  barHeight,
  switching,
  insets,
  seekWithGrace,
  player,
  durationRef,
  positionRef,
}: {
  activeSkip: { kind: 'opening' | 'ending'; start: number; end: number } | null;
  locked: boolean;
  panelOpen: boolean;
  scrubActive: boolean;
  barHeight: number;
  /** The episode-transition gate — a skip here would seek the item being left. */
  switching: boolean;
  insets: EdgeInsets;
  seekWithGrace: (apply: () => void, target?: number) => void;
  player: any;
  durationRef: any;
  positionRef: any;
}) {
  const visible = useChromeVisible();
  const bottomBarUp = (visible && !locked && !panelOpen) || scrubActive;

  if (locked || switching) return null;

  if (activeSkip) {
    return (
      <View
        pointerEvents="box-none"
        style={[styles.skipFloat, { right: insets.right + 12, bottom: barHeight + ABOVE_BAR_GAP }]}
      >
        <Animated.View entering={FadeIn} exiting={FadeOut}>
          <Pressable
            onPress={() => {
              const skipTarget = Math.ceil(activeSkip.end);
              seekWithGrace(() => {
                void player.seekBy(skipTarget - player.currentTime);
              }, skipTarget);
            }}
            accessibilityRole="button"
            accessibilityLabel={activeSkip.kind === 'opening' ? 'Skip opening' : 'Skip ending'}
            style={({ pressed }) => [styles.skipButton, pressed ? styles.skipPressed : null]}
          >
            <AppIcon name="skipForward" size={16} color="#fff" strokeWidth={2.5} />
            <Text style={styles.skipLabel}>
              {activeSkip.kind === 'opening' ? 'Skip opening' : 'Skip ending'}
            </Text>
          </Pressable>
        </Animated.View>
      </View>
    );
  }

  if (bottomBarUp && !panelOpen) {
    return (
      <View
        pointerEvents="box-none"
        style={[styles.skipFloat, { right: insets.right + 12, bottom: barHeight + ABOVE_BAR_GAP }]}
      >
        <Animated.View entering={FadeIn} exiting={FadeOut}>
          <Pressable
            onPress={() => {
              const dur = durationRef.current;
              const target = Math.floor(positionRef.current) + SKIP_FORWARD_S;
              const clamped = dur > 0 ? Math.min(target, Math.max(0, dur - 0.5)) : target;
              seekWithGrace(() => {
                void player.seekBy(clamped - player.currentTime);
              }, clamped);
            }}
            accessibilityRole="button"
            accessibilityLabel={`Skip forward ${SKIP_FORWARD_S} seconds`}
            style={({ pressed }) => [styles.skipButton, styles.skipForward, pressed ? styles.skipPressed : null]}
          >
            <AppIcon name="skipForward" size={16} color="#fff" strokeWidth={2.5} />
            <Text style={styles.skipLabel}>{`+${SKIP_FORWARD_S}s`}</Text>
          </Pressable>
        </Animated.View>
      </View>
    );
  }

  return null;
});
