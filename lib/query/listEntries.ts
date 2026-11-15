// Reading and writing the signed-in user's AniList list entry for one title.
//
// SEPARATE FROM `useMediaDetail` ON PURPOSE. The detail payload is public, cached
// on disk for seven days, and every visitor gets it. A list entry is per-user,
// 401s without a token, and is worthless the moment it is stale — so putting it
// in the same query would mean a signed-out visitor's cache holding a null entry
// that a later signed-in visit had to invalidate, and a list state that outlived
// its own account.
//
// `qk.listEntry(id)` is also NOT part of the home query's key, which is what makes
// a save cheap to reflect: writing an entry invalidates one small query, not the
// one aliased request every screen on the app depends on.

import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import { getToken } from '@/lib/anilist/auth';
import {
  deleteEntry as apiDeleteEntry,
  fetchEntry,
  saveEntry as apiSaveEntry,
  type ListEntry,
  type MediaListStatus,
} from '@/lib/anilist/lists';
import { advancesProgress, planProgressSync } from '@/lib/anilist/progress';
import type { MediaDetail } from '@/lib/anilist';
import { qk } from './keys';

/**
 * EVERY CACHE ENTRY THAT IS DERIVED FROM THE USER'S OWN LIST.
 *
 * The list is short on purpose: `['home']` is the only query in the app that reads
 * the signed-in user's list. Everything else is either public (`['media']`,
 * `['explore']`, `['browse']`, `['schedule']`, `['search']`) or is the per-title
 * entry, which is written directly rather than invalidated.
 *
 * A PREFIX, so it covers every variant of the home key. `qk.home` carries the user
 * id and the two rail flags, so there is one entry per (user, continueOn,
 * planningOn) combination and a write has to reach all of them — the one on screen
 * and any a rail toggle left behind earlier in the session.
 *
 * `['media']` is deliberately NOT here. It is public data and a list write cannot
 * change it, so invalidating it would spend a request re-fetching something
 * identical. The only thing a save affects on a detail page is that page's own
 * entry, which is `qk.listEntry` and is written, not invalidated.
 */
const USER_LIST_KEYS: ReadonlyArray<readonly string[]> = [['home']];

/**
 * Mark everything derived from the user's list stale, and refetch what is on
 * screen.
 *
 * WHY INVALIDATE RATHER THAN PATCHING THE RAILS. The home response is one aliased
 * query carrying ~70 items across seven rails. A save can add a title to Continue
 * Watching, drop one out of it, move one between Continue and Planning, or reorder
 * both — and AniList sorts those rails by `UPDATED_TIME_DESC`, so the edit itself
 * moves the title. Reconciling that optimistically means reimplementing the
 * server's sort in the client, and a guess that disagrees with AniList is worse
 * than waiting for the answer: it would reorder under the user's finger and then
 * reorder again when the real one landed.
 *
 * WHY IT DOES NOT COST A VISIBLE REFRESH, which is the objection that stopped this
 * being built the first time:
 *
 *   • `useHomeSections` sets `placeholderData: keepPreviousData`, so `data` stays
 *     populated for the whole refetch. The rails never fall back to a skeleton, so
 *     there is nothing to flash and nothing to lose scroll position to — the
 *     FlatList is never remounted and its offset is native state that survives a
 *     data swap.
 *   • Only queries with active observers are refetched, so this costs one request
 *     rather than one per cached home variant.
 *   • It happens once per deliberate user action. AniList allows 60/min; editing
 *     your own list does not come close, and the previous behaviour spent the same
 *     request anyway on the next cold start.
 *
 * So the rails update in place a beat after the sheet closes, with no spinner and
 * no jump. The alternative was correct on next launch and wrong in between.
 */
export function invalidateUserList(queryClient: QueryClient): Promise<void> {
  return Promise.all(
    USER_LIST_KEYS.map((queryKey) => queryClient.invalidateQueries({ queryKey }))
  ).then(() => undefined);
}

