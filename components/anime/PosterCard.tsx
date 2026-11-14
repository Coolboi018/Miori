// Poster tile — the one card every rail uses: home sections, continue
// watching, the detail page's relations and recommendations.
//
// TWO VARIANTS, chosen by the `variant` prop (the home.tileStyle setting):
//
//   'framed' — a "framed print". The poster sits INSIDE a quiet surface
//   card, inset like a print in a mat, with the caption on the card body:
//
//     ┌────────────────┐  ← surface body (bg.surface, hairline frame)
//     │ ┌──────────┐   │  ← art on a cover-tinted plate — NOTHING on top
//     │ │  poster  │   │
//     │ └──────────┘   │
//     │ ▁▁▁▁▁▁▂▂▂      │  ← progress bar, only when a rail carries progress
//     │ Title          │  ← caption on the surface, never on the art
//     │ 2024 · TV · 86%│
//     └────────────────┘
//
//   'clean' — no container AT ALL. The poster is its own touchable, the
//   caption is a plain element after it, directly on the page:
//
//     ┌──────────┐       ← the Pressable IS the poster. Full radius, plate
//     │  poster  │          behind the art while it loads, ripple clipped
//     └──────────┘          to the poster's own rounded shape
//     ▁▁▁▁▁▁▂▂▂           ← progress bar on the page, under the art
//     Title              ← caption on the page background — never inside a
//     2024 · TV · 86%       view with a radius, never under the ripple
//
//   The clean structure exists because the first cut wrapped everything in
//   one Pressable with `overflow: 'hidden'` and a radius, which (a) clipped
//   the caption into a rounded box the design never asked for and (b) put
//   the hold-ripple under the text. In clean the touchable is exactly
//   poster-sized: tap the text and nothing happens, long-press the poster
//   and the ripple hugs the poster's corners.
//
// NOTHING RENDERS OVER THE POSTER in either variant. An earlier revision put
// score chips and rank badges on the art; that is off the table — this
// screen mounts ~80 tiles at once on low-end phones, and every overlay is
// more views to composite per frame. Score lives in the caption's meta line
// (plain text, the cheapest view there is).
//
// PERFORMANCE CONTRACT:
//   - NO `elevation` / `shadow*`. Android generates an outline and a shadow
//     pass per shadowed view; 80 of those is a dropped-frame count, not a
//     look. The hairline frame (framed) or the page gap (clean) does the
//     separating instead.
//   - NO blur, NO per-card LinearGradient, NO overlay chips.
//   - The cover plate is arithmetic (`coverPlate`), not a decoded palette.
//   - Framework-drawn press feedback only: native Android ripple, opacity
//     dip on iOS — never a JS-driven animation.
//
// `onPress` takes the media rather than being a per-card arrow: with an
// inline `() => onSelect(m)` the `memo` below never fires, so every re-render
// of the rail re-rendered all fourteen cards.

