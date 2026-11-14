// The genre SPOTLIGHT — one feature tile plus a row of portraits.
//
// A section that is only a rail of posters has no hierarchy: everything is the
// same size, so the eye has nothing to land on. The mosaic gives the section a
// front door. One show, big, with its key art at full width; four more beneath
// it as ordinary tiles. It is the magazine spread — a lead image and a strip of
// smaller ones — and it is the reason the explore page does not read as a list
// of rails.
//
// The feature tile is the SAME `MediaBannerCard` the films grid uses, at
// emphasis: one component, two sizes. A bespoke hero component here would be a
// second scrim implementation, a second accent rule and a second set of
// fallbacks to keep in sync.
//
// The four below are `PosterCard` — the app-wide tile, honouring the
// `home.tileStyle` setting like every other grid. Mixing shapes is the point;
// mixing tile STYLES is not, and that is what the setting decides.

import { memo, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTheme } from '@/lib/ui/useTheme';
import { layout, spacing } from '@/lib/ui/tokens';
import { MediaBannerCard } from './MediaBannerCard';
import { PosterCard } from './PosterCard';
import type { MediaItem } from '@/lib/anilist';
import type { TileStyleKey } from '@/lib/settings/store';

const GAP = spacing.md - 2;
/** The tail's own padding, INSIDE the gutter. */
const PAD = GAP - 1;
/** Tighter than GAP because the tile is already inside a padded plate. */
const TAIL_GAP = GAP - 2;
const TAIL_COLUMNS = 4;

export const FeatureMosaic = memo(function FeatureMosaic({
  items,
  onSelect,
  /** Shown on the feature tile's kicker, in the section's accent. */
  kicker,
  variant = 'framed',
  screenW,
}: {
  /** [feature, ...rest]. Anything past `1 + TAIL_COLUMNS` is not shown. */
  items: MediaItem[];
  onSelect: (media: MediaItem) => void;
  kicker?: string | null;
  variant?: TileStyleKey;
  screenW: number;
}) {
  const { color } = useTheme();
  const feature = items[0];
  const tail = useMemo(
    () => items.slice(1, 1 + TAIL_COLUMNS),
    [items]
  );
  const tailW = useMemo(
    () =>
      // Measured against the plate's CONTENT box, not the screen: the plate
      // has its own padding, so deriving from `screenW` alone makes the four
      // tiles a few pixels wider than the box that holds them and the last one
      // hangs off the right edge.
      Math.floor(
        (screenW - layout.gutter * 2 - PAD * 2 - TAIL_GAP * (TAIL_COLUMNS - 1)) / TAIL_COLUMNS
      ),
    [screenW]
  );
  const featureW = screenW - layout.gutter * 2;

  if (!feature) return null;

  return (
    <View style={styles.wrap}>
      <View style={styles.feature}>
        <MediaBannerCard
          media={feature}
          width={featureW}
          onPress={onSelect}
          kicker={kicker}
          emphasis
        />
      </View>

      {tail.length ? (
        <View style={[styles.tail, { backgroundColor: color.bg.surface, borderColor: color.border.muted }]}>
          {tail.map((m) => (
            <PosterCard
              key={m.id}
              media={m}
              variant={variant}
              width={tailW}
              onPress={onSelect}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  // No top margin: same contract as `SectionHeader` — the SECTION owns the gap
  // above itself, so a mosaic rendered under a heading gets the standard
  // rhythm instead of a heading-sized gap PLUS this one.
  wrap: {},
  feature: {
    paddingHorizontal: layout.gutter,
  },
  // A plate behind the strip rather than bare page: four tiles in a row need a
  // container or they read as fragments of the section above. `padding` and
  // `gap` are the values `tailW` was solved against — change one, change both.
  tail: {
    marginTop: GAP,
    marginHorizontal: layout.gutter,
    padding: PAD,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: TAIL_GAP,
  },
});
