// The signed-out gate — shown instead of the list editor when there is no account.
//
// WHY THIS EXISTS RATHER THAN AN `Alert`. An `Alert` was what this used, and it is
// the wrong tool three separate ways. It is styled by the OS, so on one phone it
// is a centred iOS-looking box and on the next a Material dialog, and neither
// looks like the app it interrupted. It cannot say WHICH title the gesture was
// about, because it only ever got a fixed string. And it cannot carry the title's
// name into the reason for asking — which is the whole reason the interruption
// happened, and the thing worth explaining.
//
// The copy names the title because the host already has it. Someone who
// long-pressed one tile and got a generic "sign in?" has to work out which of the
// forty tiles on screen did it. Naming it costs nothing and removes the guess.
//
// WHY A CENTRED CARD AND NOT A BOTTOM SHEET. The house pattern for anything with
// controls in it is a sheet (`ListEntrySheet`, `FilterDropdown`), and this is
// deliberately the other thing. A sheet says "here is a form, fill it in"; this is
// a gate on one action with one question and two answers, and it should not look
// like the editor it is replacing. A person who long-pressed a tile, saw the
// editor, and was then asked to sign in would be right to wonder whether the
// editor had failed. Making it a different shape answers that before it is asked.
// The body copy also says the list lives on AniList, so it is clear the editor is
// not broken — it has nowhere to write.
//
// THE SHEET IS NEVER MOUNTED BEHIND THIS. `ListSheetHost` gates the editor's
// `visible` on the same flag that shows this, so there is no flash of the editor
// on the way in and no editor to dismiss on the way out.
//
// NO SWIPE. A bottom sheet is dismissed by pulling it down because it has a
// handle and a direction it can leave in. A centred card has neither, so the
// gesture that would mean something — drag it off the bottom — would also look
// broken halfway. Tapping the scrim is the dismissal, which is the convention for
// dialogs of this kind.

import { useCallback, useEffect } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/lib/ui/useTheme';
import { font, motion, radii, spacing } from '@/lib/ui/tokens';
import { AppIcon } from './AppIcon';

