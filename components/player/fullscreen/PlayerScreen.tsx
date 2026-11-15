// The landscape fullscreen player.
//
// This is the whole screen. It replaces the vertical watch page, which is parked
// at `components/player/legacy/VerticalPlayerScreen.tsx`.
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

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  AppState,
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
  type ContentType,
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
import { GestureSurface } from './GestureSurface';
import { SettingsPanel } from './SettingsPanel';
import { type MenuRow } from './Menu';
import { AppIcon } from '@/components/ui/AppIcon';
import { SubtitleOverlay } from '@/components/player/SubtitleOverlay';
import { applyTuning, tuningFor } from '@/lib/player/tuning';
import { describeFailure, type FailureReport } from '@/lib/player/failure';
import { commitTolerance, toleranceFor } from '@/lib/player/scrub';
import {
  healthProfile,
  nextLowerRung,
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
import { cueAtSync, parseVTT, type Cue } from '@/lib/subtitles/vtt';
import { resolveSubtitleStyle } from '@/lib/subtitles/style';
import { NO_TRACK, SUBTITLE_OFF, pickTrack, preferenceFor } from '@/lib/subtitles/select';
import { clearPosition, loadPosition, loadPositions, savePosition, isSynced, markSynced } from '@/lib/progress';
import { createRegistry, resolveEpisode } from '@/lib/extensions/registry';
import { fetchText } from '@/lib/extensions/fetch';
import { listVariants, type HlsVariant } from '@/lib/extensions/hls';
import type { Container, EpisodeInfo, SubtitleTrack, WatchSource } from '@/lib/extensions/types';
import { clearPresence, releasePresence, updatePresence, type PresenceMedia } from '@/lib/presence/discord';
import { fetchMedia, mediaTitle, type MediaDetail } from '@/lib/anilist';
import { episodesToShow, nextPlayableEpisode } from '@/lib/anilist/episodes';
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
import { setSetting, readSetting } from '@/lib/settings/store';
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
import { healOnFrame, wrapVerdict } from '@/lib/player/failover';
import { pickStartIndex, readSourcePref, saveSourcePref } from '@/lib/player/sourcePref';

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
/** Below this a source's runtime is too short to judge "finished" by. */
const SHORT_EPISODE = 300;
const MARK_FINISHED = 0.9;
/**
 * How long the ended frame holds before auto-advance replaces the route.
 *
 * Not zero on purpose: an instant swap at the last decoded frame reads as the
 * episode was cut off, and it also gives the resume save and the in-flight
 * 82% sync a beat before the screen tears down (the sync survives unmount —
 * the promise chain outlives the component — but the beat is still kind).
 * The manual next-episode button needed no such delay; this is only for the
 * one the player presses on the viewer's behalf.
 */
const AUTO_ADVANCE_DELAY_MS = 1500;

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

/**
 * `WatchSource.container` → expo-video's `ContentType`.
 *
 * ⚠️ WHY `'auto'` (URI sniffing) is NOT the default, and the one device report
 * that settled it. `'auto'` makes media3 INFER the source type from the URI's
 * file extension alone (`node_modules/expo-video/.../ContentType.kt`: AUTO
 * writes NO mimeType on the MediaItem). A URL with no extension at all — the
 * Bingr/Katana signed token `https://hikari.streamrip.fun/p/<opaque>` —
 * infers "other", which is the PROGRESSIVE extractor stack, and that stack
 * sniffs a `#EXTM3U` text playlist byte-for-byte: `NoDeclaredBrand`,
 * "None of the available extractors could read the stream", failover to Mega.
 * Every pick of Katana silently landed on Mega because of THIS, not signed-URL
 * expiry (30 Oct's first diagnosis — a `refresh()` could never fix it; every
 * fresh token fails identically, and the log said so).
 *
 * But OUR older lesson still stands: an extension that DERIVES `container`
 * from the URL string can mislabel, and an explicit type on a mislabelled
 * source is handed to the extractor unverified. So the rule is: trust the
 * label where the URL is SILENT (that is the only information there is, and
 * HLS-token sources of the Katana class assert it — `lib/extensions/filmu`
 * fails closed if the fetched master is not `#EXTM3U`); fall back to `'auto'`
 * sniffing when the label and the URL CONTRADICT each other (the mp4-
 * disguised-as-“playlist” case that produced the 7 Oct black video).
 */
const CONTAINER_TO_CONTENT_TYPE: Record<Container, ContentType> = {
  hls: 'hls',
  mp4: 'progressive',
};
/** The URL itself carries the extension the label claims — label is redundant but right. */
function labelAgrees(s: WatchSource): boolean {
  const u = s.url.toLowerCase();
  if (s.container === 'hls') return !u.includes('.mp4');
  // `'mp4'`: media3's progressive stack sniffs the container itself
  // (NoDeclaredBrand is fine to incur here — it is what the extractors
  // answer for a master we did label right), so we only refuse the case
  // where the URL positively NAMES an m3u8.
  return !u.includes('.m3u8');
}
/**
 * The contentType a source is loaded with. See `labelAgrees` above.
 * `'auto'` for an unlabelled source is unchanged: extension-based sniffing
 * on a URL that carries `.m3u8`/`.mp4` reaches the same pipeline the label
 * would have chosen, at no cost.
 */
function contentTypeFor(s: WatchSource): ContentType {
  const declared = CONTAINER_TO_CONTENT_TYPE[s.container];
  if (declared == null || !labelAgrees(s)) return 'auto';
  return declared;
}
/** True when the sniffed pipeline would disagree with the label. Log-only aid. */
function labelDisagrees(s: WatchSource): boolean {
  const declared = CONTAINER_TO_CONTENT_TYPE[s.container];
  return declared != null && !labelAgrees(s);
}

/**
 * Read a route param as a number, or `NaN`.
 *
 * `useLocalSearchParams<T>()` is a TYPE ASSERTION, not a parser. At runtime the
 * value is `string | string[]` for both params, and the array form is what a
 * duplicated query key produces — `Number(['1','2'])` is `NaN` because the
 * array stringifies to `"1,2"`. The generic silences that, which is how a
 * malformed deep link (`miori://watch/20920/abc`, reachable because `scheme:
 * "miori"` is in `app.json`) turns into `NaN` deep inside a screen that then
 * writes `miori:pos:NaN:NaN` and `miori:synced:NaN:NaN` to the user's disk on
 * every unmount. Junk keys are permanent and the symptom is an AniList
 * complaint rather than "bad link".
 */
function paramNumber(raw: string | string[] | undefined): number {
  const one = Array.isArray(raw) ? raw[0] : raw;
  const n = Number(one);
  return Number.isFinite(n) ? n : NaN;
}

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
  const linkOk =
    Number.isInteger(animeId) && animeId > 0 && Number.isInteger(epNum) && epNum >= 1;

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
   * One number, fed to the subtitles, the toast, the popover and the speed pill,
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
  const onBarMeasure = useCallback((h: number) => {
    // Sub-point rounding on the safe area would otherwise re-render the chrome
    // for a height nobody can see.
    setBarHeight((prev) => (Math.abs(prev - h) < 1 ? prev : h));
  }, []);

  // --- Sources ------------------------------------------------------------
  const [sources, setSources] = useState<WatchSource[]>([]);
  const [failedSources, setFailedSources] = useState<{ id: string; reason: string }[]>([]);
  const [srcIndex, setSrcIndex] = useState(0);
  const [variantsBySource, setVariantsBySource] = useState<Record<number, HlsVariant[]>>({});
  /** `null` = Auto (the master playlist). `{src,v}` locks one variant. */
  const [qualitySel, setQualitySel] = useState<{ src: number; v: number } | null>(null);

  // --- Metadata -----------------------------------------------------------
  const [title, setTitle] = useState('');
  const [episodeTitle, setEpisodeTitle] = useState<string | null>(null);
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
  const [cue, setCue] = useState<Cue | null>(null);
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
  const [showControls, setShowControls] = useState(true);
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
  const [note, setNote] = useState<string | null>(null);
  /**
   * The video surface. Needed because `startPictureInPicture()` is a method on
   * the VIEW — the view owns the native PiP surface, and there is no
   * player-side equivalent to call instead.
   */
  const videoViewRef = useRef<VideoView>(null);
  /** Pending "this source never rendered" timer. */
  const frameWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * Consecutive failure ROUNDS — one round is a walk down every source, not one
   * source. Reset by a rendered frame, so only a genuinely broken episode
   * exhausts the budget.
   */
  const roundsRef = useRef(0);
  /**
   * When the CURRENT stretch of failing began, in wall-clock ms. The second
   * failover budget — see `MAX_FAILOVER_WALL_MS`. Reset by the same events that
   * reset `roundsRef` (a rendered frame, Retry, Change source, a fresh load);
   * 0 means "not running".
   */
  const failClockRef = useRef(0);
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
    applyTuning(p, tuningFor());
  });

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
   * The resolution actually playing, for the monitor's interval callback.
   *
   * A ref beside the `liveHeight` state for the same reason every other ref in
   * this file exists: the health tick runs on its own interval, and putting
   * `liveHeight` in that effect's dependencies would tear the interval down and
   * rebuild it on every ABR switch — which on a weak connection is exactly when
   * the switches are frequent.
   */
  const liveHeightRef = useRef<number | null>(null);
  liveHeightRef.current = liveHeight;
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

