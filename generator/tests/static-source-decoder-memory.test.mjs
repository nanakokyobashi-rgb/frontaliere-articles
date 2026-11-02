import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('decoded article fields stay within a bounded heap when retained together', () => {
  const moduleUrl = new URL('../../engine/shared/staticSourceAst.mjs', import.meta.url).href;
  // Retain all results before comparing: comparing each immediately can flatten
  // character-by-character cons strings and hide the corpus reader's OOM.
  const script = `
    import assert from 'node:assert/strict';
    const { decodeStaticString } = await import(${JSON.stringify(moduleUrl)});
    const raw = 'a'.repeat(1024 * 1024);
    const values = [];
    for (let i = 0; i < 8; i++) values.push(decodeStaticString(raw + i, "'"));
    for (let i = 0; i < 8; i++) assert.equal(values[i], raw + i);
  `;
  const result = spawnSync(process.execPath, [
    '--max-old-space-size=128', '--input-type=module', '-e', script,
  ], { encoding: 'utf8', timeout: 15_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
});
