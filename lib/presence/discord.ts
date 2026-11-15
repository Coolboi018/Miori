// Discord Rich Presence via user token (activity card only — the account's
// custom status note is deliberately NOT touched; see module body).
// Token is full account access: SecureStore only, never logged, ever.
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import {
  gatewayStart,
  gatewayStatus,
  gatewayRest,
  gatewayStop,
  type GatewayStatus,
  type PresenceActivity,
} from './gateway';
import { resolveArt } from './art';
import { ACTIVITY_TYPE, APP_NAME, DISCORD_APP_ID } from './config';
import { readSetting } from '@/lib/settings/store';

const TOKEN_KEY = 'miori_discord_token';
const ENABLED_KEY = 'miori_presence_enabled';
// NOT cleared by clearDiscordToken — it must survive a token wipe so the
// switch-account screen can recognize a silent re-login as the SAME account.
const LAST_USER_KEY = 'miori_discord_last_user_id';

const credListeners = new Set<() => void>();
export function subscribeDiscordCredentials(fn: () => void): () => void {
  credListeners.add(fn);
  return () => credListeners.delete(fn);
}
function notifyCredChange() {
  for (const l of credListeners) l();
}
const API = 'https://discord.com/api/v9';

// Every Discord request is bounded. React Native's fetch has no default
// timeout — on a stalled mobile connection (exactly when the video is
// buffering) a request can hang for minutes rather than failing. The frame
// scheduler holds a `frameBusy` lock across these awaits, so one hung request
// froze every subsequent presence update, which is the opposite of what you
// want on a bad network. Fail fast, carry on, art/status are cosmetic.
const REQ_TIMEOUT = 8000;

async function timedFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQ_TIMEOUT);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// Credential cache. Every presence update needs the token and the enabled
// flag, and both live behind native bridges (SecureStore / AsyncStorage). On a
// flapping stream `playingChange` fires in bursts, so re-reading both per
// event meant a native round-trip per event just to learn values that cannot
// change under us mid-session. The writers below update the cache directly,
// so this is authoritative immediately — the TTL is only a backstop for
// changes made outside this module.
const CACHE_TTL = 5000;

let tokenCache: { v: string | null; at: number } | null = null;
let enabledCache: { v: boolean; at: number } | null = null;

export async function getDiscordToken(): Promise<string | null> {
  if (tokenCache && Date.now() - tokenCache.at < CACHE_TTL) return tokenCache.v;
  try {
    const v = await SecureStore.getItemAsync(TOKEN_KEY);
    tokenCache = { v, at: Date.now() };
    return v;
  } catch {
    return null;
  }
}

export async function saveDiscordToken(token: string): Promise<void> {
  const t = token.trim().replace(/^"|"$/g, '');
  if (!t) throw new Error('Empty token');
  await SecureStore.setItemAsync(TOKEN_KEY, t);
  tokenCache = { v: t, at: Date.now() };
  notifyCredChange();
}

export async function clearDiscordToken(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(TOKEN_KEY);
  } catch {
    /* ignore */
  }
  tokenCache = { v: null, at: Date.now() };
  notifyCredChange();
}

/**
 * Invalidate the Discord session server-side so the next login cannot reuse
 * the cached session (which is what made "log out → log in" silently land on
 * the same account). Best-effort: a dead/expired token just falls through.
 */
