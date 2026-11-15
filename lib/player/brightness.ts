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
// value to start from, `endBrightnessSession` HANDS THE WINDOW BACK TO THE SYSTEM.
// Skipping the restore leaves a user's phone dim long after they left the player,
// which is the kind of bug that gets blamed on the phone.
//
// ⚠️ AND "BACK" MEANS CLEARED, NOT RE-WRITTEN — see `endBrightnessSession`.
//
// ═══════════════════════════════════════════════════════════════════════════
// COALESCED, AND IN STEPS — the 16 Nov perf fix. READ BEFORE RAISING THE RATES.
//
// On Android this write is NOT a property poke: `setBrightnessAsync` is
// `window.attributes = lp` on the MAIN thread (`BrightnessModule.kt`), which
// forces a full window relayout. Twenty of those a second under a playing video
// is enough to starve the decoder on a low-end device, and the hitch outlives
// the drag — the report was "one swipe and the episode stutters from then on".
//
// So two things, and both are load-bearing:
//
//   1. COALESCING (`lib/player/swipeApply.ts`): at most one native write per
//      `WRITE_MS`, always the latest value, plus a trailing write so the final
//      position is exact. `WRITE_MS` is larger than the volume's because the
//      cost is a relayout rather than a gain change.
//   2. A STEP: the value is quantised to `STEP` before it is written. 2% of a
//      backlight is a step nobody can see, and it turns a full-height sweep into
//      ~13 relayouts instead of one per percent. `current` keeps the EXACT
//      value, so the next drag starts where the finger left it, not on the grid.
//
// Neither of these can make the gesture feel laggy: the HUD is drawn on the UI
// thread and never waits for this module.
//
// WEB IS A NO-OP. `isAvailableAsync` resolves false there and the whole drag is
// simply the no-op half of the gesture.

import { Platform } from 'react-native';
import * as Brightness from 'expo-brightness';
import { createLatestWriter } from './swipeApply';

/** At most one window write per this window; the trailing one always lands. */
const WRITE_MS = 80;

/** Written value granularity — see the header. */
const STEP = 0.02;

/** What the drag baseline starts from — the exact value this app last set. */
let current = 1;

const writer = createLatestWriter((value) => {
  void Brightness.setBrightnessAsync(value).catch(() => {
    // A rejected write (no activity, platform refused) costs the gesture, never
    // the episode — playback is untouched.
  });
}, WRITE_MS);

/** Snap to the write grid, clamped to the only range a brightness can have. */
function quantise(value: number): number {
  const stepped = Math.round(value / STEP) * STEP;
  if (stepped < 0) return 0;
  if (stepped > 1) return 1;
  return stepped;
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
      current = value;
    }
  } catch {
    /* unavailable — the swipe still works, it just starts from full */
  }
}

/** Hand the screen back to the system, and forget the baseline for the next one. */
export async function endBrightnessSession(): Promise<void> {
  // A queued write must not land after the restore and leave the phone dim.
  writer.cancel();
  current = 1;
  if (Platform.OS === 'web') return;
  try {
    /**
     * CLEAR THE OVERRIDE. DO NOT WRITE A NUMBER BACK (16 Nov).
     *
     * `setBrightnessAsync(original)` looks like a restore and is not one: it
     * leaves `window.screenBrightness` SET at that value, so the ACTIVITY keeps
     * a fixed brightness and stops following the system — and the activity is
     * every screen in the app, not just this one. The report was exactly that:
     * "why is the whole app not controlled by system brightness".
     *
     * `restoreSystemBrightnessAsync` assigns `BRIGHTNESS_OVERRIDE_NONE`
     * (`BrightnessModule.kt`), which is the operation that hands the window back
     * to the system value, adaptive brightness included. Only the player
     * bypasses it, and only while it is open.
     */
    await Brightness.restoreSystemBrightnessAsync();
  } catch {
    /* nothing to undo if the activity is already gone */
  }
}

/** The value a swipe baseline should start from. */
export function readBrightness(): number {
  return current;
}

/**
 * Apply a swipe value (0 → 1), coalesced and quantised. Returns immediately; the
 * write may land on the next tick.
 */
export function setBrightness(value: number): void {
  current = value;
  if (Platform.OS === 'web') return;
  writer.set(quantise(value));
}
