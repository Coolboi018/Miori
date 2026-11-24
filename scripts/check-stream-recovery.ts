// Pins the STREAM RECOVERY LADDER and the failover budget that bounds it.
//
//   npx tsx scripts/check-stream-recovery.ts
//
// ═══════════════════════════════════════════════════════════════════════════
// THE DEVICE REPORT (23 Nov, slow connection)
//
// "The episode pauses, the sources counter moved from 4/7 to 5/7 with no spinner
// on screen, then the app got stuck and closed itself." Three rules failed:
//
//   1. A frozen playhead went straight to `failover()`. A hop discards every
//      buffered byte, so the next server started from zero on the same thin
//      pipe and stalled again. Nothing ever asked for LESS BITRATE.
//   2. `load()` reset the failover budget, and a wrap-load IS a `load()`, so the
//      walk could never reach its round limit: resolve → walk → wrap → resolve,
//      forever, on the JS thread.
//   3. A frozen playhead with an empty buffer reported `starving` (a word the UI
//      ignores) instead of `rebuffering` (the ring) — see
//      `scripts/check-player-health.ts`, which owns that file.
//
// Every module here is the SHIPPING one — `lib/player/recovery.ts` and
// `lib/player/failover.ts` import nothing, so this script drives the real
// decisions rather than a model of them. The last section reads the wiring off
// `PlayerScreen.tsx`, the same way the other checks do, because a component
// cannot be imported into a Node script.

import {
  budgetOnLoad,
  freshBudget,
  MAX_FAILOVER_ROUNDS,
  MAX_FAILOVER_WALL_MS,
  noteFailure,
  spendRound,
  wrapVerdict,
  type FailBudget,
} from '../lib/player/failover';
import {
  contentTypeFor,
  isPlayableRoute,
  labelDisagrees,
  paramNumber,
} from '../lib/player/source';
import { capFor, masterHasSeparateAudio, selectableRungs } from '../lib/player/rung';
import {
  decideRecovery,
  DOWNLOADING_PATIENCE_MS,
  initialRecovery,
  noteRecovered,
  noteStable,
  RECOVERY_COOLDOWN_MS,
  type RecoveryState,
  type StallEvidence,
} from '../lib/player/recovery';

declare const require: (id: string) => {
  readFileSync(path: string, encoding: 'utf8'): string;
};
const { readFileSync } = require('node:fs');
declare const process: { cwd(): string; exit(code: number): never };

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

/** A stall on a stream that is downloading nothing. */
function stuck(): StallEvidence {
  return { ahead: 0, frozenMs: 20_000, growing: false };
}

/** Advance the clock past the cooldown so the next decision is allowed to act. */
function later(state: RecoveryState, by = RECOVERY_COOLDOWN_MS): number {
  return state.lastActionAt + by;
}

// ---------------------------------------------------------------------------
// 1. THE BUDGET — a wrap-load must inherit it, or the walk never ends
// ---------------------------------------------------------------------------
section('1. the failover budget survives the wrap-load (the endless loop)');

{
  /**
   * The bug, and the fix, as one simulation: a wrap happens, a load is started,
   * and we ask whether `wrapVerdict` can ever say 'giveup'.
   *
   * `load` is the ONLY difference between the two runs — exactly as it is in the
   * screen, where the shape was `roundsRef.current = 0; failClockRef.current = 0`
   * on every call.
   */
  function walksUntilGiveUp(load: (b: FailBudget, now: number) => FailBudget, wraps: number): number {
    let b = freshBudget();
    for (let i = 0; i < wraps; i++) {
      const now = 1_000 + i * 1_000;
      b = noteFailure(b, now);
      if (wrapVerdict(b.rounds, b.sinceMs, now) === 'giveup') return i;
      b = spendRound(b);
      b = load(b, now);
    }
    return -1;
  }

  const oldShape = (): FailBudget => freshBudget();
  const fixedShape = (b: FailBudget): FailBudget => budgetOnLoad(b, true);

  check(
    'the OLD shape (every load resets the budget) NEVER gives up — the loop that closed the app',
    walksUntilGiveUp(oldShape, 1_000),
    -1
  );
  check(
    'the fixed shape gives up after MAX_FAILOVER_ROUNDS walks',
    walksUntilGiveUp(fixedShape, 1_000),
    MAX_FAILOVER_ROUNDS
  );
}

