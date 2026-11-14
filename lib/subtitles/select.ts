// Which subtitle track plays, given a stored preference.
//
// NO IMPORTS (beyond a type), for the same reason `style.ts` has none:
// `scripts/check-subtitles.ts` runs this under plain `tsx`.
//
// ═══════════════════════════════════════════════════════════════════════════
// WHY THIS IS A MODULE AND NOT THREE LINES IN THE PLAYER
// ═══════════════════════════════════════════════════════════════════════════
//
// The player used to decide this with two effects: one that reset the index to
// `0` on every source load, and one that then pushed it to the first English
// track. The second ran whenever the `tracks` ARRAY changed identity — and a
// source load hands over a fresh array — so picking Japanese, switching quality
// and finding yourself back on English was not a bug anyone had to introduce.
// It was what the code did.
//
// The fix is one rule, and it is a rule about what counts as the same set of
// tracks: a stored PREFERENCE, matched against whatever the new source offers,
// rather than an index. An index means something different on every source; a
// language does not.

import type { SubtitleTrack } from '../extensions/types';

/**
 * Prefer English when the source offers it, else the first track.
 *
 * This is the shipped default and the answer to "why was English chosen?" — it
 * was asked for, in the sense that this is what an untouched install wants.
 */
export const SUBTITLE_AUTO = 'auto';

/**
 * Never show subtitles, even when the source has them.
 *
 * A distinct value rather than an empty string because "no preference recorded"
 * and "the user turned them off" are different states, and conflating them is
 * how a preference for no subtitles becomes indistinguishable from a first run.
 */
export const SUBTITLE_OFF = 'off';

/** The index that means "no track selected". Mirrors the player's own sentinel. */
export const NO_TRACK = -1;

/**
 * The stored identity of a track.
 *
 * `lang` first, because it is the field that means the same thing on every
 * source; `label` is the fallback and is only as stable as the provider's
 * naming, which is why it is second and why `pickTrack` also tries a prefix
 * match. An anonymous track (no lang AND no label) keys to the empty string,
 * which callers treat as "not worth persisting" — see `trackKey` usage in the
 * player, which skips the write rather than storing a value that would match
 * every other anonymous track.
 */
export function trackKey(t: SubtitleTrack): string {
  return (t.lang ?? '').trim().toLowerCase() || (t.label ?? '').trim().toLowerCase();
}

function isEnglish(t: SubtitleTrack): boolean {
  const lang = (t.lang ?? '').trim().toLowerCase();
  // 'en', 'en-US', 'en_GB' — but NOT 'eng-sub' or a label that merely starts
  // with those letters.
  if (lang === 'en' || lang.startsWith('en-') || lang.startsWith('en_')) return true;
  return /english|eng\b/i.test(t.label ?? '');
}

/**
 * The index of the track to play, or `NO_TRACK`.
 *
 * `preference` is `string | null | undefined` on purpose: `preferenceFor` hands
 * back `null` for a track it cannot identify, and the caller's correct response
 * to that is "don't persist it" — which it can only do if it is allowed to hold
 * the value long enough to branch on it. A `string` parameter would push a
 * `!` or a `?? ''` into the player, and either one turns "no preference" into a
 * real (if meaningless) one.
 *
 * PRECEDENCE, and the order is the whole design:
 *
 *   1. `'off'` wins over everything. A source that offers English does not
 *      override a viewer who turned subtitles off.
 *   2. An explicit preference wins over the English default. If the stored
 *      language is on this source, it is the answer even when an English track
 *      is sitting at index 0.
 *   3. A preference this source does not carry falls back to English, NOT to
 *      index 0. This is the failover case: the viewer asked for Japanese, the
 *      primary source died, the backup is English-only, and index 0 is the best
 *      thing available — but index 0 on some other source might be Spanish, and
 *      "best available" should not be "whatever happened to be first".
 *   4. With no English either, index 0 — there is nothing to choose between
 *      tracks at that point, and showing the only track beats showing nothing.
 *   5. No tracks at all is `NO_TRACK`, which is also what "off" means to the
 *      renderer. An empty list and an explicit choice to be silent produce the
 *      same pixels, and that is correct rather than a conflation.
 */
export function pickTrack(
  tracks: SubtitleTrack[],
  preference: string | null | undefined
): number {
  if (preference === SUBTITLE_OFF) return NO_TRACK;
  if (!tracks.length) return NO_TRACK;

  const want = (preference ?? '').trim().toLowerCase();

  if (want && want !== SUBTITLE_AUTO) {
    const exact = tracks.findIndex((t) => trackKey(t) === want);
    if (exact >= 0) return exact;
    // 'en' stored from a source that reported 'en-US' (or the reverse). A prefix
    // match on either side covers both directions without matching 'es' against
    // a track called 'español'.
    const loose = tracks.findIndex((t) => {
      const key = trackKey(t);
      return !!key && (key.startsWith(want) || want.startsWith(key));
    });
    if (loose >= 0) return loose;
  }

  const en = tracks.findIndex(isEnglish);
  return en >= 0 ? en : 0;
}

/** The preference value to persist after the viewer picks this track. */
export function preferenceFor(t: SubtitleTrack): string | null {
  const key = trackKey(t);
  return key ? key : null;
}