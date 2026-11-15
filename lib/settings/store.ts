// User-adjustable settings.
//
// Design notes:
//  - Flat dotted keys, not a nested object. Flat keys give a primitive
//    snapshot, which is what makes `useSyncExternalStore` cheap.
//  - Values are literal unions, so an invalid value is a type error rather
//    than a runtime surprise.
//  - Storage is one key for the whole bag. Settings are read together and
//    written rarely; a key per setting would mean N native reads to render.
//
// NOTE: the old nav.* keys (position/style/radius) were removed with the old
// overlay navbar. Kept out deliberately — the new top bar has no settings.

import AsyncStorage from '@react-native-async-storage/async-storage';
// The clamp for `player.speed`. `speed.ts` imports nothing, so this edge does
// not cycle — and the bound has to live in ONE place, because the store
// validates stored values against it and the player clamps live edits with it.
// Two copies would drift and silently reject rates the player had just offered.
import { MAX_SPEED, MIN_SPEED } from '@/lib/player/speed';
// `DEFAULT_PRECISION` rather than the literal `'exact'` so the store's default
// and the player's fallback cannot disagree — the same one-place rule the
// MIN/MAX clamp above exists for.
import { DEFAULT_PRECISION, type SeekPrecision } from '@/lib/player/scrub';
import { DEFAULT_POSITION_FRAC } from '@/lib/subtitles/style';

const STORAGE_KEY = 'miori:settings';

/**
 * The tile designs, in display order. The settings UI lists these; the store
 * only ever sees the `key`s, which is what the `home.tileStyle` union is
 * derived from — so adding a design is one entry here and nothing else.
 */
// Locked dark: light mode is no longer supported (the app is video-led and the
// light palette was never finished — 42 themed components still hardcode dark
// colours). Only OLED + Dark remain.
export const APP_THEMES = [
  { key: 'oled', label: 'OLED', hint: 'Pure black — saves battery on OLED screens' },
  { key: 'dark', label: 'Dark', hint: 'The default dark palette' },
] as const;
export type AppThemeKey = (typeof APP_THEMES)[number]['key'];

export const TILE_STYLES = [
  {
    key: 'framed',
    label: 'Framed',
    hint: 'Poster set in a quiet card, caption below',
  },
  {
    key: 'clean',
    label: 'Clean',
    hint: 'No card — poster and title, separate and bare',
  },
] as const;

export type TileStyleKey = (typeof TILE_STYLES)[number]['key'];

/**
 * The tab bar designs, in display order. Same registry pattern as
 * TILE_STYLES: the settings UI lists these, the store only ever sees the
 * `key`s, and adding a design is one entry here and nothing else.
 */
export const TAB_BAR_STYLES = [
  {
    key: 'floating',
    label: 'Floating',
    hint: 'Icon pill floating over the screen, dot under the active tab',
  },
  {
    key: 'segmented',
    label: 'Segmented',
    hint: 'Sliding pill behind the active tab, like the details-page strip',
  },
] as const;

export type TabBarStyleKey = (typeof TAB_BAR_STYLES)[number]['key'];

/**
 * Indicator colours for the Segmented tab bar, in display order. The pill is
 * solid and the active label sits ON it, so every option here is dark enough
 * (or dark-backed) to keep that label readable.
 */
export const SEGMENTED_COLORS = [
  { key: '#ffffff', label: 'White' },
  { key: '#7c5cff', label: 'Violet' },
  { key: '#4f8cff', label: 'Blue' },
  { key: '#4ade80', label: 'Green' },
  { key: '#f472b6', label: 'Pink' },
  { key: '#fbbf24', label: 'Amber' },
] as const;

export type SegmentedColor = (typeof SEGMENTED_COLORS)[number]['key'];

/**
 * Episode list direction. `'desc'` is newest-first — see `'episodes.order'`.
 *
 * A union rather than a boolean so the stored value is readable in AsyncStorage
 * and in a reset dump. `true`/`false` would be one byte smaller and would also
 * make the stored JSON meaningless to read six months from now.
 */
export type EpisodeOrder = 'asc' | 'desc';

/**
 * Player backends, in display order. Registry pattern as TILE_STYLES.
 *
 * TWO VALUES, and the third that used to be here is the reason. `'compat'` was
 * removed on 13 Oct: `tuningFor()` branches only on `'native'`, so `compat`
 * produced a `PlayerTuning` BYTE-IDENTICAL to `auto` at every buffer setting —
 * same `bufferOptions`, same `surfaceType`. A screen entry that does nothing is
 * worse than its absence, because someone opens it precisely when playback is
 * misbehaving and is told a conservative fallback is now active when nothing
 * changed. `scripts/check-player-scrub.ts` re-derives this from the module.
 *
 * `'native'` is NOT inert — it is the only thing that selects `surfaceView`, and
 * `surfaceType` is read when the native surface is built, so the change takes
 * effect on the next time the player is opened rather than mid-episode.
 */
