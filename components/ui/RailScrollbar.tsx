// The thin scrollbar under a horizontal rail.
//
// Extracted from the detail page's `Genres & Keywords` rail, where it has
// always lived. The explore screen needs the same under its genre and filter
// rows, and the arithmetic for it (thumb LENGTH = visible fraction, POSITION =
// scroll fraction) is the kind of thing that quietly drifts when it is written
// twice. One implementation, two rails, one set of maths.
//
// WHY NOT THE PLATFORM SCROLLBAR: `showsHorizontalScrollIndicator` draws a
// chunky system bar that cannot be styled, and on Android it overlaps the
// content. This is a `transform` on a 3px view, so it costs nothing per frame.
//
// MEASUREMENT — WHY AN INNER `onLayout`, NOT `onContentSizeChange`.
//
// This went through three versions and the symptom was identical every time: the
// bar stayed invisible until the user scrolled the rail, then popped in.
//
//   v1  rail wrapped in Reanimated's `Animated.ScrollView`. It forwards a
//       limited set of props to the ScrollView it wraps and `onContentSizeChange`
//       never arrived, so contentW stayed 0 and the track never mounted.
//   v2  plain ScrollView + `onContentSizeChange`. Now the bar appeared ONLY
//       AFTER a drag — the tell-tale sign of that callback reporting the
//       viewport rather than the content. `contentW > railW + 4` is therefore
//       false on mount, and the only thing making the bar appear was the
//       safety-net reading geometry off the scroll event.
//
// The fix is to stop asking the SCROLLVIEW how wide its content is and ask an
// ordinary VIEW. `onLayout` reports the box React Native actually laid out —
// the one measurement that cannot disagree with what is on screen. So the
// children live in an explicit content View whose width IS the content width:
// the sum of the pills, not the viewport. It also pins `flexDirection: 'row'`
// here rather than relying on React Native applying it to its own container.
//
// The ScrollView's `onLayout` (the viewport) and the scroll event's
// `layoutMeasurement` stay as corroboration. All three agree; whichever lands
// first wins, and none of them can leave the bar permanently blank.
//
// WHY `Animated.ScrollView`, AND WHY IT IS SAFE HERE. Reanimated can only take
// scroll events natively off a component it created itself — attach a worklet
// scroll handler to a PLAIN `ScrollView` and it does not get UI-thread
// treatment (the thumb still trails, because the JS events are coalesced) and
// the lifecycle form can throw outright. Both of those were tried here. So the
// rail IS an `Animated.ScrollView`, which is the only pairing that works.
//
// The original reason for avoiding it was prop forwarding, and that reason is
// gone: the measurements no longer touch the scrollable at all. See below.
//
// WHICH MEASUREMENT OWNS WHAT. Neither size comes from the ScrollView. The
// OUTER plain View reports the viewport; the INNER plain View reports the
// content. Two `onLayout`s on views this component owns directly, so nothing
// depends on what the scrollable chooses to pass along — which is what let the
// bar appear on mount instead of only after the first drag.
//
// NO `withTiming` IN THE ANIMATED STYLE. The obvious way to fade the thumb in
// while scrolling is `withTiming(…, {duration})` inside `useAnimatedStyle`, and
// it is wrong: the style re-evaluates every frame during a drag, so each frame
// RESTARTS the 300ms animation and the opacity crawls a few percent toward its
// target — it settles near the resting value and the highlight never arrives.
// Reading the shared value directly gives an instant, correct response, which on
// a 2px rule is indistinguishable from a fade and costs nothing. The fade-OUT
// is a real timing on the SHARED VALUE (`withDelay` + `withTiming` in the
// handler), which is where a timing belongs.
//
// IT ONLY MOUNTS WHEN THE CONTENT REALLY OVERFLOWS. A row that fits gets no bar
// at all, rather than a full-width stub implying motion that cannot happen.
// That is why the genre row always has one (18 pills) and the filter row often
// does not (5 short dropdowns fit a phone).
//
// THE OPACITY IS THE AFFORDANCE. 0.8 at rest — quiet enough to read as a rule
// rather than a control, bright enough to actually be seen on a near-black
// page — and 1.0 while the rail is moving, so the bar that tells you where you
// are is brightest exactly when you need it.
//
// IT IS 2px. Thinner than the 3px it started as: at 3px a 2px thumb inside a
// 3px track has no visible inset, so the bar reads as a solid block with a
// faint smudge rather than a handle sitting in a track.

import type { ReactNode } from 'react';
import { useState } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import { StyleSheet, View } from 'react-native';
import Animated, {
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
} from 'react-native-reanimated';
import { useTheme } from '@/lib/ui/useTheme';

