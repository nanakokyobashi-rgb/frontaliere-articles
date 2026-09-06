/**
 * Osservatore di #5661 — «articoli sincronizzati con claim non verificati».
 *
 * ── COSA SORVEGLIA ─────────────────────────────────────────────────────────
 *
 * Che i body en/de/fr passino da `runFactualityGates()` PRIMA di essere
 * scritti su disco. Il gate esisteva gia' ed era deterministico: girava solo
 * su `data.content.it`. Misura del 2026-09-05 con
 * `audit-article-factuality.mjs` sugli 871 articoli aggiunti a `origin/main`
 * nei 14 giorni precedenti:
 *
 *     locale   flagged   con rilievo bloccante
 *     it          2,8%                       0
 *     en         45,6%                      59
 *     de         46,7%                      32
 *     fr         47,5%                      31
 *
 * 62 articoli su 871 (7,1%) usciti con almeno un rilievo bloccante, tutti e 62
 * SOLTANTO in en/de/fr. Il difetto non era la sensibilita' del gate: era che
 * nessuno gliele faceva vedere.
 *
 * ── PERCHE' NON E' UN GUARD SUL SORGENTE ───────────────────────────────────
 *
 * I test 1-3 girano il CODICE VERO: `assertTranslationsPassFactualityGates` e'
 * RITAGLIATA verbatim dal sorgente e istanziata con `new Function`, iniettando
 * le due dipendenze che legge dalla chiusura (`runFactualityGates`,
 * `formatIssues`) — quelle VERE, importate dalla libreria. Stessa tecnica di
 * body2-expected-fields.test.mjs e split-abort-strictness.test.mjs, ed e'
 * l'unica disponibile: create-article.mjs non e' importabile dalle gate del
 * generatore, che girano `node --test` senza `npm ci`.
 *
 * Il test 4 e' invece deliberatamente sul sorgente, e non e' ridondante: il
 * difetto di #5661 NON era una funzione sbagliata, era una funzione mai
 * chiamata. Un test di solo comportamento resterebbe verde anche se qualcuno
 * togliesse le due chiamate, cioe' proprio la regressione da sorvegliare.
 * Servono entrambe le meta': il comportamento e il collegamento.
 *
 * MUTAZIONI COPERTE (ognuna uccisa da un test):
 *   M1 il gate non blocca su un falso amico critico          → #1
 *   M2 il gate blocca un articolo pulito (falso positivo)    → #2
 *   M3 il kill switch non disarma                            → #3
 *   M4 la chiamata sparisce da uno dei due percorsi di
 *      scrittura (il difetto originale di #5661)             → #4
 *   M5 le sezioni tornano cablate a body1..body3, e il
 *      quarto corpo del Bollettino resta non giudicato (#980) → #5, #6, #7
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runFactualityGates, formatIssues } from '../scripts/lib/article-factuality-gates.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CREATE_ARTICLE = path.resolve(HERE, '../scripts/create-article.mjs');
const src = readFileSync(CREATE_ARTICLE, 'utf-8');

/** Ritaglia una `function <nome>(...)` verbatim, fino alla `}` in colonna 0. */
function cutFunction(nome, sentinelle) {
  const anchor = `function ${nome}(`;
  const a = src.indexOf(anchor);
  assert.notEqual(a, -1, `anchor non trovata — aggiornare questo test: ${anchor}`);
  const rel = src.slice(a).indexOf('\n}\n');
  assert.notEqual(rel, -1, `chiusura di ${nome} non trovata`);
  const block = src.slice(a, a + rel + 2);
  for (const s of sentinelle) {
    assert.ok(block.includes(s), `il ritaglio di ${nome} non contiene ${JSON.stringify(s)}: anchor sbagliata`);
  }
  return block;
}

const GATE_SRC = cutFunction('assertTranslationsPassFactualityGates', [
  'runFactualityGates',
  'collectBodySections',
  'qualityReject',
  'ARTICLE_TRANSLATION_GATE',
]);

// Il gate deriva le sezioni dalle chiavi `bodyN` presenti invece di elencarne
// tre (#980): il ritaglio va quindi accompagnato dal suo helper, altrimenti
// `new Function` istanzia un gate che non risolve `collectBodySections`.
const SECTIONS_SRC = cutFunction('collectBodySections', ['body\\d+', 'sections']);

/** Istanzia la funzione vera con le sue dipendenze di chiusura iniettate. */
function makeGate() {
  const factory = new Function(
    'runFactualityGates',
    'formatIssues',
    'console',
    `${SECTIONS_SRC}\n${GATE_SRC}\nreturn assertTranslationsPassFactualityGates;`,
  );
  // console silenziata: il gate stampa i rilievi, non deve sporcare l'output.
  return factory(runFactualityGates, formatIssues, { error: () => {} });
}

/**
 * Un articolo minimo. L'italiano nomina i «frontalieri»; la traduzione EN li
 * rende «border guards» — guardie di confine, un mestiere diverso. E' il claim
 * non ancorato che #5661 riporta letteralmente, ed e' `critical` e NON in
 * ITALIAN_ADJUDICATED_CODES, quindi non viene degradato a `major`.
 */
