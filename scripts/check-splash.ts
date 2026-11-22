/**
 * The launch animation is an Android AnimatedVectorDrawable. Every rule it has
 * to obey is invisible in code review and expensive to see on a device — you
 * need an installed APK, an Android 12+ phone and a cold start to notice — so
 * they are asserted here instead.
 *
 * THE FOUR REPORTS THIS PINS
 *
 *   1. "THE CIRCLE CUTS PART OF THE LOGO." Android masks the splash icon to a
 *      centred circle 2/3 the width of the drawable; everything outside it is
 *      not drawn. The artwork's furthest ink was 321 units from centre against
 *      a 233-unit radius — 51.5% of the sampled outline outside the mask — so
 *      the M's tips were missing. The fix is `logo_fit` (scale 0.68); the
 *      check SAMPLES THE ACTUAL CUBIC PATHS and applies that scale, and also
 *      proves the old geometry fails it.
 *
 *   2. "IT'S ZOOMED IN." The AVD ran 1400ms under `windowSplashScreenAnimation
 *      Duration="1500"`, past Android's ~1000ms budget, so it was stopped at an
 *      arbitrary frame in the middle of the settle. The intro must FINISH
 *      inside the budget.
 *
 *   3. "THE LOGO IS CUT" ALSO MEANT HALF-DRAWN. The drawable's static values
 *      were the FIRST frame (`fillAlpha=0`, `trimPathEnd=0`), and Android may
 *      skip the animation entirely when the app is ready early — showing a
 *      blank icon area or a bare sliver of outline. The static state must be
 *      the FINISHED logo, and the outline's visibility during the intro has to
 *      be restored by a hold animator rather than by its static value.
 *
 *   4. "IT SITS STILL FOR 4-5 SECONDS." The intro is one-shot, so a slow cold
 *      start froze it on its last frame until JS hid the splash. The AVD must
 *      carry an infinitely repeating idle pulse that begins exactly where the
 *      intro ends — the native loading indicator, with no in-app overlay and no
 *      second hand-off.
 *
 * Offline: reads the XML/TS/JS files, samples the vector paths, no device.
 * Run with:  npx tsx scripts/check-splash.ts
 */

import { SPLASH } from '../lib/ui/splash';

// Declared rather than imported from 'node:*': this project carries no
// @types/node, and the other source-reading checks do exactly this.
declare const require: (id: string) => {
  readFileSync(path: string, encoding: 'utf8'): string;
};
const { readFileSync } = require('node:fs');

declare const process: { cwd(): string; exit(code: number): never };

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(`${ROOT}/${rel}`, 'utf8');

let failures = 0;
function check(name: string, pass: boolean, detail = '') {
  if (pass) {
    console.log(`  pass  ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? ` \u2014 ${detail}` : ''}`);
  }
}

const attr = (src: string, name: string): string | undefined =>
  new RegExp(`android:${name}="([^"]*)"`).exec(src)?.[1];

/** Every `<objectAnimator …/>` block in an animator file. */
function animators(rel: string): string[] {
  const src = read(rel);
  const out: string[] = [];
  const re = /<objectAnimator\b([\s\S]*?)\/>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) out.push(m[1]);
  return out;
}

const numeric = (src: string, name: string, fallback = 0): number => {
  const v = attr(src, name);
  if (v == null) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

const DRAWABLE = 'Logo/ic_miori_logo.xml';
const AVD = 'Logo/avd_miori_logo.xml';
const ANIMATOR_FILES = ['Logo/miori_stroke.xml', 'Logo/miori_fill.xml', 'Logo/miori_scale.xml'];

const drawable = read(DRAWABLE);
const avd = read(AVD);

// ===========================================================================
// 1. The drawing is the artwork, inside the mask, grown from its own centre
// ===========================================================================
console.log('\n[native splash geometry]');

/** Sample every cubic in the path and return the ink's bounding box. */
function sampleInk(pathData: string) {
  const toks = pathData.match(/[A-Za-z]|-?\d*\.?\d+(?:e-?\d+)?/g) ?? [];
  const points: [number, number][] = [];
  let i = 0;
  let cmd = '';
  let cx = 0;
  let cy = 0;
  const num = () => Number(toks[i++]);
  const step = 0.02;
  const cubic = (x0: number, y0: number, x1: number, y1: number, x2: number, y2: number, x3: number, y3: number) => {
    for (let t = 0; t <= 1; t += step) {
      const u = 1 - t;
      points.push([
        u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3,
        u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3,
      ]);
    }
  };
  while (i < toks.length) {
    const tok = toks[i];
    if (/[A-Za-z]/.test(tok)) {
      cmd = tok;
      i++;
      continue;
    }
    if (cmd === 'M') {
      cx = num();
      cy = num();
      points.push([cx, cy]);
      cmd = 'L';
    } else if (cmd === 'L') {
      cx = num();
      cy = num();
      points.push([cx, cy]);
    } else if (cmd === 'C') {
      const x1 = num();
      const y1 = num();
      const x2 = num();
      const y2 = num();
      const x3 = num();
      const y3 = num();
      cubic(cx, cy, x1, y1, x2, y2, x3, y3);
      cx = x3;
      cy = y3;
    } else {
      i++;
    }
  }
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let maxR = 0;
  for (const [x, y] of points) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
    maxR = Math.max(maxR, Math.hypot(x - 350, y - 350));
  }
  return { points: points.length, minX, maxX, minY, maxY, maxR };
}