/**
 * The cache half of a PARTIAL entry write — the progress bumps and the
 * promote-to-watching, as opposed to the sheet's whole-entry save.
 *
 * Three calls that used to be open-coded in three places, which is how the app
 * ended up with three writes that told AniList something and left the cache saying
 * otherwise. They live here so the two rules below are enforced once:
 *
 *   1. NEVER INVENT AN ENTRY. A partial write patches the entry if one is already
 *      cached and leaves `null` as `null` if not. The optimistic phase does not know
 *      what AniList will do about a title that was not tracked, and guessing a
 *      status here would silently add a show to someone's real list. When the
 *      server does create one, `settleEntryWrite` writes the real thing.
 *   2. EVERY SETTLED WRITE INVALIDATES THE RAILS. This is the invalidation that
 *      was missing, and it belongs on the success path of every write rather than
 *      being remembered per call site.
 */
interface EntryWriteContext {
  key: ReturnType<typeof qk.listEntry>;
  previous: ListEntry | null | undefined;
}

async function beginEntryWrite(
  queryClient: QueryClient,
  mediaId: number
): Promise<EntryWriteContext> {
  const key = qk.listEntry(mediaId);
  // Cancel first so an in-flight read cannot land after the optimistic write and
  // overwrite it with the value we are replacing.
  await queryClient.cancelQueries({ queryKey: key });
  return { key, previous: queryClient.getQueryData<ListEntry | null>(key) };
}

function patchEntry(
  queryClient: QueryClient,
  ctx: EntryWriteContext,
  patch: Partial<ListEntry>
): void {
  if (ctx.previous == null) return;
  queryClient.setQueryData<ListEntry | null>(ctx.key, { ...ctx.previous, ...patch });
}

function settleEntryWrite(
  queryClient: QueryClient,
  mediaId: number,
  data: ListEntry | null | undefined
): void {
  queryClient.setQueryData<ListEntry | null>(qk.listEntry(mediaId), data ?? null);
  void invalidateUserList(queryClient);
}

function rollBackEntryWrite(queryClient: QueryClient, ctx?: EntryWriteContext): void {
  if (ctx) queryClient.setQueryData(ctx.key, ctx.previous);
}

/**
 * The user's entry for one title, or `null` for "not on the list".
 *
 * DISABLED WITHOUT A TOKEN rather than enabled-and-401ing. AniList answers an
 * unauthenticated `mediaListEntry` with a 401 error rather than null, and firing
 * that from every detail page a logged-out visitor opens would spend requests to
 * learn something the caller already knows.
 *
 * `staleTime` is long because a list entry is something a person sets
 * deliberately and then does not touch for weeks — and because the sheet reads it
 * on open, where a spinner would be the first thing the user sees.
 */
export function useListEntry(
  id: number,
  enabled: boolean
): {
  entry: ListEntry | null | undefined;
  loading: boolean;
  signedIn: boolean;
} {
  const query = useQuery({
    queryKey: qk.listEntry(id),
    queryFn: async (): Promise<ListEntry | null> => {
      const token = await getToken();
      if (!token) return null;
      return fetchEntry(token, id);
    },
    enabled,
    staleTime: 5 * 60_000,
  });

  // `undefined` while loading, `null` once known to be absent. The sheet needs
  // the difference: "no entry yet" must not pre-fill the form as if the user had
  // chosen nothing, and must not show the empty state either.
  return {
    entry: query.data,
    loading: query.isLoading,
    signedIn: enabled,
  };
}

export interface EntryDraft {
  status: MediaListStatus;
  progress: number;
  score: number;
  private: boolean;
  repeat: number;
  /**
   * NO `priority`, and that is deliberate — see `ListEntrySheet`'s header note.
   *
   * AniList has the field but publishes no value mapping for it, so there is no
   * way to label the numbers honestly. Leaving it out of the DRAFT is also what
   * makes the save safe: AniList's mutation is a partial update, so a draft
   * without the field leaves an existing priority alone rather than resetting it.
   */
}

