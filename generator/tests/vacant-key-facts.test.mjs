/**
 * Regression gate for the historical empty key-fact rows tracked by #1057.
 *
 * This is intentionally a corpus observer, not a generator fixture: the
 * published body is the source of truth and a future cleanup must not replace
 * a missing fact with an invented value.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanCorpus } from '../scripts/scan-vacuous-key-facts.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('#1057: nessuna riga di fatto chiave vacua resta nei corpi pubblicati', () => {
  const report = scanCorpus(ROOT);
  assert.ok(report.fieldsScanned > 1000, 'lo scan non sta leggendo il corpus dei corpi');
  assert.deepEqual(report.files, [], 'un fatto mancante non va sostituito con un placeholder');
  assert.deepEqual(report.articles, []);
  assert.deepEqual(report.fileSummaries, []);
  assert.equal(report.hits.length, 0);
  assert.deepEqual(
    Object.fromEntries(Object.entries(report.byLocale).map(([locale, value]) => [locale, {
      files: value.files.length,
      articles: value.articles.length,
      hits: value.hits,
    }])),
    {
      it: { files: 0, articles: 0, hits: 0 },
      en: { files: 0, articles: 0, hits: 0 },
      de: { files: 0, articles: 0, hits: 0 },
      fr: { files: 0, articles: 0, hits: 0 },
    },
  );
});
