// Native Android splash-screen icon animation (Gmail/GPay style).
//
// Wraps expo-splash-screen so we can:
//   (a) keep all of its config (image, background, drawable, …)
//   (b) copy the AVD's companion files (vector drawable + animators) into the
//       generated Android project, since the splash AVD references them via
//       @drawable/... and @animator/...
//   (c) run our style edit AFTER expo-splash-screen's, adding
//       `windowSplashScreenAnimationDuration` (required for Android to actually
//       play the animated icon).
const splashPlugin = require('expo-splash-screen/app.plugin.js').default;
const { withAndroidStyles, withDangerousMod } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

const ANIMATION_DURATION_MS = '1500';

// Files that make up the AVD, relative to project root.
const AVD_FILES = [
  { src: 'Logo/ic_miori_logo.xml', dest: 'android/app/src/main/res/drawable/ic_miori_logo.xml' },
  { src: 'Logo/miori_fill.xml', dest: 'android/app/src/main/res/animator/miori_fill.xml' },
  { src: 'Logo/miori_scale.xml', dest: 'android/app/src/main/res/animator/miori_scale.xml' },
  { src: 'Logo/miori_stroke.xml', dest: 'android/app/src/main/res/animator/miori_stroke.xml' },
];

const withSplashAnimation = (config, props) => {
  // 1. Register style edit FIRST → runs AFTER expo-splash-screen's style mod.
  config = withAndroidStyles(config, (cfg) => {
    const styles = cfg.modResults?.resources?.style ?? [];
    const splash = styles.find((s) => s?.$?.name === 'Theme.App.SplashScreen');
    if (!splash) return cfg;
    splash.item = splash.item ?? [];
    if (!splash.item.some((it) => it?.$?.name === 'windowSplashScreenAnimationDuration')) {
      splash.item.push({
        $: { name: 'windowSplashScreenAnimationDuration' },
        _: ANIMATION_DURATION_MS,
      });
    }
    return cfg;
  });

  // 2. Register file copy FIRST → runs AFTER expo-splash-screen's file mods.
  config = withDangerousMod(config, [
    'android',
    async (cfg) => {
      const root = cfg.modRequest.projectRoot;
      for (const { src, dest } of AVD_FILES) {
        const from = path.join(root, src);
        const to = path.join(root, dest);
        if (!fs.existsSync(from)) continue;
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(from, to);
      }
      return cfg;
    },
  ]);

  // 3. Apply expo-splash-screen LAST so its mods register after ours and run first.
  config = splashPlugin(config, props);

  return config;
};

module.exports = withSplashAnimation;