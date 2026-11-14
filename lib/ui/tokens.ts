// Design tokens — the single source of truth for every visual value in the app.
//
// Ported from the website's `src/app.css` so the phone and the site read as
// one product. Before this file, every screen hardcoded its own hex values
// (`#0b0b10`, `#15151d`, `#888`…) and they had already drifted apart.
//
// Rules:
//  - Scales (spacing/radii/type/motion) are theme-independent.
//  - Only genuinely semantic colours vary by theme. A raw grey never appears
//    in a screen; use `text.secondary`, not a hex.
//  - Everything is a plain number, because React Native has no CSS custom
//    properties. `theme.color.x` rather than `theme.x` keeps it greppable.
//
// This module is deliberately PURE DATA — it imports nothing. The hook lives
// in `./useTheme`. That keeps the values importable from plain Node (the dev
// scripts, and the extension loader to come), and stops a design decision from
// dragging React Native's Flow-typed source through a Node transform.

// ---------------------------------------------------------------------------
// Scales — same in both themes
// ---------------------------------------------------------------------------

/** 4pt base. Mirrors --space-* on the site. */
export const spacing = {
  none: 0,
  xxs: 2,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
  huge: 40,
  giant: 48,
  massive: 64,
} as const;

/** Mirrors --radius-*. `full` is for pills and avatars. */
export const radii = {
  none: 0,
  sm: 6,
  md: 8,
  lg: 12,
  xl: 16,
  full: 9999,
} as const;

/**
 * The app's typeface, as `fontFamily` values.
 *
 * These strings must match the keys passed to `useFonts` in `app/_layout.tsx`,
 * which is what actually pulls the TTFs in. The `_400Regular` naming is the
 * React Native community convention and keeps the weight readable at the call
 * site. Use these as `fontFamily`, never as `fontWeight`.
 *
 * Declared before `type` because `type` reads it at module scope.
 */
export const font = {
  regular: 'Montserrat_400Regular',
  medium: 'Montserrat_500Medium',
  semibold: 'Montserrat_600SemiBold',
  bold: 'Montserrat_700Bold',
  /** Monospace, for tokens, URLs and log output. */
  mono: 'SpaceMono',
} as const;

/**
 * Type scale. RN needs numeric line heights — there is no unitless line-height,
 * so each entry carries its own rather than a multiplier.
 *
 * Every entry names a Montserrat family rather than setting `fontWeight`. RN
 * only synthesises/selects weights for the *system* font; with a custom family
 * the weight has to be baked into the file you load, so the family name is what
 * carries it. See `font` above.
 */
export const type = {
  xs: { fontFamily: font.regular, fontSize: 12, lineHeight: 16 },
  sm: { fontFamily: font.regular, fontSize: 14, lineHeight: 20 },
  base: { fontFamily: font.regular, fontSize: 16, lineHeight: 24 },
  lg: { fontFamily: font.semibold, fontSize: 18, lineHeight: 26 },
  xl: { fontFamily: font.semibold, fontSize: 20, lineHeight: 28 },
  xxl: { fontFamily: font.bold, fontSize: 24, lineHeight: 32 },
  title: { fontFamily: font.bold, fontSize: 28, lineHeight: 36 },
} as const;

/** Durations in ms. Mirrors --transition-*. */
export const motion = {
  fast: 150,
  normal: 250,
  slow: 350,
  /** Control auto-hide in the player. */
  controlsHide: 3000,
} as const;

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

/**
 * Colour roles. Written out rather than inferred: without this the palettes
 * below keep literal types (`bg.primary` is literally `"#0a0a0f"`), and the two
 * themes stop being assignable to each other. Annotating also documents the
 * contract — a screen may only reach for a role listed here.
 */