export const PLAYER_ENGINES = [
  {
    key: 'auto',
    label: 'Auto',
    hint: 'Default. Lets the video sit in a texture surface, which this app\'s control bars composite over most reliably',
  },
  {
    key: 'native',
    label: 'Native surface',
    hint: 'Direct surface — lower power, but if the picture glitches or the controls vanish, switch back to Auto. Applies next time you open the player',
  },
] as const;

export type PlayerEngineKey = (typeof PLAYER_ENGINES)[number]['key'];

/**
 * Buffer profile. 'balanced' (shown as Normal) is the default — enough held in
 * front of the playhead that an ordinary connection stutters less, without the
 * memory 'high' costs. 'low' holds the least memory in front of the playhead,
 * for low-RAM devices; 'high' holds more so a flaky CDN has slack to stutter
 * through without pausing.
 */
export const PLAYER_BUFFERS = [
  { key: 'low', label: 'Low', hint: 'Least memory — best for low-RAM devices' },
  { key: 'balanced', label: 'Normal', hint: 'Recommended for most connections (default)' },
  { key: 'high', label: 'High', hint: 'Most slack for a weak connection' },
] as const;

export type PlayerBufferKey = (typeof PLAYER_BUFFERS)[number]['key'];

/**
 * How precisely a seek is allowed to land. The keys and the numbers are both
 * `lib/player/scrub.ts`'s — this registry adds only the words.
 *
 * This section replaced "Decoder", which offered Hardware and Software and
 * produced a byte-identical player for both: SDK 57's `PlayerBuilderOptions`
 * carries only the two seek increments, so there is no decoder knob to write,
 * and `decodePinned` was read by nothing.
 */
export const PLAYER_SEEK_PRECISIONS = [
  { key: 'exact', label: 'Exact', hint: 'Land on the exact frame. Slowest on a weak connection' },
  { key: 'fast', label: 'Fast', hint: 'Within a quarter second — not visibly off, quicker on a slow one' },
  { key: 'rough', label: 'Rough', hint: 'Nearest keyframe, up to 2s away. Smoothest to scrub on a bad connection' },
] as const;

export type PlayerSeekPrecisionKey = SeekPrecision;

/**
 * How the player should treat audio that is already playing elsewhere.
 *
 * The values and their ORDER are expo-video's `AudioMixingMode` exactly, not a
 * subset with friendlier names — a renamed union is a union someone will get
 * wrong. The labels here are the words; `lib/player/tuning.ts` passes the key
 * straight through.
 */
export const PLAYER_AUDIO_MIXING = [
  { key: 'auto', label: 'Automatic', hint: 'Other apps keep playing only while this player is muted' },
  { key: 'mixWithOthers', label: 'Play over other audio', hint: 'Music and the episode together, at full volume' },
  { key: 'duckOthers', label: 'Quiet other audio', hint: 'Lower whatever else is playing while the episode does' },
  { key: 'doNotMix', label: 'Silence other audio', hint: 'Pause music and podcasts when playback starts' },
] as const;

export type PlayerAudioMixingKey = (typeof PLAYER_AUDIO_MIXING)[number]['key'];

/**
 * Persistent Android stream-cache budget. The native cache uses LRU eviction.
 */
export const PLAYER_CACHES = [
  { key: 'low', label: 'Low', hint: '64 MB cache limit', bytes: 64 * 1024 * 1024 },
  { key: 'balanced', label: 'Normal', hint: '192 MB cache limit (default)', bytes: 192 * 1024 * 1024 },
  { key: 'high', label: 'High', hint: '384 MB cache limit', bytes: 384 * 1024 * 1024 },
] as const;
export type PlayerCacheKey = (typeof PLAYER_CACHES)[number]['key'];

/**
 * The default-quality choices, in display order. These are HLS variant LABELS
 * as `listVariants` builds them (`${height}p`), not a closed union of the
 * stored value — the stored value stays a free string so a provider that
 * ships '1440p' or '4320p' remains lockable if the picker ever grows it. The
 * four rungs below cover what the current sources actually offer; a label the
 * episode does not carry falls back to Auto by the player's rule, so a stale
 * choice costs nothing.
 */
export const PLAYER_DEFAULT_QUALITIES = [
  { key: 'auto', label: 'Auto', hint: 'Let the player adapt to your connection (default)' },
  { key: '1080p', label: '1080p', hint: 'Full HD — needs a solid connection' },
  { key: '720p', label: '720p', hint: 'HD — a good balance on most connections' },
  { key: '480p', label: '480p', hint: 'SD — light on data, fine on a phone screen' },
  { key: '360p', label: '360p', hint: 'Lowest — for very slow connections' },
] as const;

