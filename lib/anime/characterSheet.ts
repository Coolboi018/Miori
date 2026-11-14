// Opening a character's info sheet from ANY character surface, without threading
// a prop through.
//
// WHY A MODULE AND NOT A PROP. Characters are tappable in two places today — the
// strip on the detail page and the cards on the cast page — and every future cast
// surface will want the same gesture. Threading `onSelect` through all of them
// means a character surface that forgets the prop is a dead portrait that looks
// identical to a working one, which is the worst kind of bug to notice by hand.
//
// So this is the `lib/list/listSheet.ts` pattern, verbatim in intent: a
// module-scope target, hosted once at the root, opened by `openCharacterSheet`.
//
// THE TARGET CARRIES THE DISPLAY DATA, not a fetch. Both call sites are already
// holding a name and a portrait for the character they just tapped, and the sheet
// has to paint something on its very first frame — the request is for the
// DESCRIPTION, which is the only thing not already in memory. Waiting on a request
// to learn someone's name, which the caller is holding, would be a request spent
// to render text that was there a frame earlier.
//
// WHY THE ID IS ENOUGH. `MediaCharacter` (the detail page's strip) and
// `CharacterWithVA` (the cast page's card) are different shapes that share `id`,
// `name` and `image`. This takes the intersection rather than either one, so
// neither surface has to reshape itself to open a sheet — and so a third surface
// with a third shape can open it with a two-field object.

export interface CharacterSheetTarget {
  id: number;
  name: string;
  image?: string | null;
  /**
   * The role in the anime that was tapped, when the caller knows it. Shown as a
   * quiet kicker because "Supporting in Frieren" is the answer to a question
   * someone opening this from a cast list actually has.
   */
  role?: string | null;
  /**
   * The anime the tap happened in, so a sheet opened from a cast page can say
   * which show this is about. Also the seed for the appearance rail: it can be
   * highlighted rather than listed twice.
   */
  animeTitle?: string | null;
}

let target: CharacterSheetTarget | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

export function subscribeCharacterSheet(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * The current target, or null. Read through `useSyncExternalStore`, so this getter
 * must stay pure and return the SAME reference until it actually changes — which is
 * why the dedupe below compares by id rather than building a fresh object.
 */
export function getCharacterSheetTarget(): CharacterSheetTarget | null {
  return target;
}

export function openCharacterSheet(next: CharacterSheetTarget): void {
  // Reopening the SAME character is a no-op. `MediaRail`-style lists re-render
  // their rows, and a redundant write would tear the sheet down and rebuild it —
  // visible as a flicker, and it would restart the entry animation on a sheet the
  // user is currently looking at.
  if (target && target.id === next.id) return;
  target = next;
  emit();
}

export function closeCharacterSheet(): void {
  if (!target) return;
  target = null;
  emit();
}
