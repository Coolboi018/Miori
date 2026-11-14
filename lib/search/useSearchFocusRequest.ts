// The search screen's side of the focus request — see `./focus.ts` for why this
// is a message rather than a direct call.
//
// Two readers, because a request can arrive at two moments and neither reader
// alone covers both:
//
//   1. `useFocusEffect` — the request was made while the user sat on ANOTHER
//      tab. React Navigation keeps that tab mounted once visited, so the field
//      already exists but is not on screen. Only the focus callback is
//      guaranteed to run AFTER the screen is actually showing, which is exactly
//      when a keyboard should be allowed to appear.
//
//   2. `useEffect` on the token — the request was made while the user was
//      ALREADY on the search tab. Nothing re-focuses and nothing re-navigates,
//      so no focus callback fires at all. Without this reader the search button
//      would feel dead on the one screen it exists to serve.
//
// They share `takeSearchFocus()`, so whichever fires first consumes the request
// and the other is a no-op. The order between them is deliberately left
// unspecified: it does not matter, and pinning an order would be a claim about
// when the tab becomes visible that this hook cannot actually make.

import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { useFocusEffect } from 'expo-router';
import { peekSearchFocus, subscribeSearchFocus, takeSearchFocus } from './focus';

/**
 * Call `onFocusRequest` whenever something asks the search field to take the
 * caret — on arrival at the screen, or while it is already showing.
 *
 * `onFocusRequest` MUST be stable (wrap it in `useCallback`). Both readers
 * depend on it, and an inline arrow would re-run the focus reader on every
 * render of the search screen, yanking the caret back mid-typing.
 */
export function useSearchFocusRequest(onFocusRequest: () => void): void {
  const token = useSyncExternalStore(
    subscribeSearchFocus,
    peekSearchFocus,
    // Server snapshot. Nothing can have been requested before hydration.
    () => 0
  );

  const claim = useCallback(() => {
    if (takeSearchFocus() !== null) onFocusRequest();
  }, [onFocusRequest]);

  // Already on the tab. `token` is the signal; the claim is what does the work.
  // Wrapped rather than passed as `useEffect(claim, …)` because this returns
  // the RESULT of that call (a cleanup or undefined) as its own return value,
  // and an effect that returns something is a bug React will eventually catch.
  useEffect(() => {
    claim();
  }, [claim, token]);

  // Arriving from another tab.
  useFocusEffect(claim);
}