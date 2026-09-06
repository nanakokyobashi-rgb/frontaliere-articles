/**
 * vitest-check-job-attempt.test.mjs — il one-shot del review gate non si
 * decide sugli step di un attempt superato.
 *
 * `pr-autorebase.mjs` concede UNA riapertura quando il rosso del check
 * richiesto e' lo step `Require approving Claude review` e non i test
 * (`vitestFailureIsReviewGate`). Il discriminante sono gli step del JOB di
 * Actions, e l'unico puntatore al job che la check-runs API espone e' il
 * `details_url` del check-run.
 *
 * Quel puntatore non e' datato: dopo un «Re-run failed jobs» — o su qualunque
 * run con `run_attempt > 1` — il job id che ne esce puo' descrivere l'attempt
 * PRECEDENTE, e `GET /actions/jobs/{id}` risponde comunque, con la lista di
 * step di un'altra esecuzione. Entrambi gli errori costano: concedere il
 * one-shot quando il rosso corrente sono i test brucia una `tests` intera
 * (~18min) su una coda serializzata; negarlo quando il rosso corrente e' solo
 * il gate lascia la PR ferma e le fa dire «far passare i test» coi test verdi.
 *
 * `currentAttemptJobSteps` chiude il buco con l'unico dato esatto disponibile:
 * i job dell'attempt corrente (`filter=latest`). O il job e' li' dentro, o gli
 * step sono stantii e si torna al fail-CLOSED.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  jobRefFromCheckRun,
  currentAttemptJobSteps,
  vitestFailureIsReviewGate,
  REVIEW_GATE_STEP_NAME,
} from '../../scripts/ci/lib/vitestCheck.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const HEAD = 'a'.repeat(40);
/** Il check-run vitest selezionato sull'head: rosso, con il link al suo job. */
const checkRun = {
  name: 'tests (node --test)',
  status: 'completed',
  conclusion: 'failure',
  head_sha: HEAD,
  completed_at: '2026-09-06T10:00:00Z',
  details_url: 'https://github.com/o/r/actions/runs/1234/job/5678',
};

/** Un job dell'attempt corrente, rosso per il solo review gate. */
const gateOnlyJob = {
  id: 5678,
  status: 'completed',
  conclusion: 'failure',
  head_sha: HEAD,
  steps: [
    { name: 'Checkout', conclusion: 'success' },
    { name: 'node --test', conclusion: 'success' },
    { name: REVIEW_GATE_STEP_NAME, conclusion: 'failure' },
  ],
};

test('jobRefFromCheckRun estrae run id E job id dal details_url', () => {
  assert.deepEqual(jobRefFromCheckRun(checkRun), { runId: '1234', jobId: '5678' });
});

test('jobRefFromCheckRun: null se il link manca o non e\' un job di Actions', () => {
  assert.equal(jobRefFromCheckRun(null), null);
  assert.equal(jobRefFromCheckRun({}), null);
  assert.equal(jobRefFromCheckRun({ details_url: 'https://example.test/x' }), null);
  // Senza il run id non si puo' chiedere l'attempt corrente: il vecchio
  // pattern `/job/(\d+)` accettava questa forma, il nuovo no.
  assert.equal(jobRefFromCheckRun({ details_url: 'https://github.com/o/r/job/5678' }), null);
});

test('il job dell\'attempt corrente da\' i suoi step', () => {
  const steps = currentAttemptJobSteps({ checkRun, jobId: '5678', jobs: [gateOnlyJob] });
  assert.deepEqual(steps, gateOnlyJob.steps);
  assert.equal(vitestFailureIsReviewGate(steps), true);
});

test('job di un attempt SUPERATO: non e\' fra i latest -> [] (fail-closed)', () => {
  // «Re-run failed jobs»: l'attempt 2 ha un job NUOVO (id 9999) e i test
  // rossi; il details_url del check-run selezionato punta ancora al 5678
  // dell'attempt 1, che era rosso per il solo review gate.
  const latest = [{
    id: 9999,
    status: 'completed',
    conclusion: 'failure',
    head_sha: HEAD,
    steps: [
      { name: 'node --test', conclusion: 'failure' },
      { name: REVIEW_GATE_STEP_NAME, conclusion: 'failure' },
    ],
  }];
  const steps = currentAttemptJobSteps({ checkRun, jobId: '5678', jobs: latest });
  assert.deepEqual(steps, []);
  // Il punto: senza la verifica si sarebbe concesso il one-shot su un rosso
  // che nell'attempt corrente sono i TEST.
  assert.equal(vitestFailureIsReviewGate(steps), false);
  assert.equal(vitestFailureIsReviewGate(gateOnlyJob.steps), true);
});

test('job ancora in corso o con verdetto diverso dal check-run -> []', () => {
  assert.deepEqual(
    currentAttemptJobSteps({
      checkRun, jobId: '5678',
      jobs: [{ ...gateOnlyJob, status: 'in_progress', conclusion: null }],
    }),
    [], 'una lista di step parziale non dimostra niente');
  assert.deepEqual(
    currentAttemptJobSteps({
      checkRun, jobId: '5678', jobs: [{ ...gateOnlyJob, conclusion: 'success' }],
    }),
    [], 'job verde e check-run rosso: due esecuzioni diverse');
  assert.deepEqual(
    currentAttemptJobSteps({
      checkRun, jobId: '5678', jobs: [{ ...gateOnlyJob, head_sha: 'b'.repeat(40) }],
    }),
    [], 'il job descrive un altro commit');
  assert.deepEqual(
    currentAttemptJobSteps({
      checkRun: { ...checkRun, conclusion: '' }, jobId: '5678', jobs: [gateOnlyJob],
    }),
    [], 'check-run senza conclusion: niente su cui verificare la coerenza');
});

test('input mancanti o non-array -> [] (la chiamata gh puo\' fallire)', () => {
  assert.deepEqual(currentAttemptJobSteps({ checkRun, jobId: '5678', jobs: null }), []);
  assert.deepEqual(currentAttemptJobSteps({ checkRun: null, jobId: '5678', jobs: [gateOnlyJob] }), []);
  assert.deepEqual(currentAttemptJobSteps({ checkRun, jobId: null, jobs: [gateOnlyJob] }), []);
  assert.deepEqual(
    currentAttemptJobSteps({ checkRun, jobId: '5678', jobs: [{ ...gateOnlyJob, steps: undefined }] }),
    []);
});

test('pr-autorebase chiede i job dell\'attempt corrente, non /actions/jobs/<id>', () => {
  const script = fs.readFileSync(path.join(ROOT, 'scripts/ci/pr-autorebase.mjs'), 'utf8');
  assert.match(script, /actions\/runs\/\$\{ref\.runId\}\/jobs\?filter=latest/,
    'il fetch degli step deve passare per la lista filter=latest del run');
  assert.ok(!/actions\/jobs\/\$\{/.test(script),
    '`/actions/jobs/<id>` risponde anche per un attempt superato: non e\' un oracolo di freschezza');
  assert.match(script, /currentAttemptJobSteps\(/,
    'gli step devono passare dalla verifica di attempt/identita\'');
});
