// The state behind the schedule screen's seven-day window.
//
// WHAT THIS IS FOR, NOW THAT THERE IS A CACHE UNDERNEATH IT. One hook, seven
// `useAiringDay` calls in a fixed-length array, and a `byDay` map keyed on local
// midnight. That is deliberately thin — the fetching, the expiry and the
// in-flight sharing all moved to `lib/query`, and what is left here is the only
// part that was ever this screen's problem: turning seven independent day
// results into ONE map with a status per day, because the screen's single most
// important distinction is between a day that has nothing on it and a day that
// has not answered yet. Confusing those is how a streaming list becomes a lie.
//
// ONLY ASKED DAYS ARE ASKED FOR. This is the single most expensive thing in the
// app's request budget and it used to be entirely free of choice: seven
// `useAiringDay` calls, all enabled, all in the same commit, on a tab that mounts
// at boot because of `lazy: false`.
//
// WHAT THAT ACTUALLY COST, since it is not the number it looks like. The
// transport admits requests against a sliding 24-per-minute window
// (`lib/net/gql.ts`), so the app never 429s — but a week of airings is one to
// four requests PER DAY, and seven of those at boot fills that entire window on
// its own. Everything else then queues behind days the user may never scroll to:
// home's revalidation, explore's grid, and the first thing they type into search.
// That is very likely why searching feels slow immediately after opening the app,
// and it is a worse symptom than a 429 because it is silent.
//
// So days are ASKED FOR, not merely rendered. A day that has not been asked is
// `idle`, which draws exactly what a `loading` day draws — the same "Loading…"
// note — so nothing about the screen's appearance changes. Only the request is
// deferred, to the moment the user scrolls near that day, taps its rail chip, or
// switches to it in day view.
//
// WHY NOT ONE QUERY FOR DAYS 2-7, which is the obvious cheaper shape and is
// wrong. AniList pages `airingSchedules` at 50 a page, and a week is 300-plus
// episodes, so a six-day range is six pages minimum — no saving on the request
// count, and a real risk of a lie: if Monday alone fills the budget, day six
// comes back empty and indistinguishable from "nothing scheduled", which is
// precisely the confusion this hook exists to prevent. Per-day is what makes
// each day's emptiness honest. The waste was never in the SHAPE of the request,
// it was in asking for seven of them before anyone has looked at one.
//
// NEVER BLANKS A LIST IT ALREADY HAS. Re-focusing the tab, flipping to day view
// and pulling to refresh all re-enter here, and every one of them must be free
// against a warm cache and invisible against a warm list. So a day only reads as
// `loading` when it has nothing to show, and a failed revalidation leaves the
// data on screen alone.
//
// STATE GROWS BY ONE KEY PER DAY AND STOPS. `useAiringDay` is only ever called
// with days from the current window, so a tab left open overnight accumulates
// seven stale keys and no more — and TanStack garbage-collects each one
// thirty minutes after the window stops referencing it.

import { useMemo } from 'react';

import { addDays, startOfDay, type AiringItem } from '@/lib/anilist/schedule';
import { qk } from '@/lib/query/keys';
import { useAiringDay } from '@/lib/query/hooks';
import { queryClient, refetchIfStale } from '@/lib/query/client';

/**
 * `idle` is new and it is the whole point.
 *
 * It means "nobody has asked AniList about this day yet", which is different
 * from every other state and has to be, because the two are used differently:
 * an `idle` day must not dim the list (nothing is in flight) and must not block
 * "is this week verifiably empty" on its own — except when today is genuinely
 * empty, in which case the screen escalates and asks for the rest.
 */
export type AiringDayStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface AiringDayState {
  status: AiringDayStatus;
  items: AiringItem[];
  /** AniList had more of this day than the page ceiling allowed. */
  truncated: boolean;
  error: string | null;
}

export interface AiringWindow {
  byDay: Record<number, AiringDayState>;
  /** Re-check every day. Free when the cache is warm; a revalidation when not. */
  refresh: () => void;
  /**
   * Drop the cache and fetch every day again.
   *
   * The cache has to go, or a failure inside the ten-minute TTL is served
   * straight back and the retry button does precisely nothing — the worst thing
   * a retry button can do.
   */
  retry: () => void;
  /** Re-fetch ONE day. One request for one day, not the seven a retry costs. */
  reloadDay: (start: number) => void;
}

