// The BANNER card — 16:9 key art with the caption ON the art, and the reason
// the explore screen does not look like home with the scroll position changed.
//
// WHY A DIFFERENT TILE EXISTS. Every tile on home is a 2:3 portrait poster with
// the caption below it and nothing drawn over the artwork. That rule is right
// for 80 small tiles (an overlay is a view per tile, and this app is built for
// low-end phones) and wrong for a Browse page, which has six large tiles per
// screen where an overlay costs nothing and buys the whole magazine look. A
// wall of posters is a phone gallery; a wall of banners is a streaming service.
//
// THE SCRIM IS ONE PAINT, NOT A GRADIENT VIEW. `experimental_backgroundImage`
// is a compositor-level `linear-gradient` (RN 0.86), the same trick
// `MediaListSection` uses for its podium backdrops. A `LinearGradient` view
// here would be a native view per card, and this tile lives inside a rail the
// user can fling a dozen of past at once.
//
// THE ACCENT LINE. Two pixels in the show's own cover colour along the bottom
// edge — the same lifted hue the hero's pagination dot and the chart's score
// ring use. One colour language across three components: "this tile is about
// THIS show", not "this tile is a link".
//
// FALLBACK. Not every show has a banner indexed. The portrait cover is used
// instead and centre-cropped: it reads as art through the scrim, and the sharp
// 2:3 poster beside it in the rail is the confirmation.

import { memo } from 'react';
import { Image } from 'expo-image';
import { StyleSheet, Text, View } from 'react-native';
import { RoundedPressable } from '@/components/ui/RoundedPressable';
import { useTheme } from '@/lib/ui/useTheme';
import { alpha } from '@/lib/ui/color';
import { coverAccent, coverPlate } from '@/lib/ui/accent';
import { font, radii, spacing } from '@/lib/ui/tokens';
import { mediaTitle, type MediaItem } from '@/lib/anilist';
import { openListSheet, LIST_LONG_PRESS_MS } from '@/lib/list/listSheet';
import { formatLabel, scoreDisplay } from './format';

/** 16:9 key art. */
const BANNER_RATIO = 16 / 9;
/** Enough room for a kicker, two title lines and a meta line, with air. */
export const BANNER_MIN_H = 128;

/** Banner height for a given width. Short cards cannot take a deep scrim. */
export function bannerHeight(width: number): number {
  return Math.max(BANNER_MIN_H, Math.round(width / BANNER_RATIO));
}

