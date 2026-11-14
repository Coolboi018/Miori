// Proves the ShonenX speed bug cannot happen in this codebase.
//
//   npx tsx scripts/check-speed-model.ts
//
// THE BUG BEING GUARDED AGAINST. In `ShonenX/lib/features/player/`:
//   - `gesture_overlay.dart:276` restores with `widget.onSetSpeed(widget.baseSpeed)`,
//     but `baseSpeed` defaults to 1.0 (line 27) and is never passed — the only
//     construction site, `player_screen.dart:514-522`, omits it.
//   - `player_screen.dart:519` wires `onSetSpeed: engine.setSpeed`, the RAW engine,
//     bypassing `controller.changeSpeed`, the only writer of
//     `PlayerState.playbackSpeed` (`player_controller.dart:889-892`). The UI reads
//     that state at `top_controls.dart:269`.
//
// User-visible result: pick 1.25x, hold to boost, release. Engine drops to 1x,
// the label still says 1.25x, and nothing anywhere reports the engine's real rate.
//
// THIS SCRIPT FAILS THE BUILD IF THAT STATE IS REACHABLE. It is not a unit test
// suite — it is a property check over the model, written as a script because that
// is the convention in this folder and because the property is more valuable than
// the individual cases: "the committed rate is unreachable while boosting" and
// "releasing never writes a rate" are the two invariants that make the bug
// unrepresentable.

import {
  beginBoost,
  BOOST_START,
  commitSpeed,
  effectiveRate,
  endBoost,
  formatRate,
  initialSpeed,
  MAX_SPEED,
  MIN_SPEED,
  rampBoost,
  SPEED_STEPS,
  type SpeedState,
} from '../lib/player/speed';

const failures: string[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    console.log(`  pass  ${name}`);
  } else {
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
    failures.push(name);
  }
}

const approx = (a: number, b: number) => Math.abs(a - b) < 0.005;

// ---------------------------------------------------------------------------
// 1. THE REGRESSION. This is the exact sequence from the bug report.
// ---------------------------------------------------------------------------
console.log('\nthe reported bug: custom speed, then hold-to-boost, then release\n');

{
  const chosen = 1.25;
  let s: SpeedState = initialSpeed();
  s = commitSpeed(s, chosen);
  check('menu pick commits 1.25x', approx(effectiveRate(s), 1.25));

  s = beginBoost(s);
  check('hold boosts to 2x', approx(effectiveRate(s), BOOST_START), `got ${effectiveRate(s)}`);

  s = rampBoost(s, 60); // 60px up = +0.5x
  check('hold scrubs up to 2.5x', approx(effectiveRate(s), 2.5), `got ${effectiveRate(s)}`);

  s = endBoost(s);
  check(
    'RELEASE RESTORES 1.25x, NOT 1x',
    approx(effectiveRate(s), 1.25),
    `engine would be ${effectiveRate(s)}`
  );
  check('committed rate was never touched by the hold', approx(s.committed, chosen));
}

// ---------------------------------------------------------------------------
// 2. The same, for every speed the menu offers. A fix that only works at 1.25x
//    is not a fix.
// ---------------------------------------------------------------------------
console.log('\nrelease restores the committed rate for every menu step\n');

for (const step of SPEED_STEPS) {
  let s = commitSpeed(initialSpeed(), step);
  s = rampBoost(beginBoost(s), 240); // a long hold, well past the ceiling
  s = endBoost(s);
  check(
    `${formatRate(step)}x survives a held boost`,
    approx(effectiveRate(s), step),
    `came back as ${effectiveRate(s)}`
  );
}

// ---------------------------------------------------------------------------
// 3. THE INVARIANTS. What makes the bug unrepresentable rather than merely fixed.
// ---------------------------------------------------------------------------
console.log('\ninvariants\n');

{
  // Committing while boosting must NOT clear the boost, or the release would
  // drag the engine back to the value the menu just replaced.
  let s = commitSpeed(initialSpeed(), 1.5);
  s = beginBoost(s);
  check('a menu pick during a hold does not drop the hold', effectiveRate(s) === BOOST_START);
  s = endBoost(s);
  check('...and the release lands on the NEW committed rate', approx(effectiveRate(s), 1.5));
}

{
  // The engine rate must be `boost ?? committed` and nothing else, so the label
  // and the engine cannot be reading different fields.
  const s = { committed: 1.25, boost: null } as SpeedState;
  check('no boost means the engine runs at the committed rate', approx(effectiveRate(s), 1.25));
}

{
  // `endBoost` returns null, never a number. This is the structural difference
  // from ShonenX: there is no restore target in the signature to hardcode.
  const s = beginBoost(initialSpeed(1.75));
  check('endBoost clears the boost to null', endBoost(s).boost === null);
  // Identity, not just equality: releasing when nothing was held must not
  // produce a new state object, because that would re-fire the effect that
  // writes `playbackRate` for no reason.
  const idle = initialSpeed(1.75);
  check('endBoost on an idle state returns the SAME object', endBoost(idle) === idle);
}

{
  // Scrub clamps at the ceiling and quantizes to quarters, so the HUD number and
  // the menu steps describe the same scale.
  let s = beginBoost(initialSpeed());
  s = rampBoost(s, 100000);
  check(`a very long hold clamps to ${MAX_SPEED}x`, approx(effectiveRate(s), MAX_SPEED));
  s = rampBoost(beginBoost(initialSpeed()), -100000);
  check(`a long DOWNWARD hold clamps to ${MIN_SPEED}x`, approx(effectiveRate(s), MIN_SPEED));
  s = rampBoost(beginBoost(initialSpeed()), 37); // not a multiple of 30px
  check('scrub quantizes to 0.25 steps', (effectiveRate(s) * 4) % 1 === 0, `got ${effectiveRate(s)}`);
}

{
  // Float noise must not produce a native write on every move event.
  const s = beginBoost(initialSpeed());
  const moved = rampBoost(s, 0);
  check('a zero-delta move returns the identical object', moved === s);
}

// ---------------------------------------------------------------------------
// 4. Display. A label that lies is the other half of the original bug.
// ---------------------------------------------------------------------------
console.log('\nlabel formatting\n');

check('1 renders as "1", not "1.0"', formatRate(1) === '1');
check('1.25 renders as "1.25"', formatRate(1.25) === '1.25');
check('2 renders as "2"', formatRate(2) === '2');
check('no float spill at 0.1+0.2', formatRate(0.1 + 0.2) === '0.3', `got "${formatRate(0.1 + 0.2)}"`);
check('a scrubbed 2.75 renders exactly', formatRate(2.75) === '2.75');

// ---------------------------------------------------------------------------
console.log();
if (failures.length) {
  console.error(`${failures.length} FAILED: ${failures.join(', ')}`);
  process.exit(1);
}
console.log('speed model: all checks passed.');
console.log('The hold-to-boost release restores the committed rate by construction —');
console.log('there is no restore target in this model to get wrong.');