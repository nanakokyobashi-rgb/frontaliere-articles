/**
 * crawler-fleet-stall.test.mjs — l'allarme per la flotta crawler che gira VERDE
 * e non consegna.
 *
 * Il test che conta e' il terzo: pinna la MISURA che ha scelto la soglia, e il
 * fatto che la soglia ovvia («zero consegne in 6 ore») NON rileva lo stallo
 * reale. Misurato il 2026-09-18 su 168 ore di storia del repo sito:
 *
 *   sano   09-11: 22/23   09-12: 21/23   09-13: 23/23
 *   rotto  09-14:  2/23   09-15:  0/23   09-16:  4/23   09-17: 6/23   09-18: 2/23
 *
 * I vincitori del convoglio ruotano, quindi 1-2 gruppi filtrano SEMPRE: la
 * condizione "zero" era falsa mentre il 91% della flotta non consegnava.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  GROUP_COMMIT_RE,
  EXPECTED_GROUPS,
  FALLBACK_GROUP_COUNT,
  MIN_COVERAGE_FRACTION,
  countCrawlerGroups,
  MIN_GROUPS_PER_DAY,
  COVERAGE_WINDOW_HOURS,
  groupDeliveries,
  parseDeliveryRows,
  stallVerdict,
  deliveriesByDay,
  STALL_ISSUE_TITLE,
  CLOSE_SUSTAINED_DAYS,
  CLOSE_MAX_GAP_HOURS,
  sustainedDelivery,
  closeRecoveredStallIssue,
} from '../../scripts/ci/scan-crawler-fleet-stall.mjs';

const H = 3600_000;
const NOW = Date.parse('2026-09-18T18:00:00Z');

const commit = (msg, iso) => ({ commit: { message: msg, committer: { date: iso } } });

/** n gruppi distinti consegnati `hoursAgo` ore fa. */
function wave(n, hoursAgo, offset = 0) {
  return Array.from({ length: n }, (_, i) => ({
    group: String(offset + i + 1).padStart(2, '0'),
    atMs: NOW - hoursAgo * H,
  }));
}

test('riconosce solo i commit di consegna dei gruppi', () => {
  const rows = [
    commit('Auto-update crawler group 04 jobs', '2026-09-18T13:00:00Z'),
    commit('Auto-update crawler group 19 jobs\n\nbody', '2026-09-18T15:00:00Z'),
    commit('Record crawler generation ledger', '2026-09-18T13:01:00Z'),
    commit('🌐 Auto-translate jobs', '2026-09-18T14:00:00Z'),
    commit('fix(ci): something', '2026-09-18T12:00:00Z'),
  ];
  const d = groupDeliveries(rows);
  assert.deepEqual(d.map((x) => x.group), ['19', '04'], 'ordinati dal piu recente');
  // Il ledger NON è una consegna: viene committato anche quando i dati non
  // atterrano, quindi contarlo maschererebbe esattamente il guasto cercato.
  assert.ok(!d.some((x) => x.group === undefined));
  assert.match('Auto-update crawler group 07 jobs', GROUP_COMMIT_RE);
  assert.doesNotMatch('Record crawler generation ledger', GROUP_COMMIT_RE);
});

test('una risposta API vuota e leggibile attiva il caso zero-consegne', () => {
  // Il caso PEGGIORE — nessun gruppo consegna — arrivava come `''`, che con il
  // vecchio fallback `''` di `gh()` era identico a un errore di lettura: il
  // fail-open lo faceva uscire zitto. `''` deve essere leggibile, `null` no.
  const empty = parseDeliveryRows('');
  assert.deepEqual(empty.rows, []);
  assert.equal(empty.readable, true, 'nessuna riga e una risposta valida senza consegne');
  assert.equal(empty.bad, 0);

  const failed = parseDeliveryRows(null);
  assert.equal(failed.readable, false, 'null rappresenta un errore del wrapper gh');

  // Le righe malformate si contano senza invalidare la lettura: una riga senza
  // tab e una con la data vuota. Una riga di soli spazi NON e' malformata, e'
  // salto di riga: viene scartata prima del controllo sul tab.
  const partial = parseDeliveryRows(
    '2026-09-18T10:00:00Z\tAuto-update crawler group 07 jobs\nsenza-tab\n\tmessaggio-senza-data\n \n',
  );
  assert.equal(partial.rows.length, 1);
  assert.equal(partial.bad, 2);
  assert.equal(partial.readable, true);
});

