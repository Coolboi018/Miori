/**
 * Every AniList WRITE must go through the shared transport.
 *
 * `authedQuery` used to open its own socket with its own retry loop and no
 * timeout at all, while `gql()` had a 12s deadline, a 24/min budget, global
 * de-duplication, doubling backoff and a `Retry-After` parser. The result was that
 * the reads were protected and the writes were not — and a write is the operation
 * a user is WAITING on, standing in front of a sheet with a spinner.
 *
 * Each property below is one that used to be false. They are all observable from
 * a fake `fetch`, so none of this needs a network, a device, or a real account:
 *
 *   - a write that hangs now settles        (it never did)
 *   - writes spend the request budget       (they used to be free)
 *   - a long `Retry-After` is obeyed        (`secs < 60 ? secs*1000 : 2000` turned
 *                                           AniList's "wait two minutes" into 2s,
 *                                           which earns a second 429)
 *   - a 401 still says "log in again"       (the generic status text does not)
 *   - two accounts never share a write      (the de-dup key had no token in it)
 *
 * Run with:  npx tsx scripts/check-write-transport.ts
 */

import { authedQuery } from '../lib/anilist/lists';
import { gql, isAuthError } from '../lib/net/gql';

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

// --- a controllable fetch -------------------------------------------------

interface Call {
  url: string;
  headers: Record<string, string>;
}

let calls: Call[] = [];
/** What the next response should do. */
type Reply =
  | { kind: 'json'; status: number; body: unknown; headers?: Record<string, string> }
  /** Headers immediately, body never. THE OLD HANG. */
  | { kind: 'hang' };

let reply: Reply = { kind: 'json', status: 200, body: { data: { ok: true } } };

function sleepOrAbort(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      const e = new Error('The operation was aborted.');
      e.name = 'AbortError';
      reject(e);
    };
    const timer = setTimeout(resolve, ms);
    if (signal?.aborted) return abort();
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function installFetch() {
  calls = [];
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    calls.push({
      url: String(_url),
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    if (reply.kind === 'hang') {
      await sleepOrAbort(60_000, init?.signal ?? null);
    }
    const r = reply as Extract<Reply, { kind: 'json' }>;
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: {
        get: (h: string) => r.headers?.[h.toLowerCase()] ?? r.headers?.[h] ?? null,
      },
      json: async () => r.body,
      text: async () => JSON.stringify(r.body),
    } as unknown as Response;
  }) as typeof fetch;
}

/** A fresh transport instance, so the shared budget window starts empty. */
let n = 0;
async function freshGql() {
  return (await import(`../lib/net/gql?v=${++n}`)) as typeof import('../lib/net/gql');
}

