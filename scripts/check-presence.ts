/**
 * The presence frame pipeline must survive the player's exit.
 *
 * Two device-reported failures of 10 Nov, both invisible in normal use (the
 * card on screen did exactly what the code was told):
 *
 * 1. PLAYER -> DETAILS LANDED THE WATCHING CARD BACK ON TOP. The player's
 *    release applied its blank "Browsing Miori" card through a RAW
 *    gatewayStart 600ms after unmount. Two things followed: a browsing frame
 *    the destination screen had already scheduled (focus fires at pop-
 *    transition START, unmount at its END) was clobbered by the raw idle; and
 *    an artwork upload detached from the last watch frame resolved whenever it
 *    liked, passed its own `seq !== frameSeq` check (the raw idle never bumped
 *    `frameSeq`), and re-asserted the full WATCHING card over the details
 *    page's correct one.
 *
 * 2. (covered by the same battery, scenario 3) a watch frame queued from just
 *    before unmount must not outlive its screen.
 *
 * The fix routes the idle through the ordinary frame pipeline (an applied
 * frame bumps `frameSeq`, disarming detached uploads), stands the release
 * down when the destination already asserted (`lastSent` not watch), and
 * spares a queued BROWSE frame from the drop.
 *
 * A third report (15 Nov): "every screen change removes the RPC and adds it
 * back". Nothing on the wire clears — the card was being RE-CREATED because
 * its identity moved (browsing sent type 0/'Miori', every other screen type 3
 * with its own title as the name, and a fresh start timestamp per frame). The
 * last scenario pins the identity and the browsing clock as constant.
 *
 * Run with:  npx tsx scripts/check-presence.ts
 */

type NodeRequire = {
  resolve(id: string): string;
  cache: Record<string, unknown>;
};
declare const require: NodeRequire;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Stubs. The module under test imports five neighbours; four are faked here.
// The AsyncStorage stub shape is FLAT (functions at top level) — see
// check-signout.ts for the live-observed interop trap.
// ---------------------------------------------------------------------------

const KEYCHAIN = new Map<string, string>();
const memStore = new Map<string, string>();

function installStubs() {
  const stub = (id: string, exports: unknown) => {
    const path = require.resolve(id);
    require.cache[path] = {
      id: path,
      filename: path,
      path,
      exports,
      loaded: true,
      children: [],
      paths: [],
    };
  };

  stub('expo-secure-store', {
    getItemAsync: async (k: string) => KEYCHAIN.get(k) ?? null,
    setItemAsync: async (k: string, v: string) => void KEYCHAIN.set(k, v),
    deleteItemAsync: async (k: string) => void KEYCHAIN.delete(k),
  });
  stub('@react-native-async-storage/async-storage', {
    getItem: async (k: string) => memStore.get(k) ?? null,
    setItem: async (k: string, v: string) => void memStore.set(k, v),
  });

  // The gateway capture. One object for the whole run; `reset()` between
  // scenarios so a fresh `discord` module still reports into THIS capture.
  const sent: Array<{ token: string; activity: Record<string, unknown> }> = [];
  (globalThis as Record<string, unknown>).__presenceCapture = sent;
  stub('../lib/presence/gateway', {
    gatewayStart: (token: string, activity: Record<string, unknown>) => {
      sent.push({ token, activity });
    },
    gatewayRest: () => {},
    gatewayStop: () => {},
    gatewayStatus: () => ({ connected: true, ready: true, lastCode: null, lastError: null, phase: 'ready' }),
  });

  // Artwork upload: script-controlled delay and image, so a detached upgrade
  // can be made to resolve AFTER the idle card (the re-assertion window).
  let artDelay = 0;
  let artImage: string | null = null;
  (globalThis as Record<string, unknown>).__presenceArt = {
    set(delayMs: number, image: string | null) {
      artDelay = delayMs;
      artImage = image;
    },
  };
  stub('../lib/presence/art', {
    resolveArt: async () => {
      if (artDelay > 0) await sleep(artDelay);
      return artImage;
    },
  });

  // The status-text PATCH (idle clears the text, frames set it).
  const okResponse = { status: 200, ok: true, headers: { get: () => null } };
  globalThis.fetch = (async () => okResponse) as unknown as typeof fetch;
}

function capture(): Array<{ token: string; activity: Record<string, unknown> }> {
  return (globalThis as Record<string, unknown>).__presenceCapture as Array<{
    token: string;
    activity: Record<string, unknown>;
  }>;
}

async function freshPresence(): Promise<typeof import('../lib/presence/discord')> {
  delete require.cache[require.resolve('../lib/presence/discord')];
  return import('../lib/presence/discord');
}

// ---------------------------------------------------------------------------
// Battery
// ---------------------------------------------------------------------------

