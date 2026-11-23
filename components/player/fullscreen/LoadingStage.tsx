// THE FIRST-LOAD STAGE.
//
// The player used to answer "nothing to show yet" with a 56pt ring over pure
// black. Two things were wrong with that. An episode being scraped and an
// episode that had died looked identical from the sofa, and a switch to the next
// episode left the PREVIOUS episode's last frame frozen behind the ring, which
// reads as a broken player rather than as a load.
//
// This is the surface that fixes both. It is a cover: the show's own art, very
// dark, which episode is coming, and what is being waited on.
//
// It is NOT the rebuffering overlay. That one is still a bare ring inside
// `CenterTransport` (device verdict, 9 Nov: state words under the ring flicker
// at 1Hz on a thin connection and change nothing the viewer can act on). The
// difference is altitude: this stage is only up when there is NO picture at all,
// it covers the whole frame so the episode being replaced is not visible under
// it, and it names the one thing happening — so it can afford one line of text
// without ever flickering.
//
// AND IT IS THE ONLY LAYER. The screen turns the bars and the transport off
// while this is up (see PlayerScreen's `controlsOff`), so the stage takes the
// CONTROLS' place rather than sitting behind them — otherwise a paused timeline
// at 0:00 and four trigger chips get drawn over it, every one of them wrong about
// an episode that has not loaded yet.
//
// ═══════════════════════════════════════════════════════════════════════════
// A BAR, AND IT SITS ON THE EXACT CENTRE LINE (23 Nov, third pass)
//
// This started as a spinner with the words hanging under it (read low), then as
// a centred column with the spinner nudged up ~22pt (read better, still a stack
// with a moving object in it). Both shared two faults, and the second one is the
// reason this is a bar now:
//
//   1. A DISC CANNOT BE CENTRED. Its optical weight is not its bounding box, so
//      it always needs a nudge plus balancing text — which is exactly the manual
//      arithmetic that kept coming out a few points low.
//   2. THE DISC WAS NOT WHERE THE PLAY BUTTON IS. The transport's ▶ is a 76pt
//      disc on the frame's exact middle. The loading ring sat ~22pt above it, so
//      the moment the first frame landed one spinning object vanished and another
//      appeared a little lower — the "position change of the spinner". A sweep
//      sitting ON the centre line is *inside* the disc that replaces it: the
//      stage fades, the disc is already where the bar was. Nothing travels.
//
// A horizontal rule has no optical centre to correct — its middle is its middle —
// so it can be dead-centre with no nudge at all. And a sweep is the honest glyph
// for this stage: this is a SCRAPE, a fetch over the network, not a rebuffer of
// something already in hand. The spinner is kept for the rebuffer, where it means
// exactly that.
//
// The composition is a symmetric bracket, which is what makes dead-centre read as
// dead-centre: the episode line ABOVE the rule, the phase BELOW it, roughly equal
// mass on both sides. The show name is gone from here on purpose — the cover art
// IS the show, and a third line above the episode was what made the block
// top-heavy in the first place. The episode line is "Episode N · title", so the
// frame still says what is coming.
//
// Everything about it is cheap: one image, one Reanimated loop on the UI thread,
// no blur (a blur here is a per-frame GPU cost on exactly the devices that are
// already slow), and `pointerEvents` off so the back arrow still works underneath.
// The loop unmounts with the stage, so a playing episode never pays for it.

