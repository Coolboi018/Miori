// The filter dropdown — a pill that opens a bottom sheet of options.
//
// THE PILL.  `‹icon› Value ⌄`, 36px tall, hairline-framed. Three states read at
// a glance without colour alone:
//
//   idle      surface fill, muted frame, secondary text
//   narrowed  accent wash, strong frame, primary text, and a 6px dot before
//             the label — the "you have filtered this" marker
//   focused   a white ring, drawn only while the sheet is open, so the pill
//             that owns the sheet is obvious when you dismiss it
//
// THE SHEET.  A real `Modal`, not an absolutely-positioned View, for one
// reason that no amount of absolute positioning can fix: the tab bar is
// `position: absolute` and floats OVER the scroll content, so an in-page
// overlay would render under the floating pill and the last options would be
// untappable. A Modal is its own window; the tab bar is not in it.
//
// It slides and fades on Reanimated (UI thread) from a single shared value, and
// animates OUT before `visible` flips so the dismissal has the same weight as
// the opening. `runOnJS` is required for that: the completion callback runs on
// the UI thread and `setState` cannot.
//
// PERFORMANCE: one `Modal` (mounted only while open), one animated sheet, one
// animated scrim, and plain views per option. No blur — expo-blur's tint path
// is the low-end killer this app already avoids everywhere else.

