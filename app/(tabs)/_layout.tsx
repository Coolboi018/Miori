// Home tab bar â€” two designs, chosen by the `tabs.style` setting.
//
//   floating   the original: a translucent icon-only pill floating over the
//              screen, with a small dot under the active icon.
//   segmented  the details page's tab strip (Episodes | Relations |
//              Characters): a coloured pill glides under the active label.
//
// How the Segmented design stays truthful to the details strip
// (app/anime/[id].tsx â†’ AnimatedTabs) without breaking navigation:
//
//   â€¢ TAPS come from the library's own tab buttons â€” the same
//     PlatformPressable the Floating style uses. React Navigation owns tab
//     navigation, so a tap always switches tabs. (A previous attempt drew a
//     custom row inside the bar's background and navigated with
//     router.navigate â€” taps died and the bar stuck on Home.)
//   â€¢ The ITEMS are the labels themselves: tabBarIcon returns a Text, so the
//     library lays out four equal label columns across the bar's content box.
//   â€¢ The PILL is drawn behind those columns by SegmentedIndicator, a port of
//     the details strip's indicator: geometry computed from the measured
//     content width, jump (no spring) on first layout, withSpring on every
//     switch, identical spring constants, label-hugging width, and the label
//     inverting on top of the pill.
//
// The bar's content box is 74% of the screen (13% side padding), so the pill
// no longer runs edge to edge. The pill wrap and the indicator use the same
// padding, so their rectangles â€” and therefore the columns â€” line up exactly.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Tabs, usePathname } from 'expo-router';
// `elements` is not exported from the package entry point, but the
// `expo-router/react-navigation` subpath remains the supported import surface.
import { PlatformPressable } from 'expo-router/react-navigation';
import { Easing, StyleSheet, useWindowDimensions, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppIcon, type AppIconName } from '@/components/ui/AppIcon';
// `expo-router/js-tabs` is the supported subpath for the tab navigator types;
// the deep `build/react-navigation` paths no longer typecheck (bundler
// moduleResolution can't follow the package exports to directory imports).
import type { BottomTabNavigationOptions } from 'expo-router/js-tabs';
import type { BottomTabSceneStyleInterpolator } from 'expo-router/build/react-navigation/bottom-tabs/types';
import { useSetting } from '@/lib/settings/useSetting';
import { font, layout, radii, spacing } from '@/lib/ui/tokens';

const TAB_ROUTES = [
  { name: 'index', icon: 'home', title: 'Home' },
  { name: 'explore', icon: 'compass', title: 'Explore' },
  { name: 'search', icon: 'search', title: 'Search' },
  { name: 'schedule', icon: 'schedule', title: 'Schedule' },
] as const;

type AppTabName = (typeof TAB_ROUTES)[number]['name'];

const ICONS: Record<AppTabName, AppIconName> = {
  index: 'home',
  explore: 'compass',
  search: 'search',
  schedule: 'schedule',
};

const TITLES: Record<AppTabName, string> = {
  index: 'Home',
  explore: 'Explore',
  search: 'Search',
  schedule: 'Schedule',
};

const visibleTabs = () => TAB_ROUTES;

/**
 * Same material as the top NavBar pill: translucent near-black, hairline
 * white edge, fully rounded. The two bars are meant to read as a pair, so the
 * colours are literal rather than themed â€” the tabs always sit on video,
 * which is dark regardless of the colour scheme.
 */
const PILL_BG = 'rgba(8,8,12,0.78)';
const PILL_BORDER = 'rgba(255,255,255,0.12)';
const ACTIVE = '#ffffff';
const INACTIVE = 'rgba(255,255,255,0.5)';
const DOT_INACTIVE = 'rgba(255,255,255,0)';

