// A home section for finished shows — "Recently completed" — a CHART, with
// each row coloured by its own show.
//
//   01  ╭────╮   Frieren: Beyond Journey's End    ╭──╮
//       │art │   2024 · TV · 28 EP                 │86│   ← score ring
//       ╰────╯   ─────────────────────────────────  ╰──╯
//   02  ╭────╮   another show…                     ╭──╮
//
// THE IDEA — "coloured like the poster": AniList ships a server-computed
// dominant colour per cover (`coverImage.color`) with the home query at no
// extra cost. The design lifts it to a readable accent (lib/ui/accent —
// arithmetic, no decode) and paints it in three places per row:
//
//   1. the hairline ring around the poster — each row is framed by its own
//      show's colour, which makes the list read as a chart of DIFFERENT
//      shows rather than a grey table,
//   2. the #1 rank numeral — the leader is literally tinted by its show,
//   3. the score ring on the right — the arc sweeps the score in the same
//      hue, so "how good" and "which show" share a colour.
//
// BACKDROP — a podium: the top 3 rows carry their banners, fading with
// rank. AniList ships bannerImage with the same query, so it costs nothing
// to KNOW about — but decoding fourteen 16:9s would be the old design's
// problem again. Three, with scrims that deepen down the podium, read as a
// chart: #1 gets the stage (plus its accent edge), 2–3 a whisper of art.
// The scrim is ONE compositor-level gradient (`experimental_backgroundImage`,
// supported in RN 0.86 — a paint pass, not a native view per stop). Rows 4+
// get a faint wash of their cover colour instead — hue without a decode.
//
// The ring is the row's one indulgence (react-native-svg, already in the
// dependency tree for the icons): two circles and a dash offset, drawn once,
// never animated. The brief for this section explicitly traded a little
// performance budget for looks — fourteen small SVGs is that trade, made
// deliberately, and still no gradients, no overlays, no text on art.
//
// LAYOUT — a fixed-height box with a half-row peek.
//
// The section is fourteen rows of chart, and fourteen rows at 116pt is a wall
// that pushes everything below it off the screen. The box is capped at 3.25
// rows: three whole rows read as a chart, and the sliver of the fourth says
// "there is more" the way a full row never can. The peek is the whole design —
// a scroll affordance that costs no chrome.
//
// The rows are mapped into a `ScrollView`, not a `FlatList`, for two reasons.
// The count is FIXED (the query caps the section at 14) and every row is
// FIXED-height, so windowing would buy nothing but a second, nested scroll
// axis — and React Native is right to warn that same-axis lists are a trap.
// A plain `ScrollView` carries the peek without the warning.
//
// The cost to be honest about: all fourteen rows are mounted, so fourteen
// `ScoreRing` sweeps start on mount rather than the ~4 the box shows. They are
// UI-thread `withTiming`s on one SVG circle each, staggered 90ms apart, so
// they overlap the page's own entry animation by up to ~1.2s. Acceptable, and
// if it ever shows up in a profile it is the `delay` on `ScoreRing`, not this
// box.

import { memo, useCallback } from 'react';
import { Image } from 'expo-image';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { RoundedPressable } from '@/components/ui/RoundedPressable';
import Svg, { Circle } from 'react-native-svg';


import { useTheme } from '@/lib/ui/useTheme';
import { font, layout, radii, spacing } from '@/lib/ui/tokens';
import { coverAccent } from '@/lib/ui/accent';
import { alpha } from '@/lib/ui/color';
import type { TileStyleKey } from '@/lib/settings/store';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { SectionLink } from '@/components/ui/SectionLink';
import { openListSheet, LIST_LONG_PRESS_MS } from '@/lib/list/listSheet';
import { mediaTitle, type MediaItem } from '@/lib/anilist';
import { formatLabel } from './format';

/** Poster is 2:3, so the row height is driven by it, not the other way round. */
const POSTER_W = 56;
const POSTER_H = POSTER_W / layout.posterRatio; // 84
const ROW_H = POSTER_H + spacing.lg * 2; // 116 — real air around the art

