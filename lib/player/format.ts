// Small formatters the player chrome needs. Split out so the clock format is
// defined once — a time readout that disagrees with itself between the progress
// bar and the lock-screen HUD is the kind of thing nobody reports and everybody
// notices.

import { font } from '@/lib/ui/tokens';
import type { TextStyle } from 'react-native';

/**
 * What the clock shows when the runtime is not known yet.
 *
 * `0:00` IS A CLAIM, AND FOR THE FIRST COUPLE OF SECONDS OF EVERY PLAYER IT IS A
 * FALSE ONE. `player.duration` is 0 until the manifest is parsed, so rendering
 * `formatClock(duration)` printed `0:00 / 0:00` — an assertion that the episode
 * is zero seconds long — and then snapped to the real runtime and the resume
 * point a second or two later. The viewer watched the readout move twice before
 * the picture had even started.
 *
 * `--:--` is the conventional "not known" and, more importantly, it is not a
 * number, so nothing downstream can read it as a position.
 */
export const UNKNOWN_CLOCK = '--:--';

/**
 * `m:ss`, or `h:mm:ss` once the runtime passes an hour.
 *
 * NEGATIVE INPUT CLAMPS TO ZERO. The player is fed live positions and drag
 * offsets, and `-10` arriving from a backwards double-tap is a normal event, not
 * a bug — `String(-10)` would render as "-0:10".
 *
 * A non-finite input is not clamped to zero but to `UNKNOWN_CLOCK`, for the same
 * reason above: a position we do not have is not a position of nought.
 */
export function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds)) return UNKNOWN_CLOCK;
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => (n < 10 ? `0${n}` : String(n));
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

/**
 * `Episode 7.5` for a fractional number, `Episode 7` otherwise.
 *
 * Sources do emit `.5` episodes (split-cour fillers), and rounding them to the
 * nearest integer would put the wrong number in the title bar AND send the
 * player looking for an episode that may not be listed.
 */
export function formatEpisodeNumber(n: number): string {
  return Number.isInteger(n) ? String(n) : String(n);
}

/** `-15s` / `+15s` for the accumulated double-tap readout. */
export function formatSeekDelta(seconds: number): string {
  const sign = seconds > 0 ? '+' : seconds < 0 ? '−' : '';
  return `${sign}${Math.abs(seconds)}s`;
}

/**
 * Clock text carries tabular figures so the digits do not shuffle as it ticks.
 *
 * Typed as `TextStyle` rather than left to inference. An inferred literal would
 * give `fontVariant` the type `readonly ["tabular-nums"]`, and `TextStyle`'s own
 * `fontVariant` is a mutable `FontVariant[]` — so spreading this into a style
 * is a type error even though it is perfectly valid at runtime. Typing it
 * widens the literal to the array the style system expects.
 */
export const CLOCK_FONT: TextStyle = {
  fontFamily: font.medium,
  fontVariant: ['tabular-nums'],
};