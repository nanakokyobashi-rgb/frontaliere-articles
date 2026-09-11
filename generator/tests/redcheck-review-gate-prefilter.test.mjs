/**
 * Redcheck deve scartare prima di Claude il rosso che appartiene solo al
 * verdetto della review. Il job `tests` porta quel segnale nei propri step:
 * non serve rileggere log o PR, e il fixer del codice non deve sovrapporsi al
 * redflag-fixer.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CLAUDE_REVIEW_STEP_NAME,
  NON_GATING_REVIEW_STEPS,
  REVIEW_GATE_STEP_NAME,
} from '../../scripts/ci/lib/vitestCheck.mjs';
import { reviewOnlyFailure } from '../../scripts/ci/redcheck-review-prefilter.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WORKFLOW = path.join(ROOT, '.github/workflows/pr-redcheck-fixer.yml');
const source = fs.readFileSync(WORKFLOW, 'utf8');

function preflightBlock() {
  const start = source.indexOf('- name: PR azionabile, e il rosso e\' ancora quello della HEAD?');
  const end = source.indexOf('\n\n  redcheck-fix:', start);
  assert.notEqual(start, -1, 'lo step preflight non e\' stato trovato');
  assert.notEqual(end, -1, 'il job redcheck-fix non e\' stato trovato');
  return source.slice(start, end);
}

function preflightJob() {
  const start = source.indexOf('\n  preflight:\n');
  const end = source.indexOf('\n\n  redcheck-fix:', start);
  assert.notEqual(start, -1, 'il job preflight non e\' stato trovato');
  assert.notEqual(end, -1, 'il job redcheck-fix non e\' stato trovato');
  return source.slice(start, end);
}

test('il preflight ha sul disco l helper che decide il prefilter', () => {
  const job = preflightJob();

  assert.match(
    job,
    /uses: actions\/checkout@v5[\s\S]*sparse-checkout: scripts\/ci/,
    'senza checkout di scripts/ci l helper esce con ERR_MODULE_NOT_FOUND e il prefilter e\' un ramo morto',
  );
  assert.ok(
    job.indexOf('uses: actions/checkout@v5') < job.indexOf('redcheck-review-prefilter.mjs'),
    'il checkout deve precedere lo step che invoca l helper',
  );
  assert.doesNotMatch(
    job,
    /redcheck-review-prefilter\.mjs 2>\/dev\/null/,
    'un helper rotto deve restare visibile, non collassare in un false silenzioso',
  );
  assert.match(
    job,
    /::warning::[^\n]*prefilter[^\n]*percorso normale mantenuto/,
    'exit != 0 dell helper deve emettere un warning e mantenere il percorso normale',
  );
});

test('redcheck filtra il rosso di sola review prima di spendere Claude', () => {
  const block = preflightBlock();

  assert.match(
    block,
    /actions\/runs\/\$RUN_ID\/jobs\?per_page=100[\s\S]*--paginate[\s\S]*--slurp/,
    'il preflight deve leggere gli step del run tests fallito, non solo il rollup dei check',
  );
  assert.match(
    block,
    /pulls\/\$PR\/reviews[\s\S]*--paginate[\s\S]*--slurp/,
    'il preflight deve verificare che una review reale sia stata postata sulla PR',
  );
  assert.match(
    block,
    /failed_checks[\s\S]*tests \(node --test\)/,
    'il filtro non deve ignorare un altro check rosso della stessa HEAD',
  );
  assert.match(
    block,
    /check_runs_readable[\s\S]*prefilter review-only disabilitato[\s\S]*percorso normale mantenuto/,
    'un errore della check-runs API deve disabilitare solo il prefilter, non trasformarsi in uno skip',
  );
  assert.match(
    block,
    /redcheck-review-prefilter\.mjs/,
    'la decisione deve passare dall helper che usa le costanti condivise',
  );
  assert.match(
    block,
    /review_only.*true|true.*review_only/s,
    'il filtro deve produrre una decisione deterministica review-only',
  );
  assert.match(
    block,
    /review_only[^\n]*true[\s\S]*skip[\s\S]*(?:review|Claude)/,
    'un rosso di sola review deve uscire dal preflight senza invocare Claude del fixer',
  );
});

test('l helper importa i nomi degli step e il matcher dei finding condivisi', async () => {
  const helper = await import('../../scripts/ci/redcheck-review-prefilter.mjs');
  assert.equal(typeof helper.reviewOnlyFailure, 'function');
  const helperSource = fs.readFileSync(
    path.join(ROOT, 'scripts/ci/redcheck-review-prefilter.mjs'),
    'utf8',
  );
  assert.match(helperSource, /REVIEW_GATE_STEP_NAME/);
  assert.match(helperSource, /CLAUDE_REVIEW_STEP_NAME/);
  assert.match(helperSource, /NON_GATING_REVIEW_STEPS/);
  assert.match(helperSource, /REDFLAG_IMPORTANT_RE/);
  assert.match(helperSource, /REVIEWER_BOT_LOGIN_RE/);
});

const HEAD = 'a'.repeat(40);
const jobs = (extra = []) => [{
  name: 'tests (node --test)',
  steps: [
    { name: REVIEW_GATE_STEP_NAME, conclusion: 'failure' },
    { name: CLAUDE_REVIEW_STEP_NAME, conclusion: 'success' },
    ...extra,
  ],
}];
const review = (body, commit_id = HEAD) => ({
  user: { type: 'Bot', login: 'claude[bot]' },
  commit_id,
  body,
});

test('il predicato richiede un finding reale sulla HEAD, non la conclusion dello step', () => {
  assert.equal(
    reviewOnlyFailure({
      headSha: HEAD,
      jobs: [{ jobs: jobs() }],
      reviews: [[review('`x.mjs:1`: 🔴 Important: il gate manca.')]],
    }),
    true,
  );
  const skippedReviewJobs = jobs().map(({ name, steps }) => ({
    name,
    steps: steps.map((step) => step.name === CLAUDE_REVIEW_STEP_NAME
      ? { ...step, conclusion: 'skipped' }
      : step),
  }));
  assert.equal(
    reviewOnlyFailure({
      headSha: HEAD,
      jobs: [{ jobs: skippedReviewJobs }],
      reviews: [[review('`x.mjs:1`: 🔴 Important: il gate manca.')]],
    }),
    true,
  );
  assert.equal(
    reviewOnlyFailure({
      headSha: HEAD,
      jobs: [{ jobs: jobs() }],
      reviews: [[review('## Findings (Important: 0, Nit: 2)\n\n## LGTM')]],
    }),
    false,
  );
  assert.equal(
    reviewOnlyFailure({
      headSha: HEAD,
      jobs: [{ jobs: jobs() }],
      reviews: [[review('`x.mjs:1`: 🔴 Important: il gate manca.', 'b'.repeat(40))]],
    }),
    false,
  );
});

test('il classificatore failure resta nel job ma non aggiunge una failure di codice', () => {
  assert.equal(
    NON_GATING_REVIEW_STEPS.has('Classify review gate failure'),
    true,
    'il nome del classificatore deve provenire dalla stessa topologia condivisa',
  );
  assert.equal(
    reviewOnlyFailure({
      headSha: HEAD,
      jobs: [{ jobs: jobs([{ name: 'Classify review gate failure', conclusion: 'failure' }]) }],
      reviews: [[review('`x.mjs:1`: 🔴 Important: il gate manca.')]],
    }),
    true,
    'la failure esplicita del classificatore distingue il verdetto ma non deve instradare al redcheck fixer',
  );
});

test('il predicato resta chiuso su abort, failure misto e review assente', () => {
  const base = { headSha: HEAD, reviews: [[review('`x.mjs:1`: 🔴 Important: il gate manca.')]] };
  assert.equal(reviewOnlyFailure({ ...base, jobs: [{ jobs: jobs([{ name: 'Generator CI gate', conclusion: 'failure' }]) }] }), false);
  assert.equal(reviewOnlyFailure({ ...base, jobs: [{ jobs: jobs().map(({ name, steps }) => ({ name, steps: steps.filter((s) => s.name !== CLAUDE_REVIEW_STEP_NAME) })) }] }), false);
  assert.equal(reviewOnlyFailure({ headSha: HEAD, jobs: [{ jobs: jobs() }], reviews: [] }), false);
});
