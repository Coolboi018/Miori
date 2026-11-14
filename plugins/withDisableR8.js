// Disable R8 (code shrinking + obfuscation) in release builds.
//
// SDK 58 turns `android.enableMinifyInReleaseBuilds` on by default. R8 then
// renames/strip the Java methods that react-native-webview exposes to its
// inline page through `addJavascriptInterface` — `window.ReactNativeWebView`
// stops responding, `postMessage` silently no-ops, and the hidden gateway
// page never announces `wv-ready`. The result is exactly the symptom we saw:
// Rich Presence works in dev (Expo Go, R8 off) and dies in every EAS
// preview/release build. The gateway is a WebView, so it is the first thing
// R8 breaks. Disabling minification keeps the JS<->native bridge intact.
//
// Cost: a slightly larger APK and no bytecode optimisation. Correctness of
// the presence bridge is worth more than the bytes; if size matters later,
// replace this with a targeted proguard keep-rules plugin instead.
const { withGradleProperties } = require('@expo/config-plugins');

const withDisableR8 = (config) =>
  withGradleProperties(config, (cfg) => {
    const set = (key, value) => {
      const idx = cfg.modResults.findIndex(
        (p) => p.type === 'property' && p.key === key
      );
      if (idx >= 0) cfg.modResults[idx].value = value;
      else cfg.modResults.push({ type: 'property', key, value });
    };
    set('android.enableMinifyInReleaseBuilds', 'false');
    set('android.enableShrinkResourcesInReleaseBuilds', 'false');
    return cfg;
  });

module.exports = withDisableR8;