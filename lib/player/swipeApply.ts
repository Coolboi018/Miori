// One coalescing writer for the two values a vertical swipe drives.
//
// WHY THIS FILE EXISTS AT ALL. A drag emits a value every frame (~60/s), and the
// two things that value is written to are NATIVE state, not React state:
//
//   player.volume = x      → an ExoPlayer call per frame, AND a `VolumeChanged`
//                            event posted back into JS per frame
//   setBrightnessAsync(x)  → `window.attributes = lp` on the MAIN thread, which
//                            is a full window relayout (ViewRootImpl), not a
//                            property poke
//
// At 60Hz those two starve the video pipeline on a low-end phone, and — this is
// the part the 16 Nov report made plain — the damage OUTLIVES the drag: the
// decoder keeps hitching long after the finger is lifted. A gesture that costs
// the viewer the rest of the episode is not a gesture worth having.
//
// SO THE WRITE IS COALESCED, NOT DEBOUNCED. A debounce would only write once the
// finger stops, i.e. a brightness that does not follow the hand. Coalescing keeps
// the feedback live at a rate the platform can afford: at most one native call
// per window, always carrying the LATEST value, plus a trailing call so the final
// position is exact. `end()` lands that trailing call immediately, for a gesture
// that has just finished.
//
// NO REACT IMPORTS, like `lib/player/brightness.ts` and `lib/nav/pending.ts`:
// readable from a check script, never part of a cycle.

/** Volume: an audio gain. Cheap enough to follow the finger closely. */
export const VOLUME_WRITE_MS = 40;

export interface LatestWriter {
  /** Request a value. The native call may land on the next tick. */
  set(value: number): void;
  /** The gesture ended: apply the pending value NOW instead of on the timer. */
  end(): void;
  /** Teardown: drop anything pending and write nothing (the player is gone). */
  cancel(): void;
}

/**
 * Build a coalescing writer for one native value.
 *
 * `minWriteMs` is the minimum spacing between native calls. It is a parameter
 * rather than a constant because the two values differ by an order of magnitude
 * in cost: an ExoPlayer gain change is nothing, a window relayout is not.
 */
export function createLatestWriter(
  write: (value: number) => void,
  minWriteMs: number
): LatestWriter {
  let lastWrite = 0;
  let pending: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function flush(): void {
    if (pending == null) return;
    const value = pending;
    pending = null;
    lastWrite = Date.now();
    write(value);
  }

  function stopTimer(): void {
    if (timer) clearTimeout(timer);
    timer = null;
  }

  return {
    set(value: number): void {
      pending = value;
      const wait = minWriteMs - (Date.now() - lastWrite);
      if (wait <= 0) {
        stopTimer();
        flush();
        return;
      }
      // A timer is already scheduled for this window and will read `pending`
      // when it fires, so the newest value rides along with it.
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        flush();
      }, wait);
    },

    end(): void {
      stopTimer();
      flush();
    },

    cancel(): void {
      stopTimer();
      pending = null;
    },
  };
}
