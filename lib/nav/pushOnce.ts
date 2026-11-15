// One guarded `push`, and the one place a screen is opened from.
//
// WHY THIS EXISTS. The root stack is a NATIVE stack, and `router.push` on a
// native stack does exactly what it says: it pushes another screen. It has no
// opinion about whether the screen you are pushing is already there. So when
// the device lags — a cold cache, a rail mid-layout, a JS thread busy with the
// query that is painting the tap target — the tap does not feel registered,
// the user taps again, and again, and the app obliges:
//
//     Home → Anime → Anime → Anime → Anime
//
// Four screens for one intention, and the user has to press Back four times to
// undo one tap. This is not a rate limit on navigation; it is the same class of
// bug as the favourite button's, except the favourite button corrupts a public
// counter and this one just traps you in your own history.
//
// ⚠️ WHY IT IS A MODULE AND NOT A `useRef`. A `useRef` in the tile would guard
// exactly one tile, and the report is not one tile misbehaving — it is six
// screens' worth of tiles, each holding its own ref, each pushing on every tap.
// Module scope is the same reason `listSheet`, `characterSheet` and
// `favouritePacing` are modules in this codebase: the state that has to be
// shared is shared by construction, not by remembering to thread it through.
//
// TWO RULES, AND THEY CATCH TWO DIFFERENT SHAPES OF THE SAME BUG.
//
// 1. THE WINDOW (below): the same destination twice inside `DEDUPE_MS`.
// 2. THE FOCUSED ROUTE: the destination is *already on screen*.
//
// Rule 2 exists because rule 1 alone was not enough, and the reason is delivery
// latency, not tap spacing. The user's taps are fast — but they are not
// necessarily DELIVERED fast. A tap that lands while the JS thread is committing
// the detail page (AniList write, extension resolve, a few hundred views) sits
// in the touch queue and is handed to `onPress` after that commit. If the commit
// took longer than the window, the queued tap clears rule 1 and pushes a SECOND
// copy of the page the user is already looking at — which is exactly the
// "I spammed it and got the same page twice" report. Timing can never fix that:
// the second tap is justified by the clock and wrong by the screen. So the
// guard also asks the navigator what is on top right now, and drops a push to
// the route that is already there, however much time has passed.
//
// WHY TARGET-AWARE, NOT A BLANKET LOCK. The obvious version — "ignore every
// navigation for 600ms after any navigation" — would break a real flow on this
// very screen: tap a search result, the detail page is already cached and
// renders immediately, tap "Watch now" inside 600ms, and the watch page is
// swallowed. Both rules key on the route AND its params, so a different
// destination always passes, however fast it comes. Only the thing that is
// genuinely a duplicate — the same screen, same params, again — is dropped.
//
// WHY THE WINDOW EXTENDS ON A BLOCKED TAP. A lag burst is not evenly spaced:
// taps can land at 0ms, 180ms, 420ms, 700ms. If the window only ever counted
// from the last ACCEPTED push, the tap at 700ms would be 700ms past the push at
// 0ms, clear the window, and push a second copy — defeating the whole thing for
// exactly the pattern it exists to catch. Refreshing the stamp on every blocked
// attempt turns the rule into what it should be: **the same target has to be
// quiet for `DEDUPE_MS` before another push is allowed.** A user who keeps
// tapping a tile they are already on keeps getting nothing, which is the
// correct answer, and a user who stops gets a clean stack.
//
// WHAT THIS IS NOT. It is not a debounce on navigation, and nothing is queued —
// a blocked tap is dropped, not deferred. Deferring would mean the app
// eventually navigates somewhere the user has long since stopped asking for.

import { router } from 'expo-router';
import { beginNavPending, extendNavPending } from './pending';

/**
 * How long the SAME destination must be quiet before it can be pushed again.
 *
 * 600ms is chosen against two numbers, not guessed. A lag burst's taps land
 * within ~100-250ms of each other, so anything above ~300ms absorbs one; and a
 * deliberate second tap on a *different* target is never blocked at all,
 * because that is a different key. What 600ms costs is only this: tapping the
 * same tile, deliberately, twice inside 600ms opens it once. That is the
 * cheapest possible wrong answer — the screen is already open.
 *
 * ⚠️ The window is the WEAKER of the two rules and is not what fixes the
 * queued-tap case — late delivery defeats any window. It stays because it also
 * covers pushes the focused-route rule cannot see (tab destinations, whose
 * route name is nested inside `(tabs)`) and two pushes issued in the same tick,
 * before the navigator's state has committed.
 */
const DEDUPE_MS = 600;

/** The last destination that was pushed, and when. */
let lastKey: string | null = null;
let lastAt = 0;

/**
 * The navigation container, bound once by the root layout.
 *
 * Kept as this narrow shape rather than importing react-navigation's types: the
 * guard needs exactly one question answered ("what is focused?"), and the
 * answer has to be asked at push time rather than cached from a render — a
 * cached copy is one commit behind precisely when a burst is happening.
 */
interface GuardNavRef {
  isReady?: () => boolean;
  getCurrentRoute?: () => unknown;
}

