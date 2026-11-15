// Buffer health, stall detection and tier-downgrade decisions — in one pure
// module, so the rules cannot drift between what ships and what is checked.
//
// ═══════════════════════════════════════════════════════════════════════════
// WHY THIS FILE EXISTS
//
// `progress.md` claims the player has a "30s stall watchdog". It does not. The
// one that exists is `STALL_MS` in `components/player/legacy/VerticalPlayerScreen.tsx`
// — the screen that was PARKED when the landscape player replaced it, and the
// watchdog was not carried over. What shipped is a FIRST-FRAME watchdog: it is
// armed by `replaceAsync` and cancelled by the first rendered frame, so it can
// only ever answer "this source never started".
//
// The gap it leaves is the failure that actually gets reported: a stream that
// plays perfectly for ten minutes and then dies on a train, or when the CDN
// drops a signed URL, or when the phone changes cell. `statusChange` stays
// 'loading', no frame event ever fires again, and the viewer sits in front of an
// indefinitely spinning ring with no Retry, no message and no timeout. Nothing
// in that loop can ever change the outcome, because every input to it has
// already been delivered.
//
// ═══════════════════════════════════════════════════════════════════════════
// THE FOUR TRAPS IN THIS DOMAIN
//
// 1. AN UNKNOWABLE BUFFER IS NOT AN EMPTY BUFFER. `bufferedPosition` is `-1`
//    whenever the pipeline cannot tell — including the moment right after a
//    replace. A monitor that reads that as "0 seconds buffered" decides the
//    network is dead and fails over a stream that is about to play fine. This
//    module has a distinct `unknown` verdict and it is NOT a bad one. It is the
//    `progress.md` rule — "never cache an absence as if it were an answer" —
//    applied to a number instead of to a response body.
//
// 2. A PAUSED PLAYHEAD IS NOT A STALLED ONE. `player.playing` is the pipeline's
//    own claim. When it is false the playhead is *supposed* to sit still, and a
//    monitor that measures "time since the playhead moved" without reading it
//    fails over every video the viewer paused. Every non-playing sample also
//    RESTARTS the clock, because otherwise unpausing would surface the entire
//    paused duration as one enormous frozen stretch.
//
// 3. A BACKGROUNDED APP IS NOT A DEAD ONE. `currentTime` does not advance while
//    the app is away, so a player that returns after twenty seconds in the
//    switcher is indistinguishable from a stream that died twenty seconds ago.
//    Without `noteInterruption`, every trip to the app switcher would burn a
//    failover round on a stream that is completely healthy.
//
// 4. DOWNGRADING THRASHES UNLESS IT HAS A FLOOR AND A FLOOR TO UNDO IT. An
//    adaptive monitor that reacts to a thin buffer and forgets the instant it
//    thickens will walk the ladder to the bottom on a marginal-but-playable
//    connection — which is worse than the stutter it was fixing, because the
//    viewer is now watching 480p having never been asked. There are two
//    thresholds and they are deliberately asymmetric: act below `starveFloor`,
//    forget only above `recoverFloor`, and only after the buffer has sat there
//    for `RECOVER_WINDOW`. `resetHealthOnRecovery` is asserted to be
//    unreachable by construction in `scripts/check-player-health.ts`.
//
// ═══════════════════════════════════════════════════════════════════════════
// NO IMPORTS, DELIBERATELY
//
// `scripts/check-player-health.ts` imports this file directly and runs it under
// plain `tsx` with no React Native and no Expo. Same rule as `speed.ts` and
// `tapArbiter.ts`: pure logic goes in a module that can be loaded outside the
// app, so the check exercises the code that ships rather than a model of it.

/** Mirrors expo-video's `VideoPlayerStatus`. Duplicated so this file imports nothing. */
export type PlaybackStatus = 'idle' | 'loading' | 'readyToPlay' | 'error';

/** One reading taken off the player. Nothing here is derived. */
export interface HealthSample {
  /** `player.currentTime`, seconds. */
  position: number;
  /**
   * `player.bufferedPosition`, seconds. `-1` means UNKNOWABLE, not zero — see
   * trap 1. The type is `number` because that is what the property is; the
   * handling of the sentinel is `bufferAhead`'s job and only its.
   */
  buffered: number;
  status: PlaybackStatus;
  /** `player.playing` — the pipeline's own claim, not an inference. See trap 2. */
  playing: boolean;
  /** A monotonic clock, milliseconds. Injected so a test can drive it. */
  at: number;
}

