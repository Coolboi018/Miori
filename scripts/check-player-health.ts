// Pins the player's resilience model, without needing a device.
//
//   npx tsx scripts/check-player-health.ts
//
// ═══════════════════════════════════════════════════════════════════════════
// WHAT WAS BROKEN
//
// The landscape player had a FIRST-FRAME watchdog and nothing else. It was
// armed by `replaceAsync` and cancelled by the first rendered frame, so the only
// question it could ever answer was "this source never started". A stream that
// played for ten minutes and then died on a train held an indefinite spinner:
// `statusChange` stayed 'loading', no frame event ever fired again, and nothing
// in that loop could change the outcome because every input to it had already
// been delivered.
//
// `progress.md` claimed a "30s stall watchdog" was done. It was `STALL_MS` in
// the old vertical player (since deleted) — the screen that was PARKED when the
// landscape player replaced it — and it was not carried over.
// A confident note that outlives the line of code it describes is the single
// most expensive kind of wrong documentation in this project.
//
// ═══════════════════════════════════════════════════════════════════════════
// WHY THE RULES LIVE IN A SEPARATE MODULE
//
// `lib/player/health.ts` and `lib/player/failure.ts` import nothing, so this
// script runs the code that SHIPS rather than a model of it. The lesson is
// already recorded in `progress.md` via `check-nav-dedupe.ts`: a model in a
// check proves nothing about the code unless the check also reads the rules off
// the source. Where a rule IS a source-level shape — a gate, a guard, a missing
// control — it is asserted against the file at the bottom instead.
//
// ═══════════════════════════════════════════════════════════════════════════
// THE FOUR TRAPS, AND THE MUTATIONS THAT PROVE THE CHECK CAN SEE THEM
//
// Every behavioural section below runs a mutated variant of the rule and
// asserts it produces a DIFFERENT verdict. A mutation that cannot change the
// answer is a check nobody has seen fail, which is the thing this file is
// written to avoid.
//
//   1. An unknowable buffer is not an empty one     (`bufferedPosition === -1`)
//   2. A paused playhead is not a stalled one
//   3. A backgrounded app is not a dead one
//   4. A downgrade must not be forgotten the instant the buffer thickens

import {
  bufferAhead,
  healthProfile,
  MOVE_EPS,
  noteInterruption,
  noteSeek,
  observeHealth,
  resetHealth,
  SEEK_STALL_MS,
  STALL_MS,
  type HealthProfile,
  type HealthSample,
  type HealthState,
  type PlaybackStatus,
} from '../lib/player/health';
import { describeFailure } from '../lib/player/failure';

// Declared rather than imported from 'node:*': this project carries no
// @types/node, and the other source-reading checks do exactly this.
declare const require: (id: string) => {
  readFileSync(path: string, encoding: 'utf8'): string;
};
const { readFileSync } = require('node:fs');

declare const process: { cwd(): string; exit(code: number): never };

