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
 *   SCAN_FAILED_RUNS_HORIZON_MIN
 *                       minuti di orizzonte della query `--created` (vedi
 *                       DEFAULT_RUN_QUERY_HORIZON_MIN). Non e' la finestra di
 *                       lookback: quella resta `--lookback-min`.
 */

import { execFileSync } from 'node:child_process';
import { createGithubIssue, searchSafePrefix } from '../lib/github-issue-creator.mjs';

const ARGV = process.argv.slice(2);
const flag = (n) => ARGV.includes(n);
const val = (n, d) => {
  const i = ARGV.indexOf(n);
  return i !== -1 && ARGV[i + 1] ? ARGV[i + 1] : d;
};

const DRY_RUN = flag('--dry-run');

/**
 * Un override numerico che non si lascia leggere deve DIRLO.
 *
 * `Number('2d')` e' `NaN`, e un `NaN` che degrada al default e' indistinguibile
 * da "nessun override": chi ha tirato la leva crede di averla tirata. Vale per
 * gli argv (`--lookback-min 40m` azzererebbe la finestra: `since` diventa
 * `Invalid Date`, ogni confronto e' `false`, la scansione trova ZERO run e
 * stampa "nessuna run fallita") e vale per `SCAN_FAILED_RUNS_HORIZON_MIN`, che
 * e' l'unica leva documentata per comprare il caso residuo delle run in attesa
 * di approvazione (fino a 30 giorni).
 *
 * Il silenzio e' voluto SOLO per "assente" e "stringa vuota": li' il default e'
 * la risposta giusta e non c'e' nessuna intenzione tradita.
 *
 * @param {unknown} raw valore grezzo (argv o env)
 * @param {number} fallback default da usare se `raw` e' assente o illeggibile
 * @param {{label: string, warn?: (msg: string) => void}} opts
 * @returns {number} il valore, o `fallback`
 */
export function parsePositiveNum(raw, fallback, { label, warn = console.warn } = {}) {
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return n;
  const present = raw !== undefined && raw !== null && String(raw).trim() !== '';
  if (present) {
    warn(
      `::warning::[scan-failed-runs] ${label}=${String(raw)} non e' un numero positivo — `
        + `override IGNORATO, si prosegue col default ${fallback}. `
        + 'Attenzione: il comportamento che stavi comprando NON e\' attivo.',
    );
  }
  return fallback;
}

const LOOKBACK_MIN = parsePositiveNum(val('--lookback-min', undefined), 40, { label: '--lookback-min' });
const MAX_ISSUES = parsePositiveNum(val('--max-issues', undefined), 5, { label: '--max-issues' });
const GATE = parsePositiveNum(val('--gate', undefined), 3, { label: '--gate' });
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
 * I gate pre-merge (`tests.yml`, `generator-ci.yml`): dichiarano SIA `pull_request`
 * SIA `push` sugli stessi path.
 *
 * Un push su un branch non-main è solo un'anteprima: quando (e se) la PR si
 * apre, `pull_request` rigira la stessa suite e quel segnale è già coperto
 * sotto, per lo stesso motivo — "un tests rosso su una PR è un problema della
 * PR, lo vede il reviewer lì". Vale identico per il push che la precede: un
 * checkpoint WIP del fixer autonomo è per contratto non testato al momento
 * del push (ISSUES.md § "Checkpoint WIP"), e un branch di sviluppo
 * abbandonato prima di aprire PR non ha nessuno che legga la issue. Senza
 * questo filtro entrambi i casi aprono una "Workflow Failure" fantasma —
 * misurato: #112, #135, #178, tutte push su branch mai (ancora) diventati PR.
 *
 * Su `main` non vale nessuna delle due ragioni: da quando `tests.yml` ha
 * perso `branches-ignore: [main]` (#424) la suite gira davvero sui push
 * diretti fatti dai produttori di articoli, e lì non c'è nessuna PR e nessun
 * reviewer — un rosso resterebbe silenzioso per sempre (#476). Il filtro
 * quindi esclude il push dei gate pre-merge SOLO fuori da `main`.
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
    !(r.event === 'push' && PR_GATE_WORKFLOWS.has(r.workflowName) && r.headBranch !== 'main') &&
    (!since || (r.updatedAt || r.createdAt) >= since) &&
    !ignore.has(r.workflowName)
  );
}

