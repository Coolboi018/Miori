// The swap between a loading skeleton and real content.
//
// WHY THIS IS TWO RENDERS AND NOT ONE.
//
// It used to be a single `if (loading)` returning either a plain `View` around
// the skeleton or an `Animated.View` around the content. Two different element
// types, so React unmounted the entire skeleton and mounted the entire content
// in ONE commit — on a home screen that is 400-odd views in and the skeleton's
// 250 back out again, landing in the one moment the user is watching hardest.
//
// What that looks like from the sofa is: the skeleton sweeps, sweeps, sweeps,
// then vanishes outright, then a beat of nothing at all, then the content. The
// vanish is a SNAP because the skeleton is gone on the same frame. The beat of
// nothing is because `entering={FadeIn}` starts the new subtree at opacity 0
// and the skeleton that was covering for it has already left. And the long
// sweep before all of that is the blocking commit itself: the skeleton keeps
// animating through it — Reanimated is on the UI thread — so the screen looks
// busy while nothing at all is happening.
//
// The fix is that the skeleton is never UNMOUNTED, only covered and then
// dissolved. It is a layer above the content rather than a branch beside it:
//
//   loading=true     the skeleton, in normal flow, sizing the page
//   loading flips    the content mounts UNDERNEATH a skeleton that is still
//                    there at full opacity. The frame on screen does not change
//                    at all, and the sweep keeps running through the blocking
//                    commit, so the wait reads as loading rather than as a
//                    stall.
//   next render      the skeleton starts `exiting` and dissolves, revealing
//                    content that is ALREADY opaque underneath
//
// Three things fall out of that, and only the first is cosmetic:
//
//   1. NO SNAP AND NO BLANK FRAME. The content does not animate in from nothing
//      because it does not need to — it is simply uncovered. Nothing on screen
//      is ever less than opaque except the skeleton, which is the one thing
//      that is allowed to be.
//   2. THE BLOCKING COMMIT SHRINKS. The skeleton's teardown — ~250 views for a
//      home skeleton, and more now that the plates animate — leaves the critical
//      commit entirely and happens one render later, in a commit of its own.
//      The commit that has to land before the user sees ANYTHING is now
//      content plus one skeleton relayout, rather than content plus the whole
//      skeleton's life cycle. That relayout is height-only and cheap: the root is
//      `flex: 1` in a `flex: 1` parent either way, so it keeps the same height
//      across the switch and the plates' own boxes do not move.
//   3. The dissolve cannot dip the way a two-sided crossfade does. Compare the
//      tab switch, where two screens fade through each other and the scene
//      container shows through the middle. Here the layer underneath is opaque
//      for the whole 200ms, so the worst case is "you can see the content a
//      little early", which is not a defect.
//
// WHAT THIS DOES NOT DO, because it is the other half of the complaint and it is
// a different fix: it does not make the mount CHEAPER. The content still arrives
// in one commit and on a slow device that is still a long wait. This makes the
// wait honest — something keeps moving, and then it dissolves rather than
// jumping — but the length of the wait is the mount's, and the fix for THAT is
// mounting the sections progressively, which is a change to the screens rather
// than to this file. `HomeSkeleton` mounts the same number of plates the content
// has rows, so a cheap first lever is to shrink the skeleton rather than the
// page.
//
// WHY REANIMED AND NOT `Animated`. Reanimated's layout animations run on the UI
// thread, so the dissolve costs the JS thread nothing. The RN `Animated`
// equivalent would run on the JS thread and compete with exactly the work the
// user is waiting for — parsing the response, mounting ~80 poster tiles,
// decoding bitmaps. That is an animation that makes the app slower in order to
// look smoother, in the one place the user is already waiting.
//
// WHY IT IS SHORT. 200ms — long enough to read as a dissolve rather than a
// flash, short enough not to be a delay. A skeleton that takes half a second to
// go has turned a loading state into a loading animation.
//
// WHY PURE OPACITY, AND WHY THE CONTENT DOES NOT ANIMATE AT ALL. No slide: a
// vertical movement on a whole page of rails reads as the page MOVING, which
// competes with the fact that something above it may also be arriving. And the
// content carries no `entering` animation — that is the change. An entering
// animation on the content is what produces the blank beat, and it is
// unnecessary once the skeleton is the thing that dissolves.

