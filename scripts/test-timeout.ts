/**
 * Smoke test for the extensions' fetch deadline.
 *
 *   THE TIMEOUT COVERS THE BODY, NOT JUST THE HEADERS.
 *
 * This one property was got wrong once and cost a hang rather than an error:
 * `fetch` settles when response headers arrive, so a helper that armed an
 * AbortController, returned the `Response`, and cleared the timer in a `finally`
 * had already disarmed the deadline by the time every caller ran its own
 * `await res.text()`. The timeout covered connect + headers and nothing else, and
 * a CDN that accepted the connection and then stalled mid-body never settled at
 * all — no throw, no spinner stop, app stuck on "Resolving episode 3…".
 *
 * A bug whose only symptom is "hangs on a bad network" is exactly the kind that
 * gets shipped twice, because the happy path passes every manual test. So it gets
 * a test that reproduces the stall with a fake `fetch` and no network, no device
 * and no simulator — the shape of failure the fake has to model faithfully is
 * stated in `sleepOrAbort` below, because if the fake ignores the abort signal
 * this test would itself hang instead of failing.
 *
 * Run with:  npx tsx scripts/test-timeout.ts
 */

import { fetchJson, fetchText, fetchTimed, probeHls } from '../lib/extensions/fetch';

const realFetch = globalThis.fetch;

let failures = 0;
function check(name: string, pass: boolean, detail = '') {
  if (pass) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/**
 * What a stalled body has to do to reproduce the real bug: react to the abort.
 * A fake that simply never settles would make this test hang rather than fail,
 * which would be worse than no test.
 */
function sleepOrAbort(ms: number, signal: AbortSignal | null | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      const e = new Error('The operation was aborted.');
      e.name = 'AbortError';
      reject(e);
    };
    const timer = setTimeout(resolve, ms);
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener('abort', abort, { once: true });
  });
}

type BodyMode =
  /** Body is there immediately. */
  | 'instant'
  /** Headers now, body after `delay`. */
  | 'slow'
  /** Headers now, body never. THE BUG. */
  | 'never';

let mode: BodyMode = 'instant';
let body = '';
let status = 200;
let delay = 60_000;

/** A `fetch` that reports headers immediately and the body on `mode`. */
function installFetch() {
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const signal = init?.signal ?? undefined;
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => {
        if (mode === 'instant') return body;
        await sleepOrAbort(mode === 'slow' ? delay : 60_000, signal);
        return body;
      },
    } as unknown as Response;
  }) as typeof fetch;
}

