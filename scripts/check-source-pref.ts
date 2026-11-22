/**
 * The per-anime source memory, driven as the REAL module.
 *
 * `lib/player/sourcePref.ts` (`pickStartIndex`) is the actual code the player
 * runs on every resolve. THE REPORT (13 Nov): resolve returns every
 * extension's rows ranked into one list and the player always started at
 * index 0 — a viewer who watched the last session on Mega came back to the
 * same episode and landed on the top of the queue again. The episode LIST was
 * cached; the source CHOICE was not.
 *
 * Three rules are pinned, each with its OLD shape watched getting it wrong:
 *
 *   1. A remembered extension's FIRST row is where the walk starts (not an
 *      exact row — an extension's rows regroup between resolves, and the
 *      memory's unit of truth is the extension, not row 3).
 *   2. A remembered extension that did not answer this resolve falls back to
 *      the ranked top — a stale preference never costs a watchable episode.
 *   3. No memory means rank 0, exactly as before.
 *   4. The extension that actually PLAYED outranks a GLOBAL default
 *      (`player.defaultSource`). The 21 Nov report: Mega was playing, the
 *      viewer backed out and returned, and the Settings default opened
 *      instead. Proof from a minute ago beats a guess from Settings; the
 *      default still decides when there is no memory, and still falls
 *      through when nobody can honour it.
 */

import { nextWalkIndex, pickStartIndex } from '../lib/player/sourcePref';
import {
  clearSourceTrip,
  clearSourceTrips,
  isSourceSkipped,
  noteSourcePlayed,
  readSourceTrip,
  resetSourceLedger,
  sessionProvenSource,
  sourceSkipHint,
  tripHint,
  tripKindForPlaybackFailure,
  tripKindForResolveFailure,
  tripSource,
} from '../lib/player/sourceLedger';

let pass = 0;
let fail = 0;

function check(name: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) {
    pass += 1;
  } else {
    fail += 1;
    console.error(`  ✗ ${name}\n      got:  ${JSON.stringify(got)}\n      want: ${JSON.stringify(want)}`);
  }
}

function section(title: string): void {
  console.log(`\n${title}`);
}

// The resolve's real shape: registry order (filmu first), multiple rows per
// extension, tags applied by `resolveEpisode`.
const ranked = [
  { extId: 'filmu', quality: '1080p' },
  { extId: 'filmu', quality: '720p' },
  { extId: 'mega', quality: 'Auto' },
  { extId: 'anikoto', quality: 'HD-1' },
  { extId: 'anikoto', quality: 'HD-2' },
  { extId: 'zoko', quality: 'Auto' },
];

section('1. The remembered extension starts the walk — at its FIRST row');

{
  // THE OLD SHAPE, watched failing: `setSrcIndex(0)` unconditionally.
  const oldShape = (_sources: unknown[], _pref: string | null) => 0;

  check(
    'old shape lands on filmu even though the viewer watched on mega — WRONG, watched failing',
    oldShape(ranked, 'mega'),
    0
  );
  check(
    'real rule: the memory of mega starts the walk at mega\'s first row',
    pickStartIndex(ranked, 'mega'),
    2
  );
  check(
    'a mid-list extension (anikoto) starts at its own first row, not row 0',
    pickStartIndex(ranked, 'anikoto'),
    3
  );
  check(
    'the memory\'s unit is the EXTENSION: it must NOT require the same quality row as last time',
    pickStartIndex(
      [
        { extId: 'filmu', quality: '1080p' },
        { extId: 'mega', quality: 'Auto' },
        { extId: 'mega', quality: '1080p' },
      ],
      'mega'
    ),
    1
  );
}

section('2. A preference the resolve cannot honour falls back to the ranked top');

{
  check(
    'the remembered extension did not answer this resolve — start at 0, never lose the episode',
    pickStartIndex(ranked, 'zoko-fallback-that-vanished'),
    0
  );
  check(
    'an untagged list (a resolve that predates tagging) still starts at 0',
    pickStartIndex([{}, {}], 'mega'),
    0
  );
}

section('3. No memory is exactly the old behaviour');

{
  check('null preference → ranked top', pickStartIndex(ranked, null), 0);
  check('empty preference string → ranked top', pickStartIndex(ranked, ''), 0);
  check('empty list → 0, finite', pickStartIndex([], 'mega'), 0);
}

section('4. The PROVEN source outranks the stated default');

