// Minimal AniList client for Miori.
// One request for home (trending + popular together).
// Ported from anime-frontend src/lib/server/anilist.ts HOME_QUERY.
//
// CACHING AND DE-DUPLICATION ARE NOT HERE ANYMORE. This module used to own an
// in-memory `Map` with a 60s TTL plus a second map of in-flight promises, and
// four other modules each had their own pair of the same. That was five
// independent answers to "have I already asked this?", so a prefetch of the
// schedule racing a focus refresh of the schedule was two requests, and nothing
// survived a cold start at all.
//
// Both jobs now live in `lib/query`: TanStack Query keys every response, shares
// one promise between concurrent callers, and persists the result to disk. What
// is left here is the part that was always this module's actual job � the query
// documents and the shape normalisation � which is what should have been in a
// file called `anilist.ts` all along.

import { gql } from './net/gql';

export interface MediaTitle {
  english?: string | null;
  romaji?: string | null;
  native?: string | null;
}

export interface MediaItem {
  id: number;
  title: MediaTitle;
  /**
   * `color` is AniList's server-computed dominant colour for the cover. It
   * arrives as bare hex WITHOUT a leading '#' (e.g. "519ac2"), and is null
   * when AniList has not indexed the cover yet � normalise with
   * `coverAccent()` in `@/lib/ui/accent` rather than using it raw.
   */
  coverImage: { large: string; extraLarge?: string; color?: string | null };
  bannerImage?: string | null;
  genres?: string[] | null;
  seasonYear?: number | null;
  averageScore?: number | null;
  format?: string | null;
  episodes?: number | null;
  status?: string | null;
}

function title(t: MediaTitle): string {
  return t.english || t.romaji || t.native || 'Unknown';
}

export { title as mediaTitle };

// ---------------------------------------------------------------------------
// Home screen � every section in ONE request
// ---------------------------------------------------------------------------
//
// AniList allows only ~30 requests/minute, and the home screen used to spend
// two of them (trending, then continue watching) before showing a single
// section. Now every rail is an ALIASED field on one query, and the two list
// sections are aliases on that same query when signed in. One request fills the
// entire screen, signed in or not � and one request with a section switched
// off fills less of it, since the toggle drops the alias rather than
// downloading posters to hide them.
//
// Per-rail size is deliberately small: these are horizontally scrolling rails,
// and 14 covers what fits on a phone plus a swipe.

const RAIL_SIZE = 14;

/** Field set shared by every rail and list entry � exactly `MediaItem`. */
const HOME_FIELDS = `
        id
        title { english romaji native }
        coverImage { large extraLarge color }
        bannerImage
        genres
        seasonYear
        averageScore
        format
        episodes
        status`;

export interface ContinueItem {
  media: MediaItem;
  progress: number;
  updatedAt: number;
}

export interface HomeSections {
  /** Currently airing � the shows with the newest episodes. */
  latest: MediaItem[];
  trending: MediaItem[];
  /** Finished airing, most recent end date first. */
  completed: MediaItem[];
  popular: MediaItem[];
  /** Signed-in only. */
  current: ContinueItem[];
  planning: MediaItem[];
  /** Not yet aired, most anticipated first (popularity order). */
  upcoming: MediaItem[];
}

function discoveryAliases(): string {
  return `
    latest: Page(page: 1, perPage: ${RAIL_SIZE}) {
      media(status: RELEASING, sort: TRENDING_DESC, type: ANIME, isAdult: false) {${HOME_FIELDS} }
    }
    trending: Page(page: 1, perPage: ${RAIL_SIZE}) {
      media(sort: TRENDING_DESC, type: ANIME, isAdult: false) {${HOME_FIELDS} }
    }
    completed: Page(page: 1, perPage: ${RAIL_SIZE}) {
      media(status: FINISHED, sort: END_DATE_DESC, type: ANIME, isAdult: false) {${HOME_FIELDS} }
    }
    popular: Page(page: 1, perPage: ${RAIL_SIZE}) {
      media(sort: POPULARITY_DESC, type: ANIME, isAdult: false) {${HOME_FIELDS} }
    }
    upcoming: Page(page: 1, perPage: ${RAIL_SIZE}) {
      media(status: NOT_YET_RELEASED, sort: POPULARITY_DESC, type: ANIME, isAdult: false) {${HOME_FIELDS} }
    }`;
}