import { Image } from 'expo-image';
import { memo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { coverPlate } from '@/lib/ui/accent';
import { useTheme } from '@/lib/ui/useTheme';
import { font, layout, radii } from '@/lib/ui/tokens';
import { prefetchAnime, prefetchEpisodes } from '@/lib/query/prefetch';
import type { TileStyleKey } from '@/lib/settings/store';
import { scoreDisplay, formatLabel } from './format';
import { mediaTitle, type MediaItem } from '@/lib/anilist';
import { openListSheet, LIST_LONG_PRESS_MS } from '@/lib/list/listSheet';

export const PosterCard = memo(function PosterCard({
  media,
  onPress,
  /** Small caps kicker above the title — "ANIME", "MANGA", etc. */
  kicker,
  /** Support line in the caption — "EP 4/12" for continue watching. */
  meta,
  /**
   * Watched-episode count. Renders the thin progress bar between the art and
   * the caption; the total comes from `media.episodes`. Continue watching is
   * the only caller — everything else leaves it off and the bar never mounts.
   */
  progress,
  /** Tile design. Default matches the original shipped look. */
  variant = 'framed',
  width = 124,
}: {
  media: MediaItem;
  /** Pass the handler itself, not an arrow: memo depends on it being stable. */
  onPress: (media: MediaItem) => void;
  kicker?: string | null;
  meta?: string | null;
  progress?: number | null;
  variant?: TileStyleKey;
  width?: number;
}) {
  const { color } = useTheme();
  const framed = variant === 'framed';
  const title = mediaTitle(media.title);
  /**
   * `coverImage.large` — 230x320, ~137KB. Measured on AniList's CDN against the
   * `extraLarge` this used to ask for: 460x640, ~478KB.
   *
   * A tile is 124dp wide, so this is 1.85x its width even on a 2x screen and is
   * the largest cover AniList serves below the 460px tier. Every rail on home,
   * every grid on explore and every result on search goes through here, so this
   * one line is the difference between ~5.7MB and ~20MB of posters on a first
   * home screen. `large` is non-optional in the type, so it is always present;
   * `extraLarge` stays as the fallback for a response that somehow lacks it.
   */
  const uri = media.coverImage?.large ?? media.coverImage?.extraLarge;
  // The plate mixes the cover colour towards what the art sits on: the CARD
  // surface in framed, the PAGE itself in clean. Arithmetic, no decode.
  const plate =
    coverPlate(media.coverImage?.color, framed ? color.bg.surface : color.bg.primary) ??
    (framed ? color.bg.elevated : color.bg.surface);
  // Score joins the meta line as text — free, and legible on the surface
  // where an overlay chip would have needed a scrim.
  // The dot: a STATUS LIGHT, not decoration. Green = airing now, blue =
  // not yet aired, grey = finished (and the quiet ends: cancelled, hiatus).
  // Uses the palette's meaning-named status colours, so it tracks the theme.
  const dotColor =
    media.status === 'RELEASING'
      ? color.status.success
      : media.status === 'NOT_YET_RELEASED'
        ? color.status.info
        : color.text.muted;
  // Caption tail: the score when there is one — and when there isn't
  // (upcoming shows), the FORMAT ("TV", "Movie"…) so the line never goes
  // empty and every tile in a rail keeps the same caption height. The dot
  // always leads; the tail is whatever this show can say.
  const metaLine = [
    meta,
    media.averageScore != null
      ? scoreDisplay(media.averageScore)
      : formatLabel(media.format),
  ]
    .filter(Boolean)
    .join('  ·  ');
  const total = media.episodes ?? null;
  const pct = progress != null && total ? Math.min(1, progress / total) : 0;
  const showProgress = progress != null;

  // ------------------------------------------------------------------
  // CLEAN — poster and caption as SIBLINGS, the touchable is the poster.
  // ------------------------------------------------------------------
  if (!framed) {
    return (
      <View style={{ width }}>
        <Pressable
          onPress={() => onPress(media)}
          // WARM ON TOUCH-DOWN, not on press. Every card here opens the detail
          // screen, and the finger lands ~80–150ms before the lift — which is
          // a head start on the payload's round-trip, not a speculative one:
          // the user is already going there. React Query dedups this with the
          // screen's own `prefetchAnime` (same key), so a clean lift costs
          // nothing extra; a cancelled touch costs one warm request for the
          // screen the thumb was on its way to.
          onPressIn={() => {
            prefetchAnime(media.id);
            prefetchEpisodes(media.id);
          }}
          // HOLD TO EDIT THE LIST. Long-press is the gesture every media app uses
          // for "add to list" precisely because tap is already spoken for: it
          // costs no horizontal space, cannot be hit by accident on the way to
          // opening a title, and leaves the tile's only other job untouched.
          //
          // No `onPress` guard is needed. React Native suppresses the press itself
          // once a long press has fired — `Pressability` computes
          // `isPressCanceledByLongPress` and skips `onPress` — so holding a tile
          // opens the editor without also navigating.
          onLongPress={() => openListSheet(media)}
          delayLongPress={LIST_LONG_PRESS_MS}
          accessibilityRole="button"
          accessibilityLabel={title}
          // `borderless: false` bounds the ripple to this view's rounded
          // shape — the poster's — rather than the whole column.
          android_ripple={{ color: color.accent.glow, borderless: false }}
          style={({ pressed }) => [styles.cleanArt, pressed ? styles.pressed : null]}
        >
          {/* The art well IS the touch target: full tile radius, ripple
              clipped by its own overflow, nothing else in here. */}
          <View style={[styles.art, styles.artClean, { backgroundColor: plate }]}>
            {uri ? (
              <Image
                source={{ uri }}
                style={StyleSheet.absoluteFill}
                contentFit="cover"
                transition={200}
                cachePolicy="memory-disk"
                // Decoded at the tile's size, not AniList's 460×648 —
                // off, and 80 tiles cost ~65MB of bitmaps.
                allowDownscaling
              />
            ) : null}
          </View>
        </Pressable>

        {showProgress ? (
          <View style={[styles.progressClean, { backgroundColor: color.accent.muted }]}>
            <View
              style={[
                styles.progressFill,
                { width: `${Math.round(pct * 100)}%`, backgroundColor: color.text.primary },
              ]}
            />
          </View>
        ) : null}

        {kicker ? (
          <Text style={[styles.kicker, styles.cleanKicker, { color: color.text.muted }]} numberOfLines={1}>
            {kicker}
          </Text>
        ) : null}
        <Text
          style={[styles.title, styles.cleanTitle, kicker ? null : styles.cleanTitleFirst, { color: color.text.primary }]}
          numberOfLines={1}
        >
          {title}
        </Text>
        {/* The lamp renders ALWAYS — an upcoming show has no score and often
            no year/format, and its blue dot must not vanish with them. */}
        <View style={[styles.metaRow, styles.cleanMeta, { gap: 5 }]}>
          <View style={[styles.metaDot, { backgroundColor: dotColor }]} />
          {metaLine ? (
            <Text style={[styles.meta, { color: color.text.muted }]} numberOfLines={1}>
              {metaLine}
            </Text>
          ) : null}
        </View>
      </View>
    );
  }

  // ------------------------------------------------------------------
  // FRAMED — one card, art inset in it, caption on the card body.
  // ------------------------------------------------------------------
  return (
    <Pressable
      onPress={() => onPress(media)}
      // Warm the detail payload on touch-down — see the clean variant's note.
      onPressIn={() => {
            prefetchAnime(media.id);
            prefetchEpisodes(media.id);
          }}
          // HOLD TO EDIT THE LIST. Long-press is the gesture every media app uses
          // for "add to list" precisely because tap is already spoken for: it
          // costs no horizontal space, cannot be hit by accident on the way to
          // opening a title, and leaves the tile's only other job untouched.
          //
          // No `onPress` guard is needed. React Native suppresses the press itself
          // once a long press has fired — `Pressability` computes
          // `isPressCanceledByLongPress` and skips `onPress` — so holding a tile
          // opens the editor without also navigating.
          onLongPress={() => openListSheet(media)}
          delayLongPress={LIST_LONG_PRESS_MS}
      accessibilityRole="button"
      accessibilityLabel={title}
      // Framework-drawn, so press feedback never waits on the JS thread —
      // the thread that is busy decoding posters while you tap.
      android_ripple={{ color: color.accent.glow, foreground: true }}
      // The card body IS the Pressable: surface, hairline frame and the
      // ripple mask are one view. At 80 mounted tiles this is the tile's
      // native-view budget — art well and caption are its only children.
      style={({ pressed }) => [
        styles.card,
        {
          width,
          backgroundColor: color.bg.surface,
          borderColor: color.border.muted,
        },
        pressed ? styles.pressed : null,
      ]}
    >
      {/* The art well: inset by the card's 4px padding. Radius follows the
          body inset so the two curves stay concentric (10 - 4 = 6). */}
      <View style={[styles.art, styles.artFramed, { backgroundColor: plate }]}>
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

      {showProgress ? (
        <View style={[styles.progress, { backgroundColor: color.accent.muted }]}>
          <View
            style={[styles.progressFill, { width: `${Math.round(pct * 100)}%`, backgroundColor: color.text.primary }]}
          />
        </View>
      ) : null}

      <View style={styles.caption}>
        {kicker ? (
          <Text style={[styles.kicker, { color: color.text.muted }]} numberOfLines={1}>
            {kicker}
          </Text>
        ) : null}
        <Text
          style={[styles.title, kicker ? styles.titleTight : null, { color: color.text.primary }]}
          numberOfLines={1}
        >
          {title}
        </Text>
        {/* Same as clean: the lamp is unconditional. It sits at the START of
            the caption line, before whatever meta exists — for an upcoming
            show it stands alone, which is the blue dot the rail needs. */}
        <View style={styles.metaRow}>
          <View style={[styles.metaDot, { backgroundColor: dotColor }]} />
          {metaLine ? (
            <Text style={[styles.meta, { color: color.text.muted }]} numberOfLines={1}>
              {metaLine}
            </Text>
          ) : null}
        </View>
      </View>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  // ---- shared ----
  // iOS has no ripple, so the art dims on press. Android gets the ripple
  // from `android_ripple` on top of this.
  pressed: {
    opacity: 0.85,
  },
  art: {
    aspectRatio: layout.posterRatio,
    overflow: 'hidden',
  },
  // Framed: radius 6 inside the card's 10 (body 10 - 4px padding), so the
  // curves stay concentric. Clean overrides with artClean below.
  artFramed: {
    borderRadius: radii.sm,
  },

  // ---- FRAMED ----
  // The tile's whole box: surface fill, hairline frame, ripple mask. One
  // view for all three. `overflow` + radius clip the ripple to the card.
  card: {
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 4,
    overflow: 'hidden',
  },
  progress: {
    height: 3,
    borderRadius: radii.full,
    overflow: 'hidden',
    marginTop: 6,
    marginHorizontal: 2,
  },
  progressFill: {
    height: '100%',
    borderRadius: radii.full,
  },
  // The card already pads 4; the caption adds its own inside that. Net mat
  // around the text is 13px on the outer edge, 8px below the art.
  caption: {
    paddingHorizontal: 9,
    paddingTop: 7,
    paddingBottom: 9,
  },
  kicker: {
    fontSize: 9.5,
    lineHeight: 12,
    fontFamily: font.semibold,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  title: {
    fontSize: 12.5,
    fontFamily: font.semibold,
    lineHeight: 16,
    letterSpacing: -0.1,
    marginTop: 2,
  },
  // With a kicker present the label already carries the gap.
  titleTight: {
    marginTop: 2,
  },
  // Status-light meta line. 7px — a 5px dot at caption size was easy to
  // miss; a 7px lamp beside 10.5px text reads at arm's length.
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 2,
  },
  metaDot: {
    width: 7,
    height: 7,
    borderRadius: radii.full,
  },
  meta: {
    flexShrink: 1,
    fontSize: 10.5,
    lineHeight: 13,
    fontFamily: font.medium,
  },

  // ---- CLEAN ----
  // The Pressable is exactly the poster: no fill, no border, no padding,
  // no caption inside it. Its radius + overflow are what clip the ripple.
  cleanArt: {
    borderRadius: 12,
    overflow: 'hidden',
  },
  // Same radius as the wrapper — one shape, one clip.
  artClean: {
    borderRadius: 12,
  },
  // Bar spans the poster's width, a touch of air above it.
  progressClean: {
    height: 3,
    borderRadius: radii.full,
    overflow: 'hidden',
    marginTop: 8,
  },
  cleanKicker: {
    marginTop: 8,
  },
  // First text under the poster with no kicker: 8px air, no card padding.
  cleanTitleFirst: {
    marginTop: 8,
  },
  cleanTitle: {
    marginTop: 0,
  },
  cleanMeta: {
    marginTop: 3,
  },
});