/**
 * Save or remove an entry, and keep the rails honest afterwards.
 *
 * OPTIMISTIC, because the alternative is visibly worse: you tap a status, the
 * sheet closes, and the Continue rail on home does not gain the show until a
 * refetch lands a second or two later. The detail page's own bookmark icon
 * updates instantly either way, so the inconsistency would be "this screen knows
 * but home does not", which reads as a bug.
 *
 * The optimistic value is written to the ENTRY query only, not to the home
 * sections. Those are one big aliased request that would have to be refetched to
 * reflect the change, and doing that on a keystroke's worth of optimism is a poor
 * trade against AniList's rate limit — so home catches up on the next refetch or
 * next launch, and the entry itself is correct immediately.
 */
/**
 * What the mutation accepts.
 *
 * A UNION rather than one shape with an optional `remove`, because the two cases
 * carry genuinely different fields. A removal needs an entry id and nothing else —
 * every draft field would be ignored — and typing it as "a draft plus remove"
 * forced the caller to invent a status and a score for an action that has
 * neither. The compiler now rejects that, which is the point.
 */
export type EntryChange =
  | ({ remove?: false } & EntryDraft & { entryId?: number })
  | { remove: true; entryId: number };

// Per-title write lock. AniList's budget (gql.ts) already serialises every
// request globally, but two saves for the SAME title could still interleave
// their optimistic cache writes and leave the sheet showing a stale answer.
// This chains writes per mediaId so a second save waits for the first to
// settle. Cheap: one Map, one promise chain, released in `finally`.
const writeLocks = new Map<number, Promise<void>>();

async function withWriteLock<T>(mediaId: number, fn: () => Promise<T>): Promise<T> {
  const prev = writeLocks.get(mediaId) ?? Promise.resolve();
  let resolveLock!: () => void;
  const gate = new Promise<void>((r) => {
    resolveLock = r;
  });
  const chained = prev.then(() => gate);
  writeLocks.set(mediaId, chained);
  try {
    await prev.catch(() => {});
    return await fn();
  } finally {
    resolveLock();
    if (writeLocks.get(mediaId) === chained) writeLocks.delete(mediaId);
  }
}

export function useSaveListEntry(id: number, onDone?: () => void) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (change: EntryChange): Promise<ListEntry | null> => {
      // Serialise per title. The network call and the cache settle happen
      // inside the lock so a rapid second save cannot overtake the first.
      return withWriteLock(id, async () => {
        const token = await getToken();
        if (!token) throw new Error('Sign in to edit your list');

        if (change.remove) {
          await apiDeleteEntry(token, change.entryId);
          return null;
        }

        return apiSaveEntry(token, {
          mediaId: id,
          status: change.status,
          progress: change.progress,
          // AniList treats 0 as "no score", which is what an untouched rating
          // should send. Sending `null` is not an option on this mutation.
          score: change.score > 0 ? change.score : 0,
          private: change.private,
          repeat: change.repeat,
          // `priority` deliberately NOT sent — see `EntryDraft`.
        });
      });
    },

    onMutate: async (change) => {
      const key = qk.listEntry(id);
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<ListEntry | null>(key);
      // A removal writes `null` and nothing else. A save writes only the fields the
      // sheet edits, over whatever was cached — so a partial entry (a cache hit
      // from a lighter query) keeps its `notes` and `priority` rather than gaining
      // invented ones.
      queryClient.setQueryData<ListEntry | null>(key, (prev) =>
        change.remove
          ? null
          : {
              id: change.entryId ?? prev?.id ?? 0,
              status: change.status,
              progress: change.progress,
              score: change.score,
              private: change.private,
              repeat: change.repeat,
              priority: prev?.priority ?? 0,
              notes: prev?.notes ?? null,
            }
      );
      return { previous, key };
    },

    onError: (_err, _change, ctx) => {
      // Roll back rather than leave a lie on screen. The sheet reopens with the
      // server's answer and an error to explain it.
      //
      // NO INVALIDATION HERE, and that is the whole reason this is `onError` and
      // not `onSettled`. Nothing about the rails changed — the optimistic write
      // never touched them and the request failed — so refetching seventy items to
      // be told the same thing spends a request on nothing. The rollback above is
      // the complete correction.
      if (ctx) queryClient.setQueryData(ctx.key, ctx.previous);
    },

    onSuccess: (data) => {
      // Replace the optimistic value with the server's, which carries the entry
      // id the delete path needs and may normalise the score.
      queryClient.setQueryData<ListEntry | null>(qk.listEntry(id), data ?? null);
      // Now, and only now, the rails. This line being absent is why saving from the
      // sheet left Continue Watching and Planning showing the old list until the app
      // was restarted.
      void invalidateUserList(queryClient);
    },

    onSettled: () => {
      onDone?.();
    },
  });
}

