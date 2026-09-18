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
  MIN_COVERAGE_FRACTION,
  countCrawlerGroups,
  MIN_GROUPS_PER_DAY,
  COVERAGE_WINDOW_HOURS,
  groupDeliveries,
  stallVerdict,
  deliveriesByDay,
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

test('un fleet sano non suona', () => {
  // 09-13: 23/23 in un'unica ondata.
  const v = stallVerdict({
    deliveries: wave(23, 2), nowMs: NOW, stallHours: 6, readable: true,
  });
  assert.equal(v.stalled, false);
  assert.equal(v.reason, 'delivering');
  assert.equal(v.coverage, 23);
});

test('LA MISURA: la soglia separa i giorni sani da quelli rotti senza sovrapposizione', () => {
  // Minimo osservato sano = 21; massimo osservato rotto = 6.
  const healthy = [21, 22, 23];
  const broken = [0, 2, 2, 4, 6];
  for (const n of healthy) {
    assert.ok(n >= MIN_GROUPS_PER_DAY, `giorno sano ${n}/23 non deve suonare`);
    const v = stallVerdict({ deliveries: wave(n, 2), nowMs: NOW, stallHours: 6, readable: true });
    assert.equal(v.stalled, false, `${n}/23 è sano`);
  }
  for (const n of broken) {
    assert.ok(n < MIN_GROUPS_PER_DAY, `giorno rotto ${n}/23 deve suonare`);
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
    deliveries: wave(23, 40), nowMs: NOW, stallHours: 6, readable: true,
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
  assert.equal(EXPECTED_GROUPS, 23);
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
  assert.equal(countCrawlerGroups('/nonexistent-dir'), 23, 'fallback al valore misurato, non a zero');
  assert.equal(MIN_COVERAGE_FRACTION, 0.5);
  assert.equal(MIN_GROUPS_PER_DAY, Math.max(2, Math.round(EXPECTED_GROUPS * MIN_COVERAGE_FRACTION)));
  // Con la flotta osservata oggi la soglia resta quella misurata.
  assert.equal(EXPECTED_GROUPS, 23);
  assert.equal(MIN_GROUPS_PER_DAY, 12);
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

test('il titolo e UNICO per entrambi i verdetti, o la dedup apre due issue', () => {
  // Un incidente che passa da under-coverage a hard-stop è il PEGGIORAMENTO
  // dello stesso guasto: con due titoli la dedup non lo riconosce e, dato che la
  // chiusura automatica è dichiarata non implementata, restano aperte entrambe.
  const src = readFileSync(new URL('../../scripts/ci/scan-crawler-fleet-stall.mjs', import.meta.url), 'utf8');
  assert.match(src, /const title = 'Crawler fleet: i gruppi non consegnano dati';/);
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
