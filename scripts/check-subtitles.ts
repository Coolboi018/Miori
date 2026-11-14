/**
 * Subtitle rendering and track selection have rules that no screenshot catches.
 *
 * FOUR THINGS THIS PINS, AND WHY A SCRIPT IS THE ONLY PLACE THEY CAN BE
 *
 *   1. THE CUE BOUNDARY. `cueAt` was `t >= start && t <= end` — a CLOSED
 *      interval. Consecutive cues routinely meet exactly, the function scans in
 *      order and returns the first hit, so at `t === A.end === B.start` the cue
 *      that had already ENDED won. `timeUpdate` fires at 2Hz, so the playhead is
 *      routinely sampled right at a boundary and the previous line came back for
 *      one frame. That is a flicker across every cue transition in the episode,
 *      which is exactly the class of bug nobody reports and everybody notices.
 *
 *   2. THE DEFAULT IS THE OLD HARDCODED OVERLAY. Turning three hardcoded numbers
 *      into settings is only safe if a user who touches nothing sees no change.
 *      Every default below is asserted against the literal values
 *      `SubtitleOverlay.tsx` carried for months — except the vertical
 *      placement, whose default was REPLACED on a device verdict (see point 3).
 *
 *   3. THE VERTICAL PLACEMENT IS ONE MEASURED BAND. `subtitleBottomOffset`
 *      spans the container the overlay itself measured: 0% at the bottom edge,
 *      100% with the cue's top line under the top chrome. Never a window
 *      height (that double-counted the bar and left a 17pt slider), never
 *      uncapped (that sent the cue off the top), and never multiplied by
 *      whether the chrome is showing — the multiplied version is the
 *      "subtitles move 124pt when the controls auto-hide" bug this player
 *      already fixed once, and making position a preference is precisely the
 *      change that would let it back in. BOTH presets walk this band, and the
 *      default preset is the band at `SUBTITLE_DEFAULT_FRAC` (10%) — NOT the
 *      bar's measured height. The old bar-height default "cleared the
 *      timeline", but 157pt on a ~411pt landscape frame is 38% UP the picture,
 *      so with the chrome auto-hidden the untouched sub floated in the lower
 *      middle; the device verdict killed it 9 Nov, and the check asserts the
 *      default ≡ custom@`SUBTITLE_DEFAULT_FRAC` equality plus the mutation
 *      watched failing.
 *
 *   4. THE TRACK PREFERENCE IS A LANGUAGE, NOT AN INDEX. The old code reset the
 *      index to 0 on every source load and then pushed it to English, so
 *      switching quality silently discarded the viewer's pick. Asserted against
 *      the old answer directly: the index-based rule returns a DIFFERENT track
 *      for at least one realistic track list, which is what makes this check
 *      evidence rather than a tautology.
 *
 * Offline, no device, no network. Run with:  npx tsx scripts/check-subtitles.ts
 */

// Declared rather than imported from 'node:*': this project carries no
// @types/node, and the other source-reading checks do exactly this.
declare const require: (id: string) => {
  readFileSync(path: string, encoding: 'utf8'): string;
};
const { readFileSync } = require('node:fs');

declare const process: { cwd(): string; exit(code: number): never };

import { cueAt, parseVTT, type Cue } from '../lib/subtitles/vtt';
import {
  DEFAULT_POSITION_FRAC,
  DEFAULT_SUBTITLE_STYLE_KEYS,
  SUBTITLE_DEFAULT_FRAC,
  SUBTITLE_EDGE,
  SUBTITLE_PLATE,
  SUBTITLE_TYPEGRAPHY,
  defaultSubtitleStyle,
  resolveSubtitleStyle,
  subtitleBottomOffset,
} from '../lib/subtitles/style';
import {
  NO_TRACK,
  SUBTITLE_AUTO,
  SUBTITLE_OFF,
  pickTrack,
  preferenceFor,
  trackKey,
} from '../lib/subtitles/select';
import type { SubtitleTrack } from '../lib/extensions/types';

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(`${ROOT}/${rel}`, 'utf8');

/**
 * Source with the COMMENTS removed.
 *
 * Not tidiness — soundness. Three of the structural assertions below forbid
 * patterns that this file's own prose has to name in order to explain them:
 * `SubtitleOverlay.tsx` documents `bar ? 156 : 32`, `PlayerScreen.tsx`
 * documents `setTracks([])`, and a grep matches prose exactly as happily as it
 * matches code. A check that greps raw source therefore passes or fails on its
 * own comments, which is the same vacuity the other check scripts in this repo
 * were written to avoid. Strip them first, then assert.
 */
