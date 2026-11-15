// Subtitle appearance — the numbers behind `subs.size`, `subs.position` and
// `subs.background`.
//
// NO IMPORTS, DELIBERATELY, for the same reason `lib/player/scrub.ts` has none:
// `scripts/check-subtitles.ts` runs this under plain `tsx` with no React Native
// and no Expo. The rules below are the ones that are easy to get subtly wrong
// and impossible to see in a screenshot, so they are asserted rather than hoped
// for.
//
// ═══════════════════════════════════════════════════════════════════════════
// THE ONE RULE: THE DEFAULTS ARE PINNED, AND EVERY MOVE IS DELIBERATE
// ═══════════════════════════════════════════════════════════════════════════
//
// `SubtitleOverlay.tsx` hardcoded `fontSize: 16`, `bottom: 48` and
// `backgroundColor: 'rgba(0,0,0,0.65)'` with `padding 10/4` and `radius 4`,
// and its own header admitted it was "fully styleable later". Turning those into
// settings is only safe if a user who touches NOTHING gets exactly what they
// got before — otherwise the feature ships with a silent visual change attached
// to it, and every "the subtitles look different" report has no cause anyone can
// point at. So `'plate'` is still the same box and `'default'` keeps its
// placement.
//
// THE SIZE IS THE ONE DEFAULT THAT WAS MOVED ON PURPOSE: it is now `'big'`
// (20pt), a step up from the 18pt this settled on before — 16/18pt is small on
// a phone, and "make 20px the default" was the explicit ask. The rest of the
// ladder is untouched, so anyone who wants it smaller still can. Every other
// key in `DEFAULT_SUBTITLE_STYLE_KEYS` is byte-identical to the old overlay, and
// `check-subtitles.ts` asserts the whole object.

export type SubtitleSize =
  | 'tiny'
  | 'small'
  | 'medium'
  | 'normal'
  | 'big'
  | 'large'
  | 'xlarge'
  | 'huge';
export type SubtitlePosition = 'custom' | 'default';
export type SubtitleBackground = 'plate' | 'shadow' | 'plain';
export type SubtitleColor =
  | 'white'
  | 'yellow'
  | 'green'
  | 'cyan'
  | 'magenta';

/**
 * Text size, in points, and the line height that goes with it.
 *
 * `lineHeight` is NOT left to the platform. RN picks a default leading from the
 * font's metrics, and the text sits on a plate whose height is derived from it —
 * so an unset line height makes the box height depend on which font actually
 * loaded. Stating it means the plate is the same height on every device.
 */
export const SUBTITLE_TYPEGRAPHY: Record<SubtitleSize, { fontSize: number; lineHeight: number }> = {
  tiny: { fontSize: 12, lineHeight: 16 },
  small: { fontSize: 14, lineHeight: 19 },
  medium: { fontSize: 16, lineHeight: 22 },
  normal: { fontSize: 18, lineHeight: 24 },
  big: { fontSize: 20, lineHeight: 27 },
  large: { fontSize: 22, lineHeight: 29 },
  xlarge: { fontSize: 26, lineHeight: 34 },
  huge: { fontSize: 30, lineHeight: 39 },
};

/**
 * The fraction a saved custom position starts from (see `SUBTITLE_EDGE`).
 *
 * Seeds only the custom slider's first drag when nothing is stored yet; it is
 * deliberately near the bottom edge rather than mirroring the default preset —
 * the slider's 0% is "the bottom of the picture", a lower place than the
 * default's `SUBTITLE_DEFAULT_FRAC`.
 */
export const DEFAULT_POSITION_FRAC = 0;

/**
 * The lowest a CUSTOM cue may sit: points between its box and the container's
 * bottom edge.
 *
 * NOT zero on purpose. A cue whose bottom edge is the container's bottom edge
 * has its second line of a two-line cue touching the screen border, and on a
 * device with a rounded corner it is clipped by it.
 */
export const SUBTITLE_EDGE = 16;

