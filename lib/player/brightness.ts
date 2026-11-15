// Screen brightness for the player's vertical swipe — and, importantly, giving
// it back.
//
// WHICH BRIGHTNESS. `expo-brightness`'s `setBrightnessAsync` is the APP/ACTIVITY
// brightness (Android: the window override; iOS: the screen brightness until the
// device locks), not the system setting. That is the one a player must use:
//
//   - it needs no permission (`WRITE_SETTINGS` is only for the SYSTEM value),
//     so it works in Expo Go and in the store build with no prompt;
//   - it cannot change what every other app on the phone looks like;
//   - it is exactly the behaviour of a player: the picture dims while watching
//     and the phone is normal again afterwards.
//
// ⚠️ AND IT IS NOT AUTOMATIC ON iOS. Android drops the activity override when the
// activity goes away; iOS keeps the screen where this code left it until the
// device locks. So the session is explicit: `beginBrightnessSession` reads the
// value to start from, `endBrightnessSession` puts it back. Skipping the restore
// leaves a user's phone dim long after they left the player, which is the kind
// of bug that gets blamed on the phone.
//
// THROTTLED WRITES. A drag emits a value per frame (~60/s); each write is a
// native call, and on Android it re-applies a window attribute. Coalescing to at
// most one write every `MIN_WRITE_MS` — always with the LATEST value, plus a
// trailing write so the final position is exact — keeps the visual feedback
// smooth without turning a two-second swipe into 120 platform calls.
//
// WEB IS A NO-OP. `isAvailableAsync` resolves false there and the whole drag is
// simply the no-op half of the gesture.

import { Platform } from 'react-native';
import * as Brightness from 'expo-brightness';

/** At most one native write per this window; the trailing one always lands. */
const MIN_WRITE_MS = 48;

let original: number | null = null;
/** What the drag baseline starts from — the last value this app set. */
let current = 1;
let lastWrite = 0;
let pending: number | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

function write(value: number): void {
  lastWrite = Date.now();
  void Brightness.setBrightnessAsync(value).catch(() => {
    // A rejected write (no activity, platform refused) costs the gesture, never
    // the episode — playback is untouched.
  });
}

/**
 * Capture the brightness to return to, once per player session.
 *
 * Failure is silent and leaves `current` at 1: a device where the read fails is
 * one where the swipe should still not throw, and 1 is the brightest the app can
 * ask for rather than a value that would dim a screen for no reason.
 */
export async function beginBrightnessSession(): Promise<void> {
  if (Platform.OS === 'web') return;
  try {
    const value = await Brightness.getBrightnessAsync();
    if (typeof value === 'number' && Number.isFinite(value)) {
      original = value;
      current = value;
    }
  } catch {
    /* unavailable — the swipe still works, it just starts from full */
  }
}

/** Put the screen back where it was, and forget the baseline for the next one. */
export async function endBrightnessSession(): Promise<void> {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  pending = null;
  if (Platform.OS === 'web' || original == null) {
    current = 1;
    return;
  }
  const restore = original;
  original = null;
  current = 1;
  try {
    await Brightness.setBrightnessAsync(restore);
  } catch {
    /* nothing to undo if the activity is already gone */
  }
}

/** The value a swipe baseline should start from. */
export function readBrightness(): number {
  return current;
}

/**
 * Apply a swipe value (0 → 1), coalesced. Returns immediately; the write may
 * land on the next tick.
 */
export function setBrightness(value: number): void {
  current = value;
  if (Platform.OS === 'web') return;
  pending = value;
  const now = Date.now();
  const wait = MIN_WRITE_MS - (now - lastWrite);
  if (wait <= 0) {
    const next = pending;
    pending = null;
    if (next != null) write(next);
    return;
  }
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    const next = pending;
    pending = null;
    if (next != null) write(next);
  }, wait);
}
