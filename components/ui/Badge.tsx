// Small pill badges — the "15 EP" / "TV" / "RELEASING" row under the title.
//
// `tone` is semantic, not decorative: `accent` for the count (the one thing you
// look for), `solid` for format, `outline` for status. Keeping those three
// distinct is what stops the row turning into confetti.

import { StyleSheet, Text, View, type ViewStyle } from 'react-native';
import { useTheme } from '@/lib/ui/useTheme';
import { font, radii, spacing } from '@/lib/ui/tokens';

export type BadgeTone = 'accent' | 'solid' | 'outline';

export function Badge({
  label,
  tone = 'solid',
  style,
}: {
  label: string;
  tone?: BadgeTone;
  style?: ViewStyle;
}) {
  const { color } = useTheme();
  const bg =
    tone === 'accent' ? color.accent.base : tone === 'solid' ? color.accent.muted : 'transparent';
  const fg = tone === 'accent' ? color.bg.primary : color.text.primary;
  const border = tone === 'outline' ? color.border.strong : 'transparent';

  return (
    <View style={[styles.badge, { backgroundColor: bg, borderColor: border }, style]}>
      <Text
        style={[
          styles.text,
          { color: fg },
          // Outline badges read as lighter-weight; tracking opens the letters up.
          tone === 'outline' ? styles.outlineText : null,
        ]}
        numberOfLines={1}
      >
        {label}
      </Text>
    </View>
  );
}

/** Row wrapper so callers don't hand-roll gap/flex every time. */
export function BadgeRow({ children }: { children: React.ReactNode }) {
  return <View style={styles.row}>{children}</View>;
}

const styles = StyleSheet.create({
  badge: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: radii.sm,
    borderWidth: StyleSheet.hairlineWidth,
    alignSelf: 'flex-start',
  },
  text: {
    fontSize: 11,
    fontFamily: font.semibold,
    letterSpacing: 0.4,
    textTransform: 'uppercase',
  },
  outlineText: {
    fontFamily: font.medium,
  },
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
    alignItems: 'center',
  },
});
