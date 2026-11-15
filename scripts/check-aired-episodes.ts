/**
 * The player must not offer episodes that do not exist yet — and a screen must
 * never show "no episodes" about a title that has one.
 *
 * WHY THIS NEEDS A CHECK. The details page had the rule and the watch page did
 * not, so the SAME title showed one episode on one screen and a whole season of
 * ghosts on the other. Then the inverse: a transient failure of the episode
 * fetch made the details page claim a title had no episodes at all. Both are
 * invisible to types, lint and the bundler — both screens compile, both render
 * rows, both are "correct" by every measure except the user's.
 *
 * The numbers here are REAL, taken from FilmU `/episodes?id=203473` on
 * 2026-10-11 (a title with 1 of 12 aired) and `/episodes?id=213657` the same day
 * (a premiere whose only episode had aired hours earlier). What they pin is
 * mostly the trap, which is the part that is easy to get wrong:
 *
 *   released    #1  airDate PAST   poster yes  description yes  "The Red Notebook"
 *   scheduled   #2  airDate FUTURE poster null description null "Episode 2"
 *   undated     #5  airDate null   poster null description null "Episode 5"
 *
 * `213657` is the reason this file exists in its current shape: its single
 * episode is REAL and playable, and it looks IDENTICAL to `203473`'s undated
 * ghosts — no date, no poster, no description, a title of "Episode 1". So every
 * tempting shortcut (drop rows with no poster, drop rows titled "Episode N", drop
 * rows with no description) DELETES THE EPISODE THE USER OPENED THE PAGE FOR.
 * The only honest cut is AniList's `nextAiringEpisode`.
 *
 * Run with:  npx -y tsx scripts/check-aired-episodes.ts
 */

import { clampToAired, episodesToShow, nextPlayableEpisode, nothingAiredYet, releasedCount } from '../lib/anilist/episodes';
import type { MediaDetail } from '../lib/anilist';

/**
 * The fixtures are real payloads from the live query, so they are typed as the
 * real thing: a `MediaDetail` the rule does not read is noise, but a fixture that
 * cannot be passed to the function under test is not a fixture.
 */
const media = (over: Partial<MediaDetail>): MediaDetail => ({
  id: 0,
  title: { romaji: 'fixture', english: undefined, native: undefined },
  coverImage: { large: '' },
  ...over,
});

const kyoufu = media({
  episodes: 12,
  status: 'RELEASING',
  nextAiringEpisode: { episode: 2, airingAt: 1790240000 },
});
/** Five out of nine — the shape where a failed fetch must still show rows. */
const midway = media({
  episodes: 9,
  status: 'RELEASING',
  nextAiringEpisode: { episode: 6, airingAt: 1790240000 },
});
const yozakura = media({
  episodes: 1,
  status: 'RELEASING',
  nextAiringEpisode: null, // AniList had no next episode scheduled
});
const finished = media({ episodes: 13, status: 'FINISHED', nextAiringEpisode: null });
const unreleased = media({ episodes: 12, status: 'NOT_YET_RELEASED' });
const unknown = media({ episodes: 24, status: null });

// The reported case, verbatim from AniList on 11 Oct: "The Laid-Off Cheat-Granting
// Mage Enjoys a Second Lease on Life" (207329). `episodes: null` — AniList has
// not decided the season length — while `nextAiringEpisode: { episode: 2 }` says
// episode 1 is out, which the sources confirm (streams ep1: 3 CDNs, ep2: 0).
// 15 of the 25 titles airing that week were shaped exactly like this.
const noTotal = media({
  episodes: null,
  status: 'RELEASING',
  nextAiringEpisode: { episode: 2, airingAt: 1791903600 },
});
// Same shape, three episodes in, and the "nothing has aired" edge.
const noTotalDeep = media({
  episodes: null,
  status: 'RELEASING',
  nextAiringEpisode: { episode: 4, airingAt: 1791903600 },
});
const noTotalUnstarted = media({
  episodes: null,
  status: 'RELEASING',
  nextAiringEpisode: { episode: 1, airingAt: 1791903600 },
});
/**
 * The OTHER zero: no total, no status, no schedule — AniList simply knows
 * nothing. `nothingAiredYet` must answer false here (absence of evidence is
 * not evidence of absence) so a source list that knows better is kept. This
 * fixture is the tripwire against "solving" the unaired report by showing
 * nothing on every zero.
 */
