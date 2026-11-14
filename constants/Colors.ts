// Compatibility shim. The stock Expo template shape (`Colors.dark.tint`) is
// still what `Themed.tsx` and the tab layout read, so rather than break those
// call sites this derives the old keys from the real design tokens. New code
// should import from `@/lib/ui/tokens` directly — this file exists only to keep
// a single source of truth while the rest of the app is migrated.

import { themes, type ThemeName } from '@/lib/ui/tokens';

type Compat = {
  text: string;
  background: string;
  tint: string;
  tabIconDefault: string;
  tabIconSelected: string;
};

function compat(name: ThemeName): Compat {
  const c = themes[name];
  return {
    text: c.text.primary,
    background: c.bg.primary,
    // The template used a blue tint; the site's accent is white on dark and
    // near-black on light, so the tab highlight now matches the product.
    tint: c.accent.base,
    tabIconDefault: c.text.muted,
    tabIconSelected: c.accent.base,
  };
}

const Colors = {
  light: compat('light'),
  dark: compat('dark'),
};

export default Colors;
