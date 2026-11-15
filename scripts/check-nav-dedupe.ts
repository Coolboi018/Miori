/**
 * Tapping a tile must open its destination ONCE.
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
 * TWO RULES, TWO FAILURE SHAPES. The guard used to be a time window only, and a
 * device pass still produced a doubled page. The reason is DELIVERY, not tap
 * spacing: a tap that lands while the JS thread is committing the detail page
 * is handed to `onPress` after that commit, so it can arrive well past the
 * window and clear it while the page it would duplicate is already on screen.
 * Rule 2 — "the focused route is already the destination" — is what makes that
 * case impossible, and the model below is built around proving it.
 *
 * WHY A MODEL AND NOT A COMPONENT TEST. There is no runner and no renderer
 * here, and the defect is not in rendering — it is in WHERE the navigation
 * lives and in two comparisons. The guard's real logic (same key inside the
 * window, window extends on a block, focused route wins over the clock) is
 * modelled below, and the CALL SITES are read out of the real source, because
 * "did they remember to use it" is half the bug and no model can see that.
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

interface Route {
  name: string;
  params: Record<string, string>;
}

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

function stripSlash(s: string): string {
  return s.replace(/^\/+/, '');
}

/**
 * Rule 2: is the target the screen that is focused right now?
 *
 * A SUBSET comparison of params on purpose — the focused route may carry params
 * the target never mentioned, and requiring an exact key set would let those
 * extras reopen a screen that is plainly already there.
 */
