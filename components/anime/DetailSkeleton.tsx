// The anime detail page's loading state.
//
// WHY A SKELETON AND NOT THE SPINNER IT REPLACES. The detail screen used to
// show a centred `ActivityIndicator` while `useMediaDetail` waited on the
// wire — which reads as "the app hung", because a spinner in the middle of an
// empty page gives the eye nothing to compare progress against. Worse, when
// the data landed the ENTIRE page assembled at once: banner, poster, title,
// action row, tabs, episode rows — a full-screen layout change, the exact
// jump the home screen's skeleton was built to prevent, happening on the
// app's heaviest screen.
//
// So the loading state is the SCREEN, at its real geometry, in the real
// order: banner, poster overlapping its bottom edge, centered identity,
// synopsis, the action pill, the tab strip, the episode rows. The plates
// become content in place and the page never moves.
//
// GEOMETRY IS COPIED, NOT IMPORTED, from `app/anime/[id].tsx` — same policy
// as `HomeSkeleton` with `PosterCard`. The screen's constants (BANNER_H,
// POSTER_W, POSTER_OVERLAP, the poster radius, the action pill's 50px) are
// private to it, and a placeholder that shares the real file's stylesheet
// would silently drift with every future redesign. The numbers below are
// commented with their source so a change to the screen that moves a block
// is a change that has to be made here too.
//
// THE SWEEP, TOP TO BOTTOM. Every plate is a `Shimmer` and one `ShimmerSweep`
// drives the lot, so the band walks DOWN the page — banner, identity, synopsis,
// actions, tabs, rows — in the order the content arrives. A UI-thread translate,
// no JS work per frame, reduced-motion aware. See `components/ui/Shimmer.tsx`
// for why that is affordable here when a pulsing skeleton would not be.

import { StyleSheet, View } from 'react-native';

import { useTheme } from '@/lib/ui/useTheme';
import { layout, radii, spacing } from '@/lib/ui/tokens';
import { Shimmer, ShimmerSweep } from '@/components/ui/Shimmer';

/** `app/anime/[id].tsx` → BANNER_H. */
const BANNER_H = 216;
/** `app/anime/[id].tsx` → POSTER_W; the height is its 2:3 ratio. */
const POSTER_W = 150;
/** `app/anime/[id].tsx` → POSTER_OVERLAP — how much of the poster hangs
 *  over the banner's bottom edge. */
const POSTER_OVERLAP = 0.38;
/** `app/anime/[id].tsx` → watchBtn height. */
const WATCH_H = 50;
/** `components/anime/EpisodeRow.tsx` → thumb width. */
const THUMB_W = 118;
/** `app/anime/[id].tsx` → EpisodeRow's vertical margin (spacing.xs + 2). */
const ROW_GAP = spacing.xs + 2;

/** How many episode rows the placeholder shows. Three fills a small screen
 *  without pretending to be a result set. */
const EPISODE_ROWS = 3;

/**
 * THE WAVE'S SHAPE, TOP TO BOTTOM.
 *
 * `LEAD` is what each block costs the next one, so the band descends the page
 * instead of every block flaring on the same frame. It is not uniform on
 * purpose: a synopsis line and an episode row are the same height but the row
 * follows a whole tab strip and a search field, so it starts further down.
 * `SPAN` is the largest offset anything below asks for — see `ShimmerSweep` on
 * why the cycle has to be the maximum rather than an estimate.
 */
const LEAD = 0.16;
/** The banner's block, and the identity under it, are one visual moment. */
const IDENTITY_LEAD = 0.1;
const SYNOPSIS_LEAD = 0.3;
const ACTIONS_LEAD = 0.5;
const TABS_LEAD = 0.66;
const SEARCH_LEAD = 0.78;
const ROW_LEAD = 0.86;
/**
 * The cycle, and it has to be the LARGEST offset anything below asks for —
 * which is the LAST row's meta line, not the last row's thumb. A `span` short of
 * that does not look wrong; it looks like the bottom of the page simply never
 * lights up, because that plate's window opens after the clock has looped.
 */
const SPAN = ROW_LEAD + (EPISODE_ROWS - 1) * LEAD + LEAD * 2;

