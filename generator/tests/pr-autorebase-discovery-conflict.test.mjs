import { describe, it } from 'node:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { strict as assert } from 'node:assert';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MAX_PER_RUN,
  classifyMergeTreeStatus,
  decideConflictScan,
  discoverOpenPullRequests,
  parsePaginatedPullRequests,
  preparePullRequestSweep,
} from '../../scripts/ci/pr-autorebase.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function headSha(number) {
  return number.toString(16).padStart(2, '0').slice(-2).repeat(20);
}

function apiPullRequest(number, draft = false) {
  return {
    number,
    draft,
    head: { ref: `fix/${number}`, sha: headSha(number) },
    labels: number % 2 === 0 ? [{ name: 'stale-review' }] : [],
  };
}

describe('pr-autorebase paginated PR discovery', () => {
  it('reads the complete pool, filters drafts, and rotates before the cap', () => {
    const firstPage = Array.from({ length: 60 }, (_, index) => apiPullRequest(index + 1));
    const secondPage = Array.from({ length: 61 }, (_, index) => apiPullRequest(index + 61));
    firstPage[0] = apiPullRequest(1, true);
    const calls = [];

    const pullRequests = discoverOpenPullRequests((args) => {
      calls.push(args);
      return [firstPage, secondPage];
    }, 'owner/repo');

    assert.deepEqual(calls, [[
      'api', '--paginate', '--slurp',
      'repos/owner/repo/pulls?state=open&per_page=100',
    ]]);
    assert.equal(pullRequests.length, 121);
    assert.equal(new Set(pullRequests.map(({ number }) => number)).size, 121);

    const sweep = preparePullRequestSweep(pullRequests, 3);
    assert.equal(sweep.length, 120);
    assert.equal(sweep.every(({ isDraft }) => !isDraft), true);
    assert.equal(sweep[0].number, 5);
    assert.equal(new Set(sweep.map(({ number }) => number)).size, 120);
    assert.equal(sweep.slice(0, MAX_PER_RUN).length, MAX_PER_RUN);
  });

  it('rejects malformed or incomplete API payloads instead of treating them as empty', () => {
    assert.throws(() => parsePaginatedPullRequests({}), /array of pages/i);
    assert.throws(() => parsePaginatedPullRequests([{}]), /page 1 is not an array/i);
    assert.throws(() => parsePaginatedPullRequests([[{
      ...apiPullRequest(1),
      head: { ref: 'fix/1', sha: 'short' },
    }]]), /invalid head/i);
    assert.throws(() => parsePaginatedPullRequests([[{
      ...apiPullRequest(1),
      labels: null,
    }]]), /invalid labels/i);
    assert.throws(() => parsePaginatedPullRequests([
      [apiPullRequest(1)],
      [apiPullRequest(1)],
    ]), /appears more than once/i);
  });

  it('propagates API failures to the caller', () => {
    assert.throws(() => discoverOpenPullRequests(() => {
      throw new Error('rate limit from GitHub');
    }, 'owner/repo'), /rate limit from GitHub/);
  });

  it('does not turn an unavailable discovery API into a green CLI run', () => {
    const fakeBin = mkdtempSync(path.join(tmpdir(), 'pr-autorebase-gh-'));
    const fakeGh = path.join(fakeBin, 'gh');
    const script = path.join(ROOT, 'scripts/ci/pr-autorebase.mjs');
    writeFileSync(fakeGh, '#!/bin/sh\nexit 42\n');
    chmodSync(fakeGh, 0o755);

    try {
      const result = spawnSync(process.execPath, [script], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
          GITHUB_REPOSITORY: 'owner/repo',
          GH_TOKEN: 'test-token',
          GITHUB_RUN_NUMBER: '1',
        },
      });
      assert.equal(result.status, 1);
      assert.match(`${result.stdout}${result.stderr}`, /discovery PR fallita/i);
    } finally {
      rmSync(fakeBin, { recursive: true, force: true });
    }
  });
});

