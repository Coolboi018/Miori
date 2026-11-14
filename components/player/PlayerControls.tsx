import { memo, useRef, useState } from 'react';
import { font } from '@/lib/ui/tokens';
import { AppIcon } from '@/components/ui/AppIcon';
import { Pressable, StyleSheet, Text, View } from 'react-native';

// Player controls, layered over the video:
//   top    — back chevron + small status chips (source, quality)
//   middle — transport row: ⟨prev ep · play/pause · next ep⟩
//   bottom — time / slim seekbar / duration
//
// Everything is Expo-Go-safe: no native deps, scrubbing via touch responders.
//
// ⚠️ THERE IS NO ±10s BUTTON HERE, AND THAT IS DELIBERATE. Seeking by a fixed
// step is a GESTURE on the video, not a control on it — on YouTube it is a
// double-tap on the left or right half, and the only thing it ever puts on
// screen is a transient ripple that fades out. A permanent pair of buttons
// spends two slots in a row that is already five taps wide, advertises a
// gesture the user already knows, and — worst of all — they sit inside
// `PlayerControls`, which auto-hides after 3s. A seek control that vanishes
// with the chrome is useless. The gesture lives in `app/watch/[id]/[ep].tsx`
// against the video surface itself; see `TapZone` there.

export function fmtTime(s: number): string {
  const t = Math.max(0, Math.floor(s || 0));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = t % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return `${h > 0 ? h + ':' : ''}${mm}:${String(sec).padStart(2, '0')}`;
}

const Timeline = memo(function Timeline({
  position,
  duration,
  onSeek,
}: {
  position: number;
  duration: number;
  onSeek: (t: number) => void;
}) {
  const [scrub, setScrub] = useState<number | null>(null);
  const width = useRef(0);

  const shown = scrub ?? position;
  const frac = duration > 0 ? Math.min(1, Math.max(0, shown / duration)) : 0;

  function seekAt(x: number) {
    if (width.current > 0 && duration > 0) {
      const f = Math.min(1, Math.max(0, x / width.current));
      setScrub(f * duration);
    }
  }

  return (
    <View
      style={styles.track}
      onLayout={(e) => {
        width.current = e.nativeEvent.layout.width;
      }}
      onStartShouldSetResponder={() => true}
      onResponderGrant={(e) => seekAt(e.nativeEvent.locationX)}
      onResponderMove={(e) => seekAt(e.nativeEvent.locationX)}
      onResponderRelease={() => {
        if (scrub != null && duration > 0) onSeek(scrub);
        setScrub(null);
      }}
      onResponderTerminate={() => setScrub(null)}
    >
      <View style={styles.rail} />
      <View style={[styles.fill, { flex: frac }]} />
      <View style={[styles.empty, { flex: 1 - frac }]} />
      <View style={[styles.knob, { left: `${frac * 100}%` }]} />
    </View>
  );
});

/** Small translucent chip used in the top bar. */
export function PlayerChip({ text }: { text: string }) {
  return (
    <View style={styles.chip}>
      <Text style={styles.chipText} numberOfLines={1}>
        {text}
      </Text>
    </View>
  );
}

