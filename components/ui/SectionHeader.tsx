// The one section header — every titled block of media uses this, so the
// home page stops having three slightly different headers.
//
// THE DESIGN: a small accent tick, then the title. That's it.
//
// An earlier revision drew a fading hairline "rule" after the title
// (expo-linear-gradient). It looked editorial on a mock and like noise on a
// phone — and it was a native gradient view PER HEADER, six of them on home
// alone, each one a texture pass for zero information. The tick does the same
// job for less: it marks the start of a section the way a margin note does,
// gives the eye an anchor at the left edge (where it already is), and costs
// one plain view.
//
//   ┃ TRENDING                    ‹ ›
//   ┃ ▢ ▢ ▢ ▢ ▢ ▢
//
// Layout: tick, title, then a trailing slot — scroll arrows for a rail, an
// item count for a list. The title is uppercased small-caps-style rather
// than 18px bold: quieter next to dense poster art, and it makes the
// trailing arrows read as part of the header instead of floating chrome.
//
// Performance contract (this is a component every screen renders):
//   - ONE extra native view per header — the tick. No gradients, no shadows,
//     nothing per-card, nothing animated. Six headers on home = six views.
//   - Static. Nothing here changes after render.
//   - It owns its own gutter (16) and the gap beneath it (12); the section
//     owns the gap ABOVE it and the gutter of the content below. That is what
//     makes the header align with the cards in every rail without each parent
//     remembering to pad.

import type { ReactNode } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '@/lib/ui/useTheme';
import { font, layout, spacing } from '@/lib/ui/tokens';

export function SectionHeader({
  title,
  trailing,
}: {
  title: string;
  /** Right-hand slot: rail arrows, an item count, anything static. */
  trailing?: ReactNode;
}) {
  const { color } = useTheme();
  return (
    <View style={styles.row}>
      {/* The tick. Height matches the title's line box, so the two centre as
          one unit; width 3 reads as a mark, not a bar. */}
      <View style={[styles.tick, { backgroundColor: color.text.primary }]} />

      <Text style={[styles.title, { color: color.text.primary }]} numberOfLines={1}>
        {title}
      </Text>

      {trailing ? <View style={styles.trailing}>{trailing}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 28,
    paddingHorizontal: layout.gutter,
    marginBottom: spacing.md,
  },
  tick: {
    width: 3,
    height: 14,
    borderRadius: 2,
    marginRight: spacing.sm + 2,
  },
  // Uppercase with tracking: the header becomes a label above the rail
  // rather than a heading competing with the posters under it. Semibold, not
  // bold — at this size bold Montserrat goes heavy.
  title: {
    flexShrink: 1,
    fontSize: 13,
    lineHeight: 16,
    fontFamily: font.semibold,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
  // Fixed so a header with arrows and a header with a count sit on the same
  // baseline — otherwise the trailing slot's height drags the title around
  // and the section rhythm changes from one rail to the next.
  trailing: {
    minHeight: 28,
    marginLeft: 'auto',
    justifyContent: 'center',
  },
});

/**
 * The OTHER header: a centred uppercase word over a short accent bar, with no
 * left tick and no rule running to the screen edge. It is the detail page's
 * treatment for "Genres & Keywords" / "Titles", and it lives beside
 * `SectionHeader` rather than inside it so the two stay visibly different
 * languages.
 *
 * WHY BOTH: `SectionHeader` is a wide, left-anchored label for a wide,
 * left-aligned block — a rail, a grid, a chart. This one labels a narrow
 * control, a pill row or a filter row, and CENTRING it is what makes that block
 * read as one unit instead of a label shouting at a toolbar. The bar is the
 * only coloured thing in the block, so it marks where the thing starts without
 * adding a rule the eye has to follow across the whole screen.
 */
export function CenterLabel({
  label,
  accent,
  style,
}: {
  label: string;
  /** Bar colour. Defaults to the theme accent; pass a show's own cover colour
   *  to match that page's language. */
  accent?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const { color } = useTheme();
  return (
    <View style={[centerStyles.wrap, style]}>
      <Text style={[centerStyles.text, { color: color.text.secondary }]}>{label}</Text>
      <View style={[centerStyles.bar, { backgroundColor: accent ?? color.accent.base }]} />
    </View>
  );
}

const centerStyles = StyleSheet.create({
  wrap: {
    alignItems: 'center',
    gap: 5,
  },
  text: {
    fontSize: 10,
    lineHeight: 13,
    fontFamily: font.bold,
    letterSpacing: 1.6,
    textTransform: 'uppercase',
  },
  // Short on purpose. A full-width rule under a 40px word reads as a divider
  // between sections; this one reads as a mark under a label.
  bar: {
    width: 22,
    height: 2,
    borderRadius: 1,
  },
});