/**
 * The gap under the top chrome (or the container's top edge) that a custom cue
 * may not cross at 100%, in points.
 */
export const SUBTITLE_TOP_GAP = 8;

/**
 * Where the DEFAULT preset sits: `SUBTITLE_DEFAULT_FRAC` of the same measured
 * band the custom slider walks — i.e. the slider's own 10%.
 *
 * It is NOT the bar's measured height any more, and that is the device's
 * verdict (9 Nov): the bar-height default meant "clear the timeline", but the
 * bar is ~157pt on a ~411pt landscape frame — 38% UP the picture — so with the
 * chrome auto-hidden (nearly all of the time) the untouched default floated in
 * the lower middle, "already centred at 0%". The cost of the low placement is
 * honest and transient: while the controls are up, a cue this low sits BEHIND
 * the timeline — exactly as a 0% custom cue may ("the chrome is an overlay;
 * the subtitle is part of the video"). Being the slider's own number also
 * keeps the modes from drifting: 'default' IS 'custom' at this fraction, and
 * `scripts/check-subtitles.ts` asserts that as an equality.
 */
export const SUBTITLE_DEFAULT_FRAC = 0.1;

/**
 * The opaque-ish plate the original overlay drew behind each line.
 *
 * `rgba(0,0,0,0.65)` rather than a solid colour because subtitles sit on
 * arbitrary video, and a fully opaque box draws a black bar across every bright
 * frame. Kept byte-identical to the old default for the reason in the header.
 */
export const SUBTITLE_PLATE = {
  backgroundColor: 'rgba(0,0,0,0.65)',
  paddingHorizontal: 10,
  paddingVertical: 4,
  borderRadius: 4,
} as const;

/**
 * The no-box treatment: a soft drop shadow behind the glyphs instead of a
 * rectangle. On a dark scene it reads as cleaner; on a bright one it is harder
 * to read than a plate, which is why it is not the default.
 */
export const SUBTITLE_SHADOW = {
  textShadowColor: 'rgba(0,0,0,0.9)',
  textShadowOffset: { width: 0, height: 2 },
  textShadowRadius: 4,
} as const;

/**
 * Text colours for the subtitle glyphs.
 *
 * White is the default and the only one that existed before this module. The
 * others are common subtitle colours from real players — yellow reads well over
 * most scenes, green and cyan are high-contrast against dark video, magenta is
 * mainly for people who like their subs to stand out.
 *
 * These are glyph colours, not plate colours. The plate stays the same dark
 * translucent box regardless of text colour — changing both at once would be a
 * second axis no one asked for, and a plate that lightens to match yellow text
 * would be illegible over a bright scene.
 */
export const SUBTITLE_COLORS: Record<SubtitleColor, string> = {
  white: '#ffffff',
  yellow: '#fff5a0',
  green: '#88ff88',
  cyan: '#88ffee',
  magenta: '#ff88ff',
};

export interface ResolvedSubtitleStyle {
  fontSize: number;
  lineHeight: number;
  /**
   * WHICH placement to use. Carried through because the two modes read the
   * fraction differently: 'default' ignores it and sits on the measured bar,
   * 'custom' spans the picture. `subtitleBottomOffset` is the only thing that
   * may decide this, and it needs to see the mode.
   */
  position: SubtitlePosition;
  /** Fraction of the custom band from the bottom (0 = bottom edge, 1 = top). */
  positionFrac: number;
  /** Which treatment was asked for — carried through for the settings preview. */
  background: SubtitleBackground;
  /** Box behind the text, or null for the shadow/plain treatments. */
  plate: typeof SUBTITLE_PLATE | null;
  /** Drop shadow, or null when a plate is drawn instead. */
  shadow: typeof SUBTITLE_SHADOW | null;
  /** Glyph colour. */
  color: string;
}

