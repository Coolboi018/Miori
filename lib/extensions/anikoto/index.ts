// Anikoto extension — anikoto.cz (the whole jQuery-template family:
// animesogo.to / anichi.cz / anisuge.tv share the shape; domain-swap ports).
//
// Verified contract 12 Nov (scrapper.md Source 4):
//   match   : search (keyword, no vrf) -> /watch/{slug} page `data-id`
//             -> catalog /series/{id} -> `ani_id`/`mal_id` equality.
//   episodes: catalog /series/{id} — number + title (NO stills; the app's
//             Kitsu merge supplies thumbnails — do not "fix" by dropping rows).
//   resolve : ajax/episode/list/{id}?vrf -> `data-ids` (RAW base64 attr —
//             jQuery .data() does NOT decode it; decoded = 500, verified)
//             -> ajax/server/list?servers&vrf -> provider rows (HD-1, HD-2,
//             Vidstream-1, Vidstream-2) -> ajax/server?get={link-id} (NO vrf)
//             -> megaplay.buzz url + skip_data -> existing mega decrypt chain.
//
// The provider labels are megaplay FLAVORS: for the same episode HD-1/HD-2/
// Vidstream-1/2 all land on the same megaplay embed id (only `?s=` CDN-hint
// differs) and decrypt to one identical master. They are emitted as separate
// WatchSources deliberately (user's Option A): four independent rows in the
// source sheet, each with its own refresh path — one breaking doesn't kill
// the others (the Katana/Mega redundancy lesson of 11 Nov).
//
// The nekostream mapper (animepahe/"Kiwi" etc.) is PARKED, not called here:
// its entries are download links behind a Cloudflare challenge (verified),
// not playable streams. scrapper.md Source 4 holds the correction.

import { anikotoVrf } from '../../crypto/anikoto-crypto';
import { decryptMegaEnc } from '../../crypto/mega-crypto';
import type {
  EpisodeInfo,
  Extension,
  ExtensionMatch,
  ResolveHint,
  WatchSource,
} from '../types';
import { fetchJson, fetchText, probeSource } from '../fetch';
import { fetchMegaSources, MEGA_REFERER, MEGA_ORIGIN, MEGA_UA } from '../mega';

const SITE = 'https://anikoto.cz';
const CATALOG = 'https://anikotoapi.site';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const AJAX_HEADERS: Record<string, string> = {
  'User-Agent': UA,
  Accept: 'application/json, text/javascript, */*; q=0.01',
  'X-Requested-With': 'XMLHttpRequest',
  Referer: `${SITE}/`,
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
};

const PAGE_HEADERS: Record<string, string> = {
  'User-Agent': UA,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  Referer: `${SITE}/`,
};

const STREAM_HEADERS: Record<string, string> = {
  Referer: MEGA_REFERER,
  Origin: MEGA_ORIGIN,
  'User-Agent': MEGA_UA,
};

interface AnikotoEpisode {
  id: number;
  title: string;
  jp_title?: string;
  number: number;
  episode_embed_id?: string;
  embed_url?: { sub?: string; dub?: string };
}

interface AnikotoSeries {
  anime: {
    id: number;
    title: string;
    slug: string;
    poster?: string;
    description?: string;
    mal_id?: string;
    ani_id?: string;
    episodes?: number;
  };
  episodes: AnikotoEpisode[];
}

// ---- caches (same discipline as mega: pages long, streams short) ----

const showIdCache = new Map<number, { showId: number; at: number }>();
const slugShowCache = new Map<string, { showId: number; at: number }>();
const seriesCache = new Map<number, { series: AnikotoSeries; at: number }>();
const epListCache = new Map<number, { rows: EpisodeRow[]; at: number }>();
const serverListCache = new Map<string, { html: string; at: number }>();
const serverUrlCache = new Map<string, { url: string; at: number }>();

const SHOW_TTL = 24 * 3600 * 1000;
const SERIES_TTL = 24 * 3600 * 1000;
const EP_LIST_TTL = 60 * 60 * 1000;
const SERVER_LIST_TTL = 10 * 60 * 1000;
const SERVER_URL_TTL = 10 * 60 * 1000;

// ---- mapping: anilist id -> anikoto show id ----

async function fetchSeries(showId: number): Promise<AnikotoSeries> {
  const hit = seriesCache.get(showId);
  if (hit && Date.now() - hit.at < SERIES_TTL) return hit.series;
  const j = await fetchJson<{ ok: boolean; data: AnikotoSeries }>(
    `${CATALOG}/series/${showId}`,
    15000,
    { headers: { 'User-Agent': UA, Accept: 'application/json' } },
    'Anikoto catalog'
  );
  if (!j?.ok || !j?.data?.anime) throw new Error('Anikoto catalog: bad shape');
  seriesCache.set(showId, { at: Date.now(), series: j.data });
  return j.data;
}

function slugFromHref(href: string): string | null {
  const m = href.match(/\/watch\/([a-z0-9-]+)/i);
  return m ? m[1] : null;
}

