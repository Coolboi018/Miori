// The one place that knows `expo-network` exists.
//
// Everything else — the transport, the extension fetch helper, React Query —
// talks to `lib/net/connectivity.ts`, which has no imports and therefore runs
// under the Node check scripts. This adapter is mounted once by the root layout
// and feeds the pure store from two sources: a one-shot read for the state the
// app launched into, and the OS listener for every change after it.
//
// WHY A MODULE STORE RATHER THAN THE HOOK ALONE. `expo-network`'s
// `useNetworkState` is a perfectly good hook, but a request that is already on
// the wire cannot call a hook. `gql` and `fetchText` need to ask synchronously
// whether there is a connection, and React Query's `onlineManager` needs to be
// told when the answer changes, so the source of truth has to live outside
// React and the hook has to be a subscriber to it.

import * as Network from 'expo-network';
import { useSyncExternalStore } from 'react';
import {
  getNetworkSnapshot,
  normalizeNetworkState,
  setNetworkSnapshot,
  subscribeNetworkStatus,
  type NetworkSnapshot,
} from './connectivity';

let started = false;
let subscription: { remove(): void } | null = null;

/**
 * Start observing connectivity. Idempotent, so a Fast Refresh or a second
 * layout mount cannot stack listeners.
 *
 * The initial read is awaited so the first screen's queries see the real state
 * instead of 'unknown'; the listener keeps it current afterwards. Neither
 * failure is fatal — an unavailable module leaves the store at 'unknown', which
 * is the same position the app was in before this file existed.
 */
export async function initNetworkStatus(): Promise<void> {
  if (started) return;
  started = true;

  try {
    const state = await Network.getNetworkStateAsync();
    setNetworkSnapshot(normalizeNetworkState(state, Date.now()));
  } catch {
    /* no native module (web, an old build) — stay 'unknown' */
  }

  try {
    subscription = Network.addNetworkStateListener((state) => {
      setNetworkSnapshot(normalizeNetworkState(state, Date.now()));
    });
  } catch {
    /* the one-shot read above is still better than nothing */
  }
}

/** Stop observing. Only the root layout owns the lifecycle; exposed for tests. */
export function stopNetworkStatus(): void {
  subscription?.remove();
  subscription = null;
  started = false;
}

const getSnapshot = (): NetworkSnapshot => getNetworkSnapshot();

/**
 * Subscribe a component to connectivity.
 *
 * `useSyncExternalStore` rather than the library hook for the same reason the
 * settings store uses it: the snapshot is a stable primitive-ish object, and
 * only components that read it re-render when it changes.
 */
export function useNetworkStatus(): NetworkSnapshot {
  return useSyncExternalStore(subscribeNetworkStatus, getSnapshot, getSnapshot);
}
