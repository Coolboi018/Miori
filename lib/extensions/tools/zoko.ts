// Named transforms for the Zoko backend: reuse the compiled-in extension so
// there is no duplicate logic — the manifest just references these by name.

import { createZokoExtension } from '../zoko';

export async function zokoMatch(anilistId: number, idMal?: number | null): Promise<boolean> {
  const ext = createZokoExtension();
  const m = await ext.match(anilistId, idMal ?? null);
  return !!m.available;
}

export async function zokoEpisodes(anilistId: number, idMal?: number | null): Promise<any> {
  const ext = createZokoExtension();
  const eps = await ext.episodes(anilistId, idMal ?? null);
  return eps;
}

export async function zokoFlow(anilistId: number, ep: number, idMal?: number | null): Promise<any> {
  const ext = createZokoExtension();
  // Skip match(): resolve() does the real work and the registry handles failures.
  const srcs = await ext.resolve(anilistId, ep, idMal ?? null);
  if (!srcs.length) throw new Error('Zoko: no sources');
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