/** How much of the box the list occupies before it starts scrolling. */
const VISIBLE_ROWS = 3.25;
const BOX_H = Math.round(VISIBLE_ROWS * ROW_H); // 377

export function MediaListSection({
  title,
  items,
  onSelect,
  variant = 'framed',
  onSeeAll,
  seeAllLabel = 'See all',
}: {
  title: string;
  items: MediaItem[];
  onSelect: (media: MediaItem) => void;
  /** Tile design — the section adapts to match the rails beside it. */
  variant?: TileStyleKey;
  /**
   * Make the header's link real. Supplied by the CALLER rather than derived here,
   * because this component is used for two lists that have nothing to seed a
   * filter with: home's "Recently completed" (a status + sort the browse grid can
   * express) and explore's "Airing this week" (whatever the airing schedule
   * returned, which is not a filter at all). A component that guessed would get
   * one of the two wrong.
   *
   * Omit it and no link renders — which is the honest default for a section that
   * has nowhere to send you.
   */
  onSeeAll?: () => void;
  /** Label for that link. "See all" almost always; explore may want more. */
  seeAllLabel?: string;
}) {
  const { color } = useTheme();
  const framed = variant === 'framed';

  if (!items.length) return null;

  const last = items.length - 1;
  // Content height from the constants, not from measurement: rows are fixed
  // height, so the box can size itself before the first layout pass. A short
  // section shows in full and disables scrolling rather than framing a gap.
  const contentH = items.length * ROW_H;
  const scrollable = contentH > BOX_H;
  const boxH = Math.min(BOX_H, contentH);

  return (
    <View style={styles.wrap}>
      <SectionHeader
        title={title}
        trailing={onSeeAll ? <SectionLink label={seeAllLabel} onPress={onSeeAll} /> : null}
      />

      {/* The peek box: three rows and a sliver, capped at BOX_H. `ScrollView`
          and not `FlatList` — see LAYOUT at the top of the file.

          `key` goes straight on the row rather than on a wrapper `View`, so a
          section is fourteen extra views and not twenty-eight. The row is memo'd
          and every prop it takes is stable across re-renders — `media` is a
          cached object out of the query, `onSelect` is a `useCallback` at the
          screen, `rank` and `isLast` are primitives — so mapping them inline
          costs nothing and there is no `renderItem` identity to keep still. */}
      <View
        style={[
          styles.box,
          { height: boxH },
          framed
            ? { backgroundColor: color.bg.surface, borderColor: color.border.muted }
            : styles.boxClean,
        ]}
      >
        <ScrollView
          nestedScrollEnabled
          showsVerticalScrollIndicator={false}
          scrollEnabled={scrollable}
        >
          {items.map((m, i) => (
            <ChartRow
              key={m.id}
              media={m}
              rank={i + 1}
              isLast={i === last}
              onSelect={onSelect}
            />
          ))}
        </ScrollView>
      </View>
    </View>
  );
}

/**
 * The score ring. Track: a static circle in the row's hairline colour. Arc: the
 * show's accent, drawn to its score's share of the circumference.
 *
 * THE ARC IS STATIC AND THAT IS NOT A SHORTCUT — it is the only version that
 * renders. This animated `strokeDashoffset` on an `Animated.createAnimated
 * Component(Circle)`, which worked under Reanimated 3 and is inert under
 * Reanimated 4: SVG prop animation sits behind the
 * `EXPERIMENTAL_CSS_ANIMATIONS_FOR_SVG_COMPONENTS` flag, and every config under
 * `react-native-reanimated/src/css/svg/` is web-only. On a device the animated
 * prop simply never landed, so the ring drew whatever the un-animated default is —
 * which is why it read as empty or malformed rather than as an unfinished
 * animation.
 *
 * `strokeDasharray` is the whole of the arc and needs no animation at all: it is a
 * string computed from the score before the first render. The details page's own
 * `ScoreRing` has always done it this way, with the same `rotate(-90)` string
 * transform, and is the proof that this shape renders on this SDK.
 *
 * `{c * frac}  c` — an arc of `c * frac` then a gap of the FULL circumference.
 * That gap is what stops the dash wrapping and painting a second arc on the far
 * side, which is exactly what a `dasharray` of `c` alone produces at low scores.
 *
 * WHAT WAS LOST, honestly: the sweep that filled the chart top-down on mount,
 * staggered by rank, and then the staggered fade that replaced it. Both are gone
 * entirely, and nothing replaced them.
 *
 * The fade was tried as a compromise — opacity on a VIEW rather than a prop on an
 * SVG element, which Reanimated 4 does animate. It was wrong, because it made the
 * ring's visibility DEPEND on an animation completing: the wrapper started at
 * `opacity: 0`, and on a screen where these rows mount inside a virtualised parent
 * that is not something to take on trust. When it did not run, the number rendered
 * correctly inside a ring that was not there at all — which is worse than never
 * animating, because the failure looks like missing content rather than a missing
 * effect.
 *
 * So the ring is now static on the frame it mounts, which is correct by
 * construction. The cost is real: fourteen numbers no longer fill top-down, and
 * that was this section's signature. It bought nothing that survived contact with
 * a device.
 */
