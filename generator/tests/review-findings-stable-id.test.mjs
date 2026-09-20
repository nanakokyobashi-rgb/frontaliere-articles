/**
 * Identita' stabile dei finding e stop ai 🔴 su righe non cambiate
 * (trasporto adattato del sito valerielinc-ops/frontaliere-si-o-no#9318).
 *
 * Misure del sito su 220 review: 7 casi `## LGTM` → 🔴 Important sulla stessa
 * PR senza NESSUN cambio di codice in mezzo, 9 🔴 identici ripetuti parola per
 * parola, 9 body con `\n` letterali o conferme `Fix di ``: ok` senza anchor.
 * Causa comune: l'identita' di un finding era il suo anchor `path:Lriga`, che
 * un rebase o un merge di main sposta.
 *
 * Qui si difendono i CONFINI, perche' questa e' una regola che SOPPRIME un
 * verdetto e sbagliare verso il permissivo costa un bug non visto. Il
 * declassamento non deve scattare: senza anchor di riga, senza delta
 * calcolabile, su un path mai confrontato, su un finding che il parser non sa
 * delimitare, su un id gia' visto, o su un `[regression]` dichiarato.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  changedLinesFromPatch,
  dedupeFindingsById,
  findingDeclaredClass,
  isMalformedReviewBody,
  reviewBodyDefects,
  stableFindingId,
  unchangedLineImportants,
} from '../../scripts/ci/lib/review-findings.mjs';
import { classifyImportantFindings, importantFindings } from '../../scripts/ci/review-scope.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const finding = (text) => importantFindings(['## Findings (Important: 1)', text].join('\n'))[0];

test('l\'id stabile non cambia quando la riga si sposta', () => {
  // E' la proprieta' per cui il modulo esiste: un merge di main sposta la riga
  // e il rilievo diventava «nuovo», quindi non si deduplicava e non si
  // lasciava confermare.
  const before = finding('`engine/render.mjs:42`: 🔴 Important: `buildCanonical()` perde il locale.');
  const after = finding('`engine/render.mjs:87`: 🔴 Important: `buildCanonical()` perde il locale.');
  assert.equal(stableFindingId(before), stableFindingId(after));

  // Due rilievi DIVERSI sullo stesso file e sullo stesso simbolo restano
  // distinti: la prosa entra sempre nell'id. Senza, `dedupeFindingsById` ne
  // faceva sparire uno e un Important aperto evaporava.
  const other = finding('`engine/render.mjs:42`: 🔴 Important: `buildCanonical()` non gestisce il 404.');
  assert.notEqual(stableFindingId(before), stableFindingId(other));

  // File diverso, stesso testo → id diverso.
  const elsewhere = finding('`host/render.mjs:42`: 🔴 Important: `buildCanonical()` perde il locale.');
  assert.notEqual(stableFindingId(before), stableFindingId(elsewhere));

  assert.equal(dedupeFindingsById([before, after, other]).length, 2);
});

test('la classe si dichiara DOPO i due punti, e una inventata vale other', () => {
  assert.equal(findingDeclaredClass('🔴 Important: [regression] rotto.'), 'regression');
  assert.equal(findingDeclaredClass('🔴 Important: [contract] rotto.'), 'contract');
  assert.equal(findingDeclaredClass('🔴 Important: [urgentissimo] rotto.'), 'other',
    'una classe inventata non compra l\'eccezione riservata a regression');
  assert.equal(findingDeclaredClass('🔴 Important [regression]: rotto.'), 'other',
    'il tag prima del separatore rende il finding invisibile al parser del gate');
  assert.equal(findingDeclaredClass('🔴 Important: rotto.'), 'other');
});

test('un 🔴 nuovo su righe non toccate si declassa, e i confini tengono', () => {
  const changed = new Map([['engine/render.mjs', new Set([10, 11])]]);
  const stale = finding('`engine/render.mjs:42`: 🔴 Important: `buildCanonical()` perde il locale.');
  assert.equal(unchangedLineImportants({
    findings: [stale], priorFindingIds: new Set(), changedLines: changed,
  }).length, 1);

  // 1. Id gia' visto: non e' nuovo, quindi non si tocca.
  assert.equal(unchangedLineImportants({
    findings: [stale], priorFindingIds: new Set([stableFindingId(stale)]), changedLines: changed,
  }).length, 0);

  // 2. `[regression]` dichiarato: il reviewer se ne prende la responsabilita'.
  const regression = finding('`engine/render.mjs:42`: 🔴 Important: [regression] `buildCanonical()` perde il locale.');
  assert.equal(unchangedLineImportants({
    findings: [regression], priorFindingIds: new Set(), changedLines: changed,
  }).length, 0);

  // 3. Riga toccata dal delta: il codice E' cambiato, il rilievo e' legittimo.
  assert.equal(unchangedLineImportants({
    findings: [finding('`engine/render.mjs:10`: 🔴 Important: rotto.')],
    priorFindingIds: new Set(),
    changedLines: changed,
  }).length, 0);

  // 4. Path mai confrontato: assente dalla Map non significa «non cambiato».
  assert.equal(unchangedLineImportants({
    findings: [finding('`host/other.mjs:5`: 🔴 Important: rotto.')],
    priorFindingIds: new Set(),
    changedLines: changed,
  }).length, 0);

  // 5. Delta non calcolabile: su un dato mancante si tiene il finding.
  assert.equal(unchangedLineImportants({
    findings: [stale], priorFindingIds: new Set(), changedLines: null,
  }).length, 0);

  // 6. Parser incerto: non si sa dove finisca, quindi non si sa a cosa punti.
  assert.equal(unchangedLineImportants({
    findings: [{ ...stale, parserUncertain: true }],
    priorFindingIds: new Set(),
    changedLines: changed,
  }).length, 0);
});

test('il patch si legge riga per riga, e dentro un hunk niente e\' un header', () => {
  const patch = [
    '+++ b/scripts/ci/x.mjs',
    '@@ -1,3 +1,4 @@',
    ' const a = 1;',
    '+++ concat;',
    '-const b = 2;',
    ' const c = 3;',
  ].join('\n');
  const map = changedLinesFromPatch(patch);
  // La riga aggiunta il cui contenuto inizia con `++ ` arriva come `+++ ...`:
  // leggerla come intestazione spostava il path e un Important su codice
  // appena aggiunto finiva declassato come «riga non cambiata».
  assert.deepEqual([...map.get('scripts/ci/x.mjs')], [2]);
  assert.equal(changedLinesFromPatch(null), null, 'patch assente = non calcolabile, non vuoto');
});

test('un body malformato non e\' un verdetto', () => {
  const literal = 'riga uno\\nriga due\\nriga tre\\nriga quattro';
  assert.deepEqual(reviewBodyDefects(literal), ['literal-newline']);
  assert.equal(isMalformedReviewBody(literal), true);

  assert.ok(reviewBodyDefects('Fix di ``: ok').includes('empty-fix-anchor'),
    'un anchor vuoto chiuderebbe per silenzio qualunque finding aperto');

  // Prosa legittima che nomina `\\n` una volta sola non e' malformata.
  assert.equal(isMalformedReviewBody([
    '## Findings (Important: 1)',
    '`scripts/ci/x.mjs:3`: 🔴 Important: la regex non gestisce `\\n`.',
    '',
    'Altre due righe di prosa.',
    'E ancora una.',
  ].join('\n')), false);
});

test('il classificatore del corpus declassa e resta approvabile', () => {
  const review = ['## Findings (Important: 1)',
    '`scripts/ci/review-scope.mjs:999`: 🔴 Important: `resolveCitedPath()` non regge.'].join('\n');
  const changedFiles = ['scripts/ci/review-scope.mjs'];

  const blocking = classifyImportantFindings(review, changedFiles);
  assert.equal(blocking.blocking, true, 'senza delta il finding resta bloccante');
  assert.equal(blocking.staleDeclassified.length, 0);

  const declassified = classifyImportantFindings(review, changedFiles, null, {
    priorFindingIds: new Set(),
    changedLinesSince: new Map([['scripts/ci/review-scope.mjs', new Set([1, 2])]]),
  });
  assert.equal(declassified.staleDeclassified.length, 1);
  assert.equal(declassified.blocking, false);
  assert.equal(declassified.outsideOnly, true,
    'senza outsideOnly il gate non approverebbe e il declassamento non sbloccherebbe nulla');
  assert.ok(declassified.staleDeclassified[0].stableId, 'il log deve poter citare l\'id stabile');
});

test('la derivazione sta nel classificatore, cosi\' anche il fixer la riceve', () => {
  // `pr-redflag-fixer.yml` invoca la CLI di `review-scope.mjs` senza passare
  // ne' gli id precedenti ne' il delta: se la derivazione vivesse solo nel
  // review gate, un 🔴 declassato farebbe comunque partire il fixer e
  // brucerebbe un round su lavoro che non esiste. Due politiche sullo stesso
  // verdetto sono il modo in cui questo ciclo si incaglia.
  const source = read('scripts/ci/review-scope.mjs');
  assert.match(source, /function reviewHistoryContext\(/u,
    'review-scope non deriva la storia delle review');
  assert.match(source, /\(priorFindingIds === null && changedLinesSince === null\)/u,
    'la derivazione non e\' il default quando il chiamante non dichiara nulla');
  assert.match(source, /DECLASSIFIED-UNCHANGED-LINE/u,
    'il declassamento non lascia traccia nel log');
  const fixer = read('.github/workflows/pr-redflag-fixer.yml');
  assert.match(fixer, /node scripts\/ci\/review-scope\.mjs/u,
    'il fixer deve continuare a passare da questa CLI');

  const gate = read('scripts/ci/review-gate.mjs');
  assert.match(gate, /isMalformedReviewBody\(body\)/u,
    'il gate non scarta un body malformato');
});
