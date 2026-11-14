// Build the other tabs' view trees during idle, so a tab tap is a z-index
// change and nothing else.
//
// THE PROBLEM THIS SOLVES. React commits BEFORE the navigator animates. A tab
// screen that has never been rendered has to be rendered first, and that render
// runs to completion before the switch animation gets a frame — so the sequence
// on a cold tab is:
//
//   tap → [React builds the whole screen] → slide starts → done
//
// and the bracket is dead time the user reads as the app hanging. There is no
// way to start the animation earlier: the scene has to exist before there is
// anything to animate. The only fix is for it to already exist.
//
// WHY NOT `lazy: false`. That was the previous answer and it works, but it pays
// the cost at the WRONG MOMENT — every tab's tree is built before the first
// paint, so five heavy screens sit in front of the launch the user is actually
// waiting for. Preloading moves the same work to the idle window after it, which
// is the difference between a slow launch and a fast one that also has warm
// tabs.
//
// WHAT `preload` ACTUALLY DOES. `TabRouter` records the route in
// `preloadedRouteKeys`, and `BottomTabView` renders a lazy screen whose key is
// in that list even though it is not focused and has never been visited. Nothing
// more. When the tab is later focused the key moves into `loaded` — which only
// ever accumulates — so the component instance is the same one and there is no
// second mount. Tapping a preloaded tab does not remount anything.
//
// ONE TAB PER IDLE SLOT, NOT FOUR AT ONCE — AND WITH A GAP BESIDE IT, because one
// per idle slot was not enough on its own. The work is identical; only the
// scheduling differs, and scheduling is the whole point. Four heavy screens in one
// callback is the same lump this file exists to break up, merely relocated to a
// moment where the user happens to be looking at something else.
//
// WHY AN IDLE SLOT WAS NOT ENOUGH. `whenIdle` returns the moment the event loop
// drains, and after a screen mounts the loop drains almost immediately — the React
// render is the synchronous part and it is already finished. But it is not the
// only part. Mounting a screen asks the UI thread to create, measure and first-paint
// a whole tree, and none of that is on the JS thread, so none of it holds the event
// loop. So the second tab was being mounted while the first one's native work was
// still in flight: three mounts spread over a handful of frames, which the loop
// reports as idle throughout. The result was a launch that painted cleanly and then
// spent the next second or so stuttering, which reads worse than one slow frame.
//
// So there is now a real gap as well as the idle wait, and the gap is the part that
// does the work: each mount is asked for only after a settled stretch in which
// nothing was supposed to happen. See `settleMs` in `whenIdle.ts` for why a timer is
// the right tool for that and the exact opposite of the usual objection to one.
//
// The gap applies to the FIRST tab too, not just between them. The first slot is
// reached while the home screen is still settling from its own mount — the same
// competition `lib/query/prefetch.ts` defers for and says so — so it gets the same
// courtesy.
//
// NOT `freezeOnBlur`. Suspending an unfocused tab's renders makes it cheaper in
// the background and much more expensive at the moment it is tapped, which is
// backwards. See `app/_layout.tsx` for the measurement.
//
// WHY A HOOK CALLED FROM THE HOME SCREEN, RATHER THAN A CHILD OF `<Tabs>`. A
// navigator accepts only `Screen`, `Group` and `Fragment` as direct children and
// throws on anything else, so there is nowhere inside `<Tabs>` to hang a
// component that could reach its navigation object. Home is the initial route,
// so it is mounted before anyone can tap anything, and it is the one screen
// guaranteed to exist for the whole session.

import { useEffect } from 'react';
import { useNavigation } from 'expo-router';
// Deep import for the same reason `app/(tabs)/_layout.tsx` reaches into the
// package for `BottomTabNavigationOptions`: it is not re-exported from the
// package index, and `useNavigation`'s default generic cannot be relied on to
// name these routes — see the note on `preload` below.
import type { NavigationProp } from 'expo-router/build/react-navigation/core/types';

import { whenIdle } from './whenIdle';

/**
 * Which tabs to build, in the order worth building them.
 *
 * MUST MATCH the routes declared in `app/(tabs)/_layout.tsx`; `three` is
 * deliberately absent because it is the dev probe and is not shipped. There is
 * no way to derive this list from the navigator — the navigator's own state
 * carries every declared route, including one hidden with `href: null`, so
 * reading it would warm a screen that does not exist in a release build.
 *
 * Order is heaviest-and-most-tapped first, so that if the user interrupts the
 * sequence the tab they were most likely to reach is the one that is ready.
 * Explore and Schedule are the two heavy ones; Search has no AniList data at all
 * and is last because there is nothing to wait for.
 */
const WARM_ORDER = ['explore', 'schedule', 'search'] as const;

/**
 * QUIET REQUIRED BEFORE EACH MOUNT. See the note on the gap above.
 *
 * HALF A SECOND is a judgement, and both sides of it are real. Too short and the
 * three mounts blur back into the burst this file exists to avoid; too long and the
 * last tab is still cold when a user who went straight for it taps it, which trades
 * a stutter for the dead-time bracket at the top — a strictly worse bargain, since
 * the bracket is something the user WAITS on and the stutter is something they
 * might not notice.
 *
 * 500ms puts the three mounts at roughly 0.5s, 1.3s and 2.1s after launch: the
 * whole warm-up lives inside the window where someone is still deciding which tab
 * they want, and no two mounts share a frame budget. If this ever wants to move,
 * this is the one number to change — nothing else in the sequence depends on it.
 */
const MOUNT_GAP_MS = 500;

