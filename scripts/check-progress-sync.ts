/**
 * AniList progress must only ever move FORWARD.
 *
 * `SaveMediaListEntry` takes `progress` as an absolute value. There is no
 * server-side `max()`, so whatever number the app sends becomes the number
 * AniList shows. That makes a rewatch a genuine hazard rather than a cosmetic
 * one: the watch screen's own guard is a per-episode `miori:synced:` flag, and
 * that flag only knows about episodes THIS PHONE reported. An entry added on the
 * web, on another device, or by hand has no local flag, so rewatching episode 2
 * of a show AniList has you on at episode 5 used to send `progress: 2` and roll
 * the list back.
 *
 * The bug is invisible in the happy path — progress is only ever written when it
 * should be — and its damage lands on someone else's account, silently, weeks
 * apart. So the decision table is pinned here rather than left to inspection.
 *
 * The rows that matter most are the ones that must NOT be blocked: an untracked
 * title, and the next new episode. A guard that stops those would silently break
 * syncing to protect against a regression that is now impossible.
 *
 * Run with:  npx tsx scripts/check-progress-sync.ts
 */

import { advancesProgress } from '../lib/anilist/progress';
import type { ListEntry } from '../lib/anilist/lists';

let failures = 0;
function check(name: string, pass: boolean, detail = '') {
  if (pass) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function entry(progress: number, status: ListEntry['status'] = 'CURRENT'): ListEntry {
  return {
    id: 1,
    status,
    progress,
    score: 0,
    private: false,
    repeat: 0,
    priority: 0,
    notes: null,
  };
}

function main() {
  console.log('\nprogress sync direction');

  // --- the regression this exists to stop -------------------------------
  check(
    'rewatching episode 2 with AniList on 5 does NOT send',
    !advancesProgress(entry(5), 2),
    'would have rolled AniList back to episode 2'
  );
  check(
    'the same episode again does not send either',
    !advancesProgress(entry(5), 5),
    'already at that episode'
  );

  // --- and the writes that must still happen ----------------------------
  check('the next new episode DOES send', advancesProgress(entry(5), 6));
  check('a show with no progress DOES send', advancesProgress(entry(0), 1));
  check(
    'an untracked title DOES send — null means not on the list',
    advancesProgress(null, 1),
    'this is the case that most needs the write'
  );
  check(
    'a not-yet-loaded entry DOES send',
    advancesProgress(undefined, 1),
    'undefined must not be treated as "already ahead"'
  );

  // --- the boundary, which is where an off-by-one would hide -----------
  check('exactly one behind sends', advancesProgress(entry(4), 5));
  check('exactly level does not send', !advancesProgress(entry(5), 5));
  check(
    'an entry AHEAD of the episode does not send either — that would lower it',
    !advancesProgress(entry(6), 5),
    'AniList on 6 must not be rolled back to 5 by watching episode 5 again'
  );

  // --- the status is irrelevant to the direction ----------------------
  // A REPEATING entry keeps climbing past the episode count, so progress must
  // never be clamped by status. This guards against a "fix" that consults it.
  check(
    'a REPEATING entry is judged on progress alone',
    advancesProgress(entry(2, 'REPEATING'), 3) && !advancesProgress(entry(9, 'REPEATING'), 3),
    'status must not affect whether progress moves forward'
  );
  check(
    'a COMPLETED entry can still be advanced',
    advancesProgress(entry(1, 'COMPLETED'), 2),
    'a finished show rewatched should still sync forward'
  );

  // --- edited down by hand must move forward again ---------------------
  // Deliberately asymmetric: the user lowered it, so honour that.
  check(
    'an entry edited down by hand can be moved forward again',
    advancesProgress(entry(2), 3),
    'a symmetric guard would freeze the entry forever'
  );

  console.log(failures ? `\n${failures} failed\n` : '\nall passed\n');
  process.exit(failures ? 1 : 0);
}

main();