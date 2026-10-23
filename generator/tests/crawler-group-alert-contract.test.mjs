import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WORKFLOW = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'crawler-group-04.yml'), 'utf8');

test('il fallimento del reporter watchdog entra nel verdetto aggregato', () => {
  assert.doesNotMatch(WORKFLOW, /reportCrawlerAlert\(\) \{/u);
  assert.match(WORKFLOW, /if ! node scripts\/lib\/github-issue-creator\.mjs[\s\S]*?failure_count=\$\(\(failure_count \+ 1\)\)/u);
  assert.match(WORKFLOW, /the watchdog-timeout issue could not be filed; failing the group verdict/u);
  assert.match(WORKFLOW, /\*\*Summary:\*\* \$success_count succeeded, \$failure_count failed, \$missing_count missing, \$systemic_count systemic\./u);
  assert.match(WORKFLOW, /if \[ "\$failure_count" -gt 0 \] \|\| \[ "\$missing_count" -gt 0 \] \|\| \[ "\$systemic_count" -gt 0 \]; then/u);
  assert.doesNotMatch(WORKFLOW, /alert_failure_count|CRAWLER_ALERT_FAILURES|alert_failures/u);
});
