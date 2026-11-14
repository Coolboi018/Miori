// WHO THE ACCOUNT IS, as a query.
//
// THREE SCREENS ASKED FOR THIS INDEPENDENTLY. `app/modal.tsx`,
// `app/settings/index.tsx` and `app/settings/accounts.tsx` each held their own
// `useState<Viewer | null>`, each ran its own effect, and each called `fetchViewer`
// on mount. That is three identical requests for one answer, three loading flags to
// keep in step, and no way for any of them to hear that the account changed while
// the screen was open.
//
// As a query it is one entry. Opening Settings after visiting the account sheet is a
// cache read rather than a round-trip, and signing in or out updates every screen
// showing a name or an avatar at once — because `completeSignIn` and
// `completeSignOut` are the only things that write this key.
//
// SIGNED OUT IS `null`, NOT AN ERROR, and that is the whole reason `queryFn` checks
// the token before asking. An unauthenticated `Viewer` is a 401, and a 401 would
// render as "AniList is down" in an account settings screen — on the one screen
// where that message is least welcome and most confusing.

import { useQuery, type QueryClient } from '@tanstack/react-query';
import { getToken } from '@/lib/anilist/auth';
import { fetchViewer, type Viewer } from '@/lib/anilist/lists';
import { qk } from '@/lib/query/keys';
import { useUserId } from './session';

/**
 * Five minutes.
 *
 * A name and an avatar do not move, and every screen that shows one wants it
 * painted the instant it opens. Long enough that hopping between the account sheet
 * and Settings costs nothing; short enough that a display-name change made on the
 * website turns up without a restart.
 */
const VIEWER_STALE_MS = 5 * 60_000;

export function useViewer(): {
  viewer: Viewer | null | undefined;
  loading: boolean;
} {
  const userId = useUserId();

  const query = useQuery({
    queryKey: qk.viewer(),
    queryFn: async (): Promise<Viewer | null> => {
      const token = await getToken();
      if (!token) return null;
      return fetchViewer(token);
    },
    // Disabled until the session is known, for the same reason the home query waits:
    // asking on a guess is how you spend a request on an answer you already have.
    enabled: userId !== undefined,
    staleTime: VIEWER_STALE_MS,
    /**
     * NO RETRY. Every other query in the app retries once because a failure is
     * almost always a dropped connection. Here a likely cause is a token AniList
     * rejected, and retrying an auth failure just spends a second request to be told
     * the same thing. The screens behind this already render "Not logged in" for
     * any absence, which is the correct reading of a 401.
     */
    retry: false,
  });

  return { viewer: query.data, loading: query.isLoading };
}

/**
 * Publish a viewer we already hold.
 *
 * `completeSignIn` has just called `fetchViewer` to validate the token — so the
 * answer is in hand, and asking for it again on the first screen that opens would
 * be a request spent on a value this line already has.
 */
export function seedViewer(queryClient: QueryClient, viewer: Viewer): void {
  queryClient.setQueryData(qk.viewer(), viewer);
}