// Picks the tab-switch crossfade curve, by measuring the two things that
// actually decide whether a switch feels good:
//
//   DIP        the two scenes are SIBLINGS, not layers over an opaque backdrop:
//              the focused one is z-0 and the others z-(-1), so whatever NEITHER
//              paints shows the scene container through. Combined coverage =
//              outgoing + (1-outgoing)*incoming. Lower minimum = a darker flash
//              through the middle of every switch.
//
//   LATENCY    how long before the incoming screen is actually visible. A curve
//              can win on DIP by holding the outgoing screen at full opacity for
//              the first 80ms, which does not read as a smooth switch — it reads
//              as the app ignoring you and then snapping. So the metric that
//              decides the winner is "time for the incoming screen to reach half
//              opacity", and DIP only breaks ties among curves that are fast.
//
// Run: npx tsx scripts/check-crossfade.ts

const SWITCH_MS = 260;
const CURVE = 'Easing.out(Easing.cubic)';

function piecewise(x: number, xs: number[], ys: number[]): number {
  if (x <= xs[0]) return ys[0];
  if (x >= xs[xs.length - 1]) return ys[ys.length - 1];
  for (let i = 0; i < xs.length - 1; i++) {
    if (x <= xs[i + 1]) {
      const t = (x - xs[i]) / (xs[i + 1] - xs[i]);
      return ys[i] + t * (ys[i + 1] - ys[i]);
    }
  }
  return ys[ys.length - 1];
}

/**
 * Wall-clock time at which the shared clock reaches curve position p.
 * Easing.out(cubic) satisfies p = 1 - (1-t)^3, so t = 1 - (1-p)^(1/3).
 */
const wallOf = (p: number) => (1 - Math.pow(1 - p, 1 / 3)) * SWITCH_MS;

/** Find the first clock position where the incoming screen is this opaque. */
function clockFor(g: (p: number) => number, target: number): number {
  for (let i = 0; i <= 1000; i++) {
    const p = i / 1000;
    // incoming traverses progress 1 -> 0
    if (g(1 - p) >= target) return p;
  }
  return 1;
}

const N = 500;

function measure(g: (p: number) => number) {
  let worst = 1;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const outgoing = g(t);
    const incoming = g(1 - t);
    const coverage = outgoing + (1 - outgoing) * incoming;
    if (coverage < worst) worst = coverage;
  }
  return {
    dip: worst,
    halfMs: wallOf(clockFor(g, 0.5)),
    mostlyMs: wallOf(clockFor(g, 0.9)),
  };
}

const CANDIDATES = [
  { name: 'linear (the built-in fade)', ins: [-1, 0, 1], outs: [0, 1, 0] },
  { name: 'concave A (.8/.5)', ins: [-1, -0.8, -0.5, 0, 0.5, 0.8, 1], outs: [0, 0.25, 0.7, 1, 0.7, 0.25, 0] },
  { name: 'concave B (.85/.55)', ins: [-1, -0.85, -0.55, 0, 0.55, 0.85, 1], outs: [0, 0.22, 0.72, 1, 0.72, 0.22, 0] },
  { name: 'concave C (.85/.6)', ins: [-1, -0.85, -0.6, 0, 0.6, 0.85, 1], outs: [0, 0.18, 0.78, 1, 0.78, 0.18, 0] },
  { name: 'concave D (.9/.6)', ins: [-1, -0.9, -0.6, 0, 0.6, 0.9, 1], outs: [0, 0.2, 0.8, 1, 0.8, 0.2, 0] },
  { name: 'concave E (.9/.65)', ins: [-1, -0.9, -0.65, 0, 0.65, 0.9, 1], outs: [0, 0.16, 0.84, 1, 0.84, 0.16, 0] },
  { name: 'concave F (.92/.7)', ins: [-1, -0.92, -0.7, 0, 0.7, 0.92, 1], outs: [0, 0.12, 0.88, 1, 0.88, 0.12, 0] },
];

console.log(`Tab switch crossfade — ${SWITCH_MS}ms, ${CURVE}\n`);
console.log('curve                     DIP      incoming@50%  incoming@90%');
console.log('-'.repeat(58));

const rows = CANDIDATES.map((c) => {
  const m = measure((p) => piecewise(p, c.ins, c.outs));
  return { name: c.name, ...m };
});

for (const r of rows) {
  console.log(
    `${r.name.padEnd(26)} ${r.dip.toFixed(3)}    ${r.halfMs.toFixed(0).padStart(6)}ms    ${r.mostlyMs
      .toFixed(0)
      .padStart(6)}ms`
  );
}

// Winner: every curve that gets the incoming screen to half opacity within the
// first third of the window, then the shallowest dip among those.
const FAST_ENOUGH = SWITCH_MS / 3;
const eligible = rows.filter((r) => r.halfMs <= FAST_ENOUGH);
const winner = eligible.reduce((best, r) => (r.dip > best.dip ? r : best));

console.log(`\nLatency budget: incoming screen half-opaque within ${FAST_ENOUGH.toFixed(0)}ms.`);
console.log(
  `${eligible.length} of ${rows.length} curves qualify.\n` +
    `Winner: ${winner.name} — dip ${winner.dip.toFixed(3)}, half-opaque at ${winner.halfMs.toFixed(0)}ms.`
);

if (winner.dip < 0.93) {
  console.error('\nDip too deep: the scene container shows through the switch.');
  process.exit(1);
}
