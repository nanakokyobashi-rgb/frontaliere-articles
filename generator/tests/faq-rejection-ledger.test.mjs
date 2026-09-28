import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { loadFaqRejectionLedger } from '../scripts/fix-faq-locales.mjs';

function withTempDir(run) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'faq-rejection-ledger-'));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('un ledger FAQ malformato fallisce esplicitamente senza cambiarne i byte', () => {
  withTempDir((dir) => {
    const ledgerPath = path.join(dir, 'faq-locale-rejections.json');
    const original = Buffer.from('{"article/en": {"consecutive": 2},}\n');
    writeFileSync(ledgerPath, original);

    assert.throws(() => loadFaqRejectionLedger(ledgerPath), (error) => {
      assert.match(error.message, /Impossibile leggere il ledger FAQ/);
      assert.match(error.message, /JSON/);
      assert.ok(error.cause instanceof SyntaxError);
      return true;
    });
    assert.deepEqual(readFileSync(ledgerPath), original);
  });
});

test('un ledger FAQ non leggibile fallisce esplicitamente', () => {
  withTempDir((dir) => {
    const ledgerPath = path.join(dir, 'faq-locale-rejections.json');
    mkdirSync(ledgerPath);

    assert.throws(() => loadFaqRejectionLedger(ledgerPath), (error) => {
      assert.match(error.message, /Impossibile leggere il ledger FAQ/);
      assert.equal(error.cause.code, 'EISDIR');
      return true;
    });

    const brokenSymlink = path.join(dir, 'broken-ledger.json');
    symlinkSync(path.join(dir, 'missing-target.json'), brokenSymlink);
    assert.throws(() => loadFaqRejectionLedger(brokenSymlink), (error) => {
      assert.match(error.message, /Impossibile leggere il ledger FAQ/);
      assert.equal(error.cause.code, 'ENOENT');
      return true;
    });
  });
});

test('ledger FAQ valido e file assente mantengono il comportamento esistente', () => {
  withTempDir((dir) => {
    const ledgerPath = path.join(dir, 'faq-locale-rejections.json');
    const ledger = { 'frontaliere/article/en': { consecutive: 2, source: 'abc' } };
    writeFileSync(ledgerPath, JSON.stringify(ledger));

    assert.deepEqual(loadFaqRejectionLedger(ledgerPath), ledger);
    assert.deepEqual(loadFaqRejectionLedger(path.join(dir, 'missing.json')), {});
  });
});
