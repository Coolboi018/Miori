// Settings controls. Deliberately generic so adding a preference is a data
// change, not a component change.

import { memo, type ReactNode } from 'react';
import { Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import { useTheme } from '@/lib/ui/useTheme';
import { font, radii, spacing } from '@/lib/ui/tokens';

/** A labelled row: text on the left, control on the right. */
export function SettingRow({
  label,
  hint,
  children,
  onPress,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  /** When provided, the whole row becomes tappable (used by radio rows). */
  onPress?: () => void;
}) {
  const { color } = useTheme();
  const content = (
    <>
      <View style={styles.rowText}>
        <Text style={[styles.label, { color: color.text.primary }]}>{label}</Text>
        {hint ? <Text style={[styles.hint, { color: color.text.muted }]}>{hint}</Text> : null}
      </View>
      {children}
    </>
  );
  if (onPress) {
    return (
      <Pressable
        onPress={onPress}
        accessibilityRole="radio"
        style={({ pressed }) => [styles.row, { opacity: pressed ? 0.6 : 1 }]}
      >
        {content}
      </Pressable>
    );
  }
  return <View style={styles.row}>{content}</View>;
}

export function SettingSwitch({
  value,
  onValueChange,
}: {
  value: boolean;
  onValueChange: (v: boolean) => void;
}) {
  const { color } = useTheme();
  return (
    <Switch
      value={value}
      onValueChange={onValueChange}
      trackColor={{ false: color.bg.elevated, true: color.accent.muted }}
      thumbColor={value ? color.accent.base : color.text.muted}
    />
  );
}

/**
 * 2–4 option picker. Options are supplied as `[value, label]` tuples and
 * rendered as a row of pills — one tap, no long-press, no dropdown. A dropdown
 * would be the wrong control here: three options fit, and a tap is faster
 * than a menu on a phone.
 */
export function SettingSegments<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: readonly (readonly [T, string])[];
  onChange: (v: T) => void;
}) {
  const { color } = useTheme();
  return (
    <View style={styles.segments}>
      {options.map(([v, label]) => {
        const active = v === value;
        return (
          <Pressable
            key={v}
            onPress={() => onChange(v)}
            accessibilityRole="radio"
            accessibilityState={{ selected: active }}
            style={({ pressed }) => [
              styles.pill,
              {
                backgroundColor: active ? color.accent.base : color.accent.muted,
                opacity: pressed && !active ? 0.6 : 1,
              },
            ]}
          >
            <Text
              style={[
                styles.pillText,
                { color: active ? color.bg.primary : color.text.secondary },
              ]}
              numberOfLines={1}
            >
              {label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function SettingSection({ title, children }: { title: string; children: ReactNode }) {
  const { color } = useTheme();
  return (
    <View style={styles.section}>
      <Text style={[styles.sectionTitle, { color: color.text.muted }]}>
        {title.toUpperCase()}
      </Text>
      <View style={[styles.card, { backgroundColor: color.bg.surface }]}>{children}</View>
    </View>
  );
}

export const SettingRowMemo = memo(SettingRow);

const styles = StyleSheet.create({
  section: {
    marginTop: spacing.xxl,
  },
  sectionTitle: {
    fontSize: 12,
    fontFamily: font.semibold,
    letterSpacing: 0.8,
    paddingHorizontal: spacing.lg,
    marginBottom: spacing.sm,
  },
  card: {
    marginHorizontal: spacing.lg,
    borderRadius: radii.lg,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.lg,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    // Hairline between rows, drawn on the row so the card's own border isn't
    // needed and the last row's line can be suppressed by the caller.
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(128,128,128,0.18)',
  },
  rowText: {
    flex: 1,
  },
  label: {
    fontSize: 15,
    fontFamily: font.medium,
  },
  hint: {
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 16,
    marginTop: 2,
  },
  segments: {
    flexDirection: 'row',
    gap: 4,
    backgroundColor: 'rgba(128,128,128,0.12)',
    borderRadius: radii.md,
    padding: 3,
  },
  pill: {
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: radii.sm,
    minWidth: 52,
    alignItems: 'center',
  },
  pillText: {
    fontSize: 13,
    fontFamily: font.semibold,
  },
});