const applyResumePosition = useCallback((resumeAt: number) => {
    const duration = player.duration || 0;
    if (duration > 0 && resumeAt >= duration - 30) {
      void clearPosition(animeId, epNum);
      setResumeSettled(true);
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
    }
    setResumeSettled(true);
  }, [player, animeId, epNum, readHealth]);

  const onFirstFrame = useCallback(() => {
    firstFrameRef.current = true;
    setFirstFrame(true);
    clearFrameWatchdog();
    // A frame IS proof the current source works, so the retry budget resets
    // here rather than on a timer — otherwise a long session would eventually
    // refuse to fail over at all. The wall-clock budget resets with it: a
    // surviving frame ends the failing stretch those two bounds measure.
    roundsRef.current = 0;
    failClockRef.current = 0;

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
    if (proven?.extId && proven.extId !== lastSavedExtRef.current) {
      lastSavedExtRef.current = proven.extId;
      void saveSourcePref(animeId, proven.extId);
    }

    // Resume only after a decoded frame exists. Seeking an old HLS position
    // while Android is still attaching its surface can leave audio/time moving
    // over a black VideoView. A remembered position that is effectively past
    // the runtime is stale, so discard it and start the episode normally.
    const resumeAt = resumeSeekAfterFrameRef.current;
    if (resumeAt == null) return;
    resumeSeekAfterFrameRef.current = null;
    applyResumePosition(resumeAt);
  }, [applyResumePosition, clearFrameWatchdog, player, animeId]);

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
  const failoverRef = useRef<() => void>(() => {});
  /**
   * Sources whose self-healing `refresh()` has already been tried this resolve,
   * by index — one attempt per source per `load()`, so a genuinely broken source
   * cannot turn the failover walk into a refresh loop.
   */
  const refreshedRef = useRef<Set<number>>(new Set());
  /** Synchronous guard so two failover calls in one tick cannot both refresh. */
  const refreshBusyRef = useRef(false);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Toast timers, so an unmount cannot leave one firing into a dead component. */
  const noteTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
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
  autoAdvanceRef.current = nextPlayableEpisode(epNum, mediaDetail ?? undefined);
  /** The scheduled advance, so unmount and a manual pick can cancel it. */
  const advanceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
  const bottomBarUp = (showControls && !locked && !panelOpen) || scrubActive;

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

  useEffect(() => {
    const currentCue = cueAtSync(cues, positionRef.current, subsDelayMs);
    setCue((previous) => previous === currentCue ? previous : currentCue);
  }, [cues, subsDelayMs]);

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
   * A transient toast. Declared here, ABOVE the player-event effects, because
   * the AniList sync path inside `timeUpdate` calls it — a helper used by an
   * effect has to exist before that effect's dependency array is built, not
   * somewhere further down the file.
   */
  const flash = useCallback((msg: string) => {
    setNote(msg);
    const t = setTimeout(() => setNote((n) => (n === msg ? null : n)), 3000);
    noteTimersRef.current.push(t);
  }, []);

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
  const [pokeNonce, setPokeNonce] = useState(0);
  const pokeControls = useCallback(() => {
    setShowControls(true);
    setPokeNonce((n) => n + 1);
  }, []);

  const toggleControls = useCallback(() => {
    // Tapping the chrome away should leave it away. Clearing the pending timer
    // stops it firing into a state it no longer describes.
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    setShowControls((s) => {
      if (s) setMenu(null);
      return !s;
    });
  }, []);

  // The auto-hide countdown, re-armed whenever the chrome becomes eligible to
  // hide again.
  //
  // A menu or the episode panel is an explicit request to stay — the timer must
  // not yank the chrome out from under a list someone is reading. Locked skips
  // it entirely, because the chrome is not even rendered while locked.
  //
  // `showControls` is in the guard rather than in the body: arming a timer that
  // sets a value to what it already is is a pointless wakeup every time the
  // user taps the chrome away.
  useEffect(() => {
    if (!showControls || menu || panelOpen || locked) return;
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    // `pokeNonce` reads as unused inside the body, but it is the dependency that
    // RESTARTS the countdown on every interaction — see `pokeControls` above.
    void pokeNonce;
    hideTimerRef.current = setTimeout(() => setShowControls(false), motion.controlsHide);
  }, [showControls, menu, panelOpen, locked, pokeNonce]);

  useEffect(
    () => () => {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
      for (const t of noteTimersRef.current) clearTimeout(t);
      if (frameWatchdogRef.current) clearTimeout(frameWatchdogRef.current);
      // A pending auto-advance must not fire into an unmounted screen: backing
      // out during the 1.5s beat is the viewer saying "stop here".
      if (advanceTimerRef.current) clearTimeout(advanceTimerRef.current);
    },
    []
  );

  // -------------------------------------------------------------------------
  // Loading
  // -------------------------------------------------------------------------
  const load = useCallback(async () => {
    if (!linkOk) return;
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
    setResolving(true);
    roundsRef.current = 0;
    failClockRef.current = 0;
    progressSynced.current = await isSynced(animeId, epNum);
    syncCooldownUntil.current = 0;
    try {
      // THE SOURCE MEMORY rides along with the media fetch — one round trip,
      // no added latency on the resolve path.
      const [m, prefExtId] = await Promise.all([
        fetchMedia(animeId),
        readSourcePref(animeId),
      ]);
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
        // A new resolve is a new mint of signed urls — every source's refresh
        // budget resets with it.
        refreshedRef.current = new Set();
        // START WHERE THE VIEWER LEFT OFF — the first row of the extension
        // that actually played last time, not always the ranked top (the
        // 13 Nov report). Falls back to 0 when the memory is empty or that
        // extension did not answer this resolve; a stale preference never
        // costs a watchable episode. A GLOBAL default source
        // (`player.defaultSource`), when one is set and answered, outranks
        // the memory — a stated preference beats a learned one.
        const defSource = readSetting('player.defaultSource');
        setSrcIndex(
          pickStartIndex(
            r.sources,
            prefExtId,
            defSource && defSource !== 'auto' ? defSource : null
          )
        );
        setQualitySel(null);
        // A new resolve is a fresh attempt: the default-quality applier is
        // re-armed, so a stated rung gets re-locked onto whatever list this
        // resolve produced (a wrap-round failure rebuilds the list and must
        // not silently demote the viewer to Auto forever).
        qualityChosenRef.current = false;
        setVariantsBySource({});
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
          setEpisodeTitle(shown.find((e) => e.number === epNum)?.title ?? null);
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
      const resolvePromise = resolveEpisode(reg, animeId, epNum, m.idMal ?? null, {
        // Search-keyword sources (anikoto family) map anilist id via keyword
        // + catalog-id equality; romaji first (closest to MAL titles).
        titles: [m.title?.romaji, m.title?.english].filter(
          (t): t is string => !!t && t.length >= 3
        ),
      });
      const verdict = await resolveInTwoWindows(resolvePromise, 'No source answered in time');
      if (verdict.kind === 'failed') throw verdict.error;
      applyResolve(verdict.value);
      // The episode panel is populated by the parallel fire-and-forget above,
      // so a slow stream resolve no longer gates it.
    } catch (e: any) {
      if (gen !== loadGenRef.current) return;
      setError(String(e?.message ?? e));
    } finally {
      if (gen === loadGenRef.current) {
        setResolving(false);
        loadBusyRef.current = false;
      }
    }
  }, [animeId, epNum, linkOk, queryClient]);

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
  const failover = useCallback(() => {
    // START THE WALL CLOCK on the first failure of a stretch. Both budgets read
    // it; both are reset by a rendered frame, Retry, Change source and load().
    if (!failClockRef.current) failClockRef.current = Date.now();

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
      const verdict = wrapVerdict(roundsRef.current, failClockRef.current, Date.now());
      if (verdict === 'giveup') {
        clearFrameWatchdog();
        setError('No source could play this episode. Try again, or pick a different episode.');
        return;
      }
      roundsRef.current += 1;
      // Exhausted: fresh signed URLs, try the whole list again.
      pendingSeek.current = player.currentTime;
      // JOIN, DON'T STACK. A resolve may already be in flight — a Retry the
      // viewer tapped while the walk was ending, or the wrap of a parallel
      // failure path. Starting a second resolve on top doubles the network
      // load for the same answer; the in-flight one will land, applyResolve
      // will repopulate the list at index 0, and the walk restarts from there.
      if (!loadBusyRef.current) void load();
    };

    const i = srcIndexRef.current;
    const failing = sourcesRef.current[i];

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
      pendingSeek.current = player.currentTime;
      // The variant selection hung off the dead token's urls; the fresh source
      // restarts on its master.
      if (qualitySelRef.current) {
        qualitySelRef.current = null;
        setQualitySel(null);
      }
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
        if (i + 1 < sourcesRef.current.length) {
          setSrcIndex(i + 1);
        } else {
          wrapLoad();
        }
      })();
      return;
    }

    // A locked quality belonged to the source that just failed. Dropping it is
    // what makes the hop land on the next source's MASTER instead of another
    // dead variant from the same dead server.
    if (qualitySelRef.current) {
      qualitySelRef.current = null;
      setQualitySel(null);
    }
    // Resume exactly where the viewer was, not at the stored position. The
    // stored one is up to `SAVE_EVERY` seconds behind, and a source that dies
    // mid-scene should not restart the scene.
    if (i + 1 < sourcesRef.current.length) {
      pendingSeek.current = player.currentTime;
      setSrcIndex(i + 1);
    } else {
      wrapLoad();
    }
  }, [load, player, clearFrameWatchdog]);

  failoverRef.current = failover;

  // The source -> player effect. Re-runs on source index and on an explicit
  // nonce bump (used when the user re-picks the variant they are already on).
  const [reloadNonce, setReloadNonce] = useState(0);

  useLayoutEffect(() => {
    const s = sources[srcIndex];
    if (!s) return;
    let cancelled = false;
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
    setCue(null);
    setActiveSkip(null);
    playbackProgressRef.current = false;
    setPlaybackProgress(false);
    frameRecoveryUsedRef.current = false;
    // A new media item owes us a new first frame. Leaving the old `true` in
    // place would let the spinner stay dismissed across a switch that is about
    // to show nothing.
    firstFrameRef.current = false;
    setFirstFrame(false);
    clearFrameWatchdog();

    // A locked variant on THIS source loads directly — that is what makes
    // "1080p from source 2" one replace instead of two.
    const sel = qualitySel;
    const variantUrl = sel && sel.src === srcIndex ? variantsBySource[sel.src]?.[sel.v]?.url : undefined;

    const source: VideoSource = {
      uri: variantUrl ?? s.url,
      headers: s.headers,
      // Android's native cache holds stream data for this watch session. The
      // app-level Low/Normal/High setting caps its total disk use; leaving the
      // player clears it after the native player has been released.
      useCaching: Platform.OS === 'android',
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
        const currentCue = cueAtSync(cuesRef.current, p.currentTime, subsDelayRef.current);
        setCue((previous) => previous === currentCue ? previous : currentCue);
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

        if (p.currentTime - lastSaved.current > SAVE_EVERY) {
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
            failoverRef.current();
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
        advanceTimerRef.current = setTimeout(() => {
          advanceTimerRef.current = null;
          router.replace({ pathname: '/watch/[id]/[ep]', params: { id: String(animeId), ep: String(next) } });
        }, AUTO_ADVANCE_DELAY_MS);
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
      const currentCue = cueAtSync(cuesRef.current, player.currentTime, subsDelayRef.current);
      setCue((previous) => previous === currentCue ? previous : currentCue);
    }, SUBTITLE_TICK_MS);

    return () => {
      clearInterval(cueTimer);
      for (const s of subs) s.remove();
    };
  }, [player, animeId, epNum, pushPresence, flash, applyResumePosition, readHealth, loadResumeOnce]);

  // Everything that is per-MEDIA-ITEM rather than per-episode, cleared in one
  // place. Two effects used to reset `playedRef` and `autoSkippedOpening`
  // separately on the same dependencies; one list cannot drift out of sync with
  // the other.
  useEffect(() => {
    playedRef.current = false;
    // The parked-finale flag belongs to the media item that ended. A source or
    // quality switch re-runs this effect (and so does the route replace into a
    // newly picked episode), and the fresh item is not parked — leaving it set
    // would make the first ▶ on the new episode rewind it to 0.
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
    // The buffer monitor starts over with every media item, for the same reason
    // `playedRef` does: the buffer behind the previous source describes a
    // connection that no longer exists, and a fresh source that happens to start
    // thin must be judged on its own merits rather than inheriting a starvation
    // run — which would drop a tier within seconds of arriving on a source that
    // was never the problem.
    healthRef.current = resetHealth(Date.now());
    setHealth(UNKNOWN_HEALTH);
    // A pending auto-advance belongs to the media item that ENDED. A source or
    // quality switch re-runs this effect; a timer scheduled by the old item's
    // `playToEnd` must not survive it and fire a stale `router.replace`.
    if (advanceTimerRef.current) {
      clearTimeout(advanceTimerRef.current);
      advanceTimerRef.current = null;
    }
  }, [srcIndex, qualitySel, reloadNonce]);

  // -------------------------------------------------------------------------
  // Quality gather
  // -------------------------------------------------------------------------
  const gatheringRef = useRef(false);
  const variantsLoadedRef = useRef(false);

  const gatherVariants = useCallback(async () => {
    if (gatheringRef.current || variantsLoadedRef.current) return;
    gatheringRef.current = true;
    try {
      const results = await Promise.all(
        sourcesRef.current.map((s) =>
          listVariants(s.url, s.headers ?? {}).catch(() => [] as HlsVariant[])
        )
      );
      const by: Record<number, HlsVariant[]> = {};
      results.forEach((v, i) => {
        if (v.length) by[i] = v;
      });
      variantsLoadedRef.current = true;
      setVariantsBySource(by);
    } finally {
      gatheringRef.current = false;
    }
  }, []);

  // Prefetch on load rather than on first menu open: the picker then opens with
  // the full list already in hand instead of a loading row.
  useEffect(() => {
    if (sources.length > 0 && Object.keys(variantsBySource).length === 0) {
      void gatherVariants();
    }
  }, [sources, variantsBySource, gatherVariants]);

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

  const onPickQuality = useCallback(
    (key: string) => {
      // Any manual pick — a rung OR Auto — is the viewer steering. The
      // default-quality applier stands down for the rest of this attempt.
      qualityChosenRef.current = true;
      // Capture where the viewer is BEFORE the replace, so the switch lands back
      // there instead of at 0:00. `player.currentTime` is read synchronously
      // here rather than from `position`, because `position` trails the real
      // playhead by up to `timeUpdateEventInterval`.
      const at = player.currentTime;
      if (key === 'auto') {
        qualitySelRef.current = null;
        setQualitySel(null);
        pendingSeek.current = at;
        setReloadNonce((n) => n + 1);
      } else {
        const [src, v] = key.split(':').map(Number);
        if (!Number.isFinite(src) || !Number.isFinite(v)) return;
        qualitySelRef.current = { src, v };
        setQualitySel({ src, v });
        if (src !== srcIndexRef.current) {
          pendingSeek.current = at;
          setSrcIndex(src);
        } else {
          pendingSeek.current = at;
          setReloadNonce((n) => n + 1);
        }
      }
      setMenu(null);
    },
    [player]
  );

  /**
   * THE DEFAULT-QUALITY APPLIER.
   *
   * Fires when the cross-source variant gather lands (and on every source
   * change afterwards), reads `player.defaultQuality`, and locks that rung if
   * the episode actually offers it — the active source's own variant first
   * (no source switch needed), else whichever source owns it, moving to that
   * source exactly as a manual cross-source pick does. Nothing offered at
   * that height, or the viewer already steered this attempt: stand down and
   * stay in Auto. A default that cannot be honoured must never cost an
   * episode, and must never fight a viewer who pressed Auto — that is what
   * `qualityChosenRef` and the empty-hand fall-through are.
   */
  useEffect(() => {
    if (qualityChosenRef.current) return;
    const want = readSetting('player.defaultQuality');
    if (!want || want === 'auto') return;
    if (qualitySelRef.current) return;
    const findLabel = (si: number): number => {
      const list = variantsBySource[si];
      if (!list) return -1;
      return list.findIndex((v) => v.label === want);
    };
    const own = findLabel(srcIndexRef.current);
    if (own >= 0) {
      qualitySelRef.current = { src: srcIndexRef.current, v: own };
      setQualitySel(qualitySelRef.current);
      return;
    }
    for (let si = 0; si < sourcesRef.current.length; si++) {
      const vi = findLabel(si);
      if (vi >= 0) {
        qualitySelRef.current = { src: si, v: vi };
        setQualitySel(qualitySelRef.current);
        // The source moves with the rung — the load effect below replaces the
        // media with the variant URL in one step, same as onPickQuality.
        setSrcIndex(si);
        return;
      }
    }
  }, [variantsBySource, sources, srcIndex]);

  const onPickSource = useCallback(
    (key: string) => {
      const i = Number(key);
      if (!Number.isFinite(i) || i === srcIndexRef.current) {
        setMenu(null);
        return;
      }
      pendingSeek.current = player.currentTime;
      qualitySelRef.current = null;
      setQualitySel(null);
      setSrcIndex(i);
      // THE VIEWER'S CHOICE IS THE INTENT — save it here, not only when a
      // frame proves it. `onFirstFrame` would save the same value moments
      // later, but a viewer who picks Mega explicitly wants Mega even if this
      // episode's Mega row happens to be dead and the walk hops on.
      const picked = sourcesRef.current[i];
      lastSavedExtRef.current = picked?.extId ?? null;
      void saveSourcePref(animeId, picked?.extId);
      setMenu(null);
    },
    [player, animeId]
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

      if (verdict.dropTier) {
        /**
         * Step down ONE rung, from where the pipeline actually is.
         *
         * `mergedQualities` is the merged cross-source ladder, already sorted
         * high→low, so "the next one down" is an index. `liveHeight` is
         * `player.videoTrack`, the only observation available for "which rung is
         * playing" — without it the module falls back to the second-from-top
         * rather than the top, because ExoPlayer's own ABR has already been
         * adapting for however long the buffer was thin and selecting the top of
         * the ladder would RAISE quality during the incident meant to lower it.
         *
         * `pendingSeek` goes in first for the same reason a manual switch sets
         * it: a replace is a new media item, and without a position to restore
         * the viewer is thrown back to 0:00 by the app's own attempt to help
         * them.
         */
        const next = nextLowerRung(
          mergedQualities.map((q) => q.label),
          liveHeightRef.current
        );
        if (next) {
          pendingSeek.current = player.currentTime;
          onPickQuality(next);
          flash(`Connection is slow — dropped to ${next} to keep playback smooth`);
        }
      }

      if (verdict.health.kind === 'stalled') {
        // One round of the budget, the same one every other dead-source path
        // spends. `failover` is what bounds this, and it is bounded on purpose.
        failoverRef.current();
      }
    };

    const id = setInterval(tick, HEALTH_TICK_MS);
    return () => clearInterval(id);
  }, [player, healthBounds, mergedQualities, onPickQuality, flash, readHealth]);

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
   */
  useEffect(() => {
    const sub = AppState.addEventListener('change', () => {
      const now = Date.now();
      healthRef.current = noteInterruption(readHealth(now), now);
    });
    return () => sub.remove();
  }, [readHealth]);

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
    void fetchText(t.url, 10_000, { headers: t.headers }, 'Subtitles')
      .then((txt) => {
        if (live) setCues(parseVTT(txt));
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
  const onPickEpisode = useCallback(
    (n: number) => {
      // A manual pick outranks a scheduled auto-advance: the viewer said where
      // they want to go, and a timer firing a beat later would replace the
      // route they just chose with the episode they just left.
      if (advanceTimerRef.current) {
        clearTimeout(advanceTimerRef.current);
        advanceTimerRef.current = null;
      }
      if (n === epNum) {
        setPanelOpen(false);
        return;
      }
      setPanelOpen(false);
      router.replace({ pathname: '/watch/[id]/[ep]', params: { id: String(animeId), ep: String(n) } });
    },
    [animeId, epNum]
  );

  const onPrev = useCallback(() => {
    if (epNum > 1) onPickEpisode(epNum - 1);
  }, [epNum, onPickEpisode]);

  const onNext = useCallback(() => {
    if (epNum < totalEps) onPickEpisode(epNum + 1);
  }, [epNum, totalEps, onPickEpisode]);

  // -------------------------------------------------------------------------
  // Misc actions
  // -------------------------------------------------------------------------
  const onRetry = useCallback(() => {
    // Reset the budget, or "Try again" re-exhausts it on the first failure and
    // the button appears to do nothing. `load()` resets both budgets at its
    // top; these lines cover the same intention explicitly so the handler does
    // not silently depend on that ordering.
    roundsRef.current = 0;
    failClockRef.current = 0;
    void load();
  }, [load]);

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
    // A fresh decision by the viewer: both failover budgets restart.
    roundsRef.current = 0;
    failClockRef.current = 0;
    const i = srcIndexRef.current;
    if (sourcesRef.current.length > 1) {
      pendingSeek.current = player.currentTime;
      qualitySelRef.current = null;
      setQualitySel(null);
      setSrcIndex((i + 1) % sourcesRef.current.length);
    } else {
      void load();
    }
  }, [player, load]);

  const onBack = useCallback(() => {
    if (router.canGoBack?.()) router.back();
    else router.replace('/(tabs)');
  }, []);

  const onPip = useCallback(() => {
    // On the VIEW, not the player — `startPictureInPicture` is a VideoView
    // method. The ref is null for the frame before the view mounts and on web,
    // and both are handled rather than thrown.
    void videoViewRef.current
      ?.startPictureInPicture()
      .catch(() => flash('Picture in picture unavailable'));
  }, [flash]);

  const onToggleLock = useCallback(() => {
    setLocked((l) => {
      if (l) {
        // Unlocking brings the chrome back. Leaving it hidden means the user
        // taps "unlock" and then has to tap again to find the controls they
        // just asked to get back.
        pokeControls();
      } else {
        setShowControls(false);
        setMenu(null);
      }
      return !l;
    });
  }, [pokeControls]);

  const onMute = useCallback(() => {
    setMuted((m) => {
      player.muted = !m;
      return !m;
    });
  }, [player]);

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
      }
    },
    [readHealth, pushPresence, player]
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
      releasePresence();
      void clearPresence();
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
    const rows: MenuRow[] = [{ key: 'auto', label: 'Auto', selected: qualitySel === null }];
    if (mergedQualities.length === 0 && Object.keys(variantsBySource).length === 0) {
      rows.push({ key: '__loading', label: 'Loading qualities…', disabled: true });
      return rows;
    }
    for (const q of mergedQualities) {
      rows.push({
        key: `${q.src}:${q.v}`,
        label: q.label,
        hint: q.own ? undefined : `source ${q.src + 1}`,
        selected: !!qualitySel && qualitySel.src === q.src && qualitySel.v === q.v,
      });
    }
    return rows;
  }, [mergedQualities, qualitySel, variantsBySource]);

  const sourceRows: MenuRow[] = useMemo(() => {
    const rows: MenuRow[] = sources.map((s, i) => ({
      key: String(i),
      label: s.quality ? `${s.quality} — source ${i + 1}` : `Source ${i + 1}`,
      hint: i === srcIndex ? 'playing' : undefined,
      selected: i === srcIndex,
    }));
    // Providers that did not contribute sources (e.g. Katana/bingr blocked by
    // the network) still show up, faded, with the reason — so the sheet
    // explains WHY a source is missing instead of pretending it never existed.
    const nameFor = (id: string) =>
      id === 'filmu' ? 'Katana' : id === 'mega' ? 'Mega' : id;
    failedSources.forEach((f) => {
      rows.push({
        key: `failed-${f.id}`,
        label: nameFor(f.id),
        hint: f.reason,
        selected: false,
        disabled: true,
      });
    });
    return rows;
  }, [sources, srcIndex, failedSources]);

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
   * — the same rule the toast obeys), and does NOT move when the chrome hides.
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
  const skipButton =
    locked ? null : activeSkip ? (
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
    ) : bottomBarUp && !panelOpen ? (
      <Animated.View entering={FadeIn} exiting={FadeOut}>
        <Pressable
          onPress={() => {
            // Forward by a fixed stretch, clamped to the runtime when it is
            // known — landing exactly on the end would fire `playToEnd` and
            // auto-advance, which is not what a "skip ahead" button promises.
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
    ) : null;

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
  const topUp = showControls && !locked && !panelOpen && !menu;
  const boostRate = isBoosting(speed) ? speed.boost : null;

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
  const buffering =
    desiredPlayingRef.current &&
    (resolving || seekPending || (!firstFrame && !playbackProgress) || health.kind === 'rebuffering' || health.kind === 'starving' || health.kind === 'stalled') &&
    !error;

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
        <View style={styles.errorBox} pointerEvents="box-none">
          <AppIcon name="alert" size={30} color="#FF6B6B" strokeWidth={2} />
          <Text style={styles.errorTitle}>That link is not an episode</Text>
          <Text style={styles.errorBody}>
            Miori could not read an anime and episode number out of this address.
          </Text>
          <Pressable onPress={onBack} style={styles.errorBtn} accessibilityRole="button">
            <Text style={styles.errorBtnText}>Go back</Text>
          </Pressable>
        </View>
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
        surfaceType={tuning.surfaceType}
        onFirstFrameRender={onFirstFrame}
      />

      <SubtitleOverlay
        cue={cue}
        style={subtitleStyle}
        bottomOffset={barHeight}
        topOffset={chromeTop}
        sideInset={sideInset}
      />

      {/* A scrim only while the chrome is up, so the title and timeline stay
          readable over a bright frame without dimming the video at rest. */}
      {topUp || bottomBarUp ? (
        <View style={styles.scrim} pointerEvents="none" />
      ) : null}

      <GestureSurface
        // NOT `!locked`. The gesture surface has to stay live while the controls
        // are locked, because a tap on the locked frame is what wakes the unlock
        // affordance — disabling it here would make the small unlock button the
        // ONLY exit, which is exactly the accidental-pocket-unlock trap the lock
        // exists to avoid. `locked` is handled inside the handlers instead.
        enabled={!menu && !panelOpen}
        locked={locked}
        boostRate={boostRate}
        handlers={{
          // Note: a SIDE single tap arrives only after the double-tap window
          // closes, so the very first toggle after the chrome has been hidden
          // has up to ~300ms of air under it — that is the arbitration cost, and
          // it is the price for double-tap seeks that never flash the overlay.
          // A tap in the middle (dead band) still toggles instantly.
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
          // `onDoubleTap` exists for future side effects (analytics, HUD), not
          // for chrome work, which is deliberately out of the gesture path.
          onDoubleTap: () => {
            if (locked) return;
          },
          onSeek: onGestureSeek,
          onHoldStart,
          onHoldMove,
          onHoldEnd,
        }}
      />

      <TopBar
        visible={topUp}
        title={title}
        episode={epNum}
        episodeLabel={episodeTitle}
        onBack={onBack}
        onEpisodes={() => {
          setMenu(null);
          setPanelOpen(true);
        }}
        onLock={onToggleLock}
        onSettings={() => setMenu(menu === 'root' || menu === 'subsSettings' ? null : 'root')}
        settingsActive={menu === 'root' || menu === 'subsSettings'}
        onPip={onPip}
        pipAvailable={pipSupported}
        locked={locked}
        insets={insets}
      />

      <CenterTransport
        visible={topUp}
        playing={playing}
        // `seekPending` closes the gap the health monitor structurally
        // cannot: right after a seek (or a source/quality replace) the buffer
        // readout is unknowable, which `observeHealth` answers with
        // `unknown` — a verdict that produces no ring. But the picture IS
        // frozen, and "frozen with a pause icon" is the one state a player
        // must not show without a word. The seek's own issue is the honest
        // signal; the ring clears from the `timeUpdate` listener the moment
        // frames resume.
        buffering={buffering}
        hasPrev={epNum > 1}
        hasNext={epNum < totalEps}
        onPlayPause={() => {
          // A pause is the viewer grabbing the wheel — capture the INTENT, not
          // the pipeline's state. Using `player.playing` here is the trap: during
          // a buffer `playing` is false even though the viewer wants playback, so
          // a tap would RESUME instead of pause. `desiredPlayingRef` is the wheel,
          // so toggling it gives the right action in every state — including
          // tapping the spinner while it buffers.
          setSeekPending(false);
          const willPause = desiredPlayingRef.current;
          desiredPlayingRef.current = !desiredPlayingRef.current;
          if (willPause) player.pause();
          else {
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
        }}
        onPrev={onPrev}
        onNext={onNext}
      />

      <BottomBar
        player={player}
        visible={bottomBarUp}
        skip={{ intro: sources[srcIndex]?.intro ?? null, outro: sources[srcIndex]?.outro ?? null }}
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
        onTrackWidth={(w) => {
          trackWidthRef.current = w;
        }}
      />

      {/**
       * The skip button, AT SCREEN LEVEL — outside the chrome, so a marker's
       * button survives the chrome hiding (see `skipButton` above for the
       * two-jobs-one-seat design). `barHeight`-anchored like the toast: the
       * offset is measured, not hardcoded, so the button sits just above the
       * bar in every state and does not move when the chrome hides. Mounted
       * after the gesture surface, so the button — not the double-tap zone —
       * wins the touch that lands on it.
       */}
      {skipButton ? (
        <View
          pointerEvents="box-none"
          style={[
            styles.skipFloat,
            { right: insets.right + 12, bottom: barHeight + 12 },
          ]}
        >
          {skipButton}
        </View>
      ) : null}

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
        onNavigate={(to) => setMenu(to as MenuId)}
        onClose={() => setMenu(null)}
        insets={insets}
        // Subtitle settings live IN the panel (the drill-in's last entry), so
        // size/position/style are adjustable mid-episode — the same keys and
        // semantics the settings page writes, not a second copy of them.
        subsStyle={{
          size: subsSize,
          position: subsPosition,
          positionFrac: subsPositionFrac,
          background: subsBackground,
          color: subsColor,
          delayMs: subsDelayMs,
        }}
        onSubsSize={(k) => setSetting('subs.size', k)}
        onSubsPosition={(k) => setSetting('subs.position', k)}
        onSubsPositionFrac={(v) => {
          setSetting('subs.position', 'custom');
          setSetting('subs.positionFrac', v);
        }}
        onSubsBackground={(k) => setSetting('subs.background', k)}
        onSubsColor={(k) => setSetting('subs.color', k)}
        onSubsDelay={(ms) => setSetting('subs.delayMs', ms)}
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
        current={epNum}
        onPick={onPickEpisode}
        onClose={() => setPanelOpen(false)}
        insets={insets}
        onVisibleNumbers={handleVisibleNumbers}
      />

      {note ? (
        <Animated.View
          entering={FadeIn}
          exiting={FadeOut}
          style={[
            styles.note,
            {
              // `barHeight`, not `bottomBarUp ? barHeight : 32`. The toast used
              // to drop 125pt the instant the chrome auto-hid, three seconds
              // after whatever prompted it — so a message about the episode you
              // just finished arrived, and then left, under the viewer's eyes.
              bottom: barHeight + 14,
              left: insets.left,
              right: insets.right,
            },
          ]}
          pointerEvents="none"
        >
          <Text style={styles.noteText}>{note}</Text>
        </Animated.View>
      ) : null}

      {error ? (
        <Animated.View entering={FadeIn} style={styles.errorBox} pointerEvents="box-none">
          <AppIcon name="alert" size={30} color="#FF6B6B" strokeWidth={2} />
          <Text style={styles.errorTitle}>Playback failed</Text>

          {/**
           * THE CAUSE FIRST, IN THE VIEWER'S TERMS.
           *
           * `failure` is `describeFailure`'s verdict on the engine's own
           * message, and it leads because it is the only line that tells anyone
           * what to do. The raw message follows underneath in a smaller, dimmer
           * style — kept, not replaced, because it is the only part of this
           * screen a bug report can use, and a classification that discarded it
           * would be substituting a guess for a fact.
           *
           * The `error` string is the fallback for the two failures that never
           * come from the player at all: the resolve deadline, and an AniList or
           * extension request that failed before there was ever a source to play.
           * Showing both would be noise, and showing neither would be silence.
           */}
          <Text style={styles.errorBody}>{failure ? failure.headline : error}</Text>
          {failure && failure.detail !== failure.headline ? (
            <Text style={styles.errorDetail} numberOfLines={3}>
              {failure.detail}
            </Text>
          ) : null}

          {/**
           * WHAT WAS ACTUALLY TRIED, because "it failed" and "it failed on all
           * three mirrors" are different reports and the viewer is about to make
           * a decision — retry, switch, or leave — on the strength of them.
           * Deliberately counts SOURCES rather than attempts; the retry budget
           * is three rounds over the same list, so saying "9 attempts" would
           * describe a mechanism rather than a situation.
           */}
          {sources.length > 1 ? (
            <Text style={styles.errorDetail}>
              Tried all {sources.length} sources.
            </Text>
          ) : null}

          {/**
           * THREE OUTWAYS, AND NOT ONE OF THEM IS OPTIONAL.
           *
           * It was a single "Try again" over a full-screen opaque panel. On iOS
           * — where there is no hardware back button and the stack's header is
           * hidden on this route — that left exactly one control on the screen
           * and no way out of it. Even on Android, where the hardware button
           * does work, "Try again" against a dead CDN is a loop with no exit,
           * and the source list is the one input that can actually change the
           * outcome.
           *
           * "Change source" restarts the failover walk from the top rather than
           * waiting out the remaining budget, which is what makes it different
           * from Retry rather than a second spelling of it.
           */}
          <View style={styles.errorActions}>
            <Pressable onPress={onRetry} style={styles.errorBtn} accessibilityRole="button">
              <Text style={styles.errorBtnText}>Try again</Text>
            </Pressable>
            {sources.length > 1 ? (
              <Pressable onPress={onChangeSource} style={styles.errorBtnAlt} accessibilityRole="button">
                <Text style={styles.errorBtnText}>Change source</Text>
              </Pressable>
            ) : null}
            <Pressable onPress={onBack} style={styles.errorBtnGhost} accessibilityRole="button">
              <Text style={styles.errorBtnGhostText}>Back</Text>
            </Pressable>
          </View>
        </Animated.View>
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
   * (`insets.right + 12`, `barHeight + 12`) because both are measured — the
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
  note: {
    position: 'absolute',
    alignSelf: 'center',
    // No `bottom` here. It was `170` and was then overridden inline on every
    // render, so the value in the stylesheet described nothing — the classic way
    // for a stale number to survive a change to the thing it was measuring.
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: radii.full,
    backgroundColor: 'rgba(0,0,0,0.8)',
  },
  noteText: {
    color: '#fff',
    fontFamily: font.medium,
    fontSize: 13,
  },
  errorBox: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: 'rgba(0,0,0,0.86)',
    paddingHorizontal: 32,
  },
  errorTitle: {
    color: '#fff',
    fontFamily: font.bold,
    fontSize: 17,
  },
  errorBody: {
    color: 'rgba(255,255,255,0.7)',
    fontFamily: font.regular,
    fontSize: 13,
    lineHeight: 19,
    textAlign: 'center',
    maxWidth: 380,
  },
  /**
   * The engine's own words, and the "tried N sources" count.
   *
   * Dimmer and smaller than `errorBody` on purpose: this is evidence, not the
   * headline. It is also the only part of this screen a bug report can use, so
   * it is shown rather than summarised — see `failure.detail`'s contract in
   * `lib/player/failure.ts`.
   */
  errorDetail: {
    color: 'rgba(255,255,255,0.42)',
    fontFamily: font.mono,
    fontSize: 11,
    lineHeight: 16,
    textAlign: 'center',
    maxWidth: 400,
  },
  errorActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginTop: 14,
    flexWrap: 'wrap',
    justifyContent: 'center',
  },
  errorBtn: {
    paddingHorizontal: 18,
    paddingVertical: 9,
    borderRadius: radii.full,
    backgroundColor: 'rgba(255,255,255,0.14)',
  },
  errorBtnAlt: {
    paddingHorizontal: 18,
    paddingVertical: 9,
    borderRadius: radii.full,
    backgroundColor: 'rgba(255,255,255,0.14)',
  },
  /**
   * "Back" is visually the quietest of the three, and deliberately so.
   *
   * It is the only one that is always safe, so it must not compete with the two
   * that are guesses about what went wrong. A 44pt touch target on a ghost
   * button, so the styling can recede without the target doing the same.
   */
  errorBtnGhost: {
    paddingHorizontal: 14,
    paddingVertical: 11,
    borderRadius: radii.full,
  },
  errorBtnText: {
    color: '#fff',
    fontFamily: font.semibold,
    fontSize: 13,
  },
  errorBtnGhostText: {
    color: 'rgba(255,255,255,0.6)',
    fontFamily: font.medium,
    fontSize: 13,
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
