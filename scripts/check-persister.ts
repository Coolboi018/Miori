/**
 * Per-user data must not survive on disk, and a wipe must actually wipe.
 *
 * Two things are pinned here, and the second one is the reason the first needed
 * a test at all.
 *
 *   1. `listEntry` and `viewer` are scrubbed before restore. `qk.listEntry(id)` is
 *      keyed on the media id ALONE, and `ListEntry` carries the user's free-text
 *      `notes`, `score` and `priority` — so restoring it would serve the previous
 *      account's private writing to whoever opened the app next.
 *
 *   2. `removePersistedCache` waits for an in-flight write BEFORE removing the
 *      key. It used to do the opposite, while its own comment claimed this order,
 *      which meant a `setItem` already on the wire landed on top of the
 *      `removeItem` and put the whole cache back. `completeSignOut` now depends on
 *      this function actually wiping, so the ordering is load-bearing rather than
 *      tidy — and "the cache came back" is exactly the kind of failure that reads
 *      as working, because the store is there afterwards either way.
 *
 * `home` is asserted to be KEPT. Its key already contains the user id, so another
 * account can never be served a previous account's entry — and dropping it would
 * throw away the instant cold start that is the whole reason the persister exists.
 *
 * AsyncStorage is stubbed through the CommonJS module cache (it cannot load
 * outside a native runtime) with a controllable write delay, so the race can be
 * produced rather than waited for.
 *
 * Run with:  npx tsx scripts/check-persister.ts
 */

/**
 * Declared locally: this project does not put `@types/node` in `types`, and the
 * other scripts are pure-DOM. `package.json` has no `"type": "module"`, so tsx
 * emits CommonJS and this is the real `require`.
 */
type NodeRequire = {
  resolve(id: string): string;
  cache: Record<string, unknown>;
};
declare const require: NodeRequire;

type Store = Record<string, string>;

const disk: Store = {};
/** How long the next `setItem` takes, so an in-flight write can be raced. */
let setDelay = 0;
/** Every write that actually reached the store, in order. */
let writes: string[] = [];

function installStub() {
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

  stub('@react-native-async-storage/async-storage', {
    getItem: async (k: string) => disk[k] ?? null,
    setItem: async (k: string, v: string) => {
      if (setDelay) await new Promise((r) => setTimeout(r, setDelay));
      disk[k] = v;
      writes.push(k);
    },
    removeItem: async (k: string) => {
      delete disk[k];
    },
    getAllKeys: async () => Object.keys(disk),
    multiGet: async (keys: string[]) => keys.map((k) => [k, disk[k] ?? null] as const),
    multiRemove: async (keys: string[]) => {
      for (const k of keys) delete disk[k];
    },
  });
}

let failures = 0;
function check(name: string, pass: boolean, detail = '') {
  if (pass) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** A serialised client with one query per key given. */
function stateWith(...keys: unknown[][]): unknown {
  return {
    clientState: {
      queries: keys.map((queryKey) => ({ queryKey, state: { data: { secret: 'notes' } } })),
    },
  };
}

function restoredKeys(state: unknown): string[] {
  const restored = state as { clientState?: { queries?: { queryKey: unknown[] }[] } };
  return (restored.clientState?.queries ?? []).map((q) => String(q.queryKey[0]));
}

const CACHE_KEY = 'miori:cache';

async function main() {
  installStub();
  const p = (await import('../lib/query/persister')) as typeof import('../lib/query/persister');

  console.log('\npersisted cache, per-user data');

  // --- 1. the scrub, on the real restore path ----------------------------
  {
    // Write a cache by hand and read it back through the scrubbed persister.
    disk[CACHE_KEY] = JSON.stringify({
      v: p.CACHE_VERSION,
      at: Date.now(),
      client: stateWith(
        ['search', 'cowboy bebop', 1],
        ['characterFavourite', 42],
        ['listEntry', 20920],
        ['viewer'],
        ['home', 'anon', '00'],
        ['media', 20920],
        ['schedule', 'day', 1700000000]
      ),
    });

    const restored = await p.persister.restoreClient();
    const keys = restoredKeys(restored);

    check('listEntry is not restored', !keys.includes('listEntry'), keys.join(', '));
    check('viewer is not restored', !keys.includes('viewer'), keys.join(', '));
    check('search is still not restored', !keys.includes('search'), keys.join(', '));
    check(
      'characterFavourite is still not restored',
      !keys.includes('characterFavourite'),
      keys.join(', ')
    );

    // The cold-start win must survive the fix.
    check(
      'home IS restored — scrubbing it would cost the instant cold start',
      keys.includes('home'),
      keys.join(', ')
    );
    check('media is restored', keys.includes('media'), keys.join(', '));
    check('schedule is restored', keys.includes('schedule'), keys.join(', '));
    check(
      'exactly the four scrubbed keys are gone',
      keys.length === 3,
      `${keys.length} survived: ${keys.join(', ')}`
    );
  }

  // --- 2. the wipe, raced against an in-flight write ----------------------
  // A `setItem` already on the wire resolves AFTER whatever we do next. Wiping
  // first and waiting second therefore restores the cache — and the store is
  // present afterwards either way, so only this assertion can tell.
  {
    setDelay = 250;
    writes = [];
    p.cachePersister.persistClient({
      clientState: { queries: [{ queryKey: ['listEntry', 20920], state: {} }] },
    } as never);
    // Take the debounce out of the picture so the write is genuinely in flight.
    p.flushPersistedCache();

    // Give the write a moment to start, then wipe while it is still running.
    await new Promise((r) => setTimeout(r, 50));
    await p.removePersistedCache();

    check(
      'a wipe during an in-flight write leaves nothing behind',
      disk[CACHE_KEY] === undefined,
      disk[CACHE_KEY] ? 'the cache came back' : ''
    );
    setDelay = 0;
  }

  // --- 3. and a plain wipe still works ------------------------------------
  {
    disk[CACHE_KEY] = JSON.stringify({
      v: p.CACHE_VERSION,
      at: Date.now(),
      client: stateWith(['media', 1]),
    });
    await p.removePersistedCache();
    check('an idle wipe removes the store', disk[CACHE_KEY] === undefined);
  }

  // --- 4. a stale version is discarded, not restored ----------------------
  {
    disk[CACHE_KEY] = JSON.stringify({
      v: p.CACHE_VERSION - 1,
      at: Date.now(),
      client: stateWith(['listEntry', 20920], ['viewer']),
    });
    const restored = await p.persister.restoreClient();
    check(
      'a cache from an older version is discarded outright',
      restored == null,
      restored ? 'it was restored' : ''
    );
  }

  console.log(failures ? `\n${failures} failed\n` : '\nall passed\n');
  process.exit(failures ? 1 : 0);
}

void main();