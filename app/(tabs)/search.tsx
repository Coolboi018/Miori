// SEARCH — one field, one list, and a landing state worth landing on.
//
// THE SHAPE OF IT, top to bottom, and why each piece exists:
//
//   ┌ Search ─────────────────────────────────┐  NavBar, floating, unchanged
//   │ (•) Search anime                    (×) │  THE FIELD, fixed above the
//   └─────────────────────────────────────────┘  list, never scrolled away
//   24 results for “cowboy”         [▦ ▤]       the count + the layout switch
//   ┌────────┐ ┌────────┐ ┌────────┐            THE RESULTS — one virtualised
//   │ poster │ │ poster │ │ poster │            FlatList. This is the screen's
//   │ Cowboy │ │ Bebop  │ │ …      │            only scroll axis, always.
//   └────────┘ └────────┘ └────────┘
//              ‹  Page 1 of 2  ›                 a pager, not an endless append
//
// WHY THE FIELD IS FIXED and not the list's header: the NavBar is
// `position: absolute`, so a field inside `ListHeaderComponent` slides up
// underneath it and collides with the floating search button. It also means the
// control you are typing into can leave the screen, which on a keyboard-open
// phone is the difference between the field being usable and being a guess.
//
// WHY A PAGER: the old screen appended nothing at all — it hardcoded page 1 and
// threw away the `hasNextPage` its own query already asked for, so searching
// "one" showed you 24 titles out of several thousand and said nothing at all
// about the rest. See `lib/anilist/search.ts` for why a bounded, honest page
// count beats a corridor.
//
// THE LANDING STATE. "Type at least 3 letters" in grey was the old empty
// state: an instruction to work, on a screen with no content. It is now
// RECENT searches (local, free, instant) and POPULAR searches (a curated set
// that costs zero AniList requests). Nothing is fetched until you actually
// search, so arriving at this tab spends nothing against the rate limit.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { openAnime } from '@/lib/nav/pushOnce';
import {
  FlatList,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  // Strict TypeScript API (RN 0.88): element refs are instance types.
  type TextInputInstance,
 ListRenderItem } from 'react-native';
import { useFocusEffect, useLocalSearchParams } from 'expo-router';


import {
  isSearchable,
  normaliseQuery,
  searchPageCount,
  SEARCH_MIN_CHARS,
  tidyQuery,
} from '@/lib/anilist/search';
import type { MediaItem } from '@/lib/anilist';
import { updateBrowsing } from '@/lib/presence/discord';
import { useRecentSearches } from '@/lib/search/useRecentSearches';
import { useSearchFocusRequest } from '@/lib/search/useSearchFocusRequest';
import { useSetting } from '@/lib/settings/useSetting';
import { useSearchResults } from '@/lib/query/hooks';

import { NavBar, useNavOffset } from '@/components/nav/NavBar';
import { PosterCard } from '@/components/anime/PosterCard';
import { GridEmpty, PageControl, GRID_GAP, gridTileWidth } from '@/components/anime/MediaGrid';
import { GridSkeleton } from '@/components/anime/GridSkeleton';
import { LoadingBoundary } from '@/components/ui/LoadingBoundary';
import { MediaRow, MEDIA_ROW_HEIGHT } from '@/components/anime/MediaRow';
import { AppIcon } from '@/components/ui/AppIcon';
import { RoundedPressable } from '@/components/ui/RoundedPressable';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { PillSelector, type PillItem } from '@/components/ui/Pills';
import { SearchField } from '@/components/ui/SearchField';
import { Shimmer, ShimmerSweep, sweepAt } from '@/components/ui/Shimmer';
import { useTheme } from '@/lib/ui/useTheme';
import { alpha } from '@/lib/ui/color';
import { font, layout, radii, spacing } from '@/lib/ui/tokens';
import { useTabBarClearance } from '@/lib/ui/tabBar';
import type { TileStyleKey } from '@/lib/settings/store';

/**
 * How long the results wait on the wire before the screen replaces them.
 *
 * Longer than explore's 260ms filter debounce on purpose. Typing "cowboy bebop"
 * produces eleven intermediate queries, and each one that reaches AniList is a
 * request against a ~30/minute budget spent on prefixes nobody will ever look
 * at. 340ms is under the threshold where a search FEELS laggy while typing
 * (people notice ~500ms) and above the inter-keystroke gap of a fast typist.
 */
