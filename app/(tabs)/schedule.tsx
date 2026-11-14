// SCHEDULE — what airs, when, and how long until it.
//
//   ┌ Schedule ────────────────────────────────┐   NavBar, floating, unchanged
//   │ This week                    [Week|Day]  │   THE HEADLINE says which of
//   │ 312 episodes · UTC+05:30                 │   the two is in view and the
//   │  ╭────╮╭────╮╭────╮╭────╮╭────╮╭──╮╭──╮ │   only count beneath it.
//   │  │SAT ││SUN ││MON ││TUE ││WED ││TH││FR│ │   THE RAIL is both the day
//   │  │ 3  ││ 4  ││ 5  ││ 6  ││ 7  ││ 8││ 9│ │   filter (day view) and the
//   │  │18  ││42  ││31  ││27  ││22  ││ …││ …│ │   scroll marker (week view).
//   │  ╰────╯╰────╯╰────╯╰────╯╰────╯╰──╯╰──╯ │
//   │  ╭─ NEXT UP ──────────────────────────╮  │   ONE hero: the soonest
//   │  ░░░░ banner ░░░░ Frieren · in 2h 05m ░│  │   upcoming airing anywhere in
//   │  ╰──────────────────────────────────╮  │   view. The screen's one job.
//   │  ┃SAT 3 OCT                [TODAY] 18│  │   SEVEN DAY CARDS below it,
//   │  18:00 ▢ Frieren: Beyond Journey's…  │  │   each a surface card with a
//   │  in 2h    ● EP 12 · TV                 │  │   hairline, not a flat list.
//   │  ──────────────────────────────────  │  │
//   │  19:30 ▢ Solo Leveling — Beyond…      │
//   │  ╰──────────────────────────────────╯  │
//   └────────────────────────────────────────┘
//
// WEEK OR DAY, AND IT IS BOTH — the old screen asked for the next 24 hours,
// which is neither. A week is what a viewer actually plans around (an entire
// cour fits in it) and a day is what they check on the morning of. Twenty-four
// hours is what a database can answer with one range query and it is why the
// original page was a flat undated list that mixed Thursday and Friday into one
// scroll with the weekday buried in a sentence.
//
// WHY DAY VIEW IS ITS OWN LAYOUT AND NOT A FILTERED WEEK. With one day in view
// there is no reason to repeat the weekday on a header and a hero and a rail
// chip, and the header has room to say what the week view cannot: the day in
// full, and the count under it. Same rows, same card, one section.
//
// EVERY CELL HAS A FIXED HEIGHT, so the list is honest about where things are.
// `getItemLayout` is a promise — FlatList scrolls to exactly the offset it is
// handed — which means one of these numbers being wrong is not a small
// inaccuracy, it is the list jumping to the wrong day when you tap a rail chip.
// The gap between day cards is PADDING inside `DAY_HEADER_HEIGHT`, never a
// margin, because a margin sits outside the box FlatList measures.
//
// THE HEADER IS OUTSIDE THE LIST. The NavBar is `position: absolute`, so a
// header inside `ListHeaderComponent` would slide up under it — and this one
// carries the controls you reach for while reading, not just at the top of it.
//
// DAY-BY-DAY, STREAMING. See `lib/schedule/useAiringWindow.ts`: today's card
// paints after one or two requests and the other six fill in behind it, because
// a seven-day view that waits for all seven is a seven-day spinner.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { openAnime } from '@/lib/nav/pushOnce';
import {
  FlatList,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import type {
  ListRenderItem,
  NativeScrollEvent,
  NativeSyntheticEvent,
} from 'react-native';
import { useFocusEffect } from 'expo-router';

import { addDays, startOfDay, type AiringItem } from '@/lib/anilist/schedule';
import type { MediaItem } from '@/lib/anilist';
import { useAiringWindow } from '@/lib/schedule/useAiringWindow';
import { updateBrowsing } from '@/lib/presence/discord';
import { useNow } from '@/lib/ui/useNow';
import { useIsFocusedNow } from '@/lib/ui/useIsFocusedNow';
import { useTheme } from '@/lib/ui/useTheme';
import { useTabBarClearance } from '@/lib/ui/tabBar';
import { font, layout, spacing } from '@/lib/ui/tokens';

import { NavBar, useNavOffset } from '@/components/nav/NavBar';
import { AiringRow, AIRING_ROW_HEIGHT } from '@/components/schedule/AiringRow';
import { DayHeader, DayNote, DAY_HEADER_HEIGHT, NOTE_ROW_HEIGHT } from '@/components/schedule/DayHeader';
import { NextUpCard, NEXT_UP_HEIGHT } from '@/components/schedule/NextUpCard';
import { WeekRail, type RailDay } from '@/components/schedule/WeekRail';
import { ScheduleEmpty, ScheduleError, ScheduleSkeleton } from '@/components/schedule/ScheduleStates';
import { PillSelector, type PillItem } from '@/components/ui/Pills';
import {
  airingKey,
  fullDayLabel,
  plural,
  utcOffsetLabel,
} from '@/components/schedule/format';

/** How far ahead the window reaches. A cour fits inside seven days. */
const WEEK_DAYS = 7;

/**
 * The countdown's clock. Half a minute is finer than the word "in 42m" can
 * express and coarse enough that a fast fling is not fighting a re-render.
 */
const TICK_MS = 30_000;

/**
 * HOW FAR AHEAD THE BACKGROUND WARM REACHES, as a day index from today.
 *
 * The trickle below used to warm all seven days on the first visit to this tab,
 * and a day is NOT one request — `loadAiringDay` walks AniList's 50-per-page
 * until `hasNextPage` is false, so a busy Saturday is three or four. Seven days
 * is therefore up to a dozen round trips, spent on days the user has not asked
 * to see, in the same window that home, explore and the first search all need to
 * be admitted through.
 *
 * Two days ahead is the smallest horizon that still keeps the tab honest: the
 * user sees today plus the two below it without waiting, and everything past
 * them is asked for the moment it comes near — one ahead of the scroll, or on a
 * rail tap, or by switching to day view (all three triggers already existed and
 * all three still fire). A day that arrives ~300ms after it scrolls into view is
 * a day the user never notices was missing.
 *
 * "Near" rather than "the whole week" is also what a schedule page is FOR: a
 * viewer plans around the next couple of days, and the week is there to be
 * scrolled when they want it. Spending the budget up front to make scrolling
 * cheaper is the trade this screen had backwards.
 */
const WARM_AHEAD_DAYS = 2;

type ScheduleMode = 'week' | 'day';

const MODE_ITEMS: PillItem<ScheduleMode>[] = [
  { key: 'week', label: 'Week' },
  { key: 'day', label: 'Day' },
];

/**
 * One cell of the list.
 *
 * A FLAT UNION rather than a `SectionList`, and the reason is the height
 * contract above: with every cell's box known in advance the screen can prefix-
 * sum them into a jump table and hand exact offsets to both `getItemLayout` and
 * the rail. A `SectionList` owns its cells' measurement and gives no way to ask
 * where a particular day starts, which is the one thing the rail needs.
 *
 * `h` travels on the row rather than living in a lookup table, so the cell that
 * draws something and the cell that measures it cannot disagree.
 */
type Row =
  | { kind: 'next'; h: number; airing: AiringItem; day: number }
  | { kind: 'day'; h: number; start: number; day: number; count: number | null; truncated: boolean }
  | { kind: 'airing'; h: number; item: AiringItem; day: number; isFirst: boolean; isLast: boolean }
  | {
      kind: 'note';
      h: number;
      day: number;
      text: string;
      tone: 'muted' | 'danger';
      /** Only the failure carries one — see `DayNote`. */
      onPress?: () => void;
    };

export default function ScheduleScreen() {
  const { color } = useTheme();
  const { width: screenW } = useWindowDimensions();
  const offset = useNavOffset();
  const tabBarSpace = useTabBarClearance();
  const listRef = useRef<FlatList<Row>>(null);

  /**
   * THE CLOCK ONLY TICKS WHILE THE SCREEN IS VISIBLE.
   *
   * This is the single biggest background-CPU win in the tab bar. Tabs stay
   * mounted forever, so before this the 30-second tick that drives every
   * countdown on the screen kept waking a ~300-cell FlatList every half minute
   * for the entire session — on a tab nobody was looking at, competing with the
   * tab the user WAS looking at.
   *
   * IT IS A REF, NOT A STATE FLAG, and that is the part that matters. The obvious
   * implementation is `const [visible, setVisible] = useState(true)` inside a
   * `useFocusEffect`, which is what this used to be — and `setState` on a focus
   * change is a RE-RENDER. So every tap of the tab bar was re-rendering this
   * screen's ~300-cell list in order to flip a boolean that only the interval
   * callback reads. The ref reads the same value with no render at all.
   *
   * Pausing is free of correctness cost either way: every countdown formats an
   * absolute timestamp at render, so a screen paused for a minute shows the right
   * time on its first frame back.
   */
  const isFocusedNow = useIsFocusedNow();
  const now = useNow(TICK_MS, isFocusedNow);

  const [mode, setMode] = useState<ScheduleMode>('week');
  /**
   * The day the rail picked, in DAY view. Null until one is tapped, so the
   * screen opens on today. It is stored as a day the user chose rather than as
   * "index", which means the rail keeps working when the window rolls over at
   * midnight and every index shifts under it.
   */
  const [picked, setPicked] = useState<number | null>(null);
  /**
   * The day at the top of the viewport, in WEEK view. State rather than a
   * derived value because the list's scroll offset is the only source for it,
   * and it is the one thing that lets a seven-day scroll say where it is.
   */
  const [scrolledDay, setScrolledDay] = useState<number | null>(null);

  // `today` comes off the tick, so the window turns over at midnight by itself
  // and the hook below re-fetches seven new days.
  const today = startOfDay(now);
  const weekDays = useMemo(
    () => Array.from({ length: WEEK_DAYS }, (_, i) => addDays(today, i)),
    [today]
  );
  // A pick from before the rollover is no longer in the window; fall back rather
  // than rendering a day the fetcher knows nothing about.
  const selected = picked != null && weekDays.includes(picked) ? picked : today;

  /**
   * WHICH DAYS WE HAVE ASKED ANILIST ABOUT. See the note on `useAiringWindow` for
   * the whole reason this exists; the short version is that seven days of
   * airings is one to four requests EACH, the tab mounts at boot because of
   * `lazy: false`, and those requests were eating the transport's entire
   * 24-per-minute budget before the user had tapped anything.
   *
   * Today is always in the set, because today is what the tab is for and
   * `startWarmup` has usually already paid for it. Everything else joins the set
   * when the user goes near it.
   *
   * `Set` rather than a "how many days" prefix because day view can legitimately
   * want a single day in the middle of the week: a prefix would ask for
   * everything before it.
   */
  const [asked, setAsked] = useState<Set<number>>(() => new Set([today]));
  const askFor = useCallback((...starts: number[]) => {
    setAsked((prev) => {
      let next = prev;
      for (const s of starts) {
        if (prev.has(s)) continue;
        // Copy-on-write so an unchanged set keeps its identity and the hook below
        // does not rebuild `byDay` on every scroll frame.
        if (next === prev) next = new Set(prev);
        next.add(s);
      }
      return next;
    });
  }, []);

  /**
   * MIDNIGHT RESETS THE SET.
   *
   * `today` is derived from the clock, so when it rolls the whole window shifts
   * and yesterday's day-starts are no longer days this screen can ask about.
   * Without this the set would keep seven dead keys and the new week would start
   * with nothing asked — the one case where laziness would actually cost the
   * user a blank screen.
   *
   * The identity check keeps this a no-op on mount, so the screen does not pay
   * an extra render for a set it already built correctly.
   */
  useEffect(() => {
    setAsked((prev) => (prev.size === 1 && prev.has(today) ? prev : new Set([today])));
  }, [today]);

  const { byDay, retry, reloadDay } = useAiringWindow(weekDays, asked);

  useFocusEffect(
    useCallback(() => {
      updateBrowsing('Airing schedule');
    }, [])
  );

  // NO REFRESH ON FOCUS.
  //
  // This one read well — "re-check on focus, free against the ten-minute TTL" —
  // and it was still wrong, because `refresh` was seven `refetch()` calls and
  // `refetch()` bypasses `staleTime`. Seven forced requests, each a paginated
  // walk of one to four AniList calls, on every tap of the tab bar. That is well
  // past the rate limit, so it reliably produced 429s, and a 429 makes the
  // transport sit out `Retry-After` — which is why this tab was the slowest one
  // to switch to.
  //
  // `refresh` still exists and is still correct for a caller that wants it (see
  // `useAiringWindow`); it just is not wired to focus. Freshness for this screen
  // comes from the midnight rollover, which re-keys the window and makes the
  // mount path fetch, and from `refetchStaleOnForeground` when the app resumes.

  // ---- scope --------------------------------------------------------------

  const visibleDays = useMemo(
    () => (mode === 'day' ? [selected] : weekDays),
    [mode, selected, weekDays]
  );

  const total = useMemo(
    () => visibleDays.reduce((n, d) => n + (byDay[d]?.items.length ?? 0), 0),
    [visibleDays, byDay]
  );

  /**
   * `verifiablyEmpty` is the load-bearing word, and `allReady` is what earns it.
   *
   * A day that has not ANSWERED is not a day with nothing on it, and NEITHER is a
   * week whose first day happens to be empty while six more are in flight. So the
   * empty state waits for every visible day to have actually said "none".
   *
   * A day nobody has ASKED about is a third thing, and it has to be respected in
   * both directions:
   *
   *   - It must not block `verifiablyEmpty` on its own, or the screen would sit
   *     on "Loading…" forever for a week the user has simply not scrolled into.
   *   - It must not let the screen claim the week is empty either. That is what
   *     the escalation below is for: today coming back genuinely empty is the one
   *     signal that means "go and ask about the rest", and only then is the
   *     week's emptiness a question worth answering.
   *
   * So `allReady` means "every day in view has been asked AND has said none".
   */
  const allAskedReady = visibleDays
    .filter((d) => asked.has(d))
    .every((d) => byDay[d]?.status === 'ready');
  const allReady = allAskedReady && visibleDays.every((d) => asked.has(d));
  const anyReady = visibleDays.some((d) => byDay[d]?.status === 'ready');
  /** In flight right now — the trickle's "one at a time" test. */
  const anyLoading = visibleDays.some((d) => byDay[d]?.status === 'loading');
  const anyError = visibleDays.some((d) => byDay[d]?.status === 'error');
  const firstError =
    visibleDays.map((d) => byDay[d]?.error).find((e): e is string => !!e) ??
    'AniList did not answer.';
  const verifiablyEmpty = allReady && total === 0;

  /**
   * THE ESCALATION: an empty today means ask for the week.
   *
   * A quiet today is normal and should stay quiet — that is the whole point of
   * not asking. But it is also the one case where the remaining six days decide
   * whether this screen has anything to say at all, and it is cheap to check
   * because "today has nothing on" is a fact the first day already established.
   * One-shot: the set only ever grows, so this fires at most once per window.
   */
  useEffect(() => {
    if (mode !== 'week') return;
    if (byDay[today]?.status !== 'ready') return;
    if ((byDay[today]?.items.length ?? 0) > 0) return;
    if (visibleDays.every((d) => asked.has(d))) return;
    askFor(...weekDays);
  }, [mode, byDay, today, visibleDays, asked, askFor, weekDays]);

  /**
   * THE REST OF THE WEEK, ONCE THE USER ASKS FOR IT.
   *
   * Three ways in, and each one is a moment the user has expressed that they
   * want a day: scrolling near it, tapping its rail chip, or switching to it in
   * day view. One AHEAD of the scroll position, because a day that is still being
   * fetched when it scrolls into view is a day the user watches fill in, and one
   * that was asked for a second early usually just arrives.
   */
  useEffect(() => {
    if (scrolledDay == null) return;
    const i = weekDays.indexOf(scrolledDay);
    if (i < 0) return;
    // `.filter(Boolean)` rather than trusting the index: the last day has no
    // tomorrow, and `weekDays[7]` would put `undefined` in the set.
    askFor(...[weekDays[i], weekDays[i + 1]].filter((d): d is number => d != null));
  }, [scrolledDay, weekDays, askFor]);

  useEffect(() => {
    askFor(selected);
  }, [selected, askFor]);

  /**
   * THE TRICKLE: the rest of the week, one day at a time, in the background.
   *
   * Deferring to the scroll alone was too austere. It saved the whole budget,
   * but it also meant that scrolling to Wednesday showed a "Loading…" note for
   * however long that day's round trip took — which is a worse thing to hand
   * someone than spending a little of the budget.
   *
   * So the week is warmed, but on three terms:
   *
   *   1. ONE AT A TIME. The next day is only asked for once the previous one has
   *      settled. That is what "not at once" means here, and it matters most on
   *      the day the budget is nearly full: a burst of seven would be admitted
   *      at one per 2.5 seconds and the LAST day would arrive two minutes after
   *      the first, which is worse than not having asked at all. Sequential means
   *      the week completes in the time seven round trips actually take.
   *   2. ONLY WHILE THE TAB IS VISIBLE. This is the term that makes the whole
   *      thing free. The tab is mounted from boot (`lazy: false`) but not focused,
   *      so without this the trickle would spend the first minute's budget on a
   *      screen nobody is looking at — which is the original bug. A user who
   *      never opens Schedule never pays for the days after today.
   *   3. IT NEVER WAITS ON THE USER. Nothing here depends on scrolling, tapping
   *      or switching mode. The scroll and rail triggers below are still there
   *      and still useful — they ask sooner when the user has already told us
   *      what they want — but the week finishes warming either way.
   *
   * There is no delay timer in here on purpose. One day per round trip is already
   * the spacing we want; adding a sleep would just make the tab feel slower than
   * the network actually is.
   *
   * AND IT STOPS AT `WARM_AHEAD_DAYS` (term 4, added 14 Nov): today plus two.
   * Warming the whole week made the first visit to this tab the single largest
   * spend in the app — seven day-walks, each one to four requests — to make
   * scrolling cheaper for someone who may never scroll. Past the horizon a day
   * joins the set when the user goes near it, which every trigger below already
   * does: `onScroll` asks for the day under the viewport AND its tomorrow, a
   * rail tap asks before it scrolls, and day view asks for its one day.
   */
  useEffect(() => {
    if (!isFocusedNow) return;
    // DAY VIEW HAS ONE DAY. Warming six more behind a screen that cannot show
    // them is pure waste; the rail asks for whichever day it lands on.
    if (mode !== 'week') return;
    if (anyLoading) return;
    if (asked.size >= WEEK_DAYS) return;
    const nextIndex = weekDays.findIndex((d) => !asked.has(d));
    if (nextIndex < 0 || nextIndex > WARM_AHEAD_DAYS) return;
    askFor(weekDays[nextIndex]);
  }, [isFocusedNow, mode, anyLoading, asked, weekDays, askFor]);

  // ---- rows ---------------------------------------------------------------

  /**
   * THE SOONEST UPCOMING AIRING IN SCOPE — the reference itself, not a wrapper
   * around it.
   *
   * A walk over the visible days in order and each day's items in time order,
   * taking the first one still in the future. Both are already sorted (`sort:
   * TIME` from AniList, and a stable re-sort in the fetcher), so this is a short
   * walk rather than a minimum over three hundred entries.
   *
   * Returned as the bare airing because its identity then comes from `byDay` and
   * is stable for as long as the data is. A `{ item, day }` wrapper would be a
   * fresh object every time the memo recomputed, and `rows` depends on this —
   * which would rebuild every cell in the list on every tick.
   */
  const nextUp = useMemo((): AiringItem | null => {
    for (const start of visibleDays) {
      const items = byDay[start]?.items;
      if (!items) continue;
      for (const a of items) {
        if (a.airingAt > now) return a;
      }
    }
    return null;
  }, [visibleDays, byDay, now]);

  /**
   * Identity of that airing, compared by key rather than by timestamp — two shows
   * very often share an airing slot to the second, and a stripe on both of them
   * is more honest than picking one at random.
   */
  const nextKey = useMemo(() => (nextUp ? airingKey(nextUp) : null), [nextUp]);

  const rows = useMemo<Row[]>(() => {
    if (verifiablyEmpty) return [];

    const out: Row[] = [];

    if (nextUp) {
      // An airing belongs to the local day it airs in, so the hero's day label
      // is arithmetic on the timestamp rather than state the walk had to carry.
      const day = startOfDay(nextUp.airingAt);
      out.push({ kind: 'next', h: NEXT_UP_HEIGHT, airing: nextUp, day });
    }

    for (const start of visibleDays) {
      const state = byDay[start];
      const items = state?.items ?? [];

      out.push({
        kind: 'day',
        h: DAY_HEADER_HEIGHT,
        start,
        day: start,
        // Null — not zero — until the day answers. The header prints `…`, which
        // is the difference between "loading" and "nothing on".
        count: state?.status === 'ready' ? items.length : null,
        truncated: !!state?.truncated,
      });

      if (items.length === 0) {
        const failed = state?.status === 'error';
        out.push({
          kind: 'note',
          h: NOTE_ROW_HEIGHT,
          day: start,
          text: failed
            ? "Couldn't load this day — tap to retry"
            : state?.status === 'ready'
              ? 'Nothing scheduled'
              : 'Loading…',
          tone: failed ? 'danger' : 'muted',
          // One request for one day, not the seven the whole-screen retry costs.
          onPress: failed ? () => reloadDay(start) : undefined,
        });
        continue;
      }

      items.forEach((item, i) => {
        out.push({
          kind: 'airing',
          h: AIRING_ROW_HEIGHT,
          item,
          day: start,
          isFirst: i === 0,
          isLast: i === items.length - 1,
        });
      });
    }

    return out;
    // `reloadDay` is stable, so a note's handler does not churn every cell.
  }, [visibleDays, byDay, nextUp, verifiablyEmpty, reloadDay]);

  // ---- geometry -----------------------------------------------------------

  /**
   * The jump table. Every cell's height is known before render, so offsets are
   * arithmetic rather than measurement — which is what makes both `getItemLayout`
   * and "scroll to Thursday" exact.
   */
  const table = useMemo(() => {
    let y = 0;
    const offsets: number[] = [];
    for (const r of rows) {
      offsets.push(y);
      y += r.h;
    }
    return { offsets, total: y };
  }, [rows]);

  const getItemLayout = useCallback(
    (_data: ArrayLike<Row> | null | undefined, index: number) => ({
      length: rows[index]?.h ?? 0,
      offset: table.offsets[index] ?? 0,
      index,
    }),
    [rows, table]
  );

  /** Index of each day's header cell — what a rail tap scrolls to. */
  const dayIndex = useMemo(() => {
    const map: Record<number, number> = {};
    rows.forEach((r, i) => {
      if (r.kind === 'day') map[r.start] = i;
    });
    return map;
  }, [rows]);

  /** The day each cell belongs to, parallel to `rows` — the rail's source. */
  const rowDays = useMemo(() => rows.map((r) => r.day), [rows]);

  // ---- navigation ---------------------------------------------------------

  // Guarded — see `lib/nav/pushOnce.ts`.
  const openMedia = useCallback((m: MediaItem) => openAnime(m.id), []);
  const openAiring = useCallback((a: AiringItem) => openMedia(a.media), [openMedia]);

  /**
   * BACK TO THE TOP WHEN THE SCOPE CHANGES.
   *
   * Flipping Week to Day replaces every cell, and picking a different day in Day
   * view replaces the whole list — so the old offset is pointing into content
   * that no longer exists. Left alone, FlatList clamps it and the new day opens
   * at an arbitrary place, which is the app having lost its place.
   *
   * The rail's filled chip is reset with it, for the same reason: in week view it
   * mirrors the scroll, and a stale one would claim you are somewhere you are
   * not.
   */
  useEffect(() => {
    listRef.current?.scrollToOffset({ offset: 0, animated: false });
    setScrolledDay(mode === 'week' ? today : null);
  }, [mode, selected, today]);

  const onRailSelect = useCallback(
    (start: number) => {
      // A tap on the rail is the most explicit "I want this day" there is, so it
      // asks immediately rather than waiting for the scroll to land and fire
      // `onScroll` — the rail chip is on screen and the user is watching.
      askFor(start);
      if (mode === 'day') {
        setPicked(start);
        return;
      }
      const idx = dayIndex[start];
      if (idx == null) return;
      listRef.current?.scrollToOffset({ offset: table.offsets[idx], animated: true });
    },
    [mode, dayIndex, table, askFor]
  );

  /**
   * WHERE AM I IN SEVEN DAYS.
   *
   * A binary search over the jump table for the cell under a quarter of the way
   * down the viewport, ten times a second. Not a scroll listener per row and not
   * `onViewableItemsChanged` on a mixed-height list: this reads one number and
   * does nine comparisons, and it only writes state when the day actually
   * changes — so a fling that crosses two days writes twice, not two hundred
   * times.
   */
  const onScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      if (mode !== 'week' || rows.length === 0) return;
      const { contentOffset, layoutMeasurement } = e.nativeEvent;
      const y = contentOffset.y + layoutMeasurement.height * 0.25;
      const { offsets } = table;

      let lo = 0;
      let hi = offsets.length - 1;
      let idx = 0;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (offsets[mid] <= y) {
          idx = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }

      const day = rowDays[idx];
      setScrolledDay((prev) => (prev === day ? prev : day));
    },
    [mode, rows.length, table, rowDays]
  );

  // ---- derived chrome -----------------------------------------------------

  const railDays = useMemo<RailDay[]>(
    () =>
      weekDays.map((start) => {
        const state = byDay[start];
        return {
          start,
          count: state?.status === 'ready' ? state.items.length : null,
          isToday: start === today,
        };
      }),
    [weekDays, byDay, today]
  );

  // In week view the filled chip FOLLOWS THE SCROLL; in day view it marks the
  // selection. One rail, two jobs, one `onSelect`.
  const railActive = mode === 'week' ? (scrolledDay ?? today) : selected;

  const offsetLabel = useMemo(() => utcOffsetLabel(now), [now]);

  /**
   * THE COUNT LINE, which is the screen's only running commentary and so has to
   * be true at every instant it is on screen.
   *
   * "0 episodes" while six days are still loading is a lie, and "Nothing
   * scheduled" is a worse one — so the three states are distinct: nothing yet
   * says so, a partial count says "so far", and only a complete window gets a
   * flat statement. The words change in a fixed-height line, so none of this
   * moves the rail underneath it.
   */
  const subtitle =
    (total > 0
      ? allReady
        ? plural(total, 'episode')
        : `${plural(total, 'episode')} so far`
      : allReady
        ? 'Nothing scheduled'
        : 'Loading…') + `  ·  ${offsetLabel}`;

  /** Dimmed, never hidden, while days are still arriving under a full list. */
  const refreshing = rows.length > 0 && visibleDays.some((d) => byDay[d]?.status === 'loading');

  // ---- render -------------------------------------------------------------

  const renderRow = useCallback<ListRenderItem<Row>>(
    ({ item: row }) => {
      switch (row.kind) {
        case 'next':
          return (
            <NextUpCard
              airing={row.airing}
              now={now}
              dayLabel={fullDayLabel(row.day)}
              onPress={openAiring}
            />
          );
        case 'day':
          return (
            <DayHeader
              start={row.start}
              count={row.count}
              isToday={row.start === today}
              truncated={row.truncated}
            />
          );
        case 'airing':
          return (
            <AiringRow
              item={row.item}
              now={now}
              isFirst={row.isFirst}
              isLast={row.isLast}
              isNext={airingKey(row.item) === nextKey}
              onPress={openAiring}
            />
          );
        case 'note':
          return (
            <DayNote
              text={row.text}
              tone={row.tone}
              onPress={row.onPress}
              a11yLabel={row.onPress ? `${row.text}` : undefined}
            />
          );
      }
    },
    [now, today, nextKey, openAiring]
  );

  const keyExtractor = useCallback((row: Row) => {
    switch (row.kind) {
      case 'next':
        return 'next';
      case 'day':
        return `day:${row.start}`;
      case 'airing':
        return `airing:${airingKey(row.item)}`;
      case 'note':
        return `note:${row.day}`;
    }
  }, []);

  return (
    <View style={[styles.container, { backgroundColor: color.bg.primary }]}>
      <NavBar title="Schedule" />

      {/* THE FIXED HEADER, outside the list — see the header note. */}
      <View style={[styles.header, { paddingTop: offset }]}>
        <View style={styles.titleRow}>
          <View style={styles.titleCol}>
            <Text style={[styles.headline, { color: color.text.primary }]} numberOfLines={1}>
              {mode === 'week' ? 'This week' : fullDayLabel(selected)}
            </Text>
            {/* Always rendered, never swapped for a spinner: a line that changes
                its WORDS does not move the rail beneath it. */}
            <Text style={[styles.subtitle, { color: color.text.muted }]} numberOfLines={1}>
              {subtitle}
            </Text>
          </View>

          <PillSelector
            items={MODE_ITEMS}
            value={mode}
            onChange={setMode}
            height={28}
            accessibilityPrefix="Schedule view"
          />
        </View>

        <View style={styles.railSlot}>
          <WeekRail
            days={railDays}
            active={railActive}
            onSelect={onRailSelect}
            available={screenW - layout.gutter * 2}
          />
        </View>
      </View>

      <FlatList
        ref={listRef}
        data={rows}
        renderItem={renderRow}
        keyExtractor={keyExtractor}
        getItemLayout={getItemLayout}
        // Cheap: one opacity change, no animation, no layout.
        style={refreshing ? styles.stale : undefined}
        contentContainerStyle={[styles.list, { paddingBottom: tabBarSpace }]}
        onScroll={onScroll}
        scrollEventThrottle={100}
        showsVerticalScrollIndicator={false}
        // Off deliberately, same reason as everywhere else: with `expo-image`,
        // clipping unmounts cells whose bitmap is still decoding and you get
        // grey flashes on a fast fling.
        removeClippedSubviews={false}
        initialNumToRender={12}
        maxToRenderPerBatch={8}
        updateCellsBatchingPeriod={40}
        windowSize={9}
        ListEmptyComponent={
          // Three states, one answer to "is there anything to list". The error
          // is checked FIRST because a screen where every day failed is also,
          // by the letter of `anyReady`, still loading — and a skeleton over a
          // dead request is the one combination that never resolves.
          anyError && !anyReady ? (
            <ScheduleError message={firstError} onRetry={retry} />
          ) : verifiablyEmpty ? (
            <ScheduleEmpty scope={mode} />
          ) : (
            <ScheduleSkeleton />
          )
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    paddingHorizontal: layout.gutter,
    paddingBottom: spacing.md,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    // A floor, not the height: the two lines of type are 44 together and this
    // only stops the row collapsing below the pill on a short headline. The pill
    // centres against the whole column via `alignItems`, which is what puts it
    // beside the middle of the pair rather than beside the top line.
    minHeight: 34,
  },
  titleCol: { flex: 1, minWidth: 0 },
  headline: {
    fontSize: 22,
    lineHeight: 27,
    fontFamily: font.bold,
    letterSpacing: -0.5,
  },
  subtitle: {
    fontSize: 12.5,
    lineHeight: 16,
    fontFamily: font.medium,
    marginTop: 1,
  },
  railSlot: {
    marginTop: spacing.md,
    // The rail's own scroll view clips to its padding, so the row of chips can
    // bleed to the screen edge without the chevron-free scrollbar showing.
    marginHorizontal: -layout.gutter,
  },
  stale: { opacity: 0.55 },
  list: {
    flexGrow: 1,
    // THE GUTTER LIVES HERE, on the container, and not on the cells.
    //
    // It is the one piece of chrome `getItemLayout` is allowed to be ignorant
    // about, because that contract is vertical only — and putting it here rather
    // than on three cell types means the day card, its airing rows, the hero and
    // the skeleton are all inset by the same number without each of them
    // remembering to. Cells own their INTERNAL padding; the container owns the
    // distance to the edge of the screen.
    paddingHorizontal: layout.gutter,
  },
});
