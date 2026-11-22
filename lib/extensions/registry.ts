// Extension registry — installed sources + ordered failover.
//
// v3: sources are INSTALLED, not merely downloaded. A repository is a
// catalogue: every manifest it ships is cached, and the settings allowlist
// (`extensions.repoAllowlists`) decides which of them the app actually runs.
// An uninstalled manifest stays visible on the Extensions page and is never
// registered, so adding a repository no longer means running every source in
// it — the reason a repo of five providers used to turn all five on at once.
//
// BACKWARDS COMPATIBILITY IS THE MISSING ALLOWLIST. A repository with no entry
// means "all of its manifests are installed", which is exactly how the previous
// version behaved; the first time a user toggles something, an explicit list is
// written. A stored settings blob therefore never needs migrating.
//
// Nothing here talks to a source directly: the player asks the registry, and
// the registry keeps the `extId` tag `resolveEpisode` has always stamped.

import type { Extension, ExtensionCapabilities, ResolveHint, WatchSource } from './types';
import { fetchRepo, normalizeRepoUrl, type RepoBundle } from './loader';
import { manifestToExtensionSafe } from './loader/engine';
import { readLegacyCache, readRepos, writeRepos, type StoredRepo } from './loader/repoStore';
import { readSetting, setSetting } from '../settings/store';

/**
 * How long after launch the automatic check waits.
 *
 * Deliberately not zero: the first seconds of a launch belong to the home
 * rails, the session read and the persisted-cache restore, and an update sweep
 * fired into that window competes with them for radio time. A cold start with
 * nothing cached skips the delay (see `app/_layout.tsx`) because there the
 * sweep is not a background nicety — it is what makes the first play work.
 */
export const EXTENSION_SYNC_DELAY_MS = 4000;

/** Cached repo records, keyed by the repository URL as the user entered it. */
let repos: Record<string, StoredRepo> = {};
/** Extensions actually running, in failover order. */
let installed: Extension[] = [];
/** Installed extension id -> the repository URL that supplied it. */
let origins = new Map<string, string>();
/** Bundles fetched by the last `checkForUpdates`, not yet written to the cache. */
let pending: Record<string, StoredRepo> = {};
/** Bundles fetched by `previewRepo`, awaiting the user's install choice. */
const previews = new Map<string, RepoBundle>();

// ---------------------------------------------------------------------------
// Settings-backed policy
// ---------------------------------------------------------------------------

function repoUrls(): string[] {
  return (readSetting('extensions.repoUrls') ?? []).map((u) => (u ?? '').trim()).filter(Boolean);
}

/** A repo's explicit allowlist, or null when it has none (= install all). */
function allowedFor(url: string): string[] | null {
  const map = readSetting('extensions.repoAllowlists') ?? {};
  const list = map[url];
  return Array.isArray(list) ? list : null;
}

function writeAllowlist(url: string, ids: string[]): void {
  setSetting('extensions.repoAllowlists', {
    ...(readSetting('extensions.repoAllowlists') ?? {}),
    [url]: ids,
  });
}

interface SourceMeta {
  id: string;
  label: string;
  version: string;
  capabilities: ExtensionCapabilities;
}

/** Read the display fields out of a raw manifest, defensively. */
function sourceMeta(id: string, raw: unknown): SourceMeta {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    id,
    label: typeof o.label === 'string' && o.label.trim() ? o.label : id,
    version: typeof o.version === 'string' && o.version.trim() ? o.version : '0.0.0',
    capabilities: (o.capabilities && typeof o.capabilities === 'object'
      ? o.capabilities
      : {}) as ExtensionCapabilities,
  };
}

function storedFrom(bundle: RepoBundle): StoredRepo {
  return {
    base: bundle.base,
    version: bundle.version,
    changelog: bundle.changelog,
    fetchedAt: Date.now(),
    manifests: bundle.manifests,
  };
}

/**
 * Rebuild the running set from the cache + allowlists.
 *
 * Settings order is the failover order, and the FIRST repository wins on an id
 * collision — the same rule the multi-repo loader has always had, now applied
 * at install time instead of download time.
 */
