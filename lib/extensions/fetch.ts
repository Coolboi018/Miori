// Shared fetch helper for extensions.
// Manual AbortController timeout (AbortSignal.timeout isn't on every runtime).
//
// WHY THE BODY IS READ HERE AND NOT BY THE CALLER.
//
// `fetch` settles as soon as the RESPONSE HEADERS arrive. The previous version of
// this file armed an AbortController, returned that `Response`, and cleared the
// timer in a `finally` — which fires at exactly the moment the timeout stops
// being able to do anything. Every caller then drained the body with an untimed
// `res.json()` / `res.text()`, so the deadline covered connect + headers and
// nothing else.
//
// A CDN that accepts the connection, sends headers, and then stalls mid-body is
// the common failure, and it hung forever: no throw, no settle, no spinner stop.
// So the body is read *inside* the helper, while the clock is still running.
// Every call site goes through `fetchText` / `fetchJson` and gets a whole-exchange
// deadline for free.
//
// RETRIES, AND WHY THEY LIVE IN `fetchText` RATHER THAN `fetchTimed`.
// `fetchTimed` is also the primitive behind the HLS probe, where a non-2xx is a
// VERDICT (drop the source) and a stalled master must be abandoned inside its
// own small budget — retrying there would multiply a probe's cost and could
// turn a dead source into a slow one. `fetchText`/`fetchJson` are the calls
// that want a second chance: a CDN blip or one dropped packet should not become
// "this episode failed". So the retry policy sits above the primitive, and the
// TOTAL deadline is shared across attempts instead of each attempt getting a
// fresh one — a 10s subtitle fetch cannot become 30s of spinner.

import {
  isOffline,
  isOfflineError,
  offlineError,
} from '../net/connectivity';

export interface TimedResponse {
  ok: boolean;
  status: number;
  /** Body already drained — there is nothing left to await at the call site. */
  text: string;
}

/**
 * One request with a deadline that covers the WHOLE exchange.
 *
 * Returns `ok`/`status` as well as the body, for callers that have to branch on
 * the status code before deciding whether the body is worth having (Hls
 * probing reads a non-2xx as a verdict rather than an exception).
 */
export async function fetchTimed(
  url: string,
  ms: number,
  init?: RequestInit,
  label = 'Request'
): Promise<TimedResponse> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    // Awaited while the timer is still armed. This line is the whole fix.
    const text = await res.text();
    return { ok: res.ok, status: res.status, text };
  } catch (e) {
    // A bare `AbortError` ("Aborted") tells neither the user nor a log which host
    // gave up or after how long. Everything that reaches here with an aborted
    // signal is the deadline firing — not a caller-supplied cancel, since no
    // caller passes one — so it can be named.
    if (ctrl.signal.aborted) throw new Error(`${label} timed out after ${ms}ms`);
    throw e;
  } finally {
    clearTimeout(t);
  }
}

/**
 * One request, status only, body never read.
 *
 * For probes. `fetchTimed` drains the body on purpose — every caller needs it —
 * and for a MEDIA file that drain is the file. HEAD has no body to drain, so
 * "is this served" costs headers and nothing else.
 */
export async function fetchHead(
  url: string,
  ms: number,
  headers: Record<string, string> | undefined,
  label = 'Request'
): Promise<{ ok: boolean; status: number }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { method: 'HEAD', headers, signal: ctrl.signal });
    return { ok: res.ok, status: res.status };
  } catch (e) {
    if (ctrl.signal.aborted) throw new Error(`${label} timed out after ${ms}ms`);
    throw e;
  } finally {
    clearTimeout(t);
  }
}

/** `fetchTimed` plus the `!res.ok` throw, for callers that want the body. */
export async function fetchText(
  url: string,
  ms: number,
  init?: RequestInit,
  label?: string
): Promise<string> {
  const name = label ?? 'Request';
  /** `ms` is the budget for the WHOLE operation, retries included. */
  const deadline = Date.now() + Math.max(1, ms);
  let lastError: unknown;

  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    // Checked every attempt, not only at the start: the radio can disappear
    // between the first try and its retry, and a dead connection should fail
    // with the offline sentence rather than a raw TypeError.
    if (isOffline()) throw offlineError();

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw lastError instanceof Error
        ? lastError
        : new Error(`${name} timed out after ${ms}ms`);
    }

    let res: TimedResponse;
    try {
      res = await fetchTimed(url, Math.max(1, Math.round(remaining)), init, name);
    } catch (e) {
      if (isOffline()) throw offlineError();
      lastError = e;
      // A 4xx/parse failure will answer the same way again. Only a network
      // shape or a deadline miss is worth another attempt.
      if (attempt === RETRY_ATTEMPTS || !transientFailure(e)) throw e;
      await retryPause(attempt, deadline);
      continue;
    }

    if (res.ok) return res.text;

    const httpError = new Error(`${name} HTTP ${res.status}`);
    if (attempt === RETRY_ATTEMPTS || !transientStatus(res.status)) throw httpError;
    lastError = httpError;
    await retryPause(attempt, deadline);
  }

  throw lastError instanceof Error ? lastError : new Error(`${name} failed`);
}

