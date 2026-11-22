// FilmU extension — v3: the Bingr.one direct client.
//
//
// ⚠️ THE NAME IS HISTORICAL. `hianime.filmu.in` — the host this module pointed
// at for its whole life — is GONE: on 30 Oct 2026 every path on it answers
// `404 page not found` (the 27 Oct rewrite below was against a contract that
// died three days later). The same operators relaunched as **bingr.one**, whose
// backend (`https://api.bingr.one/api`) still serves ANIME BY ANILIST ID and
// plays through SSR'd watch pages whose stream URLs are self-contained HLS.
// The module path, the factory name and the extension id are kept so the
// registry, the prefetch warm-up, the detail screen and the legacy player keep
// wiring to one thing under one name; only the label and everything under them
// changed.
//
// HOW THIS WORKS, all verified live with curl (30 Oct):
//
//   GET https://api.bingr.one/api/anime/{anilistId}/episodes?chunk={n}
//     → { total, season, status, has_next_page,
//         episodes: [{ episode, title, still, rating, air_date, overview }] }
//     No auth, no token. `still` is a TMDB still (`/t/p/original/…`; mapped to
//     `/t/p/w500/…` here — same host, ~26KB vs ~200KB for 13 near-simultaneous
//     rows on a phone). One image per row, but never null.
//
//   GET https://bingr.one/watch/anime/{anilistId}/{ep}
//     → full SSR watch page. Contains the player's SESSION token
//     (`"token":"x.y"` — dottéd, so the Cloudflare beacon's token does not
//     match), the intro/ending skip markers in `meta.skip`, and ONE stream
//     url `https://hikari.streamrip.fun/p/<opaque-signed-token>`.
//     That `/p/…` URL IS an HLS master playlist (application/vnd.apple.mpegurl,
//     1080/720/480 ladder) and plays on UA-ONLY fetches. ⚠️ No `.m3u8` appears
//     anywhere in that URL — the container is asserted, never derived.
//
// v3.1 (30 Oct): `refresh()` on every source — the player re-issues when a
// probed-alive source fails at open. 1 Nov: their SSR re-serves the same token
// inside a mint window, so a replay is upstream behaviour; the player only
// splices a refresh whose url CHANGED.
//
// v3.2 (1 Nov): SUBTITLES ARE BACK. The 30 Oct note ("gated behind encrypted
// state") is readable now — everything IS on the same page:
//
//   GET https://bingr.one/api/sources?kind=anime&anilist={id}&e={ep}&audio=sub&t={session}
//     → 200 body `v1.<base64url(nonce12 + XORred JSON)>` — the client decodes
//     `v1.` payloads with a FNV-flavoured keystream cipher whose SECRET
//     (`vY7#qL2!mZ9@wK4$`) ships in the bundle (module 74763). Decoded state:
//       { provider, servers: [katana-sub|katana-dub|katana-multi|ronin|shogun|ninja],
//         streams: [{ url: '/p/<token>', type: 'hls', quality: 'HD',
//                     subtitles: [{ url: '…/v/<token>', lang, label }] }] }
//     The 30 Oct 404 was replaying the WRONG `t` (the stream token / beacon
//     token) — the real one is embedded per SSR page and is what the player
//     itself sends.
//
//     SUBTITLE-SIDE CONTRACT: the `/v/…` VTT answers 200 ONLY to a fetch that
//     carries `Referer: https://bingr.one/` — the SAME url answers a
//     JSON-shaped `404 {"ok":false,"error":"not found"}` without it. So each
//     track carries headers, the player's `fetchText(t.headers)` path picks
//     them up unchanged. Verified END to END: Referer + browser UA →
//     `WEBVTT / 00:00:02.930 --> …`.
//
// 🔴 THE SIGNED STREAM URL IS SHORT-LIVED. Their own client refreshes a stream
// older than 8 minutes (`X.at > 48e4` triggers a re-resolve in the watch
// player). The streams cache here is 5 minutes — under the client's window —
// and `resolve()` re-fetches the SSR page on every cache miss, meaning a real
// play always starts on a token at most a few minutes old.
import type {
  EpisodeInfo,
  Extension,
  ExtensionMatch,
  SubtitleTrack,
  WatchSource,
} from '../types';
import { fetchJson, fetchText, fetchTimed, probeSource } from '../fetch';
import AsyncStorage from '@react-native-async-storage/async-storage';

