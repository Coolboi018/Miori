// The volume the player's vertical swipe drives — and the one decision that
// separates it from the brightness half.
//
// ═══════════════════════════════════════════════════════════════════════════
// DEVICE VOLUME, NOT OUR STREAM'S GAIN  (16 Nov)
//
// `player.volume` is a gain on OUR OWN stream: it leaves the rest of the phone
// exactly where it was. That is right for a music app and wrong for a video
// player, because the hardware volume keys move the DEVICE volume while the
// episode plays. Two "volumes" under one hand is a HUD that lies: the bar says
// 40 and the phone is at 80, and the next thing the viewer does is press a
// hardware key to find out which number is real. Every phone player moves the
// device stream for exactly this reason (VLC, MX, YouTube), and so does the
// reference in `ShonenX/` (`volume_controller`).
//
// The BRIGHTNESS half deliberately stays APP-ONLY (`lib/player/brightness.ts`,
// window brightness, restored on exit). Volume is a shared setting the user
// already treats as theirs; a screen dimmed from inside a video player is a
// change nobody can trace back to the app that made it, and on iOS it survives
// the screen.
//
// ═══════════════════════════════════════════════════════════════════════════
// EXPO GO FALLS BACK, AND THE NATIVE MODULE IS LOADED LAZILY
//
// `react-native-volume-manager` contains native code, and Expo Go cannot contain
// it. A STATIC import would throw while the bundle is evaluating — the whole app
// would fail to BOOT in Expo Go, which this project still uses for testing — so
// the module is reached with a dynamic `import()` inside a `try`. Until it
// resolves, and forever in Expo Go or on web, writes go to
// `setVolumeFallback` — the player's own gain, exactly the behaviour before this
// file existed. Nothing here can throw at startup, and nothing here is a "maybe
// the API works": `usingDeviceVolume()` is the single answer every caller reads.
//
// AND THE PACKAGE IS NOT EVEN EVALUATED WHEN IT IS UNLINKED. The dynamic import
// kept the app booting, but the package's own module body builds
// `new NativeEventEmitter(NativeModules.VolumeManager)` around a proxy that throws
// when unlinked — and that throw surfaces in dev as a red LogBox ERROR ("The
// package 'react-native-volume-manager' doesn't seem to be linked"), even though
// the rejection below is caught. So `NativeModules.VolumeManager` is asked FIRST:
// in Expo Go the answer is "no", the package is never loaded, there is no red box
// and no failed module left in Metro's registry, and the fallback is chosen one
// step earlier.
//
// Writes are coalesced (`lib/player/swipeApply.ts`): a drag emits a value every
// frame, and each of these is a native call.

import { NativeModules, Platform } from 'react-native';
import { createLatestWriter, VOLUME_WRITE_MS } from './swipeApply';

/**
 * The slice of `react-native-volume-manager` this file uses.
 *
 * Declared rather than imported, because the import itself has to stay dynamic —
 * see the header. The shape is the package's documented cross-platform API.
 */
interface VolumeApi {
  getVolume(): Promise<{ volume: number }>;
  setVolume(value: number, config?: { showUI?: boolean; type?: 'music' }): Promise<void>;
  addVolumeListener?(listener: (result: { volume: number }) => void): { remove(): void };
}

/**
 * Is the native module actually linked into this binary?
 *
 * Asked BEFORE the package is evaluated (see the header): an unlinked package
 * throws from its own module body, and dev builds report that as a LogBox ERROR
 * even when the import's rejection is caught. `VolumeManager` is the name both
 * platforms register (`VolumeManagerModule.NAME` on Android,
 * `RCT_EXPORT_MODULE(VolumeManager)` on iOS).
 */
const nativeLinked = Platform.OS !== 'web' && !!(NativeModules as { VolumeManager?: unknown })?.VolumeManager;

let api: VolumeApi | null = null;
let loading: Promise<VolumeApi | null> | null = null;
let listening = false;

/** The value the swipe works from — always the number the user is on. */
let current = 1;

/** Where a write goes when there is no device API (Expo Go, web). */
let fallback: ((value: number) => void) | null = null;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

const writer = createLatestWriter((value) => {
  if (api) {
    // `showUI: false` — the player draws its own readout, and the system's
    // volume popup landing on top of the video is the exact overlap the HUD
    // exists to avoid.
    void api
      .setVolume(value, { showUI: false, type: 'music' })
      .catch(() => {
        /* a refused volume write costs the gesture, never the episode */
      });
    return;
  }
  fallback?.(value);
}, VOLUME_WRITE_MS);

/**
 * Where the fallback write goes: the player's own gain.
 *
 * Registered by the screen because the player is the screen's, not this
 * module's — and because the fallback is a POSITION, not a second policy: every
 * decision about what the value should be is made here either way.
 */
export function setVolumeFallback(write: (value: number) => void): void {
  fallback = write;
}

/** True once the gesture is moving the DEVICE stream. */
export function usingDeviceVolume(): boolean {
  return api !== null;
}

/** The value a swipe baseline starts from. */
export function readVolume(): number {
  return current;
}

/**
 * Resolve the device API and read the volume to start from.
 *
 * Resolves to the baseline. Safe to call more than once: the module import is
 * memoised, and a failed read keeps the value we already had rather than
 * snapping the viewer's phone to full.
 */
export async function beginVolumeSession(): Promise<number> {
  if (Platform.OS === 'web') return current;
  // Expo Go, or a build made before the package was installed: there is no
  // device API to reach, so do not even load the module that would throw.
  if (!nativeLinked) return current;

  if (!api) {
    loading ??= (async () => {
      try {
        const mod = await import('react-native-volume-manager');
        const manager = (mod as unknown as { VolumeManager?: VolumeApi }).VolumeManager;
        return manager && typeof manager.setVolume === 'function' ? manager : null;
      } catch {
        return null;
      }
    })();
    api = await loading;
  }

  if (!api) return current;

  try {
    const result = await api.getVolume();
    const value = result?.volume;
    if (typeof value === 'number' && Number.isFinite(value)) current = clamp01(value);
  } catch {
    /* keep the baseline we have */
  }

  // FOLLOW THE HARDWARE KEYS. The gesture's baseline has to be the volume the
  // phone is ACTUALLY at, or the first swipe of a session jumps to wherever our
  // last read said it was.
  if (!listening && typeof api.addVolumeListener === 'function') {
    listening = true;
    try {
      api.addVolumeListener((result) => {
        const value = result?.volume;
        if (typeof value === 'number' && Number.isFinite(value)) current = clamp01(value);
      });
    } catch {
      /* not fatal — the session just keeps its own idea of the level */
    }
  }

  return current;
}

/** Apply a swipe value (0 → 1), coalesced. Returns immediately. */
export function setVolume(value: number): void {
  current = clamp01(value);
  writer.set(current);
}

/** The finger lifted: land the pending value now rather than on the timer. */
export function commitVolume(): void {
  writer.end();
}

/** Teardown: drop anything queued and write nothing (the player is gone). */
export function cancelVolumeWrites(): void {
  writer.cancel();
}
