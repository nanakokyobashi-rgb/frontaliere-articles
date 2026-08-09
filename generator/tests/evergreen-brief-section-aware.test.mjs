/**
 * evergreen-brief-section-aware.test.mjs — issue #96, «la sezione SVIZZERA e' a secco».
 *
 * COSA PINNA, e perche' e' scritto cosi'.
 *
 * Il difetto: per un articolo evergreen il testo che il gate deterministico
 * `checkSourceFidelity` usa come FONTE e' il brief che il generatore ha appena
 * scritto (`pageContent`), e quel brief era `EVERGREEN_FACTS_BRIEF` —
 * interamente frontaliero — iniettato SENZA nessun branch di sezione.
 * Un evergreen della sezione `svizzera` doveva quindi ricitare meta' di 27
 * ancore su Accordo Frontalieri, IRPEF e Convenzione 1976 per non essere
 * bloccato. Misurato sui run reali: recall 0–30%, sei tentativi, poi uno
 * strike; a tre strike la keyword muore.
 *
 * Le due meta' del difetto sono INDIPENDENTI e vanno pinnate separatamente,
 * perche' riparare solo la prima non sblocca niente:
 *   1. quale brief riceve la sezione        → `evergreenFactsBriefFor`
 *   2. cosa finisce nel denominatore del gate → `stripInjectedBriefs`
 * Un brief svizzero produce comunque ~27 ancore svizzere: senza (2) la sezione
 * resta bloccata esattamente come prima, con numeri diversi. I test 5 e 6
 * esistono per rendere quella dipendenza impossibile da perdere in un refactor.
 *
 * Perche' estrae il blocco invece di importarlo: `create-article.mjs` importa
 * l'intero albero del generatore e questo repo non ha `node_modules` — la
 * stessa ragione per cui `blog-title-casing.test.mjs` e
 * `seo-clause-truncation.test.mjs` usano la stessa tecnica. Se i delimitatori
 * spariscono il test FALLISCE rumorosamente: non puo' passare a vuoto.
 *
 * Il gate vero (`checkSourceFidelity`) e' importato davvero, non simulato: e'
 * lui a decidere se un articolo passa, e un test che ne replicasse la logica
 * potrebbe restare verde mentre la produzione blocca.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractSourceAnchors, checkSourceFidelity } from '../scripts/lib/article-factuality-gates.mjs';
import { svizzeraEvergreenPool, clearStrikesForPool } from '../scripts/reset-evergreen-strikes.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CREATE_ARTICLE = path.resolve(HERE, '../scripts/create-article.mjs');

/**
 * Estrae e valuta il blocco puro: i due brief, l'array e le due funzioni.
 * Delimitatori ancorati alle dichiarazioni, come negli altri test del repo.
 */
function loadBriefBlock() {
  const src = readFileSync(CREATE_ARTICLE, 'utf-8');

  const start = src.indexOf('const EVERGREEN_FACTS_BRIEF = `');
  const endAnchor = '\n}\n';
  const fnStart = src.indexOf('export function stripInjectedBriefs(');
  assert.ok(
    start !== -1 && fnStart !== -1 && fnStart > start,
    'blocco evergreen-brief non trovato in create-article.mjs — aggiornare i delimitatori di questo test '
    + '(cercati: `const EVERGREEN_FACTS_BRIEF = \\``  e  `export function stripInjectedBriefs(`)',
  );
  const endRel = src.slice(fnStart).indexOf(endAnchor);
  assert.ok(endRel !== -1, 'fine di stripInjectedBriefs non trovata — aggiornare i delimitatori di questo test');
  const block = src.slice(start, fnStart + endRel + endAnchor.length);

  // `export` non e' valido dentro `new Function`: il blocco viene valutato come
  // corpo di funzione, non come modulo.
  const body = block.replace(/^export function /gm, 'function ');
  // eslint-disable-next-line no-new-func
  const factory = new Function(`${body}\nreturn { EVERGREEN_FACTS_BRIEF, EVERGREEN_FACTS_BRIEF_CH, EVERGREEN_FACTS_BRIEFS, evergreenFactsBriefFor, stripInjectedBriefs };`);
  return factory();
}

const B = loadBriefBlock();

// Marcatori inequivocabilmente frontalieri: se uno solo di questi compare nel
// ground truth di un articolo svizzero nazionale, l'articolo viene graduato
// contro un dominio che non e' il suo.
const MARCATORI_FRONTALIERI = [
  'Accordo Frontalieri',
  'IRPEF',
  'imposta alla fonte',
  '9 DICEMBRE 1976',
  'frontalieri',
  '7’500',
  '10’000',
];

