// Resume-position store (AsyncStorage). Keyed per anime+episode.
// AniList progress sync lands here later; local resume works from day 1.
import AsyncStorage from '@react-native-async-storage/async-storage';

const key = (animeId: number, ep: number) => `miori:pos:${animeId}:${ep}`;

export async function loadPosition(animeId: number, ep: number): Promise<number> {
  try {
    const raw = await AsyncStorage.getItem(key(animeId, ep));
    const t = raw ? parseFloat(raw) : 0;
    return Number.isFinite(t) && t > 0 ? t : 0;
  } catch {
    return 0;
  }
}

export async function savePosition(
  animeId: number,
  ep: number,
  seconds: number
): Promise<void> {
  try {
    if (seconds > 5) await AsyncStorage.setItem(key(animeId, ep), String(Math.floor(seconds)));
  } catch {
    /* storage full / unavailable — resume just won't persist */
  }
}

export async function clearPosition(animeId: number, ep: number): Promise<void> {
  try {
    await AsyncStorage.removeItem(key(animeId, ep));
  } catch {
    /* ignore */
  }
}

/**
 * Every saved position for one anime, in a single storage read.
 *
 * The detail screen needs this to draw progress on the episode list. Calling
 * `loadPosition` per row would be N native reads for one screen — and rows
 * mount lazily as you scroll, so it would repeat. AsyncStorage has no
 * multi-get, but all the keys share a prefix and `getAllKeys` + `multiGet`
 * resolves them together.
 */
export async function loadPositions(
  animeId: number
): Promise<Record<number, number>> {
  const prefix = `miori:pos:${animeId}:`;
  const out: Record<number, number> = {};
  try {
    const keys = await AsyncStorage.getAllKeys();
    const mine = keys.filter((k) => k.startsWith(prefix));
    if (!mine.length) return out;
    const pairs = await AsyncStorage.multiGet(mine);
    for (const [k, v] of pairs) {
      if (typeof v !== 'string') continue;
      const ep = Number(k.slice(prefix.length));
      const t = parseFloat(v);
      if (Number.isFinite(ep) && Number.isFinite(t) && t > 0) out[ep] = t;
    }
  } catch {
    /* no saved progress — the list just renders as unwatched */
  }
  return out;
}

/**
 * Clear every saved resume position — the "Reset resume positions" setting.
 *
 * DELIBERATELY does not touch the `miori:synced:` flags. Those flags are what
 * keep AniList progress monotonic (a rewatch must never push the account's
 * progress backwards), so clearing them would trade a cosmetic reset for a
 * real data-corruption window. Positions are local convenience; the flags are
 * a correctness mechanism.
 */
export async function clearAllResume(): Promise<void> {
  try {
    const keys = await AsyncStorage.getAllKeys();
    const mine = keys.filter((k) => k.startsWith('miori:pos:'));
    if (mine.length) await AsyncStorage.multiRemove(mine);
  } catch {
    /* ignore — a failed clear just keeps the old positions */
  }
}

const syncedKey = (animeId: number, ep: number) => `miori:synced:${animeId}:${ep}`;

export async function isSynced(animeId: number, ep: number): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(syncedKey(animeId, ep))) === '1';
  } catch {
    return false;
  }
}

export async function markSynced(animeId: number, ep: number): Promise<void> {
  try {
    await AsyncStorage.setItem(syncedKey(animeId, ep), '1');
  } catch {
    /* ignore */
  }
}
