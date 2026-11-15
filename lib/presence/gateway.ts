// Gateway transport: runs inside a hidden WebView (real Chromium socket
// stack) because React Native's raw WebSocket kept dropping (1006) on
// mobile networks. Same API as before — discord.ts/modal are untouched.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { readSetting } from '@/lib/settings/store';
import { ACTIVITY_TYPE, APP_NAME } from './config';

export interface PresenceActivity {
  name: string;
  type: number;
  details?: string;
  state?: string;
  startTimestamp?: number;
  endTimestamp?: number;
  applicationId?: string;
  largeImage?: string;
  largeText?: string;
  smallImage?: string;
  smallText?: string;
  buttons?: Array<{ label: string; url: string }>;
  /** Throttle identity ONLY — semantic, not the rendered text. Never sent to
   * Discord. Distinguishes "different screen" (send fast) from "same screen,
   * churning" (coalesce), which `name|details` could not do. */
  sig?: string;
  /** How urgently this frame should reach Discord. Never sent to Discord.
   * Caller-declared: only the app knows whether a change is a navigation the
   * user is waiting to see or a play/pause flip that may not settle. */
  tier?: keyof typeof OP3_GAPS;
  /** Discord presence status: 'online' | 'idle' | 'dnd' | 'invisible'. Sent
   * as the top-level `status` of the OP3 payload. Defaults to 'online'. */
  status?: string;
}

export interface GatewayStatus {
  connected: boolean;
  ready: boolean;
  lastCode: number | null;
  lastError: string | null;
  phase: string;
  lastStatus: string | null;
}

interface Desired {
  token: string;
  activity: PresenceActivity;
}

let desired: Desired | null = null;
let pushImpl: ((msg: string) => void) | null = null;
let bridgeReady = false;
let outbox: string[] = [];

/** The live Discord session id/seq last reported by the hidden page. Held here
 * so a re-created page can RESUME the same session instead of IDENTIFYing a new
 * one (see `_onGatewayEvent`). Deliberately NOT cleared on stop: resuming the
 * same session is always preferable to standing up a second one. */
let lastSession: { id: string; seq: number | null } | null = null;

// Persisted across app restarts. Android can kill the whole app while a session
// is live, and Discord keeps that session resumable for MINUTES afterwards —
// a restarted app that IDENTIFYs instead puts a SECOND session (and so a
// second activity card) on the account until the old one times out. The
// snapshot is only a session id + sequence; on its own it grants nothing, the
// token is still required to resume.
const SESSION_KEY = 'miori_gateway_session';

void (async () => {
  try {
    const raw = await AsyncStorage.getItem(SESSION_KEY);
    if (!raw || lastSession) return;
    const s = JSON.parse(raw) as { id?: string; seq?: number | null };
    if (s?.id) lastSession = { id: s.id, seq: typeof s.seq === 'number' ? s.seq : null };
  } catch {
    /* no snapshot, or unreadable — just identify */
  }
})();

/** The `start` frame, carrying the remembered session so a freshly (re)loaded
 * page can resume rather than identify. The page ignores it when it still has
 * its own session, so a live page is never overwritten by a stale copy. */
function startMessage(token: string, activity: PresenceActivity): object {
  return {
    t: 'start',
    token,
    activity,
    ...(lastSession ? { sessionId: lastSession.id, seq: lastSession.seq } : {}),
  };
}

function drain() {
  if (!pushImpl || !bridgeReady || !outbox.length) return;
  // Every queued message is full state — only the newest matters.
  // Sending one also keeps the OP3 floor honest.
  const last = outbox[outbox.length - 1];
  outbox = [];
  try {
    const parsed = JSON.parse(last) as { t?: string; activity?: PresenceActivity };
    if (parsed.t === 'presence' || parsed.t === 'start') {
      lastOp3At = Date.now();
      if (!overBudget()) sent.push(lastOp3At);
    }
    pushImpl(last);
  } catch {
    /* ignore */
  }
}

// Full-state messages: only the newest one is ever worth keeping.
const FULL_STATE = ['start', 'presence', 'resume'];