const API = 'https://api.bingr.one/api';
const SITE = 'https://bingr.one';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
/** The `/v/` VTT routes 404 to ANY fetch without this Referer, 200 with it. */
const SUB_HEADERS = { 'User-Agent': UA, Referer: `${SITE}/` };

/** The only shape a playable stream token has ever carried. */
const STREAM_URL = /^https:\/\/hikari\.streamrip\.fun\/p\/[A-Za-z0-9_-]+$/;

/**
 * A server id -> the picker's row name.
 *
 * Their player names its servers `katana-sub`, `katana-dub`, `katana-multi`,
 * `ronin`, `shogun`, `ninja`; the app used to label EVERY stream "Katana",
 * which is one of those names and made a five-row provider look like a
 * one-row one. `katana-sub` keeps the familiar "Katana Sub", and the rest
 * arrive as "Ronin" / "Shogun" / "Ninja".
 */
function serverLabel(id: string): string | undefined {
  const clean = id.trim().toLowerCase();
  if (!clean) return undefined;
  const parts = clean.split(/[-_]+/).filter(Boolean);
  if (!parts.length) return undefined;
  return parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
}

const STREAMS_TTL = 5 * 60 * 1000; // signed tokens live ~8min client-side; stay under
const EPISODES_TTL = 60 * 60 * 1000;
// Chunks are the loop's SAFETY BOUND, not its stopping condition —
// `has_next_page` is. The old bound of 6 silently truncated every
// long-running title to what six chunks hold (~500 rows: the "One Piece
// shows 500 of 1100+" report of 10 Nov — the count was the cap, not the
// source and not AniList). One Piece alone needs ~14; 30 covers the longest
// list that exists (~3000) while still bounding a broken upstream that
// answers `has_next_page: true` forever.
const MAX_EPISODE_CHUNKS = 30;

interface BingrEpisode {
  episode?: number;
  title?: string;
  still?: string | null;
  overview?: string | null;
  air_date?: string | null;
}

interface BingrEpisodesResponse {
  total?: number;
  has_next_page?: boolean;
  episodes?: BingrEpisode[];
}

interface BingrEpisodeInfo extends EpisodeInfo {}

interface BingrSub {
  url: string;
  lang?: string;
  label?: string;
}

interface BingrStream {
  url?: string;
  type?: string;
  quality?: string;
  label?: string;
  subtitles?: BingrSub[];
}

interface BingrSourcesState {
  provider?: { id?: string; label?: string };
  servers?: Array<{ id?: string; label?: string }>;
  streams?: BingrStream[];
  at?: number;
}

interface WatchPageData {
  html: string;
  /** The player's session token (`x.y`) — the `/api/sources` key. */
  session: string | null;
  /** intro/ending markers from `meta.skip`, seconds. */
  intro: { start: number; end: number } | null;
  outro: { start: number; end: number } | null;
}

const streamsCache = new Map<string, { at: number; data: WatchSource[] }>();
const episodesCache = new Map<string, { at: number; data: BingrEpisode[] }>();

/**
 * PERSIST the episode list to AsyncStorage so a previous success survives app
 * restarts and an ISP block. Right now the cache is in-memory only: a launch
 * during a block empties it, and every title loses its stills until bingr is
 * reachable again. The persisted copy is read on module load and written on
 * every successful fetch.
 */
