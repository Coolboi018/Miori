// The one place in the app that talks to AniList.
//
// Everything the app knows about the network lives here: the endpoint, the
// timeout, the retry policy, what a rate limit looks like, and - the part that
// actually protects the app - a budget that keeps the whole process under
// AniList's documented ~30 requests/minute no matter how many screens ask at
// once.
//
// AND NOW THE WRITES TOO, which is the sentence that used to be false.
// `lib/anilist/lists.ts` opened its own socket with none of what is below: no
// timeout, no budget, no `Retry-After` parsing, and a flat 2s retry loop. So a
// hung `SaveMediaListEntry` never settled — React Native's `fetch` has no default
// timeout — and the list sheet spun forever on every attempt. Writes also escaped
// the allowance entirely, making the real ceiling 24 reads plus an unbounded
// number of writes. Both go through `authedQuery` here now; the 401 case is
// translated back into the "log in again" sentence at the boundary.
//
// WHY A SINGLE CLIENT. There were five independent `fetch` + TTL + in-flight
// call sites (home, explore, browse grid, schedule, search) plus a sixth and
// seventh in the detail and character paths. Each had its own timeout that did
// not exist, its own idea of what a 429 meant, and its own de-duplication map
// that only knew about itself — so two screens asking the same question in the
// same frame both went to the wire. One client makes de-duplication GLOBAL,
// which is the only place it can do any good: the key is the query text plus
// its variables, so the schedule's day-zero request and a prefetch of the same
// day are the same request, whoever asked.
//
// THE BUDGET. AniList answers 429 with `Retry-After`, and it is not shy about
// it: a burst of tab prefetching on a cold start will earn one. Handling it
// means waiting, and waiting means the user stares at a spinner. So instead of
// discovering the limit by hitting it, this client never exceeds it — requests
// queue and drain against a sliding window. The app is then always inside its
// allowance, and 429 becomes a rare bug rather than a normal Tuesday.
//
// RETRIES. Two, with real backoff, and only for failures that could plausibly
// succeed on a second attempt: a network error, a timeout, a 5xx, or a 429. A
// 4xx that is not a 429 is AniList telling us the query is wrong, and repeating
// it would just burn budget to arrive at the same answer.

import {
  isOffline,
  isOfflineError,
  offlineError,
} from '../net/connectivity';

const API = 'https://graphql.anilist.co';

/**
 * How long a single request may take before it is abandoned.
 *
 * Twelve seconds is long enough for a phone on a bad connection to succeed and
 * short enough that a genuinely dead socket does not leave a screen spinning
 * until the OS gives up. React Native's `fetch` has no default timeout, which
 * is why this is not optional.
 */
const REQUEST_TIMEOUT_MS = 12_000;

/** Total attempts, i.e. one request plus two retries. */
const MAX_ATTEMPTS = 3;

/** First backoff step. Doubles each attempt: 600ms, 1200ms. */
const RETRY_BASE_MS = 600;

/**
 * THE BUDGET: at most `BUDGET_MAX` requests per `BUDGET_WINDOW_MS`.
 *
 * Deliberately under AniList's documented 30/minute. A limiter set exactly at
 * the published number spends the whole allowance and then fails on the 31st,
 * and every failure costs more than the request would have — a retry, a backoff
 * wait, and a user watching a spinner. Sitting under the line means the ceiling
 * is never the thing that breaks.
 */
const BUDGET_MAX = 24;
const BUDGET_WINDOW_MS = 60_000;

/**
 * Requests actually on the wire, as timestamps. Pruned to the window on every
 * admission check rather than by a timer — a module-level interval that runs
 * forever in a backgrounded app is exactly the kind of thing this codebase
 * already avoids elsewhere.
 */
const sentAt: number[] = [];

function budgetDelay(): number {
  const now = Date.now();
  // Drop everything that has aged out of the window.
  while (sentAt.length > 0 && now - sentAt[0] >= BUDGET_WINDOW_MS) sentAt.shift();
  if (sentAt.length < BUDGET_MAX) return 0;
  // The window frees a slot when the OLDEST entry ages out.
  return Math.max(0, sentAt[0] + BUDGET_WINDOW_MS - now);
}

/**
 * Serialise admission so two requests arriving in the same tick cannot both
 * read a full window and both proceed. A promise chain rather than a mutex: the
 * queue is short (bounded by the budget) and always empty in steady state.
 */
let admission: Promise<void> = Promise.resolve();

function admit(): Promise<void> {
  const turn = admission.then(async () => {
    const wait = budgetDelay();
    if (wait > 0) {
      await new Promise((r) => setTimeout(r, wait));
    }
    // Re-checked AFTER the wait: another caller may have taken the slot we
    // waited for, and admission is the one place a race costs real money.
    const again = budgetDelay();
    if (again > 0) {
      await new Promise((r) => setTimeout(r, again));
    }
    sentAt.push(Date.now());
  });
  // The chain must survive a rejection or every later caller inherits it.
  admission = turn.catch(() => {});
  return turn;
}

