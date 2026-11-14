// The head of a day card — the one place the screen names a day.
//
//   ╭ ┃ SAT 3 OCT   ┌TODAY┐              18 ╮
//   │                                          │
//   ├──────────────────────────────────────────┤
//   │  18:00  ▢  Frieren: Beyond Journey's End │
//   │  in 2h      ● EP 12 · TV                  │
//   ╰──────────────────────────────────────────╯
//
// THE CARD IS VIRTUALISED, SO THE CARD DOES NOT EXIST. There is no wrapping
// `View` around a day: `FlatList` asks for one cell at a time, so the outline
// has to be drawn BY the cells — this header carries the top edge and the top
// corners, every row carries its own left and right hairlines, and the last row
// closes the bottom. That is why `AiringRow` takes `isFirst` / `isLast`, and it
// is the reason this component is not a wrapper around its section: at three
// hundred rows a week, a real card would mean three hundred wrapper views the
// virtualiser is already refusing to mount.
//
// THE GAP ABOVE THE CARD IS PADDING, NOT A MARGIN. `getItemLayout` is a promise
// about where cells are, and a margin sits outside the box FlatList measures —
// the list would land an entry short of the day you tapped, every time. Same
// reason `DAY_HEADER_HEIGHT` includes it.
//
// TODAY IS A BADGE, NOT A HIGHLIGHT. The alternative was painting today's card
// in the accent colour, which reads as "you are here" only until you scroll and
// discover it was decoration. A 16px pill says the same thing, stays legible
// next to dense poster art, and leaves the rest of the row's contrast alone.
//
// THE COUNT IS RIGHT-ALIGNED AND TABULAR because it is the reason to tap a day,
// and a column of them has to line up. A truncated day says `200+` rather than
// `200`: the card is telling the truth about how much of it is on screen.

