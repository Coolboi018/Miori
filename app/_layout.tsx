import { useFonts } from 'expo-font';
import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useCallback, useEffect, useState } from 'react';
import { AppState, Platform } from 'react-native';
// react-native's StatusBar lost `translucent`/`backgroundColor` in RN 0.88
// (Android is edge-to-edge now); expo-status-bar is the supported wrapper.
import { StatusBar } from 'expo-status-bar';
import { NavigationBar } from 'expo-navigation-bar';
import { clearVideoCacheAsync, setVideoCacheSizeAsync } from 'expo-video';
import 'react-native-reanimated';

import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';

import { useColorScheme } from '@/components/useColorScheme';
import { AnimatedSplash } from '@/components/AnimatedSplash';
import { GatewayView } from '@/components/presence/GatewayView';
import { ListSheetHost } from '@/components/ui/ListSheetHost';
import { CharacterSheetHost } from '@/components/ui/CharacterSheetHost';
import { UpdatePrompt } from '@/components/updates/UpdatePrompt';
import { AUTO_CHECK_DELAY_MS, checkForUpdate } from '@/lib/updates/store';
import { SPLASH, handoffMs } from '@/lib/ui/splash';
import { hydrateSettings } from '@/lib/settings/useSetting';
import { readSetting, PLAYER_CACHES } from '@/lib/settings/store';
import {
  EXTENSION_SYNC_DELAY_MS,
  getRepoStates,
  loadCachedExtensions,
  syncExtensions,
} from '@/lib/extensions/registry';
import { refreshUserId } from '@/lib/auth/session';
import { dehydrateOptions, hydrateOptions, queryClient, refetchStaleOnForeground, refreshUserListOnForeground } from '@/lib/query/client';
import { persister, flushPersistedCache } from '@/lib/query/persister';
import { startWarmup } from '@/lib/query/prefetch';

/**
 * DO NOT CALL `enableFreeze()`.
 *
 * A previous pass called it here, on the theory that background tabs re-rendering
 * was stealing frames from the tab you were switching to. That part was true — the
 * 5-second hero carousel and the 30-second schedule clock really were running
 * forever — but freezing is the wrong fix, and measuring on a device showed tab
 * switching got WORSE (1–2s → 3–4s).
 *
 * `react-freeze` suspends a screen's renders and re-runs its whole tree
 * synchronously on thaw. So every switch paid a full re-render of a screen
 * holding ~80 poster tiles, and it got more expensive rather than less once each
 * screen was backed by a query. It trades a small background cost for a large
 * foreground one — exactly backwards for this complaint.
 *
 * The background work is now stopped at the source instead, which costs nothing
 * on the way back in: `HeroCarousel` pauses its autoplay on blur and `useNow`
 * pauses the schedule clock on blur. Those two timers were the whole problem.
 *
 * `react-native-screens` therefore runs with `ENABLE_FREEZE = false`, its default,
 * and `freezeOnBlur` is left alone in `app/(tabs)/_layout.tsx`.
 */

export {
  // Catch any errors thrown by the Layout component.
  ErrorBoundary,
} from 'expo-router';

export const unstable_settings = {
  // Deep-linking or reloading straight onto a deeper route (e.g. `/anime/123`,
  // or the watch page from a link) keeps the tab stack seeded BELOW it, so the
  // deep-linked screen still has a back button. `anchor` is SDK 58's rename of
  // the deprecated `initialRouteName`, and the value must be a route CHILD of
  // this layout — `(tabs)`, the group layout, is exactly that child.
  // ⚠️ It seeds ONLY the deep-link/reload state; it does NOT choose the app's
  // launch screen (the launch URL does that, and `/` already resolves to
  // `(tabs)/index`). The old comment named `/modal`, which this app has never
  // had — it was Create Expo App boilerplate.
  anchor: '(tabs)',
};


// Prevent the splash screen from auto-hiding before asset loading is complete.
SplashScreen.preventAutoHideAsync();

/**
 * THE NATIVE SPLASH FADES OUT IN 200ms, NOT THE LIBRARY'S 400ms.
 *
 * `SplashScreenManager.kt` runs its own exit fade over `duration` while it is
 * still composited ON TOP of the first React frame — so for that whole window
 * the user is looking at a static logo with the animated one hidden underneath
 * it. Cutting it to 200ms (the number lives in `lib/ui/splash.ts` with the rest
 * of the timeline) is the difference between "the animation played behind a
 * still picture" and "the animation played".
 *
 * Safe at module scope: `setOptions` is a plain synchronous module function on
 * Android (an `AsyncFunction` on iOS is not involved), and on web it is a
 * documented no-op.
 */
