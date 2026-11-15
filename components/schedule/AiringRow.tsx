// One airing — the row every mode of this screen is built from.
//
//   ┃18:00  ┌────┐  Frieren: Beyond Journey's End
//   ┃in 2h  │ ▢▢ │  ● EP 12 · TV
//           └────┘
//
// THREE COLUMNS, EACH ANSWERING A DIFFERENT QUESTION. Time on the left, in a
// right-aligned gutter, because a schedule is a column of times you SCAN rather
// than a list of titles you read — the old screen wrote the time inside a
// sentence ("EP 12 · Sat, 18:00 (in 2h)") and lost the only thing a viewer came
// for. What airs, in the middle, with the art. When it is relative to, on the
// right, small and quiet, because it is a refinement of the clock time rather
// than the headline.
//
// THE LAMP LEADS THE META LINE, never the far right. A status dot is 7px; at the
// end of a 243px-wide text column it lands in a different place on every row
// depending on how long the episode label is, and a column of lamps that
// wanders is a column of lamps you cannot read as a column. Leading the line
// puts every lamp at the same x, which is what makes "the green ones are the
// next hour" a pattern the eye finds without being told.
//
// THE ACCENT STRIPE. The single next airing in view wears a 3px bar in its own
// cover colour down the leading edge — the same "this row is about THIS show"
// language as the chart's rank numeral and the banner card's accent line. One
// view, no animation, and it survives being scrolled past because it is on the
// row rather than in a header.
//
// PERFORMANCE: `memo`, `expo-image`, a pre-sized poster box, and framework-drawn
// press feedback only. No shadows, no blur, no gradient — a week is three
// hundred of these and they are virtualised, but a fast fling will still mount
// a screenful at once.

import { Image } from 'expo-image';
import { memo, useCallback } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { RoundedPressable } from '@/components/ui/RoundedPressable';
import type { AiringItem } from '@/lib/anilist/schedule';
import { mediaTitle } from '@/lib/anilist';
import { alpha } from '@/lib/ui/color';
import { coverAccent, coverPlate } from '@/lib/ui/accent';
import { useTheme } from '@/lib/ui/useTheme';
import { font, layout, radii, spacing } from '@/lib/ui/tokens';
import { formatLabel } from '@/components/anime/format';
import { airingState, clockTime, countdown, episodeLabel } from './format';

/** Poster is 2:3, and the row is two of them tall with air. */
const POSTER_W = 40;
const POSTER_H = POSTER_W / layout.posterRatio; // 60

/**
 * THE ROW'S HEIGHT, and the contract with the screen's `getItemLayout`.
 *
 * Poster (60) plus the row's own vertical padding (9 top, 9 bottom). Change one,
 * change the other, or the list scrolls to offsets that lie about where its
 * rows are. Exported for the same reason `MEDIA_ROW_HEIGHT` is.
 */
export const AIRING_ROW_HEIGHT = POSTER_H + 9 * 2; // 78

/**
 * THE GUTTER'S WIDTH — sized by MEASUREMENT, not by an estimate.
 *
 * The first cut of this constant was 54, justified by a comment saying a 12-hour
 * clock is "about 54px". It is not: reading the advance widths out of the
 * shipped `Montserrat-SemiBold.ttf` puts the worst case at 57.9px, and the
 * reported symptom was exactly that — a 54px box leaves room for `12:00 A` and
 * not the `M`, so the row showed half a period marker and dropped the rest.
 *
 *   "12:00 AM"   56.7px   ← the clock, 12.5px semibold
 *   "23:59"     32.7px   ← a 24-hour clock, for contrast
 *   "in 23h 59m" 57.9px   ← the RELATIVE line, 10.5px regular, and it is the
 *                            one that actually binds. A part-day row was the
 *                            worst case the original comment never considered.
 *
 * 64 leaves ~6px over the widest string. The font is a bundled file so it cannot
 * change underneath this, which is the only reason a fixed number is safe here.
 * A 24-hour locale simply sits in the extra air, right-aligned, and the column
 * stays a column — which is the point of a fixed width at all.
 *
 * `numberOfLines={1}` on both lines is the backstop, not the mechanism: anything
 * that still does not fit (a locale with a longer day-period marker, a user at
 * 1.5x system font scale) clips to one line and the row keeps its shape, instead
 * of wrapping into a second line the fixed 78px box cannot show.
 */
const TIME_W = 64;

export interface AiringRowProps {
  item: AiringItem;
  /** Current unix seconds — passed in so one tick re-renders, not a timer per row. */
  now: number;
  /** First row of its day card: no divider above, the day header drew one. */
  isFirst?: boolean;
  /** Last row of its day card: closes the card's bottom edge. */
  isLast?: boolean;
  /** The soonest upcoming airing anywhere in the window. */
  isNext?: boolean;
  onPress: (item: AiringItem) => void;
}

