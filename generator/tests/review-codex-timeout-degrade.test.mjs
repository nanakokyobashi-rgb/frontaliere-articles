/**
 * Review Codex in timeout ripetuto sulla stessa PR+HEAD (F5, corpus #3812).
 *
 * Il watchdog interno (1800 s) scade senza output; la causa viene classificata
 * `cancelled` => failed-transient => retry IDENTICO (stesso effort `max`, stessi
 * turni) => scade di nuovo. Il contratto qui sotto:
 *   1. il watchdog finisce nel ledger con una causa PROPRIA (`codex_timeout`),
 *      ancora riattivabile;
 *   2. lo step `tier` la legge dal ledger (stessa PR+HEAD) e scende di effort;
 *   3. nessun'altra causa/HEAD/PR fa scendere l'effort;
 *   4. un ledger illeggibile NON degrada (si resta a review piena).
 * La funzione `set_tier` viene ESEGUITA dallo YAML, non cercata con un grep.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CODEX_TIMEOUT_CAUSE,
  claimStatusFromOutcome,
  latestReviewClaims,
  parseReviewClaim,
  priorCodexTimeouts,
  reviewClaimDedupeKey,
  reviewClaimKey,
} from '../../scripts/ci/review-claim.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WORKFLOW = fs.readFileSync(path.join(ROOT, '.github/workflows/tests.yml'), 'utf8');
const CLAIM_CLI = path.join(ROOT, 'scripts/ci/review-claim.mjs');
const HEAD = 'a'.repeat(40);
const OTHER_HEAD = 'b'.repeat(40);
const FINGERPRINT = 'c'.repeat(64);

function claim(overrides = {}) {
  const context = {
    prNumber: '3812',
    headSha: HEAD,
    eventKey: 'run:42',
    contributionFingerprint: FINGERPRINT,
  };
  return {
    version: 1,
    token: 'review-1',
    ...context,
    key: reviewClaimKey(context),
    dedupeKey: reviewClaimDedupeKey(context),
    state: 'failed-transient',
    cause: CODEX_TIMEOUT_CAUSE,
    issuedAt: 100,
    expiresAt: 3_700,
    runId: '77',
    ...overrides,
  };
}

function comment(event, id) {
  return {
    id,
    created_at: '1970-01-01T00:02:00Z',
    user: { login: 'github-actions[bot]' },
    body: `<!-- PR_REVIEW_CLAIM: ${JSON.stringify(event)} -->`,
  };
}

const claimsOf = (...events) => latestReviewClaims(events.map((event, index) => comment(event, index + 1)));

test('codex_timeout e\' una causa valida del ledger e il claim e\' riattivabile', () => {
  assert.equal(parseReviewClaim(comment(claim()).body)?.cause, CODEX_TIMEOUT_CAUSE);
  assert.equal(claimStatusFromOutcome({
    proceed: true, providerOutcome: 'failure', failureCause: CODEX_TIMEOUT_CAUSE, retryableFailure: true,
  }), 'failed-transient');
});

test('priorCodexTimeouts conta solo i timeout falliti sulla stessa PR+HEAD', () => {
  const timeout = claim();
  assert.equal(priorCodexTimeouts({ claims: claimsOf(timeout), prNumber: '3812', headSha: HEAD }), 1);
  // Due tentativi distinti (token diversi) = due timeout; un body corretto
  // (revisione diversa) non azzera il conto.
  const second = claim({
    token: 'review-2',
    eventKey: 'run:43',
    reviewRevision: `body:${'d'.repeat(64)}`,
    key: reviewClaimKey({ prNumber: '3812', headSha: HEAD, eventKey: 'run:43', contributionFingerprint: FINGERPRINT, reviewRevision: `body:${'d'.repeat(64)}` }),
    dedupeKey: reviewClaimDedupeKey({ prNumber: '3812', headSha: HEAD, eventKey: 'run:43', contributionFingerprint: FINGERPRINT, reviewRevision: `body:${'d'.repeat(64)}` }),
  });
  assert.equal(priorCodexTimeouts({ claims: claimsOf(timeout, second), prNumber: '3812', headSha: HEAD }), 2);
  // HEAD o PR diversa, causa diversa, claim attivo/completato: zero.
  assert.equal(priorCodexTimeouts({ claims: claimsOf(timeout), prNumber: '3812', headSha: OTHER_HEAD }), 0);
  assert.equal(priorCodexTimeouts({ claims: claimsOf(timeout), prNumber: '9999', headSha: HEAD }), 0);
  assert.equal(priorCodexTimeouts({ claims: claimsOf(claim({ cause: 'cancelled' })), prNumber: '3812', headSha: HEAD }), 0);
  assert.equal(priorCodexTimeouts({ claims: claimsOf(claim({ cause: 'max_turns' })), prNumber: '3812', headSha: HEAD }), 0);
  assert.equal(priorCodexTimeouts({ claims: claimsOf(claim({ state: 'active', cause: undefined })), prNumber: '3812', headSha: HEAD }), 0);
  assert.equal(priorCodexTimeouts({ claims: claimsOf(claim({ state: 'completed', cause: 'verdict_posted' })), prNumber: '3812', headSha: HEAD }), 0);
  assert.equal(priorCodexTimeouts({ claims: [], prNumber: 'x', headSha: 'y' }), 0);
});

test('lo stesso token conta una volta sola (l\'ultimo evento vince)', () => {
  const failed = claim();
  const retried = claim({ state: 'completed', cause: 'verdict_posted', issuedAt: 200 });
  const events = [comment(failed, 1), comment(retried, 2)];
  assert.equal(priorCodexTimeouts({ claims: latestReviewClaims(events), prNumber: '3812', headSha: HEAD }), 0);
});

/** Estrae `set_tier` dallo YAML (stesso metodo di review-effort-per-tier). */
function extractSetTier() {
  const start = WORKFLOW.indexOf('          set_tier() {');
  assert.notEqual(start, -1);
  const end = WORKFLOW.indexOf('\n          }\n', start);
  return WORKFLOW.slice(start, end + '\n          }'.length)
    .split('\n').map((line) => line.replace(/^ {10}/, '')).join('\n');
}

