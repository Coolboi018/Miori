// Episode row — list style.
//
// Horizontal row: a 16:9 still on the left (or a numbered tile when the source
// has no still), then the title, an optional synopsis and the watch state on
// the right, with a thin progress bar pinned to the row's bottom edge. Compact
// enough to scan quickly, but each row still reads as a distinct item.

import { Image } from 'expo-image';
import { memo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '@/lib/ui/useTheme';
import { font, layout, radii, spacing } from '@/lib/ui/tokens';
import { fmtDuration } from './format';

export interface EpisodeRowProps {
  number: number;
  title: string;
  thumbnail?: string | null;
  /** Runtime in seconds, from the source. */
  duration?: number | null;
  synopsis?: string | null;
  /** Seconds already watched — renders the resume bar. */
  position?: number;
  /** Mark the row as fully watched (e.g. from AniList progress) even without a local position. */
  watchedOverride?: boolean;
  onPress: () => void;
}

function EpisodeRowBase({
  number,
  title,
  thumbnail,
  duration,
  synopsis,
  position = 0,
  watchedOverride = false,
  onPress,
}: EpisodeRowProps) {
  const { color } = useTheme();
  const watched = watchedOverride || (duration ? position / duration > 0.95 : false);
  const partial = !watched && position > 5;
  const pct = duration ? Math.min(100, (position / duration) * 100) : 0;

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Episode ${number}: ${title}`}
      style={({ pressed }) => [
        styles.row,
        {
          backgroundColor: color.bg.surface,
          borderColor: color.border.muted,
          opacity: pressed ? 0.7 : 1,
        },
      ]}
    >
      {/* Media slot */}
      <View style={styles.media}>
        {thumbnail ? (
          <>
            <Image
              source={{ uri: thumbnail }}
              style={StyleSheet.absoluteFill}
              contentFit="cover"
              transition={150}
              cachePolicy="memory-disk"
            />
            <View style={[styles.epBadge, { backgroundColor: color.bg.scrim }]}>
              <Text style={[styles.epBadgeText, { color: color.text.onMedia }]}>
                EP {number}
              </Text>
            </View>
            {duration ? (
              <View style={[styles.durBadge, { backgroundColor: color.bg.scrim }]}>
                <Text style={[styles.durBadgeText, { color: color.text.onMedia }]}>
                  {fmtDuration(duration)}
                </Text>
              </View>
            ) : null}
          </>
        ) : (
          <View style={[styles.numTile, { backgroundColor: color.accent.muted }]}>
            <Text style={[styles.numTileNum, { color: color.text.primary }]} numberOfLines={1}>
              {number}
            </Text>
            <Text style={[styles.numTileLabel, { color: color.text.muted }]}>
              EP
            </Text>
          </View>
        )}
      </View>

      {/* Body */}
      <View style={styles.body}>
        <Text style={[styles.title, { color: color.text.primary }]} numberOfLines={2}>
          {title}
        </Text>
        {synopsis ? (
          <Text style={[styles.synopsis, { color: color.text.muted }]} numberOfLines={2}>
            {synopsis}
          </Text>
        ) : null}
        <View style={styles.metaRow}>
          {watched ? (
            <Text style={[styles.meta, { color: color.status.success }]}>Watched</Text>
          ) : partial ? (
            <Text style={[styles.meta, { color: color.text.secondary }]}>
              {fmtDuration(position)} watched
            </Text>
          ) : (
            <Text style={[styles.meta, { color: color.text.muted }]}>Not started</Text>
          )}
          {duration && !watched && !partial ? (
            <Text style={[styles.meta, { color: color.text.muted }]}>
              · {fmtDuration(duration)}
            </Text>
          ) : null}
        </View>
      </View>

      {/* Progress bar, bottom edge */}
      {partial || watched ? (
        <View
          style={[styles.progressTrack, { backgroundColor: color.accent.muted }]}
          pointerEvents="none"
        >
          <View
            style={[
              styles.progressFill,
              {
                width: `${watched ? 100 : pct}%`,
                backgroundColor: watched ? color.status.success : color.accent.base,
              },
            ]}
          />
        </View>
      ) : null}
    </Pressable>
  );
}

export const EpisodeRow = memo(EpisodeRowBase);

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: spacing.lg,
    marginVertical: spacing.xs + 1,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  media: {
    width: 112,
    aspectRatio: layout.bannerRatio,
    overflow: 'hidden',
    position: 'relative',
    backgroundColor: '#000',
  },
  epBadge: {
    position: 'absolute',
    top: 5,
    left: 5,
    paddingHorizontal: 5,
    paddingVertical: 2,
    borderRadius: 4,
  },
  epBadgeText: {
    fontSize: 9.5,
    fontFamily: font.bold,
    letterSpacing: 0.6,
  },
  durBadge: {
    position: 'absolute',
    bottom: 5,
    right: 5,
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 4,
  },
  durBadgeText: {
    fontSize: 10,
    fontFamily: font.semibold,
  },
  numTile: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 1,
  },
  numTileNum: {
    fontSize: 22,
    fontFamily: font.bold,
    lineHeight: 24,
  },
  numTileLabel: {
    fontSize: 8.5,
    fontFamily: font.bold,
    letterSpacing: 1.2,
  },
  body: {
    flex: 1,
    justifyContent: 'center',
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    gap: 2,
  },
  title: {
    fontSize: 14,
    fontFamily: font.semibold,
    lineHeight: 18,
  },
  synopsis: {
    fontSize: 12,
    fontFamily: font.regular,
    lineHeight: 15,
    marginTop: 1,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 4,
    gap: 4,
    flexWrap: 'wrap',
  },
  meta: {
    fontSize: 11,
    fontFamily: font.medium,
  },
  progressTrack: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: 3,
  },
  progressFill: {
    height: '100%',
  },
});