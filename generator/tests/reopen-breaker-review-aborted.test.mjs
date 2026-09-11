/**
 * reopen-breaker-review-aborted.test.mjs — il one-shot del review gate non si
 * nega quando il secondo step rosso E' la morte della review.
 *
 * ## Il difetto che chiude (follow-up #975, item 1)
 *
 * `vitestFailureIsReviewGate` rispondeva `false` appena un SECONDO step del job
 * risultava `failure`, sul presupposto che un altro rosso significhi «ci sono
 * test rotti sotto». Il presupposto vale finche' ogni altro step giudica il
 * CODICE. Uno non lo fa: `Fail on transient API error (no review posted)`
 * fallisce quando `claude-code-action` e' morta — turni esauriti,
 * `outcome=failure`, 5xx — SENZA postare un verdetto.
 *
 * In quello stato la co-occorrenza col gate non e' un indizio, e' una
 * CONSEGUENZA: nessuna review postata ⇒ nessun `## LGTM` sulla HEAD ⇒
 * `Require approving Claude review` (che gira con `always()`) fallisce per
 * costruzione. I test sono verdi, e lo step morto scrive lui stesso sulla PR
 * «rilancia il run di `tests` piu' recente». Il one-shot veniva pero' negato
 * proprio li', e lo sticky diceva «far passare i test» a una PR coi test
 * verdi: il one-shot negato in silenzio del titolo della issue.
 *
 * ## Perche' una whitelist di UN nome e non un allentamento
 *
 * Misura sulle ultime 60 run `tests` fallite (2026-09-06): 43 hanno il review
 * gate rosso, e in ZERO di esse un secondo step e' fallito. `Generator CI
 * gate` e' fallito 2 volte, entrambe insieme a `Unit + closure gates` — cioe'
 * su codice davvero rotto, dove negare il one-shot e' GIUSTO (un re-trigger
 * non ripara `generator-ci`). La co-occorrenza generica e' l'eccezione; quella
 * strutturale e' solo la morte della review. Gli ultimi due test qui sotto
 * pinnano che il resto sia rimasto fail-CLOSED.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REVIEW_GATE_STEP_NAME,
  CLAUDE_REVIEW_STEP_NAME,
  REVIEW_ABORT_STEP_NAME,
  REVIEW_GATE_FAILURE_STEP_NAME,
  reviewAbortedWithoutVerdict,
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

/**
 * Review morta senza postare: lo step di abort e il gate rossi INSIEME.
 *
 * `Run Claude review` ha `continue-on-error: true`, e la `conclusion` che la
 * jobs API riporta e' quella DOPO l'applicazione del flag — quindi `success`
 * anche quando l'action e' morta (e' per questo che lo step di abort classifica
 * su `steps.claude_review.outcome`). Si coprono ENTRAMBE le forme: il
 * discriminante non deve dipendere da quel dettaglio.
 */
const reviewDied = (claudeStepConclusion) => [
  step('Set up job', 'success'),
  step('Unit + closure gates (i gate sul contenuto girano altrove)', 'success'),
  step(CLAUDE_REVIEW_STEP_NAME, claudeStepConclusion),
  step(REVIEW_ABORT_STEP_NAME, 'failure'),
  step(REVIEW_GATE_STEP_NAME, 'failure'),
  step(REVIEW_GATE_FAILURE_STEP_NAME, 'failure'),
];
const REVIEW_DIED = reviewDied('success');
/** Rosso di gate puro: la review e' girata, il verdetto e' negativo. */
const GATE_ONLY = [
  step('Set up job', 'success'),
  step(CLAUDE_REVIEW_STEP_NAME, 'success'),
  step(REVIEW_ABORT_STEP_NAME, 'success'),
  step(REVIEW_GATE_STEP_NAME, 'failure'),
  step(REVIEW_GATE_FAILURE_STEP_NAME, 'failure'),
];
/** Gate rosso + `Generator CI gate` rosso: li' sotto c'e' codice rotto. */
const GATE_PLUS_GENERATOR_CI = [
  step('Set up job', 'success'),
  step(REVIEW_GATE_STEP_NAME, 'failure'),
  step('Generator CI gate (solo per le PR che ne toccano i path)', 'failure'),
];

