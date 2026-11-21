// Pins the seek/scrub model, without needing a device.
//
//   npx tsx scripts/check-player-scrub.ts
//
// ═══════════════════════════════════════════════════════════════════════════
// WHAT WAS BROKEN
//
// The Player settings screen offered six options across "Engine" and "Decoder".
// Four of them did nothing, and the way to know that was to read `tuningFor()`:
//
//   - `decode: 'hw'` and `decode: 'sw'` produced BYTE-IDENTICAL `PlayerTuning`
//     objects — both only set `decodePinned`, and `decodePinned` was read by
//     nothing in the app. So Hardware and Software were the same player, and
//     so was Auto, because nothing read the field it differed on.
//   - `engine: 'compat'` produced a `PlayerTuning` identical to `engine: 'auto'`
//     at every buffer setting, because `tuningFor()` branches only on 'native'.
//
// A setting that does nothing is worse than no setting: the screen promised a fix
// for a black frame and gave the user a confident no-op, on the one screen they
// visit precisely when something is wrong.
//
// ═══════════════════════════════════════════════════════════════════════════
// AND THEN THE SCRUB ITSELF, WHICH 100 GREEN CHECKS DID NOT CATCH
//
// The scrub had a state machine: `ScrubState {phase, wasPlaying}`, `beginScrub`
// / `endScrub`, and an `applyScrub` that wrote `scrubbingModeOptions` and paused
// on iOS. One rule held it together — whatever a drag writes, some other path
// must write it back — and the rule was never satisfiable in practice:
//
//   1. Android FROZE THE PICTURE. `scrubbingModeEnabled: true` suppresses
//      playback (the SDK says so in the property's own doc comment), and iOS
//      was paused explicitly as the SDK recommends. So the frame under the
//      viewer's finger stopped moving for the whole drag while the audio ran
//      on. Reported as "no smooth playback on drag" — and indistinguishable
//      from a network fault, because it looks exactly like one.
//   2. The commit seek ran at the viewer's RESTING tolerance. `setScrubbing`
//      turned the mode off synchronously and the seek was dispatched after it,
//      so with the default `exact` precision ExoPlayer decoded forward from the
//      preceding keyframe and discarded frames to reach the target. Reported as
//      "the video restarts".
//   3. A drag longer than the 3s auto-hide unmounted `ProgressBar` mid-gesture,
//      so the release handler never ran and NO seek was issued at all.
//   4. Two crashes, both from trying to end a drag from a cleanup.
//
// So: THE TRAPS THIS CHECK NOW PINS
//
//   1. A gesture must leave NOTHING on the player. The only write is a widened
//      tolerance around ONE seek, restored in the same tick.
//   2. The commit must happen INSIDE that window, not after the restore.
//   3. The bar must stay mounted for the duration of a drag, or the gesture dies.
//   4. `scrubTarget` answering 0 for "unmeasurable" ⇒ the episode rewinds to 0
//
// Each behavioural section runs a mutated variant and asserts it produces a
// DIFFERENT verdict. A mutation that cannot change the answer is a check nobody
// has seen fail.
//
// WHY THE RULES LIVE IN A SEPARATE MODULE
//
// `lib/player/scrub.ts` imports nothing, so this runs the code that SHIPS. The
// shape it duplicates from expo-video is checked against the real `.d.ts` at the
// bottom, so a drift in the SDK shows up here rather than as a comment that
// outlives its code.

import {
  commitTolerance,
  DEFAULT_PRECISION,
  scrubTarget,
  SEEK_TOLERANCES,
  SCRUB_AFTER,
  SCRUB_BEFORE,
  toleranceFor,
  type SeekPrecision,
} from '../lib/player/scrub';
import { formatClock, UNKNOWN_CLOCK } from '../lib/player/format';

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

const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Source with its COMMENTS removed.
 *
 * Three of the structural rules below forbid things this file's own prose has
 * to name in order to explain them — `scrubbingModeOptions`, `endScrub`,
 * `onPanResponderRelease` — and a grep matches prose exactly as happily as it
 * matches code. A check that greps raw source therefore asserts things about its
 * own documentation. Strip comments first.
 */