let failures = 0;
function check(name: string, pass: boolean, detail = ''): void {
  if (pass) {
    console.log(`  pass  ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const approx = (a: number, b: number) => Math.abs(a - b) < 0.005;

/**
 * The ARGUMENT TEXT of a `useCallback(` declaration — its arrow function, with
 * the dependency array removed.
 *
 * Two ways this was wrong before, both caught by deliberately deleting the rule
 * and watching the check stay green:
 *   - Cutting at the next top-level `const` swallowed the FOLLOWING JSDOC BLOCK,
 *     which names the same functions.
 *   - Cutting at the declaration's `);` swallowed the DEPENDENCY ARRAY, which is
 *     `[player, seekWithGrace]` — so a check searching the result for
 *     `seekWithGrace` passes on a body that never calls it.
 * The array is stripped rather than avoided, and the call site asserts it is
 * gone, so a change that reintroduces one fails the check rather than quietly
 * emptying it.
 */
function callbackArgs(source: string, declarationStart: string): string {
  const i = source.indexOf(declarationStart);
  if (i < 0) return '';
  const end = source.indexOf('\n  );', i);
  const text = end < 0 ? source.slice(i) : source.slice(i, end);
  return text.replace(/,\s*\[[\s\S]*\]\s*$/, '');
}

// ---------------------------------------------------------------------------
// A scripted clock.
//
// Samples are fed to the REAL `observeHealth` — only the clock and the sample
// values are faked, which is the whole point: the decision function under test
// is the shipping one.
// ---------------------------------------------------------------------------
interface Step {
  /** Milliseconds since the previous step. */
  dt: number;
  position: number;
  /** Seconds of media ahead of the playhead, or `null` for "unknowable". */
  ahead: number | null;
  playing?: boolean;
  status?: PlaybackStatus;
  /**
   * Force this sample through a deliberately broken variant of the rules, so
   * the mutation can be shown to change the verdict. Omitted for real runs.
   */
  mutateAs?:
    | 'unknown-is-zero'
    | 'ignore-playing'
    | 'no-seek-grace';
}

interface Run {
  kinds: string[];
  last: HealthState;
}

/**
 * Which variant of the rules to run.
 *
 * The mutations are not re-implementations of the module — they are the module
 * with ONE rule deliberately broken, applied to the same samples, so a mutation
 * that cannot move the verdict proves the rule is doing nothing.
 */
type Mode = 'correct' | 'mutate';

function run(
  profile: HealthProfile,
  steps: Step[],
  mode: Mode = 'correct',
  start: HealthState | null = null,
  mutation?: Step['mutateAs']
): Run {
  let state = start ?? resetHealth(0);
  let t = 0;
  const kinds: string[] = [];
  for (const raw of steps) {
    const step = mode === 'mutate' && mutation ? { ...raw, mutateAs: mutation } : raw;
    t += step.dt;
    const sample: HealthSample = {
      position: step.position,
      buffered:
        step.ahead === null ? -1 : step.position + step.ahead,
      status: step.status ?? 'readyToPlay',
      playing: step.playing ?? true,
      at: t,
    };

    let verdict = observeHealth(state, sample, profile);

    if (step.mutateAs) {
      switch (step.mutateAs) {
        // TRAP 1, mutated: treat "unknowable" as "zero buffered". This is the
        // single most expensive bug available in this domain, because it turns a
        // stream that is about to play perfectly into one that gets failed over
        // and then quality-dropped.
        case 'unknown-is-zero': {
          const forced: HealthSample = { ...sample, buffered: sample.position };
          verdict = observeHealth(state, forced, profile);
          break;
        }
        // TRAP 2, mutated: ignore `playing`. A paused viewer is then a dead CDN.
        case 'ignore-playing': {
          const forced: HealthSample = { ...sample, playing: true };
          verdict = observeHealth(state, forced, profile);
          break;
        }
        // The seek's extended window, removed. Our own forward-skip then reads
        // as a dead source and spends a failover round on a healthy stream.
        case 'no-seek-grace': {
          const stripped: HealthState = { ...state, deadlineAt: state.lastMovedAt + STALL_MS };
          verdict = observeHealth(stripped, sample, profile);
          break;
        }
      }
    }

    state = verdict.state;
    kinds.push(verdict.health.kind);
  }

  return { kinds, last: state };
}

/** A healthy stream: playing, one second of progress per second, healthy ahead. */
function healthy(seconds: number, ahead = 30): Step[] {
  return Array.from({ length: seconds }, (_, i) => ({
    dt: 1000,
    position: i + 1,
    ahead,
  }));
}

const DEFAULT = healthProfile(30);

// ---------------------------------------------------------------------------
// 1. The basic verdicts
// ---------------------------------------------------------------------------
console.log('\n1. the ordinary cases\n');

check('a fresh monitor reports nothing rather than a verdict', resetHealth(0) !== undefined);
check(
  'a playing, advancing stream is ok',
  run(DEFAULT, healthy(10)).kinds[9] === 'ok',
  `got ${run(DEFAULT, healthy(10)).kinds[9]}`
);
check(
  'a healthy stream never reports starving',
  !run(DEFAULT, healthy(120)).kinds.includes('starving'),
  `got ${[...new Set(run(DEFAULT, healthy(120)).kinds)].join(', ')}`
);

// Sub-MOVE_EPS jitter is not movement. A paused or ended item produces
// float noise on `currentTime`, and treating it as progress would mask every
// stall forever — which is how a watchdog ends up inert.
{
  let state = resetHealth(0);
  let t = 0;
  for (let i = 0; i < 40; i++) {
    t += 1000;
    state = observeHealth(
      state,
      { position: 100 + i * MOVE_EPS * 0.5, buffered: 130, status: 'readyToPlay', playing: true, at: t },
      DEFAULT
    ).state;
  }
  check(
    'sub-MOVE_EPS jitter does not read as progress',
    t - state.lastMovedAt >= 39_000,
    `the clock advanced only ${(t - state.lastMovedAt) / 1000}s of 39`
  );
}

// ---------------------------------------------------------------------------
// 2. TRAP 1 — an unknowable buffer is not an empty buffer
// ---------------------------------------------------------------------------
console.log('\n2. trap 1 — `bufferedPosition: -1` is an ABSENCE, not a zero\n');

check('bufferAhead(-1, 100) is null, not 0', bufferAhead(-1, 100) === null);
check('bufferAhead(-1, 0) is null', bufferAhead(-1, 0) === null);
check('bufferAhead(NaN, 10) is null', bufferAhead(Number.NaN, 10) === null);
check('bufferAhead(130, 100) is 30', approx(bufferAhead(130, 100) ?? 0, 30));
check(
  'a buffer behind the playhead clamps to 0, never goes negative',
  bufferAhead(90, 100) === 0,
  `got ${bufferAhead(90, 100)} — a negative "seconds ahead" makes a healthy stream look broken`
);

// The stream a real `-1` burst happens on: playing fine, buffer unknowable for
// twenty seconds. Nothing should be concluded from any of it.
{
  const steps: Step[] = [
    ...healthy(5),
    ...Array.from({ length: 20 }, (_, i) => ({
      dt: 1000,
      position: 6 + i,
      ahead: null,
    })),
  ];
  const correct = run(DEFAULT, steps);
  const mutated = run(DEFAULT, steps, 'mutate', null, 'unknown-is-zero');

  check(
    'an unknowable buffer produces `unknown`, never a bad verdict',
    correct.kinds.every((k) => k === 'ok' || k === 'unknown'),
    `got ${[...new Set(correct.kinds)].join(', ')}`
  );
  check(
    '…and an unknowable buffer never reports `starving`',
    !correct.kinds.includes('starving'),
    `got ${[...new Set(correct.kinds)].join(', ')}`
  );
  check(
    'MUTATION "unknown is zero" DOES report `starving` here',
    mutated.kinds.includes('starving'),
    'if this is false the check cannot see the bug it exists to catch'
  );
}

// ---------------------------------------------------------------------------
// 3. TRAP 2 — a paused playhead is not a stalled one
// ---------------------------------------------------------------------------
console.log('\n3. trap 2 — a paused player is not a dead one\n');

{
  // Paused for a minute. Nothing about that is a fault.
  const steps: Step[] = Array.from({ length: 60 }, (_, i) => ({
    dt: 1000,
    position: 120,
    ahead: 30,
    playing: false,
  }));
  const correct = run(DEFAULT, steps);
  const mutatedPaused = run(DEFAULT, steps, 'mutate', null, 'ignore-playing');

  check(
    'a minute of paused playback is never a stall',
    !correct.kinds.includes('stalled'),
    `got ${correct.kinds.filter((k) => k === 'stalled').length} stalls`
  );
  check(
    '…and every paused sample reads `inactive`',
    correct.kinds.every((k) => k === 'inactive')
  );
  check(
    'MUTATION "ignore playing" DOES declare a stall on a paused player',
    mutatedPaused.kinds.includes('stalled'),
    'if this is false a pause could never be distinguished from a failure'
  );

  // The follow-on half, which is the part that is easy to get wrong: the clock
  // must RESTART while paused, not be held. Held, and unpausing surfaces the
  // whole paused duration as one enormous frozen stretch.
  const pausedThenPlayed: Step[] = [
    ...Array.from({ length: 40 }, () => ({
      dt: 1000,
      position: 120,
      ahead: 30,
      playing: false,
    })),
    ...Array.from({ length: 3 }, (_, i) => ({
      dt: 1000,
      position: 121 + i,
      ahead: 30,
      playing: true,
    })),
  ];
  const resumed = run(DEFAULT, pausedThenPlayed);
  check(
    'resuming after a 40s pause does not immediately declare a stall',
    !resumed.kinds.includes('stalled'),
    `got ${resumed.kinds.filter((k) => k === 'stalled').length}`
  );
}

// ---------------------------------------------------------------------------
// 4. TRAP 3 — a backgrounded app is not a dead one
// ---------------------------------------------------------------------------
console.log('\n4. trap 3 — backgrounding is not a dead stream\n');

{
  // Playing, then the app is backgrounded for 40s (no samples — the app is not
  // running), then playing again.
  const before = healthy(10);
  let state = resetHealth(0);
  for (const step of before) {
    state = observeHealth(
      state,
      {
        position: step.position,
        buffered: step.position + 30,
        status: 'readyToPlay',
        playing: true,
        at: step.position * 1000,
      },
      DEFAULT
    ).state;
  }

  const afterAway = noteInterruption(state, 50_000);
  const firstSampleBack = observeHealth(
    afterAway,
    // The playhead has NOT advanced. That is the whole point of this scenario:
    // Android throttles a backgrounded app's media pipeline, so playback stalls
    // without the app being told, and on return the stream is simply where it
    // was. A sample that jumped forward would be evidence the stream is alive
    // and would pass with or without the guard.
    { position: 10, buffered: 40, status: 'readyToPlay', playing: true, at: 50_000 },
    DEFAULT
  );
  check(
    'the first sample after returning from the background is not a stall',
    firstSampleBack.health.kind !== 'stalled',
    `got ${firstSampleBack.health.kind}`
  );
  // ⚠️ THIS ASSERTION CHANGED ON 16 NOV, and the reason is a rule rather than a
  // test detail. It used to feed the same 40s-gap sample through the module
  // WITHOUT `noteInterruption` and require a stall — which stopped being true
  // once `STARVED_SAMPLE_MS` landed: a 40s hole in the samples is itself evidence
  // that nobody was watching, so the module now forgives it on its own. The
  // AppState guard is therefore isolated from the gap guard here, with a healthy
  // tick cadence (1s) and a playhead frozen since long before the app left.
  check(
    '…without the interruption the SAME frozen playhead IS a stall',
    observeHealth(
      { ...state, lastMovedAt: 0, lastAt: 49_000, deadlineAt: STALL_MS },
      { position: 10, buffered: 40, status: 'readyToPlay', playing: true, at: 50_000 },
      DEFAULT
    ).health.kind === 'stalled',
    'the guard has to be the reason the first check passes'
  );

  check(
    '…but it does clear a starvation run from the connection we left',
    noteInterruption({ ...state, starvingSince: 1000 }, 50_000).starvingSince === null
  );
}

// ---------------------------------------------------------------------------
// 5. Stall detection
// ---------------------------------------------------------------------------
console.log('\n5. the stall watchdog\n');

{
  // Playing, then the playhead stops while the pipeline still claims to be.
  const frozen: Step[] = Array.from({ length: Math.ceil(STALL_MS / 1000) + 2 }, (_, i) => ({
    dt: 1000,
    position: 200,
    ahead: 20,
  }));
  const frozenRun = run(DEFAULT, frozen);
  check(
    `a frozen playhead is a stall at ${STALL_MS / 1000}s`,
    frozenRun.kinds.includes('stalled'),
    `kinds were ${[...new Set(frozenRun.kinds)].join(', ')}`
  );
  check(
    '…but not one second earlier',
    !run(
      DEFAULT,
      frozen.slice(0, Math.ceil(STALL_MS / 1000) - 1)
    ).kinds.includes('stalled'),
    'the threshold is doing nothing'
  );

  // A stall must NOT require a thin buffer. A playhead frozen while the buffer
  // is full is a wedged decoder, not a slow network, and there is nothing to
  // wait for.
  const frozenButFull = run(
    DEFAULT,
    frozen.map((s) => ({ ...s, ahead: 600 }))
  );
  check(
    'a frozen playhead with a FULL buffer is still a stall',
    frozenButFull.kinds.includes('stalled'),
    'requiring a thin buffer here would make the monitor blind to a wedged decoder'
  );

  // The distinction that makes the UI honest.
  //
  // Skipped the first sample on purpose: it is where the playhead ARRIVES at
  // 200 from wherever it was, which is movement, and a stream that has just
  // moved is correctly `ok`. Asserting on it would be asserting that arriving
  // somewhere is a stall.
  const briefPause = run(DEFAULT, frozen.slice(0, 3));
  check(
    'a brief freeze reads `rebuffering`, which is not a failure',
    briefPause.kinds.slice(1).every((k) => k === 'rebuffering') &&
      !briefPause.kinds.includes('stalled'),
    `got ${briefPause.kinds.join(' → ')}`
  );
  check(
    '…and it recovers to `ok` the moment the playhead moves again',
    run(DEFAULT, [
      ...frozen.slice(0, 2),
      { dt: 1000, position: 201, ahead: 20 },
    ]).kinds[2] === 'ok'
  );

  // THE MISSING RING (23 Nov report: "the episode pauses … no spinner on
  // screen"). A playhead frozen while the buffer is EMPTY used to fall through
  // the starve rule, which returned before the rebuffer rule ever ran — so the
  // one state a viewer reads as "loading" produced no ring for fifteen seconds.
  const thinFrozen = run(
    DEFAULT,
    Array.from({ length: 3 }, () => ({ dt: 1000, position: 200, ahead: 0.4 }))
  );
  check(
    'a frozen playhead with a nearly empty buffer reads `rebuffering` (the ring), not `starving`',
    thinFrozen.kinds.slice(1).every((k) => k === 'rebuffering'),
    `got ${thinFrozen.kinds.join(' → ')}`
  );
  check(
    '…while the SAME thin buffer with a moving picture is still only `starving`',
    run(DEFAULT, Array.from({ length: 3 }, (_, i) => ({ dt: 1000, position: 200 + i, ahead: 0.4 }))).kinds.includes('starving'),
    'a slow connection that is playing fine must never show a ring'
  );
}

// ---------------------------------------------------------------------------
// 6. The seek grace — our own seeks must not fail the episode
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// 5b. A starved app is not a dead stream (16 Nov, low-end device)
//
// The report: a notification arrived, the system UI took the device, the tick
// fired SECONDS late instead of on time, and the watchdog counted the whole gap
// as a frozen playhead — then failed over, which added a resolve + a replace to
// a device that was already too slow, and did it again every window.
// ---------------------------------------------------------------------------
console.log('\n5b. a starved app is not a dead stream\n');

{
  // Frozen playhead, and every tick 3s late. Over 36s of wall clock the old rule
  // saw one uninterrupted frozen stretch and declared a stall three times over.
  const lateTicks: Step[] = Array.from({ length: 12 }, () => ({
    dt: 3_000,
    position: 10,
    ahead: 30,
  }));
  const starvedRun = run(DEFAULT, lateTicks);
  check(
    'a tick that arrives 3s late does not accumulate into a stall',
    !starvedRun.kinds.includes('stalled'),
    `kinds were ${[...new Set(starvedRun.kinds)].join(', ')}`
  );
  check(
    '…and it grants a fresh window rather than acting on the gap',
    starvedRun.kinds.every((k) => k === 'unknown' || k === 'inactive'),
    `a starved sample must decide NOTHING, got ${[...new Set(starvedRun.kinds)].join(', ')}`
  );

  // THE MUTATION. The same freeze, sampled ON TIME, is still a stall — so the
  // guard above is the reason the first check passes, and a genuinely dead
  // stream on a working phone still fails over on schedule.
  const onTime = run(
    DEFAULT,
    Array.from({ length: 36 }, () => ({ dt: 1_000, position: 10, ahead: 30 }))
  );
  check(
    'the same freeze sampled ON TIME is still a stall (the rule is load-bearing)',
    onTime.kinds.includes('stalled'),
    `kinds were ${[...new Set(onTime.kinds)].join(', ')}`
  );

  // And the decisions survive, exactly as they do across a backgrounding: a
  // starved stretch is not evidence about the connection.
  const starved = observeHealth(
    { ...resetHealth(0), lastAt: 0 },
    { position: 5, buffered: 40, status: 'readyToPlay', playing: true, at: 9_000 },
    DEFAULT
  );
  check(
    '…and it never asks for a failover',
    starved.health.kind === 'unknown'
  );
}

console.log('\n6. the seek grace\n');

{
  // A forward seek whose target has NOT been reached. The pipeline is still
  // fetching segments the viewer has never been near, so the playhead holds
  // where it was — which is exactly the state a real slow seek produces and the
  // one the extra window exists for.
  const still: Step = { dt: 1000, position: 100, ahead: 20 };
  const seekSeconds = Math.ceil(SEEK_STALL_MS / 1000);

  const seeking = observeHealth(
    resetHealth(0),
    { position: 100, buffered: 130, status: 'readyToPlay', playing: true, at: 1000 },
    DEFAULT
  );
  const granted = noteSeek(seeking.state, 1000);

  // `granted` is stamped at t=1000, so its deadline sits at 1000 + SEEK_STALL_MS
  // and `run` — whose clock starts at zero — crosses it on step 21. Both halves
  // are asserted, because a window that never closes is not a window.
  const inside = run(DEFAULT, Array.from({ length: seekSeconds }, () => still), 'correct', granted);
  check(
    `a still-fetching seek is NOT a stall for ${SEEK_STALL_MS / 1000}s`,
    !inside.kinds.includes('stalled'),
    `got ${inside.kinds.filter((k) => k === 'stalled').length} stalls inside the window`
  );

  const past = run(
    DEFAULT,
    Array.from({ length: seekSeconds + 1 }, () => still),
    'correct',
    granted
  );
  check(
    '…and it IS one tick later, so the window closes rather than never existing',
    past.kinds[past.kinds.length - 1] === 'stalled',
    `got ${past.kinds[past.kinds.length - 1]}`
  );

  const withoutWindow = run(
    DEFAULT,
    Array.from({ length: seekSeconds }, () => still),
    'mutate',
    granted,
    'no-seek-grace'
  );
  check(
    'MUTATION "no seek window" DOES stall on our own seek',
    withoutWindow.kinds.includes('stalled'),
    `if this is false the extra window is not what is preventing it — got ${withoutWindow.kinds.join(' → ')}`
  );
  check(
    'the window does not invent movement',
    granted.lastPosition === seeking.state.lastPosition,
    'claiming a playhead moved when it did not is the failure this module avoids'
  );
  check(
    '…but it replaces the stall deadline rather than sitting beside it',
    granted.deadlineAt === 1000 + SEEK_STALL_MS,
    `deadlineAt was ${granted.deadlineAt}`
  );
  check(
    'movement inside the window collapses it back to the ordinary deadline',
    observeHealth(
      observeHealth(
        granted,
        { position: 101, buffered: 131, status: 'readyToPlay', playing: true, at: 2000 },
        DEFAULT
      ).state,
      { position: 101, buffered: 131, status: 'readyToPlay', playing: true, at: 3000 },
      DEFAULT
    ).state.deadlineAt === 2000 + STALL_MS
  );
  check(
    'the window is genuinely LONGER than an ordinary stall window',
    SEEK_STALL_MS > STALL_MS,
    'a nudge smaller than STALL_MS is arithmetically inert — the first version of this was exactly that bug'
  );
}

// ---------------------------------------------------------------------------
// 7. No automatic quality change (removed on purpose)
// ---------------------------------------------------------------------------
console.log('\n7. no auto-downgrade — the monitor reports, it does not act\n');

{
  // A sustained thin buffer is reported as `starving`, and nothing more. The
  // old auto-downgrade walked the ladder on this; it is gone, so the verdict
  // never carries an action and the source list is never replaced by a timer.
  const starving: Step[] = Array.from({ length: 40 }, (_, i) => ({
    dt: 1000,
    position: 100 + i,
    ahead: 1,
  }));
  const run40 = run(DEFAULT, starving);
  check(
    'a sustained thin buffer reports `starving`',
    run40.kinds.includes('starving'),
    `got ${[...new Set(run40.kinds)].join(', ')}`
  );
  check(
    '…and the verdict carries no drop action (no `dropTier` field)',
    !('dropTier' in (observeHealth(resetHealth(0), { position: 1, buffered: 2, status: 'readyToPlay', playing: true, at: 1000 }, DEFAULT)))
  );
}

// ---------------------------------------------------------------------------
// 8. The thresholds derive from the buffer horizon
// ---------------------------------------------------------------------------
console.log('\n8. the thresholds follow the setting the user chose\n');

{
  // Every horizon the app can produce, plus the degenerate ones.
  const horizons = [15, 20, 30, 60, 0, -5, Number.NaN, 1e9];
  check(
    'a degenerate horizon cannot produce a zero threshold',
    horizons.every((hz) => healthProfile(hz).starveFloor >= 3),
    'a floor of 0 makes every frame a violation'
  );
  check(
    'a Low profile is not judged against a High profile\'s floor',
    healthProfile(15).starveFloor < healthProfile(60).starveFloor,
    'a user on Low would see a permanent false alarm otherwise'
  );

  // And the consequence, driven through the real monitor: a Low-profile stream
  // sitting 8s ahead is healthy, and the same 8s on a High profile is not.
  const lowProfile = healthProfile(15);
  check(
    '8s ahead on a Low profile is ok',
    run(lowProfile, [{ dt: 1000, position: 100, ahead: 8 }]).kinds[0] === 'ok'
  );
  check(
    '8s ahead on a High profile is starving',
    run(healthProfile(60), [{ dt: 1000, position: 100, ahead: 8 }]).kinds[0] === 'starving'
  );
}
// ---------------------------------------------------------------------------
// 10. Failure messages
// ---------------------------------------------------------------------------
console.log('\n10. the engine\'s own words reach the screen\n');

{
  const http403 = describeFailure('ExoPlaybackException: HTTP 403 Forbidden for https://cdn.test/v.m3u8');
  check('an expired signed URL is filed as expired, not merely rejected', http403.kind === 'expired', `got ${http403.kind}`);

  const dns = describeFailure('Unable to resolve host "hianime.filmu.in"');
  check('a DNS failure is filed as offline', dns.kind === 'offline', `got ${dns.kind}`);

  const codec = describeFailure('MediaCodecVideoRenderer: decoder initialization failed');
  check('a decoder failure is filed as unsupported', codec.kind === 'unsupported', `got ${codec.kind}`);

  // The rule that matters more than any classification.
  for (const raw of [
    'ExoPlaybackException: HTTP 403 Forbidden',
    'Something nobody has ever seen before',
    '',
  ]) {
    const report = describeFailure(raw);
    check(
      `no failure produces an empty headline (${JSON.stringify(raw.slice(0, 24))})`,
      report.headline.trim().length > 0
    );
    check(
      '…and the raw message survives alongside it',
      raw === '' || report.detail.includes(raw.slice(0, 30)),
      `detail was ${JSON.stringify(report.detail)}`
    );
  }

  check('an absent message is handled, not crashed on', describeFailure(undefined).kind === 'unknown');
  check('a null message is handled, not crashed on', describeFailure(null).kind === 'unknown');

  // A multi-line native stack trace must not push the Retry button off-screen,
  // and the useful part is the header.
  const multiline = describeFailure(
    'ExoPlaybackException: playback error\n\tat ExoPlayerImpl.internalError\n\tat Timeline.handleEvent'
  );
  check(
    'only the first line of a stack trace is shown',
    !multiline.detail.includes('Timeline.handleEvent'),
    `detail was ${JSON.stringify(multiline.detail)}`
  );
  check(
    '…and the header is kept whole',
    multiline.detail.includes('ExoPlaybackException: playback error')
  );
}

// ---------------------------------------------------------------------------
// 11. Source shapes — the rules that live in the screen, not in the module
// ---------------------------------------------------------------------------
console.log('\n11. the wiring (read off the source, not modelled)\n');

const ROOT = process.cwd();
/**
 * Source with the comments STRIPPED.
 *
 * Same reader `check-nav-dedupe.ts` uses, and for the same reason: these files
 * DOCUMENT the shapes they must not contain. `PlayerScreen.tsx` quotes
 * `useRef(resetHealth(Date.now()))` in the comment explaining why it is not used,
 * so an unstripped search for that pattern finds the explanation and reports it
 * as the bug.
 */
const screen = readFileSync(`${ROOT}/components/player/fullscreen/PlayerScreen.tsx`, 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '');

const chrome = readFileSync(`${ROOT}/components/player/fullscreen/Chrome.tsx`, 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '');

// The failure surfaces moved into their own module on 23 Nov. Their rules are
// still rules, so they are read from where they actually live now.
const cards = readFileSync(`${ROOT}/components/player/fullscreen/PlayerCards.tsx`, 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '');

check(
  'the health tick is gated on a rendered frame',
  /if \(!firstFrameRef\.current\) return;/.test(screen),
  'two watchdogs answering one failure spends two rounds of the budget'
);
check(
  'a moving clock lifts the load stage even without the first-frame event',
  /const pictureUp = firstFrame \|\| playbackProgress;/.test(screen) &&
    /const stageUp = \(!pictureUp \|\| switchPending\)/.test(screen),
  'onFirstFrameRender can be missed (Expo Go, a VideoView remount), and the episode then plays behind a stage that never lifts'
);
check(
  'the health tick does nothing while the app is not in the foreground',
  /if \(!appActiveRef\.current\) return;/.test(screen) &&
    /appActiveRef\.current = next === 'active'/.test(screen),
  'a sample taken from a throttled background timer measures the app, not the stream'
);
check(
  'the 120ms subtitle cue tick is gated the same way',
  /setInterval\([\s\S]{0,200}!appActiveRef\.current/.test(screen),
  'eight wake-ups a second to place cues on a picture nobody is looking at'
);
check(
  'the tick runs on its OWN interval, not off `timeUpdate`',
  /setInterval\(tick, HEALTH_TICK_MS\)/.test(screen),
  '`timeUpdate` stops exactly when the player stalls — a monitor driven by the event it detects never runs during the condition it was written for'
);
check(
  'a stall goes through the recovery ladder, not straight to another source',
  /health\.kind === 'stalled'\)[\s\S]{0,700}?recoverStreamRef\.current\(/.test(screen),
  'hopping on the first stall throws away every buffered byte — the one thing a starved stream cannot afford'
);
check(
  'the player is PAUSED when the error card is up',
  /if \(error\) player\.pause\(\)/.test(screen),
  'the card is an overlay over a still-playing surface — the audio used to run to the end with no controls'
);
check(
  'the engine\'s error message is kept rather than discarded',
  /describeFailure\(p\.error\?\.message\)/.test(screen) &&
    !/if \(p\.status === 'error'\) failoverRef\.current\(\);/.test(screen),
  'the old one-liner read the payload and threw it away'
);
check(
  'the error card offers a way OUT, not only a way to retry',
  /onPress=\{onBack\}/.test(cards) &&
    /errorBtnGhost/.test(cards) &&
    /<PlaybackErrorCard[\s\S]{0,400}?onBack=\{onBack\}/.test(screen),
  'on iOS there is no hardware back button and this route has no header'
);
check(
  'a malformed route is refused before it writes anything',
  /const linkOk = isPlayableRoute\(animeId, epNum\)/.test(screen) &&
    /if \(!linkOk\) return;\n\s*void savePosition/.test(screen.replace(/\r/g, '')),
  'a NaN episode writes `miori:pos:NaN:NaN` to disk and nothing ever cleans it up'
);
check(
  'no clock is read inside a `useRef` initialiser',
  !/useRef[^)]*Date\.now\(\)/.test(screen),
  'a `useRef` initialiser re-runs every render, so the clock disagrees with itself depending on when a render happened'
);
// The scrub commit grew a `null` guard and a body, so this can no longer pin the
// old one-liner shape. It now pins the PROPERTY — seekTo's own body must route
// through the grace. See `callbackArgs` for why the extraction is not a naive
// regex, and for the two versions of this check that passed while the rule was
// deleted.
const seekToArgs = callbackArgs(screen, 'const seekTo = useCallback(');
check(
  'every seek path routes through the grace wrapper',
  /seekWithGrace/.test(screen) &&
    /seekWithGrace/.test(seekToArgs) &&
    !/player\.currentTime\s*=/.test(seekToArgs),
  'a monitor that recognises four seek sites fails over on the fifth'
);
// The extraction itself, pinned — twice. Without these a future reformat that
// quietly widened or emptied the extraction would make the check above vacuously
// true, which is exactly how it was already broken once.
check('the seekTo extraction is a real body', seekToArgs.includes('seekBy') && seekToArgs.includes('t == null'));
check(
  'the seekTo extraction excludes the dependency array',
  !/\[\s*player\s*,/.test(seekToArgs),
  'the deps are `[player, seekWithGrace]`; an extraction that includes them passes while seekTo never calls the grace'
);
check(
  'the subtitle fetch has a deadline',
  /fetchText\(t\.url, 10_000/.test(screen),
  'a bare `fetch` on a stalled host never settles and never says so'
);
check(
  'a paused viewer cannot be auto-resumed — the replace path asks the INTENT, not the pipeline',
  /if \(desiredPlayingRef\.current\)\s*\{\s*player\.play\(\)/.test(screen) &&
    /desiredPlayingRef\.current = !desiredPlayingRef\.current/.test(screen),
  'the device report of 9 Nov: pause during initial buffering, the watchdog failed the healthy stream over and `play()` resumed it — the unconditional play must be gone'
);
check(
  'the frame watchdog defers to a paused viewer instead of writing the stream off',
  /if \(!desiredPlayingRef\.current\)\s*\{\s*armFrameWatchdog\(\);/.test(screen),
  'a paused decoder renders no frame, so a pre-frame pause is not evidence of a dead source'
);
check(
  'the buffering overlay is a bare ring — the state words are gone (device verdict 9 Nov)',
  !/bufferWord|bufferAheadSec|BUFFER_NOTES|bufferNote|bufferAhead/.test(screen + chrome) &&
    !/<Text/.test(/if \(buffering\)[\s\S]*\}\n\s*if \(!visible\) return null;/.exec(chrome)?.[0] ?? ''),
  'the three words flickered at 1Hz and none changed what the viewer should do; the remedies live behind the ring'
);
check(
  'the quality chip reports the resolution actually playing',
  /videoTrack\?\.size\.height \?\? null/.test(screen),
  '"Auto" is a claim about a mechanism; the height is a statement about the download'
);

// ---------------------------------------------------------------------------
console.log(
  failures
    ? `\n${failures} failed\n`
    : '\nall passed — a stall is detected, a pause is not a stall, an unknown buffer is\nnot an empty one, a backgrounded app is not a dead one, and a slow connection\ncosts one rung rather than all of them.\n'
);
process.exit(failures ? 1 : 0);