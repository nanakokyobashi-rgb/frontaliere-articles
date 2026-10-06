/**
 * Ratchet dello stock #2325 e prova del piano read-only.
 *
 * In un worktree sparse il corpus puo' essere passato con
 * KEYFACTS_HEADING_ROOT=/percorso/del/clone-di-misura; in CI il default e' il
 * checkout completo del repository.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  STOCK_BASELINE,
  planKeyFactsHeadingInsertion,
  scanKeyFactsHeadingStock,
} from '../scripts/scan-keyfacts-heading-stock.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCANNER_PATH = path.join(ROOT, 'generator/scripts/scan-keyfacts-heading-stock.mjs');
const CORPUS_ROOT = process.env.KEYFACTS_HEADING_ROOT || ROOT;

test('il piano read-only aggiunge esattamente il solo heading', () => {
  const body = [
    '## In breve',
    '- Un fatto',
    '- Un altro fatto',
    '',
    '',
    '- **Cosa**: un fatto source-backed.',
    '- **Quando**: 6 ottobre 2026.',
  ].join('\n');

  const plan = planKeyFactsHeadingInsertion(body, 'it');
  assert.deepEqual(plan?.diff, {
    exact: true,
    addedLines: ['## Fatti chiave'],
    removedLines: [],
    changedLines: 1,
  });
  assert.equal(plan?.bulletCount, 2);
  assert.equal(body.includes('## Fatti chiave'), false, 'il piano non deve mutare il body');
});

test('il ratchet dello stock non consente nuovi file orfani', () => {
  const report = scanKeyFactsHeadingStock(CORPUS_ROOT);
  assert.ok(report.filesScanned > 0, 'il ratchet non puo\' passare senza leggere file italiani');
  assert.ok(
    report.total <= STOCK_BASELINE.total,
    `stock #2325 cresciuto: ${report.total} > ${STOCK_BASELINE.total}`,
  );
  for (const [directory, baseline] of Object.entries(STOCK_BASELINE.byTree)) {
    assert.ok(
      report.byTree[directory] <= baseline,
      `${directory}: stock cresciuto (${report.byTree[directory]} > ${baseline})`,
    );
  }
  assert.equal(
    report.total,
    Object.values(report.byTree).reduce((sum, count) => sum + count, 0),
  );
  assert.ok(report.entries.every((entry) => entry.diff.exact && entry.diff.changedLines === 1));
});

test('lo scanner e\' read-only e non espone un ramo apply', () => {
  const source = fs.readFileSync(SCANNER_PATH, 'utf8');
  assert.doesNotMatch(source, /(?:writeFileSync|renameSync|unlinkSync|rmSync)/);
  assert.doesNotMatch(source, /--apply/);
});
