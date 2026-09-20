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

test('il classificatore del corpus traccia il declassamento, ma il gate resta fail-closed', () => {
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
    'il classificatore deve esporre il ramo perche\' il gate possa applicare il guard fail-closed');
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

test('un Important su un path che non risolve NON si declassa mai', () => {
  // `changedLinesSince.get(file) ?? new Set()` trasforma un file omesso dal
  // compare — o cancellato — in «confrontato e intatto». Se il declassamento
  // girasse PRIMA della risoluzione delle citazioni, un Important ancorato a
  // un path che nell'albero della HEAD non esiste piu' uscirebbe declassato
  // invece che `unresolved`, e `outsideOnly` potrebbe approvare una
  // cancellazione che rompe la superficie pubblicata. Finding della review
  // su #1641.
  const review = ['## Findings (Important: 1)',
    '`engine/cancellato.mjs:5`: 🔴 Important: il canonical sparisce.'].join('\n');
  const result = classifyImportantFindings(review, ['engine/altro.mjs'], ['engine/altro.mjs'], {
    priorFindingIds: new Set(),
    changedLinesSince: new Map([['engine/cancellato.mjs', new Set()]]),
  });
  assert.equal(result.staleDeclassified.length, 0,
    'il path non risolve nell\'albero: il finding non e\' declassabile');
  assert.equal(result.blocking, true);
  assert.equal(result.unresolved.length, 1);
});

test('la cronologia riconosce il reviewer PRIMARIO di questo repo', () => {
  // Il reviewer qui e' `github-actions[bot]` col marker del fallback Codex.
  // Il predicato condiviso deve riconoscere il marker Codex: filtrando sul solo
  // reviewer generico gli id precedenti e il delta uscirebbero vuoti.
  const source = read('scripts/ci/review-scope.mjs');
  const start = source.indexOf('function reviewHistoryContext(');
  assert.notEqual(start, -1);
  const block = source.slice(start, source.indexOf('\nfunction ', start + 10));
  assert.match(block, /CODEX_FALLBACK_REVIEW/u,
    'la cronologia scarta le review Codex, cioe\' quasi tutte');
  assert.match(block, /isManagedReview\(review\)/u);
});

test('la storia e\' tutto tranne la review in corso, e la finestra e\' quella precedente', () => {
  // Escludere ogni review sulla HEAD corrente lasciava fuori il finding
  // IMMEDIATAMENTE precedente: un 🔴 ripetuto sulla stessa HEAD risultava
  // «nuovo» e diventava declassabile, cioe' esattamente il caso che la regola
  // deve lasciar passare intatto. E la finestra deve essere quella della
  // review precedente, non della piu' recente su un commit diverso: con la
  // seconda il compare include anche cambiamenti anteriori a quella review.
  // Finding della review su #1641.
  const source = read('scripts/ci/review-scope.mjs');
  const start = source.indexOf('function reviewHistoryContext(');
  const block = source.slice(start, source.indexOf('\nfunction ', start + 10));
  assert.match(block, /const history = managed\.slice\(0, -1\);/u,
    'la storia non e\' «tutto tranne la review in corso»');
  assert.ok(!/commit_id \|\| ''\) === String\(headSha\)\) continue;/u.test(block),
    'la raccolta degli id salta ancora le review sulla HEAD corrente');
  assert.match(block, /const prior = history\[history\.length - 1\];/u,
    'la finestra non e\' quella della review immediatamente precedente');
  assert.match(block, /changedLinesSince: new Map\(\)/u,
    'una review precedente sulla STESSA HEAD deve dare delta VUOTO, non «non calcolabile»');
});

test('due finding sulla stessa riga non si rimuovono a vicenda', () => {
  // `staleKeys` teneva solo la riga del marker: due finding distinti che la
  // condividessero venivano rimossi INSIEME, e un rilievo reale spariva dal
  // blocco del gate perche' un altro era declassabile. Ora il predicato si
  // interroga un finding alla volta e non c'e' nessuna chiave da far
  // collidere. Finding della review su #1641.
  const source = read('scripts/ci/review-scope.mjs');
  assert.ok(!/staleKeys/u.test(source), 'esiste ancora una chiave posizionale');
  assert.match(source, /findings: \[finding\],/u,
    'il predicato non viene interrogato un finding alla volta');

  // Comportamento: uno declassabile e uno no, nello stesso review body.
  const review = [
    '## Findings (Important: 2)',
    '`scripts/ci/review-scope.mjs:900`: 🔴 Important: `resolveCitedPath()` non regge.',
    '`scripts/ci/review-scope.mjs:2`: 🔴 Important: l\'import e\' sbagliato.',
  ].join('\n');
  const result = classifyImportantFindings(review, ['scripts/ci/review-scope.mjs'], null, {
    priorFindingIds: new Set(),
    changedLinesSince: new Map([['scripts/ci/review-scope.mjs', new Set([2])]]),
  });
  assert.equal(result.staleDeclassified.length, 1, 'solo quello su riga non toccata');
  assert.equal(result.inScope.length, 1, 'quello sulla riga toccata resta bloccante');
  assert.equal(result.blocking, true);
});