export function PlayerControls({
  visible,
  playing,
  position,
  duration,
  title,
  episodeLabel,
  sourceLabel,
  qualityLabel,
  speedLabel,
  hasSubs,
  hasMultipleSources,
  onBack,
  onPlayPause,
  onSeek,
  onPrevEpisode,
  onNextEpisode,
  canPrev,
  canNext,
  onOpenSheet,
}: {
  visible: boolean;
  playing: boolean;
  position: number;
  duration: number;
  /** Show title, top-left under the back chevron. */
  title?: string;
  /** "EP 3" style label beside the title. */
  episodeLabel?: string;
  /** "src 1/2" style label. Omit when there is only one source. */
  sourceLabel?: string;
  /** "1080p" or "Auto · 1080p" style label. */
  qualityLabel?: string;
  /** "1×" / "1.5×" — the speed button's label. */
  speedLabel?: string;
  /** Whether any subtitle track exists (shows the subs button). */
  hasSubs?: boolean;
  /** Whether more than one source exists (shows the source button). */
  hasMultipleSources?: boolean;
  onBack?: () => void;
  onPlayPause: () => void;
  onSeek: (t: number) => void;
  onPrevEpisode?: () => void;
  onNextEpisode?: () => void;
  /**
   * Whether that episode exists. Drives the DISABLED state of the hop buttons,
   * which is why it is separate from the handlers: a caller with no handler
   * simply omits it and the button never renders.
   */
  canPrev?: boolean;
  canNext?: boolean;
  /** Opens the settings sheet on a tab. */
  onOpenSheet?: (tab: 'quality' | 'speed' | 'source' | 'subs') => void;
}) {
  if (!visible) return null;
  return (
    <View style={styles.box} pointerEvents="box-none">
      {/* Top bar — back on the left, picker buttons on the right */}
      <View style={styles.top}>
        {onBack ? (
          <Pressable onPress={onBack} hitSlop={8} style={styles.iconBtn} accessibilityLabel="Back">
            <AppIcon name="back" size={22} color="#fff" strokeWidth={2.5} />
          </Pressable>
        ) : (
          <View style={styles.iconBtn} />
        )}
        <View style={styles.chips}>
          {episodeLabel ? <PlayerChip text={episodeLabel} /> : null}
          {sourceLabel ? <PlayerChip text={sourceLabel} /> : null}
          {qualityLabel ? <PlayerChip text={qualityLabel} /> : null}
        </View>
        <View style={styles.topActions}>
          {onOpenSheet ? (
            <>
              <Pressable
                onPress={() => onOpenSheet('speed')}
                hitSlop={6}
                style={styles.iconBtn}
                accessibilityLabel="Playback speed"
              >
                <Text style={styles.speedText}>{speedLabel ?? '1×'}</Text>
              </Pressable>
              {hasSubs ? (
                <Pressable
                  onPress={() => onOpenSheet('subs')}
                  hitSlop={6}
                  style={styles.iconBtn}
                  accessibilityLabel="Subtitles"
                >
                  <AppIcon name="subtitles" size={19} color="#fff" />
                </Pressable>
              ) : null}
              {hasMultipleSources ? (
                <Pressable
                  onPress={() => onOpenSheet('source')}
                  hitSlop={6}
                  style={styles.iconBtn}
                  accessibilityLabel="Switch source"
                >
                  <AppIcon name="layers" size={19} color="#fff" />
                </Pressable>
              ) : null}
              <Pressable
                onPress={() => onOpenSheet('quality')}
                hitSlop={6}
                style={styles.iconBtn}
                accessibilityLabel="Quality"
              >
                <AppIcon name="quality" size={19} color="#fff" />
              </Pressable>
            </>
          ) : null}
        </View>
      </View>

      {/* Title under the top bar */}
      {title ? (
        <Text style={styles.title} numberOfLines={2}>
          {title}
        </Text>
      ) : null}

      {/* Transport row — episode hops flanking play/pause.

          A disabled hop button is dimmed rather than removed: the row's width
          must not change between episodes, or the play button slides sideways
          on every episode change and the whole bar looks broken. `opacity` is
          the honest signal for "there is no episode this way" — there is
          nothing to press, and the glyph is still there to explain why.

          The ±10s seeks are NOT here. See the note at the top of this file. */}
      <View style={styles.transport}>
        {onPrevEpisode ? (
          <Pressable
            onPress={onPrevEpisode}
            disabled={canPrev === false}
            style={[styles.sideBtn, canPrev === false && styles.sideBtnOff]}
            accessibilityRole="button"
            accessibilityLabel="Previous episode"
            accessibilityState={{ disabled: canPrev === false }}
          >
            <AppIcon name="skipBack" size={22} color="#fff" fill="#fff" strokeWidth={2} />
          </Pressable>
        ) : null}
        <Pressable
          style={styles.bigBtn}
          onPress={onPlayPause}
          accessibilityRole="button"
          accessibilityLabel={playing ? 'Pause' : 'Play'}
        >
          <AppIcon name={playing ? 'pause' : 'play'} size={28} color="#fff" fill="#fff" />
        </Pressable>
        {onNextEpisode ? (
          <Pressable
            onPress={onNextEpisode}
            disabled={canNext === false}
            style={[styles.sideBtn, canNext === false && styles.sideBtnOff]}
            accessibilityRole="button"
            accessibilityLabel="Next episode"
            accessibilityState={{ disabled: canNext === false }}
          >
            <AppIcon name="skipForward" size={22} color="#fff" fill="#fff" strokeWidth={2} />
          </Pressable>
        ) : null}
      </View>

      {/* Bottom: time / seekbar / duration */}
      <View style={styles.bottom}>
        <Text style={styles.time}>{fmtTime(position)}</Text>
        <Timeline position={position} duration={duration} onSeek={onSeek} />
        <Text style={styles.time}>{fmtTime(duration)}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    ...StyleSheet.absoluteFill,
    justifyContent: 'center',
    alignItems: 'center',
  },
  top: {
    position: 'absolute',
    top: 8,
    left: 8,
    right: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  topActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },
  speedText: {
    color: '#fff',
    fontFamily: font.semibold,
    fontSize: 12,
    fontVariant: ['tabular-nums'],
  },
  iconBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chips: {
    flex: 1,
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 6,
    minWidth: 0,
  },
  chip: {
    backgroundColor: 'rgba(0,0,0,0.45)',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
    maxWidth: 110,
  },
  chipText: {
    color: '#fff',
    fontFamily: font.semibold,
    fontSize: 11,
    fontVariant: ['tabular-nums'],
  },
  title: {
    position: 'absolute',
    top: 52,
    left: 16,
    right: 16,
    color: '#fff',
    fontFamily: font.semibold,
    fontSize: 15,
    lineHeight: 20,
    textShadowColor: 'rgba(0,0,0,0.7)',
    textShadowRadius: 6,
    textShadowOffset: { width: 0, height: 1 },
  },
  bigBtn: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: 'rgba(0,0,0,0.5)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  // The three-button transport row. `pointerEvents` is inherited from the
  // `box-none` root, so the gaps between buttons stay transparent to taps — a
  // dead zone there would swallow the double-tap-the-video gesture underneath.
  transport: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 22,
  },
  sideBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  /** No episode that way — dimmed but still occupying its slot. */
  sideBtnOff: {
    opacity: 0.3,
  },
  bottom: {
    position: 'absolute',
    left: 12,
    right: 12,
    bottom: 6,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingBottom: 4,
  },
  time: {
    color: '#fff',
    fontFamily: font.medium,
    fontSize: 11,
    fontVariant: ['tabular-nums'],
    minWidth: 34,
    textAlign: 'center',
  },
  track: {
    flex: 1,
    height: 26,
    flexDirection: 'row',
    alignItems: 'center',
  },
  rail: {
    ...StyleSheet.absoluteFill,
    top: 11,
    bottom: 11,
    backgroundColor: 'rgba(255,255,255,0.25)',
    borderRadius: 2,
  },
  fill: { height: 4, backgroundColor: '#fff', borderRadius: 2 },
  empty: { height: 4, backgroundColor: 'transparent' },
  knob: {
    position: 'absolute',
    width: 11,
    height: 11,
    borderRadius: 6,
    backgroundColor: '#fff',
    marginLeft: -6,
    top: 7.5,
  },
});
