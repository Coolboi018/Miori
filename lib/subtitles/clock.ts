/**
 * WHICH TIME A SUBTITLE LOOKUP MAY USE — the one rule, so four samplers agree.
 *
 * A media replace (quality switch, source hop, reconnect, a cache-restored
 * open) leaves the native playhead at 0 until the position to restore can be
 * honoured. During that window 0 is not "the start of the episode" — it is
 * "not known yet". Looking a cue up for it drew the OPENING line over a
 * resumed mid-episode frame, which is the "subtitles are briefly out of sync
 * after a reload" half of the 21 Nov report: the line was not mistimed, it was
 * answering a question about a playhead that did not exist.
 *
 * The guard is deliberately narrow — only an ARMED restore AND a playhead
 * below `PLACEHOLDER_PLAYHEAD_S`. Once the seek lands (or when there is
 * nothing to restore) the real playhead is used again, so a legitimate 0:00
 * start still shows its first line, and a paused episode keeps the line it was
 * paused on.
 *
 * No React Native imports: `scripts/check-replay.ts` drives this under `tsx`.
 */

/**
 * Below this, with a restore armed, the playhead is a placeholder.
 *
 * One second, not zero: a replace resets the playhead to exactly 0 but the
 * first `timeUpdate` can report a few milliseconds of pre-roll, and the point
 * is to cover the whole "item is being prepared" window rather than one exact
 * sample. A viewer cannot be looking at a subtitle in the first second of a
 * resumed item anyway.
 */
export const PLACEHOLDER_PLAYHEAD_S = 1;

/**
 * The time to look a cue up at, or `null` for "show nothing".
 *
 * `restoreArmed` is the player's own knowledge that a position is waiting to be
 * applied — not something this module can infer from the number.
 */
export function cueLookupTime(playhead: number, restoreArmed: boolean): number | null {
  if (!Number.isFinite(playhead) || playhead < 0) return null;
  if (restoreArmed && playhead < PLACEHOLDER_PLAYHEAD_S) return null;
  return playhead;
}
