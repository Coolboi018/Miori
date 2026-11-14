/**
 * The player drawer's option list must scroll, and nothing else may scroll
 * while it is open.
 *
 * WHY THIS NEEDS A CHECK. The drawer ships two defects that both LOOK like one
 * report ("the sheets are not scrolling") and neither of which types, lint or a
 * bundle can see:
 *
 *   1. GESTURE OWNERSHIP. A vertical ScrollView inside a vertical ScrollView
 *      never scrolls on Android. `ReactScrollView.onInterceptTouchEvent` is
 *      asked on the way DOWN from the root, and returns true the moment the
 *      drag passes touch slop — so the page takes the gesture and the option
 *      list never starts. `nestedScrollEnabled` looks like the fix and is not:
 *      on RN 0.86 it maps to `ViewCompat.setNestedScrollingEnabled`, and the
 *      page extends `android.widget.ScrollView`, which is not a nested-scrolling
 *      parent, so there is nothing to join. The androidx NestedScrollView that
 *      would make it work sits behind `useNestedScrollViewAndroid` (false).
 *   2. LAYOUT. A ScrollView defaults to `flexShrink: 0`, so under a definite
 *      height it reports its CONTENT height, overflows the panel and is clipped
 *      by the panel's `overflow: hidden`. It is not a scroller at all: the rows
 *      past the fold are unreachable, with no scrollbar to explain it.
 *
 * EITHER ALONE IS NOT ENOUGH, which is why the fix has to hold both: moving the
 * drawer out of the page scroll view fixes (1) and leaves (2) broken, and
 * `flexShrink: 1` fixes (2) and leaves the page stealing every drag.
 *
 * WHY A MODEL AND NOT A COMPONENT TEST. There is no test runner and no renderer
 * here, and the defect is not in rendering — it is in WHERE the drawer is
 * mounted and in ONE number on one style. Both are read out of the real source
 * files below and fed to a model of the two rules, so the check fails the
 * moment someone tidies the JSX back into the player shell. The old shape is
 * also run through the same model, because a test that cannot come out false
 * is worthless.
 *
 * Run with:  npx tsx scripts/check-drawer-scroll.ts
 */

// This project does not carry `@types/node` — the app's tsconfig has no use for
// it and the other scripts get by on `process` alone — so the one filesystem
// call this script needs is declared here rather than by adding a dev
// dependency to a project that never ships one.
declare const require: (id: string) => {
  readFileSync(path: string, encoding: 'utf8'): string;
};
const { readFileSync } = require('node:fs');

// ---------------------------------------------------------------------------
// The rules, as the platform applies them
// ---------------------------------------------------------------------------

/** A scrollable in the chain, outermost first. */
interface Scroller {
  name: string;
  /** `scrollEnabled={false}` on Android also stops it INTERCEPTING. */
  enabled: boolean;
  /** Whether its content is larger than its box right now. */
  canScroll: boolean;
}

interface Verdict {
  /** What the drag is actually scrolling. */
  scrolls: string | null;
  /** What the leftover drag reaches when the first one hits its end. */
  chainsInto: string | null;
}

/**
 * Who owns a vertical drag that starts inside the innermost scroller.
 *
 * Android's rule, and it is not "the deepest one wins": `onInterceptTouchEvent`
 * runs from the root down, so the OUTERMOST scroller intercepts first and
 * cancels the child. Only when that outer one cannot move does the gesture
 * reach the next one down. Nothing above the outermost ever gets a look, which
 * is why being outside the page's scroll view is what fixes this.
 */
function dragVerdict(chain: Scroller[]): Verdict {
  for (let i = 0; i < chain.length; i++) {
    const s = chain[i];
    if (s.enabled && s.canScroll) {
      // Whatever is above it is what absorbs the drag once `s` runs out — the
      // page moving under a settings panel is the bug being pinned here.
      const outer = chain.slice(0, i).find((c) => c.enabled && c.canScroll);
      return { scrolls: s.name, chainsInto: outer?.name ?? null };
    }
  }
  return { scrolls: null, chainsInto: null };
}

/**
 * Does the list act as a scroller at all?
 *
 * `flexShrink` is the whole question. With 0 the ScrollView is sized by its
 * content, so the box it sits in never has a range to scroll — it just paints
 * past the bottom of the panel and gets clipped.
 */
function listIsScrollable(opts: {
  viewport: number;
  content: number;
  flexShrink: number;
}): boolean {
  if (opts.flexShrink <= 0) return false;
  return opts.content > opts.viewport;
}

