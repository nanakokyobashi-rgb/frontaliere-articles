/**
 * claude-step-timeout.test.mjs — ogni step che invoca `claude-code-action` deve
 * avere un tetto EFFETTIVO sano, cioe' un `timeout-minutes` proprio quando
 * quello del job e' troppo largo per fare da tetto.
 *
 * ## Il modo silenzioso in cui questo si rompe
 *
 * Uno step senza tetto eredita quello del job. Nei due workflow che portano il
 * ciclo agentico quel numero e' 360 minuti, e non e' un budget: e' un
 * anti-runaway. Il vincolo che dovrebbe mordere e' `--max-turns`, ma se la CLI
 * resta appesa (rete, provider, sandbox) nessuno la ferma prima delle sei ore.
 *
 * Quello che si perde non e' il tempo di runner, e' la CODA del job:
 *
 *  - in `issue-fix.yml` dopo lo step Claude girano il salvataggio del branch
 *    WIP, il backstop `FIX_OUTCOME` e il classificatore d'esito. Un job ucciso
 *    dal cap muore `cancelled` e non ne esegue nemmeno uno: il lavoro pagato
 *    sparisce col container e il drainer, senza marker, ri-accoda contro un
 *    muro e addebita un tentativo a una run che non ha consegnato niente;
 *  - in `tests.yml` il cap e' condiviso con la suite `node --test`, e il job
 *    produce il check-run richiesto dal ruleset su `main`. Un `cancelled` non
 *    e' un `failure`: nessun `if: failure()` lo vede, la conclusione resta
 *    quella che il gate legge come vuota, e il merge di PR sane si ferma.
 *
 * In entrambi i casi il sintomo e' un job che scade DOPO ore, non un errore.
 *
 * ## Perche' la regola guarda il tetto effettivo e non "ha un timeout"
 *
 * Chiedere un `timeout-minutes` su ogni step Claude sarebbe piu' semplice e
 * piu' sbagliato: dove il job stesso e' capato a 18, 40 o 90 minuti il tetto
 * c'e' gia', ed e' quello del job. La proprieta' che conta e' che il tempo
 * massimo in cui una CLI appesa puo' tenere in ostaggio la coda del job resti
 * sotto `MAX_EFFECTIVE_MINUTES`; da dove arrivi il numero e' indifferente.
 *
 * Portato dal sito riconciliando il `both-moved` di `.github/workflows/issue-fix.yml`
 * (issue #956, classe #7310 di valerielinc-ops/frontaliere-si-o-no).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WORKFLOW_DIR = path.join(ROOT, '.github/workflows');

/** L'action che identifica uno step "Claude" ovunque nel repo. */
const CLAUDE_ACTION = /uses:\s*anthropics\/claude-code-action/;

/**
 * Tetto massimo accettato per uno step Claude. 120 minuti sono ~10x la piu'
 * lunga esecuzione reale misurata (733s su `Run Claude fix`, 2026-09-06):
 * nessun run sano lo tocca, e lascia 4h del cap del job alla coda di step
 * deterministici che deve girare comunque.
 */
const MAX_EFFECTIVE_MINUTES = 120;

/**
 * Estrae gli step che invocano Claude da un workflow, con il tetto effettivo
 * di ciascuno. PURA sul testo: niente parser YAML (questo repo non ha
 * dipendenze) e niente disco.
 *
 * Si appoggia all'indentazione canonica di GitHub Actions usata da TUTTI i
 * workflow qui: job a 2 spazi, chiavi del job a 4, step a `      - `, chiavi
 * dello step a 8. Uno step il cui `timeout-minutes` non e' a quel livello non
 * verrebbe visto — ma non sarebbe nemmeno valido per Actions. Il commento in
 * coda al valore e' ammesso: `post-merge-followup.yml` lo usa, e ignorarlo
 * faceva leggere «nessun tetto» su un job che ce l'ha.
 *
 * @param {string} yaml
 * @returns {{job: string, step: string, stepTimeout: number|null, jobTimeout: number|null, effective: number|null}[]}
 */