function push(msg: object) {
  const s = JSON.stringify(msg);
  if (!pushImpl || !bridgeReady) {
    // Hidden page not up yet — queue it (latest full-state message wins).
    const t = (msg as any).t;
    if (FULL_STATE.includes(t)) {
      outbox = outbox.filter((m) => {
        try {
          return !FULL_STATE.includes(JSON.parse(m).t);
        } catch {
          return true;
        }
      });
    }
    outbox.push(s);
    if (outbox.length > 20) outbox = outbox.slice(-20);
    return;
  }
  try {
    pushImpl(s);
  } catch {
    /* ignore */
  }
}
let status: GatewayStatus = {
  connected: false,
  ready: false,
  lastCode: null,
  lastError: null,
  phase: 'idle',
  lastStatus: null,
};

const statusListeners = new Set<(s: GatewayStatus) => void>();
export function subscribeGatewayStatus(fn: (s: GatewayStatus) => void): () => void {
  statusListeners.add(fn);
  // Immediate snapshot so the UI doesn't wait for the next change.
  fn({ ...status });
  return () => statusListeners.delete(fn);
}
function notifyStatus() {
  const snap = { ...status };
  for (const l of statusListeners) l(snap);
}

// OP3 pacing. Two things matter and they were previously conflated:
//
//  1. Tiering. A genuine screen change (browsing -> watching an episode) must
//     land fast. Play/pause/seek churn on the SAME episode need not — HLS
//     buffer flaps on mobile make `playingChange` fire in bursts, and each one
//     used to cost a gateway frame.
//  2. A hard ceiling. Tiers alone don't bound the worst case, so there's an
//     absolute rolling-window cap on top. Discord throttles presence spam and
//     a throttled gateway session shows the account as offline — the exact
//     symptom we were chasing. Stay well under it.
//
// Three explicit tiers, declared by the caller rather than inferred from the
// text — the old key was `name|details`, which collided: browsing a detail
// page and watching episode 1 of it both hash to "DanMachi|Danmachi", so the
// transition we most needed to be fast was classified as churn.
//
//  screen  a real navigation change (~0.7s). Never delay these — a blanket
//          delay here is exactly what made the old build look dead.
//  settle  play/pause flipping. Wait for the state to come to rest before
//          telling anyone: buffer flapping and button-mashing both resolve to
//          their final state, and never reach Discord at all.
//  churn   same screen, same state — seeks, position ticks. Nothing changed,
//          so nothing is worth sending.
const OP3_GAPS = { screen: 700, settle: 2000, churn: 15000 } as const;
const WINDOW_MS = 60000;
const MAX_PER_WINDOW = 20; // absolute ceiling, keep well under Discord's

let lastOp3At = 0;
let op3Timer: ReturnType<typeof setTimeout> | null = null;
let op3Pending: { activity: PresenceActivity; sig: string } | null = null;
const sent: number[] = [];

function overBudget(): boolean {
  const cutoff = Date.now() - WINDOW_MS;
  while (sent.length && sent[0] < cutoff) sent.shift();
  return sent.length >= MAX_PER_WINDOW;
}

function emit(activity: PresenceActivity, sig: string) {
  if (!desired) return;
  // Budget spent. Defer to the moment the oldest frame leaves the window
  // rather than dropping it — a burst that ends while capped would otherwise
  // leave Discord showing stale state, and `desired` keeps the newest value
  // so whatever arrives next supersedes this.
  if (overBudget()) {
    const oldest = sent[0] ?? Date.now();
    const wait = Math.max(1000, oldest + WINDOW_MS - Date.now() + 50);
    op3Pending = { activity, sig };
    if (op3Timer) clearTimeout(op3Timer);
    op3Timer = setTimeout(() => {
      op3Timer = null;
      const p = op3Pending;
      op3Pending = null;
      if (p) emit(p.activity, p.sig);
    }, wait);
    return;
  }
  sent.push(Date.now());
  lastOp3At = Date.now();
  // Always a full 'start': the page needs the token when the socket is not up
  // yet, and it opens the socket itself when it is. Carries the remembered
  // session so a re-created page re-attaches instead of identifying.
  push(startMessage(desired.token, activity));
}

function scheduleOp3(activity: PresenceActivity, sig: string, gap: number) {
  op3Pending = { activity, sig };
  if (op3Timer) clearTimeout(op3Timer);
  op3Timer = setTimeout(() => {
    op3Timer = null;
    const p = op3Pending;
    op3Pending = null;
    if (p) emit(p.activity, p.sig);
  }, gap);
}

