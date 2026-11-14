// The disk cache behind every screen.
//
// WHY THIS EXISTS. Every data module in this app caches in a module-level
// `Map`, which is fast and correct and completely invisible to the next launch.
// The consequence was the app's defining flaw: cold start, empty maps, so each
// tab blocked its first paint on a network round-trip behind a spinner. Web hid
// it — the browser had the modules warm and mounting DOM is cheap — and on a
// phone it was a second of nothing on every tab, every launch.
//
// So the cache becomes durable. TanStack Query already does the hard parts —
// stale-while-revalidate, global de-duplication, garbage collection, keeping the
// previous page visible while the next one loads — and this file supplies the
// one thing it does not do by itself: put the cache on disk, and get it back
// before the first screen renders.
//
// WHY ASYNCSTORAGE AND NOT MMKV. The obvious upgrade is a synchronous store so
// the cache can be read during render. It is not needed, because hydration is
// awaited BEFORE the app paints rather than raced against it — the splash screen
// is up for the ~5ms it takes to read one JSON blob, and then the first render
// already has yesterday's home rails. Blocking on a 5ms read is free; blocking
// on a 400ms request is what the user was complaining about. AsyncStorage also
// means the web preview and Expo Go both work, so the cache can be exercised
// without a native rebuild. Swapping in MMKV later is a change to this file
// alone; nothing above it knows where the bytes live.
//
// THE VERSION STAMP IS NOT OPTIONAL. A persisted cache outlives the code that
// wrote it. Bump `CACHE_VERSION` whenever a query's shape changes and the whole
// store is discarded rather than handed to a screen that expects fields which
// are no longer there — a wrong-shaped cache is worse than no cache, because it
// renders before anything can correct it.

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { PersistedClient, Persister } from '@tanstack/react-query-persist-client';

/**
 * Bump on any change to a query's `queryFn` output shape, to a key's meaning,
 * or to the persister's own envelope. This is the invalidation lever for a
 * format the app can still be running.
 *
 * 2 — `MediaDetail.characters[]` gained a required `id` (the character info
 *     sheet's query key). A cache written by v1 holds cast entries with no `id`,
 *     and the sheet's hook is gated on `id > 0`, so restored v1 cast data left it
 *     disabled and permanently pending — a sheet that opened and never loaded.
 *     The version stamp is the whole fix; nothing reads `id` defensively because a
 *     cast entry without one is not a shape this app produces.
 *
 * 3 — `isFavourite` was briefly added to the PUBLIC `CharacterDetail` /
 *     `MediaCharacter` / `CharacterWithVA` payloads, which put a per-user flag in
 *     something written to disk for seven days. Existing caches hold
 *     `isFavourite: false` for everything, so the Like button reported `Like` on
 *     characters that were already favourited on AniList. The field has moved back
 *     out to `qk.characterFavourite`, which is not persisted — but the v2 cache
 *     already on disk carries the wrong value and no key change can reach it, so
 *     this bump is what clears it.
 */
export const CACHE_VERSION = 3;

const STORAGE_KEY = 'miori:cache';

/**
 * Ceiling on the serialised cache, in bytes.
 *
 * A generous week of browsing is a couple of megabytes of JSON; this is set
 * well above that so trimming is a safety net against a pathological session
 * rather than routine housekeeping. AsyncStorage on Android is a SQLite table
 * and an unbounded blob in it is a slow launch for everyone.
 */
const MAX_CACHE_BYTES = 6 * 1024 * 1024;

/**
 * A thin envelope around the payload, so a version bump and a size check are
 * one `getItem` rather than a parse of the whole cache followed by a second
 * pass to find out whether it was even usable.
 */
interface Envelope {
  v: number;
  /** `Date.now()` at write time. Used for the size guard's sanity check. */
  at: number;
  /** TanStack's serialised client state. */
  client: unknown;
}

async function readEnvelope(): Promise<Envelope | null> {
  const raw = await AsyncStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  // The size guard runs on the STRING, before JSON.parse, so a runaway cache
  // costs one length check rather than the parse that would then be thrown away.
  if (raw.length > MAX_CACHE_BYTES) {
    await AsyncStorage.removeItem(STORAGE_KEY);
    return null;
  }
  try {
    const env = JSON.parse(raw) as Envelope;
    if (env?.v !== CACHE_VERSION) {
      await AsyncStorage.removeItem(STORAGE_KEY);
      return null;
    }
    return env;
  } catch {
    // A truncated write (killed mid-put, storage full) leaves invalid JSON.
    // Dropping it is the whole repair; there is nothing to salvage.
    await AsyncStorage.removeItem(STORAGE_KEY);
    return null;
  }
}