/**
 * Step di skip DICHIARATI: rossi voluti, non guasti (issue #170).
 *
 * `post-merge-followup.yml` esce 1 quando la quota Claude e' esaurita, e lo fa
 * di proposito: il watermark avanza solo sulle run di SUCCESSO, quindi uscire
 * verdi li' farebbe scorrere la finestra e perderebbe per sempre il batch di PR
 * non triagiate. Il rosso e' il meccanismo che tiene il watermark indietro — lo
 * step lo dice per esteso nel proprio messaggio ("La prossima run schedulata
 * (<=3h) ri-copre l'intera finestra, nessuna PR persa").
 *
 * Ma questo scanner lo leggeva come qualunque altro rosso e apriva una
 * "Workflow Failure". Poiche' una finestra di quota dura ore e il cron gira ogni
 * ~3h, la stessa issue veniva ri-citata a ogni giro finche'
 * `close-recovered-failure-issues.mjs` la promuoveva a `priority:high` +
 * `needs-human` per RICORRENZA — cioe' esattamente per il fatto di funzionare.
 * E' il caso di #170: aperta il 2026-08-10, ancora accesa il 2026-08-25 con due
 * fallimenti su dieci run recenti, entrambi lo skip di quota.
 *
 * Il filtro e' volutamente NARROW: agisce sul NOME dello step, non sul workflow,
 * e solo se OGNI job fallito della run e' fermo su uno step di skip dichiarato.
 * Un guasto vero nello stesso workflow (la chiamata Claude che muore, il collect
 * che esplode) fallisce su uno step con un altro nome e resta segnalato.
 */
export const DECLARED_SKIP_STEP_RE = /skip on exhausted quota/i;

/**
 * La run e' rossa SOLO per uno skip dichiarato?
 *
 * `jobs` ha la forma prodotta da `failedJobs()`: `{ name, url, step }`, dove
 * `step` e' il PRIMO step fallito del job (o `null`/assente se l'API non lo
 * riporta). Un elenco vuoto o uno step ignoto NON e' uno skip dichiarato: in
 * dubbio si segnala, perche' il costo di una issue di troppo e' un triage, il
 * costo di una in meno e' un guasto silenzioso.
 */
export function isDeclaredSkipOnly(jobs) {
  if (!Array.isArray(jobs) || jobs.length === 0) return false;
  return jobs.every((j) => typeof j?.step === 'string' && DECLARED_SKIP_STEP_RE.test(j.step));
}

/**
 * Un job che il detector timeout/host-kill deve possedere in esclusiva.
 *
 * Il detector specializzato aspetta 120 secondi prima di APRIRE una issue,
 * per non leggere una finalizzazione transitoria dell'API come host-kill. Qui
 * invece la firma basta per cedere il job già al primo passaggio: se era solo
 * transitoria, lo scanner ordinario lo rivede al cron successivo (30 minuti,
 * dentro la finestra di 40) con tutti gli step conclusi. Segnalarlo subito da
 * entrambi i percorsi conterebbe lo stesso evento anche nel rolling ledger.
 */
export function isTimeoutScannerOwnedFailure(job) {
  return (
    job?.conclusion === 'failure'
    && job?.status === 'completed'
    && Array.isArray(job.steps)
    && job.steps.some((step) => step?.status === 'in_progress')
  );
}