/** Fraction of the screen given to each side gap â€” content is 74%. */
const SIDE_FRACTION = 0.13;
/**
 * Side padding in PIXELS, computed from the real window width.
 *
 * This used to be a `"13%"` percentage string handed to both the bar's
 * paddingHorizontal and the indicator's inset â€” but Yoga resolves percentage
 * insets on absolutely positioned children against a different base than the
 * library resolves the tab-row content box, so the indicator's measured width
 * and the icon columns' width silently disagreed. The drift scaled with the
 * screen, which read as the pill overshooting the ends and sitting off the
 * icons.
 *
 * One numeric value derived from `useWindowDimensions` is fed to BOTH â€” bar
 * padding and indicator measuring box â€” so they are the same rectangle by
 * construction, on every resolution. The component recomputes it on rotation
 * or split-screen resize.

/**
 * Label colour that sits ON the Segmented pill. The pill colour is picked in
 * settings, so the text has to be chosen per colour: dark text on light
 * pills, white text on dark ones. Same relative-luminance test the accent
 * module uses for text-on-artwork.
 */
function labelOn(accent: string): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(accent.trim());
  if (!m) return '#0a0a0f';
  const lum =
    0.2126 * parseInt(m[1], 16) + 0.7152 * parseInt(m[2], 16) + 0.0722 * parseInt(m[3], 16);
  return lum > 140 ? '#0a0a0f' : '#ffffff';
}

/** Icon-only pill. The dot is absolutely positioned, not laid out. */
const ICON_SIZE = 22;
const DOT_GAP = 5;
const DOT_H = 3;
/** Optical lift: glyphs read slightly low next to a dot below, so the icon
 * alone is nudged up; the dot stays where it is. */
const ICON_LIFT = 2;

// --- Segmented ---
/** Pill horizontal padding around the icon: 22px glyph + 16px per side â†’
 * a 54px square pill, centred in its column. */
const SEG_PILL_PAD = 16;
/** Vertical inset of the pill inside the 58px bar â†’ 50px tall. Only a few
 * pixels of the dark glass show above and below, so the pill reads as the
 * bar itself with a glyph on it. */
const SEG_INSET = 4;
/** Same spring constants as the details strip: switching feels like the pill
 * is physically moving under the labels. Module scope so it is stable. */
const SEG_SPRING = { damping: 22, stiffness: 260, mass: 0.9 };

// --- Tab switch transition -------------------------------------------------

/**
 * THE SCENES' TRANSITION, and why it is a CUSTOM INTERPOLATOR rather than
 * `animation: 'fade'` (which is what this used to be).
 *
 * `BottomTabView` hands every screen one `Animated.Value` - `progress` - which
 * is -1 for a tab to the LEFT of the focused one, 0 for the focused one and +1
 * for one to the right, and animates it toward 0 on a switch.
 * `sceneStyleInterpolator` is how that one number becomes a picture, and the
 * whole transition is two properties derived from it. Both built-in
 * interpolators derive opacity, and one of them a +/-50px shift; what is
 * different here is the SHAPE of the fade, which is the part that is actually
 * wrong in the built-ins and the part nobody can see in the source.
 *
 *   opacity     the crossfade, and it is NOT a straight line. The two scenes
 *               are SIBLINGS, not layers over an opaque backdrop: the focused
 *               one is z-0 and every other is z-(-1), so whatever NEITHER of
 *               them paints shows the scene container through. Combined coverage
 *               is `outgoing + (1 - outgoing) * incoming`, and for a linear ramp
 *               that bottoms out at 0.75 halfway through - a dark pulse through
 *               the middle of EVERY switch, on a page that is otherwise black.
 *
 *               So the middle of the curve is hoisted: it holds near 1 and only
 *               drops at the edges. That measures (see
 *               `scripts/check-crossfade.ts`) at 0.98 minimum coverage against
 *               the built-in fade's 0.75, and it does NOT cost responsiveness -
 *               the incoming screen is still half-opaque 18ms in, because the
 *               decelerating timing front-loads the whole thing. Shallow dip,
 *               fast hand-off; those normally trade against each other and here
 *               they do not.
 *
 *   translateX  a directional nudge, +/-SHIFT_NUDGE px, so the switch says which
 *               way you went. Deliberately tiny: these are the same full-bleed
 *               screens and mostly the same shape, so a large slide reads as the
 *               APP sliding rather than as a tab switching. The library's `shift`
 *               preset slides 50px, which is four times this and reads as a
 *               different app.
 *
 * NO SCALE, and this cost a wrong attempt to work out. Scaling the incoming
 * scene up from 0.98 looked like the obvious way to make a switch feel physical,
 * and it is wrong for a reason that is invisible in the source: the outgoing
 * scene gets the SAME interpolation traversed the other way, so it scales DOWN
 * as it leaves. Two screens converging on 1.0 leave a gap at the edges of both
 * of them at once, and the scene container shows through that gap. The scale
 * would have to differ per role, and the interpolator is handed one number per
 * screen with no way to ask "am I arriving or leaving?".
 *
 * NOT REPLICATED IN REANIMATED, deliberately. This is React Navigation's own
 * `Animated.Value` pipeline (BottomTabView builds it), not a Reanimated one, so
 * it runs on the native driver and needs no `useAnimatedStyle`. Wrapping the
 * scenes in an `Animated.View` of our own would mean a second animation per
 * screen fighting this one for the same properties.
 */
