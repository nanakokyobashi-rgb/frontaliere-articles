import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// Misura lo scalar passato al runner, senza indentazione YAML. I commenti
// DENTRO run fanno parte del comando e contano anch'essi nel limite.
function runScalars(source) {
  const lines = source.split(/\r?\n/);
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const key = /^( *)run:\s*(.*)$/.exec(lines[i]);
    if (!key) continue;
    const scalar = /^[|>]([-+]?)(?:\s+#.*)?$/.exec(key[2]);
    if (!scalar) {
      blocks.push(key[2]);
      continue;
    }
    const body = [];
    while (i + 1 < lines.length) {
      const next = lines[i + 1];
      if (next.trim() && next.search(/\S/) <= key[1].length) break;
      body.push(next);
      i++;
    }
    const indent = body.find(line => line.trim())?.search(/\S/) ?? 0;
    const raw = body.map(line => line.slice(indent)).join('\n');
    const value = raw.replace(/\n+$/, '');
    blocks.push(scalar[1] === '+' ? raw + '\n' : value + (scalar[1] === '-' ? '' : '\n'));
  }
  return blocks;
}

for (const name of ['generate-article', 'generate-article-core']) {
  test(`${name}: ogni comando run rispetta il limite di avvio`, () => {
    const source = readFileSync(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), 'utf8');
    const blocks = runScalars(source);
    assert.ok(blocks.length >= 10, 'scansione dei comandi incompleta');
    assert.deepEqual(blocks.flatMap((value, index) => value.length > 21_000
      ? [`run #${index + 1}: ${value.length} caratteri`] : []), []);
  });
}

test('il contratto conta commenti, Unicode e comandi multipli dopo la normalizzazione YAML', () => {
  const oversized = '# ' + 'è'.repeat(21_000);
  const blocks = runScalars(`steps:\n  - name: primo\n    run: |\n      ${oversized}\n      echo ok\n  - name: secondo\n    run: |-\n      echo fine\n`);
  assert.equal(blocks.length, 2);
  assert.ok(blocks[0].length > 21_000);
  assert.equal(blocks[1], 'echo fine');
  assert.ok(runScalars('run: ' + 'x'.repeat(21_001))[0].length > 21_000);
  assert.equal(runScalars('run: |\n  ' + 'x'.repeat(20_999))[0].length, 21_000);
  assert.equal(runScalars('run: |\n  ' + 'x'.repeat(21_000))[0].length, 21_001);
});