/**
 * THE WRITES ARE DEBOUNCED, and this is the single most valuable thing in the
 * file.
 *
 * `PersistQueryClientProvider` has no throttle of its own. Its subscription calls
 * `persistQueryClientSave` on EVERY cache event, with nothing in the chain to
 * coalesce them — and a "save" is not an append. It is `dehydrate` of the entire
 * client (every query, every response, the lot), then `JSON.stringify` of all of
 * that, then a `setItem` of the resulting megabytes into AsyncStorage, which on
 * Android is a SQLite row.
 *
 * So one response costs one FULL-CACHE REWRITE. Page through five pages of search
 * and that is five rewrites of the whole cache for five small deltas, each one on
 * the JS thread, each one on the main thread's storage queue.
 *
 * The fix is a trailing debounce, and it is safe precisely because a cache write
 * is IDEMPOTENT AND TOTAL: there is no such thing as a partial write to complete,
 * only the current state. Dropping four of five writes loses nothing at all,
 * because the fifth one contains all five results. `latest` is what makes it
 * correct — a queue would replay stale snapshots and write the OLDEST answer last.
 *
 * `flushPersistedCache` exists for the one moment dropping a write would actually
 * cost something: the app going to the background, where the process may not come
 * back. Everything else can wait 1.5 seconds without consequence.
 */
const WRITE_DEBOUNCE_MS = 1500;

let writeTimer: ReturnType<typeof setTimeout> | null = null;
/** The most recent snapshot handed to us. Only the newest is ever written. */
let pendingWrite: PersistedClient | null = null;
/** Whether a write is currently in flight, so flushes can wait for it. */
let writing: Promise<void> | null = null;

function writeNow(client: PersistedClient): Promise<void> {
  const envelope: Envelope = { v: CACHE_VERSION, at: Date.now(), client };
  writing = (async () => {
    try {
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(envelope));
    } catch {
      // Storage full or unavailable. A cache that cannot be written is a cache
      // that does not exist this launch, which the app already handles — it is
      // the state it ran in before this file existed. Never throw: failing to
      // write a cache must not take the app down with it.
    }
  })().finally(() => {
    writing = null;
  });
  return writing;
}

function cancelTimer(): void {
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
}

/**
 * Write the newest pending snapshot, now.
 *
 * Called when the app is about to be suspended, and by `removePersistedCache` so
 * that a deliberate wipe cannot be followed by a queued write putting the cache
 * straight back.
 */
export function flushPersistedCache(): void {
  const client = pendingWrite;
  pendingWrite = null;
  cancelTimer();
  if (client) void writeNow(client);
}

/**
 * The persister TanStack hydrates through.
 *
 * Reads and writes are wrapped rather than passed to
 * `createSyncStoragePersister` directly because of the envelope — the version
 * stamp has to be checked on the way in and added on the way out — and because
 * `persistClient` is where the debounce lives.
 */
export const cachePersister: Persister = {
  persistClient(client) {
    pendingWrite = client;
    // Trailing edge, restarted on every call. A burst of responses therefore
    // collapses into one write of the state they all produced, rather than one
    // write each.
    cancelTimer();
    writeTimer = setTimeout(() => {
      writeTimer = null;
      const latest = pendingWrite;
      pendingWrite = null;
      if (latest) void writeNow(latest);
    }, WRITE_DEBOUNCE_MS);
    // Deliberately NOT awaited. TanStack does not await this either, and
    // resolving immediately is what stops a response from waiting on storage.
    return Promise.resolve();
  },

  async restoreClient() {
    const env = await readEnvelope();
    // Returning undefined (rather than throwing) is what tells TanStack "there
    // is nothing to restore", which is a normal state it handles by going
    // straight to fetching.
    return env?.client as never;
  },

  async removeClient() {
    // Anything queued is now a write we would rather not make.
    pendingWrite = null;
    cancelTimer();
    await AsyncStorage.removeItem(STORAGE_KEY);
  },
};

