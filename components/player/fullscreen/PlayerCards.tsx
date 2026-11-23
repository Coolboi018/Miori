// The player's full-screen STATES: a link that is not an episode, and a
// failure with its exits.
//
// WHY THEY ARE OUT HERE. They are the only parts of the player that are pure
// presentation — props in, pixels out, no player, no refs, no timers — and
// inline in a 5,800-line screen the failure path could not be read without
// reading the resolve / failover / subtitle machinery around it. The screen
// decides WHEN a card is up; a card decides WHAT it looks like.
//
// Nothing here imports the player. `headline` and `detail` arrive already
// classified by `lib/player/failure.ts`, and the exits are callbacks the
// screen owns — Retry re-resolves the episode, Change source restarts the walk,
// and they are genuinely different jobs (see `onChangeSource` in the screen).

import { memo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { AppIcon } from '@/components/ui/AppIcon';
import { font, radii } from '@/lib/ui/tokens';

/**
 * A malformed deep link render NOTHING that could stream.
 *
 * `miori://watch/<id>/<not-a-number>` is reachable: `scheme: "miori"` is in
 * `app.json`. The screen refuses the route before anything reads it; this is
 * only the sentence that explains why.
 */
export const InvalidLinkCard = memo(function InvalidLinkCard({ onBack }: { onBack: () => void }) {
  return (
    <View style={styles.errorBox} pointerEvents="box-none">
      <AppIcon name="alert" size={30} color="#FF6B6B" strokeWidth={2} />
      <Text style={styles.errorTitle}>That link is not an episode</Text>
      <Text style={styles.errorBody}>
        Miori could not read an anime and episode number out of this address.
      </Text>
      <Pressable onPress={onBack} style={styles.errorBtn} accessibilityRole="button">
        <Text style={styles.errorBtnText}>Go back</Text>
      </Pressable>
    </View>
  );
});

export interface PlaybackErrorCardProps {
  /** The offline sentence earns its own title; everything else is a failure. */
  offline: boolean;
  /**
   * THE CAUSE FIRST, IN THE VIEWER'S TERMS.
   *
   * `failure.headline` is `describeFailure`'s verdict on the engine's own
   * message, and it leads because it is the only line that tells anyone what to
   * do. The request-level `error` string is the fallback for the two failures
   * that never come from the player: the resolve deadline, and an AniList or
   * extension request that failed before there was ever a source to play.
   */
  headline: string;
  /**
   * The engine's raw message, kept rather than replaced — it is the only part
   * of this screen a bug report can use, and a classification that discarded it
   * would be substituting a guess for a fact. Null when it adds nothing.
   */
  detail: string | null;
  /**
   * The number of distinct sources in the list.
   *
   * Deliberately SOURCES rather than attempts: the retry budget is three rounds
   * over the same list, so "9 attempts" would describe a mechanism rather than
   * a situation.
   */
  sourceCount: number;
  onRetry: () => void;
  onChangeSource: () => void;
  onBack: () => void;
}

/**
 * THREE OUTWAYS, AND NOT ONE OF THEM IS OPTIONAL.
 *
 * This used to be a single "Try again" over a full-screen opaque panel. On iOS
 * — no hardware back button, and this route hides the stack header — that left
 * exactly one control on the screen and no way out of it. Even on Android,
 * "Try again" against a dead CDN is a loop with no exit, and the source list is
 * the one input that can actually change the outcome.
 *
 * "Change source" restarts the failover walk from the top rather than waiting
 * out the remaining budget, which is what makes it different from Retry rather
 * than a second spelling of it.
 */
export const PlaybackErrorCard = memo(function PlaybackErrorCard({
  offline,
  headline,
  detail,
  sourceCount,
  onRetry,
  onChangeSource,
  onBack,
}: PlaybackErrorCardProps) {
  return (
    <Animated.View entering={FadeIn} style={styles.errorBox} pointerEvents="box-none">
      <AppIcon name="alert" size={30} color="#FF6B6B" strokeWidth={2} />
      <Text style={styles.errorTitle}>{offline ? "You're offline" : 'Playback failed'}</Text>
      <Text style={styles.errorBody}>{headline}</Text>
      {detail ? (
        <Text style={styles.errorDetail} numberOfLines={3}>
          {detail}
        </Text>
      ) : null}
      {sourceCount > 1 ? (
        <Text style={styles.errorDetail}>Tried all {sourceCount} sources.</Text>
      ) : null}
      <View style={styles.errorActions}>
        <Pressable onPress={onRetry} style={styles.errorBtn} accessibilityRole="button">
          <Text style={styles.errorBtnText}>Try again</Text>
        </Pressable>
        {sourceCount > 1 ? (
          <Pressable onPress={onChangeSource} style={styles.errorBtnAlt} accessibilityRole="button">
            <Text style={styles.errorBtnText}>Change source</Text>
          </Pressable>
        ) : null}
        <Pressable onPress={onBack} style={styles.errorBtnGhost} accessibilityRole="button">
          <Text style={styles.errorBtnGhostText}>Back</Text>
        </Pressable>
      </View>
    </Animated.View>
  );
});

const styles = StyleSheet.create({
  errorBox: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: 'rgba(0,0,0,0.86)',
    paddingHorizontal: 32,
  },
  errorTitle: {
    color: '#fff',
    fontFamily: font.bold,
    fontSize: 17,
  },
  errorBody: {
    color: 'rgba(255,255,255,0.7)',
    fontFamily: font.regular,
    fontSize: 13,
    lineHeight: 19,
    textAlign: 'center',
    maxWidth: 380,
  },
  /**
   * The engine's own words, and the "tried N sources" count.
   *
   * Dimmer and smaller than `errorBody` on purpose: this is evidence, not the
   * headline.
   */
  errorDetail: {
    color: 'rgba(255,255,255,0.42)',
    fontFamily: font.mono,
    fontSize: 11,
    lineHeight: 16,
    textAlign: 'center',
    maxWidth: 400,
  },
  errorActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginTop: 14,
    flexWrap: 'wrap',
    justifyContent: 'center',
  },
  errorBtn: {
    paddingHorizontal: 18,
    paddingVertical: 9,
    borderRadius: radii.full,
    backgroundColor: 'rgba(255,255,255,0.14)',
  },
  errorBtnAlt: {
    paddingHorizontal: 18,
    paddingVertical: 9,
    borderRadius: radii.full,
    backgroundColor: 'rgba(255,255,255,0.14)',
  },
  /**
   * "Back" is visually the quietest of the three, and deliberately so: it is the
   * only one that is always safe, so it must not compete with the two that are
   * guesses about what went wrong. A 44pt touch target on a ghost button, so the
   * styling can recede without the target doing the same.
   */
  errorBtnGhost: {
    paddingHorizontal: 14,
    paddingVertical: 11,
    borderRadius: radii.full,
  },
  errorBtnText: {
    color: '#fff',
    fontFamily: font.semibold,
    fontSize: 13,
  },
  errorBtnGhostText: {
    color: 'rgba(255,255,255,0.6)',
    fontFamily: font.medium,
    fontSize: 13,
  },
});