/**
 * The list aliases are only added when signed in. Two query strings rather
 * than an `@include(if:)` directive: AniList's directive support on list
 * arguments is not something to rely on, and passing a null `$userId` is not
 * worth the risk of a 400 on the one query every screen depends on.
 *
 * `MediaListCollection`, not `MediaList` � the singular type has no `entries`
 * field, so both lists have to be flattened out of `lists` instead. Found by
 * running the real query string, not by reading the docs.
 *
 * `chunk: 1, perChunk: N` is the only cap this type offers; it returns the
 * first N entries rather than the whole list, so a user with 500 planned shows
 * transfers 14 posters, not 500. `page`/`perPage` are rejected outright, and
 * `perChunk` on its own is ignored � the two args only take effect together.
 */
function homeQuery(withUser: boolean, lists?: { current?: boolean; planning?: boolean }): string {
  if (!withUser) {
    return `query {${discoveryAliases()}}`;
  }
  const wantCurrent = lists?.current !== false;
  const wantPlanning = lists?.planning !== false;
  if (!wantCurrent && !wantPlanning) {
    // No list alias means `$userId` is declared but unused, which AniList
    // rejects with a 400 ("Variable is never used"). Signed in with both rails
    // switched off is a real state, not a hypothetical.
    return `query {${discoveryAliases()}}`;
  }
  const parts: string[] = [];
  if (wantCurrent) {
    parts.push(`
    current: MediaListCollection(userId: $userId, type: ANIME, status: CURRENT, sort: UPDATED_TIME_DESC, chunk: 1, perChunk: ${RAIL_SIZE}) {
      lists { entries { progress updatedAt media {${HOME_FIELDS}} } }
    }`);
  }
  if (wantPlanning) {
    parts.push(`
    planning: MediaListCollection(userId: $userId, type: ANIME, status: PLANNING, sort: UPDATED_TIME_DESC, chunk: 1, perChunk: ${RAIL_SIZE}) {
      lists { entries { media {${HOME_FIELDS}} } }
    }`);
  }
  return `query ($userId: Int) {${discoveryAliases()}${parts.join('')}}`;
}

/** Which list sections to include. Omitted sections are not queried at all. */
export interface HomeListOptions {
  current?: boolean;
  planning?: boolean;
}

/**
 * Fetch every home section. One request.
 *
 * A section the caller switched off is left out of the query entirely rather
 * than fetched and hidden � a hidden rail that still costs a poster download is
 * not really hidden.
 *
 * A partial failure degrades to empty rails instead of a blank screen: AniList
 * returns `data` for whatever succeeded alongside any `errors`.
 */
