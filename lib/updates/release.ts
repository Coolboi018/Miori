// GitHub release → the little bundle the update prompt needs.
//
// PURE: imports only `./version`. `scripts/check-updates.ts` drives every
// decision here against real payload shapes, because a raw GitHub response is
// arbitrary JSON and the failure that matters — "a release went up and nobody
// was ever told" — produces no error anywhere.

import { compareVersions, parseVersion } from './version';

export interface ReleaseAsset {
  url: string;
  name: string;
  /** Bytes, when GitHub reported them; null otherwise. */
  size: number | null;
}

export interface UpdateRelease {
  /** Normalised, tag prefix stripped: `v1.2.0` → `1.2.0`. */
  version: string;
  /** The tag exactly as published, for display. */
  tag: string;
  title: string;
  /** Markdown flattened to readable plain text, capped by NOTES_MAX_CHARS. */
  notes: string;
  publishedAt: string | null;
  /** The release page — the fallback when a release carries no APK. */
  pageUrl: string;
  apk: ReleaseAsset | null;
}

/** Long release notes are scrolled, not reflowed into a wall — but not infinite. */
export const NOTES_MAX_CHARS = 2400;

/**
 * The APK to download out of a release's asset list.
 *
 * RANKED, because an ABI-split build can attach more than one and the phone in
 * the user's hand is almost always 64-bit ARM. Picking "the first .apk" would
 * hand an armeabi-v7a build to an arm64 device — it installs, and every later
 * update lands on the wrong split.
 */
export function pickApkAsset(assets: unknown): ReleaseAsset | null {
  if (!Array.isArray(assets)) return null;
  const candidates: Array<ReleaseAsset & { rank: number }> = [];
  for (const raw of assets) {
    const a = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const name = typeof a.name === 'string' ? a.name : '';
    const url = typeof a.browser_download_url === 'string' ? a.browser_download_url : '';
    if (!name || !url) continue;
    if (!name.toLowerCase().endsWith('.apk')) continue;
    const lower = name.toLowerCase();
    // arm64 first; a universal build covers everything else; then whatever is there.
    const rank = lower.includes('arm64') ? 2 : lower.includes('universal') || lower.includes('all') ? 1 : 0;
    candidates.push({
      url,
      name,
      size: typeof a.size === 'number' && Number.isFinite(a.size) ? a.size : null,
      rank,
    });
  }
  if (!candidates.length) return null;
  // Highest rank wins; ties keep the first, which is the order the release page
  // shows and therefore the order the owner uploaded in.
  const best = candidates.reduce((acc, c) => (c.rank > acc.rank ? c : acc));
  return { url: best.url, name: best.name, size: best.size };
}

/**
 * Flatten GitHub-flavoured markdown into something a `<Text>` can show.
 *
 * Deliberately not a markdown renderer: the prompt is one card, and shipping a
 * renderer for release notes would cost more than the feature. The rules below
 * keep the WORDS and drop the syntax, which is all a changelog needs.
 */
export function plainNotes(markdown: string): string {
  const text = markdown
    .replace(/\r\n/g, '\n')
    // Fenced code → its contents (a release note may quote a command).
    .replace(/```[^\n]*\n([\s\S]*?)```/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1') // image → alt text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // link → its label
    .replace(/<[^>]+>/g, '') // html tags
    // `[ \t]{0,3}`, NOT `\s{0,3}`: `\s` matches newlines, so a line-anchored
    // pattern would eat the blank line ABOVE a bullet or heading and turn a
    // paragraph break into a run-on. The blank lines are the only structure a
    // plain-text changelog has left.
    .replace(/^[ \t]{0,3}#{1,6} ?/gm, '') // headings
    .replace(/^[ \t]{0,3}> ?/gm, '') // blockquotes
    .replace(/^[ \t]{0,3}[-*+] +/gm, '• ') // bullets
    .replace(/^[ \t]{0,3}(\d+)\. +/gm, '$1. ') // numbered lists
    .replace(/(\*\*|__)(.*?)\1/g, '$2') // bold
    .replace(/(\*|_)(.*?)\1/g, '$2') // italic
    .replace(/`([^`]+)`/g, '$1') // inline code
    .replace(/^[ \t]{0,3}(-{3,}|_{3,}|\*{3,})[ \t]*$/gm, '') // horizontal rules
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text.length > NOTES_MAX_CHARS ? `${text.slice(0, NOTES_MAX_CHARS).trimEnd()}…` : text;
}

/**
 * GitHub's release object → `UpdateRelease`, or null.
 *
 * A draft is refused outright. `/releases/latest` does not return drafts, but
 * this parser is also what a `version.json`-shaped payload would go through, so
 * the refusal is stated here rather than assumed of the caller.
 */
export function parseRelease(raw: unknown): UpdateRelease | null {
  const r = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null) as Record<
    string,
    unknown
  > | null;
  if (!r || r.draft === true) return null;
  const tag = typeof r.tag_name === 'string' ? r.tag_name.trim() : '';
  const parsed = parseVersion(tag);
  if (!tag || !parsed) return null;
  const title = typeof r.name === 'string' && r.name.trim() ? r.name.trim() : tag;
  return {
    version: `${parsed.major}.${parsed.minor}.${parsed.patch}${
      parsed.prerelease ? `-${parsed.prerelease}` : ''
    }`,
    tag,
    title,
    notes: typeof r.body === 'string' ? plainNotes(r.body) : '',
    publishedAt: typeof r.published_at === 'string' ? r.published_at : null,
    pageUrl: typeof r.html_url === 'string' ? r.html_url : '',
    apk: pickApkAsset(r.assets),
  };
}

/** Strictly newer than what is installed. */
export function isUpdateAvailable(release: UpdateRelease, localVersion: string): boolean {
  return compareVersions(release.version, localVersion) === 1;
}

/**
 * Should this check put the prompt on screen?
 *
 * `auto` is the launch check, and it is the one that honours "Skip this
 * version" — pressing skip must silence that release until a NEWER one is
 * published, which is an equality test against the skipped version, not a
 * "greater than installed" test. A manual check from Settings ignores the skip:
 * the user asked, so the answer is shown.
 */
export function shouldPrompt(
  release: UpdateRelease,
  opts: { auto: boolean; skipped: string; localVersion: string }
): boolean {
  if (!isUpdateAvailable(release, opts.localVersion)) return false;
  if (!opts.auto) return true;
  const skipped = opts.skipped.trim();
  if (!skipped) return true;
  return compareVersions(release.version, skipped) !== 0;
}