export function DetailSkeleton({ insetTop = 0 }: { insetTop?: number }) {
  const { color } = useTheme();
  const plate = color.bg.elevated;
  const line = color.bg.surface;

  return (
    <ShimmerSweep span={SPAN}>
    <View style={styles.page} accessibilityRole="progressbar" accessibilityLabel="Loading">
      {/* ------- Banner (real: 216 tall, art behind a scrim) ------- */}
      <View style={styles.banner}>
        <Shimmer plate={line} radius={0} style={StyleSheet.absoluteFill} at={0} />
        {/* The back button is chrome, not content — a quiet static plate at
            the real button's box (40×40, left gutter, below the notch), so
            the page's affordances read as present while it loads. */}
        <View style={[styles.back, { top: insetTop + spacing.sm }]} />
      </View>

      {/* ------- Identity, centered, poster half over the banner ------- */}
      <View style={styles.identity}>
        <Shimmer plate={line} radius={radii.xl} style={styles.poster} at={IDENTITY_LEAD} />
        <Shimmer plate={plate} radius={6} style={styles.kicker} at={IDENTITY_LEAD + LEAD} />
        <Shimmer plate={line} radius={6} style={styles.titleA} at={IDENTITY_LEAD + LEAD * 2} />
        <Shimmer plate={line} radius={6} style={styles.titleB} at={IDENTITY_LEAD + LEAD * 3} />
      </View>

      {/* ------- Synopsis ------- */}
      <View style={styles.synopsis}>
        <Shimmer plate={plate} radius={6} style={styles.synA} at={SYNOPSIS_LEAD} />
        <Shimmer plate={plate} radius={6} style={styles.synB} at={SYNOPSIS_LEAD + LEAD} />
        <Shimmer plate={plate} radius={6} style={styles.synC} at={SYNOPSIS_LEAD + LEAD * 2} />
      </View>

      {/* ------- Actions: full-width pill + the two round buttons ------- */}
      <View style={styles.actions}>
        <Shimmer plate={line} radius={radii.full} style={styles.watch} at={ACTIONS_LEAD} />
        <View style={styles.iconRow}>
          <Shimmer plate={plate} radius={radii.full} style={styles.roundBtn} at={ACTIONS_LEAD + LEAD} />
          <Shimmer plate={plate} radius={radii.full} style={styles.roundBtn} at={ACTIONS_LEAD + LEAD * 2} />
        </View>
      </View>

      {/* ------- Tab strip: the segmented pill under a hairline ------- */}
      <View style={styles.tabs}>
        <View style={[styles.tabTrack, { backgroundColor: plate }]}>
          <Shimmer plate={line} radius={radii.full} style={styles.tabActive} at={TABS_LEAD} />
        </View>
      </View>

      {/* ------- Episode search field, then the rows ------- */}
      <Shimmer plate={plate} radius={radii.full} style={styles.search} at={SEARCH_LEAD} />

      {Array.from({ length: EPISODE_ROWS }, (_, i) => (
        <View key={i} style={[styles.row, { backgroundColor: color.bg.surface, borderColor: color.border.muted }]}>
          <Shimmer plate={plate} radius={0} style={styles.thumb} at={ROW_LEAD + i * LEAD} />
          <View style={styles.rowBody}>
            <Shimmer plate={plate} radius={4} style={styles.rowTitle} at={ROW_LEAD + i * LEAD + LEAD} />
            <Shimmer plate={plate} radius={4} style={styles.rowMeta} at={ROW_LEAD + i * LEAD + LEAD * 2} />
          </View>
        </View>
      ))}
    </View>
    </ShimmerSweep>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1 },

  banner: {
    height: BANNER_H,
    // `app/anime/[id].tsx` paints its banner over the page colour.
    backgroundColor: '#0a0a0f',
  },
  back: {
    position: 'absolute',
    left: spacing.lg,
    width: 40,
    height: 40,
    borderRadius: radii.full,
    backgroundColor: 'rgba(0,0,0,0.35)',
  },

  identity: {
    alignItems: 'center',
    // -(POSTER_W × 1.5 × POSTER_OVERLAP), verbatim from the screen.
    marginTop: -(POSTER_W * (3 / 2) * POSTER_OVERLAP),
    paddingHorizontal: spacing.lg,
    gap: spacing.sm,
  },
  poster: {
    width: POSTER_W,
    height: POSTER_W * (3 / 2),
  },
  kicker: {
    width: 92,
    height: 12,
    marginTop: spacing.sm,
    alignSelf: 'center',
  },
  titleA: { width: '76%', height: 22, alignSelf: 'center' },
  titleB: { width: '48%', height: 22, alignSelf: 'center' },

  synopsis: {
    paddingHorizontal: spacing.xl,
    marginTop: spacing.md,
    alignItems: 'center',
    gap: 7,
  },
  synA: { width: '94%', height: 14 },
  synB: { width: '88%', height: 14 },
  synC: { width: '56%', height: 14 },

  actions: {
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    marginTop: spacing.lg,
    gap: spacing.md,
  },
  watch: { alignSelf: 'stretch', height: WATCH_H },
  iconRow: { flexDirection: 'row', gap: spacing.md },
  roundBtn: { width: 46, height: 46 },

  tabs: {
    marginTop: spacing.xl,
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(255,255,255,0.08)',
    paddingBottom: spacing.md,
  },
  tabTrack: {
    width: 232,
    height: 40,
    borderRadius: radii.full,
    padding: 3,
  },
  tabActive: { width: 74, height: 34, borderRadius: radii.full },

  search: {
    height: 44,
    marginHorizontal: spacing.lg,
    marginTop: spacing.md,
  },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: spacing.lg,
    marginVertical: ROW_GAP,
    borderRadius: radii.lg,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  thumb: {
    width: THUMB_W,
    aspectRatio: layout.bannerRatio,
  },
  rowBody: {
    flex: 1,
    justifyContent: 'center',
    gap: 7,
    paddingVertical: spacing.md,
    paddingLeft: spacing.md,
    paddingRight: spacing.sm,
  },
  rowTitle: { width: '62%', height: 13 },
  rowMeta: { width: '38%', height: 10 },
});
