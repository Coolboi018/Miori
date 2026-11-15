/**
 * The player's vertical swipe — volume / brightness — and, above all, the reason
 * it cannot collide with the hold-to-speed gesture that already owns vertical
 * movement.
 *
 *   npx tsx scripts/check-vertical-swipe.ts
 *
 * WHAT THIS PINS. Four gestures share one `PanResponder`:
 *
 *   tap / double-tap → chrome toggle, ±10s seek      (`tapArbiter.ts`)
 *   press-and-hold   → speed boost, driven by dy     (`lib/player/speed.ts`)
 *   vertical drag    → volume / brightness           (`verticalSwipe.ts`)
 *
 * The last two are the dangerous pair: both are "finger down, move vertically".
 * The rule is ORDER, not direction — whichever claim is established first owns
 * the gesture:
 *
 *   sits still past HOLD_MS → speed, and `engagesVertical` then refuses
 *   moves first             → volume / brightness, and the hold timer is killed
 *
 * THE RULES ARE IMPORTED, NOT RESTATED. `verticalSwipe.ts` is written as pure
 * functions precisely so this file can drive the code that ships; a check with
 * its own copy of `|dy| > |dx| * 1.2` proves nothing about the app (that lesson
 * is already in `progress.md` via `check-nav-dedupe.ts`). Mutations below break
 * each rule in an INDEPENDENT reimplementation and demand a different outcome,
 * so the assertions cannot all pass by accident.
 */

import {
  V_DOMINANCE,
  V_SLOP,
  clampUnit,
  dragFraction,
  engagesVertical,
  hudSideFor,
  kindForX,
  sideForKind,
  sideForX,
  sidesFor,
  type SwipeSides,
} from '../components/player/fullscreen/verticalSwipe';

declare const require: (id: string) => {
  readFileSync(path: string, encoding: 'utf8'): string;
};
const { readFileSync } = require('node:fs');

const failures: string[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    console.log(`  pass  ${name}`);
  } else {
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
    failures.push(name);
  }
}

const IDLE = { holding: false, locked: false };

console.log('vertical swipe: engagement\n');

// ---------------------------------------------------------------------------
// 1. Slop, dominance, and the two claims that outrank it
// ---------------------------------------------------------------------------
check(
  'a still finger never engages (the first few points are noise)',
  !engagesVertical(0, V_SLOP - 1, IDLE)
);
check('a clear vertical drag engages', engagesVertical(3, V_SLOP + 6, IDLE));
check('dragging UP engages the same as down', engagesVertical(-2, -(V_SLOP + 6), IDLE));
check(
  'a diagonal drag that is mostly horizontal does NOT engage',
  !engagesVertical(40, 30, IDLE),
  'a thumb arc must not drop the volume'
);
check(
  'a hold that is already boosting keeps the gesture (speed wins)',
  !engagesVertical(0, 60, { holding: true, locked: false })
);
check(
  'a locked player refuses it, like it refuses a pocket seek',
  !engagesVertical(0, 60, { holding: false, locked: true })
);

console.log('\nmutation tests: break each rule, demand a different answer\n');

/** The rules with one piece removed, to prove the checks above are load-bearing. */
function mutated(dx: number, dy: number, mode: 'no-slop' | 'no-dominance' | 'hold-ignored'): boolean {
  if (mode === 'hold-ignored') return Math.abs(dy) > V_SLOP;
  if (mode === 'no-dominance') return Math.abs(dy) > V_SLOP;
  return true; // no-slop: engages on the first pixel
}

check(
  'mutation "no slop" would engage a still finger',
  mutated(0, 2, 'no-slop') && !engagesVertical(0, 2, IDLE)
);
check(
  'mutation "no dominance" would engage the diagonal drag',
  mutated(40, 30, 'no-dominance') && !engagesVertical(40, 30, IDLE)
);
check(
  'mutation "hold ignored" would steal the speed gesture',
  mutated(0, 60, 'hold-ignored') &&
    !engagesVertical(0, 60, { holding: true, locked: false })
);

console.log('\nvertical swipe: geometry and sides\n');