/**
 * Seven hooks in a fixed-length array.
 *
 * Hooks in a loop are legal ONLY because the count is constant for the lifetime
 * of the screen — it is `WEEK_DAYS`, a constant. A loop whose length could change
 * would reorder hooks between renders and corrupt every one of them, which is
 * why `days` is taken apart here rather than mapped by a caller that might pass
 * a different number of days.
 */
const WEEK_DAYS = 7;

function useAiringWindowData(days: number[], asked: Set<number>) {
  return [
    useAiringDay(days[0], { enabled: asked.has(days[0]) }),
    useAiringDay(days[1], { enabled: asked.has(days[1]) }),
    useAiringDay(days[2], { enabled: asked.has(days[2]) }),
    useAiringDay(days[3], { enabled: asked.has(days[3]) }),
    useAiringDay(days[4], { enabled: asked.has(days[4]) }),
    useAiringDay(days[5], { enabled: asked.has(days[5]) }),
    useAiringDay(days[6], { enabled: asked.has(days[6]) }),
  ];
}

export function useAiringWindow(days: number[], asked: Set<number>): AiringWindow {
  const queries = useAiringWindowData(days, asked);

  const byDay = useMemo(() => {
    const out: Record<number, AiringDayState> = {};
    days.forEach((start, i) => {
      const q = queries[i];
      if (!q) return;
      if (!asked.has(start)) {
        // Never asked. Distinct from `loading` on purpose — see the type.
        out[start] = { status: 'idle', items: [], truncated: false, error: null };
        return;
      }
      // `error && !data` is the only combination worth calling a failure. An
      // error over data that is already on screen is a revalidation that did not
      // land, and showing it as an error card would blank a day that is fine.
      if (q.data && !q.error) {
        out[start] = {
          status: 'ready',
          items: q.data.items,
          truncated: q.data.truncated,
          error: null,
        };
      } else if (q.error && !q.data) {
        out[start] = { status: 'error', items: [], truncated: false, error: String(q.error.message ?? q.error) };
      } else {
        out[start] = { status: 'loading', items: [], truncated: false, error: null };
      }
    });
    return out;
  }, [days, queries, asked]);

  /**
   * Only days that have been asked for.
   *
   * A disabled query is still an ACTIVE observer, so `refetch()` would fire for
   * it — which is how a "refresh" that respects `staleTime` would quietly become
   * the seven-forced-requests bug this file spent a pass removing. Filtering
   * here is the difference between a no-op against a warm cache and a burst.
   */
  const askedQueries = useMemo(
    () => queries.filter((_, i) => asked.has(days[i])),
    [queries, asked, days]
  );

  return {
    byDay,

    /**
     * Re-check every day AGAINST ITS OWN TEN-MINUTE TTL.
     *
     * `refetchIfStale`, not `refetch()`. This was the worst instance of the
     * `staleTime`-bypass bug: seven days, each one a paginated walk of one to
     * four AniList requests, all forced on every single focus of the tab. Seven
     * forced requests is well past the rate limit, so this reliably produced
     * 429s, and a 429 makes the transport sit out `Retry-After` — which is why
     * the schedule tab was the slowest one to switch to.
     *
     * Against a cache under ten minutes old this now does nothing at all, which
     * is the correct answer: airing times change when AniList corrects one, not
     * when you look at them.
     */
    refresh: () => {
      for (const q of askedQueries) refetchIfStale(q);
    },

    /**
     * Force every asked-about day again. This is the retry button, so "force" is
     * the point — a failure inside the TTL has to be escapable or the button does
     * nothing, which is the worst thing a retry button can do.
     *
     * NOT the days nobody asked about: re-asking those would spend the budget the
     * deferral just saved, to repair a failure on a day nobody is looking at.
     */
    retry: () => {
      for (const q of askedQueries) void q?.refetch();
    },

    /** One day, forced. One request for one day, not the seven a retry costs. */
    reloadDay: (start: number) => {
      void queryClient.invalidateQueries({ queryKey: qk.airingDay(start), exact: true });
    },
  };
}

export { WEEK_DAYS, addDays, startOfDay };