import { useLayoutEffect, useState } from 'react';
import { StyleSheet, View, type ViewStyle } from 'react-native';
import Animated, { FadeOut, useReducedMotion } from 'react-native-reanimated';

/** See the note above. Long enough to read, short enough not to delay. */
const DURATION_MS = 200;

export function LoadingBoundary({
  loading,
  skeleton,
  children,
  style,
}: {
  /** True while there is nothing real to show. */
  loading: boolean;
  /** The placeholder. Stays mounted through the dissolve — see the note above. */
  skeleton: React.ReactNode;
  /** The real content. Revealed, never animated in. */
  children: React.ReactNode;
  style?: ViewStyle;
}) {
  /**
   * Whether the skeleton has finished handing over.
   *
   * The whole trick is that this is a SECOND render, not a second commit of
   * content. When `loading` flips, the content mounts on the very next render
   * with `handedOver` still false — so the skeleton is right there, in the same
   * tree, at full opacity, doing the covering. This effect then flips the flag
   * and THAT render takes the skeleton away, which is what starts the dissolve.
   *
   * A single render cannot do it, because "mount the content" and "remove the
   * skeleton" in one commit is the exact thing that produced the snap.
   *
   * Initialised from `loading` so that a screen with a warm cache — which is the
   * normal case from the second launch onward — never mounts the skeleton at
   * all. Nothing to hand over, nothing to dissolve, one render.
   */
  const [handedOver, setHandedOver] = useState(!loading);

  // WHY `useLayoutEffect` AND NOT `useEffect`. The flag flip is a render of
  // its own, and a passive effect lets everything else on the JS thread —
  // FlatList's post-mount batches, image-load state, anything scheduled by the
  // content that JUST committed — run first. On a phone that window was not
  // one frame, it was seconds: the skeleton sat at full opacity OVER the
  // freshly mounted posters until this flip's render finally got to run. A
  // layout effect runs synchronously at the end of the commit, BEFORE the
  // frame paints — so the flip's render is processed immediately and the
  // dissolve is already running on the UI thread the first moment the content
  // is visible. The overlay window between "content exists" and "skeleton
  // leaving" is zero by construction, not by luck.
  useLayoutEffect(() => {
    setHandedOver(!loading);
  }, [loading]);

  const reduced = useReducedMotion();
  // `undefined` is the documented way to say "no exit animation", which is what
  // a user who asked for less motion should get: the skeleton leaves on the
  // frame it is asked to rather than dissolving over it.
  const exit = reduced ? undefined : FadeOut.duration(DURATION_MS);

  // While loading, the skeleton IS the page and has to be in normal flow: the
  // root has no content to give it a height yet, and on a screen whose parent
  // does not bound its height (search's landing state, inside a FlatList cell)
  // an absolutely-positioned skeleton would collapse to nothing.
  //
  // After the handover the content is what sizes the root, and the skeleton
  // becomes a layer over the top of it. Absolute fill then always covers the
  // whole content, bounded parent or not, because the root is exactly as tall as
  // the thing it has to hide.
  const showSkeleton = loading || !handedOver;

  return (
    <View style={[styles.root, style]}>
      {!loading ? children : null}

      {showSkeleton ? (
        <Animated.View
          exiting={exit}
          // The content underneath is fully interactive from the frame it mounts.
          // Blocking touches for 200ms so a skeleton plate could be "hit" would
          // be a worse bug than the one this file exists to fix.
          pointerEvents="none"
          // Only announced while it is actually the loading state; during the
          // dissolve the content is on screen and claiming to be a progress
          // indicator over it is a lie to a screen reader.
          accessibilityRole={loading ? 'progressbar' : undefined}
          accessibilityLabel={loading ? 'Loading' : undefined}
          style={loading ? styles.inFlow : styles.overlay}
        >
          {skeleton}
        </Animated.View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  inFlow: { flex: 1 },
  // Spelled out rather than spread from `StyleSheet.absoluteFillObject`, which
  // RN 0.86 no longer exposes as a public type.
  overlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
});
