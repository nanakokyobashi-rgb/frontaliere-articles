/**
 * loop-manifest-baseline-history.test.mjs — la verifica integrale delle
 * `baseline.corpus` del manifest contro la storia dei path (issue #978 item 4,
 * follow-up della #954).
 *
 * Si esercita la funzione PURA `baselineHistoryVerdict`, cioe' quella che
 * decide, con la storia passata come dato: la suite non apre git ne' la rete,
 * ed e' lo stesso schema di `gateVerdict` e `ghostVerdict`. Il ponte fra la
 * funzione e la storia vera lo tiene il passo di `loop-drift-check.yml`, che
 * gira su un checkout `fetch-depth: 0`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { baselineHistoryVerdict } from '../../scripts/ci/verify-manifest-baseline-history.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const entry = (path, corpus, extra = {}) => ({
  path,
  mode: 'identical',
  baseline: { site: 'ssss', corpus, alignedAt: '2026-01-01' },
  ...extra,
});

test('una baseline che combacia con una revisione storica passa', () => {
  const v = baselineHistoryVerdict({
    files: [entry('a.mjs', 'bbbb')],
    blobsByPath: new Map([['a.mjs', new Set(['aaaa', 'bbbb'])]]),
  });
  assert.equal(v.ok, true);
  assert.equal(v.checked, 1);
  assert.equal(v.verified, 1);
  assert.deepEqual(v.ghosts, []);
});

test('la baseline non deve essere la revisione ATTUALE: basta che sia esistita', () => {
  // E' il caso legittimo che la #954 ha creato riparando le 13 voci: l'hash
  // del blob a cui quel lato era davvero allineato ad `alignedAt`, non `now`.
  const v = baselineHistoryVerdict({
    files: [entry('a.mjs', 'vecchio')],
    blobsByPath: new Map([['a.mjs', new Set(['ora', 'intermedio', 'vecchio'])]]),
  });
  assert.equal(v.ok, true);
});

test('un hex plausibile mai esistito a quel path e\' un ghost', () => {
  const v = baselineHistoryVerdict({
    files: [entry('a.mjs', '0d449baad16a4280')],
    blobsByPath: new Map([['a.mjs', new Set(['68c106a1623858c5'])]]),
  });
  assert.equal(v.ok, false);
  assert.equal(v.verified, 0);
  assert.deepEqual(v.ghosts, [
    { path: 'a.mjs', side: 'corpus', hash: '0d449baad16a4280', revisions: 1 },
  ]);
});

test('un path senza nessuna revisione nota e\' un ghost, non un salto', () => {
  // Fail-open qui sarebbe la stessa forma di bug che il verificatore cerca:
  // «non ho trovato la storia» non e' «la baseline e' buona».
  const v = baselineHistoryVerdict({ files: [entry('a.mjs', 'bbbb')], blobsByPath: new Map() });
  assert.equal(v.ok, false);
  assert.equal(v.ghosts[0].revisions, 0);
});

test('`baseline.corpus` null non e\' un dato da verificare', () => {
  // `not-ported`: la voce dichiara di NON avere una baseline su questo lato.
  const v = baselineHistoryVerdict({
    files: [entry('a.mjs', null, { mode: 'not-ported' })],
    blobsByPath: new Map(),
  });
  assert.equal(v.ok, true);
  assert.equal(v.checked, 0);
  assert.equal(v.skipped, 1);
});

test('la verifica e\' manifest-wide: una voce sana non copre una malata', () => {
  // La differenza con `loop-baseline-pr-gate.mjs`, che e' diff-scoped: qui
  // nessuna voce e' fuori dallo sguardo perche' non l'ha toccata questa PR.
  const v = baselineHistoryVerdict({
    files: [entry('a.mjs', 'aaaa'), entry('b.mjs', 'zzzz'), entry('c.mjs', 'cccc')],
    blobsByPath: {
      'a.mjs': ['aaaa'],
      'b.mjs': ['bbbb'],
      'c.mjs': ['cccc'],
    },
  });
  assert.equal(v.checked, 3);
  assert.equal(v.verified, 2);
  assert.deepEqual(v.ghosts.map((g) => g.path), ['b.mjs']);
});

test('blobsByPath accetta anche array semplici (forma JSON del report)', () => {
  const v = baselineHistoryVerdict({ files: [entry('a.mjs', 'aaaa')], blobsByPath: { 'a.mjs': ['aaaa'] } });
  assert.equal(v.ok, true);
});

test('#1060: la baseline adapted di tests.yml è quella della riconciliazione attestata', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/ci/loop-sync-manifest.json'), 'utf8'));
  const tracked = manifest.files.find((f) => f.path === '.github/workflows/tests.yml');
  assert.ok(tracked);
  assert.equal(tracked.mode, 'adapted');
  assert.equal(tracked.baseline.corpus, 'f39e19c5467c4cc7');
  assert.equal(tracked.baseline.site, '5cafe12c0b7d3f4e');
  assert.equal(tracked.baseline.alignedAt, '2026-09-08');
  assert.match(tracked.reason, /RICONCILIATO 2026-09-08 \(#1060\)/);
});
