// The pill row — two of them on the explore screen, one behaviour each.
//
//   PillSelector  ONE choice. The active pill is a sliding solid thumb behind
//                 the label (icon-only, 28px, measured geometry + spring).
//                 Used for the browse layout switch: Grid / Large / Rows.
//
//   PillToggle    ZERO OR MORE. Each picked pill fills itself; there is no
//                 thumb because a thumb can only mark one. Used for genres.
//
// WHY MEASURED GEOMETRY for the thumb: pills have different natural widths
// (a glyph-only pill and a labelled one are nothing alike), and the row is a
// horizontal ScrollView. Every pill reports its `x` and `width` through
// `onLayout` — which is relative to the scroll CONTENT, so the coordinates
// travel with the row and stay correct while it scrolls. The thumb is
// absolutely positioned inside that same content, so it lines up by
// construction. Same technique as the details page's tab strip, and the same
// spring constants, so the motion is the app's, not a one-off.
//
// JUMP on first layout, SPRING after: sliding from x=0 on mount looks like a
// glitch when the first pill is not the one selected.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import { useTheme } from '@/lib/ui/useTheme';
import { font, radii, spacing } from '@/lib/ui/tokens';
import { RoundedPressable } from '@/components/ui/RoundedPressable';
import { AppIcon, type AppIconName } from './AppIcon';

export interface PillItem<T> {
  key: T;
  /** Visible text. Empty for an icon-only pill. */
  label: string;
  icon?: AppIconName;
  /**
   * Spoken name. Required whenever `label` is empty — an icon-only control
   * with no accessible name is unusable with a screen reader, and the
   * accessibilityLabel cannot be derived from nothing.
   */
  a11yLabel?: string;
}

/** Same constants as the details-page tab strip and the segmented tab bar. */
const SPRING = { damping: 22, stiffness: 260, mass: 0.9 };

interface Metrics {
  x: number;
  width: number;
}

