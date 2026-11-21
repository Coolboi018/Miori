// Authenticated AniList mutations — mobile port of
// anime-frontend src/routes/api/list/entry/+server.ts.
// Every field optional, send only what changed.
//
// THE HTTP CALL IS NOT HERE. It is `gql()`, in `lib/net/gql.ts`, and that used to
// be the whole point of this file's comment claiming the opposite: this had its
// own `fetch`, its own `API` constant, its own `sleep`, and its own retry loop —
// none of which had a timeout. React Native's `fetch` has no default timeout, so a
// hung write never settled and the caller waited forever; `lib/auth/queries.ts`
// runs with `retry: false`, so a hung `Viewer` query left the account row spinning
// on every cold start. It also meant writes escaped the 24/min budget, so the real
// ceiling was 24 reads plus an unbounded number of writes, and its `Retry-After`
// handling discarded a long wait (`secs < 60 ? secs * 1000 : 2000`), which turns
// AniList asking for two minutes into a retry after two seconds and a second 429.
//
// What stays here is everything that is genuinely about AniList's *shape*: the
// documents, the field names (`private`, not `isPrivate`), and the one error
// message that tells a user what to do about it.
import { gql, isAuthError } from '../net/gql';

/**
 * One authenticated document — the authenticated half of `gql()`.
 *
 * The old fourth parameter (`retries`) is gone rather than kept-and-ignored: no
 * call site passed it, and a knob that silently does nothing is how two retry
 * policies end up disagreeing. The policy is `gql`'s alone now.
 */
export async function authedQuery<T>(
  token: string,
  query: string,
  variables?: Record<string, unknown>
): Promise<T> {
  try {
    return await gql<T>(query, { variables, token });
  } catch (e) {
    // The one behaviour worth preserving across the move. AniList's own text for a
    // 401 is a status code, and this sentence is what sends someone to re-login;
    // the generic `statusError` would leave them staring at "AniList error (401)".
    if (isAuthError(e)) throw new Error('AniList session expired — log in again');
    throw e;
  }
}

/**
 * One AniList list entry, in the shape the sheet edits.
 *
 * `score` is AniList's 0–10 value (they allow 0.5 steps). It is NOT `scoreRaw`,
 * which is the same number ×10 and is the form their web client sends; the
 * mutation below takes `score` and AniList does the conversion, so the app never
 * holds both.
 *
 * `private` rather than `isPrivate` — verified against the live schema. AniList
 * renamed the type from `MediaListEntry` to `MediaList` and the field with it,
 * and asking for `isPrivate` returns "Cannot query field isPrivate on type
 * MediaList. Did you mean private?". The mutation ARG is `private` too.
 */
export interface ListEntry {
  id: number;
  status: MediaListStatus;
  progress: number;
  score: number;
  private: boolean;
  /** How many times rewatched. Only meaningful for REPEATING. */
  repeat: number;
  /** 0 = normal, 1 = high, 2 = medium, 3 = low. */
  priority: number;
  notes: string | null;
}

/**
 * AniList's `MediaListStatus`, minus the legacy `TRENDING` which their API still
 * accepts but which nothing in this app sets or displays.
 */
export type MediaListStatus =
  | 'CURRENT'
  | 'PLANNING'
  | 'COMPLETED'
  | 'DROPPED'
  | 'PAUSED'
  | 'REPEATING';

const ENTRY_QUERY = `
  query ($id: Int) {
    Media(id: $id, type: ANIME) {
      mediaListEntry { id status progress score private repeat priority notes }
    }
  }
`;

const SAVE_ENTRY = `
  mutation (
    $mediaId: Int
    $status: MediaListStatus
    $progress: Int
    $score: Float
    $private: Boolean
    $repeat: Int
    $priority: Int
  ) {
    SaveMediaListEntry(
      mediaId: $mediaId
      status: $status
      progress: $progress
      score: $score
      private: $private
      repeat: $repeat
      priority: $priority
    ) {
      id status progress score private repeat priority notes
    }
  }
`;

const DELETE_ENTRY = `
  mutation ($id: Int) {
    DeleteMediaListEntry(id: $id) { deleted }
  }
`;

const VIEWER_QUERY = `query { Viewer { id name avatar { medium large } } }`;

export async function fetchEntry(token: string, mediaId: number): Promise<ListEntry | null> {
  const data = await authedQuery<{ Media: { mediaListEntry: ListEntry | null } }>(
    token,
    ENTRY_QUERY,
    { id: mediaId }
  );
  return data.Media.mediaListEntry;
}

export async function saveEntry(
  token: string,
  vars: {
    mediaId: number;
    status?: MediaListStatus;
    progress?: number;
    score?: number;
    private?: boolean;
    repeat?: number;
    priority?: number;
  }
): Promise<ListEntry> {
  const data = await authedQuery<{ SaveMediaListEntry: ListEntry }>(token, SAVE_ENTRY, vars);
  return data.SaveMediaListEntry;
}

/**
 * Remove an entry. Takes the ENTRY id, not the media id — the mutation's argument
 * is the list entry's own id, which is a different number, and passing the media
 * id deletes whichever entry happens to have that id on the account.
 */