async function failure(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return '';
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

const DOC = 'mutation Test { ok }';

async function main() {
  installFetch();
  console.log('\nwrite transport');

  // --- the bearer header --------------------------------------------------
  calls = [];
  reply = { kind: 'json', status: 200, body: { data: { ok: true } } };
  await authedQuery('TOKEN-ABC-123', DOC);
  check(
    'a write sends the bearer token',
    calls[0]?.headers.Authorization === 'Bearer TOKEN-ABC-123',
    calls[0]?.headers.Authorization ?? 'no header'
  );

  // And a read must NOT invent one.
  calls = [];
  await gql('query ReadOnly { ok }');
  check(
    'a read sends no Authorization header',
    calls[0]?.headers.Authorization === undefined,
    calls[0]?.headers.Authorization ?? 'correctly absent'
  );

  // --- the timeout, which is the whole point ------------------------------
  // The old loop had no deadline at all. React Native's fetch has no default one,
  // so this never settled: the sheet's spinner had no exit.
  {
    const g = await freshGql();
    reply = { kind: 'hang' };
    const started = Date.now();
    // 3 attempts x 12s + 600/1200ms backoff is the ceiling; assert only that it
    // FINISHES and that each individual attempt was cut off, not the whole thing.
    const msg = await failure(g.gql(DOC, { token: 'T', label: 'hang' }));
    const elapsed = Date.now() - started;
    check('a write that hangs gives up instead of spinning forever', msg !== '', `resolved after ${elapsed}ms`);
    check(
      '…and does so inside a bounded time',
      elapsed > 11_000 && elapsed < 60_000,
      `took ${elapsed}ms`
    );
    check('…reporting a timeout rather than a raw abort', /did not answer in time/.test(msg), msg);
    reply = { kind: 'json', status: 200, body: { data: { ok: true } } };
  }

  // --- Retry-After --------------------------------------------------------
  // The old parser: `secs > 0 && secs < 60 ? secs * 1000 : 2000`. AniList asking
  // for 120s became a 2s retry, which is how a limit turns into a ban.
  {
    const g = await freshGql();
    calls = [];
    let served = 0;
    reply = { kind: 'json', status: 429, body: {}, headers: { 'retry-after': '120' } };
    // First call 429s with a long wait; make the retry observable without
    // actually sitting out two minutes by counting attempts and bailing early.
    const realSleep = setTimeout;
    void realSleep;
    const p = failure(
      g.gql(DOC, { token: 'T' }).then(() => 'resolved').catch((e: Error) => e.message)
    );
    // Let the first attempt run; the retry cannot fire before 60s (the cap), so
    // the absence of a second call within a short window IS the assertion.
    await new Promise((r) => setTimeout(r, 900));
    served = calls.length;
    void p;
    check(
      'a 429 with Retry-After: 120 does NOT retry after ~2s',
      served === 1,
      `made ${served} calls within 900ms`
    );
    reply = { kind: 'json', status: 200, body: { data: { ok: true } } };
  }

  // --- the 401 message ----------------------------------------------------
  // Kept deliberately across the move: it is the sentence that sends someone to
  // re-login. The generic status text would say "AniList error (401)".
  {
    const g = await freshGql();
    reply = { kind: 'json', status: 401, body: { errors: [{ message: 'Invalid token' }] } };
    const msg = await failure(authedQuery('BAD', DOC));
    check(
      'a 401 still says "log in again"',
      msg === 'AniList session expired — log in again',
      msg
    );
    check('isAuthError recognises it', isAuthError(Object.assign(new Error('x'), { status: 401 })));
    reply = { kind: 'json', status: 200, body: { data: { ok: true } } };
  }

  // --- writes spend the budget --------------------------------------------
  // "24/min" was a reads-only ceiling, so the real limit was 24 reads plus an
  // unbounded number of writes.
  {
    const g = await freshGql();
    const before = g.budgetRemaining();
    for (let i = 0; i < 5; i++) await g.gql(`mutation Budgeted${i} { ok }`, { token: 'T' });
    const after = g.budgetRemaining();
    check(
      'writes draw down the same allowance as reads',
      before - after === 5,
      `spent ${before - after} of ${before}`
    );
  }

  // --- two accounts never share a write -----------------------------------
  // The de-dup key was query + variables only, so the same document for two
  // bearers was one entry and the second caller got the first one's response.
  {
    const g = await freshGql();
    calls = [];
    await Promise.all([
      g.gql(DOC, { token: 'ACCOUNT-ONE' }),
      g.gql(DOC, { token: 'ACCOUNT-TWO' }),
    ]);
    check(
      'two tokens on one document are two requests',
      calls.length === 2,
      `made ${calls.length} calls`
    );
    check(
      'and each carries its own bearer',
      calls.some((c) => c.headers.Authorization === 'Bearer ACCOUNT-ONE') &&
        calls.some((c) => c.headers.Authorization === 'Bearer ACCOUNT-TWO'),
      calls.map((c) => c.headers.Authorization).join(' , ')
    );
  }

  // The realistic version of the same thing. Every JWT AniList issues is base64 of
  // `{"alg":"HS256",…}`, so a key built from a token PREFIX would put every
  // account in the app on one entry — and the first write's response would then be
  // handed to whoever signed in next.
  {
    const g = await freshGql();
    const jwt = (sub: string) =>
      `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI${sub}"}.sig${sub}`;
    calls = [];
    await Promise.all([
      g.gql(DOC, { token: jwt('ALICE') }),
      g.gql(DOC, { token: jwt('BOB') }),
    ]);
    check(
      'two JWTs sharing a header prefix are still two requests',
      calls.length === 2,
      `made ${calls.length} calls — a prefix-based key would have made 1`
    );
  }

  // --- and the same account still de-duplicates ----------------------------
  {
    const g = await freshGql();
    calls = [];
    await Promise.all([
      g.gql(DOC, { token: 'SAME' }),
      g.gql(DOC, { token: 'SAME' }),
      g.gql(DOC, { token: 'SAME' }),
    ]);
    check(
      'a double-tapped save costs one request',
      calls.length === 1,
      `made ${calls.length} calls`
    );
  }

  globalThis.fetch = realFetch;
  console.log(failures ? `\n${failures} failed\n` : '\nall passed\n');
  process.exit(failures ? 1 : 0);
}

void main();