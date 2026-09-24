/**
 * Idempotenza della chiusura di un round SUPERSEDED di `pr-redcheck-fixer.yml`
 * (issue site #9617, residuo della PR corpus #1549).
 *
 * Il rimborso del marker di round era tre side effect indipendenti (commento
 * provvisorio, DELETE, handle `_REFUNDED`) seguiti da un finalize del claim con
 * `|| echo ::warning::`. Qui lo step VERO del workflow gira con l'helper VERO
 * contro un `gh` finto ma con stato (commenti persistiti su file, DELETE che
 * restituisce 404 su un commento assente), e si rigiocano i tre casi della
 * scheda:
 *   1. interruzione dopo la DELETE → la riesecuzione converge;
 *   2. rimborso gia' presente → nessuna scrittura, stato identico;
 *   3. doppio finalize concorrente → un solo handle, un solo claim released.
 * Un fallimento deve restare ROSSO e osservabile, mai un warning.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  classifySupersededRefund,
  supersededRefundBodies,
} from '../../scripts/ci/fixer-round-marker.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WORKFLOW = readFileSync(path.join(ROOT, '.github/workflows/pr-redcheck-fixer.yml'), 'utf8');
const HELPER = path.join(ROOT, 'scripts/ci/fixer-round-marker.mjs');
const CLASSIFY_NAME = 'Classify outcome (work-done, not CLI exit)';
const FINALIZE_NAME = 'Finalize redcheck PR + HEAD + failed check claim';
const MARKER = 'REDCHECK_FIX_ROUND';
const ACTOR = 'github-actions[bot]';
const HEAD_SHA = 'a'.repeat(40);
const PR_BODY = '## Implementato\n\n- body iniziale';
const BODY_REVISION = createHash('sha256').update(`${PR_BODY}\n`).digest('hex');
const MARKER_ID = 42;
const CHECK_FAILURE_KEY = 'tests (node --test)';
const CLAIM_KEY = `pr:7|head:${HEAD_SHA}|failure:${CHECK_FAILURE_KEY}`;
const BODIES = supersededRefundBodies({ marker: MARKER, round: 1, commentId: MARKER_ID });

function stepScript(name) {
  const start = WORKFLOW.indexOf(`      - name: ${name}`);
  assert.notEqual(start, -1, `step «${name}» non trovato`);
  const rest = WORKFLOW.slice(start + 1);
  const next = rest.indexOf('\n      - name: ');
  const step = next === -1 ? rest : rest.slice(0, next);
  const match = /\n {8}run: \|\n([\s\S]*)$/.exec(step);
  assert.ok(match, `lo step «${name}» non contiene un blocco run`);
  return match[1].split('\n')
    .map((line) => (line.startsWith(' '.repeat(10)) ? line.slice(10) : line))
    .join('\n');
}

function markerComment() {
  return {
    id: MARKER_ID,
    user: { login: ACTOR },
    created_at: '2026-09-24T10:00:00Z',
    body: `<!-- ${MARKER}: 1 -->\n<!-- ${MARKER}_HEAD: ${HEAD_SHA} -->\n<!-- ${MARKER}_BODY: ${BODY_REVISION} -->\n_round 1/2 avviato (auto)._`,
  };
}

function claimComment(id, state, issuedAt) {
  const event = {
    version: 1,
    token: 'tok-1',
    key: CLAIM_KEY,
    prNumber: '7',
    headSha: HEAD_SHA,
    checkFailureKey: CHECK_FAILURE_KEY,
    state,
    issuedAt,
    expiresAt: issuedAt + 3600,
    runId: '1',
  };
  return {
    id,
    user: { login: ACTOR },
    created_at: new Date(issuedAt * 1000).toISOString(),
    body: `<!-- REDCHECK_FIX_CLAIM: ${JSON.stringify(event)} -->\n_claim_`,
  };
}

// `gh` finto con stato: i commenti vivono su file, sotto un lock mkdir, cosi'
// due processi concorrenti vedono lo stesso thread come su GitHub.
const FAKE_GH = String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const joined = args.join(' ');
fs.appendFileSync(process.env.GH_LOG, joined.replace(/\n/g, '\\n') + '\n');
const lock = process.env.GH_STATE + '.lock';
const deadline = Date.now() + 5000;
for (;;) {
  try { fs.mkdirSync(lock); break; } catch {
    if (Date.now() > deadline) { console.error('lock timeout'); process.exit(90); }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
}
let code = 0;
try {
  const state = JSON.parse(fs.readFileSync(process.env.GH_STATE, 'utf8'));
  const save = () => fs.writeFileSync(process.env.GH_STATE, JSON.stringify(state));
  const fault = (name, body) => {
    const rule = (state.faults || []).find((f) => f.on === name && f.remaining > 0 && body.includes(f.match));
    if (rule) { rule.remaining -= 1; save(); }
    return rule || null;
  };
  const append = (body) => {
    const comment = { id: state.nextId++, user: { login: '${ACTOR}' }, created_at: new Date(state.clock++ * 1000).toISOString(), body };
    state.comments.push(comment);
    save();
    return comment;
  };
  if (args[0] === 'api' && args.includes('--slurp')) {
    process.stdout.write(JSON.stringify([state.comments]) + '\n');
  } else if (args[0] === 'api' && args[1] === '--method' && args[2] === 'POST') {
    const body = args[args.indexOf('--raw-field') + 1].replace(/^body=/, '');
    const rule = fault('post', body);
    if (rule && rule.mode === 'fail') { console.error('HTTP 502'); code = 1; }
    else {
      const comment = append(body);
      if (rule && rule.mode === 'lose-response') { console.error('connection reset'); code = 1; }
      else process.stdout.write(JSON.stringify(comment) + '\n');
    }
  } else if (args[0] === 'api' && args[1] === '--method' && args[2] === 'DELETE') {
    const id = Number(args[3].split('/').pop());
    const rule = fault('delete', String(id));
    const at = state.comments.findIndex((c) => c.id === id);
    if (rule) { console.error('HTTP 500'); code = 1; }
    else if (at < 0) { console.error('HTTP 404'); code = 1; }
    else { state.comments.splice(at, 1); state.deletes.push(id); save(); }
  } else if (args[0] === 'pr' && args[1] === 'comment') {
    const body = args[args.indexOf('--body') + 1];
    const rule = fault('post', body);
    if (rule && rule.mode === 'fail') { console.error('HTTP 502'); code = 1; }
    else {
      const comment = append(body);
      if (rule && rule.mode === 'lose-response') { console.error('connection reset'); code = 1; }
      else process.stdout.write('https://github.com/example/repo/pull/7#issuecomment-' + comment.id + '\n');
    }
  } else {
    console.error('fake gh: comando non previsto: ' + joined);
    code = 64;
  }
} finally {
  fs.rmdirSync(lock);
}
process.exit(code);
`;

function makeWorld({ comments, faults = [] }) {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'redcheck-superseded-refund-'));
  const bin = path.join(temp, 'bin');
  mkdirSync(bin);
  const gh = path.join(bin, 'gh');
  writeFileSync(gh, FAKE_GH);
  chmodSync(gh, 0o755);
  const git = path.join(bin, 'git');
  writeFileSync(git, `#!/bin/sh
case "$1 $2" in
  "rev-parse HEAD") printf '%s\\n' merged-sha ;;
  "rev-parse origin/"*) printf '%s\\n' external-sha ;;
  fetch*) exit 0 ;;
  *) exit 64 ;;
esac
`);
  chmodSync(git, 0o755);
  const statePath = path.join(temp, 'state.json');
  const ghLog = path.join(temp, 'gh.log');
  writeFileSync(ghLog, '');
  writeFileSync(statePath, JSON.stringify({
    comments, nextId: 1000, clock: 1_790_000_000, deletes: [], faults,
  }));
  const world = {
    temp,
    env(extra = {}) {
      return {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        TEST_BIN: bin,
        GH_STATE: statePath,
        GH_LOG: ghLog,
        ...extra,
      };
    },
    state: () => JSON.parse(readFileSync(statePath, 'utf8')),
    log: () => readFileSync(ghLog, 'utf8'),
    setFaults(next) {
      const state = world.state();
      state.faults = next;
      writeFileSync(statePath, JSON.stringify(state));
    },
    dispose: () => rmSync(temp, { recursive: true, force: true }),
  };
  return world;
}

function classifyEnv(world, githubEnv) {
  return world.env({
    REPO: 'example/repo',
    GH_REPO: 'example/repo',
    PR_NUMBER: '7',
    HEAD_REF: 'fix/body-outcome',
    HEAD_SHA,
    CHECK_FAILURE_KEY,
    START_SHA: 'pr-sha',
    BASE_SHA: 'merged-sha',
    BASE_COMMENTS: '0',
    BASE_BODY_SHA: 'b'.repeat(64),
    BASE_CAPTURE_OUTCOME: 'success',
    ACTION_OUTCOME: 'failure',
    FIX_ROUND: '1',
    FIX_ROUND_MARKER: MARKER,
    CLAIM_TOKEN: 'tok-1',
    MARKER_COMMENT_ID: String(MARKER_ID),
    MARKER_HEAD: HEAD_SHA,
    MARKER_BODY_REVISION: BODY_REVISION,
    TRUSTED_MARKER_HELPER: HELPER,
    GITHUB_ENV: githubEnv,
  });
}

function classifyCommand() {
  return ['-c', `export PATH="$TEST_BIN:$PATH"\n${stepScript(CLASSIFY_NAME)}`];
}

function runClassify(world) {
  const githubEnv = path.join(world.temp, `github-env-${Math.random().toString(16).slice(2)}`);
  writeFileSync(githubEnv, '');
  const result = spawnSync('/bin/bash', classifyCommand(), {
    cwd: ROOT, env: classifyEnv(world, githubEnv), encoding: 'utf8', timeout: 60_000,
  });
  assert.ifError(result.error);
  result.githubEnv = readFileSync(githubEnv, 'utf8');
  return result;
}

function runClassifyAsync(world) {
  const githubEnv = path.join(world.temp, `github-env-${Math.random().toString(16).slice(2)}`);
  writeFileSync(githubEnv, '');
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/bash', classifyCommand(), {
      cwd: ROOT, env: classifyEnv(world, githubEnv),
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status) => resolve({
      status, stdout, stderr, githubEnv: readFileSync(githubEnv, 'utf8'),
    }));
  });
}

function runFinalize(world, claimStatus) {
  const result = spawnSync('/bin/bash', ['-c', `export PATH="$TEST_BIN:$PATH"\n${stepScript(FINALIZE_NAME)}`], {
    cwd: ROOT,
    env: world.env({
      GH_REPO: 'example/repo',
      CLAIM_ACTION: 'finalize',
      CLAIM_TOKEN: 'tok-1',
      CLAIM_STATUS: claimStatus,
      PR_NUMBER: '7',
      HEAD_SHA,
      CHECK_FAILURE_KEY,
      GUARD_PROCEED: 'true',
      CODEX_OUTCOME: 'failure',
      GITHUB_OUTPUT: path.join(world.temp, 'github-output'),
    }),
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.ifError(result.error);
  return result;
}

function refundView(state) {
  const bound = (body) => state.comments.filter((c) => c.body === body).map((c) => c.id);
  return {
    markerPresent: state.comments.some((c) => c.id === MARKER_ID),
    attempts: bound(BODIES.attempt),
    handles: bound(BODIES.refunded),
    markerDeletes: state.deletes.filter((id) => id === MARKER_ID).length,
  };
}

function releasedEvents(state) {
  return state.comments.filter((c) => c.body.includes('"token":"tok-1"')
    && c.body.includes('"state":"released"')).length;
}

function assertConverged(state, label) {
  const view = refundView(state);
  assert.equal(view.markerPresent, false, `${label}: marker di round ancora presente`);
  assert.equal(view.handles.length, 1, `${label}: attesi 1 handle ${BODIES.refundMarker} vincolato, trovati ${view.handles.length}`);
  assert.equal(view.attempts.length, 1, `${label}: attesi 1 tentativo vincolato, trovati ${view.attempts.length}`);
  assert.equal(view.markerDeletes, 1, `${label}: la DELETE del marker deve riuscire una sola volta`);
}

test('replay 1: interruzione dopo la DELETE è rossa e la riesecuzione converge', () => {
  const world = makeWorld({
    comments: [markerComment(), claimComment(99, 'active', 1_789_999_000)],
    faults: [{ on: 'post', match: `${BODIES.refundMarker}: 1`, mode: 'fail', remaining: 99 }],
  });
  try {
    const interrupted = runClassify(world);
    assert.equal(interrupted.status, 1,
      `DELETE eseguita senza handle deve colorare di ROSSO:\n${interrupted.stdout}\n${interrupted.stderr}`);
    assert.match(interrupted.stdout, /::error::SUPERSEDED/);
    assert.doesNotMatch(interrupted.stdout, /::warning::/, 'il fallimento non deve degradare a warning');
    assert.match(interrupted.githubEnv, /CLAIM_STATUS=released/, 'il claim resta rilasciabile dal Finalize');
    const mid = refundView(world.state());
    assert.equal(mid.markerPresent, false, 'lo scenario deve interrompersi DOPO la DELETE');
    assert.equal(mid.handles.length, 0);
    assert.equal(mid.attempts.length, 1, 'il tentativo vincolato è la prova che rende la riesecuzione sicura');

    world.setFaults([]);
    const retry = runClassify(world);
    assert.equal(retry.status, 0, `la riesecuzione deve convergere:\n${retry.stdout}\n${retry.stderr}`);
    assertConverged(world.state(), 'dopo la riesecuzione');
  } finally {
    world.dispose();
  }
});

test('replay 2: un rimborso già presente non produce alcuna scrittura', () => {
  const world = makeWorld({
    comments: [
      claimComment(99, 'active', 1_789_999_000),
      { id: 500, user: { login: ACTOR }, created_at: '2026-09-24T10:01:00Z', body: BODIES.attempt },
      { id: 501, user: { login: ACTOR }, created_at: '2026-09-24T10:02:00Z', body: BODIES.refunded },
    ],
  });
  try {
    const before = world.state().comments;
    const result = runClassify(world);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.deepEqual(world.state().comments, before, 'lo stato del thread deve restare identico');
    assert.doesNotMatch(world.log(), /--method (POST|DELETE)|pr comment/, 'nessuna scrittura su un round già rimborsato');
    assert.match(result.stdout, /"outcome":"already-refunded"/);
  } finally {
    world.dispose();
  }
});

test('replay 3: due finalizzazioni concorrenti convergono su un solo handle e un solo released', async () => {
  const world = makeWorld({
    comments: [markerComment(), claimComment(99, 'active', 1_789_999_000)],
  });
  try {
    const [first, second] = await Promise.all([runClassifyAsync(world), runClassifyAsync(world)]);
    for (const [label, result] of [['primo', first], ['secondo', second]]) {
      assert.equal(result.status, 0, `${label} finalizzatore:\n${result.stdout}\n${result.stderr}`);
      assert.match(result.githubEnv, /CLAIM_STATUS=released/);
    }
    assertConverged(world.state(), 'dopo la corsa');

    // Il claim ha un solo writer: il Finalize. Una sua riesecuzione è no-op.
    for (let i = 0; i < 2; i += 1) {
      const finalize = runFinalize(world, 'released');
      assert.equal(finalize.status, 0, `${finalize.stdout}\n${finalize.stderr}`);
      assert.match(finalize.stdout, /claim_state=released/);
    }
    assert.equal(releasedEvents(world.state()), 1, 'il claim deve essere rilasciato una sola volta');
  } finally {
    world.dispose();
  }
});

test('un round SUPERSEDED pubblica tentativo, poi DELETE, poi handle, e rilascia il claim', () => {
  const world = makeWorld({ comments: [markerComment(), claimComment(99, 'active', 1_789_999_000)] });
  try {
    const result = runClassify(world);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /run SUPERSEDED/);
    assert.match(result.githubEnv, /CLAIM_STATUS=released/);
    assertConverged(world.state(), 'round singolo');
    const lines = world.log().trim().split('\n');
    const attemptAt = lines.findIndex((line) => line.includes('--method POST') && line.includes('REDCHECK_FIX_REFUND_ATTEMPT: 1'));
    const deleteAt = lines.findIndex((line) => line.includes('--method DELETE') && line.endsWith(`/issues/comments/${MARKER_ID}`));
    const handleAt = lines.findIndex((line) => line.includes('--method POST') && line.includes('REDCHECK_FIX_REFUNDED: 1'));
    assert.ok(attemptAt >= 0 && deleteAt > attemptAt && handleAt > deleteAt,
      `ordine atteso tentativo → DELETE → handle:\n${world.log()}`);
    assert.equal(releasedEvents(world.state()), 0, 'il classify non scrive il claim: lo fa solo il Finalize');
  } finally {
    world.dispose();
  }
});

test('un handle duplicato da una corsa precedente collassa sull\'ID più basso', () => {
  const world = makeWorld({
    comments: [
      { id: 500, user: { login: ACTOR }, created_at: '2026-09-24T10:01:00Z', body: BODIES.attempt },
      { id: 501, user: { login: ACTOR }, created_at: '2026-09-24T10:02:00Z', body: BODIES.refunded },
      { id: 502, user: { login: ACTOR }, created_at: '2026-09-24T10:02:01Z', body: BODIES.refunded },
    ],
  });
  try {
    const result = runClassify(world);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.deepEqual(refundView(world.state()).handles, [501]);
  } finally {
    world.dispose();
  }
});

test('una risposta POST persa non duplica il tentativo né l\'handle', () => {
  const world = makeWorld({
    comments: [markerComment()],
    faults: [
      { on: 'post', match: 'REFUND_ATTEMPT', mode: 'lose-response', remaining: 1 },
      { on: 'post', match: `${BODIES.refundMarker}: 1`, mode: 'lose-response', remaining: 1 },
    ],
  });
  try {
    const result = runClassify(world);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assertConverged(world.state(), 'POST persa');
  } finally {
    world.dispose();
  }
});

test('il tentativo non scrivibile conserva il marker ed è rosso', () => {
  const world = makeWorld({
    comments: [markerComment()],
    faults: [{ on: 'post', match: 'REFUND_ATTEMPT', mode: 'fail', remaining: 99 }],
  });
  try {
    const result = runClassify(world);
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /::error::SUPERSEDED/);
    const view = refundView(world.state());
    assert.equal(view.markerPresent, true, 'nessuna DELETE senza un tentativo persistito');
    assert.equal(view.handles.length, 0);
  } finally {
    world.dispose();
  }
});

test('una DELETE fallita con marker ancora presente è rossa e non pubblica l\'handle', () => {
  const world = makeWorld({
    comments: [markerComment()],
    faults: [{ on: 'delete', match: String(MARKER_ID), mode: 'fail', remaining: 99 }],
  });
  try {
    const result = runClassify(world);
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    const view = refundView(world.state());
    assert.equal(view.markerPresent, true);
    assert.equal(view.handles.length, 0, 'un handle senza DELETE dichiarerebbe un falso rimborso');
  } finally {
    world.dispose();
  }
});

test('un marker sparito senza tentativo vincolato è rosso: il rimborso non è dimostrabile', () => {
  const world = makeWorld({ comments: [] });
  try {
    const result = runClassify(world);
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /assente senza tentativo di rimborso vincolato/);
    assert.equal(refundView(world.state()).handles.length, 0);
  } finally {
    world.dispose();
  }
});

test('un handle legato a un altro marker non conta come rimborso di questo round', () => {
  const other = supersededRefundBodies({ marker: MARKER, round: 1, commentId: 41 });
  const state = classifySupersededRefund({
    comments: [
      markerComment(),
      { id: 300, user: { login: ACTOR }, body: other.refunded },
      { id: 301, user: { login: 'someone-else' }, body: BODIES.refunded },
    ],
    marker: MARKER,
    round: 1,
    headSha: HEAD_SHA,
    bodySha: BODY_REVISION,
    expectedCommentId: MARKER_ID,
    expectedAuthor: ACTOR,
  });
  assert.equal(state.markerPresent, true);
  assert.deepEqual(state.handleIds, [], 'handle di un ciclo precedente o di un autore non trusted');
  assert.match(BODIES.refunded, /^<!-- REDCHECK_FIX_REFUNDED: 1 -->\n/,
    'lo stale-pr-rescuer riconosce il prefisso `<!-- REDCHECK_FIX_REFUNDED:`');
  assert.doesNotMatch(`${BODIES.attempt}\n${BODIES.refunded}`, /_FIX_ROUND: [0-9]/,
    'i commenti di rimborso non devono contare come round');
});

test('un commento con l\'ID del marker ma snapshot diverso blocca il rimborso', () => {
  assert.throws(() => classifySupersededRefund({
    comments: [{ ...markerComment(), body: markerComment().body.replace(BODY_REVISION, 'c'.repeat(64)) }],
    marker: MARKER,
    round: 1,
    headSha: HEAD_SHA,
    bodySha: BODY_REVISION,
    expectedCommentId: MARKER_ID,
    expectedAuthor: ACTOR,
  }), /non e' il marker/);
});

test('il classify non finalizza più il claim né degrada il rimborso a warning', () => {
  const classify = stepScript(CLASSIFY_NAME);
  const superseded = classify.slice(classify.indexOf('CLAIM_STATUS=released'), classify.indexOf('run SUPERSEDED'));
  assert.match(superseded, /--refund-superseded/);
  assert.match(superseded, /refund_marker="\$\{FIX_ROUND_MARKER%_ROUND\}_REFUNDED"/);
  assert.doesNotMatch(superseded, /redcheck-review-prefilter\.mjs --claim/,
    'il claim ha un solo writer: lo step Finalize');
  assert.doesNotMatch(superseded, /::warning::/, 'un rimborso non convergente è rosso, non un warning');
  const finalize = WORKFLOW.slice(WORKFLOW.indexOf(`      - name: ${FINALIZE_NAME}`));
  assert.doesNotMatch(finalize.slice(0, finalize.indexOf('run:')), /continue-on-error/,
    'il Finalize non può nascondere una finalizzazione non convergente');
});
