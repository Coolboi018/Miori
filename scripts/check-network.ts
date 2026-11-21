// Pure checks for `lib/net/connectivity.ts`.
//
// The network layer is the new piece of the resilience work: offline must be
// a positive claim, unknown must never read as offline, and the store must not
// re-notify subscribers for a report that changes nothing. A regression in any
// of those is a cold-start spinner storm or a missed reconnect, so they get
// pinned here the same way the player-health rules are.
//
// Run with:  npx tsx scripts/check-network.ts

import {
  getNetworkSnapshot,
  isOffline,
  isOfflineError,
  isOnline,
  normalizeNetworkState,
  offlineError,
  setNetworkSnapshot,
  subscribeNetworkStatus,
} from '../lib/net/connectivity';

let failures = 0;
function check(name: string, pass: boolean, detail = '') {
  if (pass) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function main() {
  // --- normalize -------------------------------------------------------
  check(
    'isConnected false → offline',
    normalizeNetworkState({ isConnected: false }, 1).kind === 'offline'
  );
  check(
    'isInternetReachable false → offline (even when connected)',
    normalizeNetworkState({ isConnected: true, isInternetReachable: false }, 1).kind === 'offline'
  );
  check(
    'isInternetReachable true → online',
    normalizeNetworkState({ isConnected: true, isInternetReachable: true }, 1).kind === 'online'
  );
  check(
    'connected, no reachability verdict → online (not offline)',
    normalizeNetworkState({ isConnected: true }, 1).kind === 'online'
  );
  check(
    'nothing reported → unknown (never offline)',
    normalizeNetworkState({}, 1).kind === 'unknown' && normalizeNetworkState(null, 1).kind === 'unknown'
  );

  // --- isOffline / isOnline -------------------------------------------
  check(
    'isOffline on unknown is false',
    !isOffline(normalizeNetworkState({}, 1))
  );
  check(
    'isOnline on offline is false',
    !isOnline(normalizeNetworkState({ isConnected: false }, 1))
  );

  // --- offlineError ----------------------------------------------------
  const e = offlineError('no signal');
  check('offlineError is tagged', e.offline === true && isOfflineError(e));
  check(
    'a plain Error is not an offline error',
    !isOfflineError(new Error('boom'))
  );

  // --- store identity / notification -----------------------------------
  setNetworkSnapshot(normalizeNetworkState({}, 10));
  const before = getNetworkSnapshot();
  setNetworkSnapshot(normalizeNetworkState({}, 20)); // same fields, different at
  check('identical fields keep identity', getNetworkSnapshot() === before);

  let notified = 0;
  const unsub = subscribeNetworkStatus(() => {
    notified++;
  });
  setNetworkSnapshot(normalizeNetworkState({ isConnected: false }, 30));
  check('a real change notifies subscribers', notified === 1);
  check('kind flipped to offline', getNetworkSnapshot().kind === 'offline');
  // Same offline report must not re-notify.
  setNetworkSnapshot(normalizeNetworkState({ isConnected: false }, 40));
  check('a repeat offline report does not re-notify', notified === 1);
  unsub();

  console.log(failures ? `\n${failures} failed\n` : '\nall passed\n');
  process.exit(failures ? 1 : 0);
}

void main();