test('il blocco si estrae e contiene entrambi i brief', () => {
  assert.equal(typeof B.EVERGREEN_FACTS_BRIEF, 'string');
  assert.equal(typeof B.EVERGREEN_FACTS_BRIEF_CH, 'string');
  assert.ok(B.EVERGREEN_FACTS_BRIEF.length > 500, 'il brief frontaliero e\' sospettosamente corto');
  assert.ok(B.EVERGREEN_FACTS_BRIEF_CH.length > 500, 'il brief svizzero e\' sospettosamente corto');
  assert.notEqual(B.EVERGREEN_FACTS_BRIEF, B.EVERGREEN_FACTS_BRIEF_CH);
  assert.deepEqual(B.EVERGREEN_FACTS_BRIEFS, [B.EVERGREEN_FACTS_BRIEF, B.EVERGREEN_FACTS_BRIEF_CH]);
});

test('IL TEST CENTRALE: la sezione svizzera NON riceve il brief frontaliero', () => {
  const brief = B.evergreenFactsBriefFor('svizzera');
  assert.notEqual(
    brief, B.EVERGREEN_FACTS_BRIEF,
    'la sezione svizzera sta ricevendo il brief frontaliero — e\' il difetto di #96',
  );
  assert.equal(brief, B.EVERGREEN_FACTS_BRIEF_CH);

  const trovati = MARCATORI_FRONTALIERI.filter((m) => brief.includes(m));
  assert.deepEqual(
    trovati, [],
    `il ground truth della sezione svizzera contiene marcatori frontalieri: ${trovati.join(', ')}`,
  );
});

test('la sezione frontaliere continua a ricevere il proprio brief (nessuna regressione)', () => {
  assert.equal(B.evergreenFactsBriefFor('frontaliere'), B.EVERGREEN_FACTS_BRIEF);
  // Default fail-safe: una sezione sconosciuta degrada al comportamento
  // storico, non consegna il ground truth svizzero a un articolo frontaliero.
  assert.equal(B.evergreenFactsBriefFor(undefined), B.EVERGREEN_FACTS_BRIEF);
  assert.equal(B.evergreenFactsBriefFor('sezione-che-non-esiste'), B.EVERGREEN_FACTS_BRIEF);
});

test('il brief svizzero e\' davvero nazionale: enti federali, nessun tema frontaliere', () => {
  const ch = B.EVERGREEN_FACTS_BRIEF_CH;
  for (const ente of ['AFC/ESTV', 'SEM', 'UFAS/BSV', 'UST/BFS', 'LAMal']) {
    assert.ok(ch.includes(ente), `il brief svizzero non nomina ${ente}`);
  }
});

// ── La seconda meta': il denominatore del gate ───────────────────────────

/** Riproduce `pageContent` come lo costruisce il ramo `evergreen://`. */
function evergreenPageContent(brief, keyword) {
  return `[ARTICOLO EVERGREEN SEO]\nKeyword target: ${keyword}\nAngolo editoriale: guida pratica\n\n`
    + `Genera un articolo approfondito e pratico ottimizzato per questa keyword long-tail.\n\n${brief}\n\n`
    + '⚠️ I FATTI VERIFICATI qui sopra DEVONO corrispondere ESATTAMENTE.';
}

test('un brief iniettato NON e\' il denominatore del gate di fedelta\'', () => {
  for (const [nome, brief] of [['frontaliere', B.EVERGREEN_FACTS_BRIEF], ['svizzera', B.EVERGREEN_FACTS_BRIEF_CH]]) {
    const grezzo = evergreenPageContent(brief, 'dichiarazione imposte svizzera canton Ginevra');
    const ripulito = B.stripInjectedBriefs(grezzo);

    const prima = extractSourceAnchors(grezzo).size;
    const dopo = extractSourceAnchors(ripulito).size;

    assert.ok(prima >= 3, `[${nome}] il brief grezzo dovrebbe portare abbastanza ancore da armare il gate (${prima})`);
    assert.ok(
      dopo < 3,
      `[${nome}] dopo lo strip restano ${dopo} ancore: il gate resta armato su un testo che il generatore ha scritto da se'`,
    );
  }
});