/**
 * The bottom-bar trigger chip ids. The authority for `player.hiddenControls` —
 * the settings page's toggles and the validator both read this list, so a chip
 * added to Chrome's bar must be added here or it can never be hidden.
 *
 * The settings gear is NOT here: it lives in the top bar's right corner and is
 * not hideable. A stored blob that still carries `'settings'` (from the build
 * where the gear was a bottom chip) is silently re-filtered out by
 * `isKnownValue` — exactly what the re-filtering validator is for.
 */
export const PLAYER_TRIGGER_IDS = ['speed', 'quality', 'source', 'subs'] as const;

/**
 * Subtitle text size. The NUMBERS live in `lib/subtitles/style.ts` — this is
 * only the words and the reasons.
 *
 * `'medium'` is a named key rather than `'default'` because it is the 16pt the
 * overlay hardcoded for months and has to stay put. The app DEFAULT is `'big'`
 * (20pt) — see `lib/subtitles/style.ts` for why the size is the one appearance
 * default that was deliberately moved.
 */
export const SUBTITLE_SIZES = [
  { key: 'tiny', label: 'Tiny', hint: 'Fits the most text — best on a small screen' },
  { key: 'small', label: 'Small', hint: 'Compact' },
  { key: 'medium', label: 'Medium', hint: 'What the player has always used' },
  { key: 'normal', label: 'Normal', hint: 'The old default — 18pt' },
  { key: 'big', label: 'Big', hint: 'Default — 20pt' },
  { key: 'large', label: 'Large', hint: 'Easier to read at arm’s length' },
  { key: 'xlarge', label: 'X-Large', hint: 'Big, for a bright room' },
  { key: 'huge', label: 'Huge', hint: 'For very young eyes' },
] as const;

export type SubtitleSizeKey = (typeof SUBTITLE_SIZES)[number]['key'];

/**
 * Where a cue sits. Both presets are fractions of the ONE measured band in
 * `lib/subtitles/style.ts` — 'default' is that band at the built-in fraction
 * (`SUBTITLE_DEFAULT_FRAC`), 'custom' is wherever the slider left it — and
 * never a function of the bottom bar: its height accounts for the notch and
 * the home indicator, but it is chrome, not the video.
 */
export const SUBTITLE_POSITIONS = [
  { key: 'default', label: 'Default', hint: 'Built-in placement — near the bottom edge, like the slider at 10%' },
  { key: 'custom', label: 'Custom', hint: 'Slide to place subtitles anywhere on the video' },
] as const;
export type SubtitlePositionKey = (typeof SUBTITLE_POSITIONS)[number]['key'];/**
 * What sits behind the text.
 *
 * 'Plate' is the default and the reason this list exists at all rather than a
 * single setting: subtitles land on arbitrary video, and what is legible on a
 * night scene is not legible on a snowfield. A box always works and always
 * covers part of the picture; a shadow covers none and is harder to read.
 */
export const SUBTITLE_BACKGROUNDS = [
  { key: 'plate', label: 'Box', hint: 'A dark box behind each line — always readable' },
  { key: 'shadow', label: 'Shadow', hint: 'No box, just a soft outline — cleaner over dark scenes' },
  { key: 'plain', label: 'None', hint: 'No box and no shadow — nothing drawn behind the text' },
] as const;
export type SubtitleBackgroundKey = (typeof SUBTITLE_BACKGROUNDS)[number]['key'];

/**
 * Text colour for the subtitle glyphs.
 *
 * White is the default and the only one that existed before this module. The
 * others are common subtitle colours from real players.
 */
export const SUBTITLE_COLORS = [
  { key: 'white', label: 'White', hint: 'The default — readable over most scenes' },
  { key: 'yellow', label: 'Yellow', hint: 'Classic subtitle colour, high visibility' },
  { key: 'green', label: 'Green', hint: 'Easy on the eyes over dark scenes' },
  { key: 'cyan', label: 'Cyan', hint: 'Cool tone, high contrast' },
  { key: 'magenta', label: 'Magenta', hint: 'Stands out over anything' },
] as const;
export type SubtitleColorKey = (typeof SUBTITLE_COLORS)[number]['key'];

/**
 * Bounds and granularity of the subtitle sync control, in milliseconds.
 *
 * ±2s is well past any real correction: a sidecar track is authored against a
 * different release, and the drift that produces is a fraction of a second. The
 * range exists so the slider's middle is ZERO — the value the overwhelming
 * majority of viewers are on — rather than so much of it is ever used.
 *
 * 50ms is below the threshold at which a human notices lip-sync drift, so one
 * step is the finest correction worth offering, and 0 sits exactly on the grid
 * (from `MIN`, every 50ms is a step) so the slider can always land back on it.
 */
export const SUBTITLE_DELAY_MIN = -2000;
export const SUBTITLE_DELAY_MAX = 2000;
export const SUBTITLE_DELAY_STEP = 50;

