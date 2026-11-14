// A shared, ticking clock.
//
// ONE TIMER PER SCREEN, NOT ONE PER ROW. The schedule asks "how long until this
// airs?" on every row, and the naive answer — `setInterval` inside each row —
// gives three hundred timers on a week view, each of which is a JS-thread wake-up
// to re-render a row that may not even be on screen. So the clock lives here,
// once, and its value is passed down: thirty seconds of tick wakes the screen,
// which re-renders the dozen rows it actually has mounted.
//
// THIRTY SECONDS, not one. An airing time is only ever displayed as "in 42m", and
// 42m is not a precision instrument — but it IS the difference between "in 0m"
// and "Now" being right at the moment an episode starts, which is the one second
// of this screen anyone is actually watching for.
//
// THIS IS ALSO WHAT MAKES THE DAY ROLL OVER AT MIDNIGHT WITHOUT ANY CODE ASKING
// FOR IT: the schedule derives "today" from this value, so the window the screen
// fetches turns over on its own.
//
// PAUSED WHEN THE SCREEN IS NOT FOCUSED, VIA A REF.
//
// Besides being correct, this is the second biggest background-CPU win in the tab
// bar: tabs stay mounted for the whole session, so an always-running clock here
// meant a 300-cell FlatList being re-rendered every thirty seconds on a tab
// nobody was looking at.
//
// `isFocusedNow` rather than a boolean on purpose, and the reason is the whole
// lesson of this file: the FIRST version of this pause took a `boolean` prop,
// and the caller got that boolean from `useState` in a `useFocusEffect` — so
// every tap of the tab bar re-rendered the schedule screen in order to flip a
// flag that only this interval callback reads. A plain function call reads current
// state with no render at all. `useIsFocusedNow()` in `./useIsFocusedNow` is what
// produces one.
//
// The interval is deliberately left ARMED while unfocused rather than cleared.
// It wakes the JS thread once every thirty seconds and does nothing, which is
// free; clearing and re-arming it would risk the interval being torn down and
// forgotten, and would make the first frame back depend on the timer having been
// restarted.

import { useEffect, useState } from 'react';

/** Current unix time in SECONDS — AniList's unit, so nothing has to convert. */
export function useNow(intervalMs: number, isFocusedNow?: () => boolean): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  useEffect(() => {
    const id = setInterval(() => {
      if (isFocusedNow && !isFocusedNow()) return;
      setNow(Math.floor(Date.now() / 1000));
    }, intervalMs);
    return () => clearInterval(id);
  }, [intervalMs, isFocusedNow]);

  return now;
}