export type PlaybackHealth =
  /** Advancing, with at least a little media ready ahead. */
  | { kind: 'ok'; ahead: number }
  /** The playhead has stopped but nothing is wrong yet. Show a spinner. */
  | { kind: 'rebuffering'; ahead: number | null; frozenMs: number }
  /** Below the floor, but not for long enough to act on. */
  | { kind: 'starving'; ahead: number; forMs: number }
  /** Frozen past every grace period. Fail over. */
  | { kind: 'stalled'; ahead: number | null; frozenMs: number }
  /** Buffer state cannot be determined. Act on NOTHING. See trap 1. */
  | { kind: 'unknown' }
  /** Paused, errored or idle. Not a judgement about the stream. */
  | { kind: 'inactive' };

export interface HealthState {
  /** Playhead as of the most recent sample. */
  lastPosition: number;
  /**
   * When the playhead last MOVED. Not "when it was last seen to have moved",
   * and not a bare timestamp of the last sample — it is the answer to "how long
   * has this stream been frozen", which is the only question a stall watchdog
   * has. Initialised to the reset time rather than left null, because a monitor
   * that has never seen movement must not read that as "no evidence".
   */
  lastMovedAt: number;
  /** `at` of the newest sample. */
  lastAt: number;
  /** Start of the current uninterrupted thin-buffer run, or null. */
  starvingSince: number | null;
  /** Start of the current uninterrupted comfortable-buffer run, or null. */
  deepSince: number | null;
  /** True once a tier has been dropped and not yet earned back. Trap 4. */
  dropped: boolean;
  /**
   * The earliest time a stall MAY be declared.
   *
   * ONE deadline rather than a separate "grace window" plus a frozen-duration
   * rule. The first version had both — `lastMovedAt + STALL_MS` AND a
   * `graceUntil` — and the grace was **arithmetically inert**, because `noteSeek`
   * resets `lastMovedAt` to the same instant it sets the grace, so the longer of
   * the two conditions is always `lastMovedAt + STALL_MS` and the grace could
   * never bind. A confident comment describing a rule the arithmetic cannot
   * express, which is the exact failure mode this project keeps paying for.
   *
   * A single deadline also makes the intent expressible: a seek grants the
   * stream a FRESH window of `SEEK_STALL_MS` rather than a slightly longer wait
   * for the next stall, because "time since the playhead last moved" is
   * measuring the wrong thing while a forward seek is still fetching segments
   * that were never buffered.
   */
  deadlineAt: number;
}

/**
 * How much playhead movement counts as movement.
 *
 * Not zero: `timeUpdateEventInterval` is 0.5s, so a genuinely playing stream
 * advances in half-second steps, but float noise on `currentTime` around a
 * paused or ended item produces sub-millimetre jitter that would otherwise read
 * as continuous movement and mask every stall forever. A twentieth of a second
 * is two orders of magnitude clear of both.
 */
export const MOVE_EPS = 0.05;

/**
 * How long the playhead may stay frozen before the source is written off.
 *
 * 15s, and deliberately much shorter than the parked page's 30s. The wait it
 * covers is explained — not in words (the device verdict of 9 Nov retired the
 * centre-screen state text: slow internet hopped the words fast enough to
 * flicker, and none of them changed what the viewer should do) but in ACTIONS
 * with doors behind them: the ring explains now, the monitor drops a tier at
 * `STARVE_WINDOW`, and at 15s this either reconnects or prints the engine's
 * own message on the error card. A wait with answers behind it is tolerable;
 * "it froze" is what a silent one reads as.
 *
 * Deliberately NOT a function of the app being foregrounded. `noteInterruption`
 * handles that case instead of widening this, because a wider threshold is also
 * a longer wait on a genuinely dead stream.
 */
export const STALL_MS = 15_000;

