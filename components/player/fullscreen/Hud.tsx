// Transient on-video readouts: the held-press speed pill and the double-tap
// seek flash. Both are receipts, not controls.
//
// The split from `components/player/PlayerControls` is deliberate. Those buttons
// live in the chrome, and the chrome auto-hides after 3s (`motion.controlsHide`),
// so a seek control that disappears is a control nobody can find. These two
// gestures belong to the video surface, are expressed only as an overlay for
// the half-second they need, and then get out of the way.

import { memo, useEffect, useSyncExternalStore } from 'react';
import { StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
} from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';

import { AppIcon } from '@/components/ui/AppIcon';
import { formatSeekDelta } from '@/lib/player/format';
import { readSideHud, subscribeSideHud } from '@/lib/player/sideHud';
import { hudSideFor } from './verticalSwipe';
import { formatRate } from '@/lib/player/speed';
import { font, radii } from '@/lib/ui/tokens';

/** Shared by both HUDs; they appear and leave on the same rhythm. */
const SHOW_MS = 120;
const HIDE_MS = 200;

/** Gap between the screen's top edge and the speed pill, in points. */
export const SPEED_PILL_TOP = 12;

/**
 * The held-press speed readout.
 *
 * Shows the LIVE rate, not the committed one — while a finger is down the
 * committed rate is not what is happening, and a HUD that said "1.25x" during a
 * 2x hold would be the same lie the ShonenX bug tells, just for 200ms instead of
 * forever. `lib/player/speed.ts` is what guarantees the value here and the
 * engine's `playbackRate` are the same number.
 *
 * PLACEMENT, second attempt. It was band-centred once and a device pass
 * (5 Nov) rejected it: mid-frame the pill reads as video content over the faces
 * being watched. Anchoring it to the top chrome's bottom edge instead was ALSO
 * not what was asked for — the device verdict is "very top of the screen, small
 * gap", a CONSTANT, not an offset derived from the chrome. So it hangs from
 * `SPEED_PILL_TOP` regardless of the top bar, inset or notch. Accepted
 * trade-off, stated plainly: while the chrome is up the pill shares the title
 * row; that only happens when a hold begins within the ~3s window the chrome
 * stays open, and the chrome is ephemeral while the pill is a receipt for a
 * gesture that is happening right now.
 *
 * This is why the component no longer takes the chrome offsets the band
 * placement needed — `GestureSurface` keeps them as props for other overlays,
 * but this one has no use for a variable input it was just told to ignore.
 */
export const SpeedHud = memo(function SpeedHud({ rate }: { rate: number }) {
  const p = useSharedValue(0);

  useEffect(() => {
    p.value = withTiming(1, { duration: SHOW_MS, easing: Easing.out(Easing.quad) });
  }, [p, rate]);

  const style = useAnimatedStyle(() => ({
    opacity: p.value,
    transform: [{ scale: 0.9 + p.value * 0.1 }],
  }));

  return (
    // Pinned to the very top of the screen — see the note above `SpeedHud`.
    <View style={[styles.speedBox, styles.speedBoxTop]} pointerEvents="none">
      <Animated.View style={[styles.pill, style]}>
        <AppIcon name="boost" size={20} color="#fff" strokeWidth={2.25} />
        <Text style={styles.speedText}>{formatRate(rate)}x</Text>
      </Animated.View>
    </View>
  );
});

/**
 * The double-tap seek flash, with the running total.
 *
 * The TOTAL is the point. Four quick taps should read "+40s", not a row of
 * "+10s" that each overwrite the last — the accumulated number is what tells
 * the user the gesture is additive rather than a race between four presses.
 */
