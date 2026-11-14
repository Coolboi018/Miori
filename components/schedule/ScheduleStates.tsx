// The three things this screen shows when the list has nothing to show.
//
//   ScheduleSkeleton   the request is in flight
//   ScheduleError      AniList could not be reached, and there is a way out
//   ScheduleEmpty      the week is genuinely, verifiably empty
//
// ONE FILE, BECAUSE THEY ARE ONE DECISION. Which of the three a user sees is
// not three separate pieces of state — it is one question ("is there anything to
// list?") with three answers, and answering it in three places is how a screen
// ends up showing a skeleton over a real error. `app/(tabs)/schedule.tsx`
// picks exactly one of them and this file owns what each looks like.
//
// THE SKELETON IS THE REAL GEOMETRY. Grey blocks at `AIRING_ROW_HEIGHT` and
// `DAY_HEADER_HEIGHT`, in the same card shape, so nothing moves when the data
// lands. A centred spinner over an empty area — what this screen used to do — is
// not a neutral loading state, it is a layout change, and a layout change during
// a load is a scroll jump.
//
// THE SWEEP IS ONE CLOCK FOR THE WHOLE SCREEN, not one per block. `ShimmerSweep`
// owns the animation and each plate takes a slice of it (`at`), which is what
// lets ~40 plates travel as a single band down the day cards instead of
// re-compositing forty times a frame. See `components/ui/Shimmer.tsx`.
//
// THE ERROR IS NOT THE EMPTY STATE. It says what failed, offers the retry, and
// the retry drops the cache first — otherwise a failure inside the TTL window is
// served straight back out of memory and the button does precisely nothing.

import { Pressable, StyleSheet, Text, View } from 'react-native';
import { alpha } from '@/lib/ui/color';
import { useTheme } from '@/lib/ui/useTheme';
import { font, layout, radii, spacing } from '@/lib/ui/tokens';
import { AppIcon } from '@/components/ui/AppIcon';
import { Shimmer, ShimmerSweep, sweepAt } from '@/components/ui/Shimmer';
import { AIRING_ROW_HEIGHT } from './AiringRow';
import { DAY_HEADER_HEIGHT } from './DayHeader';

/** Day cards drawn while the week is still being asked about. */
const GROUPS = 2;
/** Airing rows inside one card. */
const ROWS = 3;

/** How far the band travels across one row, left to right, in clock units. */
const ROW_SPAN = 0.3;
/** How far each row trails the one above it inside a card. */
const ROW_LEAD = 0.07;
/** How far the second card trails the first. */
const CARD_LEAD = 0.3;
/** The cycle: the largest `at` below. See `ShimmerSweep`. */
const SPAN = CARD_LEAD + ROW_LEAD * (ROWS - 1) + ROW_SPAN;

export function ScheduleSkeleton() {
  const { color } = useTheme();
  return (
    <ShimmerSweep span={SPAN}>
      <View accessibilityRole="progressbar" accessibilityLabel="Loading the schedule">
        {Array.from({ length: GROUPS }, (_, g) => {
          const card = g * CARD_LEAD;
          return (
            <View key={g}>
              <View style={styles.gap} />
              {/* The card's top corners are rounded and its bottom is not — the
                  last row rounds the other pair — so `radius` is 0 here and the
                  two corners come from the style, which `Shimmer` applies after
                  its own. */}
              <Shimmer
                plate={color.bg.surface}
                radius={0}
                style={[styles.head, styles.headTop]}
                at={card}
              />
              {Array.from({ length: ROWS }, (_, r) => {
                const row = card + r * ROW_LEAD;
                // `sweepAt` over the row's own plates: the stripe, the clock, the
                // art, then the title and its meta — the order the eye reads them
                // in, so the band follows the reading order and not the DOM's.
                const at = (part: number) =>
                  sweepAt(part, 5, ROW_SPAN, row);

                return (
                  <View
                    key={r}
                    style={[
                      styles.row,
                      {
                        height: AIRING_ROW_HEIGHT,
                        backgroundColor: color.bg.surface,
                        borderTopColor: color.border.muted,
                        borderTopWidth: r === 0 ? 0 : StyleSheet.hairlineWidth,
                        borderBottomColor: color.border.muted,
                        borderBottomWidth: g === GROUPS - 1 && r === ROWS - 1 ? StyleSheet.hairlineWidth : 0,
                        borderBottomLeftRadius: g === GROUPS - 1 && r === ROWS - 1 ? radii.lg : 0,
                        borderBottomRightRadius: g === GROUPS - 1 && r === ROWS - 1 ? radii.lg : 0,
                      },
                    ]}
                  >
                    <Shimmer plate={color.bg.elevated} radius={2} style={styles.stripe} at={at(0)} />
                    <View style={styles.clock}>
                      <Shimmer
                        plate={color.bg.elevated}
                        radius={radii.full}
                        style={[styles.line, { width: 34 }]}
                        at={at(1)}
                      />
                      <Shimmer
                        plate={color.bg.elevated}
                        radius={radii.full}
                        style={[styles.line, { width: 22 }]}
                        at={at(1.5)}
                      />
                    </View>
                    <Shimmer
                      plate={color.bg.elevated}
                      radius={radii.sm}
                      style={styles.thumb}
                      at={at(2)}
                    />
                    <View style={styles.lines}>
                      <Shimmer
                        plate={color.bg.elevated}
                        radius={radii.full}
                        style={[styles.line, { width: '82%' }]}
                        at={at(3)}
                      />
                      <Shimmer
                        plate={color.bg.elevated}
                        radius={radii.full}
                        style={[styles.line, { width: '46%' }]}
                        at={at(4)}
                      />
                    </View>
                  </View>
                );
              })}
            </View>
          );
        })}
      </View>
    </ShimmerSweep>
  );
}

