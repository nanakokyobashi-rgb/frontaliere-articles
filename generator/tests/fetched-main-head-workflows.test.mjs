import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function readWorkflow(name) {
  return fs.readFileSync(path.join(ROOT, '.github', 'workflows', name), 'utf8');
}

test('auto-live bases its generated branch on the exact fetched main commit', () => {
  const workflow = readWorkflow('auto-live-canton-sections.yml');
  assert.match(
    workflow,
    /git fetch --no-tags origin main\s+(?:#[^\n]*\n\s+)*main_head="\$\(git rev-parse FETCH_HEAD\)"\s+git checkout -B "\$branch" "\$main_head"/u,
  );
  assert.doesNotMatch(workflow, /git checkout -B "\$branch" origin\/main/u);
});

test('cover queue retries rebase and recover onto the commit returned by fetch', () => {
  const workflow = readWorkflow('publish-api.yml');
  assert.match(
    workflow,
    /git -c "http\.extraheader=AUTHORIZATION: basic \$auth_header" fetch --no-tags origin main\s+(?:#[^\n]*\n\s+)*main_head="\$\(git rev-parse FETCH_HEAD\)"[\s\S]*?git rebase "\$main_head"[\s\S]*?git reset --hard "\$main_head"/u,
  );
});

test('Bing corrections pin main before fetching the existing producer branch', () => {
  const workflow = readWorkflow('bing-seo-loop.yml');
  assert.match(
    workflow,
    /git fetch origin main\s+(?:#[^\n]*\n\s+)*main_head="\$\(git rev-parse FETCH_HEAD\)"[\s\S]*?git fetch origin "\$branch"[\s\S]*?git rebase "\$main_head"/u,
  );
  assert.match(workflow, /git switch --create "\$branch" "\$main_head"/u);
  assert.doesNotMatch(workflow, /git rebase origin\/main/u);
});
