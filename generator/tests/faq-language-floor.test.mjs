/**
 * faq-language-floor.test.mjs — il falso «lingua sbagliata» e il registro dei
 * rifiuti condiviso dai due scrittori FAQ.
 *
 * ## I DUE DIFETTI CHE QUESTO FILE PINNA
 *
 * Run 36297637209 di `batch-faq-articles.yml` (2026-09-27): Codex risponde
 * 20/20, ma 0/36 articoli riusciti con 43 × «traduzione rifiutata (lingua
 * sbagliata)», e gli stessi 36 articoli tornano ogni giorno.
 *
 * 1. Il ramo `lingua` di `wrongLocalePair` rifiutava sul solo rilevatore, che
 *    legge come italiano i nomi propri italiani conservati da una traduzione
 *    corretta. Sulle FAQ pubblicate: 88 rifiuti, 88 falsi. Le coppie qui sotto
 *    sono REALI, copiate dal corpus (i casi della run sono le stesse coppie).
 * 2. `batch-add-faq-to-articles.mjs` non consultava il registro dei rifiuti che
 *    `fix-faq-locales.mjs` gia' applica, quindi ritraduceva ogni giorno i locale
 *    parcheggiati.
 *
 * ## MUTAZIONI
 *
 * - Togliere `hasSourceLangFunctionWordSignal(...)` dal ramo `lingua`: i test
 *   «traduzione corretta» diventano rossi.
 * - Portare `SOURCE_LANG_MIN_FUNCTION_WORD_MARGIN` a 3: il test «italiano
 *   vero» sulla coppia corta del credito d'imposta diventa rosso.
 * - Togliere `partitionThrottledTranslations` da `main()` del batch: il test di
 *   cablaggio diventa rosso.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FAQ_REJECTION_MAX_CONSECUTIVE,
  faqLocaleIssueKey,
  functionWordMargin,
  nextFaqRejection,
  shouldSkipFaqRejection,
  wrongLocalePair,
} from '../scripts/fix-faq-locales.mjs';
import {
  partitionThrottledTranslations,
  recordFaqTranslationOutcome,
} from '../scripts/batch-add-faq-to-articles.mjs';
import { detectLanguageWithConfidence } from '../scripts/lib/detect-language.mjs';

const QUI = path.dirname(fileURLToPath(import.meta.url));
const BATCH_SRC = fs.readFileSync(path.join(QUI, '..', 'scripts', 'batch-add-faq-to-articles.mjs'), 'utf8');

// ── Fix 1: traduzioni corrette che il rilevatore diceva `it` ─────────────

// content/blog-body/de/arcidiacono-curia-lugano-2026.ts, coppia 3: e' il caso
// della run (DE rifiutato, «3:it/lingua»): confidenza 0,43, it 369 vs de 210.
const DE_ARCIDIACONO = {
  q: 'Wer hat Andrea Arcidiacono als Pressesprecher der Diözese Lugano ernannt?',
  a: 'Andrea Arcidiacono wurde vom Apostolischen Administrator Alain de Raemy ernannt.',
};
// La sorgente italiana della stessa coppia.
const IT_ARCIDIACONO = {
  q: 'Chi ha nominato Andrea Arcidiacono come addetto stampa della Curia vescovile di Lugano?',
  a: "Andrea Arcidiacono è stato nominato dall'amministratore apostolico Alain de Raemy.",
};

// I falsi a confidenza piu' alta: una soglia sulla sola confidenza del
// rilevatore li lascerebbe rifiutati (0,59 / 0,67 / 0,79).
const CORRECT_TRANSLATIONS = [
  ['de', DE_ARCIDIACONO],
  ['en', { q: 'Why can Italian motorists save on petrol?', a: 'Italy has extended the excise duty cut until 1 May 2026, which means that Italian motorists can continue to save on petrol.' }],
  ['en', { q: 'When does Villa Visconti Borromeo Litta reopen?', a: 'Villa Visconti Borromeo Litta officially reopens on May 1st, 2026.' }],
  ['en', { q: 'What are Italian taxes?', a: "Italian taxes are IRPEF 23% up to €28'000, 33% €28'001–50'000, 43% over €50'000." }],
  ['fr', { q: 'Quand le programme DaziT prendra-t-il fin ?', a: 'Le programme DaziT prendra fin le 31 décembre 2026.' }],
  ['fr', { q: 'Quand rouvre la Villa Visconti Borromeo Litta ?', a: 'La Villa Visconti Borromeo Litta rouvre officiellement le 1er mai 2026.' }],
];

test('premessa: il rilevatore dice davvero `it` su queste traduzioni corrette', () => {
  for (const [locale, pair] of CORRECT_TRANSLATIONS) {
    assert.equal(detectLanguageWithConfidence(`${pair.q} ${pair.a}`, locale).lang, 'it',
      `la premessa del test non vale piu' per ${locale}: ${pair.q}`);
  }
});

test('una traduzione corretta con nomi propri italiani NON e\' rifiutata come italiano', () => {
  for (const [locale, pair] of CORRECT_TRANSLATIONS) {
    assert.equal(wrongLocalePair([pair], locale), null, `${locale}: ${pair.q}`);
  }
  // Anche con la sorgente: il ramo verbatim non la tocca, non e' uguale.
  assert.equal(wrongLocalePair([DE_ARCIDIACONO], 'de', [IT_ARCIDIACONO]), null);
});

test('l\'italiano vero sotto un locale tradotto resta rifiutato', () => {
  const realItalian = [
    IT_ARCIDIACONO,
    // content/blog-body/it/operatore-socio-sanitario-frontaliere.ts: la coppia
    // italiana piu' corta e piu' povera di parole funzionali misurata.
    { q: "Come funziona il credito d'imposta?", a: "Il credito d'imposta evita la doppia imposizione." },
  ];
  for (const pair of realItalian) {
    for (const locale of ['en', 'de', 'fr']) {
      assert.deepEqual(wrongLocalePair([pair], locale), [{ index: 0, detected: 'it', via: 'lingua' }],
        `${locale}: ${pair.q}`);
    }
  }
});

test('le parole funzionali ambigue fra le due lingue non sono evidenza', () => {
  // `la`, `le`, `un`, `se` stanno sia in it sia in fr: nel confronto it/fr si scartano.
  assert.equal(functionWordMargin('la le un se', 'it', 'fr'), 0);
  // Contro l'inglese le stesse parole sono italiane.
  assert.equal(functionWordMargin('la le un se', 'it', 'en'), 4);
  assert.ok(functionWordMargin(DE_ARCIDIACONO.q + ' ' + DE_ARCIDIACONO.a, 'it', 'de') < 1);
  // Lingue senza lista: nessuna evidenza contraria, il ramo resta quello di prima.
  assert.equal(functionWordMargin('qualunque testo', 'it', 'es'), Infinity);
});

// ── Fix 2: il batch consulta e aggiorna lo stesso registro ──────────────

const SRC = [
  { q: 'Domanda uno della sorgente?', a: 'Risposta uno della sorgente, abbastanza lunga.' },
  { q: 'Domanda due della sorgente?', a: 'Risposta due della sorgente, abbastanza lunga.' },
  { q: 'Domanda tre della sorgente?', a: 'Risposta tre della sorgente, abbastanza lunga.' },
];
const SRC_CHANGED = [...SRC, { q: 'Domanda nuova?', a: 'Risposta nuova, abbastanza lunga.' }];
const REJECTED = { faq: null, rejected: true };

test('il batch registra ogni rifiuto e dopo N consecutivi il locale e\' parcheggiato', () => {
  const ledger = {};
  const key = faqLocaleIssueKey('art', 'de', 'frontaliere');
  for (let i = 1; i <= FAQ_REJECTION_MAX_CONSECUTIVE; i++) {
    assert.equal(recordFaqTranslationOutcome(ledger, key, SRC, REJECTED), true);
    assert.equal(ledger[key].consecutive, i);
  }
  assert.equal(shouldSkipFaqRejection(ledger[key], SRC), true);
  // Stesso formato di `fix-faq-locales.mjs`: la voce e' quella di nextFaqRejection.
  assert.deepEqual(ledger[key], nextFaqRejection(nextFaqRejection(undefined, SRC), SRC));
});

test('un fallimento del motore non e\' un rifiuto; una scrittura completa cancella la voce', () => {
  const key = faqLocaleIssueKey('art', 'en', 'frontaliere');
  const ledger = { [key]: nextFaqRejection(undefined, SRC) };
  const before = structuredClone(ledger);
  assert.equal(recordFaqTranslationOutcome(ledger, key, SRC, { faq: null, rejected: false }), false);
  assert.deepEqual(ledger, before);
  assert.equal(recordFaqTranslationOutcome(ledger, key, SRC, { faq: SRC, rejected: false }), true);
  assert.equal(key in ledger, false);
});

test('una scrittura potata sopra il pavimento e\' registrata come prunedWrite', () => {
  const ledger = {};
  const key = faqLocaleIssueKey('art', 'fr', 'frontaliere');
  assert.equal(recordFaqTranslationOutcome(ledger, key, SRC_CHANGED, { faq: SRC, rejected: false }), true);
  assert.equal(ledger[key].prunedWrite, true);
  assert.equal(ledger[key].keptPairs, SRC.length);
});

test('la coda di traduzione salta i locale parcheggiati sulla STESSA impronta della sorgente', () => {
  const parked = nextFaqRejection(nextFaqRejection(undefined, SRC), SRC);
  const ledger = {
    [faqLocaleIssueKey('a', 'de', 'frontaliere')]: parked,
    // Stessa storia, ma la sorgente italiana e' cambiata: si ritenta.
    [faqLocaleIssueKey('b', 'fr', 'frontaliere')]: parked,
    [faqLocaleIssueKey('c', 'en', 'frontaliere')]: parked,
    // Stessa chiave in un'altra sezione: non vale per questa.
    [faqLocaleIssueKey('d', 'de', 'svizzera')]: parked,
  };
  const queue = [
    { id: 'a', itFaq: SRC, missingLocales: ['de', 'en'] },
    { id: 'b', itFaq: SRC_CHANGED, missingLocales: ['fr'] },
    { id: 'c', itFaq: SRC, missingLocales: ['en'] },
    { id: 'd', itFaq: SRC, missingLocales: ['de'] },
  ];
  const { eligible, throttled } = partitionThrottledTranslations(queue, ledger, 'frontaliere');
  assert.deepEqual(eligible.map((a) => [a.id, a.missingLocales]), [['a', ['en']], ['b', ['fr']], ['d', ['de']]]);
  assert.deepEqual(throttled.map((i) => `${i.articleId}/${i.locale}`), ['a/de', 'c/en']);
  // Non muta la coda originale.
  assert.deepEqual(queue[0].missingLocales, ['de', 'en']);
});

test('cablaggio: main() filtra PRIMA del limite e i tre percorsi di traduzione registrano l\'esito', () => {
  const main = BATCH_SRC.slice(BATCH_SRC.indexOf('async function main('));
  const partition = main.indexOf('partitionThrottledTranslations(');
  const slice = main.indexOf('needsTranslation.slice(0, remaining)');
  assert.ok(partition > 0 && slice > partition, 'il filtro del registro deve precedere il --limit');
  assert.match(main, /loadFaqRejectionLedger\(\)/);
  for (const fn of ['processArticle', 'processTopUp', 'processTranslation']) {
    const start = BATCH_SRC.indexOf(`async function ${fn}(`);
    const end = BATCH_SRC.indexOf('\nasync function ', start + 1);
    assert.match(BATCH_SRC.slice(start, end), /recordTranslation\(options, articleId, locale,/, `${fn} non registra l'esito`);
  }
  // UNA sorgente per il registro: il batch non conosce il path del file.
  assert.doesNotMatch(BATCH_SRC, /faq-locale-rejections\.json/);
});
