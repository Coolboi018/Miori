/**
 * The per-anime source memory — which extension LAST ACTUALLY PLAYED.
 *
 * (The SESSION-wide memory — skips and the source that played most recently —
 * lives in `lib/player/sourceLedger.ts`; this file consumes it through
 * `pickStartIndex`'s optional `session` argument and stays purely about the
 * per-title preference.)
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
 * `defaultExtId` — the GLOBAL default source (`player.defaultSource`) — is the
 * LAST resort before the ranked top, NOT the first. It used to outrank the
 * memory, and the 21 Nov report is why that was wrong: a viewer watching on
 * Mega backed out to the details page and came straight back, and the player
 * opened on the Settings default (filmu) again — a guess typed into Settings
 * once, possibly months and several providers ago, beating the source that
 * had rendered a frame ten seconds earlier. Real players resume where you
 * were.
 *
 * The precedence is now: PROOF (the extension that actually played for this
 * anime, written by the frame rule above) → the stated default → the ranked
 * top. Both remain preferences, not requirements: an extension that did not
 * answer this resolve falls through to the next rung, so neither a stale
 * memory nor a stale default can cost a watchable episode.
 */
/**
 * The session's opinion, as an argument.
 *
 * Both fields are optional so every existing caller and check keeps working; a
 * caller that passes nothing gets the 13 Nov rule exactly as it was.
 */
export interface SessionStart {
  /**
   * The extension that rendered a frame most recently THIS SESSION — across all
   * anime (`lib/player/sourceLedger.ts`). Fresh proof, so it is consulted
   * before the per-anime memory: a source that worked five seconds ago is a
   * better bet for the next episode than one that worked last week.
   */
  proven?: string | null;
  /**
   * Is this extension skipped for the rest of the session?
   *
   * A skipped source is passed over at every rung — including its own memory
   * and the viewer's stated default — because the session already watched it
   * fail for an environmental reason. A manual pick in the player clears the
   * skip explicitly; the Settings default deliberately does NOT (it is a
   * standing preference, not a "try now" command).
   */
  skipped?: (extId: string | undefined) => boolean;
}

/**
 * Where the walk should start, given everything the app knows.
 *
 * PRECEDENCE (22 Nov): session proof → the anime's own proof → the stated
 * default → the ranked top. Every rung is filtered by `skipped`, and if that
 * filters every source out the ranked top is still returned: trying a known-bad
 * source is better than refusing to play anything, and the ledger's "skip" is
 * an ordering opinion, never a hard lock.
 */
export function pickStartIndex<T extends { extId?: string }>(
  sources: T[],
  prefExtId: string | null,
  defaultExtId?: string | null,
  session?: SessionStart
): number {
  if (!sources.length) return 0;
  const skipped = session?.skipped;
  const usable = (i: number) => i >= 0 && !(skipped ? skipped(sources[i]?.extId) : false);
  const firstFor = (id: string | null | undefined): number => {
    if (!id || id === 'auto') return -1;
    const i = sources.findIndex((s) => s.extId === id);
    return usable(i) ? i : -1;
  };

  const sessionProof = firstFor(session?.proven);
  if (sessionProof >= 0) return sessionProof;

  const ownProof = firstFor(prefExtId);
  if (ownProof >= 0) return ownProof;

  const stated = firstFor(defaultExtId);
  if (stated >= 0) return stated;

  // The ranked top that the session has not written off. Falling through to 0
  // here when every row is skipped is deliberate — see the precedence note.
  for (let i = 0; i < sources.length; i++) if (usable(i)) return i;
  return 0;
}

/**
 * The next row the failover walk should try, or null at the end of the list.
 *
 * "Next" means the next row the session has not written off, so a dead provider
 * sitting in the middle of the ladder is stepped over instead of being tried
 * every single time the walk passes it. The skipped rows are NOT deleted: they
 * stay in the picker (faded, with the reason), and one tap on one is an
 * explicit attempt.
 *
 * WHEN NOTHING IS LEFT ALIVE the walk proceeds in rank order. That is the one
 * case where a skipped source is better than an error card: if every provider is
 * marked, the marks are probably stale (a captive portal, a tunnel coming back),
 * and one attempt is the only way to learn anything.
 */
export function nextWalkIndex<T extends { extId?: string }>(
  sources: T[],
  from: number,
  skipped?: (extId: string | undefined) => boolean
): number | null {
  const start = Math.max(0, from + 1);
  if (start >= sources.length) return null;
  if (!skipped) return start;

  const anyLive = sources.some((s) => !skipped(s.extId));
  if (!anyLive) return start;

  for (let i = start; i < sources.length; i++) {
    if (!skipped(sources[i].extId)) return i;
  }
  return null;
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
