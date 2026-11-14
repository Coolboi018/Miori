/**
 * How many episodes actually exist to watch, right now.
 *
 * An AniList `episodes` count is the SEASON TOTAL. For a finished series that is
 * the answer, but for anything still airing it is a promise about the future — a
 * show with `episodes: 12` and one episode released has ELEVEN rows that cannot
 * be watched, and rendering them produced dead rows: no source poster, so each
 * fell back to a bare number chip (`EpisodeRow`'s `thumbnail ? … : numChip`).
 *
 * `nextAiringEpisode.episode` is the first episode that has NOT aired, so
 * everything below it has. That makes the released count `episode - 1`, and it
 * is the number AniList maintains precisely so this question can be answered
 * without arithmetic.
 *
 * THE THREE CASES, and why only one of them is allowed to return nothing:
 *
 *   still airing      `nextAiringEpisode` present → clamp to `episode - 1`
 *   unreleased       `status: NOT_YET_RELEASED` → 0. This is the ONLY status
 *                    that positively asserts no episode exists yet.
 *   everything else  → the full count
 *
 * The last line used to be a whitelist — `FINISHED`/`COMPLETED` and nothing else
 * — and that was a bug, not a conservative default. An airing title whose
 * `nextAiringEpisode` AniList has not filled in yet, a HIATUS title, or any status
 * this function does not enumerate all fall through a whitelist to `0`, and `0`
 * is not a neutral answer: the fallback that generates rows when the video source
 * has nothing is gated on this being positive, so those titles reported "No
 * episodes available from any source yet" on a title AniList says has twelve.
 *
 * THE RULE THAT MAKES IT SAFE: absence of evidence is not evidence of absence.
 * Only a status that ASSERTS nothing has aired may report nothing, and AniList
 * has exactly one: `NOT_YET_RELEASED`. Everything else — including a null status
 * and any value added to the enum later — is treated as "episodes exist", because
 * the failure modes are not symmetric. Guessing high on an unreleased show shows
 * a few rows that resolve to a source with nothing behind them; guessing low on a
 * real one shows an empty list on a title that is entirely playable.
 *
 * ONE RULE, TWO SCREENS. This lived inside `app/anime/[id].tsx`, which is where
 * the watch page's copy of the bug came from: it had its own episode list, its own
 * fallback, and NEITHER of them clamped — so the details page showed one episode
 * and the player, for the same title, showed the whole season of ghosts. The
 * value of the rule is only realised when one place owns it.
 */

import type { MediaDetail } from '@/lib/anilist';
import type { EpisodeInfo } from '@/lib/extensions/types';

export function releasedCount(media: MediaDetail | undefined): number {
  if (!media) return 0;
  const total = media.episodes ?? 0;
  const next = media.nextAiringEpisode?.episode;
  if (typeof next === 'number' && next > 0) {
    // ⚠️ `total` IS ONLY A CEILING WHEN IT EXISTS, and reading it as one when it
    // does not is what emptied half of AniList's schedule.
    //
    // AniList leaves `episodes: null` on any title whose season length it has
    // not decided — which is MOST of what is currently airing. Measured on
    // 11 Oct, **15 of 25** titles airing that week had `episodes: null`, every
    // one of them with `nextAiringEpisode: { episode: 2 }`. `Math.min(0, 1)`
    // is `0`, so the rule reported "nothing has aired" for fifteen shows whose
    // first episode was out and playable — and because 0 is also the signal to
    // fall back to AniList's count, the empty answer cancelled its own
    // rescue. The details page then said "No episodes available from any source
    // yet" about a title whose episode 1 plays, which is the report this is for.
    //
    // `nextAiringEpisode.episode` is "the first episode that has NOT aired", so
    // `next - 1` IS the answer and needs no ceiling. `total` still caps it when
    // it is known, because that is what it is for and it catches inconsistent
    // schedules; it is simply not allowed to veto a count it does not have.
    return total > 0 ? Math.min(total, next - 1) : next - 1;
  }
  // No next episode scheduled. Only an unreleased title asserts there is
  // nothing to play; everything else means the count is real.
  if (media.status === 'NOT_YET_RELEASED') return 0;
  return total;
}

/**
 * Drop the episodes that have not aired.
 *
 * TRUNCATE BY NUMBER, never by "drop the rows that look empty": a row with no
 * poster and a generic title is ALSO what a real episode looks like when the
 * source has nothing for it (verified live — FilmU serves an aired episode with
 * `airDate`, `poster` and `description` all null), so an emptiness test deletes
 * the episode the user opened the page for. Cutting at a number keeps whatever
 * the source listed below the airing point, including gaps.
 *
 * `count <= 0` returns the list untouched, because 0 is `releasedCount`'s way of
 * saying "no evidence" (see its note) and clamping to it would empty a list the
 * source legitimately knows about.
 */
