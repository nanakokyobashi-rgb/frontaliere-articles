import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TESTS_WORKFLOW = readFileSync(path.join(ROOT, '.github/workflows/tests.yml'), 'utf8');
const ACTIONLINT_CONFIG = readFileSync(path.join(ROOT, '.github/actionlint.yaml'), 'utf8');

test('required PR check validates every workflow and ShellChecks changed workflow scripts', () => {
  assert.match(TESTS_WORKFLOW, /uses: actions\/setup-go@v6/);
  assert.match(TESTS_WORKFLOW, /go-version: '1\.26\.1'/);
  assert.match(TESTS_WORKFLOW, /go install github\.com\/rhysd\/actionlint\/cmd\/actionlint@v1\.7\.12/);
  assert.match(
    TESTS_WORKFLOW,
    /name: Lint GitHub Actions workflow syntax and expressions[\s\S]+?set -euo pipefail[\s\S]+?git ls-files -z -- '\.github\/workflows\/\*\.yml' '\.github\/workflows\/\*\.yaml' \| xargs -0 -r actionlint -shellcheck= -config-file \.github\/actionlint\.yaml/,
  );
  assert.match(
    TESTS_WORKFLOW,
    /name: ShellCheck changed GitHub Actions workflows[\s\S]+?if ! git diff --name-only -z "\$base\.\.\.HEAD"[\s\S]+?> "\$changed_workflows_file"; then[\s\S]+?::error::Impossibile calcolare la diff[\s\S]+?if \[ -f "\$workflow" \][\s\S]+?actionlint -config-file \.github\/actionlint\.yaml "\$\{changed_workflows\[@\]\}"/,
  );
  assert.match(TESTS_WORKFLOW, /PREFLIGHT_DISPATCH_BASE_REVISION: \$\{\{ inputs\.base_sha \}\}/);
  assert.match(
    TESTS_WORKFLOW,
    /- name: Setup isolated article source runtime\s+if: \$\{\{ !cancelled\(\) \}\}\s+uses: \.\/\.github\/actions\/setup-article-source-runtime/,
  );
  assert.equal((ACTIONLINT_CONFIG.match(/unexpected key "queue"/g) || []).length, 3);
  assert.match(ACTIONLINT_CONFIG, /\.github\/workflows\/translate-queue-recovery-watchdog\.yml:/);
});

test('ShellCheck on changed workflows runs without the global opt-out', () => {
  const start = TESTS_WORKFLOW.indexOf('- name: ShellCheck changed GitHub Actions workflows');
  assert.notEqual(start, -1);
  const end = TESTS_WORKFLOW.indexOf('\n      - name:', start + 1);
  const step = TESTS_WORKFLOW.slice(start, end === -1 ? undefined : end);
  assert.match(step, /actionlint -config-file \.github\/actionlint\.yaml/);
  assert.doesNotMatch(step, /-shellcheck=/);
});
