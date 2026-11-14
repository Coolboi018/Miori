// EXPLORE — a browse surface, not a second home page.
//
// The screen this replaced was rails: seasonal, then six format rails, then
// three status rails, ten of them, with the same ten results fetched twice and
// printed twice. Home is a *stack of rails* because home answers "what is
// happening"; explore has to answer "show me the one I want", and that is a
// different job with a different shape.
//
//   1. HERO            the same carousel as home — it is the best thing in the
//                      app and duplicating it is free
//   2. BROWSE          THE reason for the screen. Genre pills, five dropdowns,
//                      a reset, a chip summary, and a real grid of tiles —
//                      nine at a time, behind a page control, in a box of a
//                      FIXED height so the page below never creeps downward
//   3. AIRING          list view — a chart, not a rail (ranks + score rings)
//   4. SPOTLIGHT       genre mosaic — one feature tile over four portraits
//   5. FAN FAVOURITES  banner rail — a third tile shape
//   6. TOP RATED       poster rail
//   7. FEATURE FILMS   banner grid, two up
//   8. COMING SOON     poster rail
//
// Two requests, not ten. `fetchExploreSections` is one aliased query; the grid
// is a second, keyed on the filter signature. First paint blocks on both, then
// every later focus refreshes silently — the same stale-while-revalidate shape
// home uses, because a spinner on every tab switch makes the app feel stuck.
//
// THE FILTER CHROME IS ONE OBJECT. The genre pills, the five dropdowns, the
// chips and the reset are four views of a single `ExploreFilters`. Nothing here
// holds filter state of its own, so a chip and a dropdown cannot disagree.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Image } from 'expo-image';
import { openAnime } from '@/lib/nav/pushOnce';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  // Strict TypeScript API (RN 0.88): element refs are instance types — the
  // component function types no longer expose the imperative methods.
  type FlatListInstance,
} from 'react-native';
import { useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  DEFAULT_FILTERS,
  MAX_GENRES,
  hasActiveFilters,
  type ExploreFilters,
} from '@/lib/anilist/explore';
import {
  activeChips,
  FORMAT_FILTERS,
  GENRE_PILLS,
  SCORE_FILTERS,
  SORT_FILTERS,
  STATUS_FILTERS,
  YEAR_FILTERS,
  type FilterChipDef,
} from '@/lib/explore/filters';
import { updateBrowsing } from '@/lib/presence/discord';
import { useBrowseGrid, useExploreSections } from '@/lib/query/hooks';
import { prefetchAnime } from '@/lib/query/prefetch';
import { qk } from '@/lib/query/keys';
import { queryClient } from '@/lib/query/client';

import { NavBar } from '@/components/nav/NavBar';
import { HeroCarousel } from '@/components/anime/HeroCarousel';
import { MediaRail } from '@/components/anime/MediaRail';
import { MediaListSection } from '@/components/anime/MediaListSection';
import { MediaBannerCard } from '@/components/anime/MediaBannerCard';
import { FeatureMosaic } from '@/components/anime/FeatureMosaic';
import {
  GridEmpty,
  MediaBannerGrid,
  MediaGrid,
  PageControl,
  gridTileWidth,
} from '@/components/anime/MediaGrid';
import { GridSkeleton } from '@/components/anime/GridSkeleton';
import { HomeSkeleton } from '@/components/anime/HomeSkeleton';
import { LoadingBoundary } from '@/components/ui/LoadingBoundary';
import { CenterLabel, SectionHeader } from '@/components/ui/SectionHeader';
import { SectionLink } from '@/components/ui/SectionLink';
import { takeBrowse } from '@/lib/explore/pendingBrowse';
import { openListSheet, LIST_LONG_PRESS_MS } from '@/lib/list/listSheet';
import { AppIcon } from '@/components/ui/AppIcon';
import { RailScrollbar } from '@/components/ui/RailScrollbar';
import { FilterChip, FilterDropdown, ResetFiltersButton } from '@/components/ui/FilterDropdown';
import { PillSelector, PillToggle, type PillItem } from '@/components/ui/Pills';
import { useTheme } from '@/lib/ui/useTheme';
import { font, layout, spacing } from '@/lib/ui/tokens';
import { useTabBarClearance } from '@/lib/ui/tabBar';
import { useSetting } from '@/lib/settings/useSetting';
import type { TileStyleKey } from '@/lib/settings/store';
import type { MediaItem } from '@/lib/anilist';

/**
 * Results per page. NINE, not twelve, and the number is load-bearing: it is
 * what makes the Browse box a FIXED height. Three rows of three tiles (or nine
 * list rows) fits a phone without the box ever needing to scroll internally,
 * which is the whole point — an internally-scrolling grid nested in a
 * vertically-scrolling page is a gesture trap on Android, and you cannot drag
 * the page past it.
 */
const PAGE = 9;
/** A floor for the page count so `Math.ceil` on a zero total is never 0. */
const MIN_PAGES = 1;

/**
 * How the Browse results are laid out. TWO options, not three: a 2-up grid
 * turned out to be the one nobody reached for — it looked like the poster grid
 * with the gutters gone rather than like a different mode — so the switch is
 * now "tiles or rows", which is a real choice about how you scan.
 */