export function ScheduleError({ message, onRetry }: { message: string; onRetry: () => void }) {
  const { color } = useTheme();
  return (
    <View style={[styles.box, { backgroundColor: alpha(color.status.danger, 0.1) }]}>
      <Text style={[styles.boxTitle, { color: color.text.primary }]}>Could not reach AniList</Text>
      <Text style={[styles.boxBody, { color: color.text.muted }]}>{message}</Text>
      <Pressable
        onPress={onRetry}
        accessibilityRole="button"
        accessibilityLabel="Try again"
        android_ripple={{ color: color.accent.glow, borderless: false }}
        style={({ pressed }) => [
          styles.retry,
          { borderColor: color.border.strong, opacity: pressed ? 0.6 : 1 },
        ]}
      >
        <AppIcon name="reset" size={14} color={color.text.primary} />
        <Text style={[styles.retryText, { color: color.text.primary }]}>Try again</Text>
      </Pressable>
    </View>
  );
}

export function ScheduleEmpty({ scope }: { scope: 'week' | 'day' }) {
  const { color } = useTheme();
  return (
    <View style={styles.empty}>
      <View style={[styles.glyph, { borderColor: color.border.muted }]}>
        <AppIcon name="schedule" size={18} color={color.text.muted} />
      </View>
      <Text style={[styles.boxTitle, { color: color.text.secondary }]}>
        {scope === 'week' ? 'Nothing scheduled this week' : 'Nothing scheduled'}
      </Text>
      <Text style={[styles.boxBody, { color: color.text.muted }]}>
        {scope === 'week'
          ? 'AniList has no airings in the next seven days. This happens between seasons — check back tomorrow.'
          : 'AniList has no airings due on this day. Pick another from the row above, or switch back to the whole week.'}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  gap: { height: spacing.lg },

  // ---- skeleton ----
  // `head` carries no background or radius of its own: the `Shimmer` is the
  // plate, and it takes `plate` + `radius` as props.
  head: { height: DAY_HEADER_HEIGHT - spacing.lg },
  headTop: { borderTopLeftRadius: radii.lg, borderTopRightRadius: radii.lg },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
  },
  stripe: { width: 3, height: 14, marginRight: spacing.md - 2 },
  // The clock column, then the art, at the same sizes `AiringRow` uses — a
  // skeleton that is a different shape from the thing it stands in for is a
  // layout change wearing a placeholder's clothes. `64` is `TIME_W`; if one moves
  // the other has to, or the placeholder's gutter is ten pixels short of the
  // real one and the bars inside it jump sideways on first paint.
  clock: { width: 64, marginRight: spacing.md - 2, gap: 5, alignItems: 'flex-end' },
  thumb: { width: 40, height: 60, marginRight: spacing.md - 2 },
  lines: { flex: 1, gap: 8 },
  line: { height: 9, borderRadius: radii.full },

  // ---- error / empty ----
  box: {
    marginTop: spacing.xl,
    marginHorizontal: layout.gutter,
    padding: spacing.lg,
    borderRadius: radii.xl,
    alignItems: 'center',
    gap: spacing.sm,
  },
  empty: {
    paddingVertical: spacing.huge,
    paddingHorizontal: layout.gutter,
    alignItems: 'center',
    gap: spacing.sm,
  },
  glyph: {
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.xs,
  },
  boxTitle: {
    fontSize: 15,
    lineHeight: 20,
    fontFamily: font.semibold,
    textAlign: 'center',
  },
  boxBody: {
    fontSize: 13,
    lineHeight: 19,
    fontFamily: font.medium,
    textAlign: 'center',
    maxWidth: 280,
  },
  retry: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: 38,
    paddingHorizontal: spacing.lg,
    marginTop: spacing.sm,
    borderRadius: radii.full,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  retryText: { fontSize: 13.5, lineHeight: 18, fontFamily: font.semibold },
});
