// A GRID of poster tiles — the explore screen's Browse section, and the one
// thing this screen exists to have.
//
// Home is a stack of horizontal rails; that is the right shape for "show me
// what's happening". It is the wrong shape for "let me narrow five thousand
// titles down to twelve", which is a scanning problem, and a scanning problem
// wants a matrix.
//
// WIDTHS ARE COMPUTED, NOT GUESSED. `PosterCard` takes a width, so the grid
// derives it from the real window: `(screen - 2·gutter - (n-1)·gap) / n`.
// A percentage would resolve against a different base on the absolute-fill art
// well inside each card, and hardcoding 110 or 118 is what makes three-column
// grids overflow on one phone and gape on another.
//
// PERFORMANCE: mapped, not virtualised. The grid is bounded by the browse page
// size (12, or 24 after one "load more"), and virtualising a grid inside the
// page ScrollView buys nothing and costs a nested-list warning.

import { memo, useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '@/lib/ui/useTheme';
import { font, layout, radii, spacing } from '@/lib/ui/tokens';
import { AppIcon } from '@/components/ui/AppIcon';
import { PosterCard } from './PosterCard';
import { MediaBannerCard } from './MediaBannerCard';
import type { MediaItem } from '@/lib/anilist';
import type { TileStyleKey } from '@/lib/settings/store';

export const GRID_GAP = spacing.md;

/** The width a tile gets at `columns` across the real window. */
export function gridTileWidth(screenW: number, columns: number, gap: number = GRID_GAP): number {
  return Math.floor((screenW - layout.gutter * 2 - gap * (columns - 1)) / columns);
}

export const MediaGrid = memo(function MediaGrid({
  items,
  onSelect,
  columns = 3,
  variant = 'framed',
  gap = GRID_GAP,
  screenW,
}: {
  items: MediaItem[];
  onSelect: (media: MediaItem) => void;
  columns?: number;
  variant?: TileStyleKey;
  gap?: number;
  /** The real window width. Passed in so every grid on a screen agrees. */
  screenW: number;
}) {
  const width = useMemo(() => gridTileWidth(screenW, columns, gap), [screenW, columns, gap]);
  return (
    <View style={[styles.grid, { gap }]}>
      {items.map((m) => (
        <PosterCard
          key={m.id}
          media={m}
          variant={variant}
          width={width}
          // The handler itself, not an arrow — see PosterCard's memo note.
          onPress={onSelect}
        />
      ))}
    </View>
  );
});

/**
 * A 16:9 banner GRID — wide tiles, two up. Deliberately a different texture
 * from the poster grid above: a banner crops landscape key art to a strip, so
 * a wall of them reads as film rather than as a phone gallery. The explore
 * screen's "Feature films" section uses it so no two adjacent sections share a
 * tile shape.
 */
export const MediaBannerGrid = memo(function MediaBannerGrid({
  items,
  onSelect,
  columns = 2,
  gap = GRID_GAP,
  screenW,
}: {
  items: MediaItem[];
  onSelect: (media: MediaItem) => void;
  columns?: number;
  gap?: number;
  screenW: number;
}) {
  const width = useMemo(
    () => Math.floor((screenW - layout.gutter * 2 - gap * (columns - 1)) / columns),
    [screenW, columns, gap]
  );
  return (
    <View style={[styles.grid, { gap }]}>
      {items.map((m) => (
        <MediaBannerCard key={m.id} media={m} width={width} onPress={onSelect} />
      ))}
    </View>
  );
});

/**
 * What a browse shows when the filters exclude the world. Never a bare blank
 * grid: a filtering surface that can produce zero results MUST say so and offer
 * the way out, or it reads as a crash.
 */
export function GridEmpty({
  title,
  hint,
  actionLabel,
  onAction,
}: {
  title: string;
  hint?: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  const { color } = useTheme();
  return (
    <View style={styles.empty}>
      <View style={[styles.emptyGlyph, { borderColor: color.border.muted }]}>
        <AppIcon name="search" size={18} color={color.text.muted} />
      </View>
      <Text style={[styles.emptyTitle, { color: color.text.secondary }]}>{title}</Text>
      {hint ? <Text style={[styles.emptyHint, { color: color.text.muted }]}>{hint}</Text> : null}
      {actionLabel && onAction ? (
        <Pressable
          onPress={onAction}
          accessibilityRole="button"
          accessibilityLabel={actionLabel}
          android_ripple={{ color: color.accent.glow, borderless: false }}
          style={({ pressed }) => [
            styles.emptyBtn,
            { borderColor: color.border.strong, opacity: pressed ? 0.6 : 1 },
          ]}
        >
          <AppIcon name="reset" size={14} color={color.text.primary} />
          <Text style={[styles.emptyBtnText, { color: color.text.primary }]}>{actionLabel}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/**
 * Page control for a bounded results box: `‹  Page 3  ›`.
 *
 * This replaced a "Load more" button that APPENDED to the list. Appending is
 * the wrong shape for a filterable grid: the section grows without limit, the
 * page becomes a corridor you scroll forever with no way to say "that was the
 * end", and every tile added costs memory the grid will never release. Real
 * paging is honest about the size of the catalogue and keeps the section a
 * FIXED height, which is what lets everything below it stay where it is.
 *
 * The arrows disable at the ends rather than disappearing, so the control never
 * changes width and the row never reflows under your thumb.
 */
export function PageControl({
  page,
  pageCount,
  onChange,
  busy,
}: {
  page: number;
  pageCount: number;
  onChange: (page: number) => void;
  busy?: boolean;
}) {
  const { color } = useTheme();
  const atStart = page <= 1;
  const atEnd = page >= pageCount;

  const arrow = (
    label: string,
    target: number,
    disabled: boolean,
    icon: 'back' | 'chevron'
  ) => (
    <Pressable
      onPress={() => onChange(target)}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      android_ripple={disabled ? undefined : { color: color.accent.glow, borderless: false }}
      style={({ pressed }) => [
        styles.arrow,
        {
          backgroundColor: pressed && !disabled ? color.accent.muted : color.bg.surface,
          borderColor: color.border.muted,
          opacity: disabled ? 0.3 : 1,
        },
      ]}
    >
      <AppIcon name={icon} size={16} color={color.text.primary} />
    </Pressable>
  );

  return (
    <View style={styles.pager}>
      {arrow('Previous page', page - 1, atStart || !!busy, 'back')}
      <View style={styles.pagerLabelWrap}>
        <Text style={[styles.pagerLabel, { color: color.text.muted }]} numberOfLines={1}>
          {`Page ${page}`}
        </Text>
      </View>
      {arrow('Next page', page + 1, atEnd || !!busy, 'chevron')}
    </View>
  );
}

const styles = StyleSheet.create({
  grid: {
    paddingHorizontal: layout.gutter,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'flex-start',
  },

  empty: {
    marginHorizontal: layout.gutter,
    paddingVertical: spacing.huge,
    paddingHorizontal: spacing.xl,
    borderRadius: radii.xl,
    alignItems: 'center',
    gap: spacing.sm,
  },
  emptyGlyph: {
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.xs,
  },
  emptyTitle: {
    fontSize: 15,
    lineHeight: 20,
    fontFamily: font.semibold,
    textAlign: 'center',
  },
  emptyHint: {
    fontSize: 13,
    lineHeight: 19,
    textAlign: 'center',
    maxWidth: 260,
  },
  emptyBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: 38,
    paddingHorizontal: spacing.lg,
    borderRadius: radii.full,
    borderWidth: StyleSheet.hairlineWidth,
    marginTop: spacing.sm,
    overflow: 'hidden',
  },
  emptyBtnText: {
    fontSize: 13.5,
    lineHeight: 18,
    fontFamily: font.semibold,
  },

  // ---- pager ----
  pager: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.lg,
    paddingTop: spacing.xl,
  },
  arrow: {
    width: 40,
    height: 40,
    borderRadius: radii.full,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  pagerLabelWrap: {
    minWidth: 104,
    alignItems: 'center',
  },
  pagerLabel: {
    fontSize: 13,
    lineHeight: 17,
    fontFamily: font.semibold,
    letterSpacing: 0.2,
    // Page counts change width as you page ("9" → "10"), and a label that
    // reflows sideways under your thumb is worse than one that doesn't.
    fontVariant: ['tabular-nums'],
  },
});