function ScoreRing({
  pct,
  accent,
  track,
  label,
  textColor,
  delay,
}: {
  pct: number;
  accent: string;
  track: string;
  label: string;
  textColor: string;
  delay: number;
}) {
  const SIZE = 42;
  const STROKE = 3;
  const r = (SIZE - STROKE * 2) / 2;
  const c = 2 * Math.PI * r;
  const frac = Math.max(0, Math.min(1, pct));

  // `delay` is ACCEPTED AND IGNORED. It used to stagger a fade-in, which is the
  // only thing that could ever have made this ring invisible: the wrapper started
  // at `opacity: 0` and depended on a `withDelay`ed `withTiming` actually
  // completing for it to become visible at all. If that animation did not run —
  // and on a screen where these rows mount inside a virtualised parent it is not
  // something to take on trust — the ring stayed at zero opacity, which is a
  // number rendering correctly and a ring that is simply not there.
  //
  // The arc itself never needed an animation: `strokeDasharray` is computed from
  // the score before the first render, and it is correct on the frame the row
  // mounts. A stagger was decoration on top of that, and it was decoration that
  // could take the content away. Gone.
  void delay;

  return (
    <View style={styles.ring} accessible accessibilityLabel={`${label} score`}>
      <Svg width={SIZE} height={SIZE}>
        <Circle cx={SIZE / 2} cy={SIZE / 2} r={r} stroke={track} strokeWidth={STROKE} fill="none" />
        <Circle
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={r}
          stroke={accent}
          strokeWidth={STROKE}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={`${c * frac} ${c}`}
          transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
        />
      </Svg>
      <Text style={[styles.ringText, { color: textColor }]}>{label}</Text>
    </View>
  );
}

/**
 * THE CHART ROW — ranked, with a score ring and a banner backdrop on the podium.
 *
 * NAMED `ChartRow`, not `MediaRow`, and that rename is not cosmetic.
 * `components/anime/MediaRow.tsx` is a search-result row — different component,
 * different file, also pressable, also a "media row". When long-press-to-edit went
 * on every tile in the app it was added to the one in `MediaRow.tsx`, and this
 * one was missed: two components with the same name in two files, and the one
 * that looked like "the row in a list of anime" was the other one.
 */