/**
 * Tick labels for the sync slider, derived from the bounds above rather than
 * typed out twice, so the two cannot disagree.
 *
 * They exist because `Slider`'s DEFAULT marks are positional — "Bottom … Top" —
 * which on a timing control is not merely unhelpful, it is wrong. What a viewer
 * needs from these ticks is where ZERO is: the slider's centre, the value almost
 * everyone stays on, and the one place a mis-set sync is recovered from. "−2s …
 * 0 … +2s" says that in five columns of a phone, which the full phrases from
 * `formatSubtitleDelay` would not.
 */
export const SUBTITLE_DELAY_MARKS = [0, 0.25, 0.5, 0.75, 1].map((frac) => {
  const ms = SUBTITLE_DELAY_MIN + frac * (SUBTITLE_DELAY_MAX - SUBTITLE_DELAY_MIN);
  return {
    frac,
    label: ms === 0 ? '0' : `${ms > 0 ? '+' : '\u2212'}${Math.abs(ms) / 1000}s`,
  };
});

/**
 * Discord Rich Presence status, in display order. The keys are Discord's own
 * status strings, so they pass straight through to the gateway payload.
 */
export const PRESENCE_STATUSES = [
  { key: 'auto', label: 'Auto', hint: 'Keep your Discord status — Miori only shows the RPC card' },
  { key: 'online', label: 'Online', hint: 'Force online' },
  { key: 'idle', label: 'Idle', hint: 'Force idle / away' },
  { key: 'dnd', label: 'DND', hint: 'Force do not disturb' },
] as const;
export type PresenceStatusKey = (typeof PRESENCE_STATUSES)[number]['key'];