let navRef: GuardNavRef | null = null;

/**
 * Hand the guard the live navigation container. Called by `RootLayoutNav`,
 * which is the one component guaranteed to sit inside it and to mount exactly
 * once. Until this runs, rule 2 is simply unavailable and rule 1 still applies.
 */
export function bindNavigationRef(ref: GuardNavRef | null): void {
  navRef = ref;
}

/** Stable key for a destination — params sorted, so order cannot fake a change. */
function keyOf(pathname: string, params?: Record<string, string>): string {
  if (!params) return pathname;
  const entries = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`);
  return `${pathname}?${entries.join('&')}`;
}

/** Leading slashes are not part of a route's identity: `/anime/[id]` === `anime/[id]`. */
function stripSlash(s: string): string {
  return s.replace(/^\/+/, '');
}

/**
 * Is this destination the screen that is focused right now?
 *
 * Deliberately a SUBSET comparison: the target's params must agree with the
 * focused route's, but the focused route may carry params the target did not
 * mention (a `title` passed along on the way in, say). Requiring an exact key
 * set would let those extras reopen a screen that is obviously already there.
 *
 * Route names are matched, not built URLs: `getCurrentRoute()` reports the
 * pattern the navigator was configured with (`anime/[id]`), which is the same
 * string `push` is given here. If the name does not match — a tab destination,
 * whose focused leaf is `explore` rather than `(tabs)/explore` — the answer is
 * "no", and rule 1 decides.
 *
 * Safe to fail: a missing ref, an unmounted container or an unexpected shape
 * all read as "unknown", and an unknown route never blocks a push.
 */
function isFocusedTarget(
  pathname: string,
  params?: Record<string, string>
): boolean {
  if (!navRef) return false;
  try {
    if (navRef.isReady && !navRef.isReady()) return false;
    const route = navRef.getCurrentRoute?.() as
      | { name?: unknown; params?: unknown }
      | undefined
      | null;
    if (!route || typeof route.name !== 'string') return false;
    if (stripSlash(route.name) !== stripSlash(pathname)) return false;
    if (!params) return true;
    const current =
      route.params && typeof route.params === 'object'
        ? (route.params as Record<string, unknown>)
        : {};
    return Object.keys(params).every(
      (k) => String(current[k]) === params[k]
    );
  } catch {
    // A navigator mid-teardown is not a reason to swallow navigation.
    return false;
  }
}

/**
 * Push a route, unless this exact destination was pushed a moment ago or is
 * the screen already on top.
 *
 * Returns whether the push happened, so a caller that needs to know (to skip
 * side work, say) can ask. Almost nobody does.
 */
export function pushOnce(
  pathname: string,
  params?: Record<string, string>
): boolean {
  const key = keyOf(pathname, params);
  const now = Date.now();

  if (isFocusedTarget(pathname, params)) {
    // Rule 2: the screen is already showing. The clock is irrelevant — this is
    // the queued-tap case. Still stamp, so the weaker rule stays consistent
    // with what the user actually last asked for.
    lastKey = key;
    lastAt = now;
    // The tap is refused, but it is not ignored: if the bar is already up (the
    // push that is covering this stall), keep it alive rather than letting it
    // time out under a finger that is still asking.
    extendNavPending();
    return false;
  }

  if (key === lastKey && now - lastAt < DEDUPE_MS) {
    // Blocked. Refresh the stamp so a continuing burst stays absorbed — see the
    // header for why this line is the whole point of the guard.
    lastAt = now;
    extendNavPending();
    return false;
  }
  lastKey = key;
  lastAt = now;
  // Acknowledge BEFORE dispatching: on a stalled device the bar has to be on
  // screen by the time the tap finishes, not after the freeze. This is the
  // "the app heard you" half — see `lib/nav/pending.ts` for why it is a top
  // hairline and not a spinner.
  beginNavPending();
  router.push({ pathname, params });
  return true;
}

/**
 * Open an anime's detail page.
 *
 * Every tile, row, banner, search result and relation in the app goes through
 * here. That is deliberate: the bug this fixes was never one screen's, and
 * six hand-written copies of the same `router.push` is how the next one gets
 * written without the guard.
 */
export function openAnime(id: number): void {
  pushOnce('/anime/[id]', { id: String(id) });
}

/**
 * Open the player for one episode.
 *
 * Same guard, same reason, higher cost: two pushes here used to mean two
 * mounted players — two `expo-video` instances, two source resolves and two
 * background streams for one intention, on top of two screens to back out of.
 * The detail page's "Watch now" CTA and its episode tiles both come through
 * here.
 */
export function openEpisode(id: number, ep: number): void {
  pushOnce('/watch/[id]/[ep]', { id: String(id), ep: String(ep) });
}

/**
 * Test seam. The guard is module state, which is deliberate and also the thing
 * that makes it awkward to assert on — this clears it so a check can push once,
 * fail, and push again without waiting out the window.
 */
export function __resetNavGuard(): void {
  lastKey = null;
  lastAt = 0;
}
