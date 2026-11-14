/**
 * The update check's decisions, driven as the REAL modules.
 *
 * `lib/updates/version.ts` and `lib/updates/release.ts` are what run on every
 * launch, and their failures are silent by construction: a tag parsed as 0, a
 * string-compared version, an APK asset missed, a skip that never expires — all
 * of them look exactly like "no update today". Each rule below is pinned with
 * the shape that would get it wrong.
 *
 * The network call, the download and Android's installer are NOT covered here;
 * they need a device and a real release (see mds/progress.md).
 */

// Declared rather than imported from 'node:*': this project carries no
// @types/node, and the other source-reading checks do exactly this.
declare const require: (id: string) => {
  readFileSync(path: string, encoding: 'utf8'): string;
};
const { readFileSync } = require('node:fs');

declare const process: { cwd(): string; exit(code: number): never };

import { compareVersions, isNewer, parseVersion } from '../lib/updates/version';
import {
  isUpdateAvailable,
  parseRelease,
  pickApkAsset,
  plainNotes,
  shouldPrompt,
  NOTES_MAX_CHARS,
  type UpdateRelease,
} from '../lib/updates/release';

let pass = 0;
let fail = 0;

function check(name: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) {
    pass += 1;
  } else {
    fail += 1;
    console.error(`  ✗ ${name}\n      got:  ${JSON.stringify(got)}\n      want: ${JSON.stringify(want)}`);
  }
}

function section(title: string): void {
  console.log(`\n${title}`);
}

// ---------------------------------------------------------------------------
section('versions — numeric, not lexicographic');
// ---------------------------------------------------------------------------

check('v-prefix and 3-part tag', parseVersion('v1.2.3'), {
  major: 1,
  minor: 2,
  patch: 3,
  prerelease: null,
});
check('2-part tag fills patch with 0', parseVersion('1.4'), {
  major: 1,
  minor: 4,
  patch: 0,
  prerelease: null,
});
check('build metadata is dropped', parseVersion('1.2.3+build.9'), {
  major: 1,
  minor: 2,
  patch: 3,
  prerelease: null,
});
check('prerelease is kept', parseVersion('v1.2.3-beta.1'), {
  major: 1,
  minor: 2,
  patch: 3,
  prerelease: 'beta.1',
});
check('a tag with no number is no answer', parseVersion('nightly'), null);
check('missing tag is no answer', parseVersion(undefined), null);

// The whole reason the comparison is not `a > b` on strings.
check('1.10.0 beats 1.9.9', compareVersions('1.10.0', '1.9.9'), 1);
check('1.9.9 loses to 1.10.0', compareVersions('1.9.9', '1.10.0'), -1);
check('same triple is equal', compareVersions('v1.2.0', '1.2.0'), 0);
check('a prerelease sorts below its release', compareVersions('1.2.0-beta.1', '1.2.0'), -1);
check('release sorts above its prerelease', compareVersions('1.2.0', '1.2.0-beta.1'), 1);
check('unreadable side is null, not 0', compareVersions('nope', '1.0.0'), null);
check('isNewer is strict', isNewer('1.0.0', '1.0.0'), false);

// ---------------------------------------------------------------------------
section('APK asset — ranked, not "the first one"');
// ---------------------------------------------------------------------------

const assets = [
  { name: 'miori-universal.apk', browser_download_url: 'https://x/u.apk', size: 900 },
  { name: 'miori-arm64-v8a.apk', browser_download_url: 'https://x/a.apk', size: 400 },
  { name: 'notes.txt', browser_download_url: 'https://x/n.txt', size: 2 },
  { name: 'attach.zip', browser_download_url: 'https://x/z.zip', size: 10 },
];
check('arm64 outranks universal', pickApkAsset(assets), {
  url: 'https://x/a.apk',
  name: 'miori-arm64-v8a.apk',
  size: 400,
});
check(
  'only an .apk counts',
  pickApkAsset([
    { name: 'notes.txt', browser_download_url: 'https://x/n.txt' },
    { name: 'app.ZIP', browser_download_url: 'https://x/z.zip' },
  ]),
  null
);
check('no assets at all', pickApkAsset(undefined), null);
check(
  'missing size stays null',
  pickApkAsset([{ name: 'app.apk', browser_download_url: 'https://x/a.apk' }]),
  { url: 'https://x/a.apk', name: 'app.apk', size: null }
);

// ---------------------------------------------------------------------------
section('release payload');
// ---------------------------------------------------------------------------

