// Favouriting a character on AniList — the one authenticated CHARACTER write in the
// app.
//
// THIS EXISTS, AND IT USED TO BE DOCUMENTED AS NOT EXISTING. `lib/anilist.ts`
// carried a note saying AniList has no mutation that favourites a `Character`, and
// that note was built from reading `Character`'s FIELDS rather than the schema's
// MUTATIONS: `Character` has no `favourite` field, and from that it was concluded
// there was no way to do it. The actual mutation is `ToggleFavourite`, which takes
// `characterId` alongside `animeId`, `mangaId`, `staffId` and `studioId` — so all
// five are favouritable and characters are simply the one nobody had asked about.
// A local-only like built on that premise was the wrong shape: it could not see a
// character the user had already favourited on the web, which is exactly the
// "it still says Like" case.
//
// Verified against the live schema rather than trusted:
//
//   Character.isFavourite : Boolean!   → the state, free, on a query we make anyway
//   Mutation.ToggleFavourite(characterId: Int) : Favourites → the write
//   User.favourites.characters : CharacterConnection → the account's list, if wanted
//
// WHY `ToggleFavourite` AND NOT `SaveFavourite`. There is no such mutation. Toggle
// is the only one, so the caller must know the current state to know what it is
// about to do — which the optimistic write below already flips locally, and the
// rollback restores. The one hazard is a double-tap landing two mutations, which
// would invert the truth; the button disables itself while a write is in flight,
// and that is where that is handled rather than here.

import { authedQuery } from './lists';

// No `//` comments inside this literal — GraphQL treats them as document text and
// the whole query fails to parse. See the same warning in `lib/anilist.ts`.
const TOGGLE_FAVOURITE = `
  mutation ($characterId: Int) {
    ToggleFavourite(characterId: $characterId) {
      characters(page: 1, perPage: 1) {
        pageInfo { total }
      }
    }
  }
`;

const FAVOURITE_QUERY = `
  query ($id: Int) {
    Character(id: $id) { id isFavourite }
  }
`;

/**
 * Whether the signed-in user has favourited ONE character.
 *
 * A SEPARATE REQUEST FROM `fetchCharacter`, and this is the whole design. The
 * character's public payload is cached on disk for seven days and shared by every
 * visitor; `isFavourite` is per-user and is worthless the instant it is stale.
 * Asking for it inside that payload is what made the Like button report `Like` for
 * characters already on the account — a value written to disk by an earlier or
 * signed-out session, restored at cold start, and then painted for the next ten
 * minutes because `useCharacter`'s staleTime had not expired.
 *
 * `lib/query/listEntries.ts` opens by making this exact argument about list
 * entries. It was right and this ignored it.
 *
 * So the flag is per-user, fetched with a token, cached for five minutes and NOT
 * persisted — `persister.ts` scrubs its key on restore, because the one thing a
 * per-user flag must never do is survive as one.
 */
export async function fetchCharacterFavourite(
  token: string,
  characterId: number
): Promise<boolean> {
  const data = await authedQuery<{ Character: { isFavourite: boolean } | null }>(
    token,
    FAVOURITE_QUERY,
    { id: characterId }
  );
  return data.Character?.isFavourite ?? false;
}

/**
 * Character detail + favourite flag in ONE request (signed-in path).
 *
 * Combines `fetchCharacter` (public) and `fetchCharacterFavourite` (per-user)
 * so opening the sheet costs one AniList call instead of two. The result
 * carries both, and the query key is separate from the public `character` key
 * so the per-user flag never pollutes the persisted public cache.
 */
export interface SignedInCharacter {
  detail: import('@/lib/anilist').CharacterDetail;
  isFavourite: boolean;
}

const SIGNED_IN_CHARACTER_QUERY = `
  query ($id: Int) {
    Character(id: $id) {
      id
      name { full native alternative }
      image { large }
      description(asHtml: false)
      favourites
      gender
      age
      bloodType
      dateOfBirth { year month day }
      isFavourite
      media(perPage: 6, sort: [POPULARITY_DESC], type: ANIME) {
        nodes {
          id
          title { english romaji }
          coverImage { large }
          format
          seasonYear
          averageScore
        }
      }
    }
  }
`;

export async function fetchCharacterSignedIn(
  token: string,
  id: number
): Promise<SignedInCharacter | null> {
  const data = await authedQuery<{ Character?: any }>(token, SIGNED_IN_CHARACTER_QUERY, {
    id,
  });
  const c = data.Character;
  if (!c) return null;
  return {
    detail: {
      id: c.id as number,
      nativeName: c.name?.native ?? null,
      alternativeName: c.name?.alternative ?? null,
      description: c.description ?? null,
      gender: c.gender ?? null,
      age: c.age ?? null,
      bloodType: c.bloodType ?? null,
      dateOfBirth: c.dateOfBirth ?? null,
      favourites: (c.favourites as number) ?? 0,
      media: (c.media?.nodes ?? [])
        .filter(Boolean)
        .map((m: any) => ({ ...m, bannerImage: null })),
    },
    isFavourite: c.isFavourite ?? false,
  };
}

/**
 * Flip one character's favourite flag on the signed-in user's account.
 *
 * RETURNS NOTHING ON PURPOSE. The mutation answers with the account's whole
 * `Favourites` object — anime, manga, characters, staff and studios as five
 * connections — and there is no sub-selection that answers "is THIS character
 * favourited now", because a paginated connection cannot be asked about an
 * arbitrary member. Pulling fifty rows down to learn a boolean this client already
 * knew would be a bad trade, so the caller keeps its optimistic value and this
 * reports only whether the write landed.
 *
 * @throws if there is no token, the session has expired, or AniList refused.
 */
export async function toggleCharacterFavourite(
  token: string,
  characterId: number
): Promise<void> {
  await authedQuery<{ ToggleFavourite: unknown }>(token, TOGGLE_FAVOURITE, {
    characterId,
  });
}