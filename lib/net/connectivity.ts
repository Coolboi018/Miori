// Connectivity, as a pure module.
//
// WHY THIS IS SEPARATE FROM `expo-network`. The transport (`lib/net/gql.ts`),
// the extension fetch helper (`lib/extensions/fetch.ts`) and React Query's
// `onlineManager` all have to ask "is there a network?" from OUTSIDE React —
// often from a request that is already in flight. `expo-network` is a native
// module, and importing it from anything a Node check script loads would break
// the battery (`scripts/*` run under plain `tsx`, with no Expo runtime).
//
// So the STATE and every DECISION live here with no imports at all, and
// `lib/net/network.ts` is the one adapter that knows about `expo-network`.
// That is the same shape as `lib/player/health.ts` and `lib/player/speed.ts`:
// the rules are script-drivable, the native edge is isolated.
//
// THE THREE-VALUED ANSWER IS DELIBERATE. "Offline" is a claim that lets the app
// skip work and fail fast, so it is only made on positive evidence
// (`isConnected === false` or `isInternetReachable === false`). Before the
// platform has reported anything the answer is 'unknown', which is NOT offline:
// treating "we have not asked yet" as "there is no network" would make a cold
// launch fail every request for the first few hundred milliseconds. The
// transport's own timeout is the backstop while the answer is unknown.

export type NetworkKind = 'unknown' | 'online' | 'offline';

export interface NetworkSnapshot {
  kind: NetworkKind;
  /** The platform says a link exists (wifi/cellular/ethernet), or null. */
  connected: boolean | null;
  /** The platform says the internet is reachable, or null when it has no verdict. */
  reachable: boolean | null;
  /** `NetworkStateType` as a string, for logs and diagnostics. */
  type: string | null;
  /** When this snapshot was produced, ms. Diagnostic only. */
  at: number;
}

/** The shape `expo-network` reports, reduced to what the decision needs. */
export interface RawNetworkState {
  isConnected?: boolean | null;
  isInternetReachable?: boolean | null;
  type?: string | number | null;
}

/**
 * The `expo-network` payload -> the app's verdict.
 *
 * `isInternetReachable` is the stronger signal and wins when it is present:
 * a phone can be attached to a wifi network that has no route to the internet
 * (a hotel captive portal is the everyday case), and `isConnected` is true
 * there. Only positive evidence produces 'offline'; a missing field is
 * 'unknown', never a failure.
 */
export function normalizeNetworkState(
  raw: RawNetworkState | null | undefined,
  at: number
): NetworkSnapshot {
  const connected =
    typeof raw?.isConnected === 'boolean' ? raw.isConnected : null;
  const reachable =
    typeof raw?.isInternetReachable === 'boolean' ? raw.isInternetReachable : null;
  const type = raw?.type == null ? null : String(raw.type);

  let kind: NetworkKind;
  if (connected === false || reachable === false) kind = 'offline';
  else if (reachable === true) kind = 'online';
  else if (connected === true) kind = 'online';
  else kind = 'unknown';

  return { kind, connected, reachable, type, at };
}

/**
 * Before the platform has said anything.
 *
 * Frozen and shared, like `UNKNOWN_HEALTH` in the player: subscribers are
 * notified only when a field actually changes, and an identity that churns
 * would defeat that guard.
 */
const UNKNOWN: NetworkSnapshot = Object.freeze({
  kind: 'unknown',
  connected: null,
  reachable: null,
  type: null,
  at: 0,
});

let current: NetworkSnapshot = UNKNOWN;

const listeners = new Set<() => void>();

/** The latest verdict. Stable identity between real changes. */
export function getNetworkSnapshot(): NetworkSnapshot {
  return current;
}

/**
 * Fold a new platform report into the store.
 *
 * Identity is preserved when nothing meaningful changed. The OS emits state
 * callbacks for things that do not alter connectivity (a cell handover, a
 * signal-strength change), and publishing each one would re-render every
 * subscriber and wake `onlineManager` for a network that never moved.
 */
export function setNetworkSnapshot(next: NetworkSnapshot): void {
  if (
    current.kind === next.kind &&
    current.connected === next.connected &&
    current.reachable === next.reachable &&
    current.type === next.type
  ) {
    return;
  }
  current = next;
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // A subscriber that throws must not stop the others. Same discipline as
      // the settings store: notification is a courtesy, not a transaction.
    }
  }
}

export function subscribeNetworkStatus(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Positive evidence of no network. 'unknown' is NOT offline — see the header. */
export function isOffline(snapshot: NetworkSnapshot = current): boolean {
  return snapshot.kind === 'offline';
}

/** Positive evidence of a working internet route. */
export function isOnline(snapshot: NetworkSnapshot = current): boolean {
  return snapshot.kind === 'online';
}

/**
 * The sentence the player and the error card show when a request was skipped
 * because there is no connection. One string, so the banner and the card
 * cannot promise different things.
 */
export const OFFLINE_MESSAGE =
  "You're offline. Playback will start automatically when the connection returns.";

export interface OfflineError extends Error {
  /** Tagged, not subclassed — same reason as `GqlError` and `DiscordError`. */
  offline: true;
}

export function offlineError(message: string = OFFLINE_MESSAGE): OfflineError {
  const e = new Error(message) as OfflineError;
  e.name = 'OfflineError';
  e.offline = true;
  return e;
}

export function isOfflineError(e: unknown): e is OfflineError {
  return !!(e as { offline?: boolean } | null)?.offline;
}
