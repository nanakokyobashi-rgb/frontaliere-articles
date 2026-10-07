import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const workflow = fs.readFileSync(new URL('../../.github/workflows/publish-api.yml', import.meta.url), 'utf8');
const marker = '      - name: Publish governed blog cover bytes before Pages deploy';
const start = workflow.indexOf(marker);
const end = workflow.indexOf('\n      - name:', start + marker.length);
const step = start >= 0 && end >= 0 ? workflow.slice(start, end) : '';

test('publish-api uploads changed hero and thumbnail bytes from public-only cover PRs', () => {
  assert.notEqual(start, -1, 'cover sync step is present');
  assert.match(step, /git diff --name-only --diff-filter=AMRC --find-renames --find-copies/);
  assert.match(step, /git cat-file -e "\$\{BEFORE\}\^\{commit\}"/);
  assert.match(step, /REF: \$\{\{ github\.ref \}\}/);
  assert.match(step, /refs\/heads\/main/);
  assert.match(step, /public\/images\/blog\/\*\.webp/);
  assert.match(step, /public\/images\/blog\/thumbnails\/\*\.webp/);
  assert.match(step, /data\/blog-cover-cdn-sync-queue\.json/);
  assert.match(step, /scripts\/lib\/upload-cdn-file\.sh/);
  assert.match(step, /https:\/\/cdn\.frontaliereticino\.ch\/\$key/);
  assert.match(step, /scripts\/cf-purge-cache\.mjs/);
  assert.match(step, /push origin HEAD:main/);
  assert.match(step, /GITHUB_PAT_NANAKO is required to persist the cover sync queue/);
  assert.match(step, /http\.https:\/\/github\.com\/.extraheader/);
  assert.match(step, /rebuild_manifest_from_queue/);
  assert.match(step, /rebase conflict/);
  assert.match(step, /github\.event_name == 'schedule'/);
  assert.match(step, /github\.event_name == 'workflow_dispatch'/);
  assert.doesNotMatch(step, /continue-on-error/);
});
