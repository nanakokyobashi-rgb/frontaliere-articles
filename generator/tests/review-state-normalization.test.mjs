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
 *   3. la presenza della seconda lettura prima dell'azione nei tre workflow;
 *   4. nel redflag fixer, la rilettura del precodex subito prima di Codex,
 *      eseguendo i blocchi `run:` VERI di ctx e precodex con `gh` finto: una
 *      review ritirata o sostituita dopo il ctx ferma Codex.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
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
const HAS_SHA256SUM = spawnSync('sh', ['-c', 'command -v sha256sum'], { encoding: 'utf8' }).status === 0;
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

function review({ id, state = 'COMMENTED', body = '## Findings (1)\n🔴 Important: x', commit = HEAD, login = 'claude[bot]', revision = REVISION }) {
  return {
    id,
    state,
    commit_id: commit,
    user: { login },
    body: `${body}\n<!-- REVIEW_INPUT_REVISION: ${revision} -->`,
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

/** Corpo di uno step `run: |` (indentazione del workflow), senza parser YAML. */
function stepRun(source, stepName) {
  const lines = source.split('\n');
  const start = lines.indexOf(`      - name: ${stepName}`);
  assert.notEqual(start, -1, `step non trovato: ${stepName}`);
  const runAt = lines.findIndex((line, i) => i > start && line === '        run: |');
  assert.notEqual(runAt, -1, `blocco run non trovato: ${stepName}`);
  const body = [];
  for (let i = runAt + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') {
      body.push('');
      continue;
    }
    if (!line.startsWith('          ')) break;
    body.push(line.slice(10));
  }
  return body.join('\n');
}

/** Valore di una variabile `env:` di workflow scritta come block scalar `|`. */
function workflowEnvBlock(source, name) {
  const lines = source.split('\n');
  const at = lines.indexOf(`  ${name}: |`);
  assert.notEqual(at, -1, `env ${name} non trovata`);
  const value = [];
  for (let i = at + 1; i < lines.length && (lines[i].startsWith('    ') || lines[i].trim() === ''); i++) {
    value.push(lines[i].slice(4));
  }
  return `${value.join('\n').trimEnd()}\n`;
}

/**
 * Esegue i blocchi `run:` VERI di ctx e precodex del redflag fixer, con un
 * `gh` finto che serve alla lettura N delle review `reviewsByRead[N-1]`
 * (l'ultima si ripete). Le letture 1 e 2 sono quelle del ctx, la 3 e' la
 * rilettura del precodex. `tamper` puo' alterare `$OUT` fra i due step, come
 * potrebbe fare il codice del checkout della PR che gira in mezzo.
 */
function runRedflagPrecodex({ reviewsByRead, tamper }) {
  const source = read('pr-redflag-fixer.yml');
  const ctxRun = stepRun(source, 'Collect PR + review context (zero-Claude)');
  const precodexRun = stepRun(source, 'Revalidate PR + review context immediately before Codex');
  const filter = workflowEnvBlock(source, 'REVIEWER_BOT_REVIEW_FILTER');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redflag-precodex-'));
  try {
    const bin = path.join(dir, 'bin');
    const stub = path.join(dir, 'stub');
    const runnerTemp = path.join(dir, 'runner');
    for (const d of [bin, stub, runnerTemp]) fs.mkdirSync(d);
    const prBody = '## Implementato\n- fixture';
    const revision = `body:${createHash('sha256').update(`${prBody}\n`).digest('hex')}`;
    fs.writeFileSync(path.join(stub, 'pr.json'),
      JSON.stringify({ title: 'fixture', body: prBody, head: { sha: HEAD, ref: 'fix/fixture' } }));
    reviewsByRead.forEach((make, i) => {
      fs.writeFileSync(path.join(stub, `reviews-${i + 1}.json`), JSON.stringify([make(revision)]));
    });
    fs.writeFileSync(path.join(stub, 'reviews-last.json'),
      JSON.stringify([reviewsByRead[reviewsByRead.length - 1](revision)]));
    fs.writeFileSync(path.join(bin, 'gh'), `#!/usr/bin/env bash
set -eu
case "$*" in
  *"/reviews"*)
    n=$(( $(cat "$STUB/reviews-reads" 2>/dev/null || echo 0) + 1 ))
    echo "$n" > "$STUB/reviews-reads"
    f="$STUB/reviews-$n.json"
    [ -f "$f" ] || f="$STUB/reviews-last.json"
    cat "$f" ;;
  *"/files"*) echo "scripts/ci/example.mjs" ;;
  *"/pulls/"*) cat "$STUB/pr.json" ;;
  *) echo "gh finto: chiamata inattesa $*" >&2; exit 1 ;;
esac
`);
    fs.chmodSync(path.join(bin, 'gh'), 0o755);
    const helper = path.join(dir, 'marker-helper.mjs');
    fs.writeFileSync(helper, 'process.stdout.write("{}\\n");\n');
    const ctxScript = path.join(dir, 'ctx.sh');
    const precodexScript = path.join(dir, 'precodex.sh');
    fs.writeFileSync(ctxScript, ctxRun);
    fs.writeFileSync(precodexScript, precodexRun);
    const base = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      STUB: stub,
      RUNNER_TEMP: runnerTemp,
      GH_TOKEN: 'x',
      REPO: 'nanakokyobashi-rgb/frontaliere-articles',
      PR_NUMBER: '7',
      REVIEWER_BOT_REVIEW_FILTER: filter,
    };
    // Stessa shell dei runner GitHub per `run:` senza `shell:`.
    const bash = (script, env) => spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', script],
      { env, encoding: 'utf8' });

    const ctxOutput = path.join(dir, 'ctx-output');
    const ctx = bash(ctxScript, { ...base, HEAD_SHA: HEAD, GITHUB_OUTPUT: ctxOutput });
    assert.equal(ctx.status, 0, `ctx: ${ctx.stdout}\n${ctx.stderr}`);
    const outputs = Object.fromEntries(fs.readFileSync(ctxOutput, 'utf8').trim().split('\n')
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
    assert.equal(outputs.context_verified, 'true');
    assert.match(outputs.review_selector_sha256, /^[a-f0-9]{64}$/);
    assert.match(outputs.review_selection_sha256, /^[a-f0-9]{64}$/);
    tamper?.(path.join(runnerTemp, 'redflag'));

    // Niente HEAD_SHA dall'ambiente: il precodex deve impostarla da se'.
    const precodexOutput = path.join(dir, 'precodex-output');
    fs.writeFileSync(precodexOutput, '');
    const precodex = bash(precodexScript, {
      ...base,
      GITHUB_OUTPUT: precodexOutput,
      EVENT_HEAD_SHA: HEAD,
      EXPECTED_HEAD_SHA: outputs.head_sha,
      EXPECTED_BODY_REVISION: outputs.review_revision,
      EXPECTED_REVIEW_SELECTOR_SHA256: outputs.review_selector_sha256,
      EXPECTED_REVIEW_SELECTION_SHA256: outputs.review_selection_sha256,
      EXPECTED_MARKER_BODY_REVISION: outputs.review_revision,
      EXPECTED_MARKER: 'REDFLAG_FIX_ROUND',
      EXPECTED_ROUND: '1',
      EXPECTED_COMMENT_ID: '1',
      TRUSTED_MARKER_HELPER: helper,
    });
    return {
      status: precodex.status,
      log: `${precodex.stdout}\n${precodex.stderr}`,
      verified: /^verified=true$/m.test(fs.readFileSync(precodexOutput, 'utf8')),
      reads: Number(fs.readFileSync(path.join(stub, 'reviews-reads'), 'utf8').trim()),
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const HAS_PRECODEX_TOOLS = HAS_JQ && HAS_SHA256SUM;

test('replay pr-redflag-fixer: il precodex rilegge le review e una dismissal dopo il ctx ferma Codex', { skip: !HAS_PRECODEX_TOOLS && 'jq o sha256sum assenti' }, () => {
  const important = (revision) => review({ id: 2, revision });
  const lgtm = (revision) => review({ id: 1, body: '## LGTM', revision });

  // Controllo: tre letture identiche, Codex autorizzato.
  const stable = runRedflagPrecodex({
    reviewsByRead: [(r) => [lgtm(r), important(r)]],
  });
  assert.equal(stable.status, 0, stable.log);
  assert.ok(stable.verified, 'contesto stabile: il precodex deve autorizzare Codex');
  assert.equal(stable.reads, 3, 'due letture del ctx + una rilettura del precodex');

  // La review con i 🔴 viene ritirata dopo il confronto del ctx.
  const dismissed = runRedflagPrecodex({
    reviewsByRead: [
      (r) => [lgtm(r), important(r)],
      (r) => [lgtm(r), important(r)],
      (r) => [lgtm(r), { ...important(r), state: 'DISMISSED' }],
    ],
  });
  assert.notEqual(dismissed.status, 0, 'una review ritirata non deve arrivare a Codex');
  assert.equal(dismissed.verified, false);
  assert.match(dismissed.log, /::error::La review selezionata è cambiata fra prefetch e Claude/);

  // Una review nuova con altri 🔴 sostituisce quella del bundle.
  const superseded = runRedflagPrecodex({
    reviewsByRead: [
      (r) => [lgtm(r), important(r)],
      (r) => [lgtm(r), important(r)],
      (r) => [lgtm(r), important(r), review({ id: 3, body: '## Findings (2)\n🔴 Important: y', revision: r })],
    ],
  });
  assert.notEqual(superseded.status, 0);
  assert.equal(superseded.verified, false);

  // Uno stato fuori enum alla rilettura e' fail-closed con lo stato nel log.
  const unknown = runRedflagPrecodex({
    reviewsByRead: [
      (r) => [lgtm(r), important(r)],
      (r) => [lgtm(r), important(r)],
      (r) => [lgtm(r), { ...important(r), state: 'SUPERSEDED' }],
    ],
  });
  assert.notEqual(unknown.status, 0);
  assert.equal(unknown.verified, false);
  assert.match(unknown.log, /Stato review sconosciuto \("SUPERSEDED"\)/);

  // Una funzione di selezione riscritta in $OUT fra i due step non viene
  // caricata, anche se produrrebbe la selezione attesa.
  const tampered = runRedflagPrecodex({
    reviewsByRead: [(r) => [lgtm(r), important(r)]],
    tamper: (out) => fs.writeFileSync(path.join(out, 'select-current-review.sh'),
      'select_current_review () { cp "$OUT/review-selection.json" "$1"; }\n'),
  });
  assert.notEqual(tampered.status, 0);
  assert.equal(tampered.verified, false);
  assert.match(tampered.log, /Selezione della review del contesto non verificabile prima di Claude/);
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
