// Display formatting for the schedule — every string on the screen is made
// here, so the whole page speaks one dialect.
//
// FORMATTERS ARE BUILT ONCE, AT MODULE SCOPE, and reused. `toLocaleTimeString`
// with an options object rebuilds an `Intl.DateTimeFormat` on every call, and
// this screen has three hundred rows in the week view: an uncached formatter
// would be constructed three hundred times per scroll to render a time that is
// already a plain string once you have it. Same reason the day labels are cached
// in a `Map` — the seven days of a window are formatted once and never again.
//
// THE DEVICE'S OWN LOCALE DECIDES EVERYTHING. No hardcoded "SAT", no forced
// 12-hour clock, no manual offset arithmetic: `Intl` already knows all three,
// and a schedule is the one screen where being wrong about a time is worse than
// being wrong about anything. A user in a 12-hour locale gets "6:00 PM" and a
// user in a 24-hour locale gets "18:00" from the same line of code.

import type { AiringItem } from '@/lib/anilist/schedule';

const locale = undefined;

const timeFmt = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' });
const weekdayShortFmt = new Intl.DateTimeFormat(locale, { weekday: 'short' });
const weekdayLongFmt = new Intl.DateTimeFormat(locale, { weekday: 'long' });
const monthShortFmt = new Intl.DateTimeFormat(locale, { month: 'short' });

/** `18:00` or `6:00 PM`, whichever the device uses. */
export function clockTime(ts: number): string {
  return timeFmt.format(new Date(ts * 1000));
}

/** `SAT`, `Mon` — whatever the locale shortens a weekday to. */
export function weekdayShort(ts: number): string {
  // Locale-aware uppercase: Turkish turns "i" into a dotted capital, which is
  // correct there and would look like a bug written with a bare toUpperCase.
  return weekdayShortFmt.format(new Date(ts * 1000)).toLocaleUpperCase();
}

/** `Saturday`. */
export function weekdayLong(ts: number): string {
  return weekdayLongFmt.format(new Date(ts * 1000));
}

/** `3` — the day of the month, unpadded, as a rail chip wants it. */
export function dayOfMonth(ts: number): string {
  return String(new Date(ts * 1000).getDate());
}

/** `Oct`. */
export function monthShort(ts: number): string {
  return monthShortFmt.format(new Date(ts * 1000));
}

const dayLabelCache = new Map<number, string>();

/** `3 Oct` — memoised, because a day header is re-rendered on every tick. */
export function dayMonthLabel(ts: number): string {
  const hit = dayLabelCache.get(ts);
  if (hit) return hit;
  const label = `${dayOfMonth(ts)} ${monthShort(ts)}`;
  dayLabelCache.set(ts, label);
  return label;
}

/** `Saturday 3 Oct` — the screen's headline when a single day is in view. */
export function fullDayLabel(ts: number): string {
  return `${weekdayLong(ts)} ${dayMonthLabel(ts)}`;
}

const headingCache = new Map<number, string>();

/** `SAT 3 OCT` — a day card's header, memoised like `dayMonthLabel`. */
export function dayHeadingLabel(ts: number): string {
  const hit = headingCache.get(ts);
  if (hit) return hit;
  const label = `${weekdayShort(ts)} ${dayMonthLabel(ts).toLocaleUpperCase()}`;
  headingCache.set(ts, label);
  return label;
}

/**
 * How long until (or since) something airs, in the words a person uses.
 *
 *   airing now     "Now"
 *   < 1h           "in 42m"
 *   < 24h          "in 2h 05m"
 *   future days    "in 3d"
 *   just passed    "Just aired"
 *   earlier        "2h ago" / "3d ago"
 *
 * `05` is padded on the minutes so a column of these keeps its width — a
 * count-up from "in 2h 5m" to "in 2h 55m" that does not shift sideways is the
 * whole reason this is a formatted string rather than two live columns.
 *
 * HORIZONTAL RULE: anything within a minute of its time is "Now" and anything
 * already past is "…ago", because an airing schedule is read against the wall
 * clock and "in 0m" is the one phrase of the set that is never true.
 */
export function countdown(ts: number, now: number): string {
  const diff = ts - now;
  if (diff >= -60 && diff < 60) return 'Now';
  if (diff < -60) {
    const past = -diff;
    if (past < 3600) return 'Just aired';
    if (past < DAY) return `${Math.floor(past / 3600)}h ago`;
    return `${Math.floor(past / DAY)}d ago`;
  }
  if (diff < 3600) return `in ${Math.max(1, Math.floor(diff / 60))}m`;
  if (diff < DAY) {
    const h = Math.floor(diff / 3600);
    const m = Math.floor((diff % 3600) / 60);
    return `in ${h}h ${String(m).padStart(2, '0')}m`;
  }
  return `in ${Math.floor(diff / DAY)}d`;
}

const DAY = 86_400;

/** How a schedule row's lamp is coloured, by what the lamp MEANS. */
export type AiringState = 'now' | 'soon' | 'later' | 'aired';

const SOON_WINDOW_S = 3600;

/**
 * `soon` is the next hour, `later` is everything beyond it.
 *
 * Two states and not one, because the difference is the point of the screen:
 * "is this hour's watch or tonight's?" is the question a schedule is opened to
 * answer, and it is answered by a colour change before a word is read.
 */
export function airingState(ts: number, now: number): AiringState {
  if (ts - now < -60) return 'aired';
  if (ts - now <= SOON_WINDOW_S) return 'soon';
  return 'later';
}

/** `EP 12` — the app's own kicker for an episode, matching the detail page. */
export function episodeLabel(episode: number): string {
  return `EP ${episode}`;
}

/** `1 episode` / `24 episodes` — never `1 episodes`. */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * The device's UTC offset, `UTC+05:30`.
 *
 * On the screen because every other time on this page is LOCAL and silently
 * converted from AniList's UTC, which is exactly the kind of transformation a
 * viewer should be able to check. Once, in the subtitle, where it costs a few
 * characters.
 */
export function utcOffsetLabel(now: number): string {
  // getTimezoneOffset is minutes BEHIND UTC, so the sign is inverted.
  const mins = -new Date(now * 1000).getTimezoneOffset();
  if (mins === 0) return 'UTC';
  const sign = mins < 0 ? '-' : '+';
  const abs = Math.abs(mins);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return m === 0 ? `UTC${sign}${h}` : `UTC${sign}${h}:${String(m).padStart(2, '0')}`;
}

/** Identity for an airing, stable across re-fetches and safe as a list key. */
export function airingKey(a: AiringItem): string {
  return `${a.media.id}:${a.episode}:${a.airingAt}`;
}