const SHIFT_NUDGE = 12;
const SWITCH_MS = 260;

/** The hoisted middle from the note above: opaque near progress 0, dropping at
 *  the extremes. Symmetric, because one screen travels 0 -> 1 while its partner
 *  travels 1 -> 0 through the very same interpolation. */
const FADE_INPUT = [-1, -0.92, -0.7, 0, 0.7, 0.92, 1];
const FADE_OUTPUT = [0, 0.12, 0.88, 1, 0.88, 0.12, 0];

/**
 * REDUCE MOTION: the same crossfade with the movement taken out.
 *
 * Opacity is the one property in the pair above that carries no DIRECTION. A
 * user who has asked the OS for less motion has said they do not want things
 * sliding across the screen, and a tab switch sliding twelve pixels is exactly
 * the thing they are asking not to see — while the dissolve is not, because a
 * screen becoming another screen is not motion in the sense they object to.
 *
 * So the interpolator and the duration are BOTH chosen per render rather than
 * baked in at module scope, which means they cannot live in `BASE_OPTIONS`.
 * `useReducedMotion` reads a module-level constant in Reanimated, so this is
 * decided once per process and costs no re-render and no subscription — which is
 * what makes it safe to fold into the `screenOptions` memo without reintroducing
 * the per-switch descriptor churn that memo exists to prevent.
 */
const fadeOnlyTransition: BottomTabSceneStyleInterpolator = ({ current }) => ({
  sceneStyle: {
    opacity: current.progress.interpolate({
      inputRange: FADE_INPUT,
      outputRange: FADE_OUTPUT,
    }),
  },
});

const sceneTransition: BottomTabSceneStyleInterpolator = ({ current }) => {
  const { progress } = current;
  return {
    sceneStyle: {
      opacity: progress.interpolate({
        inputRange: FADE_INPUT,
        outputRange: FADE_OUTPUT,
      }),
      transform: [
        {
          translateX: progress.interpolate({
            inputRange: [-1, 0, 1],
            outputRange: [-SHIFT_NUDGE, 0, SHIFT_NUDGE],
          }),
        },
      ],
    },
  };
};

/** Half the window, because there is no travel for the extra time to narrate. */
const REDUCED_SWITCH_MS = 130;