/**
 * A sample this much later than the previous one means the APP was late, not the
 * stream.
 *
 * THE 16 NOV REPORT, and the reason this constant exists. A notification arrived
 * on a low-end phone; the system UI animated over the video and the app was not
 * scheduled for seconds at a time. The tick still fired — LATE — and the stall
 * watchdog counted the whole gap as a frozen playhead it had been watching.
 * Fifteen seconds of that is a 'stalled' verdict, so it failed over: a fresh
 * resolve, a `replaceAsync`, a re-render, on the device that was already
 * struggling. The next window did the same, and the one after it. From the
 * viewer's side the app went to 1 fps, changed source on its own and restarted
 * the episode — and none of it was the network.
 *
 * The evidence a stall is made of is only valid if we were actually watching. A
 * gap of this size says we were not: no sample was taken, so nothing was
 * observed about the playhead in that window. 2.5 ticks is far above any
 * scheduling hiccup a healthy device produces and far below the 15s the watchdog
 * needs, so a dead stream on a working phone still fails over exactly on time.
 *
 * Compare the reference player in `ShonenX/` (media_kit + ExoPlayer): it has NO
 * stall watchdog at all, only its own events. That is why a system notification
 * cannot cascade there — and the reason this rule matters more than a wider
 * threshold would. The response here is deliberately `noteInterruption`'s:
 * restart the clocks, keep the decisions, act on nothing.
 */
export const STARVED_SAMPLE_MS = 2_500;

/**
 * When a frozen playhead earns a spinner.
 *
 * Short enough to feel responsive, long enough that a single dropped frame does
 * not blink one. `PlayerScreen` already debounces the centre spinner on
 * `statusChange` for exactly this reason; this is the evidence-driven twin of
 * that debounce, for the case where `statusChange` never arrives.
 */
export const REBUFFER_HINT_MS = 700;

/**
 * How long a forward seek may keep the playhead still before it counts as a
 * stall.
 *
 * A seek into unbuffered territory stalls BY CONSTRUCTION — the pipeline has to
 * fetch and decode segments the viewer has not been near before the playhead
 * can move at all. Judged by the ordinary `STALL_MS`, every forward-skip on a
 * weak connection risks spending a failover round on a stream that was about to
 * resume, and the viewer's own gesture is what triggers it.
 *
 * Longer than `STALL_MS` deliberately, and that asymmetry is the point: the
 * cost of being late to notice a real dead stream is bounded (this only applies
 * to seeks, and the viewer is told the player is reconnecting throughout), while
 * the cost of a false failover mid-seek is a visible source switch the viewer
 * did not ask for.
 */
export const SEEK_STALL_MS = 20_000;

/**
 * A thin buffer has to persist this long before a tier is dropped.
 *
 * The buffer dips on every seek, every quality switch and every momentary
 * network wobble. Acting on any of those produces a ladder walk on a connection
 * that never actually needed one (trap 4), so the response is to the SUSTAINED
 * condition and never to the instantaneous one.
 */
export const STARVE_WINDOW = 12_000;

/**
 * The buffer has to be comfortably this deep for `RECOVER_WINDOW` before a
 * dropped tier is forgotten.
 *
 * Asymmetric with the starve threshold on purpose, and enforced rather than
 * assumed: `scripts/check-player-health.ts` asserts `recoverFloor >
 * starveFloor` for every horizon, including the degenerate ones. If those two
 * ever crossed, a buffer oscillating between them would either never drop a
 * tier or drop one on every pass, and both would look like working software.
 */
export const RECOVER_WINDOW = 30_000;

export interface HealthProfile {
  /** Below this many seconds of media ahead, the buffer is a problem. */
  starveFloor: number;
  /** At or above this, for long enough, the network is demonstrably fine. */
  recoverFloor: number;
}

/**
 * The two thresholds, derived from the buffer horizon the player is configured
 * with (`BufferOptions.preferredForwardBufferDuration`).
 *
 * Deriving them is the point. A user who chose Low is holding ~15 seconds of
 * media; telling them they are starving at 8 seconds ahead would be a permanent
 * false alarm on a perfectly healthy stream, and an adaptive monitor that
 * reacts to its own false alarms walks the ladder to the floor inside a minute
 * (trap 4 again — the same bug by a different route). The floors are fractions
 * of the horizon the user actually picked, so "starving" means the same thing
 * at every setting.
 *
 * Clamped at both ends so a degenerate horizon cannot produce a threshold of
 * zero, which would make every frame a violation.
 */