import { memo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '@/lib/ui/useTheme';
import { font, radii, spacing } from '@/lib/ui/tokens';
import { AppIcon } from '@/components/ui/AppIcon';
import { dayHeadingLabel } from './format';

/**
 * The header's whole box — the visible card head AND the gap above it.
 *
 * Same contract as `AIRING_ROW_HEIGHT`: the screen's `getItemLayout` adds this
 * to build its offsets, so it must describe the exact space the cell occupies.
 */
export const DAY_HEADER_HEIGHT = 64;

export const DayHeader = memo(function DayHeader({
  start,
  count,
  isToday,
  truncated,
}: {
  start: number;
  /** Episodes found so far, or null while the day's fetch is still in flight. */
  count: number | null;
  isToday: boolean;
  /** AniList had more of this day than the page ceiling allowed. */
  truncated: boolean;
}) {
  const { color } = useTheme();

  return (
    <View style={styles.slot}>
      <View
        style={[
          styles.head,
          {
            backgroundColor: color.bg.surface,
            borderColor: color.border.muted,
          },
        ]}
      >
        <View style={[styles.tick, { backgroundColor: color.accent.base }]} />

        <Text style={[styles.label, { color: color.text.primary }]} numberOfLines={1}>
          {dayHeadingLabel(start)}
        </Text>

        {isToday ? (
          <View style={[styles.today, { backgroundColor: color.accent.muted }]}>
            <Text style={[styles.todayText, { color: color.text.primary }]}>Today</Text>
          </View>
        ) : null}

        <Text style={[styles.count, { color: color.text.muted }]} numberOfLines={1}>
          {/* `…` and not `0`: a day that has not answered yet is not a day with
              nothing on it, and the difference is the whole reason this screen
              streams instead of waiting. */}
          {count == null ? '…' : truncated ? `${count}+` : count}
        </Text>
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  slot: {
    height: DAY_HEADER_HEIGHT,
    paddingTop: spacing.lg,
  },
  head: {
    flex: 1,
    paddingHorizontal: spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderTopLeftRadius: radii.lg,
    borderTopRightRadius: radii.lg,
  },
  tick: {
    width: 3,
    height: 14,
    borderRadius: 2,
    marginRight: spacing.sm + 2,
  },
  label: {
    fontSize: 12,
    lineHeight: 16,
    fontFamily: font.semibold,
    letterSpacing: 1.1,
    textTransform: 'uppercase',
  },
  today: {
    marginLeft: spacing.sm,
    paddingHorizontal: 6,
    height: 16,
    borderRadius: radii.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  todayText: {
    fontSize: 9,
    lineHeight: 11,
    fontFamily: font.bold,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  count: {
    marginLeft: 'auto',
    fontSize: 12.5,
    lineHeight: 16,
    fontFamily: font.semibold,
    fontVariant: ['tabular-nums'],
  },
});

/**
 * The line that closes a day card with nothing in it — "Nothing scheduled",
 * "Loading…", or the failure.
 *
 * THREE ANSWERS TO ONE QUESTION and they are not interchangeable, which is why
 * this is a prop rather than a component that decides for itself. A day that has
 * not answered yet is not a day with nothing on it, and rendering "Nothing
 * scheduled" for the first would be a flat lie told by a screen that has not
 * even finished asking. The caller already knows which of the three it is.
 *
 * The height is part of the same `getItemLayout` contract as the rows above it,
 * so a day whose card is one line tall and a day whose card is forty tall both
 * put the next day exactly where `DAY_HEADER_HEIGHT` says it goes.
 *
 * THE FAILURE IS TAPPABLE. A day card that says it failed, in a screen with no
 * other way to retry that specific day, is a dead end — the whole-screen retry
 * only appears when NOTHING loaded. So the failure note is a button, and it asks
 * for one day back rather than the seven the global retry costs.
 */
export const NOTE_ROW_HEIGHT = 48;

export const DayNote = memo(function DayNote({
  text,
  isLast = true,
  tone = 'muted',
  onPress,
  a11yLabel,
}: {
  text: string;
  /** Closes the card's bottom edge. Always true in practice. */
  isLast?: boolean;
  tone?: 'muted' | 'danger';
  /** Makes the note a button. Only the failure passes one. */
  onPress?: () => void;
  a11yLabel?: string;
}) {
  const { color } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      accessibilityRole={onPress ? 'button' : 'text'}
      accessibilityLabel={a11yLabel}
      android_ripple={onPress ? { color: color.accent.glow, borderless: false } : undefined}
      style={[
        noteStyles.note,
        {
          backgroundColor: color.bg.surface,
          borderColor: color.border.muted,
          borderLeftWidth: StyleSheet.hairlineWidth,
          borderRightWidth: StyleSheet.hairlineWidth,
          borderBottomWidth: isLast ? StyleSheet.hairlineWidth : 0,
          borderBottomLeftRadius: isLast ? radii.lg : 0,
          borderBottomRightRadius: isLast ? radii.lg : 0,
        },
      ]}
    >
      <View style={noteStyles.noteInner}>
        {tone === 'danger' && onPress ? (
          <AppIcon name="reset" size={13} color={color.status.danger} strokeWidth={2.2} />
        ) : null}
        <Text
          style={[
            noteStyles.noteText,
            { color: tone === 'danger' ? color.status.danger : color.text.muted },
          ]}
          numberOfLines={1}
        >
          {text}
        </Text>
      </View>
    </Pressable>
  );
});

const noteStyles = StyleSheet.create({
  note: {
    height: NOTE_ROW_HEIGHT,
    paddingHorizontal: spacing.md,
    justifyContent: 'center',
    // Clips the ripple to the card's bottom corners, which the card itself
    // cannot do because it is not a view — see this file's header.
    overflow: 'hidden',
  },
  noteInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  noteText: {
    fontSize: 12.5,
    lineHeight: 16,
    fontFamily: font.medium,
    flexShrink: 1,
  },
});
