// HOME — every rail in one response, painted from disk before the network is
// touched.
//
// WHAT CHANGED, AND WHY IT WAS THE APP'S WORST SCREEN. It used to block its
// entire first paint on `fetchHomeSections`, showing a centred spinner until
// AniList answered, and it kept a 60-second in-memory cache that nothing else in
// the app could see and that vanished on every launch. So: a cold start was one
// to two seconds of nothing, every time, forever.
//
// Now the rails come from `useHomeSections`, which reads a persisted cache
// before it fetches. The screen renders real content on its FIRST frame from
// disk, revalidates silently underneath, and never shows a spinner unless there
// is genuinely nothing cached and the request is still in flight — in which case
// it shows a skeleton at the real rail geometry instead, so nothing moves when
// the data lands.
//
// THE HANDOVER IS A WHOLE-PAGE COMMIT, AND THAT USED TO STALL — see the note on
// `blocks` below. Home has no prefetch to save it (it is the app's first screen,
// so there is nothing to prefetch it from), which means its cold-start handover is
// always the real one. The page is one virtualised list rather than a `ScrollView`,
// but it mounts every SECTION rather than a viewport's worth, because a row
// VirtualizedList has not laid out has no height to contribute to the scroll range
// — so a page that renders a screenful at a time cannot be scrolled like a page.
// What makes that affordable is unchanged: every rail inside is its own virtualised
// horizontal list, so a section costs a header and six tiles, not all fourteen.

import { useCallback, useMemo, useState } from 'react';
import { font, radii, spacing } from '@/lib/ui/tokens';
import { openAnime, pushOnce } from '@/lib/nav/pushOnce';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { type ContinueItem, type HomeSections, type MediaItem } from '@/lib/anilist';
import { useUserId } from '@/lib/auth/session';
import { updateBrowsing } from '@/lib/presence/discord';
import { useHomeSections } from '@/lib/query/hooks';
import { prefetchAnime } from '@/lib/query/prefetch';
import { qk } from '@/lib/query/keys';
import { queryClient } from '@/lib/query/client';
import { NavBar } from '@/components/nav/NavBar';
import { HeroCarousel } from '@/components/anime/HeroCarousel';
import { MediaRail } from '@/components/anime/MediaRail';
import { MediaListSection } from '@/components/anime/MediaListSection';
import { PosterCard } from '@/components/anime/PosterCard';
import { HomeSkeleton } from '@/components/anime/HomeSkeleton';
import { LoadingBoundary } from '@/components/ui/LoadingBoundary';
import { SectionHeader } from '@/components/ui/SectionHeader';
import type { TileStyleKey } from '@/lib/settings/store';
import { useTabBarClearance } from '@/lib/ui/tabBar';
import { useTheme } from '@/lib/ui/useTheme';
import { requestBrowse } from '@/lib/explore/pendingBrowse';
import type { ExploreFilters } from '@/lib/anilist/explore';
import { usePreloadTabs } from '@/lib/ui/usePreloadTabs';
import { useSetting } from '@/lib/settings/useSetting';

/**
 * What the screen renders from. Empty until the query answers, so the rails below
 * need no null checks — an empty rail array renders nothing, which is exactly
 * what the skeleton stands in for.
 */
const EMPTY: HomeSections = {
  latest: [],
  trending: [],
  completed: [],
  popular: [],
  current: [],
  planning: [],
  upcoming: [],
};

/**
 * One section of the page, as one ROW of the page list.
 *
 * `node` rather than a tagged union of props because a row is already built when
 * `blocks` is, which keeps the page's order readable top to bottom in one place
 * and lets the list carry a stable element reference per row (see `renderRow`).
 * The section itself keeps its own virtualisation — every rail is its own
 * `FlatList` — so this list only ever has to decide which SECTIONS exist.
 */
interface HomeBlock {
  /** Stable identity across re-renders. See the note on keys above. */
  key: string;
  /** An element, not `ReactNode` — `FlatList`'s renderer must return one. */
  node: React.ReactElement;
}

