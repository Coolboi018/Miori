// Cover colour -> a usable accent for text on a dark scrim.
//
// AniList exposes a server-computed dominant colour per cover
// (`coverImage.color`), which is far more reliable than extracting a palette
// on-device: no image decode, no extra dependency, no async flash, and it is
// cached with the query. The raw value still needs two corrections before it
// can go near text:
//
//   1. It is bare hex WITHOUT a leading '#' ("519ac2"). Passing that straight
//      to a colour prop renders as black.
//   2. Cover art skews dark — and the app already puts a dark scrim over it.
//      A near-black accent would render the top of a gradient title invisible,
//      i.e. the feature would look broken rather than subtle.
//
// So the hue is kept and only the *lightness* is lifted, to a floor. That
// preserves "coloured like the poster" while guaranteeing the text stays
// readable on `#0b0b10`/`#0a0a0f` backgrounds.

/**
 * Floor for HSL lightness. Below this the accent is too close to the scrim
 * to read as a colour, and the gradient's first stop would effectively
 * disappear.
 */
const MIN_LIGHTNESS = 0.5;

/** Used when AniList has no colour for a cover. Matches the app's dark UI. */
export const FALLBACK_ACCENT = '#c9d4e6';

const HEX3 = /^#?([0-9a-f])([0-9a-f])([0-9a-f])$/i;
const HEX6 = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** sRGB channel -> linear, for a luminance that actually matches the eye. */
function toLinear(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

export function relativeLuminance(r: number, g: number, b: number): number {
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

type Rgb = [number, number, number];

function rgbToHsl([r, g, b]: Rgb): [number, number, number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;
  const l = (max + min) / 2;
  if (d === 0) return [0, 0, l];
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
  else if (max === gn) h = ((bn - rn) / d + 2) / 6;
  else h = ((rn - gn) / d + 4) / 6;
  return [h, s, l];
}

function hueToRgb(p: number, q: number, t: number): number {
  let x = t;
  if (x < 0) x += 1;
  if (x > 1) x -= 1;
  if (x < 1 / 6) return p + (q - p) * 6 * x;
  if (x < 1 / 2) return q;
  if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
  return p;
}

function hslToRgb([h, s, l]: [number, number, number]): Rgb {
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [
    Math.round(hueToRgb(p, q, h + 1 / 3) * 255),
    Math.round(hueToRgb(p, q, h) * 255),
    Math.round(hueToRgb(p, q, h - 1 / 3) * 255),
  ];
}

function parseHex(raw: string): Rgb | null {
  const s = raw.trim();
  const m6 = HEX6.exec(s);
  if (m6) {
    return [
      parseInt(m6[1], 16),
      parseInt(m6[2], 16),
      parseInt(m6[3], 16),
    ];
  }
  const m3 = HEX3.exec(s);
  if (m3) {
    return [
      parseInt(m3[1] + m3[1], 16),
      parseInt(m3[2] + m3[2], 16),
      parseInt(m3[3] + m3[3], 16),
    ];
  }
  return null;
}

function toHex([r, g, b]: Rgb): string {
  return `#${[r, g, b]
    .map((c) => clamp(Math.round(c), 0, 255).toString(16).padStart(2, '0'))
    .join('')}`;
}

/**
 * Normalise an AniList `coverImage.color` into a readable `#rrggbb`.
 * Returns null for anything unparseable so callers can fall back themselves.
 *
 * The hue is preserved and only HSL *lightness* is raised to a floor. An
 * earlier version scaled the RGB channels by a single factor, which is wrong
 * twice over: pure black has zero luminance so nothing lifted at all, and a
 * near-black cover like `0a0a14` overshot every channel straight to 255 —
 * returning pure white, i.e. the same colour as the gradient's last stop, so
 * the gradient vanished. Working in HSL is bounded on both sides.
 */
export function liftCoverColor(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const rgb = parseHex(raw);
  if (!rgb) return null;
  if (rgb.some(Number.isNaN)) return null;

  const [h, s, l] = rgbToHsl(rgb);
  if (l >= MIN_LIGHTNESS) return toHex(rgb);
  return toHex(hslToRgb([h, s, MIN_LIGHTNESS]));
}

/** `liftCoverColor` with a caller-supplied default. */
export function coverAccent(raw: string | null | undefined, fallback = FALLBACK_ACCENT): string {
  return liftCoverColor(raw) ?? fallback;
}

/**
 * The cover colour *mixed into the page colour* — the placeholder plate a
 * poster tile shows before its image arrives.
 *
 * Deliberately the opposite correction to `coverAccent`: that one lifts
 * lightness so text stays readable ON artwork, this one pulls the colour
 * TOWARDS the background so a screen full of empty tiles never flashes a wall
 * of saturated poster colours while the rail streams in. The hue still shows,
 * so the grid reads as "loading the show you asked for" rather than "grey
 * boxes". Pure arithmetic — no decode, no async, no dependency.
 *
 * `strength` is the weight of the cover colour (0 = page, 1 = raw cover).
 * Returns null when either side is unparseable, so the caller can fall back
 * to its own elevated-surface colour.
 */
export function coverPlate(
  raw: string | null | undefined,
  background: string,
  strength = 0.42
): string | null {
  const cover = raw ? parseHex(raw) : null;
  const bg = parseHex(background);
  if (!cover || !bg) return null;
  if (cover.some(Number.isNaN) || bg.some(Number.isNaN)) return null;
  const mix = (i: number) => Math.round(bg[i] + (cover[i] - bg[i]) * strength);
  return toHex([mix(0), mix(1), mix(2)]);
}
