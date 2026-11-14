// Opening the list editor from ANY tile, without threading a prop through.
//
// WHY A MODULE AND NOT A PROP. Long-press-to-edit is wanted on every tile and
// every row in the app: rails, grids, the chart on home, the chart on explore, the
// rows layout, the banner rail. Those live in six components, eight call sites and
// four different screens. Threading an `onLongPress` through all of them means
// every future rail inherits a prop nobody remembers to pass, and a tile that
// forgets it is a tile that silently does nothing on long-press.
//
// So the sheet is addressed by a MODULE-SCOPE TARGET and hosted once, at the root.
// A card calls `openListSheet(media)` and is done. `lib/explore/pendingBrowse.ts`
// is the same idea for the same reason, and the codebase already has the pattern.
//
// THE TARGET CARRIES ITS OWN DISPLAY DATA — the title and the episode count. Not
// a fetch: every caller is already holding a `MediaItem` that has both, and
// re-requesting a detail payload to label a sheet the user is looking at would be
// a request spent to render text that was in memory a frame earlier.
//
// SIGNED-OUT CALLS ARE IGNORED RATHER THAN HANDLED HERE. There is no AniList to
// write to, and the host decides what to show — a prompt to sign in, or nothing.
// Deciding it here would mean this module needed to know about auth.

import { mediaTitle, type MediaItem } from '@/lib/anilist';

/**
 * HOW LONG A TILE MUST BE HELD, in milliseconds.
 *
 * React Native's default is 500ms, and that default plus the sheet's own 250ms
 * fade is about three quarters of a second before the editor is fully legible —
 * long enough that a deliberate hold reads as the app not having registered it.
 *
 * 300 is a deliberate reduction, and the reason it is safe is that scrolling
 * cancels it: `Pressability` abandons a long press as soon as the finger travels
 * more than 10px, so a flick along a rail or a drag down a grid never gets there.
 * What does is a thumb that stopped moving, which is a person meaning it.
 *
 * It lives here rather than at each call site because six surfaces with six
 * slightly different delays is a gesture that behaves differently depending on
 * which tile you happened to touch.
 */
export const LIST_LONG_PRESS_MS = 300;

export interface ListSheetTarget {
  id: number;
  /** Resolved from the media the caller already has. */
  title: string;
  /** `null` when AniList has no count, which the sheet handles as a free number. */
  totalEpisodes: number | null;
}

let target: ListSheetTarget | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

export function subscribeListSheet(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** The current target, or null. Read through `useSyncExternalStore`, so the
 *  getter must stay pure and return the SAME reference until it changes. */
export function getListSheetTarget(): ListSheetTarget | null {
  return target;
}

/** Open the editor for a media item. The id is what matters; the rest is display. */
export function openListSheet(media: Pick<MediaItem, 'id' | 'title' | 'episodes'>): void {
  const next: ListSheetTarget = {
    id: media.id,
    title: mediaTitle(media.title),
    totalEpisodes: media.episodes ?? null,
  };
  // Reopening for the SAME title is a no-op rather than a state write. A long-press
  // fires once, but `MediaRail` re-renders rows and a redundant write would close
  // and reopen the sheet on the title the user was already editing.
  if (target && target.id === next.id) return;
  target = next;
  emit();
}

/** Close. Called by the host when the sheet's own dismiss completes. */
export function closeListSheet(): void {
  if (!target) return;
  target = null;
  emit();
}