const DEBOUNCE_MS = 340;

/** Which layout the results are in. Matches explore's switch, on purpose. */
type ResultLayout = 'three' | 'rows';
const LAYOUT_ITEMS: PillItem<ResultLayout>[] = [
  { key: 'three', label: '', a11yLabel: 'Poster grid', icon: 'layoutThree' },
  { key: 'rows', label: '', a11yLabel: 'List rows', icon: 'layoutList' },
];

/**
 * The grid's row geometry, hoisted. It never varies, and an inline literal here
 * would hand every render a fresh object for FlatList to shallow-diff against
 * each row on every batch.
 */
const GRID_ROW_STYLE = { gap: GRID_GAP, paddingHorizontal: layout.gutter };

/**
 * The idle state's quick picks.
 *
 * Every term here is VERIFIED to return results on AniList — a chip that
 * searches to nothing is a broken promise sitting on the screen's first frame,
 * and "popular" is exactly the kind of list that rots as the catalogue shifts.
 * Half of them (One Piece, JJK, AoT, Demon Slayer, Frieren) return the 5000
 * cap, so tapping one also demonstrates that the pager exists.
 *
 * A hardcoded list, on purpose: fetching real "trending searches" would spend a
 * request before the user has asked anything, against a budget this screen is
 * explicitly trying to protect.
 */
const POPULAR: string[] = [
  'One Piece',
  'Jujutsu Kaisen',
  'Attack on Titan',
  'Demon Slayer',
  'Frieren',
  'Solo Leveling',
  'Chainsaw Man',
  'Cowboy Bebop',
];

/** Module-scope, so the "no query yet" render does not allocate. */
const EMPTY_ITEMS: MediaItem[] = [];