type GridLayout = 'three' | 'rows';
const LAYOUT_ITEMS: PillItem<GridLayout>[] = [
  { key: 'three', label: '', a11yLabel: 'Three-up tiles', icon: 'layoutThree' },
  { key: 'rows', label: '', a11yLabel: 'List rows', icon: 'layoutList' },
];

/** 74% of the screen: the next banner always peeks, which is the affordance. */
function bannerRailWidth(screenW: number): number {
  return Math.round(screenW * 0.74);
}

const EMPTY_FILTER_RESULT = { items: [], total: 0, hasNextPage: false, approximate: false };

export default function ExploreScreen() {
  const { color } = useTheme();
  const { width: screenW } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const tabBarSpace = useTabBarClearance();
  const tileStyle = useSetting('home.tileStyle');

  /**
   * What the CHIPS show — updated synchronously on every tap.
   *
   * Deliberately separate from `gridQuery` below, and the split is what keeps
   * both halves honest: the chip has to light up the instant it is tapped, while
   * the request has to wait for the user to stop tapping. Driving the query from
   * this state made one of the two wrong — debouncing it left the chip dead for
   * 260ms, and not debouncing it fired the request per tap.
   */
  const [filters, setFilters] = useState<ExploreFilters>(DEFAULT_FILTERS);
  const [gridLayout, setGridLayout] = useState<GridLayout>('three');

  /**
   * WHAT THE GRID IS ACTUALLY ASKING FOR — one object, not two.
   *
   * These used to be two pieces of state (`filters` fed the query, `gridPage`
   * was separate), which is why every filter change fired TWO requests. The page
   * reset was debounced and the filter change was not, so the query key walked
   * through an intermediate combination:
   *
   *   render 1  ['browse', newFilters, 3]   <- request fires
   *   render 2  ['browse', newFilters, 1]   <- request fires, 260ms later
   *
   * Two keys is two questions, so two requests. The first was not merely
   * redundant — with `placeholderData: keepPreviousData` it PAINTED, so for 260ms
   * the grid showed page 3 of the old filter set, then page 3 of the new one,
   * before page 1 arrived. That is precisely the "tail of an unrelated result
   * set" the debounce above it exists to prevent.
   *
   * Filters and page are committed TOGETHER, as one object. That makes it a
   * single state transition with a single identity: one render, one key, one
   * request. It does not depend on React batching the two setters — even if the
   * component rendered twice, the key would be identical on the second pass and
   * nothing would refire.
   *
   * `page` starts at 0 — "not fetched yet" — so the pager never claims to be on
   * page 1 of something that has not arrived.
   */
  const [gridQuery, setGridQuery] = useState<{
    filters: ExploreFilters;
    page: number;
  }>({ filters: DEFAULT_FILTERS, page: 0 });

  const [refreshing, setRefreshing] = useState(false);

  // Scrolling to the Browse grid — the one navigation any filter control on
  // this screen performs, and what makes "See all" feel like it went somewhere.
  //
  // The page is now a FlatList of named section-blocks (see `blocks` below),
  // mirroring home. Targeting the Browse section by its ROW KEY keeps the jump
  // correct no matter which sections mount or unmount above it as data arrives —
  // a measured pixel offset (`browseY`) went stale the moment a section above
  // appeared or disappeared.
  const scrollRef = useRef<FlatListInstance>(null);
  const browseIndexRef = useRef(0);

  // ---- data ------------------------------------------------------------

  /**
   * THE TWO REQUESTS, INDEPENDENTLY.
   *
   * They used to be awaited together behind one `booted` flag that replaced the
   * whole screen with a spinner, which meant the curated sections — eight
   * sections' worth of content — waited on the nine-tile grid as well. Separate
   * queries, separate loading states: the rails can paint as soon as THEY
   * arrive, and the grid shows its own skeleton in its own box.
   *
   * `refetch` on focus respects each query's own `staleTime`, so coming back
   * inside the minute costs nothing.
   */
  const {
    data: sections,
    error: sectionsError,
    isFetching: sectionsFetching,
  } = useExploreSections();

  const { data: gridResult, error: gridError, isFetching: gridFetching } = useBrowseGrid(
    gridQuery.filters,
    Math.max(1, gridQuery.page),
    PAGE
  );

  const grid = gridResult?.items ?? EMPTY_FILTER_RESULT.items;
  const gridTotal = gridResult?.total ?? 0;
  const gridApprox = gridResult?.approximate ?? false;
  const gridHasMore = gridResult?.hasNextPage ?? false;
  const gridBusy = gridFetching && grid.length > 0;
  /** True only while the FIRST page of the FIRST load is unresolved. */
  const gridBooting = !gridResult && gridFetching;
  const error = sectionsError ?? gridError;

  /**
   * A TAB SWITCH DOES NOTHING HERE — see the long note on home's focus effect.
   *
   * All three of the things this used to do were wrong: `refetch()` bypassed
   * `staleTime` so it forced a request on every tap, the blur cleanup prefetched
   * three more, and the dependency was the whole `useQuery` result object (new
   * every render) so the effect re-subscribed per render and the "on blur"
   * prefetch ran per RENDER.
   *
   * Empty dependency list on purpose. The only thing left is the presence frame,
   * which is fire-and-forget, and it is why this effect has no dependency that
   * could change identity.
   */
  useFocusEffect(
    useCallback(() => {
      updateBrowsing('Explore');
    }, [])
  );

  const open = useCallback(
    (m: MediaItem) => {
      // See the note on home's `open`: the tap has committed, so warming the
      // detail payload here starts the next screen's one heavy request a frame
      // early rather than after the navigation has already animated.
      prefetchAnime(m.id);
      // Guarded — see `lib/nav/pushOnce.ts`. Same reason as home's `open`.
      openAnime(m.id);
    },
    []
  );

  /**
   * THE BANNER RAIL, VIRTUALISED.
   *
   * Each `MediaBannerCard` is a full-width 16:9 image with several text views on
   * top, so eight of them mapped at once is eight banner decodes plus roughly
   * fifty views — live on a tab that is mounted from boot because of
   * `lazy: false`. This was the single heaviest rail in the app, and the
   * view count across mounted tabs is what the platform re-walks on every layout
   * pass, which is what made the tab bar slow.
   *
   * Three up front is right here rather than six: a banner is 74% of the screen
   * width, so a phone shows one and a bit. Anything beyond the first couple is
   * only ever seen by swiping.
   *
   * `getItemLayout` is exact because the width is a fixed fraction of the screen
   * and the gap is a token, so the list is told its geometry instead of
   * measuring it — which is what makes such a small `initialNumToRender` safe.
   */
  const bannerW = useMemo(() => bannerRailWidth(screenW), [screenW]);
  const bannerStride = bannerW + spacing.md;
  const bannerKey = useCallback((m: MediaItem) => String(m.id), []);
  const renderBanner = useCallback(
    ({ item, index }: { item: MediaItem; index: number }) => (
      <MediaBannerCard
        media={item}
        width={bannerW}
        onPress={open}
        kicker={String(index + 1).padStart(2, '0')}
      />
    ),
    [bannerW, open]
  );
  const bannerLayout = useCallback(
    (_data: ArrayLike<MediaItem> | null | undefined, index: number) => ({
      length: bannerW,
      offset: bannerStride * index,
      index,
    }),
    [bannerW, bannerStride]
  );


  // Debounced, and ALWAYS page 1. Changing a filter changes what page 3 even
  // means — a narrowed genre might have two pages — so a filter change that
  // kept the page number would either land out of range or, worse, silently
  // show the tail of a completely different result set.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const runGrid = useCallback((f: ExploreFilters) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      // Filters AND page in ONE state update. Setting them separately is what
      // produced the intermediate `['browse', newFilters, 3]` key and the extra
      // request — the page reset has to be part of the same commit as the filter
      // change, not a second one trailing it. See `gridQuery` above.
      setGridQuery({ filters: f, page: 1 });
    }, 260);
  }, []);

  // A pending debounce must not fire after the screen goes away.
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    []
  );

  // NOTE ON PURITY: every writer below builds the next filter object OUTSIDE a
  // `setState` updater. React may invoke an updater more than once, and a
  // request fired from inside one would then go out twice.
  //
  // And note that all four of them now do the same two things in the same order:
  // `setFilters` immediately, so the chip responds, then `runGrid`, which
  // debounces the QUERY. They used to let `setFilters` double as the query
  // trigger, which is the bug this split exists to remove.
  const applyFilters = useCallback(
    (patch: Partial<ExploreFilters>) => {
      const next = { ...filters, ...patch };
      setFilters(next);
      runGrid(next);
    },
    [filters, runGrid]
  );

  // Genre multi-select. Picking a fourth evicts the OLDEST, so the tap always
  // does something visible instead of silently failing at a limit the UI never
  // explained.
  const toggleGenre = useCallback(
    (genre: string) => {
      const has = filters.genres.includes(genre);
      const genres = has
        ? filters.genres.filter((g) => g !== genre)
        : [...filters.genres, genre].slice(-MAX_GENRES);
      applyFilters({ genres });
    },
    [applyFilters, filters.genres]
  );

  const resetFilters = useCallback(() => {
    // Only re-query if anything was actually narrowed — resetting twice in a
    // row should cost nothing.
    if (!hasActiveFilters(filters)) return;
    const next = { ...DEFAULT_FILTERS };
    setFilters(next);
    runGrid(next);
  }, [filters, runGrid]);

  const clearChip = useCallback(
    (chip: FilterChipDef) => {
      if (chip.id.startsWith('genre:')) return toggleGenre(chip.value);
      if (chip.id === 'format') return applyFilters({ format: null });
      if (chip.id === 'status') return applyFilters({ status: null });
      if (chip.id === 'year') return applyFilters({ year: null });
      if (chip.id === 'score') return applyFilters({ minScore: null });
      if (chip.id === 'sort') return applyFilters({ sort: DEFAULT_FILTERS.sort });
    },
    [applyFilters, toggleGenre]
  );

  const jumpToBrowse = useCallback(() => {
    // Target the Browse section by its row key rather than a measured pixel
    // offset — the index is tracked in `browseIndexRef` as `blocks` is built, so
    // it stays correct as sections mount/unmount above it. `viewOffset` leaves
    // room for the floating NavBar so the Browse header lands below it.
    const idx = browseIndexRef.current;
    scrollRef.current?.scrollToIndex({
      index: idx,
      animated: true,
      viewOffset: insets.top + layout.navbarHeight,
    });
  }, [insets.top]);

  /**
   * Pull to refresh. `invalidateQueries` with the two keys rather than a blanket
   * `invalidateQueries()`: a refresh of explore should not re-download the
   * schedule, and the search results the user happened to leave in the cache
   * along the way. Page 1 on refresh too — a pull means "is this still right",
   * and re-fetching the tail of a stale result set is not an answer.
   *
   * Both the reset and the invalidation read `gridQuery.filters`, NOT the chip
   * state. A pull that lands inside the 260ms debounce has the two one filter
   * apart, and invalidating `filters` would refresh a key the grid is not
   * displaying — the refresh would appear to do nothing.
   */
  const onRefresh = useCallback(async () => {
    const f = gridQuery.filters;
    setRefreshing(true);
    setGridQuery({ filters: f, page: 1 });
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: qk.exploreSections() }),
      queryClient.invalidateQueries({ queryKey: qk.browse(f, 1) }),
    ]);
    setRefreshing(false);
  }, [gridQuery.filters]);

  // ---- derived ---------------------------------------------------------

  const chips = useMemo(() => activeChips(filters), [filters]);
  const filtered = useMemo(() => hasActiveFilters(filters), [filters]);
  // The Sort sheet's subtitle: genre filters are an OR across up to three
  // aliases and a score floor cuts both ways, so "how many" is a real question
  // the user has. "Any" for a month is a sentence nobody needs.
  const sortSubtitle = useMemo(() => {
    const bits: string[] = [];
    if (filters.genres.length) bits.push(filters.genres.join(' + '));
    if (filters.format) bits.push(FORMAT_FILTERS.find((o) => o.key === filters.format)?.label ?? '');
    if (filters.year) bits.push(String(filters.year));
    if (filters.minScore != null) bits.push(`${filters.minScore}%+`);
    return bits.filter(Boolean).join('  ·  ') || 'Everything in the catalogue';
  }, [filters]);
  // The switch no longer offers a column count, so this is a readability
  // guard rather than a choice: below ~92px a tile the caption is unreadable,
  // and a ~320dp phone lands there. It only ever fires on a narrow screen.
  const effectiveColumns = gridTileWidth(screenW, 3) >= 92 ? 3 : 2;

  /**
   * How many pages the current filter has. From AniList's own `total`, so the
   * pager is honest — the old "Load more" capped at four pages and never said
   * so, which made a large catalogue look small.
   *
   * A multi-genre filter SUMS its per-alias totals, so the count is inflated by
   * whatever overlap exists. That is what `gridApprox` is for: the label grows
   * a `~` rather than quietly lying.
   */
  const pageCount = Math.max(MIN_PAGES, Math.ceil(gridTotal / PAGE));
  /**
   * The real end of the list, which is not always `pageCount`.
   *
   * A multi-genre filter sums its per-alias totals, so `pageCount` can overshoot
   * by a long way and "next" would walk the user into empty pages. AniList's
   * own `hasNextPage` is the truth, and the arrow stops there.
   */
  const lastPage = useMemo(
    () => Math.min(pageCount, gridQuery.page + (gridHasMore ? 1 : 0)),
    [pageCount, gridQuery.page, gridHasMore]
  );

  /**
   * There is NO height cap on the results box, and that is the whole design.
   *
   * The earlier version put a `maxHeight` on it and enabled scrolling when the
   * content overshot. It overshot by a few pixels, so the box scrolled by a few
   * pixels — a gesture trap nested inside a vertically scrolling page, for no
   * benefit. A ceiling cannot produce "no scrolling": any ceiling small enough
   * to bind will always bind by SOME amount, and the user can drag that amount.
   *
   * So the fixed height comes from where it should: the page size is a constant
   * nine items, which makes the block a constant nine items tall on every
   * screen, in both layouts. No cap, no measurement, no nested ScrollView, and
   * nothing to drag. A plain View cannot scroll, so the "don't scroll, not even
   * a little" requirement is satisfied by construction rather than by tuning.
   *
   * The cost is honest: on a narrow phone the 2-up fallback (five rows of tall
   * tiles) and on a tablet (three very wide rows) both make the block tall.
   * That is what nine posters look like at that size, and the PAGE scroll is
   * the right way to move past it — not a second scroll axis inside it.
   */

  const goToPage = useCallback(
    (page: number) => {
      if (page < 1 || page > lastPage || page === gridQuery.page) return;
      // Paging is a plain page change — the filters are not part of this
      // transition, so they are carried through rather than re-derived from the
      // chip state, which may be a tap ahead of what the grid is showing.
      setGridQuery((q) => (q.page === page ? q : { ...q, page }));
    },
    [lastPage, gridQuery.page]
  );

  // "See all" from any curated section: seed the grid with that section's own
  // definition and jump to it. The rail's placeholder link becomes a control.
  //
  // MERGES, deliberately, because these are this screen's own sections and the
  // user chose the surrounding filters — they tap "Top rated" expecting it within
  // the Sci-Fi they had selected. A seed from ANOTHER screen is not that, which is
  // why `seedFromElsewhere` below replaces instead.
  const seedFilters = useCallback(
    (patch: Partial<ExploreFilters>) => {
      const next = { ...filters, ...patch };
      setFilters(next);
      runGrid(next);
      jumpToBrowse();
    },
    [filters, runGrid, jumpToBrowse]
  );

  /**
   * A seed that REPLACES rather than merges, for links that arrive from home.
   *
   * Home's rails each name a COMPLETE definition — "most popular, any status", not
   * "most popular within whatever explore had lying around". Merging would leave a
   * status filter the user set by hand in place: tap Popular after having narrowed
   * the grid to Airing now and you would land on "most popular, airing now", which
   * is not the rail the button was on. A link that promises a list has to deliver
   * that list.
   *
   * So this starts from `DEFAULT_FILTERS` every time rather than from `filters`.
   *
   * On focus, and consumed once. `takeBrowse` clears the request as it reads it,
   * which is what stops the seed re-applying on every later tab switch — the
   * failure a sticky route param would have had.
   */
  useFocusEffect(
    useCallback(() => {
      const patch = takeBrowse();
      if (!patch) return;
      const next = { ...DEFAULT_FILTERS, ...patch };
      setFilters(next);
      runGrid(next);
      jumpToBrowse();
    }, [runGrid, jumpToBrowse])
  );

  /**
   * A SKELETON FOR THE SECTIONS, AND IT IS PER-SECTION.
   *
   * The grid has always had `GridSkeleton` inside its own fixed-height box, which
   * is correct — that box has a fixed height precisely so it can hold a
   * placeholder. The sections above and below it had none: with no data they
   * simply did not render, so a cold explore showed a hero-shaped hole and then
   * eight sections arriving one after another. `LoadingBoundary` fills that gap
   * with the real rail geometry, so the page does not change shape when the data
   * lands.
   *
   * It is `loading` only while `sections` is undefined AND the request is still
   * in flight. Against a warm cache this is never true, which is the point of the
   * persisted cache — the skeleton is for the genuinely-cold case, not something
   * to be looked at.
   */
  const sectionsLoading = !sections && sectionsFetching;

  /**
   * NO FULL-SCREEN GATE.
   *
   * There used to be an `if (!booted)` early return that replaced the entire
   * screen — chrome, hero, every rail, all eight sections — with a centred
   * spinner until BOTH requests had resolved. That is the second-worst first
   * frame in the app after home's, and it existed to protect against a layout
   * jump that a skeleton prevents properly.
   *
   * What replaced it: each section renders its own state. The hero and rails
   * simply do not appear until their own data does — they are the same views
   * they always were, they mount a moment later — and the Browse box, which has
   * a fixed height by design, shows its own `GridSkeleton` inside its own box.
   * Nothing about the screen's geometry changes when data arrives.
   */
  const heroItems = useMemo(() => sections?.trending.slice(0, 8) ?? [], [sections?.trending]);

  /**
   * THE PAGE, AS ONE LIST OF NAMED BLOCKS — mirroring home.
   *
   * Explore used to be a hand-written `ScrollView` of sections. That is the same
   * shape home had before its refactor, and it carried the same problem: a
   * section's vertical position is a *measured pixel*, and it goes stale the
   * moment a section above mounts or unmounts as data arrives. That is what made
   * `jumpToBrowse` land short.
   *
   * Building the page as a list of *named* blocks (one per section, keyed by
   * name) means a section can be targeted by its KEY rather than by a pixel
   * number — `jumpToBrowse` finds the index of the block whose key is 'browse'
   * and scrolls to that row. Mounting/unmounting above it can no longer move
   * the target, because the target is the row, not an offset.
   *
   * Every section mounts in the first pass (`initialNumToRender` below is the
   * whole list) — the same deliberate choice home makes, because virtualising
   * the SECTIONS makes a page whose scrollable height grows as you scroll, which
   * reads as sections arriving late. A section that renders nothing (empty rail)
   * is simply not a row: see the guards on each push.
   *
   * EMPTY SECTIONS ARE NOT ROWS, same as home — a row that renders nothing is a
   * row that has to be measured to find that out.
   */
  const blocks = useMemo(() => {
    const out: { key: string; node: React.ReactElement }[] = [];

    if (error && !sections) {
      out.push({
        key: 'error',
        node: (
          <View style={[styles.errBox, { backgroundColor: 'rgba(248,113,113,0.12)' }]}>
            <Text style={[styles.err, { color: color.status.danger }]}>
              Could not reach AniList: {error.message}
            </Text>
          </View>
        ),
      });
    }

    if (heroItems.length >= 3) {
      out.push({ key: 'hero', node: <HeroCarousel items={heroItems} onSelect={open} /> });
    }

    // Browse is always present — it is the core of the screen.
    const browseBlockIndex = out.length;
    out.push({
      key: 'browse',
      node: (
        <View style={styles.section}>
          <SectionHeader
            title="Browse"
            trailing={
              <PillSelector
                items={LAYOUT_ITEMS}
                value={gridLayout}
                onChange={setGridLayout}
                height={28}
                accessibilityPrefix="Layout"
              />
            }
          />

          {/* THE FILTER CHROME, AS A LITTLE FORM. */}
          <View style={styles.filterBlock}>
            <CenterLabel label="Genre" style={styles.filterLabel} />
            <RailScrollbar
              trackInset={layout.gutter}
              contentContainerStyle={styles.pillRow}
            >
              <PillToggle
                items={GENRE_PILLS}
                values={filters.genres}
                onToggle={toggleGenre}
                height={34}
              />
              <View style={styles.pillRowEnd} />
            </RailScrollbar>

            <CenterLabel label="Filter" style={styles.filterLabel} />
            <RailScrollbar
              trackInset={layout.gutter}
              contentContainerStyle={styles.filterRow}
            >
              <FilterDropdown
                label="Format"
                icon="clapper"
                value={filters.format}
                options={FORMAT_FILTERS}
                onChange={(v) => applyFilters({ format: v })}
              />
              <FilterDropdown
                label="Status"
                icon="airing"
                value={filters.status}
                options={STATUS_FILTERS}
                onChange={(v) => applyFilters({ status: v })}
              />
              <FilterDropdown
                label="Year"
                icon="year"
                value={filters.year}
                options={YEAR_FILTERS}
                onChange={(v) => applyFilters({ year: v })}
              />
              <FilterDropdown
                label="Minimum score"
                icon="score"
                value={filters.minScore}
                options={SCORE_FILTERS}
                onChange={(v) => applyFilters({ minScore: v })}
              />
              <FilterDropdown
                label="Sort by"
                icon="sort"
                value={filters.sort}
                options={SORT_FILTERS}
                clearValue={DEFAULT_FILTERS.sort}
                clearLabel="Reset to Trending"
                subtitle={sortSubtitle}
                onChange={(v) => applyFilters({ sort: v })}
              />
              <View style={[styles.filterDivider, { backgroundColor: color.border.muted }]} />
              <ResetFiltersButton onPress={resetFilters} enabled={filtered} />
              <View style={styles.filterRowEnd} />
            </RailScrollbar>
          </View>

          {chips.length ? (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.chipRow}
            >
              {chips.map((c) => (
                <FilterChip
                  key={c.id}
                  label={c.label}
                  value={c.value}
                  icon={c.icon}
                  onClear={() => clearChip(c)}
                />
              ))}
              <View style={styles.chipRowEnd} />
            </ScrollView>
          ) : null}

          <View style={styles.resultRow}>
            <Text style={[styles.resultText, { color: color.text.muted }]} numberOfLines={1}>
              {grid.length
                ? `${gridApprox ? '~' : ''}${formatCount(gridTotal)} titles`
                : gridBooting
                  ? 'Loading…'
                  : 'No titles yet'}
            </Text>
            {gridBusy ? (
              <ActivityIndicator size="small" color={color.text.muted} />
            ) : null}
          </View>

          <View>
            {grid.length === 0 ? (
              gridBooting ? (
                <GridSkeleton
                  columns={effectiveColumns}
                  screenW={screenW}
                  tileStyle={tileStyle}
                  rows={3}
                />
              ) : (
                <GridEmpty
                  title="Nothing matches that yet"
                  hint="Those filters are narrower than AniList's catalogue. Loosen one and try again."
                  actionLabel="Reset filters"
                  onAction={resetFilters}
                />
              )
            ) : (
              <View style={gridBusy ? styles.stale : null}>
                {gridLayout === 'rows' ? (
                  <BrowseRows items={grid} onSelect={open} variant={tileStyle} />
                ) : (
                  <MediaGrid
                    items={grid}
                    onSelect={open}
                    columns={effectiveColumns}
                    variant={tileStyle}
                    screenW={screenW}
                  />
                )}
              </View>
            )}
          </View>

          {grid.length ? (
            <PageControl
              page={Math.max(1, gridQuery.page)}
              pageCount={lastPage}
              onChange={goToPage}
              busy={gridBusy}
            />
          ) : null}
        </View>
      ),
    });

    // Track the browse row's index for jumpToBrowse.
    browseIndexRef.current = browseBlockIndex;

    if (sections?.airing?.length) {
      out.push({
        key: 'airing',
        node: (
          <MediaListSection
            title="Airing this week"
            items={sections?.airing ?? []}
            onSelect={open}
            variant={tileStyle}
          />
        ),
      });
    }

    if (sections?.spotlight?.length) {
      out.push({
        key: 'spotlight',
        node: (
          <>
            <View style={styles.section}>
              <SectionHeader
                title="Sci-Fi spotlight"
                trailing={
                  <SectionLink
                    label="See all"
                    onPress={() => seedFilters({ genres: ['Sci-Fi'] })}
                  />
                }
              />
            </View>
            <FeatureMosaic
              items={sections?.spotlight ?? []}
              onSelect={open}
              kicker="SCI-FI"
              variant={tileStyle}
              screenW={screenW}
            />
          </>
        ),
      });
    }

    if (sections?.favourites?.length) {
      out.push({
        key: 'favourites',
        node: (
          <View style={styles.section}>
            <SectionHeader
              title="Fan favourites"
              trailing={
                <SectionLink
                  label="See all"
                  onPress={() => seedFilters({ sort: 'FAVOURITES_DESC' })}
                />
              }
            />
            <FlatList
              horizontal
              data={sections?.favourites ?? []}
              renderItem={renderBanner}
              keyExtractor={bannerKey}
              getItemLayout={bannerLayout}
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.bannerRow}
              initialNumToRender={3}
              maxToRenderPerBatch={3}
              windowSize={3}
              removeClippedSubviews={false}
            />
          </View>
        ),
      });
    }

    if (sections?.topRated?.length) {
      out.push({
        key: 'topRated',
        node: (
          <MediaRail
            title="Top rated"
            items={sections?.topRated ?? []}
            onSelect={open}
            variant={tileStyle}
            onSeeAll={() => seedFilters({ sort: 'SCORE_DESC' })}
          />
        ),
      });
    }

    if (sections?.films?.length) {
      out.push({
        key: 'films',
        node: (
          <>
            <View style={styles.section}>
              <SectionHeader
                title="Feature films"
                trailing={
                  <SectionLink
                    label="See all"
                    onPress={() => seedFilters({ format: 'MOVIE' })}
                  />
                }
              />
            </View>
            <MediaBannerGrid
              items={sections?.films.slice(0, 8) ?? []}
              onSelect={open}
              screenW={screenW}
            />
          </>
        ),
      });
    }

    if (sections?.upcoming?.length) {
      out.push({
        key: 'comingSoon',
        node: (
          <MediaRail
            title="Coming soon"
            items={sections?.upcoming ?? []}
            onSelect={open}
            variant={tileStyle}
            onSeeAll={() => seedFilters({ status: 'NOT_YET_RELEASED' })}
          />
        ),
      });
    }

    return out;
  }, [
    error,
    sections,
    heroItems,
    open,
    gridLayout,
    filters,
    toggleGenre,
    applyFilters,
    resetFilters,
    filtered,
    sortSubtitle,
    chips,
    clearChip,
    grid,
    gridApprox,
    gridTotal,
    gridBooting,
    gridBusy,
    effectiveColumns,
    screenW,
    tileStyle,
    gridQuery,
    lastPage,
    goToPage,
    seedFilters,
    color,
    renderBanner,
    bannerKey,
    bannerLayout,
  ]);

  const renderRow = useCallback(({ item }: { item: { key: string; node: React.ReactElement } }) => item.node, []);
  const keyOf = useCallback((b: { key: string; node: React.ReactElement }) => b.key, []);

  return (
    <View style={[styles.container, { backgroundColor: color.bg.primary }]}>
      <NavBar title="Explore" />
      <LoadingBoundary
        loading={sectionsLoading}
        skeleton={<HomeSkeleton tileStyle={tileStyle} />}
      >
        <FlatList
          ref={scrollRef}
          style={styles.content}
          data={blocks}
          renderItem={renderRow}
          keyExtractor={keyOf}
          contentContainerStyle={[styles.page, { paddingBottom: tabBarSpace }]}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={color.text.primary}
            />
          }
          initialNumToRender={20}
          maxToRenderPerBatch={20}
          windowSize={21}
          removeClippedSubviews={false}
          onScrollToIndexFailed={(info) => {
            // FlatList occasionally asks to scroll before the target row has
            // been measured. Retry once after a frame; the row will be laid out
            // by then. Mirrors the standard RN recommendation.
            setTimeout(() => {
              scrollRef.current?.scrollToIndex({
                index: info.index,
                animated: true,
                viewOffset: insets.top + layout.navbarHeight,
              });
            }, 100);
          }}
        />
      </LoadingBoundary>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Bits of the screen that are small enough not to deserve their own file