export function healthProfile(horizonSeconds: number): HealthProfile {
  const horizon =
    Number.isFinite(horizonSeconds) && horizonSeconds > 0 ? horizonSeconds : 20;
  const starveFloor = Math.min(12, Math.max(3, horizon * 0.2));
  const recoverFloor = Math.min(30, Math.max(6, horizon * 0.45));
  // Structurally impossible for the two to cross, whatever the horizon. The
  // check asserts it anyway, because a clamp that is correct today is not a
  // reason to stop asserting it tomorrow.
  return {
    starveFloor,
    recoverFloor: Math.max(recoverFloor, starveFloor + 1),
  };
}

/**
 * Seconds of media ready ahead of the playhead, or `null` when unknowable.
 *
 * `null` is a first-class answer, not a fallback for zero. Trap 1 is entirely
 * about callers refusing to tell those two apart, so the type makes it
 * impossible to confuse them without a deliberate cast.
 *
 * Clamped at zero: the pipeline legitimately reports a buffered position behind
 * the playhead during a backward seek, and a negative "seconds ahead" would
 * make a healthy stream look arbitrarily broken.
 */
export function bufferAhead(buffered: number, position: number): number | null {
  if (!Number.isFinite(buffered) || buffered < 0) return null;
  if (!Number.isFinite(position)) return null;
  return Math.max(0, buffered - position);
}

/** Fresh state for a new media item. Everything the monitor knows is discarded. */
export function resetHealth(now: number): HealthState {
  return {
    lastPosition: 0,
    // The reset time, NOT zero and NOT null. "We have been watching since the
    // reset and nothing has moved" is exactly the evidence a stall is made of;
    // leaving this null would mean a monitor that never saw movement could not
    // ever conclude one, which is the failure mode that makes a watchdog inert.
    lastMovedAt: now,
    lastAt: now,
    starvingSince: null,
    deepSince: null,
    dropped: false,
    deadlineAt: now + STALL_MS,
  };
}

/**
 * Restart the CLOCKS after an interruption, keeping what has been DECIDED.
 *
 * `AppState` backgrounding is the case that needs this (trap 3), and the reason
 * it cannot simply be `resetHealth` is worth stating: a trip to the app switcher
 * is not evidence that the network recovered. Clearing `dropped` there would
 * let a phone that briefly loses signal walk the whole quality ladder, one
 * backgrounding at a time, with the viewer never having chosen any of it.
 *
 * `starvingSince` IS cleared, because the buffer behind us describes a
 * connection that no longer exists and must not be allowed to accumulate into a
 * downgrade decision for the connection we return to.
 */
export function noteInterruption(prev: HealthState, at: number): HealthState {
  return {
    ...prev,
    lastMovedAt: at,
    lastAt: at,
    deadlineAt: at + STALL_MS,
    starvingSince: null,
    deepSince: null,
  };
}

/**
 * Forgive the stall that the seek we just issued is about to cause.
 *
 * The playhead is NOT reset to `at` — claiming movement that has not happened
 * would be exactly the kind of invented evidence this module exists to avoid.
 * Only the clock restarts, and only because a forward seek into unbuffered
 * territory stalls by construction.
 */
export function noteSeek(prev: HealthState, at: number): HealthState {
  return {
    ...prev,
    lastMovedAt: at,
    lastAt: at,
    // A whole fresh window, not a nudge on the existing one — see `deadlineAt`.
    deadlineAt: at + SEEK_STALL_MS,
    // A seek invalidates the buffer run too: the buffer is about to be emptied
    // in front of the playhead by the seek itself, so carrying the old
    // `starvingSince` forward would age a run that began before the seek.
    starvingSince: null,
    deepSince: null,
  };
}

export interface HealthVerdict {
  state: HealthState;
  health: PlaybackHealth;
  /**
   * True exactly once per bad-network episode: the caller should drop one
   * quality tier.
   *
   * A SEPARATE BOOLEAN rather than something inferred from `health.kind`. A
   * caller needs to render `starving` continuously while acting on it once, and
   * an overloaded verdict field is how those two get conflated into a ladder
   * walk.
   */
  dropTier: boolean;
}

/**
 * Fold one sample in and decide.
 *
 * The order of the rules below IS the design. Each `return` is a case where the
 * later rules must not run, and reordering them changes what the monitor does
 * on real hardware in ways no amount of commenting would make obvious.
 */
