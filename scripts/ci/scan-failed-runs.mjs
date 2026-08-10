#!/usr/bin/env node
/**
 * scan-failed-runs.mjs — apre una issue per ogni workflow di QUESTO repo che
 * fallisce, senza cablare uno step in ogni file YAML.
 *
 * ## Perché centrale e non per-workflow
 *
 * Il sito risolve lo stesso problema mettendo uno step `github-issue-creator`
 * dentro ogni workflow: 135 file lo fanno. Funziona, ma ha due costi che qui
 * pesano più che là. Il primo: modificare i workflow di generazione significa
 * toccare il core operativo di questo repo — sono loro a produrre il corpus —
 * per aggiungerci una preoccupazione che non è la loro. Il secondo, più
 * insidioso: un workflow NUOVO nasce scoperto, e nessuno se ne accorge finché
 * non fallisce in silenzio.
 *
 * Il sito è già arrivato alla stessa conclusione per il lato opposto:
 * `close-recovered-failure-issues.mjs` chiude le issue centralmente proprio
 * "without wiring a per-workflow step into ~300 YAML files". Questo script è
 * la metà simmetrica — apre centralmente ciò che quello chiude centralmente —
 * e usa le STESSE convenzioni di titolo (`Workflow Failure: <nome>`) perché il
 * reconciler le richiuda da solo quando il workflow torna verde.
 *
 * ## I tre filtri, e perché ciascuno esiste
 *
 * 1. **Solo `conclusion == failure`.** Mai `cancelled`. Il 2026-08-06 un
 *    disservizio GitHub ha cancellato in coda ogni run del repo per ore: senza
 *    questo filtro lo scanner avrebbe aperto una issue per ognuna, cioè avrebbe
 *    trasformato un guasto dell'infrastruttura in decine di falsi bug.
 *
 * 2. **Niente run da `pull_request`.** Un `tests` rosso su una PR è un problema
 *    DELLA PR: lo vede il reviewer, blocca l'auto-merge e si risolve lì. Aprire
 *    anche una issue duplicherebbe il segnale su un canale che non lo chiude.
 *
 * 3. **Gate sui fallimenti consecutivi.** Il profilo di fallimento di questo
 *    repo è dominato dalla generazione articoli (misurato: 9 `Generate Blog
 *    Article` + 8 `fast-publish-article` su 18 fallimenti in 7 giorni), che
 *    dipende da provider LLM e rete ed è transiente per natura. Il primo blip
 *    resta una briciola `priority:low`; solo la ripetizione escala. Senza
 *    questo, il triage annegherebbe in rumore al primo giorno.
 *
 * ## Anti-doppio-conteggio
 *
 * La finestra di lookback si sovrappone di proposito alla cadenza del cron (per
 * non perdere run al confine), quindi lo stesso fallimento può ricadere in due
 * scansioni. Se contasse due volte, due blip indipendenti diventerebbero una
 * falsa "ripetizione" e il gate escalerebbe a torto. Prima di segnalare, si
 * verifica quindi che nessuna issue aperta di quel workflow citi GIÀ l'URL di
 * quella run: la run stessa è la chiave di deduplica.
 *
 * Uso:
 *   node scripts/ci/scan-failed-runs.mjs [--dry-run] [--lookback-min N]
 *                                        [--max-issues N] [--gate N]
 * Env:
 *   GH_TOKEN            necessario per gh.
 *   GITHUB_REPOSITORY   owner/repo (auto in Actions).
 *   IGNORE_WORKFLOWS    lista separata da virgole di `name:` da ignorare.
 */

import { execFileSync } from 'node:child_process';
import { createGithubIssue } from '../lib/github-issue-creator.mjs';

const ARGV = process.argv.slice(2);
const flag = (n) => ARGV.includes(n);
const val = (n, d) => {
  const i = ARGV.indexOf(n);
  return i !== -1 && ARGV[i + 1] ? ARGV[i + 1] : d;
};

const DRY_RUN = flag('--dry-run');
const LOOKBACK_MIN = Number(val('--lookback-min', '40'));
const MAX_ISSUES = Number(val('--max-issues', '5'));
const GATE = Number(val('--gate', '3'));
const REPO = process.env.GITHUB_REPOSITORY || '';
/**
 * Lista dei workflow da ignorare, dal valore grezzo della env.
 *
 * **Non c'e' piu' un default**: ne' "variabile assente" ne' "stringa vuota"
 * producono una lista precompilata. Il default storico (`'Claude token smoke'`)
 * e' stato ELIMINATO, non solo scavalcato — il workflow che lo giustificava non
 * esiste piu'.
 *
 * Il `??` invece del `||` resta necessario comunque: con `||` la stringa vuota
 * e' falsy, quindi il giorno in cui qualcuno reintroducesse un default
 * troverebbe che impostare `IGNORE_WORKFLOWS: ''` per dire "non ignorare
 * niente" otterrebbe in silenzio l'esatto contrario.
 *
 * Trovato dalla review automatica sulla PR #15, al primo giro reale del ciclo.
 */
