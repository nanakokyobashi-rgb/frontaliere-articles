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
    // maxBuffer esplicito: il default di execFileSync e' 1 MB, e da quando
    // failedRunLog() scarica il log dei job falliti quel tetto e' raggiungibile
    // — la run 31459831234 ne produce gia' 220 KB, e una generazione lunga
    // arriva molto oltre. Superarlo lancia ENOBUFS, che qui viene catturato e
    // degrada in silenzio alla issue generica: cioe' proprio sulla run piu'
    // rumorosa la diagnosi sparirebbe senza dirlo. 32 MB e' la stessa soglia
    // che usa scripts/ci/close-recovered-failure-issues.mjs.
    return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
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
 * Una issue aperta con QUESTO titolo cita già questa run? Se sì l'abbiamo
 * gia' contata in una scansione precedente e va saltata, altrimenti il gate
 * conterebbe due volte lo stesso fallimento.
 *
 * Prende il titolo intero e non piu' il solo nome del workflow: da quando il
 * rilevatore qui sotto puo' emettere un titolo per-path invece di
 * `Workflow Failure: <nome>`, cercare il titolo generico guarderebbe la issue
 * sbagliata — e l'anti-doppio-conteggio si spegnerebbe in silenzio proprio
 * sulla classe piu' costosa.
 */
function alreadyReported(title, runUrl) {
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

/* ─────────────────────────────────────────────────────────────────────────────
 * Rilevatore: "articolo generato e perso" (issue #225)
 *
 * La issue generica `Workflow Failure: Generate Blog Article` dice il nome del
 * workflow e lo step (`Commit and push`). Non dice le due cose che decidono
 * cosa farne: SU QUALE FILE il push si e' incagliato, e se in quel commit
 * c'era un articolo intero — LLM, quattro traduzioni DeepL e immagine, tutto
 * gia' pagato — buttato via. Senza quelle due, nessun fixer puo' prenderla:
 * misurato sul lotto di #225, quattro fallimenti in 37 ore, quattro con
 * `ARTICLE: true`, tutti finiti `needs-human`/`fu-parked`.
 *
 * Modellato su scripts/ci/report-validate-dist-failure.mjs del sito, che e' il
 * modello di issue diagnostica ricca di questo progetto. Tre contratti onorati
 * da li', verificati sui sorgenti e non dedotti:
 *
 * - DEDUP: il titolo e' l'unica chiave, e sono i primi 60 caratteri
 *   (searchSafePrefix in scripts/lib/github-issue-creator.mjs). Il path va
 *   quindi PRIMO: searchSafePrefix taglia a 60 e, se il taglio spezza una
 *   parola, butta l'ultimo token — un titolo `<prosa> <path>` con un path
 *   lungo perde proprio il path e fa collassare percorsi diversi sulla stessa
 *   issue. Col path in testa il discriminante e' dentro la finestra per
 *   costruzione. Nessun run id nel titolo: sta nel body (stessa regola di #5121).
 *
 * - CLOSER: questo titolo sta deliberatamente FUORI dal TITLE_RE di
 *   scripts/ci/close-recovered-failure-issues.mjs (che copre solo
 *   `Workflow|Crawler|CI Failure:`). Non e' una svista: quel reconciler chiude
 *   sul primo verde successivo, e qui il verde non prova niente — il difetto e'
 *   un path assente da una allowlist, e resta assente anche mentre le run
 *   passano. Chiudere sul verde e' esattamente come questa classe e' sparita
 *   finora senza essere riparata.
 *
 * - FIXER: il body CITA il path `.github/workflows/**` apposta. Su questo repo
 *   la allowlist di bookkeeping vive dentro il workflow, e il PAT del fixer non
 *   ha lo scope `workflow`: scripts/ci/check-workflows-scope.mjs (Mode 1)
 *   riconosce il path nel body e corto-circuita PRIMA di avviare Claude,
 *   spendendo zero token invece di ~1M per una fix che non potrebbe pushare.
 *   Nominarlo e' quindi il modo giusto di instradarla, non un errore.
 * ────────────────────────────────────────────────────────────────────────── */

// Prefisso dei log di GitHub Actions (`job\tstep\t2026-08-11T05:00:18.4631322Z `)
// e sequenze ANSI. Vanno via prima di mostrare una riga in una issue.
const ANSI_RE = /\u001b\[[0-9;]*[A-Za-z]/g;
const LOG_PREFIX_RE = /^(?:[^\t]*\t[^\t]*\t)?\d{4}-\d{2}-\d{2}T[\d:.]+Z ?/;

export function cleanLogLine(line) {
  return String(line).replace(/\r$/, '').replace(ANSI_RE, '').replace(LOG_PREFIX_RE, '').trimEnd();
}

// `git rebase` quando il conflitto e' reale.
const CONFLICT_RE = /CONFLICT \([^)]*\): Merge conflict in (\S.*)$/;
// L'avviso di scripts/lib/rebase-onto-remote.sh: e' IL path che ha fatto
// abortire, non uno qualunque del set in conflitto.
const NOT_BOOKKEEPING_RE = /rebase conflict on '([^']+)', which is not a whole-file bookkeeping cache/;
// L'errore vero emesso dallo step, non l'eco dello script che GitHub stampa a
// ogni avvio dello step (quella riga c'e' anche quando il push riesce).
const PUSH_EXHAUSTED_RE = /##\[error\]push failed after \d+ attempts/;
// `ARTICLE: true` e' il dump dell'env dello step di summary, cioe' il valore
// vero di steps.generate.outputs.article. `ENABLE_HAIKU_ARTICLE_FALLBACK: true`
// non matcha: serve `ARTICLE:` preceduto da inizio riga o spazio.
const ARTICLE_TRUE_RE = /(?:^|\s)ARTICLE:\s+true\b/m;
// Corroborazione dentro lo step fallito stesso: il rebase nomina il commit che
// ha rinunciato ad applicare, e il titolo del commit dice se era un articolo.
const DROPPED_ARTICLE_COMMIT_RE = /could not apply [0-9a-f]+\.{3}\s*Generate blog article/i;

