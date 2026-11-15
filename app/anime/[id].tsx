// Anime detail — full redesign, centered layout.
//
// Visual direction: everything on a center axis. A soft banner glows behind
// a centered poster, the title sits under it, meta chips and genres wrap
// around the center line, and the action row is a centered pill button with
// round icon buttons. Nothing is left-hung anywhere on the header.
//
// Layout at a glance:
//   ┌──────────────────────────┐
//   │ ░░░ banner + scrim ░░░   │  ← back floats over art
//   │        ┌──────┐          │  ← poster, half out of the banner
//   │        │poster│          │
//   │        └──────┘          │
//   │        TV · 2024         │  ← cover-colored kicker
//   │       TITLE HERE         │
//   │    ★ 8.4 · Airing        │
//   │  [24 eps] [24m]          │
//   │  (Action) (Drama) …      │
//   │      synopsis …          │
//   │   ┌──────────────┐       │
//   │   │ ▶ Watch now  │       │  ← full-width CTA
//   │   └──────────────┘       │
//   │   ( ♡ )  ( ⇪ )           │  ← round icon actions, centered
//   │  Episodes | Relations |… │
//   └──────────────────────────┘
//
// The screen stays "one interface per concern": it talks to `lib/anilist` and
// the extension registry, never to Discord, and never to a source directly.

import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { openAnime } from '@/lib/nav/pushOnce';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  withSpring,
  withDelay,
  Easing,
} from 'react-native-reanimated';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Circle } from 'react-native-svg';
import { mediaTitle, type MediaDetail, type MediaItem } from '@/lib/anilist';
import { episodesToShow, nothingAiredYet } from '@/lib/anilist/episodes';
import { getLoadedExtensions } from '@/lib/extensions/registry';
import type { EpisodeInfo } from '@/lib/extensions/types';
import { updateBrowsing } from '@/lib/presence/discord';
import { loadPositions } from '@/lib/progress';
import { useMediaDetail } from '@/lib/query/hooks';
import { useSetting, type SettingValue } from '@/lib/settings/useSetting';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useTheme } from '@/lib/ui/useTheme';
import { font, layout, radii, spacing } from '@/lib/ui/tokens';
import { coverAccent } from '@/lib/ui/accent';
import { AppIcon, type AppIconName } from '@/components/ui/AppIcon';
import { RailScrollbar } from '@/components/ui/RailScrollbar';
import { countdown } from '@/components/schedule/format';
import {
  kitsuEpisodeVersion,
  mergeKitsuMeta,
  peekKitsuEpisodes,
  resolveKitsuEpisodes,
} from '@/lib/media/kitsuEpisodes';
import { useNow } from '@/lib/ui/useNow';
import { useIsFocusedNow } from '@/lib/ui/useIsFocusedNow';
import { SearchField } from '@/components/ui/SearchField';
import { DetailSkeleton } from '@/components/anime/DetailSkeleton';
import { LoadingBoundary } from '@/components/ui/LoadingBoundary';
import { openListSheet } from '@/lib/list/listSheet';
import { openCharacterSheet } from '@/lib/anime/characterSheet';
import { useUserId } from '@/lib/auth/session';
import { useListEntry } from '@/lib/query/listEntries';
import { EPISODE_WATCHED_AT, EpisodeRow } from '@/components/anime/EpisodeRow';
import { MediaRail } from '@/components/anime/MediaRail';
import {
  formatLabel,
  minutesToSeconds,
  relationLabel,
  statusLabel,
} from '@/components/anime/format';

type Tab = 'episodes' | 'relations' | 'characters';
/** Position of a tab in the strip — defines "left" and "right" for slides. */
const TAB_ORDER: Tab[] = ['episodes', 'relations', 'characters'];
const tabIdx = (t: Tab) => TAB_ORDER.indexOf(t);

const EPISODES_PER_PAGE = 10;
/**
 * How long the episode-artwork fetch waits for the visible set to settle.
 *
 * Collapses a run of pager taps or search keystrokes into one request. The
 * in-flight guard in `lib/media/kitsuEpisodes.ts` is what actually makes the
 * request count correct; this is what keeps a burst from producing a burst of
 * promises and re-renders.
 */
const EP_KITSU_DEBOUNCE_MS = 200;

/** Numbered page pills shown either side of the current page before ellipsis. */
const PAGE_PILL_SPREAD = 1;
const BANNER_H = 216;
const POSTER_W = 150;
/** How much of the poster's height hangs over the banner's bottom edge. */
const POSTER_OVERLAP = 0.38;

