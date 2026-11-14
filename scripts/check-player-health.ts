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
// `components/player/legacy/VerticalPlayerScreen.tsx` — the screen that was
// PARKED when the landscape player replaced it — and it was not carried over.
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
  nextLowerRung,
  noteInterruption,
  noteSeek,
  observeHealth,
  RECOVER_WINDOW,
  resetHealth,
  SEEK_STALL_MS,
  STARVE_WINDOW,
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
    | 'symmetric-recovery'
    | 'no-recovery-window'
    | 'naive-adaptive'
    | 'no-seek-grace';
}

interface Run {
  kinds: string[];
  drops: number;
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
  let drops = 0;

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
        // TRAP 4, mutated: symmetric thresholds. Forget the dropped tier the
        // instant the buffer crosses back over the starve line, which is how a
        // marginal-but-playable connection walks the whole ladder.
        case 'symmetric-recovery': {
          const relaxed: HealthProfile = { ...profile, recoverFloor: profile.starveFloor };
          verdict = observeHealth(state, sample, relaxed);
          break;
        }
        // TRAP 4, mutated: keep the asymmetric threshold but forget immediately
        // on recovery, dropping `RECOVER_WINDOW`. The subtler of the two, and
        // the one that still looks correct in a code review.
        case 'no-recovery-window': {
          if (
            sample.buffered >= 0 &&
            sample.buffered - sample.position >= profile.recoverFloor
          ) {
            verdict = observeHealth({ ...state, dropped: false }, sample, profile);
          }
          break;
        }
        // Both halves of the naive adaptive monitor at once: act on a single
        // below-floor sample and forget on a single comfortable one. Together
        // they turn a flapping connection into a ladder walk — which is the
        // thing trap 4 exists to prevent, shown here with both screws out.
        case 'naive-adaptive': {
          const naiveState: HealthState = {
            ...state,
            dropped: false,
            starvingSince: null,
          };
          if (sample.buffered >= 0) {
            const ahead = sample.buffered - sample.position;
            verdict = observeHealth(
              ahead < profile.starveFloor
                ? { ...naiveState, starvingSince: 0 }
                : naiveState,
              sample,
              profile
            );
            // Force the drop on a single sample rather than a sustained run.
            if (ahead < profile.starveFloor && !verdict.dropTier) {
              verdict = { ...verdict, dropTier: true, state: { ...verdict.state, dropped: true } };
            }
          }
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
    if (verdict.dropTier) drops++;
  }

