// Player tuning — turns the user's engine / buffer / seek settings into the
// options expo-video actually accepts, in one place.
//
// WHY ONE PLACE: the settings store holds human-readable keys ('native', 'low',
// 'exact') and the mapping to expo-video's real knobs must be identical
// everywhere. `applyTuning()` writes `player.bufferOptions`, `player.seekTolerance`,
// `player.audioMixingMode` and `player.preservesPitch` — and can be called
// before first play and again when the user flips a setting. The `surfaceType`
// travels through the VideoView prop instead, which must NOT change at runtime,
// so a consumer that renders `surfaceType` from tuning should key its VideoView
// on `tuningKey()` to remount cleanly when the engine changes.
//
// ═══════════════════════════════════════════════════════════════════════════
// WHAT IS NOT HERE, AND WHY — READ THIS BEFORE ADDING IT BACK
//
// A "Decoder" section used to offer Hardware / Software / Auto. All three
// produced a byte-identical player:
//
//   - `tuningFor()` branches on `engine` and never on `decode`. The result
//     carried a `decodePinned: boolean`, and `grep decodePinned` over the app
//     returns this file and nothing else — no consumer ever read it.
//   - There is no decoder knob to write even if something wanted to.
//     `PlayerBuilderOptions` in SDK 57 carries exactly `seekForwardIncrement`
//     and `seekBackwardIncrement` (asserted against the `.d.ts` by
//     `scripts/check-player-scrub.ts`).
//
// So the setting was a promise the player could not keep, on the one screen a
// viewer opens when something is visibly wrong. It was removed on 13 Oct and
// replaced with properties that exist: `seekTolerance`, `audioMixingMode` and
// `preservesPitch`. If a future SDK grows a real decoder selector, add it HERE
// and in the registry — nowhere else — and do not describe it as working until
// `PlayerTuning` actually differs between its values.
//
// `'compat'` went the same way for a smaller reason: it differed from `'auto'`
// in no field at all, because everything it would have changed was already what
// `'auto'` produced.
//
// ═══════════════════════════════════════════════════════════════════════════
// WHAT IS ALSO NOT HERE: scrubbingModeOptions
//
// It is a real SDK 57 property and it is used — but it is NOT a setting, because
// it is not a standing preference. On Android `scrubbingModeEnabled: true`
// SUPPRESSES PLAYBACK, so a value stored in the settings bag would be a value
// the player could freeze on. It belongs to the drag that is happening right
// now, and its lifecycle is a rule rather than a preference, so it lives in
// `lib/player/scrub.ts` with the three call sites that must turn it back off.

import type { BufferOptions, VideoPlayer } from 'expo-video';
import {
  readSetting,
  type PlayerAudioMixingKey,
  type PlayerBufferKey,
  type PlayerEngineKey,
  type PlayerSeekPrecisionKey,
} from '@/lib/settings/store';
import { toleranceFor, type SeekTolerance } from '@/lib/player/scrub';

export interface PlayerTuning {
  engine: PlayerEngineKey;
  buffer: PlayerBufferKey;
  /** Values for VideoPlayer's builder, from the three settings above. */
  bufferOptions: BufferOptions;
  /**
   * VideoView surfaceType.
   *
   * `'textureView'` is not a workaround for a hypothetical — SDK 57's own
   * known-issues note names overlapping `VideoView`s with `contentFit: 'cover'`
   * rendering out of bounds and prescribes `textureView`. Independently, this
   * app composites a fullscreen control layer over the video, and a TextureView
   * is what that composites onto reliably. `'surfaceView'` is therefore the
   * escape hatch for a device that misbehaves on it, which is exactly what the
   * settings label now says.
   */
  surfaceType: 'surfaceView' | 'textureView';
  /** The standing seek tolerance. See `lib/player/scrub.ts`. */
  seekTolerance: SeekTolerance;
  /**
   * Which precision produced `seekTolerance`.
   *
   * Carried alongside the numbers rather than only beside them so there is ONE
   * place that reads the setting. The scrub path needs the KEY, not the
   * numbers, because a drag may widen them — and reading the store a second time
   * to get it would leave two resolvers for one preference, which is the shape
   * that produced the duplicate Decoder entries.
   */
  seekPrecision: PlayerSeekPrecisionKey;
  /** Passed to `player.audioMixingMode` unchanged — expo-video's own enum. */
  audioMixingMode: PlayerAudioMixingKey;
  /** Passed to `player.preservesPitch` unchanged. */
  preservesPitch: boolean;
}

