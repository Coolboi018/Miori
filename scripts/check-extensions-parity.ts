// Static-parity check: manifest (through the loader) vs the compiled-in
// extension. Verifies that every manifest in extensions/ converts to a valid
// Extension and that the built-ins and manifests agree on id/version.
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

import { manifestToExtensionSafe } from '../lib/extensions/loader/engine';

const extDir = join(process.cwd(), 'extensions');
const index = JSON.parse(readFileSync(join(extDir, 'index.json'), 'utf8'));

let ok = 0;
let fail = 0;
for (const file of index.manifests as string[]) {
  const raw = JSON.parse(readFileSync(join(extDir, file), 'utf8'));
  const ext = manifestToExtensionSafe(raw, '');
  if (!ext) {
    console.log(`  FAIL  ${file}: did not convert to an Extension`);
    fail++;
    continue;
  }
  const hasEpisodes = typeof ext.episodes === 'function';
  const hasResolve = typeof ext.resolve === 'function';
  const hasMatch = typeof ext.match === 'function';
  if (!hasEpisodes || !hasResolve || !hasMatch) {
    console.log(`  FAIL  ${file}: missing contract methods`);
    fail++;
    continue;
  }
  console.log(`  ok    ${file} -> ${ext.id} v${ext.version} (match/episodes/resolve present)`);
  ok++;
}

// --- filmu: every sub stream is its own row -------------------------------
// The picker used to show a single "Katana" row for a provider whose own player
// lists Katana/Ronin/Shogun/Ninja, because `/api/sources` was read as
// `streams[0]`. These assert the shipped source walks the whole matrix instead,
// labels rows by server, drops dub audio, and that a refresh stays on its row.
const filmuSrc = readFileSync(join(process.cwd(), 'lib/extensions/filmu/index.ts'), 'utf8');
const subStreamRules: Array<[string, boolean]> = [
  ['filmu mints every decoded sub stream', /st\.streams\.forEach/.test(filmuSrc)],
  ['...never just the first one again', !/\.streams\[0\]/.test(filmuSrc)],
  ['...labels a row by its server', /serverLabel\(serverId\)/.test(filmuSrc)],
  ['...drops dub audio from the sub matrix', /\/dub\/i\.test\(serverId\)/.test(filmuSrc)],
  ['...and a refresh re-mints its OWN row', /s\.quality === qualityLabel/.test(filmuSrc)],
];
for (const [name, pass] of subStreamRules) {
  console.log(`  ${pass ? 'ok  ' : 'FAIL'}  ${name}`);
  if (!pass) fail++;
}

console.log(`\n${ok} converted, ${fail} failed`);
if (fail) process.exit(1);
console.log('parity: structural OK');
