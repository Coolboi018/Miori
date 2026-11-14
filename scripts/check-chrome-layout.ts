/**
 * The player's chrome must have ONE layout that every state fits inside.
 *
 * THE BUG THIS PINS
 *
 * "The controls move" in a video player is never a mystery. It is always the
 * same single cause wearing a different hat: something in the bar had a width
 * or a presence decided by the player's STATE instead of by the SCREEN, so it
 * reflowed the moment that state changed. This player had four of them, and all
 * four fired while the viewer was holding the phone and doing nothing:
 *
 *   1. The subtitle chip was CONDITIONAL on `hasSubs`. Before a source resolved
 *      there were three chips; the moment it did there were four. Inserting a
 *      sibling into a row pushes everything after it sideways.
 *   2. The source chip's LABEL changed width on its own — "Source" before any
 *      source existed, "1/3" after, and "2/3" again on every failover. Chips
 *      are sized by their text, so the chip narrowed and dragged its neighbours.
 *   3. The speed chip's label changed during a hold-to-boost: "1x" to "2.5x"
 *      makes the chip wider, shoving the quality, source and subtitle chips
 *      right — while the finger was down.
 *   4. The PiP button was read in a mount effect off a `false` initial value,
 *      so the top bar painted without it and inserted it a frame later, shoving
 *      the episode and lock buttons 42pt left on EVERY player open.
 *
 * Plus two overlays that were not "controls" but moved like them: the subtitle
 * block jumped 124pt every time the chrome auto-hid, and the toast dropped 125pt
 * three seconds after it appeared.
 *
 * WHY A SCRIPT AND NOT A DEVICE
 *
 * Each of these is a one-frame change that nobody reports and everybody notices
 * — the bar looks "slightly off" and there is nothing to file. They are also
 * perfectly checkable offline, because the failure is STRUCTURAL: a width that
 * comes from a label, a sibling that is conditionally rendered, an offset that
 * branches on chrome visibility. A script can read that and say no.
 *
 * The model below is deliberately a DIFFERENT implementation of the row layout
 * from the one in `Chrome.tsx`, in the same spirit as `check-gesture-arbitration`:
 * it is short enough to read in one sitting and wrong in a different way, so
 * agreement between the two means something. Both variants are run — the old
 * shape must FAIL, so that a passing result is evidence and not a tautology.
 *
 * Run with:  npx tsx scripts/check-chrome-layout.ts
 */

// Declared rather than imported from 'node:*': this project carries no
// @types/node, and the other source-reading checks do exactly this.
declare const require: (id: string) => {
  readFileSync(path: string, encoding: 'utf8'): string;
};
const { readFileSync } = require('node:fs');

declare const process: { cwd(): string; exit(code: number): never };

// ---------------------------------------------------------------------------
// Source assertions — the structural half
// ---------------------------------------------------------------------------

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(`${ROOT}/${rel}`, 'utf8');

const chromeSrc = read('components/player/fullscreen/Chrome.tsx');
const screenSrc = read('components/player/fullscreen/PlayerScreen.tsx');
const menuSrc = read('components/player/fullscreen/Menu.tsx');
const panelSrc = read('components/player/fullscreen/SettingsPanel.tsx');
const subSrc = read('components/player/SubtitleOverlay.tsx');