export type Palette = {
  bg: {
    primary: string;
    surface: string;
    surfaceHover: string;
    elevated: string;
    /** Scrims behind modals and the player overlay. */
    overlay: string;
    /** Subtitles sit on arbitrary video, so they get their own plate. */
    scrim: string;
  };
  text: {
    primary: string;
    secondary: string;
    muted: string;
    /** Text sitting directly on artwork. */
    onMedia: string;
  };
  accent: {
    base: string;
    hover: string;
    muted: string;
    glow: string;
  };
  /**
   * The "liked" state, and the ONLY saturated colour in the app.
   *
   * It is a separate group rather than another entry under `accent` because it is
   * not a theme accent and must never be themed as one: `accent.base` is white in
   * dark and near-black in light, because the app's accent IS its text colour, and
   * an "on" state that recoloured with the theme would stop reading as "on" in
   * light mode. A filled heart is also the one place a monochrome palette needs
   * colour to carry meaning — an outlined-versus-filled pair is legible in greyscale
   * only if you already know what it means.
   *
   * `on` is fixed at white in BOTH themes on purpose. It is drawn on top of a
   * saturated `base`, where contrast is set by the fill and not by the theme, so
   * deriving it from `text.primary` would put near-black on red in light mode.
   */
  like: {
    base: string;
    /** A quiet tint, for a heart sitting on artwork where a filled plate is too loud. */
    muted: string;
    /** Content drawn ON a filled `base` plate. */
    on: string;
  };
  border: {
    muted: string;
    strong: string;
  };
  /** Named by meaning, not hue. */
  status: {
    success: string;
    warning: string;
    danger: string;
    info: string;
  };
};

/**
 * Dark is the primary theme — the app is a video player, and the site's dark
 * palette is the one that was actually designed.
 */
const dark: Palette = {
  bg: {
    primary: '#0a0a0f',
    surface: '#16161d',
    surfaceHover: '#1f1f28',
    elevated: '#1c1c24',
    /** For scrims behind modals and the player overlay. */
    overlay: 'rgba(0, 0, 0, 0.7)',
    /** Subtitles sit on video, which can be any colour — they get a plate. */
    scrim: 'rgba(0, 0, 0, 0.55)',
  },
  text: {
    primary: '#ffffff',
    secondary: '#a0a0b0',
    muted: '#6b6b78',
    /** For text sitting directly on artwork. */
    onMedia: '#ffffff',
  },
  accent: {
    base: '#ffffff',
    hover: '#e0e0e0',
    muted: 'rgba(255, 255, 255, 0.1)',
    glow: 'rgba(255, 255, 255, 0.15)',
  },
  like: {
    base: '#f43f5e',
    muted: 'rgba(244, 63, 94, 0.16)',
    on: '#ffffff',
  },
  border: {
    muted: 'rgba(255, 255, 255, 0.08)',
    strong: 'rgba(255, 255, 255, 0.2)',
  },
  /** Status colours. Named by meaning, not hue. */
  status: {
    success: '#4ade80',
    warning: '#fbbf24',
    danger: '#f87171',
    info: '#60a5fa',
  },
};

const light: Palette = {
  bg: {
    primary: '#f2f2f5',
    surface: '#ffffff',
    surfaceHover: '#e9e9ef',
    elevated: '#e6e6ec',
    overlay: 'rgba(20, 20, 26, 0.45)',
    scrim: 'rgba(0, 0, 0, 0.55)',
  },
  text: {
    primary: '#14141a',
    secondary: '#5a5a68',
    muted: '#8a8a97',
    onMedia: '#ffffff',
  },
  accent: {
    base: '#14141a',
    hover: '#2a2a33',
    muted: 'rgba(0, 0, 0, 0.07)',
    glow: 'rgba(0, 0, 0, 0.08)',
  },
  // A step darker than dark mode's. Light mode has more competing luminance, so
  // the same rose washes out against a white page and the "on" state stops
  // separating from "off" at a glance.
  like: {
    base: '#e11d48',
    muted: 'rgba(225, 29, 72, 0.12)',
    on: '#ffffff',
  },
  border: {
    muted: 'rgba(0, 0, 0, 0.09)',
    strong: 'rgba(0, 0, 0, 0.18)',
  },
  status: {
    success: '#16a34a',
    warning: '#d97706',
    danger: '#dc2626',
    info: '#2563eb',
  },
};

