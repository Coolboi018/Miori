// The full-cast page's loading state.
//
// Same policy as `DetailSkeleton`: the page at its real geometry, not a
// spinner. The cast list is a two-column grid of paired portraits (character
// left, voice actor right, hairline between), and the placeholder draws
// exactly that — two rows of cards whose plates become portraits in place.
//
// Geometry copied from `app/anime/[id]/characters.tsx`: the grid's padding,
// the card's radius and border, the 56px / 48px portraits, the gap sizes.
// Commented at each site so a change to the page is a change here too.
//
// One `ShimmerSweep` for the lot, with the wave running left to right across
// each card and down into the next — see `components/ui/Shimmer.tsx`.

import { StyleSheet, View } from 'react-native';

import { useTheme } from '@/lib/ui/useTheme';
import { radii, spacing } from '@/lib/ui/tokens';
import { Shimmer, ShimmerSweep } from '@/components/ui/Shimmer';

/** Two rows of two — enough to read as "the grid is coming". */
const CARDS = 4;

/** `characters.tsx` → portrait (56) and portraitVa (48). */
const PORTRAIT = 56;
const PORTRAIT_VA = 48;

/** How far the wave spreads across one card, in clock units. */
const CARD_SPAN = 0.7;
/** How far the second row of cards trails the first. */
const ROW_LEAD = 0.35;
/** A plate's neighbours within its own card trail it by roughly this. */
const STEP = 0.12;
/** The cycle: the last offset below, which is the last card's role chip. */
const SPAN = ROW_LEAD + CARD_SPAN + STEP * 2;

export function CastSkeleton() {
  const { color } = useTheme();
  const plate = color.bg.elevated;
  const perRow = 2;

  return (
    <ShimmerSweep span={SPAN}>
      <View style={styles.grid} accessibilityRole="progressbar" accessibilityLabel="Loading cast">
        {Array.from({ length: CARDS }, (_, i) => {
          const row = Math.floor(i / perRow);
          const col = i % perRow;
          const base = row * ROW_LEAD + (col / (perRow - 1)) * CARD_SPAN;

          return (
            <View
              key={i}
              style={[
                styles.card,
                { backgroundColor: color.bg.surface, borderColor: color.border.muted },
              ]}
            >
              {/* Character side */}
              <View style={styles.side}>
                <Shimmer plate={plate} radius={radii.full} style={styles.portrait} at={base} />
                <Shimmer plate={plate} radius={4} style={styles.name} at={base + STEP} />
                <Shimmer plate={plate} radius={radii.full} style={styles.roleChip} at={base + STEP * 2} />
              </View>

              {/* The link between the two portraits */}
              <View style={[styles.link, { backgroundColor: color.border.muted }]} />

              {/* Voice actor side */}
              <View style={styles.side}>
                <Shimmer plate={plate} radius={radii.full} style={styles.portraitVa} at={base + STEP / 2} />
                <Shimmer plate={plate} radius={4} style={styles.nameShort} at={base + STEP * 1.5} />
              </View>
            </View>
          );
        })}
      </View>
    </ShimmerSweep>
  );
}

const styles = StyleSheet.create({
  // `characters.tsx` → contentContainerStyle { padding: spacing.lg } + col
  // { gap: spacing.md }, flattened for a non-virtualised placeholder.
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
    padding: spacing.lg,
  },
  card: {
    flex: 1,
    minWidth: '46%',
    flexDirection: 'row',
    borderRadius: radii.lg,
    borderWidth: StyleSheet.hairlineWidth,
    paddingVertical: spacing.md,
    overflow: 'hidden',
  },
  side: {
    flex: 1,
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: spacing.xs,
  },
  portrait: { width: PORTRAIT, height: PORTRAIT },
  portraitVa: { width: PORTRAIT_VA, height: PORTRAIT_VA },
  name: { width: '72%', height: 12 },
  nameShort: { width: '60%', height: 12 },
  roleChip: { width: 46, height: 17 },
  link: {
    width: StyleSheet.hairlineWidth,
    alignSelf: 'stretch',
    marginVertical: spacing.sm,
  },
});