let failures = 0;
function check(name: string, pass: boolean, detail = '') {
  if (pass) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function lastDetail(): string {
  const s = capture();
  return String(s[s.length - 1]?.activity?.details ?? '<nothing sent>');
}

function detailsAfter(predicate: (a: Record<string, unknown>) => boolean): number {
  return capture().filter((s) => predicate(s.activity)).length;
}

async function main() {
  installStubs();

  console.log('\nrelease stand-down (player -> details)');
  {
    capture().length = 0;
    const presence = await freshPresence();
    await presence.setPresenceEnabled(true);
    await presence.saveDiscordToken('a-token-from-the-webview-login');
    // A watch frame, applied.
    await presence.updatePresence('Watched Show', 1, { artKey: 'a1', artUrl: '', pageUrl: 'u1' });
    await sleep(450);
    check('the watch card applied', lastDetail() === 'Watched Show', lastDetail());
    // The details page asserts on focus (fires before the player's unmount).
    await presence.updateBrowsing('Detail Page', { artKey: 'a1', artUrl: '', pageUrl: 'u1' });
    await sleep(450);
    check('the details card applied', lastDetail() === 'Detail Page', lastDetail());
    // The player unmounts AFTER all of that (pop animation end).
    presence.releasePresence();
    await sleep(1200);
    check(
      'the release stands down instead of clobbering the destination card',
      lastDetail() === 'Detail Page',
      `last card is "${lastDetail()}" — the idle clobbered the details page`
    );
  }

  console.log('\nidle through the pipeline disarms detached art');
  {
    capture().length = 0;
    const presence = await freshPresence();
    const art = (globalThis as Record<string, unknown>).__presenceArt as {
      set(delayMs: number, image: string | null): void;
    };
    // Art resolves well after the idle lands — exactly the window the raw
    // idle used to lose.
    art.set(1500, 'https://uploads.discord/anime-art');
    await presence.updatePresence('Art Show', 2, { artKey: 'a2', artUrl: 'https://poster', pageUrl: 'u2' });
    await sleep(450); // watch frame applied; its art upload is now detached
    check('the watch card applied before the release', lastDetail() === 'Art Show', lastDetail());
    presence.releasePresence();
    await sleep(1400); // idle lands ~1250ms after the release
    const idleCount = detailsAfter((a) => a.details === 'Browsing Miori');
    check('the idle blank card applied', idleCount >= 1, 'no idle card was sent');
    await sleep(900); // art resolves at ~1500ms after detach — AFTER the idle
    check(
      'the late artwork upgrade did not resurrect the watching card',
      lastDetail() === 'Browsing Miori' && detailsAfter((a) => a.details === 'Art Show') === 1,
      `last card is "${lastDetail()}" — a detached upload re-asserted the episode`
    );
  }

  console.log('\nqueued frames vs the release');
  {
    capture().length = 0;
    const presence = await freshPresence();
    // A watch frame scheduled and released inside the same coalesce window.
    await presence.updatePresence('Queued Show', 3, { artKey: 'a3', artUrl: '', pageUrl: 'u3' });
    presence.releasePresence();
    await sleep(1400);
    check(
      'a queued watch frame dies with its screen',
      detailsAfter((a) => a.details === 'Queued Show') === 0 && lastDetail() === 'Browsing Miori',
      `last card is "${lastDetail()}"`
    );

    // A browse frame queued when the release runs must SURVIVE it (the
    // destination screen owns presence) and no idle may follow.
    await presence.updateBrowsing('Surviving Page', { artKey: 'a4', artUrl: '', pageUrl: 'u4' });
    presence.releasePresence();
    await sleep(1400);
    check(
      'a queued browse frame survives the release',
      lastDetail() === 'Surviving Page',
      `last card is "${lastDetail()}" — the idle clobbered the queued browse frame`
    );
  }

  console.log('\nthe card identity never moves (one card, updated in place)');
  {
    capture().length = 0;
    const presence = await freshPresence();
    await presence.setPresenceEnabled(true);
    // Four different screens — home, two titled browsers, then the player.
    await presence.updateBrowsing();
    await sleep(450);
    await presence.updateBrowsing('Searching anime');
    await sleep(450);
    await presence.updateBrowsing('Airing schedule');
    await sleep(450);
    await presence.updatePresence('Watched Show', 1);
    await sleep(450);

    const cards = capture().map((c) => c.activity);
    check('every screen sent a frame', cards.length === 4, `sent ${cards.length}`);
    const identity = cards.map((a) => `${a.name}|${a.type}`);
    check(
      'one name+type across every screen — changing it re-creates the card',
      new Set(identity).size === 1,
      identity.join('  ')
    );
    // The browsing card is ONE continuing activity, so its start must not be
    // re-stamped per screen (a fresh start reads as a new activity to Discord).
    const browseStarts = cards.filter((a) => a.details !== 'Watched Show').map((a) => a.startTimestamp);
    check(
      'the browsing card keeps one start timestamp',
      new Set(browseStarts).size === 1,
      browseStarts.join('  ')
    );
  }

  console.log('\nthe rich-presence switch stays OFF (25 Nov)');
  {
    capture().length = 0;
    memStore.clear();
    KEYCHAIN.clear();
    const presence = await freshPresence();
    // A session that predates the switch: a saved token, no stored CHOICE.
    check(
      'no stored choice reads as null, not "off"',
      (await presence.readPresenceChoice()) === null
    );
    await presence.saveDiscordToken('tok');
    await presence.setPresenceEnabled(false);
    check(
      'an explicit OFF is a choice, not an absence',
      (await presence.readPresenceChoice()) === false
    );
    check('…and it reads as disabled', (await presence.isPresenceEnabled()) === false);
    /**
     * THE REGRESSION. `GatewayView`'s reader used to say
     * `if (!isPresenceEnabled()) setPresenceEnabled(true)` — and
     * `setPresenceEnabled` publishes a credential change, which re-ran that
     * very reader. Turning the switch off therefore turned it back on a tick
     * later, and every browsing frame kept flowing to Discord.
     */
    await presence.updateBrowsing('Should Not Appear');
    await presence.updatePresence('Should Not Appear', 1);
    await sleep(450);
    check(
      'no frame reaches the gateway while presence is off',
      capture().length === 0,
      `sent ${capture().length}`
    );
  }

  console.log('');
  if (failures) {
    console.log(`FAILED: ${failures} check(s)`);
    process.exit(1);
  }
  console.log('all passed');
}

void main();