const payload = {
  tag_name: 'v1.3.0',
  name: 'Miori 1.3.0',
  body: '## What is new\n\n- **Per-source** installs\n- Faster [home](https://x)\n\n![shot](https://x/s.png)',
  html_url: 'https://github.com/Coolboi018/Miori/releases/tag/v1.3.0',
  published_at: '2026-11-14T10:00:00Z',
  assets,
  draft: false,
};
const release = parseRelease(payload);
check('normalised version', release?.version, '1.3.0');
check('title falls back to the tag', parseRelease({ ...payload, name: '' })?.title, 'v1.3.0');
check('notes are flattened', release?.notes, 'What is new\n\n• Per-source installs\n• Faster home\n\nshot');
check('page url survives', release?.pageUrl, payload.html_url);
check('apk is the arm64 build', release?.apk?.name, 'miori-arm64-v8a.apk');
check('a draft is refused', parseRelease({ ...payload, draft: true }), null);
check('an unreadable tag is refused', parseRelease({ ...payload, tag_name: 'latest' }), null);
check('junk is refused', parseRelease(null), null);
check('an array is refused', parseRelease([]), null);
check('a release with no apk still parses', parseRelease({ ...payload, assets: [] })?.apk, null);
check('long notes are capped', plainNotes('x'.repeat(NOTES_MAX_CHARS + 500)).length, NOTES_MAX_CHARS + 1);

// ---------------------------------------------------------------------------
section('should the prompt appear?');
// ---------------------------------------------------------------------------

const newer: UpdateRelease = release as UpdateRelease;
check('newer than installed → prompt', shouldPrompt(newer, { auto: true, skipped: '', localVersion: '1.2.0' }), true);
check('same version → no prompt', shouldPrompt(newer, { auto: true, skipped: '', localVersion: '1.3.0' }), false);
check('older than installed → no prompt', shouldPrompt(newer, { auto: true, skipped: '', localVersion: '1.4.0' }), false);
check(
  'skip silences that exact release on the launch check',
  shouldPrompt(newer, { auto: true, skipped: '1.3.0', localVersion: '1.2.0' }),
  false
);
check(
  'a newer release outlives an older skip',
  shouldPrompt(newer, { auto: true, skipped: '1.2.0', localVersion: '1.2.0' }),
  true
);
// The manual check is the user asking; the skip is about being INTERRUPTED.
check(
  'a manual check ignores the skip',
  shouldPrompt(newer, { auto: false, skipped: '1.3.0', localVersion: '1.2.0' }),
  true
);
check('isUpdateAvailable agrees', isUpdateAvailable(newer, '1.2.0'), true);

// ---------------------------------------------------------------------------
section('the card — a long changelog scrolls instead of breaking the layout');
// ---------------------------------------------------------------------------

const ROOT = process.cwd();

/**
 * Source with comments removed, for the same reason `check-subtitles.ts` does
 * it: a comment that NAMES the protective style would otherwise satisfy the
 * regex. What is asserted has to be code the device actually runs.
 */
function stripSource(src: string): string {
  return src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

const promptSrc = stripSource(readFileSync(`${ROOT}/components/updates/UpdatePrompt.tsx`, 'utf8'));

// The notes are the ONE flexible element: capped so a short body does not float,
// but shrinking (`flexShrink`) when the screen is short — the player is
// landscape, and a 6-section changelog must never push the exits off screen.
check(
  'notes box is capped AND may shrink',
  /notes:\s*\{[^}]*maxHeight:[^}]*flexShrink:\s*1[^}]*\}/.test(promptSrc),
  true
);
check(
  'notes actually scroll inside that box',
  /<ScrollView[\s\S]*?styles\.notes[\s\S]*?<\/ScrollView>/.test(promptSrc),
  true
);
// The field has to LOOK like one: outline + inset fill. Without them a long
// changelog reads as a wall of text and nothing suggests it can be scrolled.
check(
  'notes box is outlined as a field',
  /notes:\s*\{[^}]*borderWidth:\s*1[^}]*borderRadius/.test(promptSrc),
  true
);
check(
  'the outline and inset fill are themed, not raw grey',
  /styles\.notes[\s\S]*?borderColor:\s*color\.border\.strong[\s\S]*?backgroundColor:\s*color\.bg\.primary/.test(
    promptSrc
  ),
  true
);
// Card-level guard, independent of the notes cap: whatever the content, the
// card cannot be taller than the screen it is centred in.
check(
  'card is bounded by the screen',
  /card:\s*\{[^}]*maxHeight:\s*'100%'[^}]*\}/.test(promptSrc),
  true
);
check(
  'card clips its own scrolled content',
  /card:\s*\{[^}]*overflow:\s*'hidden'[^}]*\}/.test(promptSrc),
  true
);
// The OLD shape, watched failing: a notes box with no shrink would keep its
// 220pt on a short screen and push the buttons out of reach.
check(
  'a notes box with no shrink would be rejected',
  /notes:\s*\{[^}]*maxHeight:[^}]*flexShrink:\s*1[^}]*\}/.test(
    'notes: { maxHeight: 220 },'
  ),
  false
);
// Truncation is the last line of defence: an enormous body is cut before it is
// ever handed to the Text node.
check('an enormous body is truncated', plainNotes('word '.repeat(3000)).endsWith('…'), true);
check('a short body is untouched', plainNotes('- one\n- two'), '• one\n• two');

// ---------------------------------------------------------------------------
console.log(`\n${pass + fail} checks — ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
