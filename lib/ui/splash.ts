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
  /**
   * Reduce motion: no scale travel, but still a REAL fade-in.
   *
   * ⚠️ THIS PATH IS THE ONE LOW-END PHONES ACTUALLY TAKE, and it used to be a
   * still frame. Its logo started at FULL opacity and was then timed to 1 — an
   * animation from 1 to 1 — so the only motion left was the overlay's fade-out
   * 300ms later, which on black reads as a frozen screen. That is the
   * "it's just a static logo" report, and it is not a corner case:
   * `useReducedMotion()` is TRUE whenever the platform's animator duration
   * scale is 0, which Android sets under battery saver as well as under
   * Settings → Accessibility → Remove animations.
   *
   * A fade is not what reduce-motion exists to suppress — travel and zoom are.
   * So the logo fades in from `fromOpacity` here too, and only the scale is
   * dropped.
   */
  reducedFadeMs: 220,
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
   * HOW LONG THE ENTRANCE WAITS FOR THE LOGO ITSELF.
   *
   * The timeline used to start on mount, and the logo is a bundled bitmap that
   * is decoded asynchronously — so on a cold start the animation could be most
   * of the way through before the FIRST frame with a logo in it was painted,
   * and the user saw the final state. `AnimatedSplash` therefore arms the
   * timeline on the image's own `onLoad`, and this is the fallback for a decode
   * that never reports: past this the entrance starts anyway, because a late
   * logo appearing mid-fade still looks alive, while a splash that waits on a
   * hung decode looks broken.
   *
   * A CEILING ON WAITING, NOT A DELAY TO SIT THROUGH: a warm decode fires
   * `onLoad` in the same frame the image arrives, so this costs nothing on the
   * common path.
   */
  decodeFallbackMs: 240,
  /**
   * The native splash's OWN exit fade, handed to `SplashScreen.setOptions`.
   *
   * The library default is 400ms (`SplashScreenModule.kt`), and while it runs it
   * is composited OVER the in-app overlay — the same logo, one static and one
   * animating, one on top of the other — so the first 400ms of a 320ms fade-in
   * is spent behind a picture that is not moving. 200ms is long enough to read
   * as a fade rather than a cut and short enough that the entrance plays where
   * the user can see it.
   */
  nativeExitMs: 200,
  /**
   * A beat between the native fade finishing and the in-app entrance starting.
   * `hideAsync` resolves when the native fade STARTS, not when it ends, so the
   * hand-off is timed off `nativeExitMs` instead — this is the margin that keeps
   * the entrance from beginning on a frame that is still covered.
   */
  handoffGapMs: 60,
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

/**
 * From the native splash starting to fade out to the in-app entrance being
 * allowed to start — the gap the root layout waits out before mounting the
 * overlay. Deliberately NOT part of `splashTotalMs()`: that measures the overlay
 * the user is watching, and this is time spent behind the native one.
 */
export function handoffMs(): number {
  return SPLASH.nativeExitMs + SPLASH.handoffGapMs;
}
