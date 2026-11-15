// The volume / brightness readout that follows a vertical swipe.
//
// A STORE, NOT SCREEN STATE, and that is the performance decision in this file.
// The values themselves are applied straight to the engine (player volume, screen
// brightness) — nothing in `PlayerScreen` re-renders while a finger is dragging.
// Only this HUD needs to know the number, so only this HUD subscribes: a few
// hundred views of player chrome re-rendering at 60Hz because a label changed is
// exactly the kind of jank the drag is supposed to avoid.
//
// THROTTLED BY VALUE, NOT BY TIME. The engine gets every frame's value (the
// screen writes it directly), but the HUD only re-renders when the visible
// integer percentage actually changes — at most 100 emissions across a full
// sweep, however fast the finger moves. A time throttle here would make the
// number lag the finger on a slow drag and skip values on a fast one.
//
// NO REACT NATIVE IMPORTS, like `lib/nav/pending.ts`: readable from a check
// script, never part of a cycle. The hook lives in the component.

export type SideHudKind = 'volume' | 'brightness';

/** The half the readout hangs on — the half the drag started on. */
export type SideHudSide = 'left' | 'right';

export interface SideHudState {
  kind: SideHudKind | null;
  /**
   * Which side of the screen the bar draws on.
   *
   * CARRIED EXPLICITLY rather than derived from `kind`: the halves are swappable
   * in settings, so "volume is on the right" is only true for one of the two
   * mappings. Deriving it in the view would put the bar on the wrong side for
   * every user who swapped them.
   */
  side: SideHudSide;
  /** 0 → 1. The same number the engine was given. */
  value: number;
}

/** How long the readout stays after the finger lifts. */
const HIDE_AFTER_MS = 700;

let state: SideHudState = { kind: null, side: 'left', value: 0 };
let hideTimer: ReturnType<typeof setTimeout> | null = null;

const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function cancelHide(): void {
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
}

export function subscribeSideHud(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Stable identity while nothing changes — required by `useSyncExternalStore`. */
export function readSideHud(): SideHudState {
  return state;
}

/**
 * Show (or update) the readout.
 *
 * A NEW KIND always re-renders, even at the same value: switching from the
 * volume half to the brightness half has to swap the icon and the label.
 */
export function showSideHud(
  kind: SideHudKind,
  value: number,
  side: SideHudSide
): void {
  cancelHide();
  const percent = Math.round(value * 100);
  if (
    state.kind === kind &&
    state.side === side &&
    Math.round(state.value * 100) === percent
  ) {
    return;
  }
  state = { kind, side, value: percent / 100 };
  emit();
}

/**
 * The finger lifted: keep the readout up long enough to read, then take it away.
 *
 * Delayed rather than immediate for the same reason the speed pill fades slowly —
 * the final value is the one the user was aiming for, and a label that vanishes
 * on touch-up means they never see where they landed.
 */
export function scheduleSideHudHide(): void {
  cancelHide();
  hideTimer = setTimeout(() => {
    hideTimer = null;
    if (state.kind === null) return;
    state = { kind: null, side: state.side, value: state.value };
    emit();
  }, HIDE_AFTER_MS);
}

/** Test seam. */
export function __resetSideHud(): void {
  cancelHide();
  state = { kind: null, side: 'left', value: 0 };
}