/** One request plus two retries. */
const RETRY_ATTEMPTS = 3;

/** First backoff step. Doubles: 350ms, 700ms. */
const RETRY_BASE_MS = 350;

/** 408/425/429/5xx are the statuses where the same request can plausibly work. */
function transientStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

/**
 * Whether a thrown failure is worth repeating.
 *
 * The helper's own timeout is named, and React Native's `fetch` throws a bare
 * `TypeError` when the socket never opened — those are the two shapes a retry
 * can fix. A parse error cannot happen here (the body is still text), and a
 * caller cancellation would not either (no caller passes a signal), so this is
 * deliberately narrow rather than "retry anything".
 */
function transientFailure(e: unknown): boolean {
  if (isOfflineError(e)) return false;
  if (e instanceof TypeError) return true;
  const message = e instanceof Error ? e.message : String(e ?? '');
  return /timed out|network|fetch failed|econnreset|econnrefused|enotfound|eai_again|socket/i.test(
    message
  );
}

/**
 * Wait out a backoff step, but never past the total deadline.
 *
 * Returning early is intentional: the next loop's `remaining` check turns an
 * exhausted budget into the last real failure instead of sleeping on a request
 * that can no longer be sent.
 */
async function retryPause(attempt: number, deadline: number): Promise<void> {
  const budget = deadline - Date.now();
  if (budget <= 0) return;
  const wait = Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), budget);
  if (wait > 0) await new Promise<void>((resolve) => setTimeout(resolve, wait));
}


/**
 * `fetchText` + `JSON.parse`.
 *
 * `label` lands in both failure messages — `<label> HTTP <status>` and
 * `<label> timed out after <ms>ms` — which is why the call sites below keep
 * hand-written messages like `FilmU streams HTTP 500` intact instead of losing
 * them to a generic helper.
 */
export async function fetchJson<T>(
  url: string,
  ms: number,
  init?: RequestInit,
  label?: string
): Promise<T> {
  return JSON.parse(await fetchText(url, ms, init, label)) as T;
}

/** Is this URL something expo-video can play? (spritesheets etc. are out) */
export function playableContainer(url: string): 'hls' | 'mp4' | null {
  const u = url.toLowerCase();
  if (u.includes('.m3u8')) return 'hls';
  if (u.includes('.mp4')) return 'mp4';
  return null;
}

export interface ProbeResult {
  /** Master playlist fetched and looked like HLS. */
  alive: boolean;
  /** Segment evidence: real media segments (.ts/.m4s/.mp4), OR a resolved
   * variant reference confirmed as a real media playlist (the extension-less
   * chain of providers like Bingr/Katana — see probeHls). */
  video: boolean;
}

/**
 * Probe a source for aliveness. HLS masters get the playlist inspection in
 * `probeHls`; an mp4 has NO playlist to inspect, so "did not look like a
 * playlist" is not evidence it will not play — it is verified with a ranged
 * byte fetch instead, and only a hard network failure or a non-2xx verdict
 * counts as dead.
 */
export async function probeSource(
  url: string,
  container: 'hls' | 'mp4',
  headers: Record<string, string>,
  ms = 8000
): Promise<ProbeResult> {
  if (container !== 'hls') {
    /**
     * HEAD FIRST, BECAUSE THE RANGED GET WAS DOWNLOADING THE EPISODE.
     *
     * React Native's `fetch` settles only once the body has arrived, so the old
     * `Range: bytes=0-1` probe was cheap only when the CDN honoured the range.
     * One that ignores it answers 200 with the WHOLE FILE, and the probe then
     * pulled the video through the radio — tens of megabytes inside an 8s
     * deadline, on the connection the resolve is already waiting on, to learn a
     * fact the status line had stated. A HEAD response has no body at all.
     */
    try {
      const head = await fetchHead(url, ms, headers, 'mp4 probe');
      if (head.ok) return { alive: true, video: true };
      // 405/501 mean "this host has no HEAD", which says nothing about the
      // file. Any other non-2xx is the verdict the ranged GET used to give.
      if (head.status !== 405 && head.status !== 501) return { alive: false, video: false };
    } catch {
      /* HEAD is not universal — the ranged GET below is the fallback */
    }
    // Range request: 2 bytes is enough for a verdict and keeps CDN egress at
    // noise level. A 206/200 with any body means the file is being served.
    try {
      const res = await fetchTimed(
        url,
        ms,
        { headers: { ...headers, Range: 'bytes=0-1' } },
        'mp4 probe'
      );
      if (!res.ok) return { alive: false, video: false };
      return { alive: true, video: true };
    } catch {
      // Unknown on doubt, consistent with the HLS probe's failure mode.
      return { alive: true, video: false };
    }
  }
  return probeHls(url, headers, ms);
}

