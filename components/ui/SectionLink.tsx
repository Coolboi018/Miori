// The "See all ›" chip that sits in a `SectionHeader`'s trailing slot.
//
// PROMOTED OUT OF `explore.tsx` rather than duplicated, because it now appears on
// two screens that must not drift: explore's own curated sections, and home's
// rails. The affordance is identical in both — a quiet plate you can press that
// takes you to a grid of the thing you were looking at — and two copies of a pill
// is how one of them ends up a shade off and nobody can say which was first.
//
// It is deliberately NOT `MediaRail`'s own see-all plate. That one is styled to
// sit beside rail scroll arrows, and the two were never meant to be the same
// component; what they share is intent, and this is the quieter expression of it
// for a header that has no arrows.

import { StyleSheet, Text } from 'react-native';
import { useTheme } from '@/lib/ui/useTheme';
import { font, spacing } from '@/lib/ui/tokens';
import { RoundedPressable } from '@/components/ui/RoundedPressable';

export function SectionLink({
  label,
  onPress,
}: {
  label: string;
  onPress: () => void;
}) {
  const { color } = useTheme();
  return (
    // The wash is drawn by the component, so it follows this pill's own radius
    // instead of relying on the platform clipping a ripple to its outline.
    <RoundedPressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      radius={9999}
      style={[
        styles.link,
        {
          backgroundColor: color.bg.surface,
          borderColor: color.border.muted,
        },
      ]}
    >
      <Text style={[styles.text, { color: color.text.secondary }]}>{label}</Text>
      <Text style={[styles.chevron, { color: color.text.muted }]}>›</Text>
    </RoundedPressable>
  );
}

const styles = StyleSheet.create({
  link: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: spacing.sm + 2,
    height: 24,
    borderRadius: 9999,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  text: { fontSize: 12, lineHeight: 15, fontFamily: font.medium, letterSpacing: 0.2 },
  chevron: { fontSize: 14, lineHeight: 15, fontFamily: font.semibold },
});