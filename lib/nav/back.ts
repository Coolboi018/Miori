// Going back, when there may be nothing to go back to.
//
// `router.back()` on a native stack is a dead tap with a complaint attached: when
// the current screen is the ROOT of its navigator, expo-router raises
//
//     The action 'GO_BACK' was not handled by any navigator.
//
// which is a red box in development and nothing at all in a release build. Every
// way into Settings can produce that state — a cold start on a `miori://settings`
// link, a `router.replace` into the screen, a notification that opens a settings
// page directly — and the back plate is the only way OUT of a settings page: the
// detail pages have no header, and `app/settings/_layout.tsx` sets
// `headerShown: false` for all of them. So the one control that can leave the
// screen must never be the one that throws.
//
// The rule is the player's (`PlayerScreen.onBack`), moved here so there is one
// copy of it: ASK FIRST, then replace with a real destination. `replace`, not
// `push` — arriving at the tabs should not leave the settings page behind it for
// the next Back press to find.
//
// NOT a `useRouter()` hook: this is a plain call, and the call sites already sit
// inside components that would only be threading the same object through.

import { router, type Href } from 'expo-router';

export function goBack(fallback: Href = '/(tabs)'): void {
  if (router.canGoBack?.()) {
    router.back();
    return;
  }
  router.replace(fallback);
}