export default function SearchScreen() {
  const { color } = useTheme();
  const { width: screenW } = useWindowDimensions();
  const offset = useNavOffset();
  const tabBarSpace = useTabBarClearance();
  const tileStyle = useSetting('home.tileStyle');
  const { recent, loaded: recentsLoaded, remember, clearAll } = useRecentSearches();

  const listRef = useRef<FlatList<MediaItem>>(null);
  /** The field itself — the NavBar's search button focuses it through here. */
  const inputRef = useRef<TextInputInstance>(null);

  /**
   * A query handed over by the omnibox, as a route param.
   *
   * A param rather than a module store because it survives a process death and
   * a deep link, and because Back then returns the user to wherever they
   * started searching instead of stranding them on the search tab.
   *
   * It costs NOTHING in requests: the omnibox already fetched this exact page-1
   * result under the same cache key, so the fetch below is served from memory.
   */
  const { q: handedOff } = useLocalSearchParams<{ q?: string }>();

  useEffect(() => {
    if (typeof handedOff !== 'string') return;
    const term = tidyQuery(handedOff);
    if (!term) return;
    // Fill the field too, not just the results — otherwise the page shows
    // results for a term the user cannot see or edit, and the clear button has
    // nothing to clear.
    setText(term);
    setQuery(term);
  }, [handedOff]);

  /**
   * `query` is what the user TYPED (tidy, casing intact) — it is what the
   * field, the count line and the recent-search chips all show. `key` is its
   * lowercased identity: cache key, recents de-duplication, minimum-length
   * test. Two names for two jobs, because one of them must not be shown to
   * anyone.
   *
   * NOTE: on the search tab the nav-bar search button focuses the field rather
   * than opening the omnibox — this screen already has a field, and a second one
   * on top of it would be two competing fields. Everywhere ELSE the omnibox
   * hands its query here as a `?q=` param, which is why `text` can be set from
   * outside as well as by typing.
   */
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  const key = useMemo(() => normaliseQuery(query), [query]);

  const [page, setPage] = useState(1);
  const [layoutMode, setLayoutMode] = useState<ResultLayout>('three');

  useFocusEffect(
    useCallback(() => {
      updateBrowsing('Searching anime');
    }, [])
  );

  // ---- debounce ----------------------------------------------------------

  useEffect(() => {
    const t = setTimeout(() => setQuery(tidyQuery(text)), DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [text]);

  // ---- fetch -------------------------------------------------------------

  /**
   * The results, from the cache first.
   *
   * Everything this screen used to do by hand is now the query's job: the
   * `requestId` counter that guarded against out-of-order responses (the query
   * key IS the query, so a response for a query you have moved on from belongs
   * to an entry nobody is observing), the manual cache clear on retry, and the
   * `setItems([])`-then-refetch that blanked the list on every keystroke.
   *
   * That last one is worth calling out, because it was the screen's worst
   * behaviour: typing one more character emptied the results and showed a
   * skeleton, so searching felt like it restarted on every key. Now a keystroke
   * that extends the query keeps the previous page's tiles on screen, dimmed,
   * until the new ones land.
   */
  const searching = isSearchable(key);
  const {
    data: result,
    error,
    isFetching: busy,
    refetch,
  } = useSearchResults(query, page, { enabled: searching });

  const items = searching ? (result?.items ?? EMPTY_ITEMS) : EMPTY_ITEMS;
  const pageCount = useMemo(
    () => (result ? searchPageCount(result, page) : 1),
    [result, page]
  );
  /** What the list actually renders: nothing at all until the query qualifies. */
  const results = items;

  /**
   * Remember a query that actually found something.
   *
   * Only the first page counts: paging is not a new intent. Remembered with the
   * casing it was typed in, not the lowercased cache key, so the chip reads
   * "Frieren" and not "frieren". No minimum-length test is needed — a query that
   * reached this point has already passed `SEARCH_MIN_CHARS` to get a request.
   *
   * Keyed on the NORMALISED query rather than the raw text, so "cowboy bebop"
   * and "Cowboy Bebop" remember once between them.
   */
  const remembered = useRef<string | null>(null);
  useEffect(() => {
    if (!searching || !result?.items.length || page !== 1) return;
    if (remembered.current === key) return;
    remembered.current = key;
    void remember(query);
  }, [searching, result, page, key, query, remember]);

  /**
   * A NEW query always starts at page 1 and starts at the top.
   *
   * Both, deliberately. Keeping page 3 across a query change would show the tail
   * of an unrelated result set — the exact bug the explore screen's filter
   * chrome was built to avoid. And the list is very often scrolled down when you
   * edit the field, so without the reset the new results land off-screen with
   * nothing to indicate it.
   */
  const prevKey = useRef(key);
  useEffect(() => {
    if (prevKey.current === key) return;
    prevKey.current = key;
    setPage(1);
    listRef.current?.scrollToOffset({ offset: 0, animated: false });
  }, [key]);

  const goToPage = useCallback(
    (next: number) => {
      if (!searching || next === page || next < 1 || next > pageCount) return;
      setPage(next);
      // Back to the top: page 3 of a fresh query is a different set of
      // twenty-four titles, not a continuation of where you were, and landing
      // mid-list on an unrelated page reads as the app having lost its place.
      listRef.current?.scrollToOffset({ offset: 0, animated: false });
    },
    [searching, page, pageCount]
  );

  /**
   * Retry after a failure.
   *
   * A bare `refetch`, with no cache clear, and that is a change worth recording:
   * the old version had to call `clearSearchCache()` first, because a failure
   * inside the 60s TTL was served straight back out of memory and the button did
   * precisely nothing — the worst thing a retry button can do, because it looks
   * like it worked.
   *
   * It cannot happen now. An errored query is not served from cache (TanStack
   * retries an errored entry on demand regardless of `staleTime`), and errors are
   * never written to disk at all — see `dehydrateOptions`. So there is nothing to
   * clear, and clearing would only risk throwing away good results from an
   * earlier page of the same query.
   */
  const retry = useCallback(() => {
    void refetch();
  }, [refetch]);


  /** Recalling a recent or popular term fills the field and searches it. */
  const focusField = useCallback(() => {
    inputRef.current?.focus();
  }, []);

  /**
   * The NavBar's search button, tapped from any screen. On arrival here it
   * means "put the caret in the field" — and tapped while already here it means
   * the same thing, which is why this single hook covers both moments. See
   * `lib/search/focus.ts`.
   */
  useSearchFocusRequest(focusField);

  const search = useCallback(
    (term: string) => {
      setText(term);
      // Commit it NOW rather than waiting out the debounce. Tapping a chip is an
      // explicit request; making it wait 340ms for a keystroke that is not
      // coming is the field second-guessing you.
      setQuery(tidyQuery(term));
    },
    [setQuery, setText]
  );

  // Guarded — see `lib/nav/pushOnce.ts`. Search is where the report came from
  // most often: a cold result list is the most likely thing to be mid-layout
  // when the user taps it.
  const openMedia = useCallback((m: MediaItem) => openAnime(m.id), []);

  // ---- derived -----------------------------------------------------------

  const lastIndex = results.length - 1;
  /**
   * Readability guard, copied from explore: below ~92px a tile the caption is
   * illegible, and a ~320dp phone lands there. It only ever fires on a narrow
   * screen, and it is a guard rather than a choice — hence no column-count
   * option anywhere.
   */
  const tileColumns = gridTileWidth(screenW, 3) >= 92 ? 3 : 2;
  const columns = layoutMode === 'rows' ? 1 : tileColumns;
  const tileW = useMemo(
    () => (columns > 1 ? gridTileWidth(screenW, columns, GRID_GAP) : 0),
    [screenW, columns]
  );

  const renderTile = useCallback<ListRenderItem<MediaItem>>(
    ({ item }) => (
      <View style={{ width: tileW }}>
        <PosterCard media={item} variant={tileStyle} width={tileW} onPress={openMedia} />
      </View>
    ),
    [tileW, tileStyle, openMedia]
  );

  // With `numColumns === 1` FlatList hands `renderItem` the ABSOLUTE index, which
  // is what lets the divider below be "every row but the last" without an
  // `ItemSeparatorComponent` — a separator would add its own height and break
  // the `getItemLayout` contract two comments down.
  const renderRow = useCallback<ListRenderItem<MediaItem>>(
    ({ item, index }) => <MediaRow media={item} onPress={openMedia} divider={index < lastIndex} />,
    [openMedia, lastIndex]
  );

  /**
   * `getItemLayout` for the ROW layout only.
   *
   * Rows have a height this codebase controls (`MEDIA_ROW_HEIGHT`), so the
   * arithmetic is exact and the list can jump to any row without measuring.
   *
   * The grid deliberately has none. A poster tile's height is its width times
   * the poster ratio PLUS a caption whose height depends on the variant (framed
   * card padding vs bare page) and on `StyleSheet.hairlineWidth`, which is not
   * a number. An estimate here is not a small inaccuracy — `getItemLayout` is a
   * promise, and VirtualizedList scrolls to exactly the offset you hand it, so
   * a wrong height means overlapping rows and a content height that grows as
   * you scroll. No promise is better than a broken one; the grid still
   * virtualises, it just measures as it goes.
   */
  const getRowLayout = useCallback(
    (_data: ArrayLike<MediaItem> | null | undefined, index: number) => ({
      length: MEDIA_ROW_HEIGHT,
      offset: MEDIA_ROW_HEIGHT * index,
      index,
    }),
    []
  );

  return (
    <View style={[styles.container, { backgroundColor: color.bg.primary }]}>
      {/* `isSearchTab` so the button focuses the field below instead of expanding
          the omnibox over it. Passed in rather than detected with `usePathname`
          inside NavBar — that would re-render every screen's nav bar on every
          navigation. See the note on `NavBarProps.isSearchTab`. */}
      <NavBar title="Search" isSearchTab />

      {/* THE FIXED HEADER. Outside the list on purpose — see the header note. */}
      <View style={[styles.header, { paddingTop: offset }]}>
        <SearchField
          ref={inputRef}
          value={text}
          onChangeText={setText}
          placeholder="Search anime by title"
          onSubmit={() => setQuery(tidyQuery(text))}
        />

        {/* ALWAYS rendered, never conditionally — and that is the point.
            This row carries the minimum-length rule when there is no query yet
            and the result count once there is one. Making it appear at the
            threshold would push the whole list down 28px at the exact moment
            the user is typing the third character and watching for results, so
            the content would lurch at the moment it is being looked at
            hardest. A fixed row that changes its words has no layout change at
            all; the layout switch fills the same 28px it already occupies. */}
        <View style={styles.metaRow}>
          <Text style={[styles.count, { color: color.text.muted }]} numberOfLines={1}>
            {!searching
              ? `At least ${SEARCH_MIN_CHARS} characters`
              : busy && !items.length
                ? 'Searching…'
                : `${items.length} ${items.length === 1 ? 'result' : 'results'} for “${query}”`}
          </Text>
          {searching ? (
            <PillSelector
              items={LAYOUT_ITEMS}
              value={layoutMode}
              onChange={setLayoutMode}
              height={28}
              accessibilityPrefix="Result layout"
            />
          ) : null}
        </View>
      </View>

      <FlatList
        ref={listRef}
        // `key` on the column count is REQUIRED, not a workaround: FlatList
        // reads `numColumns` once when the rows are built, so changing it
        // without remounting leaves every row the old width.
        key={columns}
        data={results}
        numColumns={columns}
        // The gutter and the gap both live on the ROW, never on a per-item
        // margin: a margin on the last cell of a row is the classic "why is
        // this grid narrower than the screen" bug, and `space-between` would
        // drift a pixel per row as the leftover remainder is divided up. The
        // rows layout carries its own inset inside `MediaRow`, which is why
        // this is only set when there is more than one column.
        columnWrapperStyle={columns > 1 ? GRID_ROW_STYLE : undefined}
        renderItem={layoutMode === 'rows' ? renderRow : renderTile}
        getItemLayout={layoutMode === 'rows' ? getRowLayout : undefined}
        keyExtractor={keyExtractor}
        // Stale-while-revalidate: paging dims the page you are leaving rather
        // than blanking it. Twenty-four tiles vanishing for 400ms is a worse
        // experience than twenty-four tiles that are briefly the old ones.
        style={busy && results.length ? styles.stale : undefined}
        contentContainerStyle={[styles.list, { paddingBottom: tabBarSpace }]}
        // The field is a sibling of the list, not above it, so tapping a tile
        // must not steal focus and dismiss the keyboard mid-scroll.
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        showsVerticalScrollIndicator={false}
        // Off deliberately: with `expo-image`, clipping unmounts tiles whose
        // bitmap has not finished decoding and you get grey flashes on a fast
        // fling. Memory is already bounded by the windowed batch sizes below.
        removeClippedSubviews={false}
        initialNumToRender={12}
        maxToRenderPerBatch={8}
        updateCellsBatchingPeriod={40}
        windowSize={9}
        ListFooterComponent={
          searching && items.length ? (
            <PageControl page={page} pageCount={pageCount} onChange={goToPage} busy={busy} />
          ) : undefined
        }
        ListEmptyComponent={
          <SearchEmpty
            searching={searching}
            query={query}
            busy={busy}
            error={error ? error.message : null}
            recentsLoaded={recentsLoaded}
            recent={recent}
            onPick={search}
            onClearRecents={clearAll}
            onRetry={retry}
            columns={tileColumns}
            screenW={screenW}
            tileStyle={tileStyle}
          />
        }
      />
    </View>
  );
}

// ---------------------------------------------------------------------------
// Bits of the screen small enough not to deserve their own file
// ---------------------------------------------------------------------------

function keyExtractor(item: MediaItem): string {
  return String(item.id);
}

/**
 * Everything the list shows when it has no rows: the landing state, the
 * skeleton, the failure, and the "nothing matched".
 *
 * Four states, one component, because they are four answers to the same
 * question — "there is nothing here, and this is why". Split across four
 * components they would each re-derive the same conditions and drift out of
 * agreement about which one wins.
 */
function SearchEmpty({
  searching,
  query,
  busy,
  error,
  recentsLoaded,
  recent,
  onPick,
  onClearRecents,
  onRetry,
  columns,
  screenW,
  tileStyle,
}: {
  searching: boolean;
  query: string;
  busy: boolean;
  error: string | null;
  recentsLoaded: boolean;
  recent: string[];
  onPick: (term: string) => void;
  onClearRecents: () => void;
  onRetry: () => void;
  columns: number;
  screenW: number;
  tileStyle: TileStyleKey;
}) {
  const { color } = useTheme();

  // ---- landing: no query yet -------------------------------------------
  if (!searching) {
    /**
     * THE LANDING STATE GETTING ITS RECENT SEARCHES.
     *
     * `useRecentSearches` reads AsyncStorage, which is async, so for one frame
     * the list is empty and the old code rendered nothing at all. That reads as a
     * blank screen on the app's fourth tab, which is the first thing a new user
     * taps — so the popular searches that need NO storage read are painted
     * immediately and the recent chips join them when they arrive.
     *
     * `LoadingBoundary` fades the whole thing in on the UI thread, so there is no
     * pop when the stored terms land.
     */
    return (
      <LoadingBoundary
        loading={!recentsLoaded}
        skeleton={<SearchLandingSkeleton />}
      >
        <View style={styles.landing}>
          {recent.length ? (
            <View style={styles.landingSection}>
              <SectionHeader
                title="Recent"
                trailing={<ClearLink onPress={onClearRecents} />}
              />
              <View style={styles.chipWrap}>
                {recent.map((term) => (
                  <SearchChip key={term} label={term} onPress={() => onPick(term)} />
                ))}
              </View>
            </View>
          ) : null}

          <View style={styles.landingSection}>
            <SectionHeader title="Popular searches" />
            <View style={styles.chipWrap}>
              {POPULAR.map((term) => (
                <SearchChip key={term} label={term} onPress={() => onPick(term)} />
              ))}
            </View>
          </View>
        </View>
      </LoadingBoundary>
    );
  }

  // ---- error ------------------------------------------------------------
  if (error) {
    return (
      <View style={[styles.errBox, { backgroundColor: alpha(color.status.danger, 0.1) }]}>
        <Text style={[styles.errTitle, { color: color.text.primary }]}>
          Could not reach AniList
        </Text>
        <Text style={[styles.errBody, { color: color.text.muted }]}>{error}</Text>
        <RetryButton label="Try again" onPress={onRetry} />
      </View>
    );
  }

  // ---- loading ----------------------------------------------------------
  if (busy) return <GridSkeleton columns={columns} screenW={screenW} tileStyle={tileStyle} />;

  // ---- nothing matched --------------------------------------------------
  return (
    <GridEmpty
      title={`Nothing matches “${query}”`}
      hint="Try fewer words, the original title, or a different spelling — AniList indexes both English and Japanese names."
    />
  );
}

/**
 * The landing state, at its real geometry, for the one or two frames it takes
 * `useRecentSearches` to read AsyncStorage.
 *
 * Two sections' worth of chips, because that is exactly what arrives — a heading
 * bar and a wrapped run of pills per section. Filling the space with the real
 * shape is the whole point: the stored terms land into a layout that is already
 * the right size, so nothing jumps.
 *
 * Lit by one `ShimmerSweep`, so the band runs across a chip row and down into
 * the next section rather than the whole landing state flaring at once. The
 * chip widths vary deliberately — a row of identical plates would WRAP
 * differently, and the real chips would still jump.
 */
function SearchLandingSkeleton() {
  const { color } = useTheme();
  const plate = color.bg.elevated;

  /** How far the second section trails the first, in clock units. */
  const SECTION_LEAD = 0.25;
  const CHIP_SPAN = 0.5;
  const span = SECTION_LEAD + CHIP_SPAN;

  return (
    <ShimmerSweep span={span}>
      <View style={styles.landing}>
        {[0, 1].map((section) => {
          const base = section * SECTION_LEAD;
          const widths = [132, 96, 148, 84, 116].slice(0, section === 0 ? 3 : 5);
          return (
            <View key={section} style={styles.landingSection}>
              <Shimmer
                plate={plate}
                radius={radii.full}
                style={styles.skeletonHeading}
                at={base}
              />
              <View style={styles.chipWrap}>
                {widths.map((w, i) => (
                  <Shimmer
                    key={i}
                    plate={plate}
                    radius={radii.full}
                    style={[styles.skeletonChip, { width: w }]}
                    at={sweepAt(i, widths.length, CHIP_SPAN, base)}
                  />
                ))}
              </View>
            </View>
          );
        })}
      </View>
    </ShimmerSweep>
  );
}

/**
 * A tappable term — a recent search or a quick pick.
 *
 * One pressable per chip with a whole-label hit target, rather than a pill with
 * a separate X inside it. Nesting a second pressable inside the first splits
 * the touch target down the middle, and on Android the ripple of the outer one
 * gets clipped by the inner's radius. "Clear" for the whole list lives in the
 * section header instead, which is where every platform puts it.
 */
function SearchChip({ label, onPress }: { label: string; onPress: () => void }) {
  const { color } = useTheme();
  return (
    <RoundedPressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Search for ${label}`}
      radius={9999}
      style={[
        styles.chip,
        {
          backgroundColor: color.bg.surface,
          borderColor: color.border.muted,
        },
      ]}
    >
      <AppIcon name="search" size={12} color={color.text.muted} strokeWidth={2.2} />
      <Text style={[styles.chipText, { color: color.text.secondary }]} numberOfLines={1}>
        {label}
      </Text>
    </RoundedPressable>
  );
}

function ClearLink({ onPress }: { onPress: () => void }) {
  const { color } = useTheme();
  return (
    <RoundedPressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel="Clear recent searches"
      hitSlop={8}
      radius={8}
      style={styles.clearLink}
    >
      <Text style={[styles.clearLinkText, { color: color.text.muted }]}>Clear</Text>
    </RoundedPressable>
  );
}

function RetryButton({ label, onPress }: { label: string; onPress: () => void }) {
  const { color } = useTheme();
  return (
    <RoundedPressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      radius={9999}
      style={[styles.retry, { borderColor: color.border.strong }]}
    >
      <AppIcon name="reset" size={14} color={color.text.primary} />
      <Text style={[styles.retryText, { color: color.text.primary }]}>{label}</Text>
    </RoundedPressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    paddingHorizontal: layout.gutter,
    paddingBottom: spacing.md,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    marginTop: spacing.md,
    minHeight: 28,
  },
  count: {
    flex: 1,
    fontSize: 12.5,
    lineHeight: 16,
    fontFamily: font.medium,
    letterSpacing: 0.2,
  },
  // Cheap: one opacity change, no animation, no layout. An Animated.View here
  // would cost JS-thread work for something that changes twice per query.
  stale: { opacity: 0.5 },
  list: {
    // NO horizontal padding here. Each renderer owns its own gutter —
    // `columnWrapperStyle` for the grid, `MediaRow` for the rows, the chip rows
    // for the landing state — so padding the container too would double the
    // inset on all three.
    flexGrow: 1,
  },

  // ---- landing ----
  landing: {
    paddingTop: spacing.xs,
  },
  // Both placeholder styles are sized off the real ones they stand in for: the
  // heading bar is `SectionHeader`'s row height and the chip is the real chip's
  // 34px, so the landing state does not resize when the stored terms arrive.
  // No background or radius here — the `Shimmer` is the plate and takes both as
  // props.
  skeletonHeading: {
    height: 14,
    width: 128,
    marginLeft: layout.gutter,
    marginBottom: spacing.md,
  },
  skeletonChip: { height: 34 },
  landingSection: {
    // The ONE section gap, same value explore uses, so every heading on every
    // screen sits on one vertical rhythm.
    marginTop: spacing.xxl,
  },
  chipWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm - 2,
    paddingHorizontal: layout.gutter,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: 34,
    paddingHorizontal: spacing.md,
    borderRadius: radii.full,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
    // Long titles must not stretch a chip across the screen; the text truncates
    // inside this cap instead.
    maxWidth: '100%',
  },
  chipText: {
    flexShrink: 1,
    fontSize: 13,
    lineHeight: 17,
    fontFamily: font.semibold,
    letterSpacing: 0.1,
  },
  clearLink: { paddingHorizontal: spacing.sm, paddingVertical: 4 },
  clearLinkText: { fontSize: 12, lineHeight: 15, fontFamily: font.semibold, letterSpacing: 0.2 },

  // ---- error ----
  errBox: {
    marginTop: spacing.xl,
    marginHorizontal: layout.gutter,
    padding: spacing.lg,
    borderRadius: radii.xl,
    alignItems: 'center',
    gap: spacing.sm,
  },
  errTitle: { fontSize: 15, lineHeight: 20, fontFamily: font.semibold },
  errBody: {
    fontSize: 13,
    lineHeight: 18,
    fontFamily: font.medium,
    textAlign: 'center',
  },
  retry: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: 38,
    paddingHorizontal: spacing.lg,
    marginTop: spacing.sm,
    borderRadius: radii.full,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  retryText: { fontSize: 13.5, lineHeight: 18, fontFamily: font.semibold },
});