export function observeHealth(
  prev: HealthState,
  s: HealthSample,
  profile: HealthProfile
): HealthVerdict {
  const moved = Math.abs(s.position - prev.lastPosition) > MOVE_EPS;

  const base: HealthState = {
    ...prev,
    lastPosition: s.position,
    lastAt: s.at,
    // Movement clears the seek's extended window: if the playhead moved, the
    // seek worked and the only thing the extra patience was protecting against
    // is gone.
    lastMovedAt: moved ? s.at : prev.lastMovedAt,
    deadlineAt: moved ? s.at + STALL_MS : prev.deadlineAt,
  };

  // ── Rule 0: not playing, errored, or idle. Trap 2. ──────────────────────
  //
  // Checked FIRST, before anything that measures time or buffer. A paused
  // player produces a perfect stream of samples in which the playhead never
  // moves, and every time-based rule below would eventually fire on it.
  //
  // The clock is RESTARTED rather than held, and that is the part that is easy
  // to get wrong: hold it, and a viewer who pauses for a minute and resumes has
  // a one-minute "frozen stretch" waiting for them, so the stream they just
  // resumed fails over within seconds. There is no cost to restarting — the
  // monitor has not seen any evidence of a stall, so there is nothing to lose.
  if (!s.playing || s.status === 'error' || s.status === 'idle') {
    return {
      state: { ...base, lastMovedAt: s.at, starvingSince: null, deepSince: null },
      health: { kind: 'inactive' },
      dropTier: false,
    };
  }

  // ── Rule 1: the SAMPLE is late, so its evidence is void. ────────────────
  //
  // 16 Nov. See `STARVED_SAMPLE_MS`: a starved app is not a dead stream, and
  // treating one as the other is how the player adds a source walk to a device
  // that is already too slow. `dropped` survives (it is spread from `base`),
  // for the same reason `noteInterruption` keeps it: a starved stretch is not
  // evidence about the connection at all.
  if (s.at - prev.lastAt > STARVED_SAMPLE_MS) {
    return {
      state: {
        ...base,
        lastMovedAt: s.at,
        deadlineAt: s.at + STALL_MS,
        starvingSince: null,
        deepSince: null,
      },
      health: { kind: 'unknown' },
      dropTier: false,
    };
  }

  // ── Rule 2: frozen past every deadline. Fail over. ─────────────────────
  //
  // Note this does NOT require a thin buffer. A playhead frozen for the whole
  // window while the pipeline still claims to be playing is a broken source
  // whatever the buffer says — a full buffer with a dead clock is a decoder
  // that has wedged, and there is nothing to wait for. Requiring a thin buffer
  // here would make the monitor blind to exactly the case it exists to catch.
  //
  // The running buffer measurement is discarded rather than carried: after a
  // stall it describes nothing, and letting it age would fire a spurious
  // downgrade on the fresh source.
  //
  // `frozenMs` is reported for the UI and is deliberately NOT the condition —
  // after a seek the deadline can be later than `lastMovedAt + STALL_MS`, and
  // reporting a "15 seconds frozen" while the deadline is still fifteen seconds
  // away would be a number that disagrees with the decision printed beside it.
  const frozenMs = s.at - base.lastMovedAt;

  if (s.at >= base.deadlineAt) {
    return {
      state: { ...base, starvingSince: null, deepSince: null },
      health: { kind: 'stalled', ahead: bufferAhead(s.buffered, s.position), frozenMs },
      dropTier: false,
    };
  }

  const ahead = bufferAhead(s.buffered, s.position);

  // ── Rule 3: the buffer is unknowable. Trap 1. ───────────────────────────
  //
  // An absence of evidence about the buffer is not evidence of a bad buffer.
  // This returns BEFORE the starve bookkeeping is updated, so an unknowable
  // sample cannot start a starvation run, extend one, or be counted as a
  // comfortable one either. `dropped` is left exactly as it was: a stretch of
  // `-1`s is not a recovery, and treating it as one would erase the record that
  // a tier had already been given up.
  if (ahead === null) {
    return {
      state: { ...base, starvingSince: null, deepSince: null },
      health: { kind: 'unknown' },
      dropTier: false,
    };
  }

  // ── Rule 4: bookkeeping, then the two remaining verdicts. ───────────────
  //
  // Both runs are maintained on every knowable sample. The comfortable run is
  // tracked even while starving, because it is the thing that ends a
  // starvation, and a monitor that only looked at it when it was comfortable
  // would never be able to tell how long it had been comfortable for.
  const starving = ahead < profile.starveFloor;
  const comfortable = ahead >= profile.recoverFloor;

  const starvingSince = starving ? prev.starvingSince ?? s.at : null;
  const deepSince = comfortable ? prev.deepSince ?? s.at : null;

  // How long the buffer has been comfortable *continuously*. Read from
  // `prev.deepSince` deliberately: on the first comfortable sample the run is
  // zero-length by definition, and using the value computed above would make
  // `deepSince` immediately equal to `s.at` and measure nothing.
  const deepRunMs = comfortable && prev.deepSince != null ? s.at - prev.deepSince : 0;

  // The anti-thrash gate. Forgetting a dropped tier takes a LONG comfortable
  // run, not one comfortable sample — which is the whole of trap 4.
  const dropped = prev.dropped && deepRunMs < RECOVER_WINDOW;

  const starveMs = starvingSince != null ? s.at - starvingSince : 0;
  const dropTier = starving && !dropped && starveMs >= STARVE_WINDOW;

  if (dropTier) {
    return {
      state: { ...base, starvingSince, deepSince, dropped: true },
      health: { kind: 'starving', ahead, forMs: starveMs },
      dropTier: true,
    };
  }

  if (starving) {
    return {
      state: { ...base, starvingSince, deepSince, dropped },
      health: { kind: 'starving', ahead, forMs: starveMs },
      dropTier: false,
    };
  }

  // Not starving and not stalled. The only remaining question is whether the
  // playhead is currently stopped, which is what earns a spinner.
  //
  // `status` is deliberately NOT part of this test. The SDK has no 'buffering'
  // status — a mid-playback rebuffer reports 'loading', the same value as the
  // initial load, and every `currentTime` write into unbuffered territory
  // produces one. Keying the spinner off `status` therefore blinks it on and
  // off under the viewer's thumb during a double-tap seek sequence. The frozen
  // playhead is the actual evidence, and it cannot flicker.
  if (frozenMs >= REBUFFER_HINT_MS) {
    return { state: { ...base, starvingSince, deepSince, dropped }, health: { kind: 'rebuffering', ahead, frozenMs }, dropTier: false };
  }

  return { state: { ...base, starvingSince, deepSince, dropped }, health: { kind: 'ok', ahead }, dropTier: false };
}

