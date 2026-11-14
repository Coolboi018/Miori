// Debug: list HLS variants of live sources.
// Usage: npx -y tsx scripts/debug-variants.ts
import { createFilmuExtension } from '../lib/extensions/filmu';
import { createMegaExtension } from '../lib/extensions/mega';
import { listVariants } from '../lib/extensions/hls';

async function main() {
  const filmu = createFilmuExtension();
  const s = await filmu.resolve(20920, 1);
  for (const src of s) {
    try {
      const v = await listVariants(src.url, src.headers ?? {});
      console.log(src.quality, '->', v.map((x) => x.label).join(', '));
    } catch (e: any) {
      console.log(src.quality, 'ERR', e?.message);
    }
  }
  const mega = createMegaExtension();
  const m = await mega.resolve(20920, 1, 28121);
  const mv = await listVariants(m[0].url, m[0].headers ?? {});
  console.log('mega ->', mv.map((x) => x.label).join(', '));
}

main().catch((e) => {
  console.error('FAILED:', e?.message ?? e);
  process.exit(1);
});
