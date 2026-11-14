// The React binding for the recent-searches store.
//
// Split from `recent.ts` the same way `useSetting.ts` is split from
// `store.ts`: storage knows nothing about React, the hook knows nothing about
// AsyncStorage.
//
// `loaded` is part of the API on purpose. The list arrives asynchronously, and
// a landing state that renders "Recent — nothing here" for the one frame
// before it arrives flashes an empty section at you. `loaded` lets the screen
// render nothing until the answer is real.
//
// Every writer here awaits the storage call and then sets state from its
// RESULT rather than from what it optimistically assumed. That matters because
// the store is the source of truth — it caps, de-duplicates and reorders — and
// a local guess would disagree with it the moment someone searched the same
// term twice.

import { useCallback, useEffect, useState } from 'react';
import {
  clearRecent,
  dropRecent,
  pushRecent,
  readRecent,
  type RECENT_MAX,
} from './recent';

export interface RecentSearches {
  /** Newest first. Empty until `loaded`. */
  recent: string[];
  /** False until the first read has settled. Gate any "Recent" UI on it. */
  loaded: boolean;
  remember: (term: string) => Promise<void>;
  forget: (term: string) => Promise<void>;
  clearAll: () => Promise<void>;
}

export function useRecentSearches(): RecentSearches {
  const [recent, setRecent] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let live = true;
    void readRecent()
      .then((list) => {
        if (!live) return;
        setRecent(list);
      })
      .finally(() => {
        if (live) setLoaded(true);
      });
    return () => {
      live = false;
    };
  }, []);

  const remember = useCallback(async (term: string) => {
    setRecent(await pushRecent(term));
  }, []);

  const forget = useCallback(async (term: string) => {
    setRecent(await dropRecent(term));
  }, []);

  const clearAll = useCallback(async () => {
    setRecent(await clearRecent());
  }, []);

  return { recent, loaded, remember, forget, clearAll };
}

export { RECENT_MAX };