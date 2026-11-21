// Chrome visibility — a tiny external store.
//
// WHY NOT `useState` ON THE PLAYER SCREEN. `PlayerScreen` is a very large
// component: hundreds of hooks, memoised props, a 1 Hz health tick. Holding the
// chrome's visibility in its state meant every tap to show the controls
// re-ran that whole tree, and the reanimated fade that followed started one
// frame late — which is what read as "laggy". The chrome itself is already
// `memo`'d, so if visibility lives OUTSIDE the screen, toggling it re-renders
// only the bars and the two small overlays that actually care about it.
//
// The screen keeps a ref for its own bookkeeping (timers, gesture gates) and
// writes through `setChromeVisible`; the bars subscribe through
// `useChromeVisible`.

import { useSyncExternalStore } from 'react';

let visible = true;
const listeners = new Set<() => void>();

export function getChromeVisible(): boolean {
  return visible;
}

export function setChromeVisible(next: boolean): void {
  if (visible === next) return;
  visible = next;
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // A subscriber that throws must not stop the others.
    }
  }
}

export function subscribeChromeVisible(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useChromeVisible(): boolean {
  return useSyncExternalStore(subscribeChromeVisible, getChromeVisible, getChromeVisible);
}
