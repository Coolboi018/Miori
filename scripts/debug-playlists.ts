// Debug playlist structures for sora + mega.
// Usage: npx -y tsx scripts/debug-playlists.ts
import { createFilmuExtension } from '../lib/extensions/filmu';
import { createMegaExtension } from '../lib/extensions/mega';

async function show(label: string, masterUrl: string, headers: Record<string, string>) {
  console.log(`===== ${label} =====`);
  console.log('master:', masterUrl.slice(0, 100));
  const res = await fetch(masterUrl, { headers });
  const text = await res.text();
  console.log(`HTTP ${res.status}, len ${text.length}`);
  console.log(text.split('\n').slice(0, 12).join('\n'));
  const nested = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  if (nested.length && nested[0].toLowerCase().includes('.m3u8')) {
    try {
      const vurl = new URL(nested[0], masterUrl).toString();
      console.log('--- variant:', vurl.slice(0, 100));
      const vres = await fetch(vurl, { headers });
      const vtext = await vres.text();
      console.log(`variant HTTP ${vres.status}, len ${vtext.length}`);
      console.log(vtext.split('\n').slice(0, 10).join('\n'));
    } catch (e: any) {
      console.log('variant fetch failed:', e?.message);
    }
  }
}

async function main() {
  const filmu = createFilmuExtension();
  // Bypass resolve() probing: call raw endpoint via resolve and catch.
  // Instead list streams without probe by resolving (probe may drop) —
  // use episodes endpoint? Simplest: temporarily resolve and inspect survivors.
  const fsrc = await filmu.resolve(20920, 1).catch(() => []);
  console.log('survivors:', fsrc.map((s) => s.quality).join(' | '));
  const sora = fsrc.find((s) => (s.quality ?? '').startsWith('sora'));
  if (sora) await show('SORA', sora.url, sora.headers ?? {});
  else console.log('sora already dropped — good');

  const mega = createMegaExtension();
  try {
    const msrc = await mega.resolve(20920, 1, 28121);
    await show('MEGA', msrc[0].url, msrc[0].headers ?? {});
  } catch (e: any) {
    console.log('mega resolve failed:', e?.message);
    // Replicate mega flow manually to inspect the master structure.
    const { decryptMegaEnc } = await import('../lib/crypto/mega-crypto');
    const UA =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
    const page = await (
      await fetch('https://megaplay.buzz/stream/mal/28121/1/sub', {
        headers: { 'User-Agent': UA, Referer: 'https://miori.app/' },
      })
    ).text();
    const idm = page.match(/data-id="(\d+)"/);
    console.log('data-id:', idm?.[1]);
    const embed = 'https://megaplay.buzz/stream/mal/28121/1/sub';
    const sj = (await (
      await fetch(
        `https://megaplay.buzz/stream/getSourcesNew?id=${idm?.[1]}`,
        {
          headers: {
            'User-Agent': UA,
            'X-Requested-With': 'XMLHttpRequest',
            Referer: embed,
          },
        }
      )
    ).json()) as { enc: string };
    const file = (JSON.parse(decryptMegaEnc(sj.enc)) as { file: string }).file;
    await show(
      'MEGA-MASTER',
      file,
      { Referer: 'https://megaplay.buzz/', Origin: 'https://megaplay.buzz', 'User-Agent': UA }
    );
  }
}

main().catch((e) => {
  console.error('FAILED:', e?.message ?? e);
  process.exit(1);
});
