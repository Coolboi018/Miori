// "Am I the focused screen?", answered WITHOUT causing a re-render.
//
// WHY THIS FILE EXISTS. Every component that wanted to know whether its screen
// was visible was doing it with `useState` inside a `useFocusEffect`. That is the
// obvious way to write it and it is a trap, because `setState` on a focus change
// IS a re-render. So every tap of the tab bar was re-rendering, among other
// things:
//
//   - the home hero: two `expo-linear-gradient` views, an SVG `GradientText`, and
//     eight `Dissolve` wrappers each holding an `Animated.Value`
//   - the explore hero: the same, because explore also mounts one
//   - the schedule screen's ~300-cell list
//
// …in order to flip a boolean that only a `setTimeout` and an `interval` callback
// ever read. That is the tab-switch latency, and it is invisible on the web only
// because a backgrounded DOM is nearly free to diff.
//
// `navigation.isFocused()` is a plain synchronous call that reads current state
// and subscribes to nothing, so asking it inside a timer callback costs one
// function call and produces no render. That is the whole mechanism.
//
// WHY NOT A REF SET BY `useFocusEffect`. It was tried, and it has a bug that only
// appears with `lazy: false`: a tab that is mounted but never focused NEVER fires
// the focus event, so its ref keeps whatever it was initialised to. Initialise it
// `true` and every background tab's carousel autoplays forever; initialise it
// `false` and you are depending on the focus event firing for the initial route.
// Reading `isFocused()` at the moment of use has neither problem — it is always
// the truth, with no state to get stale.
//
// **The rule this exists to enforce: a tab switch must not cause a render.**
// Data is already cached and the view trees are already built, so the correct
// amount of work to do when focus moves is none.

import { useCallback } from 'react';
import { useNavigation } from 'expo-router';

/**
 * A live focus check, safe to call from a timer or an event callback.
 *
 * Returns a function rather than a boolean ON PURPOSE. A boolean would have to be
 * stored in state to stay current, and state is a render. This reads at the
 * instant it is asked.
 *
 * The function is `useCallback`'d, and that is not cosmetic: callers list it in
 * effect dependencies (`useNow` arms its interval on it), so a fresh closure
 * every render would tear down and re-arm a timer on every render of the
 * screen — the same churn this file exists to prevent, just on a smaller
 * dial. `useNavigation`'s object is stable for the life of the screen, so one
 * dependency gives one stable identity.
 */
export function useIsFocusedNow(): () => boolean {
  const navigation = useNavigation();
  return useCallback(() => navigation.isFocused(), [navigation]);
}
