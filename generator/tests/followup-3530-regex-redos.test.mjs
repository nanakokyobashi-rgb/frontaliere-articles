import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const longBackslashRun = '\\'.repeat(40);

function assertMalformedLiteralFinishes(moduleUrl, expression, source) {
  const result = spawnSync(process.execPath, [
    '--input-type=module',
    '-e',
    `import { ${expression.split('(')[0] } } from ${JSON.stringify(moduleUrl)};
const result = ${expression.replace('SOURCE', JSON.stringify(source))};
if (result !== '') throw new Error('il literal senza terminatore non deve produrre un valore');`,
  ], { encoding: 'utf8', timeout: 5_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
}

test('#3530 extractBodyContent non esplode su un body non terminato con molti backslash', () => {
  const moduleUrl = new URL('../scripts/batch-add-faq-to-articles.mjs', import.meta.url).href;
  const source = `'blog.article.demo.body1': '${longBackslashRun}`;
  assertMalformedLiteralFinishes(moduleUrl, "extractBodyContent(SOURCE, 'demo')", source);
});

test('#3530 parseCrossingNames non esplode su un nome non terminato con molti backslash', () => {
  const moduleUrl = new URL('../scripts/lib/canton-hubs/blocks-border-wait.mjs', import.meta.url).href;
  const source = `{ name: '${longBackslashRun}`;
  assertMalformedLiteralFinishes(moduleUrl, 'parseCrossingNames(SOURCE).size === 0 ? \'\' : \'unexpected\'', source);
});
