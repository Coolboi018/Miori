// Hosts the one list editor, at the root, for every tile in the app.
//
// MOUNTED ONCE AND ALWAYS. The editor is addressed by a module-scope target
// (`lib/list/listSheet.ts`) rather than by a prop from whichever screen happened
// to render the tile that was long-pressed, so there is exactly one of these and
// exactly one entry query and one mutation in the app.
//
// `visible={false}` when nothing is targeted, and `ListEntrySheet` is a `Modal`,
// so a closed host costs one unmounted modal and no query — `useListEntry` is
// disabled with it, which matters because a signed-out visitor long-pressing tiles
// must not fire a 401 per press.

import { useCallback, useSyncExternalStore } from 'react';
import { pushOnce } from '@/lib/nav/pushOnce';
import { useUserId } from '@/lib/auth/session';
import { useListEntry, useSaveListEntry, type EntryDraft } from '@/lib/query/listEntries';
import {
  closeListSheet,
  getListSheetTarget,
  subscribeListSheet,
} from '@/lib/list/listSheet';
import { ListEntrySheet } from './ListEntrySheet';
import { SignInGate } from './SignInGate';

export function ListSheetHost() {

  const target = useSyncExternalStore(
    subscribeListSheet,
    getListSheetTarget,
    // Server snapshot: nothing targeted during SSR, same as the settings store.
    () => null
  );
  
  /**
  * THE SESSION, SUBSCRIBED.
  *
  * This host used to read the user id itself — twice, on mount and again whenever a
  * target appeared, because a long-press has to know whether to open the editor or
  * the sign-in gate and a stale answer would be the wrong one of those two.
  *
  * That second read is gone. The session is a store now (`lib/auth/session.ts`), and
  * `completeSignIn` publishes to it, so a host that mounted before the user signed in
  * and is still mounted afterwards hears about it. A dedicated read per press was
  * only ever compensating for the account changing without telling anyone.
  *
  * `undefined` — the keychain has not answered — shows NEITHER modal, and that is why
  * the flag is three-state rather than a boolean. Showing the editor optimistically
  * and swapping it for the gate would flash a form at someone who cannot use one, and
  * prompting during the read would interrupt someone who is signed in. Both are worse
  * than waiting a few milliseconds, and in practice `refreshUserId` has already
  * settled by the time anyone can press anything.
  */
  const userId = useUserId();
  const signedIn = userId != null;
  const authKnown = userId !== undefined;
  const gated = target != null && userId === null;
  
  const signIn = useCallback(() => {
    // Close before navigating. The gate is a `Modal` and a `Modal` is its own
    // window, so pushing `/login` with one still on screen leaves it floating over
    // the login route until the target clears — which it would not, because
    // nothing dismisses it on a push.
    closeListSheet();
    pushOnce('/login');
  }, []);

  /**
   * The entry query is keyed on the TARGET's id, and disabled when there is no
   * target. That means pressing a second tile while the sheet is open re-keys the
   * query rather than leaving the first title's entry on screen — and the sheet's
   * `initial` follows, because it is derived from the same value.
   */
  const id = target?.id ?? 0;
  const { entry } = useListEntry(id, target != null && signedIn);
  const save = useSaveListEntry(id, closeListSheet);

  /**
   * LONG-PRESSING A TILE WITHOUT AN ACCOUNT SAYS SO, INSTEAD OF DOING NOTHING.
   *
   * The alternative is silence, which reads as a broken tile rather than as a
   * signed-out state — the gesture is the same one every media app uses for "add
   * to list", and on all of them it does something.
   */
  const onList = entry ?? null;
  const entryId = onList?.id;

  const submit = useCallback(
    (draft: EntryDraft & { entryId?: number }) => {
      save.mutate(
        { ...draft, entryId: draft.entryId ?? entryId },
        { onSuccess: closeListSheet }
      );
    },
    [save, entryId]
  );

  const remove = useCallback(() => {
    if (entryId == null) return;
    save.mutate({ remove: true, entryId }, { onSuccess: closeListSheet });
  }, [save, entryId]);

  return (
    <>
      <ListEntrySheet
        visible={target != null && authKnown && !gated}
        title={target?.title ?? ''}
        totalEpisodes={target?.totalEpisodes ?? null}
        entryId={entryId}
        initial={
          onList
            ? {
                status: onList.status,
                progress: onList.progress,
                score: onList.score,
                private: onList.private,
                repeat: onList.repeat,
              }
            : null
        }
        onClose={closeListSheet}
        onSubmit={submit}
        onRemove={entryId != null ? remove : undefined}
        busy={save.isPending}
        error={save.isError ? (save.error as Error).message : null}
      />

      <SignInGate
        visible={gated}
        // The title the gesture was about, so the dialog can say which tile rather
        // than making the user work it out from forty on screen.
        title={target?.title}
        onClose={closeListSheet}
        onSignIn={signIn}
      />
    </>
  );
}
