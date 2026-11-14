// Hero — featured rotation, designed for phones.
//
// Full-bleed poster (extraLarge, center crop) with a long bottom melt into
// the page — no edges anywhere. Rank kicker, title, meta, Details button.
// Dissolves between slides (plain RN Animated, native driver), swipes,
// 5s autoplay with clock reset on touch, dots. Top 8 trending.

import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Animated, PanResponder, Pressable, StyleSheet, Text, View } from 'react-native';
import { useIsFocusedNow } from '@/lib/ui/useIsFocusedNow';
import { mediaTitle, type MediaItem } from '@/lib/anilist';
import { scoreDisplay, formatLabel } from '@/components/anime/format';
import { font, motion, radii, spacing } from '@/lib/ui/tokens';
import { coverAccent } from '@/lib/ui/accent';
import { GradientText } from '@/components/ui/GradientText';
import { AppIcon } from '@/components/ui/AppIcon';

const AUTOPLAY_MS = 5000;
const DISSOLVE_MS = 650;
const DOT_INACTIVE = 6;
const DOT_ACTIVE = 20;
export const HERO_HEIGHT = 440;

/**
 * MEMOISED, and that is load-bearing.
 *
 * A hero is one of the most expensive subtrees in the app: two
 * `expo-linear-gradient` native views, an SVG `GradientText`, and up to eight
 * `Dissolve` wrappers each holding an `Animated.Value` and a timing animation.
 * There are two of them mounted at once (home and explore).
 *
 * Both props are stable — `items` comes out of the query cache and `onSelect` is
 * a `useCallback` — so `memo` lets it skip entirely whenever its parent
 * re-renders for an unrelated reason. Without it, any re-render of the screen
 * re-rendered both heroes fully.
 */
