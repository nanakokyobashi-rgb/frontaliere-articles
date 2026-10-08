/**
 * Il gate generator-ci deve spendere REST solo quando il diff locale dimostra
 * che il workflow path-scoped si applica. Una lettura `pulls/<n>/files` per
 * ogni PR non-generator era il consumo inutile che ha riempito il bucket del
 * GITHUB_TOKEN (#2514).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { localChangedFiles } from '../../scripts/ci/generator-ci-gate.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const GATE_SCRIPT = path.join(ROOT, 'scripts/ci/generator-ci-gate.mjs');
const BASE_SHA = 'b'.repeat(40);
const HEAD_SHA = 'a'.repeat(40);

test('localChangedFiles usa una diff NUL-safe senza chiamare GitHub', () => {
  const calls = [];
  const files = localChangedFiles({
    baseSha: BASE_SHA,
    headSha: HEAD_SHA,
    exec: (bin, args, options) => {
      calls.push({ bin, args, options });
      return 'content/it/article.mdx\0docs/nota\ncon newline.md\0';
    },
  });

  assert.deepEqual(files, ['content/it/article.mdx', 'docs/nota\ncon newline.md']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].bin, 'git');
  assert.deepEqual(calls[0].args, [
    'diff', '--no-ext-diff', '--no-renames', '--name-only', '-z', `${BASE_SHA}...${HEAD_SHA}`, '--',
  ]);
});

test('una PR fuori scope termina senza invocare gh', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'generator-ci-local-scope-'));
  const bin = path.join(dir, 'bin');
  mkdirSync(bin);
  const fakeGit = path.join(bin, 'git');
  const fakeGh = path.join(bin, 'gh');
  writeFileSync(fakeGit, '#!/usr/bin/env node\nprocess.stdout.write("content/article.mdx\\0dist/api/manifest.json\\0");\n');
  writeFileSync(fakeGh, '#!/usr/bin/env node\nprocess.stderr.write("gh should not be called\\n");\nprocess.exit(42);\n');
  chmodSync(fakeGit, 0o755);
  chmodSync(fakeGh, 0o755);

  try {
    const result = spawnSync(process.execPath, [GATE_SCRIPT], {
      encoding: 'utf8',
      timeout: 2_000,
      env: {
        ...process.env,
        PATH: `${bin}${path.delimiter}${process.env.PATH || ''}`,
        GITHUB_REPOSITORY: 'nanakokyobashi-rgb/frontaliere-articles',
        PR_NUMBER: '2514',
        PR_BASE_SHA: BASE_SHA,
        HEAD_SHA,
        GENERATOR_CI_GATE_TIMEOUT_MS: '1',
      },
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /non tocca i path di generator-ci/);
    assert.doesNotMatch(result.stderr, /gh should not be called/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('una SHA incompleta non puo\' diventare una diff vuota verde', () => {
  assert.throws(
    () => localChangedFiles({ baseSha: 'main', headSha: HEAD_SHA, exec: () => '' }),
    /SHA completi/,
  );
});