export function PillSelector<T extends string>({
  items,
  value,
  onChange,
  height = 28,
  accessibilityPrefix,
}: {
  items: readonly PillItem<T>[];
  value: T;
  onChange: (key: T) => void;
  /** Must match the SectionHeader's 28px row so the header rhythm survives. */
  height?: number;
  accessibilityPrefix?: string;
}) {
  const { color } = useTheme();
  // Reported by the pills themselves. `Record` rather than a ref so the thumb
  // re-measures when a row's contents change.
  const [metrics, setMetrics] = useState<Record<string, Metrics>>({});
  const x = useSharedValue(0);
  const w = useSharedValue(0);
  // A ref, NOT a shared value: this is a "have I placed the thumb yet" flag read
  // on the JS side, and reading a shared value during render is a Reanimated
  // warning.
  const placed = useRef(false);

  // Split into primitives: the effect then depends on the two numbers that
  // actually change, not on an object literal that is a new reference on every
  // re-render (which would re-place the thumb on every unrelated render).
  const targetX = metrics[value]?.x;
  const targetW = metrics[value]?.width;
  // The track is `height` TALL including its own 3px padding, so the pill and
  // the thumb both sit at `height - 6`. Sizing the pill at `height` overflowed
  // the padding box and clipped its own label on Android.
  const innerH = height - 6;

  const measure = useCallback(
    (key: string) => (e: { nativeEvent: { layout: { x: number; width: number } } }) => {
      const { x: nx, width: nw } = e.nativeEvent.layout;
      setMetrics((prev) => {
        const hit = prev[key];
        // A re-layout of every sibling fires on every scroll-driven relayout;
        // bailing out on an unchanged measurement keeps this a no-op instead
        // of a state write per pill per frame.
        if (hit && hit.x === nx && hit.width === nw) return prev;
        return { ...prev, [key]: { x: nx, width: nw } };
      });
    },
    []
  );

  const thumb = useAnimatedStyle(() => ({
    transform: [{ translateX: x.value }],
    width: w.value,
  }));

  const place = useCallback(
    (m: Metrics | undefined) => {
      if (!m) return;
      if (!placed.current) {
        placed.current = true;
        x.value = m.x;
        w.value = m.width;
        return;
      }
      x.value = withSpring(m.x, SPRING);
      w.value = withSpring(m.width, SPRING);
    },
    [x, w]
  );
  // Fires on the render where the measurement for the current value arrives —
  // once on mount (jump) and on every change after it (spring).
  useEffect(() => {
    if (targetX == null || targetW == null) return;
    place({ x: targetX, width: targetW });
  }, [place, targetX, targetW]);

  return (
    <View style={[styles.track, { height, backgroundColor: color.accent.muted }]}>
      {targetX != null && targetW != null ? (
        <Animated.View
          pointerEvents="none"
          style={[
            styles.thumb,
            { height: innerH, backgroundColor: color.accent.base },
            thumb,
          ]}
        />
      ) : null}
      {items.map((it) => {
        const active = it.key === value;
        return (
          <Pressable
            key={it.key}
            onPress={() => onChange(it.key)}
            onLayout={measure(it.key)}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            accessibilityLabel={
              accessibilityPrefix
                ? `${accessibilityPrefix}: ${it.a11yLabel ?? it.label}`
                : it.a11yLabel ?? it.label
            }
            style={({ pressed }) => [
              styles.selectorPill,
              { height: innerH, opacity: pressed && !active ? 0.6 : 1 },
            ]}
          >
            {it.icon ? (
              <AppIcon
                name={it.icon}
                size={15}
                color={active ? color.bg.primary : color.text.muted}
                strokeWidth={active ? 2.4 : 2}
              />
            ) : null}
            {it.label ? (
              <Text
                style={[
                  styles.selectorText,
                  { color: active ? color.bg.primary : color.text.secondary },
                ]}
                numberOfLines={1}
              >
                {it.label}
              </Text>
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
}

export function PillToggle<T extends string>({
  items,
  values,
  onToggle,
  height = 34,
}: {
  items: readonly PillItem<T>[];
  /** The picked set. Order is irrelevant; the UI sorts by the item order. */
  values: readonly T[];
  onToggle: (key: T) => void;
  height?: number;
}) {
  const { color } = useTheme();
  return (
    <View style={styles.toggleRow}>
      {items.map((it) => {
        const active = values.includes(it.key);
        return (
          <RoundedPressable
            key={it.key}
            onPress={() => onToggle(it.key)}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: active }}
            accessibilityLabel={it.label}
            radius={9999}
            style={[
              styles.togglePill,
              {
                height,
                backgroundColor: active ? color.accent.base : color.bg.surface,
                borderColor: active ? color.accent.base : color.border.muted,
              },
            ]}
          >
            {it.icon ? (
              <AppIcon
                name={it.icon}
                size={13}
                color={active ? color.bg.primary : color.text.muted}
                strokeWidth={active ? 2.4 : 2}
              />
            ) : null}
            <Text
              style={[
                styles.toggleText,
                { color: active ? color.bg.primary : color.text.secondary },
              ]}
              numberOfLines={1}
            >
              {it.label}
            </Text>
          </RoundedPressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  // ---- single-select ----
  track: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: radii.full,
    padding: 3,
    gap: 2,
    overflow: 'hidden',
  },
  thumb: {
    position: 'absolute',
    left: 3,
    top: 3,
    borderRadius: radii.full,
  },  selectorPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: spacing.sm + 2,
    // A pill-shaped button needs a pill-shaped highlight. Without these two,
    // the ripple on this pill is a RECTANGLE inside a rounded track — the track
    // clips its ends, which is why it read as square in the middle.
    borderRadius: radii.full,
    overflow: 'hidden',
  },
  selectorText: {
    fontSize: 12,
    lineHeight: 15,
    fontFamily: font.semibold,
    letterSpacing: 0.1,
  },

  // ---- multi-select ----
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm - 2,
  },
  togglePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: spacing.md,
    borderRadius: radii.full,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  toggleText: {
    fontSize: 12.5,
    lineHeight: 16,
    fontFamily: font.semibold,
    letterSpacing: 0.1,
  },
});