{
  // THE OLD SHAPE, watched failing: the default was checked first, so after
  // watching on Mega the player opened on the Settings default (filmu) again.
  const oldShape = (pref: string | null, def?: string | null) => {
    if (def) {
      const i = ranked.findIndex((s) => s.extId === def);
      if (i >= 0) return i;
    }
    if (!pref) return 0;
    const i = ranked.findIndex((s) => s.extId === pref);
    return i >= 0 ? i : 0;
  };

  check(
    'old shape: default filmu wins even though mega just played — WRONG, watched failing',
    oldShape('mega', 'filmu'),
    0
  );
  check(
    'real rule: the source that actually played starts the walk, past the default',
    pickStartIndex(ranked, 'mega', 'filmu'),
    2
  );
  check(
    "the proven source starts at ITS first row, not an exact quality row",
    pickStartIndex(ranked, 'anikoto', 'filmu'),
    3
  );
  check(
    "no memory: the stated default decides, exactly as before",
    pickStartIndex(ranked, null, 'mega'),
    2
  );
  check(
    "the stated default starts at that extension's FIRST row",
    pickStartIndex(ranked, null, 'anikoto'),
    3
  );
  check(
    'a memory the resolve cannot honour falls through to the default',
    pickStartIndex(ranked, 'gone', 'mega'),
    2
  );
  check(
    'a memory AND a default nobody can honour → ranked top, never lose the episode',
    pickStartIndex(ranked, 'gone', 'also-gone'),
    0
  );
  check(
    "'auto' is not a default — it is the absence of one (the memory decides)",
    pickStartIndex(ranked, 'anikoto', 'auto'),
    3
  );
  check(
    'empty-string default is the absence of one too',
    pickStartIndex(ranked, 'anikoto', ''),
    3
  );
}

// ===========================================================================
// 6. The SESSION decides: proof first, skips filtered
// ===========================================================================
//
// The 22 Nov ask. A provider that is ISP-blocked or rate-limited does not
// recover between episode 3 and episode 4, and asking it again on every open is
// the spinner the viewer remembers. The session ledger records the verdict; the
// start choice and the walk consume it.
//
// The precedence is deliberate: PROOF beats the per-anime memory, which beats
// the stated default. A frame five seconds ago is fresher evidence than a
// preference from last week, and the `skipped` filter applies to every rung so
// one bad session cannot be re-probed in the background either.

section('6. The session\u2019s own health decides the start');

const skip = (id?: string) => (id ? isSourceSkipped(id) : false);

{
  resetSourceLedger();
  noteSourcePlayed('zoko');
  check(
    'the source that just rendered a frame starts the next episode',
    pickStartIndex(ranked, null, null, { proven: sessionProvenSource(), skipped: skip }),
    5
  );
  check(
    '...and outranks the anime memory and the stated default',
    pickStartIndex(ranked, 'mega', 'filmu', { proven: sessionProvenSource(), skipped: skip }),
    5
  );
  check(
    'proof is per-session state, not per-title: the same id answers for another anime',
    sessionProvenSource(),
    'zoko'
  );
}

{
  // A source the session has written off is never chosen by Auto — not as
  // proof, not as this anime's memory, not as the Settings default.
  resetSourceLedger();
  tripSource('anikoto', 'blocked');
  check(
    'a skipped source is not chosen even as the session proof',
    pickStartIndex(ranked, null, null, { proven: 'anikoto', skipped: skip }),
    0
  );
  check(
    '...nor as this anime\u2019s memory',
    pickStartIndex(ranked, 'anikoto', null, { skipped: skip }),
    0
  );
  check(
    '...nor as the stated default',
    pickStartIndex(ranked, null, 'anikoto', { skipped: skip }),
    0
  );
  check(
    'the first source still alive wins when the top is skipped',
    pickStartIndex([{ extId: 'anikoto' }, { extId: 'mega' }], null, null, { skipped: skip }),
    1
  );
  check(
    'a skip is a hint, not a lock: when EVERY source is skipped the ranked top is still tried',
    pickStartIndex(
      [
        { extId: 'filmu' },
        { extId: 'mega' },
      ],
      'filmu',
      null,
      {
        skipped: () => true,
      }
    ),
    0
  );
  check(
    'a live memory is used when the session proof is skipped',
    pickStartIndex(ranked, 'mega', null, { proven: 'anikoto', skipped: skip }),
    2
  );
}

// ===========================================================================
// 7. The failover walk steps over a skipped row
// ===========================================================================
//
// Without this, a dead provider in the middle of the list is tried on every
// walk until the 3-round budget dies — the "wastes user time" half of the ask.

section('7. The failover walk steps over a skipped row');

const ladder = [{ extId: 'filmu' }, { extId: 'mega' }, { extId: 'anikoto' }];

