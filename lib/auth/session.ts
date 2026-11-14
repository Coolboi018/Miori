// WHO IS SIGNED IN, as one shared value.
//
// WHY THIS IS A STORE AND NOT A `getUserId()` CALL PER SCREEN. Three screens read
// the user id — home (to key its query), the detail page (to decide whether to ask
// for an entry) and the list-sheet host (to decide between the editor and the
// sign-in gate) — and every one of them was reading it `useEffect(..., [])`. That is
// a SecureStore round-trip per screen mount, and worse it is a snapshot that never
// updates, because nothing tells a mounted screen that the account changed.
//
// THE SYMPTOM THAT PRODUCED THIS. Sign in, and go back: home was mounted before the
// token existed, so its `userId` was still `null` and it kept rendering the
// anonymous query — no Continue Watching, no Planning, no indication you are signed
// in at all. Nothing short of restarting the app fixed it, because the home tab is
// never unmounted and its effect never re-ran. Sign out and the mirror image: the
// previous account's rails stayed on screen.
//
// `null` MEANS "SIGNED OUT", and `undefined` means "not read yet". The distinction
// is load-bearing: home passes `userId` straight into `qk.home`, and a signed-out
// visitor must get the real `['home', 'anon', …]` key so the anonymous rails paint
// from disk immediately rather than waiting on a SecureStore read.
//
// THE TOKEN IS NOT HERE. Only the id, because the id is what keys queries and what
// the UI branches on; the token stays in SecureStore and is read by the mutations
// that need it, one request at a time.

import { useSyncExternalStore } from 'react';
import { getUserId } from '@/lib/anilist/auth';

export type SessionState = number | null | undefined;

let userId: SessionState;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function getSnapshot(): SessionState {
  return userId;
}

/** Nothing is known during SSR and before the first read, same as the other stores. */
function getServerSnapshot(): SessionState {
  return undefined;
}

/**
 * The signed-in user's id, or `null`.
 *
 * `undefined` until the first read lands. Callers that pass this into a query key
 * must handle it — see the note on `SessionState`.
 */
export function useUserId(): SessionState {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/**
 * Announce an account change.
 *
 * Called by the sign-in and sign-out paths immediately after SecureStore is
 * written, NOT by re-reading it. The caller already knows the answer — it either
 * just received a viewer's id or just deleted the token — so making it wait for
 * another round-trip to discover what it already has would delay the UI by
 * however long the keychain takes, for no information.
 */
export function setUserId(next: number | null): void {
  if (userId === next) return;
  userId = next;
  emit();
}

/**
 * Re-read the id from SecureStore.
 *
 * For the one case where nobody knows the answer: a cold start, or a resume where
 * the account may have changed on another device. It settles to `null` rather than
 * leaving `undefined` forever if the read fails, because an unknown session is not
 * a usable state — it is a screen that cannot decide whether to ask for an entry.
 *
 * Deliberately NOT called on every foreground. `refetchStaleOnForeground` already
 * covers data freshness, and a keychain read on every resume is a cost paid for a
 * value that changes perhaps monthly.
 */
export async function refreshUserId(): Promise<void> {
  try {
    const id = await getUserId();
    setUserId(id);
  } catch {
    setUserId(null);
  }
}