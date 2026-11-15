/**
 * The splash, pinned — timing budget, seamless hand-off, and the backstop.
 *
 * The report (14 Nov) was "it lags, and on my low-end phone it just sticks". A
 * splash fails in exactly the ways numbers cannot be read back from a screen:
 *
 *   1. it fades the logo IN FROM BLACK, which is a black screen the user calls a
 *      hang (there is nothing to see, so nothing is happening);
 *   2. its timeline is longer than launching takes, so it turns a fast start into
 *      a slow one;
 *   3. its completion callback is the ONLY thing that removes the overlay, so a
 *      delayed frame leaves a black rectangle over a working app — the actual
 *      "stuck" bug.
 *
 * The follow-up report (15 Nov) was "it's just my logo, still". Motionless has
 * two more causes, both pinned below and both invisible in a code review:
 *
 *   4. the entrance PLAYS WHERE IT CANNOT BE SEEN — behind the native splash's
 *      own 400ms exit fade, or before the logo bitmap has finished decoding;
 *   5. reduce motion, which Android also switches on for battery saver, used to
 *      hold the logo at full opacity and "animate" it from 1 to 1.
 *
 * And the third report (15 Nov, "home screen for a second, THEN the splash
 * animation, THEN home") is the cover being late rather than the entrance being
 * hidden: the overlay was mounted after the hand-off, so the app was on screen
 * uncovered until it arrived. Mount and timeline are gated separately now.
 *
 * Every rule below is a source-shape or constant assertion, and each one names
 * the shape that would get it wrong. Offline, no device, no network.
 *
 * Run with:  npx tsx scripts/check-splash.ts
 */

// Declared rather than imported from 'node:*': this project carries no
// @types/node, and the other source-reading checks do exactly this.
declare const require: (id: string) => {
  readFileSync(path: string, encoding: 'utf8' | 'binary'): string;
};
const { readFileSync } = require('node:fs');

declare const process: { cwd(): string; exit(code: number): never };

import { SPLASH, handoffMs, splashTotalMs } from '../lib/ui/splash';

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

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(`${ROOT}/${rel}`, 'utf8');

