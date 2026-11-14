// Artwork pipeline for presence icons, ported from ShonenX
// (Projects/Anime/OLd/discord_rpc_service.dart :: _resolveAsset).
// Discord only renders images it knows: POST the poster url to the
// application's external-assets endpoint once, get back an mp: path,
// cache it forever, use it as large_image.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { DISCORD_APP_ID } from './config';

const API = 'https://discord.com/api/v9';

// Bounded: a stalled connection (the video is buffering, the network is
// congested) would otherwise leave this hanging for minutes, and the caller
// awaits it while holding the presence frame lock.
const REQ_TIMEOUT = 8000;

async function cachedGet(key: string): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(`miori:art:${key}`);
  } catch {
    return null;
  }
}

async function cachedSet(key: string, url: string): Promise<void> {
  try {
    await AsyncStorage.setItem(`miori:art:${key}`, url);
  } catch {
    /* ignore */
  }
}

/** In-memory mirror of the AsyncStorage cache. Presence updates fire often
 * (pause/play/seek, screen focus) and each one was paying a native bridge
 * round-trip just to re-read a value that never changes within a session. */
const memo = new Map<string, string | null>();

/** mp: asset path for a poster, or null (caller falls back to no icon). */
export async function resolveArt(
  token: string,
  cacheKey: string,
  remoteUrl: string | undefined
): Promise<string | null> {
  if (!remoteUrl || !DISCORD_APP_ID) return null;
  if (memo.has(cacheKey)) return memo.get(cacheKey) ?? null;
  try {
    const hit = await cachedGet(cacheKey);
    if (hit) {
      memo.set(cacheKey, hit);
      return hit;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQ_TIMEOUT);
    let res: Response;
    try {
      res = await fetch(`${API}/applications/${DISCORD_APP_ID}/external-assets`, {
        method: 'POST',
        headers: { Authorization: token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ urls: [remoteUrl] }),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) return null; // not memoised — a later call may succeed
    const j = (await res.json()) as Array<{ external_asset_path?: string }>;
    const path = Array.isArray(j) && j[0]?.external_asset_path ? `mp:${j[0].external_asset_path}` : null;
    if (!path) return null;
    memo.set(cacheKey, path);
    await cachedSet(cacheKey, path);
    return path;
  } catch {
    return null;
  }
}