/**
 * Record progress after an episode is watched, and promote the title if it was not
 * already being watched.
 *
 * A SEPARATE MUTATION rather than a third arm of `EntryChange`, because it has a
 * different caller with different rules. The sheet sends a whole entry the user
 * just chose in a form; this sends one number the player worked out on its own, at
 * most once per episode, and it must never be able to set a score or a repeat count
 * by accident.
 *
 * It used to be a raw `saveEntry` call in the watch screen, outside the query layer
 * entirely — which is half of why progress never showed up anywhere until a restart.
 * AniList was being told and the cache was not, so the detail page's "EP 4/12", its
 * bookmark state and the Continue Watching rail all carried on showing the number
 * from before the episode.
 *
 * WHY IT CARRIES A STATUS AT ALL, given the watch screen no longer sets one on the
 * way in. Because AniList only flips an entry to CURRENT when progress increases if
 * there IS an entry to flip, and a title nobody ever added has none. Sending
 * progress alone therefore does nothing for the first episode of an untracked show.
 *
 * The alternative — promoting on episode open, which is what this used to do — is
 * worse than the gap it fills. It cost a `fetchEntry` request per anime per session
 * purely to decide, and it marked shows "watching" for people who opened an episode
 * and closed the tab. Doing it HERE means the promotion is a consequence of having
 * watched 82% of something, which is the same fact AniList itself would act on, and
 * it is why this can be a partial update: nothing is written until there is a reason.
 *
 * It also does not depend on the behaviour above being true. If AniList would have
 * created the entry from a progress-only write, sending the status anyway is a
 * redundant field; if it would not, sending it is what makes the episode count at
 * all. The design is the same either way, which matters because whether the
 * progress-only path worked was never verified against the live API.
 *
 * `REPEATING` IS CARVED OUT, and that is the one case where sending CURRENT would
 * be wrong rather than merely redundant. A rewatch is its own status on AniList:
 * progress keeps climbing, and when it passes the episode count AniList increments
 * `repeat` and resets progress. Sending `status: CURRENT` alongside progress
 * overrides that and quietly ends the rewatch — the entry stops being REPEATING
 * mid-season, which is the one outcome worse than not syncing at all. So a rewatch
 * gets progress only, exactly as it did before.
 */
/**
 * Would writing `episode` move AniList's progress FORWARD?
 *
 * Lives in `lib/anilist/progress` so it can be tested without React Native —
 * see that file for why. Re-exported here because every caller of this module
 * already reaches for the mutation next to it.
 */
export { advancesProgress };