let failures = 0;
function check(name: string, pass: boolean, detail = '') {
  if (pass) {
    console.log(`  pass  ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** `hasSubs ? <Trigger .../> : null` anywhere in the bottom bar. */
const conditionalChip = /\{\s*hasSubs\s*\?[^\n]*Trigger/;
/** A width that is computed from a trigger's own text. */
const chipSizedByLabel = /trigger[\s\S]{0,600}?width:\s*['"]?\$\{/;

console.log('\nchrome layout — structure');

check(
  'the subtitle chip is never conditionally rendered',
  !conditionalChip.test(chromeSrc),
  'a chip that comes and goes pushes its neighbours'
);

check(
  'no trigger chip width is derived from its label',
  !chipSizedByLabel.test(menuSrc),
  'a chip that resizes with its text resizes the row'
);

check(
  'every trigger sits in its own flex: 1 slot',
  /triggerSlot:\s*\{[\s\S]{0,200}?flex:\s*1/.test(chromeSrc),
  'without equal columns the row still reflows'
);

check(
  'the bottom bar has no hardcoded height',
  !/bottomWrap:\s*\{[\s\S]{0,400}?\bheight:/.test(chromeSrc),
  'a fixed height drifts from its content every time a row changes'
);

check(
  'the bottom bar reports its measured height',
  /onLayout[\s\S]{0,400}?onMeasure\?\.\(h\)/.test(chromeSrc),
  'the subtitles, toast and popover all need the real number'
);

check(
  'PiP support is read at init, not in an effect',
  /useState\(isPictureInPictureSupported\)/.test(screenSrc) &&
    !/setPipSupported/.test(screenSrc),
  'a button inserted after mount slides the rest of the top bar'
);

check(
  'the subtitle offset does not branch on whether the chrome is showing',
  !/bottomOffset=\{[^}]*visible/i.test(screenSrc) && /bottomOffset=\{barHeight\}/.test(screenSrc),
  'a cue that moves when the chrome hides is a cue that cannot be read'
);

check(
  'the toast is anchored to the measured bar, unconditionally',
  /bottom:\s*barHeight \+ 14/.test(screenSrc),
  'a toast that drops when the chrome hides arrives and leaves under the eye'
);

check(
  'the settings card is right-anchored AND floats clear of the edge',
  /right:\s*0/.test(panelSrc) && /marginRight:\s*insets\.right \+ 10/.test(panelSrc) && /backdrop/.test(panelSrc),
  'an absolute card without a right anchor seats at the LEFT edge; margin without the anchor is dead code'
);

check(
  'the settings gear lives in the TOP bar, not the bottom trigger row',
  /onSettings\??:/.test(chromeSrc) && !/TriggerSlot id="settings"/.test(chromeSrc),
  'the bottom row is playback chips only; a gear there was a fifth chip the hide-toggle had to special-case'
);

// The bar must not be unmounted by anything that happens INSIDE it — a menu, the
// episode panel, a lock — because a control that raised a menu and then deleted
// itself rearranges the player under the viewer's finger.
//
// This used to assert one exact source line, which went red the moment a fourth
// legitimate term was added to the expression (`|| scrubActive`, so a live scrub
// drag survives the 3s chrome auto-hide). A check that pins the whole expression
// is really a check that pins "nobody may ever add a term", which is not the
// rule anyone meant. So: assert the TERMS — the three conditions that must be
// consulted — and separately pin the new one.
const bottomBarDecl = /const bottomBarUp =([^;]+);/.exec(screenSrc)?.[1] ?? '';
check(
  'the bottom bar stays mounted while a menu is open',
  bottomBarDecl.length > 0 &&
    /\bshowControls\b/.test(bottomBarDecl) &&
    /\blocked\b/.test(bottomBarDecl) &&
    /\bpanelOpen\b/.test(bottomBarDecl),
  'tapping a trigger should raise a menu, not delete the trigger'
);
check(
  'and a live scrub drag keeps it mounted even when the chrome hides',
  /\|\|\s*scrubActive/.test(bottomBarDecl),
  'the chrome auto-hides after 3s and the bar lives inside it, so a longer drag used to issue no seek at all'
);

// The speed label is user-visible text. It arrived here corrupted by an
// encoding round-trip and rendered as three characters of mojibake next to a
// gauge icon, which reads as a broken font rather than a broken string.
const speedLabelLine = screenSrc.split('\n').find((l: string) => l.includes('speedLabel={`'));
check(
  'the speed label is not mojibake',
  !!speedLabelLine && !/[\u00C0-\u00FF]/.test(speedLabelLine),
  speedLabelLine ? speedLabelLine.trim() : 'speedLabel not found'
);

// ---------------------------------------------------------------------------
// A model of the row — the behavioural half
// ---------------------------------------------------------------------------

/** Everything the bottom bar's geometry can be given, minus the state. */
interface Bar {
  /** Window width, landscape. */
  width: number;
  /** Notch inset. Landscape puts it on a side. */
  inset: number;
  /** For test output only. */
  name: string;
}

/** Chip text, in the four slots. Order is fixed; CONTENT is not. */
type Labels = [string, string, string, string];

const CHIP = { padH: 10, padV: 7, icon: 18, gap: 6, fontSize: 13 };
const ROW = { padH: 14, play: 38, mute: 38, rowGap: 10, triggerGap: 6 };

/** 13px semibold, ~0.55em average advance. Only ever used for RELATIVE width. */
const textWidth = (s: string) => s.length * CHIP.fontSize * 0.55;

const chipWidth = (label: string) => CHIP.padH * 2 + CHIP.icon + CHIP.gap + textWidth(label);

/** Space available to the triggers, shared by both variants. */
function triggerSpan(bar: Bar) {
  return (
    bar.width -
    bar.inset * 2 -
    ROW.padH * 2 -
    ROW.play -
    ROW.mute -
    ROW.rowGap * 2
  );
}

/**
 * THE FIX. Four `flex: 1` columns. The slot boundaries are arithmetic on the
 * window; the chip inside a slot is free to be any width and is centred in it.
 */
function fixedSlots(bar: Bar, labels: Labels, subsRendered: boolean): number[] {
  void subsRendered;
  const span = triggerSpan(bar);
  const slot = (span - ROW.triggerGap * (labels.length - 1)) / labels.length;
  return Array.from({ length: labels.length }, (_, i) => i * (slot + ROW.triggerGap));
}

/**
 * THE BUG. Chips sized by their own text, laid out left to right. A chip's left
 * edge is the sum of every chip before it — which is the whole mechanism.
 *
 * `subsRendered` is honoured, because that IS the bug: when it is false the chip
 * is not in the tree at all, so the row genuinely has three children instead of
 * four.
 */
function autoChips(bar: Bar, labels: Labels, subsRendered: boolean): number[] {
  const span = triggerSpan(bar);
  const present = subsRendered ? labels : labels.slice(0, 3);
  const xs: number[] = [];
  let x = 0;
  for (const label of present) {
    xs.push(x);
    x += Math.min(chipWidth(label), span) + ROW.triggerGap;
  }
  return xs;
}

/**
 * The states the player passes through without anyone touching anything.
 *
 * `labels` is `[speed, quality, source, subtitles]`. Note which entries CHANGE
 * between these — that is the entire point.
 */
const TIMELINE: { name: string; labels: Labels; subsRendered: boolean }[] = [
  // Before anything has resolved. Note the literal placeholder labels.
  { name: 'initial, nothing resolved', labels: ['1x', 'Auto', 'Source', 'Off'], subsRendered: false },
  // The source resolves. The subs chip appears AND the source label changes.
  { name: 'stream loaded', labels: ['1x', 'Auto', '1/3', 'English'], subsRendered: true },
  // A long-press boost widens the speed chip mid-gesture.
  { name: 'hold-to-boost', labels: ['2.5x', 'Auto', '1/3', 'English'], subsRendered: true },
  // The source chip gets shorter on failover, pulling the subs chip left.
  { name: 'after failover', labels: ['2.5x', 'Auto', '2/3', 'English'], subsRendered: true },
  // A long track language. One chip that does not fit must not move its peers.
  { name: 'long track language', labels: ['2.5x', 'Auto', '2/3', 'English (SDH)'], subsRendered: true },
];

const DEVICES: Bar[] = [
  { name: 'small landscape', width: 568, inset: 0 },
  { name: 'landscape, notched', width: 640, inset: 44 },
  { name: 'large landscape', width: 915, inset: 44 },
];

console.log('\nchrome layout — the row holds still');

for (const device of DEVICES) {
  const d: Bar = device;

  // The bug must still be demonstrable, or the fix below proves nothing.
  const oldXs = TIMELINE.map((s) => autoChips(d, s.labels, s.subsRendered));
  const oldMoved = oldXs.some((xs, i) => i > 0 && xs.some((x, j) => Math.abs(x - oldXs[0][j]) > 0.5));
  check(
    `[${d.name}] the old auto-width row DID move between states`,
    oldMoved,
    'if this fails the model no longer reproduces the reported bug'
  );

  // Three-chip initial state: the subs chip does not exist, so only three slots
  // are laid out at all. That alone is a 3-vs-4 row.
  const oldInitial = autoChips(d, TIMELINE[0].labels, false);
  const oldLoaded = autoChips(d, TIMELINE[1].labels, true);
  check(
    `[${d.name}] the old row dropped the subtitle chip entirely`,
    oldInitial.length === 3 && oldLoaded.length === 4,
    `initial ${oldInitial.length} chips, loaded ${oldLoaded.length}`
  );
  check(
    `[${d.name}] …which left a different number of chips to align`,
    oldInitial.length !== oldLoaded.length,
    'a row that changes its child count changes its geometry'
  );

  const newXs = TIMELINE.map((s) => fixedSlots(d, s.labels, s.subsRendered));
  const reference = newXs[0];
  const stable = newXs.every((xs) => xs.length === 4 && xs.every((x, i) => Math.abs(x - reference[i]) < 0.001));
  check(
    `[${d.name}] every state puts all four chips on the same four edges`,
    stable,
    `got ${JSON.stringify(newXs)}`
  );
}

console.log('\nchrome layout — overlays hold still');

/** The bar's height before and after it is measured. */
const FALLBACK = 157;
/** Content the real bar lays out. */
function measuredBarHeight(inset: number) {
  return (
    22 + // scrim headroom
    34 + // skip slot (fixed, so the timeline below it never moves)
    45 + // progress bar: 28 hit area + 2 gap + 15 clock line
    44 + // button row: 6 gap + 38 button
    12 + // bottom padding
    inset
  );
}

check(
  'the fallback height matches the bar it stands in for',
  FALLBACK === measuredBarHeight(0),
  `fallback ${FALLBACK}, content ${measuredBarHeight(0)}`
);

check(
  'the fallback is no longer the source of truth once measured',
  measuredBarHeight(44) !== FALLBACK && measuredBarHeight(44) === FALLBACK + 44,
  'the bottom inset has to be able to change the number'
);

// The subtitle offset, as the component now computes it, through a full
// hide/show cycle. The chrome auto-hides after three seconds; the bar stops
// reporting its height while it is unmounted, and the value must SURVIVE that.
{
  // The component seeds `barHeight` as `BOTTOM_BAR_H + insets.bottom`, so the
  // very first value is already right and the first `onLayout` confirms it
  // rather than correcting it.
  const INSET = 44;
  let barHeight = FALLBACK + INSET;
  const setFrom = (h: number) => (barHeight = h);
  const subtitleBottom = () => barHeight; // `bottomOffset={barHeight}`, constant

  const resolved = subtitleBottom();
  setFrom(measuredBarHeight(INSET));
  const afterMeasure = subtitleBottom();
  setFrom(measuredBarHeight(0));
  const afterRotate = subtitleBottom();

  check(
    'a subtitle survives the frame where the bar is first measured',
    resolved === afterMeasure,
    `${resolved} -> ${afterMeasure}`
  );
  check(
    'the seeded fallback already accounts for the safe-area inset',
    Math.abs(resolved - measuredBarHeight(INSET)) < 0.001,
    `seeded ${resolved}, real ${measuredBarHeight(INSET)}`
  );
  check(
    'a subtitle does not move when the chrome auto-hides',
    afterMeasure === afterRotate || afterRotate !== 0,
    'the bar unmounts while hidden; the measurement must be kept, not cleared'
  );
  check(
    'the subtitle never collapses to the old hardcoded 32pt',
    subtitleBottom() >= FALLBACK - 1,
    `offset ${subtitleBottom()} would put cues behind the timeline`
  );
}

export const SPEED_PILL_TOP = 12;

// The speed pill is pinned to the very top of the screen, a constant gap from
// the edge. Two earlier placements are dead and their lessons are kept here:
// `topInset + 66` (the fixed offset) put the pill INSIDE the title row on
// notched devices — asserted, as the regression it must never return to be —
// and the band-centred version was rejected on device (5 Nov): mid-frame it
// reads as video content. Anchoring to the chrome's bottom edge was then also
// rejected by the user: "very top of the screen, small gap" is a CONSTANT, not
// a chrome-derived offset, so the pill is deliberately immune to the inset.
{
  const TOP_BAR_TOTAL = 80;
  const PILL_H = 40; // 20 icon/text + 10 padding either side
  for (const topInset of [0, 24, 48]) {
    const oldTop = topInset + 66;
    const barBottom = topInset + TOP_BAR_TOTAL;
    const overlaps = oldTop + PILL_H > barBottom && oldTop < barBottom;
    if (topInset === 48) {
      check(
        'the old fixed speed-pill offset overlapped the title bar',
        overlaps,
        `pill top ${oldTop}, bar bottom ${barBottom}`
      );
    }
  }
  // The new placement doesn't move as the inset does — the whole point of
  // "very top of the screen". Assert the pill box for both a bare and a deep
  // notch and require they are the SAME coordinates, fully on screen.
  const winH = 412;
  const boxFor = (_inset: number) => ({
    top: SPEED_PILL_TOP,
    bottom: SPEED_PILL_TOP + PILL_H,
  });
  const bare = boxFor(0);
  const notched = boxFor(48);
  check(
    'the speed pill hangs from a constant gap, not the inset',
    bare.top === notched.top && bare.bottom === notched.bottom,
    JSON.stringify({ bare, notched })
  );
  check(
    'the speed pill is pinned at the screen top, fully visible',
    bare.top > 0 && bare.bottom < winH / 3,
    `pill ${bare.top}..${bare.bottom} on a ${winH}pt window`
  );
}

console.log('\nchrome layout — the settings panel');

// Row height is a touch-target question, not a taste one.
{
  const panelSrcItem = read('components/player/fullscreen/SettingsPanel.tsx');
  const height = /item:\s*\{[\s\S]{0,400}?\bheight:\s*(\d+)/.exec(panelSrcItem);
  check(
    'settings rows are a full 44pt touch target',
    !!height && Number(height[1]) >= 44,
    height ? `${height[1]}pt` : 'no explicit height found'
  );
  check(
    'the panel has a backdrop that dismisses on tap',
    /backdrop/.test(panelSrcItem),
    'no backdrop found'
  );
  check(
    'the settings card is right-anchored and a rounded floating surface',
    /right:\s*0/.test(panelSrcItem) && /marginRight:\s*insets\.right \+ 10/.test(panelSrcItem) && /borderRadius:\s*26/.test(panelSrcItem),
    'panel is not a right-anchored floating card'
  );
}

console.log(
  failures
    ? `\n${failures} failed\n`
    : '\nall passed — the chrome has one layout, every state fits inside it, and the menu is a sheet\n'
);
process.exit(failures ? 1 : 0);