/**
 * Keys restored into memory without being shown. Everything still revalidates;
 * these just do not get painted first.
 *
 * Search results are the reason this list exists. A persisted "24 results for
 * 'cow'" is the right answer to that question and the wrong answer to any other,
 * and a tab that opens onto yesterday's query the user has forgotten typing
 * looks like a bug. Same reasoning would apply to anything keyed on a string the
 * user produced.
 *
 * PER-USER FLAGS ARE THE STRONGER REASON, and every entry past the first is
 * load-bearing. `characterFavourite` answers "has THIS person favourited this
 * character", and a copy written by a signed-out session is `false` for everything
 * — restore it and the sheet paints `Like` on characters that are on the account,
 * which is a wrong answer rather than a merely old one.
 *
 * `listEntry` is the one that actually leaked. `qk.listEntry(id)` is keyed on the
 * media id ALONE — no user id — and `ListEntry` carries the user's **free-text
 * `notes`**, their `score` and their `priority`. So a signed-out session opening a
 * detail page could be served the previous account's private notes straight off
 * disk. `completeSignOut` now wipes the store, but a wipe cannot help a process
 * that was killed mid-session: the scrub covers "signed out, app backgrounded, next
 * launch", and it puts the invariant next to the mechanism that enforces it rather
 * than trusting every transition to remember.
 *
 * `viewer` is the account's own name and avatar — per-user, and already fetched on
 * demand, so restoring it buys nothing.
 *
 * DELIBERATELY NOT `home`, even though `qk.home` carries per-user rails. Its key
 * already contains the user id — `['home', userId ?? 'anon', …]` — so a previous
 * account's entry is a cache entry that can never be *served* to anyone else: the
 * keys do not match, and it goes unused until garbage collection. The bytes still
 * reach disk, which `completeSignOut`'s wipe handles. Scrubbing all of `home` would
 * throw away the instant cold start that is the entire reason this file exists, in
 * order to close an exposure that is not reachable through the app.
 */
const NO_RESTORE = ['search', 'characterFavourite', 'characterMe', 'listEntry', 'viewer'];

/**
 * Drop persisted queries that must not be rehydrated into a visible screen.
 *
 * Runs over the restored client state before TanStack adopts it, so the
 * exclusion is permanent rather than a per-screen guard somebody has to remember
 * to write. The key is the FIRST segment: search is keyed
 * `['search', query, page]`, and it is the query string the user produced that
 * makes it unsafe to restore — not the query itself.
 */
function scrubRestoredState(state: unknown): unknown {
  const client = state as { clientState?: { queries?: unknown[] } } | undefined;
  const queries = client?.clientState?.queries;
  if (!Array.isArray(queries)) return state;
  client!.clientState!.queries = queries.filter(
    (q) => !NO_RESTORE.includes(String((q as { queryKey?: unknown[] })?.queryKey?.[0] ?? ''))
  );
  return client;
}

/**
 * The persister the provider is given: `cachePersister` with the scrub applied
 * on the way in.
 *
 * Wrapping rather than configuring, because there is no option for "transform
 * the state on restore" — and putting it here rather than in the screen means a
 * new query key cannot be restored into a visible tab by accident.
 */
export const persister: Persister = {
  persistClient: (client) => cachePersister.persistClient(client),
  restoreClient: async () => {
    const state = await cachePersister.restoreClient();
    return state == null ? state : (scrubRestoredState(state) as never);
  },
  removeClient: () => cachePersister.removeClient(),
};

/**
 * Wipe the whole store. Settings → Clear calls it, and so does sign-out.
 *
 * `await writing` comes FIRST, and it is not incidental ordering. A `writeNow`
 * that is already on the wire resolves *after* whatever we do next, so wiping
 * first and waiting second means the in-flight `setItem` lands on top of the
 * `removeItem` and quietly restores the cache — the exact outcome the wait is
 * there to prevent. It read the other way round while the comment claimed this
 * one, which is the sort of thing that survives review because the comment
 * describes the intent rather than the code.
 *
 * `removeClient()` then clears `pendingWrite` and the debounce timer as well, so
 * nothing queued behind us re-creates the store either.
 */
export async function removePersistedCache(): Promise<void> {
  await writing;
  await cachePersister.removeClient();
}