export function useSyncListProgress(mediaId: number) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (episode: number): Promise<ListEntry> => {
      /**
       * READ THE ENTRY BEFORE ANYTHING CAN PATCH IT — the order is the whole
       * fix, and it is not obvious.
       *
       * React Query runs `onMutate` TO COMPLETION before this function, and
       * `onMutate` used to paint the plan optimistically (forward progress +
       * the promotion) into this exact cache key. Reading the entry here,
       * after that paint, meant the plan was computed from its own output: the
       * cache already said `progress: episode`, `planProgressSync` saw nothing
       * to advance, and the mutation RESOLVED WITH NO REQUEST AT ALL. Every
       * tracked entry was affected — Planning and Watching alike — which is
       * why an episode could be watched to 82% (position saved locally, detail
       * page updated) while AniList never moved. The device caught it on
       * 15 Nov; the pure `planProgressSync` was correct in isolation, so the
       * bug lived entirely in this ordering.
       *
       * The optimistic patch therefore moved OUT of `onMutate` and DOWN here,
       * applied only once the plan is decided. `onMutate` still cancels
       * in-flight reads and hands `previous` back for the rollback.
       *
       * WHY THE CACHE AND NOT A FETCH: a miss is the common and correct
       * answer — it means untracked, which is exactly the case that needs
       * promoting — and after the first episode our own `onSuccess` has
       * written the real entry, so from then on the cache knows. A stale or
       * absent cache can only ever cause a REDUNDANT status here, never a
       * wrong one: the worst case is writing CURRENT onto something already
       * CURRENT, which is a no-op.
       */
      const key = qk.listEntry(mediaId);
      const entry = queryClient.getQueryData<ListEntry | null>(key);
      const media = queryClient.getQueryData<MediaDetail>(qk.media(mediaId));

      /**
       * THE PLAN, not a bare guard — see `planProgressSync`.
       *
       * The old shape asked only `advancesProgress` and resolved without
       * writing when it said no, which read as success to the caller: a
       * PLANNING entry whose cached progress already sat at or past the
       * watched episode was "marked" with nothing sent, and stayed Planning
       * forever. The plan adds the one write that guard blocked: promote
       * Planning → CURRENT on a no-advance watch, STATUS ONLY, so it can never
       * roll the account's progress backwards.
       */
      const plan = planProgressSync(entry, episode, media);

      // Optimistic, and deliberately AFTER the plan: the details page must not
      // flash "Resume Ep X" for a show about to be marked done, nor paint a
      // rolled-back number for the moment before the settle.
      if (plan.write) {
        patchEntry(queryClient, { key, previous: entry }, {
          ...(plan.progress !== undefined ? { progress: plan.progress } : null),
          ...(plan.status ? { status: plan.status } : null),
        });
      }

      /**
       * NOTHING TO SEND IS STILL A RESOLVE, not a failure.
       *
       * Returned rather than thrown, because "already at or past this episode"
       * is the desired end state for the remaining statuses. Throwing would
       * make the player treat it as a failed write — clear its flag and retry
       * on a 60s cooldown for the rest of the episode, i.e. a loop that can
       * never terminate because it can never become true. Resolving also lets
       * `onSuccess` write the entry we already hold back over the optimistic
       * patch, and lets the caller mark the episode synced, which is the
       * honest outcome: there is nothing left to send.
       */
      if (!plan.write) return entry!;

      const token = await getToken();
      if (!token) throw new Error('Sign in to track progress');

      return apiSaveEntry(token, {
        mediaId,
        ...(plan.progress !== undefined ? { progress: plan.progress } : null),
        ...(plan.status ? { status: plan.status } : null),
      });
    },

    onMutate: async () => {
      // Cancel in-flight reads so a slow one cannot land after the optimistic
      // patch, and capture the pre-write value for the rollback. The PATCH
      // itself lives in the mutation function now — see the note there for why
      // painting it here would make the function read its own output and skip
      // the write entirely.
      return beginEntryWrite(queryClient, mediaId);
    },

    onError: (_err, _episode, ctx) => {
      // The watch screen retries on its own schedule (a 60s cooldown), so the only
      // job here is to stop the optimistic number outliving a failure.
      rollBackEntryWrite(queryClient, ctx);
    },

    onSuccess: (data) => {
      settleEntryWrite(queryClient, mediaId, data);
      // Continue Watching sorts by `UPDATED_TIME_DESC`, so bumping an episode moves
      // the title to the front of its rail. Once per episode, which the watch
      // screen's own 82%-of-runtime rule already limits this to.
    },
  });
}