function isFocusedTarget(
  top: Route | null,
  pathname: string,
  params?: Record<string, string>
): boolean {
  if (!top) return false;
  if (stripSlash(top.name) !== stripSlash(pathname)) return false;
  if (!params) return true;
  return Object.keys(params).every((k) => String(top.params[k]) === params[k]);
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
 *
 * `top` is the focused route at the moment of the tap. Rule 2 is checked first
 * and is time-independent — that is the whole point of it.
 */
function attempt(
  g: Guard,
  pathname: string,
  params: Record<string, string> | undefined,
  now: number,
  top: Route | null = null
): { pushed: boolean; next: Guard } {
  const key = keyOf(pathname, params);
  if (isFocusedTarget(top, pathname, params)) {
    return { pushed: false, next: { key, at: now } };
  }
  if (key === g.key && now - g.at < DEDUPE_MS) {
    return { pushed: false, next: { key: g.key, at: now } };
  }
  return { pushed: true, next: { key, at: now } };
}

const ANIME = ['/anime/[id]', { id: '203473' }] as const;
const ANIME_ROUTE: Route = { name: 'anime/[id]', params: { id: '203473' } };

/** The player screen, as the navigator reports it once it is on top. */
const WATCH_ROUTE: Route = {
  name: 'watch/[id]/[ep]',
  params: { id: '203473', ep: '1' },
};

/** Replay a list of tap times through the guard, returning how many pushed. */
function runBurst(taps: number[], top: Route | null = null): number {
  let g: Guard = { key: null, at: 0 };
  let pushed = 0;
  for (const t of taps) {
    const r = attempt(g, ANIME[0], ANIME[1], t, top);
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

/**
 * The bug the device report actually reproduces: two FAST taps, the second
 * DELIVERED late because the detail page's commit occupied the JS thread.
 * Windows cannot see this. Only rule 2 can.
 */
function runDeliveredLateBurst(taps: number[]): number {
  let g: Guard = { key: null, at: 0 };
  // The focused route follows the accepted push, exactly as the navigator's
  // state does — that is the whole premise: by the time the second tap is
  // DELIVERED, the page it would duplicate is the one on top.
  let top: Route | null = null;
  let pushed = 0;
  for (const t of taps) {
    const r = attempt(g, ANIME[0], ANIME[1], t, top);
    g = r.next;
    if (r.pushed) {
      pushed++;
      top = ANIME_ROUTE;
    }
  }
  return pushed;
}

/** The same late delivery with the window-only guard — the shape being fixed. */
function runDeliveredLateBurstWindowOnly(taps: number[]): number {
  let g: Guard = { key: null, at: 0 };
  let pushed = 0;
  for (const t of taps) {
    const key = keyOf(ANIME[0], ANIME[1]);
    if (key === g.key && t - g.at < DEDUPE_MS) {
      g = { key: g.key, at: t };
      continue;
    }
    g = { key, at: t };
    pushed++;
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
const rootLayoutSrc = read('app/_layout.tsx');
const pendingSrc = read('lib/nav/pending.ts');
const progressSrc = read('components/nav/RouteProgress.tsx');

/** Every file that opens an anime detail page, or the player, from a tap. */
const CALL_SITES = [
  'app/(tabs)/index.tsx',
  'app/(tabs)/explore.tsx',
  'app/(tabs)/schedule.tsx',
  'app/(tabs)/search.tsx',
  'app/anime/[id].tsx',
  'components/nav/SearchOmnibox.tsx',
  'components/nav/NavBar.tsx',
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
  // Quiet for longer than the window, then a deliberate re-tap (from a screen
  // that is NOT the detail page): allowed again.
  check('a deliberate re-tap after the window is allowed', runBurst([0, 5000]) === 2);

  // --- 2. the delivered-late tap: what the device report actually is --------
  // Two fast taps, the second handed to onPress 4s later, after the commit —
  // by which time the detail page IS the focused route. Window-only says yes
  // twice; that is the doubled page the user saw.
  const lateTaps = [0, 4000];
  check(
    'a tap DELIVERED after the window does not open a second copy',
    runDeliveredLateBurst(lateTaps) === 1,
    `${runDeliveredLateBurst(lateTaps)} pushes`
  );
  check(
    'and the window-only guard would have opened two — the bug being fixed',
    runDeliveredLateBurstWindowOnly(lateTaps) === 2,
    `${runDeliveredLateBurstWindowOnly(lateTaps)} pushes — if this is 1 the model cannot tell the two guards apart`
  );
  // The focused-route rule is a SUBSET comparison: params the target never
  // mentioned must not make it look like a different screen.
  const withExtras: Route = {
    name: '/anime/[id]',
    params: { id: '203473', title: 'One Piece' },
  };
  check(
    'extras on the focused route do not defeat the match (and slashes do not either)',
    isFocusedTarget(withExtras, ANIME[0], ANIME[1])
  );

  // --- 3. different targets are NEVER blocked ------------------------------
  // This is what stops the guard eating a real flow: tap a result, the detail
  // page is cached and renders at once, tap "Watch now" inside the window.
  check(
    'a DIFFERENT anime while one detail page is focused still goes through',
    attempt({ key: null, at: 0 }, ANIME[0], { id: '999' }, 120, ANIME_ROUTE).pushed
  );
  check(
    'the player from the detail page is above that page, so it still goes through',
    attempt({ key: null, at: 0 }, '/watch/[id]/[ep]', WATCH_ROUTE.params, 120, ANIME_ROUTE)
      .pushed
  );
  // And the player itself: a second tap on the SAME episode while it is playing
  // must not mount a second player.
  check(
    'the SAME episode while the player is focused is dropped',
    !attempt({ key: null, at: 0 }, '/watch/[id]/[ep]', WATCH_ROUTE.params, 9000, WATCH_ROUTE)
      .pushed
  );
  check(
    'the NEXT episode while the player is focused still goes through',
    attempt({ key: null, at: 0 }, '/watch/[id]/[ep]', { id: '203473', ep: '2' }, 9000, WATCH_ROUTE)
      .pushed
  );

  // --- 4. the key is order-independent -------------------------------------
  check(
    'param order cannot fake a different destination',
    keyOf('/anime/[id]', { id: '1', ep: '2' }) === keyOf('/anime/[id]', { ep: '2', id: '1' })
  );

  // --- 5. the guard module agrees with the model ---------------------------
  check(
    'the guard ships the same window the model assumes',
    new RegExp(`const DEDUPE_MS = ${DEDUPE_MS}\\b`).test(guardSrc),
    `model assumes ${DEDUPE_MS}`
  );
  check(
    'and it extends the window on a blocked tap',
    /lastAt = now;\s*\n\s*extendNavPending\(\);\s*\n\s*return false;/.test(guardSrc),
    'the stamp must refresh on a BLOCK, not only on an accept'
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

  // --- 6. rule 2 is real in the module and wired to the container ----------
  check(
    'the REAL guard asks the navigator what is focused',
    /getCurrentRoute/.test(guardSrc) && /isFocusedTarget\(/.test(guardSrc)
  );
  // Order inside `pushOnce` itself — searching the whole module would find the
  // `DEDUPE_MS` declaration at the top and pass without reading the body.
  const pushBody = guardSrc.slice(guardSrc.indexOf('export function pushOnce'));
  check(
    'and it checks the focused route BEFORE the clock',
    pushBody.indexOf('isFocusedTarget(') !== -1 &&
      pushBody.indexOf('isFocusedTarget(') < pushBody.indexOf('DEDUPE_MS'),
    'rule 2 must not depend on the window'
  );
  check(
    'an unknown/unready navigator never blocks a push',
    /if \(!navRef\) return false;/.test(guardSrc) && /catch \{[\s\S]*?return false;/.test(guardSrc)
  );
  check(
    'the root layout binds the live container exactly once',
    /useNavigationContainerRef/.test(rootLayoutSrc) &&
      /bindNavigationRef\(navigationRef\)/.test(rootLayoutSrc)
  );

  // --- 7. a DROPPED tap still gets an answer -------------------------------
  // The bug fix must not trade a doubled screen for a frozen-looking one. The
  // guard is correct; the FEEDBACK is what makes it feel like an app rather than
  // a hang, and these pin the two properties that were actually chosen:
  // acknowledged before the dispatch, and animated on the UI thread.
  check(
    'an accepted push raises the pending bar before dispatching',
    guardSrc.indexOf('beginNavPending()') !== -1 &&
      guardSrc.indexOf('beginNavPending()') < guardSrc.indexOf('router.push('),
    'the bar has to be up when the tap finishes, not after the commit'
  );
  check(
    'both blocked branches keep an existing bar alive',
    (guardSrc.match(/extendNavPending\(\)/g) ?? []).length === 2,
    'a blocked tap must extend, never raise, or a settled bar would reappear'
  );
  check(
    'the bar animates a TRANSFORM (UI thread), not a JS timer',
    /useAnimatedStyle/.test(progressSrc) &&
      /translateX/.test(progressSrc) &&
      !/setInterval|setTimeout|ActivityIndicator/.test(progressSrc),
    'a JS-driven indicator stalls exactly when the app needs to look alive'
  );
  check(
    'and the whole app mounts exactly one host for it',
    (rootLayoutSrc.match(/<RouteProgress \/>/g) ?? []).length === 1
  );
  const minVisible = Number(/MIN_VISIBLE_MS = (\d+)/.exec(pendingSrc)?.[1]);
  const maxVisible = Number(/MAX_VISIBLE_MS = (\d+)/.exec(pendingSrc)?.[1]);
  check(
    'the flash guard is shorter than the liar switch',
    Number.isFinite(minVisible) &&
      Number.isFinite(maxVisible) &&
      minVisible < maxVisible,
    `min ${minVisible}, max ${maxVisible}`
  );

  // --- 8. every call site goes through it ----------------------------------
  // Half of this bug is "someone wrote a sixth copy". A raw push anywhere is
  // a duplicate waiting for a slow frame.
  const raw: string[] = [];
  for (const [file, src] of sources) {
    if (/router\.push\(\{\s*pathname: '\/anime\/\[id\]'/.test(src)) raw.push(file);
    if (/router\.push\(\{\s*pathname: '\/watch\/\[id\]\/\[ep\]'/.test(src)) {
      raw.push(`${file} (hand-pushed player)`);
    }
    if (/router\.push\(\{\s*pathname: '\/anime\/\[id\]\/characters'/.test(src)) {
      raw.push(`${file} (hand-pushed characters page)`);
    }
    if (/pushOnce\(|openAnime\(/.test(src) === false) raw.push(`${file} (never calls the guard)`);
  }
  check(
    'no screen pushes a detail page, the player or the cast page by hand',
    raw.length === 0,
    raw.join(', ')
  );
  check(
    'and the wrappers are what every site actually calls',
    /export function openAnime/.test(guardSrc) && /export function openEpisode/.test(guardSrc)
  );
  // The player has its own opener for the same reason the detail page does:
  // two mounted players is a worse version of two detail screens.
  check(
    'the detail page opens the player through the guard',
    /openEpisodeNav\(animeId, ep\)/.test(sources.get('app/anime/[id].tsx') ?? ''),
    'openEpisode(resumeEp) / openEpisode(item.number) must land in pushOnce'
  );

  // A repo-wide sweep, so a NEW screen cannot reintroduce it unnoticed.
  //
  // ⚠️ `/anime/[id]/characters` IS EXEMPT from this blunt sweep, and the
  // lookahead is why. It is a different screen — the character strip — reached
  // from one place on the detail page. It is guarded separately above, because
  // a mistimed tap repeats on it like any other rail, but it is not a DETAIL
  // push and a blunt `/anime\/\[id\]/` scan cannot tell the two apart.
  const sweep = [...sources.values()].join('\n');
  check(
    'the swept call sites contain no stray anime DETAIL push',
    !/\/anime\/\[id\](?!\/)/.test(sweep)
  );

  console.log(failures ? `\n${failures} failed\n` : '\nall passed\n');
  process.exit(failures ? 1 : 0);
}

main();
