/**
 * review-state-normalization — #1762.
 *
 * Tre workflow sceglievano la review «corrente» con
 * `(.state // "") != "PENDING" and != "DISMISSED"`: un enum nuovo o uno stato
 * mancante passava come verdetto valido, e nessuno rileggeva le review dopo la
 * paginazione, quindi una dismissal concorrente lasciava agire su un verdetto
 * ritirato.
 *
 * Qui si provano tre cose:
 *   1. UNA sorgente degli stati (`scripts/ci/lib/review-states.mjs`) e il
 *      legame testuale con ogni programma jq dei workflow che la usa — jq
 *      inline non puo' importare il modulo (AGENTS.md #6);
 *   2. i tre replay della METRICA eseguiti con jq sui programmi VERI estratti
 *      dai workflow: stato inatteso, `DISMISSED`, dismissal concorrente;
 *   3. la presenza della seconda lettura prima dell'azione nei tre workflow.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  KNOWN_REVIEW_STATES,
  NON_TERMINAL_REVIEW_STATES,
  REVIEW_STATE_JQ_DEFS,
  TERMINAL_REVIEW_STATES,
  isKnownReviewState,
  isTerminalReviewState,
} from '../../scripts/ci/lib/review-states.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKFLOWS = ['pr-redflag-fixer.yml', 'tests.yml', 'stale-pr-rescuer.yml'];
const read = (file) => fs.readFileSync(path.join(ROOT, '.github', 'workflows', file), 'utf8');
const HAS_JQ = spawnSync('jq', ['--version'], { encoding: 'utf8' }).status === 0;
const [KNOWN_DEF, TERMINAL_DEF] = REVIEW_STATE_JQ_DEFS;

const HEAD = 'a'.repeat(40);
const REVISION = `body:${'b'.repeat(64)}`;

function jq(program, input, args = []) {
  const result = spawnSync('jq', [...args, program], { input, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr };
}

/** Testo fra `open` e il primo apice singolo successivo: un programma jq. */
function quotedProgram(source, open, label) {
  const at = source.indexOf(open);
  assert.ok(at >= 0, `${label}: ancora non trovata (${open})`);
  const start = at + open.length;
  const end = source.indexOf("'", start);
  assert.ok(end > start, `${label}: programma jq non chiuso`);
  return source.slice(start, end);
}

function review({ id, state = 'COMMENTED', body = '## Findings (1)\n🔴 Important: x', commit = HEAD, login = 'claude[bot]' }) {
  return {
    id,
    state,
    commit_id: commit,
    user: { login },
    body: `${body}\n<!-- REVIEW_INPUT_REVISION: ${REVISION} -->`,
  };
}

test('un solo enum: terminali + non terminali, uno stato sconosciuto non e\' mai terminale', () => {
  assert.deepEqual([...KNOWN_REVIEW_STATES].sort(),
    ['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED', 'PENDING']);
  assert.deepEqual(KNOWN_REVIEW_STATES, [...TERMINAL_REVIEW_STATES, ...NON_TERMINAL_REVIEW_STATES]);
  for (const state of TERMINAL_REVIEW_STATES) assert.ok(isTerminalReviewState(state), state);
  for (const state of ['PENDING', 'DISMISSED', 'SUPERSEDED', 'commented', '', null, undefined, 1]) {
    assert.equal(isTerminalReviewState(state), false, String(state));
  }
  assert.equal(isKnownReviewState('SUPERSEDED'), false);
  assert.equal(isKnownReviewState('DISMISSED'), true);
});

