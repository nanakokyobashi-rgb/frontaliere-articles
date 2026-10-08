import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyDispatchOutcomes,
  markLedgerItemsAbsent,
  groupRepairCandidates,
  ledgerKey,
  markDispatched,
  mergeDegradedItems,
  parseDegradationLedger,
  removeHealthyItems,
  repairCandidates,
  renderDegradationLedger,
  releasedArticleFallbacks,
  retainDegradationLedger,
  upsertDegradationLedger,
} from '../../scripts/lib/article-image-degradation-ledger.mjs';

const item = (articleId, overrides = {}) => ({
  section: 'frontaliere',
  articleId,
  url: `https://frontaliereticino.ch/articoli-frontaliere/${articleId}/`,
  registryImage: `/images/blog/${articleId}.webp`,
  firstSeenAt: '2026-10-01T00:00:00.000Z',
  lastSeenAt: '2026-10-01T00:00:00.000Z',
  ...overrides,
});

test('il ledger nel body dell issue fa round-trip senza perdere la prosa', () => {
  const body = upsertDegradationLedger('## Stato\n- osservato', [item('zeta'), item('alfa')]);
  assert.match(body, /^## Stato/);
  const parsed = parseDegradationLedger(body);
  assert.equal(parsed.present, true);
  assert.deepEqual(parsed.items.map((entry) => entry.articleId), ['alfa', 'zeta']);
  assert.deepEqual(parseDegradationLedger(renderDegradationLedger(parsed.items)).items, parsed.items);
});

test('il degrado resta durevole, la pagina sana si rimuove e il cap raggruppa per sezione', () => {
  const merged = mergeDegradedItems([], [item('old'), { ...item('new'), section: 'svizzera' }], '2026-10-08T00:00:00.000Z');
  const ready = repairCandidates(merged, { readyKeys: [ledgerKey(item('old')), ledgerKey({ section: 'svizzera', articleId: 'new' })], cap: 1 });
  assert.deepEqual(ready.map((entry) => entry.articleId), ['old']);
  assert.deepEqual(groupRepairCandidates(ready).map((group) => [group.section, group.ids]), [['frontaliere', ['old']]]);
  const healthy = merged.filter((entry) => entry.articleId === 'old').map(ledgerKey);
  assert.deepEqual(removeHealthyItems(merged, healthy).map((entry) => entry.articleId), ['new']);
});

test('tre esiti terminali falliti marcano l articolo exhausted e non lo ridispatchano', () => {
  let entries = [item('retry')];
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    entries = markDispatched(entries, [{ key: ledgerKey(entries[0]), runId: String(attempt) }]);
    entries = applyDispatchOutcomes(entries, {
      [ledgerKey(entries[0])]: { status: 'completed', conclusion: 'failure' },
    }).items;
  }
  assert.equal(entries[0].attempts, 3);
  assert.equal(entries[0].status, 'exhausted');
  assert.deepEqual(repairCandidates(entries, { readyKeys: [ledgerKey(entries[0])] }), []);
});

test('gli orfani hanno retry bounded e i terminali non consumano la finestra di pagine', () => {
  let entries = [item('gone')];
  entries = markLedgerItemsAbsent(entries, [ledgerKey(entries[0])], '2026-10-08T00:00:00.000Z');
  assert.equal(entries[0].status, 'orphaned');
  entries = markLedgerItemsAbsent(entries, [ledgerKey(entries[0])], '2026-10-09T00:00:00.000Z');
  entries = markLedgerItemsAbsent(entries, [ledgerKey(entries[0])], '2026-10-10T00:00:00.000Z');
  assert.equal(entries[0].status, 'retired');
  assert.deepEqual(repairCandidates(entries, { readyKeys: [ledgerKey(entries[0])] }), []);

  const expired = retainDegradationLedger([
    item('exhausted', { status: 'exhausted', lastSeenAt: '2026-09-01T00:00:00.000Z' }),
  ], { nowMs: Date.parse('2026-10-08T00:00:00.000Z') });
  assert.deepEqual(expired, []);
});

test('la mappa fallback conserva pending/exhausted e scarta i ritirati', () => {
  assert.deepEqual(
    releasedArticleFallbacks([
      item('zeta', { status: 'exhausted' }),
      item('alfa', { status: 'retired' }),
    ]),
    [{ section: 'frontaliere', articleId: 'zeta', declaredImage: '/images/blog/zeta.webp' }],
  );
});
