import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WORKFLOWS = [
  '.github/workflows/generate-article-core.yml',
  '.github/workflows/generate-article.yml',
];

for (const relativePath of WORKFLOWS) {
  test(`${relativePath}: admission API bounded`, () => {
    const source = readFileSync(path.join(ROOT, relativePath), 'utf8');
    assert.match(source, /api_timeout_seconds=60/);
    assert.match(
      source,
      /timeout --kill-after=0s "\$\{api_timeout_seconds\}s" gh api "\$@"/,
    );
    assert.doesNotMatch(source, /^\s+gh api\b/m, 'nessuna chiamata deve bypassare il wrapper');
    assert.equal(
      (source.match(/gh_api_timeout(?:\s|\()/g) || []).length,
      4,
      'tre chiamate piu\u0300 la definizione devono restare protette',
    );
  });
}
