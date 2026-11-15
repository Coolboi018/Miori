// One guarded `push`, and the one place an anime detail page is opened from.
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
// WHY TARGET-AWARE, NOT A BLANKET LOCK. The obvious version — "ignore every
// navigation for 600ms after any navigation" — would break a real flow on this
// very screen: tap a search result, the detail page is already cached and
// renders immediately, tap "Watch now" inside 600ms, and the watch page is
// swallowed. The key is the route AND its params, so a different destination
// always passes, however fast it comes. Only the thing that is genuinely a
// duplicate — the same screen, same params, again — is dropped.
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

/**
 * How long the SAME destination must be quiet before it can be pushed again.
 *
 * 600ms is chosen against two numbers, not guessed. A lag burst's taps land
 * within ~100-250ms of each other, so anything above ~300ms absorbs one; and a
 * deliberate second tap on a *different* target is never blocked at all,
 * because that is a different key. What 600ms costs is only this: tapping the
 * same tile, deliberately, twice inside 600ms opens it once. That is the
 * cheapest possible wrong answer — the screen is already open.
 */
// Bumped from 600 to 2000: 600 absorbed rapid double-taps but a slow render
// (cold cache, busy JS thread) can leave the user staring at the previous
// screen for >600ms, after which a second tap pushed a duplicate. 2000 covers
// the "nothing happened, tap again" case. Cost: the same tile tapped twice
// within 2s opens once — the screen is already open, so that is the right
// answer. A different destination is never blocked (key differs).
const DEDUPE_MS = 2000;

/** The last destination that was pushed, and when. */
let lastKey: string | null = null;
let lastAt = 0;

/** Stable key for a destination — params sorted, so order cannot fake a change. */
function keyOf(pathname: string, params?: Record<string, string>): string {
  if (!params) return pathname;
  const entries = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`);
  return `${pathname}?${entries.join('&')}`;
}

/**
 * Push a route, unless this exact destination was pushed a moment ago.
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
  if (key === lastKey && now - lastAt < DEDUPE_MS) {
    // Blocked. Refresh the stamp so a continuing burst stays absorbed — see the
    // header for why this line is the whole point of the guard.
    lastAt = now;
    return false;
  }
  lastKey = key;
  lastAt = now;
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
 * Test seam. The guard is module state, which is deliberate and also the thing
 * that makes it awkward to assert on — this clears it so a check can push once,
 * fail, and push again without waiting out the window.
 */
export function __resetNavGuard(): void {
  lastKey = null;
  lastAt = 0;
}
