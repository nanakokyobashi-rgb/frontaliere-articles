/**
 * loop-drift-strict-optin.test.mjs — un `workflow_dispatch` di sola ISPEZIONE
 * non deve poter far fallire `loop-drift-check.yml` (issue #982, item 2).
 *
 * ## Il difetto, e perche' e' asimmetrico
 *
 * I due passi di rete del workflow guardano lo STESSO stato — un terzo repo che
 * si e' mosso — e devono quindi escalare sullo stesso evento. Il primo lo fa
 * bene: apre la issue di drift sullo `schedule`, oppure su un dispatch che l'ha
 * chiesto con l'input `report_issue`. Il secondo passava `--strict` a
 * `verify-crawler-contract-provenance.mjs` su tutto cio' che non fosse
 * `pull_request`, cioe' **anche su un dispatch di ispezione**.
 *
 * Le due letture divergono solo li', ed e' il caso peggiore: guardare il report
 * a mano faceva uscire il workflow rosso, `workflow-failure-issues` apriva una
 * issue, `issue-triage` la instradava e il fixer ci spendeva un giro sulla
 * quota condivisa col sito — per uno stato del sito che chi ha lanciato il
 * dispatch non aveva ancora deciso di trattare. Il gesto piu' innocuo del ciclo
 * era anche l'unico che si auto-segnalava come guasto.
 *
 * ## Perche' un test, e non solo il commento nello YAML
 *
 * `if [ ... ]` dentro un `run:` non e' eseguito da nessuna suite: la sua
 * regressione non produce un errore, produce una run rossa che sembra un
 * verdetto legittimo (AGENTS.md #6 — un legame che non puo' essere un import va
 * coperto da un test). Le due condizioni devono restare LA STESSA STRINGA:
 * l'unica forma in cui il difetto puo' tornare e' che una delle due si muova
 * da sola.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WORKFLOW_REL = '.github/workflows/loop-drift-check.yml';
const WORKFLOW = fs.readFileSync(path.join(ROOT, WORKFLOW_REL), 'utf8');

/** Il blocco di uno step, dal suo `- name:` al successivo allo stesso livello. */
function stepBlock(src, name) {
  const start = src.indexOf(`      - name: ${name}\n`);
  if (start === -1) return null;
  const rest = src.slice(start + 1);
  const next = rest.search(/\n {6}- name: /);
  return next === -1 ? rest : rest.slice(0, next);
}

/**
 * La condizione che decide l'escalation, dalle sole righe ESEGUIBILI: i
 * commenti di questo workflow citano per intero la forma sbagliata (`!=
 * pull_request`), quindi un match sul testo grezzo la leggerebbe come ancora
 * presente.
 */
function escalationCondition(stepName) {
  const step = stepBlock(WORKFLOW, stepName);
  assert.ok(step, `step \`${stepName}\` non trovato in ${WORKFLOW_REL}`);
  const active = step
    .split('\n')
    .filter((l) => !l.trim().startsWith('#'))
    .join('\n');
  const m = active.match(/\n\s*if \[(.+)\]; then\n/);
  assert.ok(m, `lo step \`${stepName}\` non ha piu' un \`if [ ... ]\` che decida l'escalation`);
  return m[1].trim();
}

const REPORT = 'Confronta il ciclo col sito';
const PROVENANCE = 'Verifica la provenienza del contratto cross-repo';

test('loop-drift-check: i due passi di rete escalano sullo stesso opt-in', () => {
  const report = escalationCondition(REPORT);
  const provenance = escalationCondition(PROVENANCE);
  assert.equal(
    provenance,
    report,
    'Le due condizioni di escalation sono tornate a divergere. Guardano lo stesso stato (il sito\n' +
      'che si e\' mosso) e devono quindi accendersi insieme: se una delle due include eventi che\n' +
      "l'altra esclude, quell'evento produce un rosso che nessuno ha chiesto.\n" +
      `  \`${REPORT}\`: ${report}\n  \`${PROVENANCE}\`: ${provenance}`,
  );
});

