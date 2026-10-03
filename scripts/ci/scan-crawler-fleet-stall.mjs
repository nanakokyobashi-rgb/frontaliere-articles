#!/usr/bin/env node
/**
 * scan-crawler-fleet-stall.mjs — apre una issue quando la flotta crawler gira
 * VERDE e non consegna niente.
 *
 * ## La classe di guasto, e perche' nessun altro rilevatore la vede
 *
 * I `crawler-group-NN.yml` scrivono la loro raccolta nel repo SITO con un
 * commit `Auto-update crawler group NN jobs`. Quando il commit non atterra, la
 * run NON diventa rossa: il percorso di commit classifica il caso come
 * "systemic class" ed esce 0 con un `::warning::`, per scelta — una contesa sul
 * ref o un lease occupato non sono guasti del crawler.
 *
 * Conseguenza: `workflow-failure-issues.yml` non puo' vederla, perche' filtra su
 * `conclusion == failure`, e nemmeno deve. E' esattamente la stessa forma del
 * guasto che `generation-health-watchdog.yml` intercetta per la generazione
 * articoli («ROTTA MA VERDE»): il difetto non e' mai nel singolo run, e' nella
 * SERIE, e nessuno step dentro un run ha il denominatore per accorgersene.
 *
 * Quel pattern non era mai stato puntato sulla flotta crawler. Misurato il
 * 2026-09-18: **124 ore** in cui 15 gruppi su 23 non hanno committato nulla,
 * con run verdi e zero issue aperte. Un gruppo ha girato con 27 membri su 27
 * riusciti (run 35351794322) e ha scartato l'intera raccolta perche' il lease
 * globale era occupato. Questo script e' l'allarme che mancava.
 *
 * ## Perche' la storia git e non `gh run list`
 *
 * Su questo fleet `gh run list --workflow crawler-group-NN.yml` non e'
 * affidabile: il 2026-09-18 ha reso run vecchie di 17-24 giorni mentre i commit
 * del gruppo erano di poche ore. E soprattutto misurerebbe la domanda sbagliata
 * — "la run e' girata" invece di "il dato e' atterrato". L'oracolo e' il commit,
 * perche' il commit E' la consegna.
 *
 * ## La soglia, e da dove viene (al secondo tentativo)
 *
 * Baseline misurata dal 2026-09-05 al 2026-09-13: **tutti i gruppi consegnano
 * OGNI giorno**, in una o due ondate (23-48 commit/giorno). Dal 2026-09-14:
 * 2, 0, 4, 6, 2 gruppi distinti al giorno.
 *
 * La prima versione usava «zero consegne in 6 ore», che sembra la condizione
 * ovvia e misurata contro i dati reali NON SUONAVA: i vincitori del convoglio
 * ruotano, quindi 1-2 gruppi filtrano sempre e "zero" resta falso mentre il 91%
 * della flotta non consegna. Avrebbe preso solo il 2026-09-15, l'unico giorno a
 * zero assoluto.
 *
 * Il segnale che separa e' la COPERTURA, non il silenzio: minimo sano 21,
 * massimo rotto 6, quindi qualunque soglia fra 7 e 20 divide le due popolazioni
 * senza sovrapposizione. La soglia e' meta' della flotta CONTATA (vedi
 * `MIN_COVERAGE_FRACTION` e `countCrawlerGroups`), su una finestra di 24 ore che
 * contiene sempre almeno un'ondata intera — con 6 ore un'ondata sana appena
 * fuori finestra darebbe un falso positivo. Resta la condizione `hard-stop` per
 * lo zero assoluto, ma solo quando anche la copertura completa e' sotto soglia:
 * una pausa tra due ondate sane non deve contraddire la prova delle consegne.
 *
 * ## Un allarme che tace e' peggio di un allarme assente
 *
 * Due decisioni che sembrano simmetriche e non lo sono:
 *
 * - non riuscire a LEGGERE la storia dei commit e' fail-open deliberato
 *   (nessun verdetto, exit 0, detto nel log): un allarme che suona quando e'
 *   cieco viene silenziato, e allora non suona piu' nemmeno quando serve;
 * - non riuscire a CONSEGNARE il verdetto, o un'eccezione non prevista, escono
 *   NON-ZERO. Qui lo stato che si perde non e' un dato, e' l'allarme stesso: un
 *   fallimento silenzioso riprodurrebbe esattamente il guasto da segnalare —
 *   124 ore senza traccia — e lo renderebbe indistinguibile da un fleet sano.
 *
 * ## La chiusura: consegna sostenuta, non il primo verdetto OK
 *
 * Lo scanner richiude la propria issue, ma NON sul verdetto `delivering`: la
 * copertura 24h e' troppo larga per provare la guarigione (un'ondata intera
 * persa resta sopra soglia). Chiude solo quando `sustainedDelivery` dice che
 * gli ultimi tre giorni UTC completi sono sopra soglia e che nelle ultime 72
 * ore nessun intervallo fra consegne supera `CLOSE_MAX_GAP_HOURS`. Rispetta
 * `keep-open` / `agent:no-age-out`; una storia illeggibile non chiude niente.
 *
 * Uso:
 *   node scripts/ci/scan-crawler-fleet-stall.mjs [--dry-run] [--stall-hours N]
 *                                                [--window-hours N]
 * Env:
 *   GH_TOKEN            necessario per gh.
 *   GITHUB_REPOSITORY   owner/repo di QUESTO repo (auto in Actions).
 *   SITE_REPO           default `valerielinc-ops/frontaliere-si-o-no`.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { commentOnGithubIssue, createGithubIssue, resolveGithubIssue } from '../lib/github-issue-creator.mjs';
import { parsePositiveNum } from '../lib/parse-positive-num.mjs';

const ARGV = process.argv.slice(2);
const flag = (n) => ARGV.includes(n);
const val = (n, d) => {
  const i = ARGV.indexOf(n);
  return i !== -1 && ARGV[i + 1] ? ARGV[i + 1] : d;
};

const DRY_RUN = flag('--dry-run');
/** Default di `--stall-hours`; esportato perche' `sustainedDelivery` lo riusa. */
export const DEFAULT_STALL_HOURS = 6;
const STALL_HOURS = parsePositiveNum(val('--stall-hours', undefined), DEFAULT_STALL_HOURS, { label: '--stall-hours' });
// Finestra letta dall'API: deve essere abbastanza larga da distinguere "fermo
// da 7 ore" da "fermo da 124", perche' quel numero e' la prima cosa che serve
// a chi apre la issue. Non e' la soglia.
const WINDOW_HOURS = parsePositiveNum(val('--window-hours', undefined), 168, { label: '--window-hours' });
const SITE_REPO = process.env.SITE_REPO || 'valerielinc-ops/frontaliere-si-o-no';

