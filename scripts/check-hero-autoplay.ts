/**
 * Hero autoplay must pause when its tab is hidden and resume where it left off.
 *
 * The bug this pins was a permanent freeze, not a stutter: the timeout returned
 * early on an unfocused tab, and returning early is not a state write — so the
 * effect's dependencies never changed, so the effect never re-ran, so no new
 * timeout was ever armed. One tab switch killed the carousel for the rest of the
 * session, on both tabs.
 *
 * A silently-stopped animation is close to untestable by hand: the carousel looks
 * fine, it is just still, and "still" reads as a design choice. Every scenario
 * here is therefore about a thing that DID NOT HAPPEN — no index change while
 * hidden, no reset on return, no advance before a full dwell.
 *
 * It is a fake clock rather than real timers because the interesting cases are
 * the ones you would have to sit and watch for — a tick landing one millisecond
 * either side of a tab switch. Both the old and the new loop are driven from the
 * same clock so the comparison is like for like.
 *
 * Run with:  npx tsx scripts/check-hero-autoplay.ts
 */

const AUTOPLAY_MS = 5000;
const LEN = 8;

/** A deterministic clock. Timers fire in deadline order at their exact time. */
class Clock {
  private now = 0;
  private seq = 0;
  private timers = new Map<number, { at: number; fn: () => void }>();

  /** Flushed after each callback, so state writes re-render the way React does. */
  onAfterCallback: (() => void) | null = null;

  schedule(delay: number, fn: () => void): number {
    const id = ++this.seq;
    this.timers.set(id, { at: this.now + delay, fn });
    return id;
  }

  clear(id: number): void {
    this.timers.delete(id);
  }

  get pending(): number {
    return this.timers.size;
  }

  advanceTo(t: number): void {
    for (;;) {
      let dueId: number | null = null;
      let dueAt = Infinity;
      for (const [id, timer] of this.timers) {
        if (timer.at <= t && timer.at < dueAt) {
          dueId = id;
          dueAt = timer.at;
        }
      }
      if (dueId === null) break;
      const timer = this.timers.get(dueId)!;
      this.timers.delete(dueId);
      this.now = timer.at;
      timer.fn();
      // React flushes the state write AFTER the callback returns, not inside it.
      // Getting this wrong hides a double-timer bug, so it is modelled explicitly.
      this.onAfterCallback?.();
    }
    this.now = t;
  }

  get time(): number {
    return this.now;
  }
}

/**
 * The carousel's timer loop, both variants.
 *
 * `render()` stands in for React's effect reconciliation: the effect only re-runs
 * when its dependencies change, so an unchanged `index` genuinely produces no
 * re-arm. That is the entire mechanism the freeze depended on.
 */
class Hero {
  index = 0;
  epoch = 0;
  /** Clock times at which the slide actually changed. */
  readonly advancedAt: number[] = [];
  private sawFocus = false;
  private timer: number | null = null;
  private deps: string | null = null;
  private dirty = false;

  constructor(
    private clock: Clock,
    private focusedNow: () => boolean,
    private variant: 'old' | 'new'
  ) {}

  render(): void {
    const sig = `${this.index}|${LEN}|${this.epoch}`;
    if (sig === this.deps) return; // deps unchanged — React does NOT re-run
    this.cleanup();
    this.deps = sig;
    this.run();
  }

  cleanup(): void {
    if (this.timer !== null) {
      this.clock.clear(this.timer);
      this.timer = null;
    }
  }

  private advance(): void {
    this.index = (this.index + 1) % LEN;
    this.advancedAt.push(this.clock.time);
    this.dirty = true;
  }

  private run(): void {
    if (this.variant === 'old') {
      this.timer = this.clock.schedule(AUTOPLAY_MS, () => {
        if (!this.focusedNow()) return; // THE BUG: no state write, no re-arm
        this.advance();
      });
      return;
    }
    this.sawFocus = this.focusedNow();
    const tick = () => {
      const focused = this.focusedNow();
      if (focused && this.sawFocus) this.advance();
      this.sawFocus = focused;
      this.timer = this.clock.schedule(AUTOPLAY_MS, tick);
    };
    this.timer = this.clock.schedule(AUTOPLAY_MS, tick);
  }

  /** The re-render React performs after this component's state write. */
  flush(): void {
    if (!this.dirty) return;
    this.dirty = false;
    this.render();
  }

  /** A swipe or dot tap. */
  interact(): void {
    this.epoch++;
    this.render();
  }

  /** The tab taking / losing focus. */
  focus(focused: () => boolean): void {
    this.clock.onAfterCallback = () => this.flush();
    this.focusedNow = focused;
  }
}