// ---------------------------------------------------------------------------
// De-duplication
// ---------------------------------------------------------------------------

/**
 * In-flight requests, keyed by query text plus variables.
 *
 * GLOBAL on purpose. Every screen's own cache used to de-duplicate only against
 * itself, so a pull-to-refresh on explore racing the prefetch of explore's own
 * sections was two requests, and the schedule's prefetch racing a focus refresh
 * was another two. Here the second caller awaits the first one's promise and the
 * pair costs one.
 */
const inflight = new Map<string, Promise<unknown>>();

/**
 * A short, stable stand-in for a bearer token, for use in a cache key.
 *
 * NOT a prefix. A JWT is base64 of `{"alg":"HS256",…}`, so every token AniList
 * issues starts with the same eight characters — `eyJhbGci` — and a prefix would
 * make all accounts collide on one key, which is precisely the cross-account
 * de-duplication this is meant to prevent. Hash the whole thing instead, and mix
 * in the length so two tokens cannot collide on a weak hash alone.
 *
 * Deliberately not cryptographic. It is not defending the token, only keeping it
 * out of a long-lived structure; a full copy would live there for the life of the
 * request, which is the only thing this avoids.
 */
function fingerprint(token: string): string {
  // djb2, 32-bit. Cheap, no dependency, and fine for distinguishing two accounts.
  let h = 5381;
  for (let i = 0; i < token.length; i++) h = ((h * 33) ^ token.charCodeAt(i)) >>> 0;
  return `${h.toString(36)}.${token.length}`;
}

function keyFor(
  query: string,
  variables?: Record<string, unknown>,
  token?: string
): string {
  // Variables are sorted so key order in the caller cannot produce two keys for
  // one request. Cheap because there are never more than a handful of them.
  const stable = variables
    ? JSON.stringify(variables, Object.keys(variables).sort())
    : '';
  // The token is part of the key because a de-duplicated write would otherwise
  // hand one account's response to another: the same document and variables mean
  // different things to different bearers.
  const who = token ? fingerprint(token) : '-';
  return `${query}\u0000${stable}\u0000${who}`;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Tagged, not subclassed — see `lib/presence/discord.ts` for why. */
export interface GqlError extends Error {
  /** Present when AniList refused for quota rather than for the query. */
  retryAfterMs?: number;
  /** HTTP status, when there was a response at all. */
  status?: number;
}

/** A refusal for quota, narrowed to the one field the retry loop reads. */
export interface RateLimited {
  retryAfterMs: number;
}

/** A rate limit, typed so `isRetryable` can see the wait without a cast. */
function rateLimited(ms: number): GqlError & RateLimited {
  const e = new Error(
    `AniList rate limited — retrying in ${Math.max(1, Math.round(ms / 1000))}s`
  ) as GqlError & RateLimited;
  e.retryAfterMs = ms;
  return e;
}

function statusError(status: number, body?: string): GqlError {
  const e = new Error(`AniList error (${status})${body ? `: ${body}` : ''}`) as GqlError;
  e.status = status;
  return e;
}

/** Tagged rather than thrown as a subclass — see above. */
interface TimedOut {
  timedOut?: boolean;
}

export function isTimeout(e: unknown): boolean {
  return !!(e as TimedOut | null)?.timedOut;
}

function timedOut(): GqlError {
  const e = new Error('AniList did not answer in time') as GqlError & TimedOut;
  e.timedOut = true;
  return e;
}

/** How long AniList asked us to wait, in ms. Both headers, both forms. */
function retryAfterOf(res: Response): number {
  const raw = res.headers.get('retry-after') ?? res.headers.get('x-ratelimit-reset-after');
  if (!raw) return 0;
  // AniList sends seconds as a float; some edges send an HTTP date.
  const secs = Number(raw);
  if (Number.isFinite(secs) && secs > 0) return Math.min(secs * 1000, 60_000);
  const when = Date.parse(raw);
  return Number.isFinite(when) ? Math.max(0, Math.min(when - Date.now(), 60_000)) : 0;
}

/**
 * AniList rejected the TOKEN rather than the query.
 *
 * Kept as a distinct signal because the caller's response to it is specific and
 * unrecoverable by retrying: the user has to sign in again. The generic
 * `statusError` message would say "AniList error (401)" and leave a person
 * guessing, so `lib/anilist/lists.ts` maps this to a sentence that tells them what
 * to do.
 */
export function isAuthError(e: unknown): boolean {
  return (e as GqlError | null)?.status === 401;
}

// ---------------------------------------------------------------------------
// The request
// ---------------------------------------------------------------------------

interface GqlOptions {
  variables?: Record<string, unknown>;
  signal?: AbortSignal;
  /** Caller-driven cancellation is not retried, however it fails. */
  label?: string;
  /**
   * Bearer token. Absent for reads, which AniList serves from its public API.
   *
   * Present for every WRITE, which is why this client is now the only place in
   * the app that talks to AniList at all. `lib/anilist/lists.ts` used to open its
   * own socket with none of what is below — no timeout, no budget, flat 2s
   * retries — so a hung `SaveMediaListEntry` never settled and the list sheet
   * spun forever on every attempt.
   */
  token?: string;
}

/**
 * POST one GraphQL document and return its `data`.
 *
 * `errors` alongside a partial `data` is AniList's normal shape when one alias
 * of a many-alias query fails, and it is deliberately NOT thrown: the home and
 * explore queries are built out of seven aliases each precisely so that one
 * failing section degrades to an empty rail instead of a blank screen. The
 * normalisers downstream already treat a missing key as `[]`.
 */
async function attempt<T>(query: string, options: GqlOptions): Promise<T> {
  // FAIL FAST WHILE OFFLINE. This is checked BEFORE the budget: waiting for a
  // slot on an allowance that cannot be spent is a spinner with no possible
  // outcome, and on a phone the wait can be tens of seconds. The tagged error
  // is what tells React Query and the screens not to retry.
  if (isOffline()) throw offlineError();

  await admit();

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  // An external abort (a screen unmounting, a query cancelled) has to reach the
  // socket too, and `fetch` only takes one signal — so both are bridged onto
  // the controller this request actually uses.
  const onExternalAbort = () => ctrl.abort();
  options.signal?.addEventListener('abort', onExternalAbort);

  try {
    const res = await fetch(API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : null),
      },
      body: JSON.stringify({ query, variables: options.variables ?? {} }),
      signal: ctrl.signal,
    });

    if (res.status === 429) {
      throw rateLimited(retryAfterOf(res) || 2000);
    }
    if (!res.ok) {
      // The body is only read for 4xx — a 5xx page is AniList's HTML error
      // screen, and putting it in an error message helps nobody.
      const body = res.status >= 500 ? undefined : await res.text().catch(() => undefined);
      throw statusError(res.status, body?.slice(0, 160));
    }

    const json = (await res.json()) as { data?: T };
    if (json.data == null) throw statusError(res.status || 200, 'empty response');
    return json.data;
  } catch (e) {
    // `abort()` surfaces as an AbortError, which is indistinguishable from the
    // timeout unless the timer is the reason. The timer variable tells us.
    if (ctrl.signal.aborted && !options.signal?.aborted) throw timedOut();
    throw e;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onExternalAbort);
  }
}

