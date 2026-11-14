// How fast one account may change character favourites — the app's own ceiling on
// its own write path.
//
// WHY THIS EXISTS. A Like button is one tap away from a request, and nothing about
// a tap is a rate limiter. Left alone, a user mashing the heart spends one AniList
// mutation per tap, and AniList's ceiling is 60 requests/minute for the whole app —
// every screen included. So the failure mode is not "the button breaks", it is "the
// app stops working", and it is triggered by ordinary behaviour: someone rapidly
// flipping a heart back and forth because they are not sure which state they
// wanted.
//
// WORSE THAN A RATE LIMIT. `Character.favourites` is a PUBLIC counter that other
// people see, and `ToggleFavourite` increments it on every call. So unlike the rest
// of the app's traffic — which is private to the user — every toggle here moves a
// shared, visible number. Off-by-one churn from a fast thumb is a number that
// briefly belonged to nobody, and it is the reason this guard is stricter than the
// others in the codebase rather than looser.
//
// THE SHAPE IS `presence/discord.ts` AND `presence/gateway.ts`, deliberately. Both
// of those already solve exactly this problem against Discord's gateway and REST
// limits, in this codebase, with the same two layers: an absolute rolling-window
// ceiling on top of a minimum gap. Copying a proven shape beats inventing a third
// one, and a reader who has met `REST_MIN_GAP` recognises it instantly.
//
// TWO LAYERS, AND THE ORDER MATTERS:
//
//   1. CONFIRM-ON-SECOND-TAP. An un-like within `UNDO_WINDOW_MS` of a like is
//      treated as a mis-tap and answered locally, with no request. This is the
//      layer that actually protects the shared counter, because it removes the
//      requests rather than spacing them out. It is also the only one a user can
//      feel working in their favour.
//   2. PACING. A minimum gap between writes that DO go out, plus an absolute
//      per-window ceiling as the backstop. This is what bounds the worst case.
//
// WHAT THIS IS NOT. It protects THIS account from getting limited. It cannot stop
// someone deliberately churning a public counter from a modified client — that
// needs work on AniList's side, not ours, and no client-side code can be the
// boundary for a determined caller. What it does do is make an honest user's
// mistake cost AniList nothing.

/**
 * How long after a like an un-like is treated as a mis-tap rather than a decision.
 *
 * Six seconds is the length of a deliberate undo gesture — thumb travel, seeing
 * the state change, changing your mind. It is also short enough that someone who
 * genuinely liked then disliked a character within six seconds is rare enough not
 * to be the case being optimised for.
 */
const UNDO_WINDOW_MS = 6000;

/**
 * The floor between two writes that do go out.
 *
 * A fast thumb on a real network lands a tap roughly every 150–250ms, so 900ms
 * collapses a mash into a fraction of its requests while staying under the point
 * where an intentional second like feels laggy.
 */
const MIN_GAP_MS = 900;

/** AniList allows 60/min for everything; this path is one caller of that budget. */
const WINDOW_MS = 60_000;

/**
 * The absolute ceiling, deliberately well under the API's own limit.
 *
 * Twenty keeps this path to a third of AniList's whole-app budget even if every
 * other screen were silent. `gateway.ts` uses the same ratio against Discord's
 * gateway for the same reason: the ceiling is a backstop against a logic bug, not a
 * budget to spend.
 */
const MAX_PER_WINDOW = 20;

/**
 * Timestamps of writes that actually went out, oldest first.
 *
 * MODULE-SCOPED, and that is the whole point: the budget is per ACCOUNT, not per
 * button. Liking twenty different characters in a row must draw on one allowance,
 * or a user could open twenty sheets and mash each one and never hit a limit that
 * is supposed to be stopping them. There is one module instance per app, so this is
 * the account's ledger.
 */
const sent: number[] = [];

let lastWriteAt = 0;

/** Timestamped per character id, so the undo window is per button and not global. */
const lastLikeAt = new Map<number, number>();

function prune(now: number): void {
  while (sent.length > 0 && now - sent[0] >= WINDOW_MS) sent.shift();
}

/** Milliseconds until this account may write again, or 0 if it may. */
export function paceDelay(): number {
  const now = Date.now();
  prune(now);
  if (sent.length >= MAX_PER_WINDOW) {
    // Wait for the oldest write to age out of the window, plus a small margin so
    // it is unambiguously outside it when the retry lands.
    return Math.max(0, WINDOW_MS - (now - sent[0])) + 50;
  }
  return Math.max(0, MIN_GAP_MS - (now - lastWriteAt));
}

/**
 * Forget a character's like timestamp — called when a like is rolled back, and
 * when an un-like is handled locally as an undo.
 */
export function forgetLike(characterId: number): void {
  lastLikeAt.delete(characterId);
}

/** Record that a write went out. Called only after the request is actually sent. */
export function noteWrite(): void {
  const now = Date.now();
  lastWriteAt = now;
  prune(now);
  sent.push(now);
  // Bound the array even if the window logic above is ever changed — a ledger that
  // can grow without limit is a memory leak with a confusing name.
  if (sent.length > MAX_PER_WINDOW * 2) sent.splice(0, sent.length - MAX_PER_WINDOW);
}

/**
 * Was this character liked so recently that an un-like is probably a mis-tap?
 *
 * Returns true only for the LIKE → UNLIKE direction. The reverse is left alone:
 * un-liking then re-liking is someone changing their mind about a character they
 * had already thought about, and it does not churn the counter upward.
 */
export function isLikelyUndo(characterId: number): boolean {
  const at = lastLikeAt.get(characterId);
  return at != null && Date.now() - at < UNDO_WINDOW_MS;
}

/** Remember a like, so the next un-like on the same character can be judged. */
export function noteLike(characterId: number): void {
  lastLikeAt.set(characterId, Date.now());
  // Same bound as `sent`, for the same reason. Entries are tiny but the map is
  // keyed by character id and a long session opens a lot of sheets.
  if (lastLikeAt.size > 200) {
    const cutoff = Date.now() - UNDO_WINDOW_MS;
    for (const [id, at] of lastLikeAt) {
      if (at < cutoff) lastLikeAt.delete(id);
    }
  }
}

/** Seconds until this account may write again, for a user-facing message. */
export function retryInSeconds(): number {
  return Math.ceil(paceDelay() / 1000);
}