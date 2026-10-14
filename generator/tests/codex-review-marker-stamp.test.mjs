import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs, { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import {
  normalizeBodyRevision,
  postedReviewKey,
  reviewRetryDetails,
  stampReviewInputRevision,
  validateGhArgs,
} from '../../.github/actions/claude-codex-fallback/gh-bridge-server.mjs';
import { reviewInputRevisions } from '../../scripts/ci/lib/review-input-revision.mjs';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ACTION_DIR = path.join(ROOT, '.github/actions/claude-codex-fallback');
const REVIEW_PR = '8488';
const HEAD_SHA = 'e'.repeat(40);
const EXPECTED_REVISION = `body:${'d'.repeat(64)}`;
const EXPECTED_MARKER = `<!-- REVIEW_INPUT_REVISION: ${EXPECTED_REVISION} -->`;

function reviewMarker(revision) {
  return `<!-- REVIEW_INPUT_REVISION: ${revision} -->`;
}

async function waitFor(pathname) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (existsSync(pathname)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timeout waiting for ${pathname}`);
}

function startFixture({ root, endpoint, published, expectedRevision = EXPECTED_REVISION }) {
  const fakeGh = path.join(root, 'gh');
  writeFileSync(fakeGh, `#!/bin/sh
set -eu
[ "\${1:-}" = pr ] && [ "\${2:-}" = review ] || exit 2
shift 2
while [ "$#" -gt 0 ]; do
  case "$1" in
    --body-file) cat "$2" > '${published}'; shift 2 ;;
    --body-file=*) cat "\${1#*=}" > '${published}'; shift ;;
    --body) printf '%s' "$2" > '${published}'; shift 2 ;;
    --body=*) printf '%s' "\${1#*=}" > '${published}'; shift ;;
    *) shift ;;
  esac
done
`, { mode: 0o755 });
  const server = spawn(process.execPath, [path.join(ACTION_DIR, 'gh-bridge-server.mjs')], {
    env: {
      PATH: '/usr/bin:/bin',
      HEAD_SHA,
      CODEX_BRIDGE_TRANSPORT: 'files',
      CODEX_GH_SOCKET: endpoint,
      CODEX_GH_AUTH: 'fixture-token',
      CODEX_REAL_GH: fakeGh,
      CODEX_GH_CWD: root,
      CODEX_GH_WORKSPACE: root,
      CODEX_GH_SCRATCH: root,
      CODEX_GH_REPOSITORY: 'owner/repo',
      CODEX_GH_HOST: 'github.com',
      CODEX_GH_REVIEW_INPUT_REVISION: expectedRevision,
      CODEX_GH_REVIEW_PR_NUMBER: REVIEW_PR,
    },
    stdio: 'ignore',
  });
  return server;
}

async function stopFixture(server) {
  if (server.exitCode !== null) return;
  const exited = new Promise((resolve) => server.once('exit', resolve));
  server.kill('SIGTERM');
  await exited;
}

function bridgeServerLaunchBlocks(action) {
  const lines = action.split('\n');
  const launchRe = /gh-(?:bridge-)?server\.mjs[^\n]*&/u;
  const blocks = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^\s*env -i\b/u.test(lines[index])) continue;
    const block = [];
    for (let cursor = index; cursor < lines.length; cursor += 1) {
      if (cursor > index && /^\s*env -i\b/u.test(lines[cursor])) break;
      block.push(lines[cursor]);
      if (launchRe.test(lines[cursor])) {
        blocks.push({ line: index + 1, text: block.join('\n') });
        break;
      }
    }
  }
  return blocks;
}

test('ogni avvio del bridge server passa la revisione e la PR fuori dal modello', () => {
  const action = fs.readFileSync(path.join(ACTION_DIR, 'action.yml'), 'utf8');
  const launchRe = /gh-(?:bridge-)?server\.mjs[^\n]*&/gu;
  const launches = action.match(launchRe) || [];
  const blocks = bridgeServerLaunchBlocks(action);
  assert.equal(blocks.length, launches.length, 'un avvio server non è dentro un blocco env -i');
  assert.equal(launches.length, 2, 'il censimento degli avvii server è cambiato');
  for (const { line, text } of blocks) {
    assert.match(text, /CODEX_GH_REVIEW_INPUT_REVISION=/u, `avvio alla riga ${line}`);
    assert.match(text, /CODEX_GH_REVIEW_PR_NUMBER=/u, `avvio alla riga ${line}`);
  }
});

test('il bridge rimuove marker assente, malformato, duplicato o corretto e ne timbra uno solo', () => {
  const cases = [
    ['63 caratteri', `${reviewMarker(`body:${'a'.repeat(63)}`)}\n## LGTM`],
    ['assente', '## LGTM'],
    ['duplicato', `${reviewMarker(`body:${'a'.repeat(64)}`)}\n${reviewMarker(`body:${'b'.repeat(64)}`)}\n## LGTM`],
    ['corretto', `## Scope\n${reviewMarker(`body:${'c'.repeat(64)}`)}\n\n## LGTM`],
  ];
  for (const [label, body] of cases) {
    const stamped = stampReviewInputRevision(body, EXPECTED_REVISION);
    assert.equal(stamped.split(/\r?\n/u)[0], EXPECTED_MARKER, label);
    assert.equal((stamped.match(/REVIEW_INPUT_REVISION:/gu) || []).length, 1, label);
    assert.match(stamped, /## LGTM/u, label);
  }
  assert.equal(normalizeBodyRevision(` BODY:${'A'.repeat(64)} `), `body:${'a'.repeat(64)}`);
});