{
  resetSourceLedger();
  tripSource('mega', 'blocked');
  check('a skipped row in the middle is stepped over', nextWalkIndex(ladder, 0, skip), 2);
  check('the end of the list is still the end', nextWalkIndex(ladder, 2, skip), null);
  check('an untripped walk is plain rank order (the old behaviour)', nextWalkIndex(ladder, 0), 1);
  check('...and never returns an index past the list', nextWalkIndex(ladder, 5, skip), null);

  resetSourceLedger();
  tripSource('filmu', 'network');
  tripSource('mega', 'server');
  tripSource('anikoto', 'rate-limited');
  check(
    'when nothing is live the walk still proceeds in rank order \u2014 no refusing to try',
    nextWalkIndex(ladder, 0, skip),
    1
  );
}

// ===========================================================================
// 8. What marks a source for the session \u2014 and what must not
// ===========================================================================

section('8. What marks a source for the session');

check('a provider that answered \u201cblocked\u201d is a block', tripKindForResolveFailure('blocked'), 'blocked');
check('an ISP-level failure is a network problem', tripKindForResolveFailure('network blocked'), 'network');
check('a 429 is a rate limit, not a block', tripKindForResolveFailure('429 Too Many Requests'), 'rate-limited');
check('a 5xx is server trouble', tripKindForResolveFailure('503 Service Unavailable'), 'server');

check(
  '\u201cno mapping\u201d is about THIS TITLE, so it must not hide the provider from the next anime',
  tripKindForResolveFailure('no mapping'),
  null
);
check('\u201cno episodes\u201d is title-level too', tripKindForResolveFailure('no episodes'), null);
check('\u201cno sources\u201d is title-level too', tripKindForResolveFailure('no sources'), null);

check(
  'an EXPIRED signed link is the URL\u2019s fault, not the source\u2019s',
  tripKindForPlaybackFailure('HttpDataSource error: 403 Forbidden (expired token)'),
  null
);
check('a plain 403 IS a block', tripKindForPlaybackFailure('Source error: 403 Forbidden'), 'blocked');
check('a 429 during playback is rate limiting', tripKindForPlaybackFailure('HTTP 429'), 'rate-limited');
check('a 5xx during playback is server trouble', tripKindForPlaybackFailure('server returned 503'), 'server');
check(
  'an offline DEVICE is not a verdict about any source',
  tripKindForPlaybackFailure('Network is unreachable'),
  null
);
check('an unreadable failure marks nothing', tripKindForPlaybackFailure('Something odd happened'), null);
check('no message at all marks nothing', tripKindForPlaybackFailure(''), null);

// ===========================================================================
// 9. A frame clears the skip; a manual pick clears it for one attempt
// ===========================================================================

section('9. Proof clears a skip, and the picker can override for one attempt');

{
  resetSourceLedger();
  tripSource('mega', 'rate-limited');
  check('the trip is recorded', isSourceSkipped('mega'), true);
  check('...with a one-line hint for the picker', sourceSkipHint('mega'), 'Skipped \u00b7 rate limited');
  check('an untouched source has no hint', sourceSkipHint('filmu'), undefined);

  check('a frame clears it', noteSourcePlayed('mega'), true);
  check('...and the source is no longer skipped', isSourceSkipped('mega'), false);
  check('...and it is the session\u2019s proven source', sessionProvenSource(), 'mega');
  check('re-proving the same source changes nothing (no needless re-render)', noteSourcePlayed('mega'), false);

  tripSource('mega', 'server');
  clearSourceTrip('mega');
  check(
    'an explicit pick clears a skip WITHOUT claiming proof',
    isSourceSkipped('mega') === false && sessionProvenSource() === 'mega',
    true
  );
  check('the skip record itself is gone too', readSourceTrip('mega'), null);
  check(
    'the hint names the reason, not the raw native text',
    tripHint({ kind: 'server', reason: 'x', at: 0 }),
    'Skipped \u00b7 server error'
  );

  // "Refresh sources" — the one explicit override of the whole ledger.
  resetSourceLedger();
  noteSourcePlayed('zoko');
  tripSource('mega', 'network');
  clearSourceTrips();
  check(
    'an explicit refresh puts every skip back on trial but keeps the proof',
    isSourceSkipped('mega') === false && sessionProvenSource() === 'zoko',
    true
  );

  resetSourceLedger();
  check(
    'the ledger dies with the process: a reset clears skips AND proof',
    isSourceSkipped('mega') === false && sessionProvenSource() === null,
    true
  );
}

console.log(`\n${pass}/${pass + fail} checks passed`);
if (fail > 0) process.exit(1);