/** Comments stripped, so a comment NAMING the banned shape cannot satisfy a pin. */
function stripSource(src: string): string {
  return src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

// ---------------------------------------------------------------------------
section('timing budget');
// ---------------------------------------------------------------------------

const normal = splashTotalMs(false);
const reduced = splashTotalMs(true);

// A splash that outlasts the launch it covers IS the slow launch.
check('normal splash is under a second', normal < 1000, true);
check('normal splash is still a splash, not a blink', normal >= 500, true);
// Reduce motion means less travel, so there is less to wait for.
check('reduce-motion is shorter than the normal path', reduced < normal, true);
// The backstop must never cut a healthy animation: a watchdog close to the
// timeline turns a slow frame into a truncated fade, which looks worse than the
// splash it was protecting.
check('watchdog clears the fade by at least a second', SPLASH.watchdogMs >= normal + 1000, true);
// Subtle zoom. A big one is both uglier and more frames on a weak GPU.
check('logo scale start is a nudge, not a zoom', SPLASH.fromScale >= 0.85 && SPLASH.fromScale <= 0.95, true);
// The old artifact was 1100 + 420 + spring settle + 360. Pinned as a regression
// guard on the thing the user actually noticed.
check('the old 1.9s hold is gone', SPLASH.holdMs < 1000, true);
// VISIBLE motion. The first rebuild left the logo fully opaque and moved it 8%,
// which on a phone is indistinguishable from a stuck screen — the report that
// followed. Both numbers below have to stay in "you can see it" territory.
check('the logo fades in from below full opacity', SPLASH.fromOpacity < 1, true);
check('the scale travel is at least 10%', 1 - SPLASH.fromScale >= 0.1, true);
// The hand-off has to be a beat, not a second act of its own: it is time the
// user spends watching the NATIVE splash before the in-app one is allowed to
// move at all.
check('the hand-off to the in-app entrance is a beat', handoffMs() < 400, true);
check('the hand-off covers the native exit fade', handoffMs() > SPLASH.nativeExitMs, true);

// ---------------------------------------------------------------------------
section('the entrance is visible — and actually animates');
// ---------------------------------------------------------------------------

const splashSrc = stripSource(read('components/AnimatedSplash.tsx'));

// ⚠️ THE REGRESSION BEHIND "did you even animate it?".
// `Animated.createAnimatedComponent(Image)` on expo-image leaves the animated
// style on the component wrapper instead of the native host, so the shared
// values update and the screen never moves. Only a HOST `Animated.View` is
// guaranteed to animate, in Expo Go and in a release build alike.
check('no animated composite image', /createAnimatedComponent/.test(splashSrc), false);
check(
  'the logo box is a host Animated.View',
  /<Animated\.View style=\{\[styles\.logoBox, logoStyle\]\}>/.test(splashSrc),
  true
);
// Visible motion, not a still frame: both properties start from the shared
// constants and are actually driven by a timing curve.
check(
  'entrance starts from the shared constants',
  /SPLASH\.fromOpacity/.test(splashSrc) && /SPLASH\.fromScale/.test(splashSrc),
  true
);
check('a fade-in is actually driven', /logoOpacity\.value = withTiming\(1/.test(splashSrc), true);
check('the scale is actually driven', /logoScale\.value = withTiming\(1/.test(splashSrc), true);
// Reduce motion removes travel, never the transition itself — a completely
// still frame is what a frozen app looks like.
check('reduce-motion still cross-fades', /reducedFadeMs/.test(splashSrc), true);
// ⚠️ THE "IT'S JUST A STILL LOGO" BUG, on the path a low-end phone actually
// takes. `useSharedValue(reduced ? 1 : SPLASH.fromOpacity)` holds the logo at
// FULL opacity under reduce motion, so the fade-in that follows is an animation
// from 1 to 1. Reduce motion is on for battery saver as well as the
// accessibility toggle, which is why this showed up on the weak device.
check(
  'reduce-motion fades in from the same place',
  /logoOpacity = useSharedValue(?:<number>)?\(SPLASH\.fromOpacity\)/.test(splashSrc),
  true
);
check(
  'the full-opacity reduce-motion start would be rejected',
  /logoOpacity = useSharedValue(?:<number>)?\(SPLASH\.fromOpacity\)/.test(
    'const logoOpacity = useSharedValue(reduced ? 1 : SPLASH.fromOpacity);'
  ),
  false
);
// ⚠️ AND THE DECODE. The logo is a bundled bitmap decoded off the main thread,
// so a timeline started on mount can be over before the first frame WITH a logo
// in it is painted. The entrance arms on the image's own `onLoad` (or on the
// fallback ceiling, so a hung decode cannot mute the splash).
check(
  'the entrance arms on the logo decode',
  /onLoad=\{markDecoded\}/.test(splashSrc) && /onError=\{markDecoded\}/.test(splashSrc),
  true
);
// ⚠️ BOTH HALVES. The decode is the reason the timeline cannot start on mount;
// `handoffDone` is the reason it cannot start while the native splash is still
// drawn over the tree. Either one missing puts the entrance where it cannot be
// seen, which is the whole "it's just my logo, still" family of reports.
check(
  'the entrance waits on the decode AND the hand-off',
  /if \(!handoffDone \|\| !decoded\) return;/.test(splashSrc),
  true
);
check(
  'the entrance would not start behind the native splash',
  /if \(!handoffDone \|\| !decoded\) return;/.test('if (!decoded) return;'),
  false
);
check(
  'the decode wait has a shared ceiling',
  /setTimeout\(markDecoded, SPLASH\.decodeFallbackMs\)/.test(splashSrc),
  true
);
// THE APP IS RELEASED WHEN THE ENTRANCE ENDS. The mount that follows is the
// biggest single lump of launch work, and it is deliberately spent on the still
// hold rather than on a moving frame.
check(
  'the app is released when the entrance completes',
  /setTimeout\(onEntered, enterMs\)/.test(splashSrc),
  true
);
check(
  'the release is timed off the shared entrance constant',
  /const enterMs = reduced \? SPLASH\.reducedFadeMs : SPLASH\.enterMs;/.test(splashSrc),
  true
);
// One cheap curve instead of a per-frame solver.
check('no spring solver on the splash', /withSpring/.test(splashSrc), false);
check('a cubic timing curve drives the logo', /withTiming/.test(splashSrc) && /Easing\.out/.test(splashSrc), true);
// expo-image, not Animated.Image: downsampled decode + no implicit 300ms fade.
check('logo renders through expo-image', /from 'expo-image'/.test(splashSrc), true);
check('expo-image cross-fade disabled', /transition=\{0\}/.test(splashSrc), true);
check('Animated.Image is not used at startup', /Animated\.Image\b/.test(splashSrc), false);

// ---------------------------------------------------------------------------
section('the overlay can never stick');
// ---------------------------------------------------------------------------

const rootSrc = stripSource(read('app/_layout.tsx'));
check(
  'root layout arms the watchdog off the shared constant',
  /setTimeout\(\(\) => setAnimatedSplashVisible\(false\), SPLASH\.watchdogMs\)/.test(rootSrc),
  true
);
check(
  'the watchdog is conditional on the overlay being up',
  /if \(!animatedSplashVisible\) return;/.test(rootSrc),
  true
);
// ⚠️ THE COVER-FIRST ORDER — the 15 Nov report, "it shows my home screen for a
// second, then switches to the splash animation, then finally the home screen".
// The overlay was mounted only AFTER the native hand-off, so for that whole
// window the React tree was on screen with NOTHING over it and the first frame
// the user saw was the app. Gating the MOUNT on the hand-off is the bug; gating
// the TIMELINE on it is the fix.
check(
  'the overlay is mounted on the first frame, not after the hand-off',
  /\{animatedSplashVisible \? \(/.test(rootSrc),
  true
);
check(
  'mounting the overlay on the hand-off would be rejected',
  /\{animatedSplashVisible \? \(/.test('{splashOverlayUp ? <AnimatedSplash onFinish={x} /> : null}'),
  false
);
// The app tree waits for the entrance, so the launch's biggest render lands on
// the still hold instead of competing with the animation.
check(
  'the app tree waits for the entrance to finish',
  /const showApp = appEntered \|\| !animatedSplashVisible;/.test(rootSrc),
  true
);
check(
  'the app tree is rendered through that gate',
  /\{showApp \? <RootLayoutNav \/> : null\}/.test(rootSrc),
  true
);
// The watchdog tears the overlay down without `onEntered` ever firing, so the
// app has to be released by the overlay's absence too — otherwise a stalled
// entrance ends on the overlay's black with no way out.
check(
  'a stalled entrance still releases the app',
  /const showApp = appEntered \|\| !animatedSplashVisible;/.test(
    'const showApp = appEntered;'
  ),
  false
);
check(
  'the hand-off is timed off the shared constants',
  /setTimeout\(\(\) => setNativeSplashGone\(true\), handoffMs\(\)\)/.test(rootSrc),
  true
);
check(
  'the native exit fade is shortened from the library default',
  /SplashScreen\.setOptions\(\{ duration: SPLASH\.nativeExitMs \}\)/.test(rootSrc),
  true
);
// THE LAUNCH GATE, pinned because it is the startup win: fonts plus the one
// settings read, with the native video-cache calls moved behind the first frame.
// Re-widening it to the cache is a silent relaunch-cost regression.
check('the launch gate is fonts and settings', /if \(!fontsReady \|\| !settingsReady\) return null;/.test(rootSrc), true);
check('the launch gate no longer waits on the video cache', /playerCacheReady/.test(rootSrc), false);
// The OLD shape, watched failing: a completion callback as the only teardown.
check(
  'a callback-only teardown would be rejected',
  /setTimeout\(\(\) => setAnimatedSplashVisible\(false\), SPLASH\.watchdogMs\)/.test(
    'containerOpacity.value = withTiming(0, {}, (f) => { if (f) runOnJS(onFinish)(); });'
  ),
  false
);

// ---------------------------------------------------------------------------
section('native splash and in-app splash agree on the frame');
// ---------------------------------------------------------------------------

const appJson = JSON.parse(read('app.json')) as {
  expo: {
    plugins: Array<string | [string, Record<string, unknown>]>;
    android: { backgroundColor: string };
  };
};
const splashPlugin = appJson.expo.plugins.find(
  (p): p is [string, Record<string, unknown>] => Array.isArray(p) && p[0] === 'expo-splash-screen'
);
const nativeWidth = splashPlugin?.[1]?.imageWidth;
const logoWidth = Number(/logoBox:\s*\{[\s\S]*?width:\s*(\d+)/.exec(splashSrc)?.[1] ?? NaN);

// A different native logo size makes the hand-off a visible jump — the exact
// "janky" the user described, and invisible in code review.
check('native splash imageWidth is set', typeof nativeWidth, 'number');
check('native and in-app logo widths match', nativeWidth, logoWidth);
check('logo width is a real number', Number.isFinite(logoWidth), true);

const nativeBg = String(splashPlugin?.[1]?.backgroundColor ?? '').toLowerCase();
const containerBg = /container:\s*\{[\s\S]*?backgroundColor:\s*'([^']+)'/.exec(splashSrc)?.[1]?.toLowerCase();
// Any difference between these two is a flash at hand-off.
check('native and in-app backgrounds match', nativeBg, containerBg);

// ---------------------------------------------------------------------------
section('the logo bitmap is sized for the box');
// ---------------------------------------------------------------------------

// ⚠️ THE LOW-END DECODE. The source was 1254×1254 / 770KB to fill a 168dp box —
// roughly six times the pixels any screen asks for, and every one of them is
// allocated and decoded before the first frame of the entrance can be painted.
// On a weak device that is the splash's whole budget spent on pixels nobody
// sees. The floor is the box at 4x (so nothing upscales on the densest panel),
// the ceiling is 1024 (so a poster cannot come back).
const logoPx = (() => {
  // 'binary' on purpose: one char per byte, so both the IHDR dimensions and the
  // file size below can be read off the same buffer.
  const header = readFileSync(`${ROOT}/assets/images/splash-icon.png`, 'binary');
  const be32 = (at: number) =>
    ((header.charCodeAt(at) << 24) |
      (header.charCodeAt(at + 1) << 16) |
      (header.charCodeAt(at + 2) << 8) |
      header.charCodeAt(at + 3)) >>>
    0;
  return { width: be32(16), height: be32(20), bytes: header.length };
})();

check('the logo source decodes to a square', logoPx.width, logoPx.height);
check('the logo source covers the box at 4x', logoPx.width >= logoWidth * 4, true);
check('the logo source is not a poster', logoPx.width <= 1024, true);
// A loose ceiling, not a target: it catches a re-export at full resolution,
// which is the shape this came back as once already.
check('the logo file is not a megabyte', logoPx.bytes < 400 * 1024, true);

// ---------------------------------------------------------------------------
console.log(`\n${pass + fail} checks — ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
