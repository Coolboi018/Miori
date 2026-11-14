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
 * Every rule below is a source-shape or constant assertion, and each one names
 * the shape that would get it wrong. Offline, no device, no network.
 *
 * Run with:  npx tsx scripts/check-splash.ts
 */

// Declared rather than imported from 'node:*': this project carries no
// @types/node, and the other source-reading checks do exactly this.
declare const require: (id: string) => {
  readFileSync(path: string, encoding: 'utf8'): string;
};
const { readFileSync } = require('node:fs');

declare const process: { cwd(): string; exit(code: number): never };

import { SPLASH, splashTotalMs } from '../lib/ui/splash';

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
console.log(`\n${pass + fail} checks — ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
