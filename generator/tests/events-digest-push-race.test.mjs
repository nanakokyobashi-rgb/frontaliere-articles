/**
 * Push-race contract for the multi-canton events digest.
 *
 * The producer writes shared canton registries. A concurrent article push can
 * therefore make the already-generated digest commit impossible to rebase.
 * The recovery must rebuild from the fetched tip, not choose one side of a
 * conflict and silently drop either article.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKFLOW = path.join(HERE, '..', '..', '.github', 'workflows', 'refresh-events-digest.yml');
const source = fs.readFileSync(WORKFLOW, 'utf8');
const start = source.indexOf('- name: Commit and push');
const end = source.indexOf('- name: Summary', start);
assert.ok(start >= 0 && end > start, 'commit step must remain bounded by the workflow summary');
const commitStep = source.slice(start, end);

test('the digest push race rebuilds on the fetched main tip', () => {
  assert.match(commitStep, /for attempt in 1 2 3; do/);
  assert.match(commitStep, /git fetch "\$REMOTE" "\$TARGET"/);
  assert.match(commitStep, /git reset --hard FETCH_HEAD/);
  assert.match(commitStep, /regenerate_digest_batch\(\)/);
  assert.match(commitStep, /node generator\/scripts\/generate-events-digest-article\.mjs \\\n+\s+--section="\$SECTION" --canton/);
  assert.match(commitStep, /node --test \\\n+\s+generator\/tests\/article-fabrication-guard\.test\.mjs \\\n+\s+generator\/tests\/prompt-placeholder-guard\.test\.mjs/);
  assert.match(commitStep, /node scripts\/ci\/check-blog-locale-completeness\.mjs/);
  assert.match(commitStep, /regenerate_digest_batch\(\)[\s\S]*?stage_digest_outputs/);
  assert.match(commitStep, /echo "attempts=\$attempt" >> "\$GITHUB_OUTPUT"/);
  assert.match(commitStep, /echo "remote_sha=\$\(git rev-parse HEAD\)" >> "\$GITHUB_OUTPUT"/);
  assert.match(source, /Push attempts: \$\{\{ steps\.commit\.outputs\.attempts \}\}/);
  assert.match(commitStep, /GITHUB_PAT_NANAKO/);
  assert.doesNotMatch(commitStep, /\$\{GITHUB_PAT:-\}/);
  assert.doesNotMatch(commitStep, /git pull --rebase/);
  assert.doesNotMatch(commitStep, /git push[^\n]*--force/);
});
