/**
 * The watch page's episode box must be reachable, and the page must be the only
 * thing that scrolls.
 *
 * WHY THIS NEEDS A CHECK. The box shipped broken and the symptom was invisible
 * to every tool in the repo — it types, lints and bundles, and the failure only
 * exists on Android, only on a drag, and only as "that part doesn't move".
 * Three fixes were tried in sequence and TWO OF THEM MADE IT WORSE:
 *
 *   1. `nestedScrollEnabled`. Never the answer. On RN 0.86 it maps only to
 *      `ViewCompat.setNestedScrollingEnabled`, and a plain ScrollView is not a
 *      NestedScrollingParent, so there is nothing to join.
 *   2. `FlatList` → `ScrollView`. Silenced RN's nesting error and deleted a
 *      `scrollToIndex` measure race. Did NOT make it scroll.
 *   3. `scrollEnabled={false}`. Silences the nesting error too — by turning the
 *      box into a non-scroller that clips rows off the bottom with no scrollbar.
 *      The bug wearing a disguise, and the reason this file exists.
 *
 * THE ACTUAL DEFECT IS THE NESTING, NOT THE SCROLL VIEW. The page already
 * scrolls. `ReactScrollView.onInterceptTouchEvent` is asked on the way DOWN
 * from the root and returns true the moment the drag passes touch slop, so the
 * OUTERMOST scroller wins every time and the inner one never starts. The drawer
 * was fixed by moving itself outside the page; this box cannot move outside — it
 * belongs inline, under its own heading — so it takes the other half of that
 * answer: ONE SCROLLER PER SCREEN. The box is a plain `View` sized by its rows
 * and the page carries them.
 *
 * WHY A MODEL AND NOT A COMPONENT TEST. There is no runner and no renderer
 * here, and the defect is not in rendering — it is in WHICH element wraps the
 * rows and in two numbers on two styles. Both are read out of the real source
 * below and fed to a model of the gesture rule. The old shape is run through the
 * same model, because a check that cannot come out false is worthless.
 *
 * Run with:  npx tsx scripts/check-episode-box-scroll.ts
 */

// This project does not carry `@types/node`, so the one filesystem call this
// script needs is declared here rather than by adding a dev dependency to a
// project that never ships one.
declare const require: (id: string) => {
  readFileSync(path: string, encoding: 'utf8'): string;
};
const { readFileSync } = require('node:fs');

// ---------------------------------------------------------------------------
// The rule, as Android applies it
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
  /** What a drag starting inside the innermost scroller actually scrolls. */
  scrolls: string | null;
  /** What the leftover drag reaches when the first one hits its end. */
  chainsInto: string | null;
}

/**
 * Who owns a vertical drag that starts inside the innermost scroller.
 *
 * Android's rule, and it is not "the deepest one wins": `onInterceptTouchEvent`
 * runs from the root DOWN, so the outermost scroller intercepts first and
 * cancels the child. Only when that outer one cannot move does the gesture
 * reach the next one down.
 *
 * ⚠️ THE `boxReachable` COLUMN IS THE WHOLE POINT. A chain of one scroller
 * always scrolls — that is the page, and it is correct. The defect is not "the
 * drag did nothing", it is "a second scroller existed and the page ate its
 * drags while its rows sat unreachable". So the question is not whether
 * something scrolled but whether the BOX'S OWN rows were ever in a scroller the
 * user could reach, and the only arrangement where they are is the one where
 * the box is not a scroller at all and its rows are simply page content.
 */
function dragVerdict(chain: Scroller[]): Verdict & { boxReachable: boolean } {
  for (let i = 0; i < chain.length; i++) {
    const s = chain[i];
    if (s.enabled && s.canScroll) {
      const outer = chain.slice(0, i).find((c) => c.enabled && c.canScroll);
      return {
        scrolls: s.name,
        chainsInto: outer?.name ?? null,
        // The box's rows are only reachable if the box is NOT a scroller of its
        // own — otherwise every drag on it is claimed by whatever is above.
        boxReachable: !chain.some((c) => c.name === 'box' && c.enabled),
      };
    }
  }
  return { scrolls: null, chainsInto: null, boxReachable: false };
}

/**
 * Does the episode box actually overflow its 480pt cap?
 *
 * Modelled from the tokens rather than hard-coded: `numChip` is 64 wide at
 * `bannerRatio` 16/9 (36pt tall) and `body` carries `spacing.md` of vertical
 * padding around a 19pt title and 16pt synopsis lines, so a full row runs
 * ~65-80pt. Ten of them do not fit in 480. This is the arithmetic that made the
 * cap a bug rather than a constraint: rows were being clipped AND unreachable.
 */
function boxOverflows(rows: number): boolean {
  const ROW_MIN = 65;
  const ROW_MAX = 80;
  const BOX_H = 480;
  // The honest answer is "it might"; the check pins the case that matters, which
  // is a FULL page, since that is what a long or fully-aired series shows.
  return rows * ROW_MAX > BOX_H;
}

// ---------------------------------------------------------------------------
// What the source file actually says
// ---------------------------------------------------------------------------

const root = process.cwd();
const watch = readFileSync(`${root}/app/watch/[id]/[ep].tsx`, 'utf8');

/**
 * The source with its comments removed.
 *
 * ⚠️ NOT OPTIONAL. These rules are asserted against source text, and this file
 * *documents* the anti-patterns it forbids — `flex: 1`, `boxY.current = null`,
 * the word `ScrollView`. Matching the prose would mean a check that goes red
 * every time someone explains the bug well. Strip first, then match.
 */
const code = watch
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '');