let failures = 0;
function check(name: string, pass: boolean, detail = '') {
  if (pass) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** A hero on a clock, with the render flush wired up. */
function mount(variant: 'old' | 'new', focused: () => boolean): { clock: Clock; hero: Hero } {
  const clock = new Clock();
  const hero = new Hero(clock, focused, variant);
  clock.onAfterCallback = () => hero.flush();
  hero.render();
  return { clock, hero };
}

function main() {
  console.log('\nhero autoplay');

  // --- the bug, reproduced ------------------------------------------------
  {
    let visible = true;
    const { clock, hero } = mount('old', () => visible);
    clock.advanceTo(12_000); // two ordinary advances
    const before = hero.index;
    visible = false; // switch tab
    clock.advanceTo(600_000); // ten minutes in the background
    visible = true; // come back
    clock.advanceTo(700_000);
    check(
      'the old loop froze permanently after one tab switch',
      hero.index === before,
      `advanced to ${hero.index} after returning`
    );
  }

  // --- hidden means still -------------------------------------------------
  {
    let visible = true;
    const { clock, hero } = mount('new', () => visible);
    clock.advanceTo(12_000);
    const parked = hero.index;
    check('a visible carousel does advance', parked > 0, `index ${parked}`);

    visible = false;
    clock.advanceTo(600_000);
    check(
      'a hidden carousel does not advance at all',
      hero.index === parked,
      `moved from ${parked} to ${hero.index} while hidden`
    );
  }

  // --- resumes where it left off ------------------------------------------
  // Asserted on WHEN it moved rather than on a tick count, so the result does not
  // depend on where the timer boundaries happen to fall relative to the tab switch.
  {
    let visible = true;
    const { clock, hero } = mount('new', () => visible);
    clock.advanceTo(12_000);
    const parked = hero.index;
    visible = false;
    const hiddenFrom = clock.time;
    clock.advanceTo(300_000);
    visible = true;
    const backAt = clock.time;
    const marks = hero.advancedAt.length;
    clock.advanceTo(backAt + 20_000);

    const since = hero.advancedAt.slice(marks);
    check('nothing moved while hidden', !since.some((t) => t >= hiddenFrom && t < backAt));
    check(
      'the first move after returning is the next slide, not slide 0',
      parked !== LEN - 1 && hero.index !== 0,
      `parked ${parked}, now ${hero.index}`
    );
    check(
      'and it is the very next one',
      since.length > 0 && (parked + since.length) % LEN === hero.index,
      `parked ${parked}, ${since.length} moves, now ${hero.index}`
    );
  }

  // --- and resumes with a full dwell --------------------------------------
  // THE INVARIANT: a return must not count the time spent in another tab as
  // dwell. A timer that kept counting would advance within a millisecond of the
  // return, which reads as the carousel jumping the moment you look at it.
  //
  // The first move after a return lands between ONE and TWO dwells, not exactly
  // one: the tick that happens to be first after the return is spent recording
  // that the tab is visible again, and the move follows a dwell later. Without a
  // focus subscription the return can only be noticed at tick granularity, and
  // 5-10s of first-slide dwell is indistinguishable from 5s to a user — what is
  // not acceptable is 0s, which is what a plain re-arm gives half the time.
  {
    let visible = true;
    const { clock, hero } = mount('new', () => visible);
    clock.advanceTo(10_000);
    visible = false;
    clock.advanceTo(300_000);
    visible = true;
    const backAt = clock.time;
    const marks = hero.advancedAt.length;

    clock.advanceTo(backAt + AUTOPLAY_MS - 1);
    check(
      'returning does not cut the dwell short',
      hero.advancedAt.length === marks,
      `moved ${clock.time - backAt}ms after returning`
    );

    clock.advanceTo(backAt + 2 * AUTOPLAY_MS);
    check(
      '…and it moves within two dwells of the return',
      hero.advancedAt.length === marks + 1,
      `${hero.advancedAt.length - marks} moves within 10s of returning`
    );
  }

  // --- a tab that was never focused ---------------------------------------
  {
    const { clock, hero } = mount('new', () => false);
    clock.advanceTo(600_000);
    check(
      'a tab that was never focused never advances',
      hero.index === 0 && hero.advancedAt.length === 0,
      `index ${hero.index}, ${hero.advancedAt.length} moves`
    );
  }

  // --- interactions still reset the clock ---------------------------------
  {
    let visible = true;
    const { clock, hero } = mount('new', () => visible);
    clock.advanceTo(4_900);
    hero.interact();
    const parked = hero.index;
    clock.advanceTo(9_800);
    check(
      'a swipe resets the clock to a full 5s',
      hero.index === parked,
      `advanced to ${hero.index} 100ms after the swipe`
    );
    clock.advanceTo(9_900);
    check(
      '…and resumes on schedule after it',
      hero.index === (parked + 1) % LEN,
      `index ${hero.index}`
    );
  }

  // --- exactly one live timer, always ------------------------------------
  // The self-rearming loop replaces one timer with one timer. If it ever managed
  // to stack, a hidden tab would be doing several `isFocused()` checks per tick
  // and the leak would grow for the whole session.
  {
    let visible = true;
    const { clock } = mount('new', () => visible);
    clock.advanceTo(120_000);
    check('a visible carousel keeps one timer, not one per slide', clock.pending === 1, `${clock.pending} timers alive`);
    visible = false;
    clock.advanceTo(300_000);
    check(
      'a hidden carousel still keeps exactly one timer armed',
      clock.pending === 1,
      `${clock.pending} timers alive`
    );
  }

  // Unmounting must leave nothing behind, or a tab revisited a hundred times
  // accumulates a hundred armed timers.
  {
    const { clock, hero } = mount('new', () => true);
    clock.advanceTo(60_000);
    hero.cleanup();
    check('unmounting cancels the pending timer', clock.pending === 0, `${clock.pending} timers alive`);
  }

  console.log(failures ? `\n${failures} failed\n` : '\nall passed\n');
  process.exit(failures ? 1 : 0);
}

main();