/** The drawer is only as tall as the video; both halves of the report. */
const VIEWPORT = 139; // a 16:9 player on a phone, minus the drawer header
const CONTENT = 264; // "Off" + a handful of subtitle tracks

// ---------------------------------------------------------------------------
// What the source files actually say
// ---------------------------------------------------------------------------

const root = process.cwd();
const watch = readFileSync(`${root}/app/watch/[id]/[ep].tsx`, 'utf8');
const sheet = readFileSync(`${root}/components/player/PlayerSheet.tsx`, 'utf8');

/** Everything from `<ScrollView` up to its matching `</ScrollView>`. */
function scrollViewBody(src: string, open: number): string {
  const end = src.indexOf('</ScrollView>', open);
  return end === -1 ? src.slice(open) : src.slice(open, end);
}

/** Is the drawer's list ScrollView allowed to shrink to its box? */
function shrinkFromSource(): number {
  const m = /list:\s*\{([^}]*)\}/.exec(sheet);
  if (!m) return 0;
  const v = /flexShrink:\s*(\d+(?:\.\d+)?)/.exec(m[1]);
  return v ? Number(v[1]) : 0;
}

/** The `flexShrink` the list ScrollView is actually rendered with. */
function shrinkAppliedToList(): number {
  const applied = /<ScrollView[\s\S]{0,400}?style=\{styles\.list\}/.test(sheet);
  return applied ? shrinkFromSource() : 0;
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

let failures = 0;
function check(name: string, pass: boolean, detail = '') {
  if (pass) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function main() {
  console.log('\nplayer drawer scrolling');

  // --- 1. gesture ownership, old shape vs the one on disk -----------------
  // The OLD arrangement: the drawer mounted inside the player, which is inside
  // the page scroll view. Modelled here so this check can come out false.
  const oldChain = dragVerdict([
    { name: 'page', enabled: true, canScroll: true },
    { name: 'list', enabled: true, canScroll: listIsScrollable({ ...SHAPE, flexShrink: 1 }) },
  ]);
  check(
    'the old shape gave every drag in the list to the PAGE',
    oldChain.scrolls === 'page' && oldChain.chainsInto === null,
    JSON.stringify(oldChain)
  );

  const pageOpen = watch.indexOf('<ScrollView');
  const pageClose = watch.indexOf('</ScrollView>');
  const drawer = watch.indexOf('<PlayerSheet');
  const mountedOutside = pageOpen !== -1 && pageClose !== -1 && drawer > pageClose;

  check(
    'the drawer is mounted OUTSIDE the page scroll view',
    mountedOutside,
    mountedOutside ? '' : `<PlayerSheet at ${drawer}, page scroll view ${pageOpen}..${pageClose}`
  );

  // The chain as the source actually builds it: a drawer outside the page has
  // no scrollable ancestor at all, so there is nothing to intercept and nothing
  // to chain into.
  const newChain = dragVerdict([
    { name: 'list', enabled: true, canScroll: listIsScrollable({ ...SHAPE, flexShrink: shrinkAppliedToList() }) },
  ]);
  check(
    'a drag over the option list scrolls the LIST',
    newChain.scrolls === 'list',
    JSON.stringify(newChain)
  );
  check(
    'and reaches nothing else at either end of its range',
    newChain.chainsInto === null,
    JSON.stringify(newChain)
  );

  // --- 2. the list has to be allowed to shrink ----------------------------
  check(
    'the option list shrinks to its box (flexShrink: 1)',
    shrinkFromSource() === 1 && shrinkAppliedToList() === 1,
    `styles.list flexShrink ${shrinkFromSource()}, applied ${shrinkAppliedToList()}`
  );
  check(
    'which is what makes it a scroller at all',
    listIsScrollable({ ...SHAPE, flexShrink: shrinkAppliedToList() }),
    'the list still reports its content height and is clipped by the panel'
  );
  // ...and the shrink must not be a magic number that only works because the
  // list is short: a list that fits must stay put.
  check(
    'a list shorter than its box is not made scrollable by the shrink',
    !listIsScrollable({ viewport: 300, content: 90, flexShrink: shrinkAppliedToList() })
  );

  // --- 3. the page cannot move while the panel is up ----------------------
  check(
    'the page scroll view is locked while a panel is open',
    /<ScrollView[\s\S]{0,400}?scrollEnabled=\{sheet === null\}/.test(watch)
  );

  console.log(failures ? `\n${failures} failed\n` : '\nall passed\n');
  process.exit(failures ? 1 : 0);
}

const SHAPE = { viewport: VIEWPORT, content: CONTENT };

main();
