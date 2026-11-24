// The landscape fullscreen player.
//
// This is the whole screen. It replaced the vertical watch page, which was
// deleted in the 23 Nov dead-code pass — one player, not two.
//
// WHAT WAS CARRIED OVER FROM THE VERTICAL PAGE, AND WHY IT IS GOOD: source
// resolution with ordered failover, the cross-source HLS quality gather, resume
// from `lib/progress.ts`, the 82%-rule AniList sync, and Discord presence. All
// of that was already right and none of it depended on the page being vertical.
//
// WHAT WAS DROPPED, AND WHY IT HAD TO BE: the scrollable page, the drawer over
// the video, and the coordination between them. A drawer over a scrolling page
// needs `scrollEnabled={sheet === null}` and a `pageRef.scrollTo({y: 0})` before
// every open, because the drawer has to animate over a video that is still in
// the scroll view. A fullscreen player has no page to scroll, so both of those
// disappear rather than being reimplemented.
//
// SPEED IS THE INTERESTING PART. Read `lib/player/speed.ts` first — the short
// version is that there is exactly one rate, `effectiveRate(state)`, and this
// file is the only thing that writes it to the player. The gesture path and the
// menu path both go through it, which is what stops a long-press from leaving
// the engine at 1x while the label says 1.25x.
//
// RESILIENCE IS THE OTHER HALF, and its rules live in `lib/player/health.ts`
// rather than here. What this file does is feed that module a reading every
// second and carry out what it decides; the reasons a rule is the way it is —
// why an unknowable buffer is not an empty one, why a paused playhead is not a
// stalled one, why a backgrounded app is not a dead one, and why a downgrade
// must not be forgotten the instant the buffer thickens — are in that file's
// header, which is where they belong, because they are properties of the
// decision rather than of this screen.

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  AppState,
  BackHandler,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets, type EdgeInsets } from 'react-native-safe-area-context';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useEvent } from 'expo';
import {
  isPictureInPictureSupported,
  useVideoPlayer,
  VideoView,
  type VideoPlayer,
  type VideoSource,
} from 'expo-video';
import { StatusBar } from 'expo-status-bar';
import { NavigationBar } from 'expo-navigation-bar';
import Animated, { FadeIn, FadeOut, useSharedValue } from 'react-native-reanimated';
import {
  BottomBar,
  BOTTOM_BAR_H as CHROME_BOTTOM_BAR_H,
  CenterTransport,
  TopBar,
  TOP_BAR_TOTAL,
  type MenuId,
} from './Chrome';
import { EpisodePanel, type PanelEpisode } from './EpisodePanel';
import { NextEpisodeCard } from './NextEpisodeCard';
import { LoadingStage } from './LoadingStage';
import { GestureSurface } from './GestureSurface';
import {
  clampUnit,
  sideForKind,
  sidesFor,
  type SwipeKind,
  type SwipeSide,
} from './verticalSwipe';
import {
  beginBrightnessSession,
  endBrightnessSession,
  readBrightness,
  setBrightness,
} from '@/lib/player/brightness';
import { scheduleSideHudHide, showSideHud } from '@/lib/player/sideHud';
import {
  beginVolumeSession,
  cancelVolumeWrites,
  commitVolume,
  readVolume,
  setVolume,
  setVolumeFallback,
  usingDeviceVolume,
} from '@/lib/player/volume';
import { SettingsPanel } from './SettingsPanel';
import { type MenuRow } from './Menu';
import {
  PIP_HANDOFF_GRACE_MS,
  PIP_SUBS_SETTLE_MS,
  playbackStage,
  shouldAutoEnterPip,
  shouldHoldPlayback,
} from '@/lib/player/pip';
import { AppIcon } from '@/components/ui/AppIcon';
import { SubtitleStage } from './SubtitleStage';
import { publishCue } from '@/lib/player/cueStore';
import { applyTuning, tuningFor } from '@/lib/player/tuning';
import { describeFailure, type FailureReport } from '@/lib/player/failure';
import { commitTolerance, toleranceFor } from '@/lib/player/scrub';
import {
  healthProfile,
  noteInterruption,
  noteSeek,
  observeHealth,
  resetHealth,
  type HealthProfile,
  type HealthState,
  type PlaybackHealth,
} from '@/lib/player/health';
import {
  beginBoost,
  commitSpeed,
  effectiveRate,
  endBoost,
  formatRate,
  initialSpeed,
  isBoosting,
  rampBoost,
  SPEED_STEPS,
  type SpeedState,
} from '@/lib/player/speed';
import { parseVTT, type Cue } from '@/lib/subtitles/vtt';
import { buildSubtitleFrame } from '@/lib/subtitles/frame';
import { cueLoad } from '@/lib/subtitles/cueCache';
import { cueLookupTime } from '@/lib/subtitles/clock';
import { resolveSubtitleStyle } from '@/lib/subtitles/style';
import { NO_TRACK, SUBTITLE_OFF, pickTrack, preferenceFor } from '@/lib/subtitles/select';
import { clearPosition, loadPosition, loadPositions, savePosition, isSynced, markSynced } from '@/lib/progress';
import { createRegistry, resolveEpisode } from '@/lib/extensions/registry';
import { fetchText } from '@/lib/extensions/fetch';
import { listVariants, type HlsVariant } from '@/lib/extensions/hls';
import { capFor } from '@/lib/player/rung';
import type { EpisodeInfo, SubtitleTrack, WatchSource } from '@/lib/extensions/types';
import { releasePresence, updatePresence, type PresenceMedia } from '@/lib/presence/discord';
import { fetchMedia, mediaTitle, type MediaDetail } from '@/lib/anilist';
import { episodesToShow, isPlaceholderEpisodeTitle, nextPlayableEpisode } from '@/lib/anilist/episodes';
import {
  kitsuEpisodeVersion,
  mergeKitsuMeta,
  peekKitsuEpisodes,
  resolveKitsuEpisodes,
} from '@/lib/media/kitsuEpisodes';
import { useQueryClient } from '@tanstack/react-query';
import { useUserId } from '@/lib/auth/session';
import { useListEntry, useSyncListProgress } from '@/lib/query/listEntries';
import { qk } from '@/lib/query/keys';
import {
  setSetting,
  readSetting,
  type SubtitleBackgroundKey,
  type SubtitleColorKey,
  type SubtitlePositionKey,
  type SubtitleSizeKey,
} from '@/lib/settings/store';
import { useSetting } from '@/lib/settings/useSetting';
import { font, motion, radii } from '@/lib/ui/tokens';
// The resolve's two windows and the failover budgets live in `lib/player/`
// (`resolveWindow.ts`, `failover.ts`) rather than inline here: the check
// battery has to drive the REAL decision code, and a component cannot be
// imported into a Node script. The full reasoning for each constant lives at
// its definition.
import { resolveInTwoWindows } from '@/lib/player/resolveWindow';
// The constants are referenced in comments below; the decision functions
// default to them inside the modules, so the component imports only the verbs.
import {
  budgetOnLoad,
  freshBudget,
  healOnFrame,
  noteFailure,
  provesStable,
  spendRound,
  wrapVerdict,
  type FailBudget,
} from '@/lib/player/failover';
import {
  decideRecovery,
  initialRecovery,
  noteRecovered,
  noteStable,
  RECOVERY_EXHAUSTED_MESSAGE,
  type RecoveryState,
} from '@/lib/player/recovery';
import { contentTypeFor, isPlayableRoute, labelDisagrees, paramNumber } from '@/lib/player/source';
import { InvalidLinkCard, PlaybackErrorCard } from './PlayerCards';
import { nextWalkIndex, pickStartIndex, readSourcePref, saveSourcePref } from '@/lib/player/sourcePref';
import {
  clearSourceTrip,
  clearSourceTrips,
  isSourceSkipped,
  noteSourcePlayed,
  readSourceTrip,
  sessionProvenSource,
  sourceSkipHint,
  tripKindForPlaybackFailure,
  tripKindForResolveFailure,
  tripSource,
} from '@/lib/player/sourceLedger';
import { readQualityPref, saveQualityPref } from '@/lib/player/qualityPref';
import { dropResolveCache, readResolveCache, writeResolveCache } from '@/lib/player/resolveCache';
import { setChromeVisible, useChromeVisible } from '@/lib/player/chromeVisibility';
import {
  isOffline,
  isOfflineError,
  OFFLINE_MESSAGE,
} from '@/lib/net/connectivity';
import { useNetworkStatus } from '@/lib/net/network';

/** Seconds between resume writes. Matches the old page; not worth churning. */
const SAVE_EVERY = 10;
/**
 * Fraction of the runtime past which the episode is written to AniList.
 *
 * 82% is inherited from the old page and is deliberate rather than round: an
 * episode's last act is where "did I actually finish this" is decided, so
 * syncing before it lets a user who rewinds the ending mark an episode they
 * bounced off of.
 */
const SYNC_AT = 0.82;

/**
 * 🎧 HOW LONG A MOVING PICTURE MAY STAY SILENT.
 *
 * An HLS master with a separate audio rendition, played as a bare variant URL,
 * renders video forever and never makes a sound — and no error is raised, so
 * every existing guard (watchdog, health, budgets) calls it healthy. A frame is
 * proof of a picture, never of an audio track, so the two are checked apart.
 *
 * Two windows, 3s then 5s: some decoders enumerate tracks a beat after the
 * first frame, and walking away from a good source over a slow enumeration
 * would be worse than the bug. Eight seconds of confirmed silence is not a
 * timing accident.
 */
const NO_AUDIO_GRACE_MS = 3000;
const NO_AUDIO_RECHECK_MS = 5000;
const NO_AUDIO_MESSAGE =
  'This server is sending video with no audio track. Trying another source…';
/**
 * ⚠️ THE SILENCE VERDICT IS BOUNDED, AND ONLY TRUSTED AT AN ITEM'S START.
 *
 * `availableAudioTracks` is a synchronous native read of a list the decoder is
 * still populating, and a stream that has been playing for ten minutes with
 * sound is not evidence that a zero-length list right now means anything. So
 * the verdict is only taken:
 *
 *   • inside the first `SILENCE_MAX_POSITION_S` of an item — a genuinely
 *     video-only rendition is silent from its first seconds, which is the bug
 *     this guard exists for; a reading taken mid-episode is far more likely to
 *     be a transient enumeration state than a silent source;
 *   • ONCE per source URL, so one misread cannot become a hop every eight
 *     seconds; and
 *   • at most `MAX_SILENT_HOPS` times per episode, so an all-silent provider
 *     matrix costs two hops and the episode keeps playing (a picture with no
 *     sound beats a stream that never settles).
 *
 * Every hop re-opens the native media source, and `expo-video` prepares that on
 * the Android main thread — so an unbounded silence walk is not a cosmetic
 * annoyance, it is the UI-thread stall this pass exists to remove.
 */
const SILENCE_MAX_POSITION_S = 45;
const MAX_SILENT_HOPS = 2;
/**
 * How often the stability heartbeat asks whether the stream has earned its
 * budgets back. See `armStableProof` below; `provesStable` owns the rule.
 */
const STABLE_HEARTBEAT_MS = 20_000;
/** Below this a source's runtime is too short to judge "finished" by. */
const SHORT_EPISODE = 300;
const MARK_FINISHED = 0.9;
/**
 * How long the "up next" card counts down before the next episode starts.
 *
 * It is a COUNTDOWN now, not a hidden delay: `NextEpisodeCard` puts the queued
 * episode and this number on the frame, with Play now and Cancel. Five seconds
 * is the shape the big players use — long enough to read a title and stop it,
 * short enough that a viewer who does nothing keeps watching. A silent timer
 * that swaps episodes is the one autoplay behaviour viewers call a bug.
 */
const AUTO_ADVANCE_SECONDS = 5;

/**
 * How often the subtitle overlay re-reads the playhead, in ms.
 *
 * The active cue is picked inside the `timeUpdate` listener, and `timeUpdate`
 * fires at `timeUpdateEventInterval` — 0.5s here, because presence, the health
 * monitor and the auto-skip all read that same tick and none of them want it
 * faster. That cadence is too coarse for SUBTITLES: a cue boundary that passes
 * just after one sample is not drawn until the next, so a line can appear up to
 * HALF A SECOND after its audio — the reported "the audio comes before the
 * subtitles", and the reason it varies from title to title (it depends where
 * each cue's start happens to fall between ticks).
 *
 * So the overlay gets a tick of its own. It is deliberately NOT a smaller
 * `timeUpdateEventInterval`: that would change the cadence of every other
 * reader of the tick to fix a subtitle problem, which is how a fix for one
 * thing becomes a regression in three. This timer only reads the playhead and
 * looks up a cue — and `setCue`'s identity check drops the many ticks that land
 * inside the cue already on screen, so the extra wake-ups cost almost nothing.
 *
 * 120ms puts the worst-case lag below the threshold at which lip-sync drift is
 * perceptible, and is ~4× lighter than the 30ms a frame-rate sampler would use.
 * The viewer's own sync correction lives on top of this, in `cueAtSync`.
 */
const SUBTITLE_TICK_MS = 120;

/**
 * How long a source gets to produce its FIRST FRAME before it is written off.
 *
 * Not the same as `statusChange: 'error'`, and it has to be separate: a source
 * can reach `readyToPlay`, accept `play()`, and never render — wrong MIME type,
 * an extractor that declines, a playlist the CDN answers but does not honour.
 * None of those raise an error. All of them look identical to the user, which
 * is a black screen with a working subtitle track over it.
 *
 * Generous, because first frame legitimately takes a while on a cold HLS
 * connection. Only ever fires after a replace, and is cancelled the instant a
 * frame lands.
 */
const FIRST_FRAME_TIMEOUT = 14_000;
/** Allow one short native-surface remount before showing a render error. */
const FRAME_RECOVERY_TIMEOUT = 5_000;

/**
 * How far the chrome's generic skip button jumps, in seconds.
 *
 * The intro/outro button answers a MARKER — "this stretch is an opening, end
 * it" — and shows whenever the playhead is inside one, chrome or not. The
 * +85s button answers the NO-MARKER case: with no source-supplied window the
 * button keeps its seat but changes its job, jumping a fixed 85s. 85 is the
 * length of a typical opening-plus-recap (90s openings are the long tail; 85
 * lands inside even those), so one tap usually clears whatever unmarked
 * preamble the source baked into the file. Overlay-mode only: without a
 * marker there is nothing persistent to react to, and a permanent button on
 * the gesture surface is one more thing a pocket can find.
 */
const SKIP_FORWARD_S = 85;

/**
 * How far a floating control sits above the bottom bar's own top edge, in px.
 *
 * The bar measures 157pt, and its inner column starts 22pt below that edge —
 * that padding is the gradient's headroom, drawn above the timeline on purpose.
 * So a control seated at `barHeight` is already 22pt clear of the timeline, and
 * the extra 12pt on top of it read as detached: the up-next card and the skip
 * pill floated visibly higher than the transport they belong to. 2pt is the
 * hairline that says "overlay, not part of the bar"; the headroom does the rest.
 *
 * One constant for both, because they share that edge — two literals would drift
 * apart on the next tweak and look like two accidents.
 */
const ABOVE_BAR_GAP = 2;

/**
 * Fallback for the bottom chrome's height, until the bar has been measured.
 *
 * Imported from `Chrome.tsx` rather than restated: two literals that have to
 * agree is exactly how a subtitle ends up behind a timeline. The real number
 * arrives from `BottomBar`'s `onLayout` within a frame or two and replaces this
 * everywhere — subtitles, toast, popover, speed pill — so none of them can be
 * tuned against a value that is no longer true.
 */
const BOTTOM_BAR_H = CHROME_BOTTOM_BAR_H;

/**
 * The one value the health readout rests on when nothing is known.
 *
 * A MODULE CONSTANT rather than a fresh `{ kind: 'unknown' }` per tick. The
 * monitor runs once a second and the consumer compares by identity, so an
 * object literal would defeat the very guard that stops it re-rendering — the
 * classic way a "memoised" value quietly stops being memoised.
 */
const UNKNOWN_HEALTH = { kind: 'unknown' } as const;

// THE SOURCE-KIND AND ROUTE RULES now live in `lib/player/source.ts`.
//
// `contentTypeFor` / `labelAgrees` / `labelDisagrees` and `paramNumber` /
// `isPlayableRoute` were inline here: two decisions with a device bug behind
// each, reachable only by running this entire screen. They are pure, so they
// moved where a check script can drive them. Nothing about them changed.

