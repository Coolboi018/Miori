/**
 * Tapping a tile must open its detail page ONCE.
 *
 * WHY THIS NEEDS A CHECK. The root stack is a native stack, and `router.push`
 * on a native stack pushes another screen unconditionally — it has no opinion
 * about whether the screen being pushed is already on top. So a device that
 * lags through a tap produces the same stack every time:
 *
 *     Home -> Anime -> Anime -> Anime
 *
 * Three screens for one intention, and three Back presses to undo it. Nothing
 * about it is visible to tsc, lint or a bundle: it needs a slow frame and a
 * human, which is exactly the class of defect an offline check exists for.
 *
 * WHY A MODEL AND NOT A COMPONENT TEST. There is no runner and no renderer
 * here, and the defect is not in rendering — it is in WHERE the navigation
 * lives and in one comparison. The guard's real logic (same key, inside the
 * window, window extends on a block) is modelled below, and the CALL SITES are
 * read out of the real source, because "did they remember to use it" is half
 * the bug and no model can see that.
 *
 * Run with:  npx tsx scripts/check-nav-dedupe.ts
 */

declare const require: (id: string) => {
  readFileSync(path: string, encoding: 'utf8'): string;
};
const { readFileSync } = require('node:fs');

// ---------------------------------------------------------------------------
// The rule, modelled
// ---------------------------------------------------------------------------

const DEDUPE_MS = 600;

interface Guard {
  key: string | null;
  at: number;
}

