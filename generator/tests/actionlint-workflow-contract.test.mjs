import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TESTS_WORKFLOW = readFileSync(path.join(ROOT, '.github/workflows/tests.yml'), 'utf8');
const ACTIONLINT_CONFIG = readFileSync(path.join(ROOT, '.github/actionlint.yaml'), 'utf8');

test('required PR check installs pinned actionlint and validates every tracked workflow', () => {
  assert.match(TESTS_WORKFLOW, /uses: actions\/setup-go@v6/);
  assert.match(TESTS_WORKFLOW, /go-version: '1\.26\.1'/);
  assert.match(TESTS_WORKFLOW, /go install github\.com\/rhysd\/actionlint\/cmd\/actionlint@v1\.7\.12/);
  assert.match(
    TESTS_WORKFLOW,
    /git ls-files -z -- '\.github\/workflows\/\*\.yml' '\.github\/workflows\/\*\.yaml' \| xargs -0 -r actionlint -config-file \.github\/actionlint\.yaml/,
  );
  assert.equal((ACTIONLINT_CONFIG.match(/unexpected key "queue"/g) || []).length, 3);
  assert.match(ACTIONLINT_CONFIG, /\.github\/workflows\/translate-queue-recovery-watchdog\.yml:/);
});
