// Splash timing — the ONE place these numbers live.
//
// Pure data, like `tokens.ts`: the component, the root layout's watchdog and
// `scripts/check-splash.ts` all read the same constants, so "the splash feels
// slow" is a one-line change here rather than a hunt through an animation, and
// the invariants (the overlay always ends, the backstop is always later than the
// animation) are assertable instead of hoped for.
//
// The budget is deliberately under a second. A splash is not doing work at this
// point — fonts and the persisted cache were already read behind the native
// one — so anything longer is the app telling the user it is slow.

export const SPLASH = {
  /** The logo's fade-in. Visible motion on purpose: a still frame reads as a hang. */
  fadeMs: 320,
  /** The logo's scale settling. Runs inside `holdMs`, so it never extends the total. */
  enterMs: 560,
  /** First frame → the fade-out begins. */
  holdMs: 620,
  /** The overlay fading away to reveal the app. */
  exitMs: 260,
  /** Reduce-motion: no scale travel, only a short cross-fade. */
  reducedFadeMs: 160,
  reducedHoldMs: 300,
  reducedExitMs: 160,
  /**
   * Where the logo scale starts. A visible-but-tasteful settle — 0.92 was so
   * small that on a phone it read as a static image, which is the report this
   * number answers.
   */
  fromScale: 0.86,
  /** Where the logo's opacity starts. 0 = a real fade-in, not a still frame. */
  fromOpacity: 0,
  /**
   * ABSOLUTE BACKSTOP, not artwork. If the animation's completion callback never
   * arrives (stalled UI thread, an interrupted animation on a slow device), the
   * overlay is torn down by the root layout anyway. Without this a cold start on
   * a bad phone can leave a black rectangle sitting over a working app — which
   * is exactly what "it gets stuck on my phone" looks like.
   *
   * Must stay well clear of `splashTotalMs()`, or it would cut a healthy fade.
   */
  watchdogMs: 2500,
} as const;

/** How long the overlay is on screen when everything goes to plan. */
export function splashTotalMs(reduced: boolean): number {
  return reduced
    ? SPLASH.reducedFadeMs + SPLASH.reducedHoldMs + SPLASH.reducedExitMs
    : SPLASH.holdMs + SPLASH.exitMs;
}
