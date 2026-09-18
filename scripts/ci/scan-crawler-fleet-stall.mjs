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
 * lo zero assoluto, che prende il caso pulito prima.
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
 * Uso:
 *   node scripts/ci/scan-crawler-fleet-stall.mjs [--dry-run] [--stall-hours N]
 *                                                [--window-hours N]
 * Env:
 *   GH_TOKEN            necessario per gh.
 *   GITHUB_REPOSITORY   owner/repo di QUESTO repo (auto in Actions).
 *   SITE_REPO           default `valerielinc-ops/frontaliere-si-o-no`.
 */

import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { createGithubIssue } from '../lib/github-issue-creator.mjs';
import { parsePositiveNum } from '../lib/parse-positive-num.mjs';

const ARGV = process.argv.slice(2);
const flag = (n) => ARGV.includes(n);
const val = (n, d) => {
  const i = ARGV.indexOf(n);
  return i !== -1 && ARGV[i + 1] ? ARGV[i + 1] : d;
};

const DRY_RUN = flag('--dry-run');
const STALL_HOURS = parsePositiveNum(val('--stall-hours', undefined), 6, { label: '--stall-hours' });
// Finestra letta dall'API: deve essere abbastanza larga da distinguere "fermo
// da 7 ore" da "fermo da 124", perche' quel numero e' la prima cosa che serve
// a chi apre la issue. Non e' la soglia.
const WINDOW_HOURS = parsePositiveNum(val('--window-hours', undefined), 168, { label: '--window-hours' });
const SITE_REPO = process.env.SITE_REPO || 'valerielinc-ops/frontaliere-si-o-no';

/** Il messaggio che i workflow generati usano per la consegna. Unica sorgente. */
export const GROUP_COMMIT_RE = /^Auto-update crawler group (\d{2}) jobs/;

/**
 * Quanti crawler-group esistono, CONTATI dai workflow invece di dichiarati.
 *
 * Era una costante 23, e la review ha ragione: regex, denominatore e soglia
 * tarati su una cardinalita' fissa smettono di rappresentare "meta' della
 * flotta" appena la flotta cresce. Un gruppo 24 aggiunto avrebbe lasciato la
 * soglia a 12 su 24 — cioe' avrebbe richiesto che METÀ ESATTA fallisse prima
 * di suonare, silenziosamente piu' permissiva ogni volta che il fleet cresce.
 *
 * Il conteggio e' locale e offline: i workflow generati stanno in questo
 * checkout. Fallback a 23 se la directory non e' leggibile, che e' il valore
 * misurato il 2026-09-18 e degrada al comportamento noto invece che a zero.
 */
export function countCrawlerGroups(dir = '.github/workflows') {
  try {
    const n = readdirSync(dir).filter((f) => /^crawler-group-\d+\.yml$/.test(f)).length;
    return n > 0 ? n : 23;
  } catch {
    return 23;
  }
}

export const EXPECTED_GROUPS = countCrawlerGroups();

/** La soglia e' una FRAZIONE della flotta, non un assoluto. Vedi MIN_GROUPS_PER_DAY. */
export const MIN_COVERAGE_FRACTION = 0.5;

function gh(args, fallback = '') {
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
 * Verdetto sullo stallo, su DUE condizioni indipendenti.
 *
 * - `hard-stop`: nessuna consegna da `stallHours`. Prende il caso pulito (il
 *   2026-09-15 fu zero assoluto) e suona presto.
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

  if (recentGroups.length === 0) {
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
    '',
  );
  let rows = [];
  let readable = false;
  if (raw) {
    // Una riga = un oggetto JSON, prodotta da `--jq '.[]'`. La versione
    // precedente incollava gli array di `--paginate` con una regex
    // (`/\]\s*\[/`) e poi li riparsava: fragile per costruzione — una pagina
    // finale vuota, uno spazio diverso o un `][` dentro una stringa del
    // messaggio di commit rendevano il JSON non parsabile, e il fail-open
    // trasformava l'errore in SILENZIO invece che in un allarme. Con una riga
    // per oggetto non c'e' niente da ricucire.
    // Ogni riga e' `<iso-date>\t<prima riga del messaggio>`. Si ricostruisce la
    // forma dell'API perche' `groupDeliveries` resta puro su quella forma ed e'
    // la funzione che i test esercitano senza rete.
    const parsed = [];
    let bad = 0;
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      const tab = line.indexOf('\t');
      if (tab === -1) { bad += 1; continue; }
      const date = line.slice(0, tab);
      const message = line.slice(tab + 1);
      if (!date) { bad += 1; continue; }
      parsed.push({ commit: { message, committer: { date } } });
    }
    if (bad > 0) {
      console.warn(`[fleet-stall] ${bad} righe malformate scartate su ${parsed.length + bad}.`);
    }
    // Una riga rotta NON invalida la lettura: il conteggio scende e al massimo
    // l'allarme suona in anticipo, che e' il verso giusto in cui sbagliare.
    rows = parsed;
    readable = parsed.length > 0 || raw.trim() === '';
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
    return 0;
  }

  const idle = verdict.idleHours === null
    ? `piu' di ${WINDOW_HOURS}h (nessuna consegna nella finestra letta)`
    : `${verdict.idleHours.toFixed(1)}h`;
  const headline = verdict.reason === 'under-coverage'
    ? `Solo **${verdict.coverage} gruppi su ${EXPECTED_GROUPS}** hanno consegnato dati nelle ultime ${COVERAGE_WINDOW_HOURS}h (soglia ${MIN_GROUPS_PER_DAY}). L'ultima consegna risale a ${idle}, quindi il fleet NON e' silenzioso: sta girando e consegnando una frazione.`
    : `Nessuno dei ${EXPECTED_GROUPS} crawler-group ha committato dati nel repo sito da **${idle}**, contro una soglia di ${STALL_HOURS}h.`;
  // UN SOLO titolo canonico per entrambi i verdetti, e la ragione nel body.
  // Con due titoli, un incidente che passa da `under-coverage` a `hard-stop`
  // (che e' il PEGGIORAMENTO dello stesso guasto, non un guasto nuovo) sfuggiva
  // alla dedup e apriva una seconda issue — e dato che la chiusura automatica e'
  // dichiarata non implementata, restavano aperte entrambe. Il titolo e' la
  // chiave di dedup, quindi deve identificare la CONDIZIONE, non la sua severita'.
  const title = 'Crawler fleet: i gruppi non consegnano dati';
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

