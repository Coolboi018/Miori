/**
 * The return trip, driven as the REAL modules.
 *
 * Three regressions are pinned here, all from the 21 Nov device report:
 *
 *   1. `lib/player/resolveCache.ts` — going back to the details page and
 *      returning to the same episode must not pay for a second full resolve.
 *      The rules worth pinning are the ones that make a cache safe: it expires
 *      (signed URLs die), it is per-EPISODE, it is bounded, and a drop leaves
 *      nothing behind for the next visit.
 *
 *   2. `lib/player/sourcePref.ts` (`pickStartIndex`) — the source that actually
 *      PLAYED outranks the user's default setting. The default is a guess from
 *      Settings; the per-anime memory is proof from minutes ago. The default
 *      still decides when there is no memory, and still falls through when
 *      nobody can honour it.
 *
 *   3. `lib/subtitles/cueCache.ts` + `lib/subtitles/clock.ts` — the SUBTITLE
 *      half of the same trip. A reload hands the cue effect a fresh `tracks`
 *      array, so it used to re-download and re-parse the same .vtt ("subs take
 *      time to sync back"), and a sampler looking up a cue at the placeholder
 *      0 painted the opening line over a resumed frame. The cache is pinned
 *      for the rules that make it safe — one download per URL, no empty or
 *      failed answer remembered — and the clock for the one rule four
 *      samplers share.
 *
 * Run with:  npx tsx scripts/check-replay.ts
 */

import {
  CACHE_MAX_ENTRIES,
  CACHE_TTL_MS,
  clearResolveCache,
  dropResolveCache,
  readResolveCache,
  resolveCacheSize,
  writeResolveCache,
} from '../lib/player/resolveCache';
import { pickStartIndex } from '../lib/player/sourcePref';
import {
  CUE_CACHE_MAX,
  clearCueCache,
  cueCacheSize,
  cueLoad,
  readCueCache,
  writeCueCache,
} from '../lib/subtitles/cueCache';
import { PLACEHOLDER_PLAYHEAD_S, cueLookupTime } from '../lib/subtitles/clock';
import type { Cue } from '../lib/subtitles/vtt';
import type { WatchSource } from '../lib/extensions/types';

let pass = 0;
let fail = 0;

function check(name: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass += 1;
  else {
    fail += 1;
    console.error(`  ✗ ${name}\n      got:  ${JSON.stringify(got)}\n      want: ${JSON.stringify(want)}`);
  }
}

function section(title: string): void {
  console.log(`\n${title}`);
}

const row = (url: string, extId: string): WatchSource => ({
  url,
  container: 'hls',
  extId,
});

const T0 = 1_000_000;

section('1. A resolve is reused inside its window — the return trip is instant');

{
  clearResolveCache();
  const sources = [row('https://a/1.m3u8', 'filmu'), row('https://b/1.m3u8', 'mega')];
  writeResolveCache(7, 3, sources, [{ id: 'zoko', reason: 'no mapping' }], T0);

  const hit = readResolveCache(7, 3, T0 + 60_000);
  check('a hit returns the same rows', hit?.sources, sources);
  check('a hit keeps the failed list', hit?.failed, [{ id: 'zoko', reason: 'no mapping' }]);
  check(
    'the same episode one second before the TTL is still a hit',
    readResolveCache(7, 3, T0 + CACHE_TTL_MS) != null,
    true
  );
}

section('2. The TTL is enforced — a signed URL does not outlive its window');

{
  clearResolveCache();
  writeResolveCache(7, 3, [row('https://a/1.m3u8', 'filmu')], [], T0);
  check(
    'one millisecond past the TTL is a miss',
    readResolveCache(7, 3, T0 + CACHE_TTL_MS + 1),
    null
  );
  check('an expired entry is dropped, not kept', resolveCacheSize(), 0);
}

section('3. The unit is the episode');

