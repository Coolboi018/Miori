// ============================================================================
// PARKED — NOT A ROUTE, NOT IMPORTED ANYWHERE. DO NOT EXTEND.
//
// This is the old vertical "watch page", kept verbatim for reference while the
// landscape fullscreen player (`components/player/fullscreen/`, reached through
// `app/watch/[id]/[ep].tsx`) is the live one.
//
// It was moved here out of `app/` on purpose: every file under `app/` is a route
// in expo-router, so leaving it in place would keep it reachable and keep two
// players fighting over the same `/watch/[id]/[ep]` path. Nothing under
// `components/` is a route, so this file is now inert — it still compiles and
// still lints, which is the point of keeping it, but it cannot be navigated to.
//
// Its source-resolution, failover, quality-gather, progress-sync and presence
// logic was reused by the landscape player rather than rewritten. What was NOT
// carried over is the shape of the screen: a scrollable page with a drawer over
// the video, which is what forced the `pageRef.scrollTo({ y: 0 })` before
// opening a sheet and the `scrollEnabled={sheet === null}` lock. A fullscreen
// player has no page to scroll, so that whole class of coordination disappears.
//
// If you are looking for playback behaviour, read the landscape player. If you
// are looking for what the old page did, this is it.
// ============================================================================

// Watch page — vertical, YouTube-style.
//
// ┌──────────────────────────┐
// │ ‹  EP 3 · src 1/2 · 720p │  ← floating over video, auto-hides with controls
// │ ┌──────────────────────┐ │
// │ │       PLAYER         │ │  ← 16:9, pinned at top under the status bar
// │ │            ╭────────╮│ │  ← the drawer covers the video from a layer
// │ │            │ Quality││ │     OUTSIDE the page scroll view, so its
// │ │            ╰────────╯│ │     option list really scrolls
// │ └──────────────────────┘ │
// │ EP 3 · Title of episode  │  ← title block
// │ Anime title · 2024 · 24m │
// │ ◀ Prev  ⤓ Quality  Next ▶│  ← nav pills (playback stays in-player)
// │ ⛁ Source  ♡ Save  ⇪ Share│  ← utility pills (secondary actions)
// │ ┌──────────────────────┐ │
// │ │ (poster) title …     │ │  ← anime card: poster + synopsis + stats grid
// │ │ ★8.4 Format Year Stat│ │
// │ └──────────────────────┘ │
// │ EPISODES      Page 1 of 2│
// │ ┌──────────────────────┐ │
// │ │ [thumb] Ep 1 title   │ │  ← fixed-height box, own scroll, 10 rows max
// │ │ [thumb] Ep 2 title   │ │
// │ └──────────────────────┘ │
// │      ‹ 1 2 … 12 ›        │  ← pager; Kitsu art covers visible page only
// └──────────────────────────┘
//
// REQUEST BUDGET (same contract as the details page): FilmU's episode list is
// cached (1h TTL), and Kitsu artwork is fetched ONLY for the 10 rows on the
// current page — one mapping + up to one page per visible set, debounced,
// gated and cached. Paging through episodes never re-fetches landed pages.
//
// All playback logic (resolve → failover → progress sync → presence) is
// unchanged; this is the layout around it. EpisodeRow is IMPORTED, never
// modified — its design stays owned by the details page.

import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  // Strict TypeScript API (RN 0.88): element refs are instance types.
  type ScrollViewInstance,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { fetchMedia, mediaTitle } from '@/lib/anilist';
import { episodesToShow, releasedCount } from '@/lib/anilist/episodes';
import { getLoadedExtensions, createRegistry, resolveEpisode } from '@/lib/extensions/registry';
import { clearPresence, releasePresence, updatePresence, type PresenceMedia } from '@/lib/presence/discord';
import { openAnime } from '@/lib/nav/pushOnce';
import type { EpisodeInfo, SubtitleTrack, WatchSource } from '@/lib/extensions/types';
import { cueAt, parseVTT, type Cue } from '@/lib/subtitles/vtt';
import { defaultSubtitleStyle } from '@/lib/subtitles/style';
import { listVariants, type HlsVariant } from '@/lib/extensions/hls';
import { getToken } from '@/lib/anilist/auth';
import { useListEntry, useSyncListProgress } from '@/lib/query/listEntries';
import { isSynced, loadPosition, loadPositions, markSynced, savePosition } from '@/lib/progress';
import { useMediaDetail } from '@/lib/query/hooks';
import { useSetting, useSetSetting } from '@/lib/settings/useSetting';
import { applyTuning, tuningFor, tuningKey } from '@/lib/player/tuning';
import { PlayerSheet, type SheetOption, type SheetTab } from '@/components/player/PlayerSheet';
import { SearchField } from '@/components/ui/SearchField';
import { EpisodeRow } from '@/components/anime/EpisodeRow';
import {
  formatLabel,
  minutesToSeconds,
  scoreDisplay,
  statusLabel,
} from '@/components/anime/format';
import {
  kitsuEpisodeVersion,
  mergeKitsuMeta,
  peekKitsuEpisodes,
  resolveKitsuEpisodes,
} from '@/lib/media/kitsuEpisodes';
import { openListSheet } from '@/lib/list/listSheet';
import { useUserId } from '@/lib/auth/session';
import { useTheme } from '@/lib/ui/useTheme';
import { font, radii, spacing } from '@/lib/ui/tokens';
import { AppIcon } from '@/components/ui/AppIcon';
import { SubtitleOverlay } from '@/components/player/SubtitleOverlay';
import { PlayerControls } from '@/components/player/PlayerControls';
import { SeekRipple, RIPPLE_MS, SKIP_SECONDS } from '@/components/player/SeekRipple';

const STALL_MS = 30000;
/** Poster width in the anime card below the buttons. */
const STRIP_POSTER_W = 84;
/** Rows per episode page — matches the details page so caches line up. */
const EP_PER_PAGE = 10;
/**
 * ⚠️ THE EPISODE BOX IS NOT A SCROLL VIEW, AND NOT HAVING A FIXED HEIGHT IS THE
 * POINT. Read this before adding one back.
 *
 * It was a fixed 480pt box holding a `ScrollView`, and on Android a drag on it
 * scrolled the PAGE instead. Three fixes were tried and two of them made it
 * worse; the history is worth keeping because the wrong turn is attractive.
 *
 * `nestedScrollEnabled` was never the answer. On RN 0.86 it maps only to
 * `ViewCompat.setNestedScrollingEnabled`, and a plain ScrollView is not a
 * NestedScrollingParent, so there is nothing to join. The androidx variant that
 * would work sits behind `useNestedScrollViewAndroid()`, which defaults false —
 * and even on, the page's end-of-range hand-off is wrong for a list.
 *
 * Swapping the `FlatList` for a `ScrollView` silenced RN's nesting error and
 * deleted a `scrollToIndex` measure race. It did NOT make it scroll.
 * `scrollEnabled={false}` silences that error too, by turning the box into a
 * non-scroller that clips rows off the bottom — the bug wearing a disguise.
 *
 * The actual defect is the nesting itself. The page already scrolls; a second
 * vertical scroller inside it loses the gesture every time, because
 * `ReactScrollView.onInterceptTouchEvent` is asked on the way DOWN from the
 * root and returns true the moment the drag passes touch slop. The drawer was
 * fixed by moving itself outside the page. This box cannot move outside — it
 * belongs inline, under its own heading — so it takes the other half of that
 * answer: **one scroller per screen.** The box is a plain `View` that grows to
 * its rows, and the page scroll carries them.
 *
 * The height cap was never doing the job it claimed. Its note said it kept
 * "the screen from stretching on long series", but the PAGER already caps a
 * page at `EP_PER_PAGE` — the cap bounded nothing the pager did not, and cost
 * ~200pt of clipped, unreachable rows on a full page. All ten rows are visible
 * now and the page scrolls under them like any other section.
 *
 * Kitsu art is still fetched per visible page only — see the module note in
 * `lib/media/kitsuEpisodes.ts`.
 */
/** Same debounce as details: collapses fast page taps into one Kitsu call. */
const EP_KITSU_DEBOUNCE_MS = 200;
/**
 * The video's aspect ratio. Used TWICE on this screen, and they must not drift:
 * `videoWrap` lays the player out with it, and `sheetLayer` (the box the player
 * drawer is mounted into, see the note by its render) is sized from it so the
 * drawer covers exactly the video and not one pixel more.
 */
const VIDEO_RATIO = 16 / 9;

/**
 * ⚠️ DOUBLE-TAP SEEK WINDOW, AND WHY IT IS NOT IN PlayerControls.
 *
 * Two taps inside this window, within `TAP_SLOP` of each other, are one
 * double-tap: left half of the video rewinds, right half fast-forwards. YouTube's
 * gesture, on the video surface rather than in the control chrome — see the
 * header note in `components/player/SeekRipple.tsx` for why a ±10s BUTTON would
 * be the wrong shape for this app.
 *
 * 300ms is the usual double-tap window and is deliberately at the TOP of the
 * comfortable range: a larger window makes the gesture easier to hit but makes
 * the single-tap control toggle feel broken, since that toggle is now deferred
 * by this much (see `onVideoTap`). Below ~250ms it starts missing real double
 * taps on a laggy device.
 */
const DOUBLE_TAP_MS = 300;

/**
 * How far two taps may drift and still pair as a double-tap, in points.
 * Roughly a fingertip's width — the two taps of a deliberate double-tap land
 * within a few points of each other, while two taps a short time apart in
 * unrelated places are just two taps. This is what stops a tap on the left
 * followed by a tap on the right (both inside the window) from being read as a
 * double-tap and seeking to the wrong side.
 */
const TAP_SLOP = 48;

/** 1-based page holding episode `n` in an ascending 10-per-page list. */
function pageFor(n: number): number {
  return Math.max(1, Math.ceil(n / EP_PER_PAGE));
}

