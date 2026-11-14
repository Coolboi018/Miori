// A horizontal rail of poster cards — the "Trending", "Popular",
// "Latest releases" rows on home, and the detail page's relations and
// recommendations.
//
// SWIPE-ONLY, deliberately. The old header carried a pair of scroll arrows
// with a full onScroll state machine behind them (edge flags updated ~30×/s
// during a fling, purely to enable/disable the buttons). On a phone that is
// desktop furniture: the cut-off half-tile at the rail's edge is the
// affordance, and swiping is the most natural gesture there is. Removing
// them means a rail fling costs ZERO JS work per frame — the list
// runs entirely on the UI thread.
//
// The header's trailing slot now holds a quiet "See all ›" link. It is a real
// control when the caller passes `onSeeAll` (the explore screen does, and jumps
// to its filterable grid seeded with this rail's definition) and inert text
// when it does not, rather than a button that promises a tap it cannot honour.
//
// VIRTUALISED, AND THIS IS A PERFORMANCE FILE NOT A STYLE ONE.
//
// This was a plain horizontal `ScrollView` mapping all fourteen items, and each
// `PosterCard` is six views (card, art, title, meta row, dot, meta text). That is
// ~84 views per rail, and home mounts five rails while explore mounts three more
// plus a chart and a mosaic — call it five hundred views before any scrolling
// happens.
//
// It is the VIEW COUNT that makes the tab bar slow, not the network. Every view
// in an attached tree is walked on every layout pass, and with every tab mounted
// up front (`lazy: false` in `app/(tabs)/_layout.tsx`) the platform was
// re-measuring five screens' worth of them on each tab switch. A
// `FlatList` here mounts six tiles instead of fourteen and grows only as the user
// actually scrolls, which takes the same screen from ~500 views to ~150.
//
// `getItemLayout` is exact and free because the tile width is a constant and the
// gap is a token — so the list is told its geometry rather than measuring it, and
// `initialNumToRender` can be small without the list having to guess.

import { memo, useCallback, useMemo } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '@/lib/ui/useTheme';
import { font, radii, spacing } from '@/lib/ui/tokens';
import { PosterCard } from './PosterCard';
import { SectionHeader } from '@/components/ui/SectionHeader';
import type { MediaItem } from '@/lib/anilist';
import type { TileStyleKey } from '@/lib/settings/store';

/** `PosterCard`'s own default width — see its props. */
const TILE_W = 124;

/**
 * Tiles rendered up front. Six is roughly two screens' worth on a phone: enough
 * that a rail never shows empty space at rest, few enough that the mount is
 * cheap.
 */
const INITIAL_TILES = 6;

/**
 * How many "screens" of rail content stay mounted either side of the viewport.
 * Three is the sweet spot: enough that a fast fling does not show blanks, few
 * enough that the resident view count stays in the low dozens per rail.
 */
const WINDOW = 3;

export const MediaRail = memo(function MediaRail({
  title,
  items,
  onSelect,
  kickerFor,
  variant = 'framed',
  seeAll = true,
  onSeeAll,
}: {
  title: string;
  items: MediaItem[];
  onSelect: (media: MediaItem) => void;
  /** Optional per-item label above the title (relations show the relation type). */
  kickerFor?: (media: MediaItem, index: number) => string | null;
  /** Tile design — see PosterCard. */
  variant?: TileStyleKey;
  /** Show the "See all ›" link in the header slot. */
  seeAll?: boolean;
  /**
   * Make that link real. Without it the link renders as static text: a
   * pressable that goes nowhere is worse than no pressable.
   */
  onSeeAll?: () => void;
}) {
  const { color } = useTheme();

  /**
   * Stable identities. `FlatList` re-runs its render work whenever these change,
   * and three fresh closures per render is three re-renders of the row.
   */
  const keyExtractor = useCallback((m: MediaItem) => String(m.id), []);

  const renderItem = useCallback(
    ({ item, index }: { item: MediaItem; index: number }) => (
      <PosterCard
        media={item}
        kicker={kickerFor?.(item, index)}
        variant={variant}
        // The handler itself, not an arrow — see the memo note in PosterCard.
        onPress={onSelect}
      />
    ),
    [kickerFor, variant, onSelect]
  );

  /**
   * EXACT, because the geometry is constant: a fixed-width tile plus a fixed
   * gap. That means the list is told where every tile is instead of measuring it,
   * which is what lets `initialNumToRender` be small.
   */
  const stride = useMemo(() => TILE_W + spacing.md, []);
  const getItemLayout = useCallback(
    (_data: ArrayLike<MediaItem> | null | undefined, index: number) => ({
      length: TILE_W,
      offset: stride * index,
      index,
    }),
    [stride]
  );

  if (!items.length) return null;

  return (
    <View style={styles.wrap}>
      <SectionHeader
        title={title}
        trailing={
          seeAll ? (
            // Visual upgrade of the old muted text: a quiet plate gives it a
            // real boundary (it now reads as SOMETHING you could touch,
            // rather than a stray grey word), while the hairline border +
            // surface fill keep it far quieter than a filled pill would be
            // next to eight section headers. Press = opacity only, per the
            // app-wide no-custom-ripple rule.
            <Pressable
              onPress={onSeeAll}
              disabled={!onSeeAll}
              accessibilityRole="button"
              accessibilityLabel={`See all ${title}`}
              accessibilityState={{ disabled: !onSeeAll }}
              style={({ pressed }) => [
                styles.seeAll,
                {
                  backgroundColor: color.bg.surface,
                  borderColor: color.border.muted,
                  opacity: pressed ? 0.6 : 1,
                },
              ]}
            >
              <Text style={[styles.seeAllText, { color: color.text.secondary }]}>See all</Text>
              <Text style={[styles.seeAllChevron, { color: color.text.muted }]}>›</Text>
            </Pressable>
          ) : null
        }
      />

      <FlatList
        data={items}
        horizontal
        renderItem={renderItem}
        keyExtractor={keyExtractor}
        getItemLayout={getItemLayout}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.rail}
        initialNumToRender={INITIAL_TILES}
        maxToRenderPerBatch={INITIAL_TILES}
        windowSize={WINDOW}
        // Off, and this is the app-wide finding rather than a guess: with
        // `expo-image`, clipping unmounts tiles whose bitmap is still decoding and
        // a fast fling shows grey flashes. Virtualisation already bounds what is
        // mounted, so this buys little and costs visible glitches.
        removeClippedSubviews={false}
      />
    </View>
  );
});

const styles = StyleSheet.create({
  wrap: {
    marginTop: spacing.xxl,
  },
  seeAll: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    // Padded generously on the horizontal axis so the plate has presence
    // without growing taller than the 28px header row it lives in.
    paddingHorizontal: spacing.sm + 2,
    height: 24,
    borderRadius: radii.full,
    borderWidth: StyleSheet.hairlineWidth,
  },
  seeAllText: {
    fontSize: 12,
    lineHeight: 15,
    fontFamily: font.medium,
    letterSpacing: 0.2,
  },
  seeAllChevron: {
    fontSize: 14,
    lineHeight: 15,
    fontFamily: font.semibold,
  },
  rail: {
    paddingHorizontal: spacing.lg,
    gap: spacing.md,
  },
});
