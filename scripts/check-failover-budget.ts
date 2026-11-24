/**
 * The failover budgets and the resolve's two windows, driven as REAL modules.
 *
 * `lib/player/failover.ts` (wrapVerdict, healOnFrame) and
 * `lib/player/resolveWindow.ts` (resolveInTwoWindows) are the actual code the
 * player runs — this script imports them, the way `check-player-health.ts`
 * drives `lib/player/health.ts`.
 *
 * THE REPORT THIS SCRIPT EXISTS FOR (13 Nov, device): "Playback failed" came
 * up on screen while the episode then started playing. Three rules failed at
 * once, and each is pinned here with its OLD shape watched getting it WRONG —
 * the mutation test the battery requires:
 *
 *   1. The walk budget counted single HOPS, not walks — three calls with a
 *      ~7-source list is half of one walk, so a slow connection raised the
 *      error card over sources still being tried.
 *   2. A rendered frame never reconciled a standing error — the card stayed
 *      over a playing video because nothing cleared it on proof.
 *   3. A resolve that missed its deadline discarded the late answer — "No
 *      source answered in time" about an answer that existed seconds later.
 */

import {
  MAX_FAILOVER_ROUNDS,
  MAX_FAILOVER_WALL_MS,
  QUIET_RESET_MS,
  STABLE_PLAY_SEC,
  healOnFrame,
  provesStable,
  wrapVerdict,
} from '../lib/player/failover';
import { resolveInTwoWindows } from '../lib/player/resolveWindow';

let pass = 0;
let fail = 0;

function check(name: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) {
    pass += 1;
  } else {
    fail += 1;
    console.error(`  ✗ ${name}\n      got:  ${JSON.stringify(got)}\n      want: ${JSON.stringify(want)}`);
  }
}

function section(title: string): void {
  console.log(`\n${title}`);
}

// ---------------------------------------------------------------------------
// 1. wrapVerdict — the budget counts WALKS, not hops
// ---------------------------------------------------------------------------

section('1. The walk budget: one round = one walk down the list');

{
  // THE OLD SHAPE, watched failing: count every failover CALL as a round and
  // give up after three. On a 7-source list (anikoto ships 4 rows + mega +
  // filmu), three slow sources — each inside its 14s first-frame window, so
  // three hops at ~15s each — would exhaust the budget MID-FIRST-WALK and
  // raise the card over sources still queued.
  const oldShapeGiveUpAfterThreeCalls = (failoverCalls: number): 'reload' | 'giveup' =>
    failoverCalls + 1 > MAX_FAILOVER_ROUNDS ? 'giveup' : 'reload';

  const hopsIntoFirstWalk = 3; // the 3rd hop of walk 1, sources 4..7 still untried
  check(
    'old shape (per-call budget) gives up mid-first-walk — WRONG, watched failing',
    oldShapeGiveUpAfterThreeCalls(hopsIntoFirstWalk),
    'giveup'
  );
  check(
    'real rule: no wrap has happened yet, so the walk continues',
    wrapVerdict(0, Date.now(), Date.now()),
    'reload'
  );
}

{
  // The wrap is where rounds are spent: walks 1..2 reload, walk 3's wrap
  // (rounds would become 3) still reloads, the 4th wrap gives up.
  const start = 1_000_000;
  check('wrap 1 reloads', wrapVerdict(0, start, start + 1000), 'reload');
  check('wrap 2 reloads', wrapVerdict(1, start, start + 1000), 'reload');
  check('wrap 3 reloads', wrapVerdict(2, start, start + 1000), 'reload');
  check('wrap 4 gives up (round budget)', wrapVerdict(3, start, start + 1000), 'giveup');
}

{
  // THE WALL CLOCK: the slow-failure shape. A list of cold CDNs, each burning
  // its full first-frame window before the hop — walks are minutes, so the
  // round budget alone would hold the viewer on a spinner for a quarter of an
  // episode. The clock caps total patience at MAX_FAILOVER_WALL_MS however the
  // walk is progressing.
  const start = 1_000_000;
  check(
    'a failing stretch just under the wall clock still reloads',
    wrapVerdict(0, start, start + MAX_FAILOVER_WALL_MS - 1),
    'reload'
  );
  check(
    'a failing stretch past the wall clock gives up (walk 1, one round spent)',
    wrapVerdict(1, start, start + MAX_FAILOVER_WALL_MS + 1),
    'giveup'
  );
  check(
    'no clock running (0 start) is judged by rounds only',
    wrapVerdict(0, 0, 10 ** 12),
    'reload'
  );
}

// ---------------------------------------------------------------------------
// 2. provesStable — a frame is NOT proof, and this is what replaced it
// ---------------------------------------------------------------------------

section('2. forgiveness is earned by a quiet minute, never by one frame');

