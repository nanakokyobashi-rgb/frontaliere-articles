/**
 * needs-human-prepass-deferred-read.test.mjs — FU-2026-09-24-030 (reviewer di
 * PR #1739, bucket del sito valerielinc-ops/frontaliere-si-o-no#9609).
 *
 * La seconda lettura (`automation-deferred`) falliva dentro lo stesso catch
 * della prima: la lista `needs-human` gia' letta veniva scartata e il giro
 * non agiva su niente. La prima lettura resta obbligatoria; la seconda, se
 * fallisce, viene dichiarata e non cancella la prima.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readPrepassCandidates } from '../../scripts/ci/needs-human-prepass.mjs';

const issue = (number, ...labels) => ({ number, labels: labels.map((name) => ({ name })) });

test('030: la lista needs-human sopravvive al fallimento della seconda query', () => {
  const read = readPrepassCandidates((label) => {
    if (label === 'needs-human') return [issue(1, 'needs-human'), issue(2, 'needs-human')];
    throw new Error('HTTP 502: Bad Gateway');
  });
  assert.deepEqual(read.issues.map((i) => i.number), [1, 2]);
  assert.equal(read.deferredUnreadable, true);
  assert.match(read.deferredError, /502/);
});

test('030: senza la prima lista non c\'e\' niente da decidere (l\'errore risale)', () => {
  const calls = [];
  assert.throws(() => readPrepassCandidates((label) => {
    calls.push(label);
    throw new Error('HTTP 500');
  }), /500/);
  assert.deepEqual(calls, ['needs-human'], 'la seconda query non parte senza la prima');
});

test('030: con entrambe le letture le candidate sono l\'unione deduplicata', () => {
  const read = readPrepassCandidates((label) => (label === 'needs-human'
    ? [issue(1, 'needs-human'), issue(3, 'needs-human', 'automation-deferred')]
    : [issue(3, 'needs-human', 'automation-deferred'), issue(4, 'automation-deferred')]));
  assert.deepEqual(read.issues.map((i) => i.number), [1, 3, 4]);
  assert.equal(read.deferredUnreadable, false);
  assert.equal(read.deferredError, '');
});