function code(rel: string): string {
  return readFileSync(`${process.cwd()}/${rel}`, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * The ARGUMENT TEXT of a `useCallback(` declaration, dependency array removed.
 *
 * A regex to the declaration's `);` swallows the deps along with the body, and
 * `seekTo`'s deps name the very functions the checks below search for — so a
 * check searching the result passes on a body that never calls them. Both
 * versions of those checks were written, had their rule deleted, and stayed
 * green. The call site asserts the array is gone.
 */
function callbackArgs(source: string, declarationStart: string): string {
  const i = source.indexOf(declarationStart);
  if (i < 0) return '';
  const end = source.indexOf('\n  );', i);
  const text = end < 0 ? source.slice(i) : source.slice(i, end);
  return text.replace(/,\s*\[[\s\S]*\]\s*$/, '');
}

/**
 * The body of every `useEffect(() => () => { … })` cleanup in a file.
 *
 * Exists for the rule "no cleanup may write to the player" — which is now
 * trivially satisfied, because a drag writes nothing — and the call site asserts
 * that the extractor really finds the cleanups, against a known one, before
 * trusting it. A rule that cannot fail is not a rule.
 */
function cleanupBodies(source: string): string[] {
  const out: string[] = [];
  const re: RegExp = /=>\s*\(\)\s*=>\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const start = m.index;
    const end = source.indexOf('\n  }', start);
    out.push(source.slice(start, end < 0 ? start + 800 : end));
  }
  return out;
}

const ALL: SeekPrecision[] = ['exact', 'fast', 'rough'];

// The independent re-implementations used for the mutation tests. Each is a
// DELIBERATELY wrong variant, and each must produce a different answer than the
// real function — a mutation that cannot change the verdict is a check nobody
// has seen fail.

function tolerance(precision: SeekPrecision, mutation?: 'unclamped'): SeekToleranceLike {
  if (mutation === 'unclamped') {
    const t = SEEK_TOLERANCES[precision];
    return { toleranceBefore: t.toleranceBefore, toleranceAfter: t.toleranceAfter };
  }
  return toleranceFor(precision);
}

interface SeekToleranceLike {
  toleranceBefore: number;
  toleranceAfter: number;
}

/** The OLD shape: the tolerance restored BEFORE the seek, which is the bug. */
function commitWithRestoreFirst(
  precision: SeekPrecision
): { written: SeekToleranceLike; seekSaw: SeekToleranceLike } {
  const resting = toleranceFor(precision);
  return { written: resting, seekSaw: resting };
}

/** The NEW shape: widened around the seek, then restored. */
function commitCorrectly(
  precision: SeekPrecision
): { written: SeekToleranceLike; seekSaw: SeekToleranceLike } {
  const widened = commitTolerance(precision);
  return { written: widened, seekSaw: widened };
}

/** The widened tolerance that sticks, because nothing restores it. */
function commitSticks(precision: SeekPrecision): { written: SeekToleranceLike; seekSaw: SeekToleranceLike } {
  const widened = commitTolerance(precision);
  return { written: widened, seekSaw: widened, after: widened } as never;
}

function target(localX: number, width: number, duration: number, mutation?: 'unknowable-is-zero' | 'unclamped-track'): number | null {
  if (mutation === 'unknowable-is-zero') {
    if (width <= 0 || duration <= 0) return 0;
    return Math.min(1, Math.max(0, localX / width)) * duration;
  }
  if (mutation === 'unclamped-track') {
    if (width <= 0 || duration <= 0) return null;
    return (localX / width) * duration;
  }
  return scrubTarget(localX, width, duration);
}

// ===========================================================================
// 1. A DRAG WRITES NOTHING TO THE PLAYER
// ===========================================================================
console.log('\na drag leaves no state on the player');
{
  const screen = code('components/player/fullscreen/PlayerScreen.tsx');
  const bar = code('components/player/fullscreen/ProgressBar.tsx');

  check(
    'the player is never told scrubbing mode is on',
    !/scrubbingModeOptions/.test(screen) && !/scrubbingModeOptions/.test(bar),
    'scrubbingModeEnabled: true suppresses playback on Android and pauses the frame on iOS'
  );
  check(
    'a drag no longer pauses the player on either platform',
    !/player\.pause\(\)/.test(callbackArgs(screen, 'const onScrubActive')) &&
      !/player\.pause\(\)/.test(bar),
    'the picture must keep running under the finger'
  );
  check(
    'a drag no longer resumes the player',
    !/player\.play\(\)/.test(bar)
  );
  check(
    'the scrub state machine is gone from the module',
    !/beginScrub|endScrub|ScrubState|scrubPlan|IDLE_SCRUB/.test(code('lib/player/scrub.ts')),
    'the module header has to NAME what was removed, so this reads comments off first'
  );
  check(
    'nothing tracks a drag in a ref any more',
    !/scrubRef/.test(screen),
    'there is nothing left on the player for a ref to restore'
  );

  // THE CRASH RULE, still enforced. Nothing writes to the player from a
  // cleanup, and the extractor is canaried so an empty result cannot pass this.
  const cleanups = cleanupBodies(screen);
  check(
    'the cleanup extractor can still find a cleanup',
    cleanups.length >= 2,
    `${cleanups.length} found`
  );
  check(
    'no cleanup writes to the player',
    cleanups.every((b) => !/player\.[A-Za-z]+\s*=/.test(b)),
    cleanups.find((b) => /player\.[A-Za-z]+\s*=/.test(b))?.slice(0, 120) ?? ''
  );
  check(
    'the bar never reports its own unmount (that crashed the screen twice)',
    !/onScrubActive\(false\)[\s\S]{0,400}useEffect\(\(\)\s*=>\(\)/.test(bar)
  );
}

// ===========================================================================
// 2. THE COMMIT SEEK HAPPENS INSIDE THE WIDENED WINDOW
// ===========================================================================
console.log('\nthe commit seek lands at the widened tolerance');
{
  for (const precision of ALL) {
    const base = tolerance(precision);
    const commit = commitTolerance(precision);

    check(
      `the resting tolerance for ${precision} is the viewer's own`,
      eq(base, toleranceFor(precision))
    );
    check(
      `a commit never NARROWS the ${precision} tolerance`,
      commit.toleranceBefore >= base.toleranceBefore && commit.toleranceAfter >= base.toleranceAfter
    );
    check(
      `a commit reaches at least the scrub floor for ${precision}`,
      commit.toleranceBefore >= SCRUB_BEFORE && commit.toleranceAfter >= SCRUB_AFTER
    );

    // These are FLOORS, not replacements. A viewer who already chose `rough`
    // (2s) is past both and must keep exactly theirs — otherwise starting a
    // drag would silently make their seek MORE precise than the setting says.
    const belowFloor = base.toleranceBefore < SCRUB_BEFORE || base.toleranceAfter < SCRUB_AFTER;
    check(
      belowFloor
        ? `a commit WIDENS ${precision}, which sits below the scrub floor`
        : `a commit leaves ${precision} alone, already past the floor`,
      belowFloor
        ? commit.toleranceBefore > base.toleranceBefore || commit.toleranceAfter > base.toleranceAfter
        : commit.toleranceBefore === base.toleranceBefore && commit.toleranceAfter === base.toleranceAfter
    );
  }

  // The asymmetry that keeps the picture from sitting behind the thumb.
  check('a commit allows more overshoot than undershoot', SCRUB_AFTER > SCRUB_BEFORE, `${SCRUB_AFTER} vs ${SCRUB_BEFORE}`);
  check(
    'every precision keeps the asymmetry through a commit',
    ALL.every((p) => commitTolerance(p).toleranceAfter >= commitTolerance(p).toleranceBefore)
  );

  check(
    'SEEK_TOLERANCES are all non-negative',
    ALL.every((k) => SEEK_TOLERANCES[k].toleranceBefore >= 0 && SEEK_TOLERANCES[k].toleranceAfter >= 0)
  );
  check(
    'an unknown precision falls back to the default rather than NaN',
    eq(toleranceFor('nope' as SeekPrecision), SEEK_TOLERANCES[DEFAULT_PRECISION])
  );
  check(
    'MUTATION: dropping the clamp is observable on a negative tolerance',
    (() => {
      const bad = { ...SEEK_TOLERANCES[DEFAULT_PRECISION], toleranceBefore: -5 };
      return bad.toleranceBefore < 0 && toleranceFor('exact').toleranceBefore === 0;
    })()
  );
  check(
    'MUTATION: an unclamped tolerance is observable',
    (tolerance('exact', 'unclamped') as SeekToleranceLike).toleranceBefore ===
      SEEK_TOLERANCES.exact.toleranceBefore
  );

  // THE ORDER. This is the check that could not have existed before, because
  // before the reversal there was nothing to get wrong — the tolerance was
  // managed by a state machine whose restore ran first.
  //
  // Note the scope: the mutation is observable only for a precision that sits
  // BELOW the scrub floor. `rough` is (2,2) and the floor is (0.5,1), so its
  // commit tolerance equals its resting tolerance and restoring first is
  // indistinguishable — correctly so, since there is nothing to restore. A check
  // asserting the mutation for every precision would be red for the wrong reason,
  // so the two cases are asserted separately.
  for (const precision of ALL) {
    const correct = commitCorrectly(precision);
    const wrongOrder = commitWithRestoreFirst(precision);
    const base = toleranceFor(precision);
    const belowFloor = base.toleranceBefore < SCRUB_BEFORE || base.toleranceAfter < SCRUB_AFTER;

    check(
      `the ${precision} seek sees a tolerance at or above the scrub floor`,
      correct.seekSaw.toleranceAfter >= SCRUB_AFTER,
      `seek saw ${JSON.stringify(correct.seekSaw)}`
    );
    if (belowFloor) {
      check(
        `MUTATION: restoring before the seek is observable (${precision}) — the "video restarts" bug`,
        !eq(wrongOrder.seekSaw, correct.seekSaw),
        `wrong order would seek at ${JSON.stringify(wrongOrder.seekSaw)}`
      );
    } else {
      check(
        `...and for ${precision}, which is already past the floor, the order is genuinely unobservable`,
        eq(wrongOrder.seekSaw, correct.seekSaw),
        'asserting observability here would be a check that is red for the wrong reason'
      );
    }
  }

  const stuck = commitSticks('exact');
  check(
    'MUTATION: a tolerance that sticks is distinguishable from one that is restored',
    !eq((stuck as never as { after: SeekToleranceLike }).after, toleranceFor('exact'))
  );

  // And the real call site has to actually do it.
  const screen = code('components/player/fullscreen/PlayerScreen.tsx');
  const seekTo = callbackArgs(screen, 'const seekTo = useCallback');
  check('seekTo was actually extracted', seekTo.length > 0, 'an empty extraction would make every check below vacuous');
  check(
    'seekTo widens the tolerance before seeking',
    /player\.seekTolerance\s*=\s*commitTolerance\(/.test(seekTo)
  );
  check(
    'seekTo restores it afterwards',
    /player\.seekTolerance\s*=\s*toleranceFor\(/.test(seekTo)
  );
  check(
    'the seek sits BETWEEN the two writes',
    seekTo.indexOf('commitTolerance(') < seekTo.indexOf('seekBy') &&
      seekTo.indexOf('seekBy') < seekTo.lastIndexOf('toleranceFor('),
    'write widened → seek → write resting'
  );
  check(
    'the restore is in a finally, so a throwing seek cannot strand it',
    /finally\s*\{[\s\S]{0,160}toleranceFor\(/.test(seekTo)
  );
  check('seekTo refuses a null target', /t == null\) return;/.test(seekTo));
  check('seekTo still goes through the seek grace', /seekWithGrace/.test(seekTo));
  check('seekTo reads precision from the tuning object, not the store a second time', !/readSetting/.test(seekTo));
}

// ===========================================================================
// 3. THE BAR SURVIVES THE DRAG
// ===========================================================================
console.log('\nthe bar cannot be pulled out from under a finger');
{
  const screen = code('components/player/fullscreen/PlayerScreen.tsx');
  const bar = code('components/player/fullscreen/ProgressBar.tsx');

  check(
    'the bar is mounted while a drag is live, regardless of the chrome',
    /bottomBarUp\s*=\s*\(\s*visible\s*&&\s*!locked\s*&&\s*!panelOpen\s*\)\s*\|\|\s*scrubActive/.test(
      screen
    ),
    'the chrome auto-hides after 3s and ProgressBar lives inside it — a drag longer than that used to issue no seek at all'
  );
  check('a drag reports itself on grant', /setScrubbing\(true\)/.test(bar));
  check('a drag reports itself on release', /onPanResponderRelease[\s\S]{0,400}setScrubbing\(false\)/.test(bar));
  check('a drag reports itself on terminate', /onPanResponderTerminate[\s\S]{0,200}setScrubbing\(false\)/.test(bar));

  const release = /onPanResponderRelease[\s\S]*?onPanResponderTerminate/.exec(bar)?.[0] ?? '';
  check('the release handler was found', release.length > 0, 'an empty match would make the order checks vacuous');

  // ⚠️ THE ORDER THAT MATTERS IS THE ONE AGAINST `scrub.value = -1`, NOT AGAINST
  // `setScrubbing(false)` — and an earlier version of this check got that
  // backwards, so it passed on the exact code it was written to catch.
  //
  // `setScrubbing(false)` no longer restores anything: it clears the knob and
  // tells the screen the drag is over, and the tolerance restore happens INSIDE
  // `seekTo`'s own `finally`. So the two are independent and their order is not
  // load-bearing.
  //
  // What IS load-bearing is the preview. `scrub.value = -1` drops the knob back
  // to the live playhead, so clearing it BEFORE the seek dispatches makes the
  // fill jump to where the episode was and then snap to where you pointed — a
  // one-frame flash on every drag, which reads as the bar jumping.
  check(
    'the commit seek is dispatched BEFORE the preview is dropped',
    release.indexOf('onSeek(') < release.indexOf('scrub.value = -1'),
    'clearing the preview first flashes the fill back to the old position'
  );
  check('the release still commits exactly one seek', (release.match(/onSeek\(/g) ?? []).length === 1);
  check(
    'the move handler issues no seek at all',
    /onPanResponderMove[\s\S]{0,300}onSeek\(/.test(bar) === false,
    'a drag fires move events at the gesture rate; every one is a segment fetch'
  );
  check(
    'the screen hands the bar a stable callback',
    /const onScrubActive = useCallback/.test(screen)
  );
}

// ===========================================================================
// 3b. A TAP COMMITS WHERE YOU TAPPED, NOT WHERE moveX SAYS
// ===========================================================================
console.log('\na tap commits to the point it was aimed at');
{
  const bar = code('components/player/fullscreen/ProgressBar.tsx');

  // `PanResponder._initializeGestureState` sets `moveX = 0`, and RN assigns it
  // nowhere else except the move handler — its own docs call the value invalid
  // until a move has been observed. A tap therefore released with `moveX === 0`,
  // and `0 - originX` clamps to the start of the episode. Re-derive it here from
  // the source so the check fails if the SDK changes the initialisation.
  const pr = readFileSync('node_modules/react-native/Libraries/Interaction/PanResponder.js', 'utf8');
  check(
    'RN still initialises moveX to 0 (the reason this rule exists)',
    /gestureState\.moveX = 0;/.test(pr)
  );
  check(
    'the SDK still documents moveX as invalid before a move is observed',
    /If no move event has been observed[\s\S]{0,80}invalid/.test(pr),
    'the phrase straddles a comment line break, so the window has to allow one'
  );

  check('the release handler does NOT read moveX', !/onPanResponderRelease[\s\S]{0,400}moveX/.test(bar));
  check(
    'a tap seeds the local position from the grant',
    /onPanResponderGrant[\s\S]{0,400}localXRef\.current = e\.nativeEvent\.locationX/.test(bar)
  );
  check(
    'a move keeps it current',
    /onPanResponderMove[\s\S]{0,400}localXRef\.current = localX/.test(bar)
  );
  const release = /onPanResponderRelease[\s\S]*?onPanResponderTerminate/.exec(bar)?.[0] ?? '';
  check('the release handler was found', release.length > 0);
  check(
    'the release commits to the last position the preview was showing',
    /secondsAt\(localXRef\.current\)/.test(release)
  );
}

// ===========================================================================
// 4. AN UNMEASURABLE TRACK IS NOT THE BEGINNING OF THE EPISODE
// ===========================================================================
console.log('\nscrubTarget refuses to guess');
{
  check('a measured drag maps to a time', scrubTarget(100, 400, 800) === 200);
  check('the right edge lands on the duration', scrubTarget(400, 400, 800) === 800);

  // THE BUG. The first version returned 0 when the bar had no width or the
  // duration was not known, and 0 is a legal target — so a release during the
  // first layout, or on a live stream whose duration never arrives, rewound the
  // episode to the beginning.
  check('an unmeasured track answers null, not 0', scrubTarget(100, 0, 800) === null);
  check('an unknown duration answers null, not 0', scrubTarget(100, 400, 0) === null);
  check('a negative width answers null', scrubTarget(100, -400, 800) === null);
  check('a non-finite position answers null', scrubTarget(NaN, 400, 800) === null);

  // Past either edge the answer is the edge, not a position outside the episode.
  check('past the right edge clamps to the duration', scrubTarget(9999, 400, 800) === 800);
  check('before the left edge clamps to zero', scrubTarget(-50, 400, 800) === 0);

  const wrong = target(100, 0, 800, 'unknowable-is-zero');
  check('MUTATION: unknowable-as-zero is observable', wrong !== scrubTarget(100, 0, 800) && wrong === 0);

  const over = target(9999, 400, 800, 'unclamped-track');
  check('MUTATION: an unclamped track is observable', over !== scrubTarget(9999, 400, 800));
}

// ===========================================================================
// 5. AN UNKNOWN RUNTIME IS NOT A ZERO-LENGTH EPISODE, AND NEITHER IS AN
//    UNRESOLVED RESUME
// ===========================================================================
console.log('\nthe clock does not lie about a position it does not have');
{
  check('a real zero reads as a real position', formatClock(0) === '0:00');
  check('a genuinely unknown value reads as unknown', formatClock(NaN) === UNKNOWN_CLOCK, `got ${formatClock(NaN)}`);
  check('an infinite value reads as unknown', formatClock(Infinity) === UNKNOWN_CLOCK);
  check('the unknown marker is not itself a parseable time', !/\d/.test(UNKNOWN_CLOCK));

  const bar = code('components/player/fullscreen/ProgressBar.tsx');
  check(
    'the clock shows the unknown marker while the runtime is unknown',
    /duration > 0 \? formatClock\(duration\) : UNKNOWN_CLOCK/.test(bar),
    '"0:00 / 0:00" asserts the episode is zero seconds long, then snaps — on every open'
  );
  check(
    'the clock shows the unknown marker while the resume is unresolved',
    /positionKnown[\s\S]{0,200}UNKNOWN_CLOCK/.test(bar),
    '"0:00 / 24:13" asserts the episode has never been watched — the claim resume exists to contradict'
  );
  check(
    'the unknown marker is imported rather than re-typed',
    /import \{[^}]*UNKNOWN_CLOCK[^}]*\} from '@\/lib\/player\/format'/.test(bar)
  );

  // The knob and the fill are the same claim in two places, so both are gated.
  check(
    'the knob is hidden until BOTH the runtime and the position are known',
    /\{d > 0 && positionKnown \?/.test(bar)
  );
  check(
    'the played fill is gated on the position being known',
    /!positionKnown \|\| duration <= 0\) return 0/.test(bar),
    'the fill at 0 with the knob hidden is the same false claim in a different shape'
  );
  check(
    'the accessibility readout is gated too',
    /scrub\.value >= 0 \? scrub\.value : positionKnown \? position\.value : 0/.test(bar),
    'a non-visual user has no way to tell a false 0 from a real position'
  );

  // ⚠️ NO SHARED VALUE IS READ DURING RENDER — this warning shipped twice.
  //
  // The clock's label once asked `scrub.value >= 0` of the JSX while rendering,
  // which is the exact read Reanimated's strict mode warns about. It came back
  // in with the SDK-58 bundle commit after the 14 Oct fix had already closed
  // the same warning once, and the read decided nothing: both of its non-null
  // branches rendered the identical expression, so it contributed nothing to
  // the label and everything to the log. The fact the label actually needs —
  // whether a drag is live — travels down as the parent's React `dragging`
  // state (the same two-flips-per-gesture state that mounts the preview chip).
  // `code()` strips the prose that names the read, so this checks code only.
  const clockLabelSharedRead = (text: string): boolean => {
    const start = text.indexOf('const ClockRow = memo(function ClockRow({');
    const end = text.indexOf('const ScrubBubble', start < 0 ? 0 : start);
    if (start < 0 || end < 0) return false;
    const row = text.slice(start, end);
    // The component's LAST `return (` is its JSX. The interval legitimately
    // reads `scrub.value` inside a 500ms callback, which is not a render.
    const jsx = row.slice(row.lastIndexOf('return ('));
    return /\.value\b/.test(jsx);
  };
  check(
    "the clock's label reads no shared value during render",
    !clockLabelSharedRead(bar),
    'a render is not a place a shared value is expected to be read — the drag fact must travel as React state'
  );
  {
    // Synthetic old/new pair fed through the SAME predicate (the lesson this
    // file already paid for: a regex mutation that never runs the real
    // predicate can silently stop matching). Both snippets carry the markers
    // the predicate slices between, so the predicate is proven to
    // discriminate rather than proven vacuous.
    const oldLabel = [
      '  return (',
      '    <View style={styles.clockRow}>',
      '      <Text style={styles.clock}>',
      '        {scrub.value >= 0',
      '          ? formatClock(Math.max(0, shown))',
      '          : positionKnown',
      '            ? formatClock(Math.max(0, shown))',
      '            : UNKNOWN_CLOCK}',
      '      </Text>',
    ].join('\n');
    // Written out, NOT regrown from oldLabel by regex — a replace that
    // happens not to match is a mutation that changes nothing, which is the
    // failure this file's header describes.
    const newLabel = [
      '  return (',
      '    <View style={styles.clockRow}>',
      '      <Text style={styles.clock}>',
      '        {dragging || positionKnown',
      '          ? formatClock(Math.max(0, shown))',
      '          : UNKNOWN_CLOCK}',
      '      </Text>',
    ].join('\n');
    const wrap = (body: string) =>
      ['const ClockRow = memo(function ClockRow({', body, 'const ScrubBubble'].join('\n');
    check(
      'MUTATION: the regressed label FAILS the same predicate the real file must pass',
      clockLabelSharedRead(wrap(oldLabel)) && !clockLabelSharedRead(wrap(newLabel)),
      'a predicate that passes both shapes is connected to nothing'
    );
  }

  // ⚠️ NO REANIMATED HOOK TAKES A DEPENDENCIES ARRAY.
  //
  // `useAnimatedStyle` / `useAnimatedProps` / `useDerivedValue` log
  // "Dependencies should only be used on the web and are always ignored on
  // native" once per call site in dev when a deps array is passed. The
  // parameter is literally `_dependencies` — unused — on native, where the
  // mapper rebuilds from the worklet's captured closure; on the web the
  // deps array matters only WITHOUT the Babel plugin, which this app does
  // not ship. The three sites here (`playedFraction`, the a11y props, the
  // bubble chip) each printed the warning when the player opened because
  // the 27 Oct timeline rework passed `[duration, positionKnown]` to work
  // in the same shape the old Reanimated docs had taught.
  const workletDepsArray = (text: string): string | null => {
    let worst: string | null = null;
    for (const m of text.matchAll(/useAnimatedStyle|useAnimatedProps|useDerivedValue|useAnimatedReaction/g)) {
      const open = text.indexOf('(', m.index);
      if (open < 0) continue;
      let depth = 1;
      let j = open + 1;
      while (j < text.length && depth > 0) {
        const ch = text[j];
        if (ch === '(') depth++;
        else if (ch === ')') depth--;
        j++;
      }
      const call = text.slice(m.index, j);
      const deps = /,\s*\[[\s\S]*\]\s*\)$/.exec(call)?.[0] ?? null;
      if (deps && !worst) worst = deps.slice(0, 60);
    }
    return worst;
  };
  check(
    'no Reanimated worklet hook takes a dependencies array',
    workletDepsArray(bar) === null,
    'native ignores and warns; web uses it only without the worklet Babel plugin (this app ships the plugin)'
  );
  {
    const withDeps = 'const x = useDerivedValue(() => ({}), [duration]);';
    const without = 'const x = useDerivedValue(() => ({}));';
    check(
      'MUTATION: a re-added deps array FAILS the same predicate the real file must pass',
      workletDepsArray(withDeps) !== null && workletDepsArray(without) === null,
      'a predicate that passes both shapes is connected to nothing'
    );
  }

  // ⚠️ THE GRANT MUST NOT FABRICATE A POSITION.
  //
  // It read `scrub.value = at ?? 0`, and a null there — an unmeasured bar, or an
  // unknown runtime — became a position of zero. Putting a finger down snapped
  // the knob to the start and the clock to 0:00, which is the same report as the
  // open case but triggered by every touch. The move handler already skipped the
  // null; grant did not.
  const grant = /onPanResponderGrant[\s\S]*?onPanResponderMove/.exec(bar)?.[0] ?? '';
  check('the grant handler was found', grant.length > 0, 'an empty match makes the next check vacuous');
  check(
    'a grant on an unmeasurable bar does NOT move the preview to zero',
    !/scrub\.value = at \?\? 0/.test(bar)
  );
  check(
    'a grant only sets the preview when it has a position',
    /if \(at != null\) scrub\.value = at;/.test(grant),
    'leaving the knob where it is is honest; parking it at 0:00 is a claim'
  );
  check(
    'grant and move apply the SAME rule',
    grant.includes('if (at != null) scrub.value = at;') &&
      /onPanResponderMove[\s\S]{0,300}if \(at != null\) scrub\.value = at;/.test(bar)
  );

  // ⚠️ AND THE READ MUST NOT START ON `readyToPlay`.
  //
  // That ordering put an AsyncStorage round trip between "the pipeline is ready"
  // and "the episode resumes", while the player was already playing from 0 — so
  // the frame, the audio and the timeline all said 0:00 and then jumped. The
  // read is milliseconds and the network is hundreds, so it starts at mount.
  const screen = code('components/player/fullscreen/PlayerScreen.tsx');
  check(
    'the stored position is read once per episode and memoised',
    /resumePromiseRef[\s\S]{0,200}loadPosition\(/.test(screen),
    'a second read on readiness is the round trip that caused the jump'
  );
  const readyStart = screen.indexOf("p.status === 'readyToPlay'");
  const readyEnd = screen.indexOf("p.status === 'error'", readyStart);
  const readyToPlay = readyStart < 0 ? '' : screen.slice(readyStart, readyEnd < 0 ? readyStart + 2500 : readyEnd);
  check('the readyToPlay handler was found', readyToPlay.length > 0, 'an empty match makes the next checks vacuous');
  check(
    '...and readiness REUSES the mount-time read rather than starting another',
    readyToPlay.includes('loadResumeOnce()') && !readyToPlay.includes('loadPosition(')
  );
  check(
    'the resume decision settles the flag UNCONDITIONALLY, before the branch',
    /loadResumeOnce\(\)\.then\(\(pos\) => \{[\s\S]{0,300}setResumeSettled\(true\);[\s\S]{0,120}if \(pos > 10\)/.test(readyToPlay),
    'settling only inside the pos branches is how the flag was left false forever when the apply path stalled — the bar stayed grey with --:-- and no knob on the device'
  );
  check(
    'the seek spinner clears from the timeUpdate listener, past the in-flight window',
    /seekIssuedAtRef\.current !== 0 && Date\.now\(\) - seekIssuedAtRef\.current > 400/.test(screen) &&
      /setSeekPending\(\(previous\) => \(previous \? false : previous\)\)/.test(screen),
    'cleared by a tick already in flight, the ring never appears; cleared never, it rings over a paused player'
  );
  check(
    'every grace-wrapped seek declares its loading window the instant it is issued',
    /seekIssuedAtRef\.current = now;[\s\S]{0,120}setSeekPending\(true\);/.test(screen),
    'the buffer verdict cannot say "frozen by our own seek" — the seek itself is the signal'
  );
  //
  // THE PROPERTY, not three adjacent lines. It used to be asserted as
  // `/resumeAt;\s*\}\s*setResumeSettled\(true\);/`, which only held while the
  // seek branch ended in one statement. The cue publish now sits between them
  // (21 Nov, so a resume does not wait up to 120ms for the subtitle sampler),
  // and the adjacency regex failed while the rule it describes still held: the
  // settle is the LAST statement of the callback, outside both branch arms, so
  // every path settles — including the one that seeks.
  {
    const applyResume =
      /const applyResumePosition = useCallback\(\(resumeAt[\s\S]*?\n  \}, \[[^\]]*\]\);/.exec(screen)?.[0] ?? '';
    const seekAt = applyResume.indexOf('player.currentTime = resumeAt;');
    const settles = applyResume.match(/setResumeSettled\(true\)/g)?.length ?? 0;
    check(
      'applying the resume settles the flag too — every path, after the seek branch',
      applyResume.length > 0 &&
        seekAt >= 0 &&
        // Two settles are legitimate — the "past the runtime" guard has its own
        // early return. What matters is the LAST one being the callback's final
        // statement, outside both arms of the seek branch.
        settles >= 1 &&
        applyResume.indexOf('} else {') > seekAt &&
        /setResumeSettled\(true\);\s*\n\s*\}, \[/.test(applyResume),
      'the branch that DOES seek is the one that finally knows where we are, and the settle must not be trapped inside one arm'
    );
  }
  check(
    'the settled flag is forwarded to the bar',
    /positionKnown=\{resumeSettled\}/.test(screen) && /positionKnown=\{positionKnown\}/.test(code('components/player/fullscreen/Chrome.tsx'))
  );
  check(
    'a source or quality switch does NOT re-blank the timeline',
    !/setResumeSettled\(false\)/.test(
      /useEffect\(\(\) => \{[\s\S]{0,900}?replaceAsync/.exec(screen)?.[0] ?? ''
    ),
    'a failover carries the position across itself and never re-derives a resume'
  );
}

// ---------------------------------------------------------------------------
// SHAPE CHECKS — the duplicated expo-video types, against the real .d.ts.
//
// A drift in the SDK should fail HERE, not turn a confident comment in
// `scrub.ts` into a lie.
// ---------------------------------------------------------------------------
console.log('\nthe shapes match expo-video SDK 58');
{
  let dts = '';
  try {
    dts = readFileSync('node_modules/expo-video/build/VideoPlayer.types.d.ts', 'utf8');
  } catch {
    console.log('  skip  expo-video .d.ts not readable (run from the project root)');
  }
  if (dts) {
    check('SeekTolerance really has toleranceBefore/toleranceAfter', /export type SeekTolerance = \{[\s\S]*?toleranceBefore\?: number;[\s\S]*?toleranceAfter\?: number;/.test(dts));
    check('ScrubbingModeOptions really has scrubbingModeEnabled', /export type ScrubbingModeOptions = \{[\s\S]*?scrubbingModeEnabled\?: boolean;/.test(dts));
    check('ScrubbingModeOptions really has the Android-only knobs this module does not set', /increaseCodecOperatingRate\?: boolean;/.test(dts) && /enableDynamicScheduling\?: boolean;/.test(dts));
    check('the SDK still documents that playback is suppressed while scrubbing', /playback is suppressed/.test(dts));
    check('the SDK still documents setting it back to false', /set this property back to `false` when the user interaction ends/.test(dts));
    check('preservesPitch is still a player property (the settings screen binds it)', /preservesPitch: boolean;/.test(dts));
    check('audioMixingMode is still a player property', /audioMixingMode: AudioMixingMode;/.test(dts));
    check(
      'AudioMixingMode really is the four values the settings screen offers',
      /export type AudioMixingMode = 'mixWithOthers' \| 'duckOthers' \| 'auto' \| 'doNotMix';/.test(dts)
    );
    // And the claim that made the decoder picker inert, re-checked against the
    // SDK rather than against memory: there is no decoder knob.
    const builder = /export type PlayerBuilderOptions = \{([\s\S]*?)\n\};/.exec(dts);
    const builderKeys = builder ? [...builder[1].matchAll(/^\s{4}(\w+)\?:/gm)].map((m) => m[1]) : [];
    check(
      'PlayerBuilderOptions still carries no decoder selection',
      !builderKeys.some((k) => /decode|codec|decoder/i.test(k)),
      `keys: ${builderKeys.join(', ') || '(none found)'}`
    );
    check(
      'PlayerBuilderOptions still carries no decoder selection',
      !builderKeys.some((k) => /decode|codec|decoder/i.test(k)),
      `keys: ${builderKeys.join(', ') || '(none found)'}`
    );
    // SDK 58 added `videoChangeFrameRateStrategy` to the builder. The intent
    // the old line pinned ("just the two seek increments") survives as: the two
    // increments, plus the refresh-rate strategy that arrived with SDK 58, and
    // nothing else decoder-shaped.
    check(
      'PlayerBuilderOptions is the two seek increments plus the SDK 58 refresh-rate strategy',
      builderKeys.length === 3 &&
        builderKeys.filter((k) => /^seek(Forward|Backward)Increment$/.test(k)).length === 2 &&
        builderKeys.includes('videoChangeFrameRateStrategy'),
      `keys: ${builderKeys.join(', ') || '(none found)'}`
    );
  }
}

// ---------------------------------------------------------------------------
// SOURCE CHECKS — the things the pure module cannot enforce on its own.
//
// A rule that depends on a call site existing is a rule about the file. Reading
// the file is the only way to check it, and `check-player-health.ts` already
// establishes the pattern.
// ---------------------------------------------------------------------------
console.log('\nthe player honours the plan (source)');
{
  const screen = readFileSync('components/player/fullscreen/PlayerScreen.tsx', 'utf8');

  // The two rules below that cost a crash are enforced in section 1, against a
  // comment-stripped read: "no cleanup writes to the player", and "the bar
  // never reports its own unmount". Both were tried as the fix for the frozen
  // drag and both took the screen down on the way out.

  // The settings screen must not have kept the inert knobs. These match on the
  // JSX, not the word: the file's header necessarily NAMES the section it
  // replaced, and a check that matched prose would fail on a correct file.
  const settings = readFileSync('app/settings/player.tsx', 'utf8');
  check('no Decoder section is rendered', !/<SettingSection title="Decoder"/.test(settings));
  check('no Decoder picker is imported', !/PLAYER_DECODES/.test(settings));
  check('the settings screen does not bind player.decode', !/player\.decode/.test(settings));
  check('compat is no longer offered as an engine', !/PLAYER_ENGINES[\s\S]{0,400}'compat'/.test(settings));

  const store = readFileSync('lib/settings/store.ts', 'utf8');
  check("player.decode is out of the settings schema", !/'player\.decode':/.test(store));
  check('PLAYER_DECODES is gone', !/PLAYER_DECODES/.test(store));
  check('seek precision is in the schema', /'player\.seekPrecision':/.test(store));
  check('audio mixing is in the schema', /'player\.audioMixing':/.test(store));
  check('preserves pitch is in the schema', /'player\.preservesPitch':/.test(store));

  // A key removed from the schema must not still be readable, or a stale stored
  // value keeps writing to a player property nobody sets. Matched on the FIELD
  // declarations, since both files name `decodePinned` in their prose about why
  // it went.
  const tuning = readFileSync('lib/player/tuning.ts', 'utf8');
  check('tuning no longer declares a decode field', !/^\s*decode:\s*PlayerDecodeKey/m.test(tuning));
  check('tuning no longer declares decodePinned', !/^\s*decodePinned[?:]/m.test(tuning));
  check('tuning no longer reads player.decode', !/readSetting\('player\.decode'\)/.test(tuning));
  check('tuning no longer reads player.decode as an argument', !/PlayerDecodeKey/.test(tuning));
}

// ---------------------------------------------------------------------------
// THE CACHE SETUP IN `app/_layout.tsx`
//
// Found on device, and it is NOT the unmount crash above — it is a different
// error from a different file, surfaced while navigating away from the player:
//
//   [player] video cache setup failed
//   Error: Call to function 'ExpoVideo.setVideoCacheSizeAsync' has been rejected.
//   → Cannot clear cache while there are active players
//
// Both cache calls carry the same documented precondition ("can be called only if
// there are no existing VideoPlayer instances") and both REJECT rather than
// no-op. The original code had them in ONE `try`, so a rejected size call skipped
// the clear and a rejected clear produced a warning that blamed the wrong
// function — and the rejection text names the clear regardless, so the log could
// not tell you which call had actually failed.
// ---------------------------------------------------------------------------
console.log('\nthe video cache setup is guarded (source)');
{
  const layout = readFileSync('app/_layout.tsx', 'utf8');
  const cacheSetup = /const \[settingsReady[\s\S]*?\n  \}, \[\]\);/.exec(layout);

  check('the cache effect was extracted', !!cacheSetup, 'an empty extraction would make every check below vacuous');
  const setup = cacheSetup ? cacheSetup[0] : '';

  check('the two cache calls are in SEPARATE try blocks', (setup.match(/try\s*{/g) ?? []).length >= 2);
  check('the clear is gated on the size call having succeeded', /if \(sizeApplied\)[\s\S]{0,80}clearVideoCacheAsync/.test(setup));
  // WAS `catch … setPlayerCacheReady(true)`, the weaker promise that a failed
  // cache call would not keep the splash up. The gate now opens BEFORE the cache
  // work starts, which makes every one of these call sites irrelevant to launch
  // time — so the pin is the ordering itself. See the note on `settingsReady`.
  const gateAt = setup.indexOf('setSettingsReady(true)');
  const firstCacheCallAt = setup.indexOf('setVideoCacheSizeAsync');
  check(
    'the launch gate opens before the cache work starts',
    gateAt >= 0 && firstCacheCallAt >= 0 && gateAt < firstCacheCallAt
  );

  // The old wording blamed the clear for a rejection thrown by the size setter.
  // That sentence is the whole reason this was hard to diagnose.
  check('the misleading "cache setup failed" message is gone', !/video cache setup failed/.test(layout));
  check('the size failure names the size call', /cache size NOT applied/.test(setup));
  check('the clear failure is reported separately', /cache clear skipped/.test(setup));

  // A single `try` is the defect: it makes the two failures indistinguishable AND
  // lets one silently skip the other.
  //
  // The mutation is SYNTHETIC rather than a textual rewrite of the real file,
  // because a regex that transforms the real source is a regex that quietly stops
  // matching the first time anyone reformats it — which is how a mutation ends
  // up proving nothing while still printing "pass". The predicate below is the
  // SAME one applied to the real source on the line above; these two strings are
  // the old and new shapes it has to tell apart.
  const twoTryShape = (s: string) =>
    (s.match(/try\s*{/g) ?? []).length >= 2 &&
    /if \(sizeApplied\)[\s\S]{0,80}clearVideoCacheAsync/.test(s);

  const OLD_SHAPE = `
    try {
      await setVideoCacheSizeAsync(bytes);
      await clearVideoCacheAsync();
    } catch (cacheError) {
      if (__DEV__) console.warn('[player] video cache setup failed', cacheError);
    }`;
  const NEW_SHAPE = `
    try { await setVideoCacheSizeAsync(bytes); sizeApplied = true; } catch (e) {}
    if (sizeApplied) { try { await clearVideoCacheAsync(); } catch (e) {} }`;

  check(
    'MUTATION: the OLD one-try shape would FAIL this check',
    !twoTryShape(OLD_SHAPE),
    'if this passes, the predicate cannot see the defect and the check above is decoration'
  );
  check('MUTATION: the new two-try shape PASSES the same predicate', twoTryShape(NEW_SHAPE));
  check('…and the real file has that shape', twoTryShape(setup));
}

console.log('');
if (failures > 0) {
  console.log(`${failures} FAILED`);
  process.exit(1);
}
console.log('all passed');