/** Mantiene segnalabili gli eventuali failure ordinari della stessa run. */
export function partitionFailedJobsByOwner(jobs) {
  const ordinary = [];
  const timeoutScanner = [];
  for (const job of Array.isArray(jobs) ? jobs : []) {
    (isTimeoutScannerOwnedFailure(job) ? timeoutScanner : ordinary).push(job);
  }
  return { ordinary, timeoutScanner };
}

/**
 * Il job piu' lungo del repo (`translate-pending.yml`, 350 minuti). Serve solo
 * come ADDENDO dell'orizzonte qui sotto: da solo non e' un bound sull'eta' di
 * una run.
 */
const MAX_JOB_DURATION_MIN = 350;

/**
 * Quanto una run puo' restare in CODA prima di eseguire.
 *
 * E' il pezzo che mancava. Il `timeout-minutes` di un job limita l'ESECUZIONE,
 * non l'eta' della run: la coda di concorrenza (`concurrency` con
 * `cancel-in-progress: false`), le catene di `needs` e l'attesa di un runner
 * stanno tutte PRIMA che il cronometro del job parta. E' la stessa assunzione
 * che #761 ha gia' smentito sul gemello `scan-job-timeouts.mjs`, dove la
 * riconciliazione a favore del sito e' stata accettata proprio sull'argomento
 * (a): «il timeout di un job non limita l'eta' della RUN».
 *
 * Il bound onesto e' quello che GitHub stesso impone: un job che resta in coda
 * oltre 24 ore viene cancellato. Una run che oggi risulta `failure` ha quindi
 * eseguito, e non puo' aver aspettato piu' di cosi' prima di farlo.
 *
 * Resta un'ASSUNZIONE, e come tale non va creduta: quel ragionamento tiene solo
 * se ogni percorso verso `conclusion: failure` passa dall'esecuzione di un job,
 * mentre un errore di valutazione del workflow, un `needs` risolto in failure
 * dopo una lunga attesa o un deployment gate scaduto possono dare a una run
 * un'eta' arbitraria (#789 item 3). Per questo il valore qui e' solo il PUNTO
 * DI PARTENZA: la verifica sta in `horizonPressure()`, che misura lo span
 * `createdAt -> updatedAt` realmente osservato su ogni run tornata dalla query
 * e alza la voce se si avvicina all'orizzonte. Misurato il 2026-09-04 su 800
 * run `failure` di questo repo: span massimo 227 minuti, p99 112 — l'orizzonte
 * di default ha ~8x di margine, e nessuna delle 40 run campionate era arrivata
 * a `failure` senza eseguire almeno un job.
 */
const MAX_RUN_QUEUE_WAIT_MIN = 24 * 60;

/**
 * Orizzonte della query `--created`, che NON e' il filtro.
 *
 * Il filtro vero e' `since` su `updatedAt` (`isReportableRun`); la query puo'
 * discriminare solo per `created`, quindi il suo cutoff deve coprire la massima
 * distanza possibile fra creazione e ultimo aggiornamento di una run.
 *
 * Prima valeva `LOOKBACK_MIN + 350 + 60`: ~7 ore. Una run rimasta in coda piu'
 * a lungo e fallita DENTRO la finestra di lookback aveva `createdAt` fuori dal
 * cutoff, quindi non usciva nemmeno dalla query — nessuna issue, nessun
 * warning, nessun conteggio nel gate di ricorrenza. E' esattamente il blind
 * spot che #692 voleva chiudere, sopravvissuto qui perche' #700/#761 hanno
 * sistemato solo lo scanner dei timeout.
 *
 * Perche' non i 35 giorni della retention, come il gemello: li' la query e' su
 * `cancelled` (migliaia di run) e per stare sotto il cap di 1.000 risultati per
 * search va bisecata pagina per pagina — il costo che #762 item 2 contesta
 * proprio su quello scanner. Qui il filtro e' `failure`, decine di run al
 * giorno: ~31 ore di orizzonte restano UNA chiamata sotto il cap. Il caso
 * residuo (una run in attesa di approvazione di un environment, fino a 30
 * giorni) si compra con `SCAN_FAILED_RUNS_HORIZON_MIN`, senza toccare il
 * codice e senza imporre la paginazione a ogni giro.
 */