export default function WatchScreen() {
  const { id, ep } = useLocalSearchParams<{ id: string; ep: string }>();
  const router = useRouter();
  const animeId = Number(id);
  const epNum = Number(ep);
  const { color } = useTheme();
  const insets = useSafeAreaInsets();
  const { width: windowWidth } = useWindowDimensions();
  const mediaQuery = useMediaDetail(animeId);
  const media = mediaQuery.data;

  const [sources, setSources] = useState<WatchSource[]>([]);
  const [srcIndex, setSrcIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [tracks, setTracks] = useState<SubtitleTrack[]>([]);
  const [trackIndex, setTrackIndex] = useState(0);
  const [cues, setCues] = useState<Cue[]>([]);
  const [time, setTime] = useState(0);
  const [totalEps, setTotalEps] = useState(0);
  /**
   * Highest episode number that can actually be played, and the ONE number the
   * navigation uses. Without it, "Next" and auto-advance walked straight off the
   * end of what exists into an episode with no stream behind it — the ghost rows
   * were visible, but this was the part that produced an error card.
   *
   * `|| totalEps` covers the window before AniList lands: `releasedCount` answers
   * 0 with no media, and 0 must not read as "nothing is playable".
   */
  const playableCount = releasedCount(media) || totalEps;
  /**
   * Episode-hop availability, in ONE place.
   *
   * The in-player transport buttons and the pills below the title are the same
   * two actions, and they were computing this separately — so the player could
   * offer "Next" on an episode the pill had already greyed out, or vice versa
   * depending on which one re-rendered first. One definition, two surfaces.
   *
   * `playableCount !== 0` guards the upper bound only: while the count is
   * unknown (AniList still in flight, so `releasedCount` reads 0) "next" stays
   * ENABLED. Showing a dead button for a few hundred milliseconds because the
   * metadata had not landed is worse than briefly offering a hop that resolves.
   */
  const canGoPrev = epNum > 1;
  const canGoNext = playableCount === 0 || epNum < playableCount;
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [showControls, setShowControls] = useState(true);
  // Quality model: each source (server) has its OWN master playlist with its
  // OWN quality list — that is why an episode could show only 720p: the
  // variants were only ever listed for the ACTIVE source. Now the variants of
  // every source are gathered, and picking a quality from another source
  // switches sources first. `qSel === null` means Auto (ABR on the master).
  const [variantsBySource, setVariantsBySource] = useState<Record<number, HlsVariant[]>>({});
  const [qSel, setQSel] = useState<{ src: number; v: number } | null>(null);
  const [abrLabel, setAbrLabel] = useState<string | null>(null);
  // Mirrors for the source-load effect, which must read the locked quality
  // WITHOUT depending on it (a dep here would re-resolve on every picker tap).
  const qSelRef = useRef<{ src: number; v: number } | null>(null);
  qSelRef.current = qSel;
  // Stashed currentTime for a quality swap: the picker writes it just before
  // forcing the reload, and the source-load effect turns it into a
  // pendingSeek so the position survives the media replace.
  const qSeekRef = useRef<number | null>(null);
  // Bumped by the picker to force a reload of the SAME source index (Auto, or
  // a variant owned by the current source). A pick on another source instead
  // changes srcIndex, which re-runs the effect on its own.
  const [reloadNonce, setReloadNonce] = useState(0);
  // Flips on after the first gather pass, so the picker can show a loading
  // row before the quality list arrives.
  const [variantsLoaded, setVariantsLoaded] = useState(false);
  // Mirrors + in-flight guard for the prefetch below: a ref so the gather
  // stays a []-dep callback and the picker's open-press can retry it safely.
  const variantsLoadedRef = useRef(false);
  variantsLoadedRef.current = variantsLoaded;
  const gatheringRef = useRef(false);
  const varsRef = useRef<Record<number, HlsVariant[]>>({});
  varsRef.current = variantsBySource;
  const [episodes, setEpisodes] = useState<EpisodeInfo[]>([]);
  /**
   * Current episode-list page, initialised to the page HOLDING this episode —
   * opening EP 47 must not land the box on page 1. Reset on episode change
   * (same effect below that reloads sources).
   */
  const [epPage, setEpPage] = useState(() => pageFor(Number(ep) || 1));
  /**
   * Kitsu artwork version, same pattern as the details page: the metadata map
   * is module-level and mutated in place, so this counter is what re-runs the
   * merge memo when a page lands. No extra requests beyond the visible page.
   */
  const [kitsuVersion, setKitsuVersion] = useState(0);
  /** Local watch positions for the progress bars on the cards (no network). */
  const [positions, setPositions] = useState<Record<number, number>>({});
  const [saved, setSaved] = useState(false);
  /** Episode-number search inside the box; pager + Kitsu follow the matches. */
  const [query, setQuery] = useState('');
  /** Expanded synopsis in the anime card (`read more`). */
  const [synExpanded, setSynExpanded] = useState(false);
  const [speed, setSpeed] = useState(1);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Which settings-sheet panel is open, if any. Rendered over the video by
   *  `PlayerSheet`, and non-null also means the page is scrolled to the player
   *  and its own scrolling is off. */
  const [sheet, setSheet] = useState<SheetTab>(null);
  /** The page scroll view — parked at the player whenever a panel opens. */
  const pageRef = useRef<ScrollViewInstance | null>(null);

  const sought = useRef(false);
  const timelineSent = useRef(false);
  const pendingSeek = useRef<number | null>(null);
  const loadingSince = useRef(0);
  const lastSaved = useRef(0);
  const attempts = useRef(0);
  const tokenRef = useRef<string | null>(null);
  const progressSynced = useRef(false);
  const syncCooldownUntil = useRef(0);
  /**
   * HAS THIS EPISODE ACTUALLY PLAYED ANYTHING?
   *
   * The witness `playToEnd` needs before it is allowed to advance. An episode
   * reaching its end and a media item DYING at t≈0 both arrive as `playToEnd`,
   * and only one of them means "watch this one next". A stream that fails to
   * load, an empty HLS playlist, or a signed CDN URL that has already expired
   * all end the item immediately — and because the old handler advanced
   * unconditionally, one bad source walked the entire show in seconds:
   * ep 1 resolving, then 2, then 3, up to the last. That is the report.
   *
   * Set from `timeUpdate`, so it is evidence rather than a guess about why the
   * player stopped. Reset per episode AND per source: a failover that lands on
   * a working source must be able to play again, and an episode that played for
   * a while and then died should still advance rather than loop on failover.
   */
  const playedRef = useRef(false);
  const [syncNote, setSyncNote] = useState<string | null>(null);

  // Player engine/buffer — the tuning profile the player runs under.
  // `useSetting` subscribes the screen; the values flow through tuningFor().
  //
  // `player.decode` USED to be read here. It is gone: SDK 57's
  // `PlayerBuilderOptions` carries only the two seek increments, so Hardware,
  // Software and Auto all produced a byte-identical `PlayerTuning`. This screen
  // is parked, but it still has to compile, and the day it is deleted this line
  // should not be the reason anyone looks at it.
  const engine = useSetting('player.engine');
  const buffer = useSetting('player.buffer');
  // Derived ONCE per change: bufferOptions is written at player creation and
  // again in an effect when this key changes; surfaceType must not change at
  // runtime, so the VideoView is keyed on this string and remounts instead.
  const tuning = useMemo(() => tuningFor(engine, buffer), [engine, buffer]);
  const tuningId = tuningKey(tuning);

  /**
   * The AniList write for a finished episode. Destructured to `mutateAsync`
   * because that is the one member react-query guarantees to be referentially
   * stable for the life of the observer — this effect re-subscribes on every
   * dependency change.
   */
  const { mutateAsync: syncProgress } = useSyncListProgress(animeId);

  /**
   * Save-button state, subscribed to the SAME cached entry the details page
   * and the shared sheet read — no new request when warm, correct icon on
   * first paint after a revisit. See `app/anime/[id].tsx` for why this is a
   * subscription and not a mount-time read.
   */
  const userId = useUserId();
  const signedIn = userId != null;
  const sessionKnown = userId !== undefined;
  const { entry, loading: entryLoading } = useListEntry(animeId, signedIn && sessionKnown);

  useEffect(() => {
    if (entry !== undefined) setSaved(entry != null);
  }, [entry]);

  const indexRef = useRef(0);
  indexRef.current = srcIndex;
  const sourcesRef = useRef<WatchSource[]>([]);
  sourcesRef.current = sources;

  const player = useVideoPlayer(null, (p) => {
    p.timeUpdateEventInterval = 0.5;
    // Buffer options are read when the pipeline attaches media — set them
    // before the first source lands. Re-applied on tuning changes below.
    applyTuning(p, tuningFor());
  });

  const load = useCallback(async () => {
    setError(null);
    progressSynced.current = await isSynced(animeId, epNum);
    syncCooldownUntil.current = 0;
    try {
      const m = await fetchMedia(animeId);
      setTotalEps(m.episodes ?? 0);
      const title = mediaTitle(m.title);
      presenceTitle.current = title;
      presenceMedia.current = {
        artKey: `a${animeId}e${epNum}`,
        artUrl: '',
        pageUrl: `https://anilist.co/anime/${animeId}`,
      };
      updatePresence(title, epNum, presenceMedia.current);
      const _reg = createRegistry();
      if (!_reg.length) throw new Error('No sources installed.');
      const r = await resolveEpisode(_reg, animeId, epNum, m.idMal ?? null, {
        titles: [m.title?.romaji, m.title?.english].filter(
          (t): t is string => !!t && t.length >= 3
        ),
      });
      setSources(r.sources);
      setSrcIndex(0);
      // Fresh urls → the previous variant picks are stale.
      qSelRef.current = null;
      setQSel(null);
      setVariantsBySource({});
      setVariantsLoaded(false);
      variantsLoadedRef.current = false;
      gatheringRef.current = false;
      try {
        const filmuExt = getLoadedExtensions().find((e) => e.id === 'filmu');
        const eps = filmuExt ? await filmuExt.episodes(animeId) : [];
        const poster = eps.find((e) => e.number === epNum)?.poster ?? '';
        presenceMedia.current = { ...presenceMedia.current, artUrl: poster };
        updatePresence(title, epNum, presenceMedia.current);
      } catch {
        /* no episode art — text presence still works */
      }
    } catch (e: any) {
      setError(String(e?.message ?? e));
    }
    // THE SESSION ONLY. Nothing is written to AniList on the way in any more —
    // the 82% sync below is the only writer.
    try {
      tokenRef.current = await getToken();
    } catch {
      tokenRef.current = null;
    }
  }, [animeId, epNum]);

  const failover = useCallback(() => {
    attempts.current += 1;
    // A locked quality belonged to the source that just failed — drop it so
    // the hop plays the next source's master instead of a dead variant.
    qSelRef.current = null;
    setQSel(null);
    const i = indexRef.current;
    if (i + 1 < sourcesRef.current.length) {
      setSrcIndex(i + 1);
    } else if (attempts.current > 10) {
      setError('All sources failed repeatedly. Reopen the episode to retry.');
    } else {
      // Exhausted the list: fresh signed urls, try again.
      load();
    }
  }, [load]);

  const playingRef = useRef(false);
  const showRef = useRef(true);
  const presenceTitle = useRef('');
  const presenceMedia = useRef<PresenceMedia | undefined>(undefined);
  // Episode-to-episode navigation unmounts this screen too (router.replace),
  // and the next episode re-asserts presence immediately — so only release
  // the Watching status when we are actually leaving the player.
  const switchingEpisode = useRef(false);

  const goToEpisode = useCallback(
    (n: number) => {
      switchingEpisode.current = true;
      router.replace({
        pathname: '/watch/[id]/[ep]',
        params: { id: String(animeId), ep: String(n) },
      });
    },
    [router, animeId]
  );

  const hideControls = useCallback(() => {
    if (playingRef.current) {
      showRef.current = false;
      setShowControls(false);
    }
  }, []);

  const pushPresence = useCallback(
    (isPlaying: boolean) => {
      if (!presenceTitle.current) return;
      updatePresence(presenceTitle.current, epNum, presenceMedia.current, {
        isPlaying,
        positionSec: player.currentTime,
        durationSec: player.duration || 0,
      });
    },
    [player, epNum]
  );

  /**
   * (Re)arm the auto-hide countdown. Kept SEPARATE from `pokeControls` on
   * purpose — see the note on the `playingChange` listener. Conflating the two
   * is what let a seek summon the control chrome.
   *
   * `pokeControls` is the ONLY thing that ever shows the chrome, and it is
   * reached exclusively from real user intent (play/pause, scrub, sheet close,
   * tap). This one only starts the clock on something already visible.
   */
  const armHide = useCallback(() => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(hideControls, 3000);
  }, [hideControls]);

  const pokeControls = useCallback(() => {
    showRef.current = true;
    setShowControls(true);
    armHide();
  }, [armHide]);

  const toggleControls = useCallback(() => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    if (showRef.current) {
      showRef.current = false;
      setShowControls(false);
    } else {
      pokeControls();
    }
  }, [pokeControls]);

  /**
   * DOUBLE-TAP SEEK — YouTube's gesture: tap the left half to go back 10s, the
   * right half to go forward, and the controls stay exactly as they were. It is
   * a GESTURE, so it deliberately does not summon the control chrome: the whole
   * point is to nudge the position while watching without the layer appearing
   * over the frame. Only the ripple lands.
   *
   * WHY THE LEFT/RIGHT SPLIT IS HALF-AND-HALF AND NOT THIRDS. YouTube's desktop
   * player leaves the middle third inert so a double-tap there cannot be
   * mistaken for a seek, but this is a phone held in one hand: thumbs land in
   * the lower corners far more often than dead centre, and a dead middle third
   * is the one zone a thumb is most likely to hit by accident. Half-and-half
   * matches what YouTube's own mobile app does.
   *
   * WHY THE SINGLE TAP IS DEFERRED BY `DOUBLE_TAP_MS`. The two are
   * indistinguishable until the second tap either arrives or does not, so the
   * single-tap toggle has to wait out the window. This is the cost of the
   * gesture and it is the same trade YouTube makes; a tap that feels ~0.3s
   * sluggish to summon controls is a far smaller cost than a 10s seek the user
   * did not mean to make.
   *
   * Scrolling is not a hazard here and needs no guard: a swipe moves the touch
   * off this surface, so the responder is terminated and `onPress` never fires.
   * What `TAP_SLOP` does buy is refusing to pair two taps that land in
   * unrelated places — two taps in opposite halves inside the window are two
   * taps, not one double-tap, and resolving those by the first tap's side would
   * seek when the user meant the second one's.
   *
   * The ripple is keyed on `tapSeq` so React remounts it per tap; reusing one
   * mounted instance would mean re-triggering the animation by hand (a
   * `runOnJS` reset and a frame of stale opacity — see `SeekRipple`).
   */
  const lastTap = useRef({ t: 0, x: 0, y: 0 });
  const singleTapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rippleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [tapSeq, setTapSeq] = useState(0);
  const [ripple, setRipple] = useState<{ dir: -1 | 1; x: number; y: number } | null>(null);

  /** Seek by a fixed step, clamped to the media. See the call site for why the
   *  clamp is not optional: a `currentTime` past the end stops `timeUpdate`
   *  firing, which takes the seekbar, progress saving and the 82% AniList sync
   *  down with it. `duration` is 0 until metadata lands, and in that window
   *  there is no bound to clamp against, so the cap is dropped rather than
   *  guessed. */
  const skipBy = useCallback(
    (delta: number) => {
      const dur = player.duration || 0;
      const next = Math.min(
        Math.max(0, player.currentTime + delta),
        dur > 0 ? dur : Number.POSITIVE_INFINITY
      );
      if (next === player.currentTime) return;
      player.currentTime = next;
      // `time` is what the bottom time readout and the seekbar read; without
      // this they would keep showing the pre-skip position until the next
      // `timeUpdate` tick (up to 0.5s later).
      setTime(next);
      pushPresence(playingRef.current);
    },
    [player, pushPresence]
  );

  const onVideoTap = useCallback(
    (x: number, y: number) => {
      const now = Date.now();
      const prev = lastTap.current;
      const isDouble = now - prev.t < DOUBLE_TAP_MS;
      if (isDouble && Math.abs(x - prev.x) <= TAP_SLOP && Math.abs(y - prev.y) <= TAP_SLOP) {
        if (singleTapTimer.current) clearTimeout(singleTapTimer.current);
        singleTapTimer.current = null;
        lastTap.current = { t: 0, x: 0, y: 0 };
        const dir: -1 | 1 = x < windowWidth / 2 ? -1 : 1;
        skipBy(dir * SKIP_SECONDS);
        setRipple({ dir, x, y });
        setTapSeq((n) => n + 1);
        // Retire the node once it has finished fading. Left mounted it would
        // sit in the tree — invisible, `pointerEvents: none`, harmless — but
        // the point is that it is a receipt for ONE tap, and holding state for a
        // gesture that is long over is how this file ended up with two of them
        // (`lastTap` and the ripple) disagreeing about what "the last tap" was.
        // The timeout is replaced, not stacked, so rapid double-taps retire the
        // LAST ripple rather than clearing an earlier one out from under it.
        if (rippleTimer.current) clearTimeout(rippleTimer.current);
        rippleTimer.current = setTimeout(() => setRipple(null), RIPPLE_MS);
        return;
      }
      lastTap.current = { t: now, x, y };
      if (singleTapTimer.current) clearTimeout(singleTapTimer.current);
      singleTapTimer.current = setTimeout(() => {
        singleTapTimer.current = null;
        toggleControls();
      }, DOUBLE_TAP_MS);
    },
    [windowWidth, skipBy, toggleControls]
  );

  // The pending single tap must not fire into an unmounted screen (episode hop,
  // back, or the screen being torn down) — that would poke a control state on
  // a component that is gone, and on a `router.replace` hop the next episode
  // reuses this screen and would inherit the timer.
  useEffect(
    () => () => {
      if (singleTapTimer.current) clearTimeout(singleTapTimer.current);
      if (rippleTimer.current) clearTimeout(rippleTimer.current);
    },
    []
  );

  // Release the Watching status when leaving the player entirely.
  useEffect(
    () => () => {
      if (!switchingEpisode.current) releasePresence();
    },
    []
  );

  // Re-apply tuning when the user flips an engine/decode/buffer setting. The
  // VideoView remounts via its key (surfaceType is build-time-stable); buffer
  // options can be written live.
  useEffect(() => {
    applyTuning(player, tuning);
  }, [player, tuning, tuningId]);

  // 1. Resolve episode across extensions + the episode rail.
  //
  // `mediaRef` so the fallback can read AniList without this effect depending on
  // it — same shape and same reason as the details page's: a dep there made the
  // effect re-run when AniList landed, and the request already in flight had its
  // result thrown away, so every open paid for two extension requests and used
  // one.
  const mediaRef = useRef(media);
  mediaRef.current = media;

  useEffect(() => {
    setSources([]);
    setSrcIndex(0);
    setError(null);
    attempts.current = 0;
    // A new episode has played nothing yet — see `playedRef`.
    playedRef.current = false;
    // Episode switch (router.replace) reuses this screen: jump the box to the
    // page holding the new episode so the current row is always on screen.
    setEpPage(pageFor(epNum));
    loadPositions(animeId).then((p) => setPositions(p));
    load();
    let live = true;
    (getLoadedExtensions().find((e) => e.id === 'filmu')?.episodes(animeId) ?? Promise.resolve([]))
      .then((eps) => {
        // Keep the FULL info (title/poster) — the box renders EpisodeRow cards
        // and Kitsu decorates them, exactly like the details page. The list is
        // clamped to what has aired downstream, in `merged`.
        if (live) setEpisodes(eps);
      })
      .catch(() => {
        // Left empty on purpose. The list is DERIVED below (`episodesToShow`),
        // which turns "no rows from the source" into AniList's released count
        // whenever the evidence exists — including when AniList arrives after
        // this failure. Generating rows here instead was a race that lost in the
        // common case: the failure arrives first, `releasedCount` reads no media
        // as 0, and nothing ever retried.
      });
    return () => {
      live = false;
    };
  }, [animeId, epNum, load]);

  // 2. Load current source into player.
  useEffect(() => {
    const s = sources[srcIndex];
    if (!s) return;
    sought.current = false;
    timelineSent.current = false;
    // Per SOURCE, not just per episode: a failover onto a fresh CDN has played
    // nothing, so a stream that dies on load must not inherit the credit of the
    // one before it. (See `playedRef` — this is the reset that makes the
    // "played, then died" case advance rather than loop on failover.)
    playedRef.current = false;
    // A quality swap wants the position kept across the media replace, so the
    // picker stashes currentTime in qSeekRef right before triggering this
    // reload. A plain source hop clears it, as before.
    if (qSeekRef.current != null) {
      pendingSeek.current = qSeekRef.current;
      qSeekRef.current = null;
    } else {
      pendingSeek.current = null;
    }
    loadingSince.current = Date.now();
    setTracks(s.subtitles ?? []);
    setTrackIndex(0);
    setCues([]);
    setAbrLabel(null);
    let cancelled = false;
    // If a quality is locked to THIS source, load that variant directly —
    // this is what makes "1080p from source 2" one replace instead of two.
    const sel = qSelRef.current;
    const variantUrl =
      sel && sel.src === srcIndex && sel.v >= 0
        ? varsRef.current[sel.src]?.[sel.v]?.url
        : undefined;
    // contentType must MATCH the container: ExoPlayer trusts an explicit MIME
    // type over the actual bytes, so handing an mp4 'hls' makes the HLS
    // extractor fail on Android. 'auto' lets the player sniff instead — see
    // progress.md, known problem #10.
    player
      .replaceAsync({ uri: variantUrl ?? s.url, headers: s.headers, contentType: 'auto' })
      .then(() => {
        if (!cancelled && sourcesRef.current[indexRef.current]?.url === s.url) {
          // Re-assert speed: a replace is a new media item natively.
          player.playbackRate = speedRef.current;
          player.play();
        }
      })
      .catch(() => {
        if (!cancelled) failover();
      });
    return () => {
      cancelled = true;
    };
  }, [player, sources, srcIndex, reloadNonce, failover]);

  // 3. Player events: resume, progress save, error failover, auto-next.
  useEffect(() => {
    const subs: { remove(): void }[] = [];
    subs.push(
      player.addListener('timeUpdate', (p) => {
        setTime(p.currentTime);
        // The evidence `playToEnd` will be judged against. Half a second is
        // enough to clear a stall and far short of anything a viewer would call
        // having watched something.
        if (p.currentTime > 0.5) playedRef.current = true;
        if (player.duration) setDuration(player.duration);
        if (player.duration && !timelineSent.current) {
          timelineSent.current = true;
          pushPresence(playingRef.current);
        }
        if (p.currentTime - lastSaved.current > 10) {
          lastSaved.current = p.currentTime;
          savePosition(animeId, epNum, p.currentTime);
        }
        // 82% rule: 1 AniList call per episode, fires once.
        const dur = player.duration || 0;
        if (
          !progressSynced.current &&
          tokenRef.current &&
          dur > 0 &&
          Date.now() >= syncCooldownUntil.current
        ) {
          const threshold = totalEps === 1 || dur < 300 ? 0.9 : 0.82;
          if (p.currentTime / dur >= threshold) {
            progressSynced.current = true;
            syncProgress(epNum)
              .then(() => {
                markSynced(animeId, epNum);
                setSyncNote(`EP ${epNum} marked on AniList`);
                setTimeout(() => setSyncNote(null), 3500);
              })
              .catch(() => {
                progressSynced.current = false;
                syncCooldownUntil.current = Date.now() + 60000;
              });
          }
        }
      })
    );
    subs.push(
      player.addListener('statusChange', (p) => {
        if (p.status === 'readyToPlay') {
          loadingSince.current = 0;
          if (pendingSeek.current != null) {
            const t = pendingSeek.current;
            pendingSeek.current = null;
            player.currentTime = t;
          } else if (!sought.current) {
            sought.current = true;
            loadPosition(animeId, epNum).then((pos) => {
              const dur = player.duration || 0;
              if (pos > 10 && (!dur || pos < dur - 30)) player.currentTime = pos;
              pushPresence(playingRef.current);
            });
          }
        }
        if (p.status === 'error') failover();
      })
    );
    subs.push(
      player.addListener('videoTrackChange', (p) => {
        const h = p.videoTrack?.size?.height;
        setAbrLabel(h ? `${h}p` : null);
      })
    );
    subs.push(
      player.addListener('playingChange', (p) => {
        playingRef.current = p.isPlaying;
        setPlaying(p.isPlaying);
        // ⚠️ DELIBERATELY DOES NOT `pokeControls()`. Read before restoring it.
        //
        // It used to reveal the chrome whenever playback became active, which
        // looked right for the play button — except the play button ALREADY
        // pokes explicitly (see `onPlayPause`), so the line was redundant for
        // its only legitimate purpose and actively harmful for everything else.
        //
        // "Playback became active again" is not the same as "the user started
        // playback". A seek re-buffers, and the refill re-fires this event with
        // isPlaying true: on iOS `isPlaying` tracks time-control status, which
        // drops to "waiting" mid-seek and returns to "playing" after. So every
        // double-tap skip summoned the whole control layer — timeline, transport
        // buttons and all — a beat AFTER the seek, undoing the entire point of a
        // gesture that exists to move the playhead without covering the frame.
        //
        // The asymmetry that gave this away: forward skips stayed clean because
        // the target usually lands INSIDE the sliding buffer and no refill
        // happens, while backward skips land BEHIND the playhead where the
        // buffer has already been evicted and a cold segment must be fetched. A
        // time-based suppression was tried first and was the wrong tool — it
        // only works while the refill beats the deadline, so it fails on a slow
        // CDN and would need re-tuning forever.
        //
        // ⚠️ `armHide()` HERE IS NOT OPTIONAL — REMOVING IT BREAKS THE PLAYER.
        // This listener is what starts the auto-hide countdown when playback
        // begins, because `armHide` is called from nowhere else on load. When
        // the call was replaced with nothing, the chrome had `showControls`
        // true from state and NO timer ever armed, so it never faded: it sat on
        // the video permanently, its centered transport row and top/bottom bars
        // swallowed the double-taps meant for the video surface (so seeking
        // "stopped working"), and the strays that did land popped the overlay
        // back up. Arming the clock is what makes the chrome get OUT of the way
        // — which is what the seek needed all along, rather than suppressing
        // the reveal. Nothing here shows the controls; `pokeControls` still
        // only runs from real user intent.
        if (p.isPlaying) armHide();
        pushPresence(p.isPlaying);
      })
    );
    subs.push(
      player.addListener('playToEnd', () => {
        // ⚠️ ADVANCE ONLY IF IT ACTUALLY PLAYED. See `playedRef`. A media item
        // that dies at t≈0 is a FAILED SOURCE, not a finished episode, and
        // treating it as the end is what made one dead URL walk the whole show:
        // resolve ep 1, then 2, then 3, to the last, in a couple of seconds.
        // `failover()` hops to the next CDN and is a no-op once the list is
        // exhausted, which is the correct place for a stream that never started.
        if (!playedRef.current) {
          failover();
          return;
        }
        playedRef.current = false;
        savePosition(animeId, epNum, 0);
        // `playableCount`, not the season total: on a still-airing show the last
        // released episode is the end, and auto-advancing past it used to land on
        // an episode with nothing behind it and raise the error card.
        if (epNum < playableCount) {
          goToEpisode(epNum + 1);
        } else {
          clearPresence();
        }
      })
    );
    // Stall watchdog: hop CDN if nothing plays for ~30s.
    const timer = setInterval(() => {
      if (
        loadingSince.current &&
        Date.now() - loadingSince.current > STALL_MS &&
        player.status === 'loading'
      ) {
        loadingSince.current = 0;
        failover();
      }
    }, 5000);
    return () => {
      subs.forEach((s) => s.remove());
      clearInterval(timer);
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, [
    player,
    animeId,
    epNum,
    totalEps,
    playableCount,
    goToEpisode,
    failover,
    armHide,
    pushPresence,
    syncProgress,
  ]);

  // 4. Subtitle track -> cues.
  useEffect(() => {
    const t = tracks[trackIndex];
    if (!t) {
      setCues([]);
      return;
    }
    let live = true;
    if (t) {
      fetch(t.url, { headers: t.headers })
        .then((r) => {
          if (!r.ok) throw new Error(`sub HTTP ${r.status}`);
          return r.text();
        })
        .then((txt) => {
          if (live) setCues(parseVTT(txt));
        })
        .catch(() => {
          if (live) setCues([]);
        });
    }
    return () => {
      live = false;
    };
  }, [tracks, trackIndex]);

  // Cross-source quality gather: every source (server) is its own master
  // playlist with its OWN quality list — gathering them all is the fix for
  // the "only one quality shows up" problem. listVariants is a plain GET of
  // the master, so all sources are probed in parallel and a failure just
  // leaves that source out of the picker instead of breaking the page.
  // Idempotent: the prefetch (below) and the picker's open-press both call
  // it, and only a failed prefetch is allowed to run again.
  const gatherVariants = useCallback(async () => {
    if (gatheringRef.current || variantsLoadedRef.current) return;
    gatheringRef.current = true;
    try {
      const results = await Promise.all(
        sourcesRef.current.map((s) => listVariants(s.url, s.headers ?? {}).catch(() => [] as HlsVariant[]))
      );
      const by: Record<number, HlsVariant[]> = {};
      results.forEach((v, i) => {
        if (v.length) by[i] = v;
      });
      setVariantsBySource(by);
      variantsLoadedRef.current = true;
      setVariantsLoaded(true);
    } finally {
      gatheringRef.current = false;
    }
  }, []);

  // Prefetch the moment sources land, not on the first picker open — the
  // picker then opens with the full merged list already in hand instead of
  // a loading row. A prefetch that fails (slow CDN) is retried by the
  // on-open call, which is why the guard passes only on success.
  useEffect(() => {
    if (sources.length > 0) gatherVariants();
  }, [sources, gatherVariants]);

  /** Open a drawer panel — the ONE way in, from the top-bar chips and from the
   *  quality/source pills alike.
   *
   *  The page goes back to the player first. The drawer lives in a fixed layer
   *  over the video (see `sheetLayer`) and the page is frozen for as long as it
   *  is open, so the video has to BE there when the panel animates in: tapping
   *  "Quality" on the pill row — which is a couple of hundred points below the
   *  video — would otherwise strand the panel at the top of the screen with the
   *  video scrolled out from under it. It costs nothing when the page is
   *  already at the top, which is where the top-bar chips open it from.
   */
  const openSheet = useCallback(
    (tab: Exclude<SheetTab, null>) => {
      pageRef.current?.scrollTo({ y: 0, animated: true });
      setSheet(tab);
      // The prefetch usually filled this already; this call retries a failed
      // prefetch so the picker never stalls on its loading row.
      if (tab === 'quality') gatherVariants();
      if (hideTimer.current) clearTimeout(hideTimer.current);
    },
    [gatherVariants]
  );

  /** Lock a quality, or `null` to go back to Auto. If the variant belongs to
   *  a different source, switch sources first — the source-load effect reads
   *  the pick through qSelRef and loads that variant directly. */
  const switchQuality = useCallback(
    (entry: { src: number; v: number } | null) => {
      // Keep the playback position across the upcoming replace.
      qSeekRef.current = player.currentTime;
      qSelRef.current = entry;
      setQSel(entry);
      if (entry && entry.src !== indexRef.current) {
        setSrcIndex(entry.src); // the load effect picks it up via srcIndex
      } else {
        // Same source (or Auto): bump the nonce so the load effect re-runs
        // for this index and swaps master↔variant.
        setReloadNonce((n) => n + 1);
      }
      // Speed needs no re-assert here: the load path re-applies
      // playbackRate after the replace by itself.
    },
    [player]
  );

  /** One entry per DISTINCT quality across all sources, preferring the
   *  variant owned by the active source so picking it needs no source swap. */
  const mergedQualities = useMemo(() => {
    const byLabel = new Map<
      string,
      { label: string; src: number; v: number; own: boolean; h: number; srcLabel: string }
    >();
    for (let si = 0; si < sources.length; si++) {
      const list = variantsBySource[si];
      if (!list?.length) continue;
      list.forEach((v, vi) => {
        const own = si === srcIndex;
        const cur = byLabel.get(v.label);
        if (!cur || (own && !cur.own)) {
          const h = v.height ?? Number(/^(\d+)p/.exec(v.label)?.[1] ?? 0);
          byLabel.set(v.label, {
            label: v.label,
            src: si,
            v: vi,
            own,
            h,
            // Name the PROVIDER owning the variant, not its index — the row
            // then reads like the source list, e.g. "1080p — HD-2".
            srcLabel: sources[si]?.quality || `src ${si + 1}`,
          });
        }
      });
    }
    return Array.from(byLabel.values()).sort((a, b) => b.h - a.h);
  }, [variantsBySource, sources, srcIndex]);

  const qLabel = useMemo(() => {
    if (qSel) {
      const l = variantsBySource[qSel.src]?.[qSel.v]?.label;
      if (l) return l;
    }
    return abrLabel ? `Auto · ${abrLabel}` : 'Auto';
  }, [qSel, variantsBySource, abrLabel]);

  /** Pick the English track by default: label or lang matching 'en', else index 0. */
  const defaultTrackIndex = useMemo(() => {
    const en = tracks.findIndex(
      (t) => t.lang?.toLowerCase().startsWith('en') || /english|eng\b/i.test(t.label)
    );
    return en >= 0 ? en : 0;
  }, [tracks]);

  // Apply the English default ONCE per source load. The source effect resets
  // trackIndex to 0; this effect corrects it the moment the tracks land, so
  // English subs are the default on every source without user action.
  useEffect(() => {
    if (tracks.length > 0) setTrackIndex(defaultTrackIndex);
  }, [tracks, defaultTrackIndex]);

  // Speed applies to the player whenever it changes.
  //
  // `speedRef` as well as the effect, because a `replaceAsync` is a NEW media
  // item on the native side and the playback rate is not guaranteed to carry
  // across it — the ref lets the source-load path re-assert the current speed
  // without putting `speed` in that effect's deps (which would re-resolve the
  // episode on every speed tap).
  const speedRef = useRef(1);
  speedRef.current = speed;
  useEffect(() => {
    player.playbackRate = speed;
  }, [player, speed]);

  /** Options for the in-player settings sheet, per tab. */
  const sheetOptions = useMemo(() => {
    // Quality rows come from the cross-source gather: Auto plus one row per
    // distinct height, annotated with the source that owns it when that is
    // not the one currently playing.
    const quality: SheetOption[] = variantsLoaded
      ? [
          { key: 'auto', label: `Auto${abrLabel ? ` (${abrLabel})` : ''}` },
          ...mergedQualities.map((m) => ({
            key: `${m.src}:${m.v}`,
            label: m.own ? m.label : `${m.label} — ${m.srcLabel}`,
          })),
        ]
      : [
          { key: 'auto', label: `Auto${abrLabel ? ` (${abrLabel})` : ''}` },
          { key: '__loading', label: 'Loading qualities…', disabled: true },
        ];
    const source: SheetOption[] = sources.map((s, i) => ({
      key: String(i),
      label: s.quality ? `${s.quality} — source ${i + 1}` : `Source ${i + 1}`,
      hint: i === srcIndex ? 'playing' : undefined,
    }));
    const subs: SheetOption[] =
      tracks.length > 0
        ? [
            { key: 'off', label: 'Off' },
            ...tracks.map((t, i) => ({ key: String(i), label: t.label || `Track ${i + 1}` })),
          ]
        : [{ key: 'off', label: 'Off', disabled: true }];
    return { quality, source, subs };
  }, [variantsLoaded, mergedQualities, abrLabel, sources, srcIndex, tracks]);

  const sheetSelected = useMemo(
    () => ({
      quality: qSel ? `${qSel.src}:${qSel.v}` : 'auto',
      source: String(srcIndex),
      subs: tracks.length > 0 ? String(trackIndex) : 'off',
      speed: String(speed),
    }),
    [qSel, srcIndex, tracks, trackIndex, speed]
  );

  /** One handler for every sheet pick, dispatched by tab. */
  const handleSheetSelect = useCallback(
    (tab: Exclude<SheetTab, null>, key: string) => {
      if (tab === 'quality') {
        // Keys are `${src}:${variantIdx}` (built in sheetOptions); 'auto'
        // unlocks ABR, '__loading' is the placeholder row.
        if (key === 'auto') {
          if (qSel) switchQuality(null);
        } else if (key !== '__loading') {
          const [srcI, vI] = key.split(':').map(Number);
          const entry = { src: srcI, v: vI };
          if (!qSel || qSel.src !== entry.src || qSel.v !== entry.v) {
            switchQuality(entry);
          }
        }
      } else if (tab === 'source') {
        const i = Number(key);
        if (i !== srcIndex) {
          // A manual source hop abandons the quality lock — it pointed at a
          // variant of the OLD source, and keeping it would leave the pill
          // claiming a quality the new source never loaded.
          qSelRef.current = null;
          setQSel(null);
          setSrcIndex(i);
        }
      } else if (tab === 'subs') {
        // 'off' renders the overlay with no cue; the overlay is the only
        // subtitle surface, so an empty cue list IS "subtitles off".
        if (key === 'off') {
          setCues([]);
          setTrackIndex(-1);
        } else {
          setTrackIndex(Number(key));
        }
      } else if (tab === 'speed') {
        setSpeed(Number(key));
      }
      setSheet(null);
    },
    [qSel, srcIndex, switchQuality]
  );

  const src = sources[srcIndex];
  const cue = cueAt(cues, time);
  const skip =
    src?.intro?.start != null && src.intro?.end != null && time >= src.intro.start && time <= src.intro.end
      ? { label: 'Skip intro', to: src.intro.end }
      : src?.outro?.start != null && src.outro?.end != null && time >= src.outro.start && time <= src.outro.end
        ? { label: 'Skip outro', to: src.outro.end }
        : null;

  const animeTitle = media ? mediaTitle(media.title) : '';
  const poster = media?.coverImage?.extraLarge ?? media?.coverImage?.large ?? null;
  /** Per-episode runtime in seconds for the card badges (AniList stores minutes). */
  const perEp = minutesToSeconds(media?.duration);
  /**
   * Height of the player box, from the window width and the same ratio the box
   * itself is laid out with. The drawer is mounted into a sibling of this box
   * (below), and it has to cover the video exactly — hence one ratio, two uses.
   */
  const videoH = windowWidth / VIDEO_RATIO;

  /**
   * The rows the box shows: the source's list clamped to what has aired, or
   * AniList's released count when the source gave nothing, then decorated with
   * Kitsu art — merged last, so Kitsu can only ever decorate rows that survived,
   * exactly as on the details page.
   *
   * The clamp is the whole reason this screen showed a season of ghosts. FilmU
   * lists the SEASON TOTAL: live on an airing title with 1 of 12 out it returned
   * 12 rows, 11 of them with no poster, no description and no title — rendered
   * as bare `Episode N` chips that cannot be played. `nextAiringEpisode` is
   * AniList's own answer to "how many exist yet", it is already on the `media`
   * this screen holds, and it costs no request. See `lib/anilist/episodes`.
   *
   * `void kitsuVersion` is load-bearing: the map is mutated in place, so the
   * counter is the only thing that re-runs this memo when a page lands.
   */
  const merged = useMemo(() => {
    void kitsuVersion;
    const shown = episodesToShow(episodes, media);
    return mergeKitsuMeta(shown, peekKitsuEpisodes(animeId));
  }, [episodes, animeId, kitsuVersion, media]);

  // Episode-box sort: the SAME global preference the details page reads, so
  // flipping it here flips it there too — one setting, no new systems.
  const epOrder = useSetting('episodes.order');
  const setSetting = useSetSetting();

  /**
   * Number-based search, same semantics as details: digits match any episode
   * number containing them ("1" → 1, 10-19, 21…), other text matches titles.
   * Sort applies AFTER filtering, paging slices last.
   */
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return merged;
    const digits = q.replace(/[^0-9]/g, '');
    if (digits) {
      return merged.filter((e) => String(e.number).includes(digits));
    }
    return merged.filter((e) => (e.title ?? '').toLowerCase().includes(q));
  }, [merged, query]);

  const ordered = useMemo(
    () => (epOrder === 'desc' ? filtered.slice().reverse() : filtered),
    [filtered, epOrder]
  );

  const pageCount = Math.max(1, Math.ceil(ordered.length / EP_PER_PAGE));
  const safePage = Math.min(epPage, pageCount);
  const paged = useMemo(
    () => ordered.slice((safePage - 1) * EP_PER_PAGE, safePage * EP_PER_PAGE),
    [ordered, safePage]
  );

  /** Current episode's display title for the title block (hero line). */
  const currentEpTitle =
    merged.find((e) => e.number === epNum)?.title || `Episode ${epNum}`;

  /**
   * The episodes CURRENTLY IN THE BOX, as a stable primitive — the ONLY thing
   * Kitsu is ever asked about. A joined string (not the array) so the effect
   * below fires on set changes, not on every render's fresh array identity.
   */
  const visibleNums = useMemo(
    () => paged.map((e) => e.number).sort((a, b) => a - b).join(','),
    [paged]
  );

  /**
   * Kitsu fill-in for the visible page. Debounced (pager taps collapse into one
   * call); the module's in-flight guard + fetched-page cache make repeats free.
   * No cleanup-guard discard: a late page still belongs in the cache.
   */
  useEffect(() => {
    if (!visibleNums) return;
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
   * The playing episode is brought into view on the PAGE, not in the box.
   *
   * The box is a plain `View` now (see the note at the top of this file), so it
   * has no `scrollTo` of its own and the page is the only scroller on the
   * screen. That makes the target a SUM: the row's offset is measured from the
   * box, and the box's offset from the page, so the row's position in the
   * scroll content is `boxY + rowY`. Neither number is a guess and neither is
   * timed.
   *
   * WHY IT IS RACE-FREE WITHOUT A TIMER. The old box was a `FlatList`, so this
   * was `scrollToIndex` behind a 60ms timer and a try/catch — it threw
   * whenever the row had not been measured yet, which is most of the time, and
   * the catch is why the reveal sometimes just silently did not happen. Each
   * row now reports its own offset from its own `onLayout`, and the box reports
   * its own from its own, and `onLayout` fires children-first — so whichever
   * callback lands last completes the sum. `reveal.current` is cleared ONLY on
   * success, so a call that arrives half-measured leaves the request standing
   * for the other half to finish.
   *
   * `boxY` is deliberately NOT reset when the page or sort changes. The box sits
   * below the player, title, action pills, anime strip and its own heading, none
   * of which move when the episode page does, so its offset in the page is
   * stable — and a `View` whose height does not change on a re-render is not
   * guaranteed to fire `onLayout` again, so clearing it would risk a reveal
   * that can never complete. Row offsets DO move, so those are cleared.
   */
  /** The box's offset inside the page's scroll content, from its own onLayout. */
  const boxY = useRef<number | null>(null);
  /** Episode number → its offset inside the box, from each row's onLayout. */
  const rowY = useRef<Record<number, number>>({});
  /** Episode number still waiting for a measurement before it can be shown. */
  const reveal = useRef<number | null>(null);
  const revealEpisode = useCallback((n: number) => {
    const row = rowY.current[n];
    const base = boxY.current;
    // Half-measured is not an error — it is the other onLayout's turn.
    if (row === undefined || base === null) return;
    reveal.current = null;
    pageRef.current?.scrollTo({ y: base + row, animated: false });
  }, []);

  useEffect(() => {
    if (query.trim()) return;
    // Offsets belong to a page AND an order — reversing the list or turning the
    // page moves every row — so stale ones are dropped rather than scrolled to.
    rowY.current = {};
    reveal.current = epNum;
    revealEpisode(epNum);
  }, [epNum, safePage, epOrder, query, revealEpisode]);

  /** Open the SHARED list editor (hosted at the root — same as details).
   *  Named for what it opens: the player drawer below is the OTHER sheet, and
   *  two callbacks with the same name on one screen is how a tap ends up in
   *  the wrong surface. */
  const openListEditor = useCallback(() => {
    if (!media) return;
    openListSheet(media);
  }, [media]);

  const shareAnime = useCallback(() => {
    void Share.share({ message: `${animeTitle}\nhttps://anilist.co/anime/${animeId}` });
  }, [animeTitle, animeId]);

  const actionRow = useMemo(
    () => (
      <View style={styles.actionsRow}>
        <Pressable
          style={[styles.pill, !canGoPrev && styles.pillDisabled]}
          disabled={!canGoPrev}
          onPress={() => goToEpisode(epNum - 1)}
          accessibilityLabel="Previous episode"
        >
          <AppIcon name="back" size={16} color="#fff" />
          <Text style={styles.pillText}>Prev</Text>
        </Pressable>
        <Pressable style={styles.pill} onPress={() => openSheet('quality')} accessibilityLabel="Quality">
          <AppIcon name="quality" size={15} color="#fff" />
          <Text style={styles.pillText} numberOfLines={1}>
            {qLabel}
          </Text>
        </Pressable>
        <Pressable
          style={[styles.pill, !canGoNext && styles.pillDisabled]}
          disabled={!canGoNext}
          onPress={() => goToEpisode(epNum + 1)}
          accessibilityLabel="Next episode"
          accessibilityHint={!canGoNext ? 'Last released episode' : undefined}
        >
          <Text style={styles.pillText}>Next</Text>
          <AppIcon name="chevron" size={16} color="#fff" />
        </Pressable>
      </View>
    ),
    // qLabel is a memo over real inputs; the actionRow memo only rebuilds
    // when those change.
    [epNum, canGoPrev, canGoNext, qLabel, goToEpisode, openSheet]
  );

  if (error) {
    return (
      <View style={[styles.center, { backgroundColor: color.bg.primary }]}>
        <AppIcon name="ban" size={36} color={color.status.danger} />
        <Text style={[styles.error, { color: color.text.primary }]}>{error}</Text>
        <Pressable
          style={[styles.retryBtn, { backgroundColor: color.accent.muted }]}
          onPress={() => goToEpisode(epNum)}
        >
          <Text style={[styles.retryText, { color: color.text.primary }]}>Retry</Text>
        </Pressable>
        <Pressable onPress={() => router.back()} hitSlop={8}>
          <Text style={[styles.retryText, { color: color.text.muted }]}>Go back</Text>
        </Pressable>
      </View>
    );
  }

  if (!src) {
    return (
      <View style={[styles.center, { backgroundColor: color.bg.primary }]}>
        <ActivityIndicator size="large" color={color.text.secondary} />
        <Text style={[styles.hint, { color: color.text.muted }]}>Resolving episode {epNum}…</Text>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: color.bg.primary }]}>
      {/* The page is frozen while a drawer is open. The drawer itself is a
          SIBLING of this ScrollView (see `sheetLayer` below), so it is already
          unreachable by a page drag — this lock covers the rest of the video,
          the strip beside the drawer, where a drag would scroll the player out
          from under a drawer that does not scroll with it. It is the same rule
          the drawer itself depends on, stated at the one place that owns the
          scroll view: while a sheet is up, this page does not move. */}
      <ScrollView
        ref={pageRef}
        scrollEnabled={sheet === null}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: insets.bottom + spacing.xxl }}
      >
            {/* ------- Player, pinned under the status bar ------- */}
            <View style={[styles.playerShell, { paddingTop: insets.top }]}>
              <View style={styles.videoWrap}>
              <VideoView
                key={tuningId}
                player={player}
                style={StyleSheet.absoluteFill}
                nativeControls={false}
                contentFit="contain"
                allowsPictureInPicture
                surfaceType={tuning.surfaceType}
              />
                {/* Parked screen: it is not routed and does not hydrate
                    settings, so it gets the resolved DEFAULTS rather than
                    reading the store — which is exactly what it rendered before
                    the appearance settings existed. */}
                <SubtitleOverlay cue={cue} style={defaultSubtitleStyle()} />
                {/* Scrim only while controls are up, so the chips and title
                    stay readable over bright scenes. */}
                {showControls ? (
                  <LinearGradient
                    colors={['rgba(0,0,0,0.55)', 'transparent', 'rgba(0,0,0,0.55)']}
                    locations={[0, 0.4, 1]}
                    style={StyleSheet.absoluteFill}
                    pointerEvents="none"
                  />
                ) : null}
                {/* The whole video is one tap surface: single tap toggles the
                    controls, double tap on a side seeks ±10s (YouTube). This
                    sits UNDER `PlayerControls`, whose root is `box-none`, so the
                    transport buttons still take their own taps and only the
                    bare video falls through to here. */}
                <Pressable
                  style={StyleSheet.absoluteFill}
                  onPress={(e) => onVideoTap(e.nativeEvent.locationX, e.nativeEvent.locationY)}
                  accessibilityRole="button"
                  accessibilityLabel={showControls ? 'Hide player controls' : 'Show player controls'}
                />
                <PlayerControls
                  visible={showControls && sheet === null}
                  playing={playing}
                  position={time}
                  duration={duration}
                  title={animeTitle || undefined}
                  episodeLabel={`EP ${epNum}`}
                  sourceLabel={sources.length > 1 ? `src ${srcIndex + 1}/${sources.length}` : undefined}
                  qualityLabel={src.quality || undefined}
                  speedLabel={speed === 1 ? '1×' : `${speed}×`}
                  hasSubs={tracks.length > 0}
                  hasMultipleSources={sources.length > 1}
                  onBack={() => {
                    if (router.canGoBack?.()) router.back();
                  }}
                  onPlayPause={() => {
                    if (playingRef.current) player.pause();
                    else player.play();
                    pokeControls();
                  }}
                  onSeek={(t) => {
                    player.currentTime = t;
                    setTime(t);
                    pokeControls();
                    pushPresence(playingRef.current);
                  }}
                  // The hop handlers are passed UNCONDITIONALLY, and `canPrev` /
                  // `canNext` carry the availability. Omitting the handler is
                  // this component's "don't render the button" signal, so
                  // gating it here would make the button vanish at EP 1 and
                  // shift the whole row sideways on every episode change —
                  // the opposite of the fade it is supposed to show.
                  onPrevEpisode={() => goToEpisode(epNum - 1)}
                  onNextEpisode={() => goToEpisode(epNum + 1)}
                  canPrev={canGoPrev}
                  canNext={canGoNext}
                  onOpenSheet={openSheet}
                />
                {/* The double-tap receipt. Above everything else in the video
                    box (it is last in the stack) so it is never occluded by the
                    controls, and `pointerEvents: none` inside it so it can never
                    swallow the next tap. `key={tapSeq}` remounts per double-tap
                    so the bloom restarts from zero every time. */}
                {ripple ? (
                  <SeekRipple key={tapSeq} dir={ripple.dir} x={ripple.x} y={ripple.y} />
                ) : null}
                {skip ? (
                  <Pressable
                    style={styles.skip}
                    onPress={() => {
                      player.currentTime = skip.to;
                    }}
                  >
                    <Text style={styles.skipText}>{skip.label} →</Text>
                  </Pressable>
                ) : null}
                {!!syncNote && (
                  <View style={styles.syncToast} pointerEvents="none">
                    <Text style={styles.syncToastText}>{syncNote}</Text>
                  </View>
                )}
              </View>
            </View>

            {/* ------- Title block: the EPISODE is the hero (YouTube-style) ---
                Kicker carries the technical line, the big line is THIS
                episode's title, and the muted line names the anime — the card
                below already carries the anime's poster and synopsis, so the
                old big-anime-title here was pure duplication. */}
            <View style={styles.titleBlock}>
              <Text style={[styles.epKicker, { color: color.text.muted }]}>
                EPISODE {epNum}
                {src.quality ? ` · ${src.quality}` : ''}
                {sources.length > 1 ? ` · source ${srcIndex + 1} of ${sources.length}` : ''}
              </Text>
              <Text style={[styles.epTitle, { color: color.text.primary }]} numberOfLines={2}>
                {currentEpTitle}
              </Text>
              <Text
                style={[styles.metaLine, { color: color.text.muted }]}
                numberOfLines={1}
              >
                {[animeTitle || 'Loading…', media?.seasonYear].filter(Boolean).join(' · ')}
              </Text>
            </View>

            {/* ------- Stuck? ------- */}
            <Pressable onPress={failover} style={styles.stuckRow}>
              <Text style={[styles.stuckText, { color: color.text.muted }]}>
                {srcIndex + 1 < sources.length
                  ? 'Video stuck? Tap to try the next source'
                  : 'Video stuck? Tap to reload fresh sources'}
              </Text>
            </Pressable>

            {/* ------- Action pills ------- */}
            {actionRow}

            {/* ------- Utility pills: things that live OUTSIDE playback -------
                Playback itself (subs, speed, quality switching) stays inside
                the player sheets. These are the secondary actions: hop CDN
                source, save to the AniList list, share the title. */}
            <View style={styles.utilRow}>
              <Pressable
                style={styles.pill}
                onPress={() => openSheet('source')}
                accessibilityLabel="Switch source"
                accessibilityHint={`Currently source ${srcIndex + 1} of ${sources.length}`}
              >
                <AppIcon name="layers" size={15} color="#fff" />
                <Text style={styles.pillText} numberOfLines={1}>
                  {sources.length > 1 ? `Src ${srcIndex + 1}/${sources.length}` : 'Source'}
                </Text>
              </Pressable>
              <Pressable
                style={styles.pill}
                onPress={openListEditor}
                accessibilityLabel={saved ? 'Edit list entry' : 'Add to list'}
              >
                {entryLoading && entry === undefined ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <AppIcon name={saved ? 'saved' : 'unsaved'} size={15} color="#fff" />
                )}
                <Text style={styles.pillText} numberOfLines={1}>
                  {saved ? 'Saved' : 'Save'}
                </Text>
              </Pressable>
              <Pressable
                style={styles.pill}
                onPress={shareAnime}
                accessibilityLabel="Share this anime"
              >
                <AppIcon name="share" size={15} color="#fff" />
                <Text style={styles.pillText} numberOfLines={1}>
                  Share
                </Text>
              </Pressable>
            </View>

            {/* ------- Anime card: poster + synopsis + stats grid -------
                One surface, three zones: identity row (poster opens details),
                synopsis, and a 4-tile stats grid. Everything reads from the
                already-loaded `media` — zero new requests. */}
            {media ? (
              <View
                style={[
                  styles.animeCard,
                  { backgroundColor: color.bg.surface, borderColor: color.border.muted },
                ]}
              >
                <View style={styles.cardTop}>
                  <Pressable
                    onPress={() => openAnime(animeId)}
                    style={styles.stripPosterWrap}
                    accessibilityLabel={`Open ${animeTitle}`}
                  >
                    {poster ? (
                      <Image
                        source={{ uri: poster }}
                        style={StyleSheet.absoluteFill}
                        contentFit="cover"
                        transition={150}
                        cachePolicy="memory-disk"
                        allowDownscaling
                      />
                    ) : null}
                  </Pressable>
                  <View style={styles.stripText}>
                    <Text style={[styles.stripTitle, { color: color.text.primary }]} numberOfLines={2}>
                      {animeTitle}
                    </Text>
                    <Text style={[styles.metaLine, { color: color.text.muted }]}>
                      {[
                        media.seasonYear,
                        media.episodes ? `${media.episodes} eps` : null,
                        media.duration ? `${media.duration}m / ep` : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </Text>
                    <Text
                      style={[styles.stripSynopsis, { color: color.text.secondary }]}
                      numberOfLines={synExpanded ? undefined : 4}
                    >
                      {stripSynopsis(media.description)}
                    </Text>
                    {stripSynopsis(media.description).length > 140 ? (
                      <Pressable
                        onPress={() => setSynExpanded((v) => !v)}
                        hitSlop={8}
                        accessibilityRole="button"
                        accessibilityLabel={synExpanded ? 'Show less' : 'Read more'}
                      >
                        <Text style={[styles.readMore, { color: color.accent.base }]}>
                          {synExpanded ? 'Show less' : 'Read more'}
                        </Text>
                      </Pressable>
                    ) : null}
                  </View>
                </View>
                <View style={styles.statGrid}>
                  <StatTile label="Score" value={scoreDisplay(media.averageScore)} color={color} />
                  <StatTile label="Format" value={formatLabel(media.format) ?? '—'} color={color} />
                  <StatTile label="Year" value={media.seasonYear ? String(media.seasonYear) : '—'} color={color} />
                  <StatTile label="Status" value={statusLabel(media.status) ?? '—'} color={color} />
                </View>
              </View>
            ) : null}

            {/* ------- Episode search + sort: same controls as details -------
                Search filters first, sort applies after, the pager slices last —
                so "desc" means "newest of the matches". Kitsu follows `paged`,
                i.e. only the rows in the box. */}
            <View style={styles.searchRow}>
              <View style={styles.searchFieldWrap}>
                <SearchField
                  value={query}
                  onChangeText={setQuery}
                  placeholder="Jump to episode #"
                  keyboardType="number-pad"
                />
              </View>
              <Pressable
                style={styles.pill}
                onPress={() =>
                  setSetting('episodes.order', epOrder === 'desc' ? 'asc' : 'desc')
                }
                accessibilityRole="button"
                accessibilityLabel={
                  epOrder === 'desc' ? 'Sort oldest first' : 'Sort newest first'
                }
              >
                <AppIcon name="sort" size={15} color="#fff" />
                <Text style={styles.pillText} numberOfLines={1}>
                  {epOrder === 'desc' ? '12 → 1' : '1 → 12'}
                </Text>
              </Pressable>
            </View>

            {/* ------- Episodes: one page of rows + pager -------
                The box holds ONE page (`EP_PER_PAGE` rows) and is sized BY those
                rows — it has no height of its own and it does not scroll; the
                page does. That is deliberate and it is the Android gesture fix,
                so the note at the top of this file is the one to read before
                changing it. The "screen never stretches" job is done by the
                pager, not by a pixel cap: a long series is paged ten at a time.
                `paged` is the only thing rendered AND the only thing Kitsu is
                asked about. */}
            <View style={styles.epHeadRow}>
              <Text style={[styles.epHeadTitle, { color: color.text.muted }]}>EPISODES</Text>
              {merged.length > 0 ? (
                <Text style={[styles.epHeadCount, { color: color.text.muted }]}>
                  {query.trim()
                    ? `${ordered.length} match${ordered.length === 1 ? '' : 'es'} · `
                    : ''}
                  Page {safePage} of {pageCount}
                </Text>
              ) : null}
            </View>
            <View
              style={[
                styles.epBox,
                { backgroundColor: color.bg.surface, borderColor: color.border.muted },
              ]}
            >
              {ordered.length === 0 ? (
                <View style={styles.epBoxEmpty}>
                  <Text style={[styles.hint, { color: color.text.muted }]}>
                    {merged.length === 0 ? 'Fetching episodes…' : 'No episodes match that search.'}
                  </Text>
                </View>
              ) : (
                /* NOT A ScrollView AND NOT A FlatList — and this is the fix, not
                   a downgrade. Ten rows have nothing to window, and a SECOND
                   vertical scroller inside this page loses every drag on Android:
                   the page's `onInterceptTouchEvent` is asked on the way DOWN
                   from the root and claims the gesture the moment the drag
                   passes touch slop, so the box never starts. The box is
                   therefore a plain View that grows to its rows and the page
                   scroll carries them — one scroller per screen, which is the
                   same rule the player drawer obeys from the other side by
                   living OUTSIDE this scroll view. Full history, including the
                   two fixes that made it worse, is at the top of this file. */
                <View
                  style={styles.epBoxContent}
                  onLayout={(e) => {
                    boxY.current = e.nativeEvent.layout.y;
                    // Children lay out before their parent, so this is the
                    // callback that completes the offset sum a row could not.
                    if (reveal.current != null) revealEpisode(reveal.current);
                  }}
                >
                  {paged.map((item) => {
                    const active = item.number === epNum;
                    return (
                      <View
                        key={item.number}
                        style={active ? [styles.activeWrap, { borderColor: color.accent.base }] : null}
                        onLayout={(e) => {
                          rowY.current[item.number] = e.nativeEvent.layout.y;
                          // Half of the offset sum. If the box has reported its own
                          // by now this scrolls; if not, it returns without
                          // clearing `reveal` and the box's onLayout finishes the
                          // job. Do NOT make this unconditional.
                          if (reveal.current === item.number) revealEpisode(item.number);
                        }}
                      >
                        <EpisodeRow
                          number={item.number}
                          title={item.title ?? `Episode ${item.number}`}
                          thumbnail={item.poster}
                          duration={perEp}
                          synopsis={item.synopsis}
                          position={positions[item.number] ?? 0}
                          onPress={() => {
                            if (!active) goToEpisode(item.number);
                          }}
                        />
                      </View>
                    );
                  })}
                </View>
              )}
            </View>
            <WatchPager page={safePage} pageCount={pageCount} onChange={setEpPage} />
      </ScrollView>

      {/* ------- The player drawer: OUTSIDE the page scroll view -----------
          Same pixels as the video — `top: insets.top` and the height the video
          is laid out at — but a SIBLING of the scroll view rather than a child
          of the player, and that is the whole point. A vertical list inside a
          vertical scroll view never scrolls on Android: the parent takes the
          drag in `onInterceptTouchEvent` before the child sees the move, and
          the PAGE scrolls instead of the option list. `nestedScrollEnabled`
          cannot fix it (RN's ScrollView extends `android.widget.ScrollView`;
          the prop only toggles participation in a nested scroll that no plain
          ScrollView provides), and even where a list does scroll, Android hands
          the leftover drag to the parent at the end of its range — the exact
          thing that must not happen here. With no scrollable ancestor above it,
          the list scrolls, and at either end there is nothing above it to hand
          the gesture to. Playback never pauses; the page lock above covers the
          video strip beside the drawer. */}
      <View
        style={[styles.sheetLayer, { top: insets.top, height: videoH }]}
        pointerEvents="box-none"
      >
        <PlayerSheet
          tab={sheet}
          selected={sheetSelected}
          options={sheetOptions}
          onSelect={handleSheetSelect}
          onClose={() => {
            setSheet(null);
            // The sheet suppressed the controls while it was up, and
            // the hide timer was cleared when it opened — re-arm so
            // they fade out normally instead of staying forever.
            pokeControls();
          }}
        />
      </View>
    </View>
  );
}