export async function fetchHomeSections(
  userId: number | null,
  lists?: HomeListOptions
): Promise<HomeSections> {
  const wantCurrent = lists?.current !== false;
  const wantPlanning = lists?.planning !== false;
  const d = await gql<Record<string, any>>(
    homeQuery(userId != null, { current: wantCurrent, planning: wantPlanning }),
    { variables: userId == null ? undefined : { userId } }
  );
  const flat = (list: { lists?: Array<{ entries?: unknown[] }> } | null | undefined) =>
    (list?.lists ?? []).flatMap((l) => l?.entries ?? []);
  // `MediaListCollection` returns one entry PER LIST a show sits in � the
  // main "Watching" list plus every custom list it was also added to. The
  // flat lists above therefore contain the same media id several times,
  // which crashed React with duplicate-render keys ("two children with
  // the same key .$101168") once ContinueRail keyed tiles by media id.
  // De-dupe by id, keeping the first occurrence: entries come sorted by
  // UPDATED_TIME_DESC, so the first IS the freshest. Each call gets its own
  // seen-set, so the sections can never suppress each other.
  const firstOf = <T,>(items: T[], id: (item: T) => number): T[] => {
    const seen = new Set<number>();
    const out: T[] = [];
    for (const item of items) {
      const k = id(item);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(item);
    }
    return out;
  };
  return {
    latest: d.latest?.media ?? [],
    trending: d.trending?.media ?? [],
    completed: d.completed?.media ?? [],
    popular: d.popular?.media ?? [],
    upcoming: d.upcoming?.media ?? [],
    current: firstOf(
      flat(d.current)
        .filter((e: any) => e?.media)
        .map((e: any) => ({
          media: e.media as MediaItem,
          progress: e.progress ?? 0,
          updatedAt: e.updatedAt ?? 0,
        })),
      (e) => e.media.id
    ),
    planning: firstOf(
      flat(d.planning)
        .map((e: any) => e?.media)
        .filter((m: MediaItem | null | undefined): m is MediaItem => !!m),
      (m) => m.id
    ),
  };
}

// One request for the whole detail page. Everything the redesigned screen
// shows � banner, poster, per-anime accent colour, studio, recommendations,
// relations, characters � comes from this single call. Adding fields here is
// free; adding a second fetch is not (see the 1-req-per-page rate posture).
//
// Note `recommendations { nodes { mediaRecommendation } }` � the connection
// exposes `nodes`, not a list called `recommendations` (that was a wrong guess
// worth recording; introspect `__type` before assuming a connection shape).
//
// NO COMMENTS INSIDE THIS TEMPLATE. GraphQL's own comment syntax is `#`, so a
// `//` line written here is sent to the server as part of the document and the
// whole query fails to parse � a `400` that reads like a field error and is not
// one. An explanatory note about a selection goes above the `const`, where it is
// invisible to the wire. (`characters.edges.node` carries `id` for the
// character info sheet: it is the CHARACTER's own id, not the media's, and
// nothing else on this payload can supply it.)
const DETAIL_QUERY = `
  query ($id: Int) {
    Media(id: $id, type: ANIME) {
      id
      idMal
      title { english romaji native }
      bannerImage
      coverImage { extraLarge large medium color }
      description(asHtml: false)
      genres
      averageScore
      format
      episodes
      duration
      season
      seasonYear
      status
      countryOfOrigin
      popularity
      favourites
      synonyms
      tags { name rank isMediaSpoiler }
      startDate { year month day }
      nextAiringEpisode { episode airingAt }
      studios(isMain: true) { nodes { name } }
      recommendations(sort: RATING_DESC, perPage: 25) {
        nodes {
          rating
          mediaRecommendation {
            id
            title { english romaji }
            coverImage { large extraLarge }
            averageScore
            format
          }
        }
      }
      relations {
        edges {
          relationType(version: 2)
          node {
            id
            type
            title { english romaji }
            coverImage { large extraLarge }
            format
            episodes
            averageScore
          }
        }
      }
      characters(perPage: 8, sort: [RELEVANCE, ROLE]) {
        edges {
          role
          node { id name { full } image { large } }
        }
      }
    }
  }
`;

export interface MediaRelation {
  type: string;
  media: MediaItem & { type?: string | null };
}

export interface MediaCharacter {
  role: string;
  /**
   * The CHARACTER's id, not the media's. Present so a portrait can open the info
   * sheet, which is a query on `Character(id:)`.
   */
  id: number;
  name: string;
  image?: string | null;
  /**
   * NO `isFavourite` HERE, deliberately. See `CharacterDetail.favourites` for why a
   * per-user flag cannot live on a payload cached on disk for a week.
   *
   * It was added so a cast card could show its heart from the same field the sheet's
   * button writes, and it reported `Like` on characters already favourited on the
   * account — the value came back from a session that was not this user's.
   */
}

