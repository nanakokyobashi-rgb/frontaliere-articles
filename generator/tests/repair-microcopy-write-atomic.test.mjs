// Il writer di repair-microcopy.mjs riscrive file gia' pubblicati sotto
// content/. Il contratto e' temp+rename: una SIGKILL puo' lasciare un temp,
// ma non puo' lasciare il target troncato.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..', '..');
const file = path.join(root, 'generator', 'scripts', 'repair-microcopy.mjs');
const source = fs.readFileSync(file, 'utf8');

function extractFunctionBody(text, signature) {
  const start = text.indexOf(signature);
  assert.ok(start >= 0, `atteso di trovare "${signature}" in ${file}`);
  const braceStart = text.indexOf('{', start);
  let depth = 0;
  for (let i = braceStart; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) return text.slice(braceStart + 1, i);
    }
  }
  throw new Error(`parentesi graffa di chiusura non trovata per "${signature}"`);
}

test('repair-microcopy commette ogni riscrittura con temp+rename e cleanup', () => {
  const body = extractFunctionBody(source, 'function writeAtomic(file, content) {');

  assert.match(body, /const tmp = `\$\{file\}\.\$\{process\.pid\}\.\$\{writeTmpSeq\+\+\}\.tmp`/);
  assert.match(body, /writeFileSync\(\s*tmp\s*,/);
  assert.match(body, /renameSync\(\s*tmp\s*,\s*file\s*\)/);
  assert.match(body, /catch[\s\S]{0,160}unlinkSync\(\s*tmp\s*\)/);
  assert.doesNotMatch(body, /writeFileSync\(\s*file\s*,/,
    'il target finale deve essere raggiunto solo da renameSync');
});

test('sweepFile usa il writer atomico quando applica le sostituzioni', () => {
  assert.match(source, /if \(fileChanges && !CHECK_ONLY\) writeAtomic\(abs, src\);/);
});
