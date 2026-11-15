// The slide-in episode panel.
//
// A side panel, not a bottom sheet, because it lives inside a landscape frame:
// a sheet would take the bottom half of a 420pt-tall window and leave a
// letterboxed strip of video above it, which reads as a layout bug rather than
// as a menu. A panel takes the right third and leaves the playhead visible,
// which is what makes "jump to episode 9" a decision made WHILE watching rather
// than after a transition.
//
// It is absolutely positioned INSIDE the player root rather than pushed as a
// route, so opening it does not unmount the video — the frame keeps playing
// behind the panel, which is the entire reason to use an overlay here.

import { memo, useEffect, useRef, useState } from 'react';
import {
  Animated,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Image } from 'expo-image';

import { AppIcon } from '@/components/ui/AppIcon';
import type { EdgeInsets } from 'react-native-safe-area-context';
import { font, radii } from '@/lib/ui/tokens';
import { formatEpisodeNumber } from '@/lib/player/format';

export interface PanelEpisode {
  number: number;
  title?: string;
  poster?: string | null;
  /** Resume position in seconds, or 0. Drives the per-row progress hairline. */
  position?: number;
  duration?: number | null;
  /**
   * Set by the caller when AniList — not this device — owns what counts as
   * watched. A deliberate reset on AniList has to be expressible here too, so
   * the row cannot keep ticking off a local position the tracker has already
   * forgotten. Same contract as `EpisodeRow.watchedOverride` on the details
   * page, so the two lists cannot disagree about a title.
   */
  watchedOverride?: boolean;
}