/**
 * A character as AniList actually describes them, for the info sheet.
 *
 * EVERY FIELD HERE IS OPTIONAL ON PURPOSE, and that is not defensive hedging � it
 * is a measurement. Sampling AniList's `Character` type directly, across the
 * characters a real app meets:
 *
 *   description   16/17 have one (median ~440 chars, max ~2800)
 *   alternative   17/17
 *   native name   15/17
 *   gender        12/17
 *   favourites  >0 for 14/17
 *   age            7/17
 *   bloodType      6/17
 *   dateOfBirth    2/17
 *
 * So a sheet that assumed a full profile would be showing two or three empty rows
 * for most characters, and the one field everybody opens this for � the description �
 * is the one most likely to be missing. The sheet is therefore built around a
 * description that may be absent, and treats the rest as chips that appear only
 * when AniList has them.
 *
 * THE FIELDS THIS DOES NOT ASK FOR, and why. Introspection of `Character` shows
 * `height` and `weight` do not exist on the type at all � requesting them is a hard
 * `400`, not a null. `modNotes` and `isFavouriteBlocked` are moderation internals.
 * A previous sketch of this query asked for height/weight/occupations because
 * character-profile UIs usually have them; AniList does not, so the fantasy fields
 * are gone rather than rendered as permanently empty rows.
 *
 * THE FIELDS THIS DOES NOT ASK FOR BUT *COULD*, which is the mistake that cost the
 * most. This file used to carry a note saying AniList has no mutation that
 * favourites a `Character`, and a whole local like store was built on it. That was
 * inferred from `Character` having no `favourite` FIELD, which says nothing about
 * the MUTATIONS � `ToggleFavourite(characterId:)` exists and always has, alongside
 * `animeId` / `mangaId` / `staffId` / `studioId`. Read the schema's mutation type
 * before concluding something cannot be written.
 *
 * AND `isFavourite` IS NOT ASKED FOR, which is the second half of that lesson. It
 * IS on the type � as a `Boolean!` that resolves per viewer, free, on a query this
 * already makes. Adding it here was wrong anyway, because this payload is cached on
 * disk for seven days and a per-user flag in it is a value that outlives its
 * subject. It is fetched separately and not persisted. The lesson of both is the
 * same one `listEntries.ts` opens with: public data and per-user data have different
 * lifetimes, and only one of them can be cached for a week.
 */
export interface CharacterDetail {
  id: number;
  /** Japanese name where AniList has one � 15/17 in the sample above. */
  nativeName?: string | null;
  /** AniList's own alternate spelling. 17/17 in the sample. */
  alternativeName?: string | null;
  description?: string | null;
  gender?: string | null;
  /** A free string, not a number: AniList stores "18", "19", "18-19", "Unknown". */
  age?: string | null;
  bloodType?: string | null;
  dateOfBirth?: { year?: number | null; month?: number | null; day?: number | null } | null;
  /**
   * How many people have favourited this character � an `Int`, and the same number
   * for every visitor.
   *
   * NOT THIS USER'S FAVOURITE FLAG. AniList's per-user boolean is `isFavourite`,
   * and it is deliberately absent from this interface: everything on this payload is
   * written to disk for seven days, so a per-user field here is a value that
   * outlives the person it describes. It lives on `qk.characterFavourite` instead,
   * which is fetched with a token and never persisted. Asking for it here once cost
   * the Like button its correctness � see `lib/anilist/characterFavourite.ts`.
   */
  favourites?: number | null;
  /** Their most popular appearances, so the sheet says where they turn up. */
  media?: MediaItem[] | null;
}

