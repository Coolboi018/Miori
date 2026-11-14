// Warming data the app expects to need soon.
//
// THE RULE THIS FILE EXISTS TO KEEP: **a tab switch performs zero network
// requests and zero re-renders.** Both halves are load-bearing and neither is
// sufficient alone — see the note in pp/(tabs)/_layout.tsx for why the search
// tab, which has no AniList data at all, was still slow to switch to.
//
// ONE MOMENT, NOT THREE.
//
// This started with a three-part scheme whose first part was the exact opposite
// of the rule:
//
//   1. THE TAB YOU ARE LEAVING. prefetchNeighbours in every tab's blur handler.
//
// That is the part that has to die, because a blur handler runs on EVERY tab
// switch. It turned the act of moving between tabs into three AniList requests —
// which is precisely the thing being complained about ("why is it calling anilist
// each time?"). It was made worse by being wired into focus effects whose
// dependency was the whole useQuery result object: that object is new on every
// render, so the effect tore down and re-subscribed per RENDER and the "on blur"
// prefetch fired per render rather than per blur.
//
// Warming on blur is also unnecessary. Every tab's view tree is already built by
// the time the user could tap it — `usePreloadTabs` builds them from the same
// idle window this file uses — and the native views are DETACHED by the library
// default rather than kept attached, so there is nothing left to mount at switch
// time: only data to already be present, which is what the persisted cache is
// for.
//
// THE VIEW TREES ARE A SEPARATE FILE, ON PURPOSE. This one warms DATA.
// `lib/ui/usePreloadTabs` warms the React trees, because it needs the tab
// navigator's navigation object and this module has no business importing one.
// Both queue on the same idle scheduler, so they cannot both fire in the same
// frame and land their combined work on the launch as one lump.
//
//   2. APP START, AFTER HYDRATION AND IDLE. This is what survives, and it is now
//      the ONLY moment. startWarmup is called from the query provider's
//      onSuccess — restore finished — and defers to requestIdleCallback so it
//      does not compete with the home screen's own first paint. Against a warm
//      cache every call here is a no-op costing zero requests, which is the normal
//      case from the second launch onward.
//
//   3. ON A CARD TAP. prefetchAnime, and this one is not speculative at all:
//      the user is already going to that screen, so it is their request started a
//      frame earlier.
//
// NOTHING ON A TIMER, NOTHING ON SCROLL, NOTHING ON FOCUS. A background refresh
// loop is how apps get rate limited, and it spends the radio while the user is
// watching a video.
//
// WHAT IS NOT PREFETCHED, AND WHY:
//
//   - SEARCH. Keyed on a string the user has not typed. Guessing spends a request
//     on a query nobody asked for, and the landing state is entirely local.
//
//   - SCHEDULE DAYS 1-6. Today only. Seven requests to make one of them faster,
//     with six of them ahead of today's list in the transport's queue — on the
//     tab whose whole design is "today paints first, the rest stream in behind
//     it".
//
//   - IMAGES, ENTIRELY. expo-image's prefetch in this SDK has no priority
//     option, only a cache policy, so a prefetched bitmap competes with — and can
//     beat — one the user is actually looking at. Every mounted rail already asks
//     for its own visible covers at the right priority and they land in the disk
//     cache, so the second view is already a hit. Warming by hand only helps
//     off-screen tiles, and these rails are plain ScrollViews that render
//     everything. An earlier pass fired eighteen of these on every tab blur; it
//     was a measurable loss.
import { startOfDay } from '@/lib/anilist/schedule';
import { fetchHomeSections } from '@/lib/anilist';
import { fetchExploreSections, DEFAULT_FILTERS, fetchBrowse } from '@/lib/anilist/explore';
import { airingStaleTime } from './hooks';
import { qk } from './keys';
import { queryClient } from './client';
import { whenIdle } from '@/lib/ui/whenIdle';
// FilmU warming removed: extensions now load from the repo, not compiled in.