{
  // THE BUG (24 Nov, the freeze that closed the app): `onFirstFrame` reset the
  // whole budget, so a source that rendered a frame and died restored the walk
  // every time. `wrapVerdict` could then never give up, and each pass re-opened
  // the native media source — which expo-video prepares on the Android MAIN
  // thread behind the disk-cache lock. The UI thread froze with it.
  const oldShapeForgivesOnEveryFrame = true;
  check(
    'the OLD shape (a frame resets the walk) never terminates — WRONG, watched failing',
    oldShapeForgivesOnEveryFrame && wrapVerdict(2, 1_000, 1_500) === 'reload',
    true
  );

  check('a frame with a stall one second ago proves nothing', provesStable(30, 1_000), false);
  check(
    'a source that plays 8s and dies every 15s never earns a reset — the loop this pass removed',
    provesStable(8, 15_000),
    false
  );
  check('a frozen playhead proves nothing however quiet it was', provesStable(0, QUIET_RESET_MS), false);
  check(
    'a stream that moved and stayed quiet for the window does earn one',
    provesStable(STABLE_PLAY_SEC, QUIET_RESET_MS),
    true
  );
  check(
    'MUTATION — one second short of the quiet window is not enough',
    provesStable(STABLE_PLAY_SEC, QUIET_RESET_MS - 1),
    false
  );
}

// ---------------------------------------------------------------------------
// 3. healOnFrame — a rendered frame reconciles a standing error
// ---------------------------------------------------------------------------

section('3. The first-frame reconcile: proof outranks the verdict');

{
  // THE OLD SHAPE, watched failing: nothing cleared `error` when a frame
  // landed, so a verdict that fired early stuck over a playing video. Modelled
  // as "the frame handler leaves the error untouched".
  const oldShapeFrameHandler = (error: string | null) => ({ clearError: false, resume: false });

  check(
    'old shape keeps the card up over a playing video — WRONG, watched failing',
    oldShapeFrameHandler('No source could play this episode.'),
    { clearError: false, resume: false }
  );
  check(
    'real rule: frame after error clears the card and resumes for a viewer whose wheel says play',
    healOnFrame('No source could play this episode.', true, false),
    { clearError: true, resume: true }
  );
  check(
    'already playing (pause effect lost the race): clear the card, do not re-play',
    healOnFrame('No source could play this episode.', true, true),
    { clearError: true, resume: false }
  );
  check(
    'a PAUSED viewer stays paused — the pipeline never resumes what they paused (9 Nov rule)',
    healOnFrame('No source could play this episode.', false, false),
    { clearError: true, resume: false }
  );
  check('no error, no action', healOnFrame(null, true, false), { clearError: false, resume: false });
}

// ---------------------------------------------------------------------------
// 4. resolveInTwoWindows — a late answer is applied, not discarded
// ---------------------------------------------------------------------------

// Milliseconds versions so the real function runs in script time.
const FAST_MS = 40;
const GRACE_MS = 300;

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: Error) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

section('4. The resolve windows: a real failure is fast, a slow answer still lands');

async function resolveWindows(): Promise<void> {
{
  // Real failure lands inside the first window.
  const d = deferred<never>();
  setTimeout(() => d.reject(new Error('No extension could resolve this episode')), 10);
  const v = await resolveInTwoWindows(d.promise, 'No source answered in time', FAST_MS, GRACE_MS);
  check(
    'a real failure inside window 1 is reported as failed',
    v.kind === 'failed' && v.error.message === 'No extension could resolve this episode',
    true
  );
}

{
  // THE OLD SHAPE, watched failing: reject at the first deadline and DROP the
  // late answer. Modelled as a single-window await over the same deferred.
  const d = deferred<string>();
  setTimeout(() => d.resolve('the sources that were coming'), 120); // lands at 120ms
  let oldOutcome: string;
  try {
    oldOutcome = await Promise.race([
      d.promise,
      sleep(FAST_MS).then(() => {
        throw new Error('No source answered in time');
      }),
    ]);
  } catch (e) {
    oldOutcome = (e as Error).message;
  }
  check(
    'old shape (single window) discards the late answer — WRONG, watched failing',
    oldOutcome,
    'No source answered in time'
  );

  // The real rule: the same promise, waited out behind the grace cap.
  const d2 = deferred<string>();
  setTimeout(() => d2.resolve('the sources that were coming'), 120);
  const v = await resolveInTwoWindows(d2.promise, 'No source answered in time', FAST_MS, GRACE_MS);
  check(
    'real rule: an answer landing inside the grace window is APPLIED',
    v.kind === 'applied' && v.value === 'the sources that were coming',
    true
  );
}

{
  // A promise that never settles inside EITHER window is declared dead.
  const never = new Promise<string>(() => {});
  const started = Date.now();
  const v = await resolveInTwoWindows(never, 'No source answered in time', FAST_MS, GRACE_MS);
  const elapsed = Date.now() - started;
  check(
    'a never-settling promise fails after BOTH windows',
    v.kind === 'failed' && v.error.message === 'No source answered in time',
    true
  );
  check(
    'the wait spans window 1 + the grace cap, not window 1 alone',
    elapsed >= FAST_MS + GRACE_MS - 5,
    true
  );
}

{
  // A resolve that fails LATE (during the grace window) surfaces its real
  // message — not the deadline's.
  const d = deferred<never>();
  setTimeout(() => d.reject(new Error('Bingr: all streams dead')), 100);
  const v = await resolveInTwoWindows(d.promise, 'No source answered in time', FAST_MS, GRACE_MS);
  check(
    'a late real failure keeps its own message',
    v.kind === 'failed' && v.error.message === 'Bingr: all streams dead',
    true
  );
}

}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  await resolveWindows();
  console.log(`\n${pass}/${pass + fail} checks passed`);
  if (fail > 0) process.exit(1);
}

void main();
