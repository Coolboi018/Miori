// MegaPlay extension — direct backend client (no iframe).
// Mobile port of anime-frontend src/lib/server/mega.ts.
// Flow: embed page (MAL id first) -> data-id -> getSourcesNew -> AES decrypt
// -> HLS url + raw .vtt subs + intro/outro markers.
// NOTE: Mega has no episode-list API. episodes() returns [] and the UI
// falls back to the FilmU list (or AniList count -> 1..N).

import { decryptMegaEnc } from '../../crypto/mega-crypto';
import type {
  EpisodeInfo,
  Extension,
  ExtensionMatch,
  WatchSource,
} from '../types';
import { fetchJson, fetchText, playableContainer, probeSource } from '../fetch';

export const MEGA_ORIGIN = 'https://megaplay.buzz';
/** Referer their CDN expects on stream + subtitle fetches. */
export const MEGA_REFERER = 'https://megaplay.buzz/';
/** Stand-in origin for the embed-page fetch (web sent its own site origin). */
const PAGE_REFERER = 'https://miori.app/';

/** Shared UA — anikoto's providers land on megaplay too, so both extensions
 *  must send the same fingerprint (one embed cache, one verdict history). */
export const MEGA_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const UA = MEGA_UA;

const PAGE_HEADERS: Record<string, string> = {
  'User-Agent': UA,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Sec-Fetch-Dest': 'iframe',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'cross-site',
  'Upgrade-Insecure-Requests': '1',
};

interface MegaTrack {
  file: string;
  label?: string;
  kind?: string;
}

interface MegaSources {
  file: string;
  tracks: MegaTrack[];
  intro: { start: number; end: number } | null;
  outro: { start: number; end: number } | null;
}

const pageCache = new Map<string, { at: number; html: string }>();
const sourcesCache = new Map<string, { at: number; data: MegaSources }>();
const PAGE_TTL = 24 * 3600 * 1000;
const SOURCES_TTL = 10 * 60 * 1000; // file urls carry expiring tokens

function candidates(
  malId: number | null | undefined,
  anilistId: number,
  ep: number
): string[] {
  const e = Math.max(1, Math.floor(ep));
  const out: string[] = [];
  if (malId && malId > 0)
    out.push(`${MEGA_ORIGIN}/stream/mal/${malId}/${e}/sub`);
  if (anilistId > 0) out.push(`${MEGA_ORIGIN}/stream/ani/${anilistId}/${e}/sub`);
  return out;
}

async function fetchPage(url: string): Promise<string> {
  const hit = pageCache.get(url);
  if (hit && Date.now() - hit.at < PAGE_TTL) return hit.html;
  const html = await fetchText(
    url,
    15000,
    {
      headers: { ...PAGE_HEADERS, Referer: PAGE_REFERER },
    },
    'MegaPlay page'
  );
  pageCache.set(url, { at: Date.now(), html });
  return html;
}

function extractDataId(html: string): string | null {
  if (/Error Code/.test(html)) return null;
  const m = html.match(/data-id="(\d+)"/);
  return m ? m[1] : null;
}

async function fetchSources(catalogId: string, embedUrl: string): Promise<MegaSources> {
  const hit = sourcesCache.get(catalogId);
  if (hit && Date.now() - hit.at < SOURCES_TTL) return hit.data;
  const j = await fetchJson<{
    enc?: string;
    tracks?: MegaTrack[];
    intro?: { start: number; end: number };
    outro?: { start: number; end: number };
  }>(
    `${MEGA_ORIGIN}/stream/getSourcesNew?id=${encodeURIComponent(catalogId)}`,
    15000,
    {
      headers: {
        'User-Agent': UA,
        Accept: 'application/json, text/javascript, */*; q=0.01',
        'X-Requested-With': 'XMLHttpRequest',
        Referer: embedUrl,
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
      },
    },
    'MegaPlay sources'
  );
  if (!j?.enc) throw new Error('MegaPlay sources: no enc');
  let file: string;
  try {
    const plain = decryptMegaEnc(j.enc);
    const parsed = JSON.parse(plain) as { file?: string };
    if (!parsed?.file) throw new Error('no file');
    file = parsed.file;
  } catch {
    throw new Error('MegaPlay decrypt failed (key rotated?)');
  }
  const data: MegaSources = {
    file,
    tracks: Array.isArray(j.tracks) ? j.tracks : [],
    intro: j.intro ?? null,
    outro: j.outro ?? null,
  };
  sourcesCache.set(catalogId, { at: Date.now(), data });
  return data;
}

/**
 * Shared megaplay flow for sibling extensions whose provider rows land on
 * megaplay embed urls (anikoto's HD-1/HD-2/Vidstream-1/2 do — verified
 * 12 Nov): embed page -> data-id -> getSourcesNew -> AES decrypt.
 * Throws on a missing mapping or a rotated key; callers own their labels.
 */
export async function fetchMegaSources(embedUrl: string): Promise<MegaSources> {
  const html = await fetchPage(embedUrl);
  const catalogId = extractDataId(html);
  if (!catalogId) throw new Error('MegaPlay has no mapping for this title');
  return fetchSources(catalogId, embedUrl);
}

export function createMegaExtension(): Extension {
  async function resolveEmbed(
    malId: number | null | undefined,
    anilistId: number,
    ep: number
  ): Promise<string | null> {
    for (const u of candidates(malId, anilistId, ep)) {
      try {
        const html = await fetchPage(u);
        if (extractDataId(html)) return u;
      } catch {
        /* try next */
      }
    }
    return null;
  }

  return {
    id: 'mega',
    label: 'MegaPlay',
    version: '1.0.0',
    contractVersion: 1,
    capabilities: { subtitles: true, skipMarkers: true, thumbnails: false },

    async match(
      anilistId: number,
      idMal?: number | null
    ): Promise<ExtensionMatch> {
      // Probe ep 1 mapping (page cache = 24h, so this is cheap after first).
      const found = await resolveEmbed(idMal, anilistId, 1).catch(() => null);
      return found ? { available: true } : { available: false };
    },

    async episodes(): Promise<EpisodeInfo[]> {
      return []; // no episode API — UI falls back to FilmU / AniList count
    },

    async resolve(
      anilistId: number,
      ep: number,
      idMal?: number | null
    ): Promise<WatchSource[]> {
      const embedUrl = await resolveEmbed(idMal, anilistId, ep);
      if (!embedUrl) throw new Error('MegaPlay has no mapping for this title');
      const html = await fetchPage(embedUrl);
      const catalogId = extractDataId(html);
      if (!catalogId) throw new Error('MegaPlay has no mapping for this title');
      const src = await fetchSources(catalogId, embedUrl);
      const container = playableContainer(src.file);
      if (!container) throw new Error('MegaPlay: unplayable container');
      const headers = {
        Referer: MEGA_REFERER,
        Origin: MEGA_ORIGIN,
        'User-Agent': UA,
      };
      // probeSource, not probeHls: an mp4 has no playlist, and probing it as
      // HLS returned alive:false for every mp4 — which is exactly why Mega
      // never appeared as a failover (progress.md, known problem #10).
      const probe = await probeSource(src.file, container, headers);
      if (!probe.alive) throw new Error('MegaPlay stream dead');
      return [
        {
          url: src.file,
          container,
          quality: 'MegaPlay',
          headers,
          subtitles: src.tracks
            .filter((t) => !!t?.file)
            .map((t) => ({
              label: t.label || 'Subtitle',
              url: t.file,
              headers: { Referer: MEGA_REFERER },
            })),
          intro: src.intro,
          outro: src.outro,
        },
      ];
    },
  };
}
