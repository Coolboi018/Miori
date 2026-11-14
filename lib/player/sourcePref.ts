/**
 * The per-anime source memory — which extension LAST ACTUALLY PLAYED.
 *
 * THE REPORT (13 Nov): resolve returns every extension's rows ranked into one
 * list, and the player always started at index 0 — so a viewer who watched the
 * last session on Mega (or any source below the top) came back to the same
 * episode and landed on the top of the queue again. The episode LIST is
 * cached, but the source CHOICE was forgotten every time.
 *
 * THE SCOPE IS THE ANIME, not the episode: a viewer who picked Mega for show X
 * wants Mega for show X's next episode too — the preference is about the
 * source working for them, not about one file. Per-anime keys (the same shape
 * as `miori:epOrder:{id}`) so it never leaks across titles.
 *
 * THE WRITE RULE — proven, not chosen. The preference is saved when a FRAME
 * RENDERS on the source (and when the viewer picks one by hand), never on a
 * hop: a source that was hopped past produced no frame and must not be pinned
 * as "the one that worked" — the failover walk is the app's own correction,
 * and the memory has to record where the walk LANDED, not where it started.
 * A dead top source therefore unpins itself naturally: the walk lands lower,
 * the frame renders, the memory follows.
 *
 * THE READ RULE — preference, not requirement. On the next resolve the walk
 * STARTS at the remembered extension's first row, but if that extension did
 * not answer this time (down, ISP-blocked, no mapping) the list starts at the
 * ranked top as always. A stale preference must never cost a watchable
 * episode; `resolveEpisode` already did the probing that decided what is
 * alive today.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

/** Same prefix family as `miori:epOrder:{id}` — per-title, never global. */
const key = (animeId: number) => `miori:srcPref:${animeId}`;

/**
 * Where the walk should start, given the remembered extension.
 *
 * The FIRST row of the remembered extension wins, not an exact row: the rows
 * an extension serves can change between resolves (qualities regrouped,
 * mirrors reordered), and the memory's unit of truth is "this extension
 * played for me", not "row 3 played for me".
 *
 * `defaultExtId` — the GLOBAL default source (`player.defaultSource`) — takes
 * priority over the per-anime memory when it is given: a setting the viewer
 * typed into Settings is a stated preference, and the memory is a learned
 * one; without this ordering, one episode watched anywhere else would quietly
 * overwrite the global default through the frame-render save and the setting
 * would never stick. It is still a preference, not a requirement: an
 * extension that did not answer this resolve falls through to the memory and
 * then the ranked top, so a default never costs a watchable episode.
 */
export function pickStartIndex<T extends { extId?: string }>(
  sources: T[],
  prefExtId: string | null,
  defaultExtId?: string | null
): number {
  if (defaultExtId) {
    const i = sources.findIndex((s) => s.extId === defaultExtId);
    if (i >= 0) return i;
  }
  if (!prefExtId) return 0;
  const i = sources.findIndex((s) => s.extId === prefExtId);
  return i >= 0 ? i : 0;
}

/** The remembered extension id for this anime, or null. */
export async function readSourcePref(animeId: number): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(key(animeId));
  } catch {
    return null;
  }
}

/** Remember an extension for this anime. Undefined/empty clears the memory. */
export async function saveSourcePref(animeId: number, extId: string | undefined | null): Promise<void> {
  try {
    if (!extId) await AsyncStorage.removeItem(key(animeId));
    else await AsyncStorage.setItem(key(animeId), extId);
  } catch {
    /* a preference that cannot persist costs one re-resolve, nothing more */
  }
}
