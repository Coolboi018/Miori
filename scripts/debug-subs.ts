// Debug: run the real VTT parser against live sub files.
// Usage: npx -y tsx scripts/debug-subs.ts
import { createFilmuExtension } from '../lib/extensions/filmu';
import { createMegaExtension } from '../lib/extensions/mega';
import { parseVTT } from '../lib/subtitles/vtt';

async function head(url: string, headers: Record<string, string> = {}) {
  const res = await fetch(url, { headers });
  const text = await res.text();
  const cues = parseVTT(text);
  console.log(`bytes=${text.length} cues=${cues.length}`);
  console.log('first cue:', JSON.stringify(cues[0]));
  console.log('raw head:', JSON.stringify(text.slice(0, 200)));
}

async function main() {
  const filmu = createFilmuExtension();
  const fsrc = await filmu.resolve(20920, 1);
  for (const [i, s] of fsrc.entries()) {
    const t = s.subtitles?.[0];
    console.log(`--- filmu src${i} ${s.quality} tracks=${s.subtitles?.length ?? 0}`);
    if (t) await head(t.url, t.headers ?? {});
  }
  const mega = createMegaExtension();
  const msrc = await mega.resolve(20920, 1, 28121);
  const mt = msrc[0].subtitles?.[0];
  console.log(`--- mega tracks=${msrc[0].subtitles?.length ?? 0}`);
  if (mt) await head(mt.url, mt.headers ?? {});
}

main().catch((e) => {
  console.error('FAILED:', e?.message ?? e);
  process.exit(1);
});