for (const file of WORKFLOWS) {
  test(`${file}: ogni programma jq sugli stati copia le def canoniche di review-states.mjs`, () => {
    const source = read(file);
    assert.doesNotMatch(source, /!= "PENDING"/, 'filtro per esclusione ancora presente');
    assert.doesNotMatch(source, /!= "DISMISSED"/, 'filtro per esclusione ancora presente');
    for (const line of source.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('def review_state_known')) assert.equal(trimmed, KNOWN_DEF);
      if (trimmed.startsWith('def review_state_terminal')) assert.equal(trimmed, TERMINAL_DEF);
    }
    const uses = [...source.matchAll(/select\(review_state_terminal\)|review_state_known \| not|and review_state_known\b/g)];
    assert.ok(uses.length > 0, 'nessun uso dell\'enum condiviso');
    for (const use of uses) {
      // I programmi jq sono stringhe shell a apice singolo, senza apici
      // interni: l'apice precedente e' l'inizio del programma che contiene l'uso.
      const programStart = source.lastIndexOf("'", use.index);
      const program = source.slice(programStart, use.index);
      assert.ok(program.includes(KNOWN_DEF), `${file}@${use.index}: def review_state_known assente`);
      if (use[0].includes('terminal')) {
        assert.ok(program.includes(TERMINAL_DEF), `${file}@${use.index}: def review_state_terminal assente`);
      }
    }
  });
}

test('replay stale-pr-rescuer: stato inatteso, DISMISSED e dismissal concorrente non sono azionabili', { skip: !HAS_JQ && 'jq assente' }, () => {
  const source = read('stale-pr-rescuer.yml');
  const schema = quotedProgram(source, "REVIEW_SCHEMA_JQ='", 'schema');
  const selection = quotedProgram(source, "REVIEW_SELECTION_JQ='", 'selezione');
  const args = ['-c', '-s', '--arg', 'head', HEAD, '--arg', 'revision', REVISION];
  const page = (reviews) => `${JSON.stringify(reviews)}\n`;

  // 1. Stato inatteso: la lettura e' `unavailable`, nessuna selezione.
  const unknown = page([review({ id: 1, state: 'SUPERSEDED' })]);
  assert.notEqual(jq(schema, unknown, ['-s', '-e']).status, 0, 'uno stato fuori enum deve invalidare lo schema');
  assert.equal(jq(schema, page([review({ id: 1 })]), ['-s', '-e']).status, 0, 'controllo: lo schema accetta una review valida');

  // 2. DISMISSED: mai la review corrente, anche se e' la piu' recente.
  const dismissed = JSON.parse(jq(selection, page([
    review({ id: 1, body: '## LGTM' }),
    review({ id: 2, state: 'DISMISSED' }),
  ]), args).stdout);
  assert.equal(dismissed.current_id, 1);
  assert.doesNotMatch(dismissed.current, /Important/);

  // 3. Dismissal concorrente: stesse review, la seconda lettura vede la 2
  //    ritirata. Le due selezioni devono differire, cosi' il confronto del
  //    workflow ferma il giro.
  const first = jq(selection, page([review({ id: 1, body: '## LGTM' }), review({ id: 2 })]), args).stdout;
  const second = jq(selection, page([review({ id: 1, body: '## LGTM' }), review({ id: 2, state: 'DISMISSED' })]), args).stdout;
  assert.equal(JSON.parse(first).current_id, 2);
  assert.notEqual(first, second);
  assert.match(source, /if \[ "\$REVIEW_SELECTION" != "\$REVIEW_SELECTION_REREAD" \]; then\n\s+echo "::warning::[^"]*dismissal[^"]*"\n\s+continue/,
    'la selezione diversa fra le due letture deve saltare la PR con log esplicito');
});

