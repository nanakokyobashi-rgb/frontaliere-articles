/**
 * The needs-human digest must fail when its recurrence comment is not
 * persisted. The shared reporter remains best-effort for its other callers;
 * the corpus-only strict CLI is the boundary used by recycle-stale-prs.yml.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PUBLISHER = path.join(ROOT, 'scripts/ci/publish-needs-human-digest.mjs');
const TITLE = 'needs-human: PR bloccate in attesa di revisione umana';

const FAKE_GH = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'issue' && args[1] === 'list') {
  process.stdout.write(JSON.stringify([{
    number: 42,
    title: process.env.DIGEST_TITLE,
    url: 'https://github.com/o/r/issues/42',
  }]));
  process.exit(0);
}
if (args[0] === 'issue' && args[1] === 'comment') {
  process.exit(process.env.FAKE_COMMENT_OK === '1' ? 0 : 1);
}
process.exit(0);
`;

function runPublisher(binDir, commentOk) {
  return spawnSync(process.execPath, [
    PUBLISHER,
    '--fail-on-write',
    '--title', TITLE,
    '--description', 'misura corrente',
    '--priority', '2',
    '--label', 'automation',
    '--workflow', 'Recycle stale PRs',
  ], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
      GH_REPO: 'o/r',
      DIGEST_TITLE: TITLE,
      FAKE_COMMENT_OK: commentOk ? '1' : '0',
      ENABLE_FAILURE_REPORT: 'true',
    },
  });
}

test('fail-on-write rialza persisted:false e lascia passare una recurrence persistita', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'needs-human-strict-'));
  try {
    const bin = path.join(temp, 'gh');
    fs.writeFileSync(bin, FAKE_GH, { mode: 0o755 });

    const failed = runPublisher(temp, false);
    assert.equal(failed.status, 1, failed.stderr);
    assert.match(failed.stderr, /write not persisted/);

    const succeeded = runPublisher(temp, true);
    assert.equal(succeeded.status, 0, succeeded.stderr);
    assert.match(succeeded.stdout, /digest write acknowledged/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
