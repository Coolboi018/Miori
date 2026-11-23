// How a `WatchSource` becomes a media3 content type, and how a route param
// becomes a number — the two rules the player screen used to keep inline.
//
// WHY THEY MOVED OUT: both are pure decisions with a device bug behind them,
// and both were only exercisable by running a 5,800-line screen. `PlayerScreen`
// now imports them, so the rules are testable (`scripts/check-stream-recovery.ts`)
// and the screen is that much closer to being a view rather than a library.
//
// NO RUNTIME IMPORTS — `import type` is erased, so this file loads under plain
// `tsx` in the check battery, exactly like `health.ts` and `recovery.ts`.

import type { ContentType } from 'expo-video';
import type { Container, WatchSource } from '@/lib/extensions/types';

/**
 * `WatchSource.container` → expo-video's `ContentType`.
 *
 * ⚠️ WHY `'auto'` (URI sniffing) is NOT the default, and the one device report
 * that settled it. `'auto'` makes media3 INFER the source type from the URI's
 * file extension alone (`node_modules/expo-video/.../ContentType.kt`: AUTO
 * writes NO mimeType on the MediaItem). A URL with no extension at all — the
 * Bingr/Katana signed token `https://hikari.streamrip.fun/p/<opaque>` —
 * infers "other", which is the PROGRESSIVE extractor stack, and that stack
 * sniffs a `#EXTM3U` text playlist byte-for-byte: `NoDeclaredBrand`,
 * "None of the available extractors could read the stream", failover to Mega.
 * Every pick of Katana silently landed on Mega because of THIS, not signed-URL
 * expiry (a `refresh()` could never fix it; every fresh token fails
 * identically, and the log said so).
 *
 * But OUR older lesson still stands: an extension that DERIVES `container`
 * from the URL string can mislabel, and an explicit type on a mislabelled
 * source is handed to the extractor unverified. So the rule is: trust the
 * label where the URL is SILENT (that is the only information there is, and
 * HLS-token sources of the Katana class assert it — `lib/extensions/filmu`
 * fails closed if the fetched master is not `#EXTM3U`); fall back to `'auto'`
 * sniffing when the label and the URL CONTRADICT each other (the mp4-
 * disguised-as-“playlist” case that produced the 7 Oct black video).
 */
export const CONTAINER_TO_CONTENT_TYPE: Record<Container, ContentType> = {
  hls: 'hls',
  mp4: 'progressive',
};

/** The URL itself carries the extension the label claims — label is redundant but right. */
export function labelAgrees(s: WatchSource): boolean {
  const u = s.url.toLowerCase();
  if (s.container === 'hls') return !u.includes('.mp4');
  // `'mp4'`: media3's progressive stack sniffs the container itself
  // (NoDeclaredBrand is fine to incur here — it is what the extractors
  // answer for a master we did label right), so we only refuse the case
  // where the URL positively NAMES an m3u8.
  return !u.includes('.m3u8');
}

/**
 * The contentType a source is loaded with. See `labelAgrees` above.
 * `'auto'` for an unlabelled source is unchanged: extension-based sniffing
 * on a URL that carries `.m3u8`/`.mp4` reaches the same pipeline the label
 * would have chosen, at no cost.
 */
export function contentTypeFor(s: WatchSource): ContentType {
  const declared = CONTAINER_TO_CONTENT_TYPE[s.container];
  if (declared == null || !labelAgrees(s)) return 'auto';
  return declared;
}

/** True when the sniffed pipeline would disagree with the label. Log-only aid. */
export function labelDisagrees(s: WatchSource): boolean {
  const declared = CONTAINER_TO_CONTENT_TYPE[s.container];
  return declared != null && !labelAgrees(s);
}

/**
 * Read a route param as a number, or `NaN`.
 *
 * `useLocalSearchParams<T>()` is a TYPE ASSERTION, not a parser. At runtime the
 * value is `string | string[]` for both params, and the array form is what a
 * duplicated query key produces — `Number(['1','2'])` is `NaN` because the
 * array stringifies to `"1,2"`. The generic silences that, which is how a
 * malformed deep link (`miori://watch/20920/abc`, reachable because `scheme:
 * "miori"` is in `app.json`) turns into `NaN` deep inside a screen that then
 * writes `miori:pos:NaN:NaN` and `miori:synced:NaN:NaN` to the user's disk on
 * every unmount. Junk keys are permanent and the symptom is an AniList
 * complaint rather than "bad link".
 */
export function paramNumber(raw: string | string[] | undefined): number {
  const one = Array.isArray(raw) ? raw[0] : raw;
  const n = Number(one);
  return Number.isFinite(n) ? n : NaN;
}

/**
 * Whether a route names a playable episode at all.
 *
 * Lives beside `paramNumber` because every caller of one needs the other, and
 * because a screen that merely refused to RENDER would still have written
 * `NaN` progress keys on its way out — the check has to happen where the value
 * is used, not where it is drawn.
 */
export function isPlayableRoute(animeId: number, epNum: number): boolean {
  return Number.isInteger(animeId) && animeId > 0 && Number.isInteger(epNum) && epNum >= 1;
}
