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

import { runFactualityGates, formatIssues, detectTruncation } from '../scripts/lib/article-factuality-gates.mjs';
import { markBodyTranslationPending, isBodyTranslationPending } from '../scripts/lib/free-mt-recovery.mjs';

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
  'runArticleFactualityGates',
  'collectBodySections',
  'qualityReject',
]);

/** Ritaglia una costante `new Set([...])` usata dall'admission reale. */
function cutSet(nome) {
  const anchor = `const ${nome} = new Set([`;
  const a = src.indexOf(anchor);
  assert.notEqual(a, -1, `anchor non trovata — aggiornare questo test: ${anchor}`);
  const rel = src.slice(a).indexOf(']);');
  assert.notEqual(rel, -1, `chiusura di ${nome} non trovata`);
  return src.slice(a, a + rel + 3);
}

// Il gate deriva le sezioni dalle chiavi `bodyN` presenti invece di elencarne
// tre (#980): il ritaglio va quindi accompagnato dal suo helper, altrimenti
// `new Function` istanzia un gate che non risolve `collectBodySections`.
const SECTIONS_SRC = cutFunction('collectBodySections', ['body\\d+', 'sections']);
const BODY_FIELDS_SRC = cutFunction('bodyFieldNames', ['body\\d+', 'BODY_ONLY_FIELDS']);
const CONTENT_BODY_FIELDS_SRC = cutFunction('coerceContentBodyFields', ['coerceBodyFields', 'contentByLocale']);
const ADMISSION_SRC = cutFunction('runArticleFactualityGates', [
  'runFactualityGates',
  'DETERMINISTIC_BODY_HEURISTIC_CODES',
  'DETERMINISTIC_MAJOR_BLOCKING_CODES',
]);
const ADMISSION_CONSTANTS_SRC = [
  cutSet('DETERMINISTIC_BODY_HEURISTIC_CODES'),
  cutSet('DETERMINISTIC_MAJOR_BLOCKING_CODES'),
].join('\n');

/** Istanzia la funzione vera con le sue dipendenze di chiusura iniettate. */
function makeGate() {
  const factory = new Function(
    'runFactualityGates',
    'formatIssues',
    'isBodyTranslationPending',
    'console',
    `${SECTIONS_SRC}\n${ADMISSION_CONSTANTS_SRC}\n${ADMISSION_SRC}\n${GATE_SRC}\nreturn assertTranslationsPassFactualityGates;`,
  );
  // console silenziata: il gate stampa i rilievi, non deve sporcare l'output.
  return factory(
    runFactualityGates,
    formatIssues,
    isBodyTranslationPending,
    { error: () => {} },
  );
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
      // Il gate tratta un locale assente come un buco (vedi #9d): de e fr
      // portano la resa pulita, cosi' ogni caso giudica solo cio' che mette in en.
      de: tradottoPulito(itExtra),
      fr: tradottoPulito(itExtra),
    },
  };
}