interface SettingsSchema {
  // Placeholder for the next real preference. Kept non-empty so the store,
  // hydration, and reset paths stay exercised.
  'app.ready': boolean;
  /** App colour theme. 'oled' is pure black (default). Locked dark — no light. */
  'app.theme': 'dark' | 'oled';
  /**
   * Whether the home screen shows the Continue Watching row. Turning it off
   * hides the section AND skips its network call — the list is an AniList
   * request, so someone who never wants it should not be paying for it.
   *
   * Default on: it is the main way back into a show you started.
   */
  'features.continueWatching': boolean;
  /**
   * Whether the home screen shows the AniList PLANNING rail. Same
   * hide-and-skip-the-fetch treatment as Continue Watching. Default on.
   */
  'features.planning': boolean;
  /**
   * Which poster tile design the home rails render. The legal values are the
   * keys of TILE_STYLES above — one source of truth for store, picker and
   * screen.
   *
   * - 'framed': the framed-print tile. Poster inset inside a quiet surface
   *   card with a hairline frame; caption on the card body; thin progress
   *   bar UNDER the art for continue watching. Nothing ever renders on top
   *   of the poster.
   */
  'home.tileStyle': TileStyleKey;
  /**
   * Which design the home tab bar renders. The legal values are the keys of
   * TAB_BAR_STYLES above — one source of truth for store, picker and screen.
   *
   * - 'floating': the original bar — a translucent icon-only pill with a
   *   hairline edge and a small dot under the active icon.
   * - 'segmented': the details-page tab strip — a white pill glides under
   *   the active tab and its glyph inverts to dark while it rides the pill.
   */
  'tabs.style': TabBarStyleKey;
  /**
   * Indicator pill colour for the Segmented tab bar. Only shown in settings
   * while tabs.style is 'segmented' — the Floating bar has no pill to colour.
   */
  'tabs.segmentedColor': SegmentedColor;
  /**
   * Which way the episode list on a detail page runs.
   *
   * - 'desc': newest first. The default, and the reason is not taste — someone
   *   opening a show they are part-way through wants the next episode at the top,
   *   not at the bottom of a scroll. It is also the only order in which the
   *   first row is ever the row the "Watch now" button means.
   * - 'asc': oldest first, which is how you read a story front to back.
   *
   * A PREFERENCE rather than per-title state on purpose. Someone who prefers
   * ascending wants it everywhere; remembering it per anime would mean a
   * first-open prompt on every title and a map of exceptions that nobody can
   * inspect or reset. One setting, applied everywhere, is what the request was
   * and is the behaviour people actually expect from a sort control.
   */
  'episodes.order': EpisodeOrder;
  /**
   * Which player surface renders video. See PLAYER_ENGINES above. Legal
   * values come from that registry, like every other style key.
   */
  'player.engine': PlayerEngineKey;
  /** How much video is held in front of the playhead. See PLAYER_BUFFERS. */
  'player.buffer': PlayerBufferKey;
  /**
   * How precisely a seek lands. See PLAYER_SEEK_PRECISIONS.
   *
   * Replaces the Decoder section, whose three options all produced the same
   * player. `hydrateSettings` copies only keys in `DEFAULTS`, so a stored
   * `player.decode` is dropped on the next write rather than migrated — there
   * is no value in it worth carrying.
   */
  'player.seekPrecision': PlayerSeekPrecisionKey;
  /**
   * What happens to audio that is already playing in another app. See
   * PLAYER_AUDIO_MIXING for why the keys are expo-video's own enum.
   */
  'player.audioMixing': PlayerAudioMixingKey;
  /**
   * Whether the player corrects audio pitch when playback speed changes.
   *
   * SDK 57's default is `true`, and this is the one boolean in the player whose
   * DEFAULT is the more popular choice — so the store default matches it, and
   * turning it off is an opt-in to the chipmunk effect rather than a fix for
   * anything broken. Worth saying plainly, because a setting labelled "preserve
   * pitch" that starts OFF reads as a bug.
   */
  'player.preservesPitch': boolean;
  /**
   * Whether the player automatically skips the opening once when it starts.
   * On by default — the request everyone makes ("skip the intro every
   * episode"). Turn off to watch every opening. Endings are never auto-
   * skipped regardless (post-credits tags).
   */
  'player.autoSkipIntro': boolean;
  /** Whether the player automatically skips the ending (outro) once. Off by
   *  default — outros often carry post-credits tags, so skipping silently
   *  loses content the viewer would not have chosen to skip. */
  'player.autoSkipOutro': boolean;
  /** Persistent Android video cache budget; session data is cleared on exit. */
  'player.cache': PlayerCacheKey;
  /**
   * Which extension the player should START on when it resolves an episode,
   * stored as the extension id ('filmu', 'mega', 'anikoto', 'zoko', or a
   * user-installed one). `'auto'` — the default — means no global preference:
   * the per-anime memory (`lib/player/sourcePref.ts`) and the ranked top keep
   * deciding, which is the behaviour this setting rides on top of. A stated
   * source is used when the episode actually resolves through it; when it does
   * not (blocked, no mapping, extension removed) the player falls back to the
   * current walk — a default must never cost a watchable episode, the same
   * rule the per-anime memory already lives by.
   */
  'player.defaultSource': string;
  /**
   * The quality rung to lock at open, stored as the HLS variant label
   * ('1080p', '720p', …) exactly as `listVariants` names them. `'auto'` — the
   * default — is the ABR master playlist, unchanged. A stated rung is locked
   * only when some source actually offers it (the active source first, then
   * any); otherwise the player stays in Auto rather than inventing a rung.
   * The in-player menu still overrides it for the session, and Auto pressed
   * there means Auto — the applier must not fight an explicit choice.
   */
  'player.defaultQuality': string;
  /**
   * Which bottom-bar trigger chips the user hid, as a JSON array of slot ids
   * ('speed' | 'quality' | 'source' | 'subs'). `'[]'` — the
   * default — is every chip visible. Stored as a JSON string rather than a
   * native array because the whole settings blob is key-value strings; the
   * validator (`isKnownValue`) re-filters it against the known ids so a
   * hand-edited or stale blob can only ever drop, never invent, chips.
   *
   * Unmounting by OWNER choice is deliberate and different from the forbidden
   * hasSubs-conditional chip: it reflows the row once, when its owner changes
   * the setting, and never again while watching.
   */
  'player.hiddenControls': string;
  /**
   * The playback rate the user last CHOSE, as a number.
   *
   * A `number` and not a key union, because the committed rate is not limited
   * to the menu's steps — the held-scrub gesture quantizes to 0.25 and can land
   * on 2.75, and that has to survive a restart like any other choice. Stored as
   * a raw number so the store does not have to know the menu exists.
   *
   * ONLY THE COMMITTED RATE IS SAVED. The press-and-hold boost is deliberately
   * transient — see `lib/player/speed.ts` for why it is modelled as an override
   * rather than a second rate, and what happens to ShonenX when it is not.
   */
  'player.speed': number;
  /**
   * Which subtitle language to prefer, as a stored token rather than a
   * three-value union.
   *
   * A LANGUAGE, not an index, and that is the entire point. An index means
   * something different on every source: pick Japanese on FilmU, switch quality,
   * land on a source whose track 0 is English, and the choice is gone with no
   * error anywhere. A language is comparable across sources, so the resolution
   * rule in `lib/subtitles/select.ts` can be stated once: honour this if the
   * source has it, else English, else the first track.
   *
   * Three reserved values:
   *   - `'auto'`  — English when offered, else the first track. The default.
   *   - `'off'`   — never, even if the source offers English. Not the same as
   *                 "no preference": conflating those two is how turning
   *                 subtitles off becomes indistinguishable from a first run.
   *   - anything else — a `trackKey`: a BCP-47-ish `lang` from the source, or
   *                 its label when it ships no lang. Free-form on purpose; it
   *                 comes from a provider, not from this app, and a closed
   *                 union would reset every track to `'auto'` on upgrade.
   */
  'subs.language': string;
  /** Subtitle text size. See SUBTITLE_SIZES and `lib/subtitles/style.ts`. */
  'subs.size': SubtitleSizeKey;
  /** Subtitle vertical mode: 'default' (built-in placement) or 'custom' (slider). See SUBTITLE_POSITIONS. */
  'subs.position': SubtitlePositionKey;
  /** Vertical position as a fraction of video height from the bottom (0 = bottom, 1 = top). Only used when position is 'custom'. */
  'subs.positionFrac': number;
  /** What is drawn behind the text. See SUBTITLE_BACKGROUNDS. */
  'subs.background': SubtitleBackgroundKey;
  /** Text colour. See SUBTITLE_COLORS. */
  'subs.color': SubtitleColorKey;
  /**
   * Sync correction applied to the subtitle lookup, in milliseconds.
   *
   * POSITIVE DELAYS the subtitles (they appear later than the track says),
   * NEGATIVE ADVANCES them (earlier) — the convention desktop players use, and
   * the one applied in `cueAtSync`. Zero, the default, is "as authored".
   *
   * It exists because a sidecar track is authored against a different release
   * than the one being streamed, and that offset is a property of the FILE, not
   * of our pipeline: we cannot detect it, only the viewer can see it. Also note
   * it is NOT a fix for our own sampling cadence — that is the overlay's own
   * tick, tightened separately, so the default here stays a true zero.
   */
  'subs.delayMs': number;
  /**
   * URLs of extension repositories (GitHub raw or compatible). Empty = none.
   * Manifests are fetched from `<url>/index.json`. No default is shipped, so a
   * fresh install has no sources until the user adds one (Play Store friendly).
   * Multiple repos are supported; manifests are merged (first repo wins on id
   * collision).
   */
  'extensions.repoUrls': string[];
  /**
   * Which sources each repository is allowed to RUN, keyed by the repository
   * URL exactly as it was added. A repository with NO entry here installs all
   * of its manifests — that is what makes this key backwards compatible with
   * the builds that had no notion of installing a source at all.
   *
   * Installation is policy, never storage: every manifest a repo ships stays in
   * the cache either way, so uninstalling a source is a settings write and
   * never a re-download. An id that no longer exists in the repo is ignored by
   * the registry, which re-filters through the manifests it actually has.
   */
  'extensions.repoAllowlists': Record<string, string[]>;
  /**
   * Whether the launch sweep installs new source versions on its own.
   *
   * On by default: a source that quietly broke upstream is the normal reason a
   * user opens this page, and making them tap through it every time turns a
   * fix into a chore. The sweep runs a few seconds after launch rather than
   * during it (see `EXTENSION_SYNC_DELAY_MS`), so it never competes with the
   * first screen's requests. Off makes the sweep report-only: the updates show
   * on the Extensions page and wait for a tap.
   */
  'extensions.autoUpdate': boolean;
  /** Discord Rich Presence status shown while the app is connected. */
  'presence.status': PresenceStatusKey;
  /**
   * The release the user pressed "Skip this version" on, as the normalised
   * version (`1.2.0`, no `v`). `''` — the default — means nothing is skipped.
   *
   * An EQUALITY test is what makes the skip expire on its own: the next release
   * has a different version, so it prompts again without anything clearing this.
   * Free-form rather than a union because it is whatever a tag said; the updater
   * compares it, never branches on it.
   */
  'updates.skippedVersion': string;
}

