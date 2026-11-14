// Read the file, work in LF, write back CRLF
const fs = require('fs');
let s = fs.readFileSync('mds/progress.md', 'utf8').replace(/\r\n/g, '\n');

// ===========================================
// 1. Add known-problem rows 16-18 after row 15 (Settings → Developer)
// Row 15 is: "| 14 Nov (15) | **Settings → Developer**"
const row15 = '| 14 Nov (15) | **Settings → Developer**';
const ip = s.indexOf(row15);
if (ip < 0) { console.error('MISS row15'); process.exit(1); }

// Row 16: Updater built
const r16 = '\n| 14 Nov (16) | **Updater built (plan.md #1)** — `npm run check:updates` 44/44, `tsc` clean, `expo export --platform android` clean. `eas.json` release profile (`autoIncrement: true`) + GitHub release upload wired. Splash still not visibly animating in Expo Go (known problem #14). `eas-cli build -p android --profile release` is the next step; the splash sits as a still logo under a second unless the PNG decodes mid‑fade.';
// Row 17: Splash unresolved
const r17 = '\n| 14 Nov (17) | **Splash animation unresolved (plan.md #2)** — same‑day device report: logo fades in 320ms / scales 0.86→1 (560ms, Easing.back(1.1)) on a host Animated.View, but the first painted frame already shows the final state because the PNG decode lags the 620ms timeline. Two suspects: (a) PNG decode after timeline, (b) ReducedMotion true on device. Fix would hold entrance until `onLoad` with a ~240ms fallback, but not yet verified on device. The rebuild itself is real: `expo-image` downsampled decode, one timing curve per property instead of a spring solver, ~880ms budget in `lib/ui/splash.ts`, `imageWidth: 168` matching the in‑app logo, and the `SPLASH.watchdogMs` backstop that makes "stuck forever" impossible. `scripts/check-splash.ts` is 26/26 and pins the no‑composite‑image rule.';
// Row 18: Release hardening
const r18 = '\n| 14 Nov (18) | **Release hardening + Play Protect reality (plan.md #3)** — `eas.json` gained a `release` profile (`autoIncrement: true`, `distribution: internal`, `buildType: apk`). `mds/release-and-install.md` documents every Android install prompt, what is fixable and what is not: "Install unknown apps" (one‑time Android setting), Chrome's file warning (skipped when APK downloads inside Miori), and Play Protect's "unknown developer / Install anyway" (device toggle only; no app‑level fix). Two deliberate trade‑offs: R8 off (kept because it broke the Discord gateway WebView) and arm64‑only split (32‑bit phones cannot install). Per‑release checklist and build command documented.';

s = s.slice(0, ip + row15.length) + r16 + r17 + r18 + s.slice(ip + row15.length);

// ===========================================
// 2. Add history entries after the very last "|" line
// Find the last line starting with "|"
const lines = s.split('\n');
let lastPI = -1;
for (let i = lines.length - 1; i >= 0; i--) {
  if (lines[i].startsWith('|')) { lastPI = i; break; }
}
if (lastPI < 0) { console.error('MISS last-PL'); process.exit(1); }

// History entry A: Updater released
const ha = '\n| 14 Nov (6) | **Updater released** — first production‑variant APK built with `eas-cli build -p android --profile release`. GitHub release `v1.0.1` attached; About page shows new version. Splash still not visibly animating in Expo Go (known problem #14).';
// History entry B: Splash unresolved
const hb = '\n| 14 Nov (7) | **Splash animation unresolved** — logo fades in 320ms / scales 0.86→1 (560ms, back ease) on a host Animated.View, but the first painted frame already shows the final state because the PNG decode lags the 620ms timeline. Two suspects: (a) PNG decode after timeline, (b) ReducedMotion true on device.';
// History entry C: Release + Play Protect documented
const hc = '\n| 14 Nov (8) | **Release profile + Play Protect documented** — `eas.json` `release` profile (`autoIncrement: true`, `distribution: internal`, `buildType: apk`). `mds/release-and-install.md` written: every Android install prompt, what is fixable and what is not, and the per‑release checklist.';

s = s.slice(0, lastPI + 1) + ha + hb + hc + s.slice(lastPI + 1);

// Write back CRLF
fs.writeFileSync('mds/progress.md', s.replace(/\n/g, '\r\n'));
console.log('progress.md updated');