function rebuild(): void {
  const next: Extension[] = [];
  const nextOrigins = new Map<string, string>();
  const seen = new Set<string>();
  for (const url of repoUrls()) {
    const repo = repos[url];
    if (!repo) continue;
    const allow = allowedFor(url);
    for (const [id, raw] of Object.entries(repo.manifests)) {
      if (seen.has(id)) continue;
      if (allow && !allow.includes(id)) continue;
      const ext = manifestToExtensionSafe(raw, url);
      if (!ext) continue;
      // Dedupe on the PROVIDER id the extension reports, not only the map key.
      // A cache written by an older build can hold the same manifest under a
      // filename key (`filmu.json`) as well as its id; both then register as
      // `filmu` — two probes per resolve, two verdicts, and two identical rows
      // in the picker (which keys rows by provider).
      if (seen.has(ext.id)) continue;
      seen.add(ext.id);
      next.push(ext);
      nextOrigins.set(ext.id, url);
    }
  }
  installed = next;
  origins = nextOrigins;
}

// ---------------------------------------------------------------------------
// Reads for the app
// ---------------------------------------------------------------------------

export function getLoadedExtensions(): Extension[] {
  return installed.slice();
}

export function createRegistry(): Extension[] {
  return getLoadedExtensions();
}

export interface InstalledSourceInfo extends SourceMeta {
  /** The repository URL this source was installed from ('' if unknown). */
  repoUrl: string;
}

export function getInstalledSources(): InstalledSourceInfo[] {
  return installed.map((ext) => ({
    id: ext.id,
    label: ext.label,
    version: ext.version,
    capabilities: ext.capabilities ?? {},
    repoUrl: origins.get(ext.id) ?? '',
  }));
}

export interface RepoSourceState extends SourceMeta {
  /** In this repo's allowlist (or the repo has none, so everything is). */
  installed: boolean;
  /** A repository earlier in the list already provides this id, so this copy
   *  cannot take effect. Shown as a hint rather than hidden — the toggle still
   *  records the user's intent for the day the other repo is removed. */
  shadowedBy: string | null;
}

export interface RepoState {
  url: string;
  /** `owner/repo` for GitHub repos, the host otherwise. */
  name: string;
  base: string;
  version: number;
  fetchedAt: number;
  changelog?: string;
  sources: RepoSourceState[];
}

/** `Coolboi018/Miori-Extensions` for a GitHub base URL, else the host.
 *  Hand-rolled rather than `new URL(...)`: Hermes ships a partial URL and this
 *  runs on every render of the Extensions page. */
export function repoName(baseOrUrl: string): string {
  const clean = baseOrUrl.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  const slash = clean.indexOf('/');
  if (slash < 0) return clean || baseOrUrl;
  const host = clean.slice(0, slash);
  const rest = clean.slice(slash + 1).split('/').filter(Boolean);
  if ((host === 'github.com' || host === 'raw.githubusercontent.com') && rest.length >= 2) {
    return `${rest[0]}/${rest[1].replace(/\.git$/i, '')}`;
  }
  return host;
}

export function getRepoStates(): RepoState[] {
  return repoUrls().map((url) => {
    const repo = repos[url];
    const allow = allowedFor(url);
    const sources: RepoSourceState[] = Object.entries(repo?.manifests ?? {})
      .map(([id, raw]) => {
        const meta = sourceMeta(id, raw);
        const enabled = !allow || allow.includes(id);
        const owner = origins.get(id);
        return {
          ...meta,
          installed: enabled,
          shadowedBy: enabled && owner && owner !== url ? repoName(repos[owner]?.base ?? owner) : null,
        };
      })
      .sort((a, b) => a.label.localeCompare(b.label));
    return {
      url,
      name: repoName(repo?.base || url),
      base: repo?.base ?? normalizeRepoUrl(url),
      version: repo?.version ?? 0,
      fetchedAt: repo?.fetchedAt ?? 0,
      changelog: repo?.changelog,
      sources,
    };
  });
}

// ---------------------------------------------------------------------------
// Install / uninstall
// ---------------------------------------------------------------------------

export interface RepoPreview {
  /** Exactly what the user pasted — the key everything is stored under. */
  url: string;
  base: string;
  version: number;
  changelog?: string;
  sources: SourceMeta[];
  skipped: Array<{ file: string; reason: string }>;
}

/** Fetch a repository WITHOUT adding it, so the user can choose its sources. */
export async function previewRepo(input: string): Promise<RepoPreview> {
  const url = input.trim();
  const bundle = await fetchRepo(url);
  if (!bundle) throw new Error('No readable index.json at that address');
  previews.set(url, bundle);
  return {
    url,
    base: bundle.base,
    version: bundle.version,
    changelog: bundle.changelog,
    sources: Object.entries(bundle.manifests)
      .map(([id, raw]) => sourceMeta(id, raw))
      .sort((a, b) => a.label.localeCompare(b.label)),
    skipped: bundle.skipped,
  };
}