export function SignInGate({
  visible,
  title,
  onClose,
  onSignIn,
}: {
  visible: boolean;
  /** The title the gesture was about, or null when it is not known. */
  title?: string | null;
  onClose: () => void;
  /** Handed the tap on the primary action. Navigation lives in the host. */
  onSignIn: () => void;
}) {
  const { color } = useTheme();
  const insets = useSafeAreaInsets();
  const progress = useSharedValue(0);

  useEffect(() => {
    if (visible) progress.value = withTiming(1, { duration: motion.normal });
  }, [visible, progress]);

  /**
   * ANIMATE OUT BEFORE UNMOUNTING, or the card is cut off mid-flight and reads as
   * a glitch rather than as a dismissal. `onRequestClose` (the hardware back
   * button) routes here too, so back does the same thing the scrim does.
   */
  const dismiss = useCallback(() => {
    progress.value = withTiming(0, { duration: motion.fast }, (finished) => {
      if (finished) runOnJS(onClose)();
    });
  }, [progress, onClose]);

  const scrimStyle = useAnimatedStyle(() => ({ opacity: progress.value }));

  /**
   * SCALE AND FADE, NOT A SLIDE.
   *
   * A slide would be the sheet's entrance and would make this read as the same
   * component twice. Scaling up from 94% is the smaller, closer gesture that
   * matches what it is: something appearing in front of you rather than arriving
   * from somewhere.
   */
  const cardStyle = useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [{ scale: 0.94 + progress.value * 0.06 }],
  }));

  const signIn = useCallback(() => {
    // Straight to the action. The card does not fade out first: navigating away
    // from under a still-visible dialog would leave it on screen for a frame
    // behind the login route, and the host unmounts it as soon as the target
    // clears.
    onSignIn();
  }, [onSignIn]);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="none"
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={dismiss}
    >
      <View style={styles.root}>
        <Animated.View
          style={[StyleSheet.absoluteFill, { backgroundColor: color.bg.overlay }, scrimStyle]}
        >
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={dismiss}
            accessibilityRole="button"
            accessibilityLabel="Dismiss"
          />
        </Animated.View>

        <Animated.View
          accessibilityViewIsModal
          style={[
            styles.card,
            {
              backgroundColor: color.bg.elevated,
              borderColor: color.border.muted,
              marginBottom: insets.bottom,
            },
            cardStyle,
          ]}
        >
          {/* The icon is the first thing read and it says what kind of thing this
              is before any text is parsed. Tinted with the accent rather than
              filled, so it does not out-weigh the title underneath it. */}
          <View style={[styles.iconWell, { backgroundColor: color.accent.muted }]}>
            <AppIcon name="account" size={24} color={color.accent.base} />
          </View>

          <View style={styles.headText}>
            <Text style={[styles.kicker, { color: color.text.muted }]}>ANILIST</Text>
            <Text style={[styles.title, { color: color.text.primary }]}>
              {title ? `Sign in to add ${title}` : 'Sign in to use your list'}
            </Text>
            <Text style={[styles.body, { color: color.text.secondary }]}>
              Your progress, score and status are stored on your AniList account, so
              they follow you to any other app that reads it.
            </Text>
          </View>

          <View style={[styles.actions, { marginBottom: insets.bottom ? 0 : spacing.lg }]}>
            {/* Full width and filled: there is exactly one thing this dialog is
                for, and a half-width primary next to a secondary is the layout of
                a choice rather than of a gate. */}
            <Pressable
              onPress={signIn}
              accessibilityRole="button"
              accessibilityLabel="Sign in with AniList"
              style={({ pressed }) => [
                styles.primary,
                { backgroundColor: color.accent.base, opacity: pressed ? 0.85 : 1 },
              ]}
            >
              <Text style={[styles.primaryText, { color: color.bg.primary }]}>Sign in</Text>
            </Pressable>

            {/* A text button, not an outlined one. An outlined secondary beside a
                filled primary gives "Not now" the same visual weight as the
                decision that matters, and people dismiss these dialogs far more
                often than they act on them. */}
            <Pressable
              onPress={dismiss}
              accessibilityRole="button"
              accessibilityLabel="Not now"
              hitSlop={8}
              style={({ pressed }) => [styles.secondary, { opacity: pressed ? 0.6 : 1 }]}
            >
              <Text style={[styles.secondaryText, { color: color.text.secondary }]}>Not now</Text>
            </Pressable>
          </View>
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
  },
  card: {
    width: '100%',
    // A dialog on a 600pt-wide tablet should not stretch to the full width of the
    // window — a centred card with a cap is what makes it read as a dialog rather
    // than as a panel.
    maxWidth: 380,
    borderRadius: radii.xl + 4,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.xl,
    paddingBottom: spacing.lg,
    gap: spacing.lg,
  },
  iconWell: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignSelf: 'center',
    alignItems: 'center',
    justifyContent: 'center',
  },
  headText: { gap: spacing.xs },
  kicker: {
    fontSize: 10,
    fontFamily: font.bold,
    letterSpacing: 1.6,
    textAlign: 'center',
  },
  title: {
    fontSize: 19,
    fontFamily: font.semibold,
    lineHeight: 25,
    textAlign: 'center',
  },
  body: {
    fontSize: 13,
    fontFamily: font.regular,
    lineHeight: 19,
    textAlign: 'center',
    marginTop: 2,
  },
  actions: { gap: spacing.sm },
  primary: {
    height: 50,
    borderRadius: radii.full,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryText: { fontSize: 15.5, fontFamily: font.bold, letterSpacing: 0.2 },
  secondary: { height: 44, alignItems: 'center', justifyContent: 'center' },
  secondaryText: { fontSize: 14, fontFamily: font.medium },
});