test('il gate legge il marker solo come riga Markdown completa, non inline o in citazione', () => {
  assert.deepEqual(reviewInputRevisions(`prefix ${EXPECTED_MARKER}`), []);
  assert.deepEqual(reviewInputRevisions(`> ${EXPECTED_MARKER}`), []);
  assert.deepEqual(reviewInputRevisions(`${EXPECTED_MARKER}\n## LGTM`), [EXPECTED_REVISION]);
});

test('il bridge lascia il body invariato quando la revisione attesa manca o è malformata', () => {
  const body = `${reviewMarker(`body:${'a'.repeat(63)}`)}\n## LGTM`;
  assert.equal(stampReviewInputRevision(body, ''), body);
  assert.equal(stampReviewInputRevision(body, 'body:not-a-digest'), body);
});

test('la chiave di idempotenza usa il body già normalizzato e timbrato', () => {
  const body = `${EXPECTED_MARKER}\n## LGTM\n`;
  const details = reviewRetryDetails(
    ['pr', 'review', REVIEW_PR, '--comment', '--body', 'model body'],
    0,
    { headSha: HEAD_SHA, bodyOverride: body },
  );
  assert.equal(
    postedReviewKey(details),
    JSON.stringify([REVIEW_PR, HEAD_SHA, 'comment', body.trimEnd()]),
  );
  const differentAction = reviewRetryDetails(
    ['pr', 'review', REVIEW_PR, '-r', '--body', 'model body'],
    0,
    { headSha: HEAD_SHA, bodyOverride: body },
  );
  assert.notEqual(postedReviewKey(details), postedReviewKey(differentAction));
});

test('il bridge rifiuta una review con --body e --body-file insieme', () => {
  const error = validateGhArgs(
    ['pr', 'review', REVIEW_PR, '--comment', '--body', 'inline', '--body-file', 'review.md'],
    {
      cwd: ROOT,
      workspaceRoot: ROOT,
      scratchRoot: ROOT,
      repository: 'owner/repo',
      host: 'github.com',
    },
  );
  assert.equal(error, 'gh pr review cannot combine --body and --body-file in the Codex fallback bridge');
});