test('zero consegne leggibili suonano invece di uscire fail-open', () => {
  // La catena completa: risposta vuota -> readable -> verdetto stalled.
  const { rows, readable } = parseDeliveryRows('');
  const v = stallVerdict({
    deliveries: groupDeliveries(rows, NOW),
    nowMs: NOW,
    stallHours: 6,
    readable,
  });
  assert.equal(v.stalled, true, 'lo stallo totale deve suonare, non tacere');
});

test('un fleet sano non suona', () => {
  // 09-13: un'ondata completa in un'unica ondata.
  const v = stallVerdict({
    deliveries: wave(EXPECTED_GROUPS, 2), nowMs: NOW, stallHours: 6, readable: true,
  });
  assert.equal(v.stalled, false);
  assert.equal(v.reason, 'delivering');
  assert.equal(v.coverage, EXPECTED_GROUPS);
});

test('una pausa tra ondate sane non supera la prova della copertura 24h', () => {
  // #1579: il 2026-10-01 il monitor ha segnalato 8.7h senza commit pur
  // registrando tutti i 24 gruppi nella giornata. Il silenzio di 6h non deve
  // prevalere su una finestra di copertura che dimostra una wave completa.
  const v = stallVerdict({
    deliveries: wave(EXPECTED_GROUPS, 8.7), nowMs: NOW, stallHours: 6, readable: true,
  });
  assert.equal(v.recentGroups.length, 0, 'nessuna consegna nella soglia breve');
  assert.equal(v.coverage, EXPECTED_GROUPS, 'la finestra completa contiene tutti i gruppi');
  assert.equal(v.stalled, false);
  assert.equal(v.reason, 'delivering');
});

test('LA MISURA: la soglia separa i giorni sani da quelli rotti senza sovrapposizione', () => {
  // Minimo osservato sano = 21; massimo osservato rotto = 6.
  const healthy = [21, 22, EXPECTED_GROUPS];
  const broken = [0, 2, 2, 4, 6];
  for (const n of healthy) {
    assert.ok(n >= MIN_GROUPS_PER_DAY, `giorno sano ${n}/${EXPECTED_GROUPS} non deve suonare`);
    const v = stallVerdict({ deliveries: wave(n, 2), nowMs: NOW, stallHours: 6, readable: true });
    assert.equal(v.stalled, false, `${n}/${EXPECTED_GROUPS} è sano`);
  }
  for (const n of broken) {
    assert.ok(n < MIN_GROUPS_PER_DAY, `giorno rotto ${n}/${EXPECTED_GROUPS} deve suonare`);
  }
  assert.ok(Math.max(...broken) < MIN_GROUPS_PER_DAY && MIN_GROUPS_PER_DAY <= Math.min(...healthy),
    'la soglia deve stare nell intervallo vuoto fra le due popolazioni');
});

test('LA REGRESSIONE: «zero consegne in 6h» non rileva lo stallo reale', () => {
  // Lo stato del 2026-09-18: 2-3 gruppi consegnano, gli altri 20 no. La prima
  // versione di questo allarme (solo `hard-stop`) restava MUTA qui — ed è il
  // motivo per cui la soglia è la copertura e non il silenzio.
  const deliveries = [...wave(2, 3), ...wave(1, 20, 50)];
  const v = stallVerdict({ deliveries, nowMs: NOW, stallHours: 6, readable: true });
  assert.equal(v.recentGroups.length, 2, 'ci SONO consegne recenti: «zero in 6h» è falso');
  assert.equal(v.stalled, true, 'e nonostante questo il fleet è rotto');
  assert.equal(v.reason, 'under-coverage');
  assert.ok(v.coverage < MIN_GROUPS_PER_DAY);
});

