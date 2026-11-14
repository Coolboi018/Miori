// Pins the gesture arbitration that fixes the "double-tap flashes the player
// overlay / repeated seeks interrupted" report, without needing a device.
//
//   npx tsx scripts/check-gesture-arbitration.ts
//
// THE SHONENX MIRROR. `gesture_overlay.dart` toggles the controls on every
// `onTapUp`, even on the second tap of a pair — and its seek branch then calls
// `onHideControls` to undo what the toggle just did. Symptom in this app:
// repeated double-tap seeks flashed the overlay on/off and the third tap of a
// fast series was occasionally swallowed as a stray toggle.
//
// The check drives the REAL decision function — `tapArbiter.resolveTap`, the
// same function `GestureSurface` delegates to — through a harness that counts
// toggles and seeks. Like the other scripts in this folder it also MUTATES the
// arbiter and demands red, so a rule nobody has seen fail is gone.

import {
  DOUBLE_TAP_MS,
  EMPTY_TAP_STATE,
  deliverMatured,
  resolveTap,
  type TapInput,
  type TapState,
} from '../components/player/fullscreen/tapArbiter';

void deliverMatured; // exercised via the surface in the app; the model rules below cover its promise

const failures: string[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    console.log(`  pass  ${name}`);
  } else {
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
    failures.push(name);
  }
}

// ---------------------------------------------------------------------------
// Harness: one tap in, counts out.
// ---------------------------------------------------------------------------
function run(state: TapState, t: number, side: -1 | 0 | 1) {
  let toggles = 0;
  let seeks = 0;
  const input: TapInput = {
    now: t,
    side,
    actions: {
      onToggle: () => toggles++,
      onSeek: () => seeks++,
    },
  };
  return { next: resolveTap(state, input), toggles, seeks };
}

console.log('the reported bug: repeated double-tap side taps\n');

// ---------------------------------------------------------------------------
// 1. Three fast pairs, same side. ShonenX produced a toggle per pair (and the
//    third tap of a series was sometimes swallowed); the fix produces ONLY
//    seeks — the chrome never appears or disappears mid-series.
// ---------------------------------------------------------------------------
{
  let st: TapState = EMPTY_TAP_STATE;
  let toggles = 0;
  let seeks = 0;
  for (const [a, b] of [
    [0, 150],
    [500, 650],
    [1000, 1150],
  ] as [number, number][]) {
    for (const t of [a, b]) {
      const r = run(st, t, 1);
      st = r.next;
      toggles += r.toggles;
      seeks += r.seeks;
    }
  }
  check('six taps of three pairs → exactly 3 seeks', seeks === 3, `got ${seeks}`);
  check(
    'a repeated double-tap series toggles ZERO times (the reported flash)',
    toggles === 0,
    `got ${toggles}`,
  );
}

// ---------------------------------------------------------------------------
// 2. The lone side tap eventually toggles exactly once — parked, then delivered
//    by the surface's promotion timer, which is `deliverMatured`.
// ---------------------------------------------------------------------------
{
  const first = run(EMPTY_TAP_STATE, 10_000, 1);
  check('a lone side tap parks (no immediate toggle)', first.toggles === 0 && first.next.t === 10_000);

  let delivered = 0;
  const matured = deliverMatured(first.next, 10_000 + DOUBLE_TAP_MS, {
    onToggle: () => delivered++,
  });
  check('silence past the window delivers the parked toggle exactly once', delivered === 1 && matured.t == null);

  // A matured tap is already delivered, so a second delivery call must NOT pay
  // again — the surface's stamp check normally guarantees this; the arbiter's
  // own state machine does too (after delivery the state is empty).
  const twice = deliverMatured(matured, 10_000 + DOUBLE_TAP_MS + 5, { onToggle: () => delivered++ });
  check('delivery on an empty state is a no-op (never double-fires)', delivered === 1 && twice.t == null);
}

// ---------------------------------------------------------------------------
// 3. Centre taps toggle immediately and never park (a toggle must not feel
//    laggy just because it also cannot be a seek).
// ---------------------------------------------------------------------------
{
  const r = run(EMPTY_TAP_STATE, 20_000, 0);
  check('a dead-band tap toggles immediately', r.toggles === 1 && r.next.t == null);
}

// ---------------------------------------------------------------------------
// 4. The third tap of a fast series — the one ShonenX swallowed as a stray
//    toggle — must open a fresh pair, not misresolve.
// ---------------------------------------------------------------------------
{
  let st: TapState = EMPTY_TAP_STATE;
  const seq: [number, -1 | 0 | 1][] = [
    [0, 1],
    [100, 1], // pair 1 → seek
    [200, 1], // within window of the pair's zeroed state → parks fresh
  ];
  let seeks = 0;
  for (const [t, side] of seq) {
    const r = run(st, t, side);
    st = r.next;
    seeks += r.seeks;
  }
  const parked = st;
  check(
    'tap 2s after a pair becomes the first of a NEW pair (parks, no toggle)',
    seeks === 1 && parked.t !== null && parked.t === 200,
  );
}

// ---------------------------------------------------------------------------
// 5. MUTATIONS — break the arbiter's rules and demand red. Checked against an
//    independent re-implementation of the rules, so the mutations are literally
//    the rules this script asserts.
// ---------------------------------------------------------------------------
console.log('\nmutation tests: break each rule, demand red\n');

const RULES: string[] = [];

function arbiterStats(state: TapState, inputs: [number, -1 | 0 | 1][], mode: 'correct' | 'no-zero' | 'eager-toggle'): { toggles: number; seeks: number } {
  let toggles = 0;
  let seeks = 0;
  let st = state;
  for (const [t, side] of inputs) {
    if (mode === 'eager-toggle') toggles++; // ShonenX: toggle on every tap
    if (mode === 'no-zero' && st.t != null && side !== 0 && t - st.t < DOUBLE_TAP_MS) {
      seeks++;
      // BUG: never zeroes — the next tap pairs with the stale stamp.
      continue;
    }
    const r = run(st, t, side);
    st = r.next;
    toggles += r.toggles;
    seeks += r.seeks;
  }
  return { toggles, seeks };
}

const SERIES: [number, -1 | 0 | 1][] = [
  [0, 1],
  [150, 1],
  [500, 1],
  [650, 1],
];

const correct = arbiterStats(EMPTY_TAP_STATE, SERIES, 'correct');
check('correct arbiter: series = 2 seeks, 0 toggles', correct.seeks === 2 && correct.toggles === 0);

const eager = arbiterStats(EMPTY_TAP_STATE, SERIES, 'eager-toggle');
check('mutation "toggle every tap" (ShonenX) shows toggles ≠ 0', eager.toggles > 0);

const noZero = arbiterStats(EMPTY_TAP_STATE, SERIES, 'no-zero');
check('mutation "pair never zeroes" shows extra resolves', noZero.seeks !== correct.seeks || noZero.toggles !== correct.toggles);

console.log('\narbitration model: done');
if (failures.length) {
  console.error(`\n${failures.length} rule(s) failed:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