import { useCallback, useEffect, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/lib/ui/useTheme';
import { font, motion, radii, spacing } from '@/lib/ui/tokens';
import { AppIcon, type AppIconName } from './AppIcon';

/** A dropdown option. `hint` is the quiet right-hand disambiguator. */
export interface FilterOption<T> {
  key: T;
  label: string;
  icon?: AppIconName;
  /** Secondary line, right-aligned — e.g. "Series", "85+". */
  hint?: string;
}

export function FilterDropdown<T extends string | number | null>({
  label,
  value,
  options,
  onChange,
  icon,
  /** The value that means "no filter" — renders the pill idle and enables the
   *  sheet's own reset. Defaults to `null`, which is right for every optional
   *  filter. A filter that ALWAYS has a value (sort) must pass its default
   *  here or the pill reads as permanently narrowed. */
  clearValue = null as T,
  /** Wording for the sheet's reset row. "Any" is wrong for a sort. */
  clearLabel = 'Reset to “Any”',
  /** Sheet subtitle, e.g. the filters this list is being applied on top of. */
  subtitle,
}: {
  label: string;
  value: T;
  options: readonly FilterOption<T>[];
  onChange: (value: T) => void;
  /** Glyph on the pill — the reason three dropdowns can sit in one row. */
  icon?: AppIconName;
  clearValue?: T;
  clearLabel?: string;
  subtitle?: string;
}) {
  const { color } = useTheme();
  const insets = useSafeAreaInsets();
  const [open, setOpen] = useState(false);
  const progress = useSharedValue(0);

  const selected = options.find((o) => o.key === value) ?? null;
  const narrowed = clearValue === null ? value != null : value !== clearValue;

  useEffect(() => {
    if (open) progress.value = withTiming(1, { duration: motion.normal });
  }, [open, progress]);

  /** Animate out first, then unmount — a hard `visible=false` cuts the sheet
   *  off mid-flight and reads as a glitch. */
  const dismiss = useCallback(() => {
    progress.value = withTiming(0, { duration: motion.fast }, (finished) => {
      if (finished) runOnJS(setOpen)(false);
    });
  }, [progress]);

  const scrimStyle = useAnimatedStyle(() => ({ opacity: progress.value }));
  const sheetStyle = useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [{ translateY: (1 - progress.value) * 40 }],
  }));

  const onPick = useCallback(
    (key: T) => {
      onChange(key);
      dismiss();
    },
    [onChange, dismiss]
  );

  const clear = useCallback(() => {
    if (clearValue === null) return;
    onChange(clearValue);
    dismiss();
  }, [clearValue, onChange, dismiss]);

  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        accessibilityRole="button"
        accessibilityLabel={`${label} filter`}
        accessibilityState={{ expanded: open }}
        accessibilityHint={selected ? `Currently ${selected.label}` : 'No filter'}
        android_ripple={{ color: color.accent.glow, borderless: false }}
        style={({ pressed }) => [
          styles.pill,
          {
            backgroundColor: narrowed ? color.accent.muted : color.bg.surface,
            borderColor: open
              ? color.text.primary
              : narrowed
                ? color.border.strong
                : color.border.muted,
            opacity: pressed ? 0.7 : 1,
          },
        ]}
      >
        {narrowed ? <View style={[styles.dot, { backgroundColor: color.text.primary }]} /> : null}
        {icon ? <AppIcon name={icon} size={13} color={narrowed ? color.text.primary : color.text.muted} /> : null}
        <Text
          style={[styles.pillText, { color: narrowed ? color.text.primary : color.text.secondary }]}
          numberOfLines={1}
        >
          {selected?.label ?? 'Any'}
        </Text>
        <AppIcon name="chevronDown" size={13} color={color.text.muted} />
      </Pressable>

      <Modal
        visible={open}
        transparent
        // The slide is ours; RN's own animation would fight the shared value.
        animationType="none"
        statusBarTranslucent
        navigationBarTranslucent
        onRequestClose={dismiss}
      >
        <View style={styles.root}>
          <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: color.bg.overlay }, scrimStyle]}>
            <Pressable
              style={StyleSheet.absoluteFill}
              onPress={dismiss}
              accessibilityRole="button"
              accessibilityLabel="Close filters"
            />
          </Animated.View>

          <Animated.View
            style={[
              styles.sheet,
              {
                backgroundColor: color.bg.elevated,
                borderColor: color.border.muted,
                paddingBottom: insets.bottom + spacing.lg,
              },
              sheetStyle,
            ]}
          >
            <View style={[styles.grabber, { backgroundColor: color.border.strong }]} />

            <View style={styles.head}>
              <View style={styles.headText}>
                <Text style={[styles.title, { color: color.text.primary }]}>{label}</Text>
                {subtitle ? (
                  <Text style={[styles.sub, { color: color.text.muted }]} numberOfLines={1}>
                    {subtitle}
                  </Text>
                ) : null}
              </View>
              <Pressable
                onPress={dismiss}
                accessibilityRole="button"
                accessibilityLabel="Close"
                hitSlop={10}
                android_ripple={{ color: color.accent.glow, borderless: false }}
                style={({ pressed }) => [
                  styles.close,
                  { backgroundColor: color.accent.muted, opacity: pressed ? 0.6 : 1 },
                ]}
              >
                <AppIcon name="close" size={15} color={color.text.secondary} />
              </Pressable>
            </View>

            <ScrollView
              style={styles.list}
              contentContainerStyle={styles.listBody}
              showsVerticalScrollIndicator={false}
              bounces={false}
            >
              {options.map((o) => {
                const active = o.key === value;
                return (
                  <Pressable
                    key={String(o.key)}
                    onPress={() => onPick(o.key)}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: active }}
                    style={({ pressed }) => [
                      styles.option,
                      { opacity: pressed ? 0.65 : 1 },
                    ]}
                  >
                    {o.icon ? (
                      <View
                        style={[
                          styles.optionIcon,
                          {
                            backgroundColor: active ? color.accent.muted : color.accent.glow,
                          },
                        ]}
                      >
                        <AppIcon
                          name={o.icon}
                          size={16}
                          color={active ? color.text.primary : color.text.muted}
                        />
                      </View>
                    ) : (
                      <View style={styles.optionIconSpacer} />
                    )}

                    <Text
                      style={[
                        styles.optionLabel,
                        {
                          color: active ? color.text.primary : color.text.secondary,
                          fontFamily: active ? font.semibold : font.medium,
                        },
                      ]}
                      numberOfLines={1}
                    >
                      {o.label}
                    </Text>

                    {o.hint ? (
                      <Text style={[styles.optionHint, { color: color.text.muted }]} numberOfLines={1}>
                        {o.hint}
                      </Text>
                    ) : null}

                    <View style={styles.checkBox}>
                      {active ? (
                        <View style={[styles.check, { backgroundColor: color.text.primary }]}>
                          <AppIcon name="check" size={11} color={color.bg.primary} strokeWidth={3} />
                        </View>
                      ) : null}
                    </View>
                  </Pressable>
                );
              })}
            </ScrollView>

            {narrowed ? (
              <Pressable
                onPress={clear}
                accessibilityRole="button"
                accessibilityLabel={`Reset ${label}`}
                android_ripple={{ color: color.accent.glow, borderless: false }}
                style={({ pressed }) => [
                  styles.footerBtn,
                  {
                    borderColor: color.border.muted,
                    backgroundColor: pressed ? color.accent.muted : 'transparent',
                  },
                ]}
              >
                <AppIcon name="reset" size={15} color={color.text.secondary} />
                <Text style={[styles.footerText, { color: color.text.secondary }]}>
                  {clearLabel}
                </Text>
              </Pressable>
            ) : null}
          </Animated.View>
        </View>
      </Modal>
    </>
  );
}

/** A removable chip: "Sci-Fi ✕". Used for the active-filter summary. */
export function FilterChip({
  label,
  value,
  icon,
  onClear,
}: {
  label: string;
  value: string;
  icon?: AppIconName;
  onClear: () => void;
}) {
  const { color } = useTheme();
  return (
    <View
      style={[
        styles.chip,
        { backgroundColor: color.accent.muted, borderColor: color.border.strong },
      ]}
    >
      {icon ? <AppIcon name={icon} size={12} color={color.text.secondary} /> : null}
      <Text style={[styles.chipLabel, { color: color.text.muted }]}>{label}</Text>
      <Text style={[styles.chipValue, { color: color.text.primary }]} numberOfLines={1}>
        {value}
      </Text>
      <Pressable
        onPress={onClear}
        accessibilityRole="button"
        accessibilityLabel={`Remove ${label} filter`}
        hitSlop={8}
        android_ripple={{ color: color.accent.glow, borderless: false }}
        style={({ pressed }) => [
          styles.chipX,
          { backgroundColor: pressed ? color.accent.glow : 'transparent' },
        ]}
      >
        <AppIcon name="close" size={11} color={color.text.secondary} strokeWidth={2.5} />
      </Pressable>
    </View>
  );
}