export const SeekHud = memo(function SeekHud({
  delta,
  side,
}: {
  /** Signed accumulated seconds. Sign picks the side. */
  delta: number;
  side: 'left' | 'right';
}) {
  const p = useSharedValue(0);

  useEffect(() => {
    p.value = 0;
    p.value = withTiming(1, { duration: 200, easing: Easing.out(Easing.cubic) });
    // Re-run on every accumulated change so each tap re-pops the pill. Keyed on
    // `delta` rather than a reset flag for the same reason `SeekRipple` is
    // keyed: a shared value driven from JS shows a frame of the previous frame's
    // value first.
  }, [p, delta]);

  const style = useAnimatedStyle(() => ({
    opacity: withDelay(600, withTiming(0, { duration: HIDE_MS, easing: Easing.in(Easing.quad) })),
    transform: [{ scale: 0.85 + p.value * 0.15 }],
  }));

  const right = side === 'right';

  return (
    <View style={[styles.seekBox, right ? styles.seekRight : styles.seekLeft]} pointerEvents="none">
      {/* The directional wash: opaque at the edge the playhead is heading toward,
          clear at the inner boundary. It is what makes a 10s jump legible from
          the corner of the eye without reading the number — the frame gets
          heavier on the side that is about to move. */}
      <LinearGradient
        colors={['rgba(0,0,0,0.5)', 'rgba(0,0,0,0)']}
        start={right ? { x: 1, y: 0.5 } : { x: 0, y: 0.5 }}
        end={right ? { x: 0, y: 0.5 } : { x: 1, y: 0.5 }}
        style={StyleSheet.absoluteFill}
      />
      <Animated.View style={style}>
        <AppIcon
          name={right ? 'fastForward' : 'rewind'}
          size={40}
          color="#fff"
          strokeWidth={2}
        />
        <Text style={styles.seekText}>{formatSeekDelta(delta)}</Text>
      </Animated.View>
    </View>
  );
});

/**
 * The volume / brightness readout — a VERTICAL bar on the half being swiped.
 *
 * WHY THE SIDE AND NOT THE MIDDLE. The first version was a centred pill, and it
 * was the wrong place twice over: it covered the frame the user is watching (the
 * one thing a HUD must never do), and it sat in the middle of the gesture's own
 * travel — the finger drags up and down the frame's centre, so the readout was
 * under the hand. Every player that has this gesture (VLC, MX, YouTube) puts it on
 * the edge the finger started on, and for good reason: the eye is already there,
 * waiting for the thing it is changing, and nothing in the picture is hidden.
 *
 * The side comes from the DRAG (`sideForX`), not from the knob: the halves are
 * swappable in settings, so deriving "volume = right" in the view would draw the
 * bar on the wrong edge for anyone who swapped them.
 *
 * AND IT DRAWS ON THE OPPOSITE EDGE (`hudSideFor`) — the one refinement that makes
 * the placement actually usable. The finger is ON the half it started on; a bar
 * there is a bar under the thumb, half of it behind the hand and the rest in the
 * only place the eye is not looking. Mirroring it puts the readout on the one
 * strip of screen nobody is touching. The knob is unchanged — only the display
 * moves.
 *
 * THE TRACK IS THE POINT. A number alone makes the user read; a vertical fill
 * tells them "near the top", which is the question they actually have, and it
 * reads at a glance in peripheral vision while their thumb is on the glass. The
 * track is a fraction of the WINDOW height rather than a constant — landscape on
 * a short phone has ~380pt to work with, and a bar sized for a tall one would
 * touch both edges.
 *
 * IT SUBSCRIBES TO ITS OWN STORE. `PlayerScreen` applies the value to the engine
 * and never re-renders; this is the only component that knows the number. That is
 * why the drag can be smooth on a screen with this much chrome in it.
 */