/** Path in conflitto trovati nel log, in ordine di prima comparsa, senza duplicati. */
export function conflictedPathsFromLog(text) {
  const seen = new Set();
  for (const raw of String(text || '').split('\n')) {
    const line = cleanLogLine(raw);
    const m = NOT_BOOKKEEPING_RE.exec(line) || CONFLICT_RE.exec(line);
    if (m) seen.add(m[1].trim());
  }
  return [...seen];
}

/**
 * Il path su cui il rebase si e' arreso. E' quello nominato dall'avviso
 * dell'helper quando c'e' — gli altri path in conflitto possono essere
 * bookkeeping gia' risolvibile — altrimenti il primo in ordine alfabetico, che
 * e' l'ordine in cui `git diff --diff-filter=U` li presenta all'helper.
 */
export function blockingConflictPath(text) {
  for (const raw of String(text || '').split('\n')) {
    const m = NOT_BOOKKEEPING_RE.exec(cleanLogLine(raw));
    if (m) return m[1].trim();
  }
  const all = conflictedPathsFromLog(text).sort();
  return all[0] || null;
}

/** Il commit conteneva un articolo generato per intero? */
export function articleWasGenerated(text) {
  const s = String(text || '');
  return ARTICLE_TRUE_RE.test(s) || DROPPED_ARTICLE_COMMIT_RE.test(s);
}

/** Il loop di retry del push ha esaurito i tentativi? */
export function pushRetriesExhausted(text) {
  return PUSH_EXHAUSTED_RE.test(String(text || ''));
}

/**
 * Il titolo. Path PRIMO — vedi la nota DEDUP sopra: e' l'unica forma in cui il
 * discriminante sopravvive al taglio a 60 caratteri anche per un path lungo.
 * Stabile a parita' di path: nessun run id, nessun conteggio.
 */
export function lostArticleTitle(conflictPath) {
  return `${conflictPath}: articolo generato e perso nel push`;
}

