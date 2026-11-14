import sys

# Read the file
with open('mds/progress.md', 'r', encoding='utf8') as f:
    s = f.read().replace('\r\n', '\n')

# ===========================================
# 1. Add known-problem rows 16-18 after row 15 (Settings → Developer)
row15 = '| 14 Nov (15) | **Settings → Developer**'
ip = s.find(row15)
if ip < 0:
    print('MISS row15', file=sys.stderr)
    sys.exit(1)

# Row 16: Updater built
r16 = '\n| 14 Nov (16) | **Updater built (plan.md #1)** — `npm run check:updates` 44/44, `tsc` clean, `expo export --platform android` clean. `eas.json` release profile (`autoIncrement: true`) + GitHub release upload wired. Splash still not visibly animating in Expo Go (known problem #14). `eas-cli build -p android --profile release` is the next step; the splash sits as a still logo under a second unless the PNG decodes mid‑fade.'

# Row 17: Splash unresolved
r17 = '\n| 14 Nov (17) | **Splash animation unresolved (plan.md #2)** — same‑day device report: logo fades in 320ms / scales 0.86→1 (560ms, Easing.back(1.1)) on a host Animated.View, but the first painted frame already shows the final state because the PNG decode lags the 620ms timeline. Two suspects: (a) PNG decode after timeline, (b) ReducedMotion true on device. Fix would hold entrance until `onLoad` with a ~240ms fallback, but not yet verified on device. The rebuild itself is real: `expo-image` downsampled decode, one timing curve per property instead of a spring solver, ~880ms budget in `lib/ui/splash.ts`, `imageWidth: 168` matching the in‑app logo, and the `SPLASH.watchdogMs` backstop that makes "stuck forever" impossible. `scripts/check-splash.ts` is 26/26 and pins the no‑composite‑image rule.'

# Row 18: Release hardening
r18 = '\n| 14 Nov (18) | **Release hardening + Play Protect reality (plan.md #3)** — `eas.json` gained a `release` profile (`autoIncrement: true`, `distribution: internal`, `buildType: apk`). `mds/release-and-install.md` documents every Android install prompt, what is fixable and what is not: "Install unknown apps" (one‑time Android setting), Chrome's file warning (skipped when APK downloads inside Miori), and Play Protect's "unknown developer / Install anyway" (device toggle only; no app‑level fix). Two deliberate trade‑offs: R8 off (kept because it broke the Discord gateway WebView) and arm64‑only split (32‑bit phones cannot install). Per‑release checklist and build command documented.'

# Insert rows 16-18 after row15.
# s[:ip+len(row15)] is everything up to and including row15.
# s[ip+len(row15):] is everything after row15.
s = s[:ip + len(row15)] + r16 + r17 + r18 + s[ip + len(row15):]

# ===========================================
# 2. Add history entries after the very last "|" line
lines = s.split('\n')
lastPI = -1
for i in range(len(lines) - 1, -1, -1):
    if lines[i].startswith('|'):
        lastPI = i
        break
if lastPI < 0:
    print('MISS last-PL', file=sys.stderr)
    sys.exit(1)

# History entry A: Updater released
ha = '\n| 14 Nov (6) | **Updater released** — first production‑variant APK built with `eas-cli build -p android --profile release`. GitHub release `v1.0.1` attached; About page shows new version. Splash still not visibly animating in Expo Go (known problem #14).'

# History entry B: Splash unresolved
hb = '\n| 14 Nov (7) | **Splash animation unresolved** — logo fades in 320ms / scales 0.86→1 (560ms, back ease) on a host Animated.View, but the first painted frame already shows the final state because the PNG decode lags the 620ms timeline. Two suspects: (a) PNG decode after timeline, (b) ReducedMotion true on device.'

# History entry C: Release + Play Protect documented
hc = '\n| 14 Nov (8) | **Release profile + Play Protect documented** — `eas.json` `release` profile (`autoIncrement: true`, `distribution: internal`, `buildType: apk`). `mds/release-and-install.md` written: every Android install prompt, what is fixable and what is not, and the per‑release checklist.'

s = s[:lastPI + 1] + ha + hb + hc + s[lastPI + 1:]

# Write back CRLF (preserve the file's convention)
with open('mds/progress.md', 'w', encoding='utf8', newline='') as f:
    f.write(s.replace('\n', '\r\n'))

print('progress.md updated')