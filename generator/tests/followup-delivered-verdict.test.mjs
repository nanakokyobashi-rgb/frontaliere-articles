/**
 * followup-delivered-verdict.test.mjs — una consegna riuscita non consuma un
 * tentativo (issue #733).
 *
 * `fu-attempt:N` conta i FALLIMENTI: a N>=MAX_ATTEMPTS la issue viene
 * parcheggiata `fu-parked` ed esce dalla coda. Il rescue del drainer, per
 * decidere se una `agent:fix` è orfana, chiama `hasFixPR`, che interroga
 * `gh pr list --state open`: al MERGE della PR quel predicato torna `false`.
 * Il commento accanto a `NON_RETRYABLE` dichiarava l'esito `pr-created`
 * irraggiungibile proprio perché «`hasFixPR` lo intercetta prima» — vero solo
 * finché la PR è aperta.
 *
 * Quando la issue resta aperta dopo il merge — il caso NORMALE, non
 * l'eccezione: ISSUES.md impone `Refs #<n>` e non `Closes` sia per le issue
 * aggregate sia per i fix provabili solo da una run su `main`
 * (`awaiting-production-proof`) — la run di SUCCESSO cadeva nel ramo finale,
 * descritto come «run davvero morta, nessun verdetto», e veniva ri-accodata
 * con `fu-attempt`++. Misurato su #733: `pr-created` + PR mergiata due volte
 * (#772, #906) → `fu-attempt:1` il 2026-09-04T10:32, `fu-attempt:2` il
 * 2026-09-05T13:13. Al terzo ciclo RIUSCITO la issue si sarebbe parcheggiata.
 *
 * `DELIVERED` è la strada mancante: ri-accoda **senza** consumare un
 * tentativo, come già fa `ZERO_WORK`. Non è un loop aperto — il ciclo
 * successivo o consegna l'item seguente, o emette un verdetto `NON_RETRYABLE`
 * (`already-fixed`/`no-root-cause`) e parcheggia.
 *
 * Ma il ramo va SCOPATO ALLA RUN CORRENTE (`isDeliveredThisRun`), perché sia il
 * marker sia «nessuna PR aperta» sono stati PERSISTENTI della issue: il primo
 * sopravvive a ogni run successiva, il secondo copre allo stesso modo il merge
 * e la chiusura SENZA merge. Presi da soli, dopo la prima consegna ogni run
 * morta diventerebbe gratuita — `fu-attempt` non salirebbe mai più e
 * `park-attempts`, che per i crawler è l'UNICA uscita (niente parked-retry,
 * niente age-out), non si raggiungerebbe mai. Le tre condizioni — promozione
 * leggibile, marker DOPO la promozione, merge DOPO la promozione — sono ciò
 * che rende vero il bound dichiarato: ogni re-queue gratuito costa al ciclo
 * seguente una nuova promozione, un nuovo marker e un nuovo merge.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DELIVERED,
  NON_RETRYABLE,
  ZERO_WORK,
  MAX_ATTEMPTS,
  crawlerFixDecision,
  isDeliveredThisRun,
  lastLabelEventAt,
  latestFixOutcomeEntryFromComments,
} from '../../scripts/ci/followup-drainer.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DRAINER = path.join(ROOT, 'scripts/ci/followup-drainer.mjs');

// Una consegna della run CORRENTE: promozione → marker → merge, in quest'ordine.
// `outcome` + «nessuna PR aperta» da soli non bastano (sono stati persistenti
// della issue): i tre timestamp sono ciò che lega il ramo alla run in corso.
const T0 = Date.parse('2026-09-05T12:00:00Z');
const MIN = 60_000;
const deliveredRun = (o = {}) => ({
  outcome: 'pr-created',
  ageMin: 600,
  hasPR: false,
  promotedAt: T0,
  outcomeAt: T0 + 30 * MIN,
  mergedAt: T0 + 50 * MIN,
  ...o,
});

test('`pr-created` è un esito DELIVERED, non un verdetto fermo né una run morta', () => {
  assert.ok(DELIVERED.has('pr-created'), 'il percorso di successo del fixer deve avere una strada sua');
  // Le tre famiglie sono disgiunte: park (verdetto fermo), re-queue gratis
  // (issue mai letta), re-queue gratis (issue lavorata e consegnata).
  for (const code of DELIVERED) {
    assert.ok(!NON_RETRYABLE.has(code), `${code} non è un verdetto fermo: la issue è ancora aperta di proposito`);
    assert.ok(!ZERO_WORK.has(code), `${code} non è una run morta: l'agent ha letto la issue e consegnato`);
  }
});

test('crawlerFixDecision: PR mergiata → ri-arma senza consumare il tentativo', () => {
  const d = crawlerFixDecision(deliveredRun({ attempt: 2 }));
  assert.equal(d.action, 'requeue-delivered');
  assert.equal(d.nextAttempt, 2, 'una consegna riuscita non incrementa fu-attempt');
});

test('crawlerFixDecision: tre consegne riuscite non parcheggiano la issue', () => {
  // Il ciclo osservato su #733, proiettato al tetto: senza DELIVERED il terzo
  // `pr-created` produceva `park-attempts` — fuori dalla coda per aver
  // funzionato tre volte.
  let attempt = 0;
  for (let i = 0; i < MAX_ATTEMPTS + 1; i++) {
    // Ogni ciclo è una consegna NUOVA: promozione, marker e merge avanzano
    // insieme. È la condizione che rende gratuito il re-queue — non la
    // presenza del marker, che da sola resterebbe vera per sempre.
    const cycle = T0 + i * 24 * 60 * MIN;
    const d = crawlerFixDecision(deliveredRun({
      attempt,
      promotedAt: cycle,
      outcomeAt: cycle + 30 * MIN,
      mergedAt: cycle + 50 * MIN,
    }));
    assert.equal(d.action, 'requeue-delivered', `ciclo ${i + 1}: una consegna non è un tentativo fallito`);
    attempt = d.nextAttempt;
  }
  assert.equal(attempt, 0, 'il contatore dei fallimenti resta fermo su una catena di successi');
});

test('crawlerFixDecision: PR ANCORA aperta resta intoccata (il ramo hasPR viene prima)', () => {
  const d = crawlerFixDecision(deliveredRun({ attempt: 1, hasPR: true }));
  assert.equal(d.action, 'skip');
});

test('crawlerFixDecision: senza verdetto la run orfana consuma ancora un tentativo', () => {
  // La regressione da non introdurre: DELIVERED non deve rendere gratuito il
  // rescue delle run davvero morte, che è ciò che `fu-attempt` esiste per
  // contare.
  const d = crawlerFixDecision({ outcome: null, ageMin: 600, attempt: 0, hasPR: false });
  assert.equal(d.action, 'requeue');
  assert.equal(d.nextAttempt, 1);
});

test('il rescue queue-managed ha lo stesso ramo del gemello crawler', () => {
  // I due stadi decidono sullo stesso segnale (`latestFixOutcome` + `hasFixPR`)
  // ma su percorsi separati: il gemello non toccato è il modo in cui questa
  // classe di bug è già sopravvissuta a un giro.
  const src = fs.readFileSync(DRAINER, 'utf8');
  const stuck = src.slice(src.indexOf('for (const iss of stuckFix) {'));
  const branch = /if \(outcome && DELIVERED\.has\(outcome\)\) \{([\s\S]*?)\n {4}\}/.exec(stuck);
  assert.ok(branch, 'il rescue queue-managed deve avere il ramo DELIVERED');
  assert.match(branch[1], /add: \[LBL_QUEUED\], remove: \[LBL_FIX\]/, 'ri-accoda');
  // Solo il CODICE: il commento accanto nomina `fu-attempt` per spiegare perché
  // non lo tocca.
  const code = branch[1].split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(
    code,
    /fu-attempt/,
    'il ramo DELIVERED non deve toccare fu-attempt: conta i fallimenti, non le consegne',
  );
});

test('il commento che dichiarava `pr-created` irraggiungibile non sopravvive alla sua falsificazione', () => {
  const src = fs.readFileSync(DRAINER, 'utf8');
  assert.doesNotMatch(
    src,
    /`pr-created` non arriva qui/,
    'l assunzione «hasFixPR lo intercetta prima» è falsa appena la PR viene mergiata',
  );
});

test('crawlerFixDecision: marker `pr-created` del ciclo PRECEDENTE non rende gratuita una run morta', () => {
  // La classe di run che un verdetto non lo emette MAI (crashata, cancellata
  // in coda, mai partita) lascia in piedi il marker del ciclo prima. Letto come
  // consegna, toglierebbe ai crawler `park-attempts`, che è la loro UNICA
  // uscita: non passano né dal parked-retry né dall'age-out.
  const d = crawlerFixDecision(deliveredRun({
    attempt: 1,
    promotedAt: T0 + 2 * 24 * 60 * MIN, // promozione del ciclo NUOVO
    outcomeAt: T0,                      // marker del ciclo VECCHIO
    mergedAt: T0 + 50 * MIN,            // merge del ciclo VECCHIO
  }));
  assert.equal(d.action, 'requeue');
  assert.equal(d.nextAttempt, 2, 'una run morta consuma un tentativo anche dopo una consegna passata');
});

test('crawlerFixDecision: PR fix CHIUSA senza merge non è una consegna', () => {
  // `hasFixPR` interroga `--state open`: senza il gate sul merge, una PR
  // rifiutata/superata/chiusa a mano è indistinguibile da una mergiata e
  // otterrebbe lo stesso re-queue gratuito, con nulla di atterrato.
  const d = crawlerFixDecision(deliveredRun({ attempt: 1, mergedAt: null }));
  assert.equal(d.action, 'requeue');
  assert.equal(d.nextAttempt, 2);
});

test('crawlerFixDecision: promozione illeggibile → nessuna gratuità (fail-closed)', () => {
  // Glitch gh sull'API eventi: senza sapere quando è iniziata la run corrente
  // non si può dire che il marker appartenga a lei. Si ricade sul ramo
  // bounded pre-esistente, mai sul re-queue gratuito.
  const d = crawlerFixDecision(deliveredRun({ attempt: 0, promotedAt: null }));
  assert.equal(d.action, 'requeue');
  assert.equal(d.nextAttempt, 1);
});

test('isDeliveredThisRun: le tre condizioni sono tutte necessarie', () => {
  const ok = { outcome: 'pr-created', promotedAt: T0, outcomeAt: T0 + MIN, mergedAt: T0 + 2 * MIN };
  assert.equal(isDeliveredThisRun(ok), true);
  assert.equal(isDeliveredThisRun({ ...ok, outcome: 'max-turns' }), false, 'solo gli esiti DELIVERED');
  assert.equal(isDeliveredThisRun({ ...ok, promotedAt: null }), false, 'promozione illeggibile');
  assert.equal(isDeliveredThisRun({ ...ok, outcomeAt: T0 - MIN }), false, 'marker precedente alla promozione');
  assert.equal(isDeliveredThisRun({ ...ok, outcomeAt: null }), false, 'marker senza data');
  assert.equal(isDeliveredThisRun({ ...ok, mergedAt: T0 - MIN }), false, 'merge di un ciclo precedente');
  assert.equal(isDeliveredThisRun({ ...ok, mergedAt: null }), false, 'nessuna PR mergiata');
});

test('lastLabelEventAt: ultima aggiunta della label, ignorando le altre e le date rotte', () => {
  const events = [
    { event: 'labeled', label: { name: 'agent:fix' }, created_at: '2026-09-01T10:00:00Z' },
    { event: 'unlabeled', label: { name: 'agent:fix' }, created_at: '2026-09-04T10:00:00Z' },
    { event: 'labeled', label: { name: 'fu-prio:high' }, created_at: '2026-09-05T10:00:00Z' },
    { event: 'labeled', label: { name: 'agent:fix' }, created_at: 'non-una-data' },
    { event: 'labeled', label: { name: 'agent:fix' }, created_at: '2026-09-03T10:00:00Z' },
  ];
  assert.equal(lastLabelEventAt(events, 'agent:fix'), Date.parse('2026-09-03T10:00:00Z'));
  assert.equal(lastLabelEventAt(events, 'agent:decompose'), null);
  assert.equal(lastLabelEventAt([], 'agent:fix'), null);
});

test('latestFixOutcomeEntryFromComments: il timestamp accompagna il verdetto', () => {
  const entry = latestFixOutcomeEntryFromComments([
    { body: '<!-- FIX_OUTCOME: pr-created -->', createdAt: '2026-09-04T09:00:00Z' },
    { body: '<!-- FIX_OUTCOME: no-root-cause -->', created_at: '2026-09-05T09:00:00Z' },
  ]);
  assert.deepEqual(entry, { outcome: 'no-root-cause', at: Date.parse('2026-09-05T09:00:00Z') });
  assert.deepEqual(latestFixOutcomeEntryFromComments([]), { outcome: null, at: null });
});

test('il ramo DELIVERED del rescue queue-managed è qualificato da isDeliveredThisRun', () => {
  // Il gemello: entrambi gli stadi devono scopare il marker alla run corrente,
  // o quello non toccato riapre il buco al giro dopo.
  const src = fs.readFileSync(DRAINER, 'utf8');
  const stuck = src.slice(src.indexOf('for (const iss of stuckFix) {'));
  const branch = /if \(outcome && DELIVERED\.has\(outcome\)\) \{([\s\S]*?)\n {4}\}/.exec(stuck);
  assert.ok(branch, 'il rescue queue-managed deve avere il ramo DELIVERED');
  assert.match(branch[1], /isDeliveredThisRun\(\{/, 'il re-queue gratuito passa dal gate sulla run corrente');
  assert.match(branch[1], /mergedAt: mergedFixPrAt\(/, 'gate sul merge reale, non sull assenza di PR aperte');
  assert.match(branch[1], /promotedAt: fixPromotedAt\(/, 'gate sulla promozione della run corrente');
});
