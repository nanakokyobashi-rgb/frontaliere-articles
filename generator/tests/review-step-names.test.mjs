/**
 * review-step-names.test.mjs — i nomi di step su cui pr-autorebase decide.
 *
 * ## Perche' esiste
 *
 * `pr-autorebase.mjs` non legge il log del job: legge la lista degli step dalla
 * jobs API e decide su QUATTRO nomi, che vivono in due posti che non possono
 * importarsi a vicenda — const JS in `scripts/ci/lib/vitestCheck.mjs` e `name:`
 * di uno step in `.github/workflows/tests.yml` (AGENTS.md #6).
 *
 *   · `REVIEW_GATE_STEP_NAME` — se e' `failure`, il rosso del check richiesto e'
 *     il review gate e non i test (`vitestFailureIsReviewGate`).
 *   · `CLAUDE_REVIEW_STEP_NAME` — se e' `skipped`, su quella run la review NON
 *     e' girata: l'ha saltata il `Re-review guard` (`reviewSkippedByGuard`).
 *   · `REVIEW_ABORT_STEP_NAME` — se e' `failure`, la review e' girata ed e'
 *     morta senza postare: il rosso del gate e' la sua CONSEGUENZA, non un
 *     verdetto negativo (`reviewAbortedWithoutVerdict`). E' anche l'unico
 *     secondo step rosso che `vitestFailureIsReviewGate` tollera: con il nome
 *     sbagliato torna a contare come «test rotti sotto» e nega il one-shot
 *     proprio dove il re-trigger e' la cura (#975).
 *   · `REVIEW_GATE_FAILURE_STEP_NAME` — se e' `failure`, il gate ha scritto
 *     `failure_kind=verdict`; se e' `success`, il gate era rosso per API,
 *     rate-limit o causa sconosciuta e il one-shot resta disponibile (#1140).
 *
 * Un rename di uno step e' esattamente il tipo di modifica che sembra innocua.
 * Se si separano non esplode niente: `vitestFailureIsReviewGate` smette di
 * riconoscere il gate e il messaggio all'operatore torna a dire «far passare i
 * test» a una PR coi test verdi; `reviewSkippedByGuard` smette di riconoscere
 * lo skip e il one-shot torna a essere speso in un close+reopen che, con la
 * review saltata, e' un no-op per costruzione. Entrambi in silenzio, dietro una
 * CI verde.
 *
 * Si pinna anche l'`if:` di `Run Claude review`, perche' e' la PREMESSA del
 * segnale: lo step risulta `skipped` per il guard solo finche' la sua
 * condizione dipende da `steps.guard.outputs.skip`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WORKFLOW = path.join(ROOT, '.github/workflows/tests.yml');
const yaml = fs.readFileSync(WORKFLOW, 'utf8');
const reviewGate = fs.readFileSync(path.join(ROOT, 'scripts/ci/review-gate.mjs'), 'utf8');

/** Tutti i `- name:` di step del workflow, senza un parser YAML (nessuna dep). */
function stepNames(src) {
  return src
    .split('\n')
    .map((l) => l.match(/^\s*-\s+name:\s*(.+?)\s*$/))
    .filter(Boolean)
    .map((m) => m[1].replace(/^['"]|['"]$/g, ''));
}

/** Il blocco di uno step, dal suo `- name:` al `- name:` successivo. */
function stepBlock(src, name) {
  const lines = src.split('\n');
  // `name` va escapato: i nomi di step contengono parentesi (`Fail on transient
  // API error (no review posted)`, `Generator CI gate (solo ...)`) che, non
  // escapate, diventano gruppi di cattura e non matchano piu' il letterale.
  const lit = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const at = lines.findIndex((l) => new RegExp(`^\\s*-\\s+name:\\s*['"]?${lit}['"]?\\s*$`).test(l));
  assert.notEqual(at, -1, `tests.yml non ha uno step \`${name}\``);
  const out = [];
  for (let i = at + 1; i < lines.length; i++) {
    if (/^\s*-\s+name:\s/.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out.join('\n');
}

test('i nomi di step su cui pr-autorebase decide combaciano con tests.yml', async () => {
  const { REVIEW_GATE_STEP_NAME, CLAUDE_REVIEW_STEP_NAME, REVIEW_ABORT_STEP_NAME, REVIEW_GUARD_STEP_NAME, REVIEW_GATE_FAILURE_STEP_NAME } = await import(
    '../../scripts/ci/lib/vitestCheck.mjs'
  );
  const names = stepNames(yaml);
  for (const [constName, value] of [
    ['REVIEW_GATE_STEP_NAME', REVIEW_GATE_STEP_NAME],
    ['CLAUDE_REVIEW_STEP_NAME', CLAUDE_REVIEW_STEP_NAME],
    ['REVIEW_ABORT_STEP_NAME', REVIEW_ABORT_STEP_NAME],
    ['REVIEW_GUARD_STEP_NAME', REVIEW_GUARD_STEP_NAME],
    ['REVIEW_GATE_FAILURE_STEP_NAME', REVIEW_GATE_FAILURE_STEP_NAME],
  ]) {
    assert.ok(
      names.includes(value),
      `${constName} vale "${value}", ma nessuno step di tests.yml si chiama cosi'. ` +
        'pr-autorebase decide sulla lista degli step: con il nome sbagliato non trova niente ' +
        'e sbaglia il verdetto in silenzio. Step presenti:\n  ' + names.join('\n  '),
    );
  }
});

test('lo step della review e\' `skipped` PER il guard: la sua condizione lo dice', async () => {
  const { CLAUDE_REVIEW_STEP_NAME } = await import('../../scripts/ci/lib/vitestCheck.mjs');
  const block = stepBlock(yaml, CLAUDE_REVIEW_STEP_NAME);
  const cond = block.match(/^\s*if:\s*(.+)$/m);
  assert.ok(cond, `lo step \`${CLAUDE_REVIEW_STEP_NAME}\` non ha un \`if:\``);
  assert.match(
    cond[1],
    /steps\.guard\.outputs\.skip/,
    'la condizione di `Run Claude review` non dipende piu\' dal `Re-review guard`. ' +
      '`reviewSkippedByGuard` legge `skipped` su quello step per dedurre che il guard ha ' +
      'saltato Claude: senza questa dipendenza il segnale diventa un\'altra cosa, e il ' +
      'one-shot verrebbe negato (o concesso) su una premessa che non vale piu\'.',
  );
});

test('il review gate gira anche a review saltata, altrimenti il segnale non esisterebbe', async () => {
  const { REVIEW_GATE_STEP_NAME } = await import('../../scripts/ci/lib/vitestCheck.mjs');
  const block = stepBlock(yaml, REVIEW_GATE_STEP_NAME);
  const cond = block.match(/^\s*if:\s*(.+)$/m);
  assert.ok(cond, `lo step \`${REVIEW_GATE_STEP_NAME}\` non ha un \`if:\``);
  // `always()` e nessuna dipendenza dal guard: e' cio' che rende possibile lo
  // stato «gate rosso + review saltata», cioe' proprio quello che
  // `reviewSkippedByGuard` riconosce.
  assert.match(cond[1], /always\(\)/, 'il review gate non gira piu\' con `always()`');
  assert.doesNotMatch(
    cond[1],
    /steps\.guard\.outputs\.skip/,
    'il review gate ora si salta insieme alla review: lo stato «gate rosso su verdetti ' +
      'gia\' postati» sparisce, e con esso il caso che `reviewSkippedByGuard` distingue.',
  );
});

test('il classificatore separa un verdetto da un errore del review gate', async () => {
  const { REVIEW_GATE_STEP_NAME, REVIEW_GATE_FAILURE_STEP_NAME } = await import(
    '../../scripts/ci/lib/vitestCheck.mjs'
  );
  const block = stepBlock(yaml, REVIEW_GATE_FAILURE_STEP_NAME);
  assert.match(block, /steps\.review_gate\.outputs\.failure_kind/);
  const names = stepNames(yaml);
  assert.ok(
    names.indexOf(REVIEW_GATE_FAILURE_STEP_NAME) > names.indexOf(REVIEW_GATE_STEP_NAME),
    'il classificatore deve leggere l output del gate dopo che il gate ha girato',
  );
  assert.match(reviewGate, /failure_kind=\$\{gateFailureKind\}/);
  assert.match(reviewGate, /markTransientFailure\(\)/);
});

test('lo step di abort gira anche quando la review muore, e sta PRIMA del gate', async () => {
  const { REVIEW_ABORT_STEP_NAME, REVIEW_GATE_STEP_NAME } = await import(
    '../../scripts/ci/lib/vitestCheck.mjs'
  );
  const block = stepBlock(yaml, REVIEW_ABORT_STEP_NAME);
  const cond = block.match(/^\s*if:\s*(.+)$/m);
  assert.ok(cond, `lo step \`${REVIEW_ABORT_STEP_NAME}\` non ha un \`if:\``);
  assert.match(block, /^\s*id:\s*review_abort\s*$/m, 'lo step di abort deve esportare il proprio segnale');
  // Senza `always()` lo step non girerebbe dopo una `Run Claude review` rossa,
  // che e' esattamente il caso che deve classificare.
  assert.match(cond[1], /always\(\)/, "lo step di abort non gira piu' con `always()`");
  // L'ordine e' sostanziale: la co-occorrenza «abort rosso + gate rosso» esiste
  // solo se l'abort NON aborta il job prima che il gate giri. Il gate ha
  // `always()` (pinnato sopra), quindi basta che l'abort lo preceda.
  const names = stepNames(yaml);
  assert.ok(
    names.indexOf(REVIEW_ABORT_STEP_NAME) < names.indexOf(REVIEW_GATE_STEP_NAME),
    `\`${REVIEW_ABORT_STEP_NAME}\` deve precedere \`${REVIEW_GATE_STEP_NAME}\`: `
      + 'e\' quell\'ordine a produrre i DUE step rossi che `vitestFailureIsReviewGate` '
      + 'deve saper leggere come un rosso solo.',
  );
});

test('max_turns distingue una review gia\' postata sulla HEAD nella run corrente', async () => {
  const { REVIEW_ABORT_STEP_NAME } = await import('../../scripts/ci/lib/vitestCheck.mjs');
  const block = stepBlock(yaml, REVIEW_ABORT_STEP_NAME);
  assert.match(yaml, /^\s*actions:\s*read\s*$/m, 'la probe della run deve poter leggere Actions API');
  assert.match(block, /jq -e -s/);
  assert.match(block, /terminal_reason == "max_turns"/);
  assert.match(block, /actions\/runs\/\$RUN_ID/);
  assert.match(block, /pulls\/\$PR_NUMBER\/reviews/);
  assert.match(block, /--paginate --slurp/);
  assert.match(block, /--arg head_sha "\$HEAD_SHA"/);
  assert.match(block, /--arg run_started_at "\$RUN_STARTED_AT"/);
  assert.match(block, /\.commit_id == \$head_sha/);
  assert.match(block, /\.submitted_at \/\/ ""\) >= \$run_started_at/);
  assert.doesNotMatch(block, /env\.RUN_STARTED_AT/);
  assert.match(block, /review_abort_cause verdict_posted/);
  assert.match(block, /review_abort_cause max_turns/);
  const posted = block.indexOf('review_abort_cause verdict_posted');
  const abort = block.indexOf('review_abort_cause max_turns');
  assert.ok(posted >= 0 && abort > posted, 'il verdetto postato deve essere valutato prima dell abort max_turns');
  assert.doesNotMatch(
    block.slice(posted, abort),
    /exit 1/,
    'una review gia\' postata non deve tingere di rosso il percorso max_turns',
  );
});

test('429 e cause non riattivabili viaggiano come segnali distinti', async () => {
  const { REVIEW_ABORT_STEP_NAME, REVIEW_DEATH_STEP_NAMES } = await import(
    '../../scripts/ci/lib/vitestCheck.mjs'
  );
  const abort = stepBlock(yaml, REVIEW_ABORT_STEP_NAME);
  assert.match(abort, /review_abort_cause rate_limit/);
  assert.match(abort, /review_aborted true/);
  assert.match(abort, /review_abort_cause server_error/);
  assert.match(abort, /REVIEW_OUTCOME.*cancelled/);
  assert.match(abort, /review_abort_cause cancelled/);
  assert.match(abort, /retryable_failure true/);
  assert.match(abort, /permanent_failure true/);
  assert.match(abort, /api_error_status.*429/);
  assert.match(abort, /rate_limit_event/);
  assert.match(abort, /status.*rejected/);
  assert.doesNotMatch(abort, /rate\[ _-\]\?limit/);

  const permanentName = 'Fail on non-retryable review action error (no automatic retry)';
  const permanent = stepBlock(yaml, permanentName);
  assert.match(permanent, /steps\.review_abort\.outputs\.permanent_failure/);
  assert.match(permanent, /exit 1/);
  assert.equal(
    REVIEW_DEATH_STEP_NAMES.has(permanentName),
    false,
    'la causa permanente non deve essere trattata dal consumer come abort retryable',
  );
});
