// The control chrome: top bar, centre transport, bottom bar.
//
// Three separate components rather than one `PlayerControls`, because they have
// genuinely different lifetimes:
//
//   - The centre transport is HIDDEN while buffering. A play button sitting on
//     top of a spinner is an invitation to press it, and pressing it during a
//     rebuffer does nothing the user can see happen.
//   - The bottom bar's menu triggers and the top bar's lock/episodes are about
//     DIFFERENT moments (choosing a value vs. leaving the player) and are
//     reached by different hands on the device.
//
// A single component with `visible` props for all three is what the old vertical
// player had, and it is why that file grew to 89KB — every state that only
// mattered to one bar ended up threaded through one props object.
//
// SLIDE, NOT JUST FADE. Both bars translate off their own edge as well as
// fading. A pure cross-fade leaves the controls sitting on the video with
// nothing anchoring them, so a bright frame renders the title and the timeline
// straight through the art; moving them off the edge reads as dismissal.

import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { VideoPlayer } from 'expo-video';
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
  // Strict TypeScript API (RN 0.88): element refs are instance types.
  type ViewInstance,
} from 'react-native';
import type { EdgeInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, {
  Easing,
  FadeIn,
  FadeOut,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';

import { Trigger } from './Menu';
import { ProgressBar, type SkipWindow } from './ProgressBar';
import { AppIcon } from '@/components/ui/AppIcon';
import { formatEpisodeNumber } from '@/lib/player/format';
import { font } from '@/lib/ui/tokens';
import { useSetting } from '@/lib/settings/useSetting';

const TOP_BAR_H = 52;
/**
 * Scrim headroom above the top row, so the gradient has room to fade out
 * instead of ending on a hard edge at the button row.
 */
const TOP_BAR_SCRIM = 28;
/**
 * Total top chrome, EXCLUDING `insets.top`. Exported because the speed pill is
 * centred in the space between the two bars and has to start below the title.
 */
export const TOP_BAR_TOTAL = TOP_BAR_H + TOP_BAR_SCRIM;
/**
 * Height of the bottom bar, EXCLUDING the safe-area inset.
 *
 * THIS IS A FALLBACK, NOT THE TRUTH. The bar's real height is MEASURED at
 * runtime (`onLayout` -> `BottomBar.onMeasure`) and `PlayerScreen` feeds the
 * measurement to the subtitles, the toast and the popover. Measuring is the only
 * arrangement that cannot drift: a hardcoded total has to be re-derived by hand
 * every time a row is added, a font grows a line, or a safe area changes, and
 * every miss shows up as subtitles sitting behind the timeline.
 *
 * The number is kept, and kept honest, for the one frame before the first
 * measurement lands and for the frames where the chrome is hidden and therefore
 * not measured. Derived, not guessed:
 *
 *     22  scrim headroom (bottomInner's paddingTop)
 *   + 34  skip slot        — a FIXED height, so the timeline below it does not
 *                            move when a "Skip opening" button appears
 *   + 45  progress bar     — 28 hit area + 2 gap + 15 clock line
 *   + 44  button row       — 6 gap + 38 button
 *   + 12  bottom padding
 *   ----
 *   157
 *
 * Note that the old comment here claimed 34 + 28 + 6 + 38 + padding = 156, which
 * silently omitted the 15pt clock row and rounded the rest. The bar was 156pt
 * tall while its content measured 135pt, so ~21pt of dead gradient sat above
 * the timeline and the subtitles were offset 21pt too high.
 */
export const BOTTOM_BAR_H = 157;

/**
 * CHROME TRANSITION — a cross-fade, deliberately NOT a slide.
 *
 * `SlideInUp`/`SlideInDown` are wrong for this screen in a way that is obvious
 * once measured: Reanimated's slide distance is a fraction of the WINDOW, not of
 * the element. On a landscape phone the window is ~420pt tall, so a "slide in"
 * travels ~125pt — twice the height of the 52pt top bar and most of the 156pt
 * bottom one. The bars shoot across the frame, cross each other's path, and the
 * timeline appears to come in from the top. It reads as a glitch, not depth.
 *
 * A fade is also the correct READ here: both bars are backed by a gradient
 * scrim, so appearing is already "the darkening of the frame", and animating
 * position on top of that adds nothing but motion to read through.
 *
 * Timings: in slightly slower than out. Controls should feel instant to appear
 * (the user just asked for them) and unhurried to leave (nothing is being
 * gained by yanking them).
 */
const CHROME_IN = FadeIn.duration(180);
const CHROME_OUT = FadeOut.duration(140);

/**
 * Why the centre shows a bare ring.
 *
 * It used to name its cause under the ring — Buffering… / Connection is slow /
 * Reconnecting to another source… — on the theory that an explained wait is
 * tolerable. The theory was sound; the words were the wrong altitude (device
 * verdict, 9 Nov): slow internet hops the states at 1Hz so the text flickered,
 * none of the three changed what the viewer should do (wait), and the ACTUAL
 * explanations live one level deeper — the automatic tier drop, the failover,
 * and the error card that prints the engine's own message when the episode is
 * genuinely dead. YouTube/Netflix/ExoPlayer answer buffering with a spinner
 * and nothing else; so does this player now.
 */

// ---------------------------------------------------------------------------
// Top bar
// ---------------------------------------------------------------------------

export const TopBar = memo(function TopBar({
  title,
  episode,
  episodeLabel,
  onBack,
  onEpisodes,
  onLock,
  onSettings,
  settingsActive,
  onPip,
  pipAvailable,
  locked,
  visible,
  insets,
}: {
  title: string;
  episode: number;
  /** Provider's title for this episode, when it has one. */
  episodeLabel?: string | null;
  onBack: () => void;
  onEpisodes: () => void;
  onLock: () => void;
  /** Opens the settings panel at the root view. The gear lives HERE, top
   *  right — the bottom bar is playback controls only (quality/speed/source/
   *  subs); a settings affordance reads as chrome, not as a playback chip. */
  onSettings: () => void;
  /** True while the settings panel is open — highlights the gear. */
  settingsActive?: boolean;
  onPip: () => void;
  pipAvailable: boolean;
  locked: boolean;
  visible: boolean;
  /** Landscape puts the notch on a SIDE — see `PlayerScreen`'s `insets`. */
  insets: EdgeInsets;
}) {
  if (!visible) return null;
  const subtitle = episodeLabel
    ? `Episode ${formatEpisodeNumber(episode)} · ${episodeLabel}`
    : `Episode ${formatEpisodeNumber(episode)}`;

  return (
    <Animated.View
      entering={CHROME_IN}
      exiting={CHROME_OUT}
      style={[
        styles.topWrap,
        {
          // The gradient's height grows with the inset, so the scrim still
          // covers the status bar rather than starting below it.
          height: TOP_BAR_TOTAL + insets.top,
          // `left`/`right` clear the notch; `top` clears the status bar. In
          // landscape `insets.top` is usually 0 and a side inset is not, so
          // applying all four (rather than just top) is the whole point.
          paddingLeft: insets.left,
          paddingRight: insets.right,
          paddingTop: insets.top,
        },
      ]}
      pointerEvents="box-none"
    >
      <LinearGradient
        colors={['rgba(0,0,0,0.85)', 'rgba(0,0,0,0.35)', 'rgba(0,0,0,0)']}
        locations={[0, 0.6, 1]}
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      />
      <View style={styles.topRow}>
        <IconButton icon="back" onPress={onBack} label="Back" />

        <View style={styles.titles}>
          <Text style={styles.title} numberOfLines={1}>
            {title}
          </Text>
          <Text style={styles.subtitle} numberOfLines={1}>
            {subtitle}
          </Text>
        </View>

        {pipAvailable ? (
          <IconButton icon="pip" onPress={onPip} label="Picture in picture" />
        ) : null}
        <IconButton icon="episodes" onPress={onEpisodes} label="Episodes" />
        <IconButton
          icon={locked ? 'lock' : 'unlock'}
          onPress={onLock}
          label={locked ? 'Unlock controls' : 'Lock controls'}
        />
        {/* Rightmost — the corner seat. Icon-only: every top-bar affordance
            speaks through its glyph; a text label here would be the odd one
            out in a row of five icons. */}
        <IconButton
          icon="settings"
          onPress={onSettings}
          label="Player settings"
          active={settingsActive}
        />
      </View>
    </Animated.View>
  );
});

// ---------------------------------------------------------------------------
// Centre transport
// ---------------------------------------------------------------------------

export const CenterTransport = memo(function CenterTransport({
  visible,
  playing,
  buffering,
  hasPrev,
  hasNext,
  onPlayPause,
  onPrev,
  onNext,
}: {
  visible: boolean;
  playing: boolean;
  buffering: boolean;
  hasPrev: boolean;
  hasNext: boolean;
  onPlayPause: () => void;
  onPrev: () => void;
  onNext: () => void;
}) {
  // Buffering replaces the transport rather than sitting under it. See the
  // header: the button is useless mid-rebuffer and its presence suggests it is
  // not. The ring has no caption and no buffer readout — see the words
  // decision above the component.
  if (buffering) {
    return (
      <Animated.View entering={CHROME_IN} exiting={CHROME_OUT} style={styles.centerBox} pointerEvents="box-none">
        {/* Tappable: pausing a buffering video stops the fetch and clears the
            ring, exactly like YouTube/ExoPlayer where the center affordance is
            the control even while loading. Only the ring itself is the target —
            taps elsewhere still fall through to the gesture surface. */}
        <Pressable
          onPress={onPlayPause}
          accessibilityRole="button"
          accessibilityLabel={playing ? 'Pause' : 'Play'}
          hitSlop={16}
          style={styles.ringPressable}
        >
          <ActivityRing />
        </Pressable>
      </Animated.View>
    );
  }
  if (!visible) return null;

  return (
    <View style={styles.centerBox} pointerEvents="box-none">
      <Animated.View entering={CHROME_IN} exiting={CHROME_OUT} style={styles.centerRow}>
        <TransportButton
          icon="skipBack"
          onPress={onPrev}
          enabled={hasPrev}
          label="Previous episode"
          size={34}
        />
        <Pressable
          onPress={onPlayPause}
          accessibilityRole="button"
          accessibilityLabel={playing ? 'Pause' : 'Play'}
          hitSlop={14}
          style={({ pressed }) => [styles.playButton, pressed ? styles.playPressed : null]}
        >
          <AppIcon name={playing ? 'pause' : 'play'} size={40} color="#fff" strokeWidth={2} />
        </Pressable>
        <TransportButton
          icon="skipForward"
          onPress={onNext}
          enabled={hasNext}
          label="Next episode"
          size={34}
        />
      </Animated.View>
    </View>
  );
});

const TransportButton = memo(function TransportButton({
  icon,
  onPress,
  enabled,
  label,
  size,
}: {
  icon: 'skipBack' | 'skipForward';
  onPress: () => void;
  enabled: boolean;
  label: string;
  size: number;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={!enabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !enabled }}
      hitSlop={12}
      style={({ pressed }) => [
        styles.transportButton,
        pressed && enabled ? styles.transportPressed : null,
      ]}
    >
      {/* Greyed rather than hidden when disabled. A gap in the transport row
          shifts the play button off-centre, and a play button that moves is a
          play button that gets mis-tapped. */}
      <AppIcon
        name={icon}
        size={size}
        color={enabled ? '#fff' : 'rgba(255,255,255,0.3)'}
        strokeWidth={2}
      />
    </Pressable>
  );
});

/** Buffering ring. Reanimated's spin, so it never competes with the JS thread —
 *  a spinner animated with `Animated` would run on exactly the thread that is
 *  busy decoding the frame it is sitting on top of. */
const ActivityRing = memo(function ActivityRing() {
  const rot = useSharedValue(0);
  useEffect(() => {
    rot.value = withRepeat(withTiming(1, { duration: 900, easing: Easing.linear }), -1, false);
  }, [rot]);
  const spin = useAnimatedStyle(() => ({
    transform: [{ rotate: `${rot.value * 360}deg` }],
  }));

  return (
    <Animated.View style={[styles.ring, spin]}>
      <AppIcon name="spinner" size={38} color="#fff" strokeWidth={2.5} />
    </Animated.View>
  );
});

// ---------------------------------------------------------------------------
// Bottom bar
// ---------------------------------------------------------------------------

export type MenuId = 'speed' | 'quality' | 'source' | 'subs' | 'root' | 'subsSettings' | null;

/**
 * The bottom-bar trigger columns — the four chips a user can hide. The
 * settings gear is NOT one: it lives in the top bar's right corner (chrome,
 * not a playback chip) and is not hideable.
 */
export type TriggerSlotId = 'speed' | 'quality' | 'source' | 'subs';

/** Where a trigger column sits, in window coordinates. */
export type TriggerSlots = Record<TriggerSlotId, { x: number; width: number }>;

const EMPTY_SLOTS: TriggerSlots = {
  speed: { x: 0, width: 0 },
  quality: { x: 0, width: 0 },
  source: { x: 0, width: 0 },
  subs: { x: 0, width: 0 },
};

/**
 * One trigger's column, and the thing that knows where it is.
 *
 * It reports its own rectangle so the menu can open centred on the button that
 * opened it. `measureInWindow` rather than `onLayout`'s coordinates, because
 * `onLayout` is relative to its parent and this column sits three levels down —
 * turning that into a window position by adding parent offsets means restating
 * three paddings here, which is exactly the kind of duplicated number that goes
 * stale when a row is resized.
 *
 * Measured once per layout, not per press. The press would be correct but would
 * arrive asynchronously, so the card would open at one position and snap to
 * another a frame later — the single most obviously broken thing a popover can
 * do. By the time anyone can tap a trigger this has already settled.
 *
 * Unmeasured columns report zeroes, and the card centres itself instead of
 * aiming at nothing.
 */
const TriggerSlot = memo(function TriggerSlot({
  id,
  onReport,
  children,
}: {
  id: TriggerSlotId;
  onReport: (id: TriggerSlotId, rect: { x: number; width: number }) => void;
  children: ReactNode;
}) {
  const ref = useRef<ViewInstance>(null);

  const onLayout = useCallback(
    (e: LayoutChangeEvent) => {
      const { width } = e.nativeEvent.layout;
      if (width <= 0) return;
      // Re-measure on every layout pass, but only report a change. The slots
      // move when the window rotates or the insets settle, and never otherwise.
      ref.current?.measureInWindow((x, _y, w, h) => {
        if (w <= 0 || h <= 0) return;
        onReport(id, { x, width: w });
      });
    },
    [id, onReport]
  );

  return (
    <View ref={ref} style={styles.triggerSlot} onLayout={onLayout}>
      {children}
    </View>
  );
});

export const BottomBar = memo(function BottomBar({
  player,
  visible,
  skip,
  onSeek,
  activeMenu,
  speedLabel,
  qualityLabel,
  sourceLabel,
  subsLabel,
  hasSubs,
  onMenu,
  onMute,
  muted,
  insets,
  onMeasure,
  onSlots,
  initialTrackWidth,
  onTrackWidth,
  position,
  positionKnown,
  onScrubActive,
}: {
  player: VideoPlayer;
  visible: boolean;
  skip: SkipWindow;
  /**
   * Commit a scrub. `null` means the bar could not tell where the viewer
   * pointed — an unlaid-out bar, or a live stream with no duration — and the
   * caller must do nothing rather than seek to 0. See `scrubTarget`.
   */
  onSeek: (t: number | null) => void;
  activeMenu: MenuId;
  speedLabel: string;
  qualityLabel: string;
  sourceLabel: string;
  subsLabel: string;
  hasSubs: boolean;
  onMenu: (id: MenuId) => void;
  onMute: () => void;
  muted: boolean;
  /** Bottom inset — the home indicator / gesture bar the row must clear. */
  insets: Pick<EdgeInsets, 'bottom' | 'left' | 'right'>;
  /** Reports this bar's real height, including the inset. See `BOTTOM_BAR_H`. */
  onMeasure?: (height: number) => void;
  /** Reports where each trigger sits, so a menu can open above its own button. */
  onSlots?: (slots: TriggerSlots) => void;
  /** Seed for the track width, so a remount does not flash the knob at 0. */
  initialTrackWidth?: number;
  /** Reports the measured track width, so the next mount can seed from it. */
  onTrackWidth?: (width: number) => void;
  /**
   * The playhead, on the UI thread.
   *
   * A shared value rather than a number, and that is the fix for
   * `progress.md` §Performance #6. It used to be `setTimeline` at 2 Hz, which
   * re-rendered this whole bar — gradient, skip slot, play button and all four
   * trigger chips — twice a second for a 3px bar and two clock digits. Only the
   * clock actually needs React now, and it lives in its own component inside
   * `ProgressBar`. See that file's header for why the animated styles have to be
   * in points rather than percentages.
   */
  position: SharedValue<number>;
  /**
   * Whether `position` means anything yet.
   *
   * False between "the pipeline is ready" and "the stored resume position has
   * been applied". Forwarded rather than derived here, because the screen is the
   * only thing that knows whether the resume has been resolved.
   */
  positionKnown: boolean;
  /**
   * A scrub drag started or ended, so the screen can keep the bar mounted for
   * the duration. See `ProgressBar`'s `onScrubActive`.
   */
  onScrubActive?: (active: boolean) => void;
}) {
  /**
   * Only the parts of the timeline that change slowly are React state now.
   *
   * `duration` settles within a second of playback starting and `buffered` moves
   * in half-minute steps, so both guard-and-compare correctly. The playhead is
   * the third element of the old `timeline` object and it is deliberately NOT
   * here.
   */
  // Lazy init from the player's current state, so a remount (controls toggled)
  // does not flash `0:00 / 0:00` for a frame before the timeUpdate listener's
  // first `update()` lands. The listener still re-syncs on mount.
  const [timeline, setTimeline] = useState(() => ({
    duration: player.duration || 0,
    buffered: player.bufferedPosition || 0,
  }));
  const [slots, setSlots] = useState<TriggerSlots>(EMPTY_SLOTS);

  // WHICH CHIPS EXIST is a user choice now (`player.hiddenControls`): a viewer
  // who never dubs can hide the source chip, one who never touches speed can
  // hide that. This is DELIBERATE unmounting by the owner of the screen — a
  // different thing from the forbidden `hasSubs ? <Trigger/>` shape below,
  // which reflowed the row as a side effect of stream state. A hidden chip
  // reflows the row once, when its owner changes the setting, and never again
  // while watching.
  const hiddenRaw = useSetting('player.hiddenControls');
  const hidden = useMemo(() => {
    try {
      const parsed: unknown = JSON.parse(hiddenRaw);
      return new Set(
        Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
      );
    } catch {
      return new Set<string>();
    }
  }, [hiddenRaw]);

  // Merged one slot at a time — each column measures itself independently, so
  // they report separately and the merge has to tolerate any subset arriving in
  // any order. Comparing before writing matters: `onLayout` fires on more
  // occasions than one would think (font load, rotation, inset settle), and an
  // unguarded set here re-renders the whole player every time.
  const reportSlot = useCallback((id: TriggerSlotId, rect: { x: number; width: number }) => {
    setSlots((prev) =>
      Math.abs(prev[id].x - rect.x) < 0.5 && Math.abs(prev[id].width - rect.width) < 0.5
        ? prev
        : { ...prev, [id]: rect }
    );
  }, []);

  useEffect(() => {
    onSlots?.(slots);
  }, [slots, onSlots]);

  useEffect(() => {
    const update = (event: { currentTime: number; bufferedPosition: number }) => {
      // The playhead goes to the shared value, unconditionally and without a
      // compare. Nothing in this component's render reads it, so a compare would
      // only be there to protect a re-render that no longer happens — and a
      // dropped write would show up as the playhead stuttering, which is the
      // exact symptom this change was made to remove.
      position.value = event.currentTime;
      const buffered = event.bufferedPosition > 0 ? event.bufferedPosition : 0;
      const duration = player.duration || 0;
      setTimeline((previous) =>
        previous.duration === duration && previous.buffered === buffered ? previous : { duration, buffered }
      );
    };
    const subscription = player.addListener('timeUpdate', update);
    update({ currentTime: player.currentTime, bufferedPosition: player.bufferedPosition });
    return () => subscription.remove();
  }, [player, position]);

  if (!visible) return null;

  return (
    <Animated.View
      entering={CHROME_IN}
      exiting={CHROME_OUT}
      onLayout={(e) => {
        const h = e.nativeEvent.layout.height;
        // The gradient reaches the home indicator because the INSET is padding on
        // this box, not a separate offset — so there is no height to hardcode and
        // nothing to re-derive when the inset changes.
        if (h > 0) onMeasure?.(h);
      }}
      style={[
        styles.bottomWrap,
        {
          paddingLeft: insets.left,
          paddingRight: insets.right,
          paddingBottom: insets.bottom,
        },
      ]}
      pointerEvents="box-none"
    >
      <LinearGradient
        colors={['rgba(0,0,0,0)', 'rgba(0,0,0,0.45)', 'rgba(0,0,0,0.92)']}
        locations={[0, 0.45, 1]}
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      />

      {/* The skip affordance moved OUT of the bar to screen level
          (`PlayerScreen`'s floating button): a marker's button must survive the
          chrome hiding, and a control's position is a property of the screen,
          not of player state. The bar renders no slot for it any more. */}

      <View style={styles.bottomInner}>
        <ProgressBar
          position={position}
          duration={timeline.duration}
          buffered={timeline.buffered}
          skip={skip}
          positionKnown={positionKnown}
          onSeek={onSeek}
          onScrubActive={onScrubActive}
          initialTrackWidth={initialTrackWidth}
          onTrackWidth={onTrackWidth}
        />

        <View style={styles.buttonRow}>
          <View style={styles.triggers}>
            {/* FOUR SLOTS, ALWAYS — the playback chips only (speed, quality,
                source, subs; each hideable by its owner). The settings gear
                lives in the TOP BAR's right corner: the bottom row is
                playback state, a gear is chrome, and the two do not share a
                row. This is the single most important line for how the bar
                FEELS, so it is worth being blunt about why.

                Every trigger below is a chip whose width is decided by its own
                label. That makes the row's contents a function of the player's
                state at that instant, and a row of auto-width siblings in a
                `flex: 1` container reflows every time any of them changes. The
                states that used to do exactly that, all without the viewer
                touching anything:

                  - a source resolves -> the subtitle chip is ADDED (it was
                    conditional on `hasSubs`), shoving everything after it
                  - sources arrive -> the source chip's label changes from
                    "Source" to "1/3", so it gets NARROWER
                  - a long-press boost -> the speed chip's label goes from "1x"
                    to "2.5x", so it gets WIDER
                  - failover -> "1/3" becomes "2/3"

                Each of those slid the neighbouring controls sideways under the
                viewer's thumb. Giving each trigger a `flex: 1` column that
                does not care how wide its chip is makes the row's geometry a
                property of the SCREEN, not of the state — four equal quarters,
                every frame, whatever is playing. A label that will not fit
                ellipsizes inside its own column instead of rearranging the bar.

                A source with no subtitles still gets its chip, greyed. That is
                a deliberate cost: an empty slot that is briefly filled is a
                visible jump, a permanently reserved slot is not. */}
            <TriggerSlot id="speed" onReport={reportSlot}>
              {!hidden.has('speed') ? (
                <Trigger
                  icon="speed"
                  label={speedLabel}
                  active={activeMenu === 'speed'}
                  onPress={() => onMenu(activeMenu === 'speed' ? null : 'speed')}
                />
              ) : null}
            </TriggerSlot>
            <TriggerSlot id="quality" onReport={reportSlot}>
              {!hidden.has('quality') ? (
                <Trigger
                  icon="quality"
                  label={qualityLabel}
                  active={activeMenu === 'quality'}
                  onPress={() => onMenu(activeMenu === 'quality' ? null : 'quality')}
                />
              ) : null}
            </TriggerSlot>
            <TriggerSlot id="source" onReport={reportSlot}>
              {!hidden.has('source') ? (
                <Trigger
                  icon="layers"
                  label={sourceLabel}
                  active={activeMenu === 'source'}
                  onPress={() => onMenu(activeMenu === 'source' ? null : 'source')}
                />
              ) : null}
            </TriggerSlot>
            <TriggerSlot id="subs" onReport={reportSlot}>
              {!hidden.has('subs') ? (
                <Trigger
                  icon={hasSubs && subsLabel !== 'Off' ? 'subtitles' : 'subtitlesOff'}
                  label={hasSubs ? subsLabel : 'Off'}
                  disabled={!hasSubs}
                  active={activeMenu === 'subs' || (hasSubs && subsLabel !== 'Off')}
                  onPress={() => onMenu(activeMenu === 'subs' ? null : 'subs')}
                />
              ) : null}
            </TriggerSlot>
          </View>

          <Pressable
            onPress={onMute}
            accessibilityRole="button"
            accessibilityLabel={muted ? 'Unmute' : 'Mute'}
            hitSlop={10}
            style={({ pressed }) => [styles.roundButton, pressed ? styles.playPressed : null]}
          >
            <AppIcon
              name={muted ? 'volumeOff' : 'volumeOn'}
              size={20}
              color="#fff"
              strokeWidth={2}
            />
          </Pressable>
        </View>
      </View>
    </Animated.View>
  );
});

/**
 * Shared chrome pieces.
 */

const IconButton = memo(function IconButton({
  icon,
  onPress,
  label,
  active = false,
}: {
  icon: 'back' | 'episodes' | 'lock' | 'unlock' | 'pip' | 'settings';
  onPress: () => void;
  label: string;
  /** Paints the pressed-in pill (e.g. the gear while its panel is open). */
  active?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: active }}
      hitSlop={10}
      style={({ pressed }) => [
        styles.iconButton,
        active ? styles.iconButtonActive : null,
        pressed ? styles.playPressed : null,
      ]}
    >
      <AppIcon name={icon} size={22} color="#fff" strokeWidth={2} />
    </Pressable>
  );
});

