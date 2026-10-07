/**
 * The registration writer must roll back every target when a later target
 * fails.  A per-file atomic rename is not enough: the registry must not remain
 * ahead of SEO after an error between the two writes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  restoreRegistrationTargets,
  snapshotRegistrationTargets,
} from '../scripts/lib/register-lock.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CREATE_ARTICLE = path.join(ROOT, 'generator', 'scripts', 'create-article.mjs');

function sandbox() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'register-transaction-'));
}

test('rollback atomico: un errore dopo il registry non lascia il registry senza SEO', () => {
  const root = sandbox();
  const registry = path.join(root, 'registry.ts');
  const seo = path.join(root, 'seo.ts');
  const body = path.join(root, 'body', 'article.ts');
  fs.mkdirSync(path.dirname(registry), { recursive: true });
  fs.writeFileSync(registry, 'registry-before\n', 'utf8');
  fs.writeFileSync(seo, 'seo-before\n', 'utf8');

  const targets = [
    { label: 'registry.ts', absPath: registry },
    { label: 'seo.ts', absPath: seo },
    { label: 'body/article.ts', absPath: body },
  ];
  const snapshot = snapshotRegistrationTargets(targets);

  fs.writeFileSync(registry, 'registry-after\n', 'utf8');
  assert.throws(() => {
    throw new Error('errore simulato dopo il registry e prima del SEO');
  }, /errore simulato/);

  restoreRegistrationTargets(snapshot, {
    writeFile: (target, content) => {
      fs.mkdirSync(path.dirname(target.absPath), { recursive: true });
      fs.writeFileSync(target.absPath, content, 'utf8');
    },
    removeFile: (target) => fs.rmSync(target.absPath, { force: true }),
  });

  assert.equal(fs.readFileSync(registry, 'utf8'), 'registry-before\n');
  assert.equal(fs.readFileSync(seo, 'utf8'), 'seo-before\n');
  assert.equal(fs.existsSync(body), false, 'il body nuovo deve essere rimosso dal rollback');
});

test('il writer reale aggancia snapshot, rollback e lock alla stessa transazione', () => {
  const source = fs.readFileSync(CREATE_ARTICLE, 'utf8');
  assert.match(source, /snapshotRegistrationTargets\(registerLockTargets\(data\.id\)\)/);
  assert.match(source, /restoreRegistrationTargets\(registrationSnapshot/);
  assert.match(source, /catch \(error\) \{/);
  assert.match(source, /endRegisterLock\(\);/);
});
