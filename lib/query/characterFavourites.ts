// Reading and writing one character's AniList favourite flag.
//
// SEPARATE FROM `lib/query/hooks.ts` because this is per-user data and that is
// public data. `CharacterDetail` is cached on disk for seven days and shared by
// every visitor; `isFavourite` answers "has THIS person favourited this
// character" and is worthless the instant it is stale. Asking for it inside the
// public payload — which is exactly what this did first — writes `false` for
// everything during any signed-out session, restores that at cold start, and paints
// `Like` on characters that are already on the account. `listEntries.ts` opens by
// making this argument; this file ignored it and paid for it.
//
// NOT PERSISTED. `persister.ts` scrubs `characterFavourite` on restore, so the
// flag is always re-asked rather than trusted from disk. It is one boolean, it is
// only requested when the sheet is open and someone is signed in, and five minutes
// of cache is enough to make reopening the same sheet free.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getToken } from '@/lib/anilist/auth';
import {
  fetchCharacterFavourite,
  toggleCharacterFavourite as apiToggle,
} from '@/lib/anilist/characterFavourite';
import { forgetLike, noteLike, noteWrite, paceDelay } from '@/lib/anilist/favouritePacing';
import { qk } from './keys';
import { fetchCharacterSignedIn, type SignedInCharacter } from '@/lib/anilist/characterFavourite';
import type { CharacterDetail } from '@/lib/anilist';

/**
 * Is this character favourited, and do we know yet?
 *
 * `undefined` means "not known" and is distinct from `false` on purpose. The sheet
 * uses the difference to avoid printing a confident `Like` on a character that is
 * already favourited: during the first frame of a sheet there is genuinely no
 * answer, and a button that guesses is the bug this file exists to fix.
 *
 * DISABLED RATHER THAN ENABLED-AND-401ing when signed out, for the reason
 * `useListEntry` gives — AniList answers an unauthenticated request with a 401
 * rather than a null, and firing that from every sheet a logged-out visitor opens
 * would spend requests to learn something `getToken` already knows. A signed-out
 * sheet shows an unliked heart, which is honest: there is no account to hold a
 * favourite.
 */
export function useCharacterFavourite(
  id: number,
  { enabled = true }: { enabled?: boolean } = {}
): { isFavourite: boolean | undefined; loading: boolean } {
  const query = useQuery({
    queryKey: qk.characterFavourite(id),
    queryFn: async (): Promise<boolean> => {
      const token = await getToken();
      if (!token) return false;
      return fetchCharacterFavourite(token, id);
    },
    enabled: enabled && id > 0,
    // Short on purpose. This is the one piece of the sheet that a user can change
    // from another device — favouriting a character on the AniList website should
    // show up here within a minute or two, not after seven days of disk cache.
    staleTime: 5 * 60_000,
  });

  return { isFavourite: query.data, loading: query.isPending };
}

/**
 * Flip the flag, and keep the sheet honest about it.
 *
 * OPTIMISTIC, because this is a reaction. Tapping a heart and waiting a second for
 * it to fill is the difference between a like and a form submission. `onError`
 * restores the previous value, so a refused write cannot leave a heart lying about
 * the account — and the error is handed back rather than swallowed, so the button
 * can SAY that it failed instead of quietly reverting.
 *
 * NO `cancelQueries` HERE, and its absence is the whole fix.
 *
 * The optimistic-update recipe cancels in-flight queries so a read cannot land on
 * top of the value being replaced. That is right for a key nothing is observing.
 * This key HAS an observer — `useCharacterFavourite` is mounted in the button beside
 * this hook — and cancelling an observed query makes TanStack start a fresh fetch to
 * replace what it just lost. So the sequence was:
 *
 *   cancelQueries  → read #1 fires, asking for the OLD value
 *   flip           → heart fills
 *   write lands    → AniList now says the new value
 *   read #1 lands  → OLD value → heart reverts
 *   invalidate     → read #2 is requested, but read #1 is still in flight, so
 *                    TanStack JOINS it and never fetches
 *
 * AniList was being updated correctly the whole time and the button was being
 * corrected by a request issued before the write. Adding the `invalidate` made it
 * permanent rather than a flicker, because it guaranteed the reverting read was the
 * only one that ever ran.
 *
 * `onSuccess` therefore writes the value the toggle produced — and for a toggle that
 * value is exact, not an assumption: `ToggleFavourite` flips a boolean, so given the
 * `previous` it ran against, the result IS `!previous`. Verified on device: the
 * account was updating while the button reverted, which is what proved the write was
 * never the problem.
 *
 * Reconciliation still happens, for free: the read's five-minute `staleTime` plus
 * `refetchStaleOnForeground` sweeps it on the next resume, so if AniList ever
 * disagrees with what we believe, the truth wins a few minutes later without racing
 * anything.
 *
 * WRITES THE FAVOURITE KEY, NOT `qk.character`. The public payload no longer knows
 * anything about this flag, so there is nothing there to patch.
 */
