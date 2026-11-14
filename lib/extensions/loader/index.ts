// Extension loader — repo bundles.
//
// Fetches a repo's `index.json`, downloads every manifest it lists, validates
// them and returns ONE bundle. Nothing is persisted here: `repoStore` owns the
// cache and `registry` owns the policy (which sources are installed).
//
// A manifest that fails validation is skipped with a reason — never a crash,
// and never a partial apply.
//
// Every request goes through `fetchTimed`, which reads the BODY inside the
// deadline. A CDN that answers headers and stalls mid-body is the common
// failure, and a plain `fetch` + `res.json()` here would hang forever.

import { fetchTimed } from '../fetch';
import { validateIndex, validateManifest } from './schema';

export interface RepoBundle {
  /** The base URL that actually served `index.json` (may be a subfolder). */
  base: string;
  version: number;
  changelog?: string;
  /** Manifest id -> raw, validated manifest JSON. */
  manifests: Record<string, unknown>;
  skipped: Array<{ file: string; reason: string }>;
}

/** Turn a pasted GitHub URL into a raw-content base URL (root of repo/branch).
 *  - https://github.com/o/r/tree/branch/path -> https://raw.githubusercontent.com/o/r/branch/path
 *  - https://github.com/o/r (no tree)        -> https://raw.githubusercontent.com/o/r/main
 *  Anything else is returned trimmed (assumed to already be a raw base). */
export function normalizeRepoUrl(input: string): string {
  const url = input.trim().replace(/\/+$/, '');
  const m = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)(?:\/tree\/([^/]+)(?:\/(.*))?)?$/i);
  if (m) {
    const owner = m[1];
    const repo = m[2];
    const branch = m[3] || 'main';
    const path = m[4] || '';
    return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}${path ? '/' + path : ''}`;
  }
  return url;
}

/** Candidate subfolders to probe when the root has no index.json. */
const INDEX_CANDIDATES = ['', 'extensions', 'extensions-repo', 'manifests'];
const INDEX_TIMEOUT_MS = 12000;
const MANIFEST_TIMEOUT_MS = 12000;

/** One timed GET + parse. A non-2xx or unparseable body is `null`, not a throw:
 *  these are probes, where "no answer here" is an ordinary outcome. */
async function readJson(url: string, ms: number, label: string): Promise<unknown> {
  try {
    const res = await fetchTimed(url, ms, {}, label);
    if (!res.ok) return null;
    return JSON.parse(res.text) as unknown;
  } catch {
    return null;
  }
}

/** Resolve the base URL that actually serves a valid index.json.
 *  Tries the root, then common subfolders. Returns null if none work. */
export async function resolveBase(repoUrl: string): Promise<string | null> {
  const root = normalizeRepoUrl(repoUrl);
  for (const sub of INDEX_CANDIDATES) {
    const base = sub ? `${root}/${sub}` : root;
    const json = await readJson(`${base}/index.json`, INDEX_TIMEOUT_MS, 'extension index');
    if (validateIndex(json)) return base;
  }
  return null;
}

export async function fetchIndex(
  repoUrl: string
): Promise<{ version: number; manifests: string[]; changelog?: string } | null> {
  const base = await resolveBase(repoUrl);
  if (!base) return null;
  return validateIndex(await readJson(`${base}/index.json`, INDEX_TIMEOUT_MS, 'extension index'));
}

/**
 * Download a whole repository. Parallel per manifest — the manifests are
 * independent files, and a serial walk made a five-source repo cost five
 * round-trips of latency in a row.
 */
export async function fetchRepo(repoUrl: string): Promise<RepoBundle | null> {
  const base = await resolveBase(repoUrl);
  if (!base) return null;
  const index = validateIndex(await readJson(`${base}/index.json`, INDEX_TIMEOUT_MS, 'extension index'));
  if (!index) return null;

  const skipped: RepoBundle['skipped'] = [];
  const manifests: Record<string, unknown> = {};
  await Promise.all(
    index.manifests.map(async (file) => {
      const json = await readJson(`${base}/${file}`, MANIFEST_TIMEOUT_MS, `manifest ${file}`);
      if (json === null) {
        skipped.push({ file, reason: 'fetch failed' });
        return;
      }
      const v = validateManifest(json);
      if (!v.ok || !v.manifest) {
        skipped.push({ file, reason: v.reason ?? 'invalid' });
        return;
      }
      manifests[v.manifest.id] = json;
    })
  );

  return { base, version: index.version, changelog: index.changelog, manifests, skipped };
}

export { validateIndex, validateManifest };
