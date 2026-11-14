// THE OMNIBOX — the nav-bar search icon, expanded in place.
//
// WHAT IT IS: tapping the magnifying glass turns the bar into a search field
// with the keyboard up, and results appear as a panel of poster tiles directly
// beneath it. Nothing navigates until you commit — the go arrow, the return key,
// or "See all results". Until then you are still on the page you were on, which
// is the whole point: search becomes a verb you can use anywhere instead of a
// tab you have to visit first.
//
// WHY IT IS A SEPARATE COMPONENT: `NavBar` is mounted by six screens and its own
// header promises "three Pressables + one plain View, no scroll listeners". All
// the weight here — query state, results, the keyboard listener, the tile rail —
// lives in this file, and `NavBar` mounts it only while open. Closed, it costs
// one boolean and renders nothing, and NavBar never re-renders as you type.
//
// WHY THE BAR'S GEOMETRY NEVER CHANGES: every screen offsets its content by
// `useNavOffset()`, which is derived from the bar's row height. This reproduces
// that row EXACTLY — same `insets.top + 8`, same height — and only fills it
// differently, so opening the omnibox moves nothing on any screen.
//
// ---------------------------------------------------------------------------
// WHY IT FLOATS, AND WHY THAT IS THE WHOLE LOOK
// ---------------------------------------------------------------------------
//
// The first version put an opaque, edge-to-edge band across the top and hung the
// tiles off it. It read as a TOOLBAR — a bar arriving — which is the one thing
// this app's nav bar was redesigned to stop being. Its own header says: "No bar,
// no pill: the controls float directly on content."
//
// So the band is gone. What is left is a rounded card with real margin around
// it, a pill-shaped field, and a dimmed page behind. That reads as something
// FLOATING OVER the screen you were already on, which is the truth: you did not
// go anywhere. It also matches the floating tab pill at the bottom, so the two
// ends of the screen now speak the same language.
//
// ---------------------------------------------------------------------------
// WHY THE MOTION IS ALL `entering`/`exiting`, AND ALL TRANSFORM + OPACITY
// ---------------------------------------------------------------------------
//
// No width is animated, ever. Animating a focused `TextInput`'s width makes
// Android drop its focus and dismiss the keyboard mid-animation — the reason the
// magnifier cannot literally grow into the field. So the field simply APPEARS and
// the rest of the entrance is compositor-only: opacity and translateY. Same
// builder as the anime page's staggered rows (`FadeInDown.delay().duration()`),
// so this is house motion, not a new technique.
//
// Durations are 140–200ms and the delays are 40–60ms. Fast enough to feel like
// a response rather than a performance, slow enough that the card has visibly
// arrived before anything inside it is legible.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { openAnime } from '@/lib/nav/pushOnce';
import {
  ActivityIndicator,
  BackHandler,
  Keyboard,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  // Strict TypeScript API (RN 0.88): element refs are instance types.
  type TextInputInstance,
} from 'react-native';
import Animated, {
  FadeIn,
  FadeInDown,
  FadeOut,
  SlideOutUp,
} from 'react-native-reanimated';
import { useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { isSearchable, normaliseQuery, SEARCH_MIN_CHARS, tidyQuery } from '@/lib/anilist/search';
import type { MediaItem } from '@/lib/anilist';
import { useSearchResults } from '@/lib/query/hooks';
import { useSetting } from '@/lib/settings/useSetting';
import { useTheme } from '@/lib/ui/useTheme';
import { font, layout, radii, shadows, spacing } from '@/lib/ui/tokens';
import { AppIcon } from '@/components/ui/AppIcon';
import { PosterCard } from '@/components/anime/PosterCard';
import { SearchField } from '@/components/ui/SearchField';

/**
 * Tiles shown in the rail — one row's worth. The rail is deliberately wider
 * than its container so a partial tile shows, which is the affordance that says
 * "there is more here" better than a final tile that fits exactly.
 */
const RAIL_MAX = 8;

/**
 * Tile width. Ninety-two is not arbitrary: it is the same readability guard the
 * grids use ("below ~92px a caption is illegible"), so a rail tile and a grid
 * tile are the same object at the same size, and nothing looks coarser here than
 * on the page this hands off to.
 */
const TILE_W = 92;

/** Must match the search page's, or the two would disagree while typing. */
const DEBOUNCE_MS = 340;

/** Ceiling on the card, so a big result set never becomes a wall. */
const CARD_MAX = 420;

/**
 * Floor, so a very tall keyboard (a landscape phone, a tablet with a hardware
 * bar) cannot squeeze the card down to a sliver. Below this the card scrolls
 * rather than shrinking further.
 */
const CARD_MIN = 120;

/**
 * The bar row's height, read from `tokens` and NOT imported from `NavBar`.
 *
 * `NavBar` renders this component, so importing anything back from it closed
 * the loop into `NavBar → SearchOmnibox → NavBar`. Metro warns about it and,
 * worse, module initialisation order then decides whether the constant is
 * defined yet. `tokens.ts` imports nothing, so it is structurally incapable of
 * taking part in a cycle.
 */
const ROW_H = layout.navbarRowHeight;

// ---- motion -------------------------------------------------------------
// Same shape as the anime page's staggered rows. The scrim is the slowest thing
// on screen: if the dim arrives last it flashes the content brighter than the
// page underneath it, which looks like a bug rather than a fade.
const SCIM_IN = FadeIn.duration(190);
const SCIM_OUT = FadeOut.duration(140);
const ROW_IN = FadeIn.duration(140);
const ROW_OUT = FadeOut.duration(110);
const CARD_IN = FadeInDown.duration(210).damping(20).stiffness(200);
const CARD_OUT = SlideOutUp.duration(160);
// The two arrows trail the field very slightly, so the row assembles left to
// right instead of appearing as one block.
const BACK_IN = FadeIn.delay(40).duration(140);
const GO_IN = FadeIn.delay(60).duration(140);

export function SearchOmnibox({
  onClose,
  onCommit,
}: {
  onClose: () => void;
  /** Hand the query to the full search page. */
  onCommit: (query: string) => void;
}) {
  const { color } = useTheme();
  const insets = useSafeAreaInsets();
  const { height: screenH } = useWindowDimensions();
  const tileStyle = useSetting('home.tileStyle');

  const [text, setText] = useState('');
  const [items, setItems] = useState<MediaItem[]>([]);
  const [total, setTotal] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [keyboardH, setKeyboardH] = useState(0);

  const query = tidyQuery(text);
  const key = useMemo(() => normaliseQuery(query), [query]);
  const searching = isSearchable(key);

  /**
   * THE DEBOUNCE, and it lives here rather than inside the fetch.
   *
   * Debouncing the QUERY rather than the request is what makes the sharing work:
   * the search screen debounces to `tidyQuery` over 340ms and this does the same
   * over `DEBOUNCE_MS`, so the two converge on the same string for the same text
   * and land on the same cache key. Debouncing only the request — as this file
   * used to, with a timeout around the call — would fire the query with the raw
   * text while the page fired it with the tidied text, and those are two keys.
   *
   * A fast typist produces one request rather than eleven, which is the whole
   * reason the debounce exists: every intermediate prefix is a request against a
   * budget this screen is explicitly trying to protect.
   */
  const [debounced, setDebounced] = useState(query);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query), DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [query]);

  // ---- keyboard ----------------------------------------------------------
  //
  // The card hangs from the TOP of the screen, so the only thing a keyboard can
  // do to it is hide its lower half. Capping against the measured height is the
  // difference between "results" and "results, half of them under the keyboard".
  useEffect(() => {
    const show = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hide = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const onShow = Keyboard.addListener(show, (e) => setKeyboardH(e.endCoordinates.height));
    const onHide = Keyboard.addListener(hide, () => setKeyboardH(0));
    return () => {
      onShow.remove();
      onHide.remove();
    };
  }, []);

  // ---- results -----------------------------------------------------------

  /**
   * THE FIELD. Only ever used to `blur()` it — see `releaseKeyboard` for why
   * that has to happen explicitly instead of being left to unmount.
   */
  const inputRef = useRef<TextInputInstance>(null);

  /**
   * The results, through the same query the search page uses.
   *
   * This used to call `searchAnime` directly, which meant it had its own cache —
   * so the note above it ("pressing go is a cache hit") was true by accident
   * rather than by construction, and would have stopped being true the moment the
   * search page moved its caching somewhere else. It did.
   *
   * Now both screens ask for `['search', <normalised query>, 1]` and there is one
   * entry. So the hand-off from the omnibox to the full search page genuinely
   * costs zero AniList requests, and it costs zero because they are the same
   * query rather than because two caches happened to agree.
   *
   * `RAIL_MAX` of them are kept, so only eight posters decode even though the
   * response holds twenty-four.
   */
  const {
    data: result,
    error: queryError,
    isFetching,
  } = useSearchResults(debounced, 1, { enabled: searching });

  useEffect(() => {
    if (!searching) {
      setItems([]);
      setTotal(0);
      return;
    }
    setItems((result?.items ?? []).slice(0, RAIL_MAX));
    setTotal(result?.total ?? 0);
  }, [result, searching]);

  useEffect(() => {
    setError(queryError ? String((queryError as Error)?.message ?? queryError) : null);
  }, [queryError]);

  useEffect(() => {
    setBusy(isFetching);
  }, [isFetching]);

  // ---- actions -----------------------------------------------------------

  /**
   * THE KEYBOARD. Read this before touching any close path.
   *
   * On Android, unmounting a focused `TextInput` does NOT reliably dismiss the
   * keyboard: the native view is torn down while the IME is still attached to
   * its window, and the keyboard stays on screen over a page the user has
   * already dismissed. Closing with the back arrow or a scrim tap did exactly
   * that — the search vanished, the keyboard did not.
   *
   * So every exit releases the keyboard EXPLICITLY, and it does so BEFORE
   * `onClose()` unmounts anything. Order matters: `blur()` has to reach a live
   * native view, and `Keyboard.dismiss()` asks the window's input method
   * manager to hide the IME while it still has a token to hide against.
   *
   * `blur()` rather than `Keyboard.dismiss()` alone, because blur also clears
   * native focus — which is what actually stops the IME from re-showing itself
   * on the next focus event.
   */
  const releaseKeyboard = useCallback(() => {
    inputRef.current?.blur();
    Keyboard.dismiss();
  }, []);

  /** Close: release the keyboard, then unmount. Every dismissal goes through here. */
  const dismiss = useCallback(() => {
    releaseKeyboard();
    onClose();
  }, [releaseKeyboard, onClose]);

  const commit = useCallback(() => {
    if (!isSearchable(normaliseQuery(query))) return;
    // `onCommit` already unmounts this component (the bar collapses), so only
    // the keyboard needs releasing here — not `dismiss()`.
    releaseKeyboard();
    onCommit(query);
  }, [query, releaseKeyboard, onCommit]);

  const openMedia = useCallback(
    (m: MediaItem) => {
      dismiss();
      // Guarded — see `lib/nav/pushOnce.ts`.
      openAnime(m.id);
    },
    [dismiss]
  );

  /**
   * Android's back button has to dismiss the overlay, not the app. Returning
   * `true` claims the press; without this, back exits the app while a field the
   * user can still see is open.
   *
   * NOTE the asymmetry, which is correct rather than a bug: while the keyboard
   * is up, Android gives the FIRST back press to the IME, which closes the
   * keyboard without delivering a key event to us. Only the second press
   * reaches this handler. That is the platform's long-standing behaviour and
   * every Android app behaves this way, so it is left alone — but it is why the
   * back ARROW and the scrim had to release the keyboard explicitly.
   */
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      dismiss();
      return true;
    });
    return () => sub.remove();
  }, [dismiss]);

  /**
   * THE LAST HOLE IN THE SAME BUG, and the easiest one to miss.
   *
   * The paths above all close search from inside this component. But the omnibox
   * can also vanish without any of them running: `NavBar` collapses itself on
   * blur, so switching tabs — or pushing a screen — unmounts this component
   * with the keyboard still up, stranding it over the page you just landed on.
   *
   * So the omnibox releases the keyboard on losing focus too. It has to live
   * HERE rather than in `NavBar`, because this is where the field's ref is;
   * `NavBar` can only call `Keyboard.dismiss()`, and that alone is the weaker of
   * the two calls.
   */
  useFocusEffect(
    useCallback(() => {
      return () => releaseKeyboard();
    }, [releaseKeyboard])
  );

  /**
   * How much room the card may take: the screen, minus the bar row, the card's
   * own margins, and the measured keyboard — with a floor, so a tall keyboard
   * can never squeeze the field row itself out of existence.
   */
  const cardMax = Math.max(
    CARD_MIN,
    Math.min(
      CARD_MAX,
      screenH - (insets.top + spacing.sm + ROW_H) - spacing.xs - keyboardH - spacing.sm
    )
  );

  return (
    <View style={styles.root}>
      {/* 1. The dim. No touch handling — purely the atmosphere behind everything.
          Sits on top of the page, under the content, so the floating card has
          something to float above. */}
      <Animated.View
        pointerEvents="none"
        style={[StyleSheet.absoluteFill, { backgroundColor: color.bg.scrim }]}
        entering={SCIM_IN}
        exiting={SCIM_OUT}
      />

      {/* 2. The tap catcher. Full screen, BELOW the content layer, so a tap on
          empty space dismisses while a tap on the field or a tile never does.
          Making the content's PARENT the pressable instead would mean a tap on
          empty space inside the card dismissed it too. */}
      <Pressable
        style={StyleSheet.absoluteFill}
        onPress={dismiss}
        accessibilityRole="button"
        accessibilityLabel="Close search"
      />

      {/* 3. The content. `box-none` so this layer is transparent to touches and
          only the field, the arrows and the card actually receive them. */}
      <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
        {/* The bar row, rebuilt to the same geometry as `NavBar`'s own so that
            nothing below it moves a pixel when this opens. Inset padding on the
            OUTSIDE, fixed height on the INSIDE — merge them and the row would
            measure `ROW_H + insets.top` and shove the card down. */}
        <Animated.View
          entering={ROW_IN}
          exiting={ROW_OUT}
          style={[styles.barInset, { paddingTop: insets.top + spacing.sm }]}
        >
          <View style={styles.barRow}>
            {/* A quiet dismiss. No plate: the scrim already separates it from
                the page, and a plate here would make a secondary control look
                primary. */}
            <Animated.View entering={BACK_IN}>
              <Pressable
                onPress={dismiss}
                accessibilityRole="button"
                accessibilityLabel="Close search"
                hitSlop={10}
                android_ripple={{ color: color.accent.glow, borderless: true }}
                style={({ pressed }) => [styles.circle, { opacity: pressed ? 0.6 : 1 }]}
              >
                <AppIcon name="back" size={20} color={color.text.primary} />
              </Pressable>
            </Animated.View>

            <View style={styles.fieldWrap}>
              <SearchField
                ref={inputRef}
                value={text}
                onChangeText={setText}
                placeholder="Search anime"
                autoFocus
                onSubmit={commit}
              />
            </View>

            {/* The go arrow. Disabled rather than hidden when there is nothing
                to go to — a control that appears and disappears is a layout
                change, and this row must stay exactly one row tall. */}
            <Animated.View entering={GO_IN}>
              <Pressable
                onPress={commit}
                disabled={!searching || busy}
                accessibilityRole="button"
                accessibilityLabel="See full results"
                accessibilityState={{ disabled: !searching || busy }}
                hitSlop={10}
                android_ripple={
                  searching && !busy ? { color: color.accent.glow, borderless: true } : undefined
                }
                style={({ pressed }) => [
                  styles.circle,
                  {
                    backgroundColor: searching ? color.accent.base : 'transparent',
                    opacity: !searching ? 0.3 : pressed ? 0.7 : 1,
                  },
                ]}
              >
                <AppIcon
                  name="chevron"
                  size={20}
                  color={searching ? color.bg.primary : color.text.muted}
                />
              </Pressable>
            </Animated.View>
          </View>
        </Animated.View>

        {/* THE FLOATING CARD. Inset from both edges, rounded, one shadow — and
            ONE shadow only. The codebase bans shadows per tile because eighty of
            them is a dropped-frame count; a single card is one view, and it is
            the one surface in the app that genuinely needs to read as raised
            above everything behind it. */}
        <Animated.View
          entering={CARD_IN}
          exiting={CARD_OUT}
          style={[
            styles.card,
            shadows.lg,
            {
              maxHeight: cardMax,
              backgroundColor: color.bg.elevated,
              borderColor: color.border.muted,
            },
          ]}
        >
          <ScrollView
            style={styles.results}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            {!searching ? (
              <Text style={[styles.hint, { color: color.text.muted }]}>
                Search by title — at least {SEARCH_MIN_CHARS} characters.
              </Text>
            ) : busy && !items.length ? (
              <View style={styles.busyRow}>
                <ActivityIndicator size="small" color={color.text.muted} />
              </View>
            ) : error ? (
              <Text style={[styles.hint, { color: color.status.danger }]} numberOfLines={2}>
                Could not reach AniList
              </Text>
            ) : items.length ? (
              <>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  keyboardShouldPersistTaps="handled"
                  contentContainerStyle={styles.rail}
                >
                  {items.map((m) => (
                    <PosterCard
                      key={m.id}
                      media={m}
                      variant={tileStyle}
                      width={TILE_W}
                      onPress={openMedia}
                    />
                  ))}
                </ScrollView>

                {/* "See all" is what makes the hand-off discoverable. Without it
                    the go arrow is a mystery: people type, tap a tile, and never
                    find out the full page exists. */}
                <Pressable
                  onPress={commit}
                  accessibilityRole="button"
                  accessibilityLabel={`See all ${total} results`}
                  android_ripple={{ color: color.accent.glow, borderless: false }}
                  style={({ pressed }) => [
                    styles.seeAll,
                    {
                      backgroundColor: pressed ? color.bg.surfaceHover : color.bg.surface,
                      borderColor: color.border.muted,
                    },
                  ]}
                >
                  <Text
                    style={[styles.seeAllText, { color: color.text.secondary }]}
                    numberOfLines={1}
                  >
                    See all {total.toLocaleString('en-US')} results
                  </Text>
                  <AppIcon name="chevron" size={15} color={color.text.muted} />
                </Pressable>
              </>
            ) : (
              <Text style={[styles.hint, { color: color.text.muted }]} numberOfLines={1}>
                Nothing matches “{query}”
              </Text>
            )}
          </ScrollView>
        </Animated.View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    // Above the `NavBar`'s own zIndex 10 — this replaces it, but the bar is
    // briefly still mounted during the swap and must not paint over the field.
    zIndex: 100,
  },

  // A separate node from `barRow` on purpose, so the inset sits outside the
  // fixed height rather than adding to it.
  barInset: {},
  barRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    // Slightly tighter than NavBar's gutter: the field is a pill now, and the
    // card below it is inset to match, so this edge reads as one aligned column.
    paddingHorizontal: spacing.md,
    height: ROW_H,
  },
  fieldWrap: { flex: 1 },
  circle: {
    width: 36,
    height: 36,
    borderRadius: radii.full,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },

  // ---- the floating card ----
  card: {
    marginHorizontal: spacing.md,
    marginTop: spacing.xs,
    borderRadius: radii.xl,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  results: {
    // Must be allowed to shrink below its content or `maxHeight` on the card
    // just clips the footer instead of scrolling it.
    flexShrink: 1,
  },
  rail: {
    // No horizontal gutter: the card supplies the inset, and doubling it would
    // push the first tile off-centre from the "See all" row below.
    paddingHorizontal: spacing.md,
    gap: spacing.md,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm,
    // Lets the rail run wider than the card so a partial tile shows — the
    // affordance that there is more. Clipped by the card's `overflow: hidden`,
    // which is exactly the effect wanted.
  },
  seeAll: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    height: 40,
    marginHorizontal: spacing.md,
    marginBottom: spacing.md,
    paddingHorizontal: spacing.md,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  seeAllText: {
    fontSize: 13,
    lineHeight: 17,
    fontFamily: font.semibold,
    letterSpacing: 0.1,
  },
  hint: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.lg,
    fontSize: 13,
    lineHeight: 18,
    fontFamily: font.medium,
  },
  busyRow: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.xl,
  },
});
