// Battery: the Accounts screen Gateway row's display layer.
// Drives lib/presence/gateway.ts through a realistic session and pins exactly
// what gatewayHint()/gatewayBadge() render at each step. This is the only
// diagnostic surface for the hidden WebView socket — it caught the R8 bug —
// so the copy must not regress into raw phase jargon (the "red Off while
// connecting" bug) or contradict the transport.
import {
  gatewayStart,
  gatewayStatus,
  gatewaySetStatus,
  gatewayStop,
  gatewayHint,
  gatewayBadge,
  _onGatewayEvent,
  _registerPush,
  subscribeGatewayStatus,
} from '../lib/presence/gateway';

subscribeGatewayStatus(() => {});
_registerPush(() => {});

let failures = 0;
function check(label: string, hint: string, badgeLabel: string, tone: string) {
  const s = gatewayStatus();
  const h = gatewayHint(s);
  const b = gatewayBadge(s);
  const pass = h === hint && b.label === badgeLabel && b.tone === tone;
  if (pass) console.log(`  ok   ${label}\n       hint: ${h} · badge: ${b.label} (${b.tone})`);
  else {
    failures++;
    console.log(
      `  FAIL ${label}\n       hint: ${h} (want "${hint}")\n       badge: ${b.label} (${b.tone}) (want "${badgeLabel}" / "${tone}")`
    );
  }
}

// 1. App start — nothing running.
check('0. app start', 'Off', 'Off', 'off');

// 2. Token attached (auto status) — frame queued, socket not up yet.
//    REGRESSION PIN: the old row showed a bare red "Off" here, which looked
//    broken while the connection was actually being established.
gatewayStart('tok', {
  name: 'Miori',
  type: 0,
  details: 'Browsing Miori',
  startTimestamp: Date.now(),
  status: undefined,
  tier: 'screen',
});
check('1. token attached (auto)', 'Connecting… · sending: auto', 'Connecting', 'connecting');

// 3. Socket phases.
_onGatewayEvent({ kind: 'phase', phase: 'connecting' });
check('2. connecting', 'Connecting… · sending: auto', 'Connecting', 'connecting');
_onGatewayEvent({ kind: 'phase', phase: 'socket-open' });
check('3. socket open', 'Authenticating… · sending: auto', 'Connecting', 'connecting');
_onGatewayEvent({ kind: 'phase', phase: 'hello' });
check('4. hello', 'Authenticating… · sending: auto', 'Connecting', 'connecting');
_onGatewayEvent({ kind: 'phase', phase: 'identified' });
check('5. identified', 'Authenticating… · sending: auto', 'Connecting', 'connecting');
_onGatewayEvent({ kind: 'phase', phase: 'ready' });
check('6. ready', 'Connected · sending: auto', 'Ready', 'ready');

// 4. Selector tap — status re-asserted.
gatewaySetStatus('dnd');
check('7. user picks DND', 'Connected · sending: dnd', 'Ready', 'ready');

// 5. Mobile network drops the socket.
_onGatewayEvent({ kind: 'phase', phase: 'closed', code: 1006, error: 'watchdog' });
check('8. dropped (1006)', 'Disconnected (code 1006) · sending: dnd · watchdog', 'Off', 'off');

// 6. Reconnect.
_onGatewayEvent({ kind: 'phase', phase: 'connecting' });
check('9. reconnecting', 'Connecting… · sending: dnd', 'Connecting', 'connecting');
_onGatewayEvent({ kind: 'phase', phase: 'hello' });
_onGatewayEvent({ kind: 'phase', phase: 'ready' });
check('10. reconnected', 'Connected · sending: dnd', 'Ready', 'ready');

// 6b. The reconnect that RESUMES the same session (the one-RPC path). Always
//     preceded by the 'closed' of the socket that dropped; the row must then
//     read as a handshake in flight, never the red "Off" the raw phase implies.
_onGatewayEvent({ kind: 'phase', phase: 'closed', code: 1006 });
_onGatewayEvent({ kind: 'phase', phase: 'connecting' });
_onGatewayEvent({ kind: 'phase', phase: 'hello' });
_onGatewayEvent({ kind: 'phase', phase: 'resuming' });
check('10b. resuming same session', 'Authenticating… · sending: dnd', 'Connecting', 'connecting');
_onGatewayEvent({ kind: 'phase', phase: 'ready' });
check('10c. resumed', 'Connected · sending: dnd', 'Ready', 'ready');

// 7. Presence off — full reset.
gatewayStop();
check('11. gatewayStop', 'Off', 'Off', 'off');

// --- one-session invariant --------------------------------------------------
// The hidden page reports its live Discord session; RN must remember it and
// hand it back to a page that RELOADS (Android kills the WebView renderer), so
// the new page RESUMEs that same session instead of IDENTIFYing a fresh one.
// A second IDENTIFY while Discord still holds the old session resumable is
// exactly what put TWO activity cards on the account at once.
function checkRaw(label: string, cond: boolean, detail = '') {
  if (cond) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const pushes: string[] = [];
_registerPush((m) => pushes.push(m));
gatewayStart('tok', { name: 'Miori', type: 0, details: 'Browsing Miori', startTimestamp: Date.now(), tier: 'screen' });
_onGatewayEvent({ kind: 'session', sessionId: 'sess-1', seq: 42 });
// A reloaded page announces itself; RN answers with the start frame synchronously.
_onGatewayEvent({ kind: 'wv-ready' });
const reloadStart = JSON.parse(pushes[pushes.length - 1] ?? '{}') as {
  t?: string;
  sessionId?: string;
  seq?: number;
};
checkRaw(
  'a reloaded page is handed the remembered session',
  reloadStart.t === 'start' && reloadStart.sessionId === 'sess-1' && reloadStart.seq === 42,
  JSON.stringify(reloadStart)
);

console.log(failures ? `\n${failures} failed\n` : '\nGateway viewer battery passed.\n');
process.exit(failures ? 1 : 0);