export const DEFAULT_RUN_QUERY_HORIZON_MIN = MAX_RUN_QUEUE_WAIT_MIN + MAX_JOB_DURATION_MIN + 60;

/**
 * @param {string|undefined} raw valore grezzo di `SCAN_FAILED_RUNS_HORIZON_MIN`
 * @param {{warn?: (msg: string) => void}} [opts]
 * @returns {number} minuti; il default se il valore e' assente, non numerico o <= 0
 */
export function parseHorizonMin(raw, opts = {}) {
  return parsePositiveNum(raw, DEFAULT_RUN_QUERY_HORIZON_MIN, {
    label: 'SCAN_FAILED_RUNS_HORIZON_MIN',
    ...opts,
  });
}

const RUN_QUERY_HORIZON_MIN = parseHorizonMin(process.env.SCAN_FAILED_RUNS_HORIZON_MIN);

/**
 * L'orizzonte e' una stima, quindi va MISURATO invece che creduto: e' la
 * mancanza di questa misura ad aver reso la perdita silenziosa per mesi.
 *
 * ## Cosa si misura, e perche' non piu' l'eta' della run
 *
 * La quantita' che decide se una run sfugge alla query non e' la sua eta', ma
 * lo SPAN `createdAt -> updatedAt`: il filtro vero e' `updatedAt >= since`,
 * la query puo' discriminare solo su `createdAt`, quindi si perde esattamente
 * la run il cui span supera l'orizzonte. Misurare lo span invece dell'eta'
 * toglie di mezzo il bound assunto delle 24h di coda (#789 item 3): non serve
 * piu' credere che ogni `conclusion: failure` sia passata dall'esecuzione di
 * un job — una run che fallisce per errore di valutazione del workflow, per un
 * `needs` risolto in failure dopo una lunga attesa o per un deployment gate
 * scaduto contribuisce al campione con lo span che ha davvero.
 *
 * ## Perche' su TUTTE le run della query, non sulle sole segnalabili
 *
 * Il canary precedente vedeva solo le run gia' filtrate da `isReportableRun`,
 * cioe' quelle aggiornate dentro i 40 minuti di lookback: la banda utile era
 * di ~225 minuti su un orizzonte di 1.850, e un salto di regime che non
 * passasse per quella fessura restava muto (#789 item 4). Lo span invece e'
 * definito su ogni run tornata dalla query — campione ~40x piu' grande, stesso
 * costo, nessuna chiamata in piu'.
 *
 * Misura di riferimento al 2026-09-04 su questo repo: 800 run `failure`, span
 * massimo 227 minuti, p99 112. L'orizzonte di default (1.850) ha quindi un
 * margine di ~8x sull'osservato — ed e' questo numero, non l'assunzione, che
 * il log qui sotto tiene sotto osservazione a ogni giro.
 *
 * @param {Array<{createdAt?: string, updatedAt?: string, url?: string}>} runs
 * @param {{horizonMin: number, thresholdRatio?: number}} opts
 * @returns {{maxSpanMin: number|null, sampled: number, overThreshold: number,
 *            thresholdMin: number, worst: object|null}}
 */
export function horizonPressure(runs, { horizonMin, thresholdRatio = 0.9 }) {
  const thresholdMin = horizonMin * thresholdRatio;
  let maxSpanMin = null;
  let sampled = 0;
  let overThreshold = 0;
  let worst = null;
  for (const r of Array.isArray(runs) ? runs : []) {
    const created = Date.parse(r?.createdAt ?? '');
    const updated = Date.parse(r?.updatedAt ?? r?.createdAt ?? '');
    if (!Number.isFinite(created) || !Number.isFinite(updated) || updated < created) continue;
    sampled += 1;
    const spanMin = (updated - created) / 60_000;
    if (maxSpanMin === null || spanMin > maxSpanMin) {
      maxSpanMin = spanMin;
      worst = r;
    }
    if (spanMin >= thresholdMin) overThreshold += 1;
  }
  return { maxSpanMin, sampled, overThreshold, thresholdMin, worst };
}