export default function TabLayout() {
  const insets = useSafeAreaInsets();
  const { width: screenW } = useWindowDimensions();
  const sidePad = Math.round(screenW * SIDE_FRACTION);
  // Subscribes to the one key; the bar re-renders on a style switch and
  // nothing else in the app does.
  const styleKey = useSetting('tabs.style');
  const segmented = styleKey === 'segmented';
  // Pill colour, only meaningful in Segmented mode.
  const segColor = useSetting('tabs.segmentedColor');
  // Read once per process; see the note on `fadeOnlyTransition`.
  const reducedMotion = useReducedMotion();

  const barHeight =
    layout.tabBarTopGap +
    layout.tabBarHeight +
    layout.tabBarBottomGap +
    insets.bottom;

  /**
   * THE OPTIONS OBJECTS MUST BE REFERENTIALLY STABLE. THIS IS THE TAB SWITCH.
   *
   * `screenOptions` used to be an inline arrow returning a fresh object literal,
   * built once per route per render â€” which is fine in principle and catastrophic
   * in practice here, because React Navigation derives each screen's DESCRIPTOR
   * from that object:
   *
   *   new options object  ->  new descriptor  ->  new `descriptor.render()`
   *   element  ->  every mounted screen re-renders
   *
   * And `TabLayout` re-renders on every tab switch, because `SegmentedIndicator`
   * reads `usePathname()`. So every tap of the tab bar re-rendered all five tab
   * screens â€” including TWO `HeroCarousel`s (two `expo-linear-gradient`s, an SVG
   * `GradientText` and eight `Dissolve` wrappers each) and the completed-chart
   * section â€” purely to produce an options object with identical contents.
   *
   * The symptom is the confusing one: the visual switch IS a z-index change on
   * the screen containers, and it cannot commit until React has finished that
   * re-render. So the previous page sits there looking frozen for about a second
   * and then the new page appears â€” already populated, because the data was in
   * the cache the whole time. It looks exactly like the app is "waiting for the
   * previous page", and it never was.
   *
   * The fix is to hand React Navigation the SAME object for a given route until
   * something it actually depends on changes. `useMemo` on the two things that
   * genuinely differ â€” the bar style setting and its colour â€” gives one stable
   * options object per route per setting, and a tab switch then re-renders the
   * tab bar and the one indicator and NOTHING ELSE. The switch becomes the z-index
   * change it was always supposed to be.
   */
  const screenOptions = useMemo(() => {
    // Chosen here rather than in `BASE_OPTIONS` because it depends on the OS
    // setting. Both are module-scope constants, so this is stable for the life of
    // the process and the memo below still hands React Navigation one options
    // object per route per setting — see the long note on `screenOptions`.
    const transition: BottomTabSceneStyleInterpolator = reducedMotion
      ? fadeOnlyTransition
      : sceneTransition;

    const optionsFor = (name: string, focusedTint: string) => ({
      ...BASE_OPTIONS,
      // Same function object for every tab: it reads only `progress`, which is
      // per-screen, so there is nothing route-specific for it to close over.
      sceneStyleInterpolator: transition,
      transitionSpec: {
        animation: 'timing' as const,
        config: {
          duration: reducedMotion ? REDUCED_SWITCH_MS : SWITCH_MS,
          easing: Easing.out(Easing.cubic),
        },
      },
      tabBarActiveTintColor: focusedTint,
      tabBarBackground: () => (
        <View style={styles.shield} onStartShouldSetResponder={() => true}>
          <View
            pointerEvents="none"
            style={[
              styles.pillWrap,
              {
                top: layout.tabBarTopGap,
                bottom: layout.tabBarBottomGap + insets.bottom,
                paddingHorizontal: sidePad,
              },
            ]}
          >
            <View style={styles.pill} />
            {segmented ? <SegmentedIndicator accent={segColor} sidePad={sidePad} /> : null}
          </View>
        </View>
      ),
      tabBarButton: (props: any) => (
        <PlatformPressable
          {...props}
          android_ripple={{ color: 'rgba(255,255,255,0.14)', foreground: true }}
          style={[props.style, styles.tabBtn]}
        />
      ),
      tabBarStyle: [
        styles.bar,
        {
          height: barHeight,
          paddingTop: layout.tabBarTopGap,
          paddingBottom: layout.tabBarBottomGap + insets.bottom,
          paddingHorizontal: sidePad,
        },
      ],
      tabBarIcon: ({ color, focused }: { color: string; focused: boolean }) => {
        const iconName = ICONS[name as AppTabName] ?? 'home';
        if (segmented) {
          return (
            <AppIcon
              name={iconName}
              color={focused ? labelOn(segColor) : INACTIVE}
              size={ICON_SIZE}
            />
          );
        }
        return (
          <View style={styles.iconStack}>
            <View style={styles.iconLift}>
              <AppIcon name={iconName} color={String(color)} size={ICON_SIZE} />
            </View>
            <View style={[styles.dot, focused && styles.dotActive]} />
          </View>
        );
      },
    });

    // One object per route, built ONCE per settings change and then frozen in
    // place. `tabBarActiveTintColor` is not overridden per route today, so the
    // focus tint is the same for all of them and the cache keys on route name.
    const cache = new Map<string, BottomTabNavigationOptions>();
    return (args: { route: { name: string } }) => {
      const name = args.route.name;
      const hit = cache.get(name);
      if (hit) return hit;
      const built = optionsFor(name, ACTIVE) as BottomTabNavigationOptions;
      cache.set(name, built);
      return built;
    };
    // `reducedMotion` is in the list even though it never changes: it is read
    // from a module-level constant in Reanimated, so including it costs nothing
    // and keeps the memo honest about what it actually depends on.
  }, [barHeight, insets.bottom, segmented, segColor, sidePad, reducedMotion]);

  return (
    <Tabs
      screenOptions={screenOptions}
      /**
       * `detachInactiveScreens` is a NAVIGATOR prop, not a screenOption. A
       * previous pass put it in `screenOptions`, where `BottomTabView` ignores it
       * with no warning at all:
       *
       *   const { ..., detachInactiveScreens = Platform.OS === 'web' || ... } = props
       *
       * It is now back at the library default (unset), which is deliberate after
       * going back and forth on it.
       *
       * Keeping every tab's views ATTACHED (`false`) looks like the way to avoid
       * rebuilding native views on a switch, and it was tried. It is the wrong side
       * of the trade for five screens: the platform then carries five screens'
       * worth of views in ONE hierarchy, and every focus change changes `zIndex`
       * on all of them, forcing an occlusion pass over the lot. Detaching is the
       * default precisely because five heavy screens is not something the
       * platform wants resident at once.
       *
       * What made that default affordable is that every tab's JS render and
       * layout are already done by the time anyone can tap — now built during
       * the idle window rather than at boot (see `lazy` below), so re-attaching
       * is native work only — and with the rails now `FlatList`s a screen holds
       * ~150 views instead of ~500, so re-attaching is three times cheaper than
       * it was when this was first measured.
       *
       * The lesson, since it cost two wrong attempts: the answer to "switching is
       * slow" was never a navigator flag. It was fewer views.
       */
    >
      {TAB_ROUTES.map((t) => (
        <Tabs.Screen
          key={t.name}
          // Keep the route names literal in this file: expo-router's typed
          // routes must see every declared tab screen verbatim.
          name={t.name}
          options={{
            title: TITLES[t.name],
            // Dev probe only â€” hidden from the tab bar in release builds.
            href: undefined,
          }}
        />
      ))}
    </Tabs>
  );
}

