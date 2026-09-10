/**
 * faq-write-floor.test.mjs — il pavimento sotto cui una FAQ potata NON si
 * scrive, e il fatto che i due scrittori lo condividano.
 *
 * ## IL DIFETTO CHE QUESTO FILE PINNA
 *
 * Conservare le coppie sane invece di buttare l'articolo intero e' giusto, ma
 * senza pavimento la potatura e' PERMANENTE: il rilevatore riaccoda un locale
 * solo se manca la chiave `.faq` o se `wrongLocalePair` trova ancora una coppia
 * sbagliata, e dopo una scrittura parziale nessuna delle due condizioni vale
 * piu'. Il locale resta pubblicato con meno coppie dell'italiano per sempre,
 * senza un errore — e in `fix-faq-locales.mjs` veniva pure contato come
 * `fixed++`, sostituendo con `replaceFaqInFile` una FAQ completa con quella
 * potata. E' il caso peggiore per questo repo: una superficie troncata non
 * fallisce, il sito la accetta e mostra meno di quello che c'e'.
 *
 * ## MUTAZIONI
 *
 * Falsificato rimettendo `if (validFaq.length === 0)` al posto del pavimento in
 * `translateFaq`: i test `sotto il pavimento` diventano rossi.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FAQ_REJECTION_MAX_CONSECUTIVE,
  MIN_FAQ_PAIRS,
  belowFaqFloor,
  belowFaqSourceCount,
  faqLocaleIssueKey,
  faqSourceFingerprint,
  minPairsForWrite,
  nextFaqRejection,
  selectFaqIssuesForProcessing,
  shouldSkipFaqRejection,
} from '../scripts/fix-faq-locales.mjs';

const QUI = path.dirname(fileURLToPath(import.meta.url));
const BATCH = path.join(QUI, '..', 'scripts', 'batch-add-faq-to-articles.mjs');
const FIX = path.join(QUI, '..', 'scripts', 'fix-faq-locales.mjs');

const pairs = (n) => Array.from({ length: n }, (_, i) => ({ q: `domanda ${i}`, a: `risposta ${i}` }));

test('il pavimento e\' MIN_FAQ_PAIRS quando la sorgente ne ha almeno altrettante', () => {
  assert.equal(MIN_FAQ_PAIRS, 3);
  assert.equal(minPairsForWrite(pairs(8)), MIN_FAQ_PAIRS);
  assert.equal(minPairsForWrite(pairs(3)), MIN_FAQ_PAIRS);
});

test('una sorgente piu\' corta abbassa il pavimento: pretendere 3 da 2 sarebbe irraggiungibile', () => {
  // Un pavimento che la sorgente non puo' soddisfare non e' un gate piu'
  // severo: e' un locale che non verrebbe scritto MAI PIU'.
  assert.equal(minPairsForWrite(pairs(2)), 2);
  assert.equal(belowFaqFloor(pairs(2), pairs(2)), false);
});

test('sotto il pavimento la scrittura e\' rifiutata, sopra e\' ammessa', () => {
  assert.equal(belowFaqFloor(pairs(1), pairs(3)), true, '1 coppia su 3 italiane e\' sotto il minimo');
  assert.equal(belowFaqFloor(pairs(2), pairs(5)), true);
  assert.equal(belowFaqFloor(pairs(3), pairs(5)), false, '3 coppie sane sono pubblicabili');
  assert.equal(belowFaqFloor([], pairs(4)), true);
  assert.equal(belowFaqFloor(null, pairs(4)), true, 'nessuna coppia non e\' una scrittura valida');
});

test('il rilevatore riaccoda un locale che ha meno FAQ della sorgente', () => {
  assert.equal(belowFaqSourceCount(pairs(3), pairs(8)), true, '3/8 deve restare visibile');
  assert.equal(belowFaqSourceCount(pairs(8), pairs(8)), false);
  assert.equal(belowFaqSourceCount(pairs(2), pairs(1)), false);
  assert.equal(belowFaqSourceCount(null, pairs(8)), false, 'un literal illeggibile non e\' misurabile qui');
});

test('una potatura sopra il pavimento registra una scrittura parziale senza congelarla', () => {
  assert.equal(belowFaqFloor(pairs(5), pairs(8)), false, '5/8 supera il pavimento minimo');
  assert.equal(belowFaqSourceCount(pairs(5), pairs(8)), true, '5/8 non e\' una scrittura completa');

  const src = fs.readFileSync(FIX, 'utf-8');
  assert.match(
    src,
    /if \(belowFaqFloor\(toWrite, issue\.itFaq\)\) \{/,
    'solo una potatura sotto minPairsForWrite deve alimentare il ledger',
  );
  assert.doesNotMatch(
    src,
    /belowFaqFloor\(toWrite, issue\.itFaq\)\s*\|\|\s*belowFaqSourceCount\(toWrite, issue\.itFaq\)/,
    'belowFaqSourceCount riaccoda la sorgente ma non rifiuta una potatura sopra il pavimento',
  );
  assert.match(
    src,
    /nextFaqRejection\(previousRejection, issue\.itFaq, \{ prunedWrite: true \}\)/,
    'la potatura pubblicata deve avere un contatore distinto dal rifiuto sotto pavimento',
  );
  assert.match(
    src,
    /const partialWrite = belowFaqSourceCount\(toWrite, issue\.itFaq\);/,
    'il ledger parziale deve basarsi sul deficit osservabile rispetto alla sorgente',
  );
  assert.match(
    src,
    /else if \(rejectionLedger\[issueKey\]\) \{\s*delete rejectionLedger\[issueKey\]/s,
    'un ledger precedente deve essere cancellato solo dopo una scrittura completa',
  );
});

test('il ledger ferma il rifiuto deterministico dopo due run sulla stessa sorgente', () => {
  const source = pairs(3);
  const changedSource = pairs(4);
  const key = faqLocaleIssueKey('articolo', 'en');
  assert.equal(key, 'frontaliere/articolo/en');
  assert.equal(faqSourceFingerprint(source), faqSourceFingerprint(source));

  const first = nextFaqRejection(undefined, source);
  const second = nextFaqRejection(first, source);
  assert.equal(first.consecutive, 1);
  assert.equal(second.consecutive, FAQ_REJECTION_MAX_CONSECUTIVE);
  assert.equal(shouldSkipFaqRejection(first, source), false);
  assert.equal(shouldSkipFaqRejection(second, source), true);
  assert.equal(shouldSkipFaqRejection(second, changedSource), false, 'una sorgente cambiata riapre il tentativo');
  assert.equal(nextFaqRejection(second, changedSource).consecutive, 1);
  assert.equal(nextFaqRejection({ source: faqSourceFingerprint(source), consecutive: 'corrupt' }, source).consecutive, 1);

  const partialFirst = nextFaqRejection(undefined, source, { prunedWrite: true });
  const partialSecond = nextFaqRejection(partialFirst, source, { prunedWrite: true });
  assert.equal(partialFirst.prunedWrite, true);
  assert.equal(partialSecond.consecutive, FAQ_REJECTION_MAX_CONSECUTIVE);
  assert.equal(shouldSkipFaqRejection(partialSecond, source), true, 'dopo due potature uguali si salta solo la ritraduzione');
  assert.equal(nextFaqRejection(partialSecond, source).consecutive, FAQ_REJECTION_MAX_CONSECUTIVE + 1, 'il tipo cambia ma la sorgente uguale mantiene il contatore');
});

test('gli skip throttled non consumano il limite e lasciano passare il lavoro azionabile', () => {
  const source = pairs(8);
  const issue = (articleId) => ({ articleId, locale: 'en', itFaq: source });
  const issues = [issue('frozen-1'), issue('frozen-2'), issue('frozen-3'), issue('actionable-1'), issue('actionable-2')];
  const rejectionLedger = Object.fromEntries(
    issues.slice(0, 3).map(({ articleId }) => [
      faqLocaleIssueKey(articleId, 'en'),
      nextFaqRejection(nextFaqRejection(undefined, source, { prunedWrite: true }), source, { prunedWrite: true }),
    ]),
  );

  const selected = selectFaqIssuesForProcessing(issues, rejectionLedger, 'frontaliere', 2);
  assert.deepEqual(selected.map(({ articleId }) => articleId), ['actionable-1', 'actionable-2']);
});

test('ENTRAMBI gli scrittori consultano il pavimento prima di scrivere', () => {
  // La classe, non il singolo file: `translateFaq` (batch) e il ramo
  // `wrong` di `main()` (fix-faq-locales) potano con lo stesso
  // `filterWrongLocalePairs`, quindi devono avere lo stesso pavimento.
  for (const file of [BATCH, FIX]) {
    const src = fs.readFileSync(file, 'utf-8');
    assert.ok(
      /belowFaqFloor\(/.test(src),
      `${path.basename(file)} pota le coppie sbagliate ma non consulta belowFaqFloor: `
      + 'scriverebbe un set troncato che nessun rilevatore riaccoda',
    );
  }
});

test('il fix-faq rende osservabile il deficit e persiste il blocco di ritraduzione', () => {
  const src = fs.readFileSync(FIX, 'utf-8');
  assert.match(src, /reason: 'below_source_count'/);
  assert.match(src, /shouldSkipFaqRejection\(/);
  assert.match(src, /nextFaqRejection\(/);
  assert.match(src, /selectFaqIssuesForProcessing\(issues, rejectionLedger, SECTION, LIMIT\)/);
  assert.match(src, /repeatedRejectionSkips\+\+;\s*if \(!previousRejection\.prunedWrite\) failed\+\+;/s);

  const workflow = fs.readFileSync(path.join(QUI, '..', '..', '.github', 'workflows', 'batch-faq-articles.yml'), 'utf-8');
  assert.match(workflow, /data\/faq-locale-rejections\.json/);
  assert.match(workflow, /git status --porcelain=v1/);
  assert.match(workflow, /git add -f data\/faq-locale-rejections\.json/);
});

test('MIN_FAQ_PAIRS ha UNA sorgente sola', () => {
  const batchSrc = fs.readFileSync(BATCH, 'utf-8');
  assert.ok(
    !/^\s*const MIN_FAQ_PAIRS\s*=/m.test(batchSrc),
    'batch-add-faq-to-articles.mjs ridefinisce MIN_FAQ_PAIRS: due copie del minimo divergono, '
    + 'e il pavimento di scrittura resterebbe tarato su un numero diverso da quello del ramo IT',
  );
  assert.ok(
    /import \{[^}]*MIN_FAQ_PAIRS[^}]*\} from '\.\/fix-faq-locales\.mjs'/.test(batchSrc),
    'batch-add-faq-to-articles.mjs deve importare MIN_FAQ_PAIRS da fix-faq-locales.mjs',
  );
});
