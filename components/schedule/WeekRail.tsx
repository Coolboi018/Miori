// The week rail — seven day chips under the header, in both modes.
//
//   ┌──────┐┌──────┐┌──────┐┌──────┐┌──────┐┌────┐┌────┐
//   │ SAT  ││ SUN  ││ MON  ││ TUE  ││ WED  ││ TH ││ FR │
//   │  3   ││  4   ││  5   ││  6   ││  7   ││  8 ││  9 │
//   │ 18   ││ 42   ││ 31   ││ 27   ││ 22   ││ …  ││ …  │
//   └──────┘└──────┘└──────┘└──────┘└──────┘└────┘└────┘
//
// ONE CONTROL, TWO JOBS, WHICH IS WHY IT IS ALWAYS THERE.
//
//   DAY MODE   the chip IS the filter — tap Thursday, Thursday is what is below.
//   WEEK MODE  the chip is a SCROLL MARKER — the filled pill tracks the day at
//              the top of the viewport as you scroll, and tapping it jumps
//              there. The same component, one different `onSelect` handler.
//
// That is a real design decision rather than a shortcut. Two rails would have
// meant two sets of chips that look identical and do different things, and the
// difference is not something a user can see. One rail, and in week mode it
// answers a question the day cards cannot: where am I in seven days of content?
//
// THE THUMB IS POSITIONED ARITHMETICALLY, NOT MEASURED. `PillSelector` reports
// each pill's `x` through `onLayout` because its pills have different natural
// widths. These do not: seven equal chips in one row, so the offset is
// `index × (width + gap)` and the spring is right on the first frame with
// nothing to wait for. Same spring constants as every other sliding thumb in
// the app, so the motion is the app's rather than a one-off.
//
// CHIPS ARE SIZED FROM THE WINDOW, capped, and only scroll when the phone is
// too narrow to hold seven. Seven equal chips that end flush with the gutter
// look deliberate; seven chips floating in the middle of a tablet look lost.

import { useEffect, useMemo, useRef } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import { useTheme } from '@/lib/ui/useTheme';
import { font, layout, radii } from '@/lib/ui/tokens';
import { dayOfMonth, weekdayShort } from './format';

/** Same constants as `Pills`, the details tab strip and the segmented tab bar. */
const SPRING = { damping: 22, stiffness: 260, mass: 0.9 };

const GAP = 6;
const CHIP_H = 62;
/** Narrower than this and a day's number stops being readable at 17px. */
const CHIP_MIN = 40;
const CHIP_MAX = 64;

export interface RailDay {
  /** Local midnight. */
  start: number;
  /** Episodes found so far; null until the day's fetch lands. */
  count: number | null;
  isToday: boolean;
}

export const WeekRail = function WeekRail({
  days,
  active,
  onSelect,
  available,
}: {
  days: RailDay[];
  /** Local midnight of the day the filled pill sits on. */
  active: number;
  onSelect: (start: number) => void;
  /** Width the rail may use, excluding the gutter. */
  available: number;
}) {
  const { color } = useTheme();

  /**
   * Seven chips share the space rather than sitting at a fixed size: on a 390
   * phone they land near 51px and fill the row exactly, on a tablet they stop
   * at `CHIP_MAX` rather than becoming billboards, and below ~300px of usable
   * width they stop shrinking and the row scrolls instead.
   */
  const chipW = useMemo(() => {
    const fitted = Math.floor((available - GAP * (days.length - 1)) / days.length);
    return Math.max(CHIP_MIN, Math.min(CHIP_MAX, fitted));
  }, [available, days.length]);

  const step = chipW + GAP;
  const index = Math.max(
    0,
    days.findIndex((d) => d.start === active)
  );

  const x = useSharedValue(0);
  // A ref, not a shared value: this is a "have I placed the thumb yet" flag read
  // on the JS side. Reading a shared value during render is a Reanimated warning.
  const placed = useRef(false);

  // Slide after the first placement, jump on it — springing in from x=0 on
  // mount looks like a glitch when the first chip is not the selected one.
  useEffect(() => {
    const target = index * step;
    if (!placed.current) {
      placed.current = true;
      x.value = target;
      return;
    }
    x.value = withSpring(target, SPRING);
  }, [index, step, x]);

  const thumb = useAnimatedStyle(() => ({
    transform: [{ translateX: x.value }],
    width: chipW,
  }));

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      scrollEnabled={available < chipW * days.length + GAP * (days.length - 1)}
      contentContainerStyle={styles.content}
    >
      <View style={[styles.track, { height: CHIP_H, width: step * days.length - GAP }]}>
        <Animated.View
          pointerEvents="none"
          style={[styles.thumb, { height: CHIP_H, backgroundColor: color.accent.base }, thumb]}
        />

        {days.map((d, i) => {
          const selected = i === index;
          return (
            <Pressable
              key={d.start}
              onPress={() => onSelect(d.start)}
              accessibilityRole="tab"
              accessibilityState={{ selected }}
              accessibilityLabel={`${weekdayShort(d.start)} ${dayOfMonth(d.start)}, ${
                d.count == null ? 'loading' : `${d.count} episodes`
              }`}
              android_ripple={{ color: color.accent.glow, borderless: false }}
              style={({ pressed }) => [
                styles.chip,
                {
                  width: chipW,
                  height: CHIP_H,
                  // Today carries a quiet outline when it is not the active chip.
                  // A fill would say "you are here", which in WEEK mode the fill
                  // already means "you are looking here" — two claims, one mark.
                  borderColor: d.isToday ? color.border.strong : 'transparent',
                  borderWidth: StyleSheet.hairlineWidth,
                  opacity: pressed && !selected ? 0.6 : 1,
                },
              ]}
            >
              <Text
                style={[
                  styles.weekday,
                  { color: selected ? color.bg.primary : color.text.muted },
                ]}
                numberOfLines={1}
              >
                {weekdayShort(d.start)}
              </Text>
              <Text
                style={[
                  styles.date,
                  { color: selected ? color.bg.primary : color.text.primary },
                ]}
                numberOfLines={1}
              >
                {dayOfMonth(d.start)}
              </Text>
              <Text
                style={[
                  styles.count,
                  { color: selected ? color.bg.primary : color.text.muted },
                ]}
                numberOfLines={1}
              >
                {d.count == null ? ' ' : d.count}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </ScrollView>
  );
};

/** The rail's own footprint, so a caller can reason about the header's height. */
export const WEEK_RAIL_HEIGHT = CHIP_H;

const styles = StyleSheet.create({
  content: {
    paddingHorizontal: layout.gutter,
  },
  track: {
    flexDirection: 'row',
    gap: GAP,
    position: 'relative',
  },
  thumb: {
    position: 'absolute',
    left: 0,
    top: 0,
    borderRadius: radii.md,
  },
  chip: {
    borderRadius: radii.md,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 1,
    overflow: 'hidden',
  },
  weekday: {
    fontSize: 10,
    lineHeight: 13,
    fontFamily: font.semibold,
    letterSpacing: 0.9,
    textTransform: 'uppercase',
  },
  date: {
    fontSize: 17,
    lineHeight: 22,
    fontFamily: font.bold,
    fontVariant: ['tabular-nums'],
    letterSpacing: -0.4,
  },
  count: {
    fontSize: 9.5,
    lineHeight: 12,
    fontFamily: font.medium,
    fontVariant: ['tabular-nums'],
    // Always present, even while the day is still loading: the chips are
    // top-aligned in a `justifyContent: centre` column, and a row that grows a
    // third line when its count lands would push every date beside it.
    height: 12,
  },
});