SplashScreen.setOptions({ duration: SPLASH.nativeExitMs });

export default function RootLayout() {
  const [loaded, error] = useFonts({
    Montserrat_400Regular: require('../assets/fonts/Montserrat-Regular.ttf'),
    Montserrat_500Medium: require('../assets/fonts/Montserrat-Medium.ttf'),
    Montserrat_600SemiBold: require('../assets/fonts/Montserrat-SemiBold.ttf'),
    Montserrat_700Bold: require('../assets/fonts/Montserrat-Bold.ttf'),
    SpaceMono: require('../assets/fonts/SpaceMono-Regular.ttf'),
  });

  // Expo Router uses Error Boundaries to catch errors in the navigation tree.
  useEffect(() => {
    if (error) throw error;
  }, [error]);

  /**
   * THE LAUNCH GATE IS SETTINGS, AND ONLY SETTINGS.
   *
   * It used to be settings PLUS the whole video-cache setup below — two native
   * calls, one of which (`clearVideoCacheAsync`) deletes files off the disk
   * before the first screen was allowed to exist. That is launch time spent on
   * something the USER CANNOT REACH YET: a `VideoPlayer` only exists in the
   * watch route, which needs a navigation first. So the gate narrowed to the
   * read the first frame genuinely depends on (`hydrateSettings`, one
   * AsyncStorage-backed read, millisecond-scale), and the cache work now runs
   * underneath the animated splash instead of in front of it.
   *
   * No new hazard from that: this effect still starts at mount, before any
   * screen can mount, and those two calls have the whole splash plus whatever
   * the user does next to finish. The failure mode if one did land late is
   * unchanged and non-fatal — see below.
   */
  const [settingsReady, setSettingsReady] = useState(false);
  /**
   * CONFIGURE THE PERSISTENT VIDEO CACHE, ONCE, IN THE BACKGROUND.
   *
   * Both expo-video calls here carry the SAME hard precondition, verbatim from
   * the SDK 57 reference: *"This function can be called only if there are no
   * existing VideoPlayer instances."* They **reject** rather than no-op, and the
   * rejection text (`Cannot clear cache while there are active players`) names the
   * clear even when the call that threw was the size setter — which is why this
   * was previously impossible to diagnose from the log.
   *
   * **TWO STEPS AND NOT ONE `try`, and that is the fix.** The original had both
   * calls in a single `try`, so:
   *   - a rejected size call silently skipped the clear, and
   *   - a rejected clear produced a warning blaming the wrong function.
   * Neither failure could be told from the other in the log.
   *
   * The clear runs only if the size call succeeded, because they share one
   * precondition: with a player alive the clear is *guaranteed* to fail too, so
   * making the call buys a second guaranteed rejection and a second misleading
   * warning to say nothing new.
   *
   * Neither failure is fatal — neither one gates the app, and the size is a
   * PERSISTENT native value, so a failure leaves the previous limit standing
   * rather than none and the user's choice applies on the next launch.
   */
  useEffect(() => {
    let mounted = true;
    void (async () => {
      await hydrateSettings();
      // Everything past this line is background work the splash does NOT wait
      // on — the first frame is released here.
      if (mounted) setSettingsReady(true);
      // Load user-added extension repos (if any) while the splash is up, so the
      // registry is populated before the first screen mounts.
      // Cached manifests first (instant, offline-safe), then the update sweep.
      // The sweep waits EXTENSION_SYNC_DELAY_MS when there IS a cache, so it
      // never competes with the first screen's own requests; a cold start with
      // nothing cached fetches immediately, because there the fetch is what
      // makes the first episode playable rather than a background nicety.
      void loadCachedExtensions().then(() => {
        const hasCachedSources = getRepoStates().some((r) => r.sources.length > 0);
        void syncExtensions({
          delayMs: hasCachedSources ? EXTENSION_SYNC_DELAY_MS : 0,
        }).catch(() => {});
      });
      if (Platform.OS === 'android') {
        const profile = PLAYER_CACHES.find((item) => item.key === readSetting('player.cache'));
        let sizeApplied = false;
        try {
          await setVideoCacheSizeAsync(profile?.bytes ?? PLAYER_CACHES[0].bytes);
          sizeApplied = true;
        } catch (cacheError) {
          // A VideoPlayer existed when this ran. On a genuine cold start nothing
          // creates one before the first screen renders, so this means the effect
          // re-ran — a Fast Refresh remount is the likely cause, which is a dev
          // affordance rather than a bug in the app.
          if (__DEV__) {
            console.warn(
              '[player] cache size NOT applied: a VideoPlayer was already alive. ' +
                'The limit is persistent, so the previous one stands until next launch.',
              cacheError
            );
          }
        }
        if (sizeApplied) {
          try {
            await clearVideoCacheAsync();
          } catch (cacheError) {
            // Same precondition, re-checked because a player can be CREATED
            // between the two awaits. Distinct from the above: here the limit DID
            // apply and only the leftover eviction was skipped.
            if (__DEV__) {
              console.warn('[player] cache clear skipped: a VideoPlayer appeared mid-setup.', cacheError);
            }
          }
        }
      }
    })();
    return () => { mounted = false; };
  }, []);

  /**
   * READ THE SESSION DURING THE SPLASH, for the same reason and with more at stake.
   *
   * `useHomeSections` refuses to fire while the user id is `undefined` rather than
   * assume a guest — see the note there — so every screen that depends on knowing
   * who is signed in is waiting on this one keychain read. Starting it here, behind
   * the splash, means it has settled before the first screen mounts and the gate is
   * never actually closed when the user can see it.
   *
   * Started alongside `hydrateSettings` rather than after it: they are independent
   * SecureStore reads and there is no reason to serialise them.
   */
  useEffect(() => {
    void refreshUserId();
  }, []);

  /**
   * THE SPLASH STAYS UP UNTIL THE CACHE HAS BEEN READ BACK OFF DISK.
   *
   * This is the whole cold-start design in one place. Before, the splash hid as
   * soon as fonts loaded and the home tab then blocked on a network round-trip,
   * so a cold start was splash → spinner → content, in that order, every time.
   *
   * Reading the cache is one AsyncStorage `getItem` of a few hundred KB —
   * single-digit milliseconds. Paying it behind the splash means the first frame
   * the user sees already has yesterday's rails, and there is no spinner to
   * explain. Nothing here waits on the NETWORK: an empty cache mounts the screen
   * immediately and it shows its skeleton instead.
   *
   * `PersistQueryClientProvider` blocks its children until restore completes, so
   * this gate is belt-and-braces for the case where restore is slow — it keeps
   * the splash up rather than flashing an unhydrated screen.
   *
   * The gate is `fontsReady && settingsReady` and nothing else: settings are the
   * only read the first frame is built from (`hydrateSettings` above). The video
   * cache is background work now — see the note there.
   */
  const [fontsReady, setFontsReady] = useState(false);
  const [animatedSplashVisible, setAnimatedSplashVisible] = useState(true);
  /**
   * THE APP TREE IS NOT MOUNTED UNTIL THE SPLASH ENTRANCE HAS FINISHED.
   *
   * This is the low-end half of the 15 Nov fix. Mounting home (~70 poster tiles)
   * plus the cache restore is the single biggest lump of JS work at launch, and
   * it used to land in the SAME window as the splash entrance — so the one asset
   * that has to look smooth was competing with the screen it was covering.
   *
   * `AnimatedSplash` now fires `onEntered` when its entrance ends, and the hold
   * that follows is a still frame: that is where the app's first render is paid
   * for, with the exit fade still to come behind it.
   */
  const [appEntered, setAppEntered] = useState(false);
  const handleSplashEntered = useCallback(() => setAppEntered(true), []);
  const handleSplashFinish = useCallback(() => setAnimatedSplashVisible(false), []);
  useEffect(() => {
    if (loaded && !error) setFontsReady(true);
  }, [loaded, error]);

  /**
   * LET THE FIRST FRAME OUT, THEN TIME THE HAND-OFF TO THE IN-APP ENTRANCE.
   *
   * `hideAsync` only flips `keepSplashScreenOnScreen` to false — it resolves
   * when the native exit fade STARTS, not when it ends (`SplashScreenManager.kt`
   * runs `nativeExitMs` of alpha ramp afterwards, still drawn over the React
   * tree). Starting the animated logo's timeline immediately would therefore
   * play part of its entrance behind a still picture, which is exactly how a
   * real animation gets reported as "still". So the TIMELINE waits out
   * `handoffMs` — the native fade's own duration plus a beat.
   *
   * ⚠️ THE TIMELINE, NOT THE MOUNT. This used to hold the whole overlay back,
   * which left the React tree uncovered for that window and made the app's first
   * frame the HOME SCREEN — the "home, then the splash animation, then home"
   * sequence. `nativeSplashGone` is now passed to `AnimatedSplash` as
   * `handoffDone`; the overlay itself is up from the first frame.
   *
   * Timed rather than awaited: `hideAsync`'s promise says nothing about when the
   * fade finishes, and on web there is no native splash to wait for at all.
   */
  const [nativeSplashGone, setNativeSplashGone] = useState(Platform.OS === 'web');
  useEffect(() => {
    if (!fontsReady || !settingsReady || nativeSplashGone) return;
    void SplashScreen.hideAsync();
    const handoff = setTimeout(() => setNativeSplashGone(true), handoffMs());
    return () => clearTimeout(handoff);
  }, [fontsReady, settingsReady, nativeSplashGone]);

  /**
   * THE APP IS MOUNTED BEHIND THE OVERLAY, NOT IN FRONT OF IT.
   *
   * `!animatedSplashVisible` is the second half of this and it is not a
   * formality: the watchdog (below) tears the overlay down without ever having
   * fired `onEntered`, so a stalled entrance would otherwise leave the user on
   * the overlay's black forever — the "stuck" bug in a new costume.
   *
   * The two halves are one expression on purpose: "the app may render" is
   * exactly "the entrance finished OR there is nothing covering it any more".
   */
  const showApp = appEntered || !animatedSplashVisible;

  /**
   * THE UPDATE CHECK — once per launch, and late.
   *
   * Same discipline as the extension sweep: the first seconds belong to the
   * home rails and the cache restore, and nobody opens this app for an update
   * prompt. `AUTO_CHECK_DELAY_MS` keeps the GitHub request (and, if a release is
   * out, the download the user starts) off that window entirely.
   *
   * Web is skipped on purpose: an APK cannot be installed from a browser tab,
   * so the popup there would only offer a link. Settings → About still works.
   *
   * The check itself honours `updates.skippedVersion`, so a release the user
   * skipped stays quiet until a newer one exists — see `lib/updates/release.ts`.
   */
  /**
   * THE OVERLAY CANNOT OUTLIVE ITSELF.
   *
   * `AnimatedSplash` normally ends by calling back from its fade-out. That
   * callback rides a setTimeout and a Reanimated completion — both of which a
   * stalled UI thread on a low-end phone can delay past the point where the app
   * underneath is ready and interactive. The symptom is the one the user
   * reported as "it gets stuck": a black rectangle over a working app, with the
   * only exit being a restart.
   *
   * This is the backstop, and it is deliberately LATER than the animation
   * (`SPLASH.watchdogMs` vs `splashTotalMs()`), so it never cuts a healthy fade
   * — `scripts/check-splash.ts` pins that relationship.
   */
  useEffect(() => {
    if (!animatedSplashVisible) return;
    const bail = setTimeout(() => setAnimatedSplashVisible(false), SPLASH.watchdogMs);
    return () => clearTimeout(bail);
  }, [animatedSplashVisible]);

  useEffect(() => {
    if (!fontsReady || Platform.OS === 'web') return;
    const timer = setTimeout(() => {
      void checkForUpdate({ auto: true });
    }, AUTO_CHECK_DELAY_MS);
    return () => clearTimeout(timer);
  }, [fontsReady]);

  if (!fontsReady || !settingsReady) return null;

  return (
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={{
        persister,
        ...dehydrateOptions,
        ...hydrateOptions,
      }}
      onSuccess={() => {
        // Restore is done, so the screens can mount against real data. This is
        // also where warming the REST of the app starts — see `startWarmup`.
        void startWarmup();
      }}
    >
      {showApp ? <RootLayoutNav /> : null}
      {animatedSplashVisible ? (
        <AnimatedSplash
          handoffDone={nativeSplashGone}
          onEntered={handleSplashEntered}
          onFinish={handleSplashFinish}
        />
      ) : null}
    </PersistQueryClientProvider>
  );
}