export function RailScrollbar({
  children,
  contentContainerStyle,
  style,
  /** Gap between the track's ends and the rail's edges. Must match the content
   *  container's own horizontal padding or the bar will not line up with the
   *  pills it is describing. */
  trackInset = 0,
}: {
  children: ReactNode;
  contentContainerStyle?: StyleProp<ViewStyle>;
  style?: StyleProp<ViewStyle>;
  trackInset?: number;
}) {
  const { color } = useTheme();
  const [railW, setRailW] = useState(0);
  const [contentW, setContentW] = useState(0);
  const scrollX = useSharedValue(0);
  const scrolling = useSharedValue(0);

  // UI thread, simple handler form — the lifecycle form (`onMomentumEnd` and
  // friends) is what crashed, and it is not needed: each event raises the flag
  // and schedules it back down, so the thumb stays bright for 140ms after the
  // rail stops moving and covers the momentum coast without any of those
  // handlers.
  const onScroll = useAnimatedScrollHandler((e) => {
    scrollX.value = e.contentOffset.x;
    scrolling.value = 1;
    scrolling.value = withDelay(140, withTiming(0, { duration: 220 }));
  });

  const maxScroll = Math.max(0, contentW - railW);
  const trackW = Math.max(0, railW - trackInset * 2);
  // Thumb LENGTH = the visible fraction of the content, clamped so it is always
  // comfortably grabbable-looking and never fills the whole track (which would
  // read as "there is nothing more").
  const thumbW =
    contentW > 0 && railW > 0 && trackW > 0
      ? Math.max(28, Math.min(trackW * 0.45, trackW * (railW / contentW)))
      : 0;
  const travel = Math.max(0, trackW - thumbW);

  const thumbStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: maxScroll > 0 ? (scrollX.value / maxScroll) * travel : 0 }],
    // Read the shared value directly — see the header on `withTiming`.
    opacity: 0.8 + scrolling.value * 0.2,
  }));

  // Only visible once both measurements have landed AND the row really is
  // wider than the viewport.
  const showTrack = railW > 0 && contentW > railW + 4 && thumbW > 0;

  return (
    // The VIEWPORT, measured on a plain View this component owns — never on the
    // ScrollView, whose callbacks were the original source of the bug.
    <View
      style={style}
      onLayout={(e) => {
        const w = e.nativeEvent.layout.width;
        if (w !== railW) setRailW(w);
      }}
    >
      {/* The scrollable itself. `Animated.ScrollView` is required for the
          worklet handler above to receive events natively — a plain ScrollView
          silently runs them on the JS thread instead. Note it is given NO
          measurement callbacks: everything is measured on the two plain Views. */}
      <Animated.ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        scrollEventThrottle={16}
        onScroll={onScroll}
      >
        {/* The CONTENT. An ordinary View, so `onLayout` reports the box React
            Native actually laid out — the width of all the pills together,
            which no ScrollView callback has been reliably reporting here.
            `styles.content` pins the row direction here rather than relying on
            React Native applying it to its own content container. */}
        <View
          style={[styles.content, contentContainerStyle]}
          onLayout={(e) => {
            const w = e.nativeEvent.layout.width;
            if (w !== contentW) setContentW(w);
          }}
        >
          {children}
        </View>
      </Animated.ScrollView>

      {showTrack ? (
        <View
          style={[
            track,
            {
              width: trackW,
              // `marginHorizontal`, NOT `alignSelf: center` plus a one-sided
              // margin: Yoga resolves a centred child as
              // (parent − margins − width) / 2 + marginLeft, which slid the
              // whole track off-centre by half the inset.
              marginHorizontal: trackInset,
              backgroundColor: color.border.muted,
            },
          ]}
          pointerEvents="none"
        >
          <Animated.View
            style={[
              thumb,
              // `text.secondary`, not `text.muted`: on a near-black page the
              // muted grey at this size was indistinguishable from the track
              // behind it.
              { width: thumbW, backgroundColor: color.text.secondary },
              thumbStyle,
            ]}
          />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  content: {
    flexDirection: 'row',
    // Guarantees the View takes its INTRINSIC width inside a horizontal
    // ScrollView. In a ROW container width comes from flex-basis/grow/shrink,
    // not `alignSelf` (that is the cross axis), so these two are what stop it
    // being squeezed toward the viewport width — and `contentW` collapsing onto
    // `railW` is the exact failure this component had twice.
    flexGrow: 0,
    flexShrink: 0,
  },
});

const track = {
  height: 2,
  borderRadius: 1,
  overflow: 'hidden' as const,
  marginTop: 7,
  alignSelf: 'center' as const,
};

const thumb = {
  height: 2,
  borderRadius: 1,
};