const pathData = /android:pathData="([^"]+)"/.exec(drawable)?.[1] ?? '';
const ink = sampleInk(pathData);

/** Android's visible circle: 2/3 of the icon area, i.e. radius = 1/3 of 700. */
const MASK_RADIUS = 700 / 3;
/** The idle pulse's peak, from `Logo/miori_scale.xml`. */
const PULSE_PEAK = 1.025;

const fitBlock = /android:name="logo_fit"[\s\S]{0,500}?android:scaleX="([\d.]+)"/.exec(drawable);
const fit = fitBlock ? Number(fitBlock[1]) : NaN;

check('the drawable has a fit group around the artwork', Number.isFinite(fit), `fit=${fit}`);
check(
  'the artwork fits inside the 2/3 circle, even at the idle pulse peak',
  ink.maxR * fit * PULSE_PEAK <= MASK_RADIUS,
  `furthest ink ${(ink.maxR * fit * PULSE_PEAK).toFixed(1)} vs mask radius ${MASK_RADIUS.toFixed(1)}`
);
check(
  'the fit is not needlessly small — it fills at least 80% of the circle',
  ink.maxR * fit >= MASK_RADIUS * 0.8,
  `${((ink.maxR * fit) / MASK_RADIUS * 100).toFixed(0)}% of the radius`
);
// MUTATION: the shipped geometry, with no fit group at all. This is what the
// device saw, and it must fail the rule above — otherwise that rule is vacuous.
check(
  'the mutation (no fit group) puts over half the ink outside the mask — so this check can fail',
  ink.maxR > MASK_RADIUS && ink.maxR / MASK_RADIUS > 1.3,
  `unscaled ink ${ink.maxR.toFixed(1)} vs ${MASK_RADIUS.toFixed(1)}`
);

{
  // The zoom must grow from the logo's own centre, or the settle drifts the
  // artwork sideways and the fit margin is spent on one side only.
  const group = /android:name="logo_group"[\s\S]{0,600}?android:pivotX="([\d.]+)"[\s\S]{0,200}?android:pivotY="([\d.]+)"/.exec(drawable);
  const pivotX = group ? Number(group[1]) : NaN;
  const pivotY = group ? Number(group[2]) : NaN;
  const bboxCx = (ink.minX + ink.maxX) / 2;
  const bboxCy = (ink.minY + ink.maxY) / 2;
  check(
    'the animated group pivots on the artwork’s own centre',
    Number.isFinite(pivotX) && Math.abs(pivotX - bboxCx) < 3 && Math.abs(pivotY - bboxCy) < 3,
    `pivot ${pivotX},${pivotY} vs bbox centre ${bboxCx.toFixed(1)},${bboxCy.toFixed(1)}`
  );
  check(
    'the fit group also pivots on the centre, so scaling cannot shift the mark',
    /android:name="logo_fit"[\s\S]{0,300}?android:pivotX="350"[\s\S]{0,120}?android:pivotY="350"/.test(drawable)
  );
}

// ===========================================================================
// 2. The static state is the FINISHED logo
// ===========================================================================
// Android can skip the animation when the app is ready early; it can also stop
// it at any frame. Whatever is not animated away must therefore be correct.
console.log('\n[native splash static state]');

check('the fill is visible without animation', attr(drawable, 'fillAlpha') === '1', attr(drawable, 'fillAlpha'));
check(
  'the outline is GONE without animation (the finished logo has no outline)',
  attr(drawable, 'strokeAlpha') === '0',
  attr(drawable, 'strokeAlpha')
);
check(
  'the outline path is fully trimmed without animation',
  attr(drawable, 'trimPathEnd') === '1',
  attr(drawable, 'trimPathEnd')
);
check(
  'the group sits at its final scale without animation',
  /android:scaleX="1"/.test(drawable) && /android:scaleY="1"/.test(drawable)
);
check(
  'the mutation (first-frame statics) is gone — it rendered a blank icon when the animation was skipped',
  !/android:fillAlpha="0"/.test(drawable) && !/android:trimPathEnd="0"/.test(drawable)
);

// ===========================================================================
// 3. The intro finishes inside Android's budget, and the metadata agrees
// ===========================================================================
console.log('\n[native splash timing]');

const all = ANIMATOR_FILES.flatMap((file) => animators(file).map((block) => ({ file, block })));
const looping = all.filter(({ block }) => attr(block, 'repeatCount') === '-1');
const intro = all.filter(({ block }) => attr(block, 'repeatCount') !== '-1');
const introEnd = Math.max(
  ...intro.map(({ block }) => numeric(block, 'startOffset') + numeric(block, 'duration'))
);

