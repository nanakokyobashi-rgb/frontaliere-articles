import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WORKFLOW = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'crawler-group-04.yml'), 'utf8');

test('il reporter delle issue crawler è parte del verdetto aggregato', () => {
  assert.match(WORKFLOW, /reportCrawlerAlert\(\) \{/u);
  assert.match(WORKFLOW, /reportCrawlerAlert[\s\S]*?github-issue-creator\.mjs/u);
  assert.match(WORKFLOW, /if ! reportCrawlerAlert[\s\S]*?alert_failure_count=\$\(\(alert_failure_count \+ 1\)\)/u);
  assert.match(WORKFLOW, /alert_failure_count=\$alert_failure_count/u);
  assert.match(WORKFLOW, /CRAWLER_ALERT_FAILURES:[\s\S]*?alert_failure_count/u);
  assert.match(WORKFLOW, /if \[ "\$alert_failures" -gt 0 \]; then[\s\S]*?refusing a green group verdict/u);
});