const styles = StyleSheet.create({
  topWrap: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    // Overridden at render time to add `insets.top`; restated here so the static
    // value and the runtime one cannot read as two different heights.
    height: TOP_BAR_TOTAL,
    justifyContent: 'flex-start',
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingTop: 10,
  },
  titles: {
    flex: 1,
    paddingHorizontal: 6,
  },
  title: {
    color: '#fff',
    fontFamily: font.bold,
    fontSize: 15,
    lineHeight: 19,
    letterSpacing: 0.2,
  },
  subtitle: {
    color: 'rgba(255,255,255,0.7)',
    fontFamily: font.medium,
    fontSize: 12,
    lineHeight: 15,
  },

  centerBox: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ringPressable: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  centerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 34,
  },
  playButton: {
    width: 76,
    height: 76,
    borderRadius: 38,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  
  playPressed: {
    opacity: 0.6,
  },
  transportButton: {
    width: 52,
    height: 52,
    alignItems: 'center',
    justifyContent: 'center',
  },
  transportPressed: {
    opacity: 0.6,
  },
  ring: {
    width: 56,
    height: 56,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 28,
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  bottomWrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    // NO FIXED HEIGHT. The box is bottom-anchored and sizes to its content, with
    // the safe-area inset applied as padding so the gradient reaches the home
    // indicator without a height that has to know how tall that is. A fixed
    // height plus `justifyContent: 'flex-end'` is the arrangement that let the
    // box end up 21pt taller than its contents — dead scrim above the timeline,
    // and a subtitle offset derived from the wrong number.
    //
    // `paddingTop` is scrim headroom, ABOVE everything, so the gradient fades
    // in over the video rather than starting on a hard edge at the timeline.
    paddingTop: 22,
  },
  bottomInner: {
    paddingHorizontal: 14,
    paddingBottom: 12,
  },
  buttonRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginTop: 6,
  },
  roundButton: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.12)',
  },
  triggers: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    // Without this the four children can push past the row on a narrow landscape
    // phone and ride over the mute button instead of being contained by it.
    minWidth: 0,
  },
  triggerSlot: {
    // The load-bearing style. Equal quarters of whatever the row has, whatever
    // the labels say. See the comment above the first `Trigger`.
    flex: 1,
    minWidth: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconButton: {
    width: 38,
    height: 38,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 19,
  },
  iconButtonActive: {
    backgroundColor: 'rgba(255,255,255,0.22)',
  },
});