export default function LandscapePlayer() {
  const params = useLocalSearchParams<{ id: string | string[]; ep: string | string[] }>();
  const animeId = paramNumber(params?.id);
  const epNum = paramNumber(params?.ep);

  /**
   * Whether this route names an episode at all.
   *
   * Checked rather than assumed at three places — the load effect, the
   * unmount-save, and the render — because each one writes to storage or makes
   * a request. A screen that merely refused to render would still have already
   * written `NaN` keys on the way out.
   */
  const linkOk = isPlayableRoute(animeId, epNum);

  /**
   * Connectivity, the same store the transport and React Query read.
   *
   * In the player this is not just a banner: an offline phone must not be
   * allowed to spend the failover budget walking seven sources, and a
   * reconnect must be the event that restarts the attempt. `offlineRef` below
   * carries the same value into callbacks that must not be re-created (the
   * health tick, the frame watchdog, `failover`).
   */
  const net = useNetworkStatus();
  const offline = net.kind === 'offline';

  /**
   * Safe-area insets, for a screen that is 90% edge-anchored chrome.
   *
   * IN LANDSCAPE THESE ARE NOT A NICETY. The notch/home-indicator edge moves to
   * one SIDE, and a rotation that turns a top inset into a side inset leaves
   * every `paddingTop`-based bar exactly where it was — so the back button ends
   * up under the notch and the episode panel's header is half off-screen. The
   * old player had the same class of bug in portrait and is why this is read
   * once here and threaded down rather than each bar reading its own.
   */
  const insets = useSafeAreaInsets();

  /**
   * The bottom chrome's height, MEASURED.
   *
   * One number, fed to the subtitles, the popover and the speed pill,
   * so nothing that has to sit "just above the bar" can disagree about where the
   * bar is. It used to be the imported constant — 156, against content that
   * measured 135 — which put the subtitles 21pt higher than intended and left a
   * band of dead gradient above the timeline.
   *
   * The value is deliberately NOT reset when the chrome hides. The bar unmounts
   * while it is hidden and so stops reporting, and the alternative — falling
   * back to the constant for those three seconds — is a subtitle that JUMPS when
   * the viewer taps the screen. Keeping the last measurement means every element
   * below holds its position through the entire hide/show cycle, which is the
   * whole point.
   *
   * Seeded with the inset ALREADY added. A bare `BOTTOM_BAR_H` here would be
   * wrong by exactly the height of the home indicator until the first `onLayout`
   * arrived a frame later — a small one-off jump on every player open, which is
   * the same class of bug as the 124pt one, just quieter.
   */
  const [barHeight, setBarHeight] = useState(() => BOTTOM_BAR_H + insets.bottom);
  /**
   * The episode queued by `playToEnd`, or null.
   *
   * The NUMBER only: the title is looked up at render from the episode list,
   * which may still be in flight when the card is queued.
   */
  const [upNext, setUpNext] = useState<number | null>(null);
  const onBarMeasure = useCallback((h: number) => {
    // Sub-point rounding on the safe area would otherwise re-render the chrome
    // for a height nobody can see.
    setBarHeight((prev) => (Math.abs(prev - h) < 1 ? prev : h));
  }, []);

  // --- Sources ------------------------------------------------------------
  const [sources, setSources] = useState<WatchSource[]>([]);
  const [failedSources, setFailedSources] = useState<{ id: string; reason: string }[]>([]);
  const [srcIndex, setSrcIndex] = useState(0);
  /**
   * Bumps when the session ledger changes, so the source sheet re-reads it.
   *
   * The ledger lives outside React (it is per-launch module state), so a trip
   * written from `failover` or a frame that clears one changes nothing React can
   * see. Without this counter the sheet would keep drawing the previous
   * opinion until some unrelated render happened.
   */
  const [ledgerTick, setLedgerTick] = useState(0);
  const bumpLedger = useCallback(() => setLedgerTick((n) => n + 1), []);
  const [variantsBySource, setVariantsBySource] = useState<Record<number, HlsVariant[]>>({});
  /** `null` = Auto (the master playlist). `{src,v}` locks one variant. */
  const [qualitySel, setQualitySel] = useState<{ src: number; v: number } | null>(null);

  // --- Metadata -----------------------------------------------------------
  const [title, setTitle] = useState('');
  // Episodes for the side panel. The SOURCE list (what actually exists and is
  // playable) lives in `sourceEpisodes`; Kitsu only DECORATES it, and the merge
  // is re-derived whenever a Kitsu page lands (kitsuVersion) so a late artwork
  // upgrade re-renders the panel without a re-fetch. `resumePositions` is kept
  // separate so the merge can be re-run without re-reading progress from disk.
  const [sourceEpisodes, setSourceEpisodes] = useState<EpisodeInfo[]>([]);
  const [resumePositions, setResumePositions] = useState<Record<number, number>>({});
  const [kitsuVersion, setKitsuVersion] = useState(0);
  const [visibleNums, setVisibleNums] = useState('');
  const [totalEps, setTotalEps] = useState(0);
  /**
   * The AniList detail payload this episode was loaded against — kept as state
   * (not only inside `load()`) because TWO decisions need it after the fetch:
   * the auto-advance availability check (`nextPlayableEpisode`) and the media
   * cache seed. Both must see the SAME payload the sync and the panel see.
   */
  const [mediaDetail, setMediaDetail] = useState<MediaDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  /**
   * WHO OWNS "WHAT HAS BEEN WATCHED" IN THE PANEL — the same rule the details
   * page applies, and for the same reason. The panel used to tick a row on
   * `position > 0`, so a title reset on AniList kept every old episode marked
   * here even after the details page had correctly let the entry win.
   *
   * With an entry, AniList decides and a local position means only "the
   * playhead was here on this device"; without one — signed out, or a title
   * nobody ever tracked — local positions are the only record there is and
   * keep deciding, exactly as before. `useListEntry` is the same query the
   * details page and the list sheet read, so the usual route in (details →
   * play) costs no extra request, and the player's own progress writes patch
   * that key, which is what makes the panel update as episodes are watched.
   */
  const signedIn = useUserId() != null;
  const { entry: listEntry } = useListEntry(animeId, signedIn);
  const anilistProgress = listEntry?.progress ?? 0;
  const anilistOwnsProgress = listEntry != null;

  // Derived panel episodes: source list decorated by Kitsu, keyed on the version
  // counter so a late Kitsu page landing re-merges without re-fetching.
  const episodes = useMemo<PanelEpisode[]>(() => {
    void kitsuVersion;
    const merged = mergeKitsuMeta(sourceEpisodes, peekKitsuEpisodes(animeId));
    return merged.map((e) => ({
      number: e.number,
      title: e.title,
      poster: e.poster ?? null,
      duration: e.duration ?? null,
      // A local position is DROPPED, not merged, when AniList tracks the title
      // — same as the details page. It still does its real job (the player
      // seeks with it); it just cannot vote on whether an episode was watched.
      position: anilistOwnsProgress ? 0 : resumePositions[e.number] ?? 0,
      watchedOverride: anilistOwnsProgress && e.number <= anilistProgress,
    }));
  }, [
    sourceEpisodes,
    resumePositions,
    animeId,
    kitsuVersion,
    anilistOwnsProgress,
    anilistProgress,
  ]);

  /**
   * The name of the episode that is coming, from whatever is already known.
   *
   * This used to be STATE, committed only after the SOURCE's episode list
   * returned — the very fetch the scrape is waiting on — so the first-load stage
   * said "Episode 2" and no name for its entire life, then the name appeared
   * once the stage was gone. The panel's list is the right source: source rows
   * decorated by Kitsu, and Kitsu is the side that actually carries episode
   * names. Deriving it means the name paints as soon as either side has it,
   * which on the usual details → play route is at mount (the cache is warm).
   * `isPlaceholderEpisodeTitle` keeps the padding `episodesToShow` inserts from
   * being rendered as if it were a name.
   */
  const episodeTitle = useMemo(() => {
    const found = episodes.find((e) => e.number === epNum)?.title;
    return isPlaceholderEpisodeTitle(found, epNum) ? null : found;
  }, [episodes, epNum]);

  /**
   * Ask Kitsu for THIS episode's page at load time.
   *
   * The panel only resolves Kitsu pages from its own visible rows, so an
   * auto-advance into an episode the viewer has not scrolled to had no name to
   * show while the source was being scraped. Kitsu is the cheap side of this
   * screen (one page, cached per title), and it does not depend on the video
   * scrape at all, so it is asked in parallel and the name fills in mid-load.
   */
  useEffect(() => {
    if (!animeId || !epNum) return;
    let cancelled = false;
    void resolveKitsuEpisodes(animeId, [epNum]).then(() => {
      if (!cancelled) setKitsuVersion(kitsuEpisodeVersion(animeId));
    });
    return () => {
      cancelled = true;
    };
  }, [animeId, epNum]);

  // Kitsu fill-in for the panel. Viewability comes from the EpisodePanel's
  // FlatList (no pager here — the panel is a scrollable list), debounced so a
  // fast scroll collapses into one request. `visibleNums` is a string key so
  // the effect only re-fires when the visible set actually changes.
  useEffect(() => {
    if (!visibleNums || !animeId) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void resolveKitsuEpisodes(animeId, visibleNums.split(',').map(Number)).then(() => {
        if (!cancelled) setKitsuVersion(kitsuEpisodeVersion(animeId));
      });
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [animeId, visibleNums]);

  const handleVisibleNumbers = useCallback((nums: number[]) => {
    const key = nums.slice().sort((a, b) => a - b).join(',');
    setVisibleNums((prev) => (prev === key ? prev : key));
  }, []);

  const [resolving, setResolving] = useState(true);
  /**
   * The engine's own words about the most recent failure, classified.
   *
   * Previously the message in `statusChange`'s `error` payload was read and
   * discarded — `if (p.status === 'error') failoverRef.current()` — so every
   * cause collapsed into one sentence once the rounds ran out. A 403 from an
   * expired signed URL and a DNS failure in a lift were the same screen, and
   * neither was the thing a support report needs. `null` means "no classified
   * engine message yet", which is different from "an error that produced no
   * message" and renders differently.
   */
  const [failure, setFailure] = useState<FailureReport | null>(null);

  // --- Playback -----------------------------------------------------------
  /**
   * THE LIVE CUE IS NOT STATE HERE (16 Nov). It lives in
   * `lib/player/cueStore.ts` and only `SubtitleStage` subscribes, because a cue
   * changes a few times a second during dialogue and every one of those changes
   * used to re-render this whole screen — both bars, two gradients, four chips
   * and the timeline — for one line of text.
   */
  const [activeSkip, setActiveSkip] = useState<{ kind: 'opening' | 'ending'; start: number; end: number } | null>(null);
  const [playing, setPlaying] = useState(false);
  /**
   * Whether this player screen is the one on top. Used to stop the screen from
   * staying awake on OTHER pages: the player can stay mounted in the navigation
   * stack (so its state survives), and `keepScreenOnWhilePlaying` would otherwise
   * keep the display lit while the viewer is on home/details/etc.
   */
  const focusedRef = useRef(true);
  const [muted, setMuted] = useState(false);
  /**
   * Has the native surface actually put a frame on screen?
   *
   * Tracked separately from `status`, because "readyToPlay" and "there is a
   * picture" are different claims and only the first one is free. Without this
   * the worst failure in a player is indistinguishable from a working one: a
   * black rectangle, no error, no spinner, nothing for the viewer to act on.
   * It is the state this file was in when a mislabelled `contentType` made
   * ExoPlayer's extractor give up silently.
   */
  const [firstFrame, setFirstFrame] = useState(false);
  const [videoViewRevision, setVideoViewRevision] = useState(0);
  /** Read by the frame watchdog, which lives outside the render cycle. */
  const firstFrameRef = useRef(false);
  const frameRecoveryUsedRef = useRef(false);
  firstFrameRef.current = firstFrame;
  /** A progressing clock proves the source is alive even if its view rendered black. */
  const playbackProgressRef = useRef(false);
  const [playbackProgress, setPlaybackProgress] = useState(false);
  /** Resume seeks wait until Android has actually rendered a frame. */
  const resumeSeekAfterFrameRef = useRef<number | null>(null);

  /**
   * Whether we know where playback actually IS.
   *
   * NOT the same question as "has the player loaded". Between the two there is a
   * window where the answer is 0 and 0 is a lie: the pipeline is ready, the first
   * frame has rendered at the start of the episode, and the stored resume
   * position has not been applied yet. The playhead genuinely reads 0 there, so
   * the bar is not displaying a bug — it is displaying the truth about a player
   * that has not resumed yet.
   *
   * False until `applyResumePosition` has run, or until the stored position turns
   * out to be nothing worth resuming. The timeline renders no playhead and no
   * elapsed time while it is false, which is what stops "0:00, then 12:34" from
   * being read as the app forgetting where it was.
   */
  const [resumeSettled, setResumeSettled] = useState(false);

  // --- Buffer health ------------------------------------------------------
  /**
   * The last verdict from `lib/player/health.ts`, for display only.
   *
   * Deliberately the ONLY piece of health state in React. The running state —
   * the playhead clock, the buffer runs, whether a tier has already been given
   * up — lives in a ref inside the module and is advanced by a one-second tick,
   * because all of it is read-modify-write across ticks and putting it in state
   * would both re-render the screen every second and invite two updates to
   * interleave. What reaches React is a verdict, and only the three kinds the
   * viewer can see: a spinner, a note, or nothing at all.
   */
  const [health, setHealth] = useState<PlaybackHealth>(UNKNOWN_HEALTH);
  /**
   * The resolution the pipeline is ACTUALLY on.
   *
   * `player.videoTrack` is read-only, so this can never be *set* — it is an
   * observation, and it is the only observation available for "which rung is
   * playing". Two uses: the quality trigger shows it, so "Auto" is never a
   * label for "something is happening and I cannot tell you what"; and the
   * downgrade path steps down from THIS rather than from the top of the ladder.
   */
  const [liveHeight, setLiveHeight] = useState<number | null>(null);
  /**
   * The same observation, for code that runs from TIMERS rather than renders.
   * The recovery ladder needs to know which rung is playing to know which one
   * is below it, and it runs from the 1s health tick.
   */
  const liveHeightRef = useRef<number | null>(null);
  liveHeightRef.current = liveHeight;

  // --- Subtitles ----------------------------------------------------------
  const [tracks, setTracks] = useState<SubtitleTrack[]>([]);
  const [trackIndex, setTrackIndex] = useState(0);
  const [cues, setCues] = useState<Cue[]>([]);

  /**
   * The subtitle preferences, read through the store's hook rather than
   * `readSetting`, because all three feed RENDER — a size or position change has
   * to repaint the next cue immediately, and a module-scope read would not
   * re-render this screen at all.
   */
  const subsLanguage = useSetting('subs.language');
  const subsSize = useSetting('subs.size');
  const subsPosition = useSetting('subs.position');
  const subsPositionFrac = useSetting('subs.positionFrac');
  const subsBackground = useSetting('subs.background');
  const subsColor = useSetting('subs.color');
  const subsDelayMs = useSetting('subs.delayMs');
  /**
   * Which half of the screen drives volume and which drives brightness — see
   * `PLAYER_SWIPE_SIDES`. Mapped to the gesture's shape here (once per change)
   * rather than passed as the raw key, so the surface never has to know what a
   * setting is.
   */
  const swipeSideSetting = useSetting('player.swipeSides');
  const swipeSides = useMemo(() => sidesFor(swipeSideSetting), [swipeSideSetting]);

  /**
   * One resolved object for the overlay, so the offset arithmetic exists once.
   *
   * This screen contributes TWO measured numbers (the bar below, the chrome band
   * above) and NO height. The container the cue is placed in is the overlay's
   * own, measured there; a window-derived height here was the first version's
   * bug — it already had the bottom bar subtracted, the overlay subtracted it
   * again, and the slider's whole range collapsed to 17pt on a landscape phone.
   *
   * It must never multiply by whether the chrome is showing — that is the
   * "subtitles move when the controls auto-hide" bug this file already fixed
   * once, and making position a preference is exactly the change that would let
   * it back in.
   */
  const subtitleStyle = useMemo(
    () => resolveSubtitleStyle({ size: subsSize, position: subsPosition, positionFrac: subsPositionFrac, background: subsBackground, color: subsColor }),
    [subsSize, subsPosition, subsPositionFrac, subsBackground, subsColor]
  );

  // --- Speed --------------------------------------------------------------
  /**
   * ONE state object, ONE writer of `player.playbackRate`.
   *
   * `speed` is `{committed, boost}`; the engine always gets `effectiveRate(speed)`.
   * Nothing in this file may assign `player.playbackRate` from anything else —
   * that single rule is the fix. See the header of `lib/player/speed.ts` for the
   * ShonenX bug this prevents.
   */
  const [speed, setSpeed] = useState<SpeedState>(() => initialSpeed(1));
  const [customSpeedOpen, setCustomSpeedOpen] = useState(false);
  const [customSpeedText, setCustomSpeedText] = useState('');

  // --- Chrome -------------------------------------------------------------
  const showControlsRef = useRef(true);
  const [locked, setLocked] = useState(false);
  const lockedRef = useRef(false);
  lockedRef.current = locked;
  const [menu, setMenu] = useState<MenuId>(null);
  const [panelOpen, setPanelOpen] = useState(false);

  // Seed the Kitsu fetch when the panel opens at the current episode, in case
  // the FlatList's viewability callback is slow to fire on the first render.
  // The full visible set replaces this as soon as viewability reports.
  useEffect(() => {
    if (!panelOpen || visibleNums || !episodes.length) return;
    setVisibleNums(String(epNum));
  }, [panelOpen, visibleNums, episodes.length, epNum]);
  /**
   * PiP support, read SYNCHRONOUSLY.
   *
   * `isPictureInPictureSupported()` is a plain boolean read of a device
   * capability — there is nothing to await, and it cannot change while the app
   * is running. It used to be read in a mount effect off a `false` initial
   * value, which meant every single time the player opened, it painted the top
   * bar WITHOUT the PiP button and then, one frame later, inserted one. The
   * episode and lock buttons were shoved 42pt to the left at that moment, under
   * the viewer's finger, before they settled. The lazy initialiser has the right
   * value on the very first render, so the top bar is laid out once.
   */
  const [pipSupported] = useState(isPictureInPictureSupported);
  /**
   * WHETHER THE SYSTEM OWNS THE PICTURE RIGHT NOW, as RENDER state.
   *
   * `pipActiveRef` is the same fact held for the transport policy, and a ref
   * cannot gate a render. This gates the GESTURE SURFACE, so a tap aimed at a
   * tiny window cannot raise a full-size chrome.
   *
   * ⚠️ THERE IS NO PiP BUTTON, AND THERE CANNOT BE ONE FROM HERE.
   *
   * `expo-video`'s `layoutForPiPEnter` (android/…/PictureInPictureManager.kt)
   * REMOVES the player view from its parent, sets every other child of the
   * activity's content view to `View.GONE` — that is the entire React Native
   * root, chrome and subtitles included — and re-adds the player view
   * full-screen. So nothing this app draws is in the PiP window at all; the
   * play/pause disc that used to be mounted here (`PipControls`, 23 Nov) rendered
   * into a GONE subtree and could never have been seen. A control in that window
   * has to come from the platform: a MediaSession action list, which expo-video
   * does not expose and which needs `supportsBackgroundPlayback` — a policy this
   * app refuses on purpose, because a locked phone must be silent.
   *
   * The PiP window's own expand/close overlay is the system's, and a headset's
   * media button still reaches the player through the session it already keeps.
   */
  const [pipOn, setPipOn] = useState(false);
  /**
   * IS THE VIDEO IN A SYSTEM PIP WINDOW?
   *
   * Needed because `AppState` cannot tell PiP from a locked phone: Android
   * pauses the activity while the PiP window is up, so both report 'background'.
   * Every background rule in this file consults this ref, and it is a ref rather
   * than state because the transport policy reads it from timers and player
   * listeners that must not be rebuilt when PiP toggles.
   */
  const pipActiveRef = useRef(false);
  /**
   * Timestamp until which subtitle publishing is parked after a PiP exit — 0
   * means "not parked". See `PIP_SUBS_SETTLE_MS`.
   */
  const subsHoldUntilRef = useRef(0);
  /** Timer that restores subtitle publishing once the PiP window has settled. */
  const subsRestoreTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Pending "did a PiP handoff start?" timer. See `PIP_HANDOFF_GRACE_MS`. */
  const pipHandoffTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * True once the app has backgrounded with no PiP handoff and playback has been
   * held. Stays true until the viewer returns, and is what makes a remote play
   * (a headset button) unable to restart audio behind a locked screen.
   */
  const backgroundHoldRef = useRef(false);
  /**
   * Pending "was that PiP exit a close or an expand?" check.
   *
   * `onPictureInPictureStop` fires for both, and an expand arrives before the
   * activity reports 'active', so acting on the callback alone would pause the
   * episode the viewer just brought back to the screen. The check is deferred
   * instead; see `onPipStop`.
   */
  const pipExitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * The video surface. Needed because `startPictureInPicture()` is a method on
   * the VIEW — the view owns the native PiP surface, and there is no
   * player-side equivalent to call instead.
   */
  const videoViewRef = useRef<VideoView>(null);
  /** Pending "this source never rendered" timer. */
  const frameWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The pending silent-picture check; cleared by every new media item. */
  const audioGuardRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** False once this screen has begun unmounting; long timers check it. */
  const mountedRef = useRef(true);
  /**
   * THE FAILOVER BUDGET, AS ONE VALUE. See `FailBudget` for the loop this fixed:
   * `load()` used to reset the two loose counters on every call, including the
   * call a wrap-load makes, so the walk could never spend its budget and the
   * player resolved and re-walked every source forever.
   */
  const budgetRef = useRef<FailBudget>(freshBudget());
  /** The stall recovery ladder's running state. See `lib/player/recovery.ts`. */
  const recoveryRef = useRef<RecoveryState>(initialRecovery());
  /**
   * True while the current rung was chosen BY THE LADDER, not by the viewer.
   *
   * The difference is a disk write: a reduction earned on a train must not
   * become the remembered quality of the series (`onFirstFrame` writes the
   * proven rung). It still travels in memory, so a hop carries it.
   */
  const autoQualityRef = useRef(false);
  /** `bufferedPosition` at the previous health sample, to tell slow from dead. */
  const lastBufferedRef = useRef(-1);
  /** Previous `player.status`, so "it left BUFFERING" can count as progress. */
  const lastStatusRef = useRef<string | null>(null);
  /**
   * Last moment the health monitor declared a STALL. The stability heartbeat's
   * quiet window is measured from here — see `provesStable`.
   */
  const lastStallAtRef = useRef(0);
  /**
   * The playhead when the heartbeat last looked, so it measures real movement.
   *
   * `-1` IS "NOT MEASURED YET", and the sentinel earns its keep: a new media item
   * starts at 0, so anchoring on 0 and then reading a 30-second playhead would
   * report thirty seconds of progress that nobody watched — and hand the walk its
   * budget back on the strength of it. The first look after an item change only
   * records the anchor.
   */
  const stableAnchorRef = useRef(-1);
  /**
   * This re-open is a RECOVERY one (a hop, a bitrate step, a soft reload), not
   * the viewer's own open. Such a re-open passes `useCaching: false` — see the
   * note at the `source` object.
   */
  const recoveryOpenRef = useRef(false);
  /** Source URLs this episode has already been judged silent on. Once each. */
  const silentUrlsRef = useRef<Set<string>>(new Set());
  /** Silent-source hops spent this episode. Bounded by MAX_SILENT_HOPS. */
  const silentHopsRef = useRef(0);
  /** Extra first-frame windows granted to a source that is genuinely downloading. */
  const frameWatchdogStretchRef = useRef(0);
  /**
   * A recovery is in flight and the picture is not.
   *
   * The ring's own guarantee. `seekPending` covers a seek and `health` covers a
   * frozen playhead, but a hop, a bitrate step or an in-place reload all spend a
   * moment with NO source attached — a state whose buffer readout is unknowable
   * and whose first frame has not arrived, which used to render as a frozen
   * frame with no feedback (the 4/7 → 5/7 report). Cleared by a rendered frame,
   * the first `timeUpdate` after the action, or the error card.
   */
  const [recovering, setRecovering] = useState(false);
  const recoverStreamRef = useRef<
    (ahead: number | null, frozenMs: number, growing: boolean) => void
  >(() => {});
  /**
   * WHICH load() owns the pipeline's next state writes.
   *
   * Incremented at every `load()` start. Everything the load path writes after
   * an await — `setSources`, `setError`, `setResolving` — checks its generation
   * first. Without this, two concurrent loads interleave: a Retry double-tap,
   * or a failover wrap that starts a re-resolve while a previous one is still
   * in flight, lets the older resolve's `setSources` land AFTER the newer one's
   * and the player ends up loading a source list from an attempt that was
   * already replaced.
   */
  const loadGenRef = useRef(0);
  /** True while a `load()` is in flight — the failover wrap joins it instead of starting a second resolve. */
  const loadBusyRef = useRef(false);
  /** Latest `error`, readable inside callbacks without re-creating them. */
  const errorRef = useRef<string | null>(null);
  /**
   * The connectivity verdict, mirrored for callbacks.
   *
   * A ref rather than reading the hook's value through a dependency: the
   * frame watchdog, the health tick and `failover` are re-created only when
   * their real inputs change, and adding `offline` to all of them would
   * rebuild the listener battery every time the phone changes cell.
   */
  const offlineRef = useRef(false);
  offlineRef.current = offline;
  /**
   * Set when a failure was SUPPRESSED because the device was offline.
   *
   * The suppression is the correct behaviour while offline, but it must not
   * silently swallow the attempt: on reconnect there has to be something that
   * says "that source was never actually retried". `failover`, the frame
   * watchdog and a failed `replaceAsync` all set it; the reconnect effect
   * clears it and retries once.
   */
  const offlineBlockedRef = useRef(false);
  /** Previous connectivity verdict, for edge detection in the reconnect effect. */
  const wasOfflineRef = useRef(false);
  /** Where playback was when the connection dropped, for resume after reconnect. */
  const offlinePositionRef = useRef(0);
  /** Whether a 429 has already earned its one in-place retry this attempt. */
  const rateLimitRetryUsedRef = useRef(false);
  /** Pending 429 retry timer, so unmount can cancel it. */
  const rateLimitRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * The extension id whose pref was last WRITTEN. The guard against a disk
   * write per frame: `onFirstFrame` fires per source load (quality switches
   * included), and the same extension re-proving itself is not news.
   */
  const lastSavedExtRef = useRef<string | null>(null);
  /**
   * THE VIEWER'S PLAY INTENT, not the pipeline's.
   *
   * `player.playing` is the wrong thing to ask around a reload: mid-load the
   * audio and the UI still claim "playing" (the same trap the health module
   * documents), and by the time a replace resolves the user may have tapped
   * pause. So the wheel is captured where the viewer turns it — the play/pause
   * buttons — and every RELOAD path afterwards (failover hop, token refresh,
   * quality switch, full re-resolve) honours it: press play again, or land
   * paused and stay there.
   *
   * This is the device verdict of 9 Nov: slow connection, pause during the
   * initial buffering, and the frame watchdog wrote the paused, frame-less
   * stream off, hopped to the next source and pressed play — the episode
   * resumed itself. `true` because a cold open auto-plays; only the viewer's
   * own tap sets it false, and only their tap sets it back.
   */
  const desiredPlayingRef = useRef(true);

  /**
   * The player, for callbacks declared ABOVE it.
   *
   * `useVideoPlayer` comes after this watchdog in the component body, and a
   * `player` reference in a dependency array is evaluated during that earlier
   * render — a temporal dead zone rather than a lint complaint. A ref assigned
   * once after creation is the same shape the presence and progress paths
   * already use.
   */
  const playerRef = useRef<VideoPlayer | null>(null);

  const clearFrameWatchdog = useCallback(() => {
    if (frameWatchdogRef.current) clearTimeout(frameWatchdogRef.current);
    frameWatchdogRef.current = null;
  }, []);

  /**
   * Give the current source a bounded window to show a pixel. Written off —
   * i.e. failed over — if it does not.
   */
  const armFrameWatchdog = useCallback(() => {
    clearFrameWatchdog();
    frameWatchdogRef.current = setTimeout(() => {
      frameWatchdogRef.current = null;
      if (firstFrameRef.current) return;
      // OFFLINE IS NOT A DEAD SOURCE. The window exists to write off a source
      // that cannot render; a phone with no radio has not told us anything
      // about the source at all. Mark the blocked attempt and let the reconnect
      // effect reopen it — re-arming here would just repeat this timer every
      // 14 seconds for the whole time the viewer is in a tunnel.
      if (offlineRef.current) {
        offlineBlockedRef.current = true;
        return;
      }
      // A PAUSED VIEWER IS NOT A STALLED SOURCE.
      //
      // The pipeline cannot render a frame while paused, so "no frame has
      // arrived" against a paused stream measures the viewer's choice, not the
      // network. Acting on it is what produced the device report "I paused and
      // it resumed" (9 Nov): this watchdog failed the healthy stream over, and
      // the replace path below pressed play. So while the intent is paused the
      // timer RE-ARMS instead of acting — the write-off happens the moment the
      // viewer plays again and the window is still unanswered, never while
      // their finger holds the wheel.
      if (!desiredPlayingRef.current) {
        armFrameWatchdog();
        return;
      }
      /**
       * SLOW IS NOT DEAD.
       *
       * Fourteen seconds of silence used to write a source off and hop, even
       * when the pipeline was plainly downloading — a slow CDN at 480p takes
       * longer than 14s to reach a first frame, and the hop threw away every
       * byte it had. Media already buffered is proof the source WORKS, so it
       * earns exactly one extra window. One only: a source that buffers but
       * never renders is a decoder problem the recovery ladder handles with a
       * soft reload, not something more patience can fix.
       */
      const bufferedNow = playerRef.current?.bufferedPosition ?? -1;
      if (bufferedNow > 0 && frameWatchdogStretchRef.current < 1) {
        frameWatchdogStretchRef.current += 1;
        armFrameWatchdog();
        return;
      }
      if (playbackProgressRef.current) {
        // The stream is advancing, so changing servers cannot fix this. Give
        // Android's native view one clean mount on the same player/source first.
        if (!frameRecoveryUsedRef.current) {
          frameRecoveryUsedRef.current = true;
          firstFrameRef.current = false;
          setFirstFrame(false);
          setVideoViewRevision((revision) => revision + 1);
          frameWatchdogRef.current = setTimeout(() => {
            frameWatchdogRef.current = null;
            if (firstFrameRef.current) return;
            resumeSeekAfterFrameRef.current = null;
            void clearPosition(animeId, epNum);
            setError('The video frame did not render. I cleared this episode\'s saved position; try again to start from the beginning or choose another source.');
          }, FRAME_RECOVERY_TIMEOUT);
          return;
        }
        // Changing servers cannot fix a renderer that has already been
        // recreated once. Keep the current stream and offer a clear action.
        resumeSeekAfterFrameRef.current = null;
        void clearPosition(animeId, epNum);
        setError('The video frame did not render. I cleared this episode\'s saved position; try again to start from the beginning or choose another source.');
        return;
      }
      failoverRef.current();
    }, FIRST_FRAME_TIMEOUT);
  }, [clearFrameWatchdog, animeId, epNum]);

  // -------------------------------------------------------------------------
  // Player
  // -------------------------------------------------------------------------
  const player = useVideoPlayer(null, (p) => {
    p.timeUpdateEventInterval = 0.5;
    // Keep the screen on regardless of playing state: a paused frame with the
    // screen dimmed mid-episode reads as the app having hung.
    // Keep-awake is driven by the focused + playing effect above; default off so
    // a freshly created player never lights the screen on its own.
    p.keepScreenOnWhilePlaying = false;
    // NEVER OUTLIVE THE SCREEN. This app is a video player, not a music player:
    // the episode is expected to stop when the phone is locked, and the config
    // plugin deliberately does NOT enable background playback. Stated here as
    // well because it is the native half of the rule `lib/player/pip.ts` owns.
    p.staysActiveInBackground = false;
    applyTuning(p, tuningFor());
  });

  // Read by the frame watchdog, which is declared before the player exists.
  playerRef.current = player;

  /**
   * `statusChange` is deliberately NOT read through `useEvent` here.
   *
   * It was, purely to drive the old `spinVisible` debounce, and that is the
   * signal the health module replaced — see the note where `spinVisible` used to
   * be. The `statusChange` listener further down still exists; it carries the
   * resume-seek and the error path, both of which are effects rather than
   * render state.
   */
  const { isPlaying: isPlayingEvent } = useEvent(player, 'playingChange', { isPlaying: player.playing });

  // Keep-awake: only while this screen is focused AND the video is playing.
  // Paused playback (or a backgrounded player) lets the device sleep, and
  // navigating away no longer leaves the display lit. PiP keeps the screen on
  // through the OS media session.
  useFocusEffect(
    useCallback(() => {
      focusedRef.current = true;
      player.keepScreenOnWhilePlaying = playing;
      return () => {
        focusedRef.current = false;
        player.keepScreenOnWhilePlaying = false;
      };
    }, [player, playing])
  );
  useEffect(() => {
    if (focusedRef.current) player.keepScreenOnWhilePlaying = playing;
  }, [player, playing]);

  /**
   * The health monitor's running state. A ref, not `useState` — it is read,
   * folded and written once a second for the whole life of the screen, and every
   * one of those writes through React would re-render the player four times a
   * minute for a value nothing renders. See `observeHealth`.
   */
  const healthRef = useRef<HealthState | null>(null);
  /**
   * IS THE APP ON SCREEN? The gate for the two timers that only exist to serve a
   * picture — the health tick and the subtitle cue tick (see the `AppState`
   * effect below). A sample taken while the app is away measures the app's own
   * absence, not the stream, and on Android a backgrounded app's timers fire in
   * bursts that look exactly like stalls.
   */
  const appActiveRef = useRef(AppState.currentState === 'active');
  /**
   * The monitor's state, seeded on first use.
   *
   * `null` until something has actually read it, rather than
   * `useRef(resetHealth(Date.now()))`. A `useRef` initialiser is re-evaluated on
   * every render even though its result is discarded after the first, so a clock
   * read there is both an impure call during render (which `react-hooks/purity`
   * correctly refuses) and a value that disagrees with itself depending on when
   * a render happened to occur.
   *
   * Lazy also gives the right answer for the first sample: `resetHealth(at)` at
   * the tick's own timestamp means the clock starts when the monitor starts
   * observing, rather than at a moment chosen by an unrelated render.
   */
  const readHealth = useCallback((at: number): HealthState => {
    if (healthRef.current === null) healthRef.current = resetHealth(at);
    return healthRef.current;
  }, []);
  /**
   * How often the monitor samples the player.
   *
   * 1s, and NOT `timeUpdateEventInterval` (0.5s). The monitor's slowest decision
   * is `STALL_MS` (15s) and its fastest meaningful one is the buffer readout,
   * so doubling the sampling rate doubles the cost of every tick to sharpen
   * nothing a person can see. It also runs on its own clock rather than off
   * `timeUpdate`, because the player STOPS emitting `timeUpdate` precisely when
   * it stalls — a monitor driven by the event it exists to detect never runs
   * during the one condition it was written for.
   */
  const HEALTH_TICK_MS = 1000;

  /**
 * The stored resume position for THIS episode, and whether we have it yet.
 *
 * ⚠️ THE READ USED TO START ON `readyToPlay`, WHICH IS WHY THE PLAYER PLAYED FROM
 * ZERO AND THEN JUMPED BACK.
 *
 * The old order was: `replaceAsync` → the player loads and **starts playing at
 * 0** → first frame renders at 0 → `readyToPlay` fires → `await
 * loadPosition(...)` (an AsyncStorage round trip) → seek to the real position.
 *
 * So on every cold open of a resumed episode the viewer got: a frame at 0:00,
 * audio running from the beginning, a timeline reading `0:00 / 24:13` with the
 * knob at the start — and then a jump backwards to where they actually were. The
 * timeline was not lying about a position the player had; the player really was
 * at zero, for about as long as it took to read one storage key.
 *
 * The read is a few milliseconds and the network is hundreds, so starting it at
 * MOUNT rather than on readiness means it has resolved long before the first
 * frame — and `resumeSeekAfterFrameRef` is therefore already populated when
 * `onFirstFrame` runs, so the resume lands *with* the first frame instead of
 * after it.
 *
 * Deliberately NOT reset by the source-load effect. A quality switch or a
 * failover carries the position across itself (`pendingSeek`) and does not
 * re-derive a resume, so blanking the timeline for a storage read on every
 * source change would be a flicker for no reason. It resets per EPISODE only.
 */
const resumePromiseRef = useRef<Promise<number> | null>(null);

/** Read the stored position once per episode, and only once. */
const loadResumeOnce = useCallback((): Promise<number> => {
  if (!resumePromiseRef.current) {
    resumePromiseRef.current = loadPosition(animeId, epNum);
  }
  return resumePromiseRef.current;
}, [animeId, epNum]);

useEffect(() => {
  resumePromiseRef.current = null;
  setResumeSettled(false);
  void loadResumeOnce();
}, [animeId, epNum, loadResumeOnce]);

/**
 * Show the line for a playhead — or clear it when the playhead is a
 * PLACEHOLDER.
 *
 * Every sampler feeds the overlay through here: `timeUpdate`, the 120ms cue
 * tick, a track landing, each seek, and the app coming back to the
 * foreground. They all have to agree about the one case that is not a real
 * time — a media replace leaves the native playhead at 0 while the position
 * to restore waits for a frame, so 0 there means "not known yet".
 * `lib/subtitles/clock.ts` owns that rule so it cannot drift between the
 * callers; this is the only writer of the live cue.
 *
 * A stable identity (refs only), so it can join every listener's dependency
 * list without rebuilding the listener battery on each render.
 */
  const showCueAt = useCallback((playhead: number) => {
    // PARKED WHILE THE PiP WINDOW IS COMING BACK — see `onPipStop` and
    // `PIP_SUBS_SETTLE_MS`. Clearing rather than staying quiet matters: the line
    // left on screen from before the exit is the one being painted into a band
    // that is still moving, and that is the glitch the viewer sees.
    if (Date.now() < subsHoldUntilRef.current) {
      publishCue(null);
      return;
    }
    const armed = pendingSeek.current != null || resumeSeekAfterFrameRef.current != null;
    const at = cueLookupTime(playhead, armed);
    // A FRAME, not one cue: a sign and a voice line (or two voices) can be open
    // at the same playhead, and the old single-cue lookup silently dropped all
    // but the first. `buildSubtitleFrame` keeps the dialogue and stacks signs
    // above it; see `lib/subtitles/frame.ts`.
    publishCue(at == null ? null : buildSubtitleFrame(cuesRef.current, at, subsDelayRef.current));
  }, []);

const applyResumePosition = useCallback((resumeAt: number) => {
    const duration = player.duration || 0;
    if (duration > 0 && resumeAt >= duration - 30) {
      void clearPosition(animeId, epNum);
      setResumeSettled(true);
      showCueAt(player.currentTime);
      return;
    }
    if (resumeAt > 10) {
      // The single most important seek in the player, and the one most likely
      // to stall: a resume position is by definition somewhere the viewer has
      // not just been, so it is unbuffered by construction. Without the grace
      // this is the seek that would fail the episode over on a slow connection.
      const now = Date.now();
      healthRef.current = noteSeek(readHealth(now), now);
      player.currentTime = resumeAt;
      // Mirror the target immediately: a cue list that lands a moment later
      // reads `positionRef`, and the 0 a replace left there would briefly be
      // the answer — the same reason `seekWithGrace` mirrors its own target.
      positionRef.current = resumeAt;
      // THE LINE IS PART OF "WHERE WE WERE". Publishing the target's cue in
      // the same tick as the seek is what stops the opening line (or no line
      // at all) from surviving until the next sampler — and a resume seek is
      // exactly when the viewer is looking at the frame instead of the
      // timeline.
      showCueAt(resumeAt);
    } else {
      // Nothing worth resuming: the item is effectively at the start, and the
      // tick must not wait to say so.
      showCueAt(player.currentTime);
    }
    setResumeSettled(true);
  }, [player, animeId, epNum, readHealth, showCueAt]);

  const onFirstFrame = useCallback(() => {
    firstFrameRef.current = true;
    setFirstFrame(true);
    clearFrameWatchdog();
    // THE PICTURE IS BACK, so the failing stretch is over. The action count and
    // the reload budget restart; the reductions that earned this frame do not
    // (see `noteRecovered`), because re-offering the rung that starved is how a
    // player ends up oscillating on a weak connection.
    recoveryRef.current = noteRecovered(recoveryRef.current);
    setRecovering((prev) => (prev ? false : prev));
    // Publish the cue for the frame that just landed, so subtitles are not
    // waiting for the next 120ms tick (or the next timeUpdate) to appear —
    // which on a resume from a saved position read as "subs take a moment to
    // catch up". The tick below keeps them current afterwards.
    //
    // A RESTORE ARMED ACROSS THIS FRAME OWNS THE LINE: the playhead is still
    // a placeholder here (the seek below is what moves it), so publishing now
    // would paint the episode's OPENING line over a resumed mid-episode frame
    // for as long as the seek takes to land. `applyResumePosition` publishes
    // at the target in the same tick.
    if (resumeSeekAfterFrameRef.current == null) showCueAt(player.currentTime);

    // RESUME BACKSTOP. `readyToPlay` is the primary trigger, but on some
    // devices it never fires (or fires before the mount-time read resolves),
    // which left the stored position applied nowhere and the episode starting
    // from 0:00. If the resume has not been handled yet, do it here — the
    // frame that just landed is proof the pipeline is ready, which is the
    // condition `applyResumePosition` was waiting for.
    if (!sought.current) {
      void loadResumeOnce().then((pos) => {
        if (sought.current) return;
        sought.current = true;
        if (pos > 10) {
          applyResumePosition(pos);
        } else {
          setResumeSettled(true);
        }
      });
    }
    // ⚠️ ONE FRAME IS NOT PROOF, AND THIS USED TO SAY IT WAS.
    //
    // The line here was `budgetRef.current = freshBudget()`, and it is what made
    // the walk endless on a weak connection: hop → a frame lands → every budget
    // back to zero → stall fifteen seconds later → hop → … `wrapVerdict` can
    // only give up once three WHOLE walks are spent, so it never did, and each
    // pass re-resolved every extension and re-opened the native media source.
    // `expo-video` prepares that source on the Android MAIN thread, and with the
    // disk cache on (the default) it takes the cache index's lock — which a
    // stalled segment download is holding. That is the freeze: the picture
    // stops, the spinner stops, and Android eventually closes the app.
    //
    // Forgiveness now comes only from the stability heartbeat below: a minute
    // with no stall and a playhead that really moved. A source that renders one
    // frame and dies earns nothing, which is the whole point of the walk.

    /**
     * 🎧 SILENCE IS A FAILURE MODE, AND NOTHING ELSE LOOKS FOR IT.
     *
     * See NO_AUDIO_GRACE_MS. The row is captured by IDENTITY: a source hop
     * between the frame and the check must cancel the verdict, or the guard
     * would blame the next source for this one being silent.
     */
    const sourceAtFrame = sourcesRef.current[srcIndexRef.current];
    const watchForAudio = (delay: number, last: boolean) => {
      audioGuardRef.current = setTimeout(() => {
        audioGuardRef.current = null;
        if (!mountedRef.current) return;
        if (sourcesRef.current[srcIndexRef.current] !== sourceAtFrame) return;
        // RELEASED-PLAYER GUARD. This timer outlives a back press by up to 3s,
        // and `useVideoPlayer` releases the native object on unmount: reading a
        // property then throws "cannot use shared object that was already
        // released" from inside a setTimeout, which is a red box on the way out
        // of the player, not a playback fault. The unmount cleanup clears this
        // timer; this is the belt to that braces.
        let tracks = 0;
        try {
          tracks = player.availableAudioTracks.length;
        } catch {
          return;
        }
        if (tracks > 0) return;
        if (!last) {
          watchForAudio(NO_AUDIO_RECHECK_MS, true);
          return;
        }
        /**
         * BOUNDED, ONCE PER SOURCE, AND ONLY WHILE THE ITEM IS YOUNG.
         *
         * A zero-length `availableAudioTracks` read is a snapshot of a list the
         * decoder is still filling, so it is only trusted at an item's start —
         * where a truly video-only rendition is silent by construction. Once per
         * URL and at most `MAX_SILENT_HOPS` per episode, because every hop
         * re-opens the native media source on the main thread and an unbounded
         * silence walk is exactly the churn that froze this app.
         */
        if (positionRef.current > SILENCE_MAX_POSITION_S) return;
        const silentUrl = sourceAtFrame?.url ?? '';
        if (!silentUrl || silentUrlsRef.current.has(silentUrl)) return;
        if (silentHopsRef.current >= MAX_SILENT_HOPS) return;
        silentUrlsRef.current.add(silentUrl);
        silentHopsRef.current += 1;
        // Deliberately NOT a ledger trip: one silent server must not hide the
        // provider's other rows, which are separate tokens on other hosts.
        failoverRef.current(NO_AUDIO_MESSAGE);
      }, delay);
    };
    watchForAudio(NO_AUDIO_GRACE_MS, false);

    // RECONCILE. A rendered frame is the one fact every failure verdict was
    // waiting for, and it outranks all of them. Every path that sets `error`
    // acts on the evidence available at its moment — the walk budget, the
    // frame watchdog, the resolve deadline — and the 13 Nov device report was
    // exactly a verdict firing while the pipeline was still working: the card
    // came up over an episode that then started playing. The decision lives in
    // `lib/player/failover.ts` (`healOnFrame`) so the check battery drives the
    // real rule; it heals ALL of those races in one place, whatever set them:
    // if the verdict was right, no frame ever arrives and the card stays; if
    // it was premature, the frame arrives and the card was a lie. `failure`'s
    // engine message is deliberately KEPT — it describes the previous source,
    // and the next card that ever shows wants the most recent failure's words.
    //
    // The error path also PAUSES the player (see the `if (error) player.pause()`
    // effect), so a healed verdict must un-pause in the same breath — the
    // viewer's own wheel (`desiredPlayingRef`), not the pipeline's, decides.
    const healed = healOnFrame(errorRef.current, desiredPlayingRef.current, player.playing);
    if (healed.clearError) {
      errorRef.current = null;
      setError(null);
      if (healed.resume) player.play();
    }

    // THE SOURCE MEMORY'S WRITE RULE — proven, not chosen. A frame on this
    // source is the evidence it plays, which is the only fact worth
    // remembering: a source that was hopped past renders no frame and is
    // never pinned as "the one that worked". The failover walk landing
    // somewhere lower therefore rewrites the memory by itself, and a dead top
    // source unpins naturally. Re-proving the same extension (a quality
    // switch) writes nothing — `lastSavedExtRef` is the disk-write guard.
    const proven = sourcesRef.current[srcIndexRef.current];
    // SESSION PROOF. A frame is the only fact the ledger trusts: it clears a
    // skip this source may have picked up earlier (a provider that recovers
    // mid-session is welcome back immediately) and makes it the first choice
    // for every episode from here on. The per-anime write below stays the same
    // disk-backed preference.
    if (proven?.extId && noteSourcePlayed(proven.extId)) bumpLedger();
    if (proven?.extId && proven.extId !== lastSavedExtRef.current) {
      lastSavedExtRef.current = proven.extId;
      void saveSourcePref(animeId, proven.extId);
    }
    // THE QUALITY MEMORY'S WRITE RULE is the frame rule too. A rung that is
    // locked AND rendering is the rung that works here; a pick that never
    // produced a picture is not evidence, so nothing is written for it. Auto
    // (no selection) writes nothing here — `onPickQuality` is where an
    // explicit Auto CLEARS the memory.
    const locked = qualitySelRef.current;
    // A rung the RECOVERY ladder stepped down into is a fact about this
    // connection, not a preference for this show. Persisting it would make one
    // slow minute the permanent quality of the series.
    if (locked && locked.src === srcIndexRef.current && !autoQualityRef.current) {
      const label = variantsRef.current[locked.src]?.[locked.v]?.label;
      if (label && label !== qualityPrefRef.current) {
        qualityPrefRef.current = label;
        void saveQualityPref(animeId, label);
      }
    }

    // Resume only after a decoded frame exists. Seeking an old HLS position
    // while Android is still attaching its surface can leave audio/time moving
    // over a black VideoView. A remembered position that is effectively past
    // the runtime is stale, so discard it and start the episode normally.
    const resumeAt = resumeSeekAfterFrameRef.current;
    if (resumeAt == null) return;
    resumeSeekAfterFrameRef.current = null;
    // The restore has LANDED — it must not survive as `pendingSeek`, or the
    // next `readyToPlay` (every refill fires one) would replay the seek and pin
    // the playhead backwards, the loop this file already documents.
    pendingSeek.current = null;
    applyResumePosition(resumeAt);
  }, [applyResumePosition, clearFrameWatchdog, player, animeId, loadResumeOnce, showCueAt, bumpLedger]);

  /**
   * Engine/decoder/buffer profile, resolved ONCE per mount.
   *
   * Once, because `surfaceType` is documented as "should not be changed at
   * runtime" — it is read when the native surface is built, so a change has to
   * come from remounting the `VideoView`, not from a re-render. The player is
   * fullscreen, so there is no route underneath it where the settings screen
   * could have changed the value anyway.
   */
  const tuning = useMemo(() => tuningFor(), []);

  /**
   * The two buffer thresholds, derived from the buffer horizon this player is
   * actually configured with.
   *
   * Passed INTO the health module rather than hardcoded at the call site,
   * because "how many seconds ahead is too few" is not a constant — it is a
   * fraction of whatever the user chose in Buffer settings. A monitor that
   * judged a 15-second-ahead Low profile against a 30-second floor would report
   * a permanent emergency on a healthy stream, and an adaptive monitor that
   * reacts to its own false alarms walks the quality ladder to the bottom.
   * See `healthProfile`'s header for that argument in full.
   */
  const healthBounds: HealthProfile = useMemo(
    () => healthProfile(tuning.bufferOptions?.preferredForwardBufferDuration ?? 20),
    [tuning]
  );

  useEffect(() => setPlaying(isPlayingEvent), [isPlayingEvent]);

  /**
   * NO `spinVisible` STATE ANYMORE, and this is where its replacement is
   * declared.
   *
   * It used to be a 350ms debounce on `statusChange === 'loading'`. That was the
   * right idea — a stall shorter than the threshold never earns a ring — keyed
   * on the wrong signal, because `VideoPlayerStatus` has no 'buffering' member:
   * a mid-playback refill reports 'loading', exactly as the initial load does,
   * and every `currentTime` written into unbuffered territory produces one. So
   * it fired while the frame was still ADVANCING through the last two seconds of
   * buffer, which is precisely the case where showing a spinner is wrong.
   *
   * The health module answers it from evidence instead: a frozen playhead, held
   * still for `REBUFFER_HINT_MS`, within the grace a seek earns. That cannot
   * fire on a moving frame, cannot fire twice for one refill, and carries the
   * three distinctions a single boolean could not — `rebuffering`, `starving`
   * and `stalled` are three different situations with three different remedies.
   */

  // -------------------------------------------------------------------------
  // Refs — everything the callbacks need without re-creating the callbacks
  // -------------------------------------------------------------------------
  const sourcesRef = useRef<WatchSource[]>([]);
  sourcesRef.current = sources;
  const srcIndexRef = useRef(0);
  srcIndexRef.current = srcIndex;
  // The error mirror `onFirstFrame` reads — kept in the same render-synced
  // block so the callback's identity does not churn on every error change.
  errorRef.current = error;
  const variantsRef = useRef(variantsBySource);
  variantsRef.current = variantsBySource;
  const qualitySelRef = useRef(qualitySel);
  qualitySelRef.current = qualitySel;
  /**
   * The viewer's subtitle sync correction, for the two SAMPLERS that read it.
   *
   * Both the `timeUpdate` listener and the subtitle tick below live in an effect
   * keyed on the media item, not on the settings — re-creating that effect (and
   * re-adding every listener) every time the sync slider moves would be absurd,
   * and the listener would still close over a stale value. A render-synced ref
   * is the same answer the file already uses for `sourcesRef` and `qualitySelRef`.
   */
  const subsDelayRef = useRef(subsDelayMs);
  subsDelayRef.current = subsDelayMs;
  /**
   * Whether the VIEWER has steered quality this attempt.
   *
   * The distinction the default-quality applier turns on: `qualitySel ===
   * null` means both "auto because nothing was chosen yet" and "auto because
   * the viewer pressed Auto", and only the first is the applier's business —
   * without this flag the applier would re-lock the default the instant a
   * viewer pressed Auto, making that button a lie. Set by every manual pick
   * (a rung OR Auto), cleared by a fresh resolve in `applyResolve`.
   */
  const qualityChosenRef = useRef(false);
  /**
   * The rung that last actually PLAYED for this anime (`miori:qPref:{id}`).
   *
   * Read once per open (in `load`, alongside the source memory) and kept in a
   * ref because the default-quality applier below reads it in an effect that
   * must not re-run on every render. It is the QUALITY half of the source
   * memory's argument: the applier used to take `player.defaultQuality` — a
   * guess from Settings — over the 1080p that had rendered ten seconds earlier,
   * so backing out to the details page and returning silently changed the rung.
   */
  const qualityPrefRef = useRef<string | null>(null);
  const playedRef = useRef(false);
  /**
   * Set when the stream reaches its end and NOTHING follows — the parked
   * finale, where an airing show has no next episode and a finished one has run
   * out. `expo-video` leaves the engine in an ended state there where `play()`
   * does not restart by itself, so the transport's ▶ would look dead on the one
   * tap meant to restart the episode. `onPlayPause` reads this to rewind to the
   * top first; every seek clears it, because once the playhead is off the end a
   * manual scrub has already left the parked state behind.
   */
  const endedRef = useRef(false);
  /**
   * One-shot guard for the resume seek. See the `readyToPlay` listener for why
   * re-applying it on every readiness is an infinite seek loop.
   */
  const sought = useRef(false);
  /**
   * A position to restore after the NEXT media replace, consumed on read.
   * Set by a quality/source switch so the switch does not dump the viewer back
   * at 0:00.
   */
  const pendingSeek = useRef<number | null>(null);
  const failoverRef = useRef<(reason?: string) => void>(() => {});
  /**
   * Sources whose self-healing `refresh()` has already been tried this resolve,
   * by index — one attempt per source per `load()`, so a genuinely broken source
   * cannot turn the failover walk into a refresh loop.
   */
  const refreshedRef = useRef<Set<number>>(new Set());
  /** Synchronous guard so two failover calls in one tick cannot both refresh. */
  const refreshBusyRef = useRef(false);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const presenceTitle = useRef('');
  const presenceMedia = useRef<PresenceMedia | undefined>(undefined);
  const syncProgressRef = useRef<(ep: number) => Promise<unknown>>(async () => {});
  const progressSynced = useRef(false);
  const syncCooldownUntil = useRef(0);
  /**
   * Whether there is an account to sync TO. Read through a ref for the same
   * reason every other value in the 82% rule is: the `timeUpdate` listener's
   * deps must not grow.
   */
  const signedInRef = useRef(false);
  const lastSaved = useRef(0);
  const totalEpsRef = useRef(0);
  totalEpsRef.current = totalEps;
  const positionRef = useRef(0);
  const durationRef = useRef(0);
  /**
   * AUTO-ADVANCE. The episode number `playToEnd` may hand the viewer to, or
   * null to stay parked. Computed in the render body (so a late AniList
   * payload or a source list landing re-derives it) and read through the ref
   * by the `playToEnd` listener, whose deps must not grow with every merge —
   * the same shape as `totalEpsRef` above.
   */
  const autoAdvanceRef = useRef<number | null>(null);
  /**
   * THE ONE ANSWER TO "IS THERE AN EPISODE AHEAD" — shared by every control that
   * asks it: the `playToEnd` countdown (through `autoAdvanceRef`), the
   * transport's ⏭ and `onNext`.
   *
   * The transport used to ask a DIFFERENT question — `epNum < totalEps`, where
   * `totalEps` is `Media.episodes`, the SEASON TOTAL. On a still-airing show
   * those two answers disagree for the entire run: at episode 3 of a 12-episode
   * season that has aired 3, the button stayed white and tapping it resolved
   * episode 4 — which does not exist yet — into an error card in the middle of a
   * binge. The countdown, meanwhile, correctly declined to fire, so the same
   * player was telling the viewer two different things.
   *
   * `releasedCount` is the authority on what has aired (see
   * `nextPlayableEpisode`), so the button now greys out exactly when the
   * countdown would decline to queue anything — "we have played everything that
   * exists" is one state, drawn once.
   *
   * Null also covers "no evidence yet" (no AniList payload): ⏭ is dim for the
   * few hundred milliseconds a deep link spends before metadata lands, which is
   * the honest state — a press then would be a guess at an unwatched episode.
   */
  const nextAired = nextPlayableEpisode(epNum, mediaDetail ?? undefined);
  autoAdvanceRef.current = nextAired;
  /**
   * A fence around an EPISODE SWITCH.
   *
   * `goToEpisode` keeps this screen mounted (`router.setParams`) so the player
   * and its buffer survive "next episode". That means there is a window where
   * `epNum` already names the NEXT episode while the player still holds the
   * previous media item. Every progress write is keyed by `epNum`, so without
   * this fence the old playhead — and the old item's 82% check — would be filed
   * under the new episode's key: the episode the viewer is about to watch would
   * be credited with the minutes they just watched of the one before it, and
   * that could even mark it watched.
   *
   * The old media is paused at the same moment, so no ticks are expected; this
   * is the net under the race, not the mechanism. It clears when the replace
   * for the new item starts.
   */
  const mediaSwitchRef = useRef(false);
  /**
   * THE SWITCH GATE — `mediaSwitchRef` fences WRITES, this fences TOUCHES.
   *
   * Between `goToEpisode` and the moment the new list reaches the player, this
   * screen is still holding the OLD media: paused, seconds from being replaced.
   * Every control on screen still points at it, and the ones that WRITE are the
   * problem — a skip or a double-tap seek issues a `seekBy` on the dying item
   * and arms a seek-grace window the arriving episode inherits, a ▶ tap
   * rewrites `desiredPlayingRef` so the episode that is still resolving comes up
   * paused, and a source or quality pick lands on a ladder that is about to be
   * thrown away. None of that is what "next episode" meant.
   *
   * So the rule every streaming app follows: during a transition the transport
   * is gone and the frame is not a remote — not even a tap, which would only
   * raise an overlay that describes the wrong episode. What stays is the EXIT:
   * a back arrow at the top bar's own back seat (`TopBar`'s `off` mode) plus
   * the untouched hardware back handler. Without that arrow an iOS viewer would
   * have a spinner, no controls, and no hardware key to press.
   *
   * The gate LIFTS ITSELF the moment the new item is handed to the player (and
   * on the error card), so a resolve that fails cannot lock anyone in.
   *
   * The UI reads it as `switchPending && resolving`, not as this alone: a
   * resolve-cache hit (the return trip from the details page, or the auto
   * advance's prefetch) lands in the same commit as the tap, and hiding the bar
   * for one frame there would be a blink, not a transition.
   */
  const [switchPending, setSwitchPending] = useState(false);
  /** The gate, as the gesture handlers read it — they must not re-create on it. */
  const switchingRef = useRef(false);
  // Presence bookkeeping for the event-driven pushes (see the listeners
  // effect): whether the timeline has been sent (duration only becomes real
  // some ticks into playback — before that the card carries no end timestamp,
  // which is the "no timeline, just a count" report), and the 5-minute
  // position bucket last sent (discord.ts buckets the same way; a changed
  // bucket is a seek or a jump — the card's start/end were minted from the
  // position at push time, so it needs re-anchoring). Both reset per media
  // item in the per-media effect.
  const presenceTimedSent = useRef(false);
  const presenceBucket = useRef(-1);
  const cuesRef = useRef<Cue[]>([]);
  cuesRef.current = cues;

  /**
   * The playhead, on the UI thread.
   *
   * The fix for `progress.md` §Performance #6, which claimed the 2 Hz
   * `timeUpdate` re-render was solved while the bottom bar's subtree still
   * re-rendered twice a second. It now writes this and nothing else: the fill and
   * the knob are animated styles in `ProgressBar`, and the clock is its own
   * memoised component that rounds to whole seconds. Nothing in this screen's
   * render reads `positionSV`, which is the property that makes the win real —
   * a shared value that something still reads through React every tick is just
   * a slower `useState`.
   *
   * It is written from `Chrome`'s own listener rather than here, because that is
   * where the listener already is and a second `timeUpdate` subscription would
   * be a second callback per tick for no benefit.
   */
  const positionSV = useSharedValue(0);
  /**
   * The bottom bar's track width, persisted across the bar's mount/unmount
   * cycles (the chrome auto-hides after 3s and the bar unmounts with it).
   *
   * The knob's position is `playedFraction * trackWidth`, and `trackWidth`
   * used to reset to 0 on every remount until the first `onLayout` landed —
   * a frame or two where the knob sat at the left edge and then jumped. Seeding
   * the next mount from the last measurement removes that flash. See
   * `ProgressBar`'s `trackWidth` shared value.
   */
  const trackWidthRef = useRef(0);

  /**
   * True from the instant a seek is issued until the pipeline is producing
   * frames again — the window in which the picture stands frozen while the
   * audio and the UI still claim "playing". The health monitor cannot say
   * this word for us: a mid-stream seek sends `bufferedPosition` to `-1`
   * (unknowable), which `observeHealth` answers with `unknown` — a verdict
   * that deliberately permits no action, including no spinner. So the
   * honest "nothing is on screen yet" signal for a self-inflicted freeze is
   * the seek itself: set by `seekWithGrace` (and on every media replace),
   * cleared by the first `timeUpdate` arriving later — that event only
   * arrives while frames are being produced, which is the same evidence the
   * health monitor's tick rests on for its own stall clock.
   */
  const [seekPending, setSeekPending] = useState(false);
  /** When the spinner's seek was issued. Read by the `timeUpdate` listener:
   *  a tick ALREADY in flight when the seek dispatched (the event interval
   *  is 0.5s and the pipeline does not stop mid-interval) must not clear
   *  the ring before the seek has even reached `loading`. */
  const seekIssuedAtRef = useRef(0);

  /**
   * Whether a scrub drag is live, as STATE rather than as a player property.
   *
   * This used to be `scrubRef: ScrubState` plus `scrubbingModeOptions`, and the
   * ref existed so a drag could be ended from somewhere other than the gesture
   * — because the gesture wrote something onto the player that had to be written
   * back. With the reversal in `lib/player/scrub.ts` a drag writes NOTHING to the
   * player until release, so there is nothing to end early and no ref to hold it.
   *
   * What survives is the one thing the old machinery got right by accident: the
   * bar must not vanish from under a finger that is still on it. `bottomBarUp`
   * below ORs this in, so the 3s auto-hide cannot unmount `ProgressBar`
   * mid-gesture — which was a drag that silently issued no seek at all.
   */
  const [scrubActive, setScrubActive] = useState(false);

  /**
   * Whether the bottom bar is mounted. Derived HERE rather than down in the render
   * so the scrub handoff below can depend on it. Read the big comment at its
   * original site for what the top/bottom split is for.
   */
  // visibility is store-driven now

  /**
     * ⚠️ THE GESTURE WRITES NOTHING TO THE PLAYER, AND THAT IS THE WHOLE FIX.
     *
     * There used to be ~120 lines here: a `ScrubState` ref, an `applyScrub` that
     * wrote `scrubbingModeOptions` and paused on iOS, an `onScrubPhase` that four
     * call sites had to remember, and two effects that existed to clean up after
     * gestures that died. All of it existed to satisfy one rule — whatever a drag
     * writes, some other path must write it back — and the rule cost two crashes,
     * a frozen picture on both platforms, and a drag that silently issued no seek.
     *
     *   1. `scrubbingModeEnabled: true` SUPPRESSES PLAYBACK on Android (the SDK
     *      says so in the property's own doc comment), and iOS was paused
     *      explicitly, as the SDK also recommends. So on BOTH platforms the frame
     *      under the viewer's finger stopped moving for the whole drag while the
     *      audio ran on. That is the "no smooth playback on drag" report, and it
     *      is indistinguishable from a network fault because it looks exactly
     *      like one.
     *   2. Writing to the player from a cleanup crashed twice — once because
     *      `useVideoPlayer` had already released the native player, and once
     *      because `ProgressBar` reported its own unmount on the strength of an
     *      ordering ("children unmount before parents") that React does not
     *      guarantee and the device disproved. Both were attempts to end a drag
     *      from somewhere other than the gesture.
     *   3. The commit seek ran at the viewer's RESTING tolerance, not the widened
     *      one. `setScrubbing` turned the mode off synchronously and the seek was
     *      dispatched after it, so with the default `exact` precision ExoPlayer
     *      decoded forward from the preceding keyframe and discarded frames to
     *      reach the target. That is the "the video restarts" report.
     *
     * A drag now touches the player zero times. `ProgressBar` keeps its own visual
     * drag state and commits exactly one seek on release — at the widened
     * tolerance, restored in the same tick. All this screen does is keep the bar
     * MOUNTED while that is happening, so the 3s auto-hide cannot pull it out
     * from under a finger that is still down.
     *
     * There is deliberately still NO unmount reset here, and the reason is now a
     * simpler one than it was: **there is nothing on the player to reset.** A
     * teardown that ran after `release()` could not have helped anyway — the
     * native player it would have written to no longer exists.
     */
    const onScrubActive = useCallback((active: boolean) => {
      setScrubActive(active);
  }, []);

  /**
   * A track landing publishes at the CURRENT playhead — through `showCueAt`,
   * so the placeholder rule applies here too: a cached track handed over
   * during a replace must not draw a line for a playhead that is still 0.
   *
   * `subsDelayMs` is a dependency on purpose: the lookup time is the playhead
   * minus the viewer's sync correction, so moving that slider republishes
   * immediately instead of at the next tick.
   */
  useEffect(() => {
    showCueAt(positionRef.current);
  }, [cues, subsDelayMs, showCueAt]);

  const queryClient = useQueryClient();
  // `signedIn` above reads `useUserId()`, a synchronous external store, so it is
  // already correct by the time the player's listeners run. `!= null` counts
  // only a real id as signed in — `undefined` (keychain not read yet) must not
  // fire a request that would just 401.
  signedInRef.current = signedIn;
  const { mutateAsync: syncProgress } = useSyncListProgress(animeId);
  syncProgressRef.current = syncProgress;

  // -------------------------------------------------------------------------
  // SPEED — the one write path to `player.playbackRate`
  // -------------------------------------------------------------------------
  useEffect(() => {
    player.playbackRate = effectiveRate(speed);
  }, [player, speed]);

  /**
   * Persist only the COMMITTED rate.
   *
   * Called from the menu path, never from the hold path. A user who long-presses
   * to 2.5x and lets go must not have written 2.5x into their preferences — the
   * gesture is a momentary accelerator, not a choice.
   */
  const persistSpeed = useCallback((s: SpeedState) => {
    setSetting('player.speed', s.committed);
  }, []);

  const onPickSpeed = useCallback(
    (key: string) => {
      if (key === '__custom') {
        setCustomSpeedText(formatRate(speed.committed));
        setCustomSpeedOpen(true);
        setMenu(null);
        return;
      }
      const rate = Number(key);
      if (!Number.isFinite(rate)) return;
      setSpeed((prev) => {
        const next = commitSpeed(prev, rate);
        persistSpeed(next);
        return next;
      });
      setMenu(null);
    },
    [persistSpeed, speed.committed]
  );

  const applyCustomSpeed = useCallback(() => {
    const rate = Number(customSpeedText.replace(',', '.'));
    if (!Number.isFinite(rate)) {
      setCustomSpeedOpen(false);
      return;
    }
    setSpeed((prev) => {
      const next = commitSpeed(prev, rate);
      persistSpeed(next);
      return next;
    });
    setCustomSpeedOpen(false);
  }, [customSpeedText, persistSpeed]);

  /**
   * Hold-to-boost. `onHoldEnd` ends the OVERRIDE — it does not restore a rate,
   * because there is nothing to restore TO. See `endBoost`.
   */
  const onHoldStart = useCallback(() => {
    setSpeed((prev) => beginBoost(prev));
  }, []);

  const onHoldMove = useCallback((dyPx: number) => {
    setSpeed((prev) => rampBoost(prev, dyPx));
  }, []);

  const onHoldEnd = useCallback(() => {
    setSpeed((prev) => endBoost(prev));
  }, []);

  // -------------------------------------------------------------------------
  // Controls visibility
  // -------------------------------------------------------------------------
  /**
   * Show the chrome AND re-arm the auto-hide window.
   *
   * `pokeNonce` exists because the hide effect fires on STATE CHANGE, and
   * `setShowControls(true)` onto an already-true chrome is a state no-op — so
   * beeping the chrome awake during a burst of double-tap seeks would leave the
   * ORIGINAL countdown running and yank the chrome away mid-burst. The nonce
   * makes every interaction restart the same single countdown the effect owns:
   * "3s of quiet, then hide" — which is the behaviour every real player has and
   * what previously lived in three ad-hoc `hideTimerRef` poke sites (the last
   * of which is why a seek sequence could hide the chrome under the user's
   * thumb).
   */
  const pokeControls = useCallback(() => {
    if (!showControlsRef.current) {
      showControlsRef.current = true;
      setChromeVisible(true);
    } else {
      setChromeVisible(true);
    }
    showControlsRef.current = true;
    setChromeVisible(true);
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    if (menu || panelOpen || locked) return;
    hideTimerRef.current = setTimeout(() => {
      showControlsRef.current = false;
      setChromeVisible(false);
    }, motion.controlsHide);
  }, [menu, panelOpen, locked]);

  const toggleControls = useCallback(() => {
    const s = showControlsRef.current;
    const next = !s;
    if (s) setMenu(null);
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    if (next && !menu && !panelOpen && !locked) {
      hideTimerRef.current = setTimeout(() => {
        showControlsRef.current = false;
        setChromeVisible(false);
      }, motion.controlsHide);
    }
    showControlsRef.current = next;
    setChromeVisible(next);
  }, [menu, panelOpen, locked]);

  useEffect(() => {
    if (menu || panelOpen || locked) {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
  }, [menu, panelOpen, locked]);

  useEffect(() => {
    if (showControlsRef.current && !menu && !panelOpen && !locked) {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
      hideTimerRef.current = setTimeout(() => {
        showControlsRef.current = false;
        setChromeVisible(false);
      }, motion.controlsHide);
    }
    return () => {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(
    () => {
      mountedRef.current = true;
      return () => {
        mountedRef.current = false;
        if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
        if (frameWatchdogRef.current) clearTimeout(frameWatchdogRef.current);
        // THE SILENCE CHECK OUTLIVES THE SCREEN OTHERWISE. It is a 3s+5s timer
        // created on the first frame; backing out inside that window used to
        // leave it armed against a player `useVideoPlayer` had already released,
        // and reading `availableAudioTracks` then threw the "shared object that
        // was already released" red box on the way out.
        if (audioGuardRef.current) clearTimeout(audioGuardRef.current);
        audioGuardRef.current = null;
        // EVERY OTHER TIMER THAT CAN OUTLIVE THIS SCREEN. Each of these holds a
        // callback that touches the native player, and `useVideoPlayer` releases
        // it on unmount — a `player.pause()` from a PiP-exit timer after that is
        // the "shared object that was already released" throw, on the way out of
        // the player, which is the least diagnosable place it can happen.
        if (subsRestoreTimerRef.current) clearTimeout(subsRestoreTimerRef.current);
        subsRestoreTimerRef.current = null;
        if (pipHandoffTimerRef.current) clearTimeout(pipHandoffTimerRef.current);
        pipHandoffTimerRef.current = null;
        if (pipExitTimerRef.current) clearTimeout(pipExitTimerRef.current);
        pipExitTimerRef.current = null;
        if (rateLimitRetryTimerRef.current) clearTimeout(rateLimitRetryTimerRef.current);
        rateLimitRetryTimerRef.current = null;
        // The "up next" card unmounts with this screen and clears its own
        // countdown, so there is no timer left here to cancel.
      };
    },
    []
  );

  // -------------------------------------------------------------------------
  // Loading
  // -------------------------------------------------------------------------
  const load = useCallback(async (opts?: { fresh?: boolean; keepBudget?: boolean }) => {
    if (!linkOk) return;
    /**
     * A FRESH attempt ignores the return-trip cache.
     *
     * Retry, "Change source" with one row, the source picker's Refresh and a
     * failover wrap all call `load({ fresh: true })`: in every one of those the
     * viewer (or the walk) has just watched the cached list fail, and handing
     * it back would be a loop, not a repair. The mount/reconnect path calls
     * `load()` and may reuse the cache — that is the winning case.
     */
    const fresh = opts?.fresh === true;
    /**
     * A WRAP-LOAD CONTINUES A FAILING STRETCH. Every other load is a fresh
     * decision by the viewer (or by the mount), and starts a new budget. Marking
     * this one is what lets the walk reach `MAX_FAILOVER_ROUNDS` and give up
     * instead of re-resolving forever.
     */
    const keepBudget = opts?.keepBudget === true;
    // EPOCH. Every await below is followed by a generation check, so a
    // superseded load (a Retry double-tap, a wrap-load over an in-flight
    // resolve) cannot write state that belongs to a dead attempt.
    const gen = ++loadGenRef.current;
    loadBusyRef.current = true;
    setError(null);
    errorRef.current = null;
    // The previous attempt's engine message must not survive into the next one,
    // or a clean Retry that fails for a different reason shows the old cause.
    setFailure(null);
    /**
     * OFFLINE, BEFORE ANY REQUEST IS OPENED.
     */
    if (isOffline()) {
      const cached = queryClient.getQueryData<MediaDetail>(qk.media(animeId));
      if (cached) {
        setMediaDetail(cached);
        setTotalEps(cached.episodes ?? 0);
        setTitle(mediaTitle(cached.title));
        setSourceEpisodes(episodesToShow([], cached));
        void loadPositions(animeId)
          .then((resume) => setResumePositions(resume))
          .catch(() => {});
      }
      setSources([]);
      setFailedSources([]);
      setVariantsBySource({});
      setQualitySel(null);
      offlineBlockedRef.current = true;
      setError(OFFLINE_MESSAGE);
      errorRef.current = OFFLINE_MESSAGE;
      setResolving(false);
      loadBusyRef.current = false;
      return;
    }
    /**
     * THE SOURCE + QUALITY MEMORY, read before anything is requested.
     *
     * Two AsyncStorage reads (a few ms) that decide which row and which rung
     * this attempt starts on — and, with the resolve cache below, what makes the
     * return trip from the details page cost nothing. They used to ride along
     * with the media fetch in a `Promise.all`; they are read first now because
     * the cache is applied BEFORE the network is asked anything, so a slow or
     * dead AniList must not hold up a stream that is already known to work.
     */
    const prefExtId = await readSourcePref(animeId);
    const provenQuality = await readQualityPref(animeId);
    if (gen !== loadGenRef.current) return;
    qualityPrefRef.current = provenQuality;
    /**
     * THE RETURN TRIP — see `lib/player/resolveCache.ts`.
     *
     * Backing out to the details page and tapping the same episode again used
     * to re-resolve from scratch: every extension probed again for a list that
     * had played seconds earlier. A hit applies the list the player had, at
     * once, and the metadata fetch below still refreshes the title and panel —
     * the resolve is simply not paid for twice.
     *
     * A hit is safe because it EXPIRES (15 min, inside the shortest signed-URL
     * life we know) and because every failure path keeps its remedies: the
     * source's own `refresh()` re-mints a dead token, and a walk that runs out
     * of sources calls `load({ fresh: true })` and drops this entry.
     */
    const cached = fresh ? null : readResolveCache(animeId, epNum);
    if (cached) {
      // A FRESH ARRAY, not the cache's own. This screen now survives an episode
      // switch (`goToEpisode`), so the array in state can already BE this
      // cached one — pick B, it fails, pick A again. `setState` bails on the
      // identity, the source effect never re-runs, and the viewer sits on a
      // paused frame of the episode they just left.
      setSources(cached.sources.slice());
      // THE LADDERS BELONG TO THE LIST BEING REPLACED, and they must go in the
      // SAME commit as the new list. The rung applier runs on this commit with
      // the new `sources`; left holding the previous server's ladder it would
      // resolve a remembered label to an INDEX against the wrong list and hand
      // the replace a variant URL minted for the episode before this one.
      // `applyResolve` already does this on the fresh path — this is the
      // cached path's half of the same rule.
      setVariantsBySource({});
      setFailedSources(cached.failed);
      const defSource = readSetting('player.defaultSource');
      setSrcIndex(
        pickStartIndex(
          cached.sources,
          prefExtId,
          defSource && defSource !== 'auto' ? defSource : null,
          // Session proof first, session skips filtered — the same decision the
          // fresh path makes, because a cached list is still a list the session
          // has opinions about.
          { proven: sessionProvenSource(), skipped: isSourceSkipped }
        )
      );
      setQualitySel(null);
      qualityChosenRef.current = false;
      refreshedRef.current = new Set();
      // The chrome has something to show even if the metadata request is slow
      // or the connection is thin: the persisted payload the details page (or
      // this player's previous visit) already wrote to `qk.media`.
      const seeded = queryClient.getQueryData<MediaDetail>(qk.media(animeId));
      if (seeded) {
        setMediaDetail(seeded);
        setTotalEps(seeded.episodes ?? 0);
        setTitle(mediaTitle(seeded.title));
        setSourceEpisodes((prev) => (prev.length ? prev : episodesToShow([], seeded)));
      }
    }
    // No ring for a list that is already loading: `resolving` is the RESOLVE
    // spinner, and the cached one went straight to the player.
    setResolving(cached == null);
    budgetRef.current = budgetOnLoad(budgetRef.current, keepBudget);
    rateLimitRetryUsedRef.current = false;
    if (rateLimitRetryTimerRef.current) {
      clearTimeout(rateLimitRetryTimerRef.current);
      rateLimitRetryTimerRef.current = null;
    }
    progressSynced.current = await isSynced(animeId, epNum);
    syncCooldownUntil.current = 0;
    try {
      // The source/quality memory was read just above, before the cache decision.
      const m = await fetchMedia(animeId);
      if (gen !== loadGenRef.current) return;
      // THE MEDIA CACHE SEED. The player fetches its own media payload, and
      // the sync mutation reads `qk.media` for the finale rule (a reached
      // episode count on a finished show completes the entry). A viewer who
      // enters the player without visiting the details page first — a deep
      // link, a stale Continue Watching jump — had an empty cache there, so
      // "mark as completed on the finale" silently degraded to "promote to
      // CURRENT". Same producer (`fetchMedia`), same key, fresher data.
      queryClient.setQueryData(qk.media(animeId), m);
      setMediaDetail(m);
      // One place every resolve verdict flows through — the fast path and the
      // late-landing path are the same code, because they are the same event.
      // Defined here because its body reads `prefExtId`, which is this
      // block's binding.
      const applyResolve = (r: Awaited<ReturnType<typeof resolveEpisode>>) => {
        if (gen !== loadGenRef.current) return;
        setSources(r.sources);
        setFailedSources(r.failed ?? []);
        // A resolve failure is the cheapest place to learn a source is blocked
        // or rate-limited — it happens before any video, and on every open. Only
        // ENVIRONMENTAL reasons count (`tripKindForResolveFailure`); "no
        // mapping" is a fact about this title and must not hide the provider
        // from the next anime.
        let tripped = false;
        for (const f of r.failed ?? []) {
          const kind = tripKindForResolveFailure(f.reason);
          if (kind) {
            tripSource(f.id, kind, f.reason);
            tripped = true;
          }
        }
        if (tripped) bumpLedger();
        // A new resolve is a new mint of signed urls — every source's refresh
        // budget resets with it.
        refreshedRef.current = new Set();
        // START WHERE THE VIEWER LEFT OFF — the first row of the extension
        // that actually played last time, not always the ranked top (the
        // 13 Nov report). Falls back to 0 when the memory is empty or that
        // extension did not answer this resolve; a stale preference never
        // costs a watchable episode. The GLOBAL default source
        // (`player.defaultSource`) is only consulted when there is no memory:
        // the 21 Nov report showed the stated default silently overriding the
        // source that had just played, which is the reverse of what a viewer
        // returning to an episode expects. See `pickStartIndex`.
        const defSource = readSetting('player.defaultSource');
        setSrcIndex(
          pickStartIndex(
            r.sources,
            prefExtId,
            defSource && defSource !== 'auto' ? defSource : null,
            { proven: sessionProvenSource(), skipped: isSourceSkipped }
          )
        );
        setQualitySel(null);
        // A new resolve is a fresh attempt: the default-quality applier is
        // re-armed, so a stated rung gets re-locked onto whatever list this
        // resolve produced (a wrap-round failure rebuilds the list and must
        // not silently demote the viewer to Auto forever).
        qualityChosenRef.current = false;
        setVariantsBySource({});
        // THE LIST THAT IS ABOUT TO LOAD IS THE RETURN TRIP'S CACHE. One write
        // site — the same one every fresh resolve flows through — so the cache
        // can never describe a list the player is not actually on.
        writeResolveCache(animeId, epNum, r.sources, r.failed ?? []);
      };
      setTotalEps(m.episodes ?? 0);
      const t = mediaTitle(m.title);
      presenceTitle.current = t;
      setTitle(t);
      // FALLBACK ART IS THE ANIME POSTER — NEVER THE APP LOGO.
      //
      // An empty `artUrl` means the activity carries no `large_image` at all,
      // and Discord fills that hole with the APPLICATION's icon: the Miori
      // logo on the card of an episode whose still has not loaded yet. A
      // cover almost always exists here, so the card shows the SHOW from the
      // first frame and upgrades to the episode still when the list lands
      // (below). The cache key is the same `a<animeId>` the details page uses,
      // so a poster already uploaded while browsing costs no second round
      // trip to Discord.
      const animeCover = m.coverImage?.extraLarge ?? m.coverImage?.large ?? '';
      presenceMedia.current = {
        artKey: `a${animeId}`,
        artUrl: animeCover,
        pageUrl: `https://anilist.co/anime/${animeId}`,
      };
      updatePresence(t, epNum, presenceMedia.current);

      const reg = createRegistry();
      if (!reg.length) {
        // No sources installed — but the episode list can still be built from
        // AniList's released count and decorated by Kitsu, so the panel is
        // useful even with nothing to play. The error card (thrown below)
        // still surfaces the missing source.
        const shown = episodesToShow([], m);
        setSourceEpisodes(shown);
        void loadPositions(animeId).then((resume) => setResumePositions(resume)).catch(() => {});
        throw new Error('No sources installed. Add an extension repo in Settings.');
      }
      /**
       * THE PROBE LIST — installed sources MINUS the ones this session burned.
       *
       * Not asking is the whole point: an ISP-blocked or rate-limited host costs
       * its full deadline on every open, and asking again cannot change the
       * answer. If nothing is left, everything is probed anyway — the ledger is
       * an ordering opinion, never a lock. The episode-list fetch below still
       * uses the full registry: a source that cannot play can still list.
       */
      const liveReg = reg.filter((e) => !isSourceSkipped(e.id));
      const probeReg = liveReg.length ? liveReg : reg;
      // Kick the episode-list fetch off in parallel with the resolve so the
      // panel populates as soon as the stream is ready instead of after it.
      // The extension caches per-anime, so a title already opened on the
      // details page resolves instantly here instead of refetching.
      const epPromise = (async () => {
        try {
          const epSource = reg.find((e) => e.id === 'filmu') ?? reg[0];
          if (epSource) return await epSource.episodes(animeId);
        } catch {
          /* no source with episodes — AniList still drives the list */
        }
        return [] as EpisodeInfo[];
      })();
      // Populate the episode panel as soon as the list arrives — independent of
      // the stream resolve, so a slow source no longer gates the affordance.
      // The extension caches per-anime, so a warmed title is instant.
      void (async () => {
        try {
          const filmuEps = await epPromise;
          const shown = episodesToShow(filmuEps, m);
          const resume = await loadPositions(animeId);
          setSourceEpisodes(shown);
          setResumePositions(resume);
          const mergedShown = mergeKitsuMeta(shown, peekKitsuEpisodes(animeId));
          const art = mergedShown.find((e) => e.number === epNum)?.poster ?? '';
          if (art) {
            // The still WINS when there is one — under its OWN cache key.
            // Reusing the cover's key would make `resolveArt` answer the cached
            // cover for this url (the cache is keyed by artKey, not by url), so
            // the card would sit on the poster forever.
            presenceMedia.current = {
              ...presenceMedia.current!,
              artKey: `a${animeId}e${epNum}`,
              artUrl: art,
            };
            updatePresence(t, epNum, presenceMedia.current);
          }
        } catch {
          /* panel just stays empty */
        }
      })();

      // THE RESOLVE, IN TWO WINDOWS — the real logic lives in
      // `lib/player/resolveWindow.ts` (driven by `check-failover-budget.ts`).
      // First window: a resolve that throws a REAL failure (an extension 404'd,
      // nothing mapped) surfaces here promptly — that is the error-card case.
      // A resolve that merely MISSES the window has not failed: the promise is
      // still running, every extension is deadline'd internally, and the work
      // it is about to finish is the thing the viewer is waiting for. The
      // second window keeps the spinner and waits the SAME promise out; the
      // old shape rejected at the first deadline and dropped the late answer —
      // "No source answered in time" about an answer that landed seconds later
      // (the 13 Nov slow-connection report).
      // THE CACHED LIST IS ALREADY PLAYING — the expensive part of the open
      // (every extension probed for this episode) is not repeated for a list
      // this device resolved minutes ago.
      if (!cached) {
        const resolvePromise = resolveEpisode(probeReg, animeId, epNum, m.idMal ?? null, {
          // Search-keyword sources (anikoto family) map anilist id via keyword
          // + catalog-id equality; romaji first (closest to MAL titles).
          titles: [m.title?.romaji, m.title?.english].filter(
            (t): t is string => !!t && t.length >= 3
          ),
        });
        const verdict = await resolveInTwoWindows(resolvePromise, 'No source answered in time');
        if (verdict.kind === 'failed') throw verdict.error;
        const resolved = verdict.value;
        if (liveReg.length) {
          // A skipped provider was never asked, so it is absent from `failed`
          // too. The picker still explains it — faded, with the reason — rather
          // than pretending the extension is not installed.
          resolved.failed = [
            ...reg
              .filter((e) => isSourceSkipped(e.id))
              .map((e) => ({ id: e.id, reason: 'skipped this session' })),
            ...resolved.failed,
          ];
        }
        applyResolve(resolved);
      }
      // The episode panel is populated by the parallel fire-and-forget above,
      // so a slow stream resolve no longer gates it.
    } catch (e: any) {
      if (gen !== loadGenRef.current) return;
      /**
       * A CACHED STREAM IS NOT A FAILED EPISODE. The metadata request can fail
       * (AniList down, a thin connection) while the rows that played a minute
       * ago are already loading in the player. Raising the card there would
       * stop a watchable episode for a title that is only decoration.
       */
      if (cached) return;
      const wentOffline = isOffline() || isOfflineError(e);
      if (wentOffline) offlineBlockedRef.current = true;
      setError(wentOffline ? OFFLINE_MESSAGE : String(e?.message ?? e));
      errorRef.current = wentOffline ? OFFLINE_MESSAGE : String(e?.message ?? e);
    } finally {
      if (gen === loadGenRef.current) {
        setResolving(false);
        loadBusyRef.current = false;
      }
    }
  }, [animeId, epNum, linkOk, queryClient, bumpLedger]);

  useEffect(() => {
    // `linkOk` rather than an isFinite check. `Number.isFinite(NaN)` is false so
    // the old guard did stop the request, but everything BEFORE this effect had
    // already run with a NaN id — `useSyncListProgress(NaN)` and, on unmount,
    // `savePosition(NaN, NaN, …)` writing a real `miori:pos:NaN:NaN` key to the
    // user's disk. One check, applied where the value is used.
    if (!linkOk) return;
    void load();
  }, [linkOk, load]);

  /**
   * WARM THE NEXT EPISODE WHILE THE CARD COUNTS DOWN.
   *
   * "Next episode" is a resolve plus a replace, and the resolve is the slow
   * half. Since the screen now stays mounted across the switch (`goToEpisode`),
   * the only work left on the tap is finding a list — and this puts that list in
   * the resolve cache five seconds early, so the switch is one `replaceAsync`
   * on a stream whose urls were minted moments ago.
   *
   * Deliberately silent: a prefetch that fails costs nothing (the real load runs
   * anyway and reports its own failure), and it never marks anything as played.
   */
  const prefetchNextEpisode = useCallback(
    async (next: number) => {
      if (isOffline()) return;
      if (readResolveCache(animeId, next)) return;
      const m = mediaDetail ?? queryClient.getQueryData<MediaDetail>(qk.media(animeId));
      if (!m) return;
      try {
        const reg = createRegistry();
        if (!reg.length) return;
        const r = await resolveEpisode(reg, animeId, next, m.idMal ?? null, {
          // Same keys the real load uses — a search-keyword source matches on
          // them, so a prefetch that skipped them could cache the wrong title.
          titles: [m.title?.romaji, m.title?.english].filter(
            (t): t is string => !!t && t.length >= 3
          ),
        });
        writeResolveCache(animeId, next, r.sources, r.failed ?? []);
      } catch {
        /* the card's countdown is not the place to report a failed prefetch */
      }
    },
    [animeId, mediaDetail, queryClient]
  );

  /**
   * STOP THE AUDIO WHEN THE PLAYER HAS FAILED.
   *
   * `VideoView.onDetachedFromWindow` does not pause on Android — only
   * `player.release()` does, and that runs on unmount — and this screen's error
   * card is an OVERLAY, so the surface is still attached and still playing
   * underneath it. The reported symptom was therefore "the video disappeared and
   * the episode kept playing to the end with no controls", which is what
   * `failover()` exhausting its budget looked like from the other side of the
   * screen.
   *
   * Keyed on `error` alone, so it runs for the resolve-timeout case too, and it
   * runs exactly once per error — pausing an already-paused player is free, but
   * writing to the native player on every render is not.
   */
  useEffect(() => {
    if (error) player.pause();
    // The card replaces the ring: a recovery that ended in a verdict is not
    // still recovering, and a ring behind the card would say otherwise.
    if (error) setRecovering(false);
    // A switch that FAILED owes the screen back. Retry and Change source are the
    // only live controls left on the card, and a gate that outlived its resolve
    // would keep them behind a spinner that is no longer loading anything.
    if (error) setSwitchPending(false);
  }, [error, player]);

  // PiP support is read synchronously at initialisation above — see `pipSupported`.

  // Restore the saved rate on open. Safe to read synchronously because the root
  // layout AWAITS `hydrateSettings()` before it renders anything, so by the time
  // this mounts the store is already populated — the default-fallback path in
  // `readSetting` cannot hand back a stale 1.
  useEffect(() => {
    const stored = readSetting('player.speed');
    if (typeof stored === 'number' && stored > 0) setSpeed(initialSpeed(stored));
  }, []);

  // -------------------------------------------------------------------------
  // Source loading + failover
  // -------------------------------------------------------------------------
  /**
   * THE RUNG THAT SURVIVES A SOURCE CHANGE.
   *
   * `qualityPrefRef` is the LABEL the viewer picked (or the height this show
   * last actually played) — intent, independent of the server that happened to
   * serve it. A hop has to drop `qualitySel` because its index and its variant
   * URL belong to the dead server's ladder; this re-resolves the same label
   * against the DESTINATION source's ladder, so the hop is "same height, new
   * server" instead of "Auto, and the viewer has to notice".
   *
   * Null when the destination does not offer that label — Auto is then the
   * honest answer — and null for an explicit Auto pick, because that pick
   * clears `qualityPrefRef`. A hop can never resurrect a rung the viewer
   * rejected.
   */
  const qualityForSource = useCallback((si: number): { src: number; v: number } | null => {
    const label = qualityPrefRef.current;
    if (!label) return null;
    const list = variantsRef.current[si];
    if (!list) return null;
    const v = list.findIndex((variant) => variant.label === label);
    return v < 0 ? null : { src: si, v };
  }, []);

  const failover = useCallback((reason?: string) => {
    if (offlineRef.current) {
      offlineBlockedRef.current = true;
      clearFrameWatchdog();
      return;
    }

    // A HOP LEAVES THE PICTURE WITHOUT A SOURCE for a moment, and the ring is
    // the honest answer for that window. Set here rather than at each of the
    // walks's exits so no future exit can forget it.
    setRecovering(true);
    // The hop this decision leads to is a RECOVERY re-open — see `useCaching`.
    recoveryOpenRef.current = true;

    if (reason && /429/.test(reason) && !rateLimitRetryUsedRef.current) {
      rateLimitRetryUsedRef.current = true;
      clearFrameWatchdog();
      const at = player.currentTime;
      if (at > 0) pendingSeek.current = at;
      const timer = setTimeout(() => {
        setReloadNonce((n) => n + 1);
      }, 2000);
      rateLimitRetryTimerRef.current = timer;
      return;
    }
    if (rateLimitRetryTimerRef.current) {
      clearTimeout(rateLimitRetryTimerRef.current);
      rateLimitRetryTimerRef.current = null;
    }

    // START THE WALL CLOCK on the first failure of a stretch. Both budgets read
    // it; both are reset by a rendered frame, Retry, Change source and load().
    budgetRef.current = noteFailure(budgetRef.current, Date.now());

    /**
     * THE WRAP BOUNDARY — the walk reached the end of the list and wants a
     * fresh resolve. This is where the budget is spent, and why the increment
     * lives HERE and not at the top of `failover`.
     *
     * The old shape counted every failover CALL as a round and gave up after
     * three — but its own doc comment said "one round is a walk down every
     * source". With the anikoto family shipping four source rows plus mega and
     * filmu, the list is ~7 long: three calls is barely half of one walk, so a
     * slow connection (each source legitimately spending most of its 14s
     * first-frame window) exhausted the budget mid-first-walk and raised
     * "Playback failed" over sources that were still being tried — while the
     * currently-loading source then delivered its frame and played underneath
     * the card. The 13 Nov device report, verbatim.
     *
     * A round is now ONE FULL WALK, as documented, and a second wall-clock
     * bound (`MAX_FAILOVER_WALL_MS`) keeps the slow-failure shape honest: three
     * walks of a dead list fail fast and cheap, three walks of a slow list are
     * capped by the clock instead of spending minutes as a spinner.
     */
    const wrapLoad = () => {
      // The decision lives in `lib/player/failover.ts` (`wrapVerdict`) — one
      // full walk per round, plus the wall-clock cap; `check-failover-budget.ts`
      // drives the real function.
      const verdict = wrapVerdict(budgetRef.current.rounds, budgetRef.current.sinceMs, Date.now());
      if (verdict === 'giveup') {
        clearFrameWatchdog();
        // No re-open follows a give-up, so the flag must not survive into the
        // viewer's next attempt: a Retry is an ordinary open and keeps the cache.
        recoveryOpenRef.current = false;
        // The cached list has now failed its whole walk. Drop it so the next
        // visit re-resolves instead of resurrecting the same dead URLs. (The
        // error card's Retry asks for a fresh resolve directly.)
        dropResolveCache(animeId, epNum);
        setRecovering(false);
        // A DIFFERENT SENTENCE WHEN THE LADDER WAS USED. "No source could play
        // this episode" is wrong for a connection that played it fine until it
        // ran out of headroom: the sources were not the problem, and the lever
        // that helps (quality) is one the generic sentence never mentions.
        setError(
          recoveryRef.current.actions > 0
            ? RECOVERY_EXHAUSTED_MESSAGE
            : 'No source could play this episode. Try again, or pick a different episode.'
        );
        return;
      }
      budgetRef.current = spendRound(budgetRef.current);
      // Exhausted: fresh signed URLs, try the whole list again.
      // Preserve an already-pending target (e.g. a reconnect position) rather than
// overwriting it with a playhead that may have been reset to 0 by a failed
// replaceAsync. Only adopt the current playhead when nothing is pending.
if (pendingSeek.current == null) {
  const at = player.currentTime;
  if (at > 0) pendingSeek.current = at;
}
      // JOIN, DON'T STACK. A resolve may already be in flight — a Retry the
      // viewer tapped while the walk was ending, or the wrap of a parallel
      // failure path. Starting a second resolve on top doubles the network
      // load for the same answer; the in-flight one will land, applyResolve
      // will repopulate the list at index 0, and the walk restarts from there.
      // ⚠ `keepBudget: true` IS THE FIX for the endless loop: this load belongs
      // to the stretch that is already failing, so it inherits the budget
      // instead of resetting it and starting the walk over from nothing.
      if (!loadBusyRef.current) void load({ fresh: true, keepBudget: true });
    };

    const i = srcIndexRef.current;
    const failing = sourcesRef.current[i];
    // A PLAYBACK VERDICT FOR THE LEDGER. The 429 branch above has already taken
    // its one in-place retry, so anything reaching here is a repeat failure and
    // counts. `tripKindForPlaybackFailure` deliberately returns null for an
    // expired signed URL (refresh + re-resolve is the remedy, the source is
    // fine), for an offline device, and for an unrecognised message.
    if (reason) {
      const kind = tripKindForPlaybackFailure(reason);
      if (kind && tripSource(failing?.extId, kind)) bumpLedger();
    }

    // SELF-HEAL BEFORE HOPPING. A signed source (the extension decides; the
    // player only sees a refresh hook) probed alive at resolve time and failing
    // here is most plausibly its url dying between resolve and play — which a
    // hop to the next source hides but never fixes, and which makes Katana
    // unpickable for the whole session. One refresh, in place, before the walk
    // spends itself. Missing hook, already-tried index, or a refresh already in
    // flight all fall straight through to the hop below.
    if (failing?.refresh && !refreshedRef.current.has(i) && !refreshBusyRef.current) {
      refreshedRef.current.add(i);
      refreshBusyRef.current = true;
      // Preserve an already-pending target (e.g. a reconnect position) rather than
// overwriting it with a playhead that may have been reset to 0 by a failed
// replaceAsync. Only adopt the current playhead when nothing is pending.
if (pendingSeek.current == null) {
  const at = player.currentTime;
  if (at > 0) pendingSeek.current = at;
}
      // The variant selection hung off the dead token's urls; the fresh source
      // restarts on its master.
      if (qualitySelRef.current) {
        qualitySelRef.current = null;
        setQualitySel(null);
      }
      // ...but the INTENT is not the dead token's. Ask for the remembered rung
      // to be re-seated on the freshly minted ladder; the gather below is what
      // consumes this, because only then do the urls exist. Without it, a
      // mid-episode token refresh silently demoted a locked 1080p to Auto and
      // left it there for the rest of the episode.
      if (qualityPrefRef.current) reseatQualityRef.current = true;
      void (async () => {
        try {
          const fresh = await failing.refresh!();
          // ⚠️ A REPLAY IS NOT A RE-MINT. Their SSR re-serves its still-valid
          // token within a mint window (verified live 1 Nov: two back-to-back
          // SSRs seconds apart answer the same url; ~30min apart a new one) —
          // so `fresh.url === failing.url` happens while the token is young.
          // But the url PLACED here just failed at open, so reloading it can
          // only repeat the failure; only a CHANGED url is evidence of a
          // re-mint, and a replay continues the walk (budgeted rounds still
          // re-resolve from scratch afterwards, so a transient failure loses
          // nothing but an instant).
          if (fresh && fresh.url !== failing.url) {
            setSources((prev) =>
              prev.map((s, idx) =>
                idx === i ? { ...fresh, extId: fresh.extId ?? failing.extId } : s
              )
            );
            setReloadNonce((n) => n + 1);
            return;
          }
        } catch {
          /* refresh is an attempt, not a guarantee — hop as before */
        } finally {
          refreshBusyRef.current = false;
        }
        // Null or thrown: continue the walk that was interrupted.
        const nextRow = nextWalkIndex(sourcesRef.current, i, isSourceSkipped);
        if (nextRow != null) {
          const carried = qualityForSource(nextRow);
          qualitySelRef.current = carried;
          setQualitySel(carried);
          setSrcIndex(nextRow);
        } else {
          wrapLoad();
        }
      })();
      return;
    }

    // A locked quality belonged to the source that just failed. Its URL must
    // not survive the hop — but the RUNG should: dropping the lock outright is
    // what made one dead server demote a locked 1080p to Auto for the rest of
    // the episode. If the next source offers the same label the hop lands on
    // that variant directly (one replace, no master dance); if it does not, the
    // lock is dropped as before and Auto plays the next server.
    // THE WALK STEPS OVER WHAT THE SESSION HAS WRITTEN OFF, and keeps the rank
    // order for everything else (`nextWalkIndex`).
    const nextRow = nextWalkIndex(sourcesRef.current, i, isSourceSkipped);
    const carried = nextRow != null ? qualityForSource(nextRow) : null;
    qualitySelRef.current = carried;
    setQualitySel(carried);
    // Resume exactly where the viewer was, not at the stored position. The
    // stored one is up to `SAVE_EVERY` seconds behind, and a source that dies
    // mid-scene should not restart the scene.
    if (nextRow != null) {
      // Preserve an already-pending target (e.g. a reconnect position) rather than
// overwriting it with a playhead that may have been reset to 0 by a failed
// replaceAsync. Only adopt the current playhead when nothing is pending.
if (pendingSeek.current == null) {
  const at = player.currentTime;
  if (at > 0) pendingSeek.current = at;
}
      setSrcIndex(nextRow);
    } else {
      wrapLoad();
    }
  }, [load, player, clearFrameWatchdog, animeId, epNum, qualityForSource, bumpLedger]);

  failoverRef.current = failover;

  // The source -> player effect. Re-runs on source index and on an explicit
  // nonce bump (used when the user re-picks the variant they are already on).
  const [reloadNonce, setReloadNonce] = useState(0);

  /**
   * THE RECOVERY LADDER, as this screen runs it.
   *
   * `decideRecovery` owns the ORDER (wait → less bitrate → soft reload →
   * failover); this function owns the side effects, which is why it is not
   * pure. The one rule that matters here: NOTHING in this function may touch
   * the player while the ladder says `wait`. A stream that is still downloading
   * is doing exactly what it should, just slowly.
   */
  const recoverStream = useCallback(
    (ahead: number | null, frozenMs: number, growing: boolean) => {
      if (offlineRef.current) {
        // No radio is not a slow CDN. Mark the attempt so the reconnect path
        // reopens it, and do not spend a single remedy on it.
        offlineBlockedRef.current = true;
        return;
      }

      const now = Date.now();
      const si = srcIndexRef.current;
      const ladder = variantsRef.current[si] ?? null;
      const sel = qualitySelRef.current;
      let rung: number | null = null;
      if (ladder && ladder.length) {
        if (sel && sel.src === si) rung = sel.v;
        else {
          // Auto: the observed height is the rung that is playing, so "one
          // below it" is a real step down rather than a guess at the top.
          const height = liveHeightRef.current;
          const found = height == null ? 0 : ladder.findIndex((v) => (v.height ?? 0) <= height);
          rung = found < 0 ? 0 : found;
        }
      }
      const nextRung = ladder && rung != null && rung + 1 < ladder.length ? rung + 1 : null;

      const decision = decideRecovery(
        recoveryRef.current,
        { ahead, frozenMs, growing, hasLadder: !!ladder?.length, nextRung },
        now
      );
      recoveryRef.current = decision.state;

      /** Where to come back to — read BEFORE the replace, like every other switch. */
      const armResume = () => {
        if (pendingSeek.current != null) return;
        const at = Math.max(player.currentTime, positionRef.current);
        if (at > 0) pendingSeek.current = at;
      };

      switch (decision.action.kind) {
        case 'wait':
          // The ring is already up (the verdict is `rebuffering`). Deliberately
          // nothing else: this is the case that saves a slow connection.
          return;
        case 'lower-quality': {
          const to = decision.action.to;
          const label = ladder?.[to]?.label ?? null;
          autoQualityRef.current = true;
          qualitySelRef.current = { src: si, v: to };
          setQualitySel(qualitySelRef.current);
          // In memory only — `onFirstFrame` refuses to persist it.
          if (label) qualityPrefRef.current = label;
          // 🎧 DOWN WITHOUT A RELOAD, when the master muxes nothing: a separate
          // audio rendition is lost by a variant swap, and a swap also throws
          // away the buffered bytes the ladder is trying to protect. A ceiling
          // steps the bitrate down in place. No `setRecovering` either — there
          // is no reload to announce, and the ring comes from the health
          // monitor, which already sees the frozen playhead.
          if (ladder && ladder[0]?.separateAudio === true) {
            try {
              player.maxResolution = capFor(ladder[to]);
            } catch {
              /* the native player may already be released */
            }
            return;
          }
          armResume();
          setRecovering(true);
          recoveryOpenRef.current = true;
          setReloadNonce((n) => n + 1);
          return;
        }
        case 'cap': {
          // No ladder to step into (the master read failed on this very
          // connection, which is itself evidence). `maxResolution` is a hard
          // ABR ceiling on Android: the player re-selects its own track below it
          // WITHOUT a reload, so this costs no buffer at all.
          try {
            player.maxResolution = {
              width: Math.round((decision.action.height * 16) / 9),
              height: decision.action.height,
            };
          } catch {
            /* the native player may already be released */
          }
          setRecovering(true);
          return;
        }
        case 'reload':
          armResume();
          setRecovering(true);
          recoveryOpenRef.current = true;
          setReloadNonce((n) => n + 1);
          return;
        case 'failover':
          // The budget bounds this, and it can now actually run out.
          failoverRef.current();
          return;
      }
    },
    // Refs and setters only: the ladder reads the episode's caches through the
    // refs it was handed, and `positionRef` is the playhead's own mirror. A
    // dependency on `epNum` here would rebuild the callback mid-episode for no
    // behaviour at all.
    [player]
  );
  recoverStreamRef.current = recoverStream;

  useLayoutEffect(() => {
    const s = sources[srcIndex];
    if (!s) {
      /**
       * NO ITEM AT THIS INDEX IS STILL AN ANSWER TO "IS THE SWITCH OVER?".
       *
       * This early return used to be silent, and `switchPending` is only ever
       * cleared below it. A new episode whose source list is EMPTY, or shorter
       * than the index the previous episode was on, therefore left the gate —
       * and the first-load stage with it — up FOREVER: the device report was the
       * loading screen sitting over an episode that was audibly playing, with the
       * back arrow as the only exit. The stage covers the wait anyway (no frame
       * yet), so the gate has nothing to hold; clear it and keep the media
       * fence (`mediaSwitchRef`) exactly where it is, because no new item has
       * landed to hand the playhead over to.
       */
      setSwitchPending(false);
      return;
    }
    let cancelled = false;
    // A new media item is here, so any episode switch is over: the playhead
    // from here on belongs to `epNum`. A layout effect, so this lands before
    // the replace is issued and before a tick of the new item can be filed.
    mediaSwitchRef.current = false;
    // …and the transport comes back with it: the viewer is looking at the
    // episode they asked for, so every control now points at the right item.
    setSwitchPending(false);
    resumeSeekAfterFrameRef.current = null;
    // `slice()`, NOT the raw reference — the load-bearing copy. A same-source
    // reload (a quality pick the active source owns, the common Katana case)
    // reaches here with `s` as the very same state object, so its subtitles
    // array arrives with the SAME identity: React's setState bails out, and —
    // since this same run also did `setCues([])` below — the cue-fetch effect,
    // keyed on `[tracks, trackIndex]`, never re-ran. Cues wiped, never
    // refetched: subtitles vanished for the rest of the episode. Device-seen on
    // Katana 2 Nov; Mega recovered only by accident, because its picks land on
    // a DIFFERENT source object whose fresh array identity re-fires the fetch.
    // The copy forces a new identity on every load, so the subtitle fetch fires
    // on a quality switch exactly as it already does on a source switch.
    setTracks(s.subtitles ? s.subtitles.slice() : []);
    // `trackIndex` is deliberately NOT reset here. It used to be set to 0 on
    // every source load, which is what made the English-default effect
    // unreachable for a viewer who had picked something else — the reset
    // arrived first and won. The index is now DERIVED from the stored language
    // (see `wantedTrack`), so it re-resolves itself the moment `tracks` changes
    // and does not need to be zeroed by whoever handed the new list over.
    setCues([]);
    positionRef.current = 0;
    durationRef.current = 0;
    publishCue(null);
    setActiveSkip(null);
    playbackProgressRef.current = false;
    setPlaybackProgress(false);
    // The observed height was the PREVIOUS item's. A new item reports its own
    // through `videoTrackChange`; until it does, the quality row must not keep
    // claiming the rung the last episode happened to render.
    setLiveHeight(null);
    frameRecoveryUsedRef.current = false;
    // A new media item owes us a new first frame. Leaving the old `true` in
    // place would let the spinner stay dismissed across a switch that is about
    // to show nothing.
    firstFrameRef.current = false;
    setFirstFrame(false);
    clearFrameWatchdog();
    // A new item owes us a new silence verdict; the old timer would blame the
    // source we just left.
    if (audioGuardRef.current) {
      clearTimeout(audioGuardRef.current);
      audioGuardRef.current = null;
    }

    // A locked variant on THIS source loads directly — that is what makes
    // "1080p from source 2" one replace instead of two.
    //
    // 🎧 UNLESS THE MASTER KEEPS ITS AUDIO SOMEWHERE ELSE. A variant playlist
    // of a master with a separate audio rendition is video-only, so loading it
    // gives a silent picture (the Katana report of 23 Nov — it appeared as soon
    // as the recovery ladder started stepping down by itself). On such a master
    // the rung is applied as an ABR CEILING instead: the item stays the master,
    // the audio keeps arriving, the buffer survives, and Android re-selects its
    // own track under the cap.
    const sel = qualitySel;
    const list = sel ? variantsBySource[sel.src] : undefined;
    const picked = sel && sel.src === srcIndex ? list?.[sel.v] : undefined;
    const separateAudio = !!list?.length && list[0]?.separateAudio === true;
    const variantUrl = picked && !separateAudio ? picked.url : undefined;
    try {
      player.maxResolution = separateAudio ? capFor(picked) : null;
    } catch {
      /* the native player may already be released */
    }

    const source: VideoSource = {
      uri: variantUrl ?? s.url,
      headers: s.headers,
      // Android's native cache holds stream data for this watch session. The
      // app-level Low/Normal/High setting caps its total disk use; leaving the
      // player clears it after the native player has been released.
      // ⚠️ A RECOVERY RE-OPEN DOES NOT TOUCH THE DISK CACHE, and that is a
      // freeze fix, not a memory one. With caching on, building this media
      // source runs `CacheVariantIndex.storageKeyResult` — `@Synchronized`, plus
      // a file read — and `expo-video` does it on the Android MAIN thread while
      // preparing the item. The cache's network interceptor takes the same lock
      // on every response, so preparing a new source while a segment is stuck
      // mid-download blocks the UI thread: the picture freezes, the spinner
      // freezes, and Android closes the app. A recovery re-open is by definition
      // happening on a struggling connection, which is the one moment that lock
      // is most likely held — so that open goes straight to the network. The
      // viewer's own opens (mount, Retry, a quality or source pick) keep the
      // configured cache exactly as before.
      useCaching:
        !recoveryOpenRef.current &&
        Platform.OS === 'android' &&
        readSetting('player.cache') !== 'off',
      // ⚠️ `'auto'` was WRONG for token URLs and is documented as the bug above
      // (contentTypeFor / labelAgrees). The correction history, briefly, so the
      // next session does not restore it: the old `'hls'`-always was wrong
      // because `playableContainer()` DERIVES the label from the URL string,
      // and an explicit type on a mislabelled source went black. `'auto'` took
      // its place WHEN the known sources' URLs all carried `.m3u8`, so the
      // sniffing pipeline agreed with every label by construction. The Bingr
      // rewrite moved the FIRST source onto a `/p/<token>` URL with no
      // extension, `'auto'` inferred "other", and the progressive extractors
      // failed to read HLS text — so Katana died at open and failover walked
      // to Mega on every single play. The rule now is: trust an ASSIGNED label
      // when the URL is silence (the extension asserts it and its probe fails
      // closed), `'auto'` when the label is derived without evidence or
      // contradicted by the URL.
      contentType: contentTypeFor(s),
    };

    // The label is ignored above, so a source that mislabels itself is invisible.
    // This says so out loud in dev rather than leaving the next person to
    // "fix" the contentType back from the type alone.
    if (__DEV__ && labelDisagrees(s)) {
      console.warn(
        `[player] source labels itself "${s.container}" but the URL looks like HLS: ${s.url}`
      );
    }

    /**
     * ARM BEFORE THE REPLACE, not only after it.
     *
     * `replaceAsync` is a native call that can sit unanswered on a bad
     * connection. The old shape armed the frame watchdog inside `.then`, so a
     * replace that never settled left `firstFrame` false forever: the centre
     * ring stayed up with no Retry, no error and no failover — the "infinite
     * loading" report. The `.then` below re-arms it, so a normal load still
     * gets its full first-frame window; this only bounds the case where the
     * replace itself never comes back.
     */
    // A new media item earns a fresh first-frame window: the previous item's
    // extensions must not shorten this one's patience.
    // CONSUMED — the flag describes ONE re-open. Leaving it set would silently
    // turn the cache off for the viewer's own next open.
    recoveryOpenRef.current = false;
    frameWatchdogStretchRef.current = 0;
    armFrameWatchdog();
    void player
      .replaceAsync(source)
      .then(() => {
        if (cancelled) return;
        if (sourcesRef.current[srcIndexRef.current]?.url !== s.url) return;
        // Re-assert speed: a replace is a NEW media item natively and the
        // playback rate does not carry across it. This is why the assertion
        // lives next to the replace as well as in the `speed` effect — a user
        // who sets 1.25x and then changes source should still be at 1.25x.
        player.playbackRate = effectiveRate(speedRef.current);
        // Restore a pending position BEFORE playing, so a reconnect (or any
        // other media replace that carried a target) does not flash the
        // episode from 0:00 and then jump. `replaceAsync` resets the playhead
        // to the start; the seek below lands the viewer where they were.
        const pending = pendingSeek.current;
        if (pending != null && pending > 0) {
          /**
           * ⚠️ THE RESTORE IS ARMED HERE, NOT CONSUMED.
           *
           * This used to seek and then CLEAR `pendingSeek` and set `sought` — so
           * if the native player silently ignored the seek (it does when the
           * item is not prepared yet, and it does not throw), the only record
           * of where the viewer was went out with it and the episode played
           * from 0:00. That is the 21 Nov device report: internet drops, the
           * buffer plays out, the offline card appears, the connection returns,
           * the stream reloads — and it starts the episode over.
           *
           * The seek is still issued now (it lands on an already-prepared item,
           * which is the common case for a quality switch), but
           * `pendingSeek`/`resumeSeekAfterFrameRef` stay armed until
           * `readyToPlay` or the first frame applies it — both are proof the
           * pipeline can honour a seek, and both consume it through
           * `applyResumePosition`.
           */
          sought.current = true;
          resumeSeekAfterFrameRef.current = pending;
          try {
            player.currentTime = pending;
          } catch (e) {
            // Deferred to `readyToPlay` — see above.
            if (__DEV__) console.warn('[player] replace seek deferred:', e);
          }
        }
        if (desiredPlayingRef.current) {
          player.play();
          // A replace IS a seek-class freeze — the frame is gone while the new
          // media item loads, but `playing` says true from the `play()` above.
          // The centre transport owes this window the same ring the gesture
          // seeks get; cleared from the `timeUpdate` listener once the new
          // item's first ticks arrive.
          seekIssuedAtRef.current = Date.now();
          setSeekPending(true);
        }
        // The replace resolved and either play was asked for, or the viewer is
        // paused. If no frame appears in the window below, this source is dead
        // in a way `statusChange` will never report — so treat it as dead
        // ourselves rather than showing a black rectangle forever. The dog
        // re-arms instead of failing over while the intent is paused, so both
        // paths below can arm it unconditionally.
        armFrameWatchdog();
      })
      .catch((e: unknown) => {
        // Same device-visible line as the status-error path — `replaceAsync`
        // throwing is failover's other entry point.
        if (__DEV__) {
          console.warn(
            `[player] source ${srcIndexRef.current} (${s.quality ?? '?'}) replace failed:`,
            e instanceof Error ? e.message : e
          );
        }
        if (offlineRef.current) {
          offlineBlockedRef.current = true;
          clearFrameWatchdog();
          return;
        }
        if (!cancelled) failoverRef.current();
      });

    return () => {
      cancelled = true;
    };
    // `variantsBySource` IS DELIBERATELY NOT A DEPENDENCY, even though the body
    // reads it.
    //
    // The body only consults it when a variant is LOCKED to this source, and
    // this effect already re-runs on `qualitySel` — so by the time a locked
    // variant is needed, the lookup is satisfied by that re-run. Including it
    // means the cross-source quality gather, which finishes seconds AFTER the
    // video starts, lands here and calls `replaceAsync` a second time on a video
    // that is already playing. That is a visible restart, and it is also what
    // made the resume seek below re-fire.
    //
    // The suppression goes on the line BEFORE `useEffect(` — that is the line
    // the rule anchors to, not the dependency array itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [player, sources, srcIndex, reloadNonce, qualitySel]);

  // Latest speed for the load path above, without putting `speed` in its deps —
  // otherwise every speed change would re-resolve the episode.
  const speedRef = useRef(speed);
  speedRef.current = speed;

  /**
   * A NEW EPISODE STARTS THE LADDER OVER, and lifts the ABR ceiling with it.
   *
   * Deliberately keyed on `epNum` alone: a source hop or a bitrate step is part
   * of the SAME episode's failing stretch, and resetting the ladder on those
   * would let it step down forever — the exact shape that made the old
   * auto-downgrade thrash. A new episode is a new decision.
   */
  useEffect(() => {
    recoveryRef.current = initialRecovery();
    autoQualityRef.current = false;
    lastBufferedRef.current = -1;
    frameWatchdogStretchRef.current = 0;
    // A NEW EPISODE IS A NEW CONNECTION'S WORTH OF PATIENCE. Both of these are
    // per-episode by design and must not be reset by a source hop:
    //   • the quiet window the stability heartbeat measures — an episode that
    //     has not stalled yet has genuinely proved nothing yet either way;
    //   • the silence allowance, so a provider matrix in which every row is
    //     silent costs two hops for the whole episode rather than two per row.
    lastStallAtRef.current = 0;
    silentUrlsRef.current.clear();
    silentHopsRef.current = 0;
    try {
      player.maxResolution = null;
    } catch {
      /* the native player may already be released */
    }
  }, [epNum, player]);

  // -------------------------------------------------------------------------
  // Player events
  // -------------------------------------------------------------------------
  const pushPresence = useCallback(
    (isPlaying: boolean) => {
      if (!presenceTitle.current) return;
      updatePresence(presenceTitle.current, epNum, presenceMedia.current, {
        isPlaying,
        positionSec: positionRef.current,
        durationSec: durationRef.current,
      });
    },
    [epNum]
  );

  useEffect(() => {
    const subs: { remove(): void }[] = [];

    subs.push(
      player.addListener('timeUpdate', (p) => {
        positionRef.current = p.currentTime;
        // `TimeUpdateEventPayload` carries `currentTime` and `bufferedPosition`
        // only — the runtime is read off the PLAYER, not the payload. (The old
        // vertical page read `p.duration` here because it typed its listener
        // loosely; the runtime it wanted was always `player.duration`.)
        const dur = player.duration || 0;
        durationRef.current = dur;
        // Presence: the first tick that knows the duration is when the card
        // can finally carry its start/end timestamps (the progress bar).
        // Everything before it is a bar-less "elapsed count".
        if (dur > 0 && !presenceTimedSent.current) {
          presenceTimedSent.current = true;
          pushPresence(player.playing);
        }
        // Presence: a moved playhead re-anchors the card's timeline. The
        // card's start/end are minted from the position at push time and then
        // tick in wall-clock, so a seek leaves them describing the OLD
        // position until the next push. The bucket (5 min, the same bucketing
        // discord.ts tiers by) bounds that drift without pushing on every
        // tick; the auto-skip above and any other programmatic jump land here
        // too, since not every jump routes through `seekWithGrace`.
        const bucket = Math.floor(p.currentTime / 300);
        if (bucket !== presenceBucket.current) {
          presenceBucket.current = bucket;
          pushPresence(player.playing);
        }
        // `bufferedPosition` is -1 when the buffer state is unknowable, which
        // includes the moment right after a replace. Clamped at 0 rather than
        // passed through, or the buffered bar would render at a negative
        // fraction and vanish.
        showCueAt(p.currentTime);
        const source = sourcesRef.current[srcIndexRef.current];
        const skip = source?.intro && p.currentTime >= source.intro.start && p.currentTime < source.intro.end
          ? { kind: 'opening' as const, ...source.intro }
          : source?.outro && p.currentTime >= source.outro.start && p.currentTime < source.outro.end
            ? { kind: 'ending' as const, ...source.outro }
            : null;
        setActiveSkip((previous) => previous?.kind === skip?.kind && previous?.start === skip?.start && previous?.end === skip?.end ? previous : skip);
        if (!autoSkippedOpening.current && readSetting('player.autoSkipIntro') && source?.intro && p.currentTime >= source.intro.start && p.currentTime < source.intro.end) {
          autoSkippedOpening.current = true;
          const skipTarget = Math.ceil(source.intro.end);
          player.currentTime = skipTarget;
          // A seek like any other — the auto-skip jumps the playhead forward
          // into territory that is usually unbuffered, so the health monitor
          // needs the same grace it gives a manual one.
          const now = Date.now();
          healthRef.current = noteSeek(readHealth(now), now);
          // The auto-skip bypasses `seekWithGrace`, so it re-anchors the
          // presence card itself (the bucket check below only fires on a
          // 5-minute crossing).
          positionRef.current = skipTarget;
          pushPresence(player.playing);
        }
        // Outro auto-skip, gated separately: outros often carry post-credits
        // tags, so this is off by default and only fires when the user opts in.
        // Episodes that have an outro but NO intro are handled here too, because
        // this block does not depend on the intro block above.
        if (!autoSkippedEnding.current && readSetting('player.autoSkipOutro') && source?.outro && p.currentTime >= source.outro.start && p.currentTime < source.outro.end) {
          autoSkippedEnding.current = true;
          const skipTarget = Math.ceil(source.outro.end);
          player.currentTime = skipTarget;
          const now = Date.now();
          healthRef.current = noteSeek(readHealth(now), now);
          positionRef.current = skipTarget;
          pushPresence(player.playing);
        }
        if (p.currentTime > 0.5) {
          playedRef.current = true;
          playbackProgressRef.current = true;
          setPlaybackProgress(true);
        }

        // THE BACKSTOP for the timeline's settle flag. `resumeSettled` should
        // already be true by now — the resume question is answered in the
        // `statusChange` handler the moment the mount-time read resolves —
        // but a device where `readyToPlay` never fires must not leave the
        // playhead, the fill and the knob unrenderable forever, mindlessly
        // grey with a `--:--` clock, while the stream is visibly playing.
        // A position past half a second IS the evidence "we are playing from
        // a known place". The one exception is a jump still pending: a stored
        // resume that has not been applied yet wants its owning frame first,
        // or this settles a playhead that is about to be moved elsewhere —
        // the "0:00, then 12:34" claim the settle gate exists to keep off the
        // screen.
        if (p.currentTime > 0.5 && resumeSeekAfterFrameRef.current == null) {
          setResumeSettled((previous) => (previous ? previous : true));
        }

        // THE SEEK SPINNER'S END. `timeUpdate` only arrives while the
        // pipeline is producing frames — it goes silent the moment a seek
        // sends the player to `loading`, and resumes the instant the target
        // decodes. So the first tick that arrives AFTER the issue window
        // proves the load is over, and the ring yields to the real transport.
        if (seekIssuedAtRef.current !== 0 && Date.now() - seekIssuedAtRef.current > 400) {
          seekIssuedAtRef.current = 0;
          setSeekPending((previous) => (previous ? false : previous));
        }

        // A TICK IS A MOVING PICTURE. `timeUpdate` only arrives while frames are
        // being produced, so it is the one event that proves a recovery worked —
        // and the ring must come down on it even when the recovery was a
        // `cap`, which re-selects a track without a replace and therefore fires
        // no first-frame event at all.
        setRecovering((previous) => (previous ? false : previous));

        if (!mediaSwitchRef.current && p.currentTime - lastSaved.current > SAVE_EVERY) {
          lastSaved.current = p.currentTime;
          void savePosition(animeId, epNum, p.currentTime);
        }

        // 82% rule. One AniList write per episode, fired once.
        //
        // NOT SIGNED IN IS NOT A FAILURE — it is the reason there is nothing to
        // send. Without this guard the mutation was still attempted for a
        // logged-out viewer: it threw "Sign in to track progress", and the
        // catch below put it on a 60s cooldown and tried again on the next
        // tick, for the rest of the playback — a loop that can never succeed.
        // The episode is deliberately NOT marked synced, so signing in later
        // still syncs it.
        if (
          !mediaSwitchRef.current &&
          signedInRef.current &&
          !progressSynced.current &&
          dur > 0 &&
          Date.now() >= syncCooldownUntil.current
        ) {
          const threshold =
            totalEpsRef.current === 1 || dur < SHORT_EPISODE ? MARK_FINISHED : SYNC_AT;
          if (p.currentTime / dur >= threshold) {
            progressSynced.current = true;
            void syncProgressRef
              .current(epNum)
              .then(() => {
                void markSynced(animeId, epNum);
                // DELIBERATELY NO TOAST. The 82% sync is the tracker doing its
                // ordinary job, not an event worth interrupting the picture
                // for — a player surface stays silent about bookkeeping.
              })
              .catch(() => {
                // Not synced. Clear the flag so a later tick can retry, but put it
                // behind a cooldown — otherwise a user pausing at the 82% mark
                // fires a request every 0.5s.
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
          // ══════════════════════════════════════════════════════════════════
          // THE RESUME SEEK RUNS EXACTLY ONCE PER MEDIA ITEM.
          //
          // `readyToPlay` is NOT "the video is ready", it is "the pipeline is
          // ready" — and it fires again on every refill, which a seek into
          // unbuffered territory causes. Re-issuing the resume seek on each of
          // those is a feedback loop:
          //
          //   readyToPlay → currentTime = 24 → seek forces a refill
          //              → 'loading' (spinner) → refill finishes
          //              → readyToPlay → currentTime = 24 → …
          //
          // The user sees a player pinned at 0:24 that never advances, a
          // permanent spinner, and play/pause flickering as it alternately
          // starts and stalls. The saved position is not the cause; re-applying
          // it on every readiness is.
          //
          // `sought` is what makes the resume a RESUME instead of a recurring
          // seek. It is cleared by the media-item effect below, so it is once
          // per source/quality/episode — never once per app session.
          // ══════════════════════════════════════════════════════════════════
          if (pendingSeek.current != null) {
            // A deliberate source/quality switch: restore the position the user
            // was at, and consume the request so it cannot repeat.
            const t = pendingSeek.current;
            pendingSeek.current = null;
            // `sought` is marked here too. The stored resume below would
            // otherwise fire on the NEXT readiness — landing on a stale saved
            // position (up to `SAVE_EVERY` behind) and undoing the exact
            // position this branch just restored.
            sought.current = true;
            if (t > 0) {
              if (firstFrameRef.current) applyResumePosition(t);
              else resumeSeekAfterFrameRef.current = t;
            }
          } else if (!sought.current) {
            sought.current = true;
            // `loadResumeOnce`, not `loadPosition` — the read was started at mount
            // and this reuses it. Calling `loadPosition` here is what put an
            // AsyncStorage round trip between "the pipeline is ready" and "the
            // episode resumes", which is the window the viewer saw as the player
            // starting from 0:00.
            void loadResumeOnce().then((pos) => {
              // ⚠️ SETTLE THE TIMELINE HERE, BEFORE the branches — the flag
              // answers "do we know where playback is", and the mount-time
              // read has just answered it. It used to be set only by the
              // downstream consumers (the resume seek in
              // `applyResumePosition`, or this else-branch), so any device
              // where `readyToPlay`'s downstream plumbing stalls — a
              // `first-frame` event that never lands, a seek that never
              // applies — left the bar mindlessly grey with `--:--` clocks
              // and no knob FOREVER, while the stream visibly played. Two
              // effects follow from settling here: the timeline may draw at
              // the live position for a frame before a pending resume seek
              // snaps it forward (a mismatch measured in frames, not the
              // seconds-long gap this gate was built to prevent — the read
              // is mount-time now, so that gap does not exist), and the
              // backstop in the `timeUpdate` listener below becomes a second
              // layer rather than the only one.
              setResumeSettled(true);
              if (pos > 10) {
                if (firstFrameRef.current) applyResumePosition(pos);
                else resumeSeekAfterFrameRef.current = pos;
              }
              pushPresence(player.playing);
            });
          }
        }
        if (p.status === 'error') {
          /**
           * KEEP THE ENGINE'S WORDS.
           *
           * `StatusChangeEventPayload.error` is the only failure detail
           * expo-video offers, and it was being read and thrown away — every
           * cause became one sentence, and by the time the rounds ran out the
           * message on screen could not distinguish an expired signed URL from
           * a dead network. Recorded here rather than at the error card because
           * the LAST failure is the useful one: by the time the budget is spent
           * the viewer is looking at the reason the final source gave, not the
           * first one's.
           *
           * ONLY A GENUINE TRANSITION INTO error acts. `statusChange` re-fires
           * while the status sits at 'error' (the docs make no exactly-once
           * promise), and a monitor that hopped on every emission burned the
           * whole walk budget on ONE failure — several rounds for a single dead
           * source, each hop spending `pendingSeek` and a `replaceAsync` on a
           * player that has already moved on. The next source's own transition
           * into error brings its hop; the re-emissions bring nothing.
           */
          if (p.oldStatus !== 'error') {
            setFailure(describeFailure(p.error?.message));
            // The one line the failover walk swallows: WHICH source failed and
            // WHY, on the device where the extension probe said it was alive
            // seconds earlier. `adb logcat -s ReactNativeJS` reads this.
            if (__DEV__) {
              console.warn(
                `[player] source ${srcIndexRef.current} (${sourcesRef.current[srcIndexRef.current]?.quality ?? '?'}) failed:`,
                p.error?.message ?? p.error
              );
            }
            failoverRef.current(p.error?.message ?? undefined);
          }
        }
      })
    );

    /**
     * The resolution actually playing.
     *
     * Read-only on the player, so this can only ever be an observation — which
     * is exactly why it is worth a listener. It answers the question the
     * quality menu otherwise cannot: under Auto, which rung did the pipeline
     * actually pick? A label that says "Auto" tells the viewer nothing about
     * what their bandwidth is being asked to carry, and this is the only signal
     * that can.
     */
    subs.push(
      player.addListener('videoTrackChange', ({ videoTrack }) => {
        setLiveHeight(videoTrack?.size.height ?? null);
      })
    );

    // Presence: pause/play reflects EVENT-side, not from the two buttons.
    // The buttons each have their own handler and the first presence build
    // wired the pushes there — one handler forgotten (or a programmatic
    // pause, like the error card's) and the card silently stayed "Watching".
    // `playingChange` is the one truth both buttons and every pause path go
    // through. The 'settle' tier below waits out button-mashing.
    //
    // The `playedRef` gate is the episode-start buffer answer: a pause flip
    // before the item has ever produced a tick is not a pause the card can
    // show — a dead source at t≈0 pauses on the error path, a viewer can tap
    // pause during the initial buffer — and "(Paused)" for an episode that
    // never played a frame is a lie. Those flips are dropped and the card
    // keeps the neutral load-time frame ("Episode N", no timeline) until
    // frames are real. Once `playedRef` is set (first tick past 0.5s) every
    // pause is honest and goes out.
    subs.push(
      player.addListener('playingChange', ({ isPlaying }) => {
        if (!isPlaying && !playedRef.current) return;
        pushPresence(isPlaying);
      })
    );

    subs.push(player.addListener('playToEnd', () => {
      // The end of the item being LEFT by an episode switch is not an end the
      // viewer has reached. `player.pause()` should have beaten this event;
      // this is the guard for when it did not.
      if (mediaSwitchRef.current) return;
      // `playedRef` is the witness. A media item that DIES at t≈0 and one that
      // genuinely ends both arrive here; without the witness, every dead source
      // reads as "episode finished" and the player advances into the next one.
      if (!playedRef.current) {
        failoverRef.current();
        return;
      }
      void savePosition(animeId, epNum, player.duration || 0);
      // AUTO-ADVANCE. The manual next-episode button already worked; this is
      // the player pressing it for the viewer when the stream reaches its end.
      // `nextPlayableEpisode` is AniList's aired count, not the season total —
      // an airing show at its last released episode stays parked instead of
      // resolving into an unaired episode's error card. The 82% sync is
      // already in flight here and outlives this screen; the finale's
      // COMPLETED write does not need this handler at all.
      const next = autoAdvanceRef.current;
      if (next != null) {
        // THE CARD IS THE AUTO-ADVANCE. It shows what is queued, counts down
        // and lets the viewer stop it; at zero it calls `onAdvance`, which goes
        // through `goToEpisode` — not the router (see there).
        setUpNext(next);
        void prefetchNextEpisode(next);
      } else {
        // PARKED FINALE. Nothing follows, so the player stops here and the
        // viewer holds the last frame. Two things have to flip with it, or the
        // transport lies about the state it is in:
        //
        //   `desiredPlayingRef` drops, because nothing is playing. It is still
        //   `true` here (the wheel was never turned — this is the stream running
        //   out, not the viewer pausing), and `onPlayPause` reads it to decide
        //   pause-vs-play. Left `true`, the first ▶ tap computes "pause" and
        //   no-ops, and only the SECOND tap plays — a dead-looking button.
        //
        //   `endedRef` arms so that ▶ rewinds before playing. In the ended state
        //   a bare `play()` does nothing, so the tap that should restart the
        //   episode would otherwise be swallowed.
        //
        // NOT set on the auto-advance branch above: there the next episode is
        // about to autoplay, and dropping the intent flag would land it paused.
        desiredPlayingRef.current = false;
        endedRef.current = true;
      }
    }));

    // The subtitle overlay's OWN tick — see `SUBTITLE_TICK_MS`. The
    // `timeUpdate` handler above already looks up a cue, but only every 0.5s
    // (the interval the presence push, the health monitor and the auto-skip all
    // share), and a cue boundary that lands between two of those samples is
    // half a second late. This one only re-reads the playhead and re-picks the
    // cue; the sync correction is applied by `cueAtSync` on both paths through
    // the ref, so it takes effect on the very next tick after the slider moves.
    const cueTimer = setInterval(() => {
      // 120ms is the right cadence for a picture with cues on it, and pure cost
      // for a screen nobody is looking at.
      if (!appActiveRef.current) return;
      showCueAt(player.currentTime);
    }, SUBTITLE_TICK_MS);

    return () => {
      // Last-chance save: the 10s backstop above can leave up to `SAVE_EVERY`
      // seconds of progress on the floor when the viewer leaves mid-window.
      // Persist whatever the playhead last reported so the next open resumes
      // where they actually were rather than at the previous checkpoint.
      if (positionRef.current > 5) {
        void savePosition(animeId, epNum, positionRef.current);
      }
      clearInterval(cueTimer);
      for (const s of subs) s.remove();
    };
  }, [player, animeId, epNum, pushPresence, applyResumePosition, readHealth, loadResumeOnce, showCueAt, prefetchNextEpisode]);

  // Everything that is per-MEDIA-ITEM rather than per-episode, cleared in one
  // place. Two effects used to reset `playedRef` and `autoSkippedOpening`
  // separately on the same dependencies; one list cannot drift out of sync with
  // the other.
  useEffect(() => {
    playedRef.current = false;
    // The stability heartbeat measures the playhead across ONE item, so its
    // anchor moves with the item.
    //
    // ⚠️ THE ANCHOR IS THE ONLY HEARTBEAT STATE THAT BELONGS HERE. The quiet
    // window (`lastStallAtRef`) and the silence allowance stay with the EPISODE
    // (see the `epNum` effect): this effect also runs on every source hop, and
    // clearing the quiet window there would RESTART it at zero — which reads as
    // "quiet for fifty years" and hands the walk its budget back on the next
    // heartbeat. That is the loop this pass removed, re-opened one hop at a time.
    stableAnchorRef.current = -1;
    lastStatusRef.current = null;
    // The parked-finale flag belongs to the media item that ended. A source,
    // quality or EPISODE switch re-runs this effect, and the fresh item is not
    // parked — leaving it set would make the first ▶ on the new episode rewind
    // it to 0.
    endedRef.current = false;
    autoSkippedOpening.current = false;
    autoSkippedEnding.current = false;
    lastSaved.current = 0;
    // The presence pushes restart per media item too: the new source's
    // duration is unknown again (the card needs its fresh timeline push) and
    // the bucket belongs to the old source's playhead.
    presenceTimedSent.current = false;
    presenceBucket.current = -1;
    // `sought` clears HERE, which is what makes "resume exactly once" mean once
    // per media item rather than once per app session. Without this, changing
    // source would silently refuse to resume.
    sought.current = false;
    offlinePositionRef.current = 0;
    // The buffer monitor starts over with every media item, for the same reason
    // `playedRef` does: the buffer behind the previous source describes a
    // connection that no longer exists, and a fresh source that happens to start
    // thin must be judged on its own merits rather than inheriting a starvation
    // run — which would drop a tier within seconds of arriving on a source that
    // was never the problem.
    healthRef.current = resetHealth(Date.now());
    setHealth(UNKNOWN_HEALTH);
    // The buffer readout belongs to the media item that was just replaced.
    lastBufferedRef.current = -1;
    // The "up next" card belongs to the media item that ENDED. A source,
    // quality or episode switch re-runs this effect; a card left up would jump
    // to the episode after a stale one.
    setUpNext(null);
    // `epNum` IS the trigger. The body does not read it, but this effect's whole
    // job is "a different media item is in the player now", and since
    // `goToEpisode` keeps this screen mounted an episode change no longer
    // arrives as a fresh mount. Without it: `sought` stays true, the new
    // episode's stored position is skipped, and it opens at 0:00; `playedRef`
    // stays true, so a new item that dies at t≈0 would read as "episode
    // finished" and auto-advance.
  }, [epNum, srcIndex, qualitySel, reloadNonce]);

  // -------------------------------------------------------------------------
  // Quality gather
  // -------------------------------------------------------------------------
  const gatheringRef = useRef(false);
  const variantsLoadedRef = useRef(false);
  /**
   * "A rung is remembered and the ladders were just re-minted — re-seat it."
   *
   * Set by a token refresh, consumed by the gather that follows. It cannot be
   * acted on at the refresh itself: at that moment `variantsBySource` still
   * holds the DEAD token's urls, and an applier that ran against them would hand
   * the replace a variant from the server that just rejected the refresh. The
   * gather is the first moment the label can be resolved against urls that work.
   */
  const reseatQualityRef = useRef(false);
  const gatherAttemptRef = useRef(0);
  const qualityPhaseRef = useRef<'idle' | 'loading' | 'ready' | 'empty' | 'failed'>('idle');
  const [qualityPhase, setQualityPhase] = useState<'idle' | 'loading' | 'ready' | 'empty' | 'failed'>('idle');
  qualityPhaseRef.current = qualityPhase;

  const gatherVariants = useCallback(async (force = false, only?: number[]) => {
    if (gatheringRef.current) return;
    const list = sourcesRef.current;
    if (list.length === 0) return;
    const indexes = (only ?? list.map((_, i) => i)).filter((i) => i >= 0 && i < list.length);
    if (!indexes.length) return;
    if (!force && indexes.every((i) => variantsRef.current[i] !== undefined)) return;
    if (isOffline()) {
      setQualityPhase('failed');
      return;
    }

    gatheringRef.current = true;
    const attemptId = ++gatherAttemptRef.current;
    setQualityPhase('loading');

    const readSubset = async (indexes: number[]) => {
      const out = new Map<number, HlsVariant[] | null>();
      await Promise.all(
        indexes.map(async (i) => {
          try {
            out.set(i, await listVariants(list[i].url, list[i].headers ?? {}));
          } catch {
            out.set(i, null);
          }
        })
      );
      return out;
    };

    try {
      let result = await readSubset(indexes);
      if (attemptId !== gatherAttemptRef.current) return;

      // Retry is now LAZY: a failed read is left failed here, and only
      // retried when the viewer opens the quality menu (see the menu effect
      // below, which calls `gatherVariants(true)`). Hammering a dead or slow
      // host on a background prefetch is exactly what made a bad connection
      // worse; the menu is the viewer asking "what is actually available".
      const failed = [...result.entries()]
        .filter(([, v]) => v === null)
        .map(([i]) => i);

      if (attemptId !== gatherAttemptRef.current) return;

      const by: Record<number, HlsVariant[]> = { ...variantsRef.current };
      let ok = 0;
      let any = false;
      for (const [i, v] of result) {
        if (v === null) continue;
        ok++;
        if (v.length) {
          by[i] = v;
          any = true;
        } else if (!(i in by)) {
          by[i] = [];
        }
      }

      const stillFailing = failed.length > 0 && ok === 0;
      if (stillFailing) {
        variantsLoadedRef.current = variantsLoadedRef.current || Object.keys(by).length > 0;
        setVariantsBySource(by);
        setQualityPhase(variantsLoadedRef.current ? 'ready' : 'failed');
      } else {
        variantsLoadedRef.current = true;
        setVariantsBySource(by);
        setQualityPhase(any ? 'ready' : 'empty');
      }
      // The ladders in `by` are the CURRENT list's. A refresh asked for the
      // remembered rung to be re-seated, and this is the moment it can be: the
      // applier runs on the commit that publishes them, with `qualitySel`
      // dropped, so it resolves the label against working urls.
      if (reseatQualityRef.current) {
        reseatQualityRef.current = false;
        qualityChosenRef.current = false;
      }
    } finally {
      gatheringRef.current = false;
    }
  }, []);

  // A resolve that lands new sources invalidates every quality verdict the
  // previous attempt produced: its URLs, its ladder, and its "loaded" flag.
  // Doing it in one place here keeps `gatherVariants` from reusing a stale map.
  useEffect(() => {
    variantsLoadedRef.current = false;
    gatherAttemptRef.current += 1;
    setQualityPhase('idle');
    setVariantsBySource({});
    // THE ACTIVE SOURCE ONLY. This used to read every source's master playlist
    // in parallel the moment a resolve landed — seven round trips competing with
    // the segment fetches the player is waiting on, on the connection that is
    // already the reason the picture is thin. The active ladder is the one the
    // recovery step needs; the rest are read when the quality menu is opened.
    if (sources.length > 0) void gatherVariants(false, [srcIndexRef.current]);
  }, [sources, gatherVariants]);

  // A hop needs the DESTINATION's ladder — it is what the recovery ladder steps
  // down into if the new server is also too slow. One read, on arrival.
  useEffect(() => {
    if (sources.length === 0) return;
    if (variantsBySource[srcIndex] !== undefined) return;
    void gatherVariants(false, [srcIndex]);
  }, [srcIndex, sources.length, variantsBySource, gatherVariants]);

  // Menu open is the viewer asking "what is actually available", so a failed
  // gather gets another attempt there instead of staying broken until a
  // reconnect. A successful gather is not re-run: the ladders do not change
  // while the same episode is open.
  useEffect(() => {
    if (menu !== 'quality') return;
    // THE MENU IS WHERE THE REST OF THE LIST IS READ. Its rows are one per
    // distinct label across every source, so opening it is the moment the full
    // gather is worth its requests — and it is the viewer asking, not a
    // background prefetch competing with the segment the player needs.
    const partial = sourcesRef.current.some((_, i) => variantsRef.current[i] === undefined);
    if (qualityPhase === 'failed' || partial) void gatherVariants(true);
    else if (qualityPhase === 'idle') void gatherVariants();
  }, [menu, qualityPhase, gatherVariants]);

  /**
   * One entry per DISTINCT quality across every source, preferring the variant
   * owned by the active source so picking it needs no source switch.
   */
  const mergedQualities = useMemo(() => {
    const byLabel = new Map<string, { label: string; src: number; v: number; own: boolean }>();
    for (let si = 0; si < sources.length; si++) {
      const list = variantsBySource[si];
      if (!list?.length) continue;
      list.forEach((v, vi) => {
        const own = si === srcIndex;
        const cur = byLabel.get(v.label);
        if (!cur || (own && !cur.own)) {
          byLabel.set(v.label, { label: v.label, src: si, v: vi, own });
        }
      });
    }
    return [...byLabel.values()].sort((a, b) => {
      const ah = heightOf(a.label);
      const bh = heightOf(b.label);
      if (ah !== bh) return bh - ah;
      // A variant this source owns sorts first, so the common case is the
      // top row rather than buried by an equal height from another server.
      return Number(b.own) - Number(a.own);
    });
  }, [sources, variantsBySource, srcIndex]);

  /**
   * A VIEWER DECISION RESTARTS EVERY AUTOMATIC VERDICT.
   *
   * The ladder's reductions were answers to a connection; picking a quality or
   * a server is the viewer saying the question has changed. Both the counters
   * and the ABR ceiling go back to zero, so the next stall is judged on its own.
   */
  const resetAutoRecovery = useCallback(() => {
    recoveryRef.current = initialRecovery();
    autoQualityRef.current = false;
    try {
      player.maxResolution = null;
    } catch {
      /* the native player may already be released */
    }
  }, [player]);

  const onPickQuality = useCallback(
    (key: string) => {
      if (key === '__retryq') {
        void gatherVariants(true);
        return;
      }
      if (key === '__loading' || key === '__noq' || key === '__failed') return;

      // Any manual pick — a rung OR Auto — is the viewer steering. The
      // default-quality applier stands down for the rest of this attempt.
      qualityChosenRef.current = true;
      // …and the ladder's verdicts about this connection do not survive the
      // viewer choosing something else.
      resetAutoRecovery();
      // Capture where the viewer is BEFORE the replace, so the switch lands back
      // there instead of at 0:00. `player.currentTime` is read synchronously
      // here rather than from `position`, because `position` trails the real
      // playhead by up to `timeUpdateEventInterval`.
      const at = player.currentTime;
      if (key === 'auto') {
        qualitySelRef.current = null;
        setQualitySel(null);
        // Auto is a DECISION, so it clears the proven rung — otherwise the
        // memory would re-lock the old height on the next resolve and this
        // button would be a lie.
        qualityPrefRef.current = null;
        void saveQualityPref(animeId, null);
        pendingSeek.current = at;
        setReloadNonce((n) => n + 1);
      } else {
        const [src, v] = key.split(':').map(Number);
        if (!Number.isFinite(src) || !Number.isFinite(v)) return;
        qualitySelRef.current = { src, v };
        setQualitySel({ src, v });
        // The viewer's pick is the intent — remember it as the rung that works
        // for this show, whether or not this attempt's source is the one that
        // ends up rendering it.
        const pickedLabel = variantsRef.current[src]?.[v]?.label ?? null;
        qualityPrefRef.current = pickedLabel;
        if (pickedLabel) void saveQualityPref(animeId, pickedLabel);
        if (src === srcIndexRef.current && variantsRef.current[src]?.[0]?.separateAudio === true) {
          // 🎧 GAPLESS. The rung on this master is a ceiling, not a URL: the
          // stream is never re-opened, so nothing buffers again and the audio
          // rendition is never dropped. This is what a real player does when
          // you pick a quality — the picture simply re-seats itself.
          try {
            player.maxResolution = capFor(variantsRef.current[src]?.[v]);
          } catch {
            /* the native player may already be released */
          }
          pendingSeek.current = null;
        } else if (src !== srcIndexRef.current) {
          pendingSeek.current = at;
          setSrcIndex(src);
        } else {
          pendingSeek.current = at;
          setReloadNonce((n) => n + 1);
        }
      }
      setMenu(null);
    },
    [player, gatherVariants, animeId, resetAutoRecovery]
  );

  /**
   * THE RUNG APPLIER — the proven height first, then the stated default.
   *
   * Fires when the cross-source variant gather lands (and on every source
   * change afterwards), and locks a rung if the episode actually offers it —
   * the active source's own variant first (no source switch needed), else
   * whichever source owns it, moving to that source exactly as a manual
   * cross-source pick does. Candidates are tried in order: the rung this show
   * last actually PLAYED (`miori:qPref:{id}`), then `player.defaultQuality`.
   * Nothing offered from either list, or the viewer already steered this
   * attempt: stand down and stay in Auto. A preference that cannot be honoured
   * must never cost an episode, and must never fight a viewer who pressed Auto
   * — that is what `qualityChosenRef` and the empty-hand fall-through are.
   */
  useEffect(() => {
    if (qualityChosenRef.current) return;
    if (qualitySelRef.current) return;
    /**
     * THE PROVEN RUNG OUTRANKS THE STATED DEFAULT.
     *
     * `miori:qPref:{id}` is written when a rung actually RENDERED (see
     * `onFirstFrame`) and when the viewer picked one, so it is evidence — "this
     * height played for this show on this device a moment ago". The setting is
     * a guess the viewer typed once, possibly months and several providers
     * ago. Returning to an episode used to land on the default and make the app
     * look like it had forgotten the 1080p it was just playing. This is the
     * same precedence the source walk uses (`pickStartIndex`): proof, then the
     * stated default, then Auto.
     *
     * Still a preference, never a requirement: a rung nobody offers falls
     * through to the next candidate, and Auto is never overridden by force.
     */
    const stated = readSetting('player.defaultQuality');
    const wanted: string[] = [];
    if (qualityPrefRef.current) wanted.push(qualityPrefRef.current);
    if (stated && stated !== 'auto' && !wanted.includes(stated)) wanted.push(stated);
    if (!wanted.length) return;
    const findLabel = (si: number, label: string): number => {
      const list = variantsBySource[si];
      if (!list) return -1;
      return list.findIndex((v) => v.label === label);
    };
    for (const label of wanted) {
      const own = findLabel(srcIndexRef.current, label);
      if (own >= 0) {
        qualitySelRef.current = { src: srcIndexRef.current, v: own };
        setQualitySel(qualitySelRef.current);
        return;
      }
      for (let si = 0; si < sourcesRef.current.length; si++) {
        const vi = findLabel(si, label);
        if (vi >= 0) {
          qualitySelRef.current = { src: si, v: vi };
          setQualitySel(qualitySelRef.current);
          // The source moves with the rung — the load effect below replaces
          // the media with the variant URL in one step, same as onPickQuality.
          setSrcIndex(si);
          return;
        }
      }
    }
  }, [variantsBySource, sources, srcIndex]);

  const onPickSource = useCallback(
    (key: string) => {
      // Both paths are a viewer decision about this connection.
      resetAutoRecovery();
      if (key === '__refresh') {
        const currentExt = sourcesRef.current[srcIndexRef.current]?.extId;
        if (currentExt) void saveSourcePref(animeId, currentExt);
        // AN EXPLICIT REFRESH IS THE USER ASKING AGAIN, so every session verdict
        // goes back on trial (the proof is kept). A skipped provider is not even
        // probed while marked, and this is the only way to get its rows back
        // without restarting the app.
        clearSourceTrips();
        bumpLedger();
        // Preserve an already-pending target (e.g. a reconnect position) rather than
// overwriting it with a playhead that may have been reset to 0 by a failed
// replaceAsync. Only adopt the current playhead when nothing is pending.
if (pendingSeek.current == null) {
  const at = player.currentTime;
  if (at > 0) pendingSeek.current = at;
}
        budgetRef.current = freshBudget();
        void load({ fresh: true });
        setMenu(null);
        return;
      }
      const i = Number(key);
      if (!Number.isFinite(i) || i === srcIndexRef.current) {
        setMenu(null);
        return;
      }
      // Preserve an already-pending target (e.g. a reconnect position) rather than
// overwriting it with a playhead that may have been reset to 0 by a failed
// replaceAsync. Only adopt the current playhead when nothing is pending.
if (pendingSeek.current == null) {
  const at = player.currentTime;
  if (at > 0) pendingSeek.current = at;
}
      // Picking a SERVER is not picking Auto. The rung this show plays moves
      // with the viewer to the source they chose.
      const carried = qualityForSource(i);
      qualitySelRef.current = carried;
      setQualitySel(carried);
      setSrcIndex(i);
      // THE VIEWER'S CHOICE IS THE INTENT — save it here, not only when a
      // frame proves it. `onFirstFrame` would save the same value moments
      // later, but a viewer who picks Mega explicitly wants Mega even if this
      // episode's Mega row happens to be dead and the walk hops on.
      const picked = sourcesRef.current[i];
      // AN EXPLICIT PICK BEATS THE SESSION'S OPINION — ONCE. A faded row is one
      // the ledger has written off; tapping it is the viewer saying "try it
      // again now", so the skip is cleared before the load. If it fails, the
      // walk trips it again. The Settings default deliberately does NOT do this:
      // it is a standing preference, not a "try now" command.
      if (picked?.extId) {
        clearSourceTrip(picked.extId);
        bumpLedger();
      }
      lastSavedExtRef.current = picked?.extId ?? null;
      void saveSourcePref(animeId, picked?.extId);
      setMenu(null);
    },
    [player, animeId, load, qualityForSource, bumpLedger, resetAutoRecovery]
  );

  // -------------------------------------------------------------------------
  // The buffer monitor
  //
  // THIS IS WHAT WAS MISSING. The player had a FIRST-FRAME watchdog — armed by
  // `replaceAsync`, cancelled by the first rendered frame — and nothing else, so
  // it could only ever answer "this source never started". A stream that played
  // for ten minutes and then died on a train held an indefinite spinner with no
  // Retry, no message and no timeout, because every input to that loop had
  // already been delivered and none of them could change the outcome.
  //
  // `STALL_MS` lived in `legacy/VerticalPlayerScreen.tsx` and was not carried
  // over when the landscape player replaced that screen.
  // -------------------------------------------------------------------------
  useEffect(() => {
    const tick = () => {
      /**
       * GATED ON A RENDERED FRAME, and the gate is load-bearing.
       *
       * The two watchdogs answer different questions and must not both fire.
       * The frame watchdog owns "this source never rendered anything at all" —
       * wrong MIME type, a declined extractor, a CDN that answers but does not
       * honour. A player that has never shown a pixel has a playhead frozen at
       * zero, which the health module would read as a stall in fifteen seconds
       * and answer with its own failover — two watchdogs, one failure, two
       * rounds of the retry budget spent on a single dead source.
       *
       * The reverse direction matters too: once a frame HAS landed, the frame
       * watchdog is disarmed forever (`onFirstFrame` clears it) and this monitor
       * is the only thing left standing.
       */
      if (!firstFrameRef.current) return;
      // Off-screen: nothing is watching, and a sample taken from a throttled
      // timer answers a question about the app, not about the stream.
      if (!appActiveRef.current) return;

      // OFFLINE: the phone is not a verdict about the stream. Keep the clocks
      // from aging into a stall (trap 3 applies to the whole app, not just the
      // app switcher) and report nothing — the offline pill carries the only
      // word the viewer needs, and the reconnect effect handles recovery.
      if (offlineRef.current) {
        const now = Date.now();
        healthRef.current = noteInterruption(readHealth(now), now);
        setHealth((prev) => (prev.kind === 'unknown' ? prev : UNKNOWN_HEALTH));
        // OFFLINE MID-PLAYBACK. Buffered content keeps playing, but once the
        // buffer runs out (status flips to 'loading' / the playhead stops) there
        // is nothing to wait for — surface the offline card instead of a ring
        // that can never recover. The card pauses the player, which is correct:
        // there is no stream to resume until the connection returns.
        if (
          desiredPlayingRef.current &&
          (player.status === 'loading' || !player.playing) &&
          !errorRef.current
        ) {
          const at = Math.max(player.currentTime, positionRef.current);
          if (at > 0) offlinePositionRef.current = at;
          // SAVE IT NOW. The reconnect restore reads this ref, but the ref dies
          // with the screen: a viewer who backs out while the card is up and
          // returns later must still land where the buffer ran out. The 10s
          // checkpoint is up to `SAVE_EVERY` seconds behind, and the unmount
          // save cannot see a playhead the engine has already reset.
          if (at > 5) void savePosition(animeId, epNum, at);
          setFailure(null);
          setError(OFFLINE_MESSAGE);
          errorRef.current = OFFLINE_MESSAGE;
        }
        return;
      }

      // IS ANYTHING STILL ARRIVING? Sampled EVERY tick so the ladder's answer is
      // a one-second window rather than the last time it happened to act — a
      // slow connection is exactly the case where "the buffer grew a little,
      // just far too slowly" must be distinguishable from "nothing came back".
      const bufferedNow = player.bufferedPosition;
      /**
       * ⚠️ `bufferedPosition` REPORTS **0.0** WHILE BUFFERING — the SDK's own
       * getter collapses the readout in `STATE_BUFFERING` rather than answering
       * `-1`. So during a rebuffer the delta below is always negative and the
       * ladder's "still downloading, WAIT" rule could never fire on Android: it
       * escalated on every stall, at 15s, forever.
       *
       * The second term is the honest evidence the numeric readout cannot give:
       * the pipeline left BUFFERING between two samples, which means it received
       * enough to become ready again. That is a slow-but-working connection, and
       * the patience it earns (up to `DOWNLOADING_PATIENCE_MS`) is exactly what a
       * weak phone on a weak link needs instead of another re-open.
       */
      const cameBackReady =
        lastStatusRef.current !== 'readyToPlay' && player.status === 'readyToPlay';
      lastStatusRef.current = player.status;
      const grew =
        (lastBufferedRef.current >= 0 && bufferedNow > lastBufferedRef.current + 0.25) ||
        cameBackReady;
      lastBufferedRef.current = bufferedNow;

      const at = Date.now();
      const verdict = observeHealth(
        readHealth(at),
        {
          position: player.currentTime,
          buffered: player.bufferedPosition,
          status: player.status,
          /**
           * INTENT-AWARE PLAYING — the rebuffer spinner fix (14 Nov device
           * report: "instead of spinner it shows pause like control").
           *
           * On an underrun expo-video flips `playing` to false while the buffer
           * refills — the pipeline's state, not the viewer's. Fed raw, that
           * trips Rule 0 ("not playing → inactive") FIRST, before the rebuffer
           * rule can ever see the frozen playhead, so no `frozenMs` accumulates
           * and the ring never appears: the viewer sees the transport's big
           * button instead and reads it as "the video paused".
           *
           * The viewer's intent (`desiredPlayingRef`, captured at the wheel on
           * every play/pause gesture) is what separates a stall from a pause —
           * but it cannot be OR-ed in UNCONDITIONALLY, for two states Rule 0
           * must keep covering:
           *  • Episode finished: `playToEnd` leaves the player parked at the
           *    end with intent still true — an unconditional OR would let the
           *    frozen playhead hit Rule 1 fifteen seconds later and FAILOVER
           *    into replaying the episode the viewer just finished.
           *  • A system pause (audio focus, a call) the gesture never saw:
           *    same trap, one round of the failover budget spent on a healthy
           *    source.
           *
           * Both non-stall states report `readyToPlay`; a mid-playback rebuffer
           * reports `loading` (the SDK has no 'buffering' status — see the note
           * in `observeHealth` at the frozen-playhead rule). Gating the intent
           * on that status keeps Rule 0 armed for every real pause and parked
           * end, while letting an underrun accumulate `frozenMs` →
           * 'rebuffering' (the ring at 700ms) → the existing 15s failover if
           * the stall never recovers. The paused viewer (intent false) is
           * unaffected whatever the status is.
           */
          playing: player.playing || (desiredPlayingRef.current && player.status === 'loading'),
          at,
        },
        healthBounds
      );
      healthRef.current = verdict.state;

      // Guarded on the verdict's IDENTITY as well as its value, because this
      // runs once a second for the whole session and an unguarded `setState`
      // here is the difference between a player that costs nothing when idle and
      // one that re-renders four times a minute forever. `inactive` and
      // `unknown` both carry nothing worth a render, so they share one value.
      const shown =
        verdict.health.kind === 'inactive' || verdict.health.kind === 'unknown'
          ? UNKNOWN_HEALTH
          : verdict.health;
      setHealth((prev) => (prev.kind === shown.kind ? prev : shown));

      /**
       * NO AUTOMATIC QUALITY CHANGE. A thin buffer is reported as `starving`
       * and then left alone: the old auto-downgrade passed a quality LABEL to
       * `onPickQuality`, which expects a `src:variant` key, so it never changed
       * the rung — it only flashed a toast and, on a slow connection, repeated
       * on every failover. Silent quality changes are not this player's call.
       */

      if (verdict.health.kind === 'stalled') {
        // THE QUIET WINDOW RESTARTS HERE. A stretch that reached a stall verdict
        // has proven nothing, whatever frames happened to land inside it, so the
        // heartbeat must not forgive the budget while this keeps happening.
        lastStallAtRef.current = Date.now();
        // NOT a failover any more. Hopping servers throws away every byte
        // already buffered — the one thing a starved stream cannot afford — so
        // the ladder asks for less bitrate first, then reloads in place, and
        // only then walks on. The failover budget bounds the walk.
        recoverStreamRef.current(verdict.health.ahead, verdict.health.frozenMs, grew);
      }
    };

    const id = setInterval(tick, HEALTH_TICK_MS);
    return () => clearInterval(id);
  }, [player, healthBounds, readHealth, animeId, epNum, showCueAt]);

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE STABILITY HEARTBEAT — the only thing that forgives a failing stretch
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * The failover budget and the recovery ladder bound how much a BROKEN stream
   * may cost. Something has to hand those budgets back, or a long session would
   * eventually refuse to fail over at all — and the old answer, "a frame landed",
   * is a lie a dead source tells for free.
   *
   * So the proof is measured instead of assumed: once every
   * `STABLE_HEARTBEAT_MS`, if a picture is up, the playhead has advanced by at
      * least `STABLE_PLAY_SEC` since the last look, and no stall verdict has been
   * seen for `QUIET_RESET_MS`, then the failing stretch is over: the walk budget,
   * the reload budget, the silent-hop allowance and the ABR ceilings all start
   * again from a clean state.
   *
   * A stream that plays eight seconds and dies never accumulates the quiet
   * minute, so the walk keeps its rounds and terminates — which is exactly the
   * behaviour a weak connection needs from it: one bounded attempt, then a card
   * with an honest sentence, instead of an endless resolve→re-open loop that
   * blocks the UI thread behind the cache lock.
   *
   * Cheap by construction: six reads of a snapshot refs bag every twenty
   * seconds, no render, nothing native beyond two `currentTime` reads.
   */
  useEffect(() => {
    const id = setInterval(() => {
      if (!mountedRef.current) return;
      if (!firstFrameRef.current || errorRef.current != null) return;
      const live = playerRef.current;
      if (!live) return;
      // A deck in the background does not advance a playhead. Move the anchor so
      // the time away is neither counted as progress nor turned into a stall.
      if (!appActiveRef.current) {
        stableAnchorRef.current = live.currentTime;
        return;
      }
      if (stableAnchorRef.current < 0) {
        stableAnchorRef.current = live.currentTime;
        return;
      }
      const played = live.currentTime - stableAnchorRef.current;
      stableAnchorRef.current = live.currentTime;
      if (!provesStable(played, Date.now() - lastStallAtRef.current)) return;
      budgetRef.current = freshBudget();
      recoveryRef.current = noteStable(recoveryRef.current);
      silentHopsRef.current = 0;
      silentUrlsRef.current.clear();
    }, STABLE_HEARTBEAT_MS);
    return () => clearInterval(id);
  }, []);

  /**
   * Backgrounding must not look like a dead stream.
   *
   * `currentTime` does not advance while the app is away, so a player that
   * returns twenty seconds later is indistinguishable from one whose stream died
   * twenty seconds ago. Without this, every trip to the app switcher spends a
   * round of the retry budget on a perfectly healthy source — and because that
   * is the single most common backgrounding a phone does (a notification, a
   * call, a screenshot), it would look like the app "randomly changes source".
   *
   * The clock is restarted and the DECISIONS are kept, on both edges of the
   * transition. `noteInterruption`'s header is why those are not the same
   * operation: forgetting that a tier was already given up is how a phone that
   * briefly loses signal walks the entire quality ladder, one backgrounding at a
   * time. Restarting on the way BACK matters for the opposite reason — without
   * it the frozen stretch accumulated while away is still waiting when the app
   * returns, and the first tick after resuming declares a stall.
   *
   * IT IS ALSO THE GATE for the two picture-facing timers (`appActiveRef`).
   * Backgrounded, there is no picture to place cues on and no viewer to decide a
   * failover for — and on Android a backgrounded app's timers are throttled and
   * then delivered in a burst, which is a shape the health monitor would happily
   * read as a frozen playhead. Returning to the foreground restarts the clocks
   * above, so the first sample back is judged on its own merits rather than on
   * the time we were away.
   */
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      appActiveRef.current = next === 'active';
      const now = Date.now();
      healthRef.current = noteInterruption(readHealth(now), now);
      // COMING BACK IS A RESYNC. The cue tick is gated while the app is away
      // and the playhead can have moved (a PiP handoff, an audio-focus pause
      // the engine resumed through), so publish at the real position on the
      // way in rather than leaving the line from before the switch on screen.
      if (appActiveRef.current) showCueAt(player.currentTime);
    });
    return () => sub.remove();
  }, [readHealth, showCueAt, player]);

  /**
   * AWAY WITHOUT PIP MEANS PAUSED.
   *
   * The policy and its reasoning live in `lib/player/pip.ts`; this effect is the
   * wiring. Two details belong here:
   *
   *  • The handoff window. An automatic PiP handoff is not synchronous with the
   *    `AppState` change, so acting on 'background' immediately would pause the
   *    video the OS is about to float. The timer gives the handoff its window
   *    (`PIP_HANDOFF_GRACE_MS`) and does nothing if PiP claimed the player first.
   *  • 'inactive' is not away. On iOS a pulled-down notification shade or control
   *    centre produces it while the player is still on screen; pausing for that
   *    would stop the episode every time the viewer checks the time.
   *
   * The play INTENT is dropped along with the pause. Otherwise a failover, a
   * token refresh or the return to the foreground would each be free to press
   * play again on a decision the viewer never made.
   */
  useEffect(() => {
    const clearHandoff = () => {
      if (pipHandoffTimerRef.current) clearTimeout(pipHandoffTimerRef.current);
      pipHandoffTimerRef.current = null;
    };

    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') {
        backgroundHoldRef.current = false;
        clearHandoff();
        // A pending PiP-exit check belongs to the close case only; coming back
        // to the app answers it the other way.
        if (pipExitTimerRef.current) clearTimeout(pipExitTimerRef.current);
        pipExitTimerRef.current = null;
        return;
      }
      if (next !== 'background' || pipActiveRef.current) return;
      clearHandoff();
      pipHandoffTimerRef.current = setTimeout(() => {
        pipHandoffTimerRef.current = null;
        const stage = playbackStage(appActiveRef.current, pipActiveRef.current);
        if (!shouldHoldPlayback(stage)) return;
        backgroundHoldRef.current = true;
        desiredPlayingRef.current = false;
        player.pause();
        // THE SAVE THAT IS NOT AN UNMOUNT. The 10s backstop and the unmount
        // cleanup both assume the process is still alive to run them, and a
        // phone that backgrounds a paused player is precisely the one that gets
        // killed by the OS without ever unmounting this screen. That leaves the
        // stored position up to `SAVE_EVERY` behind — the viewer comes back to
        // a resume that is ten seconds off from where they stopped, for no
        // reason they can see. Written here, at the one moment we know the
        // picture has stopped on purpose.
        //
        // The guards are the same ones every other write keeps: a malformed
        // deep link never produces a `NaN` key, a switch in flight belongs to
        // the OUTGOING episode's playhead, and under five seconds is not a
        // position worth resuming from.
        if (linkOk && !mediaSwitchRef.current && positionRef.current > 5) {
          void savePosition(animeId, epNum, positionRef.current);
        }
      }, PIP_HANDOFF_GRACE_MS);
    });

    return () => {
      clearHandoff();
      if (pipExitTimerRef.current) clearTimeout(pipExitTimerRef.current);
      pipExitTimerRef.current = null;
      sub.remove();
    };
  }, [player, animeId, epNum, linkOk]);

  /**
   * A REMOTE PLAY IS NOT THE VIEWER'S PLAY.
   *
   * `expo-video` keeps a media session for the player, so a headset's play
   * button is a `play()` that arrives with no gesture behind it — the device
   * report was an episode starting from a phone with the screen off after one
   * earbud tap. The engine's own background pause cannot stop that, because the
   * remote command is exactly what it is being asked to obey. Once this app has
   * decided to hold (see the effect above), any play that arrives while it is
   * still backgrounded with no PiP window is undone immediately. A real gesture
   * cannot be affected: the app is not on screen to receive one.
   */
  useEffect(() => {
    const sub = player.addListener('playingChange', ({ isPlaying }) => {
      if (!isPlaying || !backgroundHoldRef.current) return;
      if (!shouldHoldPlayback(playbackStage(appActiveRef.current, pipActiveRef.current))) return;
      player.pause();
      desiredPlayingRef.current = false;
    });
    return () => sub.remove();
  }, [player]);

  // -------------------------------------------------------------------------
  // Subtitles
  // -------------------------------------------------------------------------
  useEffect(() => {
    const t = tracks[trackIndex];
    if (!t) {
      setCues([]);
      return;
    }
    let live = true;
    /**
     * `fetchText`, NOT a bare `fetch`.
     *
     * A bare `fetch` with no signal has no deadline at all: a subtitle host that
     * accepts the connection and then stalls holds the request open forever, the
     * `.catch` below never runs, and the viewer gets silence with no spinner, no
     * message and no retry — indistinguishable from a source that ships no
     * subtitles at all. That is the same hang `fetchTimed` was written to close
     * for the extension client, arriving through a door nobody checked.
     *
     * It also cannot be aborted mid-flight; `live` only suppresses the state
     * write, so switching tracks stacked one open request per tap.
     */
    // THROUGH THE CUE CACHE. A source reload, a quality switch, a failover and
    // a reconnect all hand over a fresh `tracks` array and re-run this effect
    // — and every one of them used to re-download and re-parse the same .vtt,
    // leaving the screen wordless for the length of that round trip. The cache
    // (and its in-flight map, so two rapid switches share one download) makes
    // the handover instant; `fetchText` is still the only network edge, with
    // its deadline, because the parse is not allowed to own a URL's lifetime.
    void cueLoad(t.url, () =>
      fetchText(t.url, 10_000, { headers: t.headers }, 'Subtitles').then(parseVTT)
    )
      .then((list) => {
        if (live) setCues(list);
      })
      .catch(() => {
        // Empty cues is the right failure value — the overlay renders nothing —
        // but it must not be the ONLY signal, which is why the row is greyed
        // rather than hidden. See the `subsLabel` comment below.
        if (live) setCues([]);
      });
    return () => {
      live = false;
    };
  }, [tracks, trackIndex]);

  /**
   * Which track plays, derived — never stored as an index the user has to be
   * right about.
   *
   * The previous version was two effects: one reset the index to `0` on every
   * source load, and another pushed it to the first English track. That second
   * effect fired whenever the `tracks` ARRAY changed identity, and a source load
   * hands over a fresh array — so switching quality, or failing over to another
   * CDN, silently threw the viewer's choice away and put English back. Nothing
   * errored; the pick was just gone.
   *
   * One derived index, recomputed from the stored LANGUAGE, is what makes the
   * choice survive a reload. `pickTrack` holds the precedence — honour the
   * preference, else English, else the first track — and
   * `scripts/check-subtitles.ts` pins it.
   */
  const wantedTrack = useMemo(() => pickTrack(tracks, subsLanguage), [tracks, subsLanguage]);

  useEffect(() => {
    setTrackIndex(wantedTrack);
  }, [wantedTrack]);

  // -------------------------------------------------------------------------
  // Skip markers
  // -------------------------------------------------------------------------
  /**
   * The skip window the playhead is currently inside, or null.
   *
   * Our sources ship `intro`/`outro` directly on `WatchSource`, so this needs no
   * AniSkip round-trip and cannot be wrong about a show it has never seen. The
   * markers arrive from the SOURCE, which means they are only as reliable as the
   * source — hence the conservative auto-skip rule below.
   */
  /**
   * Auto-skip the OPENING only, and only once.
   *
   * Opening-skip-on-entry is what everyone wants and almost never turns out to
   * be a problem: someone who wants the opening can rewind, someone who does not
   * would otherwise watch it every single episode. Endings are NOT auto-skipped,
   * because an outro is often where a show puts its post-credits tag, and
   * skipping it silently is a loss the viewer would not have chosen.
   */
  const autoSkippedOpening = useRef(false);
  const autoSkippedEnding = useRef(false);

  // -------------------------------------------------------------------------
  // Episodes
  // -------------------------------------------------------------------------
  /**
   * GO TO AN EPISODE WITHOUT LEAVING THE PLAYER.
   *
   * This used to be `router.replace(...)`, and a REPLACE is a new route key:
   * the screen unmounted, `useVideoPlayer` released the native player, and the
   * next episode paid a fresh screen + a fresh native player + a fresh resolve
   * + a fade of the whole surface — a visible second of black for a tap that
   * should be instant. `setParams` rewrites the SAME route (same key, same
   * screen, same player, same buffer), so the only work left is the resolve and
   * one `replaceAsync`.
   *
   * Everything the old remount used to do for free is now explicit:
   *   - the old media is paused here, so its audio does not continue behind the
   *     spinner while the next episode resolves;
   *   - `mediaSwitchRef` fences progress writes until the new item lands
   *     (the reset effect and the source effect do the rest);
   *   - a pick is an instruction to play — `desiredPlayingRef` starts true on
   *     a fresh mount, and a replace used to give that for free.
   */
  const goToEpisode = useCallback(
    (n: number) => {
      if (!Number.isInteger(n) || n < 1 || n === epNum) return;
      setUpNext(null);
      mediaSwitchRef.current = true;
      setSwitchPending(true);
      desiredPlayingRef.current = true;
      endedRef.current = false;
      // Nothing carries across the boundary: a position armed for the item
      // being left is not a resume for the item arriving.
      pendingSeek.current = null;
      resumeSeekAfterFrameRef.current = null;
      try {
        player.pause();
      } catch {
        /* the player may already be released */
      }
      router.setParams({ ep: String(n) });
    },
    [player, epNum]
  );

  /**
   * The auto-advance timer fires from the `playToEnd` listener, which is
   * registered far above this declaration and therefore has to reach the
   * callback through a ref — the same contract as `failoverRef`.
   */
  const goToEpisodeRef = useRef(goToEpisode);
  goToEpisodeRef.current = goToEpisode;

  const onPickEpisode = useCallback(
    (n: number) => {
      // A manual pick outranks a queued auto-advance: the viewer said where
      // they want to go, and a countdown finishing a beat later would jump them
      // to the episode they just left.
      setUpNext(null);
      setPanelOpen(false);
      goToEpisode(n);
    },
    [goToEpisode]
  );

  const onPrev = useCallback(() => {
    if (epNum > 1) onPickEpisode(epNum - 1);
  }, [epNum, onPickEpisode]);

  const onNext = useCallback(() => {
    // The aired rule, not the season total — see `nextAired`. Guarded here as
    // well as on the button: a disabled Pressable is the affordance, this is the
    // behaviour, and anything else that ever calls `onNext` gets the same answer.
    if (nextAired != null) onPickEpisode(nextAired);
  }, [nextAired, onPickEpisode]);

  // -------------------------------------------------------------------------
  // Misc actions
  // -------------------------------------------------------------------------
  const onRetry = useCallback(() => {
    /**
     * JOIN, DO NOT STACK. A retry tapped while a resolve is already running used
     * to start a SECOND full probe of every installed extension on the same
     * failing connection — doubled traffic on the link that is already the reason
     * the viewer is looking at this card, and one more chance to trip a provider
     * into a session-long skip. The in-flight attempt is the answer; clearing the
     * card hands the screen back to the loading stage, which says so honestly.
     */
    if (loadBusyRef.current) {
      setFailure(null);
      setError(null);
      errorRef.current = null;
      return;
    }
    // Reset the budget, or "Try again" re-exhausts it on the first failure and
    // the button appears to do nothing. `load()` resets both budgets at its
    // top; these lines cover the same intention explicitly so the handler does
    // not silently depend on that ordering.
    budgetRef.current = freshBudget();
    resetAutoRecovery();
    if (isOffline()) {
      offlineBlockedRef.current = true;
      setFailure(null);
      setError(OFFLINE_MESSAGE);
      errorRef.current = OFFLINE_MESSAGE;
      return;
    }
    void load({ fresh: true });
  }, [load, resetAutoRecovery]);

  /**
   * The error card's second exit, and genuinely different from Retry.
   *
   * Retry re-resolves and gives the same list another walk — useful when the
   * first attempt hit a signed URL that has since been refreshed, and useless
   * when every mirror is behind the same outage. This skips straight to the
   * next source without re-resolving anything, and resets the budget so it is a
   * real chance rather than three-quarters of one.
   *
   * Wrapped in the error card rather than reachable from the chrome because by
   * this point there is no chrome: `bottomBarUp` is true but the card is opaque
   * and covers it, so without its own button the source list would be one tap
   * further away than the only decision actually worth making here.
   */
  const onChangeSource = useCallback(() => {
    // A fresh decision by the viewer: the budget and every automatic verdict
    // about this connection restart with it.
    budgetRef.current = freshBudget();
    resetAutoRecovery();
    const i = srcIndexRef.current;
    if (sourcesRef.current.length > 1) {
      // Preserve an already-pending target (e.g. a reconnect position) rather than
// overwriting it with a playhead that may have been reset to 0 by a failed
// replaceAsync. Only adopt the current playhead when nothing is pending.
if (pendingSeek.current == null) {
  const at = player.currentTime;
  if (at > 0) pendingSeek.current = at;
}
      qualitySelRef.current = null;
      setQualitySel(null);
      setSrcIndex((i + 1) % sourcesRef.current.length);
    } else {
      void load({ fresh: true });
    }
  }, [player, load, resetAutoRecovery]);

  const onBack = useCallback(() => {
    if (router.canGoBack?.()) router.back();
    else router.replace('/(tabs)');
  }, []);

  const onPip = useCallback(() => {
    // On the VIEW, not the player — `startPictureInPicture` is a VideoView
    // method. The ref is null for the frame before the view mounts and on web,
    // and both are handled rather than thrown.
    void videoViewRef.current?.startPictureInPicture().catch((e: unknown) => {
      // The button only exists when the platform reports PiP support, so this
      // is a runtime refusal rather than a missing feature. Keep it out of the
      // player's UI: the old toast sat over the video and, on a slow device,
      // could outlive the tap that asked for it.
      if (__DEV__) console.warn('[player] picture in picture unavailable:', e);
    });
  }, []);

  /**
   * PIP START is a handoff, not a screen: the system owns the picture now.
   *
   * The native side hides the app's views while the window is up, so nothing
   * here draws anything — this exists so the transport policy knows playback is
   * allowed to continue, and so the player comes back in its at-rest
   * presentation (no toolbar frozen mid-open) when the viewer expands it again.
   */
  const onPipStart = useCallback(() => {
    pipActiveRef.current = true;
    setPipOn(true);
    if (subsRestoreTimerRef.current) {
      clearTimeout(subsRestoreTimerRef.current);
      subsRestoreTimerRef.current = null;
    }
    backgroundHoldRef.current = false;
    if (pipHandoffTimerRef.current) clearTimeout(pipHandoffTimerRef.current);
    pipHandoffTimerRef.current = null;
    showControlsRef.current = false;
    setChromeVisible(false);
    setMenu(null);
    // NO LINE FROZEN IN THE DRAWER. While the window is up the native side hides
    // every view (see `pipOn`), so the live cue frame would be the last one from
    // before the handoff — and that stale line is the first thing painted when
    // the viewer expands again, over a playhead that has moved on. Cleared here,
    // it cannot be what they come back to.
    publishCue(null);
  }, []);

  /**
   * PIP STOP is either an expand (back to the player) or a close (the window is
   * gone but the app is still away). They look identical here, and the expand's
   * `AppState` change lands AFTER the callback, so the decision is deferred: if
   * the app is still backgrounded a moment later, this was a close and playback
   * has nowhere to be seen.
   */
  const onPipStop = useCallback(() => {
    pipActiveRef.current = false;
    setPipOn(false);
    // Park the subtitles until the window has finished resizing (PIP_SUBS_SETTLE_MS
    // in `lib/player/pip.ts`) — publishing through that layout is the "subs jump
    // when I come back" glitch. See the ref for the full picture.
    publishCue(null);
    subsHoldUntilRef.current = Date.now() + PIP_SUBS_SETTLE_MS;
    if (subsRestoreTimerRef.current) clearTimeout(subsRestoreTimerRef.current);
    subsRestoreTimerRef.current = setTimeout(() => {
      subsRestoreTimerRef.current = null;
      subsHoldUntilRef.current = 0;
      try {
        showCueAt(player.currentTime);
      } catch {
        /* player may be released */
      }
    }, PIP_SUBS_SETTLE_MS);
    if (pipExitTimerRef.current) clearTimeout(pipExitTimerRef.current);
    pipExitTimerRef.current = setTimeout(() => {
      pipExitTimerRef.current = null;
      if (!shouldHoldPlayback(playbackStage(AppState.currentState === 'active', pipActiveRef.current))) {
        return;
      }
      backgroundHoldRef.current = true;
      desiredPlayingRef.current = false;
      // Safe bare: the unmount cleanup clears `pipExitTimerRef`, so this cannot
      // fire against a player `useVideoPlayer` has already released.
      player.pause();
    }, PIP_HANDOFF_GRACE_MS);
  }, [player, showCueAt]);

  const onToggleLock = useCallback(() => {
    setLocked((l) => {
      if (l) {
        // Unlocking brings the chrome back. Leaving it hidden means the user
        // taps "unlock" and then has to tap again to find the controls they
        // just asked to get back.
        pokeControls();
      } else {
        showControlsRef.current = false;
        setChromeVisible(false);
        setMenu(null);
      }
      return !l;
    });
  }, [pokeControls]);

  const onMute = useCallback(() => {
    setMuted((wasMuted) => {
      // UNMUTING AT 0% WOULD BE SILENT. The volume swipe below can leave the
      // player at zero, and a mute button that appears to do nothing is a bug
      // report. Coming out of mute at silence restores the last audible level
      // (never below 20%), and says so through the same HUD the swipe uses.
      // `volumeRef` / `lastAudibleRef` are declared below; a closure may read
      // them, and by the time a tap can arrive they exist.
      if (wasMuted && readVolume() === 0) {
        const restored = Math.max(0.2, lastAudibleRef.current);
        // The same write the swipe makes, so the readout, the phone and the
        // stream cannot disagree about the level the mute cycle restored.
        setVolume(restored);
        commitVolume();
        if (usingDeviceVolume()) player.volume = 1;
        showSideHud('volume', restored, sideForKind(swipeSides, 'volume'));
        scheduleSideHudHide();
      }
      player.muted = !wasMuted;
      return !wasMuted;
    });
    // `swipeSides` decides which edge the restored-volume readout draws on.
  }, [player, swipeSides]);

  // -------------------------------------------------------------------------
  // Vertical swipe — volume (one half) and brightness (the other)
  // -------------------------------------------------------------------------
  /**
   * THE TWO VALUES LIVE IN REFS, NOT STATE, and that is the whole performance
   * decision.
   *
   * A drag emits a value every frame. In `useState` that would re-render this
   * entire screen — chrome, timeline, subtitles, episode panel — sixty times a
   * second for a number only the HUD shows. So the engine gets the value
   * directly, and `lib/player/sideHud.ts` hands it to the one component that
   * displays it. Nothing else on this screen moves while a finger drags.
   *
   * THE TWO HALVES ACT ON DIFFERENT THINGS, deliberately (16 Nov). The volume
   * half moves the DEVICE's music stream (`lib/player/volume.ts`) — the same
   * thing the hardware volume keys move, so the readout and the phone cannot
   * disagree about the level. The brightness half moves only THIS APP'S window
   * (`lib/player/brightness.ts`) and is handed back on exit: a screen dimmed
   * from inside a video player is a change nobody can trace back to the app that
   * made it.
   */
  /**
   * The last level that was actually audible — what unmuting at 0% restores.
   * Kept here rather than in the mute handler so a mute/unmute cycle never needs
   * its own memory of the volume.
   */
  const lastAudibleRef = useRef(1);
  /** Where the current drag started — set on start, cleared on end. */
  const swipeBaseRef = useRef<{
    kind: SwipeKind;
    side: SwipeSide;
    base: number;
  } | null>(null);

  /**
   * ONE BASELINE PER SESSION, AND IT IS GIVEN BACK ON THE WAY OUT.
   *
   * The brightness the player sets is the app/window brightness, and on iOS it
   * outlives the screen — so leaving without restoring would hand the user a dim
   * phone. `beginBrightnessSession` reads what to return to; the cleanup below
   * puts it back for every exit path (back, auto-advance replace, a crash in a
   * child) because it is an effect cleanup rather than a button handler.
   */
  useEffect(() => {
    // The fallback write. Expo Go and web have no device-volume API, so the
    // gesture moves the player's own gain there; see `lib/player/volume.ts`.
    setVolumeFallback((value) => {
      player.volume = value;
    });
    void beginVolumeSession().then(() => {
      // With the DEVICE stream in play our own gain stays at unity — the phone
      // decides how loud the episode is, and mute remains the player's own flag.
      player.volume = usingDeviceVolume() ? 1 : readVolume();
      lastAudibleRef.current = Math.max(0.2, readVolume());
    });
    void beginBrightnessSession();
    return () => {
      void endBrightnessSession();
      // Nothing queued may land on a player that is being torn down.
      cancelVolumeWrites();
    };
  }, [player]);

  const onVerticalStart = useCallback((kind: SwipeKind, side: SwipeSide) => {
    const base = kind === 'volume' ? readVolume() : readBrightness();
    swipeBaseRef.current = { kind, side, base };
    showSideHud(kind, base, side);
  }, []);

  const onVerticalMove = useCallback(
    (fraction: number) => {
      const swipe = swipeBaseRef.current;
      if (!swipe) return;
      const value = clampUnit(swipe.base + fraction);
      if (swipe.kind === 'volume') {
        // Device volume when the native module is in the build, the player's own
        // gain when it is not. Coalesced inside the module.
        setVolume(value);
        if (value > 0) lastAudibleRef.current = value;
        // Raising the volume out of a mute has to unmute: the engine stays muted
        // at any volume, so without this the gesture reads as doing nothing.
        if (value > 0 && player.muted) {
          player.muted = false;
          setMuted(false);
        }
      } else {
        // Throttled and trailing inside the module — a per-frame native write is
        // a window-attribute change on Android.
        setBrightness(value);
      }
      showSideHud(swipe.kind, value, swipe.side);
    },
    [player]
  );

  const onVerticalEnd = useCallback(() => {
    const ended = swipeBaseRef.current;
    swipeBaseRef.current = null;
    // The finger has stopped: land the last volume now rather than on the trailing
    // timer, so the level they stopped on is the level they hear.
    if (ended?.kind === 'volume') commitVolume();
    scheduleSideHudHide();
  }, []);

  /**
   * EVERY SEEK WE ISSUE GETS A GRACE PERIOD.
   *
   * Wrapped rather than sprinkled, because there are five call sites — the
   * timeline scrub, the double-tap, the skip button, the automatic intro skip,
   * and the resume — and a monitor that recognises four of them fails over a
   * perfectly healthy stream on the fifth. Forward-seek into unbuffered
   * territory stalls by construction; without this the health monitor reads our
   * own seek as a dead CDN and burns a failover round on it. See
   * `noteSeek`, and `SEEK_STALL_MS` for why a seek gets a longer window than a
   * stall does.
   */
  const seekWithGrace = useCallback(
    (apply: () => void, target?: number) => {
      // Every seek passes through here, which makes it the one place to drop the
      // parked-finale flag: once the playhead is off the end — a restart from 0,
      // a scrub back, a resume — the engine is no longer in its ended state, so
      // a later ▶ must play rather than rewind.
      endedRef.current = false;
      // A VIEWER'S OWN SEEK REPLACES A PENDING RESTORE. A reload arms the
      // position to return to and applies it when the first frame lands; if
      // the viewer scrubs before that frame, the newer intent wins and the
      // restore must not jump them back to where the reconnect dropped them.
      resumeSeekAfterFrameRef.current = null;
      pendingSeek.current = null;
      const now = Date.now();
      healthRef.current = noteSeek(readHealth(now), now);
      // The picture is about to freeze on its way to the target — show the
      // ring the moment the seek is ISSUED, not 700ms later when the frozen
      // playhead finally earns a `rebuffering` verdict through evidence the
      // seek robbed it of (the buffer readout goes unknowable exactly here).
      // Issuing it for every grace-wrapped seek — the scrub release, the
      // double-taps, the skip button — is the point: each one is a frame the
      // viewer is entitled to see an explanation for.
      seekIssuedAtRef.current = now;
      setSeekPending(true);
      apply();
      // Re-anchor the presence card with the seek's TARGET — not the
      // pre-seek position `positionRef` still holds. The card's start/end
      // timestamps mint from the position at push time and tick in
      // wall-clock, so an un-re-pushed seek leaves the RPC bar describing
      // where the viewer WAS. The first post-seek tick re-syncs `positionRef`
      // to reality; the pushed frame is at most one tick optimistic.
      if (target != null) {
        positionRef.current = target;
        pushPresence(player.playing);
        // THE LINE IS PART OF THE SEEK. The next sampler is up to 120ms away
        // and the picture is already at the target, so the old line would sit
        // over the new frame — the "subtitles lag a beat after a jump" half of
        // the report. 120ms is only invisible when the tick is what found the
        // change, not when the viewer caused it.
        showCueAt(target);
      }
    },
    [readHealth, pushPresence, player, showCueAt]
  );

  /**
   * Commit a scrub: ONE seek, at the widened tolerance, restored immediately.
   *
   * ORDER IS THE WHOLE OF THIS FUNCTION, and the order used to be the opposite
   * of what its own comment claimed:
   *
   *   1. Write the widened tolerance — 0.5s before, 1s after at minimum, and
   *      never tighter than the viewer's own choice.
   *   2. Dispatch the seek. This is the ONLY seek a drag produces, and it is the
   *      one a widened tolerance is for: ExoPlayer lands on the neighbouring
   *      keyframe instead of decoding forward from the last one and discarding
   *      frames to get there.
   *   3. Restore the viewer's tolerance in the SAME TICK.
   *
   * The previous version restored first, because `setScrubbing(false)` was
   * called before `onSeek` and turned the scrubbing mode off synchronously. So
   * every drag committed at `exact` — decode, discard, stutter — which is what
   * "the video restarts when I drag" was.
   *
   * Step 3 matters as much as step 1, and it is cheap because of the reversal in
   * `lib/player/scrub.ts`: nothing here is state, so there is no second path that
   * has to remember to undo it. If this function threw between 1 and 3 the only
   * consequence would be a wider tolerance until the next seek — and even that is
   * bounded by the `finally`.
   *
   * `null` is "the bar could not tell where you pointed", which is a real answer
   * (an unlaid-out bar, a live stream with no duration). The previous version
   * turned it into `0` and rewound the episode to the beginning; see
   * `scrubTarget`.
   */
  const seekTo = useCallback(
    (t: number | null) => {
      if (t == null) return;
      // `tuning.seekPrecision`, NOT a second `readSetting`. The tuning object is
      // resolved once per mount and `applyTuning` has already written its resting
      // tolerance to the player; reading the store again here would be a second
      // resolver for one preference, and two resolvers are how the Decoder
      // section came to hold three options and one behaviour.
      const precision = tuning.seekPrecision;
      player.seekTolerance = commitTolerance(precision);
      try {
        seekWithGrace(() => void player.seekBy(t - player.currentTime), t);
      } finally {
        player.seekTolerance = toleranceFor(precision);
      }
    },
    [player, seekWithGrace, tuning]
  );

  const onGestureSeek = useCallback(
    (delta: number, _at?: { x: number; y: number }) => {
      // Belt and braces with the check inside the gesture surface: if the frame
      // was locked at any point during this press, the seek is dropped rather
      // than applied to a frame the user cannot see the result of.
      if (lockedRef.current) return;
      // …and no seeks during a transition: the player still holds the episode
      // being LEFT, so a jump would be issued against a stream that is about to
      // be replaced, and the seek-grace window it arms would be inherited by the
      // episode arriving. The UI is gated too — this is the net under it.
      if (switchingRef.current) return;
      // ABSOLUTE, not `seekBy`. `seekBy` is a relative call whose delta is
      // computed from the CURRENT `player.currentTime` at the MOMENT it is
      // dispatched, and the last captured position (`positionRef`) trails the
      // real playhead by up to `timeUpdateEventInterval` (0.5s here). Under a
      // rapid series of double-taps those two things corrupt each other: the
      // second `+10s` can compute off a playhead that has not yet applied the
      // first one, so a burst of taps lands short, and a hurried 4-tap series
      // visibly under-seeks. Reading the playhead ONCE synchronously and
      // setting an absolute time makes each tap's target independent of the
      // taps around it — which is what "repeated doubles must accumulate
      // cleanly" means. The clamps exist because `currentTime` can briefly
      // read outside the stream bounds right after a replace.
      const dur = player.duration || 0;
      const raw = player.currentTime + delta;
      const max = dur > 0 ? dur - 0.5 : raw;
      const target = Math.min(Math.max(0, raw), Math.max(0, max));
      seekWithGrace(() => {
        player.currentTime = target;
      }, target);
      // DELIBERATELY NO `pokeControls()` HERE. A seek's feedback is the ripple
      // and the accumulated ±Ns readout — both delivered from the gesture
      // surface — NOT the control chrome. Poking the chrome from the seek path
      // is the last trace of the ShonenX shape (its overlay appears on every
      // skip tap), and it is exactly what the report described: repeated
      // double-tap skips flashing the controls up over the video. The HUDs
      // carry the receipt; the chrome stays wherever the user last left it.
    },
    [player, seekWithGrace]
  );

  // Save on the way out. The unmount cleanup is the ONLY reliable place for
  // this: `router.back()` does not give the screen a chance to ask.
  useEffect(
    () => () => {
      // Not a defensive nicety — `miori:pos:NaN:NaN` is a real key on the
      // user's disk, written by a malformed deep link, and it is never cleaned
      // up by anything else in the app.
      if (!linkOk) return;
      void savePosition(animeId, epNum, positionRef.current);
      // Leave presence to releasePresence() ALONE. It drops any queued watch
      // frame and, after a beat, stands down to whatever the destination screen
      // asserted (the details page re-asserts on focus) — one connection, one
      // card, always. A `clearPresence()` used to run right after this and it
      // is the "messed up on the way back from the player" bug: it sends an
      // empty activity immediately, wiping the very details card the return
      // trip had just pushed, so backing out of the player left the account
      // showing nothing.
      releasePresence();
    },
    [animeId, epNum, linkOk]
  );

  // -------------------------------------------------------------------------
  // Menu rows
  // -------------------------------------------------------------------------
  const speedRows: MenuRow[] = useMemo(() => {
    const rows: MenuRow[] = SPEED_STEPS.map((s) => ({
      key: String(s),
      label: s === 1 ? 'Normal' : `${formatRate(s)}×`,
      selected: Math.abs(speed.committed - s) < 0.001,
    }));
    // A value the presets do not cover — show it as its own highlighted row so
    // the viewer can see (and re-open) what they set, rather than having the
    // selection silently fall through to the nearest preset.
    const isPreset = SPEED_STEPS.some((s) => Math.abs(s - speed.committed) < 0.001);
    rows.push({
      key: '__custom',
      label: 'Custom speed…',
      hint: isPreset ? undefined : `${formatRate(speed.committed)}× now`,
      selected: !isPreset,
    });
    return rows;
  }, [speed.committed]);

  const qualityRows: MenuRow[] = useMemo(() => {
    const rows: MenuRow[] = [
      {
        key: 'auto',
        label: 'Auto',
        hint:
          qualityPhase === 'loading'
            ? 'Loading…'
            : qualityPhase === 'failed'
              ? 'Retrying failed'
              : undefined,
        selected: qualitySel === null,
      },
    ];

    const isBusy = qualityPhase === 'loading' || qualityPhase === 'idle';

    if (isBusy && mergedQualities.length === 0) {
      rows.push({ key: '__loading', label: 'Loading qualities…', disabled: true });
      return rows;
    }

    if (qualityPhase === 'failed' && mergedQualities.length === 0) {
      rows.push({
        key: '__failed',
        label: 'Could not read qualities',
        hint: 'Tap Refresh below',
        disabled: true,
      });
    }

    if (qualityPhase === 'empty' || (mergedQualities.length === 0 && !isBusy)) {
      rows.push({
        key: '__noq',
        label: 'No selectable qualities',
        hint: 'This episode plays as Auto',
        disabled: true,
      });
    }

    for (const q of mergedQualities) {
      rows.push({
        key: `${q.src}:${q.v}`,
        label: q.label,
        hint: q.own
          ? mergedQualities.length === 1
            ? 'only option'
            : undefined
          : `source ${q.src + 1}`,
        selected: !!qualitySel && qualitySel.src === q.src && qualitySel.v === q.v,
      });
    }

    if (qualityPhase !== 'loading') {
      rows.push({
        key: '__retryq',
        label: 'Refresh quality list',
        hint:
          qualityPhase === 'failed'
            ? 'The last read failed'
            : mergedQualities.length < 2
              ? 'Try for more qualities'
              : undefined,
      });
    }

    return rows;
  }, [mergedQualities, qualitySel, qualityPhase]);

  const sourceRows: MenuRow[] = useMemo(() => {
    // READ, not merely listed: the ledger lives outside React, so a verdict
    // written by `failover` is invisible to this memo without the counter. The
    // reference is what makes the dependency real instead of a lint nit.
    void ledgerTick;
    const rows: MenuRow[] = sources.map((s, i) => ({
      key: String(i),
      label: s.quality ? `${s.quality} — source ${i + 1}` : `Source ${i + 1}`,
      hint: i === srcIndex ? 'playing' : sourceSkipHint(s.extId),
      selected: i === srcIndex,
      // Faded, not disabled: the session is skipping it, and one tap is the
      // explicit override (see `onPickSource`). A disabled row would strand a
      // provider that has recovered but has not played yet.
      muted: !!readSourceTrip(s.extId),
    }));
    // Providers that did not contribute sources (e.g. Katana/bingr blocked by
    // the network) still show up, faded, with the reason — so the sheet
    // explains WHY a source is missing instead of pretending it never existed.
    const nameFor = (id: string) =>
      id === 'filmu' ? 'Katana' : id === 'mega' ? 'Mega' : id;
    // ONE ROW PER PROVIDER. `MenuRow.key` becomes the panel list's React key,
    // so a provider reported twice is a duplicated key — React reports it as an
    // ERROR and blames the whole row list (device report, 22 Nov: opening
    // Source while an episode played showed "two children with the same key,
    // failed-filmu"). The registry dedupes by id as well; this is the picker
    // keeping its own promise rather than trusting a caller.
    const seenFailed = new Set<string>();
    failedSources.forEach((f) => {
      if (seenFailed.has(f.id)) return;
      seenFailed.add(f.id);
      rows.push({
        key: `failed-${f.id}`,
        label: nameFor(f.id),
        hint: f.reason,
        selected: false,
        disabled: true,
      });
    });
    // NOTHING TO PICK YET is a state, not an empty sheet. The picker used to
    // draw a title over a blank panel while the resolve was still in flight,
    // which reads as a provider outage rather than as a wait.
    if (sources.length === 0) {
      rows.push({
        key: '__resolving',
        label: resolving ? 'Finding sources…' : 'No sources',
        hint: resolving ? undefined : 'Tap Refresh once the episode is loaded',
        disabled: true,
      });
    }
    if (sources.length > 0) {
      rows.push({
        key: '__refresh',
        label: 'Refresh sources',
        hint: 'Re-check failed providers',
      });
    }
    return rows;
  }, [sources, srcIndex, failedSources, ledgerTick, resolving]);

  const subRows: MenuRow[] = useMemo(() => {
    const rows: MenuRow[] = [
      { key: 'off', label: 'Off', selected: tracks.length === 0 || trackIndex < 0 },
    ];
    tracks.forEach((t, i) => {
      rows.push({
        key: String(i),
        label: t.label || t.lang || `Track ${i + 1}`,
        selected: tracks.length > 0 && trackIndex === i,
      });
    });
    return rows;
  }, [tracks, trackIndex]);

  const onPickSubs = useCallback((key: string) => {
    if (key === 'off') {
      // ⚠️ NOT `setTracks([])`, and that distinction was a one-way door.
      //
      // Clearing the track LIST to mean "no track selected" also erased the
      // menu: `subRows` is built from `tracks`, so after turning subtitles off
      // the picker offered exactly one row — "Off" — and there was no way back
      // on without switching source or reopening the episode. The `-1` sentinel
      // already existed in `subRows` and in `subsLabel`; the handler just never
      // used it.
      //
      // The preference is persisted too, so "off" survives a source reload —
      // otherwise a failover to a source that ships English would switch them
      // back on mid-episode.
      setTrackIndex(NO_TRACK);
      setSetting('subs.language', SUBTITLE_OFF);
    } else {
      const i = Number(key);
      const t = tracks[i];
      setTrackIndex(i);
      // Only persist a track that can be identified. An anonymous track (no
      // `lang` and no `label`) keys to the empty string, and storing that would
      // match EVERY anonymous track on the next source rather than this one.
      const pref = t ? preferenceFor(t) : null;
      if (pref) setSetting('subs.language', pref);
    }
    setMenu(null);
  }, [tracks]);

  /**
   * What the quality chip says.
   *
   * Under Auto this now reports the resolution the pipeline ACTUALLY selected,
   * from `player.videoTrack`, rather than the word "Auto". "Auto" is a claim
   * about a mechanism; "1080p" is a statement about what is being downloaded,
   * and on a weak connection those are the only two facts a viewer actually
   * has. It is also the same observation the automatic downgrade steps down
   * from, so the label and the decision cannot disagree.
   *
   * Falls back to "Auto" whenever the pipeline will not say — an mp4 source has
   * no tracks to report, and a ladder that is still gathering has nothing to
   * compare against. Never invents a number.
   */
  const qualityLabel = useMemo(() => {
    if (!qualitySel) {
      return liveHeight ? `${liveHeight}p` : 'Auto';
    }
    const v = variantsBySource[qualitySel.src]?.[qualitySel.v];
    return v?.label ?? 'Auto';
  }, [qualitySel, variantsBySource, liveHeight]);

  const subsLabel = tracks.length === 0 || trackIndex < 0 ? 'Off' : (tracks[trackIndex]?.lang ?? tracks[trackIndex]?.label ?? 'On');

  // The panel's ROOT list — the drill-in entries, each carrying its live value
  // as the hint so the root doubles as an at-a-glance summary of the episode.
  const rootRows: MenuRow[] = useMemo(
    () => [
      { key: 'speed', label: 'Playback speed', hint: `${formatRate(effectiveRate(speed))}x`, to: 'speed', group: 'Playback' },
      { key: 'quality', label: 'Quality', hint: qualityLabel, to: 'quality', group: 'Playback' },
      {
        key: 'source',
        label: 'Source',
        hint: sources.length > 1 ? `${srcIndex + 1}/${sources.length}` : 'Auto',
        to: 'source',
        group: 'Playback',
      },
      { key: 'subs', label: 'Subtitles', hint: subsLabel, to: 'subs', group: 'Subtitles' },
      { key: 'subsSettings', label: 'Subtitle settings', hint: 'Size · position · style', to: 'subsSettings', group: 'Subtitles' },
    ],
    [speed, qualityLabel, sources.length, srcIndex, subsLabel]
  );

  /**
   * THE SKIP BUTTON, AT SCREEN LEVEL — one seat, two jobs.
   *
   * It used to live INSIDE the bottom bar (`Chrome.skipSlot`), which made it a
   * hostage of the chrome: the bar unmounts when the controls hide, so "Skip
   * opening" vanished exactly when it was most useful — the viewer is watching
   * an opening they want out of, in fullscreen, touching nothing.
   *
   * The geometry rule this file keeps learning: a control's position is a
   * property of the SCREEN, not of player state. The button is now pinned
   * right, at a constant offset above where the bar sits (`barHeight`, measured
   * — measured, not hardcoded), and does NOT move when the chrome hides.
   * Two jobs share the one seat:
   *
   *   marker active  "Skip opening / ending" — ALWAYS visible, chrome or not.
   *                  A marker is a persistent fact about the moment; the button
   *                  answering it persists with it (Netflix's skip, which also
   *                  outlives its controls).
   *   no marker      "+85s" — overlay mode ONLY. Without a marker there is
   *                  nothing persistent to react to, and a permanent button on
   *                  the gesture surface is one more thing a pocket can find.
   *                  Hidden while locked (the lock's job is a pocket-safe frame)
   *                  and while the episode panel is open (it owns the right edge
   *                  the button sits on).
   */
  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  /**
   * Which chrome is up.
   *
   * `topUp` and `bottomBarUp` are now SEPARATE, and the difference is the whole
   * fix for menus appearing to rearrange the player. Opening "Quality" used to
   * set `chromeUp` false, which unmounted the top bar, the transport AND the
   * bottom bar — the row the viewer had just touched — and replaced all of it
   * with a panel dropping in from the bottom edge. Three groups of controls
   * vanished and something else took their place, and the popover's own header
   * comment claimed it was anchored "over the chrome" when it was in fact
   * covering chrome that had been removed for the occasion.
   *
   * Now a menu only hides the top bar and the centre transport. The bottom bar
   * stays exactly where it is — same row, same values, still tappable — and the
   * panel rises out of it. The transport still hides, because the popover's
   * full-screen dismiss catcher covers it anyway: leaving a live play button
   * under an invisible sheet is worse than a tidy one.
   *
   * `bottomBarUp` is NOT declared here. It is derived up beside the scrub state
   * so the effect that ends a drag when the bar disappears can depend on it —
   * reading a value declared three hundred lines below its consumer is how that
   * consumer ends up in the wrong place. Same expression, same value.
   */
  // visibility is store-driven now
  const boostRate = isBoosting(speed) ? speed.boost : null;

  /**
   * STABLE PROP IDENTITIES FOR THE MEMOIZED CHROME.
   *
   * `TopBar`, `BottomBar`, `CenterTransport`, `GestureSurface`, `SettingsPanel`
   * and `EpisodePanel` are all `memo` — and every one of them was receiving at
   * least one freshly created object or arrow per render, so the memo could never
   * bail out and any unrelated state flip (a subtitle, a spinner, a health kind)
   * rebuilt all of them. These are the two objects and the handful of handlers
   * that made that true; the values themselves are unchanged.
   *
   * `useMemo`/`useCallback` here rather than inside the children because a child
   * cannot stabilise a prop its parent re-creates.
   */
  const skipWindow = useMemo(
    () => ({
      intro: sources[srcIndex]?.intro ?? null,
      outro: sources[srcIndex]?.outro ?? null,
    }),
    [sources, srcIndex]
  );
  const onOpenEpisodes = useCallback(() => {
    setMenu(null);
    setPanelOpen(true);
  }, []);
  const onToggleSettingsMenu = useCallback(() => {
    setMenu(menu === 'root' || menu === 'subsSettings' ? null : 'root');
  }, [menu]);
  const onTrackWidth = useCallback((w: number) => {
    trackWidthRef.current = w;
  }, []);
  const onCloseMenu = useCallback(() => setMenu(null), []);
  const onNavigateMenu = useCallback((to: string) => setMenu(to as MenuId), []);
  const onClosePanel = useCallback(() => setPanelOpen(false), []);

  /**
   * The card's countdown reached zero, or the viewer pressed Play now — the
   * same thing. The number is read from the queued state, so a stale callback
   * cannot advance into the wrong episode.
   */
  const onAdvance = useCallback(() => {
    const next = upNext;
    setUpNext(null);
    if (next != null) goToEpisode(next);
  }, [upNext, goToEpisode]);

  /**
   * Cancel is a DECISION, and the player has to agree with it. The stream is at
   * its end, so ▶ must replay rather than compute "pause" from an intent flag
   * that is still true — the same two flips the parked finale does.
   */
  const onCancelAdvance = useCallback(() => {
    setUpNext(null);
    desiredPlayingRef.current = false;
    endedRef.current = true;
  }, []);

  /**
   * ANDROID BACK BELONGS TO THE LAYER ON TOP, NOT TO THE ROUTE.
   *
   * Every overlay in this screen is a plain absolutely-positioned view rather
   * than a `Modal` (the panel has to slide, the sheet has to latch its exit
   * content), so nothing consumed the hardware back press: with the speed card,
   * the settings sheet or the episode panel open, back popped the whole player
   * and dropped the viewer back on the details page. Every real player
   * dismisses its own layer first, and so does this — in stacking order: card,
   * sheet, panel. While the screen is LOCKED back is swallowed, because that is
   * what the lock is for (a pocket must not be able to leave the player); the
   * unlock affordance is the way out.
   */
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (customSpeedOpen) {
        setCustomSpeedOpen(false);
        return true;
      }
      if (menu != null) {
        onCloseMenu();
        return true;
      }
      if (panelOpen) {
        onClosePanel();
        return true;
      }
      return locked;
    });
    return () => sub.remove();
  }, [customSpeedOpen, menu, panelOpen, locked, onCloseMenu, onClosePanel]);

  /**
   * STABLE HANDLERS FOR THE ALWAYS-MOUNTED SHEET.
   *
   * `SettingsPanel` is `memo`, but it was handed six freshly created arrows on
   * every render, so the memo could never bail: a subtitle sample, a health tick
   * or a menu change re-ran the whole sheet body (and its no-deps effects) for
   * content the viewer was not looking at. Same class as the chrome props below
   * and the same reason: a child cannot stabilise a prop its parent re-creates.
   */
  const onSubsSize = useCallback((key: SubtitleSizeKey) => setSetting('subs.size', key), []);
  const onSubsPosition = useCallback(
    (key: SubtitlePositionKey) => setSetting('subs.position', key),
    []
  );
  const onSubsPositionFrac = useCallback((frac: number) => {
    setSetting('subs.position', 'custom');
    setSetting('subs.positionFrac', frac);
  }, []);
  const onSubsBackground = useCallback(
    (key: SubtitleBackgroundKey) => setSetting('subs.background', key),
    []
  );
  const onSubsColor = useCallback((key: SubtitleColorKey) => setSetting('subs.color', key), []);
  const onSubsDelay = useCallback((ms: number) => setSetting('subs.delayMs', ms), []);

  /**
   * THE CENTRE TRANSPORT'S PLAY/PAUSE, HOISTED OUT OF THE JSX.
   *
   * Inline it was a new function on every render, so `memo(CenterTransport)`
   * could never bail and the transport was rebuilt on every unrelated state
   * flip. The body reads refs and stable callbacks only, so its identity can be
   * permanent — the behaviour is character-for-character what the inline version
   * did.
   */
  const onPlayPause = useCallback(() => {
    // A pause is the viewer grabbing the wheel — capture the INTENT, not
    // the pipeline's state. Using `player.playing` here is the trap: during
    // a buffer `playing` is false even though the viewer wants playback, so
    // a tap would RESUME instead of pause. `desiredPlayingRef` is the wheel,
    // so toggling it gives the right action in every state — including
    // tapping the spinner while it buffers.
    setSeekPending(false);
    const willPause = desiredPlayingRef.current;
    // OFFLINE: starting playback cannot succeed, so do not flip the
    // intent or call play() into a dead connection — show the offline
    // card instead, which carries the only word that matters here.
    if (!willPause && offlineRef.current) {
      desiredPlayingRef.current = true;
      if (player.currentTime > 0) offlinePositionRef.current = player.currentTime;
      if (!errorRef.current) {
        setFailure(null);
        setError(OFFLINE_MESSAGE);
        errorRef.current = OFFLINE_MESSAGE;
      }
      pokeControls();
      return;
    }
    desiredPlayingRef.current = !desiredPlayingRef.current;
    if (willPause) {
      // PAUSING IS LEAVING. The stored position is written every `SAVE_EVERY`
      // seconds and again on unmount, so a pause could leave the resume up to
      // ten seconds behind — and a pause is exactly when a viewer walks away,
      // locks the phone, or gets interrupted for an hour. Same guards as every
      // other write (valid link, no switch in flight, past the five-second
      // floor), and `positionRef` rather than `player.currentTime` for the same
      // reason the unmount save uses it: it is the mirror that survives a
      // replace, so the value cannot be the 0 a reload briefly reported.
      if (linkOk && !mediaSwitchRef.current && positionRef.current > 5) {
        void savePosition(animeId, epNum, positionRef.current);
      }
      player.pause();
    } else {
      // PARKED AT THE END. The stream ran out and nothing follows, so the
      // engine sits in its ended state where a bare `play()` does nothing
      // — the tap that should replay the episode would be swallowed. Jump
      // to the top first, through the grace wrapper so the ring shows and
      // the seek's own bookkeeping is kept; it also clears `endedRef`,
      // which is exactly right now that we are leaving the end behind.
      if (endedRef.current) seekWithGrace(() => { player.currentTime = 0; }, 0);
      player.play();
    }
    pokeControls();
  }, [player, pokeControls, seekWithGrace, animeId, epNum, linkOk]);
  const subsStyleProp = useMemo(
    () => ({
      size: subsSize,
      position: subsPosition,
      positionFrac: subsPositionFrac,
      background: subsBackground,
      color: subsColor,
      delayMs: subsDelayMs,
    }),
    [subsSize, subsPosition, subsPositionFrac, subsBackground, subsColor, subsDelayMs]
  );
  /**
   * The gesture surface's handler bag.
   *
   * The surface is `memo` and its whole contract is this one object, so a fresh
   * literal per render re-rendered it (and the HUDs inside it) on every state
   * flip. Same callbacks as before, one identity.
   */
  const gestureHandlers = useMemo(
    () => ({
      // A SIDE single tap arrives only after the double-tap window closes, so
      // the first toggle after the chrome has hidden has up to ~300ms of air
      // under it — the arbitration cost, paid for seeks that never flash the
      // overlay. A tap in the middle (dead band) still toggles instantly.
      onTap: () => {
        if (locked) {
          // A locked frame's tap only ever reveals the unlock button; it must
          // not toggle the chrome or unlocking would be a two-tap operation
          // with an invisible first step.
          onToggleLock();
          return;
        }
        toggleControls();
      },
      // A pair produces ONLY its seek — no chrome flip, no cleanup to race.
      onDoubleTap: () => {
        if (locked) return;
      },
      onSeek: onGestureSeek,
      onHoldStart,
      onHoldMove,
      onHoldEnd,
      onVerticalStart,
      onVerticalMove,
      onVerticalEnd,
    }),
    [
      locked,
      onToggleLock,
      toggleControls,
      onGestureSeek,
      onHoldStart,
      onHoldMove,
      onHoldEnd,
      onVerticalStart,
      onVerticalMove,
      onVerticalEnd,
    ]
  );

  /**
   * The band of screen the video is actually visible in: below the top chrome,
   * above the bottom chrome. Anything that has to be centred on the picture —
   * the speed pill — is centred here rather than on the window, so it does not
   * sit under the title or on the timeline.
   */
  const chromeTop = TOP_BAR_TOTAL + insets.top;
  /** Side inset for content that must clear the notch in landscape. */
  const sideInset = Math.max(insets.left, insets.right);

  /**
   * THE RING, AND ONLY THE RING.
   *
   * The buffering overlay used to name its cause — Buffering… / Connection is
   * slow / Reconnecting to another source… — from this state machine, once a
   * second. The device verdict (9 Nov) killed the words: slow enough internet
   * hops the states fast enough that the text flickered, none of the three
   * changed what the viewer should do (wait), and the remedies they hinted at —
   * the tier drop, the failover, the error card carrying the engine's actual
   * message — all happen behind the ring anyway. YouTube, Netflix and ExoPlayer
   * answer this state with a bare spinner; this player does too, now.
   *
   * The machinery underneath is the health state machine, unchanged. The
   * `observeHealth` kinds that owed a spinner still produce one here; `ok`,
   * `inactive` and `unknown` produce none, exactly as before — the words were
   * an annotation on the same signal the ring was drawn from, not a second
   * signal. The one non-health input is `seekPending`: right after a seek or a
   * replace the buffer readout is genuinely unknowable (`observeHealth`
   * answers `unknown` and produces no ring), yet the picture IS frozen, and
   * the seek's own issue is the honest signal for that window.
   */
  /**
   * Reconnect is the one event that can repair an offline attempt.
   */
  useEffect(() => {
    const wasOffline = wasOfflineRef.current;
    wasOfflineRef.current = offline;
    if (!wasOffline || offline) return;

    const now = Date.now();
    healthRef.current = noteInterruption(readHealth(now), now);
    setHealth(UNKNOWN_HEALTH);

    const hadError = errorRef.current != null;
    const blocked = offlineBlockedRef.current;
    offlineBlockedRef.current = false;

    // WHERE WERE WE? Three answers, and the LARGEST one is the truth:
    // `player.currentTime` is the live playhead (0 when a failed replace reset
    // it), `offlinePositionRef` is where the offline card stopped a buffered
    // episode, and `positionRef` is the player's own mirror from the last
    // `timeUpdate`. Taking the max survives a reset-to-zero by any one of them;
    // taking the live playhead alone is what made a reconnect reload restart
    // from the beginning of the episode.
    const at = Math.max(player.currentTime, offlinePositionRef.current, positionRef.current);
    if (at > 0) pendingSeek.current = at;

    if (hadError) {
      if (sourcesRef.current.length > 0) {
        setFailure(null);
        setError(null);
        errorRef.current = null;
        setReloadNonce((n) => n + 1);
      } else {
        void load();
      }
      return;
    }
    if (blocked) {
      if (sourcesRef.current.length > 0) {
        setReloadNonce((n) => n + 1);
      } else {
        void load();
      }
      return;
    }
    if (qualityPhaseRef.current === 'failed') void gatherVariants(true);
  }, [offline, load, readHealth, gatherVariants, player]);

  /**
   * `starving` is deliberately NOT here.
   *
   * A thin buffer is not a stopped picture: the playhead is still moving, so a
   * spinner would sit over a video that is visibly playing — which on a slow
   * connection reads as "loading forever". Only a frozen playhead
   * (`rebuffering`), a write-off (`stalled`), a resolve or a seek that has not
   * produced a frame yet earn the ring.
   */
  /**
   * THE TRANSITION WINDOW, as the UI reads it. See `switchPending`; `resolving`
   * is the half that keeps an instant, cache-hit switch from flashing the gate.
   */
  const switching = switchPending && resolving;
  switchingRef.current = switching;

  const stageUp = (!firstFrame || switchPending) && !error && !offline && desiredPlayingRef.current;

  /**
   * ONE LAYER AT A TIME — the stage REPLACES the controls; it does not sit
   * behind them.
   *
   * The first version of the stage was a cover mounted under the chrome, and on
   * a phone that read as two screens drawn on top of each other: the poster with
   * its ring and "Finding a source…" underneath, and a paused timeline at 0:00
   * with four trigger chips and a play button on top of it. Every one of those
   * controls is a lie during a scrape — there is no duration, no position, no
   * quality to pick and nothing to pause — so the frame was showing the viewer
   * the exact opposite of what was happening.
   *
   * So the load state TAKES the controls' place, the way Netflix's and
   * YouTube's do: while the stage is up the bars and the transport are off (the
   * bottom bar stays MOUNTED and invisible — its measured height is the subtitle
   * floor and the skip seat, and unmounting it would make both jump), and the
   * stage's ring stands in the transport's seat. When the first frame lands the
   * gate drops and the real chrome comes back in the same commit — loading
   * becomes controls, controls become loading.
   *
   * The BACK ARROW IS THE EXCEPTION, and it is the same exception the transition
   * gate already makes: a screen with no exit is never acceptable, so `TopBar`
   * keeps its `off` mode (arrow only, at its own seat, with the contrast disc
   * the gradient used to provide).
   */
  const controlsOff = switching || stageUp;

  const buffering =
    desiredPlayingRef.current &&
    // Nothing is loading when the episode has ENDED with the next one queued:
    // the card is up, and a ring over the last frame would claim a load that is
    // not happening (the countdown is waiting for the viewer, not the network).
    upNext == null &&
    (resolving || seekPending || recovering || (!firstFrame && !playbackProgress) || health.kind === 'rebuffering' || health.kind === 'stalled') &&
    !error &&
    !offline;

  /**
   * A malformed deep link renders NOTHING that could stream.
   *
   * Past the last hook on purpose — every hook above has run, and each of them
   * is now `linkOk`-guarded where it writes, because returning early is not a
   * strategy and a route that writes `miori:pos:NaN:NaN` on its way out has
   * already done the damage. Reachable via `miori://watch/<id>/<not-a-number>`,
   * `scheme: "miori"` being in `app.json`.
   */
  if (!linkOk) {
    return (
      <View style={styles.root}>
        <StatusBar hidden />
        <InvalidLinkCard onBack={onBack} />
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <StatusBar hidden />
      {Platform.OS === 'android' ? <NavigationBar hidden /> : null}

      <VideoView
        key={videoViewRevision}
        ref={videoViewRef}
        player={player}
        style={StyleSheet.absoluteFill}
        nativeControls={false}
        contentFit="contain"
        allowsPictureInPicture={pipSupported}
        // LEAVING THE APP WHILE PLAYING HAND THE VIDEO TO THE SYSTEM. Android 12+
        // and iOS enter PiP on their own here; older Android ignores the prop and
        // the background rule above pauses instead, which is the correct
        // fallback rather than a silent audio stream behind a locked screen.
        startsPictureInPictureAutomatically={shouldAutoEnterPip(pipSupported, playing)}
        onPictureInPictureStart={onPipStart}
        onPictureInPictureStop={onPipStop}
        surfaceType={tuning.surfaceType}
        onFirstFrameRender={onFirstFrame}
      />

      <SubtitleStage
        style={subtitleStyle}
        bottomOffset={barHeight}
        topOffset={chromeTop}
        sideInset={sideInset}
      />

      {/* A scrim only while the chrome is up, so the title and timeline stay
          readable over a bright frame without dimming the video at rest. */}
      {/* No scrim behind the stage: its gradients exist to keep the title and
          the timeline readable over a live frame, and during a load there is
          neither — they would just dim the art the stage is already dimming. */}
      {stageUp ? null : (
        <Scrim locked={locked} panelOpen={panelOpen} menu={menu} scrubActive={scrubActive} />
      )}

      {stageUp ? (
        <LoadingStage
          // Banner first: it is the widest art AniList has, and at 50% opacity
          // behind a 74% wash only the colour field survives anyway.
          art={mediaDetail?.bannerImage ?? mediaDetail?.coverImage?.extraLarge ?? null}
          episode={epNum}
          episodeTitle={episodeTitle}
          // The order is the order things actually happen; `resolving` is the
          // scrape, and it outranks a stale `recovering` from the previous item.
          phase={resolving ? 'resolving' : recovering ? 'recovering' : 'loading'}
        />
      ) : null}

      <GestureSurface
        // NOT `!locked`. The gesture surface has to stay live while the controls
        // are locked, because a tap on the locked frame is what wakes the unlock
        // affordance — disabling it here would make the small unlock button the
        // ONLY exit, which is exactly the accidental-pocket-unlock trap the lock
        // exists to avoid. `locked` is handled inside the handlers instead.
        // The switch gate rides along with the panels, and it takes the WHOLE
        // surface: a double-tap seek would land on the item being replaced, and
        // a single tap would only raise an overlay that describes that item. The
        // exit during a transition is the back arrow `TopBar` keeps in its
        // `off` mode, not a tap.
        // PiP disables the surface as well: a tap in a 200dp window must land
        // on the one control in it, not raise a full-size chrome scaled down.
        // THE STAGE TAKES IT TOO. There is nothing on this frame to seek or to
        // pause while the episode is being scraped, so a tap can only raise a
        // chrome that would be wrong about every value on it. The exit during a
        // load is the back arrow, exactly as it is during a transition.
        enabled={!menu && !panelOpen && !switching && !pipOn && !stageUp}
        locked={locked}
        swipeSides={swipeSides}
        boostRate={boostRate}
        handlers={gestureHandlers}
      />

      <TopBar
        title={title}
        episode={epNum}
        episodeLabel={episodeTitle}
        onBack={onBack}
        onEpisodes={onOpenEpisodes}
        onLock={onToggleLock}
        onSettings={onToggleSettingsMenu}
        settingsActive={menu === 'root' || menu === 'subsSettings'}
        onPip={onPip}
        pipAvailable={pipSupported}
        locked={locked}
        off={controlsOff}
        insets={insets}
      />

      <CenterTransport
        playing={playing}
        // `seekPending` closes the gap the health monitor structurally
        // cannot: right after a seek (or a source/quality replace) the buffer
        // readout is unknowable, which `observeHealth` answers with
        // `unknown` — a verdict that produces no ring. But the picture IS
        // frozen, and "frozen with a pause icon" is the one state a player
        // must not show without a word. The seek's own issue is the honest
        // signal; the ring clears from the `timeUpdate` listener the moment
        // frames resume.
        buffering={buffering && !stageUp}
        hasPrev={epNum > 1}
        // Aired, not the season total: ⏭ must dim on the last RELEASED episode
        // of an airing show, exactly where the countdown declines to fire.
        hasNext={nextAired != null}
        onPlayPause={onPlayPause}
        onPrev={onPrev}
        onNext={onNext}
        off={controlsOff}
      />

      <BottomBar
        player={player}
        skip={skipWindow}
        onSeek={seekTo}
        position={positionSV}
        positionKnown={resumeSettled}
        onScrubActive={onScrubActive}
        activeMenu={menu}
        // `x`, not `×`. The multiplication sign was here three times over-encoded
        // and the button rendered `Ãƒâ€"`. Plain ASCII also matches every other
        // speed readout in the app — the menu (`${formatRate(s)}x`), the boost
        // pill, and the player settings page.
        speedLabel={`${formatRate(effectiveRate(speed))}x`}
        qualityLabel={qualityLabel}
        sourceLabel={sources.length > 1 ? `${srcIndex + 1}/${sources.length}` : 'Source'}
        subsLabel={subsLabel}
        hasSubs={tracks.length > 0}
        onMenu={setMenu}
        onMute={onMute}
        muted={muted}
        insets={insets}
        onMeasure={onBarMeasure}
        initialTrackWidth={trackWidthRef.current}
        onTrackWidth={onTrackWidth}
        off={controlsOff}
      />

      {/**
       * The skip button, AT SCREEN LEVEL — outside the chrome, so a marker's
       * button survives the chrome hiding (see `skipButton` above for the
       * two-jobs-one-seat design). `barHeight`-anchored (measured): the
       * offset is measured, not hardcoded, so the button sits just above the
       * bar in every state and does not move when the chrome hides. Mounted
       * after the gesture surface, so the button — not the double-tap zone —
       * wins the touch that lands on it.
       */}
      <SkipButtonHost
        activeSkip={activeSkip}
        locked={locked}
        panelOpen={panelOpen}
        scrubActive={scrubActive}
        barHeight={barHeight}
        // A skip button floating over the loading art is the same two-layers
        // problem as the bar: it names a moment in an episode with no picture.
        switching={controlsOff}
        insets={insets}
        seekWithGrace={seekWithGrace}
        player={player}
        durationRef={durationRef}
        positionRef={positionRef}
      />

      {/* Bottom-LEFT: the skip button owns the right edge above the bar, and
          an outro marker is exactly when both are on screen together. */}
      <NextEpisodeCard
        number={upNext}
        title={
          upNext == null
            ? null
            : (sourceEpisodes.find((e) => e.number === upNext)?.title ?? null)
        }
        seconds={AUTO_ADVANCE_SECONDS}
        bottom={barHeight + ABOVE_BAR_GAP}
        left={insets.left + 20}
        onAdvance={onAdvance}
        onCancel={onCancelAdvance}
      />

      {locked ? <UnlockAffordance onUnlock={onToggleLock} insets={insets} /> : null}

      {/* ALWAYS MOUNTED, driven by `visible`: a pick sets the view to null
          while the panel must still animate out — a conditional mount here
          would cut the exit frame dead. The panel latches its own content for
          the exit and calls `onClose` when it finishes leaving. Opens at the
          section the trigger names; the settings chip opens at the root. */}
      <SettingsPanel
        visible={menu}
        title={menuTitle(menu)}
        rows={
          menu === 'root'
            ? rootRows
            : menu === 'speed'
              ? speedRows
              : menu === 'quality'
                ? qualityRows
                : menu === 'source'
                  ? sourceRows
                  : menu === 'subs'
                    ? subRows
                    : []
        }
        onPick={
          menu === 'speed'
            ? onPickSpeed
            : menu === 'quality'
              ? onPickQuality
              : menu === 'source'
                ? onPickSource
                : onPickSubs
        }
        onNavigate={onNavigateMenu}
        onClose={onCloseMenu}
        insets={insets}
        // Subtitle settings live IN the panel (the drill-in's last entry), so
        // size/position/style are adjustable mid-episode — the same keys and
        // semantics the settings page writes, not a second copy of them.
        subsStyle={subsStyleProp}
        onSubsSize={onSubsSize}
        onSubsPosition={onSubsPosition}
        onSubsPositionFrac={onSubsPositionFrac}
        onSubsBackground={onSubsBackground}
        onSubsColor={onSubsColor}
        onSubsDelay={onSubsDelay}
      />

      {customSpeedOpen ? (
        <View style={StyleSheet.absoluteFill} pointerEvents="auto">
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setCustomSpeedOpen(false)} />
          <View style={styles.customSpeedCard}>
            <Text style={styles.customSpeedTitle}>Custom speed</Text>
            <Text style={styles.customSpeedHint}>Enter a value between 0.5 and 3.0</Text>
            <TextInput
              value={customSpeedText}
              onChangeText={setCustomSpeedText}
              keyboardType="decimal-pad"
              autoFocus
              style={styles.customSpeedInput}
              onSubmitEditing={applyCustomSpeed}
              returnKeyType="done"
            />
            <View style={styles.customSpeedActions}>
              <Pressable onPress={() => setCustomSpeedOpen(false)} style={styles.customSpeedBtn}>
                <Text style={styles.customSpeedBtnText}>Cancel</Text>
              </Pressable>
              <Pressable onPress={applyCustomSpeed} style={[styles.customSpeedBtn, styles.customSpeedBtnPrimary]}>
                <Text style={styles.customSpeedBtnTextPrimary}>Apply</Text>
              </Pressable>
            </View>
          </View>
        </View>
      ) : null}

      <EpisodePanel
        visible={panelOpen}
        episodes={episodes}
        loading={resolving}
        current={epNum}
        onPick={onPickEpisode}
        onClose={onClosePanel}
        insets={insets}
        onVisibleNumbers={handleVisibleNumbers}
      />

      {error ? (
        <PlaybackErrorCard
          offline={error === OFFLINE_MESSAGE}
          headline={failure ? failure.headline : error}
          detail={failure && failure.detail !== failure.headline ? failure.detail : null}
          sourceCount={sources.length}
          onRetry={onRetry}
          onChangeSource={onChangeSource}
          onBack={onBack}
        />
      ) : null}
    </View>
  );
}

