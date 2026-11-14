// Named transforms for the FilmU / Bingr backend: reuse the compiled-in
// extension so there is no duplicate logic — the manifest just references
// 'filmu-flow' / 'filmu-match' by name.

import { createFilmuExtension } from '../filmu';

export async function filmuFlow(anilistId: number, ep: number, idMal?: number | null, _hint?: any): Promise<any> {
  const ext = createFilmuExtension();
  // Skip match() entirely: the registry calls resolve() directly, and match()
  // would run the full episode-list fetch (up to 30 chunks × 20s) BEFORE the
  // stream resolve — on a blocked host that doubled the wait for nothing.
  const srcs = await ext.resolve(anilistId, ep, idMal ?? null);
  if (!srcs.length) throw new Error('FilmU: no sources');
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

export async function filmuMatch(anilistId: number, idMal?: number | null, _hint?: any): Promise<boolean> {
  const ext = createFilmuExtension();
  const m = await ext.match(anilistId, idMal ?? null);
  return !!m.available;
}