test('loop-drift-check: il report accetta anche `1` e `True` e il rosso gia\' riportato non duplica issue', () => {
  for (const stepName of [REPORT, PROVENANCE]) {
    const cond = escalationCondition(stepName);
    assert.match(cond, /github\.event\.inputs\.report_issue.*=\s*"1"/);
    assert.match(cond, /github\.event\.inputs\.report_issue.*=\s*"True"/);
  }
  const report = stepBlock(WORKFLOW, REPORT);
  assert.match(report, /id: drift_report/);
  assert.doesNotMatch(report, /^\s*continue-on-error:/m);
  assert.match(
    report,
    /GITHUB_OUTPUT/,
  );
  assert.match(report, /issue_reported=/);
  assert.match(report, /grep -Fxq 'issue_reported=true' "\$GITHUB_OUTPUT"/);
  assert.match(report, /\[ "\$DRIFT_STATUS" -ne 0 \] && \[ "\$ISSUE_REPORTED" != "true" \]/);
  assert.doesNotMatch(report, /github-issue-creator|Created:|Commented on existing|Reopened #/);
  assert.match(report, /node scripts\/ci\/loop-drift-check\.mjs \$ARGS >"\$REPORT_LOG" 2>&1/);
  assert.match(report, /ARGS="--issue --strict"/);

  const provenance = stepBlock(WORKFLOW, PROVENANCE);
  assert.match(provenance, /id: provenance_report/);
  assert.match(
    provenance,
    /continue-on-error: \$\{\{ steps\.drift_report\.outputs\.issue_reported == 'true' \}\}/,
  );
});

test('loop-drift-check: l\'escalation e\' un opt-in, non «tutto cio\' che non e\' una PR»', () => {
  for (const stepName of [REPORT, PROVENANCE]) {
    const cond = escalationCondition(stepName);
    assert.ok(
      !/!=\s*"?pull_request/.test(cond),
      `Lo step \`${stepName}\` escala su tutto cio' che non e' una \`pull_request\`, quindi anche\n` +
        'su un `workflow_dispatch` di sola ispezione: guardare il report a mano fa fallire il\n' +
        'workflow, `workflow-failure-issues` apre una issue e il fixer ci spende un giro sulla\n' +
        `quota condivisa col sito. La condizione deve essere l'opt-in. Attuale: ${cond}`,
    );
    assert.match(
      cond,
      /github\.event\.inputs\.report_issue/,
      `Lo step \`${stepName}\` non legge piu' l'input \`report_issue\`: o non si escala mai su un\n` +
        "dispatch (e l'input dichiarato in `on:` non serve a niente), o si escala sempre.\n" +
        `Attuale: ${cond}`,
    );
    assert.match(
      cond,
      /=\s*"schedule"/,
      `Lo step \`${stepName}\` non escala piu' sullo \`schedule\`: e' il passaggio giornaliero, cioe'\n` +
        `l'unico che deve aprire la issue da solo. Attuale: ${cond}`,
    );
  }
});

test('loop-drift-check: `report_issue` resta dichiarato fra gli input del dispatch', () => {
  const on = WORKFLOW.slice(WORKFLOW.indexOf('\non:'), WORKFLOW.indexOf('\npermissions:'));
  assert.match(
    on,
    /workflow_dispatch:\n\s+inputs:\n\s+report_issue:/,
    'L\'input `report_issue` e\' sparito dal `workflow_dispatch`. Senza, la condizione di\n' +
      'escalation dei due passi legge sempre vuoto e un dispatch non puo\' piu\' chiedere il\n' +
      'trattamento completo: resterebbe solo il cron.',
  );
});

test('loop-drift-check: il censimento dei gemelli gira solo sullo schedule e in coda', () => {
  const censusName = 'Censimento opt-in dei gemelli';
  const census = stepBlock(WORKFLOW, censusName);
  assert.ok(census, `step \`${censusName}\` non trovato in ${WORKFLOW_REL}`);
  assert.match(census, /if: always\(\) && github\.event_name == 'schedule'/);
  assert.match(census, /LOOP_TWIN_CENSUS=1 node --test generator\/tests\/loop-sync-manifest-scope\.test\.mjs/);
  assert.match(census, /GH_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);
  assert.ok(
    WORKFLOW.indexOf(`- name: ${censusName}`) > WORKFLOW.indexOf('Baseline del manifest verificate contro la storia dei path'),
    'il censimento deve restare dopo il report delle baseline',
  );
});

test('loop-drift-check: il checkout conserva tutta la storia ma scarica i blob on-demand', () => {
  const checkout = stepBlock(WORKFLOW, 'Checkout');
  assert.ok(checkout, 'step `Checkout` non trovato');
  assert.match(checkout, /fetch-depth: 0/);
  assert.match(checkout, /filter: blob:limit=1m/);
});
