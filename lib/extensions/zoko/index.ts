// ZokoAnime extension — zokoanime.video (discovered via hianime.at's player
// list, but called DIRECTLY; hianime.at itself is not involved).
//
// Verified contract 12 Nov (scrapper.md, hianime.at note):
//   embed page : /stream/mal/{malId}/{ep}/{lang} or /stream/ani/{anilistId}/…
//                (BOTH routes verified 200 on the golden title; ani route
//                covers the no-MAL fallback our mega extension lacks)
//   config     : the page carries `window.__P` — standard base64 of a
//                XOR-with-"otaku-embed-v1" obfuscation of the player JSON.
//                Trivial by design; key found in their core/obfuscate.js.
//   stream     : `src` = signed hls.dramahot.top/p/…/master.m3u8 (HLS ladder),
//                `subtitles[]` = VTT on the same host, `skip` = intro/outro.
//                Referer-gated: 200 ONLY with `Referer: https://zokoanime.video/`
//                (403 bare, 403 with another referer — verified both).
//
// dramahot is a DIFFERENT CDN from mega's nexabloom (sibling operator, same
// /stream/mal/ route family) — the value here is redundancy: an independent
// second door to the same rips when nexabloom dies or is ISP-blocked.
// Same rips = same episode content; NOT new provider diversity (scrapper.md).

import type {
  EpisodeInfo,
  Extension,
  ExtensionMatch,
  WatchSource,
} from '../types';
import { fetchText, playableContainer, probeSource } from '../fetch';

const ZOKO_ORIGIN = 'https://zokoanime.video';
export const ZOKO_REFERER = 'https://zokoanime.video/';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const PAGE_HEADERS: Record<string, string> = {
  'User-Agent': UA,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Sec-Fetch-Dest': 'iframe',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'cross-site',
  'Upgrade-Insecure-Requests': '1',
  Referer: 'https://hianime.at/',
};

const STREAM_HEADERS: Record<string, string> = {
  Referer: ZOKO_REFERER,
  Origin: ZOKO_ORIGIN,
  'User-Agent': UA,
};

// ---- config decode ----

const OBF_KEY = 'otaku-embed-v1';

interface ZokoSubtitle {
  lang?: string;
  label?: string;
  src?: string;
}

interface ZokoConfig {
  src?: string;
  subtitles?: ZokoSubtitle[];
  skip?: { intro?: { start: number; end: number }; outro?: { start: number; end: number } };
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function base64ToBytes(input: string): Uint8Array {
  const b64 = input.replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, '');
  const clean = b64.replace(/=+$/, '');
  const out: number[] = [];
  for (let i = 0; i < clean.length; i += 4) {
    const c0 = B64.indexOf(clean[i]);
    const c1 = B64.indexOf(clean[i + 1]);
    const c2 = clean[i + 2] !== undefined ? B64.indexOf(clean[i + 2]) : 0;
    const c3 = clean[i + 3] !== undefined ? B64.indexOf(clean[i + 3]) : 0;
    if (c0 < 0 || c1 < 0 || c2 < 0 || c3 < 0) throw new Error('bad base64');
    const n = (c0 << 18) | (c1 << 12) | (c2 << 6) | c3;
    out.push((n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff);
  }
  const pad = (b64.match(/=+$/) || [''])[0].length;
  return new Uint8Array(out.slice(0, out.length - (pad === 2 ? 2 : pad === 1 ? 1 : 0)));
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

/** `window.__P` blob -> player config JSON text (XOR `otaku-embed-v1`). */
export function decodeZokoBlob(blob: string): ZokoConfig {
  const bytes = base64ToBytes(blob.trim());
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    out[i] = bytes[i] ^ OBF_KEY.charCodeAt(i % OBF_KEY.length);
  }
  return JSON.parse(utf8Decode(out)) as ZokoConfig;
}

// ---- embed flow ----

const pageCache = new Map<string, { at: number; html: string }>();
const PAGE_TTL = 60 * 60 * 1000; // config carries no per-mint token; the STREAM does

async function fetchEmbed(url: string): Promise<string> {
  const hit = pageCache.get(url);
  if (hit && Date.now() - hit.at < PAGE_TTL) return hit.html;
  const html = await fetchText(url, 15000, { headers: PAGE_HEADERS }, 'Zoko embed page');
  pageCache.set(url, { at: Date.now(), html });
  return html;
}

function embedCandidates(
  malId: number | null | undefined,
  anilistId: number,
  ep: number
): string[] {
  const e = Math.max(1, Math.floor(ep));
  const out: string[] = [];
  if (malId && malId > 0) out.push(`${ZOKO_ORIGIN}/stream/mal/${malId}/${e}/sub`);
  if (anilistId > 0) out.push(`${ZOKO_ORIGIN}/stream/ani/${anilistId}/${e}/sub`);
  return out;
}

async function resolveConfig(
  malId: number | null | undefined,
  anilistId: number,
  ep: number
): Promise<{ config: ZokoConfig; embedUrl: string }> {
  for (const url of embedCandidates(malId, anilistId, ep)) {
    try {
      const html = await fetchEmbed(url);
      const m = html.match(/window\.__P="([^"]+)"/);
      if (!m) continue;
      const config = decodeZokoBlob(m[1]);
      if (config?.src) return { config, embedUrl: url };
    } catch {
      /* try next */
    }
  }
  throw new Error('Zoko: no mapping for this title');
}

// ---- extension ----

export function createZokoExtension(): Extension {
  async function buildSource(
    malId: number | null | undefined,
    anilistId: number,
    ep: number
  ): Promise<WatchSource> {
    const { config, embedUrl } = await resolveConfig(malId, anilistId, ep);
    const src = config.src as string;
    const container = playableContainer(src);
    if (!container) throw new Error('Zoko: unplayable container');
    const probe = await probeSource(src, container, STREAM_HEADERS);
    if (!probe.alive) throw new Error('Zoko stream dead');
    return {
      url: src,
      container,
      quality: 'ZokoAnime',
      headers: STREAM_HEADERS,
      subtitles: (config.subtitles ?? [])
        .filter((t) => !!t?.src)
        .map((t) => ({
          label: t.label || t.lang || 'Subtitle',
          lang: t.lang,
          url: t.src as string,
          headers: { Referer: ZOKO_REFERER },
        })),
      intro: config.skip?.intro ?? null,
      outro: config.skip?.outro ?? null,
      // dramahot paths are signed like hikari's (same /p/ shape) — the player
      // gets ONE in-place refresh before hopping, matching the Katana lesson.
      refresh: async () => {
        try {
          pageCache.delete(embedUrl);
          return await buildSource(malId, anilistId, ep);
        } catch {
          return null;
        }
      },
    };
  }

  return {
    id: 'zoko',
    label: 'ZokoAnime',
    version: '1.0.0',
    contractVersion: 1,
    capabilities: { subtitles: true, skipMarkers: true, thumbnails: false },

    async match(anilistId, idMal): Promise<ExtensionMatch> {
      try {
        await resolveConfig(idMal, anilistId, 1);
        return { available: true };
      } catch {
        return { available: false };
      }
    },

    async episodes(): Promise<EpisodeInfo[]> {
      return []; // no episode API — UI falls back to FilmU / AniList count
    },

    async resolve(anilistId, ep, idMal): Promise<WatchSource[]> {
      const src = await buildSource(idMal, anilistId, ep);
      return [src];
    },
  };
}
