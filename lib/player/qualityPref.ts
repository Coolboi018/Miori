/**
 * The per-anime QUALITY memory — which rung actually played.
 *
 * THE REPORT (21 Nov): a viewer was watching at 1080p, backed out to the
 * details page, came back to the same episode, and the player opened at the
 * user's DEFAULT setting instead (or Auto). The source memory
 * (`sourcePref.ts`) covered WHICH SERVER; nothing covered WHICH RUNG. The
 * default quality is a guess the viewer typed into Settings once, possibly
 * months and several providers ago — the rung that rendered ten seconds ago is
 * evidence.
 *
 * SAME SHAPE AS THE SOURCE MEMORY, same reasoning:
 *
 *  • The scope is the ANIME. A viewer who picked 1080p for a show wants 1080p
 *    for that show's next episode too; the label is a property of the show's
 *    encodes, not of one episode.
 *  • The write rule is PROVEN, not chosen: saved when a locked variant
 *    actually RENDERS a frame (`onFirstFrame`) and when the viewer picks one by
 *    hand. A pick that never produced a picture is not evidence — and explicit
 *    Auto CLEARS the memory, because "Auto" is a decision too and re-locking
 *    the old rung afterwards would make that button a lie.
 *  • The read rule is PREFERENCE, not requirement: the applier takes this
 *    label only when some source actually offers it, and otherwise falls
 *    through to the stated default and then Auto. A remembered rung must never
 *    cost a watchable episode.
 *
 * Keys live in the same family as `miori:srcPref:{id}` / `miori:pos:{id}:{ep}`
 * so they are per-title and never leak across shows.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

const key = (animeId: number) => `miori:qPref:${animeId}`;

/** The remembered rung label ('1080p', '720p', …) for this anime, or null. */
export async function readQualityPref(animeId: number): Promise<string | null> {
  try {
    const value = await AsyncStorage.getItem(key(animeId));
    return value && value.trim().length > 0 ? value : null;
  } catch {
    return null;
  }
}

/**
 * Remember (or clear) the rung for this anime.
 *
 * `undefined`/`null`/empty clears it — that is the Auto path. A failed write
 * costs one re-application of the default, nothing more, so it is swallowed.
 */
export async function saveQualityPref(
  animeId: number,
  label: string | null | undefined
): Promise<void> {
  try {
    if (!label || !label.trim()) await AsyncStorage.removeItem(key(animeId));
    else await AsyncStorage.setItem(key(animeId), label.trim());
  } catch {
    /* a preference that cannot persist costs one load at the default */
  }
}
