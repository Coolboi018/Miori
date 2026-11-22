// What is on screen right now — a STORE, not player state.
//
// ═══════════════════════════════════════════════════════════════════════════
// WHY THIS IS NOT `useState` IN `PlayerScreen` (16 Nov)
//
// A cue changes a few times a SECOND during dialogue. As screen state, every one
// of those changes re-rendered the entire player: the top bar, both gradients,
// four chips, the timeline and the settings panel — all of it — to update one
// line of text. On a low-end device that is the "the overlay rebuilds itself
// constantly" feeling, and it is the same shape as the two performance bugs
// before it: a value that only one small component needs, held where everything
// needs it.
//
// The rule this follows is already in `progress.md` for the volume readout: the
// value lives in a store, and the one component that DRAWS it subscribes. Here
// that is `SubtitleStage`, which wraps `SubtitleOverlay`. `SubtitleOverlay`
// itself stays dumb (it takes the frame as a prop) so the settings preview can
// keep rendering it with its own sample.
//
// ═══════════════════════════════════════════════════════════════════════════
// WHY IT HOLDS A FRAME RATHER THAN ONE CUE (22 Nov)
// ═══════════════════════════════════════════════════════════════════════════
// A playhead can have a sign, two voices and a lyric open at once. The single
// cue this store used to hold was only ever the FIRST of them, so the rest were
// parsed, active, and never drawn. `lib/subtitles/frame.ts` assembles the whole
// picture; this store just carries it to the one component that paints it.
//
// NO REACT NATIVE IMPORTS, like `sideHud.ts` and `nav/pending.ts`: readable from
// a check script, never part of a cycle.

import { frameSignature, type SubtitleFrame } from '@/lib/subtitles/frame';

let current: SubtitleFrame | null = null;
/**
 * The content signature of `current`.
 *
 * The player rebuilds the frame on every 120ms tick; a new object with the same
 * words must NOT notify. Comparing the signature is the whole throttle, and it
 * is also what keeps `useSyncExternalStore` from tearing: unchanged content
 * always answers with the same reference.
 */
let currentKey = '';

const listeners = new Set<() => void>();

export function subscribeCue(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Stable identity while the lines do not change — required by `useSyncExternalStore`. */
export function readCue(): SubtitleFrame | null {
  return current;
}

/**
 * Show a frame (or clear the screen).
 *
 * IDENTITY BY CONTENT, not by reference: `buildSubtitleFrame` allocates a fresh
 * object each call, so object identity would notify on every tick even when the
 * words did not change. The signature comparison is the difference between a
 * hundred re-renders per minute of dialogue and one per line.
 */
export function publishCue(next: SubtitleFrame | null): void {
  const key = frameSignature(next);
  if (key === currentKey) return;
  currentKey = key;
  current = next;
  for (const listener of listeners) listener();
}

/** Test seam. */
export function __resetCue(): void {
  current = null;
  currentKey = '';
}
