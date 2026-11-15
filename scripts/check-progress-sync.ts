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

import { advancesProgress, planProgressSync } from '../lib/anilist/progress';
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

  // ======================================================================
  // THE SYNC PLAN — what a watch may actually send (15 Nov device report)
  // ======================================================================
  console.log('\nprogress sync plan');

  // --- THE BUG THE DEVICE CAUGHT ---------------------------------------
  // A PLANNING entry whose cached progress already sits at or past the watched
  // episode used to resolve the mutation with NOTHING sent — the caller read
  // that as success ("marked"), and the entry sat in Planning forever, because
  // the only write that would have promoted it was the one the guard skipped.
  // The plan promotes Planning → CURRENT on ANY watched episode, status only.
  const promoted = planProgressSync(entry(12, 'PLANNING'), 3);
  check(
    'a PLANNING entry past the watched episode is still promoted',
    promoted.write === true && promoted.status === 'CURRENT',
    `the old shape resolved with no write at all (got ${JSON.stringify(promoted)})`
  );
  check(
    'the promotion sends NO progress — it can never roll the account back',
    promoted.progress === undefined,
    'a status-only write must not carry an absolute progress value'
  );

  // --- the forward path is byte-for-byte what the mutation always sent ---
  const forward = planProgressSync(entry(0, 'PLANNING'), 1);
  check(
    'a fresh PLANNING entry advances and promotes in one write',
    forward.write && forward.progress === 1 && forward.status === 'CURRENT'
  );
  const plain = planProgressSync(entry(5, 'CURRENT'), 6, { episodes: 12 });
  check(
    'a CURRENT entry on a new episode sends progress and no status',
    plain.write && plain.progress === 6 && plain.status === undefined
  );
  const untracked = planProgressSync(null, 1);
  check(
    'an untracked title writes progress + CURRENT',
    untracked.write && untracked.progress === 1 && untracked.status === 'CURRENT'
  );
  const unloaded = planProgressSync(undefined, 1);
  check(
    'a not-yet-loaded entry writes too — undefined is not "already ahead"',
    unloaded.write && unloaded.progress === 1 && unloaded.status === 'CURRENT'
  );

  // --- the guard cases: a rewatch of a deliberate state sends nothing ---
  check(
    'CURRENT past the episode sends nothing',
    planProgressSync(entry(5, 'CURRENT'), 2).write === false
  );
  check(
    'CURRENT level with the episode sends nothing',
    planProgressSync(entry(5, 'CURRENT'), 5).write === false
  );
  check(
    'REPEATING is judged on progress alone — past sends nothing',
    planProgressSync(entry(9, 'REPEATING'), 3).write === false
  );
  check(
    'REPEATING behind still climbs',
    (() => { const p = planProgressSync(entry(2, 'REPEATING'), 3); return p.write && p.progress === 3 && p.status === undefined; })(),
    'a REPEATING entry must not be flipped out of REPEATING by a forward write'
  );
  check(
    'PAUSED is a deliberate state — a silent rewatch does not promote it',
    planProgressSync(entry(12, 'PAUSED'), 3).write === false
  );
  check(
    'DROPPED is a deliberate state — a silent rewatch does not promote it',
    planProgressSync(entry(12, 'DROPPED'), 3).write === false
  );
  check(
    'COMPLETED past the episode sends nothing',
    planProgressSync(entry(12, 'COMPLETED'), 3).write === false
  );

  // --- the finale rule, carried over from the old canComplete ----------
  const finale = planProgressSync(entry(11, 'CURRENT'), 12, { episodes: 12, status: 'FINISHED' });
  check(
    'the finale of a finished show completes',
    finale.write && finale.progress === 12 && finale.status === 'COMPLETED'
  );
  const airingFinale = planProgressSync(entry(11, 'CURRENT'), 12, { episodes: 12, status: 'RELEASING' });
  check(
    'episode N of an AIRING show is never "the finale"',
    airingFinale.write && airingFinale.progress === 12 && airingFinale.status === undefined
  );
  const unknownTotal = planProgressSync(entry(11, 'CURRENT'), 12, { episodes: null });
  check(
    'an unknown total can never complete',
    unknownTotal.write && unknownTotal.status === undefined
  );
  const planningFinale = planProgressSync(entry(12, 'PLANNING'), 12, { episodes: 12, status: 'FINISHED' });
  check(
    'a PLANNING entry at the finale of a finished show COMPLETES, not just promotes',
    planningFinale.write && planningFinale.progress === undefined && planningFinale.status === 'COMPLETED'
  );

  console.log(failures ? `\n${failures} failed\n` : '\nall passed\n');
  process.exit(failures ? 1 : 0);
}

main();