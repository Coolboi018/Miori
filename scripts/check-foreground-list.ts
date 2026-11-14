/**
 * The user's list must be force-refreshed on every return to the foreground.
 *
 * `refetchStaleOnForeground` deliberately sits behind `staleTime`: a resume
 * into a screen refetches only what went stale, and not one request more —
 * that restraint is what keeps a restless foreground from earning AniList's
 * 429. But the user's LIST is the one slice of the cache another device
 * writes: a rate change made on the web must not wait out five minutes of
 * `staleTime` just because the entries were fetched recently. So the fix is a
 * `staleTime`-bypassing refresh, scoped TIGHTLY to the list slice:
 *
 *   - `['home', userId, …]` — the user's own rails — fetched ALWAYS.
 *   - `['home', 'anon', …]` — the guest rails are public data. Exactly the
 *     case the sweep's restraint exists for; fetching one of these on every
 *     foreground would re-introduce the forced-request storm with a comment
 *     claiming it was a fix (`scripts/test-transport.ts` covers anon keys
 *     elsewhere; this check covers the foreground rule).
 *   - `['listEntry', id]` — fetched only when it has an OBSERVER. An entry
 *     nobody is looking at must not cost a per-media request; the next mount
 *     refetches under its own rules.
 *   - `['viewer']` — unkeyed, dropped at sign-out, so present ⇒ session.
 *
 * This runs the REAL `refreshUserListOnForeground` against a real
 * `QueryClient` — the filters being pinned are the kind that silently rot
 * into "refetch everything" or "refetch nothing" without any type error or
 * lint complaint.
 *
 * Run with:  npx tsx scripts/check-foreground-list.ts
 */
import { QueryObserver } from '@tanstack/react-query';

import { queryClient, refreshUserListOnForeground, refetchStaleOnForeground } from '../lib/query/client';

let failures = 0;
function check(name: string, pass: boolean, detail = '') {
  if (pass) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Zeroes the counters between the setup fetches and the decision under test. */
const counts: Record<string, number> = {};

function settle() {
  // Observers settle long before we ask anything of the counters; 30ms is
  // generous for fetchFns that resolve synchronously.
  return sleep(30);
}

async function main() {
  const make = (name: string, key: readonly unknown[], value: string, staleTime: number) => {
    // The observer is kept subscribed for the whole battery (unsubscribed
    // entries have a dedicated case below). staleTime pins the staleness the
    // sweep would apply; `refreshUserListOnForeground` must ignore it.
    const obs = new QueryObserver(queryClient, {
      queryKey: [...key],
      queryFn: () => {
        counts[name] = (counts[name] ?? 0) + 1;
        return value;
      },
      staleTime,
    });
    obs.subscribe(() => undefined);
    return obs;
  };

  const home = make('home', ['home', 42, '10'], 'H', Infinity);
  const anonHome = make('anon', ['home', 'anon', '10'], 'A', Infinity);
  const media = make('media', ['media', 7], 'M', Infinity);
  const entry = make('entry', ['listEntry', 9], 'E', Infinity);
  const viewer = make('viewer', ['viewer'], 'V', Infinity);
  // An entry with an observer that was then REMOVED before the refresh ran —
  // the mount/unmount shape (detail page scrolled past, sheet closed).
  const gone = make('gone', ['listEntry', 11], 'G', Infinity);
  gone.destroy();

  await settle(); // absorbs the subscribe-time first fetches
  Object.keys(counts).forEach((k) => (counts[k] = 0));

  await refreshUserListOnForeground();
  await settle();

  check(
    'the user-keyed home rails are force-fetched despite a fresh cache',
    counts.home === 1,
    `fetched ${counts.home ?? 0}× — the list slice did not bypass staleTime`
  );
  check(
    'the guest rails (home/anon) are NOT force-fetched',
    !counts.anon,
    `fetched ${counts.anon ?? 0}× — the forced-refresh re-introduced the forced-request storm`
  );
  check(
    'a mounted listEntry is force-fetched',
    counts.entry === 1,
    `fetched ${counts.entry ?? 0}×`
  );
  check(
    'an UNMOUNTED listEntry is left alone',
    !counts.gone,
    `fetched ${counts.gone ?? 0}× — a burst of per-media requests on every foreground`
  );
  check(
    '`viewer` is force-fetched',
    counts.viewer === 1,
    `fetched ${counts.viewer ?? 0}×`
  );
  check(
    'public media detail is NOT part of the list slice',
    !counts.media,
    `fetched ${counts.media ?? 0}× — the slice leaked into generic content`
  );

  // The pairing rule: after the force-refresh everything just re-fetched is
  // FRESH, so the steady-state sweep that follows must fetch nothing — the
  // forced refresh renders the sweep a no-op for these keys rather than a
  // doubling of them.
  await refetchStaleOnForeground();
  await settle();
  check(
    'the stale sweep does not re-fetch what the list refresh just covered',
    counts.home === 1 && counts.entry === 1 && counts.viewer === 1,
    JSON.stringify(counts)
  );

  home.destroy();
  anonHome.destroy();
  media.destroy();
  entry.destroy();
  viewer.destroy();
  queryClient.clear();

  console.log(failures ? `\n${failures} failed\n` : '\nall passed\n');
  process.exit(failures ? 1 : 0);
}

void main();
