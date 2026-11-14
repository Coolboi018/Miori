// Manifest -> Extension interpreter (Phase 3, simple sources).
//
// Supports single-fetch episode lists and single-fetch resolves. Multi-step flows
// (FilmU's SSR + /api/sources) are NOT expressible here yet — those stay as
// built-ins or require new engine capabilities. A manifest needing an unknown
// transform is skipped at load time rather than crashing.

import type { EpisodeInfo, Extension, ExtensionMatch, SubtitleTrack, WatchSource } from '../types';
import { fetchJson, fetchText, fetchTimed } from '../fetch';
import { getTool, hasTool, renderTemplate } from '../tools';
import { validateManifest } from './schema';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

interface MfHeaders { [k: string]: string }

interface MfEpisode {
  url?: string;
  transform?: string;
  headers?: MfHeaders;
  method?: 'GET';
  // paging
  paging?: { param: string; start?: number; stopWhen?: string; cap?: number };
  map?: {
    number: string;
    title?: string;
    poster?: string | { path: string; transform?: string };
    synopsis?: string;
    duration?: string;
  };
  dedupeBy?: 'number';
  emptyIsFailure?: boolean;
}

interface MfResolve {
  url?: string;
  transform?: string;
  headers?: MfHeaders;
  stream?: { jsonPath?: string; regex?: string };
  container?: 'hls' | 'mp4' | 'auto';
  quality?: string;
  subtitles?: { path: string; url: string; label?: string; lang?: string; headers?: MfHeaders };
  intro?: string;
  outro?: string;
  signed?: boolean;
}

interface MfManifest {
  contractVersion: number;
  id: string;
  label: string;
  version: string;
  capabilities?: Record<string, boolean>;
  match?: { probe?: 'episodes' | 'url'; url?: string; headers?: MfHeaders; minItems?: number; transform?: string };
  episodes?: MfEpisode;
  resolve?: MfResolve;
}

function renderHeaders(h: MfHeaders | undefined, vars: Record<string, string | number>): Record<string, string> {
  const out: Record<string, string> = {};
  if (!h) return out;
  for (const [k, v] of Object.entries(h)) out[k] = renderTemplate(v, vars);
  return out;
}

function pathOrTransform(raw: any, spec: string | { path: string; transform?: string } | undefined, vars: any): any {
  if (!spec) return undefined;
  if (typeof spec === 'string') {
    // support "regex:/pattern/" prefix
    if (spec.startsWith('regex:')) {
      const pat = spec.slice(6);
      const m = new RegExp(pat).exec(String(raw ?? ''));
      return m ? (m[1] ?? m[0]) : undefined;
    }
    // jsonpath-ish via tools
    const tool = getTool('json-path');
    return tool ? tool(raw, spec) : undefined;
  }
  const tool = getTool('json-path');
  let val = spec.path.startsWith('regex:') ? null : (tool ? tool(raw, spec.path) : undefined);
  if (spec.path.startsWith('regex:')) {
    const m = new RegExp(spec.path.slice(6)).exec(String(raw ?? ''));
    val = m ? (m[1] ?? m[0]) : undefined;
  }
  if (spec.transform === 'tmdb-w500' && typeof val === 'string') {
    val = val.replace('/t/p/original/', '/t/p/w500/');
  }
  return val;
}

function stopPaging(obj: any, stopWhen: string | undefined, items: any[]): boolean {
  if (!stopWhen) return items.length === 0;
  if (stopWhen === 'has_next_page==false') return obj?.has_next_page !== true;
  if (stopWhen.endsWith('==0') || stopWhen.includes('.length==0')) {
    const key = stopWhen.split('.')[0];
    const arr = obj?.[key];
    return !Array.isArray(arr) || arr.length === 0;
  }
  return items.length === 0;
}

