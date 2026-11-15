// One result as a ROW — the search screen's second layout.
//
// WHY A ROW EXISTS AT ALL when the poster grid already works: a tile's caption
// is one line of 10.5px text. A row has room for the title at a readable
// size, the year, the format, the episode count AND the score, right-aligned
// where the eye can compare it down a column without reading it. Searching is
// a comparing job — "which of these four do I recognise" — and comparing needs
// the numbers lined up.
//
// THE ROW IS A FIXED HEIGHT. `MEDIA_ROW_HEIGHT` is exported because the search
// list passes it to `getItemLayout`, and a `getItemLayout` that guesses is
// worse than none: rows overlap or scroll-jump and the flatlist's idea of the
// content height stops matching reality. Everything that could change the
// height therefore has a fixed value — the cover is 52×78 (poster ratio to
// within a pixel), the title is clamped to two lines, and the facts line is
// one line that ellipsises.
//
// NOTHING RENDERS OVER THE COVER. Same rule as `PosterCard`, same reason:
// this screen can mount a screenful of these and overlays are more views to
// composite. The score lives beside the text, not stamped on the art.
//
// PERFORMANCE: memoised, `onPress` takes the media rather than being an arrow
// (see `PosterCard` for why that matters), and the score is a `<Text>`.

import { Image } from 'expo-image';
import { memo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { RoundedPressable } from '@/components/ui/RoundedPressable';
import { coverPlate } from '@/lib/ui/accent';
import { useTheme } from '@/lib/ui/useTheme';
import { font, layout, radii, spacing } from '@/lib/ui/tokens';
import { prefetchAnime, prefetchEpisodes } from '@/lib/query/prefetch';
import { openListSheet, LIST_LONG_PRESS_MS } from '@/lib/list/listSheet';
import { mediaTitle, type MediaItem } from '@/lib/anilist';
import { formatLabel, scoreDisplay } from './format';

/**
 * Cover height + the row's own vertical padding. THE contract with
 * `getItemLayout`: change one, change the other, or the list lies about how
 * tall it is.
 */
const COVER_W = 52;
const COVER_H = 78;
const ROW_PAD = 7;

export const MEDIA_ROW_HEIGHT = COVER_H + ROW_PAD * 2;

export const MediaRow = memo(function MediaRow({
  media,
  onPress,
  /** Draws the hairline that separates this row from the next. */
  divider = true,
}: {
  media: MediaItem;
  onPress: (media: MediaItem) => void;
  divider?: boolean;
}) {
  const { color } = useTheme();
  /**
   * `coverImage.large` (230x320, ~137KB) over `extraLarge` (460x640, ~478KB) —
   * measured on AniList's CDN. This is the search-results and explore-list row,
   * so it is the highest-count poster in the app after the rails, and the same
   * 3.5x saving applies per row. `large` is non-optional in the type.
   */
  const uri = media.coverImage?.large ?? media.coverImage?.extraLarge;
  const plate = coverPlate(media.coverImage?.color, color.bg.surface) ?? color.bg.elevated;
  const title = mediaTitle(media.title);

  // The same status lamp the tiles use, for the same reason: green means it is
  // on air now, and that is the single most useful thing to know at a glance
  // when you are deciding whether to start something.
  const dotColor =
    media.status === 'RELEASING'
      ? color.status.success
      : media.status === 'NOT_YET_RELEASED'
        ? color.status.info
        : color.text.muted;

  const facts = [
    media.seasonYear,
    formatLabel(media.format),
    media.episodes != null ? `${media.episodes} ep${media.episodes === 1 ? '' : 's'}` : null,
  ]
    .filter(Boolean)
    .join('  ·  ');

  return (
    <RoundedPressable
      onPress={() => onPress(media)}
      // Warm the detail payload on touch-down — see PosterCard's note. The
      // finger lands ~80–150ms before the lift, and a row here is always on
      // its way to the detail screen.
      onPressIn={() => {
        prefetchAnime(media.id);
        prefetchEpisodes(media.id);
      }}
      // Hold to edit the list — see PosterCard's note for why long-press and not a
      // second button. `Pressability` suppresses `onPress` once this has fired, so
      // a held row does not also navigate.
      onLongPress={() => openListSheet(media)}
          delayLongPress={LIST_LONG_PRESS_MS}
      accessibilityRole="button"
      accessibilityLabel={title}
      radius={radii.sm}
      tint={color.accent.glow}
      style={[
        styles.row,
        {
          height: MEDIA_ROW_HEIGHT,
          borderBottomWidth: divider ? StyleSheet.hairlineWidth : 0,
          borderBottomColor: color.border.muted,
        },
      ]}
    >
      <View style={[styles.cover, { backgroundColor: plate }]}>
        {uri ? (
          <Image
            source={{ uri }}
            style={StyleSheet.absoluteFill}
            contentFit="cover"
            transition={150}
            cachePolicy="memory-disk"
            allowDownscaling
          />
        ) : null}
      </View>

      <View style={styles.body}>
        <Text style={[styles.title, { color: color.text.primary }]} numberOfLines={2}>
          {title}
        </Text>
        <View style={styles.metaRow}>
          <View style={[styles.dot, { backgroundColor: dotColor }]} />
          {facts ? (
            <Text style={[styles.meta, { color: color.text.muted }]} numberOfLines={1}>
              {facts}
            </Text>
          ) : null}
        </View>
      </View>

      {/* Right-aligned so a column of them can be scanned, not read. */}
      {media.averageScore != null ? (
        <Text style={[styles.score, { color: color.text.secondary }]} numberOfLines={1}>
          {scoreDisplay(media.averageScore)}
        </Text>
      ) : (
        // Reserved space for a show with no score yet, so the rows above and
        // below it do not shift sideways when the column has to grow.
        <View style={styles.scoreSpace} />
      )}
    </RoundedPressable>
  );
});

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: layout.gutter,
    paddingVertical: ROW_PAD,
  },
  cover: {
    width: COVER_W,
    height: COVER_H,
    borderRadius: radii.sm,
    overflow: 'hidden',
  },
  body: { flex: 1, minWidth: 0, gap: 3 },
  title: {
    fontSize: 14,
    lineHeight: 18,
    fontFamily: font.semibold,
    letterSpacing: -0.1,
  },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 5, minWidth: 0 },
  dot: { width: 6, height: 6, borderRadius: radii.full },
  meta: { flexShrink: 1, fontSize: 11.5, lineHeight: 15, fontFamily: font.medium },
  score: {
    fontSize: 13,
    lineHeight: 17,
    fontFamily: font.semibold,
    // Tabular so the "%" column of scores does not shimmer as values change.
    fontVariant: ['tabular-nums'],
  },
  scoreSpace: { width: 30 },
});