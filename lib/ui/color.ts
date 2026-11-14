// Colour maths that no single component should own.
//
// Split out of `MediaListSection`, which had its own private `alpha()` and
// would have been the second copy once `SectionHeader` needed one too.
//
// Kept out of `./tokens` for the same reason that file has no imports: that
// module is pure DATA so a dev script can read it without a React Native
// transform, and this module is pure LOGIC so it stays equally importable
// from a component, a script, or the extension loader.

/**
 * `#rrggbb` (or `#rgb`) → `rgba(r, g, b, a)` so a scrim, a fade or a hairline
 * can be built from the *theme* colour instead of a second hardcoded value —
 * interpolating a light theme towards `transparent` greys it, this does not.
 *
 * Unparseable input returns `transparent` rather than an opaque guess.
 * Callers here pass palette hexes, so this is a guard, not a code path.
 */
export function alpha(hex: string, a: number): string {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return 'transparent';
  const h = m[1].length === 3 ? m[1].split('').map((c) => c + c).join('') : m[1];
  const n = parseInt(h, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}