function runSetTier({ tier, turns, prior }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-timeout-degrade-'));
  try {
    const out = path.join(dir, 'out');
    fs.writeFileSync(out, '');
    const priorLine = prior === undefined ? '' : `prior_timeouts=${prior}\n`;
    execFileSync('bash', ['-c',
      `set -euo pipefail\nGITHUB_OUTPUT=${JSON.stringify(out)}\n${priorLine}${extractSetTier()}\nset_tier ${tier} gpt-5.6-luna ${turns}\n`,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    return Object.fromEntries(fs.readFileSync(out, 'utf8').trim().split('\n').map((l) => l.split('=')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('senza timeout precedenti il tier e\' invariato (high resta max/60)', () => {
  assert.deepEqual(
    { e: runSetTier({ tier: 'high', turns: 60 }).effort, t: runSetTier({ tier: 'high', turns: 60 }).max_turns },
    { e: 'max', t: '60' },
  );
  assert.equal(runSetTier({ tier: 'high', turns: 60, prior: 0 }).effort, 'max');
});

test('dopo un timeout sulla stessa HEAD il retry scende a effort high, stesso scope', () => {
  for (const tier of ['high', 'high-mega']) {
    const out = runSetTier({ tier, turns: tier === 'high' ? 60 : 120, prior: 1 });
    assert.equal(out.tier, tier, 'lo scope della review non cambia');
    assert.equal(out.effort, 'high');
    assert.equal(out.max_turns, tier === 'high' ? '60' : '120', 'al primo timeout il tetto turni non cambia');
    assert.equal(out.prior_codex_timeouts, '1');
  }
});

test('dopo due timeout scende anche il tetto turni; minimal e tests-only restano', () => {
  assert.equal(runSetTier({ tier: 'high', turns: 60, prior: 2 }).max_turns, '35');
  assert.equal(runSetTier({ tier: 'high-mega', turns: 120, prior: 3 }).max_turns, '35');
  assert.equal(runSetTier({ tier: 'normal', turns: 35, prior: 2 }).max_turns, '35');
  assert.equal(runSetTier({ tier: 'minimal', turns: 12, prior: 2 }).max_turns, '12');
  assert.equal(runSetTier({ tier: 'tests-only', turns: 0, prior: 2 }).max_turns, '0');
});

test('lo step tier legge il ledger con --prior-timeout, fail-open sul review pieno', () => {
  assert.match(WORKFLOW, /node scripts\/ci\/review-claim\.mjs --prior-timeout/u);
  assert.match(WORKFLOW, /case "\$\{prior_timeouts:-\}" in ''\|\*\[!0-9\]\*\) prior_timeouts=0 ;; esac/u);
});

test('il watchdog finisce nel ledger come codex_timeout, la cancellazione del runner no', () => {
  const start = WORKFLOW.indexOf("if [ \"$CLASSIFICATION_CAUSE\" = 'cancelled' ]; then");
  assert.notEqual(start, -1);
  const block = WORKFLOW.slice(start, WORKFLOW.indexOf('\n          fi\n', start));
  assert.match(block, /\.source \/\/ empty[\s\S]*?= 'watchdog'[\s\S]*?review_abort_cause codex_timeout/u);
  assert.match(block, /else\s+set_review_output review_abort_cause cancelled/u);
  assert.match(block, /retryable_failure true/u);
});

test('CLI --prior-timeout: conta dal ledger via gh e scrive l\'output', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-timeout-cli-'));
  try {
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    const comments = path.join(dir, 'comments.json');
    fs.writeFileSync(comments, JSON.stringify([[comment(claim(), 1)]]));
    fs.writeFileSync(path.join(bin, 'gh'), `#!/usr/bin/env bash\ncat ${JSON.stringify(comments)}\n`, { mode: 0o755 });
    const out = path.join(dir, 'out');
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, GH_REPO: 'o/r', PR_NUMBER: '3812', HEAD_SHA: HEAD, GITHUB_OUTPUT: out };
    const stdout = execFileSync('node', [CLAIM_CLI, '--prior-timeout'], { env, encoding: 'utf8' });
    assert.match(stdout, /^prior_codex_timeouts=1$/m);
    assert.match(fs.readFileSync(out, 'utf8'), /^prior_codex_timeouts=1$/m);
    // Ledger illeggibile: 0 + warning, mai un fallimento che degradi o blocchi.
    fs.writeFileSync(comments, 'non-json');
    const failOpen = execFileSync('node', [CLAIM_CLI, '--prior-timeout'], { env, encoding: 'utf8' });
    assert.match(failOpen, /^prior_codex_timeouts=0$/m);
    assert.match(failOpen, /::warning::/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