/**
 * Rete di sicurezza, non filtro primario: `--created` gia' delimita la query
 * per data, quindi 60 fallimenti in piu' nella finestra non troncano piu' il
 * fetch prima ancora di guardare il tempo (issue #674 — con `--limit 60` fisso
 * un run ceduto a scan-job-timeouts.mjs e poi tornato ordinario poteva uscire
 * dal fetch stesso, non solo dal filtro, se nel frattempo si accumulavano 60
 * nuovi fallimenti).
 *
 * Ma un cap su `gh run list` NON tronca a caso: la lista torna ordinata per
 * `createdAt` DECRESCENTE, quindi a sparire sono sempre le run PIU' VECCHIE
 * della finestra — cioe' esattamente la classe che l'orizzonte largo di #763
 * esiste per recuperare (la run rimasta a lungo in coda). Sotto una tempesta
 * di fallimenti il fix regrediva in silenzio al blind spot proprio quando
 * serve di piu' (#789 item 1). Da qui la bisezione: se una finestra torna
 * piena, la si taglia in due e si interroga ogni meta', finche' nessuna slice
 * e' al cap. Costo zero nel caso normale — una sola chiamata, come prima —
 * e nessun buco nel caso patologico.
 */
const FAILED_RUNS_SAFETY_CAP = 500;

/**
 * Profondita' massima della bisezione. 8 split su ~31,5 ore portano la slice
 * minima a ~7 minuti: oltre, il taglio non separa piu' nulla di utile e la
 * cosa onesta e' dichiarare il troncamento con i suoi estremi invece di
 * ricorrere all'infinito.
 */
const FAILED_RUNS_MAX_SPLIT_DEPTH = 8;

/**
 * Fetch di una finestra `created`, bisecata quando tocca il cap.
 *
 * Puro e iniettabile: `fetchWindow(startIso, endIso|null)` fa la chiamata vera
 * in produzione e viene sostituito nei test.
 *
 * @param {number} startMs estremo inferiore (incluso)
 * @param {number|null} endMs estremo superiore (incluso), o `null` per "aperta a destra"
 * @param {{fetchWindow: (a: string, b: string|null) => Array<object>, nowMs: number,
 *          cap?: number, maxDepth?: number, warn?: (m: string) => void}} opts
 * @returns {Array<object>} run deduplicate per `databaseId`
 */
export function fetchRunsBisected(startMs, endMs, opts) {
  const {
    fetchWindow,
    nowMs,
    cap = FAILED_RUNS_SAFETY_CAP,
    maxDepth = FAILED_RUNS_MAX_SPLIT_DEPTH,
    warn = console.warn,
  } = opts;
  const byId = new Map();

  const slice = (aMs, bMs, depth) => {
    const batch = fetchWindow(new Date(aMs).toISOString(), bMs === null ? null : new Date(bMs).toISOString());
    for (const r of Array.isArray(batch) ? batch : []) {
      byId.set(r?.databaseId ?? `${r?.url ?? ''}${r?.createdAt ?? ''}`, r);
    }
    if (!Array.isArray(batch) || batch.length < cap) return;
    const rightEndMs = bMs === null ? nowMs : bMs;
    const midMs = Math.floor((aMs + rightEndMs) / 2);
    if (depth >= maxDepth || midMs <= aMs || midMs >= rightEndMs) {
      warn(
        `::warning::[scan-failed-runs] cap di sicurezza (${cap}) ancora raggiunto dopo ${depth} `
          + `bisezioni sulla finestra ${new Date(aMs).toISOString()}..`
          + `${bMs === null ? 'ora' : new Date(bMs).toISOString()} — `
          + 'il troncamento di `gh run list` cade sulle run con `createdAt` piu\' VECCHIO, '
          + 'cioe\' proprio quelle rimaste a lungo in coda: in questa slice possono mancare.',
      );
      return;
    }
    // Intervalli disgiunti al millisecondo: nessun buco, nessun doppio
    // conteggio sul confine (`byId` resta comunque l'ultima difesa).
    slice(aMs, midMs, depth + 1);
    slice(midMs + 1, bMs, depth + 1);
  };

  slice(startMs, endMs, 0);
  return [...byId.values()];
}