// ---------------------------------------------------------------------------

/**
 * AniList's totals are plain integers and it caps them at 5000, so this only
 * ever has to group. `Number.toLocaleString` on a device is not free, but this
 * runs once per filter change, not per frame.
 */
function formatCount(n: number): string {
  return n.toLocaleString('en-US');
}

/**
 * The Browse grid's third layout: rows.
 *
 * Not `MediaListSection` — that one is a *chart*, with ranks, score rings and
 * podium banners, and it wants a fixed 14. This is the same information as the
 * grid, in the other orientation: a compact 64px cover, title, and the meta
 * line, with a hairline between. A view switch that shows different data would
 * be a bug; a view switch that shows the SAME data differently is the point.
 */
function BrowseRows({
  items,
  onSelect,
  variant,
}: {
  items: MediaItem[];
  onSelect: (m: MediaItem) => void;
  variant: TileStyleKey;
}) {
  const { color } = useTheme();
  const framed = variant === 'framed';
  return (
    <View
      style={[
        styles.rows,
        framed
          ? { backgroundColor: color.bg.surface, borderColor: color.border.muted }
          : null,
      ]}
    >
      {items.map((m, i) => {
        /**
     * `coverImage.large` (230x320, ~137KB) over `extraLarge` (460x640, ~478KB) —
     * measured on AniList's CDN. Explore's mosaic and grid cards are tiles, not
     * hero art, and this is the fallback for when a title has no banner. Same 3.5x
     * saving as every other tile. `large` is non-optional in the type.
     */
    const cover = m.coverImage?.large ?? m.coverImage?.extraLarge;
        const meta = [
          m.seasonYear,
          m.format ? m.format.replace('_', ' ') : null,
          m.averageScore != null ? `${m.averageScore}%` : null,
        ]
          .filter(Boolean)
          .join('  ·  ');
        return (
          <Pressable
            key={m.id}
            onPress={() => onSelect(m)}
            onLongPress={() => openListSheet(m)}
            delayLongPress={LIST_LONG_PRESS_MS}
            accessibilityRole="button"
            accessibilityLabel={m.title.english ?? m.title.romaji ?? 'Anime'}
            android_ripple={{ color: color.accent.glow, foreground: true }}
            style={({ pressed }) => [
              styles.row,
              i < items.length - 1 && {
                borderBottomWidth: StyleSheet.hairlineWidth,
                borderBottomColor: color.border.muted,
              },
              { opacity: pressed ? 0.7 : 1 },
            ]}
          >
            <View style={[styles.rowCover, { backgroundColor: color.bg.elevated }]}>
              {cover ? (
                // `expo-image` rather than a bare `Image` so the memory/disk
                // cache is shared with every other tile on this screen. A
                // 44x62 well is a downscale of a 460px source, which is
                // exactly what `allowDownscaling` is for.
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
            <View style={styles.rowBody}>
              <Text
                style={[styles.rowTitle, { color: color.text.primary }]}
                numberOfLines={2}
              >
                {m.title.english ?? m.title.romaji ?? m.title.native}
              </Text>
              {meta ? (
                <Text style={[styles.rowMeta, { color: color.text.muted }]} numberOfLines={1}>
                  {meta}
                </Text>
              ) : null}
            </View>
            <AppIcon name="chevron" size={16} color={color.text.muted} />
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * The loading state. Now shared with the search tab — a skeleton has to agree
 * with the real tile geometry of whatever screen draws it, and two private
 * copies of one guaranteed that one of them was wrong.
 */
const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { flex: 1 },
  page: { paddingBottom: spacing.xxl },
  hint: {
    fontSize: 13,
    marginTop: spacing.lg,
    fontFamily: font.regular,
  },
  errBox: {
    marginHorizontal: layout.gutter,
    marginTop: layout.navbarHeight,
    padding: spacing.md,
    borderRadius: 8,
  },
  err: { fontSize: 12, fontFamily: font.medium },

  // ---- filter chrome ----
  filterBlock: {
    marginTop: spacing.xs,
  },
  filterLabel: {
    // Sits tight under its row's header and well clear of the rail above it,
    // so the label always reads as belonging to the control BELOW it.
    marginTop: spacing.md,
    marginBottom: spacing.sm,
  },
  pillRow: {
    paddingHorizontal: layout.gutter,
    gap: spacing.sm - 2,
    alignItems: 'center',
    paddingVertical: spacing.xs,
  },
  pillRowEnd: { width: spacing.sm },
  filterRow: {
    paddingHorizontal: layout.gutter,
    gap: spacing.sm - 2,
    alignItems: 'center',
    paddingVertical: spacing.xs,
  },
  filterDivider: {
    width: StyleSheet.hairlineWidth,
    height: 20,
    marginHorizontal: spacing.xs,
  },
  filterRowEnd: { width: spacing.sm },
  chipRow: {
    paddingHorizontal: layout.gutter,
    gap: spacing.sm - 2,
    paddingTop: spacing.xs,
    paddingBottom: spacing.xs,
    alignItems: 'center',
  },
  chipRowEnd: { width: spacing.lg },
  resultRow: {
    paddingHorizontal: layout.gutter,
    marginTop: spacing.sm,
    marginBottom: spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: 16,
  },
  resultText: {
    fontSize: 12,
    lineHeight: 16,
    fontFamily: font.medium,
    letterSpacing: 0.2,
  },

  // ---- grids ----
  // The ONE section gap. Every block on this page opens with it, so the
  // headings sit on a single vertical rhythm instead of drifting.
  section: { marginTop: spacing.xxl },
  // Cheap: one opacity change, no animation, no layout. The JS-thread cost of
  // an Animated.View here would not be worth it for something that only ever
  // changes twice per query.
  stale: { opacity: 0.5 },
  bannerRow: {
    paddingHorizontal: layout.gutter,
    gap: spacing.md,
  },
  // `link`, `linkText` and `linkChevron` moved to `components/ui/SectionLink`
  // when home's rails started using the same chip — see that file's note on why
  // it is shared rather than duplicated.

  // ---- rows layout ----
  rows: {
    marginHorizontal: layout.gutter,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 1,
  },
  rowCover: {
    width: 44,
    height: 62,
    borderRadius: 6,
    overflow: 'hidden',
  },
  rowBody: { flex: 1, minWidth: 0, gap: 3 },
  rowTitle: { fontSize: 13.5, lineHeight: 17, fontFamily: font.semibold, letterSpacing: -0.1 },
  rowMeta: { fontSize: 11, lineHeight: 15, fontFamily: font.medium },
});
