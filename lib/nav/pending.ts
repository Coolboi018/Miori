// "A navigation was asked for and its screen has not been drawn yet."
//
// WHY THE GUARD NEEDS THIS TO EXIST AT ALL. `lib/nav/pushOnce.ts` fixes the
// doubled screen by DROPPING the second tap — and that is correct, but on a
// low-end phone it leaves the user with no evidence the app heard them. The
// press wash sits under their finger, the screen does not change, and the app
// looks frozen. They tap again harder. Nothing. That reads as a crash, which is
// a worse experience than the bug being fixed.
//
// So a dropped tap is not silent: while a push is in flight this store is
// "pending", and `components/nav/RouteProgress.tsx` draws a thin indeterminate
// bar at the top of the screen. It is the same language a browser uses for a
// page load — motion at the edge, content untouched.
//
// WHY NOT A CENTRED SPINNER WITH A SCRIM. Two reasons, both fatal here:
//
//   - It blocks what the user is looking at. On a fast device the detail page
//     lands in ~200ms and a dimmed screen with a spinner in the middle flashes
//     over it for no reason. On a slow one it covers the content the user is
//     already reading while they wait for a screen they can't see anyway.
//   - A spinner is a LOOPING JS/native animation that lives on the screen it
//     covers. Nothing about it explains a stall.
//
// The bar is honest about what is happening ("something is on its way") and
// leaves the app usable. It also has to animate on the UI THREAD, which is the
// one property that matters when the reason for the wait is a blocked JS
// thread — see the component for that half.
//
// PURE MODULE, NO REACT NATIVE IMPORTS. Same rule as `lib/ui/tokens.ts`:
// `eslint` can read it, a check script can import it, and it can never take
// part in a require cycle. The hook lives in the component.
//
// TWO CLOCKS, AND THEY DO DIFFERENT JOBS:
//
//   - MIN_VISIBLE_MS is a FLASH GUARD. Navigation on a warm cache is fast, and
//     a bar that appears and vanishes within two frames is visual noise that
//     makes the app feel less stable, not more. Anything shorter than this is
//     rounded up.
//   - MAX_VISIBLE_MS is a LIAR SWITCH. If the route never commits (a crashed
//     transition, a screen that throws), the bar must not orbit forever
//     claiming work is happening.

/** A bar shorter than this never renders: too short to read as progress. */
const MIN_VISIBLE_MS = 450;

/** A bar that outlives this is lying. Hide it whether or not a route landed. */
const MAX_VISIBLE_MS = 1400;

let visible = false;
let shownAt = 0;
let hideTimer: ReturnType<typeof setTimeout> | null = null;
let hardStopTimer: ReturnType<typeof setTimeout> | null = null;

/** Module-scoped so `useSyncExternalStore` gets a stable identity. */
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function clearTimers(): void {
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
  if (hardStopTimer) {
    clearTimeout(hardStopTimer);
    hardStopTimer = null;
  }
}

function conceal(): void {
  clearTimers();
  if (!visible) return;
  visible = false;
  emit();
}

export function subscribeNavPending(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** For `useSyncExternalStore`. */
export function isNavPending(): boolean {
  return visible;
}

/**
 * A push was accepted. Show the bar and re-arm the hard stop.
 *
 * Re-arming on a second accepted push (a burst, or the user opening something
 * else while the first screen commits) is deliberate: the bar tracks "is the
 * app still working", and a fresh request means the answer is still yes.
 */
export function beginNavPending(): void {
  const now = Date.now();
  if (!visible) {
    visible = true;
    shownAt = now;
    emit();
  }
  if (hardStopTimer) clearTimeout(hardStopTimer);
  hardStopTimer = setTimeout(conceal, MAX_VISIBLE_MS);
}

/**
 * A tap was DROPPED as a duplicate.
 *
 * Extends the bar only if it is already up: a blocked tap means the destination
 * is the screen on top, so reviving a bar for it would be claiming progress on
 * something that has already happened. But if it IS up, the user's tap is a
 * vote that the app still looks stuck, so the hard stop restarts — see
 * `pushOnce`, which is the only caller.
 */
export function extendNavPending(): void {
  if (!visible) return;
  if (hardStopTimer) clearTimeout(hardStopTimer);
  hardStopTimer = setTimeout(conceal, MAX_VISIBLE_MS);
}

/**
 * The router committed a new route — the screen the user asked for exists now.
 *
 * Called from the bar's own `usePathname` effect: that re-render is the same
 * commit that mounts the destination, which is the earliest honest moment to
 * stop. `MIN_VISIBLE_MS` still applies, measured from when the bar appeared.
 */
export function settleNavPending(): void {
  if (!visible) return;
  const waited = Date.now() - shownAt;
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = setTimeout(conceal, Math.max(0, MIN_VISIBLE_MS - waited));
}

/**
 * Test seam, matching `__resetNavGuard`. Timers are real, so a check that pokes
 * this needs no clock of its own — it just must not leave one armed.
 */
export function __resetNavPending(): void {
  clearTimers();
  visible = false;
  shownAt = 0;
}