// ---------------------------------------------------------------------------
// 2. The fraction: up is more, a full height is the whole range
// ---------------------------------------------------------------------------
check(
  'sliding up is positive (raises the value)',
  dragFraction(500, 400, 500) === 0.2,
  `${dragFraction(500, 400, 500)}`
);
check('sliding down is negative', dragFraction(400, 500, 500) === -0.2);
check('a full-height swipe is exactly the whole range', dragFraction(500, 0, 500) === 1);
check('an unmeasured surface cannot produce NaN', dragFraction(500, 400, 0) === 0);

check(
  'the value the screen applies stays inside 0..1',
  clampUnit(0.9 + 0.4) === 1 && clampUnit(0.1 - 0.3) === 0 && clampUnit(0.42) === 0.42
);
// The screen's actual arithmetic, modelled once: baseline + fraction.
check(
  'baseline + fraction lands where the finger is',
  clampUnit(0.5 + dragFraction(600, 475, 500)) === 0.75,
  `got ${clampUnit(0.5 + dragFraction(600, 475, 500))}`
);

// ---------------------------------------------------------------------------
// 3. Which half is which, in both settings
// ---------------------------------------------------------------------------
const DEFAULT_SIDES: SwipeSides = sidesFor('brightness-left');
const SWAPPED: SwipeSides = sidesFor('volume-left');

check(
  'default: left half is brightness, right half is volume (the phone-player convention)',
  DEFAULT_SIDES.left === 'brightness' && DEFAULT_SIDES.right === 'volume'
);
check(
  'the setting can swap them',
  SWAPPED.left === 'volume' && SWAPPED.right === 'brightness'
);
check(
  'a touch resolves by the half it STARTED in',
  kindForX(100, 800, DEFAULT_SIDES) === 'brightness' &&
    kindForX(700, 800, DEFAULT_SIDES) === 'volume'
);
check(
  'and follows the swap',
  kindForX(100, 800, SWAPPED) === 'volume' && kindForX(700, 800, SWAPPED) === 'brightness'
);
check('an unmeasured surface resolves instead of returning undefined', kindForX(10, 0, DEFAULT_SIDES) === DEFAULT_SIDES.right);
check(
  'mutation "sides ignore the setting" breaks the swap check',
  sidesFor('volume-left').left === 'brightness'
    ? false
    : SWAPPED.left === 'volume'
);

// The HUD draws on the half the drag started on, so the side is part of the
// decision, not something the view re-derives from the knob.
check(
  'the drag side comes from where the press started',
  sideForX(100, 800) === 'left' && sideForX(700, 800) === 'right'
);
check('an unmeasured surface still resolves a side', sideForX(10, 0) === 'right');
check(
  'the readout draws on the OPPOSITE edge from the drag',
  hudSideFor('left') === 'right' && hudSideFor('right') === 'left',
  'a bar under the thumb is a bar nobody can see'
);
check(
  'mirroring is its own inverse (no drift between the two helpers)',
  hudSideFor(hudSideFor('left')) === 'left' && hudSideFor(hudSideFor('right')) === 'right'
);
check(
  'a knob maps back to its half under BOTH settings',
  sideForKind(DEFAULT_SIDES, 'brightness') === 'left' &&
    sideForKind(DEFAULT_SIDES, 'volume') === 'right' &&
    sideForKind(SWAPPED, 'brightness') === 'right' &&
    sideForKind(SWAPPED, 'volume') === 'left'
);

// ---------------------------------------------------------------------------
// 4. The surface uses THESE functions, and resolves nothing else after a drag
// ---------------------------------------------------------------------------
console.log('\nvertical swipe: the surface and the wire-up\n');

