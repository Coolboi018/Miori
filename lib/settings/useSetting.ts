// Hooks over the settings store.
//
// `useSyncExternalStore` rather than a Context provider: components subscribe
// to the one key they care about, so changing the navbar's style doesn't
// re-render the player, the episode list, or anything else. With a provider
// holding the whole object, every consumer re-renders on every write.
//
// The subscribe wrapper is module-scoped so its identity is stable across
// renders — an inline arrow here would resubscribe on every render, which is
// a subtle and very easy performance bug.

import { useCallback, useSyncExternalStore } from 'react';
import {
  readSetting,
  readSettingServer,
  resetSettings,
  setSetting,
  subscribeSettings,
  type SettingKey,
  type SettingValue,
} from './store';

function subscribe(cb: () => void) {
  return subscribeSettings(cb);
}

/** Read one setting. Re-renders only when *that* value changes. */
export function useSetting<K extends SettingKey>(key: K): SettingValue<K> {
  return useSyncExternalStore(
    subscribe,
    useCallback(() => readSetting(key), [key]),
    useCallback(() => readSettingServer(key), [key])
  );
}

/** Write one setting. Identity is stable, so it is safe in a deps array. */
export function useSetSetting(): <K extends SettingKey>(
  key: K,
  value: SettingValue<K>
) => void {
  return setSetting;
}

export { resetSettings };
export { hydrateSettings } from './store';
export type { SettingKey, SettingValue } from './store';
