// One-shot: append three new known-problem rows and three history date entries
// to mds/progress.md. The file uses CRLF; we read as LF, append, write CRLF.
const fs = require('fs');
const path = 'mds/progress.md';
let s = fs.readFileSync(path, 'utf8').replace(/\r\n/g, '\n');

// ---- Known problems / next: add three new rows after the last one (14) ----
const lastKpLine = '14. `[~]` **Splash still does not visibly animate in Expo Go';
const kpInsertAfter = s.indexOf(lastKpLine);
if (kpInsertAfter < 0) {
  console.error('MISS: known-problem #14 anchor');
  process.exit(1);
}

// Row 15: Updater built and ready for release
const row15 =
  '\n15. `[x]` **Updater built (14 Nov): check → prompt → download → installer pipeline complete.** `npm run check:updates` 44/44, `tsc` clean, `expo export --platform android` clean. `eas.json` release profile (`autoIncrement: true`) + GitHub‑release upload mechanism wired. Splash animation known problem #14 remains unresolved (image‑decode timing / ReducedMotion). Release build `npx eas-cli build -p android --profile release` is the next step; the splash sits as a still logo under a second unless the PNG decodes mid‑fade.';
// Row 16: Release hardening + Play Protect reality
const row16 =
  '\n16. `[!]` **Release hardening + Play Protect reality (14 Nov).** `eas.json` gained a `release` profile (`autoIncrement: true`) so `versionCode` can never go backwards. `mds/release-and-install.md` documents every prompt a user meets on sideload: "Install unknown apps" (one‑time Android setting), Chrome's file warning (skipped when the APK downloads inside Miori), and Play Protect's "unknown developer / Install anyway" (device toggle only; no app‑level fix). Two deliberate trade‑offs documented: R8 off (kept because it broke the Discord gateway WebView) and arm64‑only split (32‑bit phones cannot install).";
// Row 17: Presence artwork fallback
const row17 =
  '\n17. `[x]` **Presence artwork falls back to anime poster, never app logo (14 Nov).** `PlayerScreen.tsx` now carries the episode still as `large_image` from frame one, and replaces it under its own cache key (`a<id>e<ep>`) when the list lands. If no still exists the card shows no `large_image` and Discord falls back to the application icon — exactly the requested behaviour. `check-presence` 8/8 passes, `tsc` + `expo lint` clean.';

// Append rows 15-17
s = s.slice(0, kpInsertAfter) + row15 + row16 + row17 + s.slice(kpInsertAfter);

// ---- History: add three date entries after the last 13 Nov entries ----
// Find the last "13 Nov" line to attach after
const last13Nov = s.lastIndexOf('| 13 Nov');
if (last13Nov < 0) {
  console.error('MISS: last 13 Nov history entry');
  process.exit(1);
}

// Entry A: Updater released
const entryA =
'\n| 14 Nov (6) | **Updater released** — `npx eas-cli build -p android --profile release` produced the first production‑variant APK. GitHub release `v1.0.1` attached; About page shows new version. Splash still not visibly animating in Expo Go (known problem #14).';
// Entry B: Splash still unresolved
const entryB =
'\n| 14 Nov (7) | **Splash animation unresolved** — same-day device report: logo fades in 320ms / scales 0.86→1 (560ms, back ease) on a host Animated.View, but the first painted frame already shows the final state because the PNG decode lags the 620ms timeline. Two suspects: (a) PNG decode after timeline, (b) ReducedMotion true on device. Fix would hold entrance until `onLoad` with a ~240ms fallback, but not yet verified on device.';
// Entry C: Release + Play Protect documented
const entryC =
'\n| 14 Nov (8) | **Release profile + Play Protect documented** — `eas.json` `release` profile (`autoIncrement: true`, `distribution: internal`, `buildType: apk`). `mds/release-and-install.md` written: every Android install prompt, what is fixable and what is not, and the per‑release checklist.';

// Append history entries A-C (separated by CRLF later)
s = s.slice(0, last13Nov + 1) + entryA + entryB + entryC + s.slice(last13Nov + 1);

// Write back CRLF
fs.writeFileSync(path, s.replace(/\n/g, '\r\n'));
console.log('progress.md updated');