test('un file cambiato ma non confrontabile riga per riga non e\' «intatto»', () => {
  // Il compare riporta il file (quindi E' cambiato) ma senza patch: binario,
  // troppo grande, o patch omessa. Il seed con l'elenco file della PR lo
  // marcava «confrontato e intatto» e un Important su quel file finiva
  // declassato senza prova. Finding della review su #1641.
  const review = ['## Findings (Important: 1)',
    '`generator/scripts/big-generated.mjs:1`: 🔴 Important: il file generato e\' corrotto.'].join('\n');
  const opts = {
    priorFindingIds: new Set(),
    changedLinesSince: new Map([['scripts/ci/review-scope.mjs', new Set([2])]]),
  };
  const without = classifyImportantFindings(review, ['generator/scripts/big-generated.mjs'], ['generator/scripts/big-generated.mjs'], opts);
  assert.equal(without.staleDeclassified.length, 1, 'controllo: senza la dichiarazione verrebbe declassato');

  const declared = classifyImportantFindings(review, ['generator/scripts/big-generated.mjs'], ['generator/scripts/big-generated.mjs'], {
    ...opts,
    uncomparablePaths: new Set(['generator/scripts/big-generated.mjs']),
  });
  assert.equal(declared.staleDeclassified.length, 0, 'dichiarato non confrontabile: resta bloccante');
  assert.equal(declared.blocking, true);
});

test('un compare al limite API non e\' una prova: delta non calcolabile', () => {
  // `compare` tronca a 300 file senza dichiararlo. Su un elenco troncato un
  // file davvero modificato puo' mancare, e il seed lo farebbe passare per
  // «intatto»: un finding nuovo su una riga CAMBIATA verrebbe declassato e il
  // bug entrerebbe nel ciclo. Finding della review su #1641.
  const source = read('scripts/ci/review-scope.mjs');
  assert.match(source, /const COMPARE_FILES_CAP = 300;/u, 'il tetto dell\'API non e\' dichiarato');
  assert.match(source, /compareFiles\.length >= COMPARE_FILES_CAP/u,
    'un compare al limite non viene riconosciuto');
  const start = source.indexOf('compareFiles.length >= COMPARE_FILES_CAP');
  const block = source.slice(start, start + 400);
  assert.match(block, /changedLinesSince: null/u,
    'al limite dell\'API il delta deve diventare non calcolabile, non vuoto');
});

test('l\'ordine delle review si normalizza, non si eredita dall\'API', () => {
  // L'ordine dell'array REST non e' un contratto. Senza normalizzazione
  // «l'ultima» e «la precedente» sono quelle che l'API capita a mettere in
  // fondo: il compare parte dal commit sbagliato e un finding nuovo puo'
  // uscire come gia' visto o su righe non cambiate, cioe' il blocco del gate
  // sparisce per un dettaglio di serializzazione. Finding della review
  // su #1641.
  const source = read('scripts/ci/review-scope.mjs');
  const start = source.indexOf('function reviewHistoryContext(');
  const block = source.slice(start, source.indexOf('\nfunction ', start + 10));
  assert.match(block, /\.sort\(\(left, right\) => \{/u,
    'la cronologia non ordina le review prima di sceglierne l\'ultima');
  assert.match(block, /submitted_at \|\| review\?\.created_at/u,
    'l\'ordinamento non usa il timestamp');
  assert.match(block, /Number\(left\?\.id\)/u,
    'a parita\' di timestamp manca il secondo criterio');
});

test('un anchor che non si sa verificare per intero non si declassa', () => {
  // `unchangedLineImportants` guarda `citation.line`, che e' il solo estremo
  // INIZIALE di un intervallo, e ignora le citazioni senza riga. Con
  // `file.mjs:L10-20` si proverebbe solo L10; con una citazione al file nudo,
  // niente. Se L15 o quel file fossero cambiati, il finding uscirebbe da
  // `inScope` e il gate approverebbe codice non verificato. Finding della
  // review su #1641.
  const changed = new Map([['engine/render.mjs', new Set([15])]]);
  const opts = { priorFindingIds: new Set(), changedLinesSince: changed };
  const files = ['engine/render.mjs'];

  const range = classifyImportantFindings(
    ['## Findings (Important: 1)',
     '`engine/render.mjs:10-20`: 🔴 Important: il blocco perde il locale.'].join('\n'),
    files, files, opts,
  );
  assert.equal(range.staleDeclassified.length, 0, 'un intervallo non si declassa: L15 e\' cambiata');
  assert.equal(range.blocking, true);

  const bare = classifyImportantFindings(
    ['## Findings (Important: 1)',
     '`engine/render.mjs:42`: 🔴 Important: rotto, vedi anche `engine/render.mjs`.'].join('\n'),
    files, files, opts,
  );
  assert.equal(bare.staleDeclassified.length, 0,
    'una citazione senza riga non si puo\' dimostrare non cambiata');
  assert.equal(bare.blocking, true);

  // Controllo positivo: anchor singolo e riga intatta → si declassa.
  const single = classifyImportantFindings(
    ['## Findings (Important: 1)',
     '`engine/render.mjs:42`: 🔴 Important: il locale sparisce.'].join('\n'),
    files, files, opts,
  );
  assert.equal(single.staleDeclassified.length, 1);
});