export async function deleteEntry(token: string, entryId: number): Promise<boolean> {
  const data = await authedQuery<{ DeleteMediaListEntry: { deleted: boolean | null } }>(
    token,
    DELETE_ENTRY,
    { id: entryId }
  );
  return !!data.DeleteMediaListEntry?.deleted;
}

export interface Viewer {
  id: number;
  name: string;
  avatar: { medium?: string | null; large?: string | null } | null;
}

export async function fetchViewer(token: string): Promise<Viewer> {
  const data = await authedQuery<{ Viewer: Viewer }>(token, VIEWER_QUERY);
  return data.Viewer;
}

// ---- profile ---------------------------------------------------------------

export interface ProfileStats {
  count: number;
  meanScore: number;
  minutesWatched: number;
  episodesWatched: number;
}

export interface FavouriteAnime {
  id: number;
  title: string;
  cover: string | null;
  /** Anime airing status (RELEASING / NOT_YET_RELEASED / FINISHED …) for the status dot. */
  mediaStatus: string | null;
}

export interface FavouriteCharacter {
  id: number;
  name: string;
  image: string | null;
}

export interface ProfileData {
  id: number;
  name: string;
  avatar: string | null;
  banner: string | null;
  stats: ProfileStats;
  favourites: { anime: FavouriteAnime[]; characters: FavouriteCharacter[] };
}

const PROFILE_QUERY = `
  query {
    Viewer {
      id
      name
      avatar { large }
      bannerImage
      statistics { anime { count meanScore minutesWatched episodesWatched } }
      favourites {
        anime { nodes { id title { english romaji } coverImage { large } status } }
        characters { nodes { id name { full } image { large } } }
      }
    }
  }
`;

export async function fetchProfile(token: string): Promise<ProfileData> {
  const data = await authedQuery<{ Viewer: any }>(token, PROFILE_QUERY);
  const v = data.Viewer;
  const stats = v.statistics?.anime ?? {};
  return {
    id: v.id,
    name: v.name,
    avatar: v.avatar?.large ?? null,
    banner: v.bannerImage ?? null,
    stats: {
      count: stats.count ?? 0,
      meanScore: stats.meanScore ?? 0,
      minutesWatched: stats.minutesWatched ?? 0,
      episodesWatched: stats.episodesWatched ?? 0,
    },
    favourites: {
      anime: (v.favourites?.anime?.nodes ?? []).map((a: any) => ({
        id: a.id,
        title: a.title?.english ?? a.title?.romaji ?? '',
        cover: a.coverImage?.large ?? null,
        mediaStatus: a.status ?? null,
      })),
      characters: (v.favourites?.characters?.nodes ?? []).map((c: any) => ({
        id: c.id,
        name: c.name?.full ?? '',
        image: c.image?.large ?? null,
      })),
    },
  };
}

export interface MediaListEntry {
  id: number;
  title: string;
  cover: string | null;
  progress: number;
  episodes: number | null;
  score: number;
  status: string;
  /** Anime airing status (RELEASING / NOT_YET_RELEASED / …) for the status dot. */
  mediaStatus: string | null;
  /** Unix timestamp the entry was created — used to sort newest-first. */
  createdAt?: number;
}

export async function fetchMediaList(token: string, userId: number, status: string): Promise<MediaListEntry[]> {
  const q = `
    query ($userId: Int, $status: MediaListStatus) {
      MediaListCollection(userId: $userId, type: ANIME, status: $status) {
        lists {
          entries {
            id
            progress
            score
            createdAt
            media {
              id
              episodes
              status
              title { english romaji }
              coverImage { large }
            }
          }
        }
      }
    }
  `;
  const data = await authedQuery<any>(token, q, { userId, status });
  const lists = data.MediaListCollection?.lists ?? [];
  const out: MediaListEntry[] = [];
  for (const l of lists) {
    for (const e of l.entries ?? []) {
      out.push({
        id: e.media.id,
        title: e.media.title?.english ?? e.media.title?.romaji ?? '',
        cover: e.media.coverImage?.large ?? null,
        progress: e.progress ?? 0,
        episodes: e.media.episodes ?? null,
        score: e.score ?? 0,
        status,
        mediaStatus: e.media.status ?? null,
        createdAt: e.createdAt ?? undefined,
      });
    }
  }
  // Newest first: people want what they added recently on top, not the oldest
  // entry. Fall back to id descending when createdAt is missing.
  out.sort((a, b) => (b.createdAt ?? b.id) - (a.createdAt ?? a.id));
  return out;
}

// Continue Watching and Planning are no longer fetched here. They are aliased
// fields on the single home query in `lib/anilist.ts`, so the whole home screen
// costs one request — which matters against AniList's ~30 req/min. See
// `fetchHomeSections`.
//
// There was also an `export { getToken }` here, re-exported from `./auth`. Every
// caller already imported it from `./auth` directly, so it had no importers — and
// because `auth.ts` pulls in `expo-secure-store`, that unused re-export was the
// single thing making this file impossible to load from a plain Node script. With
// it gone the write path is testable offline, which is what
// `scripts/check-write-transport.ts` needs.
