// SIGNING IN AND OUT, as two operations the whole app shares.
//
// WHY THIS FILE EXISTS. Three screens could sign in — `app/login.tsx` (the WebView
// redirect), `app/modal.tsx` (a pasted token) — and two could sign out. Each did the
// same three steps inline: save the token, ask AniList who it belongs to, save the
// id. None of them told the rest of the app.
//
// That last part is the bug this fixes. The user id is what keys the home query and
// what decides whether the detail page asks for a list entry, and every screen read
// it once on mount. So after a successful sign-in the app carried on behaving as a
// guest — no Continue Watching, no Planning — with no way out except a restart. And
// after a sign-out the previous account's rails stayed on screen, because the token
// was gone and so nothing would ever invalidate them.
//
// ONE OPERATION PER TRANSITION, rather than one per screen, because a transition
// that has to be remembered is a transition that will be forgotten. Adding a third
// sign-in entry point should not mean a third place to remember this.

import { queryClient } from '@/lib/query/client';
import { removePersistedCache } from '@/lib/query/persister';
import { logout as clearToken, saveToken, saveUserId } from '@/lib/anilist/auth';
import { fetchViewer, type Viewer } from '@/lib/anilist/lists';
import { setUserId } from './session';
import { seedViewer } from './queries';

/**
 * The cache entries that belong to one account and mean nothing to another.
 *
 * `['listEntry']` is here as much for privacy as for correctness: a list entry is
 * somebody's viewing history, and leaving it in memory after they sign out on a
 * shared device is not a state the app should be able to sit in.
 *
 * `['home']` goes for the opposite reason — it is public data — but it is still
 * keyed by user id, so the signed-out account's seven rails would be served to
 * whoever signs in next until it went stale.
 *
 * NOT `['media']` and friends. Those are public and identical for every account, so
 * dropping them would throw away a warm cache to fix nothing.
 */
const ACCOUNT_SCOPED_KEYS = [['home'], ['listEntry'], ['viewer']] as const;

async function dropAccountCache(): Promise<void> {
  await Promise.all(
    ACCOUNT_SCOPED_KEYS.map((queryKey) => queryClient.removeQueries({ queryKey }))
  );
}

/**
 * Finish a sign-in: validate the token, remember who it belongs to, and tell the
 * app.
 *
 * `fetchViewer` is not optional decoration — it is what proves the token works, and
 * it is the only place the user id comes from. A token saved without it would leave
 * `getUserId()` returning `null` and the app signed-out-looking while holding a
 * valid credential, which is the worst of both.
 *
 * THROWS if the token is bad, and the caller is expected to let that propagate: a
 * failed sign-in must not reach `setUserId`, or the app would announce an account it
 * does not have.
 */
export async function completeSignIn(token: string): Promise<Viewer> {
  const viewer = await fetchViewer(token);
  await saveToken(token);
  await saveUserId(viewer.id);

  // Drop the anonymous home response before announcing, so that by the time any
  // subscriber re-renders, the cache it is about to ask for is empty and it gets a
  // real fetch rather than the five-rail guest screen it was already holding.
  await dropAccountCache();
  // …and put the viewer straight back, because the line above just fetched it. Any
  // account screen that opens now paints a name and an avatar from cache instead of
  // asking AniList the same question a second time.
  seedViewer(queryClient, viewer);
  setUserId(viewer.id);

  return viewer;
}

/**
 * Finish a sign-out.
 *
 * ORDERED, AND THE ORDER IS THE FIX. `clearToken()` first and `setUserId(null)`
 * last, with the credential removed before anything announces the change.
 *
 * `clearToken()` throws if the keychain refused, and this propagates on purpose.
 * It used to swallow the failure inside `logout()` and resolve, so every line
 * below ran regardless: the account cache was dropped and `setUserId(null)`
 * published a signed-out app while the token was still in the keychain. The user
 * saw "logged out", the guest rails came up, and the next launch found the token
 * and signed itself back in. Bailing out before ANY of it leaves the app
 * honestly still-signed-in, which is the state the device is really in.
 *
 * Nothing is rolled back on the failure path, because nothing has happened yet —
 * no cache was dropped and no subscriber was told. That is why this is a plain
 * early exit and not a `try`/`finally`.
 *
 * `await`ed by callers before they re-read anything, because the cache drop is the
 * part that is easy to forget and the part with a visible failure — a home screen
 * still showing the previous account's list.
 */
export async function completeSignOut(): Promise<void> {
  await clearToken();
  // Disk, not just memory. `dropAccountCache` uses `removeQueries`, which is
  // memory-only, so without this the previous account's list entries stay in the
  // persisted blob — including their free-text `notes`, `score` and `priority` —
  // until something overwrites them. On a shared phone that is somebody's private
  // writing sitting on the device after they signed out.
  //
  // Before the wipe, not after `setUserId(null)`: nothing here is reversible, and
  // if the wipe fails there is nothing to announce anyway.
  await removePersistedCache();
  await dropAccountCache();
  setUserId(null);
}