import { memo, useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import Animated, {
  Easing,
  FadeIn,
  FadeOut,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import { formatEpisodeNumber } from '@/lib/player/format';
import { font } from '@/lib/ui/tokens';

/** What is being waited on, in the viewer's terms. */
export type LoadingPhase = 'resolving' | 'recovering' | 'loading';

const PHASE_TEXT: Record<LoadingPhase, string> = {
  resolving: 'Finding a source…',
  recovering: 'Reconnecting…',
  loading: 'Loading…',
};

// The rule's geometry. Kept here rather than in the stylesheet because the sweep
// arithmetic below is expressed in the same numbers.
const TRACK_W = 136;
const TRACK_H = 3;
const FILL = 0.38;

/**
 * The indeterminate sweep.
 *
 * One shared value, linear, repeated: the bright segment slides fully out of the
 * track on the left edge and fully out on the right, so the wrap is invisible and
 * there is no ease curve to make the bar look like it is hesitating. It runs on
 * the UI thread, next to the native player — never on the JS thread that is busy
 * resolving the episode.
 */
const LoadingBar = memo(function LoadingBar() {
  const t = useSharedValue(0);
  useEffect(() => {
    t.value = withRepeat(withTiming(1, { duration: 1300, easing: Easing.linear }), -1, false);
  }, [t]);

  const sweep = useAnimatedStyle(() => ({
    // -fillW (hidden left) → trackW (hidden right): the fill crosses the whole
    // track and exits, which is what makes the restart read as a loop.
    transform: [{ translateX: -TRACK_W * FILL + t.value * TRACK_W * (1 + FILL) }],
  }));

  return (
    <View style={styles.track}>
      <Animated.View style={[styles.fill, sweep]} />
    </View>
  );
});

export const LoadingStage = memo(function LoadingStage({
  art,
  episode,
  episodeTitle,
  phase,
}: {
  /** The show's banner or cover, used very dark behind the rule. */
  art: string | null;
  episode: number;
  episodeTitle?: string | null;
  phase: LoadingPhase;
}) {
  const line = episodeTitle
    ? `Episode ${formatEpisodeNumber(episode)} · ${episodeTitle}`
    : `Episode ${formatEpisodeNumber(episode)}`;

  return (
    <Animated.View
      // Fade IN as the cover appears, fade OUT as the first frame lands: the
      // exit is what turns "the stage vanished and the controls popped" into a
      // crossfade over the frame that is already playing underneath. 200/220
      // rather than a longer ease on purpose — this is the one moment the
      // viewer is waiting for, so it should feel like a reveal, not a transition
      // they have to sit through.
      entering={FadeIn.duration(200)}
      exiting={FadeOut.duration(220)}
      style={styles.stage}
      // The frame under this is still live (the top bar's back arrow), and a
      // stage that ate taps would turn a slow load into a screen with no exit.
      pointerEvents="none"
      // The phase line is the only sentence here and it changes at most twice
      // per load, so it is announced once rather than followed.
      accessibilityLiveRegion="polite"
    >
      {art ? (
        <Image
          source={{ uri: art }}
          style={styles.art}
          contentFit="cover"
          transition={180}
        />
      ) : null}
      <View style={styles.wash} />
      <View style={styles.lockup}>
        <Text style={styles.line} numberOfLines={1}>
          {line}
        </Text>
        <LoadingBar />
        <Text style={styles.phase} numberOfLines={1}>
          {PHASE_TEXT[phase]}
        </Text>
      </View>
    </Animated.View>
  );
});

const styles = StyleSheet.create({
  stage: { ...StyleSheet.absoluteFill },
  art: { ...StyleSheet.absoluteFill, opacity: 0.5 },
  /**
   * Dark enough that a bright banner cannot wash out a white rule, light enough
   * that the art still says which show this is.
   */
  wash: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(6,6,9,0.74)' },
  /**
   * The bracket: episode above the rule, phase below it. NO vertical pad and no
   * nudge — the rule's middle is the frame's middle by construction, and the two
   * lines are placed symmetrically around it. (The 16pt bottom pad and the
   * "half the pad up" arithmetic that the disc versions needed are gone; that
   * correction existed only to fake a centre for a shape that has an optical
   * centre of its own.)
   */
  lockup: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  /** The primary line: which episode is coming. */
  line: {
    // 14 + its 20pt box = 34 above the rule; the phase is 18 + its 16pt box =
    // 34 below it. Equal mass, so the rule's middle IS the frame's middle.
    marginBottom: 14,
    maxWidth: '100%',
    color: 'rgba(255,255,255,0.94)',
    fontFamily: font.semibold,
    fontSize: 15,
    lineHeight: 20,
    textAlign: 'center',
  },
  track: {
    width: TRACK_W,
    height: TRACK_H,
    borderRadius: TRACK_H / 2,
    backgroundColor: 'rgba(255,255,255,0.16)',
    overflow: 'hidden',
  },
  fill: {
    width: TRACK_W * FILL,
    height: TRACK_H,
    borderRadius: TRACK_H / 2,
    backgroundColor: 'rgba(255,255,255,0.92)',
  },
  /** The whisper: what is being waited on. */
  phase: {
    marginTop: 18,
    maxWidth: '100%',
    color: 'rgba(255,255,255,0.42)',
    fontFamily: font.medium,
    fontSize: 11.5,
    lineHeight: 16,
    letterSpacing: 0.4,
    textAlign: 'center',
  },
});