export async function logoutDiscordSession(token: string): Promise<void> {
  try {
    await timedFetch(`${API}/auth/logout`, {
      method: 'POST',
      headers: { Authorization: token, 'User-Agent': UA, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
  } catch {
    /* best-effort */
  }
}

export async function isPresenceEnabled(): Promise<boolean> {
  if (enabledCache && Date.now() - enabledCache.at < CACHE_TTL) return enabledCache.v;
  try {
    const v = (await AsyncStorage.getItem(ENABLED_KEY)) === '1';
    enabledCache = { v, at: Date.now() };
    return v;
  } catch {
    return false;
  }
}

export async function setPresenceEnabled(on: boolean): Promise<void> {
  try {
    await AsyncStorage.setItem(ENABLED_KEY, on ? '1' : '0');
  } catch {
    /* ignore */
  }
  enabledCache = { v: on, at: Date.now() };
  notifyCredChange();
}

export interface DiscordUser {
  id: string;
  username: string;
  global_name?: string | null;
  avatar?: string | null;
}

export async function fetchDiscordUser(token: string): Promise<DiscordUser> {
  const res = await timedFetch(`${API}/users/@me`, {
    headers: { Authorization: token, 'User-Agent': UA },
  });
  if (res.status === 401) throw new Error('Discord token invalid — log in again');
  if (!res.ok) throw new Error(`Discord error (${res.status})`);
  return (await res.json()) as DiscordUser;
}

/** Remember which Discord account last logged in, so a "switch account" run
 * can detect the failure mode where the old session survived the wipe
 * (logout request failed, cookie re-auth) and quietly landed back on it. */
export async function rememberDiscordUserId(id: string): Promise<void> {
  try {
    await AsyncStorage.setItem(LAST_USER_KEY, id);
  } catch {
    /* best-effort — the guard simply won't fire next time */
  }
}

export async function getLastDiscordUserId(): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(LAST_USER_KEY);
  } catch {
    return null;
  }
}


/** Fire-and-forget from the player: enabled + token required, else silent.
 * Opens the lightweight gateway (online state + Watching activity). */
export interface PresenceMedia {
  artKey: string;
  artUrl: string;
  pageUrl: string;
  /** Label for the card's button. Defaults to "View Anime". */
  buttonLabel?: string;
}

export interface PlaybackState {
  isPlaying: boolean;
  positionSec: number;
  durationSec: number;
}

function fmtClock(totalSec: number): string {
  const t = Math.max(0, Math.floor(totalSec || 0));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return `${h > 0 ? h + ':' : ''}${mm}:${String(s).padStart(2, '0')}`;
}

// Frame scheduler. The gateway coalesces frames, but that happens AFTER the
// credential reads and the artwork lookup — so a burst of `playingChange`
// events (HLS buffer flaps) still paid a full async pipeline per event to
// produce one frame. Coalesce here instead, upstream of all of it: the newest
// state wins and exactly one apply runs per window.
type Frame =
  | { kind: 'watch'; title: string; ep: number; media?: PresenceMedia; playback?: PlaybackState }
  | { kind: 'browse'; title?: string; media?: PresenceMedia }
  | { kind: 'idle' };

const FRAME_COALESCE_MS = 250;
let pendingFrame: Frame | null = null;
let frameTimer: ReturnType<typeof setTimeout> | null = null;
let frameBusy = false;

async function runFrame(): Promise<void> {
  frameTimer = null;
  const f = pendingFrame;
  pendingFrame = null;
  if (!f) return;
  frameBusy = true;
  const seq = ++frameSeq;
  try {
    await applyFrame(f, seq);
  } catch {
    /* presence never breaks playback */
  } finally {
    frameBusy = false;
    // A frame that arrived mid-apply gets its own window rather than riding
    // along on this one, so a continuous stream still settles.
    if (pendingFrame && !frameTimer) {
      frameTimer = setTimeout(() => {
        void runFrame();
      }, FRAME_COALESCE_MS);
    }
  }
}

function scheduleFrame(f: Frame): void {
  pendingFrame = f;
  if (frameTimer || frameBusy) return;
  frameTimer = setTimeout(() => {
    void runFrame();
  }, FRAME_COALESCE_MS);
}

/** Monotonic id of the frame currently on screen, so a slow artwork upload
 * belonging to a screen the user has already left knows to stand down. */
let frameSeq = 0;

/** Upload the poster and upgrade the activity with it — without holding the
 * frame pipeline.
 *
 * This used to be awaited inline, which meant the upload (a real network round
 * trip to Discord, seconds on a phone, first time per anime) blocked the NEXT
 * screen's presence from being applied at all. That is the "details -> browsing
 * takes ages" symptom: you leave the details page, the outgoing screen is still
 * uploading its poster, and your new screen waits behind it. Detached, and
 * abandoned if the frame has since been superseded. */
function upgradeArt(
  token: string,
  build: (largeImage: string) => PresenceActivity,
  media: PresenceMedia | undefined,
  seq: number
): void {
  if (!media?.artUrl) return;
  void (async () => {
    try {
      const largeImage = (await resolveArt(token, media.artKey, media.artUrl)) ?? undefined;
      if (!largeImage || seq !== frameSeq) return; // user already moved on
      gatewayStart(token, build(largeImage));
    } catch {
      /* artwork is cosmetic */
    }
  })();
}

/** What we last handed to the gateway. Drives the tier decision: only the app
 * knows whether an incoming change is navigation the user is waiting to see,
 * or churn that should be allowed to settle first.
 *  - `settled` is false while the frames for this episode are still missing the
 *    duration (it isn't known until the stream reports it), so those early
 *    frames are establishing the card rather than churning it, and must not be
 *    held back by the churn delay. */
let lastSent:
  | { kind: 'watch' | 'browse'; ep: number; playing: boolean; settled: boolean; bucket: number }
  | null = null;

/** One clock for the whole browsing card. A fresh `Date.now()` on every frame
 * said "this is a NEW activity" to Discord, which is the other half of the
 * re-create-the-card report: the browsing card is one continuing activity, so
 * it keeps one start and the elapsed time reads as one sitting. Cleared when a
 * watch frame lands (see `applyFrame`), so coming back from the player starts
 * a fresh clock rather than inheriting the browsing one. */
let browseStart = 0;
function browseClock(): number {
  if (!browseStart) browseStart = Date.now();
  return browseStart;
}

async function applyFrame(f: Frame, seq: number): Promise<void> {
  if (!(await isPresenceEnabled())) return;
  const token = await getDiscordToken();
  if (!token) return;

  if (f.kind === 'idle') {
    // The release's blank card, applied through the SAME pipeline as every
    // other frame. That is the whole point of routing it here instead of a
    // raw gatewayStart: an applied frame bumps `frameSeq`, which disarms any
    // detached artwork upload still in flight from a dead watch frame. When
    // the idle used to bypass the pipeline, an upload that resolved seconds
    // after it landed passed its own seq check and re-asserted the WATCHING
    // card on top of the destination screen — the "back from the player, the
    // episode is on my profile again" report of 10 Nov.
    gatewayStart(token, {
      name: APP_NAME,
      type: ACTIVITY_TYPE,
      details: 'Browsing Miori',
      state: 'Exploring anime',
      startTimestamp: browseClock(),
      status: readSetting('presence.status') === 'auto' ? undefined : readSetting('presence.status'),
      ...(DISCORD_APP_ID ? { applicationId: DISCORD_APP_ID } : {}),
      sig: 'idle',
      tier: 'screen',
    });
    lastSent = null;
    return;
  }

  if (f.kind === 'browse') {
    const title = f.title;
    const media = f.media;
    const details = title ? title.slice(0, 100) : 'Browsing Miori';
    const frame = (largeImage?: string): PresenceActivity => ({
      name: APP_NAME,
      type: ACTIVITY_TYPE,
      details,
      state: title ? 'Viewing details' : 'Exploring anime',
      startTimestamp: browseClock(),
      status: readSetting('presence.status') === 'auto' ? undefined : readSetting('presence.status'),
      ...(DISCORD_APP_ID ? { applicationId: DISCORD_APP_ID } : {}),
      ...(largeImage ? { largeImage, largeText: (title ?? APP_NAME).slice(0, 100) } : {}),
      ...(media ? { buttons: [{ label: media.buttonLabel ?? 'View Anime', url: media.pageUrl }] } : {}),
      sig: `browse|${title ?? ''}`,
      tier: 'screen' as const,
    });
    gatewayStart(token, frame());
    lastSent = { kind: 'browse', ep: 0, playing: false, settled: true, bucket: 0 };
    upgradeArt(token, frame, media, seq);
    return;
  }

  const { title, ep, media, playback } = f;
  // The player owns the card now, so the next browse/idle frame starts a fresh
  // browsing clock instead of inheriting one from before the episode.
  browseStart = 0;
  const now = Date.now();
  const posMs = Math.max(0, Math.floor((playback?.positionSec ?? 0) * 1000));
  const durMs = Math.max(0, Math.floor((playback?.durationSec ?? 0) * 1000));
  const playing = playback ? playback.isPlaying : true;
  const start = now - posMs;
  // Progress bar needs BOTH ends. `posMs > 0` used to be required here, which
  // meant the bar could never appear at the very start of an episode — exactly
  // when position is legitimately 0. Playing with a known duration is enough.
  const end = playing && durMs > posMs ? start + durMs : undefined;
  const state =
    playing || durMs <= 0
      ? `Episode ${ep}`
      : `Episode ${ep} • ${fmtClock(posMs / 1000)} / ${fmtClock(durMs / 1000)} (Paused)`;
  // Position enters the signature only in 5-minute buckets. Raw position would
  // change on every seek and read as a new screen each time (so scrubbing
  // spams the gateway); dropping it entirely meant a resume from 12:34 never
  // showed up. Buckets give the useful half of both.
  const bucket = Math.floor((playback?.positionSec ?? 0) / 300);
  // What kind of change is this? Only the app can tell, because only it knows
  // what we last told Discord:
  //  - a different episode, or coming from browsing, is navigation the user is
  //    waiting to see -> send now
  //  - early frames for a new episode are still filling the card in (no
  //    duration yet) -> send now, or the progress bar appears 15s late
  //  - play/pause flipping is the spammy one: buffer flapping and
  //    button-mashing both churn it -> wait for it to settle
  //  - a jump to a different part of the episode is real -> send now
  //  - same episode, same place, same state -> a position tick; nothing
  //    meaningful changed -> don't bother
  const tier: PresenceActivity['tier'] =
    !lastSent || lastSent.kind !== 'watch' || lastSent.ep !== ep || !lastSent.settled
      ? 'screen'
      : lastSent.playing !== playing
        ? 'settle'
        : lastSent.bucket !== bucket
          ? 'screen'
          : 'churn';
  const frame = (largeImage?: string): PresenceActivity => ({
    name: APP_NAME,
    type: ACTIVITY_TYPE,
    details: title.slice(0, 100),
    state,
    startTimestamp: start,
    status: readSetting('presence.status') === 'auto' ? undefined : readSetting('presence.status'),
    ...(end ? { endTimestamp: end } : {}),
    ...(DISCORD_APP_ID ? { applicationId: DISCORD_APP_ID } : {}),
    ...(largeImage ? { largeImage, largeText: `${title} EP ${ep}`.slice(0, 100) } : {}),
    ...(media ? { buttons: [{ label: 'View Anime', url: media.pageUrl }] } : {}),
    sig: `watch|${ep}|${playing ? 'p' : 'x'}|${largeImage ? 'a' : '-'}|${bucket}`,
    tier,
  });
  // Text frame goes out FIRST. Resolving artwork is a network round-trip
  // (external-assets upload) and gating the activity on it meant the
  // "Viewing -> Watching" switch waited on it — or never happened at all.
  gatewayStart(token, frame());
  lastSent = { kind: 'watch', ep, playing, settled: durMs > 0, bucket };
  upgradeArt(token, frame, media, seq);
}

/** Fire-and-forget from the player: enabled + token required, else silent.
 * ShonenX shape: playing gets start+end (progress bar), paused gets
 * start only + "pos / dur (Paused)" state. Art resolves first when new. */
export async function updatePresence(
  title: string,
  ep: number,
  media?: PresenceMedia,
  playback?: PlaybackState
): Promise<void> {
  cancelPendingRelease();
  scheduleFrame({ kind: 'watch', title, ep, media, playback });
}

/** Browsing presence — detail pages, home. Same socket, lighter text.
 * No icon for generic browsing (no app logo yet). */
export async function updateBrowsing(title?: string, media?: PresenceMedia): Promise<void> {
  cancelPendingRelease();
  scheduleFrame({ kind: 'browse', title, media });
}

/** Leaving the player for a screen that has no presence of its own.
 * Keeps the socket up (a full gatewayStop here made Discord briefly show the
 * account offline on every back-navigation) and just drops the activity back
 * to neutral. Deferred by a beat so a destination screen that DOES have a
 * browsing frame cancels it — otherwise the two raced and you could land on
 * either one. */
let releaseTimer: ReturnType<typeof setTimeout> | null = null;

function cancelPendingRelease() {
  if (releaseTimer) {
    clearTimeout(releaseTimer);
    releaseTimer = null;
  }
}

export function releasePresence(): void {
  cancelPendingRelease();
  // A watch frame may still be queued from just before the unmount; drop it so
  // it can't re-assert "Watching" after this release lands. A queued BROWSE
  // frame is the opposite case: the destination screen asserted its own
  // presence while the pop transition was still running (focus fires at
  // transition START, unmount at its END) — that frame, not the idle below,
  // is what the account should show.
  if (pendingFrame) {
    if (pendingFrame.kind !== 'watch') return; // destination's own frame owns presence now
    pendingFrame = null;
    if (frameTimer) {
      clearTimeout(frameTimer);
      frameTimer = null;
    }
  }
  releaseTimer = setTimeout(async () => {
    releaseTimer = null;
    try {
      // Stand down when a destination screen already applied its own frame
      // between the release and now (player -> details re-asserts on focus):
      // the idle exists to blank a dead WATCHING card, never to clobber a
      // live browsing one. `lastSent` is null right after an idle — a second
      // release then re-blanks, which is harmless and idempotent.
      if (lastSent && lastSent.kind !== 'watch') return;
      if (!(await isPresenceEnabled())) return;
      const token = await getDiscordToken();
      if (!token) return;
      // Through the frame pipeline (see the idle branch for why): the seq
      // bump is what disarms detached watch-frame artwork uploads.
      scheduleFrame({ kind: 'idle' });
    } catch {
      /* ignore */
    }
  }, 600);
}

export async function clearPresence(closeSocket = false): Promise<void> {
  cancelPendingRelease();
  // Drop any frame still queued: it would re-assert what we are clearing.
  pendingFrame = null;
  if (frameTimer) {
    clearTimeout(frameTimer);
    frameTimer = null;
  }
  lastSent = null;
  // Default: blank the activity but KEEP the connection. The app holds exactly
  // one connection for its whole session and only ever changes what that one
  // shows — including showing nothing. Dropping the socket here and rebuilding
  // it on the next screen is what produced duplicate cards.
  if (closeSocket) gatewayStop();
  else gatewayRest();
  // Custom status text is no longer set (see module header); nothing to clear.
}

export { gatewayStatus };
export type { GatewayStatus };