/**
 * Refetch on return to the foreground, and flush the cache on the way out.
 *
 * `AppState` rather than a focus event, and only for the transition that means
 * something: 'active' after 'background'. React Native has no window-focus
 * event, so `refetchOnWindowFocus` is inert on a device — this is what actually
 * refreshes the app after it has been away, and it is scoped to STALE queries,
 * so a ten-second glance costs nothing.
 */
function useForegroundRefresh(): void {
  useEffect(() => {
    // Under the strict TypeScript API `currentState` widens to
    // `string | null | undefined`, so `previous` holds the widened read while
    // the `change` events below are always real statuses.
    let previous: string | null | undefined = AppState.currentState;
    const sub = AppState.addEventListener('change', (next) => {
      const returning = previous !== 'active' && next === 'active';
      const leaving = previous === 'active' && next !== 'active';
      previous = next;

      // GOING AWAY. The persister debounces writes by 1.5s so that a burst of
      // responses costs one rewrite of the cache rather than one each (see
      // `lib/query/persister.ts` — that debounce used to not exist, and the
      // comment that claimed it did was simply wrong).
      //
      // Backgrounding is the ONE moment that has to be paid for, because the
      // process may never come back. A user who kills the app from the switcher a
      // second after a response landed should not lose it.
      if (leaving) flushPersistedCache();

      if (!returning) return;
      // Two policies, one ring: the user's own list is FORCE-refreshed (it is
      // externally mutable — see `refreshUserListOnForeground`), everything
      // else is fetched only if stale. Parallel is safe: the sweep joins an
      // in-flight refresh rather than duplicating it.
      void Promise.all([refreshUserListOnForeground(), refetchStaleOnForeground()]).then(
        () => undefined
      );
    });
    return () => sub.remove();
  }, []);
}