describe('il segnale: due step rossi, un rosso solo', () => {
  test('review morta → resta un rosso di review gate, non «test rotti sotto»', () => {
    assert.equal(vitestFailureIsReviewGate(REVIEW_DIED), true);
    assert.equal(reviewAbortedWithoutVerdict(REVIEW_DIED), true);
    // Ortogonale allo skip del guard: li' la review non e' partita, qui e'
    // partita ed e' morta. I due segnali non devono confondersi.
    assert.equal(reviewSkippedByGuard(REVIEW_DIED), false);
  });

  test('vale anche se la jobs API riporta rosso lo step della review', () => {
    const died = reviewDied('failure');
    assert.equal(vitestFailureIsReviewGate(died), true);
    assert.equal(reviewAbortedWithoutVerdict(died), true);
  });

  test('rosso di gate puro → nessun abort da nominare', () => {
    assert.equal(vitestFailureIsReviewGate(GATE_ONLY), true);
    assert.equal(reviewAbortedWithoutVerdict(GATE_ONLY), false);
    // Il ramo 429 lascia l'abort verde per non amplificare il rate-limit:
    // non e' uno skip del guard e il one-shot resta concesso.
    assert.equal(reviewSkippedByGuard(GATE_ONLY), false);
  });

  test('fail-CLOSED: qualunque ALTRO secondo step rosso nega ancora', () => {
    // `Generator CI gate` rosso significa `generator-ci` rosso: un re-trigger
    // non lo ripara, e negare il one-shot li' e' la decisione giusta.
    assert.equal(vitestFailureIsReviewGate(GATE_PLUS_GENERATOR_CI), false);
    assert.equal(
      vitestFailureIsReviewGate([
        step('Unit + closure gates (i gate sul contenuto girano altrove)', 'failure'),
        step(REVIEW_GATE_STEP_NAME, 'failure'),
      ]),
      false,
    );
  });

  test('fail-CLOSED: senza il gate rosso l abort non deduce niente', () => {
    // Lista vuota, stantia, o un abort rosso su un gate che non e' fallito
    // (job gia' verde al ritentativo): nessuna esenzione su un dubbio.
    assert.equal(reviewAbortedWithoutVerdict([]), false);
    assert.equal(reviewAbortedWithoutVerdict(null), false);
    assert.equal(
      reviewAbortedWithoutVerdict([
        step(REVIEW_ABORT_STEP_NAME, 'failure'),
        step(REVIEW_GATE_STEP_NAME, 'success'),
      ]),
      false,
    );
    // Gate rosso ma nessuno step di abort nella lista (workflow rinominato):
    // il rosso torna a essere un gate normale, non un abort.
    assert.equal(reviewAbortedWithoutVerdict([step(REVIEW_GATE_STEP_NAME, 'failure')]), false);
  });
});