export function gatewayStatus(): GatewayStatus {
  return { ...status };
}

// ---- Display layer -------------------------------------------------------
// The accounts screen renders this state verbatim; raw phase names ("idle",
// "ready → closed") are transport internals, not user-facing words. These two
// helpers are the single source of truth for what the Gateway row shows, so
// the battery can pin the copy without mounting React.

export type GatewayTone = 'off' | 'connecting' | 'ready';

/** Friendly one-liner for the row's hint. Covers every phase the transport
 * can emit, including the `"<best> → closed"` format `_onGatewayEvent` writes. */
export function gatewayHint(s: GatewayStatus): string {
  let state: string;
  if (s.phase === 'closed' || s.phase.endsWith(' → closed')) {
    state = s.lastCode != null ? `Disconnected (code ${s.lastCode})` : 'Disconnected';
  } else if (s.phase === 'ready') {
    state = 'Connected';
  } else if (s.phase === 'socket-open' || s.phase === 'hello' || s.phase === 'identified' || s.phase === 'resuming') {
    // 'identified' = IDENTIFY sent, READY dispatch not yet received. 'resuming'
    // = RESUME sent, RESUMED not yet received. Either way the handshake is in
    // flight and the transport's `ready` flag is still false, so the badge stays
    // "Connecting" and the hint must not claim "Connected" ahead of it.
    state = 'Authenticating…';
  } else if (s.phase === 'connecting') {
    state = 'Connecting…';
  } else {
    // 'idle' — off unless a presence frame is queued (start fires before the
    // socket reports 'connecting', and the old row showed a bare "Off" there).
    state = s.lastStatus ? 'Connecting…' : 'Off';
  }
  const sending = s.lastStatus ? ` · sending: ${friendlyStatus(s.lastStatus)}` : '';
  const err = s.lastError ? ` · ${s.lastError}` : '';
  return state + sending + err;
}

/** Short badge word + color tone for the row's right-hand label. */
export function gatewayBadge(s: GatewayStatus): { label: string; tone: GatewayTone } {
  if (s.ready) return { label: 'Ready', tone: 'ready' };
  const connecting =
    s.phase === 'connecting' || s.phase === 'socket-open' || s.phase === 'hello' || s.phase === 'identified' ||
    s.phase === 'resuming' ||
    (s.phase === 'idle' && !!s.lastStatus);
  return connecting ? { label: 'Connecting', tone: 'connecting' } : { label: 'Off', tone: 'off' };
}

function friendlyStatus(raw: string): string {
  return raw === 'auto (no status sent)' ? 'auto' : raw;
}

/** The hidden page is (re)mounting: injected JS would be dropped, so pushes
 * queue again until it reports wv-ready. */
export function _bridgePending() {
  bridgeReady = false;
}

/** Called by the hidden view host on mount/unmount. Flushes pending state. */
export function _registerPush(fn: ((msg: string) => void) | null) {
  pushImpl = fn;
  bridgeReady = false;
  if (!fn) {
    outbox = [];
    return;
  }
  // Wait for the page's wv-ready before sending (injects get dropped before).
}

/** Events from the hidden view: {kind:'phase',...}, {kind:'session',...} or
 * {kind:'wv-ready'}. */