export const SideHud = memo(function SideHud() {
  const hud = useSyncExternalStore(subscribeSideHud, readSideHud, readSideHud);
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const p = useSharedValue(0);
  const shown = hud.kind != null;
  /** Mirrored from the drag — see the header. */
  const left = hudSideFor(hud.side) === 'left';

  useEffect(() => {
    p.value = withTiming(shown ? 1 : 0, {
      duration: shown ? SHOW_MS : HIDE_MS,
      easing: Easing.out(Easing.quad),
    });
  }, [p, shown]);

  /**
   * Fade, plus a small slide FROM the edge it belongs to — the bar arrives out of
   * the side the finger is on, which is what makes it read as part of the gesture
   * rather than as an overlay that happened to appear.
   */
  const style = useAnimatedStyle(() => ({
    opacity: p.value,
    transform: [
      { translateX: (1 - p.value) * (left ? -14 : 14) },
      { scale: 0.96 + p.value * 0.04 },
    ],
  }));

  const percent = Math.round(hud.value * 100);
  const trackHeight = Math.round(Math.min(220, Math.max(120, height * 0.42)));

  return (
    <View
      style={[
        styles.sideAnchor,
        // Clear of the notch/cutout in landscape, plus a gutter so the bar is not
        // glued to the bezel.
        left ? { left: insets.left + 18 } : { right: insets.right + 18 },
      ]}
      pointerEvents="none"
    >
      <Animated.View style={[styles.sidePlate, style]}>
        <AppIcon
          name={hud.kind === 'volume' ? 'volumeOn' : 'brightness'}
          size={20}
          color="#fff"
          strokeWidth={2}
        />
        <View style={[styles.sideTrack, { height: trackHeight }]}>
          {/* Filled from the BOTTOM up: 0% is an empty track, 100% a full one.
              A top-down fill would read as a download bar. */}
          <View style={[styles.sideFill, { height: `${percent}%` }]} />
        </View>
        <Text style={styles.sidePercent}>{percent}</Text>
      </Animated.View>
    </View>
  );
});

const styles = StyleSheet.create({
  speedBox: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'flex-start',
  },
  // The placement IS the constant: a fixed gap from the screen's top edge,
  // deliberately not derived from the chrome or the insets — the device verdict
  // that settled this (5 Nov). Mirrored as SPEED_PILL_TOP so
  // `check-chrome-layout.ts` can assert against the same number.
  speedBoxTop: {
    paddingTop: SPEED_PILL_TOP,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: radii.full,
    backgroundColor: 'rgba(0,0,0,0.72)',
  },
  speedText: {
    color: '#fff',
    fontFamily: font.bold,
    fontSize: 20,
    lineHeight: 24,
    // Fixed width so scrubbing 2.00 → 2.25 does not make the pill jitter as the
    // digit count changes. Generous enough for the widest label ("0.5x").
    minWidth: 46,
    textAlign: 'center',
    fontVariant: ['tabular-nums'],
  },

  seekBox: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: '42%',
    justifyContent: 'center',
  },
  seekLeft: { left: 0, alignItems: 'center' },
  seekRight: { right: 0, alignItems: 'center' },
  seekText: {
    color: '#fff',
    fontFamily: font.bold,
    fontSize: 16,
    lineHeight: 22,
    marginTop: 6,
    letterSpacing: 0.4,
    fontVariant: ['tabular-nums'],
  },

  // Top/bottom pinned with no width, so the plate decides the size and the side
  // offset decides where — nothing here measures the screen.
  sideAnchor: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    justifyContent: 'center',
  },
  sidePlate: {
    alignItems: 'center',
    gap: 10,
    paddingVertical: 14,
    paddingHorizontal: 10,
    borderRadius: radii.full,
    // Lighter than the speed pill on purpose: this one sits at the edge of the
    // picture and must not read as a panel.
    backgroundColor: 'rgba(0,0,0,0.42)',
  },
  sideTrack: {
    width: 6,
    borderRadius: 3,
    backgroundColor: 'rgba(255,255,255,0.18)',
    overflow: 'hidden',
    justifyContent: 'flex-end',
  },
  sideFill: { width: 6, borderRadius: 3, backgroundColor: '#fff' },
  sidePercent: {
    color: '#fff',
    fontFamily: font.semibold,
    fontSize: 12,
    lineHeight: 16,
    fontVariant: ['tabular-nums'],
  },
});