  return { kinds, drops, last: state };
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
  'a healthy stream never drops a tier',
  run(DEFAULT, healthy(120)).drops === 0,
  `${run(DEFAULT, healthy(120)).drops} drops in two minutes of good playback`
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
    '…and no tier is dropped on unknowable evidence',
    correct.drops === 0,
    `${correct.drops} drops`
  );
  check(
    'MUTATION "unknown is zero" DOES drop a tier here',
    mutated.drops > 0,
    'if this is 0 the check cannot see the bug it exists to catch'
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
  check(
    '…without the interruption the SAME sample IS a stall',
    observeHealth(
      state,
      { position: 10, buffered: 40, status: 'readyToPlay', playing: true, at: 50_000 },
      DEFAULT
    ).health.kind === 'stalled',
    'the guard has to be the reason the first check passes'
  );

  // …but the DECISIONS are kept. Forgetting a dropped tier on backgrounding is
  // how a phone walks the ladder one app-switcher at a time.
  check(
    'an interruption does NOT forget a tier that was already dropped',
    noteInterruption({ ...state, dropped: true }, 50_000).dropped === true
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
}

// ---------------------------------------------------------------------------
// 6. The seek grace — our own seeks must not fail the episode
// ---------------------------------------------------------------------------
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
// 7. TRAP 4 — the downgrade must not thrash
// ---------------------------------------------------------------------------
console.log('\n7. trap 4 — a downgrade that cannot walk the ladder\n');

{
  // A connection that sits just below the floor, for a long time.
  const starving: Step[] = Array.from({ length: 40 }, (_, i) => ({
    dt: 1000,
    position: 100 + i,
    ahead: 1,
  }));
  const run40 = run(DEFAULT, starving);
  check(
    'a sustained thin buffer drops a tier',
    run40.drops === 1,
    `${run40.drops} drops`
  );
  check(
    '…and drops it only ONCE, however long it continues',
    run40.drops === 1,
    'one bad minute must not cost every rung of the ladder'
  );

  // The ladder walk. The first version of this section used a buffer
  // OSCILLATING around the threshold and asserted it drops nothing — and it did
  // drop nothing, under every rule, including the broken ones. The premise was
  // wrong: a drop needs a SUSTAINED thin run, and an oscillation never provides
  // one, so the scenario could not distinguish the rules at all.
  //
  // What actually walks a ladder is a connection that alternates between a long
  // thin stretch (long enough to drop a tier) and a brief comfortable one (long
  // enough to make a naive monitor believe it recovered). Realistic on a train,
  // or a phone moving between cells. That is what this drives.
  const cycle = (thinSeconds: number, deepSeconds: number, rounds: number): Step[] => {
    const out: Step[] = [];
    let pos = 100;
    for (let r = 0; r < rounds; r++) {
      for (let i = 0; i < thinSeconds; i++) {
        out.push({ dt: 1000, position: pos++, ahead: 1 });
      }
      for (let i = 0; i < deepSeconds; i++) {
        out.push({ dt: 1000, position: pos++, ahead: DEFAULT.recoverFloor + 5 });
      }
    }
    return out;
  };

  const flapping = cycle(15, 5, 4);
  const correctFlap = run(DEFAULT, flapping);
  check(
    'four rounds of thin-then-briefly-comfortable drop ONE tier in total',
    correctFlap.drops === 1,
    `${correctFlap.drops} drops — the ladder walk, and it looks like working software`
  );
  check(
    'MUTATION "no recovery window" DOES walk the ladder',
    run(DEFAULT, flapping, 'mutate', null, 'no-recovery-window').drops > 1,
    `${run(DEFAULT, flapping, 'mutate', null, 'no-recovery-window').drops} drops — if this is 1 the check cannot see trap 4`
  );
  check(
    'MUTATION "naive adaptive" (act instantly, forget instantly) is worse still',
    run(DEFAULT, flapping, 'mutate', null, 'naive-adaptive').drops >=
      run(DEFAULT, flapping, 'mutate', null, 'no-recovery-window').drops
  );

  // A buffer sitting just above the starve floor is NOT recovery. It is the
  // same bad connection with one extra segment.
  const boundaryFlap: Step[] = [
    ...Array.from({ length: 20 }, (_, i) => ({ dt: 1000, position: 100 + i, ahead: 1 })),
    ...Array.from({ length: 6 }, (_, i) => ({
      dt: 1000,
      position: 120 + i,
      ahead: DEFAULT.starveFloor + 0.5,
    })),
    ...Array.from({ length: 20 }, (_, i) => ({ dt: 1000, position: 126 + i, ahead: 1 })),
  ];
  check(
    'a buffer just above the starve floor does NOT count as recovery',
    run(DEFAULT, boundaryFlap).drops === 1,
    `${run(DEFAULT, boundaryFlap).drops} drops — the threshold asymmetry is what stops this, and RECOVER_WINDOW alone would not`
  );

  // After a drop, a brief recovery must NOT earn the tier back.
  const dipAndRecover: Step[] = [
    ...starving,
    ...Array.from({ length: 5 }, (_, i) => ({
      dt: 1000,
      position: 140 + i,
      ahead: DEFAULT.recoverFloor + 5,
    })),
    ...Array.from({ length: 20 }, (_, i) => ({
      dt: 1000,
      position: 145 + i,
      ahead: 1,
    })),
  ];
  check(
    'a short recovery does NOT earn a dropped tier back',
    run(DEFAULT, dipAndRecover).drops === 1,
    `${run(DEFAULT, dipAndRecover).drops} drops`
  );

  // …but a long one does, so a genuinely second bad episode can still act.
  const recoverLongEnough = Math.ceil(RECOVER_WINDOW / 1000) + 4;
  const dipRecoverDip: Step[] = [
    ...starving,
    ...Array.from({ length: recoverLongEnough }, (_, i) => ({
      dt: 1000,
      position: 140 + i,
      ahead: DEFAULT.recoverFloor + 5,
    })),
    ...Array.from({ length: 20 }, () => ({ dt: 1000, position: 200, ahead: 1 })),
  ];
  check(
    'a sustained recovery DOES, so a second bad episode can still act',
    run(DEFAULT, dipRecoverDip).drops === 2,
    `${run(DEFAULT, dipRecoverDip).drops} drops — if this is 1 the flag is permanent and the monitor is deaf after one incident`
  );

  // Below the window, a recovery must not count at all.
  const barelyEnough: Step[] = [
    ...starving,
    ...Array.from({ length: Math.ceil(RECOVER_WINDOW / 1000) - 2 }, (_, i) => ({
      dt: 1000,
      position: 140 + i,
      ahead: DEFAULT.recoverFloor + 5,
    })),
    ...Array.from({ length: 20 }, () => ({ dt: 1000, position: 200, ahead: 1 })),
  ];
  check(
    'a recovery one tick short of the window does not count',
    run(DEFAULT, barelyEnough).drops === 1,
    `${run(DEFAULT, barelyEnough).drops} drops`
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
    'recoverFloor is ALWAYS above starveFloor, at any horizon',
    horizons.every((hz) => {
      const p = healthProfile(hz);
      return p.recoverFloor > p.starveFloor;
    }),
    'if these ever cross, a buffer oscillating between them either never drops a tier or drops one every pass'
  );
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
    '8s ahead on a Low profile is `ok`',
    run(lowProfile, [{ dt: 1000, position: 100, ahead: 8 }]).kinds[0] === 'ok'
  );
  check(
    '8s ahead on a High profile is `starving`',
    run(healthProfile(60), [{ dt: 1000, position: 100, ahead: 8 }]).kinds[0] === 'starving'
  );

  // `STARVE_WINDOW` is what stops a momentary dip from costing a rung.
  const momentary = run(
    DEFAULT,
    Array.from({ length: 20 }, (_, i) => ({
      dt: 1000,
      position: 100 + i,
      ahead: i === 3 ? 0 : 40,
    }))
  );
  check(
    'a one-second dip does not drop a tier',
    momentary.drops === 0,
    `${momentary.drops} drops — STARVE_WINDOW (${STARVE_WINDOW / 1000}s) is not being applied`
  );
}