{
  check('a wrap-load inherits the budget', budgetOnLoad({ rounds: 2, sinceMs: 7 }, true), {
    rounds: 2,
    sinceMs: 7,
  });
  check('a viewer load starts a fresh stretch', budgetOnLoad({ rounds: 2, sinceMs: 7 }, false), {
    rounds: 0,
    sinceMs: 0,
  });
  check('the wall clock restarts only on the first failure of a stretch', noteFailure({ rounds: 1, sinceMs: 500 }, 900), {
    rounds: 1,
    sinceMs: 500,
  });
  check('…and starts when there is none running', noteFailure(freshBudget(), 900), {
    rounds: 0,
    sinceMs: 900,
  });
  check('a round is spent at a WRAP and nowhere else', spendRound({ rounds: 1, sinceMs: 5 }), {
    rounds: 2,
    sinceMs: 5,
  });
  check(
    'the wall clock still ends a slow walk',
    wrapVerdict(1, 1_000, 1_000 + MAX_FAILOVER_WALL_MS + 1),
    'giveup'
  );
}

// ---------------------------------------------------------------------------
// 2. THE LADDER — wait while bytes are still arriving
// ---------------------------------------------------------------------------
section('2. slow is not dead: wait while the buffer is still filling');

{
  const ev: StallEvidence = { ahead: 0.5, frozenMs: 16_000, growing: true };
  const slow = decideRecovery(initialRecovery(), ev, 20_000);

  check('a frozen picture whose buffer is still growing WAITS', slow.action.kind, 'wait');
  check('…with the reason recorded', slow.action.kind === 'wait' ? slow.action.because : null, 'downloading');
  check('…and spends no remedy on it', slow.state.actions, 0);

  // MUTATION: the same stall with no growth is acted on immediately. If this
  // were identical to the case above, `growing` would be doing nothing.
  const dead = decideRecovery(initialRecovery(), { ...ev, growing: false }, 20_000);
  check('MUTATION — the SAME stalled picture with no growth is acted on', dead.action.kind, 'reload');

  const impatient = decideRecovery(
    initialRecovery(),
    { ...ev, frozenMs: DOWNLOADING_PATIENCE_MS + 1_000 },
    20_000
  );
  check('…but a buffer that never finishes filling is answered', impatient.action.kind, 'reload');
}

// ---------------------------------------------------------------------------
// 3. One remedy at a time
// ---------------------------------------------------------------------------
section('3. the cooldown: one remedy per result, not one per tick');

{
  const first = decideRecovery(initialRecovery(), stuck(), 100_000);
  check('the first stall re-opens in place', first.action.kind, 'reload');
  check('…and carries no quality in it', 'to' in first.action || 'height' in first.action, false);

  const again = decideRecovery(first.state, stuck(), 100_000 + RECOVERY_COOLDOWN_MS - 1);
  check('a second remedy inside the cooldown waits', again.action.kind, 'wait');
  check('…and does not spend', again.state.actions, first.state.actions);

  const allowed = decideRecovery(first.state, stuck(), 100_000 + RECOVERY_COOLDOWN_MS);
  check('after the cooldown the next rung of the ladder is a server', allowed.action.kind, 'failover');
}

// ---------------------------------------------------------------------------
// 4. The whole ladder, in order
// ---------------------------------------------------------------------------
section('4. one in-place repair, then another server — never a different quality');

