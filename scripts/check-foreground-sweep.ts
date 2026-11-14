// Resume-sweep request accounting.
//
// Run: npx tsx scripts/check-foreground-sweep.ts
//
// Drives the REAL `refetchStaleOnForeground` against the REAL query client with
// stub query functions, so what is counted is the number of fetches the module
// actually issues — not what a reimplementation of its rules would issue.
//
// A NOTE ON HOW "STALE" IS SET UP HERE. `Query.isStale()` in query-core 5.104 is
// `observers.some(isStale)` when a query has observers and
// `data === undefined || isInvalidated` when it has none — so an unmounted
// query whose `staleTime` expired is NOT stale. The cases below therefore mark
// queries invalidated (`invalidateQueries({ refetchType: 'none' })`), which is
// the state that actually puts them in `findAll({ stale: true })` and therefore
// the state the sweep has to get right.
//
// Mutation-tested 14 Nov: remove the observer filter in `lib/query/client.ts`
// and case 3 fails with `calls=1`.
//
// The IDLE filter cannot be discriminated from out here, and that is a fact
// about the library rather than a gap in the harness: `isStale()` already
// reports false for a never-asked query, so it never reaches `findAll`. Case 2
// therefore pins the OUTCOME (never asked → never fetched), which is the thing
// that must stay true, not the line that currently produces it.

import { QueryObserver } from '@tanstack/react-query';
import { queryClient, refetchStaleOnForeground } from '../lib/query/client';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

let failed = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) {
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

interface Probe {
  readonly calls: number;
  reset: () => void;
}

interface ProbeOptions {
  enabled?: boolean;
  fail?: boolean;
  delayMs?: number;
  onStart?: () => void;
  onEnd?: () => void;
}

/** A subscribed query whose fetches are counted. */
function probe(key: readonly unknown[], opts: ProbeOptions = {}): Probe {
  const state = { calls: 0 };
  const observer = new QueryObserver(queryClient, {
    queryKey: key,
    staleTime: 0,
    gcTime: Infinity,
    retry: false,
    enabled: opts.enabled ?? true,
    queryFn: async () => {
      state.calls += 1;
      opts.onStart?.();
      try {
        if (opts.delayMs) await sleep(opts.delayMs);
        if (opts.fail) throw new Error('probe failure');
        return { ok: true };
      } finally {
        opts.onEnd?.();
      }
    },
  });
  // No keep-alive array: a subscribed observer is referenced by its query, and
  // the query lives in the client's cache, so it cannot be collected mid-run.
  observer.subscribe(() => {});
  return {
    get calls() {
      return state.calls;
    },
    reset: () => {
      state.calls = 0;
    },
  };
}

/** Put a query in the state `findAll({ stale: true })` reports — without fetching. */
async function markStale(key: readonly unknown[]) {
  await queryClient.invalidateQueries({ queryKey: key, exact: true, refetchType: 'none' });
}

async function main() {
  queryClient.clear();

  // ---- 1. the ordinary case: a mounted screen refreshes on resume ----------
  const mounted = probe(['probe', 'mounted']);
  await sleep(30);
  check('a mounted query fetches once on its own mount', mounted.calls === 1, `calls=${mounted.calls}`);

  await markStale(['probe', 'mounted']);
  mounted.reset();
  await refetchStaleOnForeground();
  check('a mounted, stale query IS refreshed on resume', mounted.calls === 1, `calls=${mounted.calls}`);

  // ---- 2. the query nobody has asked for ----------------------------------
  // `enabled: false` is exactly what `useAiringDay(day, { enabled: asked.has(day) })`
  // does for the six days the user has not gone near.
  const deferred = probe(['probe', 'deferred'], { enabled: false });
  await sleep(20);
  check('a disabled query does not fetch on subscribe', deferred.calls === 0, `calls=${deferred.calls}`);

  await markStale(['probe', 'deferred']);
  await refetchStaleOnForeground();
  check(
    'a query nobody asked for is NOT force-fetched on resume',
    deferred.calls === 0,
    `calls=${deferred.calls} (fetch() ignores enabled, so isStale() is what keeps it out)`
  );

  // ---- 3. the thirty-minute cache ----------------------------------------
  const unmounted = { calls: 0 };
  await queryClient.fetchQuery({
    queryKey: ['probe', 'unmounted'],
    staleTime: 0,
    queryFn: async () => {
      unmounted.calls += 1;
      return { ok: true };
    },
  });
  await markStale(['probe', 'unmounted']);
  unmounted.calls = 0;
  await refetchStaleOnForeground();
  check(
    'an unmounted, invalidated query is not refetched on resume',
    unmounted.calls === 0,
    `calls=${unmounted.calls}`
  );

  // ---- 4. errors still get their retry ------------------------------------
  const failing = probe(['probe', 'failing'], { fail: true });
  await sleep(30);
  check('a failing query is attempted once on mount', failing.calls === 1, `calls=${failing.calls}`);

  await markStale(['probe', 'failing']);
  failing.reset();
  await refetchStaleOnForeground();
  check('an errored query is still retried on resume', failing.calls === 1, `calls=${failing.calls}`);

  // ---- 5. the burst is batched -------------------------------------------
  let inFlight = 0;
  let peak = 0;
  const burst = Array.from({ length: 6 }, (_, i) =>
    probe(['probe', 'burst', i], {
      delayMs: 20,
      onStart: () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
      },
      onEnd: () => {
        inFlight -= 1;
      },
    })
  );
  await sleep(160);
  // The initial mounts fired together; only the sweep's shape is under test.
  peak = 0;
  inFlight = 0;
  for (let i = 0; i < burst.length; i += 1) await markStale(['probe', 'burst', i]);
  burst.forEach((p) => p.reset());

  await refetchStaleOnForeground();
  check('the resume sweep runs at most 3 requests at a time', peak <= 3 && peak > 0, `peak=${peak}`);
  check(
    'every stale mounted query is still refreshed',
    burst.every((p) => p.calls === 1),
    `calls=${burst.map((p) => p.calls).join(',')}`
  );

  console.log(failed === 0 ? '\nsweep: OK' : `\nsweep: ${failed} failing`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