export function useToggleCharacterFavourite(id: number) {
  const queryClient = useQueryClient();
  const key = qk.characterFavourite(id);

  return useMutation({
    mutationFn: async (): Promise<void> => {
      const delay = paceDelay();
      if (delay > 0) {
        // The caller checks before firing, so reaching this means two writes raced
        // the check. Waiting is still correct — it costs no request, and skipping
        // the delay here would be the one path that ignores the ceiling.
        await new Promise((r) => setTimeout(r, delay));
      }
      const token = await getToken();
      if (!token) throw new Error('Sign in to favourite characters');
      await apiToggle(token, id);
      // Recorded only once the request is genuinely on the wire, so a failed write
      // does not spend budget it never used.
      noteWrite();
    },

    onMutate: () => {
      const previous = queryClient.getQueryData<boolean>(key);
      if (previous !== undefined) {
        queryClient.setQueryData<boolean>(key, !previous);
        // Only a move INTO the liked state arms the undo window. An un-like is
        // someone reconsidering a character they already thought about, and letting
        // it arm the window would make an immediate re-like free — which is the
        // cheap way to churn a public counter in the other direction.
        if (!previous) noteLike(id);
      }
      return { previous };
    },

    onError: (err, _vars, ctx) => {
      // Roll back and stop. No invalidation: the request failed, so nothing changed
      // on the server and the rollback is the complete correction. Logged rather
      // than swallowed — a write that quietly reverts is indistinguishable from a
      // broken button.
      console.warn('[characterFavourite] write failed', err);
      if (ctx) {
        queryClient.setQueryData<boolean>(key, ctx.previous);
        // The like never happened, so it must not leave the undo window armed —
        // otherwise the next genuine un-like would be swallowed as a mis-tap.
        if (ctx.previous === false) forgetLike(id);
      }
    },

    onSuccess: (_data, _vars, ctx) => {
      // The authoritative local value. Written AFTER the write has landed, so it
      // beats any read that was already in flight when the tap happened.
      if (ctx?.previous !== undefined) {
        queryClient.setQueryData<boolean>(key, !ctx.previous);
      }
    },
  });
}

/**
 * Combined character detail + favourite for signed-in visitors.
 *
 * One request instead of two (`useCharacter` + `useCharacterFavourite`),
 * and not persisted (see `NO_RESTORE`). Used by `CharacterSheet` when a
 * token is present; signed-out visitors still use the public `useCharacter`.
 */
export function useCharacterSignedIn(
  id: number,
  { enabled = true }: { enabled?: boolean } = {}
): {
  data: CharacterDetail | null | undefined;
  isFavourite: boolean | undefined;
  loading: boolean;
  refetch: () => void;
} {
  const query = useQuery({
    queryKey: qk.characterSignedIn(id),
    queryFn: async (): Promise<SignedInCharacter | null> => {
      const token = await getToken();
      if (!token) return null;
      return fetchCharacterSignedIn(token, id);
    },
    enabled: enabled && id > 0,
    staleTime: 5 * 60_000,
  });

  return {
    data: query.data === undefined ? undefined : query.data === null ? null : query.data.detail,
    isFavourite: query.data?.isFavourite,
    loading: query.isPending,
    refetch: query.refetch,
  };
}

/**
 * Toggle favourite for the SIGNED-IN combined path.
 *
 * Mirrors `useToggleCharacterFavourite` but reads/writes the combined query
 * (`qk.characterSignedIn`) so the like button and the detail stay in sync
 * without a second request. Pacing/undo logic is identical.
 */
export function useToggleCharacterFavouriteSignedIn(id: number) {
  const queryClient = useQueryClient();
  const key = qk.characterSignedIn(id);

  return useMutation({
    mutationFn: async (): Promise<void> => {
      const delay = paceDelay();
      if (delay > 0) {
        await new Promise((r) => setTimeout(r, delay));
      }
      const token = await getToken();
      if (!token) throw new Error('Sign in to favourite characters');
      await apiToggle(token, id);
      noteWrite();
    },

    onMutate: () => {
      const previous = queryClient.getQueryData<SignedInCharacter | null>(key);
      if (previous && previous.detail) {
        queryClient.setQueryData<SignedInCharacter | null>(key, {
          ...previous,
          isFavourite: !previous.isFavourite,
        } as SignedInCharacter);
        if (!previous.isFavourite) noteLike(id);
      }
      return { previous };
    },

    onError: (err, _vars, ctx) => {
      console.warn('[characterFavourite] write failed', err);
      if (ctx?.previous !== undefined) {
        queryClient.setQueryData<SignedInCharacter | null>(key, ctx.previous);
        if (ctx.previous?.isFavourite === false) forgetLike(id);
      }
    },

    onSuccess: (_data, _vars, ctx) => {
      if (ctx?.previous && ctx.previous.detail) {
        queryClient.setQueryData<SignedInCharacter | null>(key, {
          ...ctx.previous,
          isFavourite: !ctx.previous.isFavourite,
        } as SignedInCharacter);
      }
    },
  });
}