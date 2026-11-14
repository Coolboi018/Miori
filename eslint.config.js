// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require("eslint-config-expo/flat");

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ["dist/*"],
  },
  {
    // React Compiler lint rules.
    //
    // This app runs the classic (non-compiled) React Native renderer, and these
    // rules reject patterns that are the documented API for the libraries in use:
    //
    //   react-hooks/refs
    //     useRef(new Animated.Value(...)).current (Reanimated/Animated handles),
    //     refs that mirror the latest props, and expo-video's imperative player.
    //
    //   react-hooks/immutability
    //     Mutating the object returned by useVideoPlayer() (player.currentTime,
    //     player.play(), ...). expo-video's player is an imperative handle by design.
    //
    //   react-hooks/set-state-in-effect
    //     Resetting screen state when a route param changes, and loading flags
    //     flipped on before an async load kicked off from an effect.
    //
    //   react-hooks/preserve-manual-memoization
    //     A DOWNSTREAM symptom of `react-hooks/refs` being off. The player
    //     mirrors its latest state into refs during render (so the
    //     PanResponder and the player-event listeners, both built once, read
    //     fresh values without being rebuilt). That pattern makes the compiler
    //     bail out of the component entirely, and when it bails it reports that
    //     it could not preserve every `useMemo`/`useCallback` in the file. The
    //     memos are still correct — they are just no longer the compiler's
    //     problem, and the component is not large enough for their absence to
    //     matter.
    //
    // Rewriting these to satisfy the compiler would mean reimplementing the
    // animation and playback layers. Re-enable them per-file once that work is
    // actually done.
    rules: {
      "react-hooks/refs": "off",
      "react-hooks/immutability": "off",
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/preserve-manual-memoization": "off",
    },
  },
]);