const noEvidence = media({
  episodes: null,
  status: null,
  nextAiringEpisode: null,
});
/** The unaired case's source rows: a source that pre-generated the season. */
const seasonRows = Array.from({ length: 12 }, (_, i) => ({
  number: i + 1,
  title: `Episode ${i + 1}`,
  poster: null,
  airDate: null as string | null,
}));

// What FilmU listed: 12 rows, one aired. Fields copied from the live response.
const kyoufuRows = [
  { number: 1, title: 'The Red Notebook', poster: 'u', airDate: '2026-10-10T14:45:00Z' },
  { number: 2, title: 'Episode 2', poster: null, airDate: '2026-10-17T14:45:00Z' },
  { number: 3, title: 'Episode 3', poster: null, airDate: '2026-10-24T14:45:00Z' },
  { number: 4, title: 'Episode 4', poster: null, airDate: '2026-10-31T14:45:00Z' },
  ...Array.from({ length: 8 }, (_, i) => ({
    number: i + 5,
    title: `Episode ${i + 5}`,
    poster: null,
    airDate: null as string | null,
  })),
];
const yozakuraRows = [{ number: 1, title: 'Episode 1', poster: null, airDate: null }];

let failures = 0;
function check(name: string, pass: boolean, detail = '') {
  if (pass) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const nums = (rows: Array<{ number: number }>) => rows.map((r) => r.number).join(',');

function main() {
  console.log('\nepisodes that have aired');

  // --- releasedCount, the three cases its note claims ------------------------
  check('an airing title with 1 of 12 out answers 1', releasedCount(kyoufu) === 1, String(releasedCount(kyoufu)));
  check('a finished title answers its full count', releasedCount(finished) === 13);
  check('an unreleased title answers 0', releasedCount(unreleased) === 0);
  // The failure this whitelist caused once: a status the function does not
  // enumerate must NOT fall through to 0.
  check('an unknown status is treated as "episodes exist"', releasedCount(unknown) === 24, String(releasedCount(unknown)));
  check('no media answers 0', releasedCount(undefined) === 0);
  // A premiere whose AniList row has no next episode must not be zeroed —
  // that would empty a list the source legitimately knows about.
  check(
    'a title with no next episode scheduled keeps its count',
    releasedCount(yozakura) === 1,
    String(releasedCount(yozakura))
  );

  // --- `episodes: null` is the common case, not an edge case ---------------
  // An AniList season total that does not exist is NOT a ceiling of zero. These
  // three are the reported bug: a first episode that is out, playable, and
  // reported as "no episodes available from any source yet".
  check(
    'an airing title with NO season total still counts what aired',
    releasedCount(noTotal) === 1,
    String(releasedCount(noTotal))
  );
  check(
    '…and does so as episodes are released under it',
    releasedCount(noTotalDeep) === 3,
    String(releasedCount(noTotalDeep))
  );
  check(
    '…but a show whose very first episode has not aired is still 0',
    releasedCount(noTotalUnstarted) === 0,
    String(releasedCount(noTotalUnstarted))
  );
  check(
    'the known-total clamp is unchanged, so ghosts stay hidden',
    releasedCount(kyoufu) === 1 && releasedCount(finished) === 13
  );

  // --- the clamp, on the real rows -----------------------------------------
  const kyoufuShown = clampToAired(kyoufuRows, releasedCount(kyoufu));
  check('the airing title shows exactly the episode that aired', nums(kyoufuShown) === '1', nums(kyoufuShown));

  // THE TRAP. Each of these is a plausible "fix" and each deletes the episode
  // the user came for. They are asserted because the next person to see ghost
  // rows will reach for exactly one of them.
  const byNoPoster = kyoufuRows.filter((r) => r.poster);
  check(
    '…and dropping rows with no poster would have deleted the real one too',
    byNoPoster.length === 1 && yozakuraRows.filter((r) => !r.poster).length === 1,
    `kyoufu kept ${nums(byNoPoster)}, yozakura kept 0 of 1`
  );
  const byPlaceholderTitle = yozakuraRows.filter((r) => !/^Episode \d+$/.test(r.title));
  check(
    '…as would dropping placeholder titles',
    byPlaceholderTitle.length === 0,
    `yozakura kept ${nums(byPlaceholderTitle)}`
  );
  check('…but the clamp keeps it', nums(clampToAired(yozakuraRows, releasedCount(yozakura))) === '1');

  // --- the clamp must not invent or renumber -------------------------------
  check('a finished title is untouched', nums(clampToAired(kyoufuRows, releasedCount(finished))) === nums(kyoufuRows));
  check('no evidence leaves the list alone', nums(clampToAired(kyoufuRows, 0)) === nums(kyoufuRows));
  check(
    'a source gap stays a gap (no padding)',
    nums(clampToAired([{ number: 1 }, { number: 5 }], 4)) === '1'
  );

  // --- the half the user reported: a failed fetch must not mean "no episodes"
  check('a real source list wins over the fallback', nums(episodesToShow(kyoufuRows, kyoufu)) === '1');
  check(
    'an empty source falls back to AniList’s released count',
    nums(episodesToShow([], midway)) === '1,2,3,4,5',
    nums(episodesToShow([], midway))
  );
  check(
    'the fallback arrives LATE, when AniList does',
    // The bug was a `catch` that read media before it existed and never
    // retried. Deriving means this needs no second attempt — asking again with
    // the payload that arrived is all it takes.
    episodesToShow([], undefined).length === 0 && nums(episodesToShow([], midway)) === '1,2,3,4,5'
  );
  check('an unreleased title with no source shows nothing', episodesToShow([], unreleased).length === 0);
  check('no source and no media shows nothing', episodesToShow([], undefined).length === 0);
  check(
    'a short real list is padded up to the aired count from AniList',
    nums(episodesToShow([{ number: 1 }, { number: 2 }], midway)) === '1,2,3,4,5'
  );
  // The report, end to end: the source list failed AND AniList has no total.
  // Before the fix this was empty — "no episodes" about a title with one.
  check(
    'a failed list + no season total still shows the episode that aired',
    nums(episodesToShow([], noTotal)) === '1',
    nums(episodesToShow([], noTotal))
  );

  // --- nothing aired yet: the positive assertion must win over source rows --
  // The device report of 10 Nov: an unaired title rendered a full episode grid
  // and a Watch button, because the source had pre-generated the season and
  // `episodesToShow` trusted it. (The old deliberate decision — an unreleased
  // show with a real source list keeps it — is overridden: tiles over nothing
  // are worse than a missing list.)
  check('the NOT_YET_RELEASED status is a positive assertion', nothingAiredYet(unreleased) === true);
  check(
    'a scheduled-but-unaired premiere is one too',
    nothingAiredYet(noTotalUnstarted) === true,
    `nextAiringEpisode.episode === ${noTotalUnstarted.nextAiringEpisode?.episode}`
  );
  check('a releasing title is not unaired', nothingAiredYet(kyoufu) === false);
  check('a finished title is not unaired', nothingAiredYet(finished) === false);
  check('no media is not unaired', nothingAiredYet(undefined) === false);
  check(
    '…and the no-evidence zero is NOT unaired — sources are still trusted there',
    nothingAiredYet(noEvidence) === false && nums(episodesToShow(seasonRows, noEvidence)) === nums(seasonRows),
    `nothingAiredYet=${nothingAiredYet(noEvidence)}`
  );
  check(
    'an unaired title shows nothing even when the source pre-generated the season',
    episodesToShow(seasonRows, unreleased).length === 0,
    `kept ${episodesToShow(seasonRows, unreleased).length} rows`
  );
  check(
    '…and its fallback generates nothing either',
    episodesToShow([], unreleased).length === 0
  );

  // --- a repeated episode number is not a second episode --------------------
  // One Piece, 10 Nov: Bingr's chunk windows overlapped by exactly one
  // 100-row chunk — 1274 rows for 1174 numbers. The details page keys rows by
  // number, so every duplicate was TWO children with the same React key: the
  // VirtualizedList crashed on open, and the count read 1274 for a list
  // ending at 1174.
  const dupeRows = [
    { number: 1, title: 'Ep 1', poster: null },
    { number: 2, title: 'Ep 2', poster: null },
    { number: 2, title: 'Ep 2 (repeat)', poster: null },
    { number: 3, title: 'Ep 3', poster: null },
  ];
  check(
    'duplicate episode numbers collapse to one row',
    nums(episodesToShow(dupeRows, noEvidence)) === '1,2,3',
    nums(episodesToShow(dupeRows, noEvidence))
  );
  check(
    'the dedupe survives the padding too (the crash shape, end to end)',
    nums(episodesToShow(dupeRows, midway)) === '1,2,3,4,5',
    nums(episodesToShow(dupeRows, midway))
  );

  // --- the source must not treat an empty response as an answer -------------
  // Invisible to every other check: caching `[]` for an hour made a flaky
  // response look like a title with no episodes, which is the exact report.
  const filmu = readFile(`${root()}/lib/extensions/filmu/index.ts`, 'utf8');
  const raw = /async function rawEpisodes[\s\S]*?\n  }/.exec(filmu)?.[0] ?? '';
  check(
    'an empty episode list throws instead of resolving',
    /if \(!out\.length\) throw new Error\('Bingr returned no episodes'\)/.test(raw),
    raw ? 'no throw in rawEpisodes' : 'rawEpisodes not found'
  );
  check(
    '…so it can never be cached',
    raw.indexOf('throw') !== -1 && raw.indexOf('episodesCache.set') > raw.indexOf('throw'),
    'the cache is written before the guard'
  );
  check(
    'and the streams path throws on empty too (the old asymmetry is still gone)',
    /if \(!ranked\.length\) throw new Error\('Bingr: all streams dead'\)/.test(filmu)
  );

  // --- and the screens must derive, not catch ------------------------------
  // The watch route IS the fullscreen player now — it renders no episode list,
  // so the only row derivation left in the app is the details page's. The
  // racing-copy check still scans both files: a stale copy in either is a bug.
  const watch = readFile(`${root()}/app/watch/[id]/[ep].tsx`, 'utf8');
  const detail = readFile(`${root()}/app/anime/[id].tsx`, 'utf8');
  check('the details page derives its rows', /episodesToShow\(episodes, media\)/.test(detail));
  check(
    'no screen generates rows in a catch any more',
    !/Array\.from\(\{ length: aired/.test(watch) && !/Array\.from\(\{ length: aired/.test(detail),
    'a racing copy of the fallback is back'
  );
  check(
    'the details page gates its empty state on the derived list',
    /!episodesPending && airedEpisodes\.length === 0/.test(detail)
  );
  check(
    '…and shows the skeleton while the source is still in flight',
    /activeTab === 'episodes' && episodesPending \? <EpisodeLoading \/>/.test(detail),
    'the skeleton still gates on the raw `tab` state — it diverges from the strip when the episodes tab is hidden'
  );

  // --- the unaired title shows nothing, on the screen as well as the list ----
  check(
    'the details page hides the Watch button over nothing',
    /\{!nothingAired && \(/.test(detail)
  );
  check('the details page hides the Episodes tab for an unaired title', /hidden: nothingAired/.test(detail));
  check(
    'the tab body follows the strip, not the possibly-hidden state',
    /const activeTab: Tab \| undefined = visibleTabs\.some/.test(detail) && /const data = activeTab === 'episodes' \? paged : \[\]/.test(detail)
  );

  // --- the chunk cap is a safety bound, not the stopping condition ----------
  // The One Piece report: 6 chunks silently truncated 1100+ episodes to ~500 —
  // the count was the cap, not the source. `has_next_page` is the real stop;
  // the cap only exists so a broken upstream answering `true` forever
  // terminates. Pin the ceiling high enough for the longest list that exists.
  const capMatch = /const MAX_EPISODE_CHUNKS = (\d+)/.exec(filmu);
  check(
    'the episode chunk cap covers a 1100+ episode list',
    capMatch !== null && Number(capMatch[1]) >= 30,
    capMatch ? `MAX_EPISODE_CHUNKS = ${capMatch[1]}` : 'the constant is gone'
  );
  check(
    'the chunk loop still stops on has_next_page, not on the cap alone',
    /if \(!j\?\.has_next_page \|\| rows\.length <= 0\) break;/.test(raw)
  );
  check(
    'the chunk accumulator dedupes by episode number',
    /const seen = new Set<number>\(\)/.test(raw) && /if \(seen\.has\(n\)\) continue;/.test(raw),
    'overlapping chunk windows will double-serve rows (the One Piece 1274-for-1174 crash)'
  );

  // --- auto-advance: the episode the player may hand the viewer to ----------
  // The 15 Nov device report: the player sat parked on the ended frame forever.
  // The rule must be releasedCount, not the season total — advancing by
  // `epNum < episodes` walks an airing show into an unaired episode.
  console.log('\nauto-advance availability');
  check(
    'the last AIRED episode of an airing show does not advance',
    nextPlayableEpisode(1, kyoufu) === null,
    `would resolve into unaired episode ${nextPlayableEpisode(1, kyoufu)}`
  );
  check(
    'mid-season advances to the next aired episode',
    nextPlayableEpisode(4, midway) === 5
  );
  check(
    'the last aired of a mid-season show does not advance',
    nextPlayableEpisode(5, midway) === null,
    `episodes 6-9 exist in the season but have not aired`
  );
  check(
    'a finished show advances up to its final episode',
    nextPlayableEpisode(12, finished) === 13
  );
  check(
    'the FINAL episode of a finished show does not advance',
    nextPlayableEpisode(13, finished) === null
  );
  check(
    'an unreleased title never advances',
    nextPlayableEpisode(1, unreleased) === null
  );
  check(
    'the only aired episode of an episodes:null show does not advance',
    nextPlayableEpisode(1, noTotal) === null,
    'episode 1 is the last one that exists (nextAiringEpisode: 2)'
  );
  check(
    'an episodes:null airing show advances to its aired count',
    nextPlayableEpisode(1, noTotalDeep) === 2 && nextPlayableEpisode(2, noTotalDeep) === 3
  );
  check(
    'no evidence (no total, no status, no schedule) stays put',
    nextPlayableEpisode(1, noEvidence) === null,
    'guessing high lands on a resolve failure mid-binge'
  );
  check(
    'a bad route param (0/NaN) never advances',
    nextPlayableEpisode(0, finished) === null && nextPlayableEpisode(NaN, finished) === null
  );

  console.log(failures ? `\n${failures} failed\n` : '\nall passed\n');
  process.exit(failures ? 1 : 0);
}

// Declared rather than imported from 'node:*': this project carries no
// `@types/node` and the app's tsconfig has no use for one.
declare const require: (id: string) => {
  readFileSync(path: string, encoding: 'utf8'): string;
};
const { readFileSync } = require('node:fs');
const root = () => process.cwd();
const readFile = (p: string, e: 'utf8') => readFileSync(p, e);

main();