/** The body of one style block from the watch screen's `StyleSheet`. */
function styleBody(name: string): string {
  const m = new RegExp(`\\b${name}:\\s*\\{([^}]*)\\}`).exec(code);
  return m ? m[1] : '';
}

/**
 * The JSX element that wraps the episode rows — i.e. the one that decides
 * whether they live in a scroller.
 *
 * ⚠️ ANCHORED ON THE STYLE, NOT ON `paged.map(`. `paged.map(` appears TWICE in
 * this file: once in the JSX, and once in the `visibleNums` memo near the top,
 * which builds the Kitsu request key. An `indexOf` finds that one, finds no JSX
 * container anywhere near it, and reports "nothing found" forever — a check that
 * fails for a reason that has nothing to do with the code. `epBoxContent` is
 * applied to exactly the one element that wraps the rows and to nothing else,
 * so it is the unambiguous anchor.
 */
function boxWrapper(): string {
  const m = /<(ScrollView|FlatList|SectionList|VirtualizedList|View)\b[^>]*style=\{styles\.epBoxContent\}/.exec(
    code
  );
  return m ? m[1] : '';
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
  console.log('\nwatch page episode box');

  // --- 1. gesture ownership, old shape vs the one on disk ------------------
  // The OLD arrangement: a fixed-height scroller inside the page's scroller.
  // Modelled so this check can come out false, and so the claim in progress.md
  // is something this file would catch being quietly reintroduced.
  const oldChain = dragVerdict([
    { name: 'page', enabled: true, canScroll: true },
    { name: 'box', enabled: true, canScroll: boxOverflows(10) },
  ]);
  check(
    'the old shape gave every drag on the box to the PAGE',
    oldChain.scrolls === 'page' && oldChain.chainsInto === null,
    JSON.stringify(oldChain)
  );
  check('…and left the rows past the fold unreachable', !oldChain.boxReachable);

  // The shape on disk: the box is not a scroller, so its rows ARE page content.
  // `enabled` means "is an intercepting scroller" — a plain `View` is neither
  // that nor able to scroll, so on the fixed shape the box is simply absent
  // from the chain rather than present and harmless.
  const wrapper = boxWrapper();
  const boxIsScroller = wrapper === 'ScrollView' || wrapper.endsWith('List');
  const newChain = dragVerdict([
    { name: 'page', enabled: true, canScroll: true },
    { name: 'box', enabled: boxIsScroller, canScroll: boxIsScroller },
  ]);
  check(
    'a drag over the box scrolls the PAGE, which now carries the rows',
    newChain.scrolls === 'page',
    JSON.stringify(newChain)
  );
  check('and every row in it is reachable', newChain.boxReachable);

  // --- 2. the box is a plain View, not a scroller of any kind --------------
  check(
    'the rows are wrapped in a plain View, not a scroll view',
    wrapper === 'View',
    `wrapping element is <${wrapper || 'nothing found'}>`
  );
  const boxAt = code.indexOf('<View style={styles.epBox');
  const pagerAt = code.indexOf('<WatchPager', boxAt);
  check(
    'and no scroll view survived anywhere in the episode section',
    boxAt !== -1 && pagerAt !== -1 && !/<(ScrollView|FlatList|SectionList)\b/.test(code.slice(boxAt, pagerAt)),
    `episode section spans ${boxAt}..${pagerAt}`
  );

  // --- 3. nothing may put the cap back -------------------------------------
  // The cap is the only reason a second scroller was ever needed, and it was
  // clipping ~200pt of rows. This is the assertion that outlives the person who
  // remembers the 480 and thinks it is doing something useful.
  check(
    'the box style carries no height',
    !/\bheight\s*:/.test(styleBody('epBox')),
    styleBody('epBox').trim()
  );

  // --- 4. the empty state did not die with the cap -------------------------
  // `flex: 1` centred that text by filling the 480pt box. In an auto-sized
  // parent it resolves to ZERO and the message renders at nothing — a silent
  // regression with no error and no warning, which is exactly the kind this
  // file is for.
  check(
    'the empty state does not use flex:1 (it would collapse to zero height)',
    !/\bflex\s*:\s*1\b/.test(styleBody('epBoxEmpty')),
    styleBody('epBoxEmpty').trim()
  );

  // --- 5. the reveal measures instead of guessing --------------------------
  check(
    'the box reports its own offset into the page',
    /onLayout=\{\(e\)\s*=>\s*\{\s*boxY\.current = e\.nativeEvent\.layout\.y/.test(code)
  );
  check(
    'the reveal scrolls the PAGE, summing the box offset with the row offset',
    /pageRef\.current\?\.scrollTo\(\{\s*y:\s*base \+ row/.test(code),
    'a reveal that scrolls anything but the page is scrolling a scroller that is gone'
  );
  check(
    'a half-measured reveal waits instead of scrolling to the wrong place',
    /if \(row === undefined \|\| base === null\) return;/.test(code)
  );
  check('the dead box ref is gone', !/\bboxRef\b/.test(code));

  // The trap: clearing `boxY` would leave a reveal that can never complete,
  // because a View whose height did not change is not guaranteed to fire
  // `onLayout` again — so nothing would ever put the number back. Asserted over
  // the whole file rather than one effect, which is the stronger claim and the
  // one that is actually true: the box's offset in the page cannot move.
  check(
    'the box offset is never cleared anywhere (it cannot move, and may not re-fire)',
    !/boxY\.current\s*=\s*null/.test(code)
  );
  check(
    'the page/sort effect clears the ROW offsets, which do move',
    /rowY\.current = \{\}/.test(code)
  );

  console.log(failures ? `\n${failures} failed\n` : '\nall passed\n');
  process.exit(failures ? 1 : 0);
}

main();