test('uno stop totale suona come hard-stop, non come sotto-copertura', () => {
  const v = stallVerdict({
    deliveries: wave(EXPECTED_GROUPS, 40), nowMs: NOW, stallHours: 6, readable: true,
  });
  assert.equal(v.stalled, true);
  assert.equal(v.reason, 'hard-stop');
  assert.ok(v.idleHours > 6);
});

test('nessuna consegna nella finestra letta non viene arrotondata a un numero', () => {
  const v = stallVerdict({ deliveries: [], nowMs: NOW, stallHours: 6, readable: true });
  assert.equal(v.stalled, true);
  assert.equal(v.reason, 'no-delivery-in-window');
  assert.equal(v.idleHours, null, "non si sa da quanto: non si inventa un'ora");
});

test('cieco non vuol dire rotto: fail-open se la storia e illeggibile', () => {
  // Un allarme che suona quando non riesce a leggere viene silenziato in una
  // settimana, e allora non suona piu' nemmeno quando serve.
  const v = stallVerdict({ deliveries: [], nowMs: NOW, stallHours: 6, readable: false });
  assert.equal(v.stalled, false);
  assert.equal(v.reason, 'unreadable');
});

test('la finestra di copertura contiene almeno un ondata intera', () => {
  // Con 6 ore, un'ondata sana caduta appena fuori finestra darebbe un falso
  // positivo. Le ondate osservate sono 1-2 al giorno, quindi 24h ne contiene
  // sempre una.
  assert.equal(COVERAGE_WINDOW_HOURS, 24);
  assert.ok(EXPECTED_GROUPS > 0);
});

test('il riepilogo per giorno conta gruppi DISTINTI, non commit', () => {
  // Un gruppo che committa due volte in un giorno non deve gonfiare la
  // copertura: la domanda è quanti gruppi hanno consegnato, non quanti push.
  const deliveries = [
    { group: '04', atMs: Date.parse('2026-09-18T10:00:00Z') },
    { group: '04', atMs: Date.parse('2026-09-18T14:00:00Z') },
    { group: '19', atMs: Date.parse('2026-09-18T15:00:00Z') },
    { group: '03', atMs: Date.parse('2026-09-17T15:00:00Z') },
  ];
  assert.deepEqual(deliveriesByDay(deliveries), [
    { day: '2026-09-17', groups: 1 },
    { day: '2026-09-18', groups: 2 },
  ]);
});

test('la flotta si CONTA, non si dichiara: la soglia resta meta anche se cresce', () => {
  // La review: regex, denominatore e soglia tarati su cardinalità fissa smettono
  // di rappresentare «metà della flotta» appena la flotta cresce. Con 24 gruppi
  // e soglia fissa 12 servirebbe che metà esatta fallisse prima di suonare.
  const contractGroups = JSON.parse(readFileSync('generator/data/crawler-cross-repo-contract.json', 'utf8')).groupCount;
  assert.equal(countCrawlerGroups('/nonexistent-dir'), contractGroups, 'il contratto resta autorevole anche senza workflow locali');
  assert.equal(countCrawlerGroups('/nonexistent-dir', '/nonexistent-contract.json'), FALLBACK_GROUP_COUNT, 'fallback alla cardinalita corrente, non a zero');
  assert.equal(MIN_COVERAGE_FRACTION, 0.5);
  assert.equal(MIN_GROUPS_PER_DAY, Math.max(2, Math.round(EXPECTED_GROUPS * MIN_COVERAGE_FRACTION)));
  assert.equal(FALLBACK_GROUP_COUNT, 24);
  assert.equal(MIN_GROUPS_PER_DAY, Math.max(2, Math.round(EXPECTED_GROUPS * MIN_COVERAGE_FRACTION)));
});