function tradottoPulito(itExtra) {
  return {
    body1: EN_PULITO,
    body2: 'The median salary of cross-border commuters is 5.000 francs per month.',
    body3: 'For cross-border commuters the agreement provides an exemption.',
    ...(itExtra.body4 ? { body4: 'Cross-border commuters find the border-crossing summary at the end.' } : {}),
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

test('#3 ARTICLE_TRANSLATION_GATE=0 non disarma il gate fail-closed', () => {
  const gate = makeGate();
  const prev = process.env.ARTICLE_TRANSLATION_GATE;
  process.env.ARTICLE_TRANSLATION_GATE = '0';
  try {
    assert.throws(
      () => gate(articolo({ enBody1: EN_NON_ANCORATO })),
      (error) => error?.qualityReject === true && /bloccanti nei body tradotti/.test(error.message),
      'un valore ambientale non deve riaprire il percorso di pubblicazione',
    );
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

test('#980 il contratto base body1..body3 resta obbligatorio anche con bodyN dinamici', () => {
  const names = new Function('BODY_ONLY_FIELDS', `${BODY_FIELDS_SRC}\nreturn bodyFieldNames;`)(['body1', 'body2', 'body3']);
  assert.deepEqual(names({ body1: 'a', body4: 'd' }), ['body1', 'body2', 'body3', 'body4']);
  assert.deepEqual(names({ body1: 'a', body2: ['non', 'stringa'] }), ['body1', 'body2', 'body3']);
});

test('#980 i body non-stringa vengono coercizzati prima del set richiesto', () => {
  const coerce = new Function(
    'BODY_ONLY_FIELDS',
    `${BODY_FIELDS_SRC}\n${cutFunction('coerceBodyFields', ['bodyFieldNames'])}\nreturn coerceBodyFields;`,
  )(['body1', 'body2', 'body3']);
  const content = { body1: 'a', body2: ['b', 'c'], body4: 42 };
  coerce(content);
  assert.equal(content.body2, '["b","c"]');
  assert.equal(content.body4, '42');
});

test('#1261 i bodyN vengono coercizzati in ogni locale prima dei gate', () => {
  const coerce = new Function(
    'BODY_ONLY_FIELDS',
    `${BODY_FIELDS_SRC}\n${cutFunction('coerceBodyFields', ['bodyFieldNames'])}\n${CONTENT_BODY_FIELDS_SRC}\nreturn coerceContentBodyFields;`,
  )(['body1', 'body2', 'body3']);
  const content = {
    it: { body1: ['it', 'body'] },
    en: { body4: { translated: true } },
    de: { body2: 42 },
  };
  coerce(content);
  assert.equal(content.it.body1, '["it","body"]');
  assert.equal(content.en.body4, '{"translated":true}');
  assert.equal(content.de.body2, '42');
});

test('#1261 un produttore deterministico esenta solo euristiche di forma', () => {
  const factory = new Function(
    'runFactualityGates',
    `${ADMISSION_CONSTANTS_SRC}\n${ADMISSION_SRC}\nreturn runArticleFactualityGates;`,
  );
  const runGate = factory(() => ({
    issues: [
      { code: 'structured-major', severity: 'major', message: '[body1] frammento strutturato' },
      { code: 'unknown-institution', severity: 'major', message: 'sigla non verificata' },
      { code: 'tax-implausible', severity: 'major', message: 'importo atipico' },
      { code: 'incomplete-ending', severity: 'major', message: '[body2] frase troncata' },
      { code: 'leaked-prompt-scaffolding', severity: 'critical', message: '[en/body1] istruzione operativa' },
      { code: 'tax-exceeds-income', severity: 'major', message: '[en/body2] declassato dall\'italiano' },
      { code: 'translation-number-dropped', severity: 'major', message: '[en] numero perso' },
      { code: 'translation-number-added', severity: 'major', message: '[en] numero aggiunto' },
      { code: 'critical-fact', severity: 'critical', message: '[body1] fatto incoerente' },
    ],
    blocking: [],
    passed: false,
  }));
  // The translation-number emitters identify only the locale (`[en]`), so the
  // two named codes must remain blocking even without a `[en/bodyN]` label.
  const result = runGate({ locale: 'en', deterministicBodySections: ['body1'] });
  assert.deepEqual(result.blocking.map((issue) => issue.code), [
    'leaked-prompt-scaffolding',
    'translation-number-dropped',
    'translation-number-added',
    'critical-fact',
  ]);
  assert.equal(result.passed, false);
});

// ── #8 Traduzione ridotta a «...» ─────────────────────────────────────────
//
// `como-fai-giornate-autunno` (generato il 2026-10-03) e' uscito con de/body1,
// en/body1 e fr/body2/body3 uguali a '...' (piu', in coda, il blocco strumenti
// appeso dopo la traduzione). '...' finisce con un punto, quindi il controllo
// di punteggiatura lo lascia passare: serve il confronto con l'italiano
// (`translation-semantic-truncation`), che la copia gemella del sito aveva
// gia' e quella del corpus no — il gemello `identical` si era mosso sui due
// lati e il trasporto, che porta solo `site-ahead`, si era fermato.
const IT_LUNGO = {
  body1: 'Le Giornate FAI d\'autunno aprono a Como sabato e domenica una serie di luoghi '
    + 'normalmente chiusi al pubblico. Le visite sono guidate da volontari e apprendisti '
    + 'ciceroni delle scuole superiori, durano circa quaranta minuti e richiedono un '
    + 'contributo libero. Per i frontalieri che rientrano il venerdi\' sera e\' '
    + 'consigliata la prenotazione online, perche\' i posti nei gruppi sono limitati.',
  body2: 'Tra i luoghi aperti ci sono una villa sul lago, la biblioteca di un seminario '
    + 'e un rifugio antiaereo della seconda guerra mondiale. Chi arriva dal Ticino puo\' '
    + 'usare il treno regionale fino alla stazione di San Giovanni e proseguire a piedi '
    + 'verso il centro storico in meno di quindici minuti, evitando i parcheggi a '
    + 'pagamento del lungolago che nel fine settimana si riempiono presto.',
  body3: 'Gli orari variano da un sito all\'altro: in genere le visite iniziano alle dieci '
    + 'e terminano alle diciassette, con ultimo ingresso mezz\'ora prima della chiusura. '
    + 'In caso di pioggia alcuni percorsi all\'aperto vengono ridotti, mentre le visite '
    + 'agli interni restano confermate. Il programma completo e\' pubblicato sul sito '
    + 'della delegazione locale e aggiornato fino al giorno prima.',
};
const EN_LUNGO = {
  body1: 'The autumn FAI Days open a series of places in Como on Saturday and Sunday that '
    + 'are normally closed to the public. The tours are led by volunteers and apprentice '
    + 'guides from secondary schools, last about forty minutes and ask for a free '
    + 'donation. Cross-border commuters who return home on Friday evening are advised to '
    + 'book online, because places in each group are limited.',
  body2: 'The open sites include a lakeside villa, the library of a seminary and an air-raid '
    + 'shelter from the Second World War. Visitors coming from Ticino can take the '
    + 'regional train to San Giovanni station and walk to the old town in less than '
    + 'fifteen minutes, avoiding the paid car parks on the lakefront that fill up '
    + 'quickly at weekends.',
  body3: 'Opening times vary from site to site: tours usually start at ten and end at five, '
    + 'with last entry half an hour before closing. If it rains some outdoor routes are '
    + 'shortened, while the indoor tours remain confirmed. The full programme is published '
    + 'on the website of the local delegation and updated until the day before.',
};

test('#8 rigetta un body tradotto ridotto a «...» anche se finisce con un punto', () => {
  const gate = makeGate();
  const data = {
    content: {
      it: { ...IT_LUNGO },
      en: {
        ...EN_LUNGO,
        body1: '...',
        body2: '...\n\n## Recommended Tools\nFor a current estimate use the [net salary calculator](nav:calculator).',
      },
      de: { ...EN_LUNGO },
      fr: { ...EN_LUNGO },
    },
  };
  let thrown = null;
  try {
    gate(data);
  } catch (e) {
    thrown = e;
  }
  assert.ok(thrown, 'una traduzione «...» e\' passata dal gate di ammissione — il gemello senza detectSemanticTruncation e\' tornato');
  assert.equal(thrown.qualityReject, true, 'il rigetto deve essere di qualita\', non un errore infra');
  assert.match(thrown.message, /translation-semantic-truncation/);
  assert.match(thrown.message, /\[en\/body1\]/);
  assert.match(thrown.message, /\[en\/body2\]/);
});

test('#8b la stessa traduzione completa passa (il confronto non punisce una resa fedele)', () => {
  const gate = makeGate();
  assert.doesNotThrow(() => gate({ content: { it: { ...IT_LUNGO }, en: { ...EN_LUNGO }, de: { ...EN_LUNGO }, fr: { ...EN_LUNGO } } }));
});

// ── #9 Body in attesa: assenza autorizzata contro buco non dichiarato ──────
//
// `translation-section-missing` e' `critical`: senza distinguere, un body che
// `translateArticle()` ha lasciato NON tradotto col marker pending (la SPA
// ripiega sull'italiano, il recupero lo ritraduce) rigettava l'intero articolo,
// e un locale senza alcun body saltava il gate anche quando nessuno aveva
// dichiarato l'assenza.
function senzaBody(fields) {
  const data = { content: { it: { ...IT_LUNGO }, en: { ...EN_LUNGO }, de: { ...EN_LUNGO }, fr: { ...EN_LUNGO } } };
  for (const f of fields) delete data.content.en[f];
  return data;
}

test('#9 un body in attesa (marker pending) non fa rigettare l\'articolo', () => {
  const gate = makeGate();
  const data = { content: { it: { ...IT_LUNGO }, en: { ...EN_LUNGO }, de: { ...EN_LUNGO }, fr: { ...EN_LUNGO } } };
  markBodyTranslationPending(data, { locale: 'en', field: 'body2', reason: 'truncation-retry-unusable' });
  assert.equal(data.content.en.body2, undefined, 'il marker toglie il campo, come in translateArticle()');
  assert.doesNotThrow(() => gate(data));
});

test('#9b un body assente SENZA marker resta un buco bloccante', () => {
  const gate = makeGate();
  assert.throws(
    () => gate(senzaBody(['body2'])),
    (error) => error?.qualityReject === true && /translation-section-missing/.test(error.message),
  );
});

test('#9d un locale del tutto assente e\' un buco, non un locale da saltare', () => {
  const gate = makeGate();
  const data = { content: { it: { ...IT_LUNGO }, en: { ...EN_LUNGO }, de: { ...EN_LUNGO } } };
  assert.throws(
    () => gate(data),
    (error) => error?.qualityReject === true && /\[fr\/body1\] Sezione presente nell'italiano/.test(error.message),
    'senza data.content.fr il gate saltava il locale e l\'articolo arrivava alla scrittura',
  );
});

test('#9c un locale senza alcun body passa solo se ogni body e\' in attesa', () => {
  const gate = makeGate();
  assert.throws(
    () => gate(senzaBody(['body1', 'body2', 'body3'])),
    (error) => error?.qualityReject === true && /translation-section-missing/.test(error.message),
    'tre body spariti senza marker non possono saltare il gate',
  );
  const tuttiPending = { content: { it: { ...IT_LUNGO }, en: { ...EN_LUNGO }, de: { ...EN_LUNGO }, fr: { ...EN_LUNGO } } };
  for (const field of ['body1', 'body2', 'body3']) {
    markBodyTranslationPending(tuttiPending, { locale: 'en', field, reason: 'retry-error' });
  }
  assert.doesNotThrow(() => gate(tuttiPending));
});

// ── #10 Il troncamento semantico accende il retry della traduzione ─────────
//
// Il gate di ammissione blocca i soli `critical`: un body che conserva fra il
// 50% e la soglia delle parole italiane esce `major` e da li' passava. Il
// posto giusto per agire e' il retry di `translateArticle()`, che gia' ritraduce
// un body troncato e, se il retry fallisce, lo lascia in attesa invece di
// pubblicarlo: deve vedere anche il troncamento semantico.
test('#10 il retry di troncamento di translateArticle confronta con l\'italiano', () => {
  const start = src.indexOf('const truncationOpts = {');
  assert.notEqual(start, -1, 'il loop di retry non costruisce piu\' le opzioni condivise — aggiornare questo test');
  const loop = src.slice(start, src.indexOf('markBodyTranslationPending(data', start));
  assert.match(loop.split('\n')[0], /referenceText: itContent\[field\]/, 'il retry deve passare l\'italiano come riferimento');
  assert.match(loop.split('\n')[0], /\blocale\b/, 'senza locale il confronto si spegne (l\'italiano non si giudica)');
  assert.match(loop, /i\.rule === 'paragraph-drop'/, 'il retry non deve togliere un body solo accorpato (paragraph-drop)');
  const calls = loop.match(/detectTruncation\([^)]*\)/g) || [];
  assert.equal(calls.length, 2, 'rilevazione e verifica del retry: due chiamate');
  for (const call of calls) assert.match(call, /truncationOpts/, `${call} non usa il riferimento italiano`);

  // E il riferimento cambia davvero il verdetto: un body chiuso da un punto
  // ma con meta' delle parole e' pulito senza italiano, troncato con.
  const meta = EN_LUNGO.body1.split(' ').slice(0, 30).join(' ') + '.';
  assert.deepEqual(detectTruncation(meta, { label: 'en/body1' }), []);
  assert.ok(
    detectTruncation(meta, { label: 'en/body1', locale: 'en', referenceText: IT_LUNGO.body1 })
      .some((i) => i.code === 'translation-semantic-truncation'),
  );
});

test('#4 il gate e\' collegato a ENTRAMBI i percorsi di scrittura', () => {
  const chiamate = src.match(/^\s*assertArticlePassesFactualityGates\(data\);/gm) || [];
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
    corpo.includes('assertArticlePassesFactualityGates(data);'),
    'registerArticleFiles() non chiama il gate: daily-brief, events-digest, '
      + 'border-wait-ranking e journalist tornerebbero a scrivere body tradotti non giudicati',
  );
  assert.match(src, /collectBodySections\(data\.content\.it\)/, 'il gate italiano deve derivare tutti i bodyN');
  assert.match(src, /deterministicBodySections/, 'il gate deve distinguere il body deterministico dalle euristiche LLM');
});
