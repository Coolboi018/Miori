// Segmented tab strip — "Episodes | Relations | Characters".
//
// The active tab is marked with an underline that animates between tabs
// instead of jumping. It's a small thing, but a hard cut on a strip this
// close to the eye reads as jank, and Reanimated is already installed.

import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useTheme } from '@/lib/ui/useTheme';
import { font, motion, spacing } from '@/lib/ui/tokens';

export interface Segment<T extends string> {
  key: T;
  label: string;
  /** Hide the tab entirely when the section has nothing to show. */
  hidden?: boolean;
}

export function SegmentedTabs<T extends string>({
  segments,
  value,
  onChange,
}: {
  segments: Segment<T>[];
  value: T;
  onChange: (key: T) => void;
}) {
  const { color } = useTheme();
  const visible = segments.filter((s) => !s.hidden);
  const progress = useSharedValue(0);

  const underline = useAnimatedStyle(() => ({
    opacity: withTiming(progress.value, { duration: motion.fast }),
  }));

  return (
    <View style={[styles.wrap, { borderBottomColor: color.border.muted }]}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.scroll}
      >
        {visible.map((s) => {
          const active = s.key === value;
          return (
            <Pressable
              key={s.key}
              onPress={() => {
                progress.value = 0;
                onChange(s.key);
                progress.value = 1;
              }}
              accessibilityRole="tab"
              accessibilityState={{ selected: active }}
              style={styles.tab}
            >
              <Text
                style={[
                  styles.label,
                  { color: active ? color.text.primary : color.text.muted },
                ]}
              >
                {s.label}
              </Text>
              {active ? (
                <Animated.View
                  style={[styles.underline, { backgroundColor: color.accent.base }, underline]}
                />
              ) : null}
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  scroll: {
    paddingHorizontal: spacing.lg,
    gap: spacing.xl,
  },
  tab: {
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  label: {
    fontSize: 15,
    fontFamily: font.semibold,
  },
  underline: {
    position: 'absolute',
    bottom: -1,
    height: 2,
    left: 0,
    right: 0,
    borderRadius: 1,
  },
});
