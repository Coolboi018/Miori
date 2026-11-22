// The subtitle line(s), subscribed where they are DRAWN.
//
// `PlayerScreen` used to hold the live cue in `useState` and hand it down as a
// prop, which meant every subtitle line (a few per second) re-rendered the whole
// player — chrome, gradients, chips, timeline — for one line of text. This
// component is the seam that ends that: it subscribes to `lib/player/cueStore.ts`
// itself, so a cue change re-renders four props and two `Text`s, and the screen
// above it does not render at all.
//
// What it subscribes to is the whole FRAME — sign block above dialogue — not a
// single cue, because a track can have several cues open at once and the old
// single-cue lookup discarded all but the first (22 Nov).
//
// `SubtitleOverlay` stays prop-driven and unchanged (the settings preview renders
// it with its own sample), so the placement rules in `lib/subtitles/style.ts`
// keep exactly one implementation and one set of checks.

import { memo, useSyncExternalStore } from 'react';

import { SubtitleOverlay } from '@/components/player/SubtitleOverlay';
import { readCue, subscribeCue } from '@/lib/player/cueStore';
import type { ResolvedSubtitleStyle } from '@/lib/subtitles/style';

export const SubtitleStage = memo(function SubtitleStage({
  style,
  bottomOffset,
  topOffset,
  sideInset,
}: {
  /** Resolved subtitle style — see `resolveSubtitleStyle`. */
  style: ResolvedSubtitleStyle;
  /** The bottom chrome's measured height: the one-frame fallback only. */
  bottomOffset: number;
  /** Chrome above the picture, so a cue at 100% stops below it. */
  topOffset: number;
  /** Landscape notch gutter. */
  sideInset: number;
}) {
  const frame = useSyncExternalStore(subscribeCue, readCue, readCue);

  return (
    <SubtitleOverlay
      frame={frame}
      style={style}
      bottomOffset={bottomOffset}
      topOffset={topOffset}
      sideInset={sideInset}
    />
  );
});
