// The round back plate every settings screen shares.
//
// WHY A PLATE AND NOT A BARE CHEVRON. The previous control was a 22pt glyph
// floating on the background — it looked like part of the title rather than a
// control, its tap target was invisible, and it gave no press feedback at all
// (the tap just… navigated, after the transition had already started). A plate
// does the three things a back control owes a thumb: it LOOKS tappable, it is
// visibly big enough to hit, and it answers the touch.
//
// The wash is `RoundedPressable` rather than `android_ripple`, for the reason
// stated in that file: the platform's ripple only follows the corner radius when
// it feels like clipping, and a square flash on a circular control is the exact
// bug this app has already paid for once.
//
// Shared rather than inlined per screen because the settings index keeps its own
// large-title header while the detail pages use `SettingsPage` — two headers, one
// control, so the back affordance cannot drift between them.

import { StyleSheet, View } from 'react-native';
import { goBack } from '@/lib/nav/back';
import { RoundedPressable } from '@/components/ui/RoundedPressable';
import { AppIcon } from '@/components/ui/AppIcon';
import { useTheme } from '@/lib/ui/useTheme';

/** The plate. The 44pt wrapper below keeps the row's alignment hit-target sized. */
const PLATE = 40;

export function BackPlate({
  label = 'Back',
  onPress,
}: {
  /** Spoken label — say where it goes ("Back to settings"), not what it is. */
  label?: string;
  onPress?: () => void;
}) {
  const { color } = useTheme();

  return (
    <View style={styles.wrap}>
      <RoundedPressable
        // `goBack`, not `router.back()`: a settings page opened from a link has
        // no history to pop, and an unguarded pop is a red box in dev and a dead
        // tap in release. See `lib/nav/back.ts`.
        onPress={onPress ?? (() => goBack())}
        accessibilityRole="button"
        accessibilityLabel={label}
        radius={PLATE / 2}
        // Lighter than the default wash: the plate is already a light surface, and
        // the default tint turns it grey-on-grey.
        tint="rgba(255,255,255,0.16)"
        hitSlop={8}
        style={[
          styles.plate,
          { backgroundColor: color.accent.muted, borderColor: color.border.muted },
        ]}
      >
        <AppIcon name="back" size={20} color={color.text.primary} strokeWidth={2.25} />
      </RoundedPressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  plate: {
    width: PLATE,
    height: PLATE,
    borderRadius: PLATE / 2,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    // Nudged left so the CHEVRON, not the plate's box, lines up with the screen's
    // text gutter — a centred glyph inside a centred plate always looks indented.
    transform: [{ translateX: -2 }],
  },
});
