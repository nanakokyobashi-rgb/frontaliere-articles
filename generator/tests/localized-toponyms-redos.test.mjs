import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const root = new URL('../../', import.meta.url);

// Run adversarial input out of process: a synchronous regex can otherwise
// wedge node:test indefinitely, including its own timeout callback.
for (const [file, constant, prefix, suffix, expected] of [
  ['generator/tests/localized-toponyms.test.mjs', 'ENTRY_RE', "'blog.article.demo.body1': '", "',", 4],
  ['generator/scripts/repair-localized-toponyms.mjs', 'ENTRY_RE', "'blog.article.demo.body1': '", "',", 4],
  ['generator/scripts/repair-localized-toponyms.mjs', 'SLUG_PROPERTY_RE', "en: '", "'", 3],
]) {
  test(`${file} ${constant}: escaped text and missing terminator finish in bounded time`, () => {
    const source = readFileSync(new URL(file, root), 'utf8');
    const declaration = source.split('\n').find((line) => line.startsWith(`const ${constant} = `));
    assert.ok(declaration);
    const raw = String.raw`L\'articolo \n \"test\" `.repeat(100);
    const script = `
      const assert = require('node:assert/strict');
      ${declaration}
      const re = ${constant};
      const valid = ${JSON.stringify(prefix + raw + suffix)};
      const result = [...valid.matchAll(re)];
      assert.equal(result.length, 1);
      assert.equal(result[0][${expected}], ${JSON.stringify(raw)});
      assert.equal([...${JSON.stringify(prefix + raw)}.matchAll(re)].length, 0);
    `;
    const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 3000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
  });
}

test('article projection rejects an unterminated escaped field without hanging', () => {
  const module = new URL('generator/scripts/lib/localized-toponyms.mjs', root).href;
  const raw = String.raw`L\'articolo \n \"test\" `.repeat(100);
  const source = "'blog.article.demo.body1': '" + raw;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { extractArticleProjectionText } from ${JSON.stringify(module)};
    assert.equal(extractArticleProjectionText(${JSON.stringify(source)}, 'demo'), '');
    assert.match(extractArticleProjectionText(${JSON.stringify(source + "'")}, 'demo'), /articolo/);
  `], { encoding: 'utf8', timeout: 3000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
});
