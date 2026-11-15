// Settings controls. Deliberately generic so adding a preference is a data
// change, not a component change.
//
// THREE ROW SHAPES, ONE ROW:
//
//   <SettingRow label hint />                                  — static text
//   <SettingRow label hint toggle={{ value, onChange }} />      — a SWITCH
//   <SettingRow label hint selected onSelect />                 — a RADIO
//   <SettingRow label hint>{anyControl}</SettingRow>            — custom control
//
// WHY THE SWITCH IS OURS AND NOT REACT NATIVE'S `Switch`. The platform switch is
// two different controls with two different sizes, colours and thumb behaviours
// (Material on Android, Cupertino on iOS), and neither can be themed past
// `trackColor`/`thumbColor` — on this app's near-black palette the Android one
// draws a grey trough beside a grey thumb and reads as disabled. It also animates
// on the native side, so on a cold frame the thumb can arrive before the colour
// does. This one is a Reanimated pill: a track that interpolates its colour and a
// thumb that translates, both on the UI thread, both in the theme's own colours.
//
// WHY THE WHOLE ROW IS THE TARGET. "Tap the label" is the single most common
// miss in a settings screen — the row is the thing that looks like a control, and
// a 46×26 target inside a 60pt-tall row means most of the row does nothing. Every
// row that owns a boolean or a selection therefore handles its OWN press, and the
// control it draws is `pointerEvents="none"` decoration: two hit areas for one
// value is how a tap toggles twice.
//
// WHY THE RADIO ROWS NO LONGER SAY "Use" / "On". A column of two-state words is
// the least scannable possible list: the eye has to read each trailing word to
// find the selected one. A trailing check glyph is a shape, found at a glance, and
// it is what every platform settings app uses. It also removes the "Use" vs "On"
// split, which was two words for one idea and changed depending on whether the row
// was a source or a switch.

import { useEffect, memo, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, {
  Easing,
  interpolateColor,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { AppIcon } from '@/components/ui/AppIcon';
import { useTheme } from '@/lib/ui/useTheme';
import { font, radii, spacing } from '@/lib/ui/tokens';

/** Track geometry. The travel is derived, never hand-copied. */
const TRACK_W = 46;
const TRACK_H = 26;
const THUMB = 20;
const PAD = 3;
const TRAVEL = TRACK_W - THUMB - PAD * 2;

/** Off track: a neutral trough that reads as "empty" on the card surface. */
const OFF_TRACK = 'rgba(128,128,128,0.34)';
const OFF_THUMB = '#f2f2f7';

/**
 * The switch itself — VISUAL ONLY.
 *
 * It draws no hit area on purpose: the row it sits in is the control (see the
 * header). Rendering it inside its own `Pressable` as well is the double-toggle
 * bug, and it is why the pressable wrapper below (`SettingSwitch`) exists only for
 * the few call sites that are not a `SettingRow`.
 */
export function SettingToggle({
  value,
  disabled = false,
}: {
  value: boolean;
  disabled?: boolean;
}) {
  const { color } = useTheme();
  const on = useSharedValue(value ? 1 : 0);

  useEffect(() => {
    on.value = withTiming(value ? 1 : 0, {
      // Short enough to feel immediate, long enough to read as movement.
      duration: 170,
      easing: Easing.out(Easing.cubic),
    });
  }, [on, value]);

  const track = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(on.value, [0, 1], [OFF_TRACK, color.accent.base]),
  }));

  /**
   * The thumb INVERTS against the track: white on the trough, near-black on the
   * filled pill. That contrast is what makes "on" legible at a glance without
   * reading the label — a thumb that stayed white would make the on-state look
   * like a slightly brighter off-state.
   */
  const thumb = useAnimatedStyle(() => ({
    transform: [{ translateX: on.value * TRAVEL }],
    backgroundColor: interpolateColor(on.value, [0, 1], [OFF_THUMB, color.bg.primary]),
  }));

  return (
    <Animated.View
      pointerEvents="none"
      style={[styles.track, { opacity: disabled ? 0.45 : 1 }, track]}
    >
      <Animated.View style={[styles.thumb, thumb]} />
    </Animated.View>
  );
}

/**
 * A switch with its own hit area, for the call sites that are not a `SettingRow`.
 *
 * Kept with its original signature (`value` / `onValueChange`) so every existing
 * usage upgrades to the custom toggle without touching the call site.
 */
export function SettingSwitch({
  value,
  onValueChange,
  disabled = false,
}: {
  value: boolean;
  onValueChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      onPress={() => onValueChange(!value)}
      disabled={disabled}
      accessibilityRole="switch"
      accessibilityState={{ checked: value, disabled }}
      hitSlop={10}
      style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
    >
      <SettingToggle value={value} disabled={disabled} />
    </Pressable>
  );
}

/** A labelled row: text on the left, control on the right. */
export function SettingRow({
  label,
  hint,
  children,
  onPress,
  toggle,
  selected,
  onSelect,
}: {
  label: string;
  hint?: string;
  children?: ReactNode;
  /** When provided, the whole row becomes tappable (used by custom controls). */
  onPress?: () => void;
  /**
   * A boolean owned by this row. Renders the switch and makes the whole row the
   * switch — see the header for why that is not optional.
   */
  toggle?: { value: boolean; onChange: (v: boolean) => void; disabled?: boolean };
  /** A selection owned by this row: draws a trailing check when true. */
  selected?: boolean;
  /** Makes the row a radio. Required alongside `selected` to be pressable. */
  onSelect?: () => void;
}) {
  const { color } = useTheme();

  const press =
    onPress ?? (toggle ? () => toggle.onChange(!toggle.value) : onSelect);
  const isSwitch = toggle != null;

  const content = (
    <>
      <View style={styles.rowText}>
        <Text style={[styles.label, { color: color.text.primary }]}>{label}</Text>
        {hint ? <Text style={[styles.hint, { color: color.text.muted }]}>{hint}</Text> : null}
      </View>
      {toggle ? <SettingToggle value={toggle.value} disabled={toggle.disabled} /> : null}
      {selected !== undefined ? (
        // Fixed slot, so the label does not reflow when the selection moves down
        // the list — a check that pushes its own row's text sideways is the
        // cheapest way to make a settings screen feel unstable.
        <View style={styles.checkSlot}>
          {selected ? (
            <AppIcon name="check" size={18} color={color.accent.base} strokeWidth={2.5} />
          ) : null}
        </View>
      ) : null}
      {children}
    </>
  );

  if (press) {
    return (
      <Pressable
        onPress={press}
        disabled={toggle?.disabled}
        accessibilityRole={isSwitch ? 'switch' : 'radio'}
        accessibilityState={isSwitch ? { checked: toggle.value } : { selected }}
        accessibilityLabel={hint ? `${label}. ${hint}` : label}
        style={({ pressed }) => [styles.row, { opacity: pressed ? 0.62 : 1 }]}
      >
        {content}
      </Pressable>
    );
  }
  return <View style={styles.row}>{content}</View>;
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
  track: {
    width: TRACK_W,
    height: TRACK_H,
    borderRadius: TRACK_H / 2,
    padding: PAD,
    justifyContent: 'center',
  },
  thumb: {
    width: THUMB,
    height: THUMB,
    borderRadius: THUMB / 2,
  },
  checkSlot: {
    width: 18,
    height: 18,
    alignItems: 'center',
    justifyContent: 'center',
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