/**
 * Compact page navigation for the episode box.
 *
 * Current page, its neighbours, both ends, ellipses where the run collapses —
 * the same shape as the details pager, sized for one thumb-reachable row.
 * Hidden entirely for a single page (nothing to navigate).
 */
function WatchPager({
  page,
  pageCount,
  onChange,
}: {
  page: number;
  pageCount: number;
  onChange: (p: number) => void;
}) {
  const { color } = useTheme();
  if (pageCount <= 1) return null;
  const wanted = new Set<number>([1, pageCount]);
  for (let p = page - 1; p <= page + 1; p++) {
    if (p >= 1 && p <= pageCount) wanted.add(p);
  }
  const sorted = [...wanted].sort((a, b) => a - b);
  const items: (number | '…')[] = [];
  sorted.forEach((p, i) => {
    if (i > 0 && p - sorted[i - 1] > 1) items.push('…');
    items.push(p);
  });
  return (
    <View style={styles.pager}>
      <Pressable
        onPress={() => onChange(page - 1)}
        disabled={page === 1}
        accessibilityRole="button"
        accessibilityLabel="Previous page"
        style={({ pressed }) => [
          styles.pageArrow,
          { opacity: page === 1 ? 0.3 : pressed ? 0.6 : 1 },
        ]}
      >
        <AppIcon name="back" size={16} color={color.text.primary} />
      </Pressable>
      {items.map((it, i) =>
        it === '…' ? (
          <Text key={`e${i}`} style={[styles.ellipsis, { color: color.text.muted }]}>
            …
          </Text>
        ) : (
          <Pressable
            key={it}
            onPress={() => onChange(it)}
            accessibilityRole="button"
            accessibilityLabel={`Page ${it}`}
            style={[
              styles.pagePill,
              {
                backgroundColor:
                  it === page ? color.accent.base : color.bg.surface,
                borderColor: color.border.muted,
              },
            ]}
          >
            <Text
              style={[
                styles.pagePillText,
                { color: it === page ? color.bg.primary : color.text.secondary },
              ]}
            >
              {it}
            </Text>
          </Pressable>
        )
      )}
      <Pressable
        onPress={() => onChange(page + 1)}
        disabled={page === pageCount}
        accessibilityRole="button"
        accessibilityLabel="Next page"
        style={({ pressed }) => [
          styles.pageArrow,
          { opacity: page === pageCount ? 0.3 : pressed ? 0.6 : 1 },
        ]}
      >
        <AppIcon name="chevron" size={16} color={color.text.primary} />
      </Pressable>
    </View>
  );
}

