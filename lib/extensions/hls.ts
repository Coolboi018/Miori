// HLS variant handling — manual quality selection.
// expo-video exposes videoTrack as read-only (ABR only), so forcing a
// quality means loading that variant playlist URL directly instead of
// the master. "Auto" = master URL (ABR decides), "1080p" = variant URL.
import { fetchText } from './fetch';

export interface HlsVariant {
  url: string;
  bandwidth: number;
  width?: number;
  height?: number;
  label: string;
}

export async function listVariants(
  masterUrl: string,
  headers: Record<string, string>
): Promise<HlsVariant[]> {
  const text = await fetchText(masterUrl, 8000, { headers }, 'variants');
  const lines = text.split('\n').map((l) => l.trim());
  const out: HlsVariant[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith('#EXT-X-STREAM-INF')) continue;
    const bw = /BANDWIDTH=(\d+)/.exec(line)?.[1];
    const rs = /RESOLUTION=(\d+)x(\d+)/.exec(line);
    let uri = '';
    for (let j = i + 1; j < lines.length; j++) {
      if (!lines[j] || lines[j].startsWith('#')) continue;
      uri = lines[j];
      break;
    }
    if (!uri) continue;
    try {
      const url = new URL(uri, masterUrl).toString();
      const height = rs ? parseInt(rs[2], 10) : undefined;
      const bandwidth = bw ? parseInt(bw, 10) : 0;
      out.push({
        url,
        bandwidth,
        width: rs ? parseInt(rs[1], 10) : undefined,
        height,
        label: height ? `${height}p` : bandwidth ? `${Math.round(bandwidth / 1000)}k` : '?:',
      });
    } catch {
      /* skip */
    }
  }
  // Dedupe by label, highest bandwidth wins, sort high -> low.
  const seen = new Map<string, HlsVariant>();
  for (const v of out) {
    const prev = seen.get(v.label);
    if (!prev || v.bandwidth > prev.bandwidth) seen.set(v.label, v);
  }
  return [...seen.values()].sort((a, b) => b.bandwidth - a.bandwidth);
}
