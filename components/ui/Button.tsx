// Buttons: a wide primary action plus square icon-only actions.
//
// The reference layout is "Watch Ep 1" taking the space, with bookmark /
// share / edit as fixed squares beside it. That's `ButtonRow` — it's the
// common case here, so it's a component rather than something each screen
// re-implements with fragile flex maths.

import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import { useTheme } from '@/lib/ui/useTheme';
import { font, radii, spacing } from '@/lib/ui/tokens';

export function Button({
  label,
  onPress,
  variant = 'primary',
  disabled,
  loading,
  style,
}: {
  label: string;
  onPress?: () => void;
  variant?: 'primary' | 'secondary' | 'ghost';
  disabled?: boolean;
  loading?: boolean;
  style?: ViewStyle;
}) {
  const { color } = useTheme();
  const isPrimary = variant === 'primary';
  const bg = isPrimary ? color.accent.base : variant === 'secondary' ? color.accent.muted : 'transparent';
  const fg = isPrimary ? color.bg.primary : color.text.primary;
  const inert = disabled || loading;

  return (
    <Pressable
      onPress={onPress}
      disabled={inert}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: bg, opacity: inert ? 0.5 : pressed ? 0.8 : 1 },
        style,
      ]}
    >
      {loading ? <ActivityIndicator size="small" color={fg} /> : null}
      <Text style={[styles.label, { color: fg }]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

export function IconButton({
  children,
  onPress,
  label,
  style,
}: {
  children: ReactNode;
  onPress?: () => void;
  /** Required: an icon-only control with no accessible name is unusable. */
  label: string;
  style?: ViewStyle;
}) {
  const { color } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [
        styles.icon,
        { backgroundColor: color.accent.muted, opacity: pressed ? 0.7 : 1 },
        style,
      ]}
    >
      {children}
    </Pressable>
  );
}

/**
 * A primary action beside fixed-size icon actions. `Button` already flexes, so
 * this is just the row and its gaps — no width maths here on purpose.
 */
export function ButtonRow({ children }: { children: ReactNode }) {
  return <View style={styles.row}>{children}</View>;
}

const styles = StyleSheet.create({
  button: {
    flex: 1,
    height: 48,
    borderRadius: radii.md,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
  },
  label: {
    fontSize: 15,
    fontFamily: font.semibold,
    letterSpacing: 0.2,
  },
  icon: {
    width: 48,
    height: 48,
    borderRadius: radii.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  row: {
    flexDirection: 'row',
    gap: spacing.sm,
    alignItems: 'center',
  },
});
