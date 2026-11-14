import { useCallback, useState } from 'react';
import { StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';
import type { Cue } from '@/lib/subtitles/vtt';
import { subtitleBottomOffset, type ResolvedSubtitleStyle } from '@/lib/subtitles/style';
import { font } from '@/lib/ui/tokens';

// Custom subtitle overlay.
//
// `style` is a RESOLVED style object — the output of `resolveSubtitleStyle` —
// and it is required rather than defaulted, so a screen cannot render a cue with
// a font size that disagrees with the settings page describing it. The
// `VerticalPlayerScreen` in `legacy/` is the only other caller and passes
// `defaultSubtitleStyle()` explicitly.
//
// GEOMETRY, and why this component measures instead of being told.
//
// The wrapper is always mounted (a cue is null between lines, and the screen is
// still laid out), and it reports its own height. That height — not a window
// dimension and not a number derived in the player — is what the position
// fraction is applied to. The first version of the slider was handed
// `winH - barH - insets.top - TOP_BAR_TOTAL` from `PlayerScreen`, which is a
// height that ALREADY has the bottom bar in it, and then subtracted
// `bottomOffset` again here. On a landscape phone (411pt tall, 157pt bar) that
// leaves a 17pt slider and an anchor 38% up the frame: exactly the report "at
// low it is in the middle and a little further up it is gone off the top".
// Measuring makes the two callers (this player, the settings preview) agree by
// construction, and it survives rotation, insets and a re-laid-out preview
// without anyone restating a total.
//
// The cue box also reports its own height, because 100% has to mean "the top
// line is still visible": `bottom = frac * span` alone puts the box's bottom
// edge on the container's top edge.
//
// `bottomOffset` is the bottom chrome's MEASURED height, and it is only the
// FIRST-FRAME fallback: before the stage has measured itself there is no band
// to span, so the bar's height stands in for one frame. It is never multiplied
// by whether that bar is showing — the chrome is a temporary overlay on the
// video; the subtitle is part of the video. It used to be `bar ? 156 : 32`, so
// every tap moved all sixteen words of a cue up by 124pt.
//
// It ALSO used to BE the 'default' placement verbatim ("clear the timeline"),
// which the device killed on 9 Nov: 157pt up a ~411pt landscape frame floats
// the untouched default in the lower middle of the screen once the chrome is
// hidden. The default now lives inside `subtitleBottomOffset`
// (`SUBTITLE_DEFAULT_FRAC` of the measured band); only this fallback keeps the
// prop.
export function SubtitleOverlay({
  cue,
  style,
  bottomOffset = 48,
  topOffset = 0,
  sideInset = 0,
}: {
  cue: Cue | null;
  style: ResolvedSubtitleStyle;
  /**
   * The bottom chrome's measured height — the ONE-FRAME fallback the overlay
   * answers with before its own stage measurement has arrived.
   */
  bottomOffset?: number;
  /**
   * Chrome above the picture (top bar + safe-area inset). A custom cue at 100%
   * stops below it, so "Top" is a place a cue can actually be read.
   */
  topOffset?: number;
  /**
   * In landscape the notch is on a SIDE. Without this the cue box runs the full
   * width and the first and last words of a long line land under it.
   */
  sideInset?: number;
}) {
  /**
   * Two measurements, both in points, both compared before written: `onLayout`
   * fires on more occasions than one would think (font load, rotation, inset
   * settle, a cue growing a line) and an unguarded write re-renders the player
   * for a sub-point change nobody can see.
   */
  const [stageH, setStageH] = useState(0);
  const [cueH, setCueH] = useState(0);

  const onStage = useCallback((e: LayoutChangeEvent) => {
    const h = e.nativeEvent.layout.height;
    setStageH((prev) => (Math.abs(prev - h) < 1 ? prev : h));
  }, []);
  const onCue = useCallback((e: LayoutChangeEvent) => {
    const h = e.nativeEvent.layout.height;
    setCueH((prev) => (Math.abs(prev - h) < 1 ? prev : h));
  }, []);

  const { plate, shadow } = style;
  /**
   * The placement itself is `lib/subtitles/style.ts`'s job — one function, no
   * imports, asserted by `scripts/check-subtitles.ts`. Before the stage has been
   * measured there is nothing to compute against, so the bar's height is the
   * honest answer for a frame rather than a zero.
   */
  const bottom =
    stageH > 0
      ? subtitleBottomOffset({
          position: style.position,
          positionFrac: style.positionFrac,
          stageH,
          topH: topOffset,
          cueH,
        })
      : bottomOffset;

  return (
    <View style={styles.stage} pointerEvents="none" onLayout={onStage}>
      {cue ? (
        <View
          style={[
            styles.box,
            {
              bottom,
              left: 16 + sideInset,
              right: 16 + sideInset,
            },
            // The plate pads the box, not the glyphs, so the two treatments are
            // mutually exclusive rather than cumulative: 'plain' must not inherit
            // the padding and draw an invisible-but-present larger measuring box
            // around bare text.
            plate ? { paddingHorizontal: plate.paddingHorizontal, paddingVertical: plate.paddingVertical } : null,
          ]}
          onLayout={onCue}
        >
          <Text
            style={[
              styles.text,
              {
                fontSize: style.fontSize,
                lineHeight: style.lineHeight,
                color: style.color,
                ...(plate
                  ? {
                      backgroundColor: plate.backgroundColor,
                      borderRadius: plate.borderRadius,
                    }
                  : null),
                ...(shadow
                  ? {
                      textShadowColor: shadow.textShadowColor,
                      textShadowOffset: shadow.textShadowOffset,
                      textShadowRadius: shadow.textShadowRadius,
                    }
                  : null),
              },
            ]}
          >
            {cue.text}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  /** The measured stage: the whole parent, transparent, never touchable. */
  stage: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  box: {
    position: 'absolute',
    alignItems: 'center',
  },
  text: {
    color: '#fff',
    fontFamily: font.medium,
    textAlign: 'center',
  },
});
