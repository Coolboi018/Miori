// Transient on-video readouts: the held-press speed pill, the double-tap seek
// flash and the volume / brightness bar. All three are receipts, not controls.
//
// The split from `components/player/PlayerControls` is deliberate. Those buttons
// live in the chrome, and the chrome auto-hides after 3s (`motion.controlsHide`),
// so a seek control that disappears is a control nobody can find. These gestures
// belong to the video surface, are expressed only as an overlay for the half
// second they need, and then get out of the way.

import { memo, useEffect, useState } from 'react';
import { StyleSheet, View, useWindowDimensions, Text } from 'react-native';
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
import {
  readSideHud,
  subscribeSideHud,
  type SideHudKind,
  type SideHudSide,
} from '@/lib/player/sideHud';
import { hudSideFor } from './verticalSwipe';
import { formatRate } from '@/lib/player/speed';
import { font, radii } from '@/lib/ui/tokens';

/** Shared by all three HUDs; they appear and leave on the same rhythm. */
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
 * The volume / brightness readout — a slim VERTICAL bar on the half being swiped.
 *
 * WHY THE EDGE AND NOT THE MIDDLE. The first version was a centred pill, and it
 * was the wrong place twice over: it covered the frame the user is watching (the
 * one thing a HUD must never do), and it sat in the middle of the gesture's own
 * travel — the finger drags up and down the frame's centre, so the readout was
 * under the hand. Every player that has this gesture (VLC, MX, YouTube) puts it
 * on the edge the finger started on.
 *
 * The side comes from the DRAG (`sideForX`, carried in the store), not from the
 * knob: the halves are swappable in settings, so deriving "volume = right" in the
 * view would draw the bar on the wrong edge for anyone who swapped them. And it
 * DRAWS ON THE OPPOSITE EDGE (`hudSideFor`, the one refinement that makes the
 * placement usable) — the finger is ON the half it started on, so the readout
 * goes on the one strip of screen nobody is touching.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * IT DRAWS ON THE UI THREAD AND DOES NOT RE-RENDER FOR A NUMBER. 16 Nov, and
 * this is the whole reason the component looks the way it does.
 *
 * The previous version re-rendered React once per visible percent — up to 100
 * renders across a sweep — and every one of those renders re-laid-out a
 * PERCENTAGE-HEIGHT fill, i.e. a Yoga pass plus a native view update, on top of
 * a playing video, under a moving finger. On a low-end phone that burst starves
 * the decoder and the stutter outlives the gesture. So:
 *
 *   - there is NO number in this HUD (a text node is the thing that would force
 *     a render per percent, and the bar already answers "near the top", which is
 *     the question the user actually has);
 *   - the fill is a SHARED VALUE in POINTS, so a drag writes one number to the
 *     UI thread and React is not involved at all;
 *   - React state holds only the ICON and the EDGE, which change at most twice
 *     per gesture (kind, side) — never while the finger is moving.
 *
 * The percentage height is deliberately gone: animating a percentage re-runs
 * layout for every step (the same trap `progress.md` records for width).
 */
export const SideHud = memo(function SideHud() {
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  /** Icon + edge only — see the header. A value never lands here. */
  const [hud, setHud] = useState<{ kind: SideHudKind | null; side: SideHudSide }>({
    kind: null,
    side: 'left',
  });

  /**
   * A fraction of the WINDOW height rather than a constant — landscape on a
   * short phone has ~380pt to work with, and a bar sized for a tall one would
   * touch both edges.
   */
  const trackHeight = Math.round(Math.min(176, Math.max(96, height * 0.3)));

  const track = useSharedValue(trackHeight);
  const fill = useSharedValue(0);
  const shown = useSharedValue(0);
  /** Mirrored from the drag — see the header. */
  const left = hudSideFor(hud.side) === 'left';

  /**
   * Rotation, and the first value ever set: the fill is in POINTS, so a 40%
   * level has to be re-derived against the new track or it would draw at 40% of
   * the OLD length.
   */
  useEffect(() => {
    track.value = trackHeight;
    fill.value = readSideHud().value * trackHeight;
  }, [trackHeight, track, fill]);

  /**
   * THE DRAG PATH. Subscribed imperatively (not through React state) so the only
   * work a value change causes is one shared-value write on the UI thread.
   */
  useEffect(() => {
    let kind = readSideHud().kind;
    let side = readSideHud().side;
    return subscribeSideHud(() => {
      const s = readSideHud();
      fill.value = s.value * track.value;

      // THE DRAG PATH ENDS HERE. A value change touches one shared value and
      // returns: no setState, not even a bailing one, so React does no work at
      // all while a finger moves. Icon and edge below are the only things that
      // can bring it back in, and they change at most twice per gesture.
      if (s.kind === kind && s.side === side) return;

      const kindChanged = s.kind !== kind;
      kind = s.kind;
      side = s.side;
      setHud({ kind, side });
      if (kindChanged) {
        shown.value = withTiming(s.kind ? 1 : 0, {
          duration: s.kind ? SHOW_MS : HIDE_MS,
          easing: Easing.out(Easing.quad),
        });
      }
    });
  }, [fill, shown, track]);

  /**
   * Fade, plus a small slide FROM the edge it belongs to — the bar arrives out of
   * the side it hangs on, which is what makes it read as part of the gesture
   * rather than as an overlay that happened to appear.
   */
  const plateStyle = useAnimatedStyle(() => ({
    opacity: shown.value,
    transform: [{ translateX: (1 - shown.value) * (left ? -10 : 10) }],
  }));

  /** Points, not a percentage: a height animation here must not re-run layout. */
  const fillStyle = useAnimatedStyle(() => ({ height: fill.value }));

  return (
    <View
      style={[
        styles.sideAnchor,
        // Clear of the notch/cutout in landscape, plus a gutter so the bar is not
        // glued to the bezel.
        left ? { left: insets.left + 16 } : { right: insets.right + 16 },
      ]}
      pointerEvents="none"
    >
      <Animated.View style={[styles.sidePlate, plateStyle]}>
        <View style={[styles.sideTrack, { height: trackHeight }]}>
          {/* Filled from the BOTTOM up: 0% is an empty track, 100% a full one.
              A top-down fill would read as a download bar. */}
          <Animated.View style={[styles.sideFill, fillStyle]} />
        </View>
        <AppIcon
          name={hud.kind === 'volume' ? 'volumeOn' : 'brightness'}
          size={16}
          color="#fff"
          strokeWidth={2}
        />
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
  // Deliberately plain: a slim plate, a bar, an icon. No panel, no label, nothing
  // that has to be re-measured while a finger is moving.
  sidePlate: {
    alignItems: 'center',
    gap: 8,
    paddingVertical: 10,
    paddingHorizontal: 6,
    borderRadius: radii.full,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  sideTrack: {
    width: 5,
    borderRadius: 3,
    backgroundColor: 'rgba(255,255,255,0.22)',
    overflow: 'hidden',
    justifyContent: 'flex-end',
  },
  sideFill: { width: 5, borderRadius: 3, backgroundColor: '#fff' },
});