/**
 * The "Reset" button that closes the filter row — the one control that can undo
 * everything at once, so it is placed at the END of the row where the eye
 * lands after reading the pills, not at the front competing with them.
 */
export function ResetFiltersButton({
  onPress,
  enabled,
}: {
  onPress: () => void;
  enabled: boolean;
}) {
  const { color } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={!enabled}
      accessibilityRole="button"
      accessibilityLabel="Reset all filters"
      accessibilityState={{ disabled: !enabled }}
      android_ripple={enabled ? { color: color.accent.glow, borderless: false } : undefined}
      style={({ pressed }) => [
        styles.reset,
        {
          // Muted, not hidden: a control that appears and disappears shifts
          // every pill to its left, which is worse than showing a dimmed one.
          opacity: enabled ? (pressed ? 0.65 : 1) : 0.35,
          borderColor: enabled ? color.border.strong : color.border.muted,
          backgroundColor: enabled ? color.accent.muted : 'transparent',
        },
      ]}
    >
      <AppIcon
        name="reset"
        size={14}
        color={enabled ? color.text.primary : color.text.muted}
      />
      <Text
        style={[
          styles.resetText,
          { color: enabled ? color.text.primary : color.text.muted },
        ]}
      >
        Reset
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  // ---- trigger pill ----
  pill: {
    height: 36,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: spacing.md - 1,
    borderRadius: radii.full,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  pillText: {
    fontSize: 13,
    lineHeight: 16,
    fontFamily: font.semibold,
    letterSpacing: 0.1,
    maxWidth: 116,
  },
  dot: {
    width: 5,
    height: 5,
    borderRadius: radii.full,
  },

  // ---- sheet ----
  root: { flex: 1, justifyContent: 'flex-end' },
  sheet: {
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    borderWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: 0,
    paddingTop: spacing.sm,
    paddingHorizontal: spacing.lg,
  },
  grabber: {
    width: 36,
    height: 4,
    borderRadius: radii.full,
    alignSelf: 'center',
    marginBottom: spacing.md,
  },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: spacing.md,
  },
  headText: { flex: 1, minWidth: 0 },
  title: {
    fontSize: 17,
    lineHeight: 22,
    fontFamily: font.bold,
    letterSpacing: -0.2,
  },
  sub: {
    fontSize: 12,
    lineHeight: 16,
    fontFamily: font.medium,
    marginTop: 2,
  },
  close: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    marginLeft: spacing.md,
  },
  // Bounded so a 25-option list (years) is a sheet, not a full screen, and a
  // 6-option one (status) does not float in a sea of empty sheet.
  list: { maxHeight: 372 },
  listBody: { paddingBottom: spacing.xs },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    height: 48,
    paddingRight: spacing.xs,
  },
  optionIcon: {
    width: 32,
    height: 32,
    borderRadius: radii.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  optionIconSpacer: { width: 0 },
  optionLabel: {
    flex: 1,
    fontSize: 15,
    lineHeight: 20,
    letterSpacing: -0.1,
  },
  optionHint: {
    fontSize: 11.5,
    lineHeight: 15,
    fontFamily: font.medium,
    maxWidth: 96,
  },
  // Fixed box so the tick occupies layout whether or not it is drawn, and rows
  // never change width as the selection moves.
  checkBox: {
    width: 24,
    alignItems: 'flex-end',
    justifyContent: 'center',
  },
  check: {
    width: 18,
    height: 18,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
  },
  footerBtn: {
    height: 44,
    borderRadius: radii.lg,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    marginTop: spacing.md,
    overflow: 'hidden',
  },
  footerText: {
    fontSize: 14,
    fontFamily: font.semibold,
    letterSpacing: 0.1,
  },

  // ---- chips + reset ----
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    height: 30,
    paddingLeft: spacing.md - 2,
    paddingRight: 4,
    borderRadius: radii.full,
    borderWidth: StyleSheet.hairlineWidth,
  },
  chipLabel: {
    fontSize: 10,
    lineHeight: 13,
    fontFamily: font.semibold,
    letterSpacing: 0.7,
    textTransform: 'uppercase',
  },
  chipValue: {
    fontSize: 12.5,
    lineHeight: 16,
    fontFamily: font.semibold,
    maxWidth: 108,
  },
  chipX: {
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  reset: {
    height: 36,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: spacing.md,
    borderRadius: radii.full,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  resetText: {
    fontSize: 13,
    lineHeight: 16,
    fontFamily: font.semibold,
    letterSpacing: 0.1,
  },
});