{
  let state = initialRecovery();
  const actions: string[] = [];
  for (let i = 0; i < 3; i++) {
    const decision = decideRecovery(state, stuck(), later(state));
    state = decision.state;
    actions.push(decision.action.kind);
  }
  check('a dead stream is reloaded once, then handed to another server', actions, [
    'reload',
    'failover',
    'failover',
  ]);
  check('…starting with the cheap in-place repair', actions[0], 'reload');
}

{
  /**
   * THE 24 NOV REPORT, AS A CLOSED INVARIANT.
   *
   * The ladder used to answer a starved buffer by stepping DOWN the variant
   * ladder (`lower-quality`) and by capping the ABR track (`cap`) — the "I had
   * 720p and it came back as 360p" report. Neither may exist again: every remedy
   * must keep the request identical (same URL, same rung, same audio) and only
   * the SERVER may change. Driven over every evidence shape the screen can hand
   * it, including the ones that used to win a reduction.
   */
  const kinds = new Set<string>();
  let state = initialRecovery();
  const shapes: StallEvidence[] = [
    { ahead: null, frozenMs: 0, growing: true },
    { ahead: 0, frozenMs: 20_000, growing: false },
    { ahead: 30, frozenMs: 60_000, growing: true },
    { ahead: 12, frozenMs: DOWNLOADING_PATIENCE_MS + 1_000, growing: true },
  ];
  for (const ev of shapes) {
    for (let i = 0; i < 8; i++) {
      const d = decideRecovery(state, ev, later(state, RECOVERY_COOLDOWN_MS));
      kinds.add(d.action.kind);
      state = d.state;
    }
  }
  check('every action the ladder can still take is quality-neutral', [...kinds].sort(), [
    'failover',
    'reload',
    'wait',
  ]);
}

// ---------------------------------------------------------------------------
// 5. What a recovered frame does to the ladder
// ---------------------------------------------------------------------------
section('5. a frame ends the stretch but keeps the reload it spent');

{
  const spent: RecoveryState = { actions: 4, reloads: 1, lastActionAt: 5_000 };
  const revived = noteRecovered(spent);
  check('a rendered frame restarts the remedy budget', [revived.actions, revived.lastActionAt], [0, 0]);
  check(
    '…and KEEPS the reload it already spent — one soft re-open per failing stretch (24 Nov)',
    revived.reloads,
    spent.reloads
  );
  // THE 24 NOV FREEZE. `noteRecovered` used to zero `reloads` too, so a source
  // that rendered a frame and died could reload every eight seconds forever.
  // Each of those re-opens `prepare()`s the native source on the Android MAIN
  // thread, behind the disk cache's lock — which a stuck segment holds.
  const oldShapeReloads = { ...spent, reloads: 0 };
  check(
    'the OLD shape (a frame clears the reload) can reload without end — WRONG, watched failing',
    decideRecovery(oldShapeReloads, stuck(), 20_000).action.kind,
    'reload'
  );
  check(
    'the real rule: after one reload the ladder moves on to another server',
    decideRecovery(revived, stuck(), 20_000).action.kind,
    'failover'
  );

  const stable = noteStable(spent);
  check(
    'a PROVEN stream ends the stretch, reload budget included',
    [stable.actions, stable.reloads, stable.lastActionAt],
    [0, 0, 0]
  );
  check('a new episode starts over', initialRecovery(), {
    actions: 0,
    reloads: 0,
    lastActionAt: 0,
  });
}

// ---------------------------------------------------------------------------
// 6. The wiring, read off the screen
// ---------------------------------------------------------------------------
section('6. the wiring (read off the source, not modelled)');

const ROOT = process.cwd();
/** Comments stripped, exactly as in the other source-reading checks. */
const screen = readFileSync(`${ROOT}/components/player/fullscreen/PlayerScreen.tsx`, 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '');