/** Run fallite nella finestra, escluse quelle da pull_request e dai gate pre-merge in preview. */
function failedRuns() {
  const nowMs = Date.now();
  const since = new Date(nowMs - LOOKBACK_MIN * 60_000).toISOString();
  const queryCutoffMs = nowMs - (LOOKBACK_MIN + RUN_QUERY_HORIZON_MIN) * 60_000;
  const fetchWindow = (startIso, endIso) => {
    const raw = gh(
      ['run', 'list', '--repo', REPO, '--status', 'failure', '--limit', String(FAILED_RUNS_SAFETY_CAP),
        '--created', endIso === null ? `>=${startIso}` : `${startIso}..${endIso}`,
        '--json', 'databaseId,workflowName,conclusion,event,createdAt,updatedAt,headBranch,url'],
      '[]',
    );
    try {
      const parsed = JSON.parse(raw || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  };
  const runs = fetchRunsBisected(queryCutoffMs, null, { fetchWindow, nowMs });
  const reportable = runs.filter((r) => isReportableRun(r, { since }));
  const pressure = horizonPressure(runs, { horizonMin: RUN_QUERY_HORIZON_MIN });
  if (pressure.maxSpanMin !== null) {
    console.log(
      `[scan-failed-runs] span createdAt->updatedAt massimo osservato: `
        + `${Math.round(pressure.maxSpanMin)} min su ${pressure.sampled} run, `
        + `contro un orizzonte di ${RUN_QUERY_HORIZON_MIN} min.`,
    );
  }
  if (pressure.overThreshold > 0) {
    console.warn(
      `::warning::[scan-failed-runs] ${pressure.overThreshold} run con span createdAt->updatedAt `
        + `oltre ${Math.round(pressure.thresholdMin)} minuti (peggiore: ${Math.round(pressure.maxSpanMin)} min, `
        + `${pressure.worst?.url ?? 'url ignoto'}) contro un orizzonte di ${RUN_QUERY_HORIZON_MIN} — `
        + 'lo scarto fra creazione e ultimo aggiornamento si sta avvicinando al cutoff `--created`, '
        + 'oltre il quale i fallimenti sparirebbero dalla query in silenzio. '
        + 'Alzare SCAN_FAILED_RUNS_HORIZON_MIN.',
    );
  }
  return reportable;
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
 *
 * Il prefisso di ricerca passa da `searchSafePrefix()` (stesso helper condiviso
 * usato da `findIssueReportingRun` in scan-job-timeouts.mjs), non dal
 * `title.slice(0, 60)` grezzo: quel taglio puo' spezzare una parola o lasciare
 * una parentesi sbilanciata, e la ricerca `gh` su una frase cosi' rotta ritorna
 * zero risultati — la issue canonica esiste ma non si trova, e se ne apre una
 * doppia.
 */
export function alreadyReported(title, runUrl) {
  const titlePrefix = searchSafePrefix(title);
  const raw = gh(
    ['issue', 'list', '--repo', REPO, '--state', 'open', '--search', `${titlePrefix} in:title`, '--json', 'number,title', '--limit', '10'],
    '[]',
  );
  let issues = [];
  try {
    issues = JSON.parse(raw || '[]');
  } catch {
    return false;
  }
  const match = issues.filter((i) => (i.title || '').startsWith(titlePrefix));
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
      '[.jobs[] | select(.conclusion=="failure") | '
        + '{name, url: .html_url, step: ([.steps[]? | select(.conclusion=="failure") | .name] | first), '
        + 'status, conclusion, completed_at, steps}]'],
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
 *
 *   MA nominarlo non basta, e la prima stesura di questo body lo dimostrava.
 *   `detectWorkflowScoped()` (scripts/lib/workflow-scope-detect.mjs) e'
 *   ESCLUSIVO per costruzione: cita >=1 workflow E **zero** path di codice
 *   non-workflow. Un solo `<dir>/<file>.<ext>` sotto una delle cartelle di
 *   `CODE_PATH_RE` (`scripts`, `src`, `services`, `build`, ...) riapre la
 *   valvola "la fix potrebbe stare li'" e il verdetto torna `false`. Il body
 *   ne aveva due — l'helper di rebase nel punto 2 e la firma dell'auto-filer
 *   in fondo — quindi Mode 1 NON corto-circuitava e il fixer partiva lo
 *   stesso: esattamente il costo che questa citazione dice di evitare.
 *   Misurato eseguendo il detector sul body reale: `false` sia con la copia di
 *   questo repo sia con quella del sito post-#5599.
 *
 *   La #231 ha ristabilito il verdetto TOGLIENDO i nomi: «l'helper di rebase in
 *   scripts/lib/ (nome file omesso qui apposta…)», «dallo scanner delle run
 *   fallite», «il reconciler che chiude in automatico». Verdetto giusto, prezzo
 *   sbagliato: il `## Suggested action` esiste per dire A UN UMANO che cosa
 *   aprire, e al punto 2 gli spiegava perche' non glielo diceva. Nella stessa
 *   riscrittura sono spariti anche `close-recovered-failure-issues.mjs` e il
 *   nome dell'auto-filer, che non erano nemmeno il problema: senza cartella
 *   davanti `CODE_PATH_RE` non li vedeva.
 *
 *   Il rimedio che tiene tutte e due le cose: scrivere ogni referente che NON e'
 *   un fix target come **nome file + cartella separati**
 *   (`` `rebase-onto-remote.sh` ``, sotto `` `scripts/lib/` ``) invece che come
 *   path unico. `CODE_PATH_RE` vuole cartella ed estensione ATTACCATE, quindi
 *   nessuna delle due meta' matcha da sola, mentre `git ls-files | grep` le
 *   trova entrambe. L'unico path scritto per intero resta il fix target vero,
 *   che e' il workflow. La #5599 aveva coperto la stessa trappola per le issue
 *   `Workflow Failure:`/`CI Failure:` con `isMonitorFiledWorkflowFailure()`,
 *   che pero' aggancia sul PREFISSO DEL TITOLO: questo titolo sta apposta
 *   fuori da quei prefissi (vedi CLOSER sopra), quindi quella scorciatoia qui
 *   non scatta e l'invariante va tenuta a mano — pinnata dal test
 *   "il body della issue ricca e' esclusivamente workflow-scoped" in
 *   generator/tests/scan-failed-runs-filter.test.mjs, che chiama il detector
 *   vero sul body vero.
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

  // ⚠ INVARIANTE DI ROUTING — vedi la nota FIXER in testa al file.
  // L'unico path completo `<cartella>/<file>.<ext>` ammesso qui dentro e' il
  // workflow (`wfPath`): e' il fix target vero, ed e' cio' che fa corto-
  // circuitare check-workflows-scope.mjs Mode 1 senza spendere token. Ogni
  // altro referente va scritto come nome file e cartella SEPARATI
  // (`` `x.mjs` ``, sotto `` `scripts/ci/` ``), altrimenti CODE_PATH_RE lo
  // legge come possibile fix target e il corto-circuito salta in silenzio.
  // Il test "il body della issue ricca e' esclusivamente workflow-scoped"
  // chiama il detector vero su questo body: se qui rientra un path, diventa rosso.
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
    `2. In quel caso il path va aggiunto alla allowlist di bookkeeping che \`${wfPath}\` passa`,
    '   all\'helper di rebase — file `rebase-onto-remote.sh`, sotto `scripts/lib/`. L\'helper ha gia\' il',
    '   ramo che risolve cosi\' (issue #76): non serve logica nuova, serve dichiarare che il file',
    '   appartiene a quella categoria.',
    '3. Se invece e\' un registro append-only del corpus (`blog-articles-data.ts`, `blog-meta-*.ts`, sotto',
    '   `content/`), "prendi upstream" NON va bene: cancellerebbe il record dell\'articolo. Il path va',
    '   dichiarato con `--merge-registry`, che manda il conflitto a `merge-content-registry-conflict.mjs`',
    '   (sotto `scripts/lib/`): unisce i RECORD dei due lati e rifiuta di scrivere cio\' che non sa',
    '   dimostrare sano. NON metterlo fra i path nudi del punto 2 — li\' verrebbe "risolto" cancellando',
    '   dal registro l\'articolo appena generato e lasciandone i corpi sul posto, cioe\' un fantasma',
    '   invece di una perdita (issue #255, #281, #285).',
    '4. Se e\' un file PER-ARTICOLO che porta lo slug nel nome — `content/blog-body{,-ch}/<locale>/<slug>.ts`,',
    '   `data/{blog,swiss}-articles/<slug>.json`, l\'immagine hero — il conflitto e\' un add/add fra due run',
    '   che hanno generato lo STESSO slug, e la categoria e\' `--take-theirs` (per PREFISSO): vince il',
    '   commit rigiocato, lo stesso lato che vince nel merge dei registri.',
    '5. Il test che prova la scelta e\' `rebase-onto-remote.test.mjs`, sotto `generator/tests/`: legge le',
    '   tre categorie dal workflow e ci fa girare sopra un conflitto vero.',
    '',
    '---',
    '',
    'Issue aperta automaticamente da `scan-failed-runs.mjs`, sotto `scripts/ci/`. **Non si chiude da sola su',
    'una run verde**: `close-recovered-failure-issues.mjs` copre solo i titoli `Workflow Failure:`/`CI Failure:`/',
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

    const allFailedJobs = failedJobs(run.databaseId);
    const { ordinary: jobs, timeoutScanner: timeoutOwnedJobs } = partitionFailedJobsByOwner(allFailedJobs);

    if (timeoutOwnedJobs.length > 0) {
      console.log(
        `[scan-failed-runs] ${name}: ${timeoutOwnedJobs.length} job con firma host-kill `
          + 'ceduto a scan-job-timeouts.mjs (nessun doppio conteggio nel gate).',
      );
      // Una run puo' contenere sia un host-kill sia un failure ordinario in un
      // altro job: in quel caso il secondo resta segnalabile. Si salta la run
      // solo quando ogni job fallito appartiene al detector specializzato.
      if (jobs.length === 0) continue;
    }

    // Rosso VOLUTO (issue #170): la run e' ferma su uno step di skip dichiarato,
    // non su un guasto. Segnalarla apre una "Workflow Failure" che nessun fix
    // puo' chiudere — il rosso torna alla finestra di quota successiva — e la
    // ricorrenza la fa escalare a `needs-human`. Si salta PRIMA della dedup e
    // prima del rilevatore ricco: non c'e' niente da arricchire.
    if (isDeclaredSkipOnly(jobs)) {
      console.log(`[scan-failed-runs] ${name}: run ${run.databaseId} rossa solo per skip dichiarato (${jobs.map((j) => j.step).join(', ')}) → nessuna issue.`);
      continue;
    }

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