/**
 * EVERY SECTION, IN ONE PASS. See the note on the page list below for why this
 * is the whole page rather than a viewport's worth.
 *
 * Eight is the ceiling, not a guess: hero, continue watching, planning, trending,
 * latest, completed, popular, upcoming — which is every `key` `blocks` can push.
 */
const ALL_SECTIONS = 8;

export default function HomeScreen() {
  const router = useRouter();
  const tabBarSpace = useTabBarClearance();
  const continueOn = useSetting('features.continueWatching');
  const planningOn = useSetting('features.planning');
  // Which poster tile the rails render. One design exists today ('framed');
  // when a second lands, branch the rail rows on this value.
  const tileStyle = useSetting('home.tileStyle');
  const { color } = useTheme();

  /**
   * Build the other tabs while the app is idle, so tapping one is a z-index
   * change rather than a mount. Lived here rather than inside `<Tabs>` because a
   * navigator rejects any child that is not a Screen — and home is the initial
   * route, so it is the one screen guaranteed to be mounted before a tap. See
   * `lib/ui/usePreloadTabs.ts` for why the work is deferred rather than done at
   * boot.
   */
  usePreloadTabs();

  /**
   * The user id gates the two list rails, and it gates the whole query KEY.
   *
   * `undefined` until the first SecureStore read settles, and that is different
   * from `null` on purpose: `undefined` asks for nothing, while `null` asks for the
   * real anonymous screen — five public rails and no list ones. So a cold start
   * paints the public rails from disk immediately instead of waiting on the
   * keychain, and the two list rails arrive a moment later.
   *
   * A STORE rather than a local `useState`, and that is the fix rather than a
   * refactor. This used to read the id once on mount into local state, which meant
   * that signing in while this screen was already mounted changed nothing here: the
   * tab is never unmounted and its effect never re-ran, so `null` stayed `null`
   * and the Continue Watching and Planning rails simply never appeared. Restarting
   * the app was the only way out. `useUserId` subscribes instead, so
   * `completeSignIn` reaching the rest of the app is enough.
   */
  const userId = useUserId();

  // One request fills every rail, signed in or not — see fetchHomeSections.
  // The toggles go into the QUERY KEY rather than being applied afterwards, so a
  // rail that is switched off is never requested at all.
  const sectionsQuery = useHomeSections(userId, {
    current: continueOn,
    planning: planningOn,
  });
  const { data: sections, isFetching, error } = sectionsQuery;

  const data = sections ?? EMPTY;
  /**
   * Destructured rather than read as `data.trending` throughout, and the reason
   * is not tidiness: one of the rails is called `current`, so `data.current` is
   * a property access named `current`, which is exactly the shape the React
   * Compiler reads as a REF (`x.current`). Left as-is it rejects the `useMemo`
   * below — "the inferred dependency was `data.current`" — because it genuinely
   * cannot tell a ref read from a field of a response object. Named locals have
   * no such ambiguity, and every `useMemo` below can list its real inputs.
   */
  const {
    trending,
    latest,
    completed,
    popular,
    upcoming,
    current: continueItems,
    planning,
  } = data;

  /**
   * Open a title. Warms the detail payload on the way in — the tap has already
   * committed, so this is not a speculative request, it is the request the next
   * screen was going to make, started a frame earlier. The detail screen is the
   * heaviest in the app (one query returning a banner, 25 recommendations, every
   * relation and eight characters), so it is the one place where arriving with
   * the data already there is worth doing.
   *
   * There is no early return for the skeleton on this screen any more — the
   * handover goes through `LoadingBoundary` so the content mounts underneath a
   * skeleton that is still there (see the note at the bottom of this file). The
   * rule that shaped the order above still stands, though: hooks cannot be
   * conditional, and a `useCallback` living inside a branch means the hook order
   * changes between renders of the same component.
   */
  const open = useCallback((m: MediaItem) => {
    prefetchAnime(m.id);
    // `openAnime`, not a bare push — the native stack will stack a second copy
    // of the same screen for every extra tap, and a laggy frame is exactly when
    // the user taps again. See `lib/nav/pushOnce.ts`.
    openAnime(m.id);
  }, []);

  /**
   * A TAB SWITCH DOES NOTHING HERE.
   *
   * Not a refetch, not a staleness check, not a prefetch. This used to carry all
   * three, and all three were wrong:
   *
   *   - `refetch()` bypasses `staleTime` (only the mount path checks it), so it
   *     fired a forced AniList request on EVERY tap of the tab bar.
   *   - `prefetchNeighbours` in the cleanup fired three more.
   *   - and because the dependency was the whole `useQuery` result object — which
   *     is a NEW object on every render — the effect tore down and re-subscribed
   *     on every render, so even the "on blur" prefetch ran per RENDER.
   *
   * None of it was needed. The data is already in the cache and the view tree is
   * already built, so switching tabs is a visibility change and the correct
   * amount of work to do about it is none.
   *
   * Freshness is owned by `refetchStaleOnForeground` when the app resumes, and by
   * an explicit invalidate on pull-to-refresh. `updateBrowsing` is a fire-and-
   * forget presence frame and is the only thing left, which is the point: it is
   * the only reason this effect exists at all, and it is why the dependency list
   * is empty rather than a query object.
   */
  useFocusEffect(
    useCallback(() => {
      updateBrowsing();
    }, [])
  );

  const onRefresh = useCallback(async () => {
    await queryClient.invalidateQueries({
      queryKey: qk.home(userId ?? null, continueOn, planningOn),
    });
  }, [userId, continueOn, planningOn]);

  /**
   * Retry from the error card, with a local busy flag.
   *
   * `isFetching` cannot cover this: the error header only renders when
   * `!isFetching`, so using it as the busy signal would mean the button was never
   * visibly busy — it would swap to a spinner and the whole header would unmount
   * in the same commit. A local flag survives the swap.
   */
  const [retrying, setRetrying] = useState(false);
  const onRetry = useCallback(async () => {
    setRetrying(true);
    try {
      await onRefresh();
    } finally {
      setRetrying(false);
    }
  }, [onRefresh]);

  const hero = useMemo(() => trending.slice(0, 8), [trending]);
  const signedIn = userId != null;
  // A hidden rail is also an unrequested one — the flags go into the query key
  // (see useHomeSections), so switching a section off stops it costing a poster
  // download.
  const showContinue = signedIn && continueOn;
  const showPlanning = signedIn && planningOn;

  /**
   * "See all" — every rail's link goes to the same place: the explore tab, grid
   * seeded with that rail's own definition, scrolled to it. That is exactly what
   * explore's own section links do through its local `seedFilters`.
   *
   * ONE DESTINATION FOR ONE AFFORDANCE. The alternative was sending the three
   * status-based rails to `/explore/[status]` pages and the two sort-based ones to
   * the grid — the same button meaning two different things depending on which
   * rail it happened to sit in.
   *
   * THE SEEDS ARE COPIED FROM `discoveryAliases` in `lib/anilist.ts`, and that is a
   * coupling worth naming rather than hiding: the rail's contents and the
   * destination's contents are the same query, written down twice. They can drift,
   * and the drift would be silent — a rail would show one list and its See all
   * another. Change a rail's query and its seed here has to change with it.
   *
   * THE TWO LIST RAILS ARE NOT HERE, deliberately. Continue Watching and Planning
   * are the signed-in user's own AniList lists, which the browse grid cannot
   * express — there is no filter for "what I am watching" — and they belong to a
   * profile area that does not exist yet.
   */
  const seeAll = useCallback(
    (patch: Partial<ExploreFilters>) => {
      requestBrowse(patch);
      router.push('/(tabs)/explore');
    },
    [router]
  );

  /**
   * THE PAGE, AS ONE LIST. And the type of that list is the whole fix, so it is
   * worth being precise about the complaint it answers: data lands on home, the
   * skeleton sits there for a second or two, and then the page is suddenly there.
   *
   * `LoadingBoundary` was never the problem. It covers the skeleton and dissolves
   * it in 200ms on the UI thread once content exists — and that dissolve is
   * smooth. What it cannot do is make the content exist faster, and React cannot
   * take the skeleton away until the content does. So the wait is the COMMIT,
   * and the commit was the entire page:
   *
   *   hero + up to seven rails x six tiles + a fourteen-row chart
   *   = ~600 views and ~50 poster decodes, in one commit
   *
   * The details page never stalls, and the reason is structural rather than
   * accidental: its body is a virtualised `FlatList`, so what it mounts on
   * arrival is bounded by the VIEWPORT, not by the page. (`prefetchAnime` on
   * touch-down means it usually shows no skeleton at all, but even cold it is
   * small.) Home was a plain `ScrollView`, which lays out and mounts every child
   * whether or not it can be seen — so its handover was always the real one, and
   * always the biggest in the app.
   *
   * So the page becomes the same kind of list the details page is: one section
   * per row, virtualised vertically. What virtualising the SECTIONS does NOT do is
   * make the page scrollable, and that is the trap this file walked into: a row
   * VirtualizedList has not laid out contributes no height to the content
   * container, so rendering a screenful of rows at a time yields a screenful-tall
   * page that grows as you scroll — which reads as sections arriving late rather
   * than as a page. The details page escapes it because its rows are a fixed
   * height and it is scrolled after it mounts; home's rows are a page. So every
   * section mounts in the first pass, which is what "like the details page"
   * actually means. A stagger would NOT be. See the note on the page list for how
   * the section count is batched.
   *
   * ONE SCROLL AXIS, as everywhere else in this app. A vertical list containing
   * horizontal rails is not a nested-axis problem — RN only objects to same-
   * orientation nesting — and `MediaRail`'s own notes are about the axis it owns,
   * not about being owned.
   *
   * THE KEYS ARE THE POINT, and they are per SECTION rather than per index.
   * `userId` resolves from SecureStore after the first response lands, which
   * changes the query key and adds the two list rails; a key derived from the
   * index would shift every rail below them by one and remount all of them,
   * throwing away their decoded bitmaps. Keyed by name, a section that stays on
   * the page stays mounted wherever it moves to.
   *
   * EMPTY SECTIONS ARE NOT ROWS. A rail with nothing in it renders `null` anyway
   * (`MediaRail`'s own guard), and a row that renders nothing is a row that has
   * to be measured to find that out.
   */
  const blocks = useMemo(() => {
    const out: HomeBlock[] = [];
    if (hero.length >= 3) {
      out.push({ key: 'hero', node: <HeroCarousel items={hero} onSelect={open} /> });
    }
    if (showContinue && continueItems.length > 0) {
      out.push({
        key: 'continue',
        node: (
          <ContinueRail
            items={continueItems}
            onSelect={open}
            tileStyle={tileStyle}
            onSeeAll={() => pushOnce('/profile', { tab: 'CURRENT' })}
          />
        ),
      });
    }
    if (showPlanning && planning.length > 0) {
      out.push({
        key: 'planning',
        node: (
          <MediaRail
            title="Planning"
            items={planning}
            onSelect={open}
            variant={tileStyle}
            onSeeAll={() => pushOnce('/profile', { tab: 'PLANNING' })}
          />
        ),
      });
    }
    if (trending.length > 0) {
      out.push({
        key: 'trending',
        node: (
          <MediaRail
            title="Trending"
            items={trending}
            onSelect={open}
            variant={tileStyle}
            onSeeAll={() => seeAll({ sort: 'TRENDING_DESC' })}
          />
        ),
      });
    }
    if (latest.length > 0) {
      out.push({
        key: 'latest',
        node: (
          <MediaRail
            title="Latest releases"
            items={latest}
            onSelect={open}
            variant={tileStyle}
            onSeeAll={() => seeAll({ status: 'RELEASING', sort: 'TRENDING_DESC' })}
          />
        ),
      });
    }
    if (completed.length > 0) {
      out.push({
        key: 'completed',
        node: (
          <MediaListSection
            title="Recently completed"
            items={completed}
            onSelect={open}
            variant={tileStyle}
            onSeeAll={() => seeAll({ status: 'FINISHED', sort: 'END_DATE_DESC' })}
          />
        ),
      });
    }
    if (popular.length > 0) {
      out.push({
        key: 'popular',
        node: (
          <MediaRail
            title="Popular"
            items={popular}
            onSelect={open}
            variant={tileStyle}
            onSeeAll={() => seeAll({ sort: 'POPULARITY_DESC' })}
          />
        ),
      });
    }
    // Last stop: what's coming. Every dot here is blue by definition
    // (NOT_YET_RELEASED), so the rail reads as "coming soon" at a
    // glance — see PosterCard's status light.
    if (upcoming.length > 0) {
      out.push({
        key: 'upcoming',
        node: (
          <MediaRail
            title="Upcoming"
            items={upcoming}
            onSelect={open}
            variant={tileStyle}
            onSeeAll={() => seeAll({ status: 'NOT_YET_RELEASED', sort: 'POPULARITY_DESC' })}
          />
        ),
      });
    }
    return out;
  }, [
    hero,
    open,
    seeAll,
    showContinue,
    showPlanning,
    tileStyle,
    continueItems,
    planning,
    trending,
    latest,
    completed,
    popular,
    upcoming,
  ]);

  /**
   * Stable row renderer. The rows carry their own element, so this is `item.node`
   * and nothing else — which also means a re-render of the screen does not
   * re-render a row: the element identity is unchanged, so React bails out of
   * the subtree below it.
   */
  const renderRow = useCallback(({ item }: { item: HomeBlock }) => item.node, []);
  const keyOf = useCallback((b: HomeBlock) => b.key, []);

  // NO DATA AND A REQUEST STILL IN FLIGHT. The only case a skeleton is right,
  // and the geometry matters: it has to be the rails' real geometry or the whole
  // page jumps when the data lands, which is worse than the spinner was.
  //
  // Wrapped in `LoadingBoundary` for the crossfade. On a warm cache this branch
  // never runs at all — the content fades in over nothing, which is free — so
  // the animation is really only paid on a genuine first-ever launch.
  return (
    <View style={[styles.container, { backgroundColor: color.bg.primary }]}>
      <NavBar />
      {/*
        THE `&& !error` IS THE WHOLE FIX, AND IT IS NOT A TIMER.

        This used to be `loading={!sections}`. A failed first fetch leaves
        `sections` undefined forever, so `loading` stayed true forever — and the only
        error UI on this screen lives INSIDE `children`, which `LoadingBoundary` does
        not mount while loading (`LoadingBoundary.tsx:153`). The two conditions locked:
        no data means loading, and the message that would explain why sits behind the
        thing that is waiting for data. Skeleton forever, no explanation, no way out
        but a restart.

        Gating on the SETTLED ERROR rather than on elapsed time is what makes this safe
        on a slow phone, and a timer would be the obvious wrong answer: a low-end
        device taking ten seconds to mount seventy tiles would get an error card in
        front of a request that was about to succeed. Here a slow request keeps
        `error` null, so the skeleton stays up for as long as it genuinely takes — ten
        seconds or thirty — and the only thing that stops it is the request actually
        failing.

        NOT `&& isFetching`, which is what explore uses (`explore.tsx:494`). That is
        wrong HERE specifically: `useHomeSections` is gated
        `enabled: userId !== undefined` so it waits for the keychain rather than
        firing a 70-item guest request. During that window `isFetching` is false and
        `sections` is undefined, so `&& isFetching` would flip `loading` false and
        mount an EMPTY page — a flash of nothing on precisely the cold start where the
        keychain read is slowest, which is the hardware this was reported from.
      */}
      <LoadingBoundary
        loading={!sections && !error}
        skeleton={<HomeSkeleton tileStyle={tileStyle} />}
      >
        {/*
          THE PAGE LIST. Every section mounts in the FIRST pass — the whole page
          rather than a viewport's worth — and the reason is not politeness. It is
          that `initialNumToRender: 2` made the page look like it was loading one
          section at a time, and it was NOT a loading state at all. It was
          VirtualizedList measuring rows it had not mounted yet.

          Two symptoms, one cause. A `FlatList`'s scrollable length is whatever its
          content container ACTUALLY laid out to, and that is the sum of its
          mounted cells — there is no estimate for a row nobody has rendered, and
          no `estimatedItemSize` equivalent on RN's list. With two rows mounted,
          the page was two rows tall, so it could barely scroll; and
          `maxToRenderPerBatch: 2` then added the next two rows on each pass, so
          the remaining six arrived a couple at a time as the user scrolled. The
          page grew taller under your thumb. That is the complaint: "I scroll and
          it doesn't scroll, because there are no sections until then."

          Everything lands in one commit instead, so the scroll range is right
          before the first frame and scrolling is just scrolling. `LoadingBoundary`
          is what makes the batch size safe to raise here: it does not mount
          `children` while `loading` (see its line 153), so the list's first render
          ALREADY has all eight blocks in `data` rather than growing from empty.

          WHAT THIS COSTS, stated plainly, because the earlier version of this
          comment argued the other way and was wrong about why. Mounting the page
          is a bigger commit than mounting a screenful — but the win that made the
          page affordable is still in place and is what bounds this: each rail is
          its own horizontal `FlatList` capped at six tiles (`MediaRail`), and the
          chart is a fixed-height peek box (`MediaListSection`). So "every section"
          means eight headers and eight six-tile rails, not the ~600 views of the
          old all-`ScrollView` page that this replaced. If the handover ever feels
          heavy again, the lever is the SKELETON — `LoadingBoundary`'s own note
          says so — not the page.

          `windowSize: 3` still applies, and still matters: it unmounts sections far
          from the viewport on a long scroll, which is what keeps a tall page cheap
          to walk. It no longer affects the first pass.

          `removeClippedSubviews: false` is the app-wide finding (see
          `MediaRail`): with `expo-image` it unmounts tiles whose bitmap is still
          decoding and a fling shows grey flashes. Virtualisation already bounds
          what is resident.
        */}
        <FlatList
          data={blocks}
          renderItem={renderRow}
          keyExtractor={keyOf}
          style={styles.content}
          contentContainerStyle={[styles.page, { paddingBottom: tabBarSpace }]}
          ListHeaderComponent={
            /*
              * A RETRY, because pull-to-refresh cannot be the only way out here.
              *
              * This header renders above an EMPTY list — a failed first fetch leaves
              * `blocks` empty, so the FlatList is one short row and there is nothing
              * to scroll. A RefreshControl on a list that will not scroll never
              * fires, which would leave the error text as the entire remedy:
              * accurate, and not actionable.
              *
              * The button disables itself and spins rather than using the
              * RefreshControl's `refreshing`, which is `isFetching && !error` — false
              * for the whole retry, because `error` is still set. Without the local
              * flag the button would sit dead through the request and read as broken
              * rather than busy.
              */
            error && !isFetching ? (
              <View style={styles.errBox}>
                <Text style={styles.err}>Could not reach AniList: {error.message}</Text>
                <Pressable
                  onPress={onRetry}
                  disabled={retrying}
                  accessibilityRole="button"
                  accessibilityLabel="Try loading your home rails again"
                  accessibilityState={{ disabled: retrying, busy: retrying }}
                  style={styles.retryBtn}
                >
                  {retrying ? (
                    <ActivityIndicator size="small" color="#f87171" />
                  ) : (
                    <Text style={styles.retryText}>Try again</Text>
                  )}
                </Pressable>
              </View>
            ) : undefined
          }
          initialNumToRender={ALL_SECTIONS}
          maxToRenderPerBatch={ALL_SECTIONS}
          windowSize={3}
          removeClippedSubviews={false}
          refreshControl={
            <RefreshControl
              refreshing={isFetching && !error}
              onRefresh={onRefresh}
              tintColor="#fff"
            />
          }
        />
      </LoadingBoundary>
    </View>
  );
}

