import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { layout, spacing } from './tokens';

/**
 * Bottom padding for scrollable content inside the tabs.
 *
 * The tab bar is a floating pill positioned with `position: absolute`, so it
 * overlays the content instead of reserving layout space for it — this is the
 * documented requirement for that pattern. Every tab screen must clear it or
 * its last row sits under the pill.
 *
 * Derived from `layout.tabBarHeight`, the same token `app/(tabs)/_layout.tsx`
 * sets on `tabBarStyle`, plus the bottom safe-area inset and a little breathing
 * room. Computing it from the token rather than from `useBottomTabBarHeight()`
 * keeps it in sync by construction, and avoids importing from
 * `expo-router/build/react-navigation/...`, which is not a public entry point.
 */
export function useTabBarClearance(extra = 0): number {
  const { bottom } = useSafeAreaInsets();
  return (
    layout.tabBarTopGap +
    layout.tabBarHeight +
    layout.tabBarBottomGap +
    bottom +
    spacing.lg +
    extra
  );
}