const EPISODES_STORE_KEY = 'miori:filmu-episodes';
let episodesLoaded = false;
void AsyncStorage.getItem(EPISODES_STORE_KEY)
  .then((raw) => {
    if (!raw) return;
    const entries = JSON.parse(raw) as Array<[string, { at: number; data: BingrEpisode[] }]>;
    for (const [k, v] of entries) {
      if (v && Array.isArray(v.data)) episodesCache.set(k, v);
    }
    episodesLoaded = true;
  })
  .catch(() => { episodesLoaded = true; });

let persistTimer: ReturnType<typeof setTimeout> | null = null;
function persistEpisodes(): void {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const entries = [...episodesCache.entries()]
      .filter(([, v]) => Array.isArray(v.data))
      .slice(0, 200);
    void AsyncStorage.setItem(EPISODES_STORE_KEY, JSON.stringify(entries)).catch(() => {});
  }, 300);
}

/** base64 alphabet, standalone for `base64urlToBytes` above. */
const B64ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** The `.v1.` payload's keystream SECRET — ships verbatim in their bundle. */
const STATE_SECRET = 'vY7#qL2!mZ9@wK4$';

/**
 * Hermes has no `atob` and no `TextDecoder` (see `lib/crypto/mega-crypto.ts`:
 * "No Node crypto, no Buffer, no TextEncoder/TextDecoder"). Base64url decoding
 * and UTF-8 decoding are therefore the same pure charCode loops that module
 * uses, inlined here because extensions stay self-contained.
 */