/**
 * The keys that reproduce the pre-settings overlay exactly.
 *
 * Typed as the FULL unions rather than `as const`. `as const` would give
 * `background` the literal type `'plate'`, and since the fallback argument is
 * what infers the key type in `resolveSubtitleStyle`'s `pick` helper, every
 * comparison below would then be narrowed to "always false" — the shadow and
 * plain treatments would still be reachable at runtime and would fail to
 * type-check, or worse, would be quietly deleted by a future cleanup. The
 * annotation is what stops the compiler from doing that.
 */
export const DEFAULT_SUBTITLE_STYLE_KEYS: {
  size: SubtitleSize;
  position: SubtitlePosition;
  positionFrac: number;
  background: SubtitleBackground;
  color: SubtitleColor;
} = {
  size: 'big',
  position: 'default',
  positionFrac: DEFAULT_POSITION_FRAC,
  background: 'plate',
  color: 'white',
};

const SUBTITLE_BACKGROUNDS_ARE: Record<SubtitleBackground, true> = {
  plate: true,
  shadow: true,
  plain: true,
};

const SUBTITLE_COLORS_ARE: Record<SubtitleColor, true> = {
  white: true,
  yellow: true,
  green: true,
  cyan: true,
  magenta: true,
};

function pick<K extends string, V>(
  table: Record<K, V>,
  key: unknown,
  fallback: K
): K {
  return typeof key === 'string' && key in table ? (key as K) : fallback;
}



/**
 * The four preferences become one style object.
 *
 * Every key is CLAMPED through its registry rather than indexed directly. The
 * settings bag is a JSON blob on disk: a key can arrive absent (an app version
 * that predates this one), null (hand-edited), or a value from a renamed union.
 * `SubtitleOverlay` is a leaf that renders on every cue change, so an
 * `undefined` here would be a `NaN` font size and an invisible subtitle — which
 * looks identical to a source that ships no subtitles at all. Degrading to the
 * default here is the same belt-and-braces move `clampTolerance` makes in
 * `lib/player/scrub.ts`.
 */
export function resolveSubtitleStyle(opts: {
  size: SubtitleSize | string | undefined;
  position: SubtitlePosition | string | undefined;
  positionFrac: number | string | undefined;
  background: SubtitleBackground | string | undefined;
  color: SubtitleColor | string | undefined;
}): ResolvedSubtitleStyle {
  // The annotations are load-bearing. Without them TypeScript infers each key as
  // `DEFAULT_SUBTITLE_STYLE_KEYS`'s literal — `'big'`, `'default'`, `0`,
  // `'plate'`, `'white'` — and the whole rest of the function silently loses the
  // other options of every union while still type-checking.
  const size: SubtitleSize = pick(SUBTITLE_TYPEGRAPHY, opts.size, DEFAULT_SUBTITLE_STYLE_KEYS.size);
  const position: SubtitlePosition = pick(
    { default: true, custom: true },
    opts.position,
    DEFAULT_SUBTITLE_STYLE_KEYS.position
  );
  // Default mode ignores the stored custom fraction. Without this the preview
  // (which passes undefined when default) and the player (which always passed
  // the stored frac) could disagree — low selected, centre shown.
  const positionFrac = position === 'custom' ? clampFrac(opts.positionFrac) : DEFAULT_POSITION_FRAC;
  const background: SubtitleBackground = pick(
    SUBTITLE_BACKGROUNDS_ARE,
    opts.background,
    DEFAULT_SUBTITLE_STYLE_KEYS.background
  );
  const color: SubtitleColor = pick(SUBTITLE_COLORS_ARE, opts.color, DEFAULT_SUBTITLE_STYLE_KEYS.color);
  const { fontSize, lineHeight } = SUBTITLE_TYPEGRAPHY[size];
  return {
    fontSize,
    lineHeight,
    position,
    positionFrac,
    background,
    color: SUBTITLE_COLORS[color],
    plate: background === 'plate' ? SUBTITLE_PLATE : null,
    // 'plain' is genuinely plain: neither a box nor a shadow. It is the option
    // for someone whose video is already high-contrast enough, and it has to be
    // reachable or 'shadow' is just 'plain' with extra steps.
    shadow: background === 'shadow' ? SUBTITLE_SHADOW : null,
  };
}