export default function AnimeDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const animeId = Number(id);
  const { color } = useTheme();
  const insets = useSafeAreaInsets();
  // The relations rail follows the tile design picked in settings.
  const tileStyle = useSetting('home.tileStyle');

  const [episodes, setEpisodes] = useState<EpisodeInfo[]>([]);
  /**
   * WHETHER THE EPISODE FETCH IS STILL OUTSTANDING.
   *
   * This exists because "no episodes" and "not yet" are different facts and the
   * screen was conflating them: `episodes` starts as `[]`, so during the request
   * the list rendered "No episodes available from any source yet." — which is a
   * confident claim about a source that had not been asked yet. It read as a
   * broken title rather than a loading one, and it lasted as long as two network
   * round trips (a token mint, then the episode list).
   *
   * Set false in a `finally` rather than on the success path, so a genuine failure
   * lands on the empty state rather than on a skeleton that never resolves. That
   * distinction is the entire reason this is a boolean and not `isLoading`.
   */
  const [episodesPending, setEpisodesPending] = useState(true);
  // FilmU (Bingr) is now loaded from the extension repo, not compiled in. The
  // details page only needs its episode list for titles/thumbs; fall back to an
  // empty list (AniList's released count) when it is not loaded yet.
  const [positions, setPositions] = useState<Record<number, number>>({});
  const [tab, setTab] = useState<Tab>('episodes');
  const [query, setQuery] = useState('');
  const [epPage, setEpPage] = useState(1);
  const [saved, setSaved] = useState(false);

  /**
   * WHO IS SIGNED IN, read from the shared session rather than from SecureStore.
   *
   * Two reasons it is a subscription and not a mount-time read. A read here used to
   * be `useEffect(..., [])`, which is a snapshot: signing in from this very screen
   * left the bookmark button and the entry query both believing nobody was signed
   * in, with no way out but a restart. And it was a second SecureStore round-trip
   * for a value three screens read, each keeping its own copy and its own idea of
   * when it might be out of date.
   *
   * `undefined` means the keychain has not answered yet, and the entry query stays
   * disabled until it has — asking without a token 401s, and asking while we simply
   * do not know yet would be the same request.
   */
  const userId = useUserId();
  const signedIn = userId != null;
  const sessionKnown = userId !== undefined;

  /**
   * THE LIST ENTRY — for the ICON only.
   *
   * `saved` used to be a local boolean the bookmark button flipped on press, which
   * is a button that lies: it looked like it added the title to your AniList and
   * nothing was ever sent. The real state now lives in the query cache, so the
   * icon reflects the entry AniList actually holds and survives a remount — which
   * matters on this screen specifically, because it lives inside a `FlatList`
   * header that re-measures more than once.
   *
   * THE SHEET ITSELF IS NOT HERE. It is hosted once at the root
   * (`ListSheetHost`) because every tile in the app long-presses into the same
   * editor, and a second instance on this screen would be a second entry query, a
   * second mutation and a second thing to keep in step. This screen opens the
   * shared one and reads the same cached entry the host writes.
   */
  const { entry, loading: entryLoading } = useListEntry(animeId, signedIn && sessionKnown);

  // AniList's watched-episode count for this title. Used so the details page
  // reflects progress synced from another device (or a previous session) even
  // when there is no local resume position on this phone.
  const anilistProgress = entry?.progress ?? 0;

  /**
   * WHO OWNS "WHAT HAS BEEN WATCHED" FOR THIS TITLE — AniList, or this phone.
   *
   * The two records are not additive and must never be OR'd together. A local
   * resume position says "the playhead was here on this device"; an entry's
   * `progress` says "this many episodes have been marked watched". Treating
   * them as two votes for the same question is what let a title reset on
   * AniList keep printing "Completed" here: every episode still had a local
   * position from the earlier watch, so local outvoted the entry on every
   * count — the button, the resume target and every tick in the list.
   *
   * So there is exactly one authority, and the entry is it whenever there IS
   * one. That is also what makes a deliberate reset on AniList expressible at
   * all: without this, no action taken in the tracker could ever lower what
   * this screen shows.
   *
   * THE OTHER HALF IS NOT AN EDGE CASE. With no entry — signed out, or a title
   * nobody ever added — local positions are the ONLY record there is, and they
   * keep driving everything exactly as before. Handing the answer to AniList
   * unconditionally would blank the progress of every show watched while
   * signed out, which is the behaviour `lib/progress.ts` exists to provide.
   *
   * `undefined` (the entry query still in flight) reads as "no entry" for the
   * same reason: local is never a lie about this device, so a first paint that
   * shows local and then defers to the entry is honest in both frames.
   */
  const anilistOwnsProgress = entry != null;

  useEffect(() => {
    // Driven by the query rather than by the button, so it is right on first
    // paint after a revisit instead of flashing empty then filling.
    if (entry !== undefined) setSaved(entry != null);
  }, [entry]);

  /**
   * Open the SHARED editor. Signed-out is handled by the host, which prompts and
   * closes — so this does not need its own auth branch, and neither does any of
   * the tiles that long-press into it.
   */
  const openSheet = useCallback(() => {
    // `openListSheet` takes the media object and derives the display title itself,
    // the same way every tile calls it. `mediaRef` rather than `media` so this
    // callback's identity does not change every time the payload lands — it is
    // passed to a `memo`'d `RoundIconBtn`.
    const m = mediaRef.current;
    if (!m) return;
    openListSheet(m);
  }, []);
  // Episode list direction is PER-TITLE now (not global): the default is
  // ascending, and toggling persists only for this anime. Stored in AsyncStorage
  // under a per-anime key so it never leaks across titles.
  const [epOrder, setEpOrderState] = useState<'asc' | 'desc'>('asc');
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const v = await AsyncStorage.getItem(`miori:epOrder:${animeId}`);
        if (live && (v === 'asc' || v === 'desc')) setEpOrderState(v);
        else if (live) setEpOrderState('asc');
      } catch {
        if (live) setEpOrderState('asc');
      }
    })();
    return () => {
      live = false;
    };
  }, [animeId]);
  const setEpOrder = useCallback((next: 'asc' | 'desc') => {
    setEpOrderState(next);
    void AsyncStorage.setItem(`miori:epOrder:${animeId}`, next).catch(() => {});
  }, [animeId]);

  /**
   * THE ANILIST HALF, through the cache.
   *
   * This was one hand-rolled effect that fetched the media AND the extension's
   * episode list together, behind a full-screen spinner, with nothing cached.
   * Splitting them matters for three reasons:
   *
   *   1. THIS IS THE SCREEN PEOPLE COME BACK TO. Watching three episodes means
   *      opening it three times. With the response persisted, the second and
   *      third are instant and cost no request at all — and `prefetchAnime` on
   *      the card press means it is usually already there before the screen
   *      mounts.
   *   2. THE EPISODE LIST IS NOT ANILIST'S. It comes from a video extension, is
   *      a different provider entirely, and has nothing to do with AniList's rate
   *      limit. Coupling them meant one provider's failure hid the other's
   *      success, and the page showed a spinner because a video source was slow.
   *   3. The spinner below is now the ONLY loading state, and it waits on the
   *      media query alone.
   */
  const { data: media, error, refetch } = useMediaDetail(animeId);

  /**
   * Kitsu's per-episode metadata is NOT state. It lives in a module-level map that
   * is persisted to disk and read synchronously, so a title opened a second time
   * has artwork on its first frame with no await and no re-render.
   *
   * What IS state is `kitsuVersion` below — a counter bumped when a page lands.
   * The map itself is mutated in place, so its identity never changes and a memo
   * keyed on it would never re-run; the counter is what says "look again".
   */
  const [kitsuVersion, setKitsuVersion] = useState(0);

  // --- Episodes, from the extension. Not AniList, not cached with it.

  /**
   * `media` THROUGH A REF, and this effect keyed on `[animeId, filmu]`.
   *
   * It used to depend on `[animeId, media]`, which is the bug that made this
   * screen feel slow to open. `media` is the AniList query result: `undefined` on
   * the first render and an object a moment later, so the effect ran TWICE —
   * once immediately and again when AniList landed. The first extension request
   * was still in flight when the cleanup set `live = false`, so its result was
   * discarded and the screen waited on the SECOND identical request. Every open
   * of every anime paid for two requests and used one.
   *
   * The dependency was only ever there so the catch branch could read
   * `media.episodes` for its fallback. A ref serves that without making the
   * effect care: the fallback runs on a failure, and by then the ref holds
   * whatever AniList has said — which is either the payload or `undefined`, and
   * `undefined` correctly produces no fallback rows.
   *
   * ⚠️ THAT LAST SENTENCE IS NOW THE BUG, and it is why the fallback moved OUT of
   * this `catch` and into `episodesToShow`. A failure that arrived before AniList
   * landed found `undefined`, produced nothing, and — because this effect does not
   * depend on AniList — nothing ever retried: a title with one episode reported
   * "No episodes available from any source yet". The ref stays, because the
   * presence art below still wants the poster without re-running the fetch.
   */
  const mediaRef = useRef<MediaDetail | undefined>(media);
  mediaRef.current = media;

  useEffect(() => {
    let live = true;
    loadPositions(animeId).then((p) => live && setPositions(p));
    void (async () => {
      const filmuExt = getLoadedExtensions().find((e) => e.id === 'filmu');
      if (!filmuExt) {
        // Not loaded yet (offline / repo unreachable): AniList count drives
        // the list, Kitsu decorates.
        if (live) setEpisodesPending(false);
        return;
      }
      // Race filmu against a short deadline so an ISP-blocked / slow host
      // (bingr.one times out per chunk at 20s) cannot keep the episode skeleton
      // up for the whole timeout. When the deadline wins we lift the skeleton
      // and show AniList's released count immediately, while filmu keeps
      // running in the background and refines the list when it finally lands.
      const epsPromise = filmuExt.episodes(animeId);
      const timeoutPromise = new Promise<null>((resolve) => setTimeout(() => resolve(null), 4000));
      try {
        const result = await Promise.race([
          epsPromise.then((eps) => ({ kind: 'eps' as const, eps })),
          timeoutPromise.then(() => ({ kind: 'timeout' as const })),
        ]);
        if (result.kind === 'eps') {
          if (live) setEpisodes(result.eps);
        } else {
          // Keep awaiting filmu; it will refine the list when it resolves.
          void epsPromise
            .then((eps) => {
              if (live) setEpisodes(eps);
            })
            .catch(() => {});
        }
      } catch {
        // Nothing to do but leave the list empty: `episodesToShow` turns that
        // into AniList's released count. The throw is the signal, and handling
        // it here would be a second, racing copy of the same rule.
      } finally {
        // Every exit, including the unmount case. A skeleton that outlives its
        // own request is worse than no skeleton, and there is no path out of this
        // effect that should leave `episodesPending` true.
        if (live) setEpisodesPending(false);
      }
    })();
    return () => {
      live = false;
    };
  // `filmu` is safe in the list and `media` deliberately is not. The instance
    // is `useMemo`'d on `[]`, so its identity never changes and including it is
    // free — whereas `media` is exactly the dependency that made this effect run
    // twice per open. `mediaRef` carries it instead; see the note above.
  }, [animeId]);

  // Presence on every focus, not just mount — coming back here from an episode
  // is the transition that has to undo "Watching".
  // `?? null` rather than `?? undefined`: the hook's signature was written when
  // this was local state, which is `T | null`, and a query is `T | undefined`.
  useFocusBrowsing(media ?? null, animeId);

  const openEpisode = useCallback(
    (ep: number) => {
      router.push({
        pathname: '/watch/[id]/[ep]',
        params: { id: String(animeId), ep: String(ep) },
      });
    },
    [router, animeId]
  );

  const openMedia = useCallback(
    (m: MediaItem) => {
      // Guarded — see `lib/nav/pushOnce.ts`. The relations rail is the easiest
      // place in the app to stack duplicates: it is a horizontal row of same-
      // sized tiles at the bottom of a long page, so a mistimed tap repeats.
      openAnime(m.id);
    },
    []
  );

  /**
   * What the source returned, clamped to what has actually aired.
   *
   * The clamp is applied HERE as well as in the fallback, and it has to be: the
   * extension's list is upstream data this app does not control, and a source
   * that has pre-generated rows for a whole season would otherwise put the same
   * dead rows back that `releasedCount` just removed. Truncating by episode
   * NUMBER rather than dropping rows is deliberate — a source that returns
   * 1..12 with gaps is cut at the airing point, and anything the source omitted
   * stays omitted rather than being padded.
   *
   * `releasedCount` returns 0 for a show that has not started, which would empty
   * a list the source legitimately knows about. So the clamp only applies when
   * there IS an airing point to clamp at — an unreleased show with a real source
   * list keeps it, because that list is the source's answer and it is not this
   * screen's job to overrule it without evidence.
   */
  const airedEpisodes = useMemo(() => {
    // Clamp to what has aired, and fall back to AniList's count when the source
    // gave us nothing — both in one pure step, so a late AniList answer fills the
    // list without anything retrying. See `episodesToShow`.
    const shown = episodesToShow(episodes, media);
    // Kitsu's metadata goes on LAST, after the clamp, so it can only ever
    // decorate rows that survived. Merging before would let a Kitsu entry
    // resurrect something the clamp deliberately removed.
    //
    // Read through `peek` and keyed on `kitsuVersion` rather than on a state copy
    // of the map: the map is mutated in place by the fetcher, so memoising on its
    // identity would never re-run and rows that gained a poster would keep their
    // number chip until the screen was reopened.
    //
    // The `void kitsuVersion` is load-bearing and not noise. It is what makes this
    // a REAL dependency rather than a decorative one, which matters because
    // nothing else in this closure changes when a Kitsu page lands — the map's
    // identity is constant, so without this line the memo would be correct and
    // permanently stale.
    void kitsuVersion;
    return mergeKitsuMeta(shown, peekKitsuEpisodes(animeId));
  }, [episodes, media, animeId, kitsuVersion]);

  // Number-based episode search: "12" or "ep 12" matches episode 12;
  // a partial number like "1" matches 1, 10-19, 21, 31... (any episode whose
  // number contains the digits). Non-numeric input falls back to titles.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return airedEpisodes;
    const digits = q.replace(/[^0-9]/g, '');
    if (digits) {
      return airedEpisodes.filter((e) => String(e.number).includes(digits));
    }
    return airedEpisodes.filter((e) => (e.title ?? '').toLowerCase().includes(q));
  }, [airedEpisodes, query]);

  /**
   * THE SORT, applied AFTER filtering and BEFORE paging.
   *
   * The order matters twice over.
   *
   * After the filter, so that "desc" means "the newest of the matches", not "the
   * newest ten of the matches, sorted".
   *
   * Before the pager, because paging is positional: page 1 is a SLICE of the
   * list, and reversing after slicing would put episode 20 and episode 10 side by
   * side with a hole where 19 belongs. Reversing first means page 1 of a
   * descending list really is the newest ten.
   *
   * `slice().reverse()` rather than sorting: the list is already in ascending
   * order — both providers sort it, and `mergeKitsuMeta` preserves that — so
   * reversing is exact, allocation-light, and cannot disagree with a comparator
   * about where ties go. Episodes have unique numbers, so there are no ties.
   */
  const ordered = useMemo(
    () => (epOrder === 'desc' ? filtered.slice().reverse() : filtered),
    [filtered, epOrder]
  );

  const pageCount = Math.max(1, Math.ceil(ordered.length / EPISODES_PER_PAGE));

  // Clamp the page whenever the filtered set shrinks (search typed, new anime).
  const safePage = Math.min(epPage, pageCount);
  const paged = useMemo(
    () => ordered.slice((safePage - 1) * EPISODES_PER_PAGE, safePage * EPISODES_PER_PAGE),
    [ordered, safePage]
  );

  /**
   * THE EPISODES CURRENTLY ON SCREEN, as a stable primitive.
   *
   * This is what Kitsu is asked about, and deriving it from `paged` rather than
   * from the whole list is what makes a 1,000-episode title cost one request
   * instead of fifty. Change the pager, change the sort, or type in the search
   * box and this becomes a different string, which is exactly when the fetch
   * should re-run.
   *
   * A JOINED STRING rather than the array because this is a dependency and an
   * effect dependency is compared with `Object.is`. A fresh array every render
   * would re-fire the effect on every render, which is the churn this codebase
   * keeps paying for elsewhere. The numbers are sorted so that a re-render that
   * produces the same set in a different order is not treated as a change.
   */
  const visibleNums = useMemo(
    () => paged.map((e) => e.number).sort((a, b) => a - b).join(','),
    [paged]
  );

  /**
   * THE KITSU FILL-IN, and why it is a separate effect rather than awaited
   * inside the episodes effect above.
   *
   * The extension decides which episodes exist; Kitsu only supplies artwork and
   * text for rows that already exist. Chaining them would make a second provider
   * a precondition for showing the list at all — and Kitsu is a third-party API
   * that can be slow, rate-limited or down, none of which should be able to hold
   * up a screen whose primary source has already answered.
   *
   * It asks about `visibleNums` ONLY. The screen shows `EPISODES_PER_PAGE` rows,
   * so that is all it requests; walking the pager requests one more Kitsu page
   * per step. Fetching a whole title up front is what made the first version
   * truncate silently at 120 episodes and spend a dozen requests on artwork
   * nobody was looking at — see `lib/media/kitsuEpisodes.ts`.
   *
   * `kitsuVersion` is a counter rather than the map, because the map is mutated in
   * place: a version bump is what tells the memo below to look again.
   *
   * NO CLEANUP GUARD, unlike the effect above. There is nothing to cancel — the
   * fetch is idempotent and cached by page, so a response arriving after the user
   * has paged away is simply written to the cache and used if they come back. A
   * `live` flag here would only discard a result that is still correct.
   */
  useEffect(() => {
    if (!visibleNums) return;
    // DEBOUNCED, and the timer is the SECOND line of defence rather than the
    // first. `kitsuEpisodes` already refuses to re-request a page that is in
    // flight, so a burst of taps cannot produce a burst of requests even with
    // this removed — but it would still produce a burst of RESOLVED promises and
    // version bumps, which is its own kind of churn.
    //
    // 200ms is about the length of a deliberate tap-and-look, not a mash: long
    // enough that four fast page presses collapse into one call, short enough
    // that a single deliberate press still feels immediate. Nothing is rendered
    // off the back of this — the list is already on screen with its number chips,
    // and the artwork appears when it arrives either way.
    let cancelled = false;
    const timer = setTimeout(() => {
      void resolveKitsuEpisodes(animeId, visibleNums.split(',').map(Number)).then(() => {
        if (!cancelled) setKitsuVersion(kitsuEpisodeVersion(animeId));
      });
    }, EP_KITSU_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [animeId, visibleNums]);

  /**
   * Where the Watch button goes, decided by the same authority as everything
   * else on this screen.
   *
   * WITH AN ENTRY: `progress + 1`. That number is not a guess about where the
   * viewer stopped — the 82% rule only counts an episode once it is nearly
   * over, so `progress` IS the episode in hand and the next one is exactly
   * where to continue. It also means a title watched to 30% of episode 5 still
   * resumes at 5 (the entry says 4), which is why deferring to AniList here
   * loses nothing that the local high-water mark used to provide.
   *
   * WITHOUT ONE: the furthest episode with a resume point, as before.
   *
   * Must sit above the early returns below — a hook after one is a
   * rules-of-hooks violation and breaks the moment an error is set.
   */
  const resumeEp = useMemo(() => {
    const total = media?.episodes ?? airedEpisodes.length ?? 0;
    if (anilistOwnsProgress) {
      const next = anilistProgress + 1;
      return total > 0 && next > total ? total : next;
    }
    const started = Object.keys(positions)
      .map(Number)
      .sort((a, b) => b - a)[0];
    return started ?? 1;
  }, [positions, anilistProgress, anilistOwnsProgress, media?.episodes, airedEpisodes.length]);

  // Direction of the last tab change (+1 right, -1 left), so the content
  // slides in from the same side the pill travelled from. Above the early
  // returns, like every other hook.
  const prevTabRef = useRef<Tab>('episodes');
  const tabDir = tabIdx(tab) >= tabIdx(prevTabRef.current) ? 1 : -1;
  useEffect(() => {
    prevTabRef.current = tab;
  }, [tab]);

  /**
   * Entering animations only run for views added to an ALREADY-MOUNTED parent.
   * On the very first mount of this screen (and of its FlatList header) they
   * did not fire, leaving content at its initial opacity 0. So the first paint
   * renders with NO entering animation at all (opacity 1, no offset), and only
   * subsequent remounts — tab switches, pagination — animate.
   */
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
  }, []);

  if (error && !media) {
    return (
      <View style={[styles.center, { backgroundColor: color.bg.primary }]}>
        <Text style={[styles.error, { color: color.status.danger }]}>{error.message}</Text>
        <Pressable
          onPress={() => void refetch()}
          style={[styles.retryBtn, { backgroundColor: color.accent.muted }]}
        >
          <Text style={[styles.retryText, { color: color.text.primary }]}>Try again</Text>
        </Pressable>
        <Pressable onPress={() => router.back()} style={[styles.retryBtn]}>
          <Text style={[styles.retryText, { color: color.text.muted }]}>Go back</Text>
        </Pressable>
      </View>
    );
  }

  /**
   * THE HANDOVER, and why there is no early return for the skeleton any more.
   *
   * This used to `return <DetailSkeleton/>` when `media` was null and a faded
   * `Animated.View` when it was not. Two different trees, so React unmounted one
   * and mounted the other in a single commit — on the heaviest screen in the
   * app, which is a banner, a poster, a synopsis, a tab strip and a page of
   * episode rows arriving together. The skeleton snapped away and then there was
   * a beat of nothing while `FadeIn` ran up from zero.
   *
   * `LoadingBoundary` fixes that, but ONLY if it is the same component instance
   * across the transition — an early return unmounts it, and then the handover
   * has nothing to hand over from. So the skeleton is the boundary's `skeleton`
   * prop and the body renders only when there is a body to render. See
   * `components/ui/LoadingBoundary.tsx` for why that is deliberately two renders.
   *
   * The derived values below therefore read `media` through null-safe
   * expressions. They are `''`/`0`/`undefined` for exactly one span of time —
   * the query in flight with nothing cached — and nothing can see them, because
   * the entire tree they feed renders only when `media` is truthy. They are here
   * to satisfy the compiler, not to be looked at.
   */
  const title = media ? mediaTitle(media.title) : '';
  const fmt = media ? formatLabel(media.format) : '';
  const perEp = media ? minutesToSeconds(media.duration) : 0;
  const accent = media ? coverAccent(media.coverImage?.color) : color.accent.base;

  /**
   * HOW MANY EPISODES ARE WATCHED, asked of whichever side owns the answer.
   *
   * TWO THINGS THIS REPLACES, and the second is why it is a count at all:
   *
   *   1. The `||` that made it a union of both records. With AniList tracking
   *      the title, a local resume position must not be able to answer this —
   *      see `anilistOwnsProgress`.
   *
   *   2. `resumeEp >= total`, which was off by one in the direction that
   *      matters. `resumeEp` is the NEXT episode, so an entry at
   *      `progress === total - 1` resumes at `total` and the old test called
   *      that finished with one episode still outstanding. "Completed" is a
   *      claim about a COUNT, so it is compared as one now, in both directions.
   *
   * The local branch counts with `EPISODE_WATCHED_AT` — the same threshold
   * `EpisodeRow` ticks a row with — so the button can never say "Completed"
   * over a list that still shows an episode unwatched.
   */
  const totalEpisodes = media?.episodes ?? airedEpisodes.length ?? 0;
  const watchedCount = anilistOwnsProgress
    ? anilistProgress
    : Object.values(positions).filter(
        (t) => perEp != null && perEp > 0 && t / perEp > EPISODE_WATCHED_AT
      ).length;
  const hasProgress = anilistOwnsProgress
    ? anilistProgress > 0
    : Object.keys(positions).length > 0;

  // What the watch button SAYS, driven by the user's list status rather than
  // by raw progress. A finished title the user has completed must not keep
  // prompting "Resume Ep X" — that reads as a lie. Planning / paused / dropped
  // / rewatching get their own honest labels too; only a genuinely in-progress
  // (or untracked) title keeps the progress-based wording.
  const watchLabel = (() => {
    const s = entry?.status;
    if (s === 'COMPLETED') return 'Completed';
    if (s === 'REPEATING') return 'Rewatching';
    if (s === 'PAUSED') return 'Paused';
    if (s === 'DROPPED') return 'Dropped';
    if (s === 'PLANNING') return 'Planning';
    // CURRENT (or nothing tracked): infer completion from the watched count so
    // a finished binge never keeps prompting "Resume Ep X".
    if (totalEpisodes > 0 && watchedCount >= totalEpisodes) return 'Completed';
    return hasProgress ? `Resume Ep ${resumeEp}` : 'Watch now';
  })();
  const watchIcon = entry?.status === 'COMPLETED' || (totalEpisodes > 0 && watchedCount >= totalEpisodes)
    ? 'check'
    : 'play';
  const banner = media ? media.bannerImage ?? media.coverImage?.extraLarge : undefined;

  const nothingAired = nothingAiredYet(media);
  const tabs: { key: Tab; label: string; hidden?: boolean }[] = media
    ? [
        // An unaired title has no tile to show — not the source's
        // pre-generated season, not the empty-state. `episodesToShow` already
        // returns nothing for it; hiding the tab hides the noise too.
        { key: 'episodes', label: 'Episodes', hidden: nothingAired },
        { key: 'relations', label: 'Relations', hidden: !media.relations?.length },
        { key: 'characters', label: 'Characters', hidden: !media.characters?.length },
      ]
    : [];
  const visibleTabs = tabs.filter((t) => !t.hidden);
  // The `tab` state defaults to 'episodes', which a hidden tab invalidates:
  // the body must follow the tab strip, or an unaired title renders its
  // episodes body under a strip that no longer offers it.
  const activeTab: Tab | undefined = visibleTabs.some((t) => t.key === tab)
    ? tab
    : visibleTabs[0]?.key;

  const data = activeTab === 'episodes' ? paged : [];
  const showPagination = activeTab === 'episodes' && pageCount > 1;

  return (
    <View style={[styles.container, { backgroundColor: color.bg.primary }]}>
      {/* The ONLY case a skeleton is right on this screen: nothing cached for
          this title and the request is still in flight. Coming back to an anime
          you have already opened never reaches here — `prefetchAnime` fires on
          touch-down, so the payload is usually already arriving with the push
          animation.

          It is the SCREEN at its real geometry (DetailSkeleton), not a spinner:
          a spinner over an empty page reads as a hang, and a full page
          assembling at once when the payload lands is a layout jump on the
          app's heaviest screen. */}
      <LoadingBoundary loading={!media} skeleton={<DetailSkeleton insetTop={insets.top} />}>
        {media ? (
          <FlatList
            data={data}
            keyExtractor={(e) => String(e.number)}
            // Long lists of small rows: a bigger window keeps scrolling smooth at
            // the cost of rendering a few more rows up front.
            windowSize={9}
            initialNumToRender={8}
            // App-wide finding (see home tab / MediaRail): with expo-image,
            // removeClippedSubviews unmounts views whose bitmaps are still
            // decoding, and on this screen specifically it clipped the
            // ListHeaderComponent (tabs + the episode-number search field) while
            // leaving its layout space and tap target behind — a "hidden but still
            // clickable" ghost that read as extra space between the tab pill and
            // the episode list. Virtualisation (windowSize) already bounds what is
            // resident, so clipping is not needed here.
            removeClippedSubviews={false}
            contentContainerStyle={{ paddingBottom: insets.bottom + spacing.xxxl }}
            ListHeaderComponent={
              <>
                {/* ------- Banner ------- */}
                <View style={styles.bannerWrap}>
                  {banner ? (
                    <Image
                      source={{ uri: banner }}
                      style={StyleSheet.absoluteFill}
                      contentFit="cover"
                      transition={250}
                      cachePolicy="memory-disk"
                    />
                  ) : null}
                  {/* Scrim + fade into the page colour, so the art dissolves
                      rather than ending on a hard edge. */}
                  <LinearGradient
                    colors={['rgba(0,0,0,0.2)', 'rgba(0,0,0,0.5)']}
                    style={StyleSheet.absoluteFill}
                  />
                  <LinearGradient
                    colors={['transparent', color.bg.primary]}
                    locations={[0.25, 1]}
                    style={StyleSheet.absoluteFill}
                  />
                  <Pressable
                    onPress={() => router.back()}
                    accessibilityRole="button"
                    accessibilityLabel="Go back"
                    hitSlop={8}
                    style={[styles.back, { top: insets.top + spacing.sm }]}
                  >
                    <AppIcon name="back" size={22} color={color.text.onMedia} strokeWidth={2.5} />
                  </Pressable>
                </View>

                {/* ------- Identity, centered ------- */}
                <View style={styles.identity}>
                  {/* Poster + accent frame. The wrapper's gradient padding is
                      the visible frame — a 2px ring in the show's colour, so the
                      border belongs to the artwork instead of grey chrome. The
                      shadow behind it is the glow. */}
                  <LinearGradient
                    colors={[accent, `${accent}55`]}
                    start={{ x: 0, y: 0 }}
                    end={{ x: 1, y: 1 }}
                    style={[
                      styles.posterFrame,
                      { shadowColor: accent, shadowOpacity: 0.55, shadowRadius: 28, shadowOffset: { width: 0, height: 0 }, elevation: 12 },
                    ]}
                  >
                    <View style={[styles.posterWrap, { backgroundColor: color.bg.elevated }]}>
                      <Image
                        source={{
                          uri: media.coverImage?.extraLarge ?? media.coverImage?.large,
                        }}
                        style={StyleSheet.absoluteFill}
                        contentFit="cover"
                        transition={200}
                        cachePolicy="memory-disk"
                      />
                    </View>
                  </LinearGradient>

                  {fmt || media.seasonYear ? (
                    <Text style={[styles.kicker, { color: accent }]}>
                      {[fmt?.toUpperCase(), media.seasonYear].filter(Boolean).join(' · ')}
                    </Text>
                  ) : null}

                  <Text style={[styles.title, { color: color.text.primary }]}>{title}</Text>
                </View>

                {/* ------- Synopsis ------- */}
                <Synopsis text={media.description ?? null} />

                {/* ------- Actions, centered ------- */}
                <View style={styles.actions}>
                  {/* No Watch button over nothing: an unaired title has no
                      episode to open, and the button's only job is opening
                      one. Nothing aired → no button (the device report). */}
                  {!nothingAired && (
                    <Pressable
                      onPress={() => openEpisode(resumeEp)}
                      accessibilityRole="button"
                      accessibilityLabel={watchLabel}
                      style={({ pressed }) => [
                        styles.watchBtn,
                        { backgroundColor: color.accent.base, opacity: pressed ? 0.85 : 1 },
                      ]}
                    >
                      <AppIcon name={watchIcon} size={18} color={color.bg.primary} strokeWidth={2.5} />
                      <Text style={[styles.watchText, { color: color.bg.primary }]}>
                        {watchLabel}
                      </Text>
                    </Pressable>
                  )}
                  <View style={styles.iconRow}>
                    <RoundIconBtn
                      label={saved ? 'Edit list entry' : 'Add to list'}
                      onPress={openSheet}
                    >
                      {/* `undefined` rather than `false` while loading: the icon
                          must not flash "not on the list" on a title the user has
                          already added, because the query resolves after the
                          first paint. */}
                      {entryLoading && entry === undefined ? (
                        <ActivityIndicator size="small" color={color.text.secondary} />
                      ) : (
                        <AppIcon
                          name={saved ? 'saved' : 'unsaved'}
                          size={20}
                          color={saved ? accent : color.text.secondary}
                        />
                      )}
                    </RoundIconBtn>
                    <RoundIconBtn
                      label="Share"
                      onPress={() => {
                        void Share.share({
                          message: `${title}\nhttps://anilist.co/anime/${media.id}`,
                        });
                      }}
                    >
                      <AppIcon name="share" size={20} color={color.text.secondary} />
                    </RoundIconBtn>
                  </View>
                </View>

                {/* ------- Next episode, when there is one ------- */}
                <NextEpisodeCard media={media} accent={accent} />

                {/* ------- Details: grid + keywords + titles, one block ------- */}
                <DetailsBlock media={media} accent={accent} />

                {/* ------- Tabs: animated segmented control ------- */}
                {visibleTabs.length > 0 && (
                  <AnimatedTabs
                    tabs={visibleTabs}
                    value={activeTab ?? visibleTabs[0].key}
                    onChange={setTab}
                    accent={accent}
                  />
                )}

                {/* ------- Tab bodies (directional slide on switch) ------- */}
                <Animated.View key={tab} entering={mountedRef.current ? contentEntering(tabDir) : undefined} style={styles.tabBody}>
                {activeTab === 'episodes' ? (
                  <>
                    {/* Search and sort share one row because they are the same
                        kind of control — both change what the list below shows
                        without changing the list itself — and the search field is
                        the only wide thing on this row. The toggle takes its
                        natural width beside it rather than a row of its own, which
                        would put a 44pt control between the field and the episodes
                        it affects. */}
                    <View style={styles.searchRow}>
                      <View style={styles.searchFieldWrap}>
                        <SearchField
                          value={query}
                          onChangeText={setQuery}
                          placeholder="Jump to episode #"
                          keyboardType="number-pad"
                        />
                      </View>
                      <SortToggle
                        order={epOrder}
                        accent={accent}
                        onToggle={() =>
                          setEpOrder(epOrder === 'desc' ? 'asc' : 'desc')
                        }
                      />
                    </View>
                    {airedEpisodes.length > 0 && (
                      <Text style={[styles.epCount, { color: color.text.muted }]}>
                        {ordered.length} of {airedEpisodes.length} episodes
                      </Text>
                    )}
                  </>
                ) : null}

                {activeTab === 'relations' && media.relations?.length ? (
                  <MediaRail
                    title="Related"
                    items={media.relations.map((r) => r.media)}
                    onSelect={openMedia}
                    seeAll={false}
                    // Same tile design the user picked for home rails.
                    variant={tileStyle}
                    kickerFor={(_, i) => relationLabel(media.relations![i].type)}
                  />
                ) : null}

                {activeTab === 'characters' && media.characters?.length ? (
                  <CharacterStrip
                    characters={media.characters}
                    animeId={animeId}
                    animeTitle={title}
                  />
                ) : null}

                {/* Gated on the DERIVED list and on the request, not on the raw
                    one: a failed source fetch now yields AniList's released
                    count, and that must read as episodes rather than as "none
                    available". `episodesPending` comes FIRST so the skeleton
                    wins while the source is still in flight — otherwise the
                    generated rows would flash before the real ones arrive. */}
                {/* Gated on the DERIVED list and on the request, not on the raw
                    one: a failed source fetch now yields AniList's released
                    count, and that must read as episodes rather than as "none
                    available". `episodesPending` comes FIRST so the skeleton
                    wins while the source is still in flight — otherwise the
                    generated rows would flash before the real ones arrive. */}
                {activeTab === 'episodes' && episodesPending ? <EpisodeLoading /> : null}
                {activeTab === 'episodes' && !episodesPending && airedEpisodes.length === 0 ? (
                  <EmptyState message="No episodes available from any source yet." />
                ) : null}
                {activeTab === 'episodes' && !episodesPending && airedEpisodes.length > 0 && filtered.length === 0 ? (
                  <EmptyState message="No episodes match that search." />
                ) : null}
                </Animated.View>
              </>
            }
            renderItem={({ item, index }) => (
              <Animated.View entering={mountedRef.current ? rowEntering(index) : undefined}>
                <EpisodeRow
                  number={item.number}
                  title={item.title ?? `Episode ${item.number}`}
                  thumbnail={item.poster}
                  duration={perEp}
                  // A local resume position is DROPPED here, not merged, when
                  // AniList tracks this title: leaving it in would let this
                  // device's old positions keep every episode ticked and keep
                  // drawing a bar under each one, which is the contradiction
                  // that made an AniList reset invisible. The position still
                  // does its real job — the player seeks with it — it just
                  // cannot vote on whether an episode was watched.
                  position={anilistOwnsProgress ? 0 : positions[item.number] ?? 0}
                  watchedOverride={item.number <= anilistProgress}
                  onPress={() => openEpisode(item.number)}
                />
              </Animated.View>
            )}
            ListFooterComponent={
              <>
                {showPagination ? (
                  <PageNav
                    page={safePage}
                    pageCount={pageCount}
                    onChange={(p) => setEpPage(p)}
                    accent={accent}
                  />
                ) : null}

                {/* Recommendations — always the page's tail, whatever tab you're
                    on. Same tile design as the home rails. */}
                {media.recommendations?.length ? (
                  <MediaRail
                    title="You may also like"
                    items={media.recommendations}
                    onSelect={openMedia}
                    variant={tileStyle}
                    seeAll={false}
                  />
                ) : null}
              </>
            }
              />
        ) : null}
      </LoadingBoundary>
    </View>
  );
}

