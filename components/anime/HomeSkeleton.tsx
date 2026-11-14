// Home's loading state — built from scratch.
//
// DESIGN, STATED PLAINLY. This is a set of quiet plates at the exact geometry
// the real screen will have — one hero, then rails of poster tiles — with a
// single, slow breathing animation over the whole thing. No sweeping bands, no
// staggered waves, no per-plate clocks: ONE Reanimated opacity loop on the UI
// thread drives every plate together. That is the smoothness argument in one
// line — the fewer animations a skeleton runs while the JS thread is busy
// parsing the response, the smoother it looks, and one shared pulse is the
// fewest there is.
//
// IT IS SMALL ON PURPOSE. Hero + two rails is everything that fits above the
// fold of a phone; rails below it are never seen before real content replaces
// them, so they are not drawn. Fewer views alive during the handover means the
// frame where real content replaces this costs less, which is where any
// hitch would come from.

import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import { useTheme } from '@/lib/ui/useTheme';
import { layout, radii, spacing } from '@/lib/ui/tokens';
import { HERO_HEIGHT } from './HeroCarousel';
import type { TileStyleKey } from '@/lib/settings/store';

/** `PosterCard`'s own tile width — the rails' real geometry. */
const TILE_W = 124;

/** Plates across one rail — as many as fit a phone's width. */
const TILES = 5;

/** How many rails to draw: what sits above the fold, no more. */
const RAILS = 2;

/** One breath of the pulse, in and out. Slow reads as calm; fast reads as panic. */
const BREATH_MS = 1100;

/** The pulse's floor — plates never vanish, they just dim. */
const MIN_OPACITY = 0.45;

export function HomeSkeleton({
  tileStyle = 'framed',
  rails = RAILS,
}: {
  tileStyle?: TileStyleKey;
  /** Rails above the fold. Home's real count is irrelevant past two — nothing
      below the fold is ever seen before content replaces it. */
  rails?: number;
}) {
  const { color } = useTheme();
  const framed = tileStyle === 'framed';
  const plate = color.bg.elevated;

  // ONE shared value for the whole skeleton. The animation lives entirely on
  // the UI thread — the JS thread can be fully occupied by the request this
  // skeleton is standing in for and the pulse keeps breathing.
  //
  // Started in an EFFECT, not during render — writing a shared value while
  // React is rendering is exactly what Reanimated's strict mode warns about,
  // and the component only ever mounts once per loading state, so there is no
  // restart cost to paying on mount.
  const breath = useSharedValue(MIN_OPACITY);
  const reduced = useReducedMotion();

  useEffect(() => {
    if (reduced) {
      // Reduced motion: park at full strength, no loop at all.
      breath.value = 1;
      return;
    }
    breath.value = withRepeat(
      withTiming(1, { duration: BREATH_MS, easing: Easing.inOut(Easing.quad) }),
      -1,
      true
    );
  }, [breath, reduced]);

  const pulse = useAnimatedStyle(() => ({ opacity: breath.value }));

  // The pulse style reads the shared value; with reduced motion it sits at 1
  // and is a no-op — static plates, no loop running.
  return (
    <Animated.View
      style={pulse}
      accessibilityLabel="Loading"
      accessibilityRole="progressbar"
    >
      <SkeletonBody color={color} plate={plate} framed={framed} rails={rails} />
    </Animated.View>
  );
}

/**
 * The plates themselves — plain views, no animation inside. Kept as its own
 * component so the animated wrapper above stays a one-liner and the reduced-
 * motion path shares it unchanged.
 */
function SkeletonBody({
  color,
  plate,
  framed,
  rails,
}: {
  color: ReturnType<typeof useTheme>['color'];
  plate: string;
  framed: boolean;
  rails: number;
}) {
  return (
    <View style={styles.page}>
      {/* The hero, at its real height, so nothing moves when content lands. */}
      <View
        style={[
          styles.hero,
          { backgroundColor: framed ? color.bg.surface : color.bg.elevated },
        ]}
      >
        <View
          style={[
            styles.heroInner,
            { backgroundColor: plate, borderRadius: radii.md },
          ]}
        />
      </View>

      {Array.from({ length: rails }, (_, r) => (
        <View key={r} style={styles.section}>
          {/* The heading, as a bar: a skeleton is a shape, not text. */}
          <View style={[styles.heading, { backgroundColor: plate }]} />
          <View style={styles.rail}>
            {Array.from({ length: TILES }, (_, j) => (
              <View
                key={j}
                style={[
                  styles.tile,
                  framed
                    ? {
                        backgroundColor: color.bg.surface,
                        borderColor: color.border.muted,
                      }
                    : null,
                ]}
              >
                <View style={[styles.art, { backgroundColor: plate, borderRadius: framed ? radii.sm : radii.lg }]} />
                <View style={styles.caption}>
                  <View style={[styles.line, { backgroundColor: plate }]} />
                  <View style={[styles.lineShort, { backgroundColor: plate }]} />
                </View>
              </View>
            ))}
          </View>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1 },
  // The hero's box matches the real carousel's height exactly (HERO_HEIGHT),
  // with one softer well inside it standing in for artwork — flat would read
  // as an empty gap rather than as an image on its way.
  hero: {
    height: HERO_HEIGHT,
    width: '100%',
    justifyContent: 'flex-end',
    padding: spacing.xl,
  },
  heroInner: { height: 96 },
  // `MediaRail`'s own top margin, so the first rail starts where it will
  // really start rather than jumping down when data lands.
  section: { marginTop: spacing.xxl },
  heading: {
    height: 14,
    width: 132,
    borderRadius: radii.full,
    marginLeft: layout.gutter,
    marginBottom: spacing.md,
  },
  // `MediaRail`'s rail padding and gap, verbatim — same gutters as the real
  // rows, so the plates line up with where the tiles will be.
  rail: { paddingHorizontal: spacing.lg, gap: spacing.md, flexDirection: 'row' },
  tile: {
    width: TILE_W,
    borderRadius: radii.lg,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 4,
  },
  art: { width: '100%', aspectRatio: layout.posterRatio },
  caption: { paddingHorizontal: 9, paddingTop: 7, paddingBottom: 9 },
  line: { height: 16, borderRadius: 4, width: '88%' },
  lineShort: { height: 16, borderRadius: 4, width: '54%', marginTop: 4 },
});