test('un articolo svizzero nazionale NON viene piu\' bloccato da source-fidelity-low', () => {
  // Corpo realistico: parla di imposte cantonali senza citare un solo fatto
  // frontaliero — che e' il comportamento CORRETTO per questa sezione.
  const articolo = `La dichiarazione d'imposta nel Canton Ginevra segue il calendario cantonale.
Il sistema fiscale svizzero e' articolato su tre livelli: imposta federale diretta, cantonale e comunale.
L'amministrazione cantonale delle contribuzioni gestisce l'imposta cantonale e comunale, mentre l'AFC/ESTV
amministra l'imposta federale diretta. Le deduzioni ammesse variano da cantone a cantone e comprendono
i contributi al terzo pilastro 3a, le spese professionali e i premi dell'assicurazione malattia.
Chi non rispetta la scadenza puo' chiedere una proroga all'autorita' fiscale cantonale.`;

  const pageContent = evergreenPageContent(B.EVERGREEN_FACTS_BRIEF_CH, 'dichiarazione imposte svizzera canton Ginevra');

  const prima = checkSourceFidelity(articolo, pageContent);
  assert.ok(
    prima.some((i) => i.code === 'source-fidelity-low'),
    'il fixture non riproduce il difetto: senza strip il gate dovrebbe bloccare',
  );

  const dopo = checkSourceFidelity(articolo, B.stripInjectedBriefs(pageContent));
  assert.deepEqual(
    dopo.filter((i) => i.code === 'source-fidelity-low'), [],
    'un articolo svizzero nazionale viene ancora bloccato per fedelta\' a una fonte che non esiste',
  );
});

test('su una fonte REALE lo strip e\' un no-op e il gate resta a piena forza', () => {
  // Una pagina di notizia non contiene il brief: il gate deve continuare a
  // bloccare un articolo che ne butta via i dati. E' la meta' che NON va persa.
  const fonte = `Il Consiglio federale ha approvato l'aumento dell'8,7% dei premi.
Secondo l'UST il 12,4% delle economie domestiche riceve un sussidio, mentre il 3,1% ha cambiato cassa.
La SECO ha confermato il dato il 5 marzo 2026, con un impatto stimato del 2,2% sul potere d'acquisto.`;
  assert.equal(B.stripInjectedBriefs(fonte), fonte, 'lo strip ha modificato una fonte reale');

  const svuotato = 'I premi dell\'assicurazione malattia aumenteranno. Le autorita\' hanno commentato la decisione.';
  const issues = checkSourceFidelity(svuotato, B.stripInjectedBriefs(fonte));
  assert.ok(
    issues.some((i) => i.code === 'source-fidelity-low'),
    'il gate non blocca piu\' un articolo che ha buttato via i dati di una fonte vera — lo strip e\' troppo aggressivo',
  );
});

test('stripInjectedBriefs regge gli input degeneri', () => {
  assert.equal(B.stripInjectedBriefs(''), '');
  assert.equal(B.stripInjectedBriefs(null), '');
  assert.equal(B.stripInjectedBriefs(undefined), '');
  assert.equal(B.stripInjectedBriefs(42), '');
  assert.equal(B.stripInjectedBriefs('testo', []), 'testo');
});