/** Re-assert browsing presence whenever the screen regains focus.
 *
 * The plain effect below only fires when `media`/`animeId` change — returning
 * from the PLAYER changes neither (the screen was mounted beneath it the whole
 * time), so the return trip never asserted the page's own presence and the
 * account kept whatever the release path left. `useFocusEffect` re-runs on
 * focus; the media object itself must NOT sit in its deps — a query result
 * gets a fresh identity on every refetch, and each of those would be a
 * presence frame (the documented trap). The ref holds the latest media, the
 * callback identity only follows `animeId`. */
function useFocusBrowsing(media: MediaDetail | null, animeId: number) {
  const latest = useRef(media);
  latest.current = media;
  useFocusEffect(
    useCallback(() => {
      const m = latest.current;
      if (!m) return;
      const cover = m.coverImage?.extraLarge ?? m.coverImage?.large;
      updateBrowsing(mediaTitle(m.title), {
        artKey: `a${animeId}`,
        artUrl: cover ?? '',
        pageUrl: `https://anilist.co/anime/${animeId}`,
      });
    }, [animeId])
  );
  // Media arriving on a focused screen (first load) — the focus callback ran
  // while it was still null and will not re-run for the arrival.
  useEffect(() => {
    if (!media) return;
    const cover = media.coverImage?.extraLarge ?? media.coverImage?.large;
    updateBrowsing(mediaTitle(media.title), {
      artKey: `a${animeId}`,
      artUrl: cover ?? '',
      pageUrl: `https://anilist.co/anime/${animeId}`,
    });
  }, [media, animeId]);
}