const ChartRow = memo(function ChartRow({
  media,
  rank,
  onSelect,
  isLast,
}: {
  media: MediaItem;
  rank: number;
  onSelect: (media: MediaItem) => void;
  isLast: boolean;
}) {
  const { color } = useTheme();
  const title = mediaTitle(media.title);
  /**
   * THE CHART'S POSTER, and the cheapest place in the app to get image sizing
   * right because the row is tiny.
   *
   * Measured against AniList's CDN: `coverImage.extraLarge` serves 460x640 at
   * ~478KB, `coverImage.large` serves 230x320 at ~137KB, and `medium` is 100x139.
   * This row draws the cover at POSTER_W = 56dp, so even a 3x screen needs 168px
   * — which `large` covers at 1.37x. Asking for `extraLarge` here was paying 3.5x
   * the bytes for 2.7x the pixels the row has nowhere to show. It is also the only
   * poster in the app with three composited layers over it (banner backdrop,
   * directional scrim, accent edge), so nobody was ever grading its pixels.
   *
   * `large` FIRST with `extraLarge` as the fallback, not the reverse: `large` is
   * non-optional in the type, so it is always present, and it is always the
   * smaller of the two files.
   */
  const uri = media.coverImage?.large ?? media.coverImage?.extraLarge;
  // This row's identity colour — the show's own cover hue, lifted to a
  // readable accent. Falls back to the app's neutral accent when AniList
  // has not indexed a colour for the cover.
  const accent = coverAccent(media.coverImage?.color);
  // The chart's hierarchy: #1 leads, the field recedes. A colour change is
  // the cheapest emphasis there is — no extra view, no icon.
  const lead = rank === 1;
  // The podium. Top 3 decode a backdrop, fading with rank — see BACKDROP.
  // Banner first, poster as fallback: not every show has a banner indexed,
  // and the podium should never show a colour-washed gap. A portrait cover
  // stretched across the row still reads through the deep scrim, and the
  // sharp 2:3 art sits right beside it anyway.
  const backdrop =
    rank <= 3 ? (media.bannerImage ?? uri) ?? null : null;
  const meta = [
    media.seasonYear ? String(media.seasonYear) : null,
    formatLabel(media.format),
    media.episodes ? `${media.episodes} EP` : null,
  ]
    .filter(Boolean)
    .join('  ·  ');

  // Stable handler INSIDE the memo'd row: an arrow built in the parent would
  // be fresh per render and re-render all fourteen rows on every section
  // update. `onSelect` is stable (see PosterCard's note), `media` is a
  // cached object — this useCallback holds.
  const press = useCallback(() => onSelect(media), [onSelect, media]);

  return (
    <RoundedPressable
      onPress={press}
      // Hold to edit the list, exactly as a poster tile does — see PosterCard's
      // note for the gesture and for why `onPress` needs no guard.
      //
      // This row is NOT `components/anime/MediaRow.tsx`. That file is a search
      // result row; this one is the ranked chart row, local to this file, and it
      // was the one that got missed when long-press went on everywhere — two
      // components with the same name, in different files, both pressable, both
      // looking like "the media row". Hence the rename below.
      onLongPress={() => openListSheet(media)}
      delayLongPress={LIST_LONG_PRESS_MS}
      accessibilityRole="button"
      accessibilityLabel={`Number ${rank}, ${title}`}
      radius={10}
      tint={color.accent.glow}
      style={[
        styles.row,
        !isLast && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: color.border.muted },
      ]}
    >
      {/* BACKDROP LAYER — first child, so everything paints above it.
          leader: banner image + one compositor-gradient scrim. Field: a
          5% wash of the row's own cover colour, no image at all. */}
      {backdrop ? (
        <View style={styles.backdrop} pointerEvents="none">
          <Image
            source={{ uri: backdrop }}
            style={StyleSheet.absoluteFill}
            contentFit="cover"
            transition={250}
            cachePolicy="memory-disk"
            // Banner arrives at 16:9 but decodes to this row's box.
            allowDownscaling
          />
          {/* Dim + directional scrim in ONE paint, deepening down the
              podium: #1 shows its art, #2 and #3 breathe it — 3 only a
              touch quieter than 2, so both read as visible art rather than
              a tint. Built from the theme colour, so light theme dims
              toward white, not grey. */}
          <View
            style={[
              StyleSheet.absoluteFill,
              {
                experimental_backgroundImage: `linear-gradient(90deg, ${alpha(
                  color.bg.primary,
                  rank === 1 ? 0.88 : rank === 2 ? 0.94 : 0.95
                )} 0%, ${alpha(color.bg.primary, rank === 1 ? 0.55 : rank === 2 ? 0.8 : 0.83)} 55%, ${alpha(
                  color.bg.primary,
                  rank === 1 ? 0.35 : rank === 2 ? 0.7 : 0.74
                )} 100%)`,
              },
            ]}
          />
          {/* Hairline in the show's colour, marking the banner's bottom edge —
              the accent the row already wears, echoed where art meets list.
              Leader only: on 2–3 it would dilute the podium's hierarchy. */}
          {lead ? (
            <View
              style={[styles.backdropEdge, { backgroundColor: accent }]}
              pointerEvents="none"
            />
          ) : null}
        </View>
      ) : (
        // Field rows: a wash, not an image. alpha() of the lifted accent at
        // 5% is visible on the page/surface in BOTH themes without ever
        // competing with text — hue from the cache, zero decodes.
        <View
          style={[styles.backdrop, { backgroundColor: alpha(accent, 0.05) }]}
          pointerEvents="none"
        />
      )}

      <Text style={[styles.rank, { color: lead ? accent : color.text.muted }]}>
        {String(rank).padStart(2, '0')}
      </Text>

      {/* The poster wears its show's colour as a ring. A washed 2px fill
          under a 1px stroke keeps the ring visible on both light and dark
          art without becoming a heavy border. */}
      <View
        style={[
          styles.art,
          { backgroundColor: color.bg.elevated, borderColor: alpha(accent, 0.55) },
        ]}
      >
        {uri ? (
          <Image
            source={{ uri }}
            style={StyleSheet.absoluteFill}
            contentFit="cover"
            transition={200}
            cachePolicy="memory-disk"
            allowDownscaling
          />
        ) : null}
      </View>

      <View style={styles.body}>
        <Text style={[styles.title, { color: color.text.primary }]} numberOfLines={1}>
          {title}
        </Text>
        {meta ? (
          <Text style={[styles.meta, { color: color.text.muted }]} numberOfLines={1}>
            {meta}
          </Text>
        ) : null}
      </View>

      {media.averageScore != null ? (
        <ScoreRing
          pct={media.averageScore / 100}
          accent={accent}
          track={color.border.strong}
          label={String(Math.round(media.averageScore))}
          textColor={color.text.primary}
          delay={(rank - 1) * 90}
        />
      ) : (
        <View style={styles.ringPlaceholder} />
      )}
    </RoundedPressable>
  );
});