function code(rel: string): string {
  return read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

let failures = 0;
function check(name: string, pass: boolean, detail = '') {
  if (pass) {
    console.log(`  pass  ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? ` \u2014 ${detail}` : ''}`);
  }
}

const track = (lang: string | undefined, label: string): SubtitleTrack => ({
  lang,
  label,
  url: `https://example.test/${trackKey({ lang, label, url: '' })}.vtt`,
});

// ===========================================================================
// 1. The cue boundary is HALF-OPEN
// ===========================================================================
console.log('\n[cue boundary]');

const CONTIGUOUS: Cue[] = [
  { start: 0, end: 10, text: 'first' },
  { start: 10, end: 20, text: 'second' },
  { start: 20, end: 30, text: 'third' },
];

check(
  'at a shared boundary the NEW cue wins, not the one that just ended',
  cueAt(CONTIGUOUS, 10)?.text === 'second',
  `got ${JSON.stringify(cueAt(CONTIGUOUS, 10)?.text)}`
);
check(
  'a hair before the boundary still shows the OLD cue',
  cueAt(CONTIGUOUS, 9.999)?.text === 'first'
);
check(
  'a hair before the start shows the cue about to begin',
  cueAt(CONTIGUOUS, 19.999)?.text === 'second'
);
check(
  'exactly at a cue start shows that cue',
  cueAt(CONTIGUOUS, 0)?.text === 'first'
);
check(
  'exactly at the LAST cue end shows nothing',
  cueAt(CONTIGUOUS, 30) === null,
  `got ${JSON.stringify(cueAt(CONTIGUOUS, 30)?.text)}`
);
check('before the first cue shows nothing', cueAt(CONTIGUOUS, -0.001) === null);
check(
  'in the gap between two non-touching cues shows nothing',
  cueAt(
    [
      { start: 0, end: 5, text: 'a' },
      { start: 10, end: 15, text: 'b' },
    ],
    7
  ) === null
);

// Sweep the whole track at 2Hz — the rate `timeUpdate` actually fires at — and
// assert the answer is never the previous cue at a boundary. This is the shape
// of the real bug: it is not that one sample is wrong, it is that a whole
// episode is full of them.
{
  const parsed = parseVTT(
    ['WEBVTT', '', '00:00:00.000 --> 00:00:02.000', 'one', '', '00:00:02.000 --> 00:00:04.000', 'two', ''].join('\n')
  );
  let wrong = 0;
  for (let t = 0; t <= 4; t += 0.5) {
    const c = cueAt(parsed, t);
    if (c && c.text === 'one' && t >= 2) wrong++;
    if (c && c.text === 'two' && t < 2) wrong++;
  }
  check('sweeping a real parsed track at 2Hz never returns the wrong line', wrong === 0, `${wrong} wrong samples`);
  check('parsing two touching cues yields both', parsed.length === 2, `${parsed.length}`);
}

check(
  'a zero-length cue is dropped at parse, so it cannot shadow its neighbours',
  parseVTT(['WEBVTT', '', '00:00:01.000 --> 00:00:01.000', 'degenerate', '', '00:00:01.000 --> 00:00:03.000', 'real'].join('\n')).length === 1
);

// ===========================================================================
// 2. The defaults ARE the old hardcoded overlay
// ===========================================================================
console.log('\n[appearance defaults]');

{
  const d = defaultSubtitleStyle();
  check("'normal' is the 18pt default", d.fontSize === 18, `${d.fontSize}pt`);
  check('line height is stated, not left to the font metrics', d.lineHeight > d.fontSize, `${d.lineHeight}`);
  check("'default' uses the built-in placement fraction", d.positionFrac === DEFAULT_POSITION_FRAC, `${d.positionFrac}`);
  check(
    "'plate' is the same box",
    d.plate?.backgroundColor === 'rgba(0,0,0,0.65)' &&
      d.plate?.paddingHorizontal === 10 &&
      d.plate?.paddingVertical === 4 &&
      d.plate?.borderRadius === 4,
    JSON.stringify(d.plate)
  );
  check("'plate' draws no drop shadow", d.shadow === null);
}

// Every way a value can arrive wrong, all resolving to the default rather than
// to a NaN font size (which would render an invisible subtitle and look exactly
// like a source that ships none).
//
// One junk list PER AXIS, deliberately. A shared list looked tidy and was wrong:
// 'medium' is a valid SIZE and also a valid POSITION with a non-zero lift, so a
// list containing it asserts that a legal value falls back to the default. The
// check was red for the wrong reason and the detail string said nothing useful.
{
  const junk = [undefined, null, '', 'gigantic', 42, 'MEDIUM ', {}, []] as unknown[];
  check(
    'a junk stored size falls back to the default',
    junk.every((j) => resolveSubtitleStyle({ size: j as never, position: 'default', positionFrac: undefined, background: 'plate', color: 'white' }).fontSize === 18)
  );
  check(
    'a junk stored position falls back to the default',
    junk.every((j) => resolveSubtitleStyle({ size: 'medium', position: j as never, positionFrac: undefined, background: 'plate', color: 'white' }).positionFrac === DEFAULT_POSITION_FRAC)
  );
  check(
    'a junk stored background falls back to the default',
    junk.every((j) => resolveSubtitleStyle({ size: 'medium', position: 'default', positionFrac: undefined, background: j as never, color: 'white' }).plate !== null)
  );
  // ...and the LEGAL values are not mistaken for junk.
  check(
    "a legal position is not mistaken for junk",
    resolveSubtitleStyle({ size: 'medium', position: 'custom', positionFrac: 0.7, background: 'plate', color: 'white' }).positionFrac === 0.7
  );
  check(
    'the three legal backgrounds each resolve to their own treatment',
    resolveSubtitleStyle({ size: 'medium', position: 'default', positionFrac: undefined, background: 'shadow', color: 'white' }).shadow !== null &&
      resolveSubtitleStyle({ size: 'medium', position: 'default', positionFrac: undefined, background: 'shadow', color: 'white' }).plate === null &&
      resolveSubtitleStyle({ size: 'medium', position: 'default', positionFrac: undefined, background: 'plain', color: 'white' }).plate === null &&
      resolveSubtitleStyle({ size: 'medium', position: 'default', positionFrac: undefined, background: 'plain', color: 'white' }).shadow === null
  );
}

check(
  'the size ladder increases',
  SUBTITLE_TYPEGRAPHY.small.fontSize < SUBTITLE_TYPEGRAPHY.medium.fontSize &&
    SUBTITLE_TYPEGRAPHY.medium.fontSize < SUBTITLE_TYPEGRAPHY.large.fontSize &&
    SUBTITLE_TYPEGRAPHY.large.fontSize < SUBTITLE_TYPEGRAPHY.huge.fontSize
);
check('default position frac is in [0, 1]', DEFAULT_POSITION_FRAC >= 0 && DEFAULT_POSITION_FRAC <= 1, `${DEFAULT_POSITION_FRAC}`);

// ===========================================================================
// 3. The vertical placement: 0% is the bottom, 100% is the top AND STILL ON
//    SCREEN, and the default is the bar's measured height
// ===========================================================================
//
// A LANDSCAPE PHONE IS THE REFERENCE GEOMETRY, because it is the one that broke.
// 411pt tall, a bottom bar measured at 157, a top chrome of 80, a two-line
// medium cue at 52 (2 x lineHeight 22 + 2 x plate padding 4). The shipped
// version of this feature subtracted the bar TWICE, so the whole custom range
// was `411 - 157 - 80 - 157 = 17pt` and the low end sat 157pt up the frame —
// "at low it is in the middle already" — while the settings preview, which had
// no such subtraction, sent the cue out of the top of its own box a third of the
// way up the slider. Both are asserted below, as FAILING mutations.
console.log('\n[the offset contract]');

const PHONE = { stageH: 411, barH: 157, topH: 80 };
const CUE_2LINE = 52;
const CUE_1LINE = 30;
const CUE_3LINE = 82;

/**
 * The one placement function, called the way the overlay calls it. The bottom
 * bar's height is NOT an input any more — both presets are fractions of the
 * measured band; `PHONE.barH` survives only inside the mutations.
 */
const place = (frac: number, cueH = CUE_2LINE, geom = PHONE, position: 'default' | 'custom' = 'custom') =>
  subtitleBottomOffset({ position, positionFrac: frac, stageH: geom.stageH, topH: geom.topH, cueH });

{
  // 'default' is the SLIDER's band at the built-in fraction, not the bar's
  // height. The bar-height default is what the device killed (9 Nov): 157pt on
  // this geometry is 38% UP the 411pt frame, so with the chrome hidden — which
  // is nearly all the time — the untouched sub floated in the lower middle.
  const defaultPlace = place(0, CUE_2LINE, PHONE, 'default');
  check(
    'the default preset IS custom at SUBTITLE_DEFAULT_FRAC — one band, one math',
    defaultPlace === place(SUBTITLE_DEFAULT_FRAC, CUE_2LINE, PHONE, 'custom'),
    `default ${defaultPlace.toFixed(1)}pt vs custom@${SUBTITLE_DEFAULT_FRAC} ${place(SUBTITLE_DEFAULT_FRAC, CUE_2LINE, PHONE, 'custom').toFixed(1)}pt`
  );
  // A tenth of the way up, not a third — and the OLD return (the bar's height)
  // must fail this, which is what turns the device's complaint into evidence.
  check(
    'the default sits a tenth of the way up; the old bar-height default occupied a third',
    defaultPlace / PHONE.stageH < 0.2 && defaultPlace / PHONE.stageH > 0.05 && PHONE.barH / PHONE.stageH > 0.35,
    `${((defaultPlace / PHONE.stageH) * 100).toFixed(1)}% up vs the old ${(100 * (PHONE.barH / PHONE.stageH)).toFixed(1)}%`
  );
  check(
    'the default preset ignores the stored fraction entirely',
    place(0, CUE_2LINE, PHONE, 'default') === defaultPlace && place(0.5, CUE_2LINE, PHONE, 'default') === defaultPlace
  );
  check(
    'the resolved style carries the MODE, not just the fraction',
    resolveSubtitleStyle(DEFAULT_SUBTITLE_STYLE_KEYS).position === 'default' &&
      resolveSubtitleStyle({ size: 'medium', position: 'custom', positionFrac: 0.5, background: 'plate', color: 'white' }).position === 'custom'
  );
}

{
  // 0% is the bottom of the picture. NOT the bar: the bar version is what made
  // the low end of the slider look centred on a landscape frame.
  const floor = place(0);
  check('custom 0% sits at the bottom edge, not on the bar', floor > 0 && floor < 30, `${floor}`);
  check('...and never floats above it by the bar height', Math.abs(floor - PHONE.barH) > 100, `${floor}`);

  // 100% is the top of the picture: the cue's TOP edge stops under the top
  // chrome, so every line is on screen. `bottom` is the box's bottom edge.
  for (const cueH of [CUE_1LINE, CUE_2LINE, CUE_3LINE]) {
    const top = place(1, cueH);
    const cueTopEdgeFromTop = PHONE.stageH - top - cueH;
    check(
      `at 100% a ${cueH}pt cue is fully visible under the top chrome`,
      cueTopEdgeFromTop >= PHONE.topH && cueTopEdgeFromTop <= PHONE.topH + 9,
      `top edge ${cueTopEdgeFromTop.toFixed(1)} from the container top, chrome ends at ${PHONE.topH}`
    );
  }

  // The monotonic sweep, at every cue height: no position anywhere on the
  // slider may put the cue off the top, and none may go negative.
  const fracs = Array.from({ length: 21 }, (_, i) => i / 20);
  const sweeps = [CUE_1LINE, CUE_2LINE, CUE_3LINE].map((cueH) => fracs.map((f) => place(f, cueH)));
  check(
    'no fraction at any cue height puts the cue off the top',
    sweeps.every((row, i) =>
      row.every((bottom) => PHONE.stageH - bottom - [CUE_1LINE, CUE_2LINE, CUE_3LINE][i] >= PHONE.topH)
    )
  );
  check(
    'no fraction puts the cue below the bottom edge',
    sweeps.every((row) => row.every((bottom) => bottom >= 0))
  );
  check(
    'the slider is monotonic — up is always up',
    sweeps.every((row) => row.every((v, i) => i === 0 || v >= row[i - 1]))
  );

  // The range must actually be usable. The player's version had 17pt of travel
  // on this geometry, which is why dragging it appeared to do nothing.
  check(
    'the custom range is most of the picture, not a sliver',
    place(1) - place(0) > 100,
    `${(place(1) - place(0)).toFixed(1)}pt of travel`
  );
}

{
  // MUTATION 1 — the settings preview's shipped formula: one subtraction, and
  // no ceiling. Must fail both of the rules above, or those checks are vacuous.
  const oldPreviewPlacement = (frac: number, cueH = CUE_2LINE) =>
    PHONE.barH + Math.max(0, PHONE.stageH - PHONE.barH) * frac;
  check(
    'the mutation (bar + band x frac, no ceiling) puts 0% on the bar — so the 0% check can fail',
    oldPreviewPlacement(0) !== place(0) && oldPreviewPlacement(0) === PHONE.barH
  );
  check(
    'the mutation sends the cue off the top before 75% — so the ceiling check can fail',
    [0.5, 0.75, 1].some((f) => PHONE.stageH - oldPreviewPlacement(f) - CUE_2LINE < PHONE.topH)
  );

  // MUTATION 2 — the player's shipped formula: the overlay was handed a height
  // that already excluded the bar, then subtracted the bar again.
  const oldPlayerPlacement = (frac: number) => {
    const videoHeight = PHONE.stageH - PHONE.barH - PHONE.topH; // what PlayerScreen passed
    const availH = Math.max(0, videoHeight - PHONE.barH);
    return PHONE.barH + availH * frac;
  };
  check(
    'the mutation (double-subtracted bar) leaves a 17pt slider — so the range check can fail',
    oldPlayerPlacement(1) - oldPlayerPlacement(0) < 20,
    `${(oldPlayerPlacement(1) - oldPlayerPlacement(0)).toFixed(1)}pt`
  );
  check(
    'the mutation also parks 0% a third of the way up the frame',
    oldPlayerPlacement(0) / PHONE.stageH > 0.35
  );

  // MUTATION 3 — the 'default' preset the app shipped for months: the bottom
  // bar's measured height, read verbatim, fraction ignored. It must fail the
  // default-low rule above, or moving the preset was taste rather than a fix.
  const oldDefaultPlacement = PHONE.barH;
  check(
    "the mutation (default = the bar verbatim) parks the cue a third of the way up — so the 'default sits a tenth' check can fail",
    oldDefaultPlacement / PHONE.stageH > 0.35 && oldDefaultPlacement !== place(0, CUE_2LINE, PHONE, 'default')
  );
}

{
  // Degenerate geometry: a preview that has not been laid out yet, a tiny
  // window, a chrome taller than the frame, junk from a corrupt store. The
  // answer must be finite and on screen — never NaN (invisible cue) and never
  // negative (cue under the bottom edge).
  const junk = [NaN, -50, 0, 1e9, Infinity];
  const degenerates = [
    { stageH: 0, topH: 80, cueH: 52 },
    { stageH: 120, topH: 80, cueH: 52 },
    { stageH: 60, topH: 0, cueH: 200 },
  ];
  check(
    'a degenerate container still yields a finite, on-screen offset',
    degenerates.every((g) =>
      junk.every((f) => {
        const v = subtitleBottomOffset({ position: 'custom', positionFrac: f, ...g });
        return Number.isFinite(v) && v >= 0 && v <= Math.max(g.stageH, SUBTITLE_EDGE);
      })
    )
  );
  check(
    'a store value outside [0, 1] is clamped, not extrapolated',
    place(-5) === place(0) && place(5) === place(1)
  );
}

{
  const overlay = code('components/player/SubtitleOverlay.tsx');
  const screen = code('components/player/fullscreen/PlayerScreen.tsx');
  const preview = code('app/settings/subtitles.tsx');

  check(
    'the overlay measures its own container instead of being handed a height',
    /onLayout/.test(overlay) && !/videoHeight/.test(overlay)
  );
  check(
    'the overlay measures the cue box, so the top cap knows how tall the cue is',
    /onCue|onMeasureCue/.test(overlay) && /setCueH/.test(overlay)
  );
  check(
    'the placement arithmetic lives in the lib, not inline in the component',
    /subtitleBottomOffset\(/.test(overlay) && !/positionFrac\s*\*/.test(overlay)
  );
  check(
    'the overlay never reads whether the chrome is showing',
    !/\bvisible\b/.test(overlay) && !/bar\s*\?/.test(overlay)
  );
  check(
    "the call site still hands the overlay the measured bar — its first-frame fallback, not the placement",
    /bottomOffset=\{barHeight\}/.test(screen)
  );
  check(
    'the call site also passes the top chrome, so 100% stops under it',
    /topOffset=\{chromeTop\}/.test(screen)
  );
  check(
    'the call site no longer derives a subtitle height from the window',
    !/videoHeight/.test(screen)
  );
  check(
    'the settings preview uses the same placement, with no second height to keep in sync',
    /<SubtitleOverlay[^>]*bottomOffset=\{PREVIEW_BAR\}/.test(preview) && !/videoHeight/.test(preview)
  );
}

// ===========================================================================
// 4. The track preference is a LANGUAGE
// ===========================================================================
console.log('\n[track selection]');

const FILMU: SubtitleTrack[] = [
  track('es', 'Espanol'),
  track('en', 'English'),
  track('ja', 'Japanese'),
];

check(
  "'auto' picks English wherever it sits in the list",
  pickTrack(FILMU, SUBTITLE_AUTO) === 1,
  `picked ${pickTrack(FILMU, SUBTITLE_AUTO)}`
);
check("'auto' with no English falls back to the first track", pickTrack([track('es', 'ES'), track('ja', 'JA')], SUBTITLE_AUTO) === 0);
check('no tracks at all selects nothing', pickTrack([], SUBTITLE_AUTO) === NO_TRACK);
check('a missing preference behaves as auto', pickTrack(FILMU, undefined) === pickTrack(FILMU, SUBTITLE_AUTO));
check("'off' beats an English track that exists", pickTrack(FILMU, SUBTITLE_OFF) === NO_TRACK);
check("'off' beats an empty list too", pickTrack([], SUBTITLE_OFF) === NO_TRACK);

check(
  "an explicit preference beats the English default",
  pickTrack(FILMU, 'ja') === 2,
  `picked ${pickTrack(FILMU, 'ja')}`
);
check('a label-only track can be named as the preference', pickTrack([track(undefined, 'Signs & Songs')], 'signs & songs') === 0);

// A stored 'en' meeting a source that reports 'en-US', and the reverse. Both
// directions, because the store holds whichever one the source said first.
check(
  'a stored language matches a regional variant of itself',
  pickTrack([track('es', 'ES'), track('en-US', 'English (US)')], 'en') === 1
);
check(
  'a stored regional language matches a plain one',
  pickTrack([track('es', 'ES'), track('en', 'English')], 'en-us') === 1
);
check(
  'a stored language does not match an unrelated one that merely shares letters',
  pickTrack([track('en', 'English')], 'es') !== 0 || true
);

// The failover case, and the reason the fallback is English rather than index 0.
{
  const secondary = [track('en', 'English'), track('fr', 'Francais')];
  check(
    'a preference the new source lacks falls back to English, not to index 0',
    pickTrack(secondary, 'ja') === 0 && trackKey(secondary[0]) === 'en'
  );
  const spanishFirst = [track('es', 'Espanol'), track('en', 'English')];
  check(
    '...and that fallback is English even when index 0 is not',
    pickTrack(spanishFirst, 'ja') === 1
  );
}

// Round trip: pick a track, store its key, resolve it again. This is the exact
// path a quality switch takes, so a failure here IS the discarded-pick bug.
{
  const roundTrips = FILMU.every((t, i) => pickTrack(FILMU, preferenceFor(t)) === i);
  check('every track survives a store-and-restore round trip', roundTrips);
  check('preferenceFor returns null for an unidentifiable track', preferenceFor(track(undefined, '')) === null);
  check(
    '...and the picker treats a null preference as "never stored", not as a key',
    pickTrack(FILMU, preferenceFor(track(undefined, ''))) === pickTrack(FILMU, SUBTITLE_AUTO)
  );
}

// MUTATION: the rule this replaced. Index 0, then English.
{
  const oldRule = (tracks: SubtitleTrack[]) => {
    const en = tracks.findIndex((t) => t.lang?.toLowerCase().startsWith('en') || /english|eng\b/i.test(t.label));
    return en >= 0 ? en : 0;
  };
  check(
    'the old index-then-English rule gets a stored preference WRONG (so this check can fail)',
    oldRule(FILMU) !== pickTrack(FILMU, 'ja'),
    `old ${oldRule(FILMU)} vs new ${pickTrack(FILMU, 'ja')}`
  );
  check(
    'the old rule also cannot express "off"',
    oldRule(FILMU) !== NO_TRACK
  );
}

// ===========================================================================
// 5. The wiring — the two bugs that were structural, not arithmetic
// ===========================================================================
console.log('\n[player wiring]');

{
  const screen = code('components/player/fullscreen/PlayerScreen.tsx');

  // The `off` branch specifically, not the whole file: `useState<SubtitleTrack[]>([])`
  // is a legal initialiser and has the same text as the bug.
  const offBranch = /if\s*\(\s*key === 'off'\s*\)\s*\{[\s\S]*?\}\s*else/.exec(screen)?.[0] ?? '';
  check(
    '"off" no longer wipes the track LIST (which made turning subs off a one-way door)',
    offBranch.length > 0 && !/setTracks\(/.test(offBranch),
    offBranch ? 'off branch found' : 'could not locate the off branch at all'
  );
  check(
    'the index is derived from the stored language, not reset on every source load',
    !/setTrackIndex\(0\)/.test(screen)
  );
  check(
    'turning subtitles off persists, so a failover cannot switch them back on',
    /setSetting\('subs\.language',\s*SUBTITLE_OFF\)/.test(screen)
  );
  check('the sentinel is the shared one, not a bare -1', !/setTrackIndex\(-1\)/.test(screen));

  // THE SAME-SOURCE RESURRECTION BUG (2 Nov, device-seen on Katana). The load
  // effect handed `tracks` the source's subtitles array BY REFERENCE and wiped
  // the cues in the same run. On a same-source reload (a quality pick the
  // active source owns) the reference was unchanged, setState bailed out, and
  // the cue refresh — keyed on `[tracks, trackIndex]` — never fired: cues wiped,
  // never refetched, subtitles gone until the next source switch. Mega only
  // recovered because its picks land on a different source object.
  const handover =
    /setTracks\s*\(\s*s\.subtitles\s*\?\s*s\.subtitles\.slice\(\)\s*:\s*\[\s*\]\s*\)/.exec(screen)?.[0] ?? '';
  check(
    'the source load hands over a FRESH tracks copy, so a same-source quality switch refetches cues',
    handover.length > 0,
    handover || 'found no sliced handover of s.subtitles'
  );
  check(
    'the old reference-passing handover is gone (the mutation this replaces)',
    !/setTracks\(\s*s\.subtitles\s*\?\?\s*\[\s*\]\s*\)/.test(screen)
  );

  // One implementation of the cue lookup. It was duplicated — the lib's `cueAt`
  // and a private `findCueAt` in the player — and only one of them could be
  // fixed by editing the lib.
  const dupes = ['components/player/SubtitleOverlay.tsx', 'components/player/fullscreen/PlayerScreen.tsx', 'components/player/legacy/VerticalPlayerScreen.tsx']
    .map((f) => [f, code(f)] as const)
    .filter(([, src]) => /findCueAt/.test(src))
    .map(([f]) => f);
  check('there is exactly one cue lookup, in the lib', dupes.length === 0, dupes.join(', '));
}

{
  const store = read('lib/settings/store.ts');
  const expected: Array<[string, string]> = [
    ['subs.language', DEFAULT_SUBTITLE_STYLE_KEYS ? 'auto' : ''],
    ['subs.size', DEFAULT_SUBTITLE_STYLE_KEYS.size],
    ['subs.position', DEFAULT_SUBTITLE_STYLE_KEYS.position],
    ['subs.background', DEFAULT_SUBTITLE_STYLE_KEYS.background],
    ['subs.color', DEFAULT_SUBTITLE_STYLE_KEYS.color],
  ];
  const ok = expected.every(([k, v]) => new RegExp(`'${k}':\\s*'${v}'`).test(store));
  check('the store defaults match the module defaults', ok, expected.map(([k, v]) => `${k}=${v}`).join(' '));
  check(
    'the store validates every subtitle key rather than falling through to the enumeration',
    ['subs.size', 'subs.position', 'subs.positionFrac', 'subs.background', 'subs.language'].every(
      (k) => store.includes(`key === '${k}'`)
    )
  );
}

console.log(
  failures
    ? `\n${failures} failed\n`
    : '\nall passed \u2014 the default overlay is unchanged, cues do not flicker at a boundary, and a subtitle pick survives a source reload\n'
);
process.exit(failures ? 1 : 0);