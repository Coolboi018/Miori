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

// 7. Presence off — full reset.
gatewayStop();
check('11. gatewayStop', 'Off', 'Off', 'off');

console.log(failures ? `\n${failures} failed\n` : '\nGateway viewer battery passed.\n');
process.exit(failures ? 1 : 0);