function read(path: string): string {
  return readFileSync(`${process.cwd()}/${path}`, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

const surface = read('components/player/fullscreen/GestureSurface.tsx');
const screen = read('components/player/fullscreen/PlayerScreen.tsx');
const store = read('lib/settings/store.ts');
const hud = read('lib/player/sideHud.ts');
const hudView = read('components/player/fullscreen/Hud.tsx');
const brightness = read('lib/player/brightness.ts');
const swipeApply = read('lib/player/swipeApply.ts');
const volumeSrc = read('lib/player/volume.ts');

check(
  'the surface delegates to the real rules (no second copy)',
  /engagesVertical\(/.test(surface) &&
    /kindForX\(/.test(surface) &&
    /dragFraction\(/.test(surface)
);
check(
  'and it passes the live hold state into the decision',
  /engagesVertical\(g\.dx, g\.dy, \{[\s\S]{0,120}holding: holdRef\.current\.active/.test(surface),
  'without `holding` the two gestures both claim one press'
);
// Slop and dominance must be START conditions: the move handler has to hand an
// already-engaged drag straight back to the screen, BEFORE it re-tests anything.
{
  const move = /onPanResponderMove: \(e, g\) => \{([\s\S]*?)onPanResponderRelease/.exec(surface)?.[1] ?? '';
  const engaged = move.indexOf('verticalRef.current.active');
  const start = move.indexOf('engagesVertical(');
  check(
    'an engaged drag is handled before any start test (it cannot drop out)',
    engaged !== -1 && start !== -1 && engaged < start,
    `active at ${engaged}, engagesVertical at ${start}`
  );
}
// A vertical swipe must never resolve as a tap — the release branch has to run
// BEFORE `resolveTap`.
{
  const release = /onPanResponderRelease: \(e\) => \{([\s\S]*?)onPanResponderTerminate/.exec(surface)?.[1] ?? '';
  const vertical = release.indexOf('verticalRef.current.active');
  const taps = release.indexOf('resolveTap(');
  check(
    'a released vertical swipe returns before the tap arbitration',
    vertical !== -1 && taps !== -1 && vertical < taps,
    `vertical at ${vertical}, resolveTap at ${taps}`
  );
  check(
    'and it clears the parked half-pair on the way in',
    /onPanResponderMove[\s\S]{0,900}lastTapRef\.current = EMPTY_TAP_STATE/.test(surface),
    'a swipe followed by an older tap\'s toggle is the bug this prevents'
  );
}
check(
  'the screen owns the values: handlers wired, sides passed',
  /swipeSides=\{swipeSides\}/.test(screen) &&
    /onVerticalStart,/.test(screen) &&
    /onVerticalMove,/.test(screen) &&
    /onVerticalEnd,/.test(screen)
);
check(
  'the brightness session is ended on the way out (iOS keeps the value)',
  /beginBrightnessSession\(\)/.test(screen) &&
    /return \(\) => \{[\s\S]{0,120}endBrightnessSession\(\)/.test(screen)
);
check(
  'brightness writes are coalesced, not one native call per frame',
  /createLatestWriter/.test(brightness) &&
    /setTimeout/.test(swipeApply) &&
    /pending = value/.test(swipeApply),
  'on Android this write is a full window relayout, not a property poke'
);
check(
  'and it is written in steps, so a sweep is a dozen relayouts and not sixty',
  /const STEP/.test(brightness) && /quantise\(/.test(brightness)
);
//
// CLEARING THE OVERRIDE, NOT WRITING A NUMBER BACK (16 Nov).
//
// `setBrightnessAsync(original)` reads like a restore and is not one: the window
// keeps that value, so the ACTIVITY — every screen in the app — stops following
// the system, adaptive brightness included. The reported symptom was exactly
// that. Only `restoreSystemBrightnessAsync` (BRIGHTNESS_OVERRIDE_NONE) gives the
// window back.
check(
  'leaving the player hands the window back to the SYSTEM brightness',
  /restoreSystemBrightnessAsync\(\)/.test(brightness) &&
    !/setBrightnessAsync\(restore\)/.test(brightness),
  'a written number leaves the whole activity pinned, not just the player'
);
check(
  'the volume write is coalesced the same way',
  /createLatestWriter/.test(volumeSrc) &&
    /VOLUME_WRITE_MS/.test(volumeSrc) &&
    /setVolume\(value\)/.test(screen),
  'a per-frame native volume write is a platform call plus an event back into JS'
);
//
// THE TWO HALVES, AND THE DIFFERENT THINGS THEY MOVE (16 Nov).
//
// Volume must move the DEVICE stream — the hardware keys already do, so an app
// that only moves its own gain puts two "volumes" under one gesture. Brightness
// must stay this app's window, and be given back on exit.
check(
  'the volume swipe moves the DEVICE stream, not our own gain',
  /VolumeManager/.test(volumeSrc) &&
    /setVolume\(value, \{ showUI: false/.test(volumeSrc) &&
    /beginVolumeSession\(\)/.test(screen),
  'the hardware keys move the device volume — two numbers for one word is a HUD that lies'
);
check(
  '…and Expo Go still BOOTS: the native module is loaded lazily',
  /await import\('react-native-volume-manager'\)/.test(volumeSrc) &&
    !/^import .*react-native-volume-manager/m.test(volumeSrc),
  'a static import of a module Expo Go does not contain throws while the bundle evaluates'
);
check(
  '…falling back to the player gain when there is no device API',
  /setVolumeFallback/.test(volumeSrc) && /setVolumeFallback\(/.test(screen)
);
check(
  "brightness stays THIS APP'S window, never the device setting",
  /setBrightnessAsync/.test(brightness) && !/setSystemBrightnessAsync/.test(brightness),
  'a player that dims the whole phone leaves a change nobody can trace back to it'
);
check(
  'the trailing value still lands (coalescing, not a debounce)',
  /end\(\): void \{/.test(swipeApply) && /flush\(\)/.test(swipeApply),
  'a debounce would only write once the finger stopped'
);
check(
  'the HUD lives in its own store, so a drag never re-renders the screen',
  /subscribeSideHud/.test(hud) && !/useState/.test(hud)
);
check(
  'the store carries the SIDE, so swapping the halves moves the readout too',
  /side: SideHudSide/.test(hud) && /showSideHud\([\s\S]{0,80}side[\s\S]{0,40}\)/.test(screen)
);
check(
  'the surface reports the side it started on',
  /onVerticalStart\(kind, side\)/.test(surface)
);
// The readout must hang on the edge the finger is on — not float over the frame.
check(
  'the readout is anchored to a side, not centred over the video',
  /insets\.left/.test(hudView) &&
    /insets\.right/.test(hudView) &&
    /left \? \{ left:/.test(hudView) &&
    !/minWidth: 208/.test(hudView),
  'a centred pill covers the picture and the gesture path'
);
check(
  'the view mirrors the drag side through `hudSideFor` (not by hand)',
  /hudSideFor\(hud\.side\)/.test(hudView),
  'a local `=== right` flip would drift from the rule the check drives'
);
//
// THE VALUE PATH — 16 Nov. The first version re-rendered React once per visible
// percent and re-laid-out a PERCENTAGE-HEIGHT fill each time. On a low-end phone
// that burst starved the decoder, and the stutter outlived the gesture. These
// three checks pin the shape that prevents it.
{
  const sideHudSource = hudView.slice(
    hudView.indexOf('SideHud = memo('),
    hudView.indexOf('const styles')
  );
  check(
    'the readout subscribes to the store itself, not through React state',
    /subscribeSideHud\(/.test(sideHudSource) && !/useSyncExternalStore/.test(sideHudSource),
    'a value that arrives through React state is a re-render per percent'
  );
  check(
    'a value goes to a shared value, and nothing renders a number from it',
    /fill\.value = s\.value/.test(sideHudSource) &&
      !/percent/.test(sideHudSource) &&
      !/<Text/.test(sideHudSource),
    'a percent text node is what forces ~100 renders across one sweep'
  );
  check(
    'a value change returns before React is told anything at all',
    /if \(s\.kind === kind && s\.side === side\) return;/.test(sideHudSource),
    'even a bailing setState is work on the JS thread under a moving finger'
  );
  check(
    'only a change of kind or side re-renders it, and only kind re-fades',
    /const kindChanged = s\.kind !== kind;/.test(sideHudSource) &&
      /setHud\(\{ kind, side \}\)/.test(sideHudSource)
  );
}
check(
  'and it is a VERTICAL fill, drawn from the bottom, in POINTS',
  /useAnimatedStyle/.test(hudView) &&
    /justifyContent: 'flex-end'/.test(hudView) &&
    /height: fill\.value/.test(hudView) &&
    !/height: `\$\{percent\}%`/.test(hudView),
  'an animated percentage height re-runs layout for every step'
);
check(
  'the settings default is the conventional one',
  /'player\.swipeSides': 'brightness-left'/.test(store)
);

console.log(`\n${failures.length ? `${failures.length} rule(s) failed` : 'all passed'}\n`);
if (failures.length) process.exit(1);
