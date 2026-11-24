// HLS variant handling — manual quality selection.
//
// "Auto" = the master URL (ABR decides), "1080p" = that variant's URL.
//
// 🎧 A VARIANT URL IS NOT ALWAYS A SUBSTITUTE FOR THE MASTER.
// When the master declares its audio as a separate rendition
// (
//   #EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",URI="audio/en.m3u8"
// )
// the variant playlists carry VIDEO ONLY: the audio arrives from that other
// playlist, which only the master knows to fetch. Loading one variant directly
// therefore plays a silent picture — the Katana "video but no sound" report of
// 23 Nov, which appeared the moment the app started stepping down a ladder
// automatically. `separateAudio` is what tells the player to pin the rung with
// `maxResolution` instead of swapping the URL.
import { masterHasSeparateAudio, selectableRungs } from '../player/rung';
import { fetchText } from './fetch';

export interface HlsVariant {
  url: string;
  bandwidth: number;
  width?: number;
  height?: number;
  label: string;
  /**
   * The master keeps its audio in a SEPARATE rendition, so this variant URL is
   * video-only. Loading it loses the sound; see the header.
   */
  separateAudio?: boolean;
}

// `masterHasSeparateAudio` lives in `lib/player/rung.ts` — pure, and driven by
// `scripts/check-stream-recovery.ts` without pulling in expo-network.

export async function listVariants(
  masterUrl: string,
  headers: Record<string, string>
): Promise<HlsVariant[]> {
  const text = await fetchText(masterUrl, 12000, { headers }, 'variants');
  const lines = text.split('\n').map((l) => l.trim());
  const separateAudio = masterHasSeparateAudio(text);
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
        separateAudio,
      });
    } catch {
      /* skip */
    }
  }
  /**
   * ONLY RUNGS A VIEWER CAN ACTUALLY SEE.
   *
   * A `#EXT-X-STREAM-INF` with no `RESOLUTION` is not a picture size — it is an
   * audio-only rendition published as a variant (a real CDN shape), or a
   * bandwidth-only entry. Offering it as `1234k` gives the viewer a row that
   * plays a silent/blank picture, and on a separate-audio master it is worse
   * than that: `capFor` has no height to pin, so the pick applies nothing and
   * the stream re-opens onto the same master, looking like a dead button.
   *
   * When at least one rung declares a height, the heightless entries are
   * dropped. A master that declares NONE of them (the extension-less Bingr /
   * Katana ladder) keeps them all: there the label is the only identity a rung
   * has, and dropping everything would leave the quality sheet empty for a
   * perfectly adaptive stream.
   */
  const selectable = selectableRungs(out);

  // Dedupe by label, highest bandwidth wins, sort high -> low.
  const seen = new Map<string, HlsVariant>();
  for (const v of selectable) {
    const prev = seen.get(v.label);
    if (!prev || v.bandwidth > prev.bandwidth) seen.set(v.label, v);
  }
  return [...seen.values()].sort((a, b) => b.bandwidth - a.bandwidth);
}