check('the intro has real animators', intro.length >= 4, `${intro.length} one-shot animators`);
check(
  'the intro ends inside Android’s ~1000ms splash-animation budget',
  introEnd <= 1000,
  `${introEnd}ms`
);
check(
  'the intro length matches SPLASH.nativeAnimationMs',
  introEnd === SPLASH.nativeAnimationMs,
  `AVD ${introEnd}ms vs SPLASH ${SPLASH.nativeAnimationMs}ms`
);
{
  const plugin = read('plugins/withSplashAnimation.js');
  const declared = /ANIMATION_DURATION_MS\s*=\s*'(\d+)'/.exec(plugin)?.[1];
  check(
    'the plugin hands Android the intro’s real length as windowSplashScreenAnimationDuration',
    declared === String(SPLASH.nativeAnimationMs),
    `plugin ${declared} vs ${SPLASH.nativeAnimationMs}`
  );
  check(
    'the plugin copies every file the AVD references into the generated project',
    ['ic_miori_logo.xml', 'miori_fill.xml', 'miori_scale.xml', 'miori_stroke.xml'].every((f) =>
      plugin.includes(f)
    )
  );
}
check(
  'the AVD plays the three animators it was built for',
  /@drawable\/ic_miori_logo/.test(avd) &&
    ['logo_stroke', 'logo_fill', 'logo_group'].every((name) =>
      new RegExp(`android:name="${name}"`).test(avd)
    ) &&
    ['miori_stroke', 'miori_fill', 'miori_scale'].every((file) =>
      avd.includes(`@animator/${file}`)
    )
);
// The outline must be visible while it draws. Its static alpha is 0 (finished
// state), so without a hold animator the draw happens on an invisible stroke.
{
  const holds = animators('Logo/miori_stroke.xml').filter(
    (b) =>
      attr(b, 'propertyName') === 'strokeAlpha' &&
      attr(b, 'valueFrom') === '1' &&
      attr(b, 'valueTo') === '1'
  );
  check('a hold animator restores the outline’s visibility during the intro', holds.length === 1);
}

// ===========================================================================
// 4. It never freezes: an idle loop starts exactly where the intro ends
// ===========================================================================
console.log('\n[native splash idle loop]');

check('there is an infinitely repeating idle animation', looping.length >= 2, `${looping.length} looping animators`);
check(
  'the idle loop begins exactly where the intro ends — no jump at the seam',
  looping.every(({ block }) => numeric(block, 'startOffset') === introEnd),
  looping.map(({ file, block }) => `${file}@${numeric(block, 'startOffset')}`).join(' ')
);
check(
  'the idle loop runs on both the fill and the group, so the pulse reads as one motion',
  looping.some(({ file }) => file.includes('miori_fill')) &&
    looping.filter(({ file }) => file.includes('miori_scale')).length === 2
);
check(
  'every looping animator is a reverse loop, so the pulse is seamless rather than a sawtooth',
  looping.every(({ block }) => attr(block, 'repeatMode') === 'reverse')
);
check(
  'the looping fill never dims so far that the logo reads as off',
  looping.every(({ file, block }) => {
    if (!file.includes('miori_fill')) return true;
    const to = numeric(block, 'valueTo', 1);
    return to >= 0.7 && to <= 0.9;
  })
);

// ===========================================================================
// 5. Expo Go has no say in any of this — and must not have to print a warning
// ===========================================================================
//
// `expo-splash-screen`'s own `setOptions` is a hard no-op in Expo Go and warns on
// every launch ("'Splashscreen.setOptions' cannot be used in Expo Go. To
// customize the splash screen, you can use development builds."). Expo Go draws
// its own splash regardless, so the call is guarded instead — the AVD and the
// exit duration only mean anything in a real build, where the call still runs.
console.log('\n[Expo Go guard]');
{
  const layout = read('app/_layout.tsx');
  const GUARD = /if \(!isRunningInExpoGo\(\)\)\s*\{[\s\S]{0,160}?SplashScreen\.setOptions/;
  check('the splash options call is guarded against Expo Go', GUARD.test(layout));
  check(
    '…and the guard uses the SDK predicate, not a platform guess',
    /import \{[^}]*isRunningInExpoGo[^}]*\} from 'expo'/.test(layout)
  );
  // The predicate must be able to tell the old shape from the new one, or the
  // check above is decoration.
  const UNGUARDED = '\nSplashScreen.setOptions({ duration: SPLASH.nativeExitMs });';
  check('MUTATION: the old unguarded call would FAIL the guard check', !GUARD.test(UNGUARDED));
}

console.log(
  failures
    ? `\n${failures} failed\n`
    : '\nall passed — the splash logo is complete inside Android’s circular mask, finishes before the animation budget, shows the finished mark when the animation is skipped, keeps breathing while a slow device starts, and does not make Expo Go warn about a screen it cannot customise\n'
);
process.exit(failures ? 1 : 0);
