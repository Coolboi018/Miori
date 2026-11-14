// Live test of Miori extensions (runs on Node, same code runs on Hermes).
// Golden title: DanMachi S1 — AniList 20920, MAL 28121, ep 1 sub.
// Usage: npx -y tsx scripts/test-extensions.ts
import { createFilmuExtension } from '../lib/extensions/filmu';
import { createMegaExtension } from '../lib/extensions/mega';
import { createAnikotoExtension } from '../lib/extensions/anikoto';
import { createZokoExtension } from '../lib/extensions/zoko';
import { resolveEpisode, createRegistry } from '../lib/extensions/registry';

const ANILIST = 20920;
const MAL = 28121;
const EP = 1;
// Anikoto's catalog has no ani/mal-keyed lookup route — its match() maps via
// keyword search + catalog-id equality, so the hint carries both titles.
const HINT = {
  titles: [
    'Dungeon ni Deai wo Motomeru no wa Machigatteiru Darou ka',
    'DanMachi',
  ],
};

async function main() {
  // Built-ins are off by default now (SHIP_BUILTIN_SOURCES=false), so build the
  // battery's registry directly from the compiled-in creators — this script
  // exists to exercise the built-in code, not the (network-dependent) loader.
  const registry = [
    createFilmuExtension(),
    createMegaExtension(),
    createAnikotoExtension(),
    createZokoExtension(),
  ];
  console.log(
    'registry:',
    registry.map((e) => `${e.id}@${e.version}`).join(', ')
  );

  // FilmU — gated by the bingr/hikari edge: undici's TLS fingerprint 403s or
  // the master answers wrong from Node even when the source is live on a real
  // device (scrapper.md). Keep it optional so the rest of the battery runs.
  let filmuOk = true;
  try {
    // FilmU
    const filmu = createFilmuExtension();
    const eps = await filmu.episodes(ANILIST);
    console.log(`filmu episodes: ${eps.length} (first: ${eps[0]?.title})`);
    const fsrc = await filmu.resolve(ANILIST, EP);
    console.log(
      `filmu sources: ${fsrc.length}`,
      fsrc.map((s) => s.quality).join(' | ')
    );
    const fsubs = fsrc.reduce((n, s) => n + (s.subtitles?.length ?? 0), 0);
    console.log(`filmu subs merged: ${fsubs}`);
    const subbed = fsrc.filter((s) => s.subtitles && s.subtitles.length > 0);
    if (!(subbed[0]?.subtitles?.length)) throw new Error('filmu: no subtitle tracks on any source');
    console.log(`filmu subs on lead source: ${subbed[0].subtitles.length} — ${subbed[0].subtitles.map((t) => t.label).join(' | ')}`);
    console.log('filmu intro/outro:', JSON.stringify(fsrc[0].intro), JSON.stringify(fsrc[0].outro));
    if (fsrc[0]?.refresh) {
      const fresh = await fsrc[0].refresh();
      if (!fresh) throw new Error('filmu refresh returned null');
      if (fresh.url === fsrc[0].url) {
        console.log(
          'filmu refresh: same token re-served by the SSR mint window (documented; player does not spend a splice on it)'
        );
      } else {
        console.log(`filmu refresh: new token ${fresh.url.slice(30, 46)}…`);
      }
      console.log('filmu refresh quality:', fresh.quality, 'container:', fresh.container);
    } else {
      console.log('filmu refresh: (no hook)');
    }
  } catch (e) {
    filmuOk = false;
    console.log(`filmu: SKIPPED — ${(e as Error)?.message ?? e} (undici gate; device-only)`);
  }

  // Mega (validates pure-JS AES decrypt too)
  const mega = createMegaExtension();
  const m = await mega.match(ANILIST, MAL);
  console.log('mega match:', JSON.stringify(m));
  if (m.available) {
    const msrc = await mega.resolve(ANILIST, EP, MAL);
    console.log(`mega file: ${msrc[0].url.slice(0, 80)}…`);
    console.log(
      `mega tracks: ${msrc[0].subtitles?.length ?? 0}, intro: ${JSON.stringify(
        msrc[0].intro
      )}, outro: ${JSON.stringify(msrc[0].outro)}`
    );
  }

  // Anikoto (megaplay flavors: HD-1/HD-2/Vidstream-1/2 — four independent rows)
  const anikoto = createAnikotoExtension();
  const ak = await anikoto.match(ANILIST, MAL, HINT);
  console.log('anikoto match:', JSON.stringify(ak));
  if (ak.available) {
    const aksrc = await anikoto.resolve(ANILIST, EP, MAL, HINT);
    console.log(
      `anikoto sources: ${aksrc.length} — ${aksrc.map((s) => s.quality).join(' | ')}`
    );
    const akSubs = aksrc.reduce((n, s) => n + (s.subtitles?.length ?? 0), 0);
    console.log(
      `anikoto subs on lead: ${aksrc[0]?.subtitles?.length ?? 0}, intro: ${JSON.stringify(
        aksrc[0]?.intro
      )}, outro: ${JSON.stringify(aksrc[0]?.outro)}`
    );
    const akLabels = new Set(aksrc.map((s) => s.quality));
    if (akLabels.size < 2) throw new Error('anikoto: expected multiple provider flavors');
    if (!(aksrc[0]?.subtitles?.length)) throw new Error('anikoto: no subtitle tracks');
    const akeps = await anikoto.episodes(ANILIST, MAL, HINT);
    console.log(`anikoto episodes: ${akeps.length} (first: ${akeps[0]?.title})`);
  }

  // Zoko (independent dramahot CDN — same rips as mega, different host)
  const zoko = createZokoExtension();
  const z = await zoko.match(ANILIST, MAL);
  console.log('zoko match:', JSON.stringify(z));
  if (z.available) {
    const zsrc = await zoko.resolve(ANILIST, EP, MAL);
    console.log(`zoko file: ${zsrc[0].url.slice(0, 80)}…`);
    console.log(
      `zoko subs: ${zsrc[0].subtitles?.length ?? 0}, intro: ${JSON.stringify(
        zsrc[0].intro
      )}, outro: ${JSON.stringify(zsrc[0].outro)}, refresh: ${!!zsrc[0].refresh}`
    );
    if (!zsrc[0].url) throw new Error('zoko: no stream url');
    if (zsrc[0].intro && zsrc[0].intro.start === 0 && zsrc[0].intro.end === 0)
      console.log('zoko skip: zero markers (upstream)');
  }

  // Registry failover
  const all = await resolveEpisode(registry, ANILIST, EP, MAL, HINT);
  console.log(
    `registry total sources: ${all.sources.length}, from: ${all.available.join(',')}`
  );
  console.log('ALL GREEN');
}

main().catch((e) => {
  console.error('TEST FAILED:', e?.message ?? e);
  process.exit(1);
});