function articolo({ enBody1, itExtra = {}, enExtra = {} }) {
  return {
    content: {
      it: {
        ...itExtra,
        body1: 'I frontalieri che lavorano in Ticino pagano l\'imposta alla fonte. '
          + 'I frontalieri residenti nella fascia di 20 km hanno un regime dedicato.',
        body2: 'Il salario mediano dei frontalieri e\' di 5.000 franchi al mese.',
        body3: 'Per i frontalieri l\'accordo prevede una franchigia.',
      },
      en: {
        ...enExtra,
        body1: enBody1,
        body2: 'The median salary of cross-border commuters is 5.000 francs per month.',
        body3: 'For cross-border commuters the agreement provides an exemption.',
      },
    },
  };
}

const EN_PULITO = 'Cross-border commuters working in Ticino pay withholding tax. '
  + 'Cross-border commuters living within the 20 km band have a dedicated regime.';

const EN_NON_ANCORATO = 'Ticino border guards working in Ticino pay withholding tax. '
  + 'Border guards living within the 20 km band have a dedicated regime.';

test('#1 blocca un body tradotto con un claim non ancorato (falso amico critico)', () => {
  const gate = makeGate();
  let thrown = null;
  try {
    gate(articolo({ enBody1: EN_NON_ANCORATO }));
  } catch (e) {
    thrown = e;
  }
  assert.ok(thrown, 'il gate NON ha bloccato un claim non ancorato — #5661 e\' tornato');
  assert.equal(thrown.qualityReject, true, 'il rigetto deve essere di qualita\', non un errore infra');
  assert.match(thrown.message, /bloccanti nei body tradotti/);
});

test('#2 lascia passare una traduzione pulita (nessun falso positivo)', () => {
  const gate = makeGate();
  assert.doesNotThrow(() => gate(articolo({ enBody1: EN_PULITO })));
});

test('#3 ARTICLE_TRANSLATION_GATE=0 disarma il gate', () => {
  const gate = makeGate();
  const prev = process.env.ARTICLE_TRANSLATION_GATE;
  process.env.ARTICLE_TRANSLATION_GATE = '0';
  try {
    assert.doesNotThrow(() => gate(articolo({ enBody1: EN_NON_ANCORATO })));
  } finally {
    if (prev === undefined) delete process.env.ARTICLE_TRANSLATION_GATE;
    else process.env.ARTICLE_TRANSLATION_GATE = prev;
  }
});

test('#5 giudica anche `body4` — il quarto corpo del Bollettino non e\' esente', () => {
  const gate = makeGate();
  // Tre corpi puliti, il rilievo sta SOLO nel quarto: con le sezioni cablate a
  // body1..body3 questo articolo passava, in tutte e quattro le lingue.
  let thrown = null;
  try {
    gate(articolo({
      enBody1: EN_PULITO,
      itExtra: { body4: 'I frontalieri trovano in fondo il riepilogo dei valichi.' },
      enExtra: { body4: EN_NON_ANCORATO },
    }));
  } catch (e) {
    thrown = e;
  }
  assert.ok(thrown, 'il gate non ha guardato body4 — la sezione resta non giudicata (#980)');
  assert.equal(thrown.qualityReject, true);
});

test('#6 un articolo a quattro corpi pulito passa (nessun falso positivo sul nuovo corpo)', () => {
  const gate = makeGate();
  assert.doesNotThrow(() => gate(articolo({
    enBody1: EN_PULITO,
    itExtra: { body4: 'I frontalieri trovano in fondo il riepilogo dei valichi.' },
    enExtra: { body4: 'Cross-border commuters find the border-crossing summary at the end.' },
  })));
});

test('#7 le sezioni sono derivate dalle chiavi, non elencate', () => {
  const sections = new Function(`${SECTIONS_SRC}\nreturn collectBodySections;`)();
  assert.deepEqual(
    Object.keys(sections({ title: 't', body1: 'a', body10: 'j', body2: 'b', excerpt: 'e' })),
    ['body1', 'body2', 'body10'],
    'solo le chiavi bodyN, in ordine NUMERICO (body10 dopo body2, non prima)',
  );
  assert.deepEqual(sections(null), {});
  assert.deepEqual(sections({ body1: null, body2: 'b' }), { body2: 'b' }, 'i non-stringa non entrano');
});

test('#4 il gate e\' collegato a ENTRAMBI i percorsi di scrittura', () => {
  const chiamate = src.match(/^\s*assertTranslationsPassFactualityGates\(data\);/gm) || [];
  assert.ok(
    chiamate.length >= 2,
    'il gate deve essere chiamato sia nel flusso AI primario (Step 3a.2) sia in '
      + `registerArticleFiles() per i produttori secondari — trovate ${chiamate.length} chiamate. `
      + 'Questo E\' il difetto di #5661: il gate esisteva e non veniva invocato.',
  );

  // La chiamata condivisa deve stare DENTRO registerArticleFiles(), prima di
  // qualunque scrittura: e' l'unica via dei quattro produttori secondari.
  const reg = src.indexOf('export async function registerArticleFiles(');
  assert.notEqual(reg, -1, 'registerArticleFiles non trovata — aggiornare questo test');
  const corpo = src.slice(reg, reg + 4000);
  assert.ok(
    corpo.includes('assertTranslationsPassFactualityGates(data);'),
    'registerArticleFiles() non chiama il gate: daily-brief, events-digest, '
      + 'border-wait-ranking e journalist tornerebbero a scrivere body tradotti non giudicati',
  );
});
