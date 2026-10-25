import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const ACTION = readFileSync(new URL('../../.github/actions/claude-codex-fallback/action.yml', import.meta.url), 'utf8');

test('trusted Node archive download has connect and total deadlines', () => {
  const start = ACTION.indexOf('/usr/bin/curl --fail --silent --show-error --location --proto');
  assert.ok(start >= 0);
  const end = ACTION.indexOf('\n        archive_sha256=', start);
  assert.ok(end > start);
  const download = ACTION.slice(start, end);
  assert.match(download, /--connect-timeout 10/);
  assert.match(download, /--max-time 180/);
});