{
  clearResolveCache();
  writeResolveCache(7, 3, [row('https://a/3.m3u8', 'filmu')], [], T0);
  writeResolveCache(7, 4, [row('https://a/4.m3u8', 'mega')], [], T0);
  check(
    'episode 4 does not answer episode 3',
    readResolveCache(7, 3, T0)?.sources[0].url,
    'https://a/3.m3u8'
  );
  check(
    'another anime does not answer either',
    readResolveCache(8, 3, T0),
    null
  );
  check('the same episode writes a replacement, not a second row', resolveCacheSize(), 2);
  writeResolveCache(7, 3, [row('https://a/3b.m3u8', 'filmu')], [], T0 + 5);
  check(
    'the newest resolve wins',
    readResolveCache(7, 3, T0 + 6)?.sources[0].url,
    'https://a/3b.m3u8'
  );
  check('replacement did not grow the store', resolveCacheSize(), 2);
}

section('4. Bounded, and a bad list can be dropped');

{
  clearResolveCache();
  for (let ep = 1; ep <= CACHE_MAX_ENTRIES; ep++) {
    writeResolveCache(1, ep, [row(`https://a/${ep}.m3u8`, 'filmu')], [], T0 + ep);
  }
  check('the store stops at its cap', resolveCacheSize(), CACHE_MAX_ENTRIES);
  // Touch episode 1 so the next insert evicts episode 2 instead.
  readResolveCache(1, 1, T0 + 100);
  writeResolveCache(1, CACHE_MAX_ENTRIES + 1, [row('https://a/x.m3u8', 'mega')], [], T0 + 200);
  check('the least recently USED entry is evicted', readResolveCache(1, 2, T0 + 201), null);
  check('a touched entry survives', readResolveCache(1, 1, T0 + 201) != null, true);

  dropResolveCache(1, 1);
  check('a dropped episode is a miss', readResolveCache(1, 1, T0 + 202), null);

  writeResolveCache(1, 99, [], [], T0 + 203);
  check('an empty resolve is not cached (nothing to play)', readResolveCache(1, 99, T0 + 204), null);

  writeResolveCache(NaN, 1, [row('https://a/n.m3u8', 'filmu')], [], T0);
  check('a NaN route param is never a key', readResolveCache(NaN, 1, T0), null);
}

section('5. The PROVEN source outranks the stated default');

{
  // The resolve's real shape: registry order (filmu first), several rows each.
  const ranked = [
    { extId: 'filmu', quality: '1080p' },
    { extId: 'filmu', quality: '720p' },
    { extId: 'mega', quality: 'Auto' },
    { extId: 'anikoto', quality: 'HD-1' },
  ];

  // THE OLD SHAPE, watched failing: the default was checked first, so the
  // viewer's default (filmu) beat the mega that had just played.
  const oldShape = (
    sources: typeof ranked,
    pref: string | null,
    def?: string | null
  ) => {
    if (def && def !== 'auto') {
      const i = sources.findIndex((s) => s.extId === def);
      if (i >= 0) return i;
    }
    if (!pref) return 0;
    const i = sources.findIndex((s) => s.extId === pref);
    return i >= 0 ? i : 0;
  };

  check(
    'old shape: default filmu starts at filmu though mega just played — WRONG, watched failing',
    oldShape(ranked, 'mega', 'filmu'),
    0
  );
  check(
    'real rule: the source that actually played starts the walk',
    pickStartIndex(ranked, 'mega', 'filmu'),
    2
  );
  check(
    'the proven source starts at its FIRST row, not an exact quality row',
    pickStartIndex(ranked, 'anikoto', 'filmu'),
    3
  );
  check(
    'no memory: the stated default decides, as it always did',
    pickStartIndex(ranked, null, 'mega'),
    2
  );
  check(
    "'auto' is not a default — it is the absence of one",
    pickStartIndex(ranked, null, 'auto'),
    0
  );
  check(
    'a memory the resolve cannot honour falls through to the default',
    pickStartIndex(ranked, 'gone', 'mega'),
    2
  );
  check(
    'a memory AND a default nobody can honour → ranked top, never lose the episode',
    pickStartIndex(ranked, 'gone', 'also-gone'),
    0
  );
  check(
    'no memory, no default → ranked top (the old behaviour)',
    pickStartIndex(ranked, null),
    0
  );
  check('an empty list is 0, never NaN', pickStartIndex([], 'mega', 'filmu'), 0);
}