/** Probe an HLS master. Never drops playable sources:
 * - not-HLS / dead master -> alive: false (drop)
 * - image-looking segments (sora sheets AND mega obfuscation look the
 *   same here) -> alive: true, video: false (deprioritize, still try) */
export async function probeHls(
  masterUrl: string,
  headers: Record<string, string>,
  ms = 8000
): Promise<ProbeResult> {
  const dead: ProbeResult = { alive: false, video: false };
  const get = (u: string, timeout: number) =>
    fetchTimed(u, timeout, { headers }, 'HLS probe');
  let text: string;
  try {
    // `fetchTimed` rather than `fetchText`: a non-2xx master is a VERDICT here
    // (dead, drop it), not an exception to report and recover from. Routing it
    // through `fetchText` would turn a 403 into the catch below's "unknown on
    // doubt", which keeps dead sources in the list.
    const res = await get(masterUrl, ms);
    if (!res.ok) return dead;
    text = res.text;
    if (!text.replace(/^\uFEFF/, '').trimStart().startsWith('#EXTM3U')) return dead;
  } catch {
    return { alive: true, video: false }; // unknown on doubt
  }
  // Prefer video variant playlists (non-# .m3u8 lines) over EXT-X-MEDIA
  // renditions (audio/subtitle playlists tell us nothing about video).
  //
  // ⚠️ Some providers ship the WHOLE chain extension-less: the Bingr/Katana
  // master's variant lines are `/p/<token>` and its segments `/s/<token>` —
  // no `.m3u8` text anywhere. The `.m3u8` filter below therefore selects
  // NOTHING and an old version read "video: false" for a perfectly live
  // ladder. When the master carries variant entries (#EXT-X-STREAM-INF) but
  // no `.m3u8` line, the first non-# line IS the ladder's top entry, so it is
  // fetched as a candidate — but the fetched body is trusted as the segment
  // level only if it is ITSELF a playlist (`#EXTM3U`), and only for the
  // extension-less path. That keeps the image-encodes trap closed: a sprite
  // sheet or a segment fetched off a `.m3u8` master answers with image/mpegts
  // bytes, not playlist text, and `video` stays `false`.
  const masterLines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  const resolveAbs = (u: string): string | null => {
    try {
      return new URL(u, masterUrl).toString();
    } catch {
      return null;
    }
  };
  const videoVariants = masterLines
    .filter((l) => l.toLowerCase().includes('.m3u8'))
    .map(resolveAbs)
    .filter((u): u is string => u !== null);
  const extensionlessCandidates =
    text.includes('#EXT-X-STREAM-INF') && videoVariants.length === 0
      ? masterLines.map(resolveAbs).filter((u): u is string => u !== null)
      : [];
  let segmentLevel = text;
  // A fetched extension-less candidate that answers playlist text is evidence
  // of real segments AS WELL: the reference resolved to a media playlist
  // rather than a status page or binary junk. (Verified live: the Katana top
  // variant is `#EXTM3U … #EXT-X-TARGETDURATION … #EXTINF:11.428,`.)
  let extensionlessPlaylistConfirmed = false;
  const firstCandidate = videoVariants[0] ?? extensionlessCandidates[0];
  if (firstCandidate) {
    try {
      const vres = await get(firstCandidate, 6000);
      if (
        vres.ok &&
        vres.text.replace(/^\uFEFF/, '').trimStart().startsWith('#EXTM3U')
      ) {
        segmentLevel = vres.text;
        if (videoVariants.length === 0) extensionlessPlaylistConfirmed = true;
      }
    } catch {
      /* keep master level — doubt */
    }
  }
  return {
    alive: true,
    video: extensionlessPlaylistConfirmed || segmentsLookLikeVideo(segmentLevel),
  };
}

function segmentsLookLikeVideo(segmentLevel: string): boolean {
  const segs = segmentLevel
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  if (!segs.length) return false; // no info — not verified
  return segs.some((u) => /\.(ts|m4s|mp4|cmfv|cmfa|aac)(\?|$)/i.test(u));
}
