// Theme access — the only React-aware piece of the design system.
//
// The values live in `./tokens` and import nothing, so scripts and the
// extension loader can read the palette without pulling in React Native's
// Flow-typed source. This file is the thin bridge for components.
//
// The active theme is driven by the `app.theme` setting (dark / light / oled),
// defaulting to OLED black. System colour scheme is ignored once the user
// picks, which is what makes the choice stick.

import { useSyncExternalStore } from 'react';
import { paletteFor, type Palette, type ThemeName } from './tokens';
import { readSetting, readSettingServer, subscribeSettings } from '@/lib/settings/store';

const subscribe = (cb: () => void) => subscribeSettings(cb);

export interface Theme {
  name: ThemeName;
  color: Palette;
}

export function useTheme(): Theme {
  const name = useSyncExternalStore(
    subscribe,
    () => readSetting('app.theme') as ThemeName,
    () => readSettingServer('app.theme') as ThemeName
  );
  return { name, color: paletteFor(name) };
}

export type { Palette, ThemeName };