describe('la decisione: il one-shot si concede, e la causa e nominata', () => {
  const green = { additions: 1, deletions: 0, changedFiles: 1, reviewCount: 0 };
  const redFp = reopenFingerprint({ ...green, vitestConclusion: 'failure' });

  test('review morta → riciclo concesso con la causa giusta', () => {
    const d = decideReopen({
      vitestConclusion: 'failure', fingerprint: redFp, prior: null,
      failureNotAttributable: 'review-gate', reviewGateFailure: true, reviewAborted: true,
    });
    assert.equal(d.action, 'reopen');
    assert.equal(d.cause, 'review-gate-aborted');
    assert.match(d.reason, /morta senza postare/);
  });

  test('rate-limit con abort verde → one-shot concesso, non review-gate-skipped', () => {
    const d = decideReopen({
      vitestConclusion: 'failure', fingerprint: redFp, prior: null,
      failureNotAttributable: 'review-gate', reviewGateFailure: true,
    });
    assert.equal(d.action, 'reopen');
    assert.equal(d.cause, 'review-gate');
  });

  test('one-shot gia speso → niente riciclo, ma il messaggio resta vero', () => {
    const d = decideReopen({
      vitestConclusion: 'failure', fingerprint: redFp, prior: null,
      reviewGateFailure: true, reviewAborted: true,
    });
    assert.equal(d.action, 'skip-failing-check');
    assert.equal(d.cause, 'review-gate-aborted');
    assert.match(d.reason, /i test sono verdi/);
    assert.doesNotMatch(d.reason, /Serve far passare i test/);
  });

  test('lo skip del guard ha la precedenza: li il re-trigger e un no-op', () => {
    // I due stati sono disgiunti nel workflow (a review saltata lo step di
    // abort e' `skipped`), ma se mai arrivassero insieme la cura piu'
    // conservativa e' quella del guard: NON concedere.
    const d = decideReopen({
      vitestConclusion: 'failure', fingerprint: redFp, prior: null,
      reviewGateFailure: true, reviewSkippedByGuard: true, reviewAborted: true,
    });
    assert.equal(d.cause, 'review-gate-skipped');
  });

  test('nessuna regressione sui due rossi gia coperti', () => {
    const gate = decideReopen({
      vitestConclusion: 'failure', fingerprint: redFp, prior: null,
      failureNotAttributable: 'review-gate', reviewGateFailure: true,
    });
    assert.equal(gate.cause, 'review-gate');
    const tests = decideReopen({
      vitestConclusion: 'failure', fingerprint: redFp, prior: null,
    });
    assert.equal(tests.cause, 'tests');
    assert.match(tests.reason, /Serve far passare i test/);
  });
});

describe('il messaggio: non mandare a chiudere un finding mai scritto', () => {
  const green = { additions: 1, deletions: 0, changedFiles: 1, reviewCount: 0 };
  const fp = reopenFingerprint({ ...green, vitestConclusion: 'failure' });
  const render = (cause, action = 'skip-failing-check') => renderReopenBudget({
    count: 1, max: DEFAULT_MAX_REOPENS, fingerprint: fp, action, reason: 'x', cause,
  });

  for (const action of ['skip-failing-check', 'skip-breaker']) {
    test(`(${action}) lo sticky dice «la review e morta», non «far passare i test»`, () => {
      const body = render('review-gate-aborted', action);
      assert.match(body, /review Claude che arrivi in fondo/);
      assert.match(body, /morta prima di postare|morte prima di postare|morte prima di postare/);
      assert.doesNotMatch(
        body,
        /\*\*far passare/,
        'e\' esattamente il messaggio sbagliato dell\'item 1 della #975: i test sono verdi.',
      );
    });
  }

  test('la causa sconosciuta ricade ancora sul messaggio dei test', () => {
    // Il ramo di default non deve sparire: un rosso davvero dei test continua
    // a mandare l'operatore a farli passare.
    assert.match(render('tests'), /\*\*far passare/);
  });
});

describe('WIRING: la decisione vera legge davvero il segnale', () => {
  test('guardedReopen calcola l abort e lo passa a decideReopen', () => {
    assert.match(script, /reviewAbortedWithoutVerdict\(steps\)/);
    assert.match(script, /reviewAborted,/);
  });

  test('una sola lettura degli step del job per tutte e tre le domande', () => {
    // La DICHIARAZIONE (`function vitestJobSteps(head)`) non e' una lettura.
    const calls = (script.match(/(?<!function\s)vitestJobSteps\(head\)/g) || []).length;
    assert.equal(calls, 1);
  });
});