async function showIdFromSlug(slug: string): Promise<number | null> {
  const hit = slugShowCache.get(slug);
  if (hit && Date.now() - hit.at < SHOW_TTL) return hit.showId;
  const html = await fetchText(`${SITE}/watch/${slug}`, 15000, { headers: PAGE_HEADERS }, 'Anikoto watch page');
  const m = html.match(/data-id="(\d+)"/);
  if (!m) return null;
  const showId = Number(m[1]);
  slugShowCache.set(slug, { at: Date.now(), showId });
  return showId;
}

/**
 * anilist id -> anikoto show id. Search keywords come from the caller's
 * ResolveHint (additive contract) — the catalog has no ani/mal-keyed lookup
 * route (verified 404s), so keyword search + catalog-id equality is the only
 * mapping. Candidate slugs are verified against the CATALOG ids, never the
 * search order alone (season variants share title text).
 */
async function ensureShowId(
  anilistId: number,
  idMal: number | null | undefined,
  hint?: ResolveHint
): Promise<{ showId: number; series: AnikotoSeries }> {
  const hit = showIdCache.get(anilistId);
  if (hit && Date.now() - hit.at < SHOW_TTL) {
    return { showId: hit.showId, series: await fetchSeries(hit.showId) };
  }

  const titles = (hint?.titles ?? [])
    .map((t) => (t || '').trim())
    .filter((t) => t.length >= 3)
    .filter((t, i, a) => a.indexOf(t) === i)
    .slice(0, 3);

  for (const kw of titles) {
    let slugs: string[] = [];
    try {
      const j = await fetchJson<{ status: number; result?: { html?: string } }>(
        `${SITE}/ajax/anime/search?keyword=${encodeURIComponent(kw)}`,
        15000,
        { headers: AJAX_HEADERS },
        'Anikoto search'
      );
      const html = j?.result?.html ?? '';
      const hrefs = html.match(/href="[^"]*\/watch\/[a-z0-9-]+/gi) ?? [];
      slugs = hrefs
        .map(slugFromHref)
        .filter((s): s is string => !!s)
        .filter((s, i, a) => a.indexOf(s) === i)
        .slice(0, 4);
    } catch {
      continue;
    }
    for (const slug of slugs) {
      try {
        const showId = await showIdFromSlug(slug);
        if (!showId) continue;
        const series = await fetchSeries(showId);
        const ani = String(series.anime.ani_id ?? '');
        const mal = String(series.anime.mal_id ?? '');
        if (ani === String(anilistId) || (idMal && mal === String(idMal))) {
          showIdCache.set(anilistId, { at: Date.now(), showId });
          return { showId, series };
        }
      } catch {
        /* next candidate */
      }
    }
  }
  throw new Error('Anikoto: no mapping for this title');
}

// ---- site ajax chain ----

interface EpisodeRow {
  num: number;
  ids: string; // RAW data-ids attribute (base64, NOT decoded)
  slug: string;
  mal: string;
  sub: boolean;
  dub: boolean;
}

async function fetchEpisodeRows(showId: number): Promise<EpisodeRow[]> {
  const hit = epListCache.get(showId);
  if (hit && Date.now() - hit.at < EP_LIST_TTL) return hit.rows;
  const j = await fetchJson<{ status: number; result?: string }>(
    `${SITE}/ajax/episode/list/${showId}?vrf=${encodeURIComponent(anikotoVrf(String(showId)))}`,
    15000,
    { headers: AJAX_HEADERS },
    'Anikoto episode list'
  );
  if (j?.status !== 200 || !j?.result) throw new Error(`Anikoto episode list HTTP ${j?.status}`);
  const html = j.result;
  const rows: EpisodeRow[] = [];
  const anchors = html.match(/<a [^>]*data-ids="[^"]*"[^>]*>/g) ?? [];
  for (const a of anchors) {
    const get = (n: string) => (a.match(new RegExp(`data-${n}="([^"]*)"`)) || [])[1] ?? '';
    const num = Number(get('num'));
    if (!Number.isFinite(num) || num <= 0) continue;
    rows.push({
      num,
      ids: get('ids'),
      slug: get('slug'),
      mal: get('mal'),
      sub: get('sub') === '1',
      dub: get('dub') === '1',
    });
  }
  if (!rows.length) throw new Error('Anikoto episode list: no rows');
  epListCache.set(showId, { at: Date.now(), rows });
  return rows;
}

/**
 * Provider rows for one episode, SUB bucket only (dub parked with the rest
 * of the language work). Labels are the site's own: HD-1, HD-2, Vidstream-1…
 * Deduped by label — the same `<li>` is served once per rendering pass.
 */