// ── Guard di cablaggio ──────────────────────────────────────────────────
//
// I test sopra provano che le funzioni sono corrette. Questo prova che sono
// CHIAMATE: e' la classe di difetto che ha causato #96 (il branch di sezione
// esisteva gia', 1500 righe piu' su, e il punto di iniezione non lo leggeva) e
// la stessa forma del difetto `SiteShellContract` — un contratto senza forma di
// import non lo copre nessun guard che segue gli import.
test('i punti di iniezione usano il selettore di sezione, non il brief nudo', () => {
  const src = readFileSync(CREATE_ARTICLE, 'utf-8');

  assert.equal(
    (src.match(/\$\{EVERGREEN_FACTS_BRIEF\}/g) || []).length, 0,
    'c\'e\' ancora un\'interpolazione diretta di ${EVERGREEN_FACTS_BRIEF}: quel punto ignora la sezione',
  );
  assert.ok(
    src.includes('${evergreenFactsBriefFor(SECTION_NAME)}'),
    'nessun punto di iniezione passa da evergreenFactsBriefFor(SECTION_NAME)',
  );
  // Ancorato al blocco di runFactualityGates, non a tutto il file: l'altra
  // chiamata con `sourceText` e' quella di buildSourceContract, che e' gia'
  // corretta perche' vive dietro `isSyntheticSource ? '' : ...` — ed e' proprio
  // il commento di QUELLA chiamata («the fidelity gate does not apply to
  // them») a dire cosa il codice intendeva fare. Delle due chiamate, una sola
  // implementava l'intento; #96 e' l'altra.
  const gateCall = src.indexOf('runFactualityGates({');
  assert.ok(gateCall !== -1, 'chiamata a runFactualityGates non trovata — aggiornare questo guard');
  const gateBlock = src.slice(gateCall, gateCall + 1200);
  assert.ok(
    gateBlock.includes('sourceText: stripInjectedBriefs(pageContent)'),
    'runFactualityGates riceve di nuovo pageContent nudo: il brief e\' tornato nel denominatore del gate di recall',
  );
  assert.equal(
    (gateBlock.match(/sourceText: pageContent\b/g) || []).length, 0,
    'runFactualityGates ha di nuovo una `sourceText: pageContent` non ripulita',
  );

  // L'altra meta' dell'intento, che deve restare vera.
  assert.ok(
    /const sourceContract = isSyntheticSource \? '' : buildSourceContract\(\{/.test(src),
    'buildSourceContract non e\' piu\' dietro la guardia isSyntheticSource',
  );
});

// ── L'amnistia sugli strike (reset-evergreen-strikes.mjs) ────────────────
//
// La fix sblocca la GENERAZIONE, ma non resuscita da sola le keyword che il
// difetto ha gia' ucciso: al 2026-08-09 erano 52 su 110, ritirate a
// EVERGREEN_STRIKE_LIMIT. Senza amnistia la sezione resterebbe a secco con il
// codice corretto — il pool e' vuoto per bookkeeping, non per generazione.

test('il pool svizzero si ricostruisce da create-article.mjs, non e\' riscritto altrove', () => {
  const src = readFileSync(CREATE_ARTICLE, 'utf-8');
  const pool = svizzeraEvergreenPool(src);
  // 110 e' il numero che il run reale stampa: «Pre-flight check su 110 keyword»
  // (run 31315163916, section=svizzera). Se le due liste cambiano questo numero
  // cambia con loro — l'asserzione e' sulla FORMA, non sul valore esatto.
  assert.ok(pool.length >= 100, `pool svizzero ricostruito con sole ${pool.length} keyword`);
  assert.ok(pool.every((k) => typeof k === 'string' && k.length > 0));
  assert.ok(pool.includes('affitti svizzera diritti inquilino disdetta'), 'manca una keyword della lista statica');
  assert.ok(
    pool.some((k) => /canton (Vaud|Ginevra|Zurigo)/.test(k)),
    'mancano le varianti cantonali generate da buildDynamicEvergreenTopicsSvizzera',
  );
  // Nessuna keyword frontaliere deve finire nel pool svizzero: sarebbe
  // un'amnistia fuori bersaglio.
  assert.deepEqual(pool.filter((k) => /frontalier/i.test(k)), []);
});

test('l\'amnistia tocca SOLO gli strike del pool svizzero, mai i ban', () => {
  const ledger = {
    keywords: ['dup svizzera nel pool', 'dup frontaliere fuori pool'],
    strikes: {
      'affitti svizzera diritti inquilino disdetta': 3,   // nel pool, ritirata → azzerare
      'permesso di soggiorno svizzera tipologie B C L': 2, // nel pool, non ancora morta → azzerare
      'frontaliere farmacista ticino stipendio requisiti': 3, // FUORI dal pool → intatta
      'dup svizzera nel pool': 1,
    },
  };
  const pool = ['affitti svizzera diritti inquilino disdetta', 'permesso di soggiorno svizzera tipologie B C L', 'dup svizzera nel pool'];
  const out = clearStrikesForPool(ledger, pool);

  assert.deepEqual(
    out.ledger.strikes, { 'frontaliere farmacista ticino stipendio requisiti': 3 },
    'l\'amnistia ha toccato strike fuori dal pool svizzero',
  );
  assert.deepEqual(
    out.ledger.keywords, ledger.keywords,
    'i ban permanenti sono stati modificati: un duplicato resta un duplicato',
  );
  assert.equal(out.cleared.length, 3);
  assert.equal(out.cleared.filter((c) => c.wasRetired).length, 1);
  assert.deepEqual(out.keptBanned, ['dup svizzera nel pool']);
});

test('clearStrikesForPool e\' pura: non muta il ledger che riceve', () => {
  const ledger = { keywords: ['a'], strikes: { x: 3 } };
  const copia = JSON.parse(JSON.stringify(ledger));
  clearStrikesForPool(ledger, ['x']);
  assert.deepEqual(ledger, copia, 'il ledger di input e\' stato mutato');
});