/** Add the previewed repository, installing exactly `ids`. */
export async function installPreview(preview: RepoPreview, ids: string[]): Promise<void> {
  const bundle = previews.get(preview.url);
  if (!bundle) throw new Error('Preview expired — fetch the repository again');
  const url = preview.url;

  repos[url] = storedFrom(bundle);
  const urls = repoUrls();
  if (!urls.includes(url)) setSetting('extensions.repoUrls', [...urls, url]);
  writeAllowlist(url, ids.filter((id) => Object.prototype.hasOwnProperty.call(bundle.manifests, id)));
  await writeRepos(repos);
  previews.delete(url);
  rebuild();
}

/** Install/uninstall individual sources of a repo that is already added.
 *  Synchronous on purpose: the toggle must land in the same frame as the tap. */
export function setRepoSources(url: string, ids: string[]): void {
  const repo = repos[url];
  const allowed = repo
    ? ids.filter((id) => Object.prototype.hasOwnProperty.call(repo.manifests, id))
    : ids;
  writeAllowlist(url, allowed);
  rebuild();
}

export async function removeRepo(url: string): Promise<void> {
  setSetting('extensions.repoUrls', repoUrls().filter((u) => u !== url));
  const map = { ...(readSetting('extensions.repoAllowlists') ?? {}) };
  delete map[url];
  setSetting('extensions.repoAllowlists', map);
  delete repos[url];
  await writeRepos(repos);
  rebuild();
}

// ---------------------------------------------------------------------------
// Cache load + updates
// ---------------------------------------------------------------------------

/** Load the cached repositories (offline launch), seeding from the old merged
 *  cache on the first run after the upgrade so nothing vanishes without a
 *  network fetch. */
export async function loadCachedExtensions(): Promise<void> {
  try {
    repos = await readRepos();
    if (!Object.keys(repos).length) {
      const legacy = await readLegacyCache();
      const urls = repoUrls();
      if (legacy && urls.length) {
        repos = {
          [urls[0]]: {
            base: normalizeRepoUrl(urls[0]),
            version: legacy.version,
            fetchedAt: Date.now(),
            manifests: legacy.manifests,
          },
        };
        await writeRepos(repos);
      }
    }
    rebuild();
  } catch {
    /* cache unavailable — an empty registry is the honest state, not a crash */
  }
}

export interface UpdateInfo {
  repoUrl: string;
  id: string;
  label: string;
  /** Cached version, or null when the remote repo added this source. */
  from: string | null;
  to: string;
}

export interface UpdateReport {
  updates: UpdateInfo[];
  errors: Array<{ url: string; reason: string }>;
  checkedAt: number;
}

/**
 * Fetch every repository and diff it against the cache. Nothing is written —
 * `applyUpdates` is the only place a downloaded manifest reaches the disk, so a
 * check-then-cancel cannot half-upgrade the catalogue.
 */
export async function checkForUpdates(): Promise<UpdateReport> {
  const report: UpdateReport = { updates: [], errors: [], checkedAt: Date.now() };
  const fresh: Record<string, StoredRepo> = {};

  for (const url of repoUrls()) {
    try {
      const bundle = await fetchRepo(url);
      if (!bundle) {
        report.errors.push({ url, reason: 'no readable index.json' });
        continue;
      }
      fresh[url] = storedFrom(bundle);
      const current = repos[url];
      for (const [id, raw] of Object.entries(bundle.manifests)) {
        const remote = sourceMeta(id, raw);
        const prevRaw = current?.manifests[id];
        const prev = prevRaw === undefined ? null : sourceMeta(id, prevRaw);
        if (!prev) {
          report.updates.push({ repoUrl: url, id, label: remote.label, from: null, to: remote.version });
        } else if (prev.version !== remote.version) {
          report.updates.push({
            repoUrl: url,
            id,
            label: remote.label,
            from: prev.version,
            to: remote.version,
          });
        }
      }
    } catch (e) {
      report.errors.push({ url, reason: (e as Error)?.message ?? 'error' });
    }
  }

  pending = fresh;
  return report;
}