export const HeroCarousel = memo(function HeroCarousel({
  items,
  onSelect,
}: {
  items: MediaItem[];
  onSelect: (media: MediaItem) => void;
}) {
  const [index, setIndex] = useState(0);
  const len = items.length;
  // The pagination pill borrows the current slide's cover colour, so it reads
  // as part of the artwork rather than unrelated chrome. Same lifted accent
  // the title gradient starts from, so the two agree.
  const activeAccent = coverAccent(items[index]?.coverImage?.color);

  // ONE AUTOPLAY TIMER, re-armed by a monotonically rising "epoch". Every
  // interaction (swipe, dot tap) bumps the epoch, which tears the old
  // timeout down and starts a fresh full 5s. Re-arming on index alone was
  // the old bug: a swipe that goes 6 -> 5 -> 6 in quick succession never
  // fires, and the carousel can sit on one slide forever.
  //
  // PAUSED OFF-SCREEN — VIA A REF, NOT STATE.
  //
  // Both home and explore mount a hero, and both tabs stay mounted for the whole
  // session, so without this there are two 5-second timers each driving an
  // `Animated.timing` cross-dissolve, running forever on tabs nobody was looking
  // at.
  //
  // This used to be `useState` + `useFocusEffect`. That is the obvious way to
  // write it and it is a trap: `setState` on focus change is a RE-RENDER, so
  // every tap of the tab bar re-rendered this whole subtree — two
  // `expo-linear-gradient` views, an SVG `GradientText`, and eight `Dissolve`
  // wrappers — twice over, because there are two heroes. Measured as the
  // difference between an instant tab switch and a one-second one.
  //
  // The ref reads the same boolean with no render at all. The timer stays armed
  // and no-ops while the tab is in the background, which costs one boolean check
  // every five seconds.
  //
  // "Stays armed" is load-bearing and used to be false: the timer used to return
  // early on an unfocused tab, which killed the re-arm and froze the carousel
  // permanently. See the effect below.
  const isFocusedNow = useIsFocusedNow();

  const [epoch, setEpoch] = useState(0);
  const bump = useCallback(() => setEpoch((e) => e + 1), []);

  /**
   * Did the LAST tick already see this screen as focused?
   *
   * The difference between "the tab is hidden" and "the tab has just come back",
   * and it is what makes a pause resume as a pause instead of as a hiccup. Set on
   * every tick, read on the next one.
   */
  const sawFocus = useRef(false);

  useEffect(() => {
    if (len < 2) return;
    // Seeded here rather than left `false` for the life of the component: this
    // effect also re-runs on `index` and on `epoch`, and both of those only ever
    // happen because the user touched the carousel — so the screen is focused, and
    // the next tick should be free to advance. Seeding at setup also gets a
    // never-focused tab (mounted under `lazy: false`, never once visited) right:
    // it starts `false` and therefore never advances at all.
    sawFocus.current = isFocusedNow();

    /**
     * THE TIMER RE-ARMS ITSELF. That is the fix.
     *
     * It used to read:
     *
     *   setTimeout(() => {
     *     if (!isFocusedNow()) return;        // ← the whole bug
     *     setIndex((i) => (i + 1) % len);
     *   }, AUTOPLAY_MS)
     *
     * A hidden tab hits that `return`, which is not a state write — so `index`
     * never changes, so this effect's dependencies never change, so the effect
     * never re-runs, so no new timeout is ever scheduled. One tab switch was
     * enough to kill the carousel for the rest of the session, on BOTH tabs:
     * the one you left was frozen at that moment, and the one you arrived at had
     * already been frozen the moment you last left it. `useNow` in the same file
     * survived only because it uses `setInterval`, which re-arms on its own.
     *
     * Re-arming unconditionally means a hidden tab costs one boolean check every
     * five seconds — the same price the note on `isFocusedNow` above already
     * accepted, now actually being paid.
     */
    const tick = () => {
      const focused = isFocusedNow();
      // Advance only if this screen was ALREADY visible at the previous tick, so
      // the first tick after coming back starts the dwell instead of finishing it.
      // Otherwise the twenty seconds spent on another tab would count as five, and
      // the slide could change the instant the user looked at it.
      //
      // The cost of noticing a return only at tick granularity is that the first
      // move after one lands between ONE and TWO dwells away, not exactly one: the
      // tick that happens to come first after the return is spent recording that
      // the tab is visible again. A focus SUBSCRIPTION would put it back to exactly
      // one dwell, at the cost of the render this whole file exists to avoid — see
      // `useIsFocusedNow`. 5-10s is not perceptible as a difference; 0s is.
      if (focused && sawFocus.current) setIndex((i) => (i + 1) % len);
      sawFocus.current = focused;
      t = setTimeout(tick, AUTOPLAY_MS);
    };

    let t: ReturnType<typeof setTimeout> | null = setTimeout(tick, AUTOPLAY_MS);
    return () => {
      if (t) clearTimeout(t);
    };
  }, [index, len, epoch, isFocusedNow]);

  const goTo = useCallback(
    (i: number) => setIndex(((i % len) + len) % len),
    [len]
  );

  const goRef = useRef(goTo);
  goRef.current = goTo;
  const indexRef = useRef(index);
  indexRef.current = index;
  const pan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponderCapture: (_, g) =>
        Math.abs(g.dx) > 25 && Math.abs(g.dx) > Math.abs(g.dy) * 1.5,
      onMoveShouldSetPanResponder: (_, g) =>
        Math.abs(g.dx) > 25 && Math.abs(g.dx) > Math.abs(g.dy) * 1.5,
      onPanResponderTerminationRequest: () => false,
      onPanResponderRelease: (_, g) => {
        if (g.dx <= -40) goRef.current(indexRef.current + 1);
        else if (g.dx >= 40) goRef.current(indexRef.current - 1);
      },
    })
  ).current;

  if (!len) return null;
  const near = (i: number) =>
    len <= 3 || i === index || i === (index + 1) % len || i === (index - 1 + len) % len;

  return (
    <View style={[styles.wrap, { height: HERO_HEIGHT }]} {...pan.panHandlers}>
      {items.map((m, i) =>
        near(i) ? (
          <Dissolve key={m.id} active={i === index} depth={1} passthrough>
            <Image
              // AniList's largest cover, and nothing else.
              //
              // This used to be swapped for a Kitsu poster (550x780) once a
              // background lookup resolved. Removed, and the reason is that the
              // upgrade was never worth what it cost: home and explore each mount
              // a hero, so the carousel was issuing lookups to a SECOND provider
              // on every launch to gain 1.43x the pixels on an image most people
              // see for five seconds at a time — sixteen requests on a cold start,
              // plus a persisted mapping store, plus a provider whose real
              // justification was the full-bleed hero and nothing else.
              //
              // AniList caps out at 460px (`extraLarge` returns a `large` URL and
              // every larger size token 404s), so the hero is up against that
              // ceiling either way. Swapping providers bought back a fraction of a
              // stop and cost a round-trip.
              source={{ uri: m.coverImage?.extraLarge ?? m.coverImage?.large }}
              // Required: without it the image sizes to its intrinsic
              // dimensions instead of filling the slide.
              style={StyleSheet.absoluteFill}
              contentFit="cover"
              contentPosition="center"
              transition={300}
              cachePolicy="memory-disk"
              // The first slide is the one people see while scrolling in, so
              // let it jump the queue.
              priority={i === 0 ? 'high' : 'normal'}
            />
          </Dissolve>
        ) : null
      )}

      {/* Uniform dim so text always wins over bright art, then the
          directional melts. All static — never animated. */}
      <View
        style={[StyleSheet.absoluteFill, { zIndex: 2, backgroundColor: 'rgba(11,11,16,0.3)' }]}
        pointerEvents="none"
      />
      <LinearGradient
        colors={['rgba(11,11,16,0.55)', 'rgba(11,11,16,0)']}
        locations={[0, 0.28]}
        start={{ x: 0, y: 0 }}
        end={{ x: 0, y: 1 }}
        style={[StyleSheet.absoluteFill, { zIndex: 2 }]}
        pointerEvents="none"
      />
      <LinearGradient
        colors={['rgba(11,11,16,0)', '#0b0b10']}
        locations={[0.45, 1]}
        start={{ x: 0, y: 0 }}
        end={{ x: 0, y: 1 }}
        style={[StyleSheet.absoluteFill, { zIndex: 2 }]}
        pointerEvents="none"
      />

      {items.map((m, i) =>
        near(i) ? (
          <Dissolve key={`c-${m.id}`} active={i === index} depth={3}>
            <HeroCard rank={i + 1} media={m} onDetails={() => onSelect(m)} />
          </Dissolve>
        ) : null
      )}

      {len > 1 ? (
        <View style={styles.dots} pointerEvents="box-none">
          {items.map((m, i) => (
            <Dot
              key={m.id}
              active={i === index}
              color={activeAccent}
              label={`Go to slide ${i + 1}`}
              onPress={() => {
                bump();
                goTo(i);
              }}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
});

function Dissolve({
  active,
  depth,
  passthrough,
  children,
}: {
  active: boolean;
  depth: number;
  passthrough?: boolean;
  children: React.ReactNode;
}) {
  const opacity = useRef(new Animated.Value(active ? 1 : 0)).current;
  useEffect(() => {
    const anim = Animated.timing(opacity, {
      toValue: active ? 1 : 0,
      duration: DISSOLVE_MS,
      useNativeDriver: true,
    });
    anim.start();
    return () => anim.stop();
  }, [active, opacity]);

  return (
    <Animated.View
      style={[StyleSheet.absoluteFill, { opacity, zIndex: active ? depth : 0 }]}
      // `passthrough` forces 'none' for EVERY slide, not just inactive ones.
      // Only use it on subtrees that contain no controls: putting it on the
      // card made the Details button unclickable on all slides, because
      // `active && !passthrough` can never be true.
      pointerEvents={active && !passthrough ? 'auto' : 'none'}
    >
      {children}
    </Animated.View>
  );
}

/**
 * One pagination dot. The active one stretches into a pill and takes the
 * current slide's cover colour, so the indicator is tied to the artwork
 * rather than being a neutral white blob. Width is animated because the
 * reference transitions the dot too, and a hard snap reads as a glitch on an
 * element that changes every 5s.
 */
function Dot({
  active,
  color,
  label,
  onPress,
}: {
  active: boolean;
  color: string;
  label: string;
  onPress: () => void;
}) {
  const width = useRef(new Animated.Value(active ? DOT_ACTIVE : DOT_INACTIVE)).current;

  useEffect(() => {
    Animated.timing(width, {
      toValue: active ? DOT_ACTIVE : DOT_INACTIVE,
      duration: motion.fast,
      // Width is not a native-driver property, so this has to stay on the
      // JS driver. It is a 6px view, so the cost is irrelevant.
      useNativeDriver: false,
    }).start();
  }, [active, width]);

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: active }}
      hitSlop={10}
      style={styles.dotPress}
    >
      <Animated.View
        style={[
          styles.dot,
          { width, backgroundColor: active ? color : 'rgba(255,255,255,0.28)' },
        ]}
      />
    </Pressable>
  );
}

/**
 * Status glyph for the hero's meta line — same semantics as the tiles'
 * status light (RELEASING green, NOT_YET_RELEASED blue, else muted).
 * A filled circle at text size; the hero always sits on dark scrimmed art,
 * so fixed light-on-dark values are correct here regardless of theme.
 */
function StatusDot({ status }: { status?: string | null }) {
  const fill =
    status === 'RELEASING'
      ? '#4ade80'
      : status === 'NOT_YET_RELEASED'
        ? '#60a5fa'
        : 'rgba(255,255,255,0.45)';
  return <View style={[styles.statusDot, { backgroundColor: fill }]} />;
}

function HeroCard({
  rank,
  media,
  onDetails,
}: {
  rank: number;
  media: MediaItem;
  onDetails: () => void;
}) {
  const year = media.seasonYear ? String(media.seasonYear) : null;
  // AniList's dominant colour for this cover, lifted so it stays legible
  // against the scrim. See lib/ui/accent for why the lift is needed.
  const accent = coverAccent(media.coverImage?.color);
  // Two genres, matching the website. The reference hides the synopsis on
  // mobile; the status line is the only place they can go.
  const genres = (media.genres ?? []).slice(0, 2);
  // One plain text line replaces the old chip row: dot, score as a star
  // glyph, then format/year/genres joined. Upcoming shows (no score) lead
  // with their FORMAT instead, matching the tiles' caption logic.
  const metaLine = [
    media.averageScore != null ? `★ ${scoreDisplay(media.averageScore)}` : formatLabel(media.format),
    year,
    ...genres,
  ]
    .filter(Boolean)
    .join('  ·  ');

  return (
    <View style={styles.card} pointerEvents="box-none">
      {/* Rank-aware kicker: the numeral wears the slide's accent, the label
          stays muted — the same leader-marking trick the completed chart
          uses on its #1. */}
      <Text style={styles.kicker}>
        <Text style={{ color: accent }}>{String(rank).padStart(2, '0')}</Text>
        {'  TRENDING'}
      </Text>
      <GradientText
        colors={[accent, '#ffffff']}
        fontSize={23}
        lineHeight={28}
        fontFamily={font.bold}
        maxLines={1}
      >
        {mediaTitle(media.title)}
      </GradientText>

      {/* Status line: one view + one text, replacing five chip views. The
          dot leads, the tail is score-or-format — identical logic to the
          tiles' caption. */}
      <View style={styles.metaRow} pointerEvents="none">
        <StatusDot status={media.status} />
        <Text style={styles.metaText} numberOfLines={1}>
          {metaLine}
        </Text>
      </View>

      {/* THE CTA. Solid, cover-tinted, the one saturated element on the
          card — the old 12% pill was the least visible thing on screen and
          the only thing you could tap. */}
      <Pressable
        onPress={onDetails}
        accessibilityRole="button"
        accessibilityLabel={`Watch now: ${mediaTitle(media.title)}`}
        hitSlop={8}
        style={({ pressed }) => [
          styles.cta,
          { backgroundColor: accent, opacity: pressed ? 0.8 : 1 },
        ]}
      >
        <AppIcon name="play" size={13} color="#0b0b10" strokeWidth={2.5} />
        <Text style={styles.ctaText}>Watch now</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { width: '100%', backgroundColor: '#0b0b10' },
  card: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: spacing.xl,
    // Clears the pagination dots, which sit 10px off the bottom edge.
    paddingBottom: spacing.huge,
    gap: spacing.sm,
  },
  kicker: {
    // Was gold (#ffd479). Nothing else in the palette is gold, so it read as
    // an off-system accent and pulled focus from the title.
    color: 'rgba(255,255,255,0.5)',
    fontSize: 10,
    fontFamily: font.semibold,
    letterSpacing: 1.6,
  },
  // No `title` style on purpose: the title is drawn as SVG by GradientText,
  // which takes its size and weight as props. A fontSize here would be
  // silently ignored, and would drift out of sync with the real value.
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 2,
  },
  statusDot: {
    width: 7,
    height: 7,
    borderRadius: 999,
    marginRight: 2,
  },
  metaText: {
    flexShrink: 1,
    fontSize: 12,
    lineHeight: 15,
    fontFamily: font.medium,
    letterSpacing: 0.2,
    color: 'rgba(255,255,255,0.82)',
  },
  // The card's one saturated element. Dark text on the cover-tinted fill —
  // coverAccent is lightness-lifted for exactly this (legible-on-dark), and
  // dark-on-light-plate flips the contrast the right way.
  cta: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: spacing.xs + 2,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.sm + 2,
    borderRadius: radii.full,
    marginTop: spacing.sm + 2,
  },
  ctaText: {
    color: '#0b0b10',
    fontSize: 13,
    lineHeight: 16,
    fontFamily: font.bold,
    letterSpacing: 0.6,
  },
  dots: {
    position: 'absolute',
    bottom: 10,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    zIndex: 4,
  },
  // The pressable is wider than the pill so the tap target is not 6px, and it
  // sits in a fixed-height row so the animated width change cannot shift the
  // row and make the dots jitter vertically.
  dotPress: { height: 14, justifyContent: 'center' },
  dot: { height: DOT_INACTIVE, borderRadius: DOT_INACTIVE / 2 },
});
