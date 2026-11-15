// Top bar — DECONSTRUCTED. No bar, no pill: the controls float directly on
// content, each with its own small circular plate.
//
// WHY: the old design was a full-width translucent pill ("app bar"), which
// fought the immersive home hero (full-bleed art melting into the page) and
// mirrored the floating tab pill at the bottom — two lozenges framing the
// screen like a bumper. The controls never needed a shared container; only
// the avatar/search/settings tappable circles do, and those get their own
// plates. Art now reaches the top edge of the screen, streaming-app style.
//
// The plates are solid translucent fills, NOT blur — same reasoning as ever
// (expo-blur's tint path is the low-end killer, see plan.md). Fixed at their
// translucent rest value: a scroll-linked fade was tried and reverted — it
// coupled every tab screen to the bar for a subtlety not worth the wiring.
//
// PERFORMANCE: four pressables + one plain View. No gradients, no shadows,
// no elevation, no scroll listeners. Press feedback is `RoundedPressable`'s
// rounded wash rather than an Android ripple: clipping a ripple to these
// circles depended on platform outline clipping, and on device it showed as a
// square highlight on a round button.

import { Image } from 'expo-image';
import { useFocusEffect, useRouter } from 'expo-router';
import { pushOnce } from '@/lib/nav/pushOnce';
import { memo, useCallback, useState } from 'react';
import { Alert, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { font, layout, spacing } from '@/lib/ui/tokens';
import { AppIcon } from '@/components/ui/AppIcon';
import { RoundedPressable } from '@/components/ui/RoundedPressable';
import { alpha } from '@/lib/ui/color';
import { useTheme } from '@/lib/ui/useTheme';
import { useViewer } from '@/lib/auth/queries';
import { requestSearchFocus } from '@/lib/search/focus';
import { SearchOmnibox } from './SearchOmnibox';

/**
 * The row height is `layout.navbarRowHeight`, and it deliberately does NOT live
 * here. The search omnibox builds a row from the same number and this component
 * RENDERS the omnibox — so exporting the constant from here made
 * `NavBar → SearchOmnibox → NavBar`, a require cycle. `tokens.ts` imports
 * nothing, so it can never be part of one.
 */

/** Space screens must leave above their scroll content for the controls. */
export function useNavOffset(): number {
  const insets = useSafeAreaInsets();
  return insets.top + spacing.sm + layout.navbarRowHeight + spacing.sm;
}

export interface NavBarProps {
  title?: string;
  avatarUrl?: string | null;
  onProfile?: () => void;
  onSearch?: () => void;
  /** Overrides the default bell behaviour (see `onNotify` below). */
  onNotify?: () => void;
  onSettings?: () => void;
  /**
   * This screen IS the search screen, so the button focuses the field already on
   * screen instead of expanding the omnibox.
   *
   * A prop rather than a `usePathname()` comparison INSIDE this component,
   * deliberately: every screen renders a NavBar, and `usePathname` re-renders
   * all of them on every navigation — thirty-odd SVG icons' worth, per tab tap.
   * See the note on `onSearchPress` below.
   */
  isSearchTab?: boolean;
}

export const NavBar = memo(function NavBar({
  title,
  avatarUrl,
  onProfile,
  onSearch,
  onNotify: onNotifyProp,
  onSettings,
  isSearchTab = false,
}: NavBarProps) {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { color } = useTheme();
  const { viewer } = useViewer();
  const resolvedAvatar = avatarUrl ?? viewer?.avatar?.large ?? viewer?.avatar?.medium ?? null;

  const go = useCallback(
    (path: string, fn?: () => void) => () => {
      if (fn) return fn();
      pushOnce(path);
    },
    []
  );

  /**
   * THE SEARCH BUTTON, and it does one of two things.
   *
   * `isSearchTab` is a PROP rather than a `usePathname()` comparison, and that is
   * not a style choice — it was the tab-switch latency.
   *
   * Every screen in the app renders a `NavBar`. `usePathname()` subscribes to the
   * navigation state, so when the path changes EVERY mounted screen's NavBar
   * re-renders, even the ones not involved in the navigation. With every tab
   * mounted (see `lazy: false`) that is five NavBars × four Pressables + an
   * avatar + three SVG `AppIcon`s — roughly thirty-five SVG path renders on every
   * single tap of the tab bar, on top of everything else the switch does.
   *
   * The search screen already knows it is the search screen, so it says so. The
   * bar needs no opinion about routing at all, which is also why it can stay
   * `memo`'d and genuinely not re-render.
   */
  const [expanded, setExpanded] = useState(false);
  // Stable identity: `SearchOmnibox` registers a back-button handler and a
  // keyboard listener keyed on this, and a fresh arrow each render would
  // re-register both on every render of the omnibox.
  const closeOmnibox = useCallback(() => setExpanded(false), []);

  const onSearchPress = useCallback(() => {
    if (onSearch) return onSearch();
    if (isSearchTab) {
      requestSearchFocus();
      return;
    }
    setExpanded(true);
  }, [onSearch, isSearchTab]);

  /**
   * Hand the omnibox's query to the full search page.
   *
   * `push` with a param, not a module-level store: the query then survives a
   * process death and a deep link, and Back returns the user to wherever they
   * started searching rather than to the search tab. The request the page makes
   * next is free — see `SearchOmnibox`'s note on `perPage`.
   */
  const commitSearch = useCallback(
    (q: string) => {
      setExpanded(false);
      router.push({ pathname: '/(tabs)/search', params: { q } });
    },
    [router]
  );

  /**
   * COLLAPSE ON BLUR. Not an optimisation — a correctness fix.
   *
   * Tabs stay mounted once visited, so an expanded bar on a screen the user has
   * navigated away from would keep its `TextInput` focused and its keyboard
   * listener attached, holding a keyboard open over a screen that is no longer
   * visible. The cleanup returned by `useFocusEffect` runs on blur, which is
   * the one signal that covers both a tab switch and a stack navigation.
   */
  useFocusEffect(
    useCallback(() => () => setExpanded(false), [])
  );

  /**
   * THE BELL. A placeholder, and an honest one.
   *
   * Nothing in the app emits notifications yet — airing reminders are still an
   * open item in progress.md. A button that silently does nothing is worse than
   * no button at all, so it says what it is. When the feature lands this is the
   * only line that changes.
   *
   * Declared ABOVE the `expanded` branch below because hooks cannot be
   * conditional: the early return would skip this one on exactly the renders
   * where the bar is replaced by the omnibox, and the hook order would change
   * between renders of the same component.
   */
  const onNotify = useCallback(() => {
    if (onNotifyProp) return onNotifyProp();
    Alert.alert('Notifications', 'Airing reminders are not built yet — they are next on the list.', [
      { text: 'OK' },
    ]);
  }, [onNotifyProp]);

  // Every hook has run — safe to branch now.
  if (expanded) {
    return <SearchOmnibox onClose={closeOmnibox} onCommit={commitSearch} />;
  }

  // The plate fill: white wash over art on dark theme, dark wash on light.
  // alpha() of the theme's own surface colour — same trick the scrims use.
  const plate = alpha(color.bg.primary, 0.45);
  const plateBorder = alpha(color.text.primary, 0.14);

  return (
    <View
      pointerEvents="box-none"
      style={[styles.bar, { paddingTop: insets.top + spacing.sm }]}
    >
      {title ? (
        <Text style={[styles.title, { color: color.text.primary }]} numberOfLines={1}>
          {title}
        </Text>
      ) : null}

      {/* Avatar — the identity anchor. Larger than the icon buttons.
          Shown only on the home screen (no title); other screens show their title. */}
      {!title ? (
        <RoundedPressable
          onPress={go('/profile', onProfile)}
          accessibilityRole="button"
          accessibilityLabel="Profile"
          hitSlop={6}
          radius={24}
          tint={alpha(color.text.primary, 0.16)}
          style={[styles.avatarBtn, { backgroundColor: plate, borderColor: 'rgba(255,255,255,0.7)' }]}
        >
        {resolvedAvatar ? (
        <Image
          source={{ uri: resolvedAvatar }}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
          cachePolicy="memory-disk"
        />
      ) : (
        <Text style={[styles.avatarInitial, { color: color.text.primary }]}>M</Text>
      )}
        </RoundedPressable>
      ) : null}

      {/* Reserves the width the title would have taken, whether or not there is
          a title. Without this the avatar slides right on screens that pass a
          title ("Explore") and sits at the gutter on those that do not (home) —
          the anchor moved for a reason nobody can see. */}
      <View style={styles.spacer} />

      {/* Icon buttons — identical 40px circles, ripple clipped to the circle. */}
      <RoundedPressable
        onPress={onSearchPress}
        accessibilityRole="button"
        accessibilityLabel="Search"
        hitSlop={6}
        radius={20}
        tint={alpha(color.text.primary, 0.14)}
        style={[styles.iconBtn, { backgroundColor: plate, borderColor: plateBorder }]}
      >
        <AppIcon name="search" size={19} color={color.text.primary} />
      </RoundedPressable>

      {/* Notifications. A PLACEHOLDER — nothing in the app emits them yet (the
          airing-notifications item is still open in progress.md). It says so
          rather than silently doing nothing, which is the only honest thing a
          dead chrome button can do until the feature lands. Swap the body of
          `onNotify` and nothing else. */}
      <RoundedPressable
          onPress={onNotify}
          accessibilityRole="button"
          accessibilityLabel="Notifications"
          hitSlop={6}
          radius={20}
          tint={alpha(color.text.primary, 0.14)}
          style={[styles.iconBtn, { backgroundColor: plate, borderColor: plateBorder }]}
        >
          <AppIcon name="bell" size={18} color={color.text.primary} />
        </RoundedPressable>

      <RoundedPressable
        onPress={go('/settings', onSettings)}
        accessibilityRole="button"
        accessibilityLabel="Settings"
        hitSlop={6}
        radius={20}
        tint={alpha(color.text.primary, 0.14)}
        style={[styles.iconBtn, { backgroundColor: plate, borderColor: plateBorder }]}
      >
        <AppIcon name="settings" size={19} color={color.text.primary} />
      </RoundedPressable>
    </View>
  );
});

const styles = StyleSheet.create({
  bar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 10,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
  },
  title: {
    fontSize: 22,
    fontFamily: font.bold,
    letterSpacing: -0.4,
    flexShrink: 1,
    marginRight: spacing.sm,
  },
  spacer: { flex: 1 },
  avatarBtn: {
    width: 48,
    height: 48,
    borderRadius: 24,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
  },
  avatarInitial: { fontSize: 16, fontFamily: font.bold },
  iconBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    marginLeft: spacing.sm,
    overflow: 'hidden',
  },
});
