// Per-ABI APK splits — this is why the personal APK was ~150MB.
//
// `expo prebuild` packages EVERY ABI the SDK ships — arm64-v8a,
// armeabi-v7a, x86 and x86_64 — into one universal APK. Four copies of the
// same native payload (RN + Hermes + expo-video + reanimated + webview …)
// is what made `app-universal-release.apk` land at ~150MB. The x86 pair is
// EMULATOR-only; no phone runs them, and sideloading a universal APK onto a
// phone installs all four anyway.
//
// The fix is a gradle `splits` block: ONE APK, architecture-scoped. Only
// `arm64-v8a` is included — the user's phone, like every phone worth owning
// since ~2017 — so the artifact is one installable file at a fraction of
// universal. Old `armeabi-v7a` devices are out of scope BY CHOICE here (the
// former `include` covered them too); if that ever returns, add the ABI back
// on this line.
//
// WHY A CONFIG PLUGIN AND NOT pregrooted edits: `android/` is CNG —
// generated per prebuild, never committed — so a hand edit to
// `android/app/build.gradle` survives locally but is regenerated away in
// the EAS cloud build, which prebuilds from `app.json`. Living in
// `app.json`'s plugins is the only placement that applies everywhere.
//
// EAS builds this alongside `buildType: "apk"` with no extra profile
// config: gradle emits the single arm64 `.apk` and the build page lists it;
// install it on the device directly.
const { withAppBuildGradle } = require('@expo/config-plugins');

const SPLIT_BLOCK = `    splits {
        abi {
            enable true
            reset()
            include 'arm64-v8a'
            universalApk false
        }
    }
`;

const withAbiSplits = (config) =>
  withAppBuildGradle(config, (cfg) => {
    // Idempotent: a prebuild that runs this plugin twice must not nest the
    // block, and the template carries no `splits {` today (verified), so the
    // marker text can come from no one else.
    if (!cfg.modResults.contents.includes('universalApk')) {
      // `withAppBuildGradle` hands back the whole file as one string; the
      // root `android {` block is its first and only unindented one.
      cfg.modResults.contents = cfg.modResults.contents.replace(
        'android {\n',
        `android {\n${SPLIT_BLOCK}`
      );
    }
    if (!cfg.modResults.contents.includes('universalApk')) {
      // The anchor is part of the template, not our own text — if it is gone
      // the template skipped a rename. Fail the prebuild loudly rather than
      // shipping a 150MB universal APK silently.
      throw new Error('withAbiSplits: could not anchor the splits block in app/build.gradle');
    }
    return cfg;
  });

module.exports = withAbiSplits;
