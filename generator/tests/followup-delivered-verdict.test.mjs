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
} from '../../scripts/ci/followup-drainer.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DRAINER = path.join(ROOT, 'scripts/ci/followup-drainer.mjs');

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
  const d = crawlerFixDecision({ outcome: 'pr-created', ageMin: 600, attempt: 2, hasPR: false });
  assert.equal(d.action, 'requeue-delivered');
  assert.equal(d.nextAttempt, 2, 'una consegna riuscita non incrementa fu-attempt');
});

test('crawlerFixDecision: tre consegne riuscite non parcheggiano la issue', () => {
  // Il ciclo osservato su #733, proiettato al tetto: senza DELIVERED il terzo
  // `pr-created` produceva `park-attempts` — fuori dalla coda per aver
  // funzionato tre volte.
  let attempt = 0;
  for (let i = 0; i < MAX_ATTEMPTS + 1; i++) {
    const d = crawlerFixDecision({ outcome: 'pr-created', ageMin: 600, attempt, hasPR: false });
    assert.equal(d.action, 'requeue-delivered', `ciclo ${i + 1}: una consegna non è un tentativo fallito`);
    attempt = d.nextAttempt;
  }
  assert.equal(attempt, 0, 'il contatore dei fallimenti resta fermo su una catena di successi');
});

test('crawlerFixDecision: PR ANCORA aperta resta intoccata (il ramo hasPR viene prima)', () => {
  const d = crawlerFixDecision({ outcome: 'pr-created', ageMin: 600, attempt: 1, hasPR: true });
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