/** Il messaggio che i workflow generati usano per la consegna. Unica sorgente. */
export const GROUP_COMMIT_RE = /^Auto-update crawler group (\d{2}) jobs/;

/**
 * Quanti crawler-group esistono, dalla cardinalità del contratto invece di una
 * costante duplicata nel rilevatore.
 *
 * Era una costante 23, e la review ha ragione: regex, denominatore e soglia
 * tarati su una cardinalita' fissa smettono di rappresentare "meta' della
 * flotta" appena la flotta cresce. Un gruppo 24 aggiunto avrebbe lasciato la
 * soglia a 12 su 24 — cioe' avrebbe richiesto che METÀ ESATTA fallisse prima
 * di suonare, silenziosamente piu' permissiva ogni volta che il fleet cresce.
 *
 * Il contratto e' la sorgente autorevole anche quando il checkout e' sparse o
 * sta attraversando il trasporto sito→corpus. I workflow locali servono solo
 * come fallback quando il contratto non e' leggibile; l'ultimo fallback resta
 * la cardinalità corrente nota invece di zero.
 */
export const FALLBACK_GROUP_COUNT = 24;

const CONTRACT_PATH = 'generator/data/crawler-cross-repo-contract.json';

function readContractGroupCount(contractPath = CONTRACT_PATH) {
  try {
    const contract = JSON.parse(readFileSync(contractPath, 'utf8'));
    const n = Number(contract?.groupCount);
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export function countCrawlerGroups(dir = '.github/workflows', contractPath = CONTRACT_PATH) {
  const contractCount = readContractGroupCount(contractPath);
  if (contractCount !== null) return contractCount;
  try {
    const n = readdirSync(dir).filter((f) => /^crawler-group-\d+\.yml$/.test(f)).length;
    return n > 0 ? n : FALLBACK_GROUP_COUNT;
  } catch {
    return FALLBACK_GROUP_COUNT;
  }
}

export const EXPECTED_GROUPS = countCrawlerGroups();

/** La soglia e' una FRAZIONE della flotta, non un assoluto. Vedi MIN_GROUPS_PER_DAY. */
export const MIN_COVERAGE_FRACTION = 0.5;

function gh(args, fallback = null) {
  try {
    return execFileSync('gh', args, {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (e) {
    console.warn(`[fleet-stall] gh ${args.slice(0, 3).join(' ')} fallito: ${String(e.message).slice(0, 160)}`);
    return fallback;
  }
}

/**
 * Estrae i commit di consegna dei gruppi da una lista di commit dell'API.
 *
 * Puro e esportato: e' la logica che decide se l'allarme suona, e un test la
 * esercita senza rete.
 *
 * @param {Array<{commit?: {message?: string, committer?: {date?: string}}}>} rows
 * @returns {Array<{group: string, atMs: number}>}
 */
export function groupDeliveries(rows, nowMs = Date.now()) {
  const out = [];
  let future = 0;
  for (const r of Array.isArray(rows) ? rows : []) {
    const msg = String(r?.commit?.message || '').split('\n')[0];
    const m = GROUP_COMMIT_RE.exec(msg);
    if (!m) continue;
    const atMs = Date.parse(r?.commit?.committer?.date || '');
    if (!Number.isFinite(atMs)) continue;
    // Un timestamp nel FUTURO va scartato, non contato come consegna recente.
    // `committer.date` e' fornito dal client che ha pushato, quindi un clock
    // skew su un runner puo' datare un commit avanti; conteggiarlo renderebbe
    // "recente" una consegna che non e' avvenuta, e sopprimerebbe l'allarme
    // proprio nel verso sbagliato. 5 minuti di tolleranza assorbono lo skew
    // normale senza ammettere date inventate.
    if (atMs > nowMs + 5 * 60_000) {
      future += 1;
      continue;
    }
    out.push({ group: m[1], atMs });
  }
  if (future > 0) {
    console.warn(`[fleet-stall] ${future} consegne con data nel futuro scartate (clock skew?).`);
  }
  return out.sort((a, b) => b.atMs - a.atMs);
}

/**
 * Decodifica il TSV di `gh api` senza confondere una risposta VUOTA con un
 * errore di lettura.
 *
 * E' la distinzione su cui si regge l'allarme: `''` = API raggiunta e nessuna
 * consegna nella finestra (cioe' lo stallo totale, il caso peggiore, che deve
 * SUONARE); `null` = il wrapper `gh()` ha fallito e il verdetto deve restare
 * fail-open. Prima erano lo stesso valore e il caso peggiore usciva zitto.
 *
 * Ogni riga e' `<iso-date>\t<prima riga del messaggio>`. Si ricostruisce la
 * forma dell'API perche' `groupDeliveries` resta puro su quella forma ed e' la
 * funzione che i test esercitano senza rete. Una riga = un record, prodotta da
 * `--jq ... | @tsv`: la versione precedente incollava gli array di
 * `--paginate` con una regex (`/\]\s*\[/`) e li riparsava, fragile per
 * costruzione — una pagina finale vuota, uno spazio diverso o un `][` dentro
 * un messaggio di commit rendevano il JSON non parsabile, e il fail-open
 * trasformava l'errore in SILENZIO invece che in un allarme.
 *
 * @param {string|null|undefined} raw
 * @returns {{rows: Array<{commit: {message: string, committer: {date: string}}}>, readable: boolean, bad: number}}
 */
export function parseDeliveryRows(raw) {
  if (raw === null || raw === undefined) return { rows: [], readable: false, bad: 0 };
  const rows = [];
  let bad = 0;
  for (const line of String(raw).split('\n')) {
    if (!line.trim()) continue;
    const tab = line.indexOf('\t');
    if (tab === -1) { bad += 1; continue; }
    const date = line.slice(0, tab);
    const message = line.slice(tab + 1);
    if (!date) { bad += 1; continue; }
    rows.push({ commit: { message, committer: { date } } });
  }
  // Una riga rotta NON invalida la lettura: il conteggio scende e al massimo
  // l'allarme suona in anticipo, che e' il verso giusto in cui sbagliare.
  return { rows, readable: rows.length > 0 || String(raw).trim() === '', bad };
}

/**
 * Copertura minima di gruppi distinti in 24 ore sotto cui il fleet e' rotto.
 *
 * **Non e' un numero scelto a intuito, ed e' il secondo tentativo.** La prima
 * versione di questo allarme usava "zero consegne in 6 ore", e misurata contro
 * i dati reali NON SUONAVA durante lo stallo del 2026-09-14/18: i vincitori del
 * convoglio ruotano, quindi 1-2 gruppi su 23 filtrano sempre e la condizione
 * "zero" resta falsa mentre il 91% della flotta non consegna. Avrebbe preso
 * solo il 2026-09-15, l'unico giorno con zero assoluto.
 *
 * Il segnale che separa davvero e' la COPERTURA, non il silenzio. Misurato
 * sulla stessa finestra di 168 ore:
 *
 *   sano   2026-09-11: 22/23   2026-09-12: 21/23   2026-09-13: 23/23
 *   rotto  2026-09-14:  2/23   2026-09-16:  4/23   2026-09-17:  6/23
 *          2026-09-18:  2/23   2026-09-15:  0/23
 *
 * Minimo sano 21, massimo rotto 6: qualunque soglia fra 7 e 20 separa le due
 * popolazioni senza sovrapposizione. 12 e' circa la meta' della flotta, sta nel
 * mezzo dell'intervallo e sopravvive a un'ondata parziale (un'ondata sana ne
 * consegna >=21, e anche mezza ondata ne fa ~11-12 — per questo la finestra e'
 * 24 ore, che contiene sempre almeno un'ondata intera, e non 6).
 */
export const MIN_GROUPS_PER_DAY = Math.max(2, Math.round(EXPECTED_GROUPS * MIN_COVERAGE_FRACTION));

/** Ampiezza della finestra di copertura. Contiene sempre almeno un'ondata. */
export const COVERAGE_WINDOW_HOURS = 24;

/**
 * Verdetto sullo stallo: la copertura e' il segnale comune; il silenzio recente
 * distingue solo il hard-stop dalla sotto-copertura parziale.
 *
 * - `hard-stop`: nessuna consegna da `stallHours` E copertura sotto soglia
 *   nell'intera finestra. Prende il caso pulito (il 2026-09-15 fu zero
 *   assoluto) senza scambiare la pausa fra due ondate sane per uno stallo.
 * - `under-coverage`: meno di `MIN_GROUPS_PER_DAY` gruppi distinti in 24 ore.
 *   Prende il caso REALE, che la prima condizione da sola non vede, perche' un
 *   convoglio che fa passare 2 gruppi su 23 non e' mai "silenzioso".
 *
 * Fail-CLOSED su lista vuota? No: fail-open. Se l'API non risponde non si
 * distingue "nessuna consegna" da "non ho potuto leggere", quindi l'assenza di
 * dati NON suona e il chiamante lo dice nel log. Un allarme che suona quando e'
 * cieco viene silenziato in una settimana.
 *
 * @param {{deliveries: Array<{group: string, atMs: number}>, nowMs: number,
 *   stallHours: number, readable: boolean, minGroups?: number,
 *   coverageWindowHours?: number}} a
 */
export function stallVerdict({
  deliveries,
  nowMs,
  stallHours,
  readable,
  minGroups = MIN_GROUPS_PER_DAY,
  coverageWindowHours = COVERAGE_WINDOW_HOURS,
}) {
  if (!readable) {
    return { stalled: false, reason: 'unreadable', lastAtMs: null, idleHours: null, recentGroups: [], coverage: null };
  }
  const last = deliveries.length > 0 ? deliveries[0] : null;
  const idleHours = last ? (nowMs - last.atMs) / 3600_000 : null;
  const recentGroups = [...new Set(
    deliveries.filter((d) => nowMs - d.atMs <= stallHours * 3600_000).map((d) => d.group),
  )];
  const coverage = [...new Set(
    deliveries.filter((d) => nowMs - d.atMs <= coverageWindowHours * 3600_000).map((d) => d.group),
  )];

  if (recentGroups.length === 0 && coverage.length < minGroups) {
    return {
      stalled: true,
      reason: last ? 'hard-stop' : 'no-delivery-in-window',
      lastAtMs: last?.atMs ?? null,
      idleHours,
      recentGroups,
      coverage: coverage.length,
    };
  }
  if (coverage.length < minGroups) {
    return {
      stalled: true, reason: 'under-coverage', lastAtMs: last.atMs, idleHours, recentGroups, coverage: coverage.length,
    };
  }
  return {
    stalled: false, reason: 'delivering', lastAtMs: last.atMs, idleHours, recentGroups, coverage: coverage.length,
  };
}

/** Gruppi distinti che hanno consegnato, per giorno UTC — la prova nella issue. */
export function deliveriesByDay(deliveries) {
  const byDay = new Map();
  for (const d of deliveries) {
    const day = new Date(d.atMs).toISOString().slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, new Set());
    byDay.get(day).add(d.group);
  }
  return [...byDay.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([day, set]) => ({ day, groups: set.size }));
}

/**
 * Titolo canonico dell'allarme: UNICO per entrambi i verdetti di stallo e
 * UNICO fra apertura e chiusura.
 *
 * Con due titoli, un incidente che passa da `under-coverage` a `hard-stop`
 * (che e' il PEGGIORAMENTO dello stesso guasto, non un guasto nuovo) sfuggiva
 * alla dedup e apriva una seconda issue. Il titolo e' anche la chiave con cui
 * `closeRecoveredStallIssue` cerca la issue da chiudere: se apertura e chiusura
 * usassero due letterali, la chiusura cercherebbe una issue che nessuno apre.
 * Il titolo identifica la CONDIZIONE, non la sua severita'.
 */
export const STALL_ISSUE_TITLE = 'Crawler fleet: i gruppi non consegnano dati';

/** Giorni UTC COMPLETI (oggi escluso) di consegna sopra soglia per chiudere. */
export const CLOSE_SUSTAINED_DAYS = 3;

/**
 * Massimo intervallo fra due consegne consecutive (e fra l'ultima e adesso)
 * ammesso per chiudere l'allarme. Separa «pausa fra due ondate» da «ondata
 * persa».
 *
 * Le ondate partono alle 09:00 e alle 21:00 UTC (Cloud Scheduler →
 * `orchestrate-crawlers.yml` del sito) e consegnano in circa 1,7 ore. Misurato
 * il 2026-10-03 sulla storia dei commit del sito, gap fra consegne di gruppo:
 *
 *   sano (ondate puntuali)  10-01: 10,34h   10-02: 10,42h / 10,27h   10-03: 10,36h
 *   ondata persa/in ritardo 09-28: 15,35h   09-30: 17,40h (ricorrenza 12:51Z a 14,4h)
 *   un'ondata intera persa con cadenza puntuale: ~22,3h
 *
 * 13 ore sta sopra il massimo sano (10,4) con ~2,5 ore di margine per un'ondata
 * che parte in ritardo, e sotto il minimo di un'ondata persa (14,4 gia' alla
 * ricorrenza del 30-09). Un ritardo oltre il margine tiene aperta la issue per
 * un altro giro: e' il verso giusto in cui sbagliare per un criterio di
 * CHIUSURA.
 */
export const CLOSE_MAX_GAP_HOURS = 13;

const DAY_MS = 24 * 3600_000;

/**
 * Criterio di CHIUSURA dell'allarme: consegna SOSTENUTA, non il primo verdetto
 * OK.
 *
 * Perche' non basta `stallVerdict(...).stalled === false`: con una copertura di
 * almeno `MIN_GROUPS_PER_DAY` gruppi nelle 24 ore il verdetto e' `delivering`
 * ANCHE quando un'ondata intera e' andata persa — la ricorrenza del 30-09
 * (14,4 ore senza consegne) sarebbe passata per guarita. La issue era gia'
 * stata chiusa a mano il 27-09 e riaperta tre giorni dopo da uno stallo vero.
 * Chiudere su quel verdetto userebbe un segnale troppo largo come prova di
 * guarigione; qui il verdetto e' una condizione necessaria, non sufficiente.
 *
 * `sustained` e' vero solo se TUTTE:
 * - la storia e' leggibile (`readable === true`; cieco non vuol dire guarito);
 * - `stallVerdict` non dichiara lo stallo;
 * - in ciascuno degli ultimi `days` giorni UTC completi (oggi escluso) i gruppi
 *   distinti che hanno consegnato sono almeno `minGroups`;
 * - nelle ultime `days × 24` ore nessun intervallo fra consegne consecutive, ne'
 *   fra l'ultima consegna e adesso, supera `maxGapHours` (nessuna ondata persa).
 *   Il primo intervallo parte dall'ultima consegna PRIMA della finestra, se la
 *   finestra letta la contiene: un buco a cavallo dell'inizio conta per intero.
 *
 * Pura e senza rete: e' la funzione che decide se un allarme si chiude.
 *
 * @param {{deliveries: Array<{group: string, atMs: number}>, nowMs: number,
 *   readable: boolean, days?: number, maxGapHours?: number, minGroups?: number,
 *   stallHours?: number}} a
 * @returns {{sustained: boolean, reason: string, detail: string,
 *   perDay: Array<{day: string, groups: number}>, maxGapHours: number|null,
 *   maxGapEndMs: number|null, windowHours: number, gapLimitHours: number}}
 *   `maxGapHours` e' il gap MISURATO; `gapLimitHours` la soglia applicata.
 */
export function sustainedDelivery({
  deliveries,
  nowMs,
  readable,
  days = CLOSE_SUSTAINED_DAYS,
  maxGapHours = CLOSE_MAX_GAP_HOURS,
  minGroups = MIN_GROUPS_PER_DAY,
  stallHours = DEFAULT_STALL_HOURS,
}) {
  const windowHours = days * 24;
  const base = {
    sustained: false, perDay: [], maxGapHours: null, maxGapEndMs: null, windowHours, gapLimitHours: maxGapHours,
  };
  if (readable !== true) {
    return { ...base, reason: 'unreadable', detail: 'storia dei commit illeggibile' };
  }
  // Ordinate dalla piu' recente, come le rende `groupDeliveries`: `stallVerdict`
  // legge l'ultima consegna dal primo elemento.
  const list = (Array.isArray(deliveries) ? deliveries : [])
    .filter((d) => d.atMs <= nowMs)
    .sort((a, b) => b.atMs - a.atMs);

  const todayStartMs = Date.parse(`${new Date(nowMs).toISOString().slice(0, 10)}T00:00:00Z`);
  const perDay = [];
  for (let i = days; i >= 1; i -= 1) {
    const startMs = todayStartMs - i * DAY_MS;
    const endMs = startMs + DAY_MS;
    const groups = new Set(list.filter((d) => d.atMs >= startMs && d.atMs < endMs).map((d) => d.group)).size;
    perDay.push({ day: new Date(startMs).toISOString().slice(0, 10), groups });
  }

  const windowStartMs = nowMs - windowHours * 3600_000;
  const times = list.map((d) => d.atMs).sort((a, b) => a - b);
  const before = times.filter((t) => t < windowStartMs);
  const points = [
    before.length > 0 ? before[before.length - 1] : windowStartMs,
    ...times.filter((t) => t >= windowStartMs),
    nowMs,
  ];
  let gapMs = 0;
  let gapEndMs = null;
  for (let i = 1; i < points.length; i += 1) {
    if (points[i] - points[i - 1] > gapMs) {
      gapMs = points[i] - points[i - 1];
      gapEndMs = points[i];
    }
  }
  const measured = { ...base, perDay, maxGapHours: gapMs / 3600_000, maxGapEndMs: gapEndMs };

  const verdict = stallVerdict({ deliveries: list, nowMs, stallHours, readable, minGroups });
  if (verdict.stalled) {
    return { ...measured, reason: 'stalled', detail: `verdetto di stallo attivo (${verdict.reason})` };
  }
  const low = perDay.find(({ groups }) => groups < minGroups);
  if (low) {
    return {
      ...measured,
      reason: 'day-below-threshold',
      detail: `${low.day}: ${low.groups} gruppi distinti, soglia ${minGroups}`,
    };
  }
  if (measured.maxGapHours > maxGapHours) {
    return {
      ...measured,
      reason: 'gap-too-long',
      detail: `intervallo di ${measured.maxGapHours.toFixed(1)}h senza consegne terminato il `
        + `${new Date(gapEndMs).toISOString()}${gapEndMs === nowMs ? ' (ancora in corso)' : ''}, `
        + `soglia ${maxGapHours}h`,
    };
  }
  return {
    ...measured,
    sustained: true,
    reason: 'sustained',
    detail: `${days} giorni completi sopra soglia, intervallo massimo ${measured.maxGapHours.toFixed(1)}h`,
  };
}

/**
 * Label che sottraggono una issue a ogni chiusura automatica (confronto senza
 * maiuscole). Non riusa `isFixerExempt` di `scripts/lib/classify-issue.mjs`:
 * quello include anche backlog/needs-human, che non devono impedire la
 * chiusura di un allarme guarito.
 */
export const KEEP_OPEN_LABELS = new Set(['keep-open', 'agent:no-age-out']);

/** Il commento con la misura che accompagna la chiusura. */
export function sustainedCloseNote({ sustained, minGroups = MIN_GROUPS_PER_DAY, expectedGroups = EXPECTED_GROUPS, runUrl }) {
  return [
    '✅ **Consegna sostenuta**: la flotta crawler consegna di nuovo, con margine e senza ondate perse.',
    '',
    `Criterio di chiusura (\`sustainedDelivery\` in \`scripts/ci/scan-crawler-fleet-stall.mjs\`): `
      + `${sustained.perDay.length} giorni UTC completi con almeno ${minGroups} gruppi distinti E nessun `
      + `intervallo fra consegne oltre ${sustained.gapLimitHours}h nelle ultime ${sustained.windowHours}h. `
      + 'Il solo verdetto di copertura 24h non basta: lascia passare un\'ondata persa.',
    '',
    '| giorno | gruppi |',
    '| --- | --- |',
    ...sustained.perDay.map(({ day, groups }) => `| ${day} | ${groups}/${expectedGroups} |`),
    '',
    `Intervallo massimo senza consegne nelle ultime ${sustained.windowHours}h: `
      + `**${sustained.maxGapHours.toFixed(1)}h** (soglia ${sustained.gapLimitHours}h).`,
    runUrl ? `\nRun del watchdog: ${runUrl}` : '',
    '\nSe lo stallo si ripresenta, lo stesso titolo riapre questa issue.',
  ].join('\n');
}

/**
 * Lookup della issue aperta col titolo canonico ESATTO, con le label: servono
 * per rispettare `keep-open` / `agent:no-age-out`, che `resolveGithubIssue` non
 * guarda. `undefined` = lettura fallita (nessuna azione), `null` = nessuna.
 */
function findOpenStallIssue(title) {
  const repo = process.env.GH_REPO ? ['--repo', process.env.GH_REPO] : [];
  const out = gh([
    'issue', 'list', '--state', 'open',
    '--search', `in:title "${title.replace(/"/g, '\\"')}"`,
    '--limit', '20', '--json', 'number,title,url,labels', ...repo,
  ]);
  if (typeof out !== 'string') return undefined;
  if (!out) return null;
  try {
    const list = JSON.parse(out);
    if (!Array.isArray(list)) return undefined;
    const exact = list.filter((i) => i?.title === title).sort((a, b) => Number(b.number) - Number(a.number));
    return exact[0] || null;
  } catch {
    return undefined;
  }
}

/**
 * Chiude l'allarme quando la consegna e' SOSTENUTA, e solo allora.
 *
 * Le dipendenze di rete sono iniettabili: il test esercita ogni ramo senza gh.
 * Esiti: `not-sustained` (nessuna scrittura, una riga di log col motivo se la
 * issue e' aperta), `no-open-issue`, `lookup-failed`, `kept-open` (label di
 * pin), `dry-run`, `comment-failed` (la misura non e' atterrata: niente
 * chiusura muta), `closed`, `close-failed`.
 *
 * Costo accettato: se il commento atterra ma la chiusura fallisce, la run
 * successiva (ogni 2h) ripubblica la misura finche' la chiusura riesce. E' il
 * lato sicuro (l'allarme resta aperto) e ogni commento porta la misura del
 * momento.
 *
 * @returns {Promise<{action: string, number?: number, exitCode: number}>}
 */
export async function closeRecoveredStallIssue({
  sustained,
  title = STALL_ISSUE_TITLE,
  runUrl,
  dryRun = false,
  deps = {},
  log = console.log,
  warn = console.warn,
}) {
  const findOpen = deps.findOpen || findOpenStallIssue;
  const comment = deps.comment || commentOnGithubIssue;
  const resolve = deps.resolve || resolveGithubIssue;

  // Un verdetto `unreadable` non arriva mai qui come `sustained`, ma la
  // condizione resta esplicita: una lettura cieca non chiude niente.
  if (!sustained || sustained.reason === 'unreadable') {
    return { action: 'not-sustained', exitCode: 0 };
  }
  const issue = await findOpen(title);
  if (issue === undefined) {
    warn('[fleet-stall] lookup della issue di stallo fallito → nessuna chiusura (fail-open).');
    return { action: 'lookup-failed', exitCode: 0 };
  }
  if (!issue) {
    log('[fleet-stall] nessuna issue di stallo aperta: niente da chiudere.');
    return { action: 'no-open-issue', exitCode: 0 };
  }

  if (!sustained.sustained) {
    log(`[fleet-stall] #${issue.number} resta aperta: consegna non ancora sostenuta (${sustained.reason}: ${sustained.detail}).`);
    return { action: 'not-sustained', number: issue.number, exitCode: 0 };
  }
  const pin = (issue.labels || [])
    .map((l) => (typeof l === 'string' ? l : l?.name))
    .find((n) => KEEP_OPEN_LABELS.has(String(n || '').toLowerCase()));
  if (pin) {
    log(`[fleet-stall] #${issue.number} ha la label \`${pin}\`: consegna sostenuta ma nessuna chiusura automatica.`);
    return { action: 'kept-open', number: issue.number, exitCode: 0 };
  }
  const note = sustainedCloseNote({ sustained, runUrl });
  if (dryRun) {
    log(`[fleet-stall] (dry-run) chiuderei #${issue.number} con il commento:\n${note}`);
    return { action: 'dry-run', number: issue.number, exitCode: 0 };
  }
  // Prima la misura, poi la chiusura: una issue chiusa senza la prova del
  // perche' e' indistinguibile da una chiusa a mano su un verdetto debole.
  if (!(await comment(issue.number, note))) {
    warn(`::warning::[fleet-stall] commento con la misura non persistito su #${issue.number} → nessuna chiusura, si ritenta alla prossima run.`);
    return { action: 'comment-failed', number: issue.number, exitCode: 0 };
  }
  try {
    const res = await resolve(title, { workflow: 'Crawler fleet stall watchdog', runUrl, exactTitle: true });
    if (res?.persisted === true) {
      if (Number(res.number) !== Number(issue.number)) {
        // Il lookup di `resolveGithubIssue` e' diverso dal nostro (gemelle con
        // lo stesso titolo, indice di ricerca in ritardo): la misura e il
        // controllo delle label stanno su un'altra issue. Lo si rende visibile.
        warn(`::warning::[fleet-stall] misura commentata su #${issue.number} ma chiusa #${res.number}: verificare a mano le due issue.`);
      }
      log(`[fleet-stall] #${res.number} chiusa: consegna sostenuta.`);
      return { action: 'closed', number: res.number, exitCode: 0 };
    }
    warn(`::warning::[fleet-stall] chiusura di #${issue.number} non confermata (resolve: ${res === null ? 'null' : 'senza persisted'}).`);
    return { action: 'close-failed', number: issue.number, exitCode: 0 };
  } catch (e) {
    // `resolveGithubIssue` lancia quando la chiusura e' rifiutata o non
    // verificata: dichiararla fatta sarebbe falso, quindi la run lo mostra.
    console.error(`::error::[fleet-stall] chiusura di #${issue.number} fallita: ${String(e?.message || e).slice(0, 200)}`);
    return { action: 'close-failed', number: issue.number, exitCode: 1 };
  }
}

async function main() {
  const nowMs = Date.now();
  const sinceIso = new Date(nowMs - WINDOW_HOURS * 3600_000).toISOString();
  const raw = gh(
    ['api', '-H', 'Accept: application/vnd.github+json',
      `repos/${SITE_REPO}/commits?sha=main&since=${sinceIso}&per_page=100`,
      // TSV di DUE campi, non JSON: `gh api --jq` stampa gli oggetti
      // pretty-printed su piu' righe, quindi "una riga = un oggetto" non regge
      // (misurato: 139'095 righe, nessuna parsabile singolarmente). Servono solo
      // la data e la prima riga del messaggio, quindi li si estrae in jq e non
      // resta nessun JSON da ricucire — ne' la regex fragile di prima, ne' il
      // parsing per riga.
      '--paginate', '--jq',
      '.[] | [(.commit.committer.date // ""), ((.commit.message // "") | split("\n")[0])] | @tsv'],
    // `null`, NON `''`: zero consegne e' il guasto che questo script esiste per
    // vedere, e con `''` come fallback era indistinguibile da un `gh` fallito.
    null,
  );
  const { rows, readable, bad } = parseDeliveryRows(raw);
  if (bad > 0) {
    console.warn(`[fleet-stall] ${bad} righe malformate scartate su ${rows.length + bad}.`);
  }
  if (!readable) {
    console.warn('[fleet-stall] storia dei commit del sito illeggibile → nessun verdetto (fail-open).');
    return 0;
  }

  const deliveries = groupDeliveries(rows, nowMs);
  const verdict = stallVerdict({ deliveries, nowMs, stallHours: STALL_HOURS, readable });
  const perDay = deliveriesByDay(deliveries);

  console.log(`[fleet-stall] finestra ${WINDOW_HOURS}h: ${rows.length} commit letti, ${deliveries.length} consegne di gruppo.`);
  for (const { day, groups } of perDay) {
    console.log(`[fleet-stall]   ${day}: ${groups}/${EXPECTED_GROUPS} gruppi distinti`);
  }

  if (!verdict.stalled) {
    console.log(`[fleet-stall] OK — copertura ${verdict.coverage}/${EXPECTED_GROUPS} gruppi distinti in ${COVERAGE_WINDOW_HOURS}h (soglia ${MIN_GROUPS_PER_DAY}).`);
    // Il verdetto OK NON chiude l'allarme: e' troppo largo (vedi
    // `sustainedDelivery`). La chiusura vuole consegna sostenuta.
    const sustained = sustainedDelivery({ deliveries, nowMs, readable, stallHours: STALL_HOURS });
    console.log(
      `[fleet-stall] consegna sostenuta: ${sustained.sustained} (${sustained.reason}: ${sustained.detail}); `
        + `gap massimo ${sustained.maxGapHours === null ? 'n/d' : `${sustained.maxGapHours.toFixed(2)}h`} `
        + `nelle ultime ${sustained.windowHours}h (soglia ${sustained.gapLimitHours}h); `
        + `giorni completi: ${sustained.perDay.map(({ day, groups }) => `${day}=${groups}`).join(', ')}.`,
    );
    const runUrl = process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
      ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : undefined;
    const closing = await closeRecoveredStallIssue({ sustained, runUrl, dryRun: DRY_RUN });
    return closing.exitCode;
  }

  const idle = verdict.idleHours === null
    ? `piu' di ${WINDOW_HOURS}h (nessuna consegna nella finestra letta)`
    : `${verdict.idleHours.toFixed(1)}h`;
  const headline = verdict.reason === 'under-coverage'
    ? `Solo **${verdict.coverage} gruppi su ${EXPECTED_GROUPS}** hanno consegnato dati nelle ultime ${COVERAGE_WINDOW_HOURS}h (soglia ${MIN_GROUPS_PER_DAY}). L'ultima consegna risale a ${idle}, quindi il fleet NON e' silenzioso: sta girando e consegnando una frazione.`
    : `Nessuno dei ${EXPECTED_GROUPS} crawler-group ha committato dati nel repo sito da **${idle}**, contro una soglia di ${STALL_HOURS}h.`;
  // UN SOLO titolo canonico per entrambi i verdetti, e la ragione nel body.
  // Lo stesso letterale (`STALL_ISSUE_TITLE`) e' la chiave con cui il ramo OK
  // richiude l'allarme, ma solo su consegna SOSTENUTA (`sustainedDelivery`:
  // tre giorni completi sopra soglia e nessuna ondata persa), non al primo
  // verdetto OK.
  const title = STALL_ISSUE_TITLE;
  const lines = [
    headline,
    '',
    'Le run possono essere VERDI: il percorso di commit classifica la contesa sul ref e il',
    'lease globale occupato come "systemic class", esce 0 con un `::warning::` e non stage',
    'niente. Per questo `workflow-failure-issues.yml` non lo vede — filtra su',
    '`conclusion == failure` — ed e\' la stessa forma di guasto che',
    '`generation-health-watchdog.yml` intercetta per la generazione articoli.',
    '',
    '**Gruppi distinti che hanno consegnato, per giorno UTC:**',
    '',
    '| giorno | gruppi |',
    '| --- | --- |',
    ...perDay.map(({ day, groups }) => `| ${day} | ${groups}/${EXPECTED_GROUPS} |`),
    '',
    'Cosa guardare, in ordine:',
    '',
    '1. Il log del commit di gruppo di una run recente, cercando `exit 44`,',
    '   `global data-pipeline lease is busy`, `no group data was staged` o',
    '   `lost the ref race`. Sono i marker della perdita silenziosa.',
    '2. Il documento di lease `ci_leases/jobs-data-pipeline`: un holder morto blocca',
    '   fino alla scadenza del TTL.',
    '3. Se le run sono verdi e i membri riusciti, il guasto NON e\' nei parser:',
    '   e\' nella consegna. Non ritirare crawler su verdetti di staleness raccolti',
    '   in questa finestra — misurano la consegna, non la sorgente.',
    '',
    `Contesto e misura della causa nota: issue #1573.`,
  ];
  const description = lines.join('\n');

  if (DRY_RUN) {
    console.log(`[fleet-stall] (dry-run) aprirei: "${title}"`);
    console.log('--- corpo ---');
    console.log(description);
    return 0;
  }

  const res = await createGithubIssue({
    title,
    description,
    priority: 1,
    labels: ['bug', 'crawler-fleet'],
    workflow: 'Crawler fleet stall watchdog',
  });

  // Il risultato NON si puo' ignorare, ed e' il difetto che la review ha
  // trovato su questa PR: `createGithubIssue` rende `null` quando la scrittura
  // fallisce e `{persisted: false}` quando fallisce un commento su una issue
  // esistente o riaperta. Stampare «issue aperta/aggiornata» e uscire 0 in quei
  // casi e' la stessa classe di difetto che questo allarme esiste per
  // intercettare: dichiarare fatto qualcosa che non e' stato fatto. Qui costa
  // di piu' che altrove, perche' questa e' l'UNICA segnalazione di una consegna
  // ferma: se sparisce, si torna alle 124 ore di silenzio.
  //
  // `ledger: true` e `staleBuild: true` sono percorsi RIUSCITI che non portano
  // `persisted`, quindi si testano esattamente i due casi di fallimento e non
  // la verita' di `persisted`.
  if (res === null || res?.persisted === false) {
    console.error(
      '::error::[fleet-stall] verdetto di stallo NON consegnato: '
        + `${res === null ? 'createGithubIssue ha restituito null' : 'commento non persistito (persisted: false)'}. `
        + 'La run esce non-zero: il fallimento dell\'allarme deve essere visibile, '
        + 'altrimenti una consegna ferma resta senza nessuna traccia.',
    );
    return 1;
  }
  console.log(`[fleet-stall] verdetto consegnato${res?.number ? ` su #${res.number}` : ''}.`);
  return 0;
}

if (process.argv[1] && process.argv[1].endsWith('scan-crawler-fleet-stall.mjs')) {
  main().then(
    (c) => process.exit(c),
    (e) => {
      // NON fail-open. Il primo tentativo usciva 0 qui, con il ragionamento
      // «questo script non ha watermark da far avanzare, quindi un'uscita
      // morbida non nasconde nulla». Sbagliato: lo stato che si perde non e' un
      // watermark, e' l'ALLARME. Questo e' l'unico rilevatore di una consegna
      // ferma, quindi un crash silenzioso riproduce esattamente la condizione
      // che deve segnalare — 124 ore di guasto senza nessuna traccia — e la
      // rende indistinguibile da un fleet sano.
      //
      // Distinzione che conta e che resta: non leggere la storia dei commit e'
      // fail-open DELIBERATO (verdetto assente, exit 0, detto nel log), perche'
      // un allarme che suona quando e' cieco viene silenziato. Ma un'eccezione
      // non prevista non e' cecita' dichiarata: e' un guasto dell'allarme, e va
      // visto.
      console.error(`::error::[fleet-stall] errore non gestito: ${e && e.stack ? e.stack : e}`);
      process.exit(1);
    },
  );
}
