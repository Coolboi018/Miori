// Throwaway sanity check for the token scales. Run with:
//   npx tsx scripts/check-tokens.ts
// Not part of the app bundle; delete once the design system has settled.
import {
  layout,
  motion,
  paletteFor,
  radii,
  resolveThemeName,
  shadows,
  spacing,
  themes,
  type,
} from '../lib/ui/tokens';

const problems: string[] = [];

function walk(node: unknown, path: string, theme: string) {
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    const p = `${path}.${k}`;
    if (v && typeof v === 'object') walk(v, p, theme);
    else if (typeof v !== 'string' || !v) problems.push(`${theme}${p} = ${JSON.stringify(v)}`);
  }
}

for (const [name, palette] of Object.entries(themes)) walk(palette, 'color', name);

const nonMonotonic = Object.entries(spacing).filter(
  ([, a], i, all) => i > 0 && a < (all[i - 1][1] as number)
);

console.log('palettes      :', Object.keys(themes).join(', '));
console.log(
  'scheme resolve:',
  ['light', 'dark', null, undefined, 'unspecified']
    .map((s) => `${String(s)}->${resolveThemeName(s as never)}`)
    .join('  ')
);
console.log('scale sizes   :', {
  spacing: Object.keys(spacing).length,
  radii: Object.keys(radii).length,
  type: Object.keys(type).length,
  motion: Object.keys(motion).length,
  shadows: Object.keys(shadows).length,
});
console.log('dark bg       :', themes.dark.bg.primary, '| light bg:', themes.light.bg.primary);
console.log('palettes differ:', themes.dark.bg.primary !== themes.light.bg.primary);
console.log('paletteFor() ok:', paletteFor('light').text.primary);
console.log('poster ratio  :', layout.posterRatio);

if (nonMonotonic.length) problems.push(`spacing not monotonic: ${nonMonotonic.map(([k]) => k).join(', ')}`);
for (const k of Object.keys(type) as Array<keyof typeof type>) {
  const t = type[k];
  if (t.lineHeight < t.fontSize) problems.push(`type.${k} lineHeight < fontSize`);
}
if (shadows.md.elevation <= shadows.sm.elevation) problems.push('shadow elevations not increasing');

console.log(problems.length ? `\nPROBLEMS:\n- ${problems.join('\n- ')}` : '\nAll token checks passed.');
process.exit(problems.length ? 1 : 0);