/**
 * Where the cue box's BOTTOM edge sits, in points above the container's bottom
 * edge — the one place the vertical placement is decided.
 *
 * It lives here, in a module with no imports, because the arithmetic is the part
 * that was wrong twice over and a screenshot cannot tell you which numbers
 * produced it:
 *
 *   - THE BAND IS MEASURED FROM THE CONTAINER, not from the window. The overlay
 *     measures itself (`onLayout`) and passes that height in. It used to be
 *     handed `winH - barH - insets.top - TOP_BAR_TOTAL` and then subtract the bar
 *     AGAIN here, so on a landscape phone the whole slider range collapsed to
 *     `411 - 157 - 80 - 157 = 17pt`: the bar floated at 157 (38% up a landscape
 *     frame, which reads as "already in the middle" with the chrome hidden) and
 *     100% moved it 17pt, i.e. never.
 *   - THE TOP END IS CAPPED BY THE CUE'S OWN HEIGHT. `bottom = ... * frac` alone
 *     puts 100% at the container's top edge, so a two-line cue at "100%" is half
 *     off the screen and "Top" stops being reachable — the exact report that
 *     produced this function. The ceiling is `stageH - topH - cueH - gap`: at
 *     100% the cue's TOP edge sits just under the top chrome, fully visible.
 *
 * BOTH PRESETS WALK THE SAME BAND. 'custom' spans `[SUBTITLE_EDGE, ceiling]`
 * by the stored fraction; 'default' is that band at `SUBTITLE_DEFAULT_FRAC`,
 * so a viewer who never opens settings and one who drags to 10% see the same
 * cue. They used to be two formulas — the default was the bar's measured
 * height — and that difference is what made the untouched placement float a
 * third of the way up the frame with the chrome hidden.
 *
 * Nothing here may read whether the chrome is showing: the cue is part of the
 * video, and a cue that moves when the controls auto-hide cannot be read.
 */
export function subtitleBottomOffset(opts: {
  position: SubtitlePosition;
  positionFrac: number;
  /** The overlay's own measured height. */
  stageH: number;
  /** Chrome above the picture (top bar + safe-area inset); the cap at 100%. */
  topH: number;
  /** The cue box's measured height, so 100% keeps every line on screen. */
  cueH: number;
}): number {
  const px = (v: number) => (Number.isFinite(v) ? Math.max(0, v) : 0);
  const stageH = px(opts.stageH);
  const cueH = px(opts.cueH);
  const topH = px(opts.topH);
  // Never below the floor, even when the chrome alone is taller than the frame
  // (a tiny window, a huge inset): a negative band would invert the slider.
  const floor = Math.min(SUBTITLE_EDGE, stageH);
  const ceiling = Math.max(floor, stageH - topH - cueH - SUBTITLE_TOP_GAP);
  // 'custom' obeys the stored fraction wherever it is; 'default' is the
  // band's built-in fraction and deliberately reads NOTHING from the store.
  const frac = opts.position === 'custom' ? clampFrac(opts.positionFrac) : SUBTITLE_DEFAULT_FRAC;
  return floor + (ceiling - floor) * frac;
}

/**
 * Clamp a position fraction to [0, 1].
 *
 * A value outside that range would place subs off-screen, which is the
 * "top is out of screen" bug you reported. This is the belt-and-braces that
 * stops a corrupt/old stored value from doing that.
 */
function clampFrac(v: number | string | undefined): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : DEFAULT_POSITION_FRAC;
  return Math.max(0, Math.min(1, n));
}

/**
 * The style used when nothing has been read from the store yet.
 *
 * Exists so the parked `VerticalPlayerScreen` — which is not routed and never
 * hydrates settings — keeps rendering exactly what it rendered before this
 * module existed, rather than becoming the one screen whose subtitles silently
 * change when the file is next read.
 */
export function defaultSubtitleStyle(): ResolvedSubtitleStyle {
  return resolveSubtitleStyle(DEFAULT_SUBTITLE_STYLE_KEYS);
}