/**
 * The lock screen's only affordance: a small unlock button.
 *
 * Deliberately centred-left and small rather than a full-width bar. The lock
 * exists so a phone in a bag does not pocket-seek, and the way out has to be
 * discoverable without being easy to hit by accident — a thumb across the frame
 * should never unlock it.
 */
function UnlockAffordance({ onUnlock, insets }: { onUnlock: () => void; insets: EdgeInsets }) {
  return (
    <View
      style={[styles.unlockBox, { paddingLeft: insets.left + 28 }]}
      pointerEvents="box-none"
    >
      <Pressable
        onPress={onUnlock}
        accessibilityRole="button"
        accessibilityLabel="Unlock controls"
        style={({ pressed }) => [styles.unlockBtn, pressed ? styles.playPressed : null]}
      >
        <AppIcon name="unlock" size={24} color="#fff" strokeWidth={2} />
      </Pressable>
    </View>
  );
}

function menuTitle(m: MenuId): string {
  switch (m) {
    case 'root':
      return 'Player settings';
    case 'speed':
      return 'Playback speed';
    case 'quality':
      return 'Quality';
    case 'source':
      return 'Source';
    case 'subsSettings':
      return 'Subtitle settings';
    default:
      return 'Subtitles';
  }
}

function heightOf(label: string): number {
  const m = /(\d{3,4})p?/.exec(label);
  return m ? parseInt(m[1], 10) : 0;
}