export function claudeSteps(yaml) {
  const lines = yaml.split('\n');
  const out = [];
  let inJobs = false;
  let job = null;
  const jobTimeout = new Map();
  // Step corrente: righe accumulate finche' non ne comincia un altro.
  let step = null;

  const flush = () => {
    if (!step) return;
    const body = step.lines.join('\n');
    if (CLAUDE_ACTION.test(body)) {
      const m = /^ {8}timeout-minutes:\s*(\d+)\s*(?:#.*)?$/m.exec(body);
      const stepTimeout = m ? Number(m[1]) : null;
      const jt = jobTimeout.get(step.job) ?? null;
      out.push({
        job: step.job,
        step: step.name,
        stepTimeout,
        jobTimeout: jt,
        // Il piu' stretto dei due, o `null` se nessuno dei due esiste: senza
        // tetto alcuno il job eredita il default di GitHub (6h), che e' il
        // caso peggiore, non un'assenza di problema.
        effective:
          stepTimeout != null && jt != null ? Math.min(stepTimeout, jt) : (stepTimeout ?? jt),
      });
    }
    step = null;
  };

  for (const line of lines) {
    if (/^jobs:\s*$/.test(line)) {
      inJobs = true;
      continue;
    }
    if (!inJobs) continue;
    const jobMatch = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (jobMatch) {
      flush();
      job = jobMatch[1];
      continue;
    }
    const jobTimeoutMatch = /^ {4}timeout-minutes:\s*(\d+)\s*(?:#.*)?$/.exec(line);
    if (jobTimeoutMatch && job) {
      jobTimeout.set(job, Number(jobTimeoutMatch[1]));
      continue;
    }
    if (/^ {6}- /.test(line)) {
      flush();
      const name = /^ {6}- name:\s*(.+?)\s*$/.exec(line);
      step = { job, name: name ? name[1] : line.trim(), lines: [line] };
      continue;
    }
    if (step) step.lines.push(line);
  }
  flush();
  return out;
}

const workflowFiles = fs
  .readdirSync(WORKFLOW_DIR)
  .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
  .sort();

test('ogni step Claude ha un tetto effettivo sotto il massimo', () => {
  const offenders = [];
  let seen = 0;
  for (const file of workflowFiles) {
    const yaml = fs.readFileSync(path.join(WORKFLOW_DIR, file), 'utf8');
    for (const s of claudeSteps(yaml)) {
      seen += 1;
      if (s.effective == null || s.effective > MAX_EFFECTIVE_MINUTES) {
        offenders.push(
          `${file} → job "${s.job}" / step "${s.step}": tetto effettivo ${
            s.effective ?? 'nessuno (default GitHub: 360+)'
          } min > ${MAX_EFFECTIVE_MINUTES}`,
        );
      }
    }
  }
  assert.ok(seen > 0, 'nessuno step Claude trovato: il parser o il path si sono rotti');
  assert.deepEqual(
    offenders,
    [],
    `Step Claude senza tetto sano:\n  ${offenders.join('\n  ')}\n` +
      'Aggiungi `timeout-minutes:` allo step (non al job: il cap del job serve anche alla coda di step deterministici).',
  );
});

test('i due workflow del ciclo agentico dichiarano il tetto SULLO step', () => {
  // Regressione mirata: nei due file dove il cap del job e' 360 il tetto non
  // puo' arrivare dal job, o la coda di step post-Claude muore col job.
  for (const [file, stepName] of [
    ['issue-fix.yml', 'Run Claude fix'],
    ['tests.yml', 'Run Claude review'],
  ]) {
    const yaml = fs.readFileSync(path.join(WORKFLOW_DIR, file), 'utf8');
    const found = claudeSteps(yaml).find((s) => s.step === stepName);
    assert.ok(found, `${file}: step "${stepName}" non trovato`);
    assert.ok(
      found.stepTimeout != null,
      `${file}: "${stepName}" non ha un \`timeout-minutes\` PROPRIO (job: ${found.jobTimeout})`,
    );
    assert.ok(
      found.stepTimeout <= MAX_EFFECTIVE_MINUTES,
      `${file}: "${stepName}" ha timeout-minutes ${found.stepTimeout} > ${MAX_EFFECTIVE_MINUTES}`,
    );
  }
});

test('claudeSteps legge il tetto dello step e quello del job', () => {
  const yaml = [
    'jobs:',
    '  alpha:',
    '    runs-on: ubuntu-latest',
    '    timeout-minutes: 360',
    '    steps:',
    '      - name: Run Claude fix',
    '        timeout-minutes: 120',
    '        uses: anthropics/claude-code-action@v1',
    '      - name: Post',
    '        run: echo ok',
    '  beta:',
    '    timeout-minutes: 18 # commento in coda: va letto, non ignorato',
    '    steps:',
    '      - name: Run Claude harvest',
    '        uses: anthropics/claude-code-action@v1',
    '  gamma:',
    '    steps:',
    '      - name: Run Claude unbounded',
    '        uses: anthropics/claude-code-action@v1',
    '',
  ].join('\n');
  assert.deepEqual(claudeSteps(yaml), [
    {
      job: 'alpha',
      step: 'Run Claude fix',
      stepTimeout: 120,
      jobTimeout: 360,
      effective: 120,
    },
    { job: 'beta', step: 'Run Claude harvest', stepTimeout: null, jobTimeout: 18, effective: 18 },
    {
      job: 'gamma',
      step: 'Run Claude unbounded',
      stepTimeout: null,
      jobTimeout: null,
      effective: null,
    },
  ]);
});
