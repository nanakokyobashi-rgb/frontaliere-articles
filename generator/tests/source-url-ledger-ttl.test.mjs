/**
 * source-url-ledger-ttl.test.mjs — la finestra del ledger URL→id, e le due
 * cose che NON devono scadere.
 *
 * ## Cosa copre, e perché in questa forma
 *
 * Il ledger delle fonti era un cricchetto: `saveSourceUrls` dichiara una FIFO
 * da 500 voci ma non era ingaggiata (137/500 e 268/500 il 2026-08-18), e non
 * c'era alcun criterio temporale. Misurato lo stesso giorno sulle 49 fonti
 * `frontaliere`, scansione reale: 1.791 URL normalizzati visti, **45 già nel
 * ledger della propria sezione**, cioè bloccati per il solo fatto di essere
 * già stati usati.
 *
 * La fix fa scadere le voci della SOLA sezione attiva. Le tre cose che
 * possono romperla in silenzio, e che i test qui sotto tengono ferme:
 *
 *  1. **La migrazione.** I due file contengono stringhe nude. Leggerle come
 *     «senza data quindi vecchie» azzererebbe entrambi i ledger al primo
 *     deploy — un'unica run senza dedup su tutto il corpus.
 *  2. **Il ramo cross-sezione.** È la garanzia comprata dall'incidente #251
 *     (5 coppie duplicate reali) e non ha una rete equivalente a valle. Non
 *     scade mai, in nessuna forma.
 *  3. **L'ordine fra `SOURCE_URL_TTL_DAYS` e `MAX_ARTICLE_AGE_DAYS`.** È ciò
 *     che rende la scadenza incapace di riaprire un documento di fonte ancora
 *     fresco: se qualcuno abbassa il primo sotto il secondo, la proprietà
 *     sparisce senza che nulla fallisca.
 *
 * Esegui:
 *   node --test generator/tests/source-url-ledger-ttl.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SOURCE_URL_TTL_DAYS,
  isLedgerEntryExpired,
  ledgerArticleId,
  ledgerArticleIds,
  ledgerViewsForLookup,
  makeLedgerEntry,
  readLedgerEntry,
} from '../scripts/lib/source-url-ledger.mjs';
import { findCrossSectionSourceDuplicate, SIGNAL_CROSS_SECTION } from '../scripts/lib/cross-section-dedup.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const CREATE_ARTICLE = path.join(ROOT, 'generator/scripts/create-article.mjs');
const src = readFileSync(CREATE_ARTICLE, 'utf-8');

function cutDecl(startAnchor, from = src) {
  const a = from.indexOf(startAnchor);
  assert.notEqual(a, -1, `dichiarazione non trovata — aggiornare questo test: ${startAnchor}`);
  const rel = from.slice(a).indexOf('\n}\n');
  assert.notEqual(rel, -1, `chiusura non trovata per: ${startAnchor}`);
  return from.slice(a, a + rel + 3);
}

const NOW = Date.parse('2026-08-18T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const ago = (days) => new Date(NOW - days * DAY).toISOString();

// ── Strato 1: lettura delle due forme ────────────────────────────────────────

test('readLedgerEntry accetta la stringa storica e la voce datata', () => {
  assert.deepEqual(readLedgerEntry('permesso-g-2026'), { articleId: 'permesso-g-2026', ts: null });
  assert.deepEqual(
    readLedgerEntry({ articleId: 'permesso-g-2026', ts: ago(1) }),
    { articleId: 'permesso-g-2026', ts: ago(1) },
  );
  assert.equal(ledgerArticleId({ articleId: 'x-1', ts: ago(1) }), 'x-1');
  assert.equal(ledgerArticleId('x-1'), 'x-1');
});

test('readLedgerEntry rifiuta ciò che non porta un id, senza inventarne uno', () => {
  for (const v of [null, undefined, '', 0, 42, [], {}, { ts: ago(1) }, { articleId: '' }, { articleId: 7 }]) {
    assert.equal(readLedgerEntry(v), null, `valore accettato per sbaglio: ${JSON.stringify(v)}`);
    assert.equal(ledgerArticleId(v), '');
  }
});

test('makeLedgerEntry scrive SEMPRE un ts — è ciò che rende databile il ledger', () => {
  const e = makeLedgerEntry('nuovo-articolo', NOW);
  assert.equal(e.articleId, 'nuovo-articolo');
  assert.equal(e.ts, new Date(NOW).toISOString());
  assert.equal(isLedgerEntryExpired(e, { now: NOW }), false);
});

// ── Strato 2: la migrazione — un file di sole stringhe non scade ──────────────

test('un ledger di sole stringhe non perde NESSUNA voce, a qualunque finestra', () => {
  const storico = {
    'https://www.tio.ch/ticino/economia/1': 'articolo-uno',
    'https://www.rsi.ch/s/3936801': 'aumento-dei-frontalieri-attivi-in-svizzera',
    'https://www.laregione.ch/economia/2': 'articolo-tre',
  };
  for (const maxAgeDays of [1, 3, 5, 30, 90, 3650]) {
    assert.deepEqual(
      ledgerArticleIds(storico, { maxAgeDays, now: NOW }),
      storico,
      `finestra ${maxAgeDays}g: una voce senza ts è stata trattata come scaduta — al primo deploy il ledger si azzera in blocco`,
    );
  }
});

test('una voce senza ts è permanente anche quando il ts è illeggibile', () => {
  assert.equal(isLedgerEntryExpired('solo-id', { maxAgeDays: 1, now: NOW }), false);
  assert.equal(isLedgerEntryExpired({ articleId: 'x', ts: 'non-una-data' }, { maxAgeDays: 1, now: NOW }), false);
  assert.equal(isLedgerEntryExpired({ articleId: 'x', ts: '' }, { maxAgeDays: 1, now: NOW }), false);
});

// ── Strato 3: un file misto — scadono solo le voci datate e vecchie ───────────

const MISTO = {
  'https://www.tio.ch/ticino/economia/storica': 'senza-ts-permanente',
  'https://www.tio.ch/ticino/economia/fresca': { articleId: 'ts-di-un-giorno', ts: ago(1) },
  'https://www.tio.ch/ticino/economia/bordo': { articleId: 'ts-sul-bordo', ts: ago(SOURCE_URL_TTL_DAYS) },
  'https://www.tio.ch/ticino/economia/vecchia': { articleId: 'ts-vecchio', ts: ago(SOURCE_URL_TTL_DAYS + 1) },
};

test('in un ledger misto scadono SOLO le voci con ts oltre la finestra', () => {
  const vista = ledgerArticleIds(MISTO, { maxAgeDays: SOURCE_URL_TTL_DAYS, now: NOW });
  assert.deepEqual(Object.keys(vista).sort(), [
    'https://www.tio.ch/ticino/economia/bordo',
    'https://www.tio.ch/ticino/economia/fresca',
    'https://www.tio.ch/ticino/economia/storica',
  ]);
  // I valori restano STRINGHE: è la forma che cross-section-dedup.mjs legge.
  for (const v of Object.values(vista)) assert.equal(typeof v, 'string');
});

test('il bordo della finestra è inclusivo: esattamente N giorni blocca ancora', () => {
  const bordo = { articleId: 'x', ts: ago(SOURCE_URL_TTL_DAYS) };
  assert.equal(isLedgerEntryExpired(bordo, { maxAgeDays: SOURCE_URL_TTL_DAYS, now: NOW }), false);
  const oltre = { articleId: 'x', ts: ago(SOURCE_URL_TTL_DAYS + 0.01) };
  assert.equal(isLedgerEntryExpired(oltre, { maxAgeDays: SOURCE_URL_TTL_DAYS, now: NOW }), true);
});

test('senza finestra la vista è completa — è il default, e serve al ratchet', () => {
  assert.equal(Object.keys(ledgerArticleIds(MISTO)).length, 4);
});

test('una chiave pericolosa sopravvive alla vista invece di essere assorbita', () => {
  // `JSON.parse('{"__proto__": "x"}')` crea `__proto__` come proprietà PROPRIA,
  // quindi la mappa in ingresso può averla davvero; `out[url] = …` la
  // ingoierebbe in silenzio e la voce smetterebbe di bloccare.
  const map = JSON.parse('{"__proto__": "id-proto", "constructor": "id-ctor", "https://a.ch/1": "id-a"}');
  const vista = ledgerArticleIds(map);
  assert.deepEqual(Object.keys(vista).sort(), ['__proto__', 'constructor', 'https://a.ch/1']);
  assert.equal(Object.getOwnPropertyDescriptor(vista, '__proto__').value, 'id-proto');
  assert.equal(Object.getPrototypeOf(vista), Object.prototype, 'la vista non deve aver cambiato prototipo');
  const hit = findCrossSectionSourceDuplicate('__proto__', { frontaliere: vista }, 'frontaliere');
  assert.equal(hit.used, true);
  assert.equal(hit.articleId, 'id-proto');
});

// ── Strato 4: il ramo cross-sezione non scade MAI ────────────────────────────

const URL_CONDIVISO = 'https://www.tio.ch/svizzera/economia/1943399/aziende-settori-fallite-effetto-svizzera';

test('una voce scaduta nella sezione attiva resta bloccante dall’ALTRA sezione', () => {
  const ledgers = {
    frontaliere: { [URL_CONDIVISO]: { articleId: 'fallimenti-aziende-svizzera-1994', ts: ago(365) } },
    svizzera: { [URL_CONDIVISO]: { articleId: 'effetto-domino-fallite-aziende-svizzera', ts: ago(365) } },
  };
  const viste = ledgerViewsForLookup(ledgers, 'frontaliere', { maxAgeDays: SOURCE_URL_TTL_DAYS, now: NOW });
  assert.deepEqual(viste.frontaliere, {}, 'la sezione attiva doveva scadere');
  assert.deepEqual(
    viste.svizzera,
    { [URL_CONDIVISO]: 'effetto-domino-fallite-aziende-svizzera' },
    'la sezione sorella è scaduta: la garanzia cross-sezione di #251 sarebbe stata buttata con la finestra',
  );

  const hit = findCrossSectionSourceDuplicate(URL_CONDIVISO, viste, 'frontaliere');
  assert.equal(hit.used, true);
  assert.equal(hit.signal, SIGNAL_CROSS_SECTION);
  assert.equal(hit.section, 'svizzera');
});

test('la finestra si applica alla sola sezione attiva, qualunque sia', () => {
  const vecchia = { articleId: 'id-vecchio', ts: ago(SOURCE_URL_TTL_DAYS + 30) };
  const ledgers = {
    frontaliere: { 'https://a.ch/1': vecchia },
    svizzera: { 'https://b.ch/2': vecchia },
  };
  const daFrontaliere = ledgerViewsForLookup(ledgers, 'frontaliere', { now: NOW });
  assert.deepEqual(daFrontaliere.frontaliere, {});
  assert.deepEqual(daFrontaliere.svizzera, { 'https://b.ch/2': 'id-vecchio' });

  const daSvizzera = ledgerViewsForLookup(ledgers, 'svizzera', { now: NOW });
  assert.deepEqual(daSvizzera.svizzera, {});
  assert.deepEqual(daSvizzera.frontaliere, { 'https://a.ch/1': 'id-vecchio' });
});

test('una sezione senza corrispondenza nei ledger non fa sparire le altre', () => {
  const viste = ledgerViewsForLookup(
    { frontaliere: { 'https://a.ch/1': 'id-a' }, svizzera: null },
    'terza-sezione',
    { now: NOW },
  );
  assert.deepEqual(viste, { frontaliere: { 'https://a.ch/1': 'id-a' }, svizzera: {} });
});

// ── Strato 5: l’invariante coi giorni di freschezza ──────────────────────────

test('SOURCE_URL_TTL_DAYS resta STRETTAMENTE sopra MAX_ARTICLE_AGE_DAYS', () => {
  const m = src.match(/^const MAX_ARTICLE_AGE_DAYS = (\d+);/m);
  assert.ok(m, 'MAX_ARTICLE_AGE_DAYS non trovato in create-article.mjs — aggiornare questo test');
  const maxAge = Number(m[1]);
  assert.ok(
    SOURCE_URL_TTL_DAYS > maxAge,
    `SOURCE_URL_TTL_DAYS=${SOURCE_URL_TTL_DAYS} <= MAX_ARTICLE_AGE_DAYS=${maxAge}: la scadenza del ledger `
    + 'potrebbe riammettere una headline DATATA e ancora fresca, cioè riaprire un documento di fonte '
    + 'che ha già prodotto un articolo. Sopra quella soglia può riammettere solo headline undated.',
  );
});

test('la finestra resta sotto l’orizzonte della FIFO da 500 voci', () => {
  // ~9 registrazioni al giorno per sezione (48→137 dall’08-08 al 18-08 su
  // frontaliere): la FIFO sfratta da sola oltre i ~55 giorni. Una finestra più
  // larga di così non potrebbe mai eseguirsi — è il motivo per cui i 90 giorni
  // «per coerenza con TOPIC_COVERAGE_WINDOW_DAYS» sono stati scartati.
  const REGISTRAZIONI_AL_GIORNO = 9;
  const orizzonteFifo = 500 / REGISTRAZIONI_AL_GIORNO;
  assert.ok(
    SOURCE_URL_TTL_DAYS < orizzonteFifo,
    `SOURCE_URL_TTL_DAYS=${SOURCE_URL_TTL_DAYS} oltre l’orizzonte della FIFO (~${Math.round(orizzonteFifo)}g): `
    + 'la finestra sarebbe ombreggiata dal cap e non scadrebbe mai niente',
  );
});

// ── Strato 6: cablaggio in create-article.mjs ────────────────────────────────

test('isSourceUrlAlreadyUsed passa dalle viste, non dai ledger grezzi', () => {
  const fn = cutDecl('function isSourceUrlAlreadyUsed(headlineUrl) {');
  assert.match(fn, /ledgerViewsForLookup\(\s*loadAllSectionSourceUrls\(\)/, 'la finestra non è applicata: il ledger torna un cricchetto');
  assert.match(fn, /findCrossSectionSourceDuplicate\(/, 'il ramo esatto non passa più dal dedup cross-sezione');
});

test('recordSourceUrl scrive la voce datata, non la stringa nuda', () => {
  const fn = cutDecl('function recordSourceUrl(sourceUrl, articleId) {');
  assert.match(fn, /makeLedgerEntry\(articleId\)/, 'senza ts la voce nasce permanente e la finestra non morde mai');
  assert.ok(
    !/map\[normalized\]\s*=\s*articleId\s*;/.test(fn),
    'recordSourceUrl è tornato a scrivere la stringa nuda',
  );
});

test('saveSourceUrls NON pota le voci scadute dal file', () => {
  const fn = cutDecl('function saveSourceUrls(map) {');
  assert.ok(
    !/ledgerArticleIds|isLedgerEntryExpired|SOURCE_URL_TTL_DAYS/.test(fn),
    'la scadenza è finita in scrittura: il file è anche ciò che l’ALTRA sezione legge per il dedup '
    + 'cross-sezione, dove non c’è scadenza. Potarlo qui cancellerebbe la garanzia di #251.',
  );
});

test('cross-section-dedup.mjs resta ignaro della finestra', () => {
  // È `mode: identical` nel loop-sync-manifest: una modifica lì andrebbe
  // replicata sul sito. La fix è stata costruita per non toccarlo, e questo
  // test è ciò che impedisce di riavvicinarcisi per comodità.
  const dedup = readFileSync(path.join(ROOT, 'generator/scripts/lib/cross-section-dedup.mjs'), 'utf-8');
  assert.ok(
    !/source-url-ledger|SOURCE_URL_TTL_DAYS|\bts\b\s*[:.]/.test(dedup),
    'cross-section-dedup.mjs ha imparato la forma datata: è `mode: identical`, va replicato sul sito',
  );
});
