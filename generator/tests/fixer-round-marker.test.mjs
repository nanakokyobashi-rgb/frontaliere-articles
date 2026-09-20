import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  bodyRevision,
  markerTokens,
  verifyPersistedMarker,
  verifyRoundMarker,
} from '../../scripts/ci/fixer-round-marker.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HELPER = path.join(ROOT, 'scripts/ci/fixer-round-marker.mjs');
const HEAD = 'a'.repeat(40);
const BODY = '## Implementato\n\n- marker body';
const BODY_SHA = bodyRevision(BODY);
const REPO = 'example/repo';
const PR = '7';

function fakeGh({ comments, postBody = '', failComment = false, failCommentsRead = false, head = HEAD, body = BODY }) {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'fixer-round-marker-'));
  const bin = path.join(temp, 'bin');
  mkdirSync(bin);
  const log = path.join(temp, 'gh.log');
  writeFileSync(log, '');
  const gh = path.join(bin, 'gh');
  const commentsJson = JSON.stringify([comments]);
  writeFileSync(gh, `#!/bin/sh
echo "$*" >> "$GH_LOG"
case "$*" in
  "api user") printf '%s\\n' '{"login":"fixture-bot"}' ;;
  *"api --method POST repos/${REPO}/issues/${PR}/comments"*)
    ${failComment ? 'exit 23' : 'printf \'{"id":42,"user":{"login":"fixture-bot"},"body":%s}\\n\' "$FAKE_POST_BODY"'} ;;
  *"api --method DELETE repos/${REPO}/issues/comments/42"*) exit 0 ;;
  *"issues/${PR}/comments?per_page=100"*)
    ${failCommentsRead ? 'exit 24' : `printf '%s\\n' '${commentsJson.replaceAll("'", "'\\''")}'`} ;;
  *"pulls/${PR}"*)
    printf '%s\\n' "$FAKE_PR" ;;
  *) exit 64 ;;
esac
`);
  chmodSync(gh, 0o755);
  return {
    temp,
    bin,
    log,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      GH_LOG: log,
      FAKE_POST_BODY: JSON.stringify(postBody),
      FAKE_PR: JSON.stringify({ head: { sha: head }, body }),
    },
  };
}

function runHelper(fake, extra = []) {
  return spawnSync(process.execPath, [HELPER,
    '--repo', REPO,
    '--pr', PR,
    '--marker', 'REDCHECK_FIX_ROUND',
    '--round', '1',
    '--expected-head', HEAD,
    '--message', '_round 1/2_',
    ...extra,
  ], { cwd: ROOT, env: fake.env, encoding: 'utf8', timeout: 10_000 });
}

test('il marker lega round, HEAD e body revision allo stesso commento', () => {
  const tokens = markerTokens({
    marker: 'REDCHECK_FIX_ROUND', round: 1, headSha: HEAD, bodySha: BODY_SHA,
  });
  const comments = [{ id: 10, body: `${tokens.join('\n')}\n_round_` }];
  const persisted = verifyPersistedMarker({
    comments, marker: 'REDCHECK_FIX_ROUND', round: 1, headSha: HEAD, bodySha: BODY_SHA,
  });
  assert.equal(persisted.commentId, 10);
  assert.throws(() => verifyRoundMarker({
    pr: { headSha: HEAD, bodySha: bodyRevision('changed') },
    comments,
    marker: 'REDCHECK_FIX_ROUND',
    round: 1,
    expectedHead: HEAD,
    expectedBodySha: BODY_SHA,
  }), /body revision cambiata/);
});

test('post + verifica usa i commenti paginati e completa il ciclo', () => {
  const tokens = markerTokens({
    marker: 'REDCHECK_FIX_ROUND', round: 1, headSha: HEAD, bodySha: BODY_SHA,
  });
  const postedBody = `${tokens.join('\n')}\n_round 1/2_`;
  const fake = fakeGh({
    comments: [
      { id: 10, user: { login: 'fixture-bot' }, body: postedBody },
      { id: 42, user: { login: 'fixture-bot' }, body: postedBody },
    ],
    postBody: postedBody,
  });
  try {
    const result = runHelper(fake);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /"commentId":42/);
    assert.match(result.stdout, /"marker":"REDCHECK_FIX_ROUND"/);
    assert.match(result.stdout, /"round":1/);
    const log = readFileSync(fake.log, 'utf8');
    assert.match(log, /api --method POST repos\/example\/repo\/issues\/7\/comments/);
    assert.match(log, /api --paginate --slurp repos\/example\/repo\/issues\/7\/comments\?per_page=100/);
  } finally {
    rmSync(fake.temp, { recursive: true, force: true });
  }
});

test('failure injection sulla scrittura non permette di arrivare alla verifica o al modello', () => {
  const fake = fakeGh({ comments: [], failComment: true });
  try {
    const result = runHelper(fake);
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    const log = readFileSync(fake.log, 'utf8');
    assert.match(log, /api --method POST repos\/example\/repo\/issues\/7\/comments/);
    assert.doesNotMatch(log, /issues\/example\/repo\/comments\?per_page=100/);
  } finally {
    rmSync(fake.temp, { recursive: true, force: true });
  }
});

test('marker scritto ma API commenti illeggibile resta retryable, rimborsa e fallisce chiuso', () => {
  const tokens = markerTokens({
    marker: 'REDCHECK_FIX_ROUND', round: 1, headSha: HEAD, bodySha: BODY_SHA,
  });
  const postedBody = `${tokens.join('\n')}\n_round 1/2_`;
  const fake = fakeGh({ comments: [], postBody: postedBody, failCommentsRead: true });
  try {
    const result = runHelper(fake);
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /commenti paginata/);
    assert.match(readFileSync(fake.log, 'utf8'), /api --method DELETE repos\/example\/repo\/issues\/comments\/42/);
  } finally {
    rmSync(fake.temp, { recursive: true, force: true });
  }
});
