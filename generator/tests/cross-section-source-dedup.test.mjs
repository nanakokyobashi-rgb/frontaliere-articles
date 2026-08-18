/**
 * cross-section-source-dedup.test.mjs — lo stesso materiale non può generare
 * due articoli nelle due sezioni (issue #251, residuo di #246).
 *
 * ## Il difetto, e cosa lo rendeva invisibile
 *
 * Dopo #246 il classificatore «frontaliere» accetta anche le statistiche
 * AGGREGATE Italia-Svizzera. Lo stesso dato passa pure il classificatore
 * nazionale, quindi la STESSA pagina di fonte poteva produrre un articolo in
 * entrambe le sezioni, pubblicati come contenuti distinti. Il ledger URL→id
 * esisteva già ma `loadSourceUrls()` apre `SECTION.sourceUrlsFile`, cioè un
 * file per sezione: il ramo esatto di `isSourceUrlAlreadyUsed` non poteva
 * vedere la sezione gemella, e l'unico ramo che le attraversava
 * (`url_slug_match`, Jaccard fra le parole dello slug della fonte e quelle
 * degli id) è un'euristica di TEMA che ha lasciato passare tutti e 5 i
 * duplicati reali.
 *
 * ## I tre strati, e perché servono tutti e tre
 *
 *  · **Comportamento** — `findCrossSectionSourceDuplicate` con ledger finti:
 *    dice cosa viene bloccato e, soprattutto, cosa NON viene bloccato.
 *  · **Cablaggio** — che `isSourceUrlAlreadyUsed` in `create-article.mjs` legga
 *    davvero tutti i ledger. Un dedup corretto che nessuno chiama è lo stesso
 *    difetto con un file in più.
 *  · **Ratchet sul registro PUBBLICATO** — quanti duplicati cross-sezione ci
 *    sono OGGI nei due ledger reali. Il gate impedisce che ne nascano di nuovi;
 *    questo strato dice se serve anche una bonifica, e va rosso al sesto.
 *
 * Il terzo strato è il motivo per cui il file gira anche nel preflight di
 * `publish-api.yml`: fino al 2026-08-18 `tests.yml` aveva
 * `branches-ignore: [main]` e gli articoli generati atterrano con un push diretto
 * su `main`, dove nessuna PR li guarda.
 *
 * ## La differenza che il gate deve rispettare
 *
 * Blocca la duplicazione del CONTENUTO (stesso documento di fonte), non la
 * copertura dello stesso TEMA. Una riforma AVS letta per chi vive in Svizzera e
 * letta per chi fa il frontaliere sono due pezzi legittimi: se vengono da due
 * URL diversi passano entrambi. È il test «due tagli sullo stesso tema da fonti
 * diverse» qui sotto a pinnare quella metà — senza, la fix giusta sarebbe
 * indistinguibile da un gate che spegne la sezione svizzera.
 *
 * Lancia con:
 *   node --test generator/tests/cross-section-source-dedup.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SIGNAL_CROSS_SECTION,
  SIGNAL_SAME_SECTION,
  findCrossSectionSourceDuplicate,
  listCrossSectionDuplicates,
} from '../scripts/lib/cross-section-dedup.mjs';

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

const AGGREGATE_STATS_URL = 'https://www.tio.ch/svizzera/economia/1943399/frontalieri-italia-svizzera-dati-ust';
const LEDGERS = {
  frontaliere: {
    'https://www.tio.ch/ticino/attualita/1941660/permesso-g-nuove-regole': 'permesso-g-nuove-regole-2026',
  },
  svizzera: {
    [AGGREGATE_STATS_URL]: 'dati-ust-frontalieri-italiani',
  },
};

// ── Strato 1: comportamento ──────────────────────────────────────────────────

test('la fonte già usata dalla sezione NAZIONALE blocca la generazione frontaliere', () => {
  const hit = findCrossSectionSourceDuplicate(AGGREGATE_STATS_URL, LEDGERS, 'frontaliere');
  assert.equal(hit.used, true);
  assert.equal(hit.articleId, 'dati-ust-frontalieri-italiani');
  assert.equal(hit.section, 'svizzera');
  assert.equal(hit.crossSection, true);
  assert.equal(hit.signal, SIGNAL_CROSS_SECTION);
});

test('e simmetricamente: la fonte già usata da frontaliere blocca la sezione nazionale', () => {
  const url = 'https://www.tio.ch/ticino/attualita/1941660/permesso-g-nuove-regole';
  const hit = findCrossSectionSourceDuplicate(url, LEDGERS, 'svizzera');
  assert.equal(hit.used, true);
  assert.equal(hit.section, 'frontaliere');
  assert.equal(hit.crossSection, true);
});

test('dentro la sezione attiva il segnale storico non cambia significato', () => {
  const hit = findCrossSectionSourceDuplicate(AGGREGATE_STATS_URL, LEDGERS, 'svizzera');
  assert.equal(hit.used, true);
  assert.equal(hit.section, 'svizzera');
  assert.equal(hit.crossSection, false);
  assert.equal(hit.signal, SIGNAL_SAME_SECTION);
});

test('IL CASO LEGITTIMO: stesso tema da due fonti diverse resta ammesso in entrambe le sezioni', () => {
  // Due URL diversi sulla stessa vicenda: sono due pezzi con tagli diversi, non
  // un duplicato di contenuto. Se questo test diventa rosso, la fix ha smesso
  // di distinguere «stesso materiale» da «stesso argomento».
  const altraFonte = 'https://www.rsi.ch/info/1943401/frontalieri-italia-svizzera-il-commento';
  assert.deepEqual(findCrossSectionSourceDuplicate(altraFonte, LEDGERS, 'frontaliere'), { used: false });
  assert.deepEqual(findCrossSectionSourceDuplicate(altraFonte, LEDGERS, 'svizzera'), { used: false });
});

test('un URL mai visto, un ledger vuoto o assente non bloccano niente', () => {
  assert.deepEqual(findCrossSectionSourceDuplicate('https://example.org/x', LEDGERS, 'frontaliere'), { used: false });
  assert.deepEqual(findCrossSectionSourceDuplicate('', LEDGERS, 'frontaliere'), { used: false });
  assert.deepEqual(
    findCrossSectionSourceDuplicate(AGGREGATE_STATS_URL, { frontaliere: {}, svizzera: null }, 'frontaliere'),
    { used: false },
  );
});

test('le chiavi ereditate da Object.prototype non passano per id di articolo', () => {
  for (const key of ['__proto__', 'constructor', 'toString']) {
    assert.deepEqual(
      findCrossSectionSourceDuplicate(key, { frontaliere: {}, svizzera: {} }, 'frontaliere'),
      { used: false },
      `"${key}" letto come voce del ledger`,
    );
  }
});

test('listCrossSectionDuplicates conta solo gli URL presenti in PIÙ sezioni', () => {
  const dups = listCrossSectionDuplicates({
    frontaliere: { 'https://a.ch/1': 'id-fr', 'https://b.ch/2': 'solo-fr' },
    svizzera: { 'https://a.ch/1': 'id-ch' },
  });
  assert.equal(dups.length, 1);
  assert.equal(dups[0].url, 'https://a.ch/1');
  assert.deepEqual(dups[0].sections.map((s) => s.section).sort(), ['frontaliere', 'svizzera']);
});

// ── Strato 2: cablaggio in create-article.mjs ────────────────────────────────

test('isSourceUrlAlreadyUsed interroga TUTTI i ledger, non solo quello della sezione attiva', () => {
  const fn = cutDecl('function isSourceUrlAlreadyUsed(headlineUrl) {');
  assert.match(fn, /findCrossSectionSourceDuplicate\(/, 'il ramo esatto non passa dal dedup cross-sezione');
  assert.match(fn, /loadAllSectionSourceUrls\(\)/, 'i ledger non vengono letti tutti');
  assert.ok(
    !/\bloadSourceUrls\(\)/.test(fn),
    'isSourceUrlAlreadyUsed è tornato a leggere il ledger della sola sezione attiva: è esattamente il difetto di #251',
  );
});

test('loadAllSectionSourceUrls itera le SEZIONI dichiarate, non due path scritti a mano', () => {
  const fn = cutDecl('function loadAllSectionSourceUrls() {');
  assert.match(fn, /ARTICLE_SECTION_CONFIGS/, 'i ledger non si derivano dalle sezioni dichiarate: una terza sezione resterebbe fuori in silenzio');
  assert.match(fn, /sourceUrlsFile/);
});

test('lo scarto cross-sezione è osservabile nel run report', () => {
  assert.match(src, /urlUsedOtherSection: 0/, 'contatore del run report rimosso: il caso torna invisibile');
  assert.match(src, /url_already_used_cross_section/, 'lo scarto cross-sezione non è più distinguibile nei campioni scartati');
});

// ── Strato 3 ─────────────────────────────────────────────────────────────────
// Il ratchet sul registro PUBBLICATO — quanti duplicati cross-sezione ci sono
// oggi nei due ledger reali — sta in `cross-section-duplicate-ratchet.test.mjs`,
// perché quello gira anche nel preflight di `publish-api.yml` (push diretto a
// main, dove `tests.yml` non gira) mentre i contratti sul SORGENTE qui sopra
// non devono girare lì: `create-article.mjs` non è fra i `paths` di quel
// workflow, quindi una sua modifica congelerebbe la superficie dati al primo
// push di contenuto successivo, per una ragione che col contenuto non c'entra.