async function fetchProviderRows(showId: number, ep: number, ids: string): Promise<Array<{ label: string; linkId: string }>> {
  const key = `${showId}:${ep}`;
  const hit = serverListCache.get(key);
  let html: string;
  if (hit && Date.now() - hit.at < SERVER_LIST_TTL) {
    html = hit.html;
  } else {
    const j = await fetchJson<{ status: number; result?: string }>(
      `${SITE}/ajax/server/list?servers=${encodeURIComponent(ids)}&vrf=${encodeURIComponent(anikotoVrf(ids))}`,
      15000,
      { headers: AJAX_HEADERS },
      'Anikoto server list'
    );
    if (j?.status !== 200 || !j?.result) throw new Error(`Anikoto server list HTTP ${j?.status}`);
    html = j.result;
    serverListCache.set(key, { at: Date.now(), html });
  }

  // SUB bucket only: cut at the dub block if present.
  const subPart = html.split('data-type="dub"')[0];
  const items = subPart.match(/<li [^>]*data-link-id="[^"]*"[^>]*>[^<]*</g) ?? [];
  const seen = new Set<string>();
  const out: Array<{ label: string; linkId: string }> = [];
  for (const raw of items) {
    const linkId = (raw.match(/data-link-id="([^"]*)"/) || [])[1];
    const label = ((raw.match(/>([^<]*)</) || [])[1] ?? '').trim();
    if (!linkId || !label || seen.has(label)) continue;
    seen.add(label);
    out.push({ label, linkId });
  }
  return out;
}

async function fetchServerUrl(linkId: string): Promise<string> {
  const hit = serverUrlCache.get(linkId);
  if (hit && Date.now() - hit.at < SERVER_URL_TTL) return hit.url;
  const j = await fetchJson<{ status: number; result?: { url?: string } }>(
    `${SITE}/ajax/server?get=${encodeURIComponent(linkId)}`,
    15000,
    { headers: AJAX_HEADERS },
    'Anikoto server url'
  );
  const url = j?.result?.url;
  if (j?.status !== 200 || !url) throw new Error(`Anikoto server url HTTP ${j?.status}`);
  serverUrlCache.set(linkId, { at: Date.now(), url });
  return url;
}

// ---- extension ----

export function createAnikotoExtension(): Extension {
  async function resolveProviders(
    anilistId: number,
    ep: number,
    idMal: number | null | undefined,
    hint?: ResolveHint
  ): Promise<WatchSource[]> {
    const { showId } = await ensureShowId(anilistId, idMal, hint);
    const rows = await fetchEpisodeRows(showId);
    const row = rows.find((r) => r.num === Math.max(1, Math.floor(ep)));
    if (!row) throw new Error('Anikoto: episode not in list');
    if (!row.sub) throw new Error('Anikoto: no sub for this episode');

    const providers = await fetchProviderRows(showId, row.num, row.ids);
    if (!providers.length) throw new Error('Anikoto: no provider rows');

    // fan out, label kept — four independent rows (Option A), each probed.
    const settled = await Promise.allSettled(
      providers.map(async (p) => {
        const embedUrl = await fetchServerUrl(p.linkId);
        const src = await fetchMegaSources(embedUrl);
        const probe = await probeSource(src.file, 'hls', STREAM_HEADERS);
        if (!probe.alive) throw new Error('stream dead');
        const src2: WatchSource = {
          url: src.file,
          container: 'hls',
          quality: `Anikoto ${p.label}`,
          headers: STREAM_HEADERS,
          subtitles: src.tracks
            .filter((t) => !!t?.file)
            .map((t) => ({
              label: t.label || 'Subtitle',
              url: t.file,
              headers: { Referer: MEGA_REFERER },
            })),
          intro: src.intro,
          outro: src.outro,
        };
        return src2;
      })
    );
    const out = settled
      .filter((s): s is PromiseFulfilledResult<WatchSource> => s.status === 'fulfilled')
      .map((s) => s.value);
    if (!out.length) throw new Error('Anikoto: every provider dead');
    return out;
  }

  return {
    id: 'anikoto',
    label: 'Anikoto',
    version: '1.0.0',
    contractVersion: 1,
    capabilities: { subtitles: true, skipMarkers: true, thumbnails: false },

    async match(anilistId, idMal, hint): Promise<ExtensionMatch> {
      try {
        await ensureShowId(anilistId, idMal, hint);
        return { available: true };
      } catch {
        return { available: false };
      }
    },

    async episodes(anilistId, idMal, hint): Promise<EpisodeInfo[]> {
      const { series } = await ensureShowId(anilistId, idMal, hint);
      const seen = new Set<number>();
      const out: EpisodeInfo[] = [];
      for (const e of series.episodes ?? []) {
        const num = Math.floor(Number(e.number));
        if (!Number.isFinite(num) || num <= 0 || seen.has(num)) continue;
        seen.add(num);
        out.push({ number: num, title: e.title || e.jp_title || undefined, poster: null, synopsis: null });
      }
      return out;
    },

    async resolve(anilistId, ep, idMal, hint): Promise<WatchSource[]> {
      return resolveProviders(anilistId, ep, idMal, hint);
    },
  };
}