/** Defaults, and the authoritative list of what exists. */
export const DEFAULTS: SettingsSchema = {
  'app.ready': true,
  'app.theme': 'oled',
  'features.continueWatching': true,
  'features.planning': true,
  'home.tileStyle': 'clean',
  'tabs.style': 'segmented',
  'tabs.segmentedColor': '#ffffff',
  'episodes.order': 'desc',
  'player.engine': 'auto',
  'player.buffer': 'balanced',
  'player.seekPrecision': DEFAULT_PRECISION,
  'player.audioMixing': 'auto',
  'player.preservesPitch': true,
  'player.autoSkipIntro': true,
  'player.autoSkipOutro': false,
  'player.cache': 'balanced',
  'player.defaultSource': 'mega',
  'player.defaultQuality': 'auto',
  'player.hiddenControls': '[]',
  'player.speed': 1,
  // The appearance defaults are the numbers `SubtitleOverlay.tsx` had
  // hardcoded — except the size, which is 20pt by design. They are
  // load-bearing, not arbitrary — see `lib/subtitles/style.ts`.
  'subs.language': 'auto',
  'subs.size': 'big',
  'subs.position': 'default',
  'subs.positionFrac': DEFAULT_POSITION_FRAC,
  'subs.background': 'plate',
  'subs.color': 'white',
  // Zero is "as authored". A non-zero default would silently re-time every
  // track on an install that never asked for it.
  'subs.delayMs': 0,
  'extensions.repoUrls': ['https://github.com/Coolboi018/Miori-Extensions'],
  'extensions.repoAllowlists': {},
  'extensions.autoUpdate': true,
  'presence.status': 'auto',
  'updates.skippedVersion': '',
};

export type SettingKey = keyof SettingsSchema;
export type SettingValue<K extends SettingKey> = SettingsSchema[K];

type Cache = SettingsSchema;

let cache: Cache = { ...DEFAULTS };
let hydrated = false;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

