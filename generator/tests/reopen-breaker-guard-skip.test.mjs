/**
 * reopen-breaker-guard-skip.test.mjs — il one-shot del review gate non si
 * spende quando la review non e' nemmeno girata.
 *
 * ## Il difetto che chiude (follow-up #975, item 3)
 *
 * Il one-shot del review gate si regge su una premessa esplicita, scritta nel
 * `reason` di `decideReopen`: «la review e' gia' girata e il verdetto manca o e'
 * negativo, quindi il re-trigger e' proprio cio' che ne produce uno nuovo».
 *
 * Quella premessa cade in uno stato preciso: il `Re-review guard` di
 * `tests.yml` ha SALTATO Claude (delta dall'ultima `## LGTM` di soli file
 * non-code, oppure fingerprint del contributo invariato) e lo step
 * `Require approving Claude review` — che gira con `always()` — e' fallito lo
 * stesso sui verdetti gia' postati. Li' il close+reopen e' un no-op per
 * costruzione: `tests.yml` riparte, il guard rivaluta lo stesso contributo (il
 * merge di `main` pushato dall'autorebase non lo cambia: e' 3-dot contro la
 * merge-base), salta di nuovo, e il gate fallisce identico. Si bruciano il
 * one-shot e una `tests` intera per tornare dov'era — e lo sticky prometteva
 * all'operatore un effetto che su quella PR non si verifica.
 *
 * Le asserzioni qui sotto coprono le tre facce dello stesso difetto: il
 * segnale (`reviewSkippedByGuard`), la decisione (il one-shot negato) e il
 * messaggio (nessuna promessa falsa nello sticky).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  REVIEW_GATE_STEP_NAME,
  CLAUDE_REVIEW_STEP_NAME,
  reviewSkippedByGuard,
  vitestFailureIsReviewGate,
} from '../../scripts/ci/lib/vitestCheck.mjs';
import {
  DEFAULT_MAX_REOPENS,
  reopenFingerprint,
  decideReopen,
  renderReopenBudget,
} from '../../scripts/ci/lib/reopen-breaker.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const script = fs.readFileSync(path.join(ROOT, 'scripts/ci/pr-autorebase.mjs'), 'utf8');

const step = (name, conclusion) => ({ name, conclusion });
/** Gli step di un job rosso per il SOLO review gate, con la review girata. */
const GATE_RED_REVIEW_RAN = [
  step('Set up job', 'success'),
  step(CLAUDE_REVIEW_STEP_NAME, 'success'),
  step(REVIEW_GATE_STEP_NAME, 'failure'),
];
/** Lo stesso rosso, ma con la review SALTATA dal `Re-review guard`. */
const GATE_RED_REVIEW_SKIPPED = [
  step('Set up job', 'success'),
  step('Re-review guard (skip Claude when no code changed since last LGTM)', 'success'),
  step(CLAUDE_REVIEW_STEP_NAME, 'skipped'),
  step(REVIEW_GATE_STEP_NAME, 'failure'),
];

describe('il segnale: la review e girata su questa run?', () => {
  test('gate rosso + review skipped → il guard l ha saltata', () => {
    assert.equal(reviewSkippedByGuard(GATE_RED_REVIEW_SKIPPED), true);
    // Resta comunque un rosso di review gate: le due domande sono ortogonali.
    assert.equal(vitestFailureIsReviewGate(GATE_RED_REVIEW_SKIPPED), true);
  });

  test('gate rosso + review girata → premessa del one-shot intatta', () => {
    assert.equal(reviewSkippedByGuard(GATE_RED_REVIEW_RAN), false);
  });

  test('gate NON rosso → nessuna deduzione, qualunque sia la review', () => {
    // Senza il rosso del gate lo skip della review e' irrilevante (PR esente,
    // job verde): dedurne qualcosa toglierebbe il one-shot a stati sani.
    const green = [step(CLAUDE_REVIEW_STEP_NAME, 'skipped'), step(REVIEW_GATE_STEP_NAME, 'success')];
    assert.equal(reviewSkippedByGuard(green), false);
  });

  test('fail-CLOSED: lista vuota, stantia o senza lo step della review → false', () => {
    assert.equal(reviewSkippedByGuard([]), false);
    assert.equal(reviewSkippedByGuard(null), false);
    // Lo step della review non c'e' (workflow rinominato, lista di un altro
    // job): non si nega il one-shot sulla base di un dubbio.
    assert.equal(reviewSkippedByGuard([step(REVIEW_GATE_STEP_NAME, 'failure')]), false);
  });
});