/**
 * Continue watching is the one rail with per-item state to show: how far in
 * you are. It reuses the poster tile with `progress`, which draws the thin
 * bar between art and caption. The row stays as light as every other rail
 * (no overlays, no backdrop layers) while still telling you, at a glance,
 * which show you are two episodes into.
 *
 * Its own horizontal `FlatList`, like every other rail on the page. It lives
 * inside the page list now (see `blocks`), so this is a horizontal list nested in
 * a vertical one — the one nesting RN does not object to, because the axes
 * differ. It keeps `removeClippedSubviews` off for the same reason the others do:
 * with `expo-image` it unmounts tiles whose bitmap is still decoding.
 */
function ContinueRail({
  items,
  onSelect,
  tileStyle,
  onSeeAll,
}: {
  items: ContinueItem[];
  onSelect: (m: MediaItem) => void;
  tileStyle: TileStyleKey;
  onSeeAll?: () => void;
}) {
  const { color } = useTheme();
  /**
   * Virtualised for the same reason `MediaRail` is: this mapped all fourteen
   * entries in a plain ScrollView, and a tile with a progress bar is six views
   * like any other. The view COUNT across a mounted tab is what the platform
   * re-walks on every layout pass, and that is what made the tab bar slow.
   */
  const keyExtractor = useCallback((e: ContinueItem) => String(e.media.id), []);
  const renderItem = useCallback(
    ({ item: e }: { item: ContinueItem }) => (
      <PosterCard
        media={e.media}
        progress={e.progress}
        meta={`EP ${e.progress}${e.media.episodes ? `/${e.media.episodes}` : ''}`}
        variant={tileStyle}
        onPress={onSelect}
      />
    ),
    [tileStyle, onSelect]
  );

  return (
    <View style={styles.section}>
      <SectionHeader
        title="Continue watching"
        trailing={
          onSeeAll ? (
            <Pressable
              onPress={onSeeAll}
              style={({ pressed }) => [
                styles.seeAll,
                {
                  backgroundColor: color.bg.surface,
                  borderColor: color.border.muted,
                  opacity: pressed ? 0.6 : 1,
                },
              ]}
            >
              <Text style={[styles.seeAllText, { color: color.text.secondary }]}>See all</Text>
              <Text style={[styles.seeAllChevron, { color: color.text.muted }]}>›</Text>
            </Pressable>
          ) : null
        }
      />
      <FlatList
        data={items}
        horizontal
        renderItem={renderItem}
        keyExtractor={keyExtractor}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.crow}
        initialNumToRender={6}
        maxToRenderPerBatch={6}
        windowSize={3}
        removeClippedSubviews={false}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { flex: 1 },
  page: { paddingBottom: 24 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  hint: { color: '#888', fontSize: 13, marginTop: spacing.lg, fontFamily: font.regular },
  section: { marginTop: spacing.xxl, marginBottom: spacing.xs },
  // Same gutter as SectionHeader and the rails, so the row lines up with the
  // tiles above and below it.
  crow: { paddingHorizontal: spacing.lg, gap: spacing.md },
  seeAll: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: spacing.sm + 2,
    height: 24,
    borderRadius: radii.full,
    borderWidth: StyleSheet.hairlineWidth,
  },
  seeAllText: {
    fontSize: 12,
    lineHeight: 15,
    fontFamily: font.medium,
    letterSpacing: 0.2,
  },
  seeAllChevron: {
    fontSize: 14,
    lineHeight: 15,
    fontFamily: font.semibold,
  },
  errBox: {
    marginHorizontal: spacing.lg,
    padding: spacing.md,
    borderRadius: 8,
    backgroundColor: 'rgba(248, 113, 113, 0.12)',
  },
  err: { color: '#f87171', fontSize: 12, fontFamily: font.medium },
  // 48dp tall, so the only control on this screen that matters is not the one
  // that needs aiming at.
  retryBtn: {
    marginTop: spacing.sm,
    minHeight: 48,
    justifyContent: 'center',
    alignSelf: 'flex-start',
  },
  retryText: { color: '#f87171', fontSize: 13, fontFamily: font.semibold },
});