const styles = StyleSheet.create({
  wrap: {
    marginTop: spacing.xxl,
  },
  // Radius matches the tile family's body. `overflow: hidden` is what rounds
  // the corners of the first row's artwork and CLIPS the fourth — the peek is
  // a slice of a row, so the box has to cut it rather than let it hang out.
  box: {
    marginHorizontal: layout.gutter,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  // Clean: no box — rows sit straight on the page like the bare posters do.
  boxClean: {
    backgroundColor: 'transparent',
    borderWidth: 0,
  },
  row: {
    height: ROW_H,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingLeft: spacing.md,
    paddingRight: spacing.lg,
    // Backdrop layers position against the row box.
    overflow: 'hidden',
  },
  backdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  backdropEdge: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: 2,
  },
  // The editorial mark: big, bold, zero-padded, fixed width so the poster
  // column never moves. #1 is tinted by its own show's accent.
  rank: {
    width: 30,
    fontSize: 22,
    lineHeight: 26,
    fontFamily: font.bold,
    fontVariant: ['tabular-nums'],
    letterSpacing: -0.5,
  },
  art: {
    width: POSTER_W,
    height: POSTER_H,
    borderRadius: radii.sm,
    borderWidth: 1.5,
    overflow: 'hidden',
  },
  body: {
    flex: 1,
    minWidth: 0,
    gap: 4,
  },
  title: {
    fontSize: 14,
    fontFamily: font.semibold,
    lineHeight: 18,
  },
  meta: {
    fontSize: 11.5,
    lineHeight: 15,
    fontFamily: font.regular,
  },
  ring: {
    width: 42,
    height: 42,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ringText: {
    position: 'absolute',
    fontSize: 12,
    fontFamily: font.bold,
    fontVariant: ['tabular-nums'],
  },
  // Keeps rows without a score the same height as rows with one.
  ringPlaceholder: {
    width: 42,
    height: 42,
  },
});
