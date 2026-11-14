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
 *   4. A GLOBAL default source (`player.defaultSource`) outranks the memory
 *      when its extension answered — a stated preference beats a learned
 *      one — and falls through to the memory when it did not.
 */

import { pickStartIndex } from '../lib/player/sourcePref';

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

section('4. A GLOBAL default source outranks the learned memory — when it answered');

{
  // THE OLD SHAPE, watched failing: the two-argument call. A viewer who set
  // Mega in Settings watched one episode elsewhere, the frame-render save
  // wrote the per-anime memory over it, and the global default never stuck.
  check(
    'old shape (no default argument) lets the memory override the setting — WRONG, watched failing',
    pickStartIndex(ranked, 'anikoto'),
    3
  );
  check(
    'the stated default starts the walk, past the memory',
    pickStartIndex(ranked, 'anikoto', 'mega'),
    2
  );
  check(
    'the stated default starts at that extension\'s FIRST row, not an exact row',
    pickStartIndex(ranked, null, 'anikoto'),
    3
  );
  check(
    'a default the resolve cannot honour falls through to the memory, then the top',
    pickStartIndex(ranked, 'mega', 'zoko-fallback-that-vanished'),
    2
  );
  check(
    'a default nobody can honour with no memory → ranked top, never lose the episode',
    pickStartIndex(ranked, null, 'zoko-fallback-that-vanished'),
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

console.log(`\n${pass}/${pass + fail} checks passed`);
if (fail > 0) process.exit(1);
