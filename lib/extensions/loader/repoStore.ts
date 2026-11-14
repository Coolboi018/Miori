// Per-repository manifest cache.
//
// The old cache was ONE merged bag of manifests plus a single index version, so
// the app could not answer "which repository did this source come from?" or
// "what does this repository OFFER that I have not installed?" — the two
// questions the Extensions screen is built on. Records are now keyed by the
// repository URL exactly as the user pasted it, because that same string is the
// key of the install allowlist in settings; normalising one and not the other
// would silently split a repository in two.
//
// A record holds EVERY validated manifest the repo shipped, installed or not.
// Installation is policy (registry + allowlist), never storage: uninstalling a
// source must not mean re-downloading a repository to get it back.

import AsyncStorage from '@react-native-async-storage/async-storage';

export interface StoredRepo {
  /** The base URL that actually served `index.json` (may be a subfolder). */
  base: string;
  /** The repo's `index.json` version. */
  version: number;
  changelog?: string;
  /** Wall-clock ms of the last successful fetch. */
  fetchedAt: number;
  /** Manifest id -> raw, already-validated manifest JSON. */
  manifests: Record<string, unknown>;
}

const KEY = 'miori:ext:repos.v1';

/** The pre-install-era cache. Read once, to seed the new one. */
const LEGACY_MANIFESTS = 'miori:ext:manifests';
const LEGACY_VERSION = 'miori:ext:indexVersion';

export async function readRepos(): Promise<Record<string, StoredRepo>> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, StoredRepo> = {};
    for (const [url, value] of Object.entries(parsed as Record<string, unknown>)) {
      const r = value as Partial<StoredRepo> | null;
      if (!r || typeof r !== 'object') continue;
      if (!r.manifests || typeof r.manifests !== 'object') continue;
      out[url] = {
        base: typeof r.base === 'string' ? r.base : '',
        version: typeof r.version === 'number' && Number.isFinite(r.version) ? r.version : 0,
        changelog: typeof r.changelog === 'string' ? r.changelog : undefined,
        fetchedAt: typeof r.fetchedAt === 'number' && Number.isFinite(r.fetchedAt) ? r.fetchedAt : 0,
        manifests: r.manifests as Record<string, unknown>,
      };
    }
    return out;
  } catch {
    return {};
  }
}

export async function writeRepos(map: Record<string, StoredRepo>): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify(map));
  } catch {
    /* best effort — a failed write costs a warm start, never a session */
  }
}

/**
 * The old merged cache, so an upgrade does not lose sources until the first
 * network fetch. Returns null when there is nothing worth migrating.
 */
export async function readLegacyCache(): Promise<{
  version: number;
  manifests: Record<string, unknown>;
} | null> {
  try {
    const raw = await AsyncStorage.getItem(LEGACY_MANIFESTS);
    if (!raw) return null;
    const manifests: unknown = JSON.parse(raw);
    if (!manifests || typeof manifests !== 'object' || Array.isArray(manifests)) return null;
    if (!Object.keys(manifests as Record<string, unknown>).length) return null;
    const verRaw = await AsyncStorage.getItem(LEGACY_VERSION);
    return {
      version: verRaw ? Number(verRaw) || 0 : 0,
      manifests: manifests as Record<string, unknown>,
    };
  } catch {
    return null;
  }
}