describe('pr-autorebase conflict scan tri-state', () => {
  it('maps merge-tree exit statuses without treating unknown as clean', () => {
    assert.equal(classifyMergeTreeStatus(0), 'clean');
    assert.equal(classifyMergeTreeStatus(1), 'conflicted');
    assert.equal(classifyMergeTreeStatus(null), 'unknown');
    assert.equal(classifyMergeTreeStatus(2), 'unknown');
  });

  it('preserves the existing conflict state when fetch or merge-tree is unknown', () => {
    for (const input of [
      { fetchOk: false, mergeTreeState: 'clean', hasLabel: true },
      { fetchOk: true, mergeTreeState: 'unknown', hasLabel: true },
    ]) {
      assert.deepEqual(decideConflictScan(input), { state: 'unknown', action: 'none' });
    }
  });

  it('allows mutations only for a verified clean or conflicted result', () => {
    assert.deepEqual(decideConflictScan({
      fetchOk: true, mergeTreeState: 'clean', hasLabel: true,
    }), { state: 'clean', action: 'remove' });
    assert.deepEqual(decideConflictScan({
      fetchOk: true, mergeTreeState: 'conflicted', hasLabel: false,
    }), { state: 'conflicted', action: 'add' });
  });

  it('defers the whole near-merge PR when fetch or merge-tree is unknown, before any mutation', () => {
    for (const failStage of ['fetch', 'merge-tree']) {
    const fakeBin = mkdtempSync(path.join(tmpdir(), 'pr-autorebase-unknown-'));
    const callLog = path.join(fakeBin, 'calls.log');
    const fakeGh = path.join(fakeBin, 'gh');
    const fakeGit = path.join(fakeBin, 'git');
    const script = path.join(ROOT, 'scripts/ci/pr-autorebase.mjs');
    const sha = 'a'.repeat(40);
    const pullRequests = JSON.stringify([[{
      number: 1,
      draft: false,
      head: { ref: 'fix/1', sha },
      labels: [{ name: 'stale-review' }, { name: 'needs-human' }],
    }]]);
    writeFileSync(callLog, '');
    writeFileSync(fakeGh, `#!/bin/sh
printf 'gh %s\\n' "$*" >> "$CALL_LOG"
case "$*" in
  *'pulls?state=open&per_page=100'*) printf '%s\\n' '${pullRequests}';;
  *'compare/main...'*) printf '1\\n';;
  *'/check-runs?per_page=100'*) printf '%s\\n' '{"check_runs":[]}';;
  *'/actions/workflows/tests.yml/runs?'*) printf '%s\\n' '{"workflow_runs":[]}';;
  *'/pulls/1/reviews'*) printf '%s\\n' '[]';;
  *'/pulls/1'*) printf '%s\\n' '{"body":"","head":{"sha":"${sha}"}}';;
  *'/issues/1/comments'*) printf '\\n';;
  *) printf '%s\\n' '[]';;
esac
`);
    writeFileSync(fakeGit, `#!/bin/sh
printf 'git %s\\n' "$*" >> "$CALL_LOG"
if [ "$FAIL_STAGE" = fetch ] && [ "$1" = fetch ]; then
  printf 'simulated fetch failure\\n' >&2
  exit 42
fi
if [ "$FAIL_STAGE" = merge-tree ] && [ "$1" = merge-tree ]; then
  printf 'simulated merge-tree failure\\n' >&2
  exit 2
fi
if [ "$1" = fetch ]; then
  # A successful fetch has no stdout; it still makes the next merge-tree call
  # observable in the merge-tree failure case.
  exit 0
fi
if [ "$1" = merge-tree ]; then
  exit 0
fi
exit 0
`);
    chmodSync(fakeGh, 0o755);
    chmodSync(fakeGit, 0o755);

    try {
      const result = spawnSync(process.execPath, [script], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
          CALL_LOG: callLog,
          FAIL_STAGE: failStage,
          GITHUB_REPOSITORY: 'owner/repo',
          GH_TOKEN: 'test-token',
          GITHUB_RUN_NUMBER: '1',
        },
      });
      const calls = readFileSync(callLog, 'utf8');
      assert.equal(result.status, 0);
      assert.match(`${result.stdout}${result.stderr}`, /rinvio ogni azione questo tick/i);
      assert.match(calls, /git fetch origin fix\/1 main/);
      if (failStage === 'merge-tree') assert.match(calls, /git merge-tree --write-tree origin\/main/);
      assert.doesNotMatch(calls, /gh (pr (comment|edit|close|reopen|update-branch)|workflow run|label create)/);
      assert.doesNotMatch(calls, /gh .*--method (POST|PATCH|PUT|DELETE)/);
      assert.doesNotMatch(calls, /git .*\b(checkout|reset|add|commit|push|branch)\b|git .*\bmerge\s/);
    } finally {
      rmSync(fakeBin, { recursive: true, force: true });
    }
    }
  });
});