/**
 * Warm everything, once, after the persisted cache has been restored.
 *
 * Called from the query provider's `onSuccess`, which fires during the first
 * commit — hence the deferral to idle: starting three requests there would
 * compete with the home screen's own first paint for the JS thread and the
 * radio, making the app slower to LOOK at, which is the opposite of the intent.
 *
 * `prefetchQuery` rather than `fetchQuery`, because being allowed to do nothing
 * IS the feature: against a warm cache every one of these is a no-op that costs
 * zero requests, which is the normal case after the first launch.
 *
 * Sequential, not parallel. Three at once is three requests the transport has to
 * queue anyway, and spreading them means home's own fetch is not competing for a
 * slot in the budget window.
 */
export function startWarmup(): void {
  whenIdle(() => {
    void queryClient
      .prefetchQuery({ queryKey: qk.exploreSections(), queryFn: fetchExploreSections })
      .catch(() => {});

    // Today only. Warming all seven days would spend seven requests to make one
    // of them faster, putting six ahead of today's list in the transport's queue
    // on the tab whose whole design is "today paints first, the rest stream in".
    // The screen warms the other six itself now, one at a time and only while it
    // is on screen — see the trickle in `app/(tabs)/schedule.tsx` — so this stays
    // the single day that is ready before the user has gone anywhere near it.
    const today = startOfDay(Math.floor(Date.now() / 1000));
    void queryClient
      .prefetchQuery({
        queryKey: qk.airingDay(today),
        queryFn: () => import('@/lib/anilist/schedule').then((m) => m.loadAiringDay(today)),
        // The same rule the query itself uses. Today is always a "near" day, but
        // asking the shared function rather than restating a number here is what
        // stops the two drifting apart.
        staleTime: airingStaleTime(today),
      })
      .catch(() => {});

    // The default explore grid, which the screen fetches on mount.
    void queryClient
      .prefetchQuery({
        queryKey: qk.browse(DEFAULT_FILTERS, 1),
        queryFn: () => fetchBrowse(DEFAULT_FILTERS, 1, 9),
      })
      .catch(() => {});
  });
}

/**
 * Warm the episode list for one anime, on the way into its detail screen.
 *
 * The same argument as `prefetchAnime`, one layer down: a card press means the
 * user is already going to this title, so fetching its episode list now is their
 * request started ~150ms early rather than a speculative one. That head start is
 * worth more here than for the AniList payload, because the episode list is the
 * slowest thing on the screen and the one with no cached copy to fall back on.
 *
 * Cached by the extension itself (`episodesCache`, one hour), so a repeat visit
 * costs nothing and a press that is cancelled after the request went out costs
 * one warm request.
 */
export function prefetchEpisodes(_id: number): void {
  // FilmU (Bingr) episodes are now fetched by the details page from the
  // repo-loaded extension; nothing to warm here.
}

/**
 * Warm a specific anime's detail payload.
 *
 * Called from a poster card's press handler, before the navigation happens. The
 * detail screen is the heaviest in the app — one request returning a banner, a
 * poster, 25 recommendations, every relation and eight characters — so it is the
 * one place where arriving with the data already there is worth a request. And it
 * is not speculative at all: the card is being tapped, so the user is already
 * going there.
 */
export function prefetchAnime(id: number): void {
  void queryClient
    .prefetchQuery({
      queryKey: qk.media(id),
      queryFn: () => import('@/lib/anilist').then((m) => m.fetchMedia(id)),
      staleTime: 5 * 60_000,
    })
    .catch(() => {});
}

/**
 * Kept only so the dev probe can warm a tab on demand.
 *
 * NOT called from any focus effect. See the note at the top.
 */
export function warmHome(): void {
  void queryClient
    .prefetchQuery({ queryKey: qk.home(null, true, true), queryFn: () => fetchHomeSections(null) })
    .catch(() => {});
}