describe('la decisione: il one-shot non si spende su un no-op', () => {
  const green = { additions: 1, deletions: 0, changedFiles: 1, reviewCount: 0 };
  const redFp = reopenFingerprint({ ...green, vitestConclusion: 'failure' });

  test('review saltata → niente riciclo, e la causa e nominata per quello che e', () => {
    const d = decideReopen({
      vitestConclusion: 'failure', fingerprint: redFp, prior: null,
      reviewGateFailure: true, reviewSkippedByGuard: true,
    });
    assert.equal(d.action, 'skip-failing-check');
    assert.equal(d.cause, 'review-gate-skipped');
    assert.match(d.reason, /Re-review guard/);
    assert.doesNotMatch(d.reason, /Serve far passare i test/);
  });

  test('review girata → il one-shot resta concesso (nessuna regressione)', () => {
    // Il chiamante passa `failureNotAttributable: 'review-gate'` solo in quel
    // caso: e' il ramo che questa PR NON deve toccare.
    const d = decideReopen({
      vitestConclusion: 'failure', fingerprint: redFp, prior: null,
      failureNotAttributable: 'review-gate', reviewGateFailure: true,
    });
    assert.equal(d.action, 'reopen');
    assert.equal(d.cause, 'review-gate');
  });
});

describe('il messaggio: niente promesse che su quella PR non si avverano', () => {
  const green = { additions: 1, deletions: 0, changedFiles: 1, reviewCount: 0 };
  const fp = reopenFingerprint({ ...green, vitestConclusion: 'failure' });

  const render = (cause, action = 'skip-failing-check') => renderReopenBudget({
    count: 1, max: DEFAULT_MAX_REOPENS, fingerprint: fp, action, reason: 'x', cause,
  });

  test('a review saltata lo sticky NON promette che il close+reopen la ri-esegue', () => {
    const body = render('review-gate-skipped');
    assert.doesNotMatch(
      body,
      /close\+reopen manuale\) ri-esegue la review/,
      'lo sticky promette un re-trigger che il `Re-review guard` annullerebbe: e\' ' +
        'esattamente l\'item 3 della follow-up #975.',
    );
    assert.match(body, /commit che cambi il codice/);
    assert.match(body, /Re-review guard/);
  });

  test('a review girata la promessa resta, perche li e vera', () => {
    assert.match(render('review-gate').concat(''), /ri-esegue la review/);
  });

  test('anche a breaker aperto il consiglio segue lo stato del guard', () => {
    const skipped = render('review-gate-skipped', 'skip-breaker');
    assert.doesNotMatch(skipped, /close\+reopen\s*\n?\s*manuale ri-triggera review\+tests/);
    assert.match(skipped, /Re-review guard/);
    const ran = render('review-gate', 'skip-breaker');
    assert.match(ran, /close\+reopen/);
  });
});

describe('WIRING: la decisione vera legge davvero il segnale', () => {
  // La logica pura passa anche se il call-site non la chiama: e' il difetto
  // classico del one-shot «solo a parole» gia' pinnato in
  // pr-autorebase-reopen-breaker.test.mjs.
  test('guardedReopen calcola lo skip e lo passa a decideReopen', () => {
    assert.match(script, /reviewSkippedByGuard\(steps\)/);
    assert.match(script, /reviewSkippedByGuard:\s*reviewSkipped/);
  });

  test('con la review saltata il one-shot non viene concesso', () => {
    assert.match(script, /reviewGateRed\s*&&\s*!reviewSkipped\s*&&/);
  });

  test('una sola lettura degli step del job per entrambe le domande', () => {
    // Due fetch della stessa lista costerebbero due chiamate API e, peggio,
    // potrebbero descrivere due attempt diversi (la classe dell'item 2).
    // La DICHIARAZIONE (`function vitestJobSteps(head)`) non e' una lettura:
    // contarla renderebbe il test rosso su un call-site solo, cioe' proprio
    // sulla forma corretta.
    const calls = (script.match(/(?<!function\s)vitestJobSteps\(head\)/g) || []).length;
    assert.equal(calls, 1);
  });
});
