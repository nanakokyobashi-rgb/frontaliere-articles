/**
 * Il gate generator-ci deve spendere REST solo quando il diff locale dimostra
 * che il workflow path-scoped si applica. Una lettura `pulls/<n>/files` per
 * ogni PR non-generator era il consumo inutile che ha riempito il bucket del
 * GITHUB_TOKEN (#2514).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { localChangedFiles } from '../../scripts/ci/generator-ci-gate.mjs';

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

test('una SHA incompleta non puo\' diventare una diff vuota verde', () => {
  assert.throws(
    () => localChangedFiles({ baseSha: 'main', headSha: HEAD_SHA, exec: () => '' }),
    /SHA completi/,
  );
});