function RootLayoutNav() {
  const colorScheme = useColorScheme();
  useForegroundRefresh();

  return (
    <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
      <StatusBar style="light" />
      {/* Android only. The system nav bar defaults to `auto`, which resolves
          against the ACTIVE COLOUR SCHEME — but this app's chrome is
          hardcoded dark (#0b0b10) in both themes, so on a device set to light
          mode "auto" picked a white bar under a dark app. Pinned to `dark`
          instead. The matching `enforceContrast: false` in app.json is
          required for this to take effect. */}
      {Platform.OS === 'android' ? <NavigationBar style="dark" /> : null}
      <GatewayView />
      {/* The list editor, ONCE, for the whole app. Addressed by a module-scope
          target rather than a prop from whichever screen rendered the tile that
          was long-pressed — see `lib/list/listSheet.ts`. Inside the ThemeProvider
          so the sheet reads the app's colours rather than its own. */}
      <ListSheetHost />
      {/* The character info sheet, for the same reason and by the same pattern:
          characters are tappable from the detail page's strip and the cast page's
          cards, and a host per screen would mean a second query and a second
          animation for each. `useCharacter` is disabled until something is
          targeted, so a permanently-mounted host costs nothing. */}
      <CharacterSheetHost />
      <Stack
        screenOptions={{
          headerShown: false,
          /**
           * EXPLICIT, because the platform default reads as NOTHING on this app.
           *
           * A native stack's default Android transition is a cross-fade, and every
           * screen here is hardcoded `#0b0b10` (see `contentStyle` below) — so
           * fading between two screens of the identical colour produces no visible
           * change at any point in the transition. The back gesture was animating,
           * just not observably. Anything with real travel reads as depth on a
           * near-black app where a fade cannot.
           *
           * Kept on the whole stack rather than per screen, deliberately. One shared
           * transition is one thing to learn; a detail screen that slides while
           * settings fades is a stack that feels broken.
           *
           * `ios_from_right` AND NOT `slide_from_right`, and the reason is HALF THE
           * DURATION. Both are pure translation with no fade, so both satisfy the
           * paragraph above — but on Android react-native-screens drives them from
           * different sets of animator resources, and those resources hold the
           * duration. There is no JS option involved. The pop pair, from
           * `FragmentTransactionKt.setTweenAnimations` in react-native-screens:
           *
           *   slide_from_right → rns_slide_in_from_left / rns_slide_out_to_right
           *                      both `@android:integer/config_mediumAnimTime` (400ms)
           *   ios_from_right   → rns_ios_from_right_background_close /
           *                      rns_ios_from_right_foreground_close
           *                      both `@android:integer/config_shortAnimTime` (200ms)
           *
           * Push uses the mirrored `_open` pair and lands on the same two numbers.
           * 400ms was the complaint: every back out of the detail screen felt like
           * it was dragging. `ios_from_right` also has parallax the other one
           * lacks — the screen underneath trails at 30% instead of travelling with
           * the foreground — so it reads as MORE depth, not less, while moving for
           * half as long. That is the whole trick: on this navigator the preset name
           * is the only speed control there is.
           *
           * THIS IS A NATIVE STACK, AND THAT IS WHY THERE IS NO DURATION NUMBER.
           * `StackClient.js` builds it from `createNativeStackNavigator`, and its own
           * types say "Renders a native stack navigator" (`StackClient.d.ts:156`), so
           * the option set is react-native-screens' and it is passed straight
           * through as `stackAnimation` (`NativeStackView.native.js:214`).
           *
           * `animationDuration`/`transitionDuration` is the option that looks like
           * it should work, and it is the trap: it is documented iOS-only, and even
           * there it covers just four presets (`slide_from_bottom`,
           * `fade_from_bottom`, `fade`, `simple_push`) — none of them a horizontal
           * translation, so it is dead for this stack on both platforms.
           *
           * Every Android duration lives in an `anim/` XML under
           * `react-native-screens/android/src/main/res/base/anim/`. An app could
           * shadow those by name, but `android/` is not tracked in git here, so
           * anything hand-written there dies at the next prebuild. Not a real lever.
           *
           * Making push and pop feel like the tab switch is likewise not available.
           * That animation is a bottom-tab `sceneStyleInterpolator` — a custom
           * hoisted crossfade plus a 12px nudge (`app/(tabs)/_layout.tsx`) — and a
           * native stack has no equivalent hook. `cardStyleInterpolator`,
           * `transitionSpec` and `detachPreviousScreen` are all rejected by the
           * typechecker here, which is the reliable way to tell they are JS-stack
           * options. Matching it would mean moving the root stack to
           * `expo-router/js-stack`, giving up native gestures and native screen
           * performance app-wide for one transition.
           *
           * NOT FIXED: a one-frame white flash on pop, where the screen underneath
           * has no attached view for an instant and the bare Android window shows
           * through. `detachPreviousScreen` would be the direct fix and it does not
           * exist on this navigator; `android.backgroundColor` is unset in app.json,
           * so that window is the template default of white. Setting that key to
           * `#0b0b10` makes the gap invisible whatever causes it, and needs a native
           * rebuild to take effect. Not done — it is a build-level change.
           */
          animation: 'ios_from_right',
          // Matches the hardcoded screen backgrounds. On Android gesture
          // navigation the system bar is a transparent overlay, so whatever
          // paints there is what shows through it — without this, any
          // unpainted strip falls back to the window background, which is how
          // a light strip ends up under a dark app. Deliberately not themed:
          // the screens are hardcoded dark in both colour schemes, so a
          // themed background would disagree with them.
          contentStyle: { backgroundColor: '#0b0b10' },
          /**
           * Every screen in the app is portrait EXCEPT the player.
           *
           * This was previously enforced by `"orientation": "portrait"` in
           * app.json, which the player could not override. That value had to go
           * to `"default"` for the landscape lock to be possible at all — on
           * Android it becomes the activity's `screenOrientation` attribute, and
           * `portrait` there is a hard ceiling no runtime lock can lift.
           *
           * So the guarantee moves here, to the one place that can express
           * "portrait everywhere, landscape in exactly one place". This is the
           * right place rather than a `useEffect` per screen: react-native-screens
           * applies this when the route is pushed and releases it when the route
           * leaves, so no screen has to remember to unlock on unmount.
           */
          orientation: 'portrait',
        }}
      >
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="settings" options={{ headerShown: false }} />
        <Stack.Screen name="modal" options={{ presentation: 'modal', headerShown: false }} />
        <Stack.Screen name="anime/[id]" options={{ headerShown: false }} />
        <Stack.Screen
          name="watch/[id]/[ep]"
          options={{ headerShown: false, orientation: 'landscape', animation: 'fade' }}
        />
        <Stack.Screen name="login" options={{ title: 'AniList login', headerShown: false }} />
        <Stack.Screen name="discord-login" options={{ title: 'Discord login', headerShown: false }} />
      </Stack>
      {/* The update card, ONCE, for the whole app: the launch check and the
          Settings → About row open this same host rather than each rendering a
          modal. Above the Stack because it is a Modal — it has to survive a
          screen change underneath it. */}
      <UpdatePrompt />
    </ThemeProvider>
  );
}
