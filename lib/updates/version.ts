// Version parsing + comparison for the GitHub release check.
//
// PURE: imports nothing. `scripts/check-updates.ts` runs this module under tsx,
// and it holds the one judgement the whole feature rests on — "is the installed
// build behind the newest release?". Keeping it free of React Native is what
// makes that judgement assertable instead of eyeballed.
//
// NUMERIC, NOT STRING. `1.10.0` is newer than `1.9.9`, and a string compare says
// the opposite — which is a silent "no updates ever" exactly when a project has
// shipped enough times to reach a double digit. Hence the triple.

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  /** Everything after `-` (e.g. `beta.1`), or null for a plain release. */
  prerelease: string | null;
}

/**
 * `v1.2.3`, `1.2`, `1.2.3-beta.1` and `1.2.3+build9` all parse.
 *
 * Anything without a leading number returns null. A tag we cannot read is "no
 * answer", never version 0 — treating it as 0 would make every launch claim an
 * update is available, which is worse than saying nothing.
 */
export function parseVersion(raw: string | null | undefined): ParsedVersion | null {
  if (typeof raw !== 'string') return null;
  // Build metadata (`+sha`) never affects ordering, so it is dropped before the
  // match rather than carried around.
  const text = raw.trim().replace(/^v/i, '').split('+')[0];
  const m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?$/.exec(text);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2] ?? 0),
    patch: Number(m[3] ?? 0),
    prerelease: m[4] ?? null,
  };
}

/**
 * -1 / 0 / 1, or null when either side cannot be read.
 *
 * A prerelease sorts BELOW the same triple without one (`1.2.0-beta` < `1.2.0`),
 * which is semver's rule and the reason a test tag can be published without
 * telling every installed user they are behind.
 */
export function compareVersions(a: string, b: string): number | null {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return null;
  if (pa.major !== pb.major) return pa.major > pb.major ? 1 : -1;
  if (pa.minor !== pb.minor) return pa.minor > pb.minor ? 1 : -1;
  if (pa.patch !== pb.patch) return pa.patch > pb.patch ? 1 : -1;
  if (pa.prerelease === pb.prerelease) return 0;
  if (pa.prerelease === null) return 1;
  if (pb.prerelease === null) return -1;
  const c = pa.prerelease.localeCompare(pb.prerelease);
  return c === 0 ? 0 : c > 0 ? 1 : -1;
}

/** `remote` is strictly newer than `local`. Unreadable either side → false. */
export function isNewer(remote: string, local: string): boolean {
  return compareVersions(remote, local) === 1;
}
