// Recent searches — the last few things you looked for, on the device.
//
// WHY THEY EXIST: the alternative to "no results yet" on a search screen is a
// blank area and an instruction to type. Recent searches turn the empty state
// into the fastest possible path back into something you already wanted, and
// they cost NOTHING at render time: no request, no spinner, no rate-limit
// spend. The landing state of the search tab is therefore entirely local.
//
// STORAGE, not state-of-the-component. A recent search has to outlive the
// screen being unmounted, or "recent" means "this session". One AsyncStorage
// key holds the whole list — the same reasoning as the settings bag: this is
// read once on mount and written on a deliberate tap, so a key per entry would
// mean N native writes for no benefit.

import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = 'miori:recentSearches';

/**
 * How many to keep. Eight is what fits two clean wrapped rows on a phone;
 * a longer list stops being a shortcut and starts being a log.
 */
export const RECENT_MAX = 8;

/**
 * The canonical identity of a search term, shared with the cache key in
 * `@/lib/anilist/search`. Re-declared rather than imported so this module
 * stays a leaf — but it MUST stay the same rule, or "  Frieren " and "frieren"
 * would become two rows in the recents list.
 */
function identity(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Read the list, newest first. Cached in memory after the first read so a
 * screen remount (every tab switch) costs no native I/O at all.
 *
 * A missing key is an empty list, not an error — a first run has never
 * searched anything, and that is a normal state, not a failure.
 */
let memo: string[] | null = null;

export async function readRecent(): Promise<string[]> {
  if (memo) return memo;
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    // Trust nothing on disk: a hand-edited or half-written value must not be
    // able to render a non-array into the list, or a non-string into a pill.
    memo = Array.isArray(parsed)
      ? parsed.filter((v): v is string => typeof v === 'string' && v.trim().length > 0).slice(0, RECENT_MAX)
      : [];
  } catch {
    // A corrupt or unreadable store must not take the search screen down with
    // it. Start clean; the next write repairs the key.
    memo = [];
  }
  return memo;
}

async function persist(list: string[]): Promise<string[]> {
  memo = list;
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    // Memory still holds the new list, so the screen updates even if the
    // write failed. Nothing here is worth interrupting a tap over.
  }
  return list;
}

/**
 * Move a term to the front. Re-searching something already in the list
 * REORDERS it rather than duplicating it, which is what makes the list read as
 * "what I want lately" instead of "every query I have ever typed".
 *
 * Keeps the casing the user typed: `Frieren` reads better on a chip than
 * `frieren`, and identity is only ever used for comparison.
 */
export async function pushRecent(raw: string): Promise<string[]> {
  const term = raw.trim().replace(/\s+/g, ' ');
  const key = identity(term);
  if (!key) return readRecent();
  const current = await readRecent();
  return persist([term, ...current.filter((t) => identity(t) !== key)].slice(0, RECENT_MAX));
}

/** Drop one term — from the per-item X. */
export async function dropRecent(raw: string): Promise<string[]> {
  const key = identity(raw);
  const current = await readRecent();
  return persist(current.filter((t) => identity(t) !== key));
}

/** Empty the list — from "Clear" in the Recent header. */
export async function clearRecent(): Promise<string[]> {
  return persist([]);
}