const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#000',
  },
  scrim: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(0,0,0,0.18)',
  },
  unlockBox: {
    ...StyleSheet.absoluteFill,
    justifyContent: 'center',
    alignItems: 'flex-start',
  },
  playPressed: {
    opacity: 0.6,
  },
  unlockBtn: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.6)',
  },
  skipButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: radii.full,
    backgroundColor: 'rgba(255,255,255,0.18)',
  },
  skipPressed: {
    opacity: 0.65,
  },
  /**
   * The floating skip button's seat. `right`/`bottom` are set inline
   * (`insets.right + 12`, `barHeight + ABOVE_BAR_GAP`) because both are measured — the
   * same rule the toast obeys: the offset names the real bar, not a guess of
   * it, so the button sits just above the bar in every state and does not
   * move when the chrome hides.
   */
  skipFloat: {
    position: 'absolute',
    alignItems: 'flex-end',
  },
  skipForward: {
    // The +85s variant carries one digit-group more than "Skip opening"; a
    // touch more horizontal padding keeps the pill's proportions calm.
    paddingHorizontal: 14,
  },
  skipLabel: {
    color: '#fff',
    fontFamily: font.semibold,
    fontSize: 13,
    lineHeight: 16,
  },
  customSpeedCard: {
    position: 'absolute',
    top: '50%',
    left: '50%',
    transform: [{ translateX: -120 }, { translateY: -90 }],
    width: 240,
    padding: 18,
    borderRadius: 16,
    backgroundColor: 'rgba(20, 20, 27, 0.97)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.12)',
    elevation: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.5,
    shadowRadius: 22,
  },
  customSpeedTitle: {
    color: '#fff',
    fontFamily: font.semibold,
    fontSize: 16,
    marginBottom: 4,
  },
  customSpeedHint: {
    color: 'rgba(255,255,255,0.5)',
    fontFamily: font.regular,
    fontSize: 12,
    marginBottom: 12,
  },
  customSpeedInput: {
    height: 44,
    borderRadius: 10,
    paddingHorizontal: 12,
    backgroundColor: 'rgba(255,255,255,0.08)',
    color: '#fff',
    fontFamily: font.semibold,
    fontSize: 18,
    marginBottom: 14,
  },
  customSpeedActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 8,
  },
  customSpeedBtn: {
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  customSpeedBtnPrimary: {
    backgroundColor: 'rgba(255,255,255,0.22)',
  },
  customSpeedBtnText: {
    color: 'rgba(255,255,255,0.85)',
    fontFamily: font.medium,
    fontSize: 13,
  },
  customSpeedBtnTextPrimary: {
    color: '#fff',
    fontFamily: font.semibold,
    fontSize: 13,
  },
});

