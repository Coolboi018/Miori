// Theme resolution. The actual values live in `@/lib/ui/tokens` — this is kept
// only because `useColorScheme` is imported by path in a few screens.
//
// Note the old implementation compared the raw scheme against
// `'unspecified'`, which React Native never returns. `null` (the real "system
// hasn't decided yet" value) fell through untouched, and callers doing
// `Colors[colorScheme]` then indexed with `null`. All of that now funnels
// through `resolveThemeName`, which has a defined answer for every input.

import { useColorScheme as useColorSchemeCore } from 'react-native';
import { resolveThemeName } from '@/lib/ui/tokens';

export const useColorScheme = (): 'dark' => resolveThemeName(useColorSchemeCore());
