// The loading state for a poster grid.
//
// Six plates at the grid's REAL geometry, so the grid does not jump when the
// tiles land. A spinner over an empty area is not a neutral loading state, it
// is a layout change — and a layout change is a scroll jump.
//
// It lives here rather than inside the explore screen because two screens now
// want it: explore's Browse box and the search tab's results. A skeleton is
// the one piece of a screen that must agree with that screen's real tile
// geometry, so having two copies of it guarantees one of them is wrong.
//
// THE SWEEP GOES ROW BY ROW, left to right. A grid is read in rows, so the wave
// crosses a row before it crosses the next — see `rowLead`. Nine tiles flaring
// on the same frame read as a broken screen; nine in a travelling line read as
// the grid arriving. One `ShimmerSweep` drives the lot.

import { StyleSheet, View } from 'react-native';
import { useTheme } from '@/lib/ui/useTheme';
import { layout, radii, spacing } from '@/lib/ui/tokens';
import { Shimmer, ShimmerSweep } from '@/components/ui/Shimmer';
import { gridTileWidth } from './MediaGrid';
import type { TileStyleKey } from '@/lib/settings/store';

/** How far the band travels across one row of tiles, in clock units. */
const ROW_SPAN = 0.55;

/** How far each row trails the one above it. */
const ROW_LEAD = 0.16;

/** The caption follows the art it belongs to rather than running level with it. */
const LINE_LEAD = 0.05;

export function GridSkeleton({
  columns,
  screenW,
  tileStyle,
  /** How many plates to draw. Two rows is the most that reads as "a grid is
   *  coming" without pretending to be a result set. */
  rows = 2,
}: {
  columns: number;
  screenW: number;
  tileStyle: TileStyleKey;
  rows?: number;
}) {
  const { color } = useTheme();
  const w = gridTileWidth(screenW, columns);
  const framed = tileStyle === 'framed';

  // The cycle, from the largest offset below — see ShimmerSweep on why this has
  // to be the maximum rather than an estimate.
  const span = (rows - 1) * ROW_LEAD + ROW_SPAN + LINE_LEAD * 2;

  return (
    <ShimmerSweep span={span}>
      <View style={styles.wrap}>
        {Array.from({ length: columns * rows }).map((_, i) => {
          // Row-major: the grid WRAPS, so the wave has to wrap with it or the
          // last tile of one row jumps back to the left of the next.
          const row = Math.floor(i / columns);
          const col = i % columns;
          const at = row * ROW_LEAD + (columns <= 1 ? 0 : (col / (columns - 1)) * ROW_SPAN);

          return (
            <View
              key={i}
              style={[
                styles.tile,
                // Only the FRAMED variant has a body to fill — clean's poster sits
                // directly on the page, so its placeholder is bare art.
                {
                  width: w,
                  backgroundColor: framed ? color.bg.surface : 'transparent',
                  borderColor: color.border.muted,
                  borderWidth: framed ? StyleSheet.hairlineWidth : 0,
                },
              ]}
            >
              <Shimmer
                plate={color.bg.elevated}
                radius={framed ? radii.sm : radii.md}
                style={styles.art}
                at={at}
              />
              <Shimmer
                plate={color.bg.elevated}
                radius={4}
                style={styles.line}
                at={at + LINE_LEAD}
              />
              <Shimmer
                plate={color.bg.elevated}
                radius={4}
                style={styles.lineShort}
                at={at + LINE_LEAD * 2}
              />
            </View>
          );
        })}
      </View>
    </ShimmerSweep>
  );
}

const styles = StyleSheet.create({
  wrap: {
    paddingHorizontal: layout.gutter,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
  },
  tile: { borderRadius: 10, padding: 4, gap: 6 },
  art: { width: '100%', aspectRatio: 2 / 3 },
  line: { height: 8, borderRadius: 4, width: '86%', marginTop: 2 },
  lineShort: { height: 8, borderRadius: 4, width: '52%' },
});