test('un timestamp nel futuro non vale come consegna recente', () => {
  // `committer.date` viene dal client che ha pushato: un clock skew su un runner
  // può datare un commit avanti, e contarlo sopprimerebbe l'allarme nel verso
  // sbagliato — «recente» una consegna che non è avvenuta.
  const rows = [
    { commit: { message: 'Auto-update crawler group 04 jobs', committer: { date: '2026-09-19T18:00:00Z' } } },
    { commit: { message: 'Auto-update crawler group 05 jobs', committer: { date: '2026-09-18T17:00:00Z' } } },
  ];
  const d = groupDeliveries(rows, NOW);
  assert.deepEqual(d.map((x) => x.group), ['05'], 'la consegna datata domani è scartata');
  // Tolleranza: 5 minuti di skew restano ammessi.
  const skewed = [{ commit: { message: 'Auto-update crawler group 06 jobs', committer: { date: '2026-09-18T18:03:00Z' } } }];
  assert.equal(groupDeliveries(skewed, NOW).length, 1);
});

test('il titolo e UNICO per entrambi i verdetti e fra apertura e chiusura', () => {
  // Un incidente che passa da under-coverage a hard-stop è il PEGGIORAMENTO
  // dello stesso guasto: con due titoli la dedup non lo riconosce. E il titolo
  // è anche la chiave della chiusura: se apertura e chiusura usassero due
  // letterali, la chiusura cercherebbe una issue che nessuno apre.
  const src = readFileSync(new URL('../../scripts/ci/scan-crawler-fleet-stall.mjs', import.meta.url), 'utf8');
  // L'invariante vero: il letterale esiste UNA volta (la costante). Che la
  // chiusura cerchi proprio quella costante lo verifica il test comportamentale
  // della chiusura (`calls.resolve[0].title`).
  assert.equal(STALL_ISSUE_TITLE, 'Crawler fleet: i gruppi non consegnano dati');
  assert.equal(src.split(`'${STALL_ISSUE_TITLE}'`).length - 1, 1, 'il letterale compare una volta sola');
  assert.doesNotMatch(src, /const title = verdict\.reason === 'under-coverage'/);
});

