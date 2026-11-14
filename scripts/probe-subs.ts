// Probe: embedded subs in manifests? What format are external subs?
// Usage: npx -y tsx scripts/probe-subs.ts
import { createFilmuExtension } from '../lib/extensions/filmu';
import { createMegaExtension } from '../lib/extensions/mega';

async function fetchText(url: string, headers: Record<string, string> = {}) {
  const res = await fetch(url, { headers });
  const text = await res.text();
  return { status: res.status, text };
}

async function main() {
  const filmu = createFilmuExtension();
  const fsrc = await filmu.resolve(20920, 1);
  const f0 = fsrc[0];
  const master = await fetchText(f0.url, f0.headers ?? {});
  console.log(`filmu master HTTP ${master.status}, len ${master.text.length}`);
  console.log(
    'filmu manifest embedded SUBTITLES:',
    /EXT-X-MEDIA[^\\n]*SUBTITLES/.test(master.text)
  );
  console.log('filmu master head:', master.text.split('\n').slice(0, 8).join(' | '));

  const fsub = f0.subtitles?.[0];
  if (fsub) {
    const s = await fetchText(fsub.url, fsub.headers ?? {});
    console.log(`filmu sub HTTP ${s.status}, head:`, JSON.stringify(s.text.slice(0, 120)));
  } else {
    console.log('filmu: no subs on first source');
  }

  const mega = createMegaExtension();
  const msrc = await mega.resolve(20920, 1, 28121);
  const m0 = msrc[0];
  const mmaster = await fetchText(m0.url, m0.headers ?? {});
  console.log(`mega master HTTP ${mmaster.status}, len ${mmaster.text.length}`);
  console.log(
    'mega manifest embedded SUBTITLES:',
    /EXT-X-MEDIA[^\\n]*SUBTITLES/.test(mmaster.text)
  );
  const msub = m0.subtitles?.[0];
  if (msub) {
    const s = await fetchText(msub.url, msub.headers ?? {});
    console.log(`mega sub HTTP ${s.status}, head:`, JSON.stringify(s.text.slice(0, 120)));
  }
}

main().catch((e) => {
  console.error('PROBE FAILED:', e?.message ?? e);
  process.exit(1);
});
