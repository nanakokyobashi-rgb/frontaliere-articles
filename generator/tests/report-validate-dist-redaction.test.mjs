import assert from 'node:assert/strict';
import test from 'node:test';

import { extractStepExcerpt } from '../../scripts/ci/report-validate-dist-failure.mjs';
import { redactWorkflowPaths } from '../../scripts/lib/workflow-scope-detect.mjs';

test('extractStepExcerpt uses the canonical workflow-path redactor', () => {
  const log = [
    'Uses: owner/repo/.github/workflows/publish.yml@main',
    'Prose mentions .github/workflows/publish.ymlx as a non-path token',
    '##[error]step failed',
  ].join('\n');

  const excerpt = extractStepExcerpt(log);

  assert.equal(excerpt, redactWorkflowPaths(log));
  assert.match(excerpt, /«workflow publish\.yml»/);
  assert.match(excerpt, /\.github\/workflows\/publish\.ymlx/);
  assert.doesNotMatch(excerpt, /«workflow publish\.yml»x/);
});