/**
 * Write what `checkForUpdates` fetched.
 *
 * No `ids` = replace each repository's whole manifest set (a source deleted
 * upstream disappears, and a newly added one arrives); with `ids` only those
 * sources are merged in, which is what a per-source "Update" tap means. The
 * pending bundles are kept so a second per-source tap still has its data.
 */
export async function applyUpdates(ids?: string[]): Promise<{ applied: string[] }> {
  const applied: string[] = [];
  const want = ids ? new Set(ids) : null;

  for (const [url, stored] of Object.entries(pending)) {
    const current = repos[url];
    let manifests: Record<string, unknown>;
    if (want) {
      manifests = { ...(current?.manifests ?? {}) };
      for (const id of want) {
        if (!Object.prototype.hasOwnProperty.call(stored.manifests, id)) continue;
        manifests[id] = stored.manifests[id];
        if (!applied.includes(id)) applied.push(id);
      }
    } else {
      manifests = { ...stored.manifests };
      applied.push(...Object.keys(stored.manifests));
    }
    repos[url] = {
      base: stored.base,
      version: stored.version,
      changelog: stored.changelog,
      fetchedAt: stored.fetchedAt,
      manifests,
    };
  }

  if (applied.length) {
    await writeRepos(repos);
    rebuild();
  }
  return { applied };
}

/**
 * The launch sweep: check, and install what changed when the user allows it.
 * `delayMs` is the slow-start courtesy described on EXTENSION_SYNC_DELAY_MS.
 */
export async function syncExtensions(opts?: {
  delayMs?: number;
}): Promise<{ updates: number; applied: number }> {
  const delay = opts?.delayMs ?? 0;
  if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
  const report = await checkForUpdates();
  if (!report.updates.length) return { updates: 0, applied: 0 };
  if (!readSetting('extensions.autoUpdate')) {
    return { updates: report.updates.length, applied: 0 };
  }
  const { applied } = await applyUpdates();
  return { updates: report.updates.length, applied: applied.length };
}

// ---------------------------------------------------------------------------
// Resolve (unchanged contract)
// ---------------------------------------------------------------------------

export interface FailedSource {
  /** Extension id (e.g. 'filmu', 'mega'). */
  id: string;
  /** Short human reason, suitable for a faded row's hint. */
  reason: string;
}

export interface ResolvedEpisode {
  /** Playable sources across all extensions, alive first. */
  sources: WatchSource[];
  /** Which extensions had this title at all. */
  available: string[];
  /** Extensions that did NOT contribute sources, with a short reason. */
  failed: FailedSource[];
}

/** Resolve one episode across every extension, best first. */
function shortReason(err: unknown): string {
  const msg = (err instanceof Error ? err.message : String(err ?? '')).toLowerCase();
  if (msg.includes('fetch failed') || msg.includes('econnreset') || msg.includes('network') || msg.includes('timeout') || msg.includes('aborted')) {
    return 'network blocked';
  }
  if (msg.includes('403') || msg.includes('forbidden')) return 'blocked';
  if (msg.includes('404') || msg.includes('not found') || msg.includes('no mapping')) return 'no mapping';
  if (msg.includes('no episodes') || msg.includes('returned no')) return 'no episodes';
  if (msg) return msg.slice(0, 40);
  return 'unavailable';
}

export async function resolveEpisode(
  registry: Extension[],
  anilistId: number,
  ep: number,
  idMal?: number | null,
  hint?: ResolveHint
): Promise<ResolvedEpisode> {
  const sources: WatchSource[] = [];
  const available: string[] = [];
  const failed: FailedSource[] = [];

  const settled = await Promise.allSettled(
    registry.map((ext) => ext.resolve(anilistId, ep, idMal, hint))
  );

  // ONE VERDICT PER PROVIDER. A duplicated registration must never reach the
  // picker: its failed rows are keyed by provider, and two `failed-filmu` rows
  // are both a duplicated React key (an ERROR in dev) and a duplicated reason.
  const seenIds = new Set<string>();
  settled.forEach((result, i) => {
    const id = registry[i].id;
    if (seenIds.has(id)) return;
    seenIds.add(id);
    if (result.status === 'rejected') {
      failed.push({ id, reason: shortReason(result.reason) });
      return;
    }
    const list = result.value;
    if (list.length) {
      available.push(id);
      sources.push(...list.map((s) => ({ ...s, extId: s.extId ?? id })));
    } else {
      failed.push({ id, reason: 'no sources' });
    }
  });

  if (!sources.length) {
    throw new Error('No extension could resolve this episode');
  }
  return { sources, available, failed };
}