/** Stable key for a destination — params sorted, so order cannot fake a change. */
function keyOf(pathname: string, params?: Record<string, string>): string {
  if (!params) return pathname;
  const entries = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`);
  return `${pathname}?${entries.join('&')}`;
}

/**
 * Whether a push is allowed, and what the guard looks like afterwards.
 *
 * The window EXTENDING ON A BLOCK is the part that is easy to get wrong and is
 * the whole reason this guard catches a lag burst. A burst is not evenly
 * spaced — taps land at 0, 180, 420, 700ms. If the stamp only moved on an
 * ACCEPTED push, the tap at 700ms would be 700ms past the push at 0ms, clear a
 * 600ms window, and push a second copy: the guard would stop two taps and let
 * through the third, which is the exact pattern it exists to stop.
 */
function attempt(
  g: Guard,
  pathname: string,
  params: Record<string, string> | undefined,
  now: number
): { pushed: boolean; next: Guard } {
  const key = keyOf(pathname, params);
  if (key === g.key && now - g.at < DEDUPE_MS) {
    return { pushed: false, next: { key: g.key, at: now } };
  }
  return { pushed: true, next: { key, at: now } };
}

const ANIME = ['/anime/[id]', { id: '203473' }] as const;

/** Replay a list of tap times through the guard, returning how many pushed. */
function runBurst(taps: number[]): number {
  let g: Guard = { key: null, at: 0 };
  let pushed = 0;
  for (const t of taps) {
    const r = attempt(g, ANIME[0], ANIME[1], t);
    g = r.next;
    if (r.pushed) pushed++;
  }
  return pushed;
}

/** A naive guard that only stamps on an ACCEPTED push — the wrong one. */
function runBurstNaive(taps: number[]): number {
  let g: Guard = { key: null, at: 0 };
  let pushed = 0;
  for (const t of taps) {
    const key = keyOf(ANIME[0], ANIME[1]);
    const pushedNow = !(key === g.key && t - g.at < DEDUPE_MS);
    if (pushedNow) {
      g = { key, at: t };
      pushed++;
    }
  }
  return pushed;
}

// ---------------------------------------------------------------------------
// What the source files actually say
// ---------------------------------------------------------------------------

const root = process.cwd();
/** Source text, comments stripped — these files DOCUMENT the raw push they replaced. */
function read(path: string): string {
  return readFileSync(`${root}/${path}`, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

// The guard module is stripped for the same reason: its header explains WHY it
// is a module and not a `useRef`, so the literal string `useRef` appears in it
// and an unstripped scan reads the documentation as the bug.
const guardSrc = read('lib/nav/pushOnce.ts');

/** Every file that opens an anime detail page. */
const CALL_SITES = [
  'app/(tabs)/index.tsx',
  'app/(tabs)/explore.tsx',
  'app/(tabs)/schedule.tsx',
  'app/(tabs)/search.tsx',
  'app/anime/[id].tsx',
  'components/nav/SearchOmnibox.tsx',
  'components/ui/CharacterSheet.tsx',
];

const sources = new Map(CALL_SITES.map((f) => [f, read(f)]));

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
  console.log('\nnavigation dedupe');

  // --- 1. the model, including the shape it has to beat --------------------
  // A lag burst, unevenly spaced. One push is the whole requirement.
  const burst = runBurst([0, 180, 420, 700, 1100]);
  check(
    'an uneven lag burst opens the page ONCE',
    burst === 1,
    `${burst} pushes`
  );
  check(
    'the naive "stamp only on accept" guard would have failed here',
    runBurstNaive([0, 180, 420, 700, 1100]) > 1,
    `${runBurstNaive([0, 180, 420, 700, 1100])} pushes — if this is 1 the model cannot tell the two guards apart`
  );
  // Quiet for longer than the window, then a deliberate re-tap: allowed again.
  check('a deliberate re-tap after the window is allowed', runBurst([0, 5000]) === 2);

  // --- 2. different targets are NEVER blocked ------------------------------
  // This is what stops the guard eating a real flow: tap a result, the detail
  // page is cached and renders at once, tap "Watch now" inside the window.
  let g: Guard = { key: null, at: 0 };
  g = attempt(g, ANIME[0], ANIME[1], 0).next;
  const toWatch = attempt(g, '/watch/[id]/[ep]', { id: '203473', ep: '1' }, 120);
  check('a DIFFERENT route inside the window still goes through', toWatch.pushed);
  const toOtherAnime = attempt(g, ANIME[0], { id: '999' }, 120);
  check('a DIFFERENT anime inside the window still goes through', toOtherAnime.pushed);

  // --- 3. the key is order-independent -------------------------------------
  check(
    'param order cannot fake a different destination',
    keyOf('/anime/[id]', { id: '1', ep: '2' }) === keyOf('/anime/[id]', { ep: '2', id: '1' })
  );

  // --- 4. the guard module agrees with the model ---------------------------
  check(
    'the guard ships the same window the model assumes',
    new RegExp(`const DEDUPE_MS = ${DEDUPE_MS}\\b`).test(guardSrc),
    `model assumes ${DEDUPE_MS}`
  );
  check(
    'and it extends the window on a blocked tap',
    /lastAt = now;\s*\n\s*return false;/.test(guardSrc)
  );
  check(
    'the guard is module state, not a ref inside one screen',
    /^let lastKey/m.test(guardSrc) && !/useRef/.test(guardSrc)
  );
  // ⚠️ THIS ONE EXISTS BECAUSE A MUTATION SLIPPED THROUGH THE FIRST VERSION OF
  // THIS FILE. The model above proves that keying on the params is correct, but
  // it proves it about ITS OWN `keyOf` — replacing the real module's return with
  // a bare `return pathname` (so every anime shares one key, and opening one
  // anime would block opening any other) left every assertion here green,
  // because nothing compared the model to the code. So the model is not
  // evidence about the module, and the module's own key construction is asserted
  // directly: the key must be built from the joined params, not the path alone.
  check(
    'the REAL guard keys on the params, not the path alone',
    /Object\.keys\(params\)/.test(guardSrc) && /\$\{pathname\}\?\$\{entries\.join/.test(guardSrc),
    'the module must build its key as pathname + joined params'
  );

  // --- 5. every call site goes through it ----------------------------------
  // Half of this bug is "someone wrote a sixth copy". A raw push anywhere is
  // a duplicate waiting for a slow frame.
  const raw: string[] = [];
  for (const [file, src] of sources) {
    if (/router\.push\(\{\s*pathname: '\/anime\/\[id\]'/.test(src)) raw.push(file);
    if (!/openAnime\(/.test(src)) raw.push(`${file} (never calls openAnime)`);
  }
  check(
    'no screen pushes an anime detail route by hand',
    raw.length === 0,
    raw.join(', ')
  );
  check(
    'and the wrapper is what every site actually calls',
    /export function openAnime/.test(guardSrc)
  );

  // A repo-wide sweep, so a NEW screen cannot reintroduce it unnoticed.
  //
  // ⚠️ `/anime/[id]/characters` IS EXEMPT, and the lookahead is why. It is a
  // different screen — the character strip — reached from one place on the
  // detail page, not a tile that can be double-tapped, so it stays a raw push.
  // A blunt `/anime/\[id\]/` sweep cannot tell the two apart and would demand a
  // guard on a route that does not have the problem.
  const sweep = [...sources.values()].join('\n');
  check(
    'the swept call sites contain no stray anime DETAIL push',
    !/\/anime\/\[id\](?!\/)/.test(sweep)
  );

  console.log(failures ? `\n${failures} failed\n` : '\nall passed\n');
  process.exit(failures ? 1 : 0);
}

main();
