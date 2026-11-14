// The hook over the update store. Module-scoped subscribe, for the same reason
// as `useSetting`: an inline arrow would resubscribe on every render.

import { useSyncExternalStore } from 'react';
import { readUpdates, subscribeUpdates, type UpdateState } from './store';

const subscribe = (cb: () => void) => subscribeUpdates(cb);

export function useUpdateState(): UpdateState {
  return useSyncExternalStore(subscribe, readUpdates, readUpdates);
}
