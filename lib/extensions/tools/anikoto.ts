// Named transforms for the Anikoto backend: reuse the compiled-in extension so
// there is no duplicate logic — the manifest just references these by name.

import { createAnikotoExtension } from '../anikoto';
import type { ResolveHint } from '../types';

export async function anikotoMatch(anilistId: number, idMal?: number | null, hint?: ResolveHint): Promise<boolean> {
  const ext = createAnikotoExtension();
  const m = await ext.match(anilistId, idMal ?? null, hint);
  return !!m.available;
}

export async function anikotoEpisodes(anilistId: number, idMal?: number | null, hint?: ResolveHint): Promise<any> {
  const ext = createAnikotoExtension();
  const eps = await ext.episodes(anilistId, idMal ?? null, hint);
  return eps;
}

export async function anikotoFlow(anilistId: number, ep: number, idMal?: number | null, hint?: ResolveHint): Promise<any> {
  const ext = createAnikotoExtension();
  // Skip match(): resolve() runs the same mapping internally and the registry
  // handles failures. match() would add a redundant search + catalog round trip.
  const srcs = await ext.resolve(anilistId, ep, idMal ?? null, hint);
  if (!srcs.length) throw new Error('Anikoto: no sources');
  return srcs.map((s) => ({
    url: s.url,
    container: s.container,
    headers: s.headers,
    quality: s.quality,
    subtitles: s.subtitles,
    intro: s.intro,
    outro: s.outro,
  }));
}