section('6. Subtitles survive the trip without a re-download');

const cue: Cue[] = [{ start: 0, end: 2, text: 'hello' }];

async function cueCacheChecks(): Promise<void> {
  clearCueCache();
  let downloads = 0;
  const load = () => {
    downloads += 1;
    return Promise.resolve(cue);
  };

  const first = await cueLoad('https://x/a.vtt', load);
  const second = await cueLoad('https://x/a.vtt', load);
  check('one URL is downloaded once, not once per source reload', downloads, 1);
  check('the second caller gets the SAME parsed list', second === first, true);
  check('the hit is the cached entry', readCueCache('https://x/a.vtt') === first, true);

  await cueLoad('https://x/b.vtt', load);
  check('a different track URL is its own download', downloads, 2);

  // Two callers inside one tick — a source switch landing on the same
  // extension, or a track pick during a reload. They must share one request.
  clearCueCache();
  let started = 0;
  let release: (v: Cue[]) => void = () => {};
  const deferred = new Promise<Cue[]>((resolve) => {
    release = resolve;
  });
  const p1 = cueLoad('https://x/slow.vtt', () => {
    started += 1;
    return deferred;
  });
  const p2 = cueLoad('https://x/slow.vtt', () => {
    started += 1;
    return Promise.resolve(cue);
  });
  // `cueLoad` defers the loader by one microtask (so a synchronous throw cannot
  // escape as a non-promise) — let the first download actually start.
  await Promise.resolve();
  check('a second caller JOINS the in-flight download', started, 1);
  check('...and is handed the same promise', p1 === p2, true);
  release(cue);
  check('...both resolve with the parsed list', (await p1) === cue, true);

  clearCueCache();
  await cueLoad('https://x/empty.vtt', () => Promise.resolve([]));
  check('an empty parse is NOT cached — one bad download must not be permanent', readCueCache('https://x/empty.vtt'), null);

  clearCueCache();
  let attempts = 0;
  // NOT named `fail` — that is the module's failure counter, and a local of the
  // same name makes the summary line add a function to a number.
  const failingLoad = () => {
    attempts += 1;
    return Promise.reject(new Error('404'));
  };
  await cueLoad('https://x/bad.vtt', failingLoad).catch(() => {});
  await cueLoad('https://x/bad.vtt', failingLoad).catch(() => {});
  check('a failed download is retried, not remembered', attempts, 2);

  clearCueCache();
  for (let i = 0; i < CUE_CACHE_MAX + 1; i++) {
    writeCueCache(`https://x/${i}.vtt`, cue);
  }
  check('the cue cache is bounded', cueCacheSize(), CUE_CACHE_MAX);
  check('the least recently used track is the one evicted', readCueCache('https://x/0.vtt'), null);
  check('the newest track is still there', readCueCache(`https://x/${CUE_CACHE_MAX}.vtt`) === cue, true);

  section('7. The subtitle clock: a placeholder is not a time');

  check('a real playhead is looked up as-is', cueLookupTime(300, false), 300);
  check('a restored playhead is looked up as-is once the seek has landed', cueLookupTime(300, true), 300);
  check('0 under an ARMED restore shows NO line (the opening-line flash)', cueLookupTime(0, true), null);
  check(
    'the placeholder window ends at PLACEHOLDER_PLAYHEAD_S',
    cueLookupTime(PLACEHOLDER_PLAYHEAD_S, true),
    PLACEHOLDER_PLAYHEAD_S
  );
  check('0 with nothing to restore is the start of the episode, not a placeholder', cueLookupTime(0, false), 0);
  check('a NaN playhead shows nothing rather than looking up NaN', cueLookupTime(NaN, false), null);
  check('a negative playhead shows nothing', cueLookupTime(-0.5, false), null);

  clearCueCache();
  console.log(`\n${pass}/${pass + fail} checks passed`);
  if (fail > 0) process.exit(1);
}

void cueCacheChecks();