export const AiringRow = memo(function AiringRow({
  item,
  now,
  isFirst = false,
  isLast = false,
  isNext = false,
  onPress,
}: AiringRowProps) {
  const { color } = useTheme();
  const title = mediaTitle(item.media.title);
  /**
   * `large` (230x320, ~137KB) rather than `extraLarge` (460x640, ~478KB) —
   * measured on AniList's CDN. At POSTER_W = 40dp even a 3x screen needs 120px,
   * so `extraLarge` was paying 3.5x the bytes for 3.8x the pixels a 40dp
   * thumbnail cannot show. This row renders one per airing, so a busy evening is
   * dozens of them. `large` first because it is non-optional in the type.
   */
  const uri = item.media.coverImage?.large ?? item.media.coverImage?.extraLarge;
  const accent = coverAccent(item.media.coverImage?.color);
  const plate = coverPlate(item.media.coverImage?.color, color.bg.surface) ?? color.bg.elevated;

  const state = airingState(item.airingAt, now);
  const time = clockTime(item.airingAt);
  const rel = countdown(item.airingAt, now);

  // Meaning-named status colours, in a ramp the eye can read as urgency:
  // green = on now, amber = within the hour, grey = later, nothing = already
  // aired. A scheduled show's lamp is never a fourth opinion about the show —
  // it only ever says something about WHEN.
  const lamp =
    state === 'soon' ? color.status.success : state === 'now' ? color.status.info : null;

  const meta = [episodeLabel(item.episode), formatLabel(item.media.format)]
    .filter(Boolean)
    .join('  ·  ');

  const press = useCallback(() => onPress(item), [onPress, item]);

  return (
    <RoundedPressable
      onPress={press}
      accessibilityRole="button"
      accessibilityLabel={`${title}, ${episodeLabel(item.episode)}, ${time}, ${rel}`}
      radius={isLast ? radii.lg : 0}
      tint={color.accent.glow}
      style={[
        styles.row,
        {
          borderLeftColor: color.border.muted,
          borderRightColor: color.border.muted,
          borderTopColor: color.border.muted,
          borderBottomColor: color.border.muted,
          borderTopWidth: isFirst ? 0 : StyleSheet.hairlineWidth,
          borderBottomWidth: isLast ? StyleSheet.hairlineWidth : 0,
          borderBottomLeftRadius: isLast ? radii.lg : 0,
          borderBottomRightRadius: isLast ? radii.lg : 0,
        },
      ]}
    >
      {isNext ? (
        <View style={[styles.stripe, { backgroundColor: accent }]} pointerEvents="none" />
      ) : null}

      <View style={styles.time}>
        <Text
          style={[
            styles.clock,
            state === 'aired' ? styles.dim : null,
            { color: state === 'aired' ? color.text.muted : color.text.primary },
          ]}
          numberOfLines={1}
        >
          {time}
        </Text>
        <Text
          style={[
            styles.rel,
            { color: state === 'now' ? color.status.success : color.text.muted },
          ]}
          numberOfLines={1}
        >
          {rel}
        </Text>
      </View>

      <View style={[styles.poster, { backgroundColor: plate, borderColor: alpha(accent, 0.55) }]}>
        {uri ? (
          <Image
            source={{ uri }}
            style={StyleSheet.absoluteFill}
            contentFit="cover"
            transition={150}
            cachePolicy="memory-disk"
            // AniList ships a 460px cover into a 40px box. Downscaling is what
            // keeps a three-hundred-row week from holding three hundred of them.
            allowDownscaling
          />
        ) : null}
      </View>

      <View style={styles.body}>
        <Text
          style={[styles.title, { color: state === 'aired' ? color.text.secondary : color.text.primary }]}
          numberOfLines={2}
        >
          {title}
        </Text>
        <View style={styles.metaRow}>
          {lamp ? <View style={[styles.lamp, { backgroundColor: lamp }]} /> : null}
          {meta ? (
            <Text style={[styles.meta, { color: color.text.muted }]} numberOfLines={1}>
              {meta}
            </Text>
          ) : null}
        </View>
      </View>
    </RoundedPressable>
  );
});

const styles = StyleSheet.create({
  row: {
    height: AIRING_ROW_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    // Insets are INTERNAL: the screen's list container owns the distance to the
    // edge of the screen, and a cell that also padded would be inset twice.
    // Left inset is constant on EVERY row, not just the striped one, or the
    // clock column shifts sideways the moment the next airing changes.
    paddingLeft: spacing.md,
    paddingRight: spacing.md,
    overflow: 'hidden',
  },
  stripe: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: 3,
  },
  time: {
    width: TIME_W,
    alignItems: 'flex-end',
    marginRight: spacing.md - 2,
  },
  // Tabular figures, and tabular matters here more than anywhere else on the
  // screen: this column is read vertically, and a proportional "1" beside a
  // "2" makes two rows' times look like different widths.
  clock: {
    fontSize: 12.5,
    lineHeight: 16,
    fontFamily: font.semibold,
    fontVariant: ['tabular-nums'],
  },
  dim: { fontFamily: font.medium },
  rel: {
    fontSize: 10.5,
    lineHeight: 14,
    fontFamily: font.medium,
    marginTop: 1,
  },
  poster: {
    width: POSTER_W,
    height: POSTER_H,
    borderRadius: radii.sm,
    borderWidth: 1.5,
    overflow: 'hidden',
    marginRight: spacing.md - 2,
  },
  body: {
    flex: 1,
    minWidth: 0,
    gap: 3,
  },
  title: {
    fontSize: 13.5,
    lineHeight: 18,
    fontFamily: font.semibold,
    letterSpacing: -0.1,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    minWidth: 0,
  },
  lamp: {
    width: 6,
    height: 6,
    borderRadius: radii.full,
  },
  meta: {
    flexShrink: 1,
    fontSize: 11.5,
    lineHeight: 15,
    fontFamily: font.medium,
  },
});
