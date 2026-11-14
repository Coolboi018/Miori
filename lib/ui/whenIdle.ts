// Run work when the JS thread has nothing queued.
//
// ONE SCHEDULER, TWO CALLERS. `lib/query/prefetch.ts` warms the DATA and
// `lib/ui/usePreloadTabs.ts` warms the VIEW TREES, and both of them want the
// same thing: a moment that costs the launch nothing. That was worth extracting
// rather than writing twice, because the reasoning below is the part that must
// not drift — two copies of "why `requestIdleCallback` and not a timeout" is how
// one of them ends up on a `setTimeout(0)` six months from now.
//
// WHY `requestIdleCallback` AND NOT `setTimeout(0)`. A timeout fires whether or
// not the app is busy, so it can steal a frame from the launch the user is
// watching. This also replaced `InteractionManager.runAfterInteractions`, which
// React Native 0.86 deprecates and logs a warning for on first use.
//
// The two are NOT equivalent, and the difference is the interesting part.
// `InteractionManager` queued behind *interactions* — an in-flight touch or
// animation — and knew nothing about how loaded the JS thread was.
// `requestIdleCallback` queues behind *work*: it fires when the event loop has
// nothing queued, which is the actual thing this function is trying to avoid
// stepping on. It is called during the first commit with a screen's worth of
// mounts behind it, and "nothing queued yet" is exactly the right condition to
// wait for. It cannot tell a touch is in progress, but at app start there is not
// one, and every other call site here is deliberately synchronous.
//
// The `typeof` guard is not paranoia about React Native — it installs
// `requestIdleCallback` as a global — but about the web bundle, where the
// function's availability depends on the browser. Getting this wrong would take
// the app's entire warm-up path down with a ReferenceError at launch, which is a
// bad trade for saving one branch.

/**
 * How long a warm-up may wait for a genuinely idle moment before running anyway.
 *
 * `requestIdleCallback` fires when the JS thread drains OR when `timeout`
 * expires, whichever comes first, and the timeout is what makes this a
 * deferral rather than a hope. Without it, the work could silently never happen
 * on exactly the devices that need it — a phone that never goes idle through
 * launch is the phone that was going to benefit from having the rest of the app
 * already built.
 *
 * Two seconds is long enough that the first paint is unambiguously finished and
 * short enough that a cold start still gets its warm work inside the window
 * where the user is deciding which tab to open.
 */
const IDLE_TIMEOUT_MS = 2000;

/**
 * Run `work` when the JS thread is idle, optionally after a settle gap.
 *
 * `settleMs` requires a stretch of QUIET before `work` runs, on top of the idle
 * moment itself. It exists for work that is heavy in a way the event loop cannot
 * see, which is exactly what mounting a screen is: the React render is over by the
 * time `requestIdleCallback` fires, but the native view creation, measure and
 * first paint that render asked for are still going, on the UI thread and the
 * compositor. Chaining two of those back to back looks idle to this function and
 * still stacks their costs, and the symptom is a launch that is fine and then not
 * fine for a second afterwards.
 *
 * WHY A TIMER IS THE RIGHT TOOL HERE, which is the opposite of the argument at the
 * top of this file. `setTimeout` earns its distrust because it fires into whatever
 * the thread happens to be doing. That is not what this one does: it fires into a
 * window we have just waited for on purpose, and its whole job is to NOT do
 * anything for a while. It is a delay that exists so the next step has somewhere
 * cheap to land. It is still bounded — the gap is a constant, and a cancelled
 * caller's own guard drops the work when it finally comes due.
 *
 * Never throws. A warmer that throws is a warmer that did not run, and the
 * call sites are all fire-and-forget — there is no caller to hand an error to,
 * and an unhandled rejection at this point in the launch would be a far worse
 * outcome than the warm-up quietly not happening.
 */
export function whenIdle(
  work: () => void,
  options?: {
    /**
     * Milliseconds of quiet required before `work` runs. Omitted means "as soon
     * as the thread is idle", which is what the data warmers want — a request is
     * not a layout pass and there is nothing to let settle.
     */
    settleMs?: number;
  }
): void {
  const run = (): void => {
    try {
      work();
    } catch {
      /* a warmer that throws is a warmer that did not run */
    }
  };

  if (typeof requestIdleCallback !== 'function') {
    run();
    return;
  }

  const settleMs = options?.settleMs ?? 0;
  requestIdleCallback(
    () => {
      if (settleMs <= 0) {
        run();
      } else {
        setTimeout(run, settleMs);
      }
    },
    // The gap counts toward the budget: waiting for quiet we then asked to keep
    // quiet is one wait, not two.
    { timeout: IDLE_TIMEOUT_MS + settleMs }
  );
}