export function parseIgnoreList(raw) {
  return new Set(
    (raw ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

const IGNORE = parseIgnoreList(process.env.IGNORE_WORKFLOWS);

/**
 * Workflow che dichiarano SIA `push: branches-ignore: [main]` SIA
 * `pull_request` sugli stessi path — i gate pre-merge (`tests.yml`,
 * `generator-ci.yml`). Per questi la run innescata da un push su un branch
 * non-main è solo un'anteprima: quando (e se) la PR si apre, `pull_request`
 * rigira la stessa suite e quel segnale è già escluso sotto, per lo stesso
 * motivo — "un tests rosso su una PR è un problema della PR, lo vede il
 * reviewer lì". Vale identico per il push che la precede: un checkpoint WIP
 * del fixer autonomo è per contratto non testato al momento del push
 * (ISSUES.md § "Checkpoint WIP"), e un branch di sviluppo abbandonato prima
 * di aprire PR non ha nessuno che legga la issue. Senza questo filtro
 * entrambi i casi aprono una "Workflow Failure" fantasma — misurato: #112,
 * #135, #178, tutte push su branch mai (ancora) diventati PR.
 *
 * Non generalizzare oltre questi due nomi: gli altri workflow con `push` (i
 * self-test di generazione, es. `batch-faq-articles.yml`) non hanno un
 * trigger `pull_request` gemello — per loro il push È l'unico segnale che
 * esista, ed escluderlo azzererebbe la copertura, non la duplicherebbe.
 */
const PR_GATE_WORKFLOWS = new Set(['tests', 'Generator CI']);

function gh(args, fallback = '') {
  try {
    return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (e) {
    console.warn(`[scan-failed-runs] gh ${args.slice(0, 3).join(' ')} fallito: ${String(e.message).slice(0, 120)}`);
    return fallback;
  }
}

/** Un run va segnalato, o è rumore già coperto da un altro canale? */
export function isReportableRun(r, { since, ignore = IGNORE } = {}) {
  return (
    r.conclusion === 'failure' &&
    r.event !== 'pull_request' &&
    !(r.event === 'push' && PR_GATE_WORKFLOWS.has(r.workflowName)) &&
    (!since || (r.updatedAt || r.createdAt) >= since) &&
    !ignore.has(r.workflowName)
  );
}

/** Run fallite nella finestra, escluse quelle da pull_request e dai gate pre-merge in preview. */
function failedRuns() {
  const since = new Date(Date.now() - LOOKBACK_MIN * 60_000).toISOString();
  const raw = gh(
    ['run', 'list', '--repo', REPO, '--status', 'failure', '--limit', '60',
      '--json', 'databaseId,workflowName,conclusion,event,createdAt,updatedAt,headBranch,url'],
    '[]',
  );
  let runs = [];
  try {
    runs = JSON.parse(raw || '[]');
  } catch {
    return [];
  }
  return runs.filter((r) => isReportableRun(r, { since }));
}

/**
 * Una issue aperta per questo workflow cita già questa run? Se sì l'abbiamo
 * gia' contata in una scansione precedente e va saltata, altrimenti il gate
 * conterebbe due volte lo stesso fallimento.
 */
function alreadyReported(workflowName, runUrl) {
  const title = `Workflow Failure: ${workflowName}`;
  const raw = gh(
    ['issue', 'list', '--repo', REPO, '--state', 'open', '--search', title, '--json', 'number,title', '--limit', '10'],
    '[]',
  );
  let issues = [];
  try {
    issues = JSON.parse(raw || '[]');
  } catch {
    return false;
  }
  const match = issues.filter((i) => (i.title || '').startsWith(title.slice(0, 60)));
  for (const i of match) {
    const body = gh(['issue', 'view', String(i.number), '--repo', REPO, '--json', 'body,comments', '--jq', '.body + (.comments | map(.body) | join("\n"))'], '');
    if (body.includes(runUrl)) return true;
  }
  return false;
}

/** I job falliti di una run, per dare al triage un aggancio concreto. */
function failedJobs(runId) {
  const raw = gh(
    ['api', `repos/${REPO}/actions/runs/${runId}/jobs`, '--jq',
      '[.jobs[] | select(.conclusion=="failure") | {name, url: .html_url, step: ([.steps[]? | select(.conclusion=="failure") | .name] | first)}]'],
    '[]',
  );
  try {
    return JSON.parse(raw || '[]');
  } catch {
    return [];
  }
}

async function main() {
  if (!REPO) {
    console.error('[scan-failed-runs] GITHUB_REPOSITORY non impostato — esco senza fare nulla.');
    return 0;
  }

  const runs = failedRuns();
  if (!runs.length) {
    console.log(`[scan-failed-runs] Nessuna run fallita negli ultimi ${LOOKBACK_MIN} minuti (esclusi PR e cancelled).`);
    return 0;
  }

  // Una issue per WORKFLOW, non per run: se lo stesso workflow è fallito tre
  // volte nella finestra, il segnale resta uno solo. Si tiene la piu' recente.
  const byWorkflow = new Map();
  for (const r of runs) {
    const prev = byWorkflow.get(r.workflowName);
    if (!prev || (r.updatedAt || r.createdAt) > (prev.updatedAt || prev.createdAt)) byWorkflow.set(r.workflowName, r);
  }

  console.log(`[scan-failed-runs] ${runs.length} run fallite → ${byWorkflow.size} workflow distinti${DRY_RUN ? ' (dry-run)' : ''}.`);

  let opened = 0;
  for (const [name, run] of byWorkflow) {
    if (opened >= MAX_ISSUES) {
      // Un cap che tronca in silenzio si legge come "tutto coperto". Lo diciamo.
      console.warn(`::warning::[scan-failed-runs] Cap di ${MAX_ISSUES} issue raggiunto — ${byWorkflow.size - opened} workflow falliti NON segnalati in questa passata: ${[...byWorkflow.keys()].slice(opened).join(', ')}. Verranno ripresi alla prossima scansione.`);
      break;
    }

    if (alreadyReported(name, run.url)) {
      console.log(`[scan-failed-runs] ${name}: run ${run.databaseId} già segnalata → skip (evita doppio conteggio nel gate).`);
      continue;
    }

    const jobs = failedJobs(run.databaseId);
    const jobLines = jobs.length
      ? jobs.map((j) => `- \`${j.name}\`${j.step ? ` — step fallito: \`${j.step}\`` : ''}\n  ${j.url}`).join('\n')
      : '_(nessun job fallito riportato dall\'API — possibile fallimento a livello di run)_';

    const description = [
      `Il workflow **${name}** è fallito.`,
      '',
      `- Run: ${run.url}`,
      `- Branch: \`${run.headBranch || '?'}\``,
      `- Evento: \`${run.event || '?'}\``,
      `- Concluso: ${run.updatedAt || run.createdAt}`,
      '',
      '**Job falliti**',
      jobLines,
      '',
      '---',
      '',
      'Issue aperta automaticamente da `scripts/ci/scan-failed-runs.mjs`. Si chiude da sola quando il workflow torna verde (`close-recovered-failure-issues.mjs`, cron orario) — non serve chiuderla a mano dopo un fix.',
    ].join('\n');

    if (DRY_RUN) {
      console.log(`[scan-failed-runs] (dry-run) aprirei: "Workflow Failure: ${name}" — run ${run.url}`);
      opened++;
      continue;
    }

    const res = await createGithubIssue({
      title: `Workflow Failure: ${name}`,
      description,
      priority: 2,
      labels: ['Bug'],
      workflow: name,
      // Il primo blip resta una briciola priority:low; solo la ripetizione
      // dentro la finestra escala. È ciò che tiene fuori dal triage il rumore
      // transiente della generazione articoli.
      consecutiveGate: GATE,
    });
    if (res) opened++;
  }

  console.log(`[scan-failed-runs] Fatto — ${opened} segnalazione/i emesse.`);
  return 0;
}

// Solo in modalita' CLI: senza guardia, importare questo modulo da un test lo
// eseguirebbe — e questo script apre issue sul repo.
if (process.argv[1] && process.argv[1].endsWith('scan-failed-runs.mjs')) {
  main().then(
    (c) => process.exit(c),
    (e) => {
      // PROCEED-SAFE: uno scanner rotto non deve far fallire il workflow che lo
      // ospita, altrimenti il rilevatore di fallimenti diventa esso stesso un
      // fallimento ricorrente da segnalare.
      console.error(`[scan-failed-runs] errore non fatale: ${e && e.stack ? e.stack : e}`);
      process.exit(0);
    },
  );
}
