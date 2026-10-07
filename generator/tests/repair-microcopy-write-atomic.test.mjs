// I writer di bonifica riscrivono file gia' pubblicati sotto content/. Il
// contratto comune e' temp+rename: una SIGKILL puo' lasciare un temp, ma non
// puo' lasciare il target troncato.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..', '..');
const helper = fs.readFileSync(
  path.join(root, 'generator', 'scripts', 'lib', 'atomic-write-file.mjs'), 'utf8');
const writers = [
  'generator/scripts/repair-microcopy.mjs',
  'generator/scripts/repair-prompt-placeholders.mjs',
  'generator/scripts/repair-source-echo.mjs',
  'generator/scripts/repair-mangled-chars.mjs',
  'scripts/retire-article.mjs',
];

test('il writer condiviso commette ogni riscrittura con temp+rename e cleanup', () => {
  assert.match(helper, /const tmp = `\$\{filePath\}\.\$\{process\.pid\}\.\$\{tmpSeq\+\+\}\.tmp`/);
  assert.match(helper, /writeFileSync\(\s*tmp\s*,/);
  assert.match(helper, /renameSync\(\s*tmp\s*,\s*filePath\s*\)/);
  assert.match(helper, /catch[\s\S]{0,180}unlinkSync\(\s*tmp\s*\)/);
  assert.doesNotMatch(helper, /writeFileSync\(\s*filePath\s*,/,
    'il target finale deve essere raggiunto solo da renameSync');
});

test('tutti i writer della classe usano il writer atomico condiviso', () => {
  for (const relative of writers) {
    const source = fs.readFileSync(path.join(root, relative), 'utf8');
    assert.match(source, /writeFileAtomic\(/, `${relative}: manca writeFileAtomic`);
    assert.doesNotMatch(source, /\b(?:fs\.)?writeFileSync\(/,
      `${relative}: mantiene una scrittura diretta sul corpus`);
  }
});

test('sweepFile usa il writer atomico quando applica le sostituzioni', () => {
  const source = fs.readFileSync(
    path.join(root, 'generator', 'scripts', 'repair-microcopy.mjs'), 'utf8');
  assert.match(source, /if \(fileChanges && !CHECK_ONLY\) writeFileAtomic\(abs, src\);/);
});
