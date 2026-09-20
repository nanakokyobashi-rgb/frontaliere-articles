import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  bodyRevision,
  markerTokens,
  verifiedCurrentRound,
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

function fakeGh({ comments, postBody = '', refundBody = '', failComment = false, malformedPost = false, failCommentsRead = false, head = HEAD, body = BODY }) {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'fixer-round-marker-'));
  const bin = path.join(temp, 'bin');
  mkdirSync(bin);
  const log = path.join(temp, 'gh.log');
  const postCount = path.join(temp, 'post-count');
  writeFileSync(log, '');
  writeFileSync(postCount, '0');
  const gh = path.join(bin, 'gh');
  const commentsJson = JSON.stringify([comments]);
  const postCommand = failComment
    ? 'exit 23'
    : `count=$(cat "$FAKE_POST_COUNT"); count=$((count + 1)); printf '%s\\n' "$count" > "$FAKE_POST_COUNT"; if [ "$count" -eq 1 ] && [ "$FAKE_MALFORMED_POST" = true ]; then printf '%s\\n' '{'; else body="$FAKE_POST_BODY"; [ "$count" -gt 1 ] && body="$FAKE_REFUND_BODY"; printf '{"id":42,"user":{"login":"fixture-bot"},"body":%s}\\n' "$body"; fi`;
  writeFileSync(gh, `#!/bin/sh
echo "$*" >> "$GH_LOG"
case "$*" in
  "api user") printf '%s\\n' '{"login":"fixture-bot"}' ;;
  *"api --method POST repos/${REPO}/issues/${PR}/comments"*)
    ${postCommand} ;;
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
      FAKE_POST_COUNT: postCount,
      FAKE_MALFORMED_POST: String(malformedPost),
      FAKE_POST_BODY: JSON.stringify(postBody),
      FAKE_REFUND_BODY: JSON.stringify(refundBody),
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

function runCurrentRound(fake, marker = 'REDCHECK_FIX_ROUND') {
  return spawnSync(process.execPath, [HELPER,
    '--current-round', '--repo', REPO, '--pr', PR, '--marker', marker,
  ], { cwd: ROOT, env: fake.env, encoding: 'utf8', timeout: 10_000 });
}

function runVerifyCurrent(fake, { marker = 'REDCHECK_FIX_ROUND', round = 1, commentId = 42 } = {}) {
  return spawnSync(process.execPath, [HELPER,
    '--verify-current', '--repo', REPO, '--pr', PR, '--marker', marker,
    '--round', String(round), '--comment-id', String(commentId),
    '--expected-head', HEAD, '--expected-body-revision', BODY_SHA,
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

test('la body revision conserva i byte API e la newline jq contrattuale', () => {
  const body = 'body con spazio  \n';
  assert.equal(bodyRevision(body), createHash('sha256').update(`${body}\n`).digest('hex'));
  assert.notEqual(bodyRevision(body), bodyRevision(body.trim()));
});

test('il cap ignora marker preseed/stale e conta solo autore, HEAD e body correnti', () => {
  const current = markerTokens({ marker: 'REDCHECK_FIX_ROUND', round: 1, headSha: HEAD, bodySha: BODY_SHA });
  const stale = markerTokens({ marker: 'REDCHECK_FIX_ROUND', round: 2, headSha: 'b'.repeat(40), bodySha: BODY_SHA });
  const preseed = markerTokens({ marker: 'REDCHECK_FIX_ROUND', round: 2, headSha: HEAD, bodySha: BODY_SHA });
  const comments = [
    { id: 8, user: { login: 'attacker' }, body: preseed.join('\n') },
    { id: 9, user: { login: 'fixture-bot' }, body: stale.join('\n') },
    { id: 10, user: { login: 'fixture-bot' }, body: current.join('\n') },
  ];
  const state = verifiedCurrentRound({
    comments, marker: 'REDCHECK_FIX_ROUND', headSha: HEAD, bodySha: BODY_SHA, expectedAuthor: 'fixture-bot',
  });
  assert.equal(state.round, 1);
});

test('un marker trusted oltre il cap è un errore fail-closed', () => {
  const tokens = markerTokens({ marker: 'REDCHECK_FIX_ROUND', round: 3, headSha: HEAD, bodySha: BODY_SHA });
  assert.throws(() => verifiedCurrentRound({
    comments: [{ id: 12, user: { login: 'fixture-bot' }, body: tokens.join('\n') }],
    marker: 'REDCHECK_FIX_ROUND', headSha: HEAD, bodySha: BODY_SHA, expectedAuthor: 'fixture-bot',
  }), /fuori intervallo/);
});

test('la CLI del cap usa il read-back paginato e scarta preseed/stale', () => {
  const current = markerTokens({ marker: 'REDCHECK_FIX_ROUND', round: 1, headSha: HEAD, bodySha: BODY_SHA });
  const stale = markerTokens({ marker: 'REDCHECK_FIX_ROUND', round: 2, headSha: 'b'.repeat(40), bodySha: BODY_SHA });
  const preseed = markerTokens({ marker: 'REDCHECK_FIX_ROUND', round: 2, headSha: HEAD, bodySha: BODY_SHA });
  const fake = fakeGh({ comments: [
    { id: 8, user: { login: 'attacker' }, body: preseed.join('\n') },
    { id: 9, user: { login: 'fixture-bot' }, body: stale.join('\n') },
    { id: 10, user: { login: 'fixture-bot' }, body: current.join('\n') },
  ] });
  try {
    const result = runCurrentRound(fake);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /"round":1/);
    const log = readFileSync(fake.log, 'utf8');
    assert.match(log, /api user/);
    assert.match(log, /api --paginate --slurp repos\/example\/repo\/issues\/7\/comments\?per_page=100/);
  } finally {
    rmSync(fake.temp, { recursive: true, force: true });
  }
});

test('la verifica finale prova lo stesso ID, autore e body del marker persistito', () => {
  const tokens = markerTokens({
    marker: 'REDCHECK_FIX_ROUND', round: 1, headSha: HEAD, bodySha: BODY_SHA,
  });
  const postedBody = `${tokens.join('\n')}\n_round 1/2_`;
  const fake = fakeGh({
    comments: [{ id: 42, user: { login: 'fixture-bot' }, body: postedBody }],
    postBody: postedBody,
  });
  try {
    const result = runVerifyCurrent(fake);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /"commentId":42/);
    const missing = runVerifyCurrent(fake, { commentId: 99 });
    assert.equal(missing.status, 1, `${missing.stdout}\n${missing.stderr}`);
    assert.match(missing.stderr, /stesso ID\/autore\/body/);
  } finally {
    rmSync(fake.temp, { recursive: true, force: true });
  }
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

test('POST malformata viene riconciliata e rimborsata senza lasciare il marker', () => {
  const tokens = markerTokens({
    marker: 'REDCHECK_FIX_ROUND', round: 1, headSha: HEAD, bodySha: BODY_SHA,
  });
  const postedBody = `${tokens.join('\n')}\n_round 1/2_`;
  const fake = fakeGh({
    comments: [{ id: 42, user: { login: 'fixture-bot' }, body: postedBody }],
    postBody: postedBody,
    refundBody: '<!-- REDCHECK_FIX_REFUNDED: 1 -->\n_Round rimborsato: marker non verificabile; nessun round consumato._',
    malformedPost: true,
  });
  try {
    const result = runHelper(fake);
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /JSON illeggibile/);
    assert.match(readFileSync(fake.log, 'utf8'), /api --method DELETE repos\/example\/repo\/issues\/comments\/42/);
  } finally {
    rmSync(fake.temp, { recursive: true, force: true });
  }
});

test('marker scritto ma API commenti illeggibile resta retryable, rimborsa e fallisce chiuso', () => {
  const tokens = markerTokens({
    marker: 'REDCHECK_FIX_ROUND', round: 1, headSha: HEAD, bodySha: BODY_SHA,
  });
  const postedBody = `${tokens.join('\n')}\n_round 1/2_`;
  const fake = fakeGh({
    comments: [], postBody: postedBody,
    refundBody: '<!-- REDCHECK_FIX_REFUNDED: 1 -->\n_Round rimborsato: marker non verificabile; nessun round consumato._',
    failCommentsRead: true,
  });
  try {
    const result = runHelper(fake);
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /commenti paginata/);
    assert.match(readFileSync(fake.log, 'utf8'), /api --method DELETE repos\/example\/repo\/issues\/comments\/42/);
  } finally {
    rmSync(fake.temp, { recursive: true, force: true });
  }
});

test('invocazione via symlink esegue davvero il main e non esce silenziosamente', () => {
  const tokens = markerTokens({
    marker: 'REDCHECK_FIX_ROUND', round: 1, headSha: HEAD, bodySha: BODY_SHA,
  });
  const postedBody = `${tokens.join('\n')}\n_round 1/2_`;
  const fake = fakeGh({
    comments: [{ id: 42, user: { login: 'fixture-bot' }, body: postedBody }],
    postBody: postedBody,
  });
  const link = path.join(fake.temp, 'marker-link.mjs');
  symlinkSync(HELPER, link);
  try {
    const result = spawnSync(process.execPath, [link,
      '--repo', REPO, '--pr', PR, '--marker', 'REDCHECK_FIX_ROUND', '--round', '1',
      '--expected-head', HEAD, '--message', '_round 1/2_',
    ], { cwd: ROOT, env: fake.env, encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /"commentId":42/);
  } finally {
    rmSync(fake.temp, { recursive: true, force: true });
  }
});
