/**
 * A filter change on Explore must cost ONE request, not two.
 *
 * This is here because the bug it pins is invisible in normal use. Two requests
 * produce two requests' worth of results, the screen fills in either way, and
 * nothing looks wrong — the cost shows up as an inflated share of AniList's
 * 24/min allowance and, when the budget bites, as a spinner. `test-transport.ts`
 * already guards the allowance itself; this guards the one screen that was
 * systematically over-spending it.
 *
 * WHY A SIMULATION AND NOT A COMPONENT TEST.
 *
 * There is no test runner and no React renderer in this repo, and the defect is
 * not in rendering — it is in how many distinct query keys a transition walks
 * through. `useBrowseGrid` is a thin `useQuery` over `qk.browse`, and react-query
 * fires exactly one request per key it does not already hold fresh data for. So
 * counting distinct keys IS counting requests, and that can be checked without
 * mounting anything.
 *
 * The keys come from the real `qk.browse`, so a change to `filtersKey` or to the
 * key's shape is picked up here rather than silently making this test stale.
 *
 * Run with:  npx tsx scripts/check-explore-keys.ts
 */

import { DEFAULT_FILTERS, type ExploreFilters } from '../lib/anilist/explore';
import { qk } from '../lib/query/keys';

/** What the grid is querying, as the screen holds it. */
interface GridQuery {
  filters: ExploreFilters;
  page: number;
}

/**
 * A stand-in for the query cache. One request per distinct key that is not
 * already held fresh — which is react-query's actual rule.
 *
 * `placeholderData: keepPreviousData` does not change this: it supplies
 * placeholder data for a NEW key, it does not spare that key its fetch. That is
 * why the old bug cost a real request and not merely an extra paint.
 */
class Requests {
  readonly fired: string[] = [];
  private readonly fresh = new Set<string>();

  render(q: GridQuery): void {
    const key = JSON.stringify(qk.browse(q.filters, Math.max(1, q.page)));
    if (this.fresh.has(key)) return;
    this.fresh.add(key);
    this.fired.push(key);
  }

  get count(): number {
    return this.fired.length;
  }
}

/**
 * Settles `from` first and returns how many requests the transition itself cost.
 *
 * The pre-tap render has to be in the count or not at all: a user changing a
 * filter is by definition looking at a populated grid, so its key is already
 * cached and that render is free. Measuring from an empty cache instead charges
 * every scenario for a request the screen would never make.
 */
function cost(r: Requests, from: GridQuery, transition: (r: Requests) => void): number {
  r.render(from);
  const before = r.count;
  transition(r);
  return r.count - before;
}

/**
 * The OLD arrangement: one `filters` state feeding the query, with the page reset
 * debounced separately.
 *
 * Reproduced faithfully, including the intermediate render — `setFilters` lands
 * immediately, `setGridPage(1)` lands 260ms later.
 */
function oldTransition(r: Requests, from: GridQuery, taps: number): void {
  let committed = from.filters;
  for (let i = 0; i < taps; i++) {
    committed = { ...committed, genres: [...committed.genres, `g${i}`].slice(-3) };
    r.render({ filters: committed, page: from.page }); // setFilters — now
  }
  // …260ms later, the debounced page reset.
  r.render({ filters: committed, page: 1 });
}

/**
 * The NEW arrangement: the chip state updates now, the query input is one atomic
 * commit inside the debounce.
 */
function newTransition(r: Requests, from: GridQuery, taps: number): void {
  let committed = from.filters;
  for (let i = 0; i < taps; i++) {
    committed = { ...committed, genres: [...committed.genres, `g${i}`].slice(-3) };
    // The chip render. `gridQuery` is untouched, so this is the SAME key as the
    // pre-tap render and costs nothing.
    r.render(from);
  }
  // …260ms later, ONE commit carrying both filters and page.
  r.render({ filters: committed, page: 1 });
}

let failures = 0;
function check(name: string, pass: boolean, detail = '') {
  if (pass) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function onPage(page: number): GridQuery {
  return { filters: DEFAULT_FILTERS, page };
}

function main() {
  console.log('\nexplore query keys');

  // --- the reported case: a single tap from page 3 ------------------------
  const oldSingle = new Requests();
  const oldSingleCost = cost(oldSingle, onPage(3), (r) => oldTransition(r, onPage(3), 1));
  const newSingle = new Requests();
  const newSingleCost = cost(newSingle, onPage(3), (r) => newTransition(r, onPage(3), 1));

  check(
    'the old shape fired two requests for one tap from page 3',
    oldSingleCost === 2,
    `fired ${oldSingleCost}`
  );
  check(
    'one tap from page 3 now costs one request',
    newSingleCost === 1,
    `fired ${newSingleCost}: ${newSingle.fired.slice(-1).join(' , ')}`
  );

  // The wasted one was not free of consequence: it asked for page 3 of the NEW
  // filters, which is the very page the debounce exists to avoid asking for.
  check(
    'the old extra request was for page 3 of the NEW filters',
    JSON.parse(oldSingle.fired[1])[2] === 3,
    oldSingle.fired[1]
  );

  // --- rapid multi-select, which is what genre multi-select invites -------
  const oldMulti = new Requests();
  const oldMultiCost = cost(oldMulti, onPage(3), (r) => oldTransition(r, onPage(3), 3));
  const newMulti = new Requests();
  const newMultiCost = cost(newMulti, onPage(3), (r) => newTransition(r, onPage(3), 3));

  check(
    'three taps in the debounce window cost one request, not four',
    newMultiCost === 1,
    `new fired ${newMultiCost}, old fired ${oldMultiCost}`
  );

  // --- page 1 was never broken, and must stay un-broken ------------------
  const oldP1 = new Requests();
  const oldP1Cost = cost(oldP1, onPage(1), (r) => oldTransition(r, onPage(1), 1));
  const newP1 = new Requests();
  const newP1Cost = cost(newP1, onPage(1), (r) => newTransition(r, onPage(1), 1));

  check('a tap from page 1 was already one request', oldP1Cost === 1, `old fired ${oldP1Cost}`);
  check('…and still is', newP1Cost === 1, `new fired ${newP1Cost}`);

  // --- and paging on its own must still move the key ---------------------
  const paged = new Requests();
  paged.render(onPage(1));
  paged.render(onPage(2));
  paged.render(onPage(2)); // re-render at the same page
  check(
    'paging fetches the new page and re-renders do not refetch',
    paged.count === 2,
    `fired ${paged.count}`
  );

  // A page change must not silently reset the filters it is paging through.
  const keptFilters = new Requests();
  const narrowed: ExploreFilters = { ...DEFAULT_FILTERS, genres: ['Action'] };
  keptFilters.render({ filters: narrowed, page: 1 });
  keptFilters.render({ filters: narrowed, page: 2 });
  check(
    'paging keeps the filters in the key',
    keptFilters.fired.every((k) => JSON.parse(k)[1].includes('Action')),
    keptFilters.fired.join(' , ')
  );

  console.log(failures ? `\n${failures} failed\n` : '\nall passed\n');
  process.exit(failures ? 1 : 0);
}

main();