// Hosts the one character info sheet, at the root, for every character surface.
//
// WHY IT LIVES HERE AND NOT IN THE SCREEN. A character is tappable from the
// detail page's strip and from the cast page's cards today, and both would need
// their own sheet, their own query and their own animation otherwise. That is the
// `ListSheetHost` argument exactly: the sheet is addressed by a module-scope target
// so a portrait just calls `openCharacterSheet(character)` and is done.
//
// MOUNTED ONCE AND ALWAYS, and `useCharacter` is disabled when nothing is targeted
// — which is what makes that affordable. A host that mounted permanently and
// fetched anyway would spend a request per character on the app's lifetime for a
// sheet nobody opened.

import { useSyncExternalStore } from 'react';
import {
  closeCharacterSheet,
  getCharacterSheetTarget,
  subscribeCharacterSheet,
} from '@/lib/anime/characterSheet';
import { CharacterSheet } from './CharacterSheet';

export function CharacterSheetHost() {
  const target = useSyncExternalStore(
    subscribeCharacterSheet,
    getCharacterSheetTarget,
    // Server snapshot: nothing is targeted during SSR, same as the list sheet.
    () => null
  );

  return (
    <CharacterSheet
      visible={target != null}
      target={target}
      onClose={closeCharacterSheet}
    />
  );
}