// ---------------------------------------------------------------------------
// Header pieces
// ---------------------------------------------------------------------------

/**
 * Tab-body entrance (content transition when the tab changes) — directional
 * slide matching the pill: moving to a tab on the right, the new content enters
 * from the right; moving left, from the left. Opacity-safe: starts at opacity 1.
 */
const contentEntering = (dir: number) => (values: any) => {
  'worklet';
  return {
    initialValues: { opacity: 1, transform: [{ translateX: dir * 28 }] },
    animations: {
      opacity: withTiming(1, { duration: 170 }),
      transform: [
        { translateX: withTiming(0, { duration: 240, easing: Easing.out(Easing.cubic) }) },
      ],
    },
  };
};

/** Row entrance — a 12px rise + fade, staggered ~25ms per index so a page
 *  of rows cascades quickly instead of arriving as one block. */
/**
 * Row entrance — opacity-safe for the same reason as `contentEntering`: a
 * `FadeInDown` starts at opacity 0, and on the initial mount of this list those
 * animations did not fire, leaving every row invisible-but-present. The slide
 * stays; the fade is removed so a missed animation can never hide a row. The
 * stagger is retained on the transform so a page still cascades.
 */
const rowEntering = (index: number) => (values: any) => {
  'worklet';
  const delay = Math.min(index, 10) * 25;
  return {
    initialValues: { opacity: 1, transform: [{ translateY: 12 }] },
    animations: {
      opacity: withDelay(delay, withTiming(1, { duration: 180 })),
      transform: [
        { translateY: withDelay(delay, withTiming(0, { duration: 180, easing: Easing.out(Easing.cubic) })) },
      ],
    },
  };
};