const Scrim = memo(function Scrim({
  locked,
  panelOpen,
  menu,
  scrubActive,
}: {
  locked: boolean;
  panelOpen: boolean;
  menu: MenuId;
  scrubActive: boolean;
}) {
  const visible = useChromeVisible();
  const topUp = visible && !locked && !panelOpen && !menu;
  const bottomBarUp = (visible && !locked && !panelOpen) || scrubActive;
  if (!(topUp || bottomBarUp)) return null;
  return <View style={styles.scrim} pointerEvents="none" />;
});

const SkipButtonHost = memo(function SkipButtonHost({
  activeSkip,
  locked,
  panelOpen,
  scrubActive,
  barHeight,
  switching,
  insets,
  seekWithGrace,
  player,
  durationRef,
  positionRef,
}: {
  activeSkip: { kind: 'opening' | 'ending'; start: number; end: number } | null;
  locked: boolean;
  panelOpen: boolean;
  scrubActive: boolean;
  barHeight: number;
  /** The episode-transition gate — a skip here would seek the item being left. */
  switching: boolean;
  insets: EdgeInsets;
  seekWithGrace: (apply: () => void, target?: number) => void;
  player: any;
  durationRef: any;
  positionRef: any;
}) {
  const visible = useChromeVisible();
  const bottomBarUp = (visible && !locked && !panelOpen) || scrubActive;

  if (locked || switching) return null;

  if (activeSkip) {
    return (
      <View
        pointerEvents="box-none"
        style={[styles.skipFloat, { right: insets.right + 12, bottom: barHeight + ABOVE_BAR_GAP }]}
      >
        <Animated.View entering={FadeIn} exiting={FadeOut}>
          <Pressable
            onPress={() => {
              const skipTarget = Math.ceil(activeSkip.end);
              seekWithGrace(() => {
                void player.seekBy(skipTarget - player.currentTime);
              }, skipTarget);
            }}
            accessibilityRole="button"
            accessibilityLabel={activeSkip.kind === 'opening' ? 'Skip opening' : 'Skip ending'}
            style={({ pressed }) => [styles.skipButton, pressed ? styles.skipPressed : null]}
          >
            <AppIcon name="skipForward" size={16} color="#fff" strokeWidth={2.5} />
            <Text style={styles.skipLabel}>
              {activeSkip.kind === 'opening' ? 'Skip opening' : 'Skip ending'}
            </Text>
          </Pressable>
        </Animated.View>
      </View>
    );
  }

  if (bottomBarUp && !panelOpen) {
    return (
      <View
        pointerEvents="box-none"
        style={[styles.skipFloat, { right: insets.right + 12, bottom: barHeight + ABOVE_BAR_GAP }]}
      >
        <Animated.View entering={FadeIn} exiting={FadeOut}>
          <Pressable
            onPress={() => {
              const dur = durationRef.current;
              const target = Math.floor(positionRef.current) + SKIP_FORWARD_S;
              const clamped = dur > 0 ? Math.min(target, Math.max(0, dur - 0.5)) : target;
              seekWithGrace(() => {
                void player.seekBy(clamped - player.currentTime);
              }, clamped);
            }}
            accessibilityRole="button"
            accessibilityLabel={`Skip forward ${SKIP_FORWARD_S} seconds`}
            style={({ pressed }) => [styles.skipButton, styles.skipForward, pressed ? styles.skipPressed : null]}
          >
            <AppIcon name="skipForward" size={16} color="#fff" strokeWidth={2.5} />
            <Text style={styles.skipLabel}>{`+${SKIP_FORWARD_S}s`}</Text>
          </Pressable>
        </Animated.View>
      </View>
    );
  }

  return null;
});