// ---------------------------------------------------------------------------
// 9. Picking the rung below
// ---------------------------------------------------------------------------
console.log('\n9. choosing which rung to drop to\n');

const LADDER = ['1080p', '720p', '480p'];

check('from the top it picks the next one down', nextLowerRung(LADDER, 1080) === '720p');
check('from the middle it picks the next one down', nextLowerRung(LADDER, 720) === '480p');
check('from the bottom there is nowhere to go', nextLowerRung(LADDER, 480) === null);
check('a single-rung ladder has nowhere to go', nextLowerRung(['1080p'], 1080) === null);
check('an empty ladder has nowhere to go', nextLowerRung([], 1080) === null);
check(
  'an unknown active rung steps down from the SECOND, not the top',
  nextLowerRung(LADDER, null) === '720p',
  'selecting the top of the ladder would RAISE quality during the incident meant to lower it — ExoPlayer ABR has already been adapting'
);
check(
  'a height the ladder does not carry is treated as unknown',
  nextLowerRung(LADDER, 360) === '720p'
);
check(
  'a bitrate label carries no height and cannot match a resolution',
  nextLowerRung(['1500k', '800k'], null) === '800k'
);

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

check(
  'the health tick is gated on a rendered frame',
  /if \(!firstFrameRef\.current\) return;/.test(screen),
  'two watchdogs answering one failure spends two rounds of the budget'
);
check(
  'the tick runs on its OWN interval, not off `timeUpdate`',
  /setInterval\(tick, HEALTH_TICK_MS\)/.test(screen),
  '`timeUpdate` stops exactly when the player stalls — a monitor driven by the event it detects never runs during the condition it was written for'
);
check(
  'a stall spends the retry budget through `failover`, not by reaching around it',
  /health\.kind === 'stalled'\)[\s\S]{0,600}?failoverRef\.current\(\)/.test(screen)
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
  /onPress=\{onBack\}/.test(screen) && /errorBtnGhost/.test(screen),
  'on iOS there is no hardware back button and this route has no header'
);
check(
  'a malformed route is refused before it writes anything',
  /const linkOk =[\s\S]{0,200}Number\.isInteger/.test(screen) &&
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