/** Rejects with the message, or returns `undefined`. Never throws. */
async function failure(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

const MASTER = [
  '#EXTM3U',
  '#EXT-X-STREAM-INF:BANDWIDTH=1200000,RESOLUTION=1920x1080',
  'https://cdn.test/1080.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=600000,RESOLUTION=1280x720',
  'https://cdn.test/720.m3u8',
].join('\n');

const VARIANT = ['#EXTM3U', '#EXTINF:4.0,', 'https://cdn.test/seg1.ts'].join('\n');

async function main() {
  installFetch();
  console.log('\nextension fetch timeout');

  // --- 1. the body is inside the deadline -------------------------------
  // Headers arrive at once, the body never does. This is the stall the old
  // helper let through: it had already returned and cleared the timer.
  mode = 'never';
  let started = Date.now();
  let msg = await failure(fetchText('https://cdn.test/master.m3u8', 300));
  let elapsed = Date.now() - started;
  check(
    'a body that never arrives is cut off at the deadline',
    msg !== undefined,
    `settled with ${JSON.stringify(msg)}`
  );
  check(
    '…and it waited for the deadline rather than failing instantly',
    elapsed >= 250,
    `returned after ${elapsed}ms`
  );
  check(
    '…and it did not overshoot into a hang',
    elapsed < 2000,
    `returned after ${elapsed}ms`
  );
  check('the timeout names the host and the budget', /timed out after 300ms/.test(msg ?? ''), msg ?? 'no message');

  // Same stall, through JSON — which is what every real call site does.
  msg = await failure(fetchJson('https://cdn.test/api', 250));
  check('fetchJson is covered too', /timed out after 250ms/.test(msg ?? ''), msg ?? 'no message');

  // And through the low-level primitive the probe uses.
  msg = await failure(fetchTimed('https://cdn.test/master.m3u8', 250, undefined, 'probe'));
  check('fetchTimed is covered too', /probe timed out after 250ms/.test(msg ?? ''), msg ?? 'no message');

  // --- 2. a body that is merely slow is not cut off ---------------------
  mode = 'slow';
  delay = 40;
  body = '{"ok":true}';
  status = 200;
  // Awaited directly, not through `failure` — a slow body must SUCCEED, so the
  // assertion is that nothing is thrown, not that a message comes back.
  let resolved: { ok: boolean } | undefined;
  let threw: string | undefined;
  try {
    resolved = await fetchJson<{ ok: boolean }>('https://cdn.test/slow', 1000);
  } catch (e) {
    threw = e instanceof Error ? e.message : String(e);
  }
  check('a slow-but-finite body still resolves', !!resolved, threw ?? '');
  check(
    '…and the body is parsed, not swallowed',
    resolved?.ok === true,
    `got ${JSON.stringify(resolved)}`
  );

  // --- 3. a real failure still reports the status -----------------------
  // The call sites' hand-written messages (`FilmU token HTTP 500`) came from
  // these throws, so the label has to survive the move into the helper.
  status = 503;
  body = 'upstream is down';
  msg = await failure(fetchText('https://cdn.test/x', 1000, undefined, 'MegaPlay page'));
  check('a non-2xx names the label and the status', msg === 'MegaPlay page HTTP 503', String(msg));
  check(
    'a non-2xx is not reported as a timeout',
    !/timed out/.test(msg ?? ''),
    String(msg)
  );

  // The timeout must not mask an HTTP error that arrives inside the budget:
  // the status is checked before the deadline matters.
  msg = await failure(fetchJson('https://cdn.test/x', 1000, undefined, 'FilmU token'));
  check('fetchJson reports the status the same way', msg === 'FilmU token HTTP 503', String(msg));

  // --- 4. probeHls: doubt, not a hang, and verdicts unchanged ----------
  mode = 'never';
  started = Date.now();
  const stalled = await probeHls('https://cdn.test/master.m3u8', {});
  elapsed = Date.now() - started;
  check('probeHls does not hang on a stalled body', elapsed < 12_000, `took ${elapsed}ms`);
  check(
    '…and keeps the source on doubt',
    stalled.alive && !stalled.video,
    JSON.stringify(stalled)
  );

  // A non-2xx master is a VERDICT, not an exception: it must still drop. This
  // is why the probe uses `fetchTimed` rather than `fetchText` — a 403 routed
  // through `fetchText` would throw, land in the catch, and survive.
  mode = 'instant';
  status = 404;
  const gone = await probeHls('https://cdn.test/master.m3u8', {});
  check('a non-2xx master is still reported dead', !gone.alive, JSON.stringify(gone));

  // Not a playlist at all — also dead, which is what §2's probe fix removes for
  // mp4 sources. Asserted here so the probe's real contract stays pinned.
  status = 200;
  body = '\x00\x00\x00 ftypisom mp42';
  const notPlaylist = await probeHls('https://cdn.test/video.mp4', {});
  check('a non-playlist body is still reported dead', !notPlaylist.alive, JSON.stringify(notPlaylist));

  // A genuine master is alive. Its variant fetch gets the same body from this
  // stub, and a master lists only playlists, not segments — so `video` is
  // legitimately unverified here. The two-stage path is exercised just below.
  status = 200;
  body = MASTER;
  const good = await probeHls('https://cdn.test/master.m3u8', {});
  check('a real master is alive', good.alive, JSON.stringify(good));
  check(
    '…but segments are unverified when only the master was served',
    !good.video,
    'claimed verified video from a master that lists no segments'
  );

  // Serve the variant as well, so the second stage really runs. The probe reads
  // the FIRST `.m3u8` line of the master, which is the 1080p one.
  globalThis.fetch = (async (url: string) => {
    return {
      ok: true,
      status: 200,
      text: async () => (String(url).endsWith('1080.m3u8') ? VARIANT : MASTER),
    } as unknown as Response;
  }) as typeof fetch;
  const withVariant = await probeHls('https://cdn.test/master.m3u8', {});
  check(
    'a master whose variant lists .ts segments verifies as video',
    withVariant.alive && withVariant.video,
    JSON.stringify(withVariant)
  );

  globalThis.fetch = realFetch;
  console.log(failures ? `\n${failures} failed\n` : '\nall passed\n');
  process.exit(failures ? 1 : 0);
}

void main();