function base64urlToBytes(input: string): Uint8Array {
  const b64 = input.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 === 0 ? 0 : 4 - (b64.length % 4);
  let b64p = b64;
  for (let i = 0; i < pad; i++) b64p += '=';
  const out: number[] = [];
  for (let i = 0; i < b64p.length; i += 4) {
    const c0 = B64ALPHA.indexOf(b64p[i]);
    const c1 = B64ALPHA.indexOf(b64p[i + 1]);
    const c2 = b64p[i + 2] === '=' ? 0 : B64ALPHA.indexOf(b64p[i + 2]);
    const c3 = b64p[i + 3] === '=' ? 0 : B64ALPHA.indexOf(b64p[i + 3]);
    if (c0 < 0 || c1 < 0 || c2 < 0 || c3 < 0) throw new Error('Bingr: bad base64 in sources payload');
    const n = (c0 << 18) | (c1 << 12) | (c2 << 6) | c3;
    out.push((n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff);
  }
  return new Uint8Array(out.slice(0, out.length - pad));
}

function utf8Decode(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; ) {
    const b0 = bytes[i];
    if (b0 < 0x80) {
      out += String.fromCharCode(b0);
      i += 1;
    } else if ((b0 & 0xe0) === 0xc0) {
      out += String.fromCharCode(((b0 & 0x1f) << 6) | (bytes[i + 1] & 0x3f));
      i += 2;
    } else if ((b0 & 0xf0) === 0xe0) {
      out += String.fromCharCode(
        ((b0 & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f)
      );
      i += 3;
    } else {
      const cp =
        ((b0 & 0x07) << 18) |
        ((bytes[i + 1] & 0x3f) << 12) |
        ((bytes[i + 2] & 0x3f) << 6) |
        (bytes[i + 3] & 0x3f);
      const v = cp - 0x10000;
      out += String.fromCharCode(0xd800 + (v >> 10), 0xdc00 + (v & 0x3ff));
      i += 4;
    }
  }
  return out;
}

/**
 * Decode `/api/sources`' `v1.<payload>` body. Port of their client module
 * (bundle chunk 4652, module `74763`, function `D`): base64url of
 * `nonce[12] + XOR'd JSON`, where the XOR keystream is a four-register
 * FNV-flavoured blend seeded from the SECRET and the nonce, producing one
 * 32-bit word per four bytes.
 *
 * ⚠️ Every detail is load-bearing, and each wrong turn produced GARBAGE rather
 * than an error, so this was pinned against the live payload the same day it
 * was written (see `scripts/debug-filmu-raw.ts`, deployment v4):
 *  - the rotation step folds the OLD third register (their `a`) even after the
 *    first register was reassigned in the same block — reads stay sequential;
 *  - the counter is read AFTER its own increment (`e=e+(s=s+1|0)`), so the
 *    XOR word is `oldSum + (counter+1)`, not the old sum.
 */
export function decodeSourcesPayload(text: string): BingrSourcesState {
  if (!text.startsWith('v1.')) throw new Error('Bingr: bad sources payload shape');
  const raw = base64urlToBytes(text.slice(3));
  const nonce = raw.subarray(0, 12);
  const body = raw.slice(12);
  const [N0, L0, A0, S0] = [0, 0, 0, 0].map((_, k) => {
    let h = (0x811c9dc5 ^ (0x9e3779b9 * k)) >>> 0;
    for (let j = 0; j < STATE_SECRET.length; j++) {
      h = Math.imul(h ^ STATE_SECRET.charCodeAt(j), 0x1000193) >>> 0;
    }
    for (let j = 0; j < nonce.length; j++) h = Math.imul(h ^ nonce[j], 0x1000193) >>> 0;
    return h >>> 0;
  });
  let N = N0;
  let L = L0;
  let A = A0;
  let S = S0;
  let i = 0;
  for (let t = 0; t < body.length; t++) {
    if ((t & 3) === 0) {
      A >>>= 0;
      S >>>= 0;
      let E = (N >>> 0) + (L >>> 0) | 0;
      N = L ^ (L >>> 9);
      L = (A + (A << 3)) | 0;
      S = (S + 1) | 0;
      E = (E + S) | 0;
      A = (((A << 21) | (A >>> 11)) + E) | 0;
      i = E >>> 0;
    }
    body[t] ^= (i >>> ((t & 3) * 8)) & 255;
  }
  return JSON.parse(utf8Decode(body)) as BingrSourcesState;
}

export function createFilmuExtension(): Extension {
  /**
   * ⚠️ AN EMPTY LIST IS A FAILURE, NOT AN ANSWER — and it must not be cached.
   *
   * Carried from the rawEpisodes rule (both previous iterations died the same
   * way as candidates: an upstream 200-with-garbage body used to be cached as
   * an one-hour success). `JSON.parse` failures, `{}`, and `total: 0` all come
   * back `[]` and never land in the cache, so one flaky response cannot empty
   * a title for an hour — the caller is told it failed and falls back to
   * AniList's own count.
   */
  async function rawEpisodes(anilistId: number): Promise<BingrEpisode[]> {
    const key = String(anilistId);
    const hit = episodesCache.get(key);
    if (hit && Date.now() - hit.at < EPISODES_TTL) return hit.data;
    // Stale fallback (up to 7 days): keeps the stills showing during an ISP
    // block after a restart. resolve() still re-tries the stream path, so a
    // stale episode list never costs a playable episode.
    if (hit && Date.now() - hit.at < 7 * 24 * 3600 * 1000) return hit.data;
    const out: BingrEpisode[] = [];
    // Chunk windows can OVERLAP — One Piece came back with 1274 rows for 1174
    // episode numbers, exactly one chunk's worth of repeats. A repeated
    // number is not a second episode: the details page keys rows by number,
    // so duplicates crashed the list (duplicate React keys in the
    // VirtualizedList) and inflated the reported count by the same hundred.
    // First occurrence wins — chunks are ordered, so that is the row the
    // earlier window carried.
    const seen = new Set<number>();
    for (let chunk = 0; chunk < MAX_EPISODE_CHUNKS; chunk++) {
      const j = await fetchJson<BingrEpisodesResponse>(
        `${API}/anime/${anilistId}/episodes?chunk=${chunk}`,
        20000,
        { headers: { 'User-Agent': UA, Accept: 'application/json' } },
        'Bingr episodes'
      );
      const rows = Array.isArray(j?.episodes) ? j.episodes : [];
      const usable = rows.filter((e) => Number(e?.episode) > 0 || typeof e?.episode === 'number');
      for (const e of usable) {
        const n = Number(e.episode);
        if (seen.has(n)) continue;
        seen.add(n);
        out.push(e);
      }
      if (!j?.has_next_page || rows.length <= 0) break;
    }
    if (!out.length) throw new Error('Bingr returned no episodes');
    episodesCache.set(key, { at: Date.now(), data: out });
    persistEpisodes();
    return out;
  }

  /**
   * SSR the watch page: stream tokens in the flight payload, the player's
   * session token and the intro/ending markers.
   *
   * The flight payload is streamed as `self.__next_f.push([1,"…"])` literals
   * whose quote characters vary segment-by-segment between `'` escaped
   * (`\\\"`) and plain — so the text is normalized ONCE by stripping every
   * backslash, and each claim is a plain-string regex afterwards (hikari
   * tokens are `[A-Za-z0-9_-]`, unaffected by stripping). The session token is
   * distinguished from the Cloudflare beacon token by its FORMAT: the player's
   * is `id.random` (contains a dot), the beacon's is bare hex.
   */
  async function watchPageData(anilistId: number, ep: number): Promise<WatchPageData> {
    const r = await fetchTimed(
      `${SITE}/watch/anime/${anilistId}/${ep}`,
      25000,
      { headers: { 'User-Agent': UA, Accept: 'text/html' } },
      'Bingr watch page'
    );
    // A non-2xx page is a verdict the caller must see: 404 = the title is not
    // on bingr at all (unknown/unmapped), 5xx = their SSR is down.
    if (!r.ok) throw new Error(`Bingr watch page HTTP ${r.status}`);
    const sane = r.text.replace(/\\/g, '');
    const session =
      /"token":"([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)"/.exec(sane)?.[1] ?? null;
    const skip =
      /"skip":\{"opening":\[([\d.]+),([\d.]+)\],"ending":\[([\d.]+),([\d.]+)\]\}/.exec(sane);
    return {
      html: r.text,
      session,
      intro:
        skip
          ? { start: Number(skip[1]), end: Number(skip[2]) }
          : null,
      outro:
        skip
          ? { start: Number(skip[3]), end: Number(skip[4]) }
          : null,
    };
  }

  function mintSource(
    anilistId: number,
    ep: number,
    url: string,
    subs: SubtitleTrack[] = [],
    /** The watch page's parsed data — supplies the intro/ending markers. */
    skip: WatchPageData | null = null,
    /** The row's name: the bingr server this stream came from. */
    qualityLabel = 'Katana'
  ): WatchSource {
    return {
      url,
      // Asserted, never derived, and why: the token URL contains no `.m3u8`
      // and it is an HLS master feeding a 1080/730/480 ladder. See header.
      container: 'hls' as const,
      quality: qualityLabel,
      headers: { 'User-Agent': UA },
      intro: skip?.intro ?? null,
      outro: skip?.outro ?? null,
      subtitles: subs.length ? subs : undefined,
      /**
       * Self-healing for the signed URL's own lifetime. Their server-side state
       * dies around 8 minutes; their client re-resolves at that mark, and our
       * player now can too. The re-issue goes STRAIGHT to the SSR page — it
       * deliberately ignores the streams cache, because the whole point is that
       * the cached answer is the thing that died.
       */
      refresh: async () => {
        const fresh = await probeRanked(anilistId, ep).catch(() => [] as WatchSource[]);
        // SAME ROW, not merely "a source". With several sub streams in the
        // list a blind `fresh[0]` would hand this row another server's token —
        // the player only splices a refresh whose url CHANGED, so that swap
        // would land as if it were a re-mint of THIS stream.
        return fresh.find((s) => s.quality === qualityLabel) ?? fresh[0] ?? null;
      },
    };
  }

  /**
   * The `/api/sources` state for THIS page's session token. `resolve()` walks
   * EVERY entry of `streams` — one row per sub server — and maps each row's own
   * subtitles onto it (each with the Referer headers the `/v/` routes demand),
   * preferring those fresh stream tokens over the page-scraped one.
   *
   * Fail-closed: a bad shape, a failed decode or an empty `streams` throws —
   * the caller keeps the SSR-page source, which plays fine and merely ships no
   * manifest subs (MegaPlay remains a sub-bearing neighbour).
   */
  async function apiSources(
    anilistId: number,
    ep: number,
    session: string
  ): Promise<BingrSourcesState & { streams: BingrStream[] }> {
    const q = new URLSearchParams({
      kind: 'anime',
      anilist: String(anilistId),
      e: String(ep),
      audio: 'sub',
      t: session,
    });
    const body = await fetchText(
      `${SITE}/api/sources?${q.toString()}`,
      15000,
      { headers: { 'User-Agent': UA } },
      'Bingr sources'
    );
    const state = decodeSourcesPayload(body);
    if (!Array.isArray(state?.streams)) throw new Error('Bingr: sources payload without streams');
    return state as BingrSourcesState & { streams: BingrStream[] };
  }

  function toSubTracks(st: BingrStream): SubtitleTrack[] {
    return (st.subtitles ?? [])
      .filter((s) => typeof s?.url === 'string' && s.url.startsWith('https://hikari.streamrip.fun/v/'))
      .map((s) => ({
        url: s.url,
        lang: s.lang ?? undefined,
        label: s.label ?? s.lang ?? 'Subtitles',
        // 🔴 `/v/` answers a JSON-shaped 404 without `Referer: bingr.one` —
        // verified: SAME url, no Referer → 404 `{"ok":false,"error":"not
        // found"}`; with Referer → 200 `WEBVTT`. The player's subtitle fetch
        // sends `_headers`, so this is the whole fix.
        headers: SUB_HEADERS,
      }));
  }

  /** SSR → extract → probe → rank → enrich. The one path every caller shares. */
  async function probeRanked(anilistId: number, ep: number): Promise<WatchSource[]> {
    const page = await watchPageData(anilistId, ep);
    const tokens = [...new Set(
      (page.html.match(/https:\/\/hikari\.streamrip\.fun\/p\/[A-Za-z0-9_-]+/g) ?? [])
    )];
    if (!tokens.length) throw new Error('Bingr: no stream token on the watch page');
    const sources = tokens.map((url) => mintSource(anilistId, ep, url, [], page));

    // Probe, as before — this proves the whole first hop before the player
    // counts on it, cheaply on a short-token 8s deadline.
    const probes = await Promise.all(
      sources.map((s) => probeSource(s.url, s.container, s.headers ?? {}))
    );
    const ranked = sources
      .map((s, i) => ({ s, ...probes[i] }))
      .filter((x) => x.alive)
      .sort((a, b) => Number(b.video) - Number(a.video))
      .map((x) => x.s);
    if (!ranked.length) throw new Error('Bingr: all streams dead');

    // Subtitles live on the /api/sources mint, not in the page or the master.
    // The decoded stream token is a FRESH mint of the same provider — probing
    // it here (one more master fetch) is what lets the extension RETURN a
    // source that has both a live stream and its subs rather than pairing a
    // subs list with a token it never verified. Anything else (wrong token
    // shape, expired session, gate) leaves the SSR-page source in place.
    if (page.session) {
      try {
        const st = await apiSources(anilistId, ep, page.session);
        // EVERY SUB STREAM, NOT JUST THE FIRST. `?audio=sub` answers with the
        // whole sub matrix — the servers their own player lists as Katana /
        // Ronin / Shogun / Ninja — and `streams[0]` used to be taken while the
        // rest were thrown away. Each stream is its own row now, carrying ITS
        // OWN subtitles: a `/v/` track is bound to the token it arrived with,
        // so subs cannot be borrowed across servers.
        //
        // Labels come from the SERVER LIST when it aligns one-to-one with the
        // streams (the usual shape), otherwise from the stream's own label, and
        // "Katana" only when nothing distinguishes it — naming a row after a
        // server it is not would be worse than the generic name.
        const aligned = st.servers?.length === st.streams.length;
        const seenUrl = new Set<string>();
        const candidates: { url: string; subs: SubtitleTrack[]; label: string }[] = [];
        st.streams.forEach((s, i) => {
          if (!s?.url || !STREAM_URL.test(s.url) || seenUrl.has(s.url)) return;
          const serverId = aligned ? (st.servers?.[i]?.id ?? '') : '';
          // SUB AUDIO ONLY. The request already says `audio=sub`; a dub server
          // appearing in the matrix would play the wrong voice track under
          // subtitle lines, so it is dropped rather than offered.
          if (/dub/i.test(serverId)) return;
          seenUrl.add(s.url);
          candidates.push({
            url: s.url,
            subs: toSubTracks(s),
            label: serverLabel(serverId) ?? s.label ?? 'Katana',
          });
        });
        // Probe together: N servers must cost one round-trip, not N.
        const alive = await Promise.all(
          candidates.map((c) =>
            probeSource(c.url, 'hls', { 'User-Agent': UA })
              .then((p) => p.alive === true)
              .catch(() => false)
          )
        );
        const minted = candidates
          .filter((_, i) => alive[i])
          .map((c) => mintSource(anilistId, ep, c.url, c.subs, page, c.label));
        if (minted.length) {
          // Drop the page-scraped rows that carry the SAME token — the mint
          // window re-serves it (see the header) — keeping the minted row,
          // which is the one with subtitles attached.
          const freshUrls = new Set(minted.map((s) => s.url));
          return [...minted, ...ranked.filter((s) => !freshUrls.has(s.url))];
        }
      } catch {
        /* the page source stays; Mega remains the neighbour with subs */
      }
    }
    return ranked;
  }

  return {
    id: 'filmu',
    label: 'Bingr (Anime)',
    version: '3.2.0',
    contractVersion: 1,
    capabilities: { subtitles: true, skipMarkers: true, thumbnails: true },

    async match(anilistId: number): Promise<ExtensionMatch> {
      try {
        const eps = await rawEpisodes(anilistId);
        return { available: eps.length > 0 };
      } catch {
        return { available: false };
      }
    },

    async episodes(anilistId: number): Promise<EpisodeInfo[]> {
      const eps = await rawEpisodes(anilistId);
      const infos: BingrEpisodeInfo[] = eps
        .map((e) => ({
          number: Number(e.episode),
          title: e.title || `Episode ${e.episode}`,
          // `/original/` stills are ~200KB each; thirteen rows at once on a
          // phone is real airtime. `/w500/` is the same host's ~26KB rendition
          // (same host — a blocked host stays blocked either way; a SLOW one
          // now finishes eight times sooner).
          poster: e.still
            ? e.still.replace('/t/p/original/', '/t/p/w500/')
            : null,
          synopsis: e.overview ?? null,
        }))
        .filter((e) => Number.isFinite(e.number) && e.number > 0)
        .sort((a, b) => a.number - b.number);
      return infos;
    },

    async resolve(anilistId: number, ep: number): Promise<WatchSource[]> {
      const key = `${anilistId}:${ep}`;
      const hit = streamsCache.get(key);
      if (hit && Date.now() - hit.at < STREAMS_TTL) return hit.data;

      const ranked = await probeRanked(anilistId, ep);
      streamsCache.set(key, { at: Date.now(), data: ranked });
      return ranked;
    },
  };
}