export const EpisodePanel = memo(function EpisodePanel({
  visible,
  episodes,
  current,
  onPick,
  onClose,
  insets,
  onVisibleNumbers,
}: {
  visible: boolean;
  episodes: PanelEpisode[];
  current: number;
  onPick: (number: number) => void;
  onClose: () => void;
  /** Landscape puts the notch on a SIDE — the panel is edge-anchored. */
  insets: EdgeInsets;
  /** Reported viewable episode numbers — drives the Kitsu fill-in. */
  onVisibleNumbers?: (numbers: number[]) => void;
}) {
  const anim = useRef(new Animated.Value(0)).current;
  /**
   * The list node and each row's Y offset. Saved by the rows themselves so the
   * open-effect can scroll straight to the current episode without a measuring
   * pass — `getItemLayout` cannot be used here because poster thumbs make some
   * rows taller than the title-only fallback, and a wrong itemLayout scrolls to
   * the WRONG row, which is worse than not scrolling.
   */
  const listRef = useRef<FlatList<PanelEpisode>>(null);
  const rowOffsets = useRef(new Map<number, number>());
  // Viewability, kept in refs so the FlatList's handler identity is stable.
  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 50, minimumViewTime: 100 }).current;
  const onVisibleNumbersRef = useRef(onVisibleNumbers);
  onVisibleNumbersRef.current = onVisibleNumbers;
  const onViewableItemsChanged = useRef(({ viewableItems }: { viewableItems: { item: PanelEpisode }[] }) => {
    const nums = viewableItems.map((v) => v.item.number);
    onVisibleNumbersRef.current?.(nums);
  }).current;

  // Mount/unmount is a STATE machine, not a render-time side effect. The panel
  // has to stay mounted through its exit animation — unmounting the instant
  // `visible` goes false makes the close a hard cut — so it lives for one more
  // render after being told to close.
  const [mounted, setMounted] = useState(visible);

  useEffect(() => {
    if (visible) {
      setMounted(true);
      anim.setValue(0);
    }
    Animated.spring(anim, {
      toValue: visible ? 1 : 0,
      useNativeDriver: true,
      damping: 20,
      stiffness: 240,
      mass: 0.8,
    }).start(({ finished }) => {
      // Only drop the node once the close has actually played out. Guarded on
      // `finished` because an interrupted spring reports false, and unmounting
      // mid-flight would snap it shut.
      if (finished && !visible) setMounted(false);
    });
  }, [visible, anim]);

  // Open AT the current episode, not at the top of the list. A panel that opens
  // wherever it last scrolled leaves a viewer on episode 40 of 50 hunting for
  // the row they are actually on — every real player scrolls the picker to
  // "now" on open, because "which episode am I on, and what comes next" is the
  // reason the panel was opened. `getItemLayout` cannot be used here because
  // the poster thumbs make some rows taller than the title-only fallback, and
  // a wrong itemLayout scrolls to the WRONG row — which is worse than not
  // scrolling — so the offset comes from each row's own `onLayout` (saved by
  // `onMeasure` below) with `scrollToIndex` as the fallback while rows are
  // still being measured.
  useEffect(() => {
    if (!visible) {
      rowOffsets.current.clear();
      return;
    }
    const i = episodes.findIndex((e) => e.number === current);
    if (i <= 0) {
      listRef.current?.scrollToOffset({ offset: 0, animated: false });
      return;
    }
    const y = rowOffsets.current.get(current);
    if (y != null) {
      listRef.current?.scrollToOffset({ offset: Math.max(0, y - 40), animated: false });
    } else {
      listRef.current?.scrollToIndex({ index: i, viewPosition: 0.3, animated: false });
    }
  }, [visible, episodes, current]);

  if (!mounted) return null;

  // A constant slide distance rather than the measured panel width: the panel
  // is `right: 0`, so anything past its own width puts it fully off-screen, and
  // a constant means the interpolation does not have to be rebuilt when the
  // first layout arrives and change under a running animation.
  const translateX = anim.interpolate({ inputRange: [0, 1], outputRange: [SLIDE, 0] });

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      {/* Backdrop. Semi-transparent rather than opaque: the user is choosing to
          keep watching while they pick, and losing the frame entirely is what
          makes a picker feel like leaving the player. */}
      <Animated.View style={[StyleSheet.absoluteFill, styles.backdrop, { opacity: anim }]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel="Close episodes" />
      </Animated.View>

      <Animated.View
        style={[
          styles.panel,
          {
            transform: [{ translateX }],
            // The panel spans the full height of the right edge, so all four
            // insets apply. `top` clears the notch when the device is held the
            // other way; `right` clears it in the usual landscape grip.
            paddingTop: insets.top + 14,
            paddingBottom: insets.bottom,
            paddingRight: insets.right,
          },
        ]}
      >
        <View style={styles.header}>
          <Text style={styles.heading}>Episodes</Text>
          <Pressable
            onPress={onClose}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel="Close episodes"
          >
            <AppIcon name="close" size={20} color="#fff" strokeWidth={2} />
          </Pressable>
        </View>
        <FlatList
          ref={listRef}
          data={episodes}
          keyExtractor={(e) => String(e.number)}
          showsVerticalScrollIndicator={false}
          // Rows are ~52pt. Getting 6-8 of them on screen without scrolling is
          // the whole point of a panel that does not steal the frame, so this is
          // tuned to overshoot slightly and scroll rather than undershoot and
          // leave the last episode unreachable-looking.
          getItemLayout={(_data, index) => ({
            length: 58,
            offset: 58 * index,
            index,
          })}
          initialScrollIndex={Math.max(
            0,
            episodes.findIndex((e) => e.number === current)
          )}
          initialNumToRender={12}
          windowSize={7}
          onViewableItemsChanged={onViewableItemsChanged}
          viewabilityConfig={viewabilityConfig}
          removeClippedSubviews
          renderItem={({ item }) => (
            <EpisodeRow
              episode={item}
              active={item.number === current}
              onPick={onPick}
              onMeasure={(y) => {
                // `onLayout` fires on mount and on every re-layout; mid-list
                // virtualisation can report a row's position while it is being
                // recycled. Only the row layouts that were measured while the
                // list is settled matter to the open-scroll, and a stale entry
                // from a recycled row is corrected by the next layout event.
                if (y >= 0) rowOffsets.current.set(item.number, y);
              }}
            />
          )}
        />
      </Animated.View>
    </View>
  );
});

