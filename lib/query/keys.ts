// Every cache key in the app, in one file.
//
// The rule this enforces: a key is a function of the request and nothing else.
// Not of who is asking, not of when, not of what happens to be on screen. Two
// screens that want the same thing ask for the same key and therefore share one
// response — which is the entire point of moving off five independent caches.
//
// The first segment is a plain noun (`'home'`, `'explore'`, `'schedule'`), and
// that matters for two reasons beyond tidiness: it is what `scrubRestoredState`
// matches on to keep user-typed search terms out of a restored session, and it
// is what `invalidateQueries({ queryKey: ['home'] })` targets when a pull to
// refresh needs to be honest about going back to the network.

import type { ExploreFilters } from '@/lib/anilist/explore';
import { filtersKey } from '@/lib/anilist/explore';

export const qk = {
  /**
   * Home's rails, in one response.
   *
   * `userId` and the two list flags are IN the key, not applied afterwards,
   * because they change the query document itself — AniList rejects a query that
   * declares a variable it never uses, so a signed-in user with both rails
   * switched off is a genuinely different request from a signed-out one. Keying
   * on what was asked for is what stops a rail being served a response that
   * lacks it.
   */
  home: (userId: number | null, current: boolean, planning: boolean) =>
    ['home', userId ?? 'anon', `${current ? 1 : 0}${planning ? 1 : 0}`] as const,

  /** Explore's curated sections — no inputs, so no arguments. */
  exploreSections: () => ['explore'] as const,

  /**
   * The filterable browse grid.
   *
   * `filtersKey` collapses the filter object to a stable string, so two filter
   * objects that mean the same thing share an entry. That matters for more than
   * tidiness: it is what makes flipping between two filters and back free, and
   * it is why the key is derived rather than passed through — a key built from
   * object identity would never hit at all.
   */
  browse: (filters: ExploreFilters, page: number) =>
    ['browse', filtersKey(filters), page] as const,

  /**
   * One local day of airing schedule, keyed on local midnight in seconds.
   *
   * Per day rather than per week on purpose, and not only for the request
   * count: the unit of display is a day, so the unit of caching is a day, and
   * today's list paints the moment it lands instead of waiting on six others.
   */
  airingDay: (start: number) => ['schedule', 'day', start] as const,

  /**
   * One page of search results.
   *
   * The query string is NORMALISED (trimmed, lowercased, whitespace collapsed)
   * before it reaches a key, so "Cowboy Bebop" and "  cowboy   bebop " are one
   * entry rather than two. The display casing never enters a key — it is the
   * user's text, not a request parameter.
   */
  search: (normalisedQuery: string, page: number) =>
    ['search', normalisedQuery, page] as const,

  /** One anime's full detail payload. */
  media: (id: number) => ['media', id] as const,

  /** The extended cast for one anime — a separate tab on the detail page. */
  characters: (id: number) => ['media', id, 'characters'] as const,

  /**
   * ONE character in full — the info sheet's PUBLIC payload.
   *
   * Top level and NOT under `['media', id]`, and the reason is the same as the
   * list entry's: a character's id belongs to the character, not to the title you
   * happened to reach them from. A cast page is reachable from many anime, and a
   * character appears in most of them. Nesting under the anime would mean the same
   * character fetched once per anime that features them, and a sheet opened from
   * two different titles would be a cache miss the second time.
   *
   * PUBLIC ONLY — and that is a contract, not a description. Everything under this
   * key is written to disk and restored for seven days, so no per-user field may
   * ever appear in it. The sheet's Like state is `characterFavourite` below, which
   * is deliberately NOT persisted.
   */
  character: (id: number) => ['character', id] as const,

  /**
   * Combined character detail + favourite flag for signed-in visitors.
   *
   * Separate from `character` because it carries a per-user field
   * (`isFavourite`) and must never be persisted. Listed in `NO_RESTORE`.
   */
  characterSignedIn: (id: number) => ['characterMe', id] as const,

  /**
   * Whether the signed-in user has favourited one character.
   *
   * NOT nested under `character`, and NOT persisted — `persister.ts` scrubs this
   * key on restore. A per-user flag that survives as `false` in a signed-out
   * session's disk cache is exactly what made the Like button report `Like` for
   * characters already on the account.
   */
  characterFavourite: (id: number) => ['characterFavourite', id] as const,

  /**
   * The signed-in user's list entry for one title.
   *
   * NOT nested under `['media', id]`, and that is deliberate. `characters` can
   * live there because it is more of the same public payload; a list entry is a
   * different thing with different rules — it needs a token, it 401s without
   * one, and it is invalidated on every write the user makes. Sharing the prefix
   * would mean a save invalidated the detail payload too, which would cost a
   * request to re-fetch something that had not changed.
   */
  listEntry: (id: number) => ['listEntry', id] as const,

  /** AniList's genre list. Referenced but rarely invalidated. */
  genres: () => ['genres'] as const,

  /**
   * The signed-in account's own name and avatar.
   *
   * Account-scoped, so it is written by `completeSignIn` (which has just fetched it
   * to validate the token and seeds the value rather than asking twice) and removed
   * by `completeSignOut`. Not keyed on the user id for the same reason the entry is
   * not: the transitions already replace it, so a second key would only add a way
   * for the two to disagree.
   */
  viewer: () => ['viewer'] as const,
} as const;

/**
 * Every key the app owns, for wholesale invalidation.
 *
 * `['search']` is deliberately included. A pull to refresh on any screen means
 * "is this still right", and search results age exactly like rails do — it is
 * only the RESTORE that is unsafe, not the invalidation.
 */
export const ALL_KEYS = [['home'], ['explore'], ['browse'], ['schedule'], ['search'], ['media']] as const;