/** Le righe del log che spiegano il fallimento, ripulite e senza ripetizioni. */
export function diagnosticExcerpt(text, max = 12) {
  const out = [];
  const seen = new Set();
  for (const raw of String(text || '').split('\n')) {
    const line = cleanLogLine(raw);
    if (!CONFLICT_RE.test(line) && !NOT_BOOKKEEPING_RE.test(line) && !PUSH_EXHAUSTED_RE.test(line)) continue;
    if (seen.has(line)) continue;
    seen.add(line);
    out.push(line);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Costruisce titolo e body ricchi, oppure `null` se questa run non e' della
 * classe. Puro: prende il log gia' scaricato, non tocca la rete.
 */
export function buildLostArticleReport({ log, run, workflowName, workflowPath, jobLines }) {
  if (!pushRetriesExhausted(log) || !articleWasGenerated(log)) return null;
  const conflictPath = blockingConflictPath(log);
  if (!conflictPath) return null;

  const allPaths = conflictedPathsFromLog(log);
  const excerpt = diagnosticExcerpt(log);
  const wfPath = workflowPath || '.github/workflows/';

  const description = [
    `**Un articolo generato per intero e' stato buttato via.** Il commit conteneva l'articolo`,
    "(`ARTICLE: true`), il push e' stato rifiutato, il rebase si e' fermato su un conflitto e lo step e'",
    'morto su "the article is registered locally but not pushed". LLM, quattro traduzioni e immagine',
    "erano gia' pagati.",
    '',
    `- Path che ha bloccato il rebase: \`${conflictPath}\``,
    allPaths.length > 1 ? `- Tutti i path in conflitto: ${allPaths.map((p) => `\`${p}\``).join(', ')}` : null,
    `- Run: ${run.url}`,
    `- Branch: \`${run.headBranch || '?'}\``,
    `- Evento: \`${run.event || '?'}\``,
    `- Concluso: ${run.updatedAt || run.createdAt}`,
    '',
    '**Job falliti**',
    jobLines,
    '',
    '**Estratto del log**',
    '',
    '```',
    ...(excerpt.length ? excerpt : ['(nessuna riga diagnostica estratta)']),
    '```',
    '',
    '## Suggested action',
    '',
    `1. Decidere che cos'e' \`${conflictPath}\`. Se e' una cache rigenerabile riscritta per intero a ogni`,
    "   run (un catalogo, un ledger di dedup, un file di progresso), il conflitto si risolve con \"prendi",
    '   upstream": perdere un aggiornamento costa una rigenerazione, perdere il commit costa l\'articolo.',
    `2. In quel caso il path va aggiunto alla allowlist di bookkeeping che \`${wfPath}\` passa a`,
    '   `scripts/lib/rebase-onto-remote.sh`. L\'helper ha gia\' il ramo che risolve cosi\' (issue #76): non',
    '   serve logica nuova, serve dichiarare che il file appartiene a quella categoria.',
    '3. Se invece e\' un registro append-only del corpus (`content/blog-articles-data.ts`, `content/blog-meta-*.ts`),',
    '   "prendi upstream" NON va bene: cancellerebbe il record dell\'articolo. Serve un merge per-record,',
    '   ed e\' un cambio di forma dei registri — decisione del proprietario, non del fixer.',
    `4. Il test che prova la scelta sta in \`generator/tests/rebase-onto-remote.test.mjs\`: legge la`,
    '   allowlist dal workflow e ci fa girare sopra un conflitto vero.',
    '',
    '---',
    '',
    'Issue aperta automaticamente da `scripts/ci/scan-failed-runs.mjs`. **Non si chiude da sola su una run',
    'verde**: `close-recovered-failure-issues.mjs` copre solo i titoli `Workflow Failure:`/`CI Failure:`/',
    "`Crawler Failure:`, e qui un verde non prova niente — il path resta fuori dalla allowlist anche mentre",
    'le run passano. Si chiude quando la allowlist (o il registro) cambia.',
  ].filter((l) => l !== null).join('\n');

  return { title: lostArticleTitle(conflictPath), description };
}

/** Il file YAML da cui la run e' partita, es. `.github/workflows/generate-article.yml`. */
function workflowPathOfRun(runId) {
  return gh(['api', `repos/${REPO}/actions/runs/${runId}`, '--jq', '.path'], '') || '';
}

/**
 * Log dei job falliti della run. Scaricato SOLO quando uno step fallito si
 * chiama come un push: e' l'unica classe per cui questo modulo sa dire
 * qualcosa di piu' della issue generica, e un log per run e' comunque costoso.
 */
function failedRunLog(runId, jobs) {
  if (!jobs.some((j) => /push/i.test(j.step || ''))) return '';
  return gh(['run', 'view', String(runId), '--repo', REPO, '--log-failed'], '');
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

    const jobs = failedJobs(run.databaseId);
    const jobLines = jobs.length
      ? jobs.map((j) => `- \`${j.name}\`${j.step ? ` — step fallito: \`${j.step}\`` : ''}\n  ${j.url}`).join('\n')
      : '_(nessun job fallito riportato dall\'API — possibile fallimento a livello di run)_';

    // Il rilevatore ricco gira PRIMA della dedup: e' il titolo che decide quale
    // issue guardare, e per questa classe il titolo non e' piu' quello generico.
    const lost = buildLostArticleReport({
      log: failedRunLog(run.databaseId, jobs),
      run,
      workflowName: name,
      workflowPath: workflowPathOfRun(run.databaseId),
      jobLines,
    });

    const title = lost ? lost.title : `Workflow Failure: ${name}`;

    if (alreadyReported(title, run.url)) {
      console.log(`[scan-failed-runs] ${name}: run ${run.databaseId} già segnalata → skip (evita doppio conteggio nel gate).`);
      continue;
    }

    const description = lost ? lost.description : [
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
      console.log(`[scan-failed-runs] (dry-run) aprirei: "${title}" — run ${run.url}`);
      opened++;
      continue;
    }

    const res = await createGithubIssue({
      title,
      description,
      // Un articolo intero buttato via non e' un blip: e' la perdita piu' cara
      // per unita' della pipeline, ed e' gia' successa quando la issue si apre.
      priority: lost ? 1 : 2,
      labels: ['Bug'],
      workflow: name,
      // Il primo blip resta una briciola priority:low; solo la ripetizione
      // dentro la finestra escala. È ciò che tiene fuori dal triage il rumore
      // transiente della generazione articoli. Non vale per un articolo perso:
      // `-1` disattiva il gate (vedi consecutiveGate in github-issue-creator.mjs),
      // perche' aspettare la terza perdita significa buttarne tre.
      consecutiveGate: lost ? -1 : GATE,
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