export function clampToAired<T extends { number: number }>(
  episodes: T[],
  count: number
): T[] {
  if (count <= 0) return episodes;
  return episodes.filter((e) => e.number <= count);
}

/**
 * Does AniList positively assert that NOTHING has aired yet?
 *
 * Two signals mean it: `status: NOT_YET_RELEASED` (the only status that
 * asserts no episode exists), and `nextAiringEpisode.episode === 1` (the
 * first episode is announced but has not aired — `releasedCount` already
 * folds this to 0).
 *
 * THIS IS A DIFFERENT 0. `releasedCount` also returns 0 for "no evidence"
 * (no status, no schedule, no count) — but there absence of evidence is not
 * evidence of absence, and a source list that knows better is kept. A
 * POSITIVE assertion is the opposite: the source has at most pre-generated
 * season rows for episodes that do not exist, and showing them produced the
 * device report — an unaired title with a full episode grid and a Watch
 * button over nothing. So the positive case wins over the source list, the
 * no-evidence case does not.
 */
export function nothingAiredYet(media: MediaDetail | undefined): boolean {
  if (!media) return false;
  return media.status === 'NOT_YET_RELEASED' || media.nextAiringEpisode?.episode === 1;
}

/**
 * Collapse repeated episode numbers to one row each, first occurrence winning.
 *
 * A repeated number is never a second episode — it is the source double-
 * serving a window (Bingr's chunks overlapped by exactly one 100-row chunk on
 * One Piece). The list screens key rows by number, so a duplicate is a crash
 * (two children with the same React key) plus a doubled count; this runs on
 * everything `episodesToShow` returns so no source bug can ever reach a list.
 */
function dedupeByNumber<T extends { number: number }>(rows: T[]): T[] {
  const seen = new Set<number>();
  return rows.filter((r) => {
    if (seen.has(r.number)) return false;
    seen.add(r.number);
    return true;
  });
}

/**
 * The rows a screen should show, whatever state the video sources are in.
 *
 * THE FALLBACK LIVES HERE, AND THAT IS THE POINT. It used to be a `catch` branch:
 * "if the extension threw, generate rows from AniList". That is a race, and it
 * lost in the most common case — the extension fails *before* AniList has landed,
 * `releasedCount` reads `undefined` as 0, nothing is generated, and because the
 * fetch effect deliberately does not depend on AniList, **nothing ever retries**.
 * The screen then said "No episodes available from any source yet" about a title
 * that had one. Deriving instead of catching means the rows appear whenever the
 * evidence does, in any order, and reappear if AniList arrives late.
 *
 * Order matters, and it is the reason this is not simply `clamped.length ?
 * clamped : generated`:
 *
 *   nothing aired    → NOTHING, not even source rows. A positive AniList
 *                      assertion outranks whatever the source pre-generated —
 *                      see `nothingAiredYet` (this used to lose to the branch
 *                      below, and an unaired title rendered a full grid of
 *                      dead tiles plus a Watch button).
 *   source has rows  → clamp them, dedupe them, keep them. A short list from a
 *                      real source is the source's answer and this screen does
 *                      not overrule it (or pad it — gaps stay gaps).
 *   source is empty  → AniList's released count, with generated titles. Still
 *                      navigable, which is the whole point of the fallback.
 *   neither          → nothing, and the screen says so.
 */
export function episodesToShow(
  source: EpisodeInfo[],
  media: MediaDetail | undefined
): EpisodeInfo[] {
  if (nothingAiredYet(media)) return [];
  const aired = releasedCount(media);
  // No evidence either way (no total, no schedule, no status): trust whatever
  // the source said — including an empty list, which stays empty rather than
  // being padded with guesses.
  if (aired <= 0) {
    return dedupeByNumber(clampToAired(source, aired));
  }
  // AniList is the source of truth for WHICH episodes exist: render one tile per
  // released episode, and decorate it with whatever the source (filmu) gave us
  // (poster, title, air date). Episodes the source did not list still get a
  // tile — a number chip — so a missing thumbnail never hides a released
  // episode. `nothingAiredYet` above already removed the unaired ones.
  const byNumber = new Map<number, EpisodeInfo>();
  for (const e of source) {
    if (!byNumber.has(e.number)) byNumber.set(e.number, e);
  }
  const rows: EpisodeInfo[] = [];
  for (let i = 1; i <= aired; i++) {
    const src = byNumber.get(i);
    rows.push(src ? { ...src } : { number: i, title: `Episode ${i}` });
  }
  return dedupeByNumber(rows);
}
