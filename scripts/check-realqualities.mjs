// Probe several titles through the REAL extension code and print each master's
// variant ladder — evidence for "some anime just have no ladder".
import { createMegaExtension } from '../lib/extensions/mega/index.ts';
import { createFilmuExtension } from '../lib/extensions/filmu/index.ts';
import { listVariants } from '../lib/extensions/hls.ts';
const mega = createMegaExtension();
const titles = [
  ['Frieren', 154587, 52991],
  ['DanMachi S1', 20920, 28121],
  ['One Piece ep1', 21, 170],
];
for (const [name, ani, mal] of titles) {
  try {
    const srcs = await mega.resolve(ani, 1, mal);
    for (const s of srcs) {
      const v = await listVariants(s.url, s.headers ?? {});
      console.log(`mega ${name}: ${v.map(x=>x.label).join(', ') || '(no variants / single-file mp4)'}`);
    }
  } catch (e) { console.log(`mega ${name}: ERR ${String(e?.message).slice(0, 70)}`); }
}
// FilmU: attempt resolve; token IP-bound + host currently unreachable from this box.
const filmu = createFilmuExtension();
try {
  const eps = await filmu.episodes(20920);
  console.log('filmu reachable: episodes', eps.length);
} catch (e) { console.log(`filmu: unreachable from this machine (${String(e?.message).slice(0, 40)})`); }
