import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const uploader = resolve('scripts/lib/upload-cdn-file.sh');

function writeExecutable(path, source) {
  writeFileSync(path, source);
  chmodSync(path, 0o755);
}

function setup(dateOutput) {
  const dir = mkdtempSync(join(tmpdir(), 'cdn-recovery-timestamp-'));
  const binDir = join(dir, 'bin');
  mkdirSync(binDir);
  const eventsPath = join(dir, 'events.log');
  const localFile = join(dir, 'cover.webp');
  writeFileSync(localFile, 'test image bytes');

  writeExecutable(join(binDir, 'node'), `#!/bin/sh
case "$1" in
  */r2-image-namespace-lock.mjs)
    action="$2"
    printf '%s\\n' "$action" >> "$LEASE_TEST_EVENTS"
    case "$action" in
      acquire) printf '%s\\n' '{"version":1,"leases":[{"namespace":"blog","owner":"test-owner","leaseId":"test-lease","acquiredAt":1000000,"expiresAt":9999999999999}]}' ;;
      verify|release) exit 0 ;;
      *) exit 90 ;;
    esac
    ;;
  *) exit 91 ;;
esac
`);
  writeExecutable(join(binDir, 'rclone'), `#!/bin/sh
printf 'copy\\n' >> "$LEASE_TEST_EVENTS"
`);
  writeExecutable(join(binDir, 'date'), `#!/bin/sh
printf '%s\\n' ${JSON.stringify(dateOutput)}
`);
  writeExecutable(join(binDir, 'timeout'), `#!/bin/sh
if [ "$1" = "-k" ]; then shift 2; fi
shift
exec "$@"
`);

  return {
    dir,
    eventsPath,
    localFile,
    env: {
      PATH: `${binDir}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      LEASE_TEST_EVENTS: eventsPath,
      RUNNER_TEMP: dir,
      R2_ACCESS_KEY_ID: 'test-access',
      R2_SECRET_ACCESS_KEY: 'test-secret',
      R2_S3_ENDPOINT: 'https://example.invalid',
      R2_BUCKET: 'test-bucket',
      R2_TIMEOUT_OBJECT_S: '5',
    },
  };
}

function events(fixture) {
  try {
    return readFileSync(fixture.eventsPath, 'utf8').trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

test('rejects non-decimal date output before creating recovery JSON', () => {
  const fixture = setup('not-a-timestamp');
  try {
    const output = execFileSync('bash', [uploader, fixture.localFile, 'images/blog/article/hero.webp'], {
      encoding: 'utf8',
      env: fixture.env,
    });

    assert.match(output, /recovery timestamp.*not a positive decimal/u);
    assert.deepEqual(events(fixture), []);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});
