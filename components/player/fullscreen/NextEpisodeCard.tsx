import { memo, useEffect, useRef, useState } from 'react';
import { Animated, Pressable, StyleSheet, Text, View } from 'react-native';
import { font, radii } from '@/lib/ui/tokens';

/**
 * "UP NEXT" — what a player shows when an episode actually ends.
 *
 * Auto-advance used to be a silent 1.5s timer: the last frame held, then the
 * next episode appeared with no word about why. Every real player (Netflix,
 * Crunchyroll, YouTube's autoplay) puts a card on the frame instead, with the
 * next title, a visible countdown and two ways to say no — because "the app
 * jumped to another episode on its own" is the one behaviour viewers complain
 * about when it is invisible.
 *
 * THE COUNTDOWN LIVES IN HERE, not on the screen.
 *
 * A seconds counter held by `PlayerScreen` would re-render that whole component
 * body — five thousand lines — once per second purely to change a digit. This
 * component is memoised, ticks on its own, and tells the screen once, when the
 * countdown reaches zero (`onAdvance`). Cancel and Play now are the same two
 * callbacks the countdown uses.
 *
 * Bottom-LEFT on purpose: the skip button (`SkipButtonHost`) owns the right
 * edge above the bar, and an outro marker is exactly when both would be on
 * screen together.
 */
export const NextEpisodeCard = memo(function NextEpisodeCard({
  number,
  title,
  seconds,
  bottom,
  left,
  onAdvance,
  onCancel,
}: {
  /** The episode queued to play, or null when nothing is queued. */
  number: number | null;
  /** That episode's title, when the list already knows it. */
  title: string | null;
  /** Seconds shown before the advance fires. */
  seconds: number;
  /** Measured distance from the bottom edge — above the bottom bar. */
  bottom: number;
  /** Distance from the left edge, already inset-safe. */
  left: number;
  onAdvance: () => void;
  onCancel: () => void;
}) {
  const visible = number != null;

  /**
   * The last queued episode, kept for the fade-out. Without it the card's
   * content would blank the instant `number` goes null — the exit would be an
   * empty rectangle fading away.
   */
  const lastRef = useRef<{ number: number; title: string | null } | null>(null);
  if (number != null) lastRef.current = { number, title };
  const shown = number != null ? { number, title } : lastRef.current;

  const [leftSeconds, setLeft] = useState(seconds);
  // The latest `onAdvance` without re-arming the interval for a new closure.
  const advanceRef = useRef(onAdvance);
  advanceRef.current = onAdvance;

  useEffect(() => {
    if (number == null) return;
    // A new queue starts its countdown from the top. `seconds` is a constant in
    // practice; keying on it keeps the timer honest if that ever changes.
    let remaining = seconds;
    setLeft(seconds);
    const id = setInterval(() => {
      remaining -= 1;
      setLeft(Math.max(0, remaining));
      if (remaining <= 0) {
        clearInterval(id);
        advanceRef.current();
      }
    }, 1000);
    return () => clearInterval(id);
  }, [number, seconds]);

  const anim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(anim, {
      toValue: visible ? 1 : 0,
      duration: 180,
      useNativeDriver: true,
    }).start();
  }, [visible, anim]);

  if (shown == null) return null;

  return (
    <Animated.View
      // `none` while hidden so a fading-out card cannot eat a tap that belongs
      // to the video or the bar underneath it.
      pointerEvents={visible ? 'auto' : 'none'}
      accessibilityLabel={
        visible ? `Next episode in ${leftSeconds} seconds` : undefined
      }
      style={[
        styles.card,
        { left, bottom },
        {
          opacity: anim,
          transform: [
            { translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [10, 0] }) },
          ],
        },
      ]}
    >
      <View style={styles.badge}>
        <Text style={styles.badgeText}>{leftSeconds}</Text>
      </View>
      <View style={styles.copy}>
        <Text style={styles.kicker}>UP NEXT</Text>
        <Text style={styles.title} numberOfLines={1}>
          {`Episode ${shown.number}${shown.title ? ` · ${shown.title}` : ''}`}
        </Text>
      </View>
      <Pressable
        onPress={onAdvance}
        style={styles.play}
        accessibilityRole="button"
        accessibilityLabel={`Play episode ${shown.number} now`}
      >
        <Text style={styles.playText}>Play now</Text>
      </Pressable>
      <Pressable
        onPress={onCancel}
        style={styles.cancel}
        accessibilityRole="button"
        accessibilityLabel="Stay on this episode"
      >
        <Text style={styles.cancelText}>Cancel</Text>
      </Pressable>
    </Animated.View>
  );
});

const styles = StyleSheet.create({
  card: {
    position: 'absolute',
    width: 372,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: radii.xl,
    backgroundColor: 'rgba(14,14,18,0.96)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.16)',
  },
  badge: {
    width: 32,
    height: 32,
    borderRadius: radii.full,
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.35)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: {
    color: '#ffffff',
    fontSize: 14,
    fontFamily: font.semibold,
    fontVariant: ['tabular-nums'],
  },
  copy: {
    flex: 1,
    minWidth: 0,
  },
  kicker: {
    color: 'rgba(255,255,255,0.55)',
    fontSize: 10,
    letterSpacing: 1.1,
    fontFamily: font.semibold,
    marginBottom: 2,
  },
  title: {
    color: '#ffffff',
    fontSize: 14,
    fontFamily: font.semibold,
  },
  play: {
    height: 32,
    paddingHorizontal: 14,
    borderRadius: radii.full,
    backgroundColor: '#ffffff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  playText: {
    color: '#0b0b10',
    fontSize: 13,
    fontFamily: font.semibold,
  },
  cancel: {
    height: 32,
    paddingHorizontal: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelText: {
    color: 'rgba(255,255,255,0.66)',
    fontSize: 13,
    fontFamily: font.medium,
  },
});
