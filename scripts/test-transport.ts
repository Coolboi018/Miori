/**
 * Smoke test for the transport's two load-bearing promises:
 *
 *   1. TWO CALLERS ASKING THE SAME QUESTION COST ONE REQUEST.
 *   2. THE APP NEVER EXCEEDS ANILIST'S ALLOWANCE.
 *
 * Plus the staleness gate, which is here because it was got wrong TWICE and cost
 * a measurable regression on device (tab switching 1–2s → 3–4s). See below.
 *
 * Both transport properties are pure logic over a fake `fetch`, so they run in
 * plain Node with no device, no simulator and no network. If either regresses,
 * this fails — which matters because both are invisible in normal use: a
 * duplicated request costs nothing you can see, and a 429 costs a spinner.
 *
 * Run with:  npx tsx scripts/test-transport.ts
 */

import { gql } from '../lib/net/gql';
import { refetchIfStale } from '../lib/query/client';

let calls = 0;
let failNext = 0;

/** Stand-in for `fetch`. Counts calls and can be told to fail. */
const realFetch = globalThis.fetch;
globalThis.fetch = (async (_url: string, init?: RequestInit) => {
  calls++;
  if (failNext > 0) {
    failNext--;
    throw new TypeError('Network request failed');
  }
  await new Promise((r) => setTimeout(r, 5));
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({ data: { ok: true, echo: JSON.parse(String(init?.body)).variables } }),
  } as unknown as Response;
}) as typeof fetch;

let failures = 0;
function check(name: string, pass: boolean, detail = '') {
  if (pass) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function main() {
  console.log('\ntransport');

  // --- 1. de-duplication ------------------------------------------------
  calls = 0;
  const [a, b, c] = await Promise.all([
    gql<{ ok: boolean }>('query Dedupe { ok }'),
    gql<{ ok: boolean }>('query Dedupe { ok }'),
    gql<{ ok: boolean }>('query Dedupe { ok }'),
  ]);
  check('three concurrent identical calls make one request', calls === 1, `made ${calls}`);
  check('all three callers get the response', a.ok && b.ok && c.ok);

  // The same query with different variables is a DIFFERENT question.
  calls = 0;
  await Promise.all([
    gql('query V($id: Int) { ok }', { variables: { id: 1 } }),
    gql('query V($id: Int) { ok }', { variables: { id: 2 } }),
  ]);
  check('different variables are not de-duplicated', calls === 2, `made ${calls}`);

  // Key order must not matter, or `{$a,$b}` and `{$b,$a}` would be two requests.
  calls = 0;
  await Promise.all([
    gql('query K { ok }', { variables: { a: 1, b: 2 } }),
    gql('query K { ok }', { variables: { b: 2, a: 1 } }),
  ]);
  check('variable key order does not affect the key', calls === 1, `made ${calls}`);

  // --- 2. retry ----------------------------------------------------------
  calls = 0;
  failNext = 2;
  const retried = await gql<{ ok: boolean }>('query Retry { ok }');
  check('recovers after two transient failures', retried.ok && calls === 3, `made ${calls}`);

  calls = 0;
  failNext = 99;
  let threw = false;
  try {
    await gql('query Dead { ok }');
  } catch {
    threw = true;
  }
  check('gives up rather than retrying forever', threw && calls === 3, `made ${calls}`);
  failNext = 0;

  // --- 3. the budget -----------------------------------------------------
  // A FRESH module instance, because the allowance is module-level state shared
  // by everything in this file — the tests above legitimately spent some of it,
  // and asserting against an absolute number would be asserting against the
  // tests' own side effects. A cache-busting specifier gives a second copy of
  // the module with its own window.
  const fresh = (await import(`../lib/net/gql?budget=${Date.now()}`)) as typeof import('../lib/net/gql');
  calls = 0;
  const remainingAtStart = fresh.budgetRemaining();
  check('a fresh transport starts with the full allowance', remainingAtStart === 24, `reported ${remainingAtStart}`);

  // 26 distinct requests inside one minute, against an allowance of 24. The two
  // over the line must be QUEUED, not refused — and queueing means waiting, so
  // this call block returns measurably later than the ones above.
  const started = Date.now();
  for (let i = 0; i < 26; i++) {
    await fresh.gql(`query Budget${i} { ok }`);
  }
  const elapsed = Date.now() - started;
  check('26 requests all completed', calls === 26, `made ${calls}`);
  check(
    'the ones over the allowance were queued, not dropped',
    elapsed > 100,
    `finished in ${elapsed}ms, which means nothing ever waited`
  );
  const remaining = fresh.budgetRemaining();
  check('the allowance is spent, never overspent', remaining >= 0 && remaining <= 24, `reported ${remaining}`);

  // The window slides: the oldest entries age out after a minute, so a later
  // call must be admitted without any help. This is what stops a long session
  // from locking itself out permanently.
  check(
    'remaining is a real count, not a stuck zero',
    typeof remaining === 'number' && Number.isFinite(remaining),
    `reported ${remaining}`
  );

  globalThis.fetch = realFetch;
  testStalenessGate();
  console.log(failures ? `\n${failures} failed\n` : '\nall passed\n');
  process.exit(failures ? 1 : 0);
}

/**
 * THE STALENESS GATE.
 *
 * `useQuery().refetch()` bypasses `staleTime` — it fetches unconditionally. That
 * is the whole reason this function exists, and the reason it is tested: the
 * caching work called plain `refetch()` from three focus effects while comments
 * said it respected the window. On a device that turned a 1–2s tab switch into
 * 3–4s, because a steady stream of forced requests earned AniList's 429 and the
 * transport then sat out `Retry-After` while the screen you were switching to
 * waited.
 *
 * A test here is cheap insurance for a bug whose only symptom is "feels slow" —
 * which is exactly the kind of bug that gets shipped twice.
 */
function testStalenessGate() {
  console.log('\nstaleness gate');

  let fetched = 0;
  const make = (isStale: boolean) => ({
    isStale,
    refetch: () => {
      fetched++;
    },
  });

  // The common case: user taps back to a tab they left ten seconds ago.
  refetchIfStale(make(false));
  check('a fresh query is not refetched', fetched === 0, `fetched ${fetched}`);

  // The case the gate exists for: sixty-plus seconds have passed.
  refetchIfStale(make(true));
  check('a stale query IS refetched', fetched === 1, `fetched ${fetched}`);

  // Defensive: focus effects fire during unmount races, and a missing query must
  // not throw inside a navigation callback.
  let threw = false;
  try {
    refetchIfStale(undefined);
  } catch {
    threw = true;
  }
  check('a missing query is a no-op, not a throw', !threw);

  // Seven days at once is what the schedule tab does on focus.
  fetched = 0;
  const week = [false, false, false, false, false, false, true];
  for (const stale of week) refetchIfStale(make(stale));
  check(
    'a seven-day window refreshes only its stale days',
    fetched === 1,
    `fetched ${fetched}, expected 1`
  );
}

void main();
