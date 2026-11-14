// The "next up" card — the one thing a schedule screen is actually opened for.
//
//   ╭──────────────────────────────────────────────╮
//   │  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │  16:9 key art
//   │  NEXT UP                                     │  the show's own accent
//   │  ┌────┐ Frieren: Beyond Journey's End        │
//   │  │ ▢▢ │ EP 12 · 18:00 · in 2h 05m            │
//   │  └────┘                                      │
//   │  ▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔ │  2px, same hue
//   ╰──────────────────────────────────────────────╯
//
// WHY A HERO AND NOT JUST A HIGHLIGHTED ROW. `AiringRow` marks the next airing
// with an accent stripe, which is enough to FIND it in a list and useless for
// answering "is it tonight?" at a glance. This is the answer: one piece of art,
// one countdown, one title, above a list that is otherwise three hundred rows of
// the same shape. It is the only element on the screen that decodes a banner,
// and it is one element.
//
// THE SCRIM IS ONE PAINT. `experimental_backgroundImage` is a compositor-level
// `linear-gradient` in RN 0.86, the trick `MediaBannerCard` and
// `MediaListSection` both use. A `LinearGradient` view here would be a native
// view per card on a screen that mounts this once per data set — no measurable
// win for a gradient that has to be there for legibility anyway.
//
// BANNER FIRST, COVER SECOND. Exactly as `MediaBannerCard` falls back: not
// every show has a banner indexed, and a portrait cover centre-cropped behind
// the same scrim reads as art, with the sharp 2:3 poster sitting right beside
// it as the confirmation.
//
// THE COUNTDOWN LIVES IN THE META LINE and not in a corner badge, because the
// badge was where it went before and it read as a timer belonging to the card
// rather than to the episode. `in 2h 05m` next to `18:00` is the same fact twice
// in two registers, which is the point: one for planning, one for now.

import { Image } from 'expo-image';
import { memo, useCallback } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { AiringItem } from '@/lib/anilist/schedule';
import { mediaTitle } from '@/lib/anilist';
import { alpha } from '@/lib/ui/color';
import { coverAccent, coverPlate } from '@/lib/ui/accent';
import { useTheme } from '@/lib/ui/useTheme';
import { font, layout, radii, spacing } from '@/lib/ui/tokens';
import { clockTime, countdown, episodeLabel } from './format';
const POSTER_W = 34;
const POSTER_H = POSTER_W / layout.posterRatio; // 51

/** The slot, not the card — the gap above it is padding, for `getItemLayout`. */
export const NEXT_UP_HEIGHT = 140;

export interface NextUpCardProps {
  airing: AiringItem;
  now: number;
  /** Where it sits in the window, for the screen reader's benefit. */
  dayLabel: string;
  onPress: (item: AiringItem) => void;
}

export const NextUpCard = memo(function NextUpCard({
  airing,
  now,
  dayLabel,
  onPress,
}: NextUpCardProps) {
  const { color } = useTheme();
  const title = mediaTitle(airing.media.title);
  /**
   * `large` (230x320, ~137KB) rather than `extraLarge` (460x640, ~478KB) —
   * measured on AniList's CDN. At POSTER_W = 34dp a 3x screen needs 102px, so
   * `extraLarge` was paying 3.5x the bytes for 4.5x the pixels this thumbnail
   * cannot show. It is a FALLBACK anyway: `art` below prefers the 1900x400
   * banner, which is the only large image this card ever shows.
   */
  const cover = airing.media.coverImage?.large ?? airing.media.coverImage?.extraLarge;
  const art = airing.media.bannerImage ?? cover;
  const accent = coverAccent(airing.media.coverImage?.color);
  const plate = coverPlate(airing.media.coverImage?.color, color.bg.surface) ?? color.bg.elevated;

  const press = useCallback(() => onPress(airing), [onPress, airing]);

  return (
    <View style={styles.slot}>
      <Pressable
        onPress={press}
        accessibilityRole="button"
        accessibilityLabel={`Next up: ${title}, ${episodeLabel(airing.episode)}, ${dayLabel} at ${clockTime(
          airing.airingAt
        )}, ${countdown(airing.airingAt, now)}`}
        android_ripple={{ color: alpha(color.text.primary, 0.14), foreground: true }}
        style={({ pressed }) => [
          styles.card,
          {
            backgroundColor: plate,
            borderColor: color.border.muted,
            opacity: pressed ? 0.85 : 1,
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
            allowDownscaling
            priority="high"
          />
        ) : null}

        <View
          pointerEvents="none"
          style={[
            StyleSheet.absoluteFill,
            {
              experimental_backgroundImage: `linear-gradient(180deg, ${alpha(
                color.bg.primary,
                0.18
              )} 0%, ${alpha(color.bg.primary, 0.58)} 42%, ${alpha(color.bg.primary, 0.95)} 100%)`,
            },
          ]}
        />

        <View style={styles.body}>
          <Text style={[styles.kicker, { color: accent }]} numberOfLines={1}>
            Next up
          </Text>

          <View style={styles.row}>
            <View style={[styles.poster, { backgroundColor: plate, borderColor: alpha(accent, 0.55) }]}>
              {cover ? (
                <Image
                  source={{ uri: cover }}
                  style={StyleSheet.absoluteFill}
                  contentFit="cover"
                  transition={150}
                  cachePolicy="memory-disk"
                  allowDownscaling
                />
              ) : null}
            </View>

            <View style={styles.text}>
              <Text style={[styles.title, { color: color.text.onMedia }]} numberOfLines={2}>
                {title}
              </Text>
              <Text style={[styles.meta, { color: color.text.onMedia }]} numberOfLines={1}>
                {episodeLabel(airing.episode)}  ·  {clockTime(airing.airingAt)}  ·{' '}
                {countdown(airing.airingAt, now)}
              </Text>
            </View>
          </View>
        </View>

        <View style={[styles.accentLine, { backgroundColor: accent }]} pointerEvents="none" />
      </Pressable>
    </View>
  );
});

const styles = StyleSheet.create({
  slot: {
    height: NEXT_UP_HEIGHT,
    paddingTop: spacing.lg,
  },
  card: {
    flex: 1,
    borderRadius: radii.lg,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
    justifyContent: 'flex-end',
  },
  body: {
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.md,
    gap: spacing.sm,
  },
  kicker: {
    fontSize: 9.5,
    lineHeight: 12,
    fontFamily: font.bold,
    letterSpacing: 1.3,
    textTransform: 'uppercase',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  poster: {
    width: POSTER_W,
    height: POSTER_H,
    borderRadius: radii.sm,
    borderWidth: 1.5,
    overflow: 'hidden',
  },
  text: { flex: 1, minWidth: 0, gap: 3 },
  title: {
    fontSize: 16,
    lineHeight: 21,
    fontFamily: font.bold,
    letterSpacing: -0.3,
  },
  meta: {
    fontSize: 11.5,
    lineHeight: 15,
    fontFamily: font.semibold,
    // Sits on artwork, so it needs the weight and the opacity the scrim can
    // carry — `text.secondary` disappears against a bright key-art sky.
    opacity: 0.82,
  },
  accentLine: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: 2,
  },
});
