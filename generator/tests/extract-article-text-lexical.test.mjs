import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SOURCE_PATH = path.join(ROOT, 'generator', 'scripts', 'lib', 'extract-article-text.mjs');
const SOURCE = fs.readFileSync(SOURCE_PATH, 'utf8');

function loadNoscriptScanner() {
  const start = SOURCE.indexOf('const NOSCRIPT_END_TAG_RE =');
  const end = SOURCE.indexOf('\nfunction findReliableNoscriptTailBoundary', start);
  assert.notEqual(start, -1, 'costante del boundary noscript non trovata');
  assert.ok(end > start, 'fine dello scanner noscript non trovata');
  return new Function(`${SOURCE.slice(start, end)}\nreturn findNoscriptEndTagOutsideLexicalState;`)();
}

const findNoscriptEndTagOutsideLexicalState = loadNoscriptScanner();

test('break e continue senza semicolon non fanno ereditare un label attraverso }', () => {
  for (const keyword of ['break', 'continue']) {
    const markup = `while (x) { ${keyword}}foo\n/ 2 </noscript>`;
    const expectedEnd = markup.indexOf('</noscript>') + '</noscript>'.length;
    assert.equal(
      findNoscriptEndTagOutsideLexicalState(markup, 0),
      expectedEnd,
      `${keyword}: la divisione dopo l’identificatore non deve diventare regexp`,
    );
  }
});
