// Rules about what may be written to AniList, with no React and no network.
//
// These were living inside `lib/query/listEntries.ts`, which is the wrong home for
// two reasons. They are domain rules rather than cache mechanics, and — the
// practical one — that module imports the query client, AsyncStorage and
// SecureStore, so nothing in it can be loaded by a plain Node script. A rule
// nobody can execute a test against does not get tested, and this one needs to be.

import type { ListEntry, MediaListStatus } from './lists';

/**
 * Would writing `episode` move AniList's progress FORWARD?
 *
 * `progress` is an ABSOLUTE value on `SaveMediaListEntry`: AniList ends up with
 * whatever number was sent, and there is no server-side `max()`. So this
 * comparison is the only thing standing between a rewatch and a destroyed list
 * entry.
 *
 * THE BUG IT PREVENTS. The watch screen gates on a per-episode `miori:synced:`
 * flag, but that flag only knows about episodes THIS PHONE reported. An entry
 * added on the web, on another device, or by hand has no local flag at all — so
 * rewatching episode 2 of a show AniList had you on at episode 5 sent
 * `progress: 2` and rolled the list back, losing every episode since.
 *
 * `entry.progress` is AniList's own number, already fetched by the detail page
 * and already in the cache under the same key — it was simply being read for
 * `status` and never for `progress`. Checking it costs no request.
 *
 * `null` means "not on the list", which is the case that most needs writing, so
 * an absent entry never blocks. `undefined` means "not loaded yet" and is
 * treated the same way: syncing is the cheaper mistake, because the caller's own
 * per-episode flag already prevents a second attempt on a true failure.
 *
 * DELIBERATELY NOT SYMMETRIC. An entry edited DOWN to episode 3 by hand means
 * the user wants to be at 3, so the next episode they watch has to be able to
 * move it forward again. A symmetric "only ever write once" guard would freeze
 * the entry permanently, and a guard keyed on `status` would break a REPEATING
 * entry, whose progress is supposed to keep climbing past the episode count.
 */
export function advancesProgress(
  entry: ListEntry | null | undefined,
  episode: number
): boolean {
  return !(entry && entry.progress >= episode);
}

/**
 * The media facts the sync plan needs, as plain fields — deliberately NOT the
 * full `MediaDetail`, so this file stays loadable by a plain Node script.
 */
export interface SyncMediaFacts {
  episodes?: number | null | undefined;
  status?: string | null;
}

/**
 * What one 82%-rule sync may send to AniList for this episode.
 *
 * This replaces the old single question (`advancesProgress`) because that guard
 * had a HOLE the device caught (15 Nov): a PLANNING entry whose cached progress
 * already sits at or past the watched episode produced "success" — the mutation
 * resolved, the caller marked the episode synced — with NOTHING sent to
 * AniList. The entry sat in Planning forever, because the only write that would
 * have promoted it (a forward progress write) was exactly the one the guard
 * skipped. The user watched episodes to 100% and their account never moved.
 *
 * The three outcomes:
 *
 *  - `progress` — the episode moves AniList's number forward. Sends progress,
 *    plus a status when one is needed (see `needsPromotion` below).
 *  - `promote` — the episode does NOT move the number (the guard is doing its
 *    job), but the entry's status still contradicts the fact that someone just
 *    watched it. Only PLANNING qualifies: it means "not started", which a
 *    fully-watched episode disproves. The write sends STATUS ONLY — never a
 *    progress value, so it can never roll the account's number backwards. A
 *    Planning entry at the finale of a finished show completes instead, by the
 *    same rule the forward path uses.
 *  - `none` — nothing to send. CURRENT/REPEATING already past the episode, and
 *    PAUSED/DROPPED/COMPLETED, which are deliberate states a silent rewatch
 *    must not overwrite.
 */
export interface ProgressSyncPlan {
  write: boolean;
  progress?: number;
  status?: MediaListStatus;
}

/** True when the finale rule may fire for this entry's status. */
function promotableFrom(status: ListEntry['status'] | null | undefined): boolean {
  return status == null || status === 'CURRENT' || status === 'PLANNING';
}

export function planProgressSync(
  entry: ListEntry | null | undefined,
  episode: number,
  media?: SyncMediaFacts | null
): ProgressSyncPlan {
  const total = media?.episodes ?? 0;
  const airing = media?.status === 'RELEASING' || media?.status === 'HIATUS';
  const finale = total > 0 && episode >= total && !airing;

  // Untracked (null) or not-yet-loaded (undefined) entries always write —
  // `null >= episode` is false, so `advancesProgress` already agreed.
  if (entry == null) {
    return {
      write: true,
      progress: episode,
      status: finale ? 'COMPLETED' : 'CURRENT',
    };
  }

  const { progress, status } = entry;

  // The episode DOES move AniList's number. Same shape the mutation always sent.
  if (!(progress >= episode)) {
    return {
      write: true,
      progress: episode,
      // The existing promotion rule, unchanged: anything not already CURRENT or
      // REPEATING is promoted to CURRENT by a forward write (PAUSED/DROPPED
      // included — behaviour deliberately kept), and a reached finale of a
      // finished show completes instead.
      status: finale && promotableFrom(status)
        ? 'COMPLETED'
        : status !== 'CURRENT' && status !== 'REPEATING'
          ? 'CURRENT'
          : undefined,
    };
  }

  // The guard holds: writing this episode's number would move AniList
  // BACKWARDS. The one thing still worth sending is a Planning → CURRENT
  // promotion, because the watched episode disproves "not started". Status
  // only — never a progress value.
  if (status === 'PLANNING') {
    return {
      write: true,
      status: finale && promotableFrom(status) ? 'COMPLETED' : 'CURRENT',
    };
  }

  // Already watching/paused/dropped/completed past this episode: a rewatch.
  // Nothing to send, and that is the honest outcome — the caller marks the
  // episode synced so it is never retried.
  return { write: false };
}