export const MediaBannerCard = memo(function MediaBannerCard({
  media,
  onPress,
  width,
  /** Small caps line above the title — "01 TRENDING", "SCI-FI", "FILM". */
  kicker,
  /** The section's feature tile: bigger type, a real hero. */
  emphasis = false,
}: {
  media: MediaItem;
  onPress: (media: MediaItem) => void;
  width: number;
  kicker?: string | null;
  emphasis?: boolean;
}) {
  const { color } = useTheme();
  const title = mediaTitle(media.title);
  /**
   * The COVER FALLBACK only — `art` below prefers the 1900x400 banner whenever the
   * title has one, which is the only large image this card ever shows.
   *
   * So this is `coverImage.large` (230x320, ~137KB) rather than `extraLarge`
   * (460x640, ~478KB), measured on AniList's CDN: the cover is the second-choice
   * art here, drawn at card width behind a plate colour, and it was paying 3.5x the
   * bytes for pixels the banner path never uses. `large` is non-optional in the type.
   */
  const cover = media.coverImage?.large ?? media.coverImage?.extraLarge;
  const art = media.bannerImage ?? cover;
  const accent = coverAccent(media.coverImage?.color);
  // Plate is the cover colour pulled TOWARDS the surface (accent.ts), so the
  // card never flashes a bright rectangle while the banner streams in.
  const plate = coverPlate(media.coverImage?.color, color.bg.surface) ?? color.bg.elevated;

  const height = bannerHeight(width);

  const meta = [
    media.seasonYear ? String(media.seasonYear) : null,
    formatLabel(media.format),
    media.averageScore != null ? scoreDisplay(media.averageScore) : null,
  ]
    .filter(Boolean)
    .join('  ·  ');

  // Same meaning-named status colours as the poster tile's lamp.
  const dotColor =
    media.status === 'RELEASING'
      ? color.status.success
      : media.status === 'NOT_YET_RELEASED'
        ? color.status.info
        : color.text.muted;

  return (
    <RoundedPressable
      onPress={() => onPress(media)}
      // Hold to edit the list — see PosterCard's note. `Pressability` suppresses
      // `onPress` once a long press has fired, so a held banner does not navigate.
      onLongPress={() => openListSheet(media)}
          delayLongPress={LIST_LONG_PRESS_MS}
      accessibilityRole="button"
      accessibilityLabel={title}
      radius={radii.lg}
      tint={alpha(color.text.primary, 0.14)}
      style={[
        styles.card,
        {
          width,
          height,
          backgroundColor: plate,
          borderColor: color.border.muted,
        },
      ]}
    >
      {art ? (
        <Image
          source={{ uri: art }}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
          contentPosition="center"
          transition={220}
          cachePolicy="memory-disk"
          // The banner arrives at 16:9 and decodes to THIS card's box, not to
          // AniList's full width — otherwise a rail of these is a memory leak
          // wearing a card's clothes.
          allowDownscaling
          priority={emphasis ? 'high' : 'normal'}
        />
      ) : null}

      {/* One paint: a top-down scrim, so the kicker and title win on ANY
          artwork without a second gradient view. */}
      <View
        pointerEvents="none"
        style={[
          StyleSheet.absoluteFill,
          {
            experimental_backgroundImage: `linear-gradient(180deg, ${alpha(
              color.bg.primary,
              0.12
            )} 0%, ${alpha(color.bg.primary, 0.5)} 40%, ${alpha(color.bg.primary, 0.93)} 100%)`,
          },
        ]}
      />

      <View style={styles.body}>
        {kicker ? (
          <Text style={[styles.kicker, { color: accent }]} numberOfLines={1}>
            {kicker}
          </Text>
        ) : null}

        <Text
          style={[styles.title, emphasis ? styles.titleEmphasis : null, { color: color.text.primary }]}
          numberOfLines={2}
        >
          {title}
        </Text>

        <View style={styles.metaRow}>
          <View style={[styles.dot, { backgroundColor: dotColor }]} />
          {meta ? (
            <Text style={[styles.meta, { color: color.text.secondary }]} numberOfLines={1}>
              {meta}
            </Text>
          ) : null}
        </View>
      </View>

      {/* The show's own colour, where art meets the card's edge. */}
      <View style={[styles.accentLine, { backgroundColor: accent }]} pointerEvents="none" />
    </RoundedPressable>
  );
});

const styles = StyleSheet.create({
  card: {
    borderRadius: radii.lg,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
    justifyContent: 'flex-end',
  },
  body: {
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.md - 1,
    gap: 3,
  },
  kicker: {
    fontSize: 9.5,
    lineHeight: 12,
    fontFamily: font.bold,
    letterSpacing: 1.1,
    textTransform: 'uppercase',
  },
  title: {
    fontSize: 14.5,
    lineHeight: 18,
    fontFamily: font.semibold,
    letterSpacing: -0.2,
  },
  titleEmphasis: {
    fontSize: 21,
    lineHeight: 26,
    fontFamily: font.bold,
    letterSpacing: -0.6,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    marginTop: 2,
  },
  dot: { width: 6, height: 6, borderRadius: radii.full },
  meta: {
    flexShrink: 1,
    fontSize: 11,
    lineHeight: 14,
    fontFamily: font.medium,
  },
  accentLine: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: 2,
  },
});
