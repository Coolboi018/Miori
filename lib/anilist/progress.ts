// Rules about what may be written to AniList, with no React and no network.
//
// These were living inside `lib/query/listEntries.ts`, which is the wrong home for
// two reasons. They are domain rules rather than cache mechanics, and — the
// practical one — that module imports the query client, AsyncStorage and
// SecureStore, so nothing in it can be loaded by a plain Node script. A rule
// nobody can execute a test against does not get tested, and this one needs to be.

import type { ListEntry } from './lists';

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