/**
 * The Segmented indicator â€” the details page's AnimatedTabs pill
 * (app/anime/[id].tsx) with ICONS instead of labels: a coloured square pill
 * that glides under the active glyph, jump on first layout and spring on
 * every switch.
 *
 * Every tab renders the same 22px glyph, so the pill has one fixed size â€”
 * icon + SEG_PILL_PAD per side â€” centred in its quarter column. No
 * measuring, no round-trips. Focus comes from `usePathname`: the navigator
 * owns the switch (its own buttons handle taps), and the pill follows the
 * route it reports â€” which also keeps it correct on back gestures and deep
 * links.
 */
function SegmentedIndicator({ accent, sidePad }: { accent: string; sidePad: number }) {
  const pathname = usePathname();

  /**
   * The visible tab list, memoised ONCE per `__DEV__` flip rather than per render.
   *
   * `visibleTabs()` is `TAB_ROUTES.filter(...)`, which returns a NEW array every
   * call â€” so as a bare call it was a fresh dependency on every render, which
   * meant the spring effect below fired on every render and kept CANCELLING AND
   * RESTARTING the animation. A spring that restarts as often as the bar renders
   * never arrives anywhere; it just re-aims. `useMemo` with `[]` gives it the
   * stable identity it needs.
   */
  const tabs = useMemo(() => visibleTabs(), []);

  const focused = useMemo<AppTabName>(() => {
    const seg = (pathname ?? '/').split('/').filter(Boolean)[0] ?? 'index';
    return (tabs.some((t) => t.name === seg) ? seg : 'index') as AppTabName;
  }, [pathname, tabs]);

  // Measured content width â€” the box the icon columns divide evenly.
  // Content is measured on layout (only once, it never changes at runtime).
  const [contentW, setContentW] = useState(0);
  const x = useSharedValue(0);
  const w = useSharedValue(0);
  const [ready, setReady] = useState(false);

  /**
   * Same rhythm as the details strip: on first layout JUMP to the focused tab
   * (nothing slides on mount); on every later change SPRING there.
   *
   * `tabs` is read through a REF rather than listed as a dependency. It is a
   * constant for the process's lifetime, so depending on it changes nothing
   * except making this effect â€” the one that starts a Reanimated animation â€”
   * re-run on every render of the tab bar.
   */
  const tabsRef = useRef(tabs);
  useEffect(() => {
    // A TRANSIENT ZERO MEASUREMENT IS NOT A NEW GEOMETRY.
    //
    // `onLayout` fires with width 0 whenever the bar lays out before it has a
    // width — which it does on a relayout, a rotation, or a pass where the bar is
    // being re-measured while its own layout is still settling. Storing that 0
    // made the next run divide by it and compute `col: NaN`, and a NaN written
    // into a Reanimated shared value does not animate — it propagates, and the
    // pill is left at a position no number explains. That is the "disappears, or
    // stuck somewhere impossible" symptom.
    //
    // So a zero is ignored outright. The previous good width stands until a real
    // one arrives, which is always: `onLayout` fires again the moment the bar has
    // a width.
    if (!contentW) return;
    const list = tabsRef.current;
    const col = contentW / list.length;
    if (!Number.isFinite(col) || col <= 0) return;
    const i = list.findIndex((t) => t.name === focused);
    if (i < 0) return;
    // Fixed square pill: icon + padding each side, centred in the column,
    // never wider than it.
    const pill = Math.min(col - spacing.sm, ICON_SIZE + SEG_PILL_PAD * 2);
    const gx = i * col + (col - pill) / 2;
    if (!Number.isFinite(pill) || !Number.isFinite(gx)) return;
    if (!ready) {
      // First placement JUMPS. A spring from x=0, w=0 would slide the pill in
      // from the left edge on every cold start, which is the one moment it must
      // not move: the bar is already correct when it first draws.
      x.value = gx;
      w.value = pill;
      setReady(true);
    } else {
      x.value = withSpring(gx, SEG_SPRING);
      w.value = withSpring(pill, SEG_SPRING);
    }
  }, [contentW, focused, ready, x, w]);

  const indicator = useAnimatedStyle(() => ({
    transform: [{ translateX: x.value }],
    width: w.value,
  }));

  return (
    // Measures the CONTENT box (see segMeasure) â€” the identical rectangle
    // the library's four equal icon columns divide.
    <View
      style={[styles.segMeasure, { left: sidePad, right: sidePad }]}
      onLayout={(e) => {
        // ZEROS ARE DROPPED AT THE SOURCE, not filtered downstream. A bar that
        // lays out before it has a width reports 0, and storing that would make
        // `col` NaN on the next run — which propagates into the shared values and
        // leaves the pill at a position no number explains. Keeping the last good
        // width is both simpler and the only version where a later real
        // measurement is guaranteed to overwrite rather than race.
        const w = e.nativeEvent.layout.width;
        if (w > 0) setContentW(w);
      }}
      pointerEvents="none"
    >
      {ready ? (
        <Animated.View
          style={[styles.segIndicator, { backgroundColor: accent }, indicator]}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    position: 'absolute',
    backgroundColor: 'transparent',
    // The default 1px top border would draw a hard line across the screen and
    // give the floating pill away.
    borderTopWidth: 0,
    elevation: 0,
    shadowOpacity: 0,
    // paddingHorizontal is supplied per-style (74% content width) in the
    // tabBarStyle array â€” it MUST match pillWrap's so the items sit inside
    // the pill rather than on its rounded ends.
  },
  // Fills the whole bar so the transparent margins and the bottom gap are
  // swallowed rather than falling through to the content behind.
  shield: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  // top/bottom/paddingHorizontal come from the render, so this box is exactly
  // the pill's box.
  pillWrap: {
    position: 'absolute',
    left: 0,
    right: 0,
  },
  pill: {
    flex: 1,
    borderRadius: radii.full,
    backgroundColor: PILL_BG,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: PILL_BORDER,
  },
  item: {
    // Clips the Android ripple. BottomTabItem hardcodes
    // `android_ripple: { borderless: true }`, and a borderless ripple is NOT
    // bounded by the view â€” it paints a free-floating circle. The library only
    // clips it for `tabBarVariant: 'material'`, and that variant THROWS unless
    // the bar is on the left or right, so it is not an option for a bottom bar.
    //
    // This works because BottomTabItem builds its outer style as
    // `[{ borderRadius, overflow }, style]` and `style` carries
    // `tabBarItemStyle` last â€” so these values win over the variant's.
    borderRadius: radii.full,
    overflow: 'hidden',
  },
  // Overrides the library button's `justifyContent: 'flex-start'` so the
  // slot is centred in the button's full height. Must be appended AFTER
  // `props.style` (see tabBarButton above) or the library's value wins.
  tabBtn: { justifyContent: 'center' },
  // Exactly the slot, nothing else. TabBarIcon applies this over its own
  // wrapperUikit (28 tall), so the slot fills the box, and the button's
  // `justifyContent: 'center'` (tabBtn above) centres THAT box in the pill.
  // One centring, no reserved space for the dot to skew.
  iconBox: { height: ICON_SIZE },
  iconStack: {
    width: ICON_SIZE,
    height: ICON_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconLift: { transform: [{ translateY: -ICON_LIFT }] },
  // Hangs in the space below the icon. Absolute + negative offset means it
  // takes part in no layout, so the centred glyph is unaffected whether it is
  // transparent (inactive) or white (active).
  dot: {
    position: 'absolute',
    bottom: -DOT_GAP - DOT_H,
    width: 14,
    height: DOT_H,
    borderRadius: radii.full,
    backgroundColor: DOT_INACTIVE,
  },
  dotActive: { backgroundColor: ACTIVE },
  // --- Segmented ---
  // THE SAME BOX the library's icon columns divide: pillWrap's content box.
  // Inset by the same NUMERIC side padding the bar uses (supplied from the
  // render â€” see SIDE_FRACTION above), so this box is pixel-identical to the
  // content box the library's icon columns divide. A percentage inset here
  // resolved against a different base than the bar's percentage padding,
  // which pushed the indicator out past the pill's rounded ends.
  segMeasure: {
    position: 'absolute',
    top: 0,
    bottom: 0,
  },
  // Glides under the active glyph; geometry comes from the measured columns.
  segIndicator: {
    position: 'absolute',
    top: SEG_INSET,
    bottom: SEG_INSET,
    left: 0,
    borderRadius: radii.full,
  },
  // Label style kept for the library (labels are hidden above via
  // `tabBarShowLabel`), so nothing drifts if labels come back.
  label: {
    fontSize: 11,
    height: 14,
    lineHeight: 14,
    fontFamily: font.medium,
    letterSpacing: 0.3,
    marginTop: spacing.xs,
  },
});

/**
 * The options every tab shares, built ONCE at module scope.
 *
 * Declared below `styles` deliberately: it reads `styles.*`, and a `const` is not
 * hoisted for initialisation, so putting it above would throw on a temporal dead
 * zone at module load. Referencing it from inside `TabLayout` is fine — function
 * bodies run long after this line.
 *
 * Module scope is the whole point. See the note on `screenOptions` in
 * `TabLayout`: React Navigation derives a screen's descriptor from its options
 * object, so a fresh object per render re-renders every mounted screen on every
 * tab switch. This one never changes identity for the lifetime of the process.
 */
const BASE_OPTIONS = {
  // See the note on the root Stack: the tab screens are hardcoded dark, and this
  // is the layer that shows through the Android gesture bar.
  sceneStyle: { backgroundColor: '#0b0b10' },
  // No native header anywhere in tabs — screens draw their own NavBar.
  headerShown: false,
  // Both designs render their own label/dot inside the icon slot, so the
  // library's label row stays off.
  tabBarShowLabel: false,
  tabBarInactiveTintColor: INACTIVE,
  // The library sizes the icon wrapper itself (ICON_SIZE_TALL = 28),
  // independently of the slot drawn inside it, so the height of the column was
  // never actually known. Pinning it to match the slot makes the group's height
  // exact, which both styles rely on for centring.
  tabBarIconStyle: styles.iconBox,
  tabBarItemStyle: styles.item,

  /**
   * `lazy` IS NOT SET — every tab is built during the idle window after launch
   * instead, by `usePreloadTabs`.
   *
   * The default `lazy: true` would leave a tab unmounted until it is first
   * tapped, and React commits before the navigator animates, so that tab's tap
   * would be: build the whole screen, THEN slide. The pause is unavoidable from
   * the navigator's side — the scene has to exist before there is anything to
   * animate.
   *
   * The previous answer was `lazy: false`, which builds every tab up front and
   * does fix the tap. It pays for it in the wrong place: five heavy screens in
   * front of the first paint, on every cold launch, including for tabs the user
   * never opens. On a low-end phone that is the whole cost of the launch, and
   * it is paid before the user has seen anything.
   *
   * `navigation.preload()` moves the identical work to the moment the JS thread
   * is idle — after the launch, one tab at a time, so no single frame carries
   * four mounts. The end state before a tap is the same, which is what makes the
   * tap the z-index change it was meant to be. See `lib/ui/usePreloadTabs.ts`.
   */

  /**
   * A TAB SWITCH IS AN ANIMATION.
   *
   * `animation: 'none'` - the default - swaps the screens on a single frame, so
   * any work the platform still has to do when focus moves is visible as the app
   * FREEZING and then snapping, with nothing in between. That is exactly the
   * "it just waits for a second" symptom, and it is why a plain cut reads as a
   * hang rather than as navigation.
   *
   * What it was before: `animation: 'fade'` at 140ms. That fixed the freeze but
   * was barely an event - five full-bleed screens dissolving through each other
   * with nothing else changing is a blink, and (see `sceneTransition` above) a
   * linear one puts a 0.25-coverage hole through the middle of every switch.
   *
   * `animation: 'shift'` rather than `'fade'` is only the SWITCH that turns the
   * interpolation on at all: `hasAnimation` reads the NAME, and the name is what
   * selects a preset to take a `sceneStyleInterpolator` from. Both that and the
   * `transitionSpec` are overridden below, so the name is otherwise inert - which
   * is why the pitch is 'shift' even though the motion is entirely our own.
   *
   * The TIMING is `timing` + `Easing.out(Easing.cubic)`, 260ms. Decelerating
   * because a switch that eases IN makes the user wait for permission to arrive:
   * with this curve the incoming screen is half-opaque 18ms in and fully legible
   * well before the window closes, so the deceleration costs nothing in
   * responsiveness. Longer than the preset's 150ms because the fade is now doing
   * less of the work and the nudge needs room to be seen at all.
   *
   * It runs on the NATIVE driver (`useNativeDriver` is true everywhere but web
   * inside `BottomTabView`), so none of this touches the JS thread - which is the
   * point, because the thing this animation is covering is native work on five
   * heavy screens, not a React render.
   *
   * `sceneStyleInterpolator` and `transitionSpec` are NOT set here - they are
   * chosen per render in `TabLayout` so they can honour reduce motion. See
   * `fadeOnlyTransition`.
   */
  animation: 'shift',
  // A tab you left scrolled halfway down and come back to should be where you
  // left it. React Navigation resets a tab's stack on re-entry, which here means
  // jumping to the top of a 300-row schedule for no reason.
  popToTopOnBlur: false,

  /**
   * NO `freezeOnBlur`, AND `enableFreeze()` IS CALLED NOWHERE.
   *
   * react-freeze suspends a screen's renders and re-runs its whole tree
   * synchronously on thaw, so every switch paid a full re-render of ~80 poster
   * tiles. It trades a small background cost for a large foreground one, which is
   * exactly backwards for this complaint.
   *
   * The background work it was meant to stop is stopped at the source and for
   * free: `HeroCarousel`'s autoplay and `useNow`'s clock both call
   * `navigation.isFocused()` inside their timer, so an unfocused tab costs one
   * function call per tick and NO render at all
   * (`lib/ui/useIsFocusedNow.ts`).
   *
   * NOT SET HERE, AND DELIBERATELY SO: any fetch or prefetch in a focus effect.
   * See the note in `app/(tabs)/index.tsx` for how that went wrong twice.
   */
} as const;
