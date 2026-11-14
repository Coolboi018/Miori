// Named transform: run the MegaPlay backend flow and return a plain source
// descriptor. Reuses the compiled-in mega extension so there is no duplicate
// logic — the manifest just references 'mega-flow' by name.

import { createMegaExtension } from '../mega';

export async function megaFlow(anilistId: number, ep: number, idMal?: number | null): Promise<any> {
  const ext = createMegaExtension();
  // Skip match(): resolve() does the real work and the registry handles
  // failures. match() would add a redundant pre-flight fetch.
  const srcs = await ext.resolve(anilistId, ep, idMal ?? null);
  if (!srcs.length) throw new Error('MegaPlay: no sources');
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

export async function megaMatch(anilistId: number, idMal?: number | null): Promise<boolean> {
  const ext = createMegaExtension();
  const m = await ext.match(anilistId, idMal ?? null);
  return !!m.available;
}