/**
 * The same names as a ParamList, which is the only thing that makes
 * `navigation.preload` callable at all.
 *
 * `useNavigation()` without a generic resolves to
 * `NavigationProp<ReactNavigation.RootParamList>`, and expo-router declares that
 * as `{}` for any project without generated route types — this one has no
 * `.expo/types/router.d.ts`. `keyof {}` is `never`, so `preload`'s
 * `RouteName extends keyof ParamList` resolves to `never` and its rest parameter
 * collapses to `never`, which accepts nothing.
 *
 * The alternative is turning on `experiments.typedRoutes` and letting expo-router
 * generate a real `RootParamList`. That is the better fix and it is not taken
 * here because it re-types the whole app's navigation surface, which is a
 * review of its own and not something to smuggle into a performance change.
 */
type TabsParamList = { [K in (typeof WARM_ORDER)[number]]: undefined };

/**
 * `navigation.preload(name)`, with the two things that stop that expression from
 * compiling spent in one place.
 *
 * `preload`'s rest parameter is a DISTRIBUTIVE conditional over `RouteName`, so a
 * union of three route names distributes into a union of three tuple types — and
 * a rest parameter typed as a union of tuples cannot be applied to arguments at
 * all. `queue.shift()` hands over the whole union in one go, which is exactly
 * the case the signature cannot express.
 *
 * Module scope so it is the same function object every render, which keeps it
 * out of the effect's dependency list.
 */
function preloadTab(
  navigation: NavigationProp<TabsParamList>,
  screen: keyof TabsParamList
): void {
  (navigation.preload as (name: keyof TabsParamList) => void)(screen);
}

/**
 * HAS THE USER ALREADY BEEN TO THIS TAB?
 *
 * Because they quite possibly got there first, and the queue cannot know that.
 * `WARM_ORDER` is fixed when the effect runs, so a user who taps Explore 150ms
 * after launch — which is exactly what someone who opened this app to look at
 * something specific does — would otherwise have the first slot spent on a tab
 * that is already mounted and already paid for. Re-reading the navigator at each
 * step costs one array walk and removes that.
 *
 * WHY `state.routes` CANNOT ANSWER THIS. `TabRouter` builds one entry per
 * DECLARED route from boot (`getRehydratedState` maps over `routeNames`), so every
 * tab is in `state.routes` before the user has looked at any of them. That list
 * answers "does this tab exist", which is the question the note on `WARM_ORDER`
 * already had to ask, and it cannot answer "has it been visited".
 *
 * WHY `state.history` CAN. `changeIndex` unshifts a `{type: 'route', key}` entry
 * every time a tab takes focus, so history is the visited set and grows only on
 * real navigation. The comparison is by KEY rather than by name because history
 * stores keys, and a name would first need resolving against the route that owns
 * it.
 *
 * THE `unknown[]` IS DELIBERATE on react-navigation's side — history is declared
 * as "alternative entries", because a drawer puts non-route things in it — so the
 * narrowing below is the honest way to read it rather than a guess about the shape.
 * Anything unrecognised is treated as "not visited", which fails towards mounting
 * a tab we did not need to, which is the cheap direction to fail in.
 */
function alreadyVisited(
  navigation: NavigationProp<TabsParamList>,
  name: keyof TabsParamList
): boolean {
  const state = navigation.getState();
  const route = state.routes.find((r) => r.name === name);
  if (route == null) return false;
  // `history` is optional on the type and genuinely absent before the first focus
  // change is recorded, which is the same answer as "nothing visited yet".
  return (state.history ?? []).some(
    (entry) =>
      typeof entry === 'object' &&
      entry !== null &&
      (entry as { type?: unknown }).type === 'route' &&
      (entry as { key?: unknown }).key === route.key
  );
}

/**
 * Preload the other tabs, one per idle slot and one per gap, once.
 *
 * Idempotent in effect if not in type: `preload` on an already-preloaded route is a
 * no-op in `TabRouter` — it filters the key out of `preloadedRouteKeys` before
 * re-adding it — and a tab that has since been visited is in `history`, which
 * `alreadyVisited` now catches before the dispatch rather than after. The effect is
 * keyed on `navigation` alone, which is stable for the life of the screen, so it
 * does not re-run on a re-render.
 *
 * The gap is not a cancellation problem. A `setTimeout` left pending by an unmount
 * still fires, and then `step` drops the work on `cancelled` — which is why the
 * guard sits at the top of `step` rather than at the call sites.
 */
export function usePreloadTabs(): void {
  const navigation = useNavigation<NavigationProp<TabsParamList>>();

  useEffect(() => {
    let cancelled = false;
    const queue = [...WARM_ORDER];

    const step = (): void => {
      if (cancelled) return;

      // Drop whatever the user reached on their own before this slot came up. A
      // skip costs nothing — there is no mount behind it — so it must not consume
      // a gap either, hence the loop rather than a single test.
      while (queue.length > 0 && alreadyVisited(navigation, queue[0])) {
        queue.shift();
      }

      const name = queue.shift();
      if (name == null) return;
      preloadTab(navigation, name);
      // Chain rather than loop, so the next mount waits for its own drained frame
      // AND its own settled stretch, rather than joining this one's.
      if (queue.length > 0) whenIdle(step, { settleMs: MOUNT_GAP_MS });
    };

    whenIdle(step, { settleMs: MOUNT_GAP_MS });

    return () => {
      // Unmounting before the queue drains — a fast reload, a test — should stop
      // it rather than dispatch into a navigator that is going away.
      cancelled = true;
    };
  }, [navigation]);
}