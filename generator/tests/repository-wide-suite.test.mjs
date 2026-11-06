import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TESTS_WORKFLOW = path.join(ROOT, '.github/workflows/tests.yml');

function requiredCheckoutBlock() {
  const workflow = fs.readFileSync(TESTS_WORKFLOW, 'utf8');
  const start = workflow.indexOf('      - uses: actions/checkout@v7');
  const end = workflow.indexOf('\n      - uses: actions/setup-node@v7', start);
  assert.notEqual(start, -1, 'checkout del job tests non trovato');
  assert.ok(end > start, 'checkout del job tests non delimitato da setup-node');
  return workflow.slice(start, end);
}

test('il check richiesto usa storia e working tree completi', () => {
  const checkout = requiredCheckoutBlock();
  assert.match(checkout, /^\s+fetch-depth:\s*0\s*$/mu);
  assert.doesNotMatch(
    checkout,
    /^\s+(?:filter|sparse-checkout|sparse-checkout-cone-mode):/mu,
    'tests.yml non deve omettere blob o alberi richiesti dalla suite repository-wide',
  );
});

test('la suite vede tutti i fixture tracciati di content, data e public', () => {
  for (const directory of ['content', 'data', 'public']) {
    const tracked = execFileSync('git', ['ls-files', '-z', '--', directory], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    }).split('\0').filter(Boolean);
    assert.ok(tracked.length > 0, `${directory}/ non contiene fixture tracciati`);

    const missing = tracked.filter((relative) => !fs.existsSync(path.join(ROOT, relative)));
    assert.deepEqual(
      missing,
      [],
      `${directory}/ non e' materializzata per intero (${missing.length} file tracciati assenti)`,
    );
  }
});