/**
 * Buffer profiles, in seconds / bytes. Tuned for a low-RAM phone first:
 * 'low' holds ~15s ahead and caps the byte pool so a 1080p stream cannot eat
 * the device's memory; 'high' trades memory for stutter slack on weak links.
 */
const BUFFER_PROFILES: Record<PlayerBufferKey, BufferOptions> = {
  low: {
    preferredForwardBufferDuration: 15,
    minBufferForPlayback: 1.5,
    maxBufferBytes: 24 * 1024 * 1024,
    prioritizeTimeOverSizeThreshold: false,
  },
  balanced: {
    preferredForwardBufferDuration: 30,
    minBufferForPlayback: 2,
    maxBufferBytes: 48 * 1024 * 1024,
    prioritizeTimeOverSizeThreshold: true,
  },
  high: {
    preferredForwardBufferDuration: 60,
    minBufferForPlayback: 2.5,
    // 0 = the pipeline decides; on a flaky CDN more slack beats a hard cap.
    maxBufferBytes: 0,
    prioritizeTimeOverSizeThreshold: true,
  },
};

/**
 * Resolve the player's settings into real expo-video options.
 *
 * The defaults are read from the store, which is what makes this callable as
 * `tuningFor()` from a player that resolves its tuning once per mount. Passing
 * all three explicitly is supported for the screens that subscribe and want the
 * change to take effect without a remount.
 */
export function tuningFor(
  engine: PlayerEngineKey = readSetting('player.engine'),
  buffer: PlayerBufferKey = readSetting('player.buffer'),
  precision: PlayerSeekPrecisionKey = readSetting('player.seekPrecision'),
  audioMixing: PlayerAudioMixingKey = readSetting('player.audioMixing'),
  preservesPitch: boolean = readSetting('player.preservesPitch')
): PlayerTuning {
  const bufferOptions = { ...BUFFER_PROFILES[buffer] };

  // The native surface is the "give me the lowest-power direct surface" preset.
  // Only `prioritizeTimeOverSizeThreshold` differs, and only on the Low profile —
  // 'balanced' and 'high' already set it — so for those two this branch is a
  // no-op and the engine's real effect is `surfaceType` below. Worth knowing,
  // because it means the setting has exactly one observable effect on two of
  // the three buffer profiles, and the check pins that rather than asserting a
  // difference that does not exist.
  if (engine === 'native') {
    (bufferOptions as { prioritizeTimeOverSizeThreshold?: boolean }).prioritizeTimeOverSizeThreshold = true;
  }

  return {
    engine,
    buffer,
    bufferOptions,
    surfaceType: engine === 'native' ? 'surfaceView' : 'textureView',
    seekTolerance: toleranceFor(precision),
    seekPrecision: precision,
    audioMixingMode: audioMixing,
    preservesPitch,
  };
}

/**
 * A stable identity for the current tuning, so a consumer can key an effect
 * (or a `useVideoPlayer` recreation) on "did any player-affecting setting
 * change" without comparing objects.
 *
 * `engine` leads and nothing is dropped, because a key that omits a field
 * silently coalesces two different configurations into one — which is how the
 * decoder section came to contain three options and one behaviour.
 */
export function tuningKey(t: PlayerTuning): string {
  return `${t.engine}|${t.buffer}|${t.seekTolerance.toleranceBefore}/${t.seekTolerance.toleranceAfter}|${t.audioMixingMode}|${t.preservesPitch}`;
}

/**
 * Write the settings onto a player.
 *
 * `bufferOptions` is a single object assignment, not field edits — expo-video
 * explicitly rejects setting the individual buffer properties. The other three
 * are plain properties and are assigned individually for the same reason.
 *
 * `scrubbingModeOptions` is deliberately NOT written here. It is not a standing
 * setting and writing it would overwrite whatever a live drag had set; it
 * belongs to `lib/player/scrub.ts`.
 */
export function applyTuning(player: VideoPlayer, t: PlayerTuning): void {
  player.bufferOptions = t.bufferOptions;
  player.seekTolerance = t.seekTolerance;
  player.audioMixingMode = t.audioMixingMode;
  player.preservesPitch = t.preservesPitch;
}