/**
 * One character in full, by id.
 *
 * A SEPARATE REQUEST from the cast list, and that is the whole reason the sheet
 * opens fast rather than slowly. `fetchCharacters` returns fifty characters with a
 * name and a portrait each and nothing else � the payload a cast page needs and
 * nothing more. Adding description and stats to that query would multiply a
 * fifty-row response by roughly six, on every title whose cast page the user has
 * ever opened, to serve a panel most of them never tap.
 *
 * So the cast lists stay as they are and this is fetched per character, on the
 * sheet, behind a query keyed on the id � the second sheet for the same character
 * is free, and it survives a cold start.
 */
export async function fetchCharacter(id: number): Promise<CharacterDetail | null> {
  const query = `
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
  const data = await gql<{ Character?: any }>(query, { variables: { id } });
  const c = data.Character;
  if (!c) return null;
  return {
    id: c.id as number,
    nativeName: c.name?.native ?? null,
    alternativeName: c.name?.alternative ?? null,
    // `asHtml: false` above, but AniList still sends the occasional `<br>` and the
    // sheet renders plain `Text` � so the same strip the detail page's synopsis
    // does, rather than trusting the flag.
    description: c.description ?? null,
    gender: c.gender ?? null,
    age: c.age ?? null,
    bloodType: c.bloodType ?? null,
    dateOfBirth: c.dateOfBirth ?? null,
    favourites: (c.favourites as number) ?? 0,
    // `false`, not `null`, when absent: the field is non-null on AniList's side, and
    // a button that reads `null` as "unknown" would show the wrong state on a
    // signed-out visitor instead of the honest unliked one.
    media: (c.media?.nodes ?? [])
      .filter(Boolean)
      .map((m: any) => ({ ...m, bannerImage: null })),
  };
}

/** A character together with their voice actor for one language. */
export interface CharacterWithVA {
  id: number;
  role: string;
  name: string;
  image?: string | null;
  vaName?: string | null;
  vaImage?: string | null;
  language: string;
}

const CHARACTER_FIELDS = `
  id
  role
  node {
    id
    name { full }
    image { large }
  }
  voiceActors(language: JAPANESE) {
    id
    name { full }
    image { large }
    languageV2
  }
`;

/**
 * The full cast for one anime � every character (not just the 8 the detail
 * query bundles) plus their Japanese voice actor, paired per edge.
 */
export async function fetchCharacters(id: number): Promise<CharacterWithVA[]> {
  const query = `
    query ($id: Int) {
      Media(id: $id, type: ANIME) {
        characters(sort: [ROLE, RELEVANCE], perPage: 50) {
          edges { ${CHARACTER_FIELDS} }
        }
      }
    }
  `;
  const data = await gql<{ Media?: { characters?: { edges?: any[] } } }>(query, {
    variables: { id },
  });
  const edges = data.Media?.characters?.edges ?? [];
  return edges
    .filter((e: any) => e?.node)
    .map((e: any) => ({
      id: e.node.id as number,
      role: (e.role as string) ?? 'MAIN',
      name: (e.node.name?.full as string) ?? 'Unknown',
      image: e.node.image?.large ?? null,
      vaName: e.voiceActors?.[0]?.name?.full ?? null,
      vaImage: e.voiceActors?.[0]?.image?.large ?? null,
      language: e.voiceActors?.[0]?.languageV2 ?? 'Japanese',
    }));
}

export interface MediaDetail extends MediaItem {
  idMal?: number | null;
  description?: string | null;
  genres?: string[] | null;
  duration?: number | null;
  season?: string | null;
  seasonYear?: number | null;
  countryOfOrigin?: string | null;
  startDate?: { year?: number | null; month?: number | null; day?: number | null } | null;
  coverColor?: string | null;
  studios?: string[] | null;
  nextAiringEpisode?: { episode: number; airingAt: number } | null;
  popularity?: number | null;
  favourites?: number | null;
  synonyms?: string[] | null;
  tags?: string[] | null;
  recommendations?: MediaItem[] | null;
  relations?: MediaRelation[] | null;
  characters?: MediaCharacter[] | null;
}

/**
 * Flatten the nested AniList connection shapes into the plain arrays the
 * screens want. Doing it here keeps every `.edges[0].node...` chain out of the
 * UI, and means a missing section is an empty array rather than a crash.
 */
function normaliseDetail(m: any): MediaDetail {
  return {
    ...(m as MediaDetail),
    coverColor: m.coverImage?.color ?? null,
    synonyms: (m.synonyms ?? []).filter(Boolean),
    tags: (m.tags ?? [])
      .filter((t: any) => t?.name && !t.isMediaSpoiler && (t.rank ?? 0) >= 60)
      .map((t: any) => t.name),
    studios: (m.studios?.nodes ?? []).map((s: any) => s.name).filter(Boolean),
    recommendations: (m.recommendations?.nodes ?? [])
      .map((r: any) => r.mediaRecommendation)
      .filter(Boolean),
    relations: (m.relations?.edges ?? [])
      .filter((e: any) => e?.node)
      .map((e: any) => ({ type: e.relationType, media: e.node })),
    characters: (m.characters?.edges ?? [])
      .filter((e: any) => e?.node)
      .map((e: any) => ({
        role: e.role,
        id: (e.node.id as number) ?? 0,
        name: e.node.name?.full ?? 'Unknown',
        image: e.node.image?.large ?? null,
      })),
  };
}

/**
 * One anime's whole detail payload, in a single request.
 *
 * Cached and persisted like everything else � which matters more here than
 * anywhere else in the app, because this is the screen people return to.
 * Opening a show you looked at yesterday should be instant, and with the data
 * on disk it is.
 */
export async function fetchMedia(id: number): Promise<MediaDetail> {
  const data = await gql<{ Media?: any }>(DETAIL_QUERY, { variables: { id } });
  if (!data.Media) throw new Error('Anime not found');
  return normaliseDetail(data.Media);
}

// Search moved to `./anilist/search.ts`. It used to live here as a bare
// `searchAnime(q)` that hardcoded `page: 1` and discarded the
// `pageInfo { hasNextPage }` its own query already asked for. See that file for
// the paged version and why a pager beats an append.

// The schedule moved to `./anilist/schedule.ts` for the same reason. It used to
// be a single `fetchSchedule()` over a hardcoded 24-hour window with no cache at
// all, so the tab could not be re-entered without paying for the same request
// again, and it silently truncated at AniList's page size. See that file for the
// per-day window and the paging.

// `fetchTrending` used to live here as its own request. It is gone: the hero
// and the Trending rail now read from `fetchHomeSections`, which is the same
// data without the extra call.

// ---------------------------------------------------------------------------
// Explore � genres, seasons, formats, status
//
// Four drill-down fetchers that used to be four near-identical copies of the
// same POST: same query, same fields, same two lines of unpacking, one argument
// swapped. Collapsed into one helper, because four copies is four places for a
// field to be added to three of them � which is what had happened to
// `bannerImage`.
//
// What stays per-caller is the ARGUMENT. A GraphQL enum is a literal in a
// document, not a value, so `format: $format` needs a `MediaFormat` type on the
// variable declaration and gains nothing over formatting the enum in � but the
// one argument that IS user-influenced, `genre`, is bound as a variable
// instead, because it comes off a route param and hand-quoting a string into a
// document is an injection point as well as being fragile.
// ---------------------------------------------------------------------------

/** The fields every browse tile shows. Same set as the home rails. */
const BROWSE_FIELDS = `
        id
        title { english romaji native }
        coverImage { large extraLarge color }
        averageScore
        format
        episodes
        status
        genres
        seasonYear`;

/** One `Page` of media, with `hasNextPage` answered honestly. */
export interface SeasonalResult {
  media: MediaItem[];
  hasNextPage: boolean;
}

interface PageShape {
  Page?: { media?: MediaItem[]; pageInfo?: { hasNextPage?: boolean } };
}

/** Unpack a `Page`, defaulting a missing block to empty rather than crashing. */
async function fetchPage(
  query: string,
  variables: Record<string, unknown>
): Promise<SeasonalResult> {
  const data = await gql<PageShape>(query, { variables });
  return {
    media: data.Page?.media ?? [],
    hasNextPage: data.Page?.pageInfo?.hasNextPage ?? false,
  };
}

const GENRES_QUERY = `
  query {
    GenreCollection
  }
`;

/**
 * AniList's own genre list.
 *
 * Never called � `EXPLORE_GENRES` in `./anilist/explore.ts` is a hardcoded
 * adult-free copy of exactly this, and fetching it would spend a request to
 * redownload a constant. Kept as the documented source of that list.
 */
export async function fetchGenres(): Promise<string[]> {
  const data = await gql<{ GenreCollection?: string[] }>(GENRES_QUERY);
  return data.GenreCollection ?? [];
}

export type SeasonName = 'WINTER' | 'SPRING' | 'SUMMER' | 'FALL';

const SEASONAL_QUERY = `
  query ($season: MediaSeason, $seasonYear: Int, $page: Int, $perPage: Int) {
    Page(page: $page, perPage: $perPage) {
      pageInfo { hasNextPage }
      media(season: $season, seasonYear: $seasonYear, type: ANIME, isAdult: false, sort: POPULARITY_DESC) {${BROWSE_FIELDS} }
    }
  }
`;

export function fetchSeasonal(
  season: SeasonName,
  seasonYear: number,
  page = 1,
  perPage = 24
): Promise<SeasonalResult> {
  return fetchPage(SEASONAL_QUERY, { season, seasonYear, page, perPage });
}

export type MediaFormat = 'TV' | 'TV_SHORT' | 'MOVIE' | 'SPECIAL' | 'OVA' | 'ONA' | 'MUSIC';

/** Enum in, so formatted into the document rather than bound as a variable. */
function byEnumQuery(arg: string): string {
  return `
  query ($page: Int, $perPage: Int) {
    Page(page: $page, perPage: $perPage) {
      pageInfo { hasNextPage }
      media(${arg}, type: ANIME, isAdult: false, sort: POPULARITY_DESC) {${BROWSE_FIELDS} }
    }
  }
`;
}

export function fetchByFormat(
  format: MediaFormat,
  page = 1,
  perPage = 24
): Promise<SeasonalResult> {
  return fetchPage(byEnumQuery(`format: ${format}`), { page, perPage });
}

export type MediaStatus =
  | 'RELEASING'
  | 'FINISHED'
  | 'NOT_YET_RELEASED'
  | 'CANCELLED'
  | 'HIATUS';

export function fetchByStatus(
  status: MediaStatus,
  page = 1,
  perPage = 24
): Promise<SeasonalResult> {
  return fetchPage(byEnumQuery(`status: ${status}`), { page, perPage });
}

const BY_GENRE_QUERY = `
  query ($genre: String, $page: Int, $perPage: Int) {
    Page(page: $page, perPage: $perPage) {
      pageInfo { hasNextPage }
      media(genre: $genre, type: ANIME, isAdult: false, sort: POPULARITY_DESC) {${BROWSE_FIELDS} }
    }
  }
`;

export function fetchByGenre(
  genre: string,
  page = 1,
  perPage = 24
): Promise<SeasonalResult> {
  return fetchPage(BY_GENRE_QUERY, { genre, page, perPage });
}

export function getCurrentSeason(): { season: SeasonName; year: number } {
  const now = new Date();
  const month = now.getMonth(); // 0-11
  let season: SeasonName;
  if (month >= 0 && month <= 2) season = 'WINTER';
  else if (month >= 3 && month <= 5) season = 'SPRING';
  else if (month >= 6 && month <= 8) season = 'SUMMER';
  else season = 'FALL';
  return { season, year: now.getFullYear() };
}

export function getSeasonLabel(season: SeasonName, year: number): string {
  return `${season.charAt(0) + season.slice(1).toLowerCase()} ${year}`;
}
