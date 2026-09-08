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
import { readFileSync } from 'node:fs';
import {
  baselineHistoryVerdict,
  CANONICAL_HISTORY_REF,
  CURRENT_HISTORY_REF,
  isExpectedMissingHistoricalPath,
  parseCatFileBatchOutput,
  parseFollowHistory,
} from '../../scripts/ci/verify-manifest-baseline-history.mjs';

const HISTORY_SCRIPT = readFileSync(
  new URL('../../scripts/ci/verify-manifest-baseline-history.mjs', import.meta.url),
  'utf8',
);

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
  assert.match(tracked.baseline.corpus, /^[0-9a-f]{16}$/);
  assert.match(tracked.baseline.site, /^[0-9a-f]{16}$/);
  assert.match(tracked.baseline.alignedAt, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(tracked.reason, new RegExp(`RICONCILIATO ${tracked.baseline.alignedAt} \\(\\#1060\\)`));
});

test('la storia usa il ref canonico e conserva i merge completi', () => {
  assert.equal(CANONICAL_HISTORY_REF, 'origin/main');
  assert.equal(CURRENT_HISTORY_REF, 'HEAD');
  assert.match(
    HISTORY_SCRIPT,
    /git\(\['rev-list', '--full-history', CURRENT_HISTORY_REF, CANONICAL_HISTORY_REF, '--objects'/,
  );
  assert.doesNotMatch(HISTORY_SCRIPT, /git\(\['rev-list', '--all'/);
});

test('la passata sui rinomini usa il path storico associato a ogni commit', () => {
  const newer = 'a'.repeat(40);
  const older = 'b'.repeat(40);
  assert.deepEqual(
    parseFollowHistory(`${newer}\n\nnew-name.mjs\nold-name.mjs\n\n${older}\n\nolder-name.mjs\n`),
    [
      { sha: newer, path: 'new-name.mjs' },
      { sha: newer, path: 'old-name.mjs' },
      { sha: older, path: 'older-name.mjs' },
    ],
  );
  assert.match(HISTORY_SCRIPT, /parseFollowHistory\(git\(\['log', '--follow'[\s\S]+--name-only[\s\S]+CURRENT_HISTORY_REF/);
  assert.match(HISTORY_SCRIPT, /`\$\{sha\}:\$\{historicalPath\}`/);
});

test('un path storico assente e\' atteso, un errore di lettura no', () => {
  assert.equal(isExpectedMissingHistoricalPath("fatal: path 'old-name.mjs' does not exist in 'abc'"), true);
  assert.equal(isExpectedMissingHistoricalPath("fatal: path 'old-name.mjs' exists on disk, but not in 'abc'"), true);
  assert.equal(isExpectedMissingHistoricalPath('fatal: Not a valid object name abc:old-name.mjs'), false);
  assert.match(HISTORY_SCRIPT, /if \(r\.status === 0\) hashes\.add/);
  assert.match(HISTORY_SCRIPT, /isExpectedMissingHistoricalPath\(r\.stderr\)/);
});

test('cat-file non maschera missing, ambiguous o stdout troncato come ghost di massa', () => {
  const requested = new Map([['oid', new Set(['file.mjs'])]]);
  assert.throws(
    () => parseCatFileBatchOutput(Buffer.from('oid missing\n'), requested),
    /oid missing/,
  );
  assert.throws(
    () => parseCatFileBatchOutput(Buffer.from('oid ambiguous\n'), requested),
    /oid ambiguous/,
  );
  assert.throws(
    () => parseCatFileBatchOutput(Buffer.from('oid blob 4\nab'), requested),
    /stdout troncato|contenuto troncato/,
  );
  assert.throws(
    () => parseCatFileBatchOutput(Buffer.from('oid blob nope\n'), requested),
    /header non parsabile/,
  );
  assert.throws(
    () => parseCatFileBatchOutput(Buffer.from('oid blob 0\n\n'), new Map([
      ['oid', new Set(['file.mjs'])],
      ['another-oid', new Set(['another.mjs'])],
    ])),
    /stdout troncato.*another-oid/,
  );
});