export function manifestToExtension(mf: MfManifest, _repoUrl: string): Extension {
  const id = mf.id;
  const vars0 = { ua: UA };

  async function fetchEpisodes(anilistId: number, idMal?: number | null, hint?: any): Promise<EpisodeInfo[]> {
    const ep = mf.episodes;
    if (!ep) return [];
    // Transform-based episodes (multi-step / search-based backends).
    if (ep.transform) {
      const tool = getTool(ep.transform);
      if (!tool) throw new Error(`${id}: unknown transform ${ep.transform}`);
      const data = await tool(anilistId, idMal ?? null, hint);
      if (!Array.isArray(data)) throw new Error(`${id}: episodes transform returned no array`);
      return data as EpisodeInfo[];
    }
    if (!ep.url) return [];
    const out: EpisodeInfo[] = [];
    const seen = new Set<number>();
    const start = ep.paging?.start ?? 0;
    const cap = ep.paging?.cap ?? 30;
    const param = ep.paging?.param ?? 'chunk';
    const stopWhen = ep.paging?.stopWhen;
    for (let i = start; i < start + cap; i++) {
      const vars = { ...vars0, anilistId, chunk: i, page: i };
      const url = renderTemplate(ep.url, vars);
      const headers = renderHeaders(ep.headers, vars);
      let data: any;
      try {
        data = await fetchJson<any>(url, 20000, { headers }, `${id} episodes`);
      } catch {
        break;
      }
      const itemsRaw = Array.isArray(data?.episodes) ? data.episodes
        : Array.isArray(data) ? data : (data?.items ?? data?.results ?? []);
      const items = Array.isArray(itemsRaw) ? itemsRaw : [];
      const map = ep.map ?? { number: 'number' };
      for (const it of items) {
        const num = Number(pathOrTransform(it, map.number, it));
        if (!Number.isFinite(num) || num <= 0) continue;
        if (ep.dedupeBy === 'number' && seen.has(num)) continue;
        seen.add(num);
        const posterSpec = map.poster;
        const poster = posterSpec ? pathOrTransform(it, posterSpec, it) : undefined;
        out.push({
          number: num,
          title: map.title ? String(pathOrTransform(it, map.title, it) ?? `Episode ${num}`) : `Episode ${num}`,
          poster: typeof poster === 'string' ? poster : null,
          synopsis: map.synopsis ? (pathOrTransform(it, map.synopsis, it) ?? null) : null,
          duration: map.duration ? (Number(pathOrTransform(it, map.duration, it)) || null) : null,
        });
      }
      if (stopPaging(data, stopWhen, items)) break;
      if (items.length === 0) break;
    }
    if (ep.emptyIsFailure !== false && out.length === 0) {
      throw new Error(`${id}: returned no episodes`);
    }
    return out.sort((a, b) => a.number - b.number);
  }

  async function resolveOne(anilistId: number, ep: number, idMal?: number | null, hint?: any): Promise<WatchSource[]> {
    const r = mf.resolve;
    if (!r) return [];
    const vars = { ...vars0, anilistId, ep, idMal: idMal ?? anilistId, episode: ep };

    // Transform-based resolve (multi-step flows live in the toolbox).
    // A transform may return a SINGLE descriptor OR an ARRAY of descriptors
    // (filmu's ranked mirrors, anikoto's megaplay flavors). All are probed;
    // the survivors are returned as independent sources.
    if (r.transform) {
      const tool = getTool(r.transform);
      if (!tool) throw new Error(`${id}: unknown transform ${r.transform}`);
      const raw: any = await tool(anilistId, ep, idMal ?? null, hint);
      const specs: any[] = Array.isArray(raw) ? raw
        : (raw && Array.isArray(raw.sources)) ? raw.sources
        : (raw && raw.url) ? [raw] : [];
      if (!specs.length) throw new Error(`${id}: transform returned no sources`);
      const { probeSource } = await import('../fetch');
      const out: WatchSource[] = [];
      for (const data of specs) {
        if (!data || !data.url) continue;
        const src: WatchSource = {
          url: data.url,
          container: data.container ?? 'hls',
          quality: data.quality ?? id,
          headers: data.headers,
          subtitles: data.subtitles,
          intro: data.intro ?? null,
          outro: data.outro ?? null,
        };
        if (r.signed) {
          src.refresh = async () => {
            try {
              const fresh = await resolveOne(anilistId, ep, idMal);
              return fresh.find((s) => s.quality === src.quality) ?? fresh[0] ?? null;
            } catch {
              return null;
            }
          };
        }
        try {
          const probe = await probeSource(src.url, src.container, src.headers ?? {});
          if (probe.alive) out.push(src);
        } catch { /* dead */ }
      }
      if (!out.length) throw new Error(`${id}: all streams dead`);
      return out;
    }

    if (!r.url) throw new Error(`${id}: resolve needs url or transform`);
    const url = renderTemplate(r.url, vars);
    const headers = renderHeaders(r.headers, vars);
    const text = await fetchText(url, 20000, { headers }, `${id} resolve`);
    // Try JSON first; fall back to raw text for regex.
    let json: any = null;
    try { json = JSON.parse(text); } catch { json = null; }
    const root = json ?? text;

    // stream url
    let streamUrl: string | undefined;
    if (r.stream?.jsonPath) {
      streamUrl = pathOrTransform(root, r.stream.jsonPath, root);
    } else if (r.stream?.regex) {
      const m = new RegExp(r.stream.regex).exec(text);
      streamUrl = m ? (m[1] ?? m[0]) : undefined;
    }
    if (typeof streamUrl !== 'string' || !streamUrl) {
      throw new Error(`${id}: no stream url`);
    }
    // container
    let container: 'hls' | 'mp4' = 'hls';
    if (r.container === 'mp4') container = 'mp4';
    else if (r.container === 'hls') container = 'hls';
    else if (r.container === 'auto') {
      const u = streamUrl.toLowerCase();
      container = u.includes('.mp4') ? 'mp4' : 'hls';
    }

    // subtitles
    let subtitles: SubtitleTrack[] | undefined;
    if (r.subtitles?.path) {
      const arr = pathOrTransform(root, r.subtitles.path, root);
      if (Array.isArray(arr)) {
        subtitles = arr.map((t: any) => ({
          label: r.subtitles!.label ? String(pathOrTransform(t, r.subtitles!.label, t) ?? 'Sub') : (t.label ?? t.lang ?? 'Sub'),
          lang: r.subtitles!.lang ? String(pathOrTransform(t, r.subtitles!.lang, t)) : t.lang,
          url: String(pathOrTransform(t, r.subtitles!.url, t)),
          headers: r.subtitles!.headers ? renderHeaders(r.subtitles!.headers, vars) : undefined,
        })).filter((t) => !!t.url);
      }
    }

    // intro/outro
    let intro: { start: number; end: number } | null = null;
    let outro: { start: number; end: number } | null = null;
    if (r.intro) {
      const v = pathOrTransform(root, r.intro, root);
      if (v && typeof v === 'object') intro = { start: Number(v.start ?? v[0]), end: Number(v.end ?? v[1]) };
    }
    if (r.outro) {
      const v = pathOrTransform(root, r.outro, root);
      if (v && typeof v === 'object') outro = { start: Number(v.start ?? v[0]), end: Number(v.end ?? v[1]) };
    }

    const h = r.headers ? renderHeaders(r.headers, vars) : { 'User-Agent': UA };
    const src: WatchSource = {
      url: streamUrl,
      container,
      quality: r.quality ?? id,
      headers: h,
      subtitles: subtitles && subtitles.length ? subtitles : undefined,
      intro,
      outro,
    };
    if (r.signed) {
      src.refresh = async () => {
        try {
          const fresh = await resolveOne(anilistId, ep, idMal);
          return fresh[0] ?? null;
        } catch {
          return null;
        }
      };
    }
    // probe
    const probe = await (async () => {
      const { probeSource } = await import('../fetch');
      return probeSource(src.url, src.container, src.headers ?? {});
    })();
    if (!probe.alive) throw new Error(`${id}: stream dead`);
    return [src];
  }

  async function match(anilistId: number, idMal?: number | null, hint?: any): Promise<ExtensionMatch> {
    if (mf.match?.transform) {
      const tool = getTool(mf.match.transform);
      if (!tool) return { available: false };
      try {
        const ok = await tool(anilistId, idMal ?? null, hint);
        return { available: !!ok };
      } catch {
        return { available: false };
      }
    }
    if (mf.match?.probe === 'url' && mf.match.url) {
      try {
        const vars = { ...vars0, anilistId, idMal: idMal ?? anilistId };
        const url = renderTemplate(mf.match.url, vars);
        const headers = renderHeaders(mf.match.headers, vars);
        await fetchText(url, 15000, { headers }, `${id} match`);
        return { available: true };
      } catch {
        return { available: false };
      }
    }
    // default: probe episodes
    try {
      const eps = await fetchEpisodes(anilistId);
      const min = mf.match?.minItems ?? 1;
      return { available: eps.length >= min };
    } catch {
      return { available: false };
    }
  }

  return {
    id,
    label: mf.label,
    version: mf.version,
    contractVersion: mf.contractVersion ?? 1,
    capabilities: mf.capabilities as any,
    match: (aid, mal, h) => match(aid, mal, h),
    episodes: (aid, mal, h) => fetchEpisodes(aid, mal, h),
    resolve: (aid, ep, mal, h) => resolveOne(aid, ep, mal, h),
  };
}

export function manifestToExtensionSafe(raw: unknown, repoUrl: string): Extension | null {
  const v = validateManifest(raw);
  if (!v.ok || !v.manifest) return null;
  try {
    return manifestToExtension(v.manifest as unknown as MfManifest, repoUrl);
  } catch {
    return null;
  }
}