/**
 * scripts/lib/merge-counter-conflict.mjs — il merge a tre vie dei contatori
 * (`--merge-counter` di rebase-onto-remote.sh, D18). I casi git veri stanno in
 * rebase-onto-remote.test.mjs; qui la regola, lato per lato.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mergeCounterDocuments, parseCounterSpec } from '../../scripts/lib/merge-counter-conflict.mjs';

const doc = (o) => `${JSON.stringify(o, null, 2)}\n`;

test('upstream + incremento del commit rigiocato, gli altri campi da upstream', () => {
  const r = mergeCounterDocuments({
    base: doc({ version: 1, runCounter: 10, currentQuota: 80 }),
    upstream: doc({ version: 1, runCounter: 13, currentQuota: 70 }),
    replayed: doc({ version: 1, runCounter: 11, currentQuota: 80 }),
    field: 'runCounter',
  });
  assert.equal(r.ok, true);
  assert.equal(r.value, 14);
  // Stesso formato di saveQuotaState / persist*Counter, ordine delle chiavi di upstream.
  assert.equal(r.merged, doc({ version: 1, runCounter: 14, currentQuota: 70 }));
});

test('senza base comune (add/add) si tiene il massimo: mai contato due volte', () => {
  const r = mergeCounterDocuments({ base: null, upstream: doc({ count: 4 }), replayed: doc({ count: 7 }), field: 'count' });
  assert.equal(r.ok, true);
  assert.equal(r.value, 7);
});

test('si rifiuta di fondere cio\' che non sa dimostrare', () => {
  const base = doc({ count: 10 });
  const cases = [
    { upstream: '{ rotto', replayed: doc({ count: 11 }), why: /upstream: JSON illeggibile/ },
    { upstream: doc({ count: 12 }), replayed: doc({ count: '11' }), why: /commit rigiocato: il campo 'count'/ },
    { upstream: doc({ count: 12 }), replayed: doc({ count: 9 }), why: /decrementato/ },
    { upstream: doc([1]), replayed: doc({ count: 11 }), why: /non e' un oggetto/ },
  ];
  for (const c of cases) {
    const r = mergeCounterDocuments({ base, upstream: c.upstream, replayed: c.replayed, field: 'count' });
    assert.equal(r.ok, false, JSON.stringify(c));
    assert.match(r.reason, c.why);
  }
});

test('la spec e\' <path>:<campo>, divisa sull\'ultimo due punti', () => {
  assert.deepEqual(parseCounterSpec('data/quota-state.json:runCounter'), { path: 'data/quota-state.json', field: 'runCounter' });
  assert.equal(parseCounterSpec('data/quota-state.json'), null);
  assert.equal(parseCounterSpec('data/quota-state.json:'), null);
  assert.equal(parseCounterSpec(':count'), null);
});
