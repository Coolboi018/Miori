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

/** `fetchTimed` plus the `!res.ok` throw, for callers that want the body. */
export async function fetchText(
  url: string,
  ms: number,
  init?: RequestInit,
  label?: string
): Promise<string> {
  const r = await fetchTimed(url, ms, init, label);
  if (!r.ok) throw new Error(`${label ?? 'Request'} HTTP ${r.status}`);
  return r.text;
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