export function _onGatewayEvent(ev: {
  kind: string;
  phase?: string;
  code?: number | null;
  error?: string;
  sessionId?: string;
  seq?: number | null;
}) {
  if (ev.kind === 'wv-ready') {
    bridgeReady = true;
    if (desired && pushImpl) {
      try {
        pushImpl(JSON.stringify(startMessage(desired.token, desired.activity)));
      } catch {
        /* ignore */
      }
    }
    drain();
    return;
  }
  if (ev.kind === 'session') {
    // The page's live Discord session identity, remembered OUTSIDE the page.
    // Android can kill the WebView renderer (in-memory copy is enough) or the
    // whole app (the persisted copy is what survives). Either way a fresh page
    // must RESUME this session rather than IDENTIFY a second one, which is what
    // shows the account two activity cards at once.
    if (ev.sessionId) {
      lastSession = { id: ev.sessionId, seq: typeof ev.seq === 'number' ? ev.seq : null };
      void AsyncStorage.setItem(SESSION_KEY, JSON.stringify(lastSession)).catch(() => {});
    }
    return;
  }
  if (ev.kind === 'phase' && ev.phase) {
    const p = ev.phase;
    const max = status.phase.split(' → ')[0];
    const order = ['idle', 'connecting', 'socket-open', 'hello', 'identified', 'resuming', 'ready'];
    const best = Math.max(order.indexOf(max), order.indexOf(p)) >= 0
      ? order[Math.max(order.indexOf(max), order.indexOf(p))]
      : p;
    status = {
      ...status,
      phase: p === 'closed' ? `${best} → closed` : p,
      connected: p === 'closed' ? false : p === 'ready' || p === 'identified' || p === 'hello' || p === 'socket-open',
      ready: p === 'ready' ? true : p === 'closed' ? false : status.ready,
      lastCode: ev.code ?? (p === 'closed' ? status.lastCode : null),
      lastError: ev.error ?? null,
    };
    notifyStatus();
  }
}

export function gatewayStart(token: string, activity: PresenceActivity) {
  desired = { token, activity };
  status.lastStatus = activity.status ? activity.status : 'auto (no status sent)';
  notifyStatus();
  const gap = OP3_GAPS[activity.tier ?? 'screen'];
  scheduleOp3(activity, activity.sig ?? '', Math.max(0, gap - (Date.now() - lastOp3At)));
}

export function gatewayUpdate(token: string, activity: PresenceActivity) {
  gatewayStart(token, activity);
}

/** App came back to the foreground: the socket usually died while we were
 * backgrounded, so tell the hidden page to re-open and re-identify. */
export function gatewayResume() {
  push({ t: 'resume' });
}

/** App is going to the background. Drop the activity but keep the connection,
 * so a frozen-then-killed page can't leave a stale card on the account. */
export function gatewayRest() {
  push({ t: 'rest' });
}

/** Credentials just became available (login finished, presence toggled on).
 * Re-assert whatever we last wanted to show — the page may have been sitting
 * closed, and without this the socket only opens on the next screen change. */
export function gatewayAttach(token: string) {
  if (desired && desired.token !== token) desired = null;
  if (desired) gatewayStart(token, desired.activity);
  else {
    gatewayStart(token, {
      name: APP_NAME,
      type: ACTIVITY_TYPE,
      details: 'Browsing Miori',
      state: 'Exploring anime',
      startTimestamp: Date.now(),
      status: readSetting('presence.status') === 'auto' ? undefined : readSetting('presence.status'),
      tier: 'screen',
    });
  }
}

export function gatewayStop() {
  desired = null;
  if (op3Timer) clearTimeout(op3Timer);
  op3Timer = null;
  op3Pending = null;
  // A stop resets the pacing state: whatever comes next is a fresh start, and
  // it gets a clean rate-limit budget.
  lastOp3At = 0;
  sent.length = 0;
  // NB: bridgeReady stays as-is. Forcing it false here poisoned the outbox —
  // the page is still mounted, so the next start would sit in the queue until
  // a wv-ready that never comes, and presence would look permanently dead.
  // Stop goes direct (never queued) — the view may be gone already.
  try {
    pushImpl?.(JSON.stringify({ t: 'stop' }));
  } catch {
    /* ignore */
  }
  status = { connected: false, ready: false, lastCode: null, lastError: null, phase: 'idle', lastStatus: null };
  notifyStatus();
}

/** Apply a new Discord status without rebuilding the whole activity. Re-asserts
 *  the current frame with the updated status so the change lands immediately.
 *  The re-assert is a REAL user action (the selector was tapped), so it goes
 *  out at 'screen' pace — reusing the frame's stale tier would let a 'churn'
 *  position tick hold the status change for 15 seconds. */
export function gatewaySetStatus(newStatus: string) {
  if (!desired) return;
  desired.activity.status = newStatus === 'auto' ? undefined : newStatus;
  desired.activity.tier = 'screen';
  status.lastStatus = newStatus === 'auto' ? 'auto (no status sent)' : newStatus;
  notifyStatus();
  gatewayStart(desired.token, desired.activity);
}