/**
 * Animated tab switcher — a pill track with a sliding indicator.
 *
 * The indicator is a rounded pill that glides under the active tab. Each tab
 * reports its own width via onLayout, so the pill is always exactly as wide
 * as its label (no fixed widths, no measuring round-trips). Position and
 * width share one spring, so switching feels like the pill is physically
 * moving. Label colours animate in the same window.
 */
function AnimatedTabs({
  tabs,
  value,
  onChange,
  accent,
}: {
  tabs: { key: Tab; label: string; hidden?: boolean }[];
  value: Tab;
  onChange: (t: Tab) => void;
  accent: string;
}) {
  const { color } = useTheme();
  // Measured geometry per tab: x-offset and width within the track.
  const geo = useRef(new Map<string, { x: number; w: number }>()).current;
  const x = useSharedValue(0);
  const w = useSharedValue(0);
  const [ready, setReady] = useState(false);

  const spring = { damping: 22, stiffness: 260, mass: 0.9 };

  const place = useCallback(
    (key: Tab, animate: boolean) => {
      const g = geo.get(key);
      if (!g) return;
      // `animate: false` is the first placement and anything after a re-measure.
      // Both JUMP rather than spring, because in those cases the pill is not
      // "moving to" a place — it is being put where it belongs, and a spring
      // from the old geometry would slide it through positions the user never
      // asked for.
      x.value = animate ? withSpring(g.x, spring) : g.x;
      w.value = animate ? withSpring(g.w, spring) : g.w;
    },
    // `geo` is a stable ref, and `spring` is a fresh object per render — the
    // identity churn on `spring` would re-run this and re-place the pill on
    // every render. Module scope for the constant, like `_layout.tsx` does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [geo]
  );

  const indicator = useAnimatedStyle(() => ({
    transform: [{ translateX: x.value }],
    width: w.value,
  }));

  /**
   * THE PILL FOLLOWS THE VALUE, NOT THE PRESS.
   *
   * This used to move only from the `Pressable`'s `onPress`, which meant the
   * indicator's position was coupled to how the value changed rather than to
   * what the value IS. Two things break that, and both happen in this app:
   *
   *   1. A value change from anywhere else — and there are two such sources, a
   *      parent that clamps or resets `value`, and a remount of this component
   *      (the strip lives in a `FlatList`'s `ListHeaderComponent`, and
   *      `removeClippedSubviews` is on) — left the pill exactly where the last
   *      press had put it, under a label that was no longer active.
   *   2. After the first placement, `measure` recorded new geometry and did
   *      nothing with it. A width change — rotation, a font-size change, a
   *      relayout after un-clipping — updated the map while the pill sat on the
   *      old numbers, which is the "stuck in the wrong place" case.
   *
   * So the placement is an EFFECT on the value, and a re-measure re-places. The
   * press handler no longer positions anything; it only reports the new value.
   */
  useEffect(() => {
    if (!ready) return;
    place(value, true);
  }, [ready, value, place]);

  // Each tab reports its geometry on layout; once ALL of them have, position
  // the indicator under the active tab. This runs on the item's layout (not
  // the track's), which fires after the children — the reason the pill used
  // to be invisible until the first press.
  //
  // NO `geo.clear()` ANYWHERE, and that is a correction rather than an omission.
  // A version of this had an effect that emptied the map whenever the tab count
  // changed, on the theory that a disappearing tab invalidates every offset
  // after it. It made the pill strictly worse, for a reason worth recording:
  // `ready` is in that effect's dependency list, so the flip from false to true
  // fired it immediately after `measure` had just filled the map — the clear
  // wiped the geometry the pill was about to be placed from, `place` found
  // nothing, and it never moved at all.
  //
  // The theory was also wrong. A tab that MOVED fires its own `onLayout`,
  // because that is what a move is, so `geo` refreshes itself for exactly the
  // tabs whose offsets changed. Clearing it would have needed a forced re-layout
  // to recover, and there is none.
  const measure = (key: Tab, e: { x: number; w: number }) => {
    const prev = geo.get(key);
    geo.set(key, e);
    if (!ready && geo.size >= tabs.length) {
      // First placement: jump, so nothing slides on mount.
      place(value, false);
      setReady(true);
      return;
    }
    // Already placed, and this tab MOVED. Re-place rather than record and
    // ignore — a stale map entry is exactly how a pill ends up under the wrong
    // label. Only when the active tab's own geometry changed, so a neighbouring
    // tab relaying out cannot yank the pill out from under a settled label.
    if (ready && prev && key === value && (prev.x !== e.x || prev.w !== e.w)) {
      place(value, false);
    }
  };

  return (
    <View style={[styles.tabStrip, { borderBottomColor: color.border.muted }]}>
      <View style={styles.tabTrack}>
        {ready ? (
          <Animated.View
            style={[styles.tabIndicator, { backgroundColor: accent }, indicator]}
            pointerEvents="none"
          />
        ) : null}
        {tabs.map((t) => {
          const active = t.key === value;
          return (
            <Pressable
              key={t.key}
              onPress={() => {
                // Reports the change only. The pill is positioned by the effect
                // on `value` — see the note there for why coupling the two is
                // what let it drift.
                onChange(t.key);
              }}
              accessibilityRole="tab"
              accessibilityState={{ selected: active }}
              style={styles.tabItem}
              onLayout={(e) =>
                measure(t.key, {
                  x: e.nativeEvent.layout.x,
                  w: e.nativeEvent.layout.width,
                })
              }
            >
              <Text
                style={[
                  styles.tabItemText,
                  { color: active ? color.bg.primary : color.text.muted },
                ]}
              >
                {t.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

/**
 * Numbered page navigation for the episode list.
 *
 * `‹  1 … 3  4  5 … 12  ›` — the current page, its neighbours, both ends,
 * and ellipses where the run is collapsed. Never wider than the screen:
 * with a big page count the ends still anchor the row and the middle windows
 * around the current page.
 */
function PageNav({
  page,
  pageCount,
  onChange,
  accent,
}: {
  page: number;
  pageCount: number;
  onChange: (p: number) => void;
  accent: string;
}) {
  const { color } = useTheme();

  // Build the pill list: ends always, window of PAGE_PILL_SPREAD around the
  // current page, ellipses where numbers were dropped.
  const items: (number | '…')[] = [];
  const wanted = new Set<number>([1, pageCount]);
  for (let p = page - PAGE_PILL_SPREAD; p <= page + PAGE_PILL_SPREAD; p++) {
    if (p >= 1 && p <= pageCount) wanted.add(p);
  }
  const sorted = [...wanted].sort((a, b) => a - b);
  sorted.forEach((p, i) => {
    if (i > 0 && p - sorted[i - 1] > 1) items.push('…');
    items.push(p);
  });

  const btn = (
    label: string,
    onPress: () => void,
    disabled: boolean,
    icon?: AppIconName
  ) => (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [
        styles.pageBtn,
        icon
          ? null
          : { backgroundColor: color.bg.surface, borderColor: color.border.muted },
        { opacity: disabled ? 0.3 : pressed ? 0.7 : 1 },
      ]}
    >
      {icon ? (
        <AppIcon name={icon} size={16} color={color.text.primary} />
      ) : (
        <Text style={[styles.pageBtnText, { color: color.text.primary }]}>{label}</Text>
      )}
    </Pressable>
  );

  return (
    <View style={styles.pageNav}>
      {btn('Previous page', () => onChange(page - 1), page === 1, 'back')}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.pagePills}
      >
        {items.map((it, i) =>
          it === '…' ? (
            <Text key={`gap-${i}`} style={[styles.pageGap, { color: color.text.muted }]}>
              …
            </Text>
          ) : (
            <Pressable
              key={it}
              onPress={() => onChange(it)}
              accessibilityRole="button"
              accessibilityLabel={`Page ${it}`}
              accessibilityState={{ selected: it === page }}
              style={({ pressed }) => [
                styles.pageBtn,
                {
                  backgroundColor: it === page ? accent : color.bg.surface,
                  borderColor: it === page ? accent : color.border.muted,
                  opacity: pressed ? 0.7 : 1,
                },
              ]}
            >
              <Text
                style={[
                  styles.pageBtnText,
                  { color: it === page ? color.bg.primary : color.text.primary },
                ]}
              >
                {it}
              </Text>
            </Pressable>
          )
        )}
      </ScrollView>
      {btn('Next page', () => onChange(page + 1), page === pageCount, 'chevron')}
    </View>
  );
}

/**
 * The episode sort control — one toggle, no menu.
 *
 * TWO STATES, SO NOT A DROPDOWN. A menu would be the wrong shape for a choice
 * with exactly two options: it costs a tap to open and a second to pick, for
 * something that is otherwise a single press. And the icon itself already
 * carries the meaning — an up-down arrow with the direction it currently sorts,
 * which is a control people read without reading a label.
 *
 * THE ICHON MEANS "WHAT YOU WILL GET NEXT", not "what you have". That is the
 * whole ambiguity of a sort toggle and it is worth being deliberate: the icon
 * shows the order you WILL see after pressing. `sortAsc` means the list will
 * read top-to-bottom forwards, so the arrow points that way. A user who reads it
 * as "the list is currently sorted this way" would press it and get the opposite
 * of what they expected.
 *
 * `hitSlop` of 4 on every edge: a 42px box is at the small end of comfortable for
 * a tap target, and this is a control people hit while scrolling a list. The
 * slop costs nothing visually and buys the edges back.
 *
 * The accent comes from the show's own cover colour, like every other control on
 * this page, so the toggle reads as part of the title rather than app chrome.
 */
function SortToggle({
  order,
  accent,
  onToggle,
}: {
  // Derived from the store's own key rather than a separately declared union, so
  // the component cannot accept an order the store does not actually store.
  order: SettingValue<'episodes.order'>;
  accent: string;
  onToggle: () => void;
}) {
  const { color } = useTheme();
  const next = order === 'desc' ? 'asc' : 'desc';

  return (
    <Pressable
      onPress={onToggle}
      accessibilityRole="button"
      accessibilityLabel={`Sort episodes ${next === 'desc' ? 'newest first' : 'oldest first'}`}
      hitSlop={4}
      style={({ pressed }) => [
        styles.sortBtn,
        {
          backgroundColor: color.bg.surface,
          borderColor: color.border.muted,
          opacity: pressed ? 0.6 : 1,
        },
      ]}
    >
      {/* Rotating the glyph rather than swapping two icons is what makes the
          control read as ONE thing that changed state, instead of two different
          buttons that happen to occupy the same box. 180° is the whole travel,
          which is the difference between "reversed" and "scrolling". */}
      <View
        style={[
          styles.sortIcon,
          { transform: [{ rotate: order === 'desc' ? '180deg' : '0deg' }] },
        ]}
      >
        <AppIcon name="sort" size={17} color={accent} strokeWidth={2.4} />
      </View>
    </Pressable>
  );
}

/**
 * The episode list is loading.
 *
 * A SPINNER, deliberately, and not placeholder rows. The argument for skeletons
 * generally is that they occupy the height the content will occupy, so the
 * handover is a fill rather than a reflow. That argument assumes the height is
 * knowable — and here it is not, in a way that matters: the list's length is
 * whatever the video source has for this title, which is not AniList's
 * `episodes` count and is not known until the request lands. Placeholder rows
 * sized from AniList were wrong at both ends — a one-episode film drew several
 * rows of furniture for one row of content, which reads as "this title has eight
 * episodes" right up until it corrects itself.
 *
 * So this takes up the height of about ONE ROW and no more. A list that turns
 * out to be one episode long grows by nothing; a list that is twenty long pushes
 * the footer down, which is a normal thing for a list to do and reads as content
 * arriving rather than as chrome moving.
 */
function EpisodeLoading() {
  const { color } = useTheme();
  return (
    <View style={styles.epLoading}>
      <ActivityIndicator color={color.accent.base} size="small" />
    </View>
  );
}

/** Clamped description, centered, with a read-more toggle. */
function Synopsis({ text }: { text: string | null }) {
  const { color } = useTheme();
  const [expanded, setExpanded] = useState(false);
  const clean = (text ?? '').replace(/<[^>]*>/g, '').trim();
  if (!clean) return null;
  return (
    <View style={styles.synopsisWrap}>
      <Pressable onPress={() => setExpanded((v) => !v)}>
        <Text
          style={[styles.synopsis, { color: color.text.secondary }]}
          numberOfLines={expanded ? undefined : 3}
        >
          {clean}
        </Text>
        <Text style={[styles.readMore, { color: color.text.primary }]}>
          {expanded ? 'Show less' : 'Read more'}
        </Text>
      </Pressable>
    </View>
  );
}

/**
 * NEXT EPISODE — the one card on this page that is about the future.
 *
 * Everything else here describes a title that already exists: its score, its
 * genres, the episodes you can watch. An airing show has exactly one piece of
 * forward-looking information AniList gives us, and it is the thing a viewer
 * actually came to check — when is the next one on. So it gets its own card
 * rather than a fourth stat in the details grid, where `12 Episodes` already sits
 * and the countdown would be read as a footnote to a count.
 *
 * PLACEMENT IS THE POINT. It goes directly under the watch button, above the
 * details grid, because that is the top of the page's decision area — you arrive,
 * you see what you can watch and when the next one lands, and only then the
 * reference material. It also directly answers the episode list below it: the
 * list ends where this card says the next one begins, so the two read as one
 * idea split across the tabs.
 *
 * `countdown` is the schedule's own formatter rather than a new one, so "in 2h
 * 05m" says exactly the same thing here as it does on the schedule tab — the
 * padding, the "Now" threshold and the day rounding are all in one place.
 *
 * LIVE, VIA `useNow`. Thirty-second ticks, focus-gated, exactly as the schedule
 * does it — one timer for the screen rather than one per card, and none at all
 * while this screen is in the stack behind something else. "in 12m" therefore
 * becomes "in 11m" on its own, without this card owning an interval.
 *
 * NOT RENDERED AT ALL unless there is genuinely a next episode. A finished show
 * gets nothing here, rather than a card saying "Aired 3 months ago", because the
 * absence is the correct message and a dead card is noise.
 */
function NextEpisodeCard({ media, accent }: { media: MediaDetail; accent: string }) {
  const { color } = useTheme();
  const isFocusedNow = useIsFocusedNow();
  const now = useNow(30_000, isFocusedNow);

  const next = media.nextAiringEpisode;
  if (!next?.airingAt) return null;

  // `duration` is AniList's per-episode runtime in minutes. It is what makes the
  // card worth the row: "Ep 7 · in 2h 05m · 24m" answers when AND how long,
  // which is the whole of what someone checks before deciding to wait.
  const runtime = media.duration ? `${media.duration}m` : null;
  const when = countdown(next.airingAt, now);

  return (
    <View
      style={[
        styles.nextCard,
        { backgroundColor: color.bg.surface, borderColor: color.border.muted },
      ]}
    >
      {/* The accent rail is the card's one piece of colour, and it is the SAME
          `headingBar` mark the details sections use — a 3px vertical in the
          show's own colour. Reusing that idiom is why this card reads as part of
          the page rather than a widget dropped into it. */}
      <View style={[styles.nextRail, { backgroundColor: accent }]} />

      <View style={styles.nextBadge}>
        <AppIcon name="sparkles" size={13} color={accent} strokeWidth={2.5} />
      </View>

      <View style={styles.nextBody}>
        <Text style={[styles.nextLabel, { color: color.text.muted }]}>NEXT EPISODE</Text>
        <Text style={[styles.nextEp, { color: color.text.primary }]} numberOfLines={1}>
          Episode {next.episode}
          {runtime ? <Text style={{ color: color.text.muted }}>{`  ·  ${runtime}`}</Text> : null}
        </Text>
      </View>

      {/* The countdown is the answer, so it gets the emphasis and the far edge.
          It is the one thing on this card that changes, which is why it is the
          only part allowed to be large. */}
      <Text style={[styles.nextWhen, { color: accent }]} numberOfLines={1}>
        {when}
      </Text>
    </View>
  );
}

/**
 * The score ring — an SVG donut showing the average score out of 10.
 * Track in the muted border colour, arc in the cover accent, big number in
 * the middle. This is the card's centrepiece.
 */
function ScoreRing({ score, accent }: { score: number; accent: string }) {
  const { color } = useTheme();
  const size = 64;
  const stroke = 5;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  // AniList averageScore is 0-100; the ring fills proportionally.
  const frac = Math.max(0, Math.min(1, score / 100));

  return (
    <View style={{ width: size, height: size }}>
      <Svg width={size} height={size}>
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={color.border.strong}
          strokeWidth={stroke}
          fill="none"
        />
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={accent}
          strokeWidth={stroke}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={`${c * frac} ${c}`}
          // Start at 12 o'clock, sweep clockwise.
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </Svg>
      <View style={styles.ringCenter} pointerEvents="none">
        <Text style={[styles.ringValue, { color: color.text.primary }]}>
          {score.toFixed(1)}
        </Text>
      </View>
    </View>
  );
}

/**
 * Details card, rebuilt to be the page's showpiece.
 *
 * Top band: the score ring on the left, episode/runtime stat blocks on the
 * right, all sitting on a subtle accent-tinted glow (LinearGradient in the
 * show's cover colour) so the card literally carries the show's hue.
 * Below: two-column table where every row has its own icon — Format, Status
 * (with a live pulse dot when airing), Season, Studio, Country, Popularity,
 * Favourites, Start date.
 */
function DetailsGrid({
  media,
  accent,
}: {
  media: MediaDetail;
  accent: string;
}) {
  const { color } = useTheme();

  const date = media.startDate;
  const dateLabel =
    date?.year
      ? new Date(date.year, (date.month ?? 1) - 1, date.day ?? 1).toLocaleDateString(
          undefined,
          { month: 'short', day: 'numeric', year: 'numeric' }
        )
      : null;

  const airing = statusLabel(media.status);
  const isAiring = airing === 'Airing';

  // Table rows: the long tail of facts, each with its own icon.
  const rows: { icon: AppIconName; label: string; value: string | null }[] = [
    { icon: 'clapper', label: 'Format', value: formatLabel(media.format) },
    { icon: isAiring ? 'sparkles' : 'schedule', label: 'Status', value: airing },
    {
      icon: 'schedule',
      label: 'Season',
      value: [media.season, media.seasonYear].filter(Boolean).join(' ') || null,
    },
    { icon: 'sparkles', label: 'Studio', value: media.studios?.[0] ?? null },
    { icon: 'globe', label: 'Country', value: media.countryOfOrigin ?? null },
    {
      icon: 'users',
      label: 'Popularity',
      value: media.popularity ? media.popularity.toLocaleString() : null,
    },
    {
      icon: 'heart',
      label: 'Favourites',
      value: media.favourites ? media.favourites.toLocaleString() : null,
    },
    { icon: 'schedule', label: 'Start date', value: dateLabel },
  ];
  const filled = rows.filter((r) => r.value);

  const hasScore = !!media.averageScore;
  const hasEpisodes = !!media.episodes;
  const hasRuntime = !!media.duration;
  if (!hasScore && !hasEpisodes && !hasRuntime && !filled.length) return null;

  return (
    <View
      style={[
        styles.grid,
        {
          backgroundColor: color.bg.surface,
          borderColor: color.border.muted,
          shadowColor: accent,
        },
      ]}
    >
      {/* Accent glow washes the top band in the show's colour. */}
      <LinearGradient
        colors={[`${accent}26`, 'transparent']}
        style={styles.gridGlow}
        pointerEvents="none"
      />

      {/* Hero band: ring + stat blocks. */}
      <View style={[styles.gridHero, filled.length ? { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: color.border.muted } : null]}>
        {hasScore ? (
          <View style={styles.gridRingWrap}>
            <ScoreRing score={media.averageScore!} accent={accent} />
          </View>
        ) : null}

        <View style={styles.gridStats}>
          {hasEpisodes ? (
            <View style={styles.gridStatBlock}>
              <View style={[styles.gridStatBadge, { backgroundColor: `${accent}26` }]}>
                <AppIcon name="play" size={13} color={accent} strokeWidth={2.5} />
              </View>
              <Text style={[styles.gridStatValue, { color: color.text.primary }]}>
                {media.episodes}
              </Text>
              <Text style={[styles.gridStatLabel, { color: color.text.muted }]}>Episodes</Text>
            </View>
          ) : null}
          {hasRuntime ? (
            <View style={styles.gridStatBlock}>
              <View style={[styles.gridStatBadge, { backgroundColor: `${accent}26` }]}>
                <AppIcon name="schedule" size={13} color={accent} strokeWidth={2.5} />
              </View>
              <Text style={[styles.gridStatValue, { color: color.text.primary }]}>
                {media.duration}m
              </Text>
              <Text style={[styles.gridStatLabel, { color: color.text.muted }]}>Per ep</Text>
            </View>
          ) : null}
          {airing ? (
            <View style={styles.gridStatBlock}>
              <View style={[styles.gridStatBadge, { backgroundColor: `${accent}26` }]}>
                <AppIcon
                  name={isAiring ? 'sparkles' : 'info'}
                  size={13}
                  color={accent}
                  strokeWidth={2.5}
                />
              </View>
              <Text
                style={[
                  styles.gridStatValue,
                  {
                    color: isAiring ? color.status.success : color.text.primary,
                    fontSize: isAiring ? 14 : 17,
                  },
                ]}
                numberOfLines={1}
              >
                {airing}
              </Text>
              <Text style={[styles.gridStatLabel, { color: color.text.muted }]}>Status</Text>
            </View>
          ) : null}
        </View>
      </View>

      {/* Table band: icon-led rows in two columns. */}
      {filled.map((r, i) => (
        <View
          key={r.label}
          style={[
            styles.gridCell,
            i < filled.length - (filled.length % 2 === 0 ? 2 : 1)
              ? { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: color.border.muted }
              : null,
            i % 2 === 0
              ? { borderRightWidth: StyleSheet.hairlineWidth, borderRightColor: color.border.muted }
              : null,
          ]}
        >
          <View style={[styles.gridCellIcon, { backgroundColor: `${accent}1A` }]}>
            <AppIcon name={r.icon} size={12} color={accent} strokeWidth={2.2} />
          </View>
          <View style={styles.gridCellText}>
            <Text style={[styles.gridLabel, { color: color.text.muted }]}>{r.label}</Text>
            <Text style={[styles.gridValue, { color: color.text.primary }]} numberOfLines={1}>
              {r.value}
            </Text>
          </View>
        </View>
      ))}
    </View>
  );
}

/**
 * Keyword pills — genres first, then the show's strongest tags — as ONE
 * horizontal rail. A rail rather than a wrap grid: every keyword is reachable
 * (just scroll), the section never changes height, and there's no
 * expand/collapse state to glitch. Swipe is the affordance.
 *
 * The rail and its thin scrollbar are `RailScrollbar` — the same component the
 * explore screen uses under its genre and filter rows, so the thumb maths
 * (length = visible fraction, position = scroll fraction) exists once.
 */
function Keywords({ words }: { words: string[] }) {
  const { color } = useTheme();
  return (
    <RailScrollbar
      style={styles.keywordRailWrap}
      trackInset={spacing.xl}
      contentContainerStyle={styles.keywordRow}
    >
      {words.map((w, i) => (
        <View
          key={`${w}-${i}`}
          style={[styles.keywordPill, { backgroundColor: color.accent.muted }]}
        >
          <Text style={[styles.keywordPillText, { color: color.text.secondary }]}>{w}</Text>
        </View>
      ))}
    </RailScrollbar>
  );
}

/**
 * The details section — grid, keywords and alternate titles — under labelled
 * headings, everything visible at once. No clamping, no fade, no toggle:
 * the grid is short, the keyword rail scrolls, and titles rarely exceed a
 * handful of lines. Simple beats clever here.
 */
function DetailsBlock({
  media,
  accent,
}: {
  media: MediaDetail;
  accent: string;
}) {
  const { color } = useTheme();

  const words = [...(media.genres ?? []), ...(media.tags ?? [])];
  const hasGrid = !!media.format || !!media.status || !!media.studios?.length || !!media.averageScore;
  if (!hasGrid && !words.length) return null;

  return (
    <View style={styles.detailsBlock}>
      <DetailsGrid media={media} accent={accent} />

      {words.length ? (
        <View style={styles.detailsSection}>
          <View style={styles.detailsHeadingWrap}>
            <Text style={[styles.detailsHeading, { color: color.text.primary }]}>
              Genres & Keywords
            </Text>
            <View style={[styles.headingBar, { backgroundColor: accent }]} />
          </View>
          <Keywords words={words} />
        </View>
      ) : null}

      <View style={styles.detailsSection}>
        <View style={styles.detailsHeadingWrap}>
          <Text style={[styles.detailsHeading, { color: color.text.primary }]}>Titles</Text>
          <View style={[styles.headingBar, { backgroundColor: accent }]} />
        </View>
        <AltTitles media={media} />
      </View>
    </View>
  );
}

/**
 * Alternate titles — one labelled row per title: Romaji, English, Native,
 * then synonyms. Labels make each line self-explanatory; duplicates (a show
 * whose romaji and native are written the same, or that match the main
 * title) are hidden so the section never shows the same string twice.
 */
function AltTitles({ media }: { media: MediaDetail }) {
  const { color } = useTheme();

  const seen = new Set<string>([mediaTitle(media.title).toLowerCase()]);
  const rows: { label: string; value: string }[] = [];
  const push = (label: string, value?: string | null) => {
    const v = value?.trim();
    if (!v) return;
    const key = v.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    rows.push({ label, value: v });
  };

  push('Romaji', media.title?.romaji);
  push('Native', media.title?.native);

  if (!rows.length) return null;

  return (
    <View style={styles.titleCard}>
      {rows.map((r, i) => (
        <View
          key={r.label}
          style={[
            styles.titleRow,
            i < rows.length - 1
              ? { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: color.border.muted }
              : null,
          ]}
        >
          <Text style={[styles.titleLabel, { color: color.text.muted }]}>{r.label}</Text>
          <Text style={[styles.titleValue, { color: color.text.secondary }]}>
            {r.value}
          </Text>
        </View>
      ))}
    </View>
  );
}

/** Round icon action — circular, quiet, centered as a pair. */
function RoundIconBtn({
  children,
  onPress,
  label,
}: {
  children: React.ReactNode;
  onPress?: () => void;
  label: string;
}) {
  const { color } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [
        styles.roundBtn,
        {
          backgroundColor: color.bg.surface,
          borderColor: color.border.muted,
          opacity: pressed ? 0.7 : 1,
        },
      ]}
    >
      {children}
    </Pressable>
  );
}

/** AniList character role enum → display label. */
function roleLabel(role: string): string {
  if (role === 'MAIN') return 'Main';
  if (role === 'SUPPORTING') return 'Supporting';
  if (role === 'BACKGROUND') return 'Background';
  return role.charAt(0) + role.slice(1).toLowerCase();
}

/**
 * Characters preview — a horizontal strip of circular portraits with a
 * trailing "View all" card that opens the full cast page.
 */
function CharacterStrip({
  characters,
  animeId,
  animeTitle,
}: {
  characters: NonNullable<MediaDetail['characters']>;
  animeId: number;
  animeTitle: string;
}) {
  const { color } = useTheme();
  const router = useRouter();
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.charRail}
    >
      {characters.map((c) => (
        // A `Pressable`, because a portrait is now the way into this character's
        // description. The whole cell rather than just the image, since the name
        // and role are part of what identifies the tap target.
        <Pressable
          key={c.id || c.name}
          onPress={() =>
            openCharacterSheet({
              id: c.id,
              name: c.name,
              image: c.image,
              role: c.role,
              animeTitle,
            })
          }
          accessibilityRole="button"
          accessibilityLabel={`${c.name}, ${roleLabel(c.role)}. Open character details`}
          style={({ pressed }) => [{ opacity: pressed ? 0.7 : 1 }]}
        >
          <View style={styles.charCell}>
            <View style={[styles.charArt, { backgroundColor: color.bg.elevated }]}>
              {c.image ? (
                <Image
                  source={{ uri: c.image }}
                  style={StyleSheet.absoluteFill}
                  contentFit="cover"
                  transition={150}
                  cachePolicy="memory-disk"
                />
              ) : null}
            </View>
            <Text style={[styles.charName, { color: color.text.primary }]} numberOfLines={2}>
              {c.name}
            </Text>
            <Text style={[styles.charRole, { color: color.text.muted }]} numberOfLines={1}>
              {roleLabel(c.role)}
            </Text>
          </View>
        </Pressable>
      ))}

      {/* View all — a quiet dashed-ish card at the end of the strip. */}
      <Pressable
        onPress={() =>
          router.push({
            pathname: '/anime/[id]/characters',
            params: { id: String(animeId), title: animeTitle },
          })
        }
        accessibilityRole="button"
        accessibilityLabel="View all characters"
        style={({ pressed }) => [
          styles.viewAllCard,
          {
            borderColor: color.border.strong,
            backgroundColor: color.bg.surface,
            opacity: pressed ? 0.7 : 1,
          },
        ]}
      >
        <AppIcon name="users" size={18} color={color.text.secondary} />
        <Text style={[styles.viewAllText, { color: color.text.secondary }]}>View all</Text>
      </Pressable>
    </ScrollView>
  );
}

function EmptyState({ message }: { message: string }) {
  const { color } = useTheme();
  return (
    <View style={styles.empty}>
      <Text style={[styles.emptyText, { color: color.text.muted }]}>{message}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl, gap: spacing.lg },
  error: { fontFamily: font.regular, fontSize: 15, textAlign: 'center' },
  retryBtn: {
    paddingHorizontal: spacing.xxl,
    paddingVertical: spacing.md,
    borderRadius: radii.full,
  },
  retryText: { fontFamily: font.semibold, fontSize: 14 },

  // --- banner ---
  bannerWrap: {
    height: BANNER_H,
    backgroundColor: '#0a0a0f',
  },
  back: {
    position: 'absolute',
    left: spacing.lg,
    width: 40,
    height: 40,
    borderRadius: radii.full,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.35)',
  },

  // --- identity (everything centered) ---
  identity: {
    alignItems: 'center',
    marginTop: -(POSTER_W * (3 / 2) * POSTER_OVERLAP),
    paddingHorizontal: spacing.lg,
    gap: spacing.sm,
  },
  posterFrame: {
    padding: 2,
    borderRadius: radii.xl + 2,
  },
  posterWrap: {
    width: POSTER_W,
    aspectRatio: layout.posterRatio,
    borderRadius: radii.xl,
    overflow: 'hidden',
    backgroundColor: '#1a1a22',
  },
  kicker: {
    fontSize: 11,
    lineHeight: 14,
    fontFamily: font.bold,
    letterSpacing: 2,
    textTransform: 'uppercase',
    marginTop: spacing.sm,
  },
  title: {
    fontSize: 24,
    lineHeight: 30,
    fontFamily: font.bold,
    textAlign: 'center',
  },
  // --- synopsis ---
  synopsisWrap: {
    paddingHorizontal: spacing.xl,
    marginTop: spacing.md,
    alignItems: 'center',
  },
  synopsis: {
    fontFamily: font.regular,
    fontSize: 14,
    lineHeight: 21,
    textAlign: 'center',
  },
  readMore: {
    fontFamily: font.semibold,
    fontSize: 13,
    marginTop: spacing.xs,
    textAlign: 'center',
  },

  // --- actions ---
  actions: {
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    marginTop: spacing.lg,
    gap: spacing.md,
  },
  watchBtn: {
    alignSelf: 'stretch',
    height: 50,
    borderRadius: radii.full,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
  },
  watchText: { fontSize: 15, fontFamily: font.bold, letterSpacing: 0.3 },
  iconRow: { flexDirection: 'row', gap: spacing.md },

  // --- next episode card ---
  // Same margins and radius as the details grid (`grid`), so the two blocks
  // stack as a column of cards rather than as two unrelated shapes.
  nextCard: {
    marginHorizontal: spacing.lg,
    marginTop: spacing.xl,
    borderRadius: radii.lg,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.md,
    paddingRight: spacing.lg,
    // `overflow: hidden` so the accent rail is clipped by the rounded corner
    // rather than sitting as a separate bar beside it.
    overflow: 'hidden',
  },
  // 3px, full height, flush to the left edge — the same proportion as the
  // details sections' `headingBar`, so the two marks rhyme.
  nextRail: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: 3,
  },
  nextBadge: {
    width: 30,
    height: 30,
    borderRadius: radii.full,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: spacing.lg,
  },
  nextBody: { flex: 1, minWidth: 0, marginLeft: spacing.md, gap: 1 },
  // Small, wide-tracked, muted — a section label, not a headline.
  nextLabel: {
    fontSize: 10,
    fontFamily: font.bold,
    letterSpacing: 1,
  },
  nextEp: { fontSize: 15, fontFamily: font.semibold, lineHeight: 20 },
  // Tabular so a ticking countdown does not shift the card's contents sideways
  // once a minute. `useNow` re-renders this on every tick, and without it the
  // "EP 7" beside it would jitter as the digit count changes.
  nextWhen: {
    fontSize: 15,
    fontFamily: font.bold,
    fontVariant: ['tabular-nums'],
    marginLeft: spacing.sm,
  },
  roundBtn: {
    width: 46,
    height: 46,
    borderRadius: radii.full,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },

  // --- details grid ---
  grid: {
    marginHorizontal: spacing.lg,
    marginTop: spacing.xl,
    borderRadius: radii.lg,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    flexWrap: 'wrap',
    overflow: 'hidden',
    shadowOpacity: 0.25,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 0 },
    elevation: 8,
  },
  gridGlow: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 120,
  },
  gridHero: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.lg,
    gap: spacing.lg,
  },
  gridRingWrap: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  ringCenter: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ringValue: {
    fontSize: 15,
    lineHeight: 19,
    fontFamily: font.bold,
  },
  gridStats: {
    flex: 1,
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignItems: 'center',
  },
  gridStatBlock: {
    alignItems: 'center',
    gap: 3,
  },
  gridStatBadge: {
    width: 24,
    height: 24,
    borderRadius: radii.full,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 2,
  },
  gridStatValue: {
    fontSize: 17,
    lineHeight: 21,
    fontFamily: font.bold,
  },
  gridStatLabel: {
    fontSize: 10,
    lineHeight: 13,
    fontFamily: font.medium,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  gridCell: {
    width: '50%',
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
    gap: spacing.sm,
  },
  gridCellIcon: {
    width: 24,
    height: 24,
    borderRadius: radii.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  gridCellText: {
    flex: 1,
    gap: 1,
  },
  gridLabel: {
    fontSize: 11,
    lineHeight: 14,
    fontFamily: font.semibold,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  gridValue: {
    fontSize: 13,
    lineHeight: 17,
    fontFamily: font.medium,
  },

  // --- keywords + alt titles ---
  detailsBlock: {
    paddingHorizontal: spacing.lg,
    marginTop: spacing.xl,
    alignItems: 'center',
  },
  detailsSection: {
    alignItems: 'center',
    marginTop: spacing.xl,
    alignSelf: 'stretch',
  },
  detailsHeadingWrap: {
    alignItems: 'center',
    marginBottom: spacing.md,
    gap: 5,
  },
  detailsHeading: {
    fontSize: 12,
    lineHeight: 15,
    fontFamily: font.bold,
    textTransform: 'uppercase',
    letterSpacing: 1.6,
  },
  headingBar: {
    width: 22,
    height: 2,
    borderRadius: 1,
  },
  keywordRailWrap: {
    alignSelf: 'stretch',
    alignItems: 'center',
  },
  keywordRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.xl,
    gap: spacing.sm,
  },
  keywordPill: {
    paddingHorizontal: spacing.md,
    paddingVertical: 5,
    borderRadius: radii.full,
  },
  keywordPillText: {
    fontSize: 12,
    lineHeight: 15,
    fontFamily: font.medium,
  },
  altLine: {
    fontSize: 13,
    lineHeight: 18,
    fontFamily: font.regular,
    textAlign: 'center',
  },
  titleCard: {
    alignSelf: 'stretch',
    marginHorizontal: spacing.lg,
  },
  titleRow: {
    alignSelf: 'stretch',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm + 2,
    gap: 2,
  },
  titleLabel: {
    fontSize: 10,
    lineHeight: 13,
    fontFamily: font.semibold,
    textTransform: 'uppercase',
    letterSpacing: 1,
    textAlign: 'center',
  },
  titleValue: {
    fontSize: 13,
    lineHeight: 19,
    fontFamily: font.medium,
    textAlign: 'center',
  },
  /* Kept for the synopsis's Read more toggle. */

  // --- tabs ---
  tabStrip: {
    marginTop: spacing.xl,
    borderBottomWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
  },
  tabTrack: {
    flexDirection: 'row',
    backgroundColor: 'rgba(128,128,128,0.08)',
    borderRadius: radii.full,
    padding: 3,
    marginBottom: spacing.md,
  },
  tabItem: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm + 2,
    borderRadius: radii.full,
  },
  tabItemText: {
    fontSize: 13.5,
    fontFamily: font.semibold,
  },
  tabIndicator: {
    position: 'absolute',
    top: 3,
    bottom: 3,
    left: 0,
    borderRadius: radii.full,
  },
  tabBody: {
    // Anchor for the entering animation on tab switch.
  },

  // --- episodes ---
  // `flexDirection: row` + `gap` so the search field and the sort button sit side by
  // side, with `searchFieldWrap` taking the remaining width.
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
  },
  // THE WRAPPER IS LOAD-BEARING. `SearchField`'s own `field` style sets a height
  // and no width, because everywhere else it is a child of a COLUMN — where the
  // default `alignItems: 'stretch'` gives it the full width for free. This row is
  // a `row`, so that stretch no longer applies and the field would collapse to
  // its content width (an icon plus a placeholder's worth of nothing), dragging
  // the sort button left with it.
  //
  // `flex: 1` here rather than on `SearchField` itself: as a child of a column,
  // `flex: 1` means `flexBasis: 0` and the field would grow VERTICALLY against
  // its own `height: 42`. Fixing it at the one call site that needs it leaves
  // every other usage exactly as it was.
  searchFieldWrap: {
    flex: 1,
    minWidth: 0,
  },
  // 42px, matching `SearchField`'s own `height` exactly. That is the whole reason
  // for the number: a control a pixel or two shorter or taller than the field
  // beside it reads as two controls that happen to be near each other, and the
  // row's own `alignItems: center` would leave visible dead space above and below
  // one of them. Equal height reads as one toolbar.
  sortBtn: {
    width: 42,
    height: 42,
    // `radii.md` (8) is `SearchField`'s corner radius, so the two share it.
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // A wrapper so the rotation animates as one object rather than the icon's own
  // transform being fought over by AppIcon's sizing styles.
  sortIcon: { width: 20, height: 20, alignItems: 'center', justifyContent: 'center' },
  epCount: {
    alignSelf: 'center',
    paddingTop: spacing.sm,
    fontSize: 12,
    fontFamily: font.medium,
  },
  // Mirrors `EpisodeRow`'s card exactly — same margins, same hairline, same
  // radius — so the swap to real rows changes nothing about the layout.
  epLoading: {
    paddingTop: spacing.xl,
    minHeight: 72,
  },

  // --- characters ---
  charRail: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    gap: spacing.md,
  },
  charCell: { width: 88, alignItems: 'center' },
  charArt: {
    width: 88,
    height: 88,
    borderRadius: radii.full,
    overflow: 'hidden',
  },
  charName: {
    fontSize: 12,
    lineHeight: 15,
    fontFamily: font.semibold,
    marginTop: spacing.sm,
    textAlign: 'center',
  },
  charRole: {
    fontFamily: font.regular,
    fontSize: 11,
    lineHeight: 14,
    textAlign: 'center',
  },
  viewAllCard: {
    width: 88,
    height: 88,
    borderRadius: radii.full,
    borderWidth: StyleSheet.hairlineWidth,
    borderStyle: 'dashed',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  viewAllText: {
    fontSize: 11,
    fontFamily: font.semibold,
  },

  more: {
    margin: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radii.full,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
  },
  moreText: { fontSize: 14, fontFamily: font.semibold },

  // --- page navigation ---
  pageNav: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    marginTop: spacing.md,
    gap: spacing.sm,
  },
  pagePills: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  pageBtn: {
    minWidth: 34,
    height: 34,
    paddingHorizontal: spacing.sm,
    borderRadius: radii.full,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pageBtnText: {
    fontSize: 13,
    lineHeight: 16,
    fontFamily: font.semibold,
  },
  pageGap: {
    fontSize: 13,
    fontFamily: font.semibold,
    paddingHorizontal: 2,
  },

  empty: { padding: spacing.xxxl, alignItems: 'center' },
  emptyText: { fontFamily: font.regular, fontSize: 14, textAlign: 'center' },
});
