// The subtitle line currently on screen — a STORE, not player state.
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
// itself stays dumb (it takes the cue as a prop) so the settings preview can
// keep rendering it with its own fixed text.
//
// NO REACT NATIVE IMPORTS, like `sideHud.ts` and `nav/pending.ts`: readable from
// a check script, never part of a cycle.

import type { Cue } from '@/lib/subtitles/vtt';

let current: Cue | null = null;

const listeners = new Set<() => void>();

export function subscribeCue(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Stable identity while the line does not change — required by `useSyncExternalStore`. */
export function readCue(): Cue | null {
  return current;
}

/**
 * Show a cue (or clear it).
 *
 * IDENTITY, NOT DEEP EQUALITY: `cueAtSync` returns a reference out of the parsed
 * list, so the same line produces the same object on every tick. That is what
 * makes "the tick fired 8 times and the cue did not change" cost nothing — the
 * comparison below is the whole throttle.
 */
export function publishCue(next: Cue | null): void {
  if (next === current) return;
  current = next;
  for (const listener of listeners) listener();
}

/** Test seam. */
export function __resetCue(): void {
  current = null;
}