/**
 * The rung below `active` on a ladder sorted highest-first, or null at the
 * bottom.
 *
 * `active` is the resolution the pipeline is ACTUALLY on — `player.videoTrack`,
 * which is the only observation available — matched against the ladder's own
 * labels. It is a `number` because the variant list this is paired with carries
 * labels like "1080p" and a height is the thing they can be compared against;
 * see `heightOfLabel` for the parsing, which lives here so the caller cannot
 * do it two ways.
 *
 * The unknown case — a ladder we cannot match the pipeline to — deliberately
 * steps down ONE rung from the second-from-top rather than from the top.
 * ExoPlayer's own ABR has already been running for however long the buffer was
 * thin, so the pipeline is almost certainly not on the highest rung, and
 * selecting the top of the ladder would be a "recovery" that raises quality
 * during the exact incident that was meant to lower it.
 */
export function nextLowerRung(
  ladder: readonly string[],
  activeHeight: number | null | undefined
): string | null {
  if (ladder.length < 2) return null;
  if (activeHeight != null && Number.isFinite(activeHeight)) {
    const index = ladder.findIndex((label) => heightOfLabel(label) === activeHeight);
    if (index >= 0) return index + 1 < ladder.length ? ladder[index + 1] : null;
  }
  return ladder.length >= 2 ? ladder[1] : null;
}

/**
 * The pixel height a quality label describes, or 0.
 *
 * "1080p" -> 1080, "720" -> 720, "1500k" -> 0. The `k` form is a bitrate and
 * not a height, and guessing a height for it would let a ladder of bitrate
 * labels match the pipeline's resolution by accident.
 */
export function heightOfLabel(label: string): number {
  const m = /(\d{3,4})\s*p?\b/i.exec(label);
  return m ? parseInt(m[1], 10) : 0;
}