/** One stat tile in the anime card's grid — value over a small caps label. */
function StatTile({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color: ReturnType<typeof useTheme>['color'];
}) {
  return (
    <View style={[styles.statTile, { backgroundColor: color.bg.elevated }]}>
      <Text style={[styles.statValue, { color: color.text.primary }]} numberOfLines={1}>
        {value}
      </Text>
      <Text style={[styles.statLabel, { color: color.text.muted }]}>{label}</Text>
    </View>
  );
}

/** Strip the HTML AniList puts in descriptions down to plain text. */
function stripSynopsis(html: string | null | undefined): string {
  if (!html) return '';
  return html
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xxl,
    gap: spacing.md,
  },
  error: { fontFamily: font.medium, fontSize: 15, textAlign: 'center', lineHeight: 22 },
  hint: { fontFamily: font.regular, fontSize: 14 },
  retryBtn: {
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.sm,
    borderRadius: radii.full,
    marginTop: spacing.xs,
  },
  retryText: { fontFamily: font.semibold, fontSize: 14 },

  playerShell: { backgroundColor: '#000' },
  videoWrap: { width: '100%', aspectRatio: VIDEO_RATIO },
  // The drawer's box: exactly the video's, so it covers the player and nothing
  // else. Sized from VIDEO_RATIO at the call site — if the video's aspect ever
  // changes, both move together. Drawn after the ScrollView so it sits above
  // it, and `box-none` so the closed sheet (pointerEvents "none") lets every
  // touch fall through to the page.
  sheetLayer: {
    position: 'absolute',
    left: 0,
    right: 0,
  },
  skip: {
    position: 'absolute',
    right: 14,
    bottom: 56,
    backgroundColor: 'rgba(255,255,255,0.92)',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: radii.sm,
  },
  skipText: { color: '#0a0a0f', fontFamily: font.semibold, fontSize: 13 },
  syncToast: {
    position: 'absolute',
    top: 10,
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  syncToastText: {
    color: '#4ade80',
    fontFamily: font.semibold,
    fontSize: 12,
    backgroundColor: 'rgba(0,0,0,0.6)',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: radii.full,
    overflow: 'hidden',
  },

  titleBlock: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    gap: 4,
  },
  epKicker: { fontFamily: font.semibold, fontSize: 12, letterSpacing: 0.6 },
  epTitle: { fontFamily: font.bold, fontSize: 19, lineHeight: 26 },
  metaLine: { fontFamily: font.regular, fontSize: 13 },

  stuckRow: { paddingHorizontal: spacing.lg, paddingTop: spacing.sm },
  stuckText: { fontFamily: font.regular, fontSize: 12 },

  actionsRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(128,128,128,0.14)',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: radii.full,
  },
  pillDisabled: { opacity: 0.35 },
  pillText: { color: '#fff', fontFamily: font.semibold, fontSize: 12.5, maxWidth: 84 },

  utilRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    flexWrap: 'wrap',
  },

  animeCard: {
    marginHorizontal: spacing.lg,
    marginTop: spacing.lg,
    borderRadius: radii.lg,
    borderWidth: StyleSheet.hairlineWidth,
    padding: spacing.md,
    gap: spacing.md,
  },
  cardTop: {
    flexDirection: 'row',
    gap: spacing.md,
  },
  stripPosterWrap: {
    width: STRIP_POSTER_W,
    height: (STRIP_POSTER_W * 3) / 2,
    borderRadius: radii.md,
    overflow: 'hidden',
    backgroundColor: 'rgba(128,128,128,0.12)',
  },
  stripText: { flex: 1, minWidth: 0, gap: 4 },
  stripTitle: { fontFamily: font.semibold, fontSize: 14, lineHeight: 19 },
  stripSynopsis: { fontFamily: font.regular, fontSize: 12.5, lineHeight: 18 },
  readMore: { fontFamily: font.semibold, fontSize: 12.5, marginTop: 2 },
  statGrid: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  statTile: {
    flex: 1,
    alignItems: 'center',
    borderRadius: radii.md,
    paddingVertical: spacing.sm,
    paddingHorizontal: 4,
    gap: 2,
  },
  statValue: { fontFamily: font.semibold, fontSize: 14 },
  statLabel: {
    fontFamily: font.medium,
    fontSize: 10,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },

  epHeadRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.xl,
    paddingBottom: spacing.sm,
  },
  epHeadTitle: {
    fontFamily: font.semibold,
    fontSize: 12,
    letterSpacing: 0.8,
  },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
  },
  searchFieldWrap: { flex: 1 },
  epHeadCount: { fontFamily: font.medium, fontSize: 11.5 },
  epBox: {
    marginHorizontal: spacing.lg,
    // ⚠️ NO `height` HERE, and putting one back re-creates the bug. The box is
    // a plain View sized by its rows, and the page is the screen's only
    // scroller — the note at the top of this file has the whole argument. A cap
    // here is the ONLY reason there was ever a second scroller to lose a
    // gesture to, and it was clipping ~200pt of rows nobody could reach. What
    // actually bounds this section's height is `EP_PER_PAGE`, not a pixel
    // count: ten rows, always, on every page of every title.
    borderRadius: radii.lg,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  epBoxContent: { paddingVertical: spacing.xs },
  epBoxEmpty: {
    // ⚠️ `flex: 1` DIED WITH THE FIXED HEIGHT, and silently. It centred this
    // text by filling the 480pt box; inside an auto-sized parent it resolves to
    // zero and the message renders at nothing. Padding is the height now.
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.xxxl,
  },
  activeWrap: {
    marginHorizontal: spacing.lg,
    marginVertical: spacing.xs + 2,
    borderWidth: 1.5,
    borderRadius: radii.lg + 2,
  },
  pager: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    paddingTop: spacing.md,
  },
  pageArrow: { padding: spacing.sm },
  pagePill: {
    minWidth: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.full,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.sm,
  },
  pagePillText: { fontFamily: font.semibold, fontSize: 13, fontVariant: ['tabular-nums'] },
  ellipsis: { fontFamily: font.medium, fontSize: 13, paddingHorizontal: 2 },
});
