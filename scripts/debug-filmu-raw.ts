// Debug: the post-30-Oct backend (Bingr).
// 1. /episodes?chunk= from api.bingr.one (rich list, no auth)
// 2. SSR the bingr watch page and dump EVERY stream token it embedded
// 3. probe each token's master playlist + variant heads, so we can see what the
//    phone would actually load.
// 4. the player's session token -> /api/sources -> decode the `v1.` payload and
//    dump provider/servers/streams/subtitles (24 Nov 2026 session found the
//    encrypted state; subs live ONLY there).
// Usage: npx -y tsx scripts/debug-filmu-raw.ts [anilistId] [ep]
import { fetchTimed, fetchJson } from '../lib/extensions/fetch';
import { listVariants } from '../lib/extensions/hls';
import { decodeSourcesPayload } from '../lib/extensions/filmu';

const API = 'https://api.bingr.one/api';
const SITE = 'https://bingr.one';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

async function main() {
  const anilistId = Number(process.argv[2] ?? 20920);
  const ep = Number(process.argv[3] ?? 1);

  const eps = await fetchJson<{ total?: number; episodes?: Array<{ episode?: number; title?: string; still?: string }> }>(
    `${API}/anime/${anilistId}/episodes?chunk=0`,
    20000,
    { headers: { 'User-Agent': UA, Accept: 'application/json' } },
    'Bingr episodes'
  );
  console.log(`episodes: total=${eps?.total}, rows=${eps?.episodes?.length ?? 0}, first: ${eps?.episodes?.[0]?.title}`);

  const page = await (
    await fetchTimed(`${SITE}/watch/anime/${anilistId}/${ep}`, 25000, { headers: { 'User-Agent': UA, Accept: 'text/html' } }, 'watch page')
  ).text;
  if (!page.includes('hikari.streamrip.fun')) {
    throw new Error(`watch page has no hikari token (len ${page.length}). head: ${page.slice(0, 200)}`);
  }
  const tokens = [...new Set(page.match(/https:\/\/hikari\.streamrip\.fun\/p\/[A-Za-z0-9_-]+/g) ?? [])];
  console.log(`\nwatch page: ${page.length} bytes, ${tokens.length} stream token(s)`);

  // Backslash-stripped plain match (extension's own extraction): the player's
  // token is `id.random` — a dot — while the Cloudflare beacon token is bare hex.
  const sane = page.replace(/\\/g, '');
  const session = /"token":"([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)"/.exec(sane)?.[1] ?? null;
  console.log(`session token: ${session ?? '(none found)'}`);

  if (session) {
    try {
      const q = new URLSearchParams({
        kind: 'anime',
        anilist: String(anilistId),
        e: String(ep),
        audio: 'sub',
        t: session,
      });
      const body = await (
        await fetchTimed(`${SITE}/api/sources?${q.toString()}`, 15000, { headers: { 'User-Agent': UA } }, '/api/sources')
      ).text;
      const st = decodeSourcesPayload(body);
      console.log(`\n/api/sources: ${body.length}B, provider=${st.provider?.id}`);
      const servers = (st.servers ?? []).map((s) => s.id).filter(Boolean);
      console.log('  servers:', servers.join(', ') || '(none)');
      const st0 = st.streams?.[0];
      console.log(`  streams[0]: ${st0?.url?.slice(0, 48) ?? '(none)'}… type=${st0?.type} quality=${st0?.quality}`);
      const subs = st0?.subtitles ?? [];
      console.log(`  subtitles: ${subs.map((s) => s.label ?? s.lang).join(' | ') || '(none)'}`);
    } catch (e: any) {
      console.log('  /api/sources ERR:', e?.message);
    }
  }

  for (const [i, token] of tokens.entries()) {
    console.log(`\n== token ${i + 1}/${tokens.length} (len ${token.length})`);
    try {
      const master = await (await fetchTimed(token, 12000, { headers: { 'User-Agent': UA } }, 'master')).text;
      const lines = master
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'));
      console.log('  master head:', master.slice(0, 60).replace(/\n/g, ' | '));
      console.log('  master lines:', lines.map((l) => `${l.slice(0, 40)}…`).slice(0, 3).join(' | '));
      const v = await listVariants(token, { 'User-Agent': UA });
      console.log('  variants:', v.map((x) => x.label).join(', ') || '(none)');
      if (v.length) {
        const seg = await (
          await fetchTimed(v[0].url, 10000, { headers: { 'User-Agent': UA } }, 'variant')
        ).text;
        console.log('  variant head:', seg.split('\n').slice(0, 3).join(' | ').slice(0, 160));
      }
    } catch (e: any) {
      console.log('  ERR:', e?.message);
    }
  }
}

main().catch((e) => {
  console.error('FAILED:', e?.message ?? e);
  process.exit(1);
});
