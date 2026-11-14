// "Focus the search field" as a message from one screen to another.
//
// WHY A STORE AND NOT A CALLBACK: the thing you tap lives in `NavBar`, which
// every screen in this app renders, and the thing that has to respond is one
// `TextInput` on the search tab, which only exists while that tab is mounted.
// There is no import path from the first to the second — and threading one
// through six screens would mean every screen in the app having to know that
// search exists.
//
// A COUNTER, NOT A BOOLEAN, because the two cases are genuinely different:
//
//   - tapping search from ANOTHER tab: the request is made before the search
//     screen is focused, and the tab has to act on it once it IS on top. Tab
//     focus is the only reliable signal for that.
//   - tapping search while ALREADY on the tab: the tab never re-focuses, so
//     `useFocusEffect` will not run again and only a subscription catches it.
//
// Both readers call `takeSearchFocus()`, so whichever one runs first consumes
// the request. A request is never dropped, and never handled twice.
//
// `useSyncExternalStore`, like the settings store, rather than a Context
// provider: exactly one component subscribes, and a provider would re-render
// every consumer for a value read in one place.

/** Increments on every request. Also the subscription's change signal. */
let issued = 0;
/** The highest token a reader has already acted on. */
let acted = 0;

const listeners = new Set<() => void>();

/** Ask the search field to take the caret. Notifies subscribers immediately. */
export function requestSearchFocus(): void {
  issued++;
  for (const listener of listeners) listener();
}

/**
 * Consume a pending request, if there is one.
 *
 * Returns the token that was handled, or `null` when nothing is outstanding.
 * `null` rather than `false` so that two taps in a row are two requests — a
 * boolean flag set by a reader that another reader then cleared would collapse
 * them into one.
 */
export function takeSearchFocus(): number | null {
  if (issued === acted) return null;
  acted = issued;
  return issued;
}

/**
 * The current token WITHOUT consuming it — the snapshot
 * `useSyncExternalStore` needs. It must not mutate, or React's store check
 * never settles.
 */
export function peekSearchFocus(): number {
  return issued;
}

/** Subscribe to requests. Returns the unsubscribe, so identity is stable. */
export function subscribeSearchFocus(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}