/** A boolean assertion, with the reason a failure matters. */
function verify(name: string, ok: boolean, detail: string): void {
  if (ok) {
    pass += 1;
  } else {
    fail += 1;
    console.error(`  ✗ ${name} — ${detail}`);
  }
}

verify(
  'the wrap-load keeps the budget',
  /load\(\{ fresh: true, keepBudget: true \}\)/.test(screen),
  'without it the walk resets its own round count and re-resolves forever'
);
verify(
  'a stall goes into the recovery ladder',
  /recoverStreamRef\.current\(/.test(screen),
  'hopping on the first stall is what made a slow connection unable to recover'
);
verify(
  'the ring covers a recovery window',
  /resolving \|\| seekPending \|\| recovering \|\|/.test(screen),
  'a hop leaves the screen with no source: that window must not be a silent frozen frame'
);
/** The ladder module's own source, for the invariant below. */
const recoverySrc = readFileSync(`${ROOT}/lib/player/recovery.ts`, 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '');
verify(
  'the ladder has NO quality action left (24 Nov: 720p came back as 360p)',
  !/kind: '(?:lower-quality|cap)'/.test(recoverySrc) &&
    !/qualityDrops/.test(recoverySrc) &&
    !/lower-quality/.test(screen),
  'a hiccup is not consent to lower the rung the viewer picked; the picker is the only lever'
);
verify(
  'a re-open refuses the cache while a stall is recent',
  /!stallRecent/.test(screen),
  'the cache lock is held by the stalled download, and preparing behind it blocks the UI thread'
);
verify(
  'only the ACTIVE source is gathered eagerly',
  /gatherVariants\(false, \[srcIndexRef\.current\]\)/.test(screen),
  'reading every master playlist in parallel competes with the segment the player is waiting for'
);
// THE 24 NOV PREVIEW — the endless "Loading qualities…" sheet.
verify(
  'the quality gather asks each source ONCE per list',
  /gatherTriedRef\.current\.has\(i\)/.test(screen) &&
    /gatherTriedRef\.current\.add\(i\)/.test(screen),
  'a failed master is stored nowhere (undefined), so a state-driven retry re-read EVERY source on every commit'
);
verify(
  'the quality sheet retries at most once per open',
  /sheetRetriedRef\.current = true/.test(screen),
  'one fair re-read on the viewer opening the sheet; a second is the hammer that flashed the rows'
);
verify(
  'a rendered frame clears the recovery ring',
  /recoveryRef\.current = noteRecovered/.test(screen),
  'a ring that outlives the picture is the same lie as one that never appears'
);
// THE 24 NOV FREEZE — the two rules that keep a failing stretch bounded.
verify(
  'a frame alone never forgives the walk (the endless resolve→hop loop)',
  /provesStable\(/.test(screen) && /noteStable\(recoveryRef\.current\)/.test(screen),
  'resetting the budget on every frame let the walk re-resolve forever'
);
verify(
  'a RECOVERY re-open bypasses the disk cache (the main-thread lock that froze the UI)',
  /!recoveryOpenRef\.current/.test(screen) && /recoveryOpenRef\.current = false/.test(screen),
  'preparing a cached source takes CacheVariantIndex\'s @Synchronized lock on the Android main thread'
);
verify(
  'the silence verdict is bounded per item, per URL and per episode',
  /positionRef\.current > SILENCE_MAX_POSITION_S/.test(screen) &&
    /silentUrlsRef\.current\.has\(silentUrl\)/.test(screen) &&
    /silentHopsRef\.current >= MAX_SILENT_HOPS/.test(screen),
  'an unbounded silence walk re-opens the native source every eight seconds'
);
verify(
  'the heal timer, the PiP timers and the 429 retry cannot outlive the screen',
  /clearTimeout\(pipExitTimerRef\.current\)/.test(screen) &&
    /clearTimeout\(subsRestoreTimerRef\.current\)/.test(screen) &&
    /clearTimeout\(rateLimitRetryTimerRef\.current\)/.test(screen),
  'a timer holding a released VideoPlayer is the red box on the way out'
);

// ---------------------------------------------------------------------------
// 7. The rules that left the screen with this pass
// ---------------------------------------------------------------------------
section('7. source kind + route parsing (now in `lib/player/source.ts`)');

{
  const hlsToken = { url: 'https://hikari.streamrip.fun/p/opaque', container: 'hls' as const };
  const labelled = { url: 'https://cdn.test/master.m3u8', container: 'hls' as const };
  const contradiction = { url: 'https://cdn.test/master.m3u8', container: 'mp4' as const };
  const mp4 = { url: 'https://cdn.test/v.mp4', container: 'mp4' as const };

  check(
    'an extension-less HLS token is loaded as HLS, not as "auto"',
    contentTypeFor(hlsToken),
    'hls'
  );
  check('a self-describing m3u8 is HLS', contentTypeFor(labelled), 'hls');
  check('an mp4 is progressive', contentTypeFor(mp4), 'progressive');
  check(
    'MUTATION — a source that CONTRADICTS itself falls back to sniffing',
    contentTypeFor(contradiction),
    'auto'
  );
  check('…and the contradiction is visible to the dev log', labelDisagrees(contradiction), true);
  check('…while a consistent source is silent', labelDisagrees(labelled), false);

  check('a numeric route param parses', paramNumber('20920'), 20920);
  check('a duplicated query key takes the first value', paramNumber(['1', '2']), 1);
  check('junk is NaN, not a number', Number.isNaN(paramNumber('abc')), true);
  check('an absent param is NaN', Number.isNaN(paramNumber(undefined)), true);
  check('a real route is playable', isPlayableRoute(20920, 3), true);
  check('a NaN route is not', isPlayableRoute(Number.NaN, 3), false);
  check('episode 0 is not', isPlayableRoute(20920, 0), false);
  check('a fractional episode is not', isPlayableRoute(20920, 1.5), false);
}

// ---------------------------------------------------------------------------
// 8. The rung a master can honour without losing its audio (23 Nov)
// ---------------------------------------------------------------------------
section('8. separate audio + the ABR ceiling');

{
  const AUDIO = '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Japanese",URI="audio/jp.m3u8"';
  const MUXED = '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Japanese"';

  check('a separate audio rendition is detected', masterHasSeparateAudio(AUDIO), true);
  check(
    'MUTATION — a MUXED audio group is not separate (the safe case)',
    masterHasSeparateAudio(MUXED),
    false
  );
  check(
    'a master with no audio group at all is muxed',
    masterHasSeparateAudio('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv.m3u8'),
    false
  );
  check(
    'the tag may carry URI before TYPE and still count',
    masterHasSeparateAudio('#EXT-X-MEDIA:URI="a.m3u8",TYPE=AUDIO,GROUP-ID="x"'),
    true
  );

  check(
    'a cap keeps the variant width when the master states one',
    JSON.stringify(capFor({ width: 1920, height: 1080 })),
    '{"width":1920,"height":1080}'
  );
  check(
    'a bandwidth-only rung derives 16:9 from its height',
    JSON.stringify(capFor({ height: 720 })),
    '{"width":1280,"height":720}'
  );
  check('no height → NO cap, never a 0-pixel ceiling', capFor({}), null);

  // A `#EXT-X-STREAM-INF` with no RESOLUTION is not a picture size: it is an
  // audio-only rendition published as a variant, or a bandwidth-only entry.
  // Offering it gives a pick that plays a silent picture, and with no height
  // `capFor` cannot even apply it as a ceiling — the pick does nothing.
  check(
    'a heightless variant is not offered while the master declares heights',
    selectableRungs([{ height: 1080 }, { height: 720 }, {}]).length,
    2
  );
  check(
    'a master with no declared heights keeps its bandwidth-only rungs',
    selectableRungs([{}, {}, {}]).length,
    3
  );

  // The wiring, asserted statically: the pure rules are only worth anything if
  // the screen actually consults them. `screen` is the comment-stripped copy
  // section 6 already read.
  verify(
    'the screen never loads a bare variant of a separate-audio master (that is the silent picture)',
    /const separateAudio = !!list\?\.length && list\[0\]\?\.separateAudio === true/.test(screen) &&
      /const variantUrl = picked && !separateAudio/.test(screen),
    'Katana: video, no sound, no error'
  );
  /**
   * THE CEILING IS A PICK'S BUSINESS NOW (24 Nov).
   *
   * A separate-audio master is still never played as a bare variant URL (the
   * silent picture), so a picked rung is applied as `maxResolution` instead. What
   * changed is WHO may apply it: the ladder used to step such a master down by
   * ceiling on its own, which is the same unwanted quality decision in a costume
   * that costs no buffer. The recovery callback must not touch the rung at all.
   */
  const recoverBlock =
    /const recoverStream = useCallback[\s\S]*?recoverStreamRef\.current = recoverStream/.exec(screen)?.[0] ?? '';
  verify(
    'a picked rung on a separate-audio master is applied as a ceiling',
    /player\.maxResolution = separateAudio \? capFor\(picked\) : null/.test(screen),
    'a variant swap both mutes the picture and throws away the buffer'
  );
  verify(
    'the recovery path never touches quality or the ABR ceiling (24 Nov report)',
    recoverBlock.length > 0 && !/maxResolution|qualitySelRef|setQualitySel|capFor/.test(recoverBlock),
    'that is how 720p came back as 360p: a hiccup must not change the rung the viewer picked'
  );
  verify(
    'a silent picture is a failure with its own sentence',
    /NO_AUDIO_MESSAGE/.test(screen) &&
      /player\.availableAudioTracks\.length/.test(screen) &&
      /if \(tracks > 0\) return;/.test(screen),
    'no existing guard notices a missing audio track'
  );
  verify(
    'the silence timer cannot outlive the screen',
    /if \(!mountedRef\.current\) return;/.test(screen) &&
      /clearTimeout\(audioGuardRef\.current\)/.test(screen),
    'a 3s timer reading a released VideoPlayer is the red box on the way out'
  );
  verify(
    'an empty source list still ends the episode switch',
    /if \(!s\)[\s\S]{0,400}setSwitchPending\(false\)/.test(screen),
    'otherwise the loading stage stayed up over an episode that was playing'
  );
  verify(
    'the silence verdict is cancelled by a source change',
    /sourcesRef\.current\[srcIndexRef\.current\] !== sourceAtFrame/.test(screen),
    'otherwise the next source is blamed for this one being silent'
  );

  const filmu = readFileSync(`${ROOT}/lib/extensions/filmu/index.ts`, 'utf8');
  verify(
    'filmu still offers the dub rows (a sub-only matrix collapsed to one row)',
    /dub: \/dub\/i\.test\(serverId\)/.test(filmu) && !/if \(\/dub\/i\.test\(serverId\)\) return;/.test(filmu),
    'dropping them threw away audio-bearing rows before the probe ran'
  );
  verify(
    'sub rows come before dub rows',
    /candidates\.sort\(\(a, b\) => Number\(a\.dub\) - Number\(b\.dub\)\)/.test(filmu),
    'the subbed copy is the one a subtitle viewer wants first'
  );
}

// ---------------------------------------------------------------------------
console.log(
  fail
    ? `\n${fail} failed, ${pass} passed\n`
    : `\nall ${pass} passed — a slow link is waited out, then reloaded in place ONCE at\nthe same quality, and only then moved to another server. The quality is never\ntouched by the ladder, and the walk can run out of rounds, so it terminates.\n`
);
process.exit(fail ? 1 : 0);
