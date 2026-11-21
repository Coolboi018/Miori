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

console.log(`\n${pass}/${pass + fail} checks passed`);
if (fail > 0) process.exit(1);