/**
 * Shadows. Android uses `elevation` and ignores the iOS shadow* props; iOS
 * ignores `elevation`. Both have to be set or the card looks flat on one
 * platform and wrong on the other.
 */
export const shadows = {
  none: { elevation: 0 },
  sm: {
    elevation: 2,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.2,
    shadowRadius: 2,
  },
  md: {
    elevation: 6,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
  },
  lg: {
    elevation: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.4,
    shadowRadius: 16,
  },
} as const;

/** Tab bar / navbar height, so screens can pad without guessing. */
export const layout = {
  /**
   * The floating tab pill and the gaps around it.
   *
   * `tabBarHeight` is the PILL itself, not the bar container. Keeping the pill
   * and the row of tab items in the identical box is what makes centring the
   * items exact rather than approximate.
   *
   * `tabBarBottomGap` is explicit rather than folded into the safe-area inset
   * because `insets.bottom` is 0 on devices with no home indicator (and in
   * Expo Go), which left the pill sitting almost on top of the system nav bar.
   */
  tabBarHeight: 58,
  tabBarTopGap: 4,
  tabBarBottomGap: 8,
  /**
   * The nav bar's CONTROL ROW — the avatar and the icon circles. This is the
   * real height of the bar's furniture.
   *
   * It lives here, and not in `NavBar.tsx`, for a structural reason: both the
   * bar and the search omnibox build a row from this number, and the omnibox is
   * rendered BY the bar. Keeping the constant in the bar made
   * `NavBar → SearchOmnibox → NavBar`, a require cycle. `tokens.ts` imports
   * nothing, so it can never be part of one.
   *
   * `useNavOffset()` is derived from it, which means every screen's content
   * offset moves if this moves.
   */
  navbarRowHeight: 44,
  /**
   * LEGACY — the old full-width app-bar pill, kept only as a scroll-offset
   * estimate by explore's "jump to browse". It is NOT the bar's height; see
   * `navbarRowHeight`. Do not use it for layout.
   */
  navbarHeight: 56,
  /** Artwork is 2:3. Pre-sizing containers is what stops the grid jumping. */
  posterRatio: 2 / 3,
  bannerRatio: 16 / 9,
  /** Screens that must clear the notch. */
  gutter: spacing.lg,
} as const;

// ---------------------------------------------------------------------------
// Theme access
// ---------------------------------------------------------------------------

const oled: Palette = {
  ...dark,
  bg: {
    ...dark.bg,
    primary: '#000000',
    surface: '#0a0a0a',
    surfaceHover: '#141414',
    elevated: '#0f0f0f',
  },
};

export const themes = { dark, light, oled } as const;
export type ThemeName = keyof typeof themes;

/** Every value RN's `useColorScheme()` is allowed to return, plus null/undefined. */
export type RawColorScheme = 'light' | 'dark' | 'unspecified' | null | undefined;

/**
 * Single place that turns a raw colour scheme into a theme name.
 *
 * The old helper only compared against `'unspecified'`, so the far more common
 * `null` (system hasn't decided yet — first launch, or an emulator) fell
 * straight through and `Colors[null]` was `undefined`. This has an answer for
 * every input, and defaults to dark because the app is video-led and a light
 * flash on first launch is worse than a dark one.
 */
export function resolveThemeName(scheme: RawColorScheme): 'dark' | 'light' {
  return scheme === 'light' ? 'light' : 'dark';
}

/** Non-hook palette access, for module-scope constants and StyleSheet.create. */
export function paletteFor(name: ThemeName = 'dark'): Palette {
  return themes[name];
}

