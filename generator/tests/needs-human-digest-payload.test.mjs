/**
 * Regressioni #1143 item 1/3 per il confine payload del digest needs-human.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  PAYLOAD_OK_MARKER,
  classifyDigestPartitions,
  formatPayload,
  parseNeedsHumanPayload,
} from '../../scripts/ci/needs-human-digest.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = path.join(ROOT, 'scripts/ci/needs-human-digest.mjs');
const item = (number, title, pullRequest = null) => ({
  number,
  title,
  updated_at: '2026-09-11T10:00:00Z',
  pull_request: pullRequest,
});

test('#1143: il payload paginato vuoto è valido, la forma inattesa no', () => {
  assert.deepEqual(parseNeedsHumanPayload('[]'), []);
  assert.deepEqual(parseNeedsHumanPayload(JSON.stringify([[item(1, 'issue')], []])), [item(1, 'issue')]);
  assert.throws(() => parseNeedsHumanPayload('{"unexpected":[]}'), /forma inattesa/);
  assert.throws(() => parseNeedsHumanPayload('[{}]'), /number non valido/);
});

test('#1143 item 1: errors accanto a data non diventano un falso-vuoto', () => {
  assert.throws(
    () => parseNeedsHumanPayload(JSON.stringify({ data: [], errors: [{ message: 'partial' }] })),
    /errors.*data parziale/,
  );
  assert.throws(
    () => parseNeedsHumanPayload(JSON.stringify([[item(1, 'issue')], { data: [], errors: [{ message: 'partial' }] }])),
    /errors.*data parziale/,
  );
});

test('#1143 item 3: il classificatore separa completo, parziale e doppio fallimento', () => {
  assert.deepEqual(classifyDigestPartitions(0, 0), {
    kind: 'complete', good: ['prs', 'issues'], incomplete: [],
  });
  assert.deepEqual(classifyDigestPartitions(1, 0), {
    kind: 'partial', good: ['issues'], incomplete: ['prs'],
  });
  assert.deepEqual(classifyDigestPartitions(0, 1), {
    kind: 'partial', good: ['prs'], incomplete: ['issues'],
  });
  assert.deepEqual(classifyDigestPartitions(1, 1), {
    kind: 'failed', good: [], incomplete: ['prs', 'issues'],
  });
});

test('#1143: il CLI emette il marker solo dopo la validazione', () => {
  const ok = spawnSync(process.execPath, [CLI], { input: '[]', encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout, `${formatPayload([])}`);
  assert.ok(ok.stdout.startsWith(`${PAYLOAD_OK_MARKER}\n`));

  const bad = spawnSync(process.execPath, [CLI], {
    input: JSON.stringify({ data: [], errors: [{ message: 'partial' }] }),
    encoding: 'utf8',
  });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /errors.*data parziale/);
});