test('replay pr-redflag-fixer: la selezione ignora DISMISSED e stati ignoti, il pre-controllo li nomina', { skip: !HAS_JQ && 'jq assente' }, () => {
  const source = read('pr-redflag-fixer.yml');
  const selection = quotedProgram(source,
    '| jq -cs --arg revision "$review_revision" --arg head "$HEAD_SHA" \'', 'selezione redflag');
  const precheck = quotedProgram(source, 'unknown_review_states=$(printf \'%s\' "$reviews_json" | jq -r \'', 'precheck redflag');
  const args = ['-c', '-s', '--arg', 'revision', REVISION, '--arg', 'head', HEAD];
  const stream = (reviews) => reviews.map((r) => JSON.stringify(r)).join('\n');

  const onlyInactive = jq(selection, stream([
    review({ id: 1, state: 'DISMISSED' }),
    review({ id: 2, state: 'PENDING' }),
    review({ id: 3, state: 'SUPERSEDED' }),
  ]), args);
  assert.equal(onlyInactive.status, 0, onlyInactive.stderr);
  assert.equal(onlyInactive.stdout, '', 'nessuna review azionabile');

  const picked = JSON.parse(jq(selection, stream([review({ id: 1 }), review({ id: 2, state: 'DISMISSED' })]), args).stdout);
  assert.equal(picked.id, 1);

  const named = jq(precheck, JSON.stringify([[review({ id: 1 }), review({ id: 2, state: 'SUPERSEDED' })]]), ['-r']);
  assert.equal(named.stdout, '"SUPERSEDED"');
  assert.equal(jq(precheck, JSON.stringify([[review({ id: 1 })]]), ['-r']).stdout, '');

  // Doppia lettura prima di Claude: stessa funzione, confronto, fail-closed.
  const first = source.indexOf('select_current_review "$OUT/review-selection.json"');
  const second = source.indexOf('select_current_review "$OUT/review-selection-reread.json"');
  const compare = source.indexOf('cmp -s "$OUT/review-selection.json" "$OUT/review-selection-reread.json"');
  const bundle = source.indexOf('> "$OUT/latest-review.md"');
  assert.ok(first > 0 && second > first && compare > second && bundle > compare,
    'le due letture e il confronto devono precedere il bundle');
  assert.match(source.slice(compare, bundle), /context_fail "La review selezionata è cambiata fra due letture consecutive/);
});

test('replay tests.yml: guard e contesto non contano review DISMISSED o ignote, e rileggono prima di saltare Codex', { skip: !HAS_JQ && 'jq assente' }, () => {
  const source = read('tests.yml');
  const sameHead = quotedProgram(source,
    'same_head=$(printf \'%s\' "$reviews" | jq --arg head "$HEAD_SHA" --arg revision "$REVIEW_REVISION" \'', 'same_head');
  const args = ['--arg', 'head', HEAD, '--arg', 'revision', REVISION];
  const lgtm = review({ id: 1, state: 'COMMENTED', body: '## LGTM' });
  const pages = (reviews) => JSON.stringify([reviews]);

  assert.equal(jq(sameHead, pages([lgtm]), args).stdout, '1', 'controllo: LGTM pulito conta');
  assert.equal(jq(sameHead, pages([{ ...lgtm, state: 'DISMISSED' }]), args).stdout, '0', 'LGTM ritirato non conta');
  assert.equal(jq(sameHead, pages([{ ...lgtm, state: 'SUPERSEDED' }]), args).stdout, '0', 'stato ignoto non conta');

  const previous = quotedProgram(source, 'jq -r --arg head "$CODE_UNCHANGED_SINCE" \\\n                  \'', 'previous-review');
  const unknownContext = jq(previous, pages([{ ...lgtm, state: 'SUPERSEDED' }]), ['-r', '--arg', 'head', HEAD]);
  assert.notEqual(unknownContext.status, 0, 'uno stato ignoto deve far dichiarare il contesto mancante');

  const guardAt = source.indexOf('id: guard');
  const reread = source.indexOf('reviews_reread=$(gh api "repos/$REPO/pulls/$PR_NUMBER/reviews" --paginate --slurp', guardAt);
  const unknownCheck = source.indexOf('echo "::error::Stato review sconosciuto', guardAt);
  const decision = source.indexOf('same_head=$(', guardAt);
  assert.ok(unknownCheck > guardAt && reread > unknownCheck && decision > reread,
    'pre-controllo dello stato e seconda lettura devono precedere la decisione same-head');
  assert.match(source.slice(reread, decision), /\[ "\$reviews_first_view" != "\$reviews_second_view" \]; then\n\s+echo "::error::[^"]*dismissal[^"]*"\n\s+exit 1/);
});
