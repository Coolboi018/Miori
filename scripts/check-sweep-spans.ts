// Verifies each skeleton's ShimmerSweep `span` covers the largest `at` any of its
// plates asks for. A span short of the maximum does not look wrong — it looks
// like the tail of the wave simply never lights up, which is exactly the kind of
// bug a comment cannot catch.
//
// Run: npx tsx scripts/check-sweep-spans.ts

const LEAD = 0.16;

type Case = { name: string; span: number; offsets: number[] };

const cases: Case[] = [];

// --- HomeSkeleton: rails=2 (home and explore) ------------------------------
{
  const TILES = 5, RAIL_SPAN = 0.62, RAIL_LEAD = 0.13, LINE_LEAD = 0.06;
  for (const rails of [2]) {
    const offsets: number[] = [0];
    for (let r = 0; r < rails; r++) {
      const base = r * RAIL_LEAD;
      offsets.push(base);
      for (let j = 0; j < TILES; j++) {
        const tile = base + (j / (TILES - 1)) * RAIL_SPAN;
        offsets.push(tile, tile + LINE_LEAD, tile + LINE_LEAD * 2);
      }
    }
    cases.push({
      name: `HomeSkeleton rails=${rails}`,
      span: (rails - 1) * RAIL_LEAD + RAIL_SPAN + LINE_LEAD * 2,
      offsets,
    });
  }
}

// --- GridSkeleton: rows=2 (search) and rows=3 (explore browse) ------------
{
  const ROW_SPAN = 0.55, ROW_LEAD = 0.16, LINE_LEAD = 0.05;
  for (const [rows, columns] of [[2, 3], [3, 3], [2, 2]] as const) {
    const offsets: number[] = [];
    for (let i = 0; i < columns * rows; i++) {
      const row = Math.floor(i / columns), col = i % columns;
      const at = row * ROW_LEAD + (columns <= 1 ? 0 : (col / (columns - 1)) * ROW_SPAN);
      offsets.push(at, at + LINE_LEAD, at + LINE_LEAD * 2);
    }
    cases.push({
      name: `GridSkeleton rows=${rows} cols=${columns}`,
      span: (rows - 1) * ROW_LEAD + ROW_SPAN + LINE_LEAD * 2,
      offsets,
    });
  }
}

// --- ScheduleSkeleton ------------------------------------------------------
{
  const ROWS = 3, ROW_SPAN = 0.3, ROW_LEAD = 0.07, CARD_LEAD = 0.3;
  const offsets: number[] = [];
  for (let g = 0; g < 2; g++) {
    const card = g * CARD_LEAD;
    offsets.push(card);
    for (let r = 0; r < ROWS; r++) {
      const row = card + r * ROW_LEAD;
      // Parts 0, 1, 1.5, 2, 3, 4 through sweepAt(part, 5, ROW_SPAN, row)
      for (const part of [0, 1, 1.5, 2, 3, 4]) {
        offsets.push(row + (part / 4) * ROW_SPAN);
      }
    }
  }
  cases.push({ name: 'ScheduleSkeleton', span: CARD_LEAD + (ROWS - 1) * ROW_LEAD + ROW_SPAN, offsets });
}

// --- SearchLandingSkeleton -------------------------------------------------
{
  const SECTION_LEAD = 0.25, CHIP_SPAN = 0.5;
  const offsets: number[] = [];
  for (let section = 0; section < 2; section++) {
    const base = section * SECTION_LEAD;
    offsets.push(base);
    const n = section === 0 ? 3 : 5;
    for (let i = 0; i < n; i++) offsets.push(base + (i / (n - 1)) * CHIP_SPAN);
  }
  cases.push({ name: 'SearchLandingSkeleton', span: SECTION_LEAD + CHIP_SPAN, offsets });
}

// --- DetailSkeleton --------------------------------------------------------
{
  const EPISODE_ROWS = 3;
  const IDENTITY_LEAD = 0.1, SYNOPSIS_LEAD = 0.3, ACTIONS_LEAD = 0.5;
  const TABS_LEAD = 0.66, SEARCH_LEAD = 0.78, ROW_LEAD = 0.86;
  const offsets: number[] = [
    0,
    IDENTITY_LEAD, IDENTITY_LEAD + LEAD, IDENTITY_LEAD + LEAD * 2, IDENTITY_LEAD + LEAD * 3,
    SYNOPSIS_LEAD, SYNOPSIS_LEAD + LEAD, SYNOPSIS_LEAD + LEAD * 2,
    ACTIONS_LEAD, ACTIONS_LEAD + LEAD, ACTIONS_LEAD + LEAD * 2,
    TABS_LEAD, SEARCH_LEAD,
  ];
  for (let i = 0; i < EPISODE_ROWS; i++) {
    offsets.push(ROW_LEAD + i * LEAD, ROW_LEAD + i * LEAD + LEAD, ROW_LEAD + i * LEAD + LEAD * 2);
  }
  cases.push({ name: 'DetailSkeleton', span: ROW_LEAD + (EPISODE_ROWS - 1) * LEAD + LEAD * 2, offsets });
}

// --- CastSkeleton ----------------------------------------------------------
{
  const perRow = 2, CARD_SPAN = 0.7, ROW_LEAD = 0.35, STEP = 0.12;
  const offsets: number[] = [];
  for (let i = 0; i < 4; i++) {
    const row = Math.floor(i / perRow), col = i % perRow;
    const base = row * ROW_LEAD + (col / (perRow - 1)) * CARD_SPAN;
    offsets.push(base, base + STEP, base + STEP * 2, base + STEP / 2, base + STEP * 1.5);
  }
  cases.push({ name: 'CastSkeleton', span: ROW_LEAD + CARD_SPAN + STEP * 2, offsets });
}

let failed = false;
for (const c of cases) {
  const max = Math.max(...c.offsets);
  const ok = c.span + 1e-9 >= max;
  if (!ok) failed = true;
  const slack = c.span - max;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${c.name.padEnd(34)} span=${c.span.toFixed(3)}  max at=${max.toFixed(3)}  slack=${slack.toFixed(3)}`
  );
}

if (failed) {
  console.error('\nA span shorter than the largest `at` cuts the tail off the wave.');
  process.exit(1);
}
console.log('\nAll spans cover every plate.');