const EpisodeRow = memo(function EpisodeRow({
  episode,
  active,
  onPick,
  onMeasure,
}: {
  episode: PanelEpisode;
  active: boolean;
  onPick: (n: number) => void;
  /** The row's Y offset within the list, reported on layout. */
  onMeasure?: (y: number) => void;
}) {
  // AniList-watched draws a FULL hairline rather than none. The hairline is how
  // this panel says "seen", so an episode the tracker counts as watched has to
  // keep reading that way even though its local position is withheld — hence
  // the override coming first, before the ratio that needs a position.
  const frac = episode.watchedOverride
    ? 1
    : episode.duration && (episode.position ?? 0) > 0
      ? Math.min(1, (episode.position ?? 0) / episode.duration)
      : 0;

  return (
    <Pressable
      onPress={() => onPick(episode.number)}
      onLayout={(e) => onMeasure?.(e.nativeEvent.layout.y)}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      style={({ pressed }) => [
        styles.row,
        active ? styles.rowActive : null,
        pressed ? styles.rowPressed : null,
      ]}
    >
      <View style={styles.thumbWrap}>
        {episode.poster ? (
          <Image
            source={{ uri: episode.poster }}
            style={styles.thumb}
            contentFit="cover"
            transition={120}
          />
        ) : (
          <View style={[styles.thumb, styles.thumbEmpty]}>
            <Text style={styles.thumbNum}>{formatEpisodeNumber(episode.number)}</Text>
          </View>
        )}
        {episode.poster ? (
          <View style={styles.epBadge}>
            <Text style={styles.epBadgeText}>EP {formatEpisodeNumber(episode.number)}</Text>
          </View>
        ) : null}
      </View>

      <View style={styles.rowBody}>
        <Text
          style={[styles.rowTitle, active ? styles.rowTitleActive : null]}
          numberOfLines={1}
        >
          Episode {formatEpisodeNumber(episode.number)}
        </Text>
        {episode.title ? (
          <Text style={styles.rowSub} numberOfLines={1}>
            {episode.title}
          </Text>
        ) : null}
        {frac > 0 ? (
          <View style={styles.miniTrack}>
            <View style={[styles.miniFill, { width: `${frac * 100}%` }]} />
          </View>
        ) : null}
      </View>

      {active ? <View style={styles.nowDot} /> : null}
    </Pressable>
  );
});

const PANEL_MAX = 340;
/** Slide distance. Must exceed PANEL_MAX so the panel clears the right edge. */
const SLIDE = PANEL_MAX + 24;

const styles = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  panel: {
    position: 'absolute',
    right: 0,
    top: 0,
    bottom: 0,
    width: PANEL_MAX,
    backgroundColor: 'rgba(16,16,22,0.98)',
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.12)',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 10,
  },
  heading: {
    color: 'rgba(255,255,255,0.6)',
    fontFamily: font.semibold,
    fontSize: 11,
    letterSpacing: 1.1,
    textTransform: 'uppercase',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  rowActive: {
    backgroundColor: 'rgba(255,255,255,0.1)',
  },
  rowPressed: {
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  thumbWrap: {
    position: 'relative',
  },
  thumb: {
    width: 72,
    height: 40,
    borderRadius: radii.sm,
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  epBadge: {
    position: 'absolute',
    top: 4,
    left: 4,
    paddingHorizontal: 4,
    paddingVertical: 1,
    borderRadius: 3,
    backgroundColor: 'rgba(0,0,0,0.6)',
  },
  epBadgeText: {
    color: '#fff',
    fontFamily: font.bold,
    fontSize: 9,
    letterSpacing: 0.4,
  },
  thumbEmpty: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  thumbNum: {
    color: 'rgba(255,255,255,0.7)',
    fontFamily: font.semibold,
    fontSize: 13,
  },
  rowBody: {
    flex: 1,
    gap: 2,
  },
  rowTitle: {
    color: 'rgba(255,255,255,0.9)',
    fontFamily: font.medium,
    fontSize: 14,
    lineHeight: 18,
  },
  rowTitleActive: {
    color: '#fff',
    fontFamily: font.semibold,
  },
  rowSub: {
    color: 'rgba(255,255,255,0.45)',
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 15,
  },
  miniTrack: {
    height: 2,
    borderRadius: 1,
    backgroundColor: 'rgba(255,255,255,0.18)',
    marginTop: 3,
    overflow: 'hidden',
  },
  miniFill: {
    height: 2,
    backgroundColor: '#fff',
  },
  nowDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#fff',
  },
});