test('un verdetto non consegnato esce non-zero, e un crash pure', () => {
  // È l'UNICA segnalazione di una consegna ferma: se createGithubIssue rende
  // null o `persisted: false` e il processo stampa «aperta» ed esce 0, si torna
  // alle 124 ore di silenzio. `ledger`/`staleBuild` sono successi SENZA
  // `persisted`, quindi si testano i due fallimenti, non la verità di persisted.
  const src = readFileSync(new URL('../../scripts/ci/scan-crawler-fleet-stall.mjs', import.meta.url), 'utf8');
  assert.match(src, /if \(res === null \|\| res\?\.persisted === false\)/);
  // Non basta che la stringa non ci sia: il commento sopra la CITA per spiegare
  // perché era sbagliata. Ciò che deve sparire è la STAMPA incondizionata.
  assert.doesNotMatch(src, /console\.log\('\[fleet-stall\] issue aperta\/aggiornata\.'\)/);
  assert.match(src, /console\.log\(`\[fleet-stall\] verdetto consegnato/);
  const tail = src.slice(src.indexOf('main().then('));
  assert.match(tail, /process\.exit\(1\)/, 'un errore non gestito deve risultare rotto');
  assert.doesNotMatch(tail, /process\.exit\(0\)/);
});

test('le pagine di gh api arrivano come TSV di due campi, senza JSON da ricucire', () => {
  // Due tentativi scartati, entrambi per fragilità del parsing:
  //  1. incollare gli array di --paginate con /\]\s*\[/ e riparsare — una pagina
  //     finale vuota o un `][` dentro un messaggio rompeva il JSON;
  //  2. `--jq '.[]'` una riga per oggetto — ma `gh api --jq` stampa gli oggetti
  //     pretty-printed, misurato: 139.095 righe, nessuna parsabile da sola.
  // In entrambi i casi il fail-open trasformava l'errore in SILENZIO, che su
  // questo allarme è il guasto stesso. Servono solo data e prima riga del
  // messaggio: estratti in jq, non resta niente da parsare.
  const src = readFileSync(new URL('../../scripts/ci/scan-crawler-fleet-stall.mjs', import.meta.url), 'utf8');
  assert.match(src, /@tsv/);
  assert.match(src, /\.commit\.committer\.date/);
  assert.doesNotMatch(src, /'--paginate', '--jq', '\.\[\]'\]/);
  assert.doesNotMatch(src, /replace\(\/\\\]\\s\*\\\[\/g/);
  assert.doesNotMatch(src, /JSON\.parse\(t\)/, 'nessun parsing JSON per riga');
});

// ── Chiusura dell'allarme: consegna SOSTENUTA, non il primo verdetto OK ──────
//
// Le ondate partono alle 09:00 e alle 21:00 UTC e consegnano in circa 1,5 ore.
// `fleetWave` riproduce un'ondata: `n` gruppi distinti a 4 minuti l'uno
// dall'altro. Con l'ondata serale che termina alle 22:29 e quella del mattino
// che parte alle 09:19, la pausa sana fra due ondate è di ~10,8 ore.

const pad = (i) => String(i).padStart(2, '0');

function fleetWave(startIso, n = EXPECTED_GROUPS) {
  const start = Date.parse(startIso);
  return Array.from({ length: n }, (_, i) => ({ group: pad(i + 1), atMs: start + i * 4 * 60_000 }));
}

/** Due ondate al giorno per ciascun giorno; `skip` toglie un'ondata, `groups` la riduce. */
function fleetDays(days, { skip = [], groups = {} } = {}) {
  const out = [];
  for (const day of days) {
    for (const [slot, hhmm] of [['am', '09:19'], ['pm', '20:57']]) {
      const key = `${day}-${slot}`;
      if (skip.includes(key)) continue;
      out.push(...fleetWave(`${day}T${hhmm}:00Z`, groups[key] ?? EXPECTED_GROUPS));
    }
  }
  return out.sort((a, b) => b.atMs - a.atMs);
}

/** Dipendenze di rete finte: registrano ogni scrittura. */
function fakeDeps({ issue = { number: 1579, title: STALL_ISSUE_TITLE, labels: [] }, commentOk = true, resolveImpl } = {}) {
  const calls = { findOpen: [], comment: [], resolve: [] };
  return {
    calls,
    deps: {
      findOpen: async (title) => { calls.findOpen.push(title); return issue; },
      comment: async (n, body) => { calls.comment.push({ n, body }); return commentOk; },
      resolve: async (title, ctx) => {
        calls.resolve.push({ title, ctx });
        if (resolveImpl) return resolveImpl();
        return { number: issue?.number, title, persisted: true };
      },
    },
  };
}

const quiet = { log: () => {}, warn: () => {} };

test('LA MISURA: la soglia di gap separa la pausa sana dall ondata persa', () => {
  // Misurato il 2026-10-03 sulla storia dei commit del sito: gap massimi sani
  // 10,27-10,42h (ondate puntuali dal 10-01); ondata persa o in ritardo 15,35h
  // (09-28) e 17,40h (09-30), con la ricorrenza delle 12:51Z già a 14,4h.
  const healthyMax = 10.42;
  const lostWaveMin = 14.4;
  assert.ok(healthyMax < CLOSE_MAX_GAP_HOURS && CLOSE_MAX_GAP_HOURS < lostWaveMin,
    'la soglia deve stare nell intervallo vuoto fra pausa sana e ondata persa');
  assert.equal(CLOSE_SUSTAINED_DAYS, 3);
});

test('REPLAY 30-09: copertura sopra soglia ma 14,4h senza consegne → issue aperta NON chiusa', async () => {
  // La ricorrenza vera del 30-09 alle 12:51Z: l'ondata del mattino non è
  // arrivata, l'ultima consegna è delle 22:29 del giorno prima. La copertura
  // 24h contiene ancora l'ondata serale intera, quindi `stallVerdict` dice
  // `delivering`: chiudere su quel verdetto avrebbe dato per guarita un'ondata
  // persa.
  const nowMs = Date.parse('2026-09-30T12:51:00Z');
  const deliveries = fleetDays(['2026-09-26', '2026-09-27', '2026-09-28', '2026-09-29'])
    .filter((d) => d.atMs <= nowMs);
  const v = stallVerdict({ deliveries, nowMs, stallHours: 6, readable: true });
  assert.equal(v.stalled, false, 'il verdetto indebolito non suona');
  assert.equal(v.reason, 'delivering');
  assert.ok(v.idleHours > 14.3 && v.idleHours < 14.5, `idle ${v.idleHours}`);

  const s = sustainedDelivery({ deliveries, nowMs, readable: true });
  assert.equal(s.sustained, false, 'un ondata persa non è consegna sostenuta');
  assert.equal(s.reason, 'gap-too-long');
  assert.ok(s.maxGapHours > CLOSE_MAX_GAP_HOURS);
  assert.equal(s.maxGapEndMs, nowMs, 'il buco è ancora in corso');

  const { calls, deps } = fakeDeps();
  const r = await closeRecoveredStallIssue({ sustained: s, deps, ...quiet });
  assert.equal(r.action, 'not-sustained');
  assert.equal(calls.comment.length, 0, 'nessun commento');
  assert.equal(calls.resolve.length, 0, 'nessuna chiusura');
});

test('tre giorni completi sopra soglia e nessun gap oltre il limite → una chiusura con la misura', async () => {
  const nowMs = Date.parse('2026-10-03T18:37:00Z');
  const deliveries = fleetDays(['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03'])
    .filter((d) => d.atMs <= nowMs);
  const s = sustainedDelivery({ deliveries, nowMs, readable: true });
  assert.equal(s.sustained, true, s.detail);
  assert.equal(s.reason, 'sustained');
  assert.deepEqual(s.perDay.map((d) => d.day), ['2026-09-30', '2026-10-01', '2026-10-02'], 'oggi escluso');
  assert.ok(s.perDay.every((d) => d.groups === EXPECTED_GROUPS));
  assert.ok(s.maxGapHours < CLOSE_MAX_GAP_HOURS);

  const { calls, deps } = fakeDeps();
  const runUrl = 'https://github.com/o/r/actions/runs/1';
  const r = await closeRecoveredStallIssue({ sustained: s, runUrl, deps, ...quiet });
  assert.equal(r.action, 'closed');
  assert.equal(r.exitCode, 0);
  assert.equal(calls.comment.length, 1, 'un commento con la misura');
  assert.equal(calls.resolve.length, 1, 'una chiusura');
  const body = calls.comment[0].body;
  assert.equal(calls.comment[0].n, 1579);
  for (const { day } of s.perDay) assert.ok(body.includes(`| ${day} | ${EXPECTED_GROUPS}/${EXPECTED_GROUPS} |`), day);
  assert.ok(body.includes(`**${s.maxGapHours.toFixed(1)}h**`), 'il gap massimo misurato');
  assert.ok(body.includes(`ultime ${CLOSE_SUSTAINED_DAYS * 24}h`), 'la finestra');
  assert.ok(body.includes(runUrl), 'la run del watchdog');
  assert.equal(calls.resolve[0].title, STALL_ISSUE_TITLE, 'chiude per titolo canonico');
  assert.equal(calls.resolve[0].ctx.exactTitle, true, 'titolo ESATTO, non prefisso');
});

test('due giorni sopra soglia e il terzo sotto → nessuna chiusura', async () => {
  const nowMs = Date.parse('2026-10-03T12:00:00Z');
  const deliveries = fleetDays(['2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03'], {
    groups: { '2026-10-02-am': 5, '2026-10-02-pm': 5 },
  }).filter((d) => d.atMs <= nowMs);
  // Il verdetto 24h è OK (l'ondata di stamattina è intera): è proprio il caso
  // in cui un closer sul verdetto chiuderebbe troppo presto.
  assert.equal(stallVerdict({ deliveries, nowMs, stallHours: 6, readable: true }).stalled, false);
  const s = sustainedDelivery({ deliveries, nowMs, readable: true });
  assert.equal(s.sustained, false);
  assert.equal(s.reason, 'day-below-threshold');
  assert.match(s.detail, /2026-10-02: 5 gruppi/);

  const { calls, deps } = fakeDeps();
  const r = await closeRecoveredStallIssue({ sustained: s, deps, ...quiet });
  assert.equal(r.action, 'not-sustained');
  assert.equal(calls.comment.length + calls.resolve.length, 0);
});

test('primo verdetto OK dopo uno stallo (meno di tre giorni completi) → nessuna chiusura', async () => {
  const nowMs = Date.parse('2026-10-03T12:00:00Z');
  // Fermo fino al 10-01 compreso, consegne riprese il 10-02.
  const deliveries = fleetDays(['2026-10-02', '2026-10-03']).filter((d) => d.atMs <= nowMs);
  const v = stallVerdict({ deliveries, nowMs, stallHours: 6, readable: true });
  assert.equal(v.stalled, false, 'il primo verdetto è già OK');
  const s = sustainedDelivery({ deliveries, nowMs, readable: true });
  assert.equal(s.sustained, false);
  assert.equal(s.reason, 'day-below-threshold');

  const { calls, deps } = fakeDeps();
  await closeRecoveredStallIssue({ sustained: s, deps, ...quiet });
  assert.equal(calls.comment.length + calls.resolve.length, 0);
});

test('verdetto OK sostenuto senza issue aperta → nessuna scrittura', async () => {
  const nowMs = Date.parse('2026-10-03T18:37:00Z');
  const deliveries = fleetDays(['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03'])
    .filter((d) => d.atMs <= nowMs);
  const s = sustainedDelivery({ deliveries, nowMs, readable: true });
  assert.equal(s.sustained, true);
  const { calls, deps } = fakeDeps({ issue: null });
  const r = await closeRecoveredStallIssue({ sustained: s, deps, ...quiet });
  assert.equal(r.action, 'no-open-issue');
  assert.equal(calls.comment.length + calls.resolve.length, 0);
});

test('verdetto unreadable con issue aperta → nessuna chiusura (il fail-open resta)', async () => {
  const s = sustainedDelivery({ deliveries: [], nowMs: NOW, readable: false });
  assert.equal(s.sustained, false);
  assert.equal(s.reason, 'unreadable');
  const { calls, deps } = fakeDeps();
  const r = await closeRecoveredStallIssue({ sustained: s, deps, ...quiet });
  assert.equal(r.action, 'not-sustained');
  assert.equal(calls.findOpen.length + calls.comment.length + calls.resolve.length, 0, 'cieco non tocca niente');
});

test('una issue con keep-open o agent:no-age-out non si chiude', async () => {
  const nowMs = Date.parse('2026-10-03T18:37:00Z');
  const deliveries = fleetDays(['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03'])
    .filter((d) => d.atMs <= nowMs);
  const s = sustainedDelivery({ deliveries, nowMs, readable: true });
  for (const name of ['keep-open', 'agent:no-age-out', 'Keep-Open']) {
    const { calls, deps } = fakeDeps({ issue: { number: 1579, title: STALL_ISSUE_TITLE, labels: [{ name }] } });
    const r = await closeRecoveredStallIssue({ sustained: s, deps, ...quiet });
    assert.equal(r.action, 'kept-open', name);
    assert.equal(calls.comment.length + calls.resolve.length, 0, name);
  }
});

test('senza la misura persistita non si chiude, e una chiusura rifiutata esce non-zero', async () => {
  const nowMs = Date.parse('2026-10-03T18:37:00Z');
  const deliveries = fleetDays(['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03'])
    .filter((d) => d.atMs <= nowMs);
  const s = sustainedDelivery({ deliveries, nowMs, readable: true });

  const noComment = fakeDeps({ commentOk: false });
  const r1 = await closeRecoveredStallIssue({ sustained: s, deps: noComment.deps, ...quiet });
  assert.equal(r1.action, 'comment-failed');
  assert.equal(noComment.calls.resolve.length, 0, 'una chiusura senza la prova del perché no');

  const refused = fakeDeps({
    resolveImpl: () => { const e = new Error('close rejected'); e.persisted = false; throw e; },
  });
  const origError = console.error;
  console.error = () => {};
  try {
    const r2 = await closeRecoveredStallIssue({ sustained: s, deps: refused.deps, ...quiet });
    assert.equal(r2.action, 'close-failed');
    assert.equal(r2.exitCode, 1, 'dichiararla chiusa sarebbe falso');
  } finally {
    console.error = origError;
  }
});

test('la nota e il risultato riportano la soglia di gap APPLICATA, non la costante', async () => {
  const nowMs = Date.parse('2026-10-03T18:37:00Z');
  const deliveries = fleetDays(['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03'])
    .filter((d) => d.atMs <= nowMs);
  const s = sustainedDelivery({ deliveries, nowMs, readable: true, maxGapHours: 12 });
  assert.equal(s.gapLimitHours, 12);
  assert.equal(sustainedDelivery({ deliveries, nowMs, readable: true }).gapLimitHours, CLOSE_MAX_GAP_HOURS);
  const { calls, deps } = fakeDeps();
  await closeRecoveredStallIssue({ sustained: s, deps, ...quiet });
  assert.ok(calls.comment[0].body.includes('(soglia 12h)'), 'la soglia applicata');
  assert.ok(!calls.comment[0].body.includes(`${CLOSE_MAX_GAP_HOURS}h`), 'non la costante di default');
});

test('se resolve chiude una issue diversa da quella commentata, lo segnala', async () => {
  const nowMs = Date.parse('2026-10-03T18:37:00Z');
  const deliveries = fleetDays(['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03'])
    .filter((d) => d.atMs <= nowMs);
  const s = sustainedDelivery({ deliveries, nowMs, readable: true });
  const { deps } = fakeDeps({ resolveImpl: () => ({ number: 1600, title: STALL_ISSUE_TITLE, persisted: true }) });
  const warnings = [];
  const r = await closeRecoveredStallIssue({ sustained: s, deps, log: () => {}, warn: (m) => warnings.push(m) });
  assert.equal(r.action, 'closed');
  assert.equal(r.number, 1600);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /#1579 ma chiusa #1600/);
});

test('il gap a cavallo dell inizio finestra conta per intero', () => {
  // L'ultima consegna prima della finestra di 72h è il punto di partenza del
  // primo intervallo: un buco iniziato prima e finito dentro non si accorcia.
  // Finestra 72h dal 10-01 08:00: l'ondata serale del 09-30 è persa, quindi
  // il buco va dalle 10:51 del 09-30 alle 09:19 del 10-01 (22,5h). Misurato
  // solo da inizio finestra sarebbe 1,3h e la issue si chiuderebbe.
  const nowMs = Date.parse('2026-10-04T08:00:00Z');
  const deliveries = fleetDays(['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03'], {
    skip: ['2026-09-30-pm'],
  }).filter((d) => d.atMs <= nowMs);
  const s = sustainedDelivery({ deliveries, nowMs, readable: true });
  assert.ok(s.perDay.every((d) => d.groups === EXPECTED_GROUPS), 'i tre giorni completi sono interi');
  assert.equal(s.sustained, false);
  assert.equal(s.reason, 'gap-too-long');
  assert.ok(s.maxGapHours > 22, `gap ${s.maxGapHours}`);
  assert.equal(s.maxGapEndMs, Date.parse('2026-10-01T09:19:00Z'));
});