export function subscribeSettings(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function readSetting<K extends SettingKey>(key: K): SettingValue<K> {
  return cache[key];
}

/**
 * Server/web snapshot: before hydration we can only know the defaults.
 * Without this, `useSyncExternalStore` throws during server rendering.
 */
export function readSettingServer<K extends SettingKey>(key: K): SettingValue<K> {
  return DEFAULTS[key];
}

/**
 * Every legal value for a key.
 *
 * An object default is read as the set of options (`{ a: 1, b: 2 }` means
 * "1 or 2"). A boolean default means "true or false" — NOT just the default.
 * `home.tileStyle` uses the first form: its schema default is an object whose
 * VALUES enumerate the designs.
 *
 * That second case is a bug if you forget it: `Object.values(true)` is `[]`,
 * so `isKnownValue` rejects every stored value and `hydrateSettings` silently
 * resets the key to its default on every launch. The toggle would appear to
 * work, then forget itself. Hence the explicit branch.
 */
export function allowedValues<K extends SettingKey>(key: K): Array<SettingValue<K>> {
  const d = DEFAULTS[key] as unknown;
  if (typeof d === 'boolean') return [true, false] as Array<SettingValue<K>>;
  if (typeof d === 'object' && d !== null) {
    return Object.values(d) as Array<SettingValue<K>>;
  }
  return [d as SettingValue<K>];
}

export function isKnownValue(key: SettingKey, value: unknown): boolean {
  if (key === 'home.tileStyle') {
    // TILE_STYLES is the authority for this key, not the lone default —
    // otherwise every design except the default one would be "unknown" and
    // silently reset on launch.
    return TILE_STYLES.some((t) => t.key === value);
  }
  if (key === 'tabs.style') {
    // Same registry-authority treatment as home.tileStyle above.
    return TAB_BAR_STYLES.some((t) => t.key === value);
  }
  if (key === 'tabs.segmentedColor') {
    return SEGMENTED_COLORS.some((c) => c.key === value);
  }
  if (key === 'player.engine') {
    return PLAYER_ENGINES.some((e) => e.key === value);
  }
  if (key === 'player.buffer') {
    return PLAYER_BUFFERS.some((b) => b.key === value);
  }
  if (key === 'player.seekPrecision') {
    return PLAYER_SEEK_PRECISIONS.some((p) => p.key === value);
  }
  if (key === 'player.audioMixing') {
    return PLAYER_AUDIO_MIXING.some((a) => a.key === value);
  }
  if (key === 'player.preservesPitch') {
    // A boolean key, and `allowedValues` handles that shape already — but
    // `hydrateSettings` would silently store `preservesPitch: "false"` from a
    // hand-edited blob without this, and `player.preservesPitch = "false"` is
    // truthy. The cost is one branch; the failure is a pitch setting that
    // cannot be turned off.
    return typeof value === 'boolean';
  }
  if (key === 'player.autoSkipIntro') {
    return typeof value === 'boolean';
  }
  if (key === 'player.autoSkipOutro') {
    return typeof value === 'boolean';
  }
  if (key === 'player.cache') {
    return PLAYER_CACHES.some((b) => b.key === value);
  }
  if (key === 'player.defaultSource' || key === 'player.defaultQuality') {
    // Free-form on purpose — the source is whatever extension id the picker
    // wrote (built-in or user-installed), the quality is whatever label a
    // provider's master playlist uses. The only legal non-default values come
    // from this app's own pickers, so the check is: 'auto', or a non-empty
    // string. An empty one would match nothing in the player and silently
    // behave as Auto while claiming to be set.
    return typeof value === 'string' && (value === 'auto' || value.trim().length > 0);
  }
  if (key === 'player.hiddenControls') {
    // A JSON array of KNOWN slot ids only. Re-filtering (rather than
    // rejecting) matters: a blob from a build whose chip set has changed
    // keeps its still-valid entries instead of silently showing everything
    // again. A malformed or non-array value means "no opinion" — '[]'.
    if (typeof value !== 'string') return false;
    try {
      const parsed: unknown = JSON.parse(value);
      if (!Array.isArray(parsed)) return false;
      return parsed.every(
        (v) =>
          typeof v === 'string' &&
          PLAYER_TRIGGER_IDS.includes(v as (typeof PLAYER_TRIGGER_IDS)[number])
      );
    } catch {
      return false;
    }
  }
  if (key === 'player.speed') {
    // Same trap as the boolean case above, and worse here: the schema default
    // is the NUMBER 1, so `allowedValues` returns `[1]` and every stored rate
    // except exactly 1x would be judged "unknown" and reset to 1x on every
    // launch. The user would pick 1.75x, close the app, come back to 1x.
    //
    // A RANGE rather than an enumeration, because the committed rate is not
    // restricted to the menu's steps — the held-scrub gesture can land on
    // 2.75 — so `SPEED_STEPS` is not the authority here either.
    return (
      typeof value === 'number' &&
      Number.isFinite(value) &&
      value >= MIN_SPEED &&
      value <= MAX_SPEED
    );
  }
  if (key === 'subs.language') {
    // Free-form by design — it comes from a provider's `lang`/`label`, so the
    // only thing to reject is a non-string. The three reserved values
    // ('auto' / 'off' / a trackKey) are all just non-empty strings, and an
    // empty one would silently become "first track" in `pickTrack`, which is
    // not what a blank setting blob means.
    return typeof value === 'string' && value.trim().length > 0;
  }
  if (key === 'subs.size') {
    return SUBTITLE_SIZES.some((s) => s.key === value);
  }
  if (key === 'subs.position') {
    return SUBTITLE_POSITIONS.some((p) => p.key === value);
  }
  if (key === 'subs.background') {
    return SUBTITLE_BACKGROUNDS.some((b) => b.key === value);
  }
  if (key === 'subs.color') {
    return SUBTITLE_COLORS.some((c) => c.key === value);
  }
  if (key === 'subs.positionFrac') {
    // A fraction in [0, 1]. Anything else is corrupt and falls back to default.
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
  }
  if (key === 'subs.delayMs') {
    // Explicit branch for the same reason as `player.speed`: the schema default
    // is the NUMBER 0, so `allowedValues` returns `[0]` and every real
    // correction would be judged unknown and reset to zero on every launch —
    // the viewer would set 0.5s earlier, restart, and find it back in sync.
    return (
      typeof value === 'number' &&
      Number.isFinite(value) &&
      value >= SUBTITLE_DELAY_MIN &&
      value <= SUBTITLE_DELAY_MAX
    );
  }
  if (key === 'extensions.repoUrls') {
    // Array of free-form URL strings. Empty array is the default (no repos).
    return Array.isArray(value) && value.every((v) => typeof v === 'string');
  }
  if (key === 'extensions.repoAllowlists') {
    // Explicit branch, because the default is `{}` and `allowedValues` would
    // read that as "no legal values at all" — every stored allowlist would be
    // judged unknown and reset, silently re-installing every source on launch.
    // Shape: object whose values are arrays of id strings.
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    return Object.values(value as Record<string, unknown>).every(
      (ids) => Array.isArray(ids) && ids.every((id) => typeof id === 'string')
    );
  }
  if (key === 'extensions.autoUpdate') {
    return typeof value === 'boolean';
  }
  if (key === 'presence.status') {
    return PRESENCE_STATUSES.some((s) => s.key === value);
  }
  if (key === 'updates.skippedVersion') {
    // Any string, including the empty default. Its schema default is `''` and
    // `allowedValues` would otherwise return only `['']` — every stored skip
    // would be judged unknown and reset, so the prompt would come back on the
    // next launch and the button would look broken.
    return typeof value === 'string';
  }
  return allowedValues(key).includes(value as SettingValue<typeof key>);
}

/**
 * Load persisted settings once. Safe to call repeatedly and from anywhere —
 * only the first call does work. Call it near app start so the first paint
 * uses real values rather than flashing the defaults and correcting.
 */
export async function hydrateSettings(): Promise<void> {
  if (hydrated) return;
  hydrated = true;
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const next: Cache = { ...DEFAULTS };
    // Copy only known keys with a known value. A stale or hand-edited value
    // must never be able to put a component into an impossible state.
    for (const key of Object.keys(DEFAULTS) as SettingKey[]) {
      const v = parsed[key];
      if (isKnownValue(key, v)) {
        (next as unknown as Record<string, unknown>)[key] = v;
      }
    }
    // Migration: old single-URL setting -> new array setting.
    const oldUrl = parsed['extensions.repoUrl'];
    if (typeof oldUrl === 'string' && oldUrl.trim() && Array.isArray(next['extensions.repoUrls']) && next['extensions.repoUrls'].length === 0) {
      (next as unknown as Record<string, unknown>)['extensions.repoUrls'] = [oldUrl.trim()];
    }
    // Migration: the old default source was 'auto'; the new default is MegaPlay.
    // Only the untouched default is migrated — a viewer who picked a specific
    // source keeps their choice.
    if (next['player.defaultSource'] === 'auto') {
      (next as unknown as Record<string, unknown>)['player.defaultSource'] = 'mega';
    }
    cache = next;
    emit();
  } catch {
    /* unreadable or corrupt — defaults stand, which is always a valid UI */
  }
}

export function setSetting<K extends SettingKey>(key: K, value: SettingValue<K>): void {
  if (cache[key] === value) return;
  cache = { ...cache, [key]: value };
  emit();
  // Fire-and-forget: a failed write costs the user their preference, never
  // their session. Nothing awaits this.
  void AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(cache)).catch(() => {});
}

export function resetSettings(): void {
  cache = { ...DEFAULTS };
  emit();
  void AsyncStorage.removeItem(STORAGE_KEY).catch(() => {});
}