test('il bridge timbra il body prima di pubblicare la review e deduplica il body timbrato', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'codex-review-marker-'));
  const endpoint = path.join(root, 'mailbox');
  const published = path.join(root, 'published-body');
  const source = path.join(root, 'review.md');
  const server = startFixture({ root, endpoint, published });
  try {
    await waitFor(endpoint);
    writeFileSync(source, `${reviewMarker(`body:${'a'.repeat(63)}`)}\n## LGTM\n\ncase: first`);
    const args = ['pr', 'review', REVIEW_PR, '--comment', '--body-file', source];
    await run(process.execPath, [path.join(ACTION_DIR, 'gh-bridge-client.mjs'), ...args], {
      env: { CODEX_BRIDGE_TRANSPORT: 'files', CODEX_GH_SOCKET: endpoint },
      timeout: 10_000,
    });
    const posted = readFileSync(published, 'utf8');
    assert.equal(posted.split(/\r?\n/u)[0], EXPECTED_MARKER);
    assert.equal((posted.match(/REVIEW_INPUT_REVISION:/gu) || []).length, 1);

    writeFileSync(source, `${EXPECTED_MARKER}\n## LGTM\n\ncase: first`);
    const repeat = await run(process.execPath, [path.join(ACTION_DIR, 'gh-bridge-client.mjs'), ...args], {
      env: { CODEX_BRIDGE_TRANSPORT: 'files', CODEX_GH_SOCKET: endpoint },
      timeout: 10_000,
    });
    assert.match(repeat.stderr, /already posted on PR #8488/u);
  } finally {
    await stopFixture(server);
    rmSync(root, { recursive: true, force: true });
  }
});

test('il bridge pubblica il body originale quando la revisione host non è disponibile', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'codex-review-marker-no-revision-'));
  const endpoint = path.join(root, 'mailbox');
  const published = path.join(root, 'published-body');
  const source = path.join(root, 'review.md');
  const body = `${reviewMarker(`body:${'a'.repeat(63)}`)}\n## LGTM`;
  writeFileSync(source, body);
  const server = startFixture({ root, endpoint, published, expectedRevision: '' });
  try {
    await waitFor(endpoint);
    await run(process.execPath, [path.join(ACTION_DIR, 'gh-bridge-client.mjs'),
      'pr', 'review', REVIEW_PR, '--comment', '--body-file', source], {
      env: { CODEX_BRIDGE_TRANSPORT: 'files', CODEX_GH_SOCKET: endpoint },
      timeout: 10_000,
    });
    assert.equal(readFileSync(published, 'utf8'), body);
  } finally {
    await stopFixture(server);
    rmSync(root, { recursive: true, force: true });
  }
});

test('action e prompt passano la revisione solo al bridge host-side', () => {
  const action = fs.readFileSync(path.join(ACTION_DIR, 'action.yml'), 'utf8');
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/tests.yml'), 'utf8');
  assert.match(action, /codex_review_input_revision="\$\{REVIEW_REVISION:-\}"/u);
  assert.match(action, /CODEX_GH_REVIEW_INPUT_REVISION="\$codex_review_input_revision"/u);
  assert.match(action, /CODEX_GH_REVIEW_PR_NUMBER="\$codex_review_pr_number"/u);
  assert.match(action, /claude_review_input_revision="\$\{REVIEW_REVISION:-\}"/u);
  assert.match(action, /claude_review_pr_number="\$\{PR_NUMBER:-\}"/u);
  const reviewStepStart = workflow.indexOf('      - name: Run Codex Luna Max review');
  const reviewStep = workflow.slice(reviewStepStart, workflow.indexOf('\n      - name: ', reviewStepStart + 1));
  assert.match(reviewStep, /REVIEW_REVISION: \$\{\{ steps\.review_input\.outputs\.review_revision \}\}/u);
  assert.match(reviewStep, /Do not add or edit a `REVIEW_INPUT_REVISION` marker/u);
  assert.doesNotMatch(reviewStep, /DEVE contenere.*REVIEW_INPUT_REVISION/u);
  const claudeStepStart = action.indexOf('    - name: Run Claude fallback');
  const claudeStepEnd = action.indexOf('\n    - name: Cleanup Claude fallback GitHub bridge', claudeStepStart);
  const claudeStep = action.slice(claudeStepStart, claudeStepEnd);
  assert.match(claudeStep, /prompt: \$\{\{ inputs\.prompt \}\}/u);
  assert.doesNotMatch(claudeStep, /REVIEW_INPUT_REVISION/u);
});