/**
 * Whether the caller cancelled, as opposed to the request failing. Retrying a
 * cancellation would keep a dead screen's work alive on the wire.
 */
function isAbort(e: unknown): boolean {
  return (e as { name?: string })?.name === 'AbortError';
}

/** Whether this failure could plausibly become a success on another attempt. */
function isRetryable(e: unknown): boolean {
  if (isAbort(e)) return false;
  // No network is not a transient transport failure: every retry would fail
  // the same way and only delay the moment the screen can say so.
  if (isOfflineError(e)) return false;
  if (isTimeout(e)) return true;
  if ((e as GqlError)?.retryAfterMs != null) return true;
  const status = (e as GqlError)?.status;
  if (status != null) return status >= 500;
  // A bare network failure has no status at all. TypeError is what RN's fetch
  // throws when the socket never opened.
  return e instanceof TypeError;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onTheAbort);
      resolve();
    }, ms);
    function onTheAbort() {
      clearTimeout(t);
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    }
    signal?.addEventListener('abort', onTheAbort, { once: true });
  });

/**
 * One AniList document. De-duplicated, budgeted, timed, retried.
 *
 * @example
 * const data = await gql<{ Page: { media: MediaItem[] } }>(QUERY, { variables: { id } });
 */
export async function gql<T>(
  query: string,
  { variables, signal, token }: GqlOptions = {}
): Promise<T> {
  const key = keyFor(query, variables, token);
  const pending = inflight.get(key);
  if (pending) return pending as Promise<T>;

  const run = (async () => {
    let lastError: unknown;
    for (let attempt_ = 1; attempt_ <= MAX_ATTEMPTS; attempt_++) {
      try {
        return await attempt<T>(query, { variables, signal, token });
      } catch (e) {
        lastError = e;
        if (attempt_ === MAX_ATTEMPTS || !isRetryable(e)) throw e;
        // The radio can disappear between attempts. Do not spend a backoff
        // sleeping on a connection that is already known to be gone.
        if (isOffline()) throw offlineError();
        // A rate limit is AniList's own instruction, so it wins over our backoff
        // schedule — going early on a 429 is how a limit turns into a ban.
        const wait = (e as GqlError).retryAfterMs ?? RETRY_BASE_MS * 2 ** (attempt_ - 1);
        await sleep(wait, signal);
      }
    }
    throw lastError;
  })();

  inflight.set(key, run);
  try {
    return await run;
  } finally {
    if (inflight.get(key) === run) inflight.delete(key);
  }
}

/**
 * How much of the minute's allowance is left. Read by the debug panel only.
 */
export function budgetRemaining(): number {
  const now = Date.now();
  while (sentAt.length > 0 && now - sentAt[0] >= BUDGET_WINDOW_MS) sentAt.shift();
  return Math.max(0, BUDGET_MAX - sentAt.length);
}
