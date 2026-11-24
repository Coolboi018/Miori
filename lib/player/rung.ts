// The RUNG rules — what a master can actually honour without losing its sound.
//
// ═══════════════════════════════════════════════════════════════════════════
// WHY THIS IS ITS OWN MODULE (23 Nov)
//
// The Katana report was "the video plays but there is no audio", and the cause
// was a quality change, not a decode: an HLS master may declare its audio as a
// SEPARATE rendition (`#EXT-X-MEDIA:TYPE=AUDIO,…,URI="audio/en.m3u8"`), and the
// variant playlists of such a master carry VIDEO ONLY — the audio arrives from
// that other playlist, which only the master knows to fetch. The player used to
// honour a quality pick (and, since the recovery ladder, a quality STEP-DOWN) by
// loading the variant URL directly, which is exactly the silent picture.
//
// The fix is the one real players use: a rung on an adaptive stream is a
// CEILING (`maxResolution`), not a different stream. Android re-selects its own
// track below the ceiling, so the audio keeps arriving, the buffered bytes
// survive and the change is instant.
//
// These two rules are pure and live here, not inside `hls.ts`, because
// `hls.ts` reaches `fetch.ts` → `connectivity` → `expo-network`, and the check
// battery runs under plain `tsx`. A rule that can only be tested by running the
// app is a rule that gets re-broken by the next session.

export interface RungLike {
  width?: number;
  height?: number;
}

/**
 * Does this master carry its audio as its own playlist?
 *
 * Attribute order inside an `#EXT-X-MEDIA` tag is not fixed, so both claims are
 * read off the same line rather than matched as one regex: `TYPE=AUDIO` says the
 * group is audio, and only a `URI=` makes it a SEPARATE rendition. No URI means
 * the audio is muxed into every variant, which is the safe case — loading a
 * variant then plays sound.
 */
export function masterHasSeparateAudio(text: string): boolean {
  return text
    .split('\n')
    .some((l) => l.trim().startsWith('#EXT-X-MEDIA') && /TYPE=AUDIO/i.test(l) && /URI=/i.test(l));
}

/**
 * The rungs a viewer may pick, out of everything a master declared.
 *
 * A `#EXT-X-STREAM-INF` with no `RESOLUTION` is not a picture size. It is an
 * audio-only rendition published as a variant (a shape real CDNs ship), or a
 * bandwidth-only entry — and offering it as a quality row gives the viewer a
 * pick that plays a silent/blank picture. On a separate-audio master it fails a
 * second way: `capFor` has nothing to pin, so the pick applies nothing and the
 * item re-opens onto the same master, which reads as a dead button.
 *
 * When the master declares a height for at least one rung, the heightless ones
 * are dropped. A master that declares NONE (the extension-less Bingr/Katana
 * ladder) keeps them all: there the label is the only identity a rung has, and
 * dropping everything would empty the sheet for a working adaptive stream.
 */
export function selectableRungs<T extends RungLike>(variants: T[]): T[] {
  const withHeight = variants.filter((v) => v.height != null);
  return withHeight.length ? withHeight : variants;
}

/**
 * The `maxResolution` that pins a rung WITHOUT re-opening the stream.
 *
 * `null` when the variant has no height: some masters label a rung with
 * bandwidth only, and a 0-height ceiling would black the picture.
 */
export function capFor(v: RungLike | null | undefined): { width: number; height: number } | null {
  if (!v?.height) return null;
  return { width: v.width ?? Math.round((v.height * 16) / 9), height: v.height };
}
