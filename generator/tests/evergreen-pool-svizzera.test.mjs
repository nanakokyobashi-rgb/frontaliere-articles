/**
 * evergreen-pool-svizzera.test.mjs — il pool evergreen nazionale non deve
 * ne' restringersi ne' ri-derivare il dominio frontaliere.
 *
 * ## Il difetto misurato (2026-08-10)
 *
 * La sezione `svizzera` non produceva piu' NIENTE. Ogni run scheduled durava
 * ~50 secondi e finiva cosi' (run 31402855968, 31403653098, 31404256910,
 * 31405881104 — identici):
 *
 *   📚 Fase 2: Fallback evergreen — generazione articolo SEO long-tail...
 *      Pre-flight check su 110 keyword...
 *   ⚠️  Tutte le keyword evergreen risultano gia' coperte dal pre-flight.
 *
 * 110 keyword contro le 537 del lato frontaliere, che ha in piu'
 * `buildStructuralEvergreenTopics()`. Di quelle 110, 90 erano gia' nel ledger
 * come duplicato confermato. E il pool NON poteva crescere da solo: 8 cantoni
 * su 26, nessuna dimensione combinatoria. La saturazione era inevitabile.
 *
 * Costava il doppio di quanto sembra: 2 dei 4 slot cron orari di
 * `generate-article.yml` sono `svizzera`, quindi erano no-op garantiti, e la
 * catena self-trigger — che alterna sezione a ogni anello — moriva su ogni
 * anello svizzero, perche' un run senza articolo non tocca `content/`.
 *
 * ## Cosa pinna questo file, e perche' proprio queste cose
 *
 * Non la dimensione per se': un pool grande scritto male e' esattamente il
 * pool vecchio con piu' righe. Le quattro proprieta' che lo tengono VIVO:
 *
 *  1. la taglia, confrontata con il pool frontaliere ricostruito qui e non con
 *     un numero copiato a mano — cosi' se qualcuno riduce le liste dall'altro
 *     lato il confronto si muove da solo;
 *  2. nessun token Ticino/frontaliere: e' l'errore corretto il 2026-07-21 e
 *     riderivabile per via combinatoria (un `canton Ticino` nel pool nazionale
 *     e' l'altro lato dello stesso sbaglio);
 *  3. nessun candidato in una famiglia SATURA di `evergreenTopicFamily`: quelle
 *     sei famiglie fanno dichiarare duplicato contro QUALUNQUE articolo
 *     esistente, senza soglia. Un pool da 500 keyword tutte in famiglia satura
 *     e' un pool da zero, e nessun conteggio lo direbbe;
 *  4. nessun anno interpolato: il ledger e' indicizzato sulla stringa letterale
 *     della keyword, quindi il 1° gennaio ban e strike diventerebbero
 *     irraggiungibili e il run ripagherebbe un ciclo LLM per riscoprirli.
 *
 * ## Perche' estrae i blocchi invece di importarli
 *
 * `create-article.mjs` importa l'intero albero del generatore, e la meta'
 * frontaliere del pool passa da `data/municipalities.ts` — un import TypeScript
 * che `node --test` non risolve (il repo non ha `node_modules`; il workflow usa
 * `tsx`). Stessa tecnica di `blog-title-casing.test.mjs`,
 * `seo-clause-truncation.test.mjs` e `reset-evergreen-strikes.mjs`. I
 * delimitatori sono ancorati alle dichiarazioni: se spariscono il test
 * FALLISCE, non passa a vuoto.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { tokenizeIt, normalizeItWord } from '../scripts/lib/it-text-similarity.mjs';
import { filterDistinctive } from '../scripts/lib/dup-stoplist.mjs';
import { svizzeraEvergreenPool } from '../scripts/reset-evergreen-strikes.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const CREATE_ARTICLE = path.join(ROOT, 'generator/scripts/create-article.mjs');
const CANTON_SLUGS = path.join(ROOT, 'generator/data/canton-url-slugs.json');

const SRC = readFileSync(CREATE_ARTICLE, 'utf-8');

/** Blocco letterale di `SRC`, dall'inizio ancorato al terminatore dato. */
function block(startNeedle, endNeedle) {
  const a = SRC.indexOf(startNeedle);
  assert.notEqual(a, -1, `delimitatore non trovato in create-article.mjs: ${startNeedle}`);
  const b = SRC.indexOf(endNeedle, a);
  assert.notEqual(b, -1, `fine del blocco non trovata per: ${startNeedle}`);
  return SRC.slice(a, b + endNeedle.length);
}

/** Le tre liste della sezione svizzera, valutate in sandbox. */
const SVI = new Function(
  `${block('const PRIORITY_EVERGREEN_TOPICS_SVIZZERA = [', '\n];\n')}\n`
  + `${block('function buildDynamicEvergreenTopicsSvizzera() {', '\n}\n')}\n`
  + `${block('function buildStructuralEvergreenTopicsSvizzera() {', '\n}\n')}\n`
  + 'return {'
  + ' statiche: PRIORITY_EVERGREEN_TOPICS_SVIZZERA,'
  + ' dinamiche: buildDynamicEvergreenTopicsSvizzera(),'
  + ' strutturali: buildStructuralEvergreenTopicsSvizzera(),'
  + '};',
)();

/**
 * La parte del pool frontaliere che si puo' ricostruire senza TypeScript: le
 * due liste scritte in `create-article.mjs`. La terza — il pool strutturale di
 * `evergreen-topic-generator.mjs` — vale 310 candidati (misurati con `tsx`:
 * 140 mestiere + 170 comune) e non e' caricabile qui, quindi il confronto sotto
 * e' DELIBERATAMENTE conservativo: il pool svizzero deve battere questa soglia
 * bassa con margine, e il floor assoluto separato copre il resto.
 */
const FRO = new Function(
  `${block('const PRIORITY_EVERGREEN_TOPICS = [', '\n];\n')}\n`
  + `${block('function buildDynamicEvergreenTopics() {', '\n}\n')}\n`
  + 'return { statiche: PRIORITY_EVERGREEN_TOPICS, dinamiche: buildDynamicEvergreenTopics() };',
)();

/** `evergreenTopicFamily` vera, non riscritta: e' lei a decidere in produzione. */
const evergreenTopicFamily = new Function(
  'tokenizeIt', 'normalizeItWord',
  `${block('function evergreenTopicFamily(text) {', '\n}\n')}\nreturn evergreenTopicFamily;`,
)(tokenizeIt, normalizeItWord);

/** Anche SATURATED_FAMILIES si legge dal sorgente: una copia qui potrebbe drift-are. */
const SATURATED_FAMILIES = new Function(
  `${block('const SATURATED_FAMILIES = new Set([', ']);')}\nreturn SATURATED_FAMILIES;`,
)();

const tuttoIlPool = [...SVI.statiche, ...SVI.dinamiche, ...SVI.strutturali];

// ── 1. Taglia ────────────────────────────────────────────────────────────

test('il pool svizzero non e\' piu\' un decimo di quello frontaliere', () => {
  const frontaliereRicostruibile = FRO.statiche.length + FRO.dinamiche.length;
  assert.ok(
    tuttoIlPool.length > frontaliereRicostruibile,
    `pool svizzero ${tuttoIlPool.length} vs parte frontaliere ricostruibile ${frontaliereRicostruibile}`,
  );
  // Floor assoluto. 610 e' il valore misurato il 2026-08-10 (20 + 90 + 500)
  // contro i 537 del pool frontaliere COMPLETO (122 + 105 + 310, misurato con
  // `tsx`): stesso ordine di grandezza, che e' il punto. La soglia sta sotto
  // per lasciare spazio a una riformulazione, non a un dimezzamento.
  assert.ok(tuttoIlPool.length >= 500, `pool svizzero sceso a ${tuttoIlPool.length} keyword`);
  // Il difetto in forma di numero: 110 era il pool che non produceva niente.
  assert.ok(tuttoIlPool.length >= 110 * 4, `pool svizzero a ${tuttoIlPool.length}: siamo tornati vicino alle 110 di #96`);
});

test('il pool strutturale nazionale e\' 20 pilastri × 25 cantoni, senza collisioni', () => {
  assert.equal(SVI.strutturali.length, 500);
  assert.equal(new Set(SVI.strutturali.map((t) => t.keyword)).size, 500, 'due pilastri generano la stessa keyword');
  for (const t of SVI.strutturali) {
    assert.equal(typeof t.keyword, 'string');
    assert.equal(typeof t.angle, 'string');
    assert.ok(t.keyword.length > 10, `keyword sospettosamente corta: "${t.keyword}"`);
    assert.ok(t.angle.length > 60, `angolo sospettosamente corto per "${t.keyword}"`);
    // Un `%c`/`%C` rimasto significa un pilastro che non ha ricevuto il cantone:
    // sarebbe una keyword identica per tutti e 25, cioe' 24 duplicati garantiti.
    assert.ok(!/%[cC]/.test(`${t.keyword} ${t.angle}`), `placeholder non sostituito in "${t.keyword}"`);
  }
});

test('l\'intero pool svizzero e\' senza duplicati', () => {
  const keywords = tuttoIlPool.map((t) => t.keyword);
  assert.equal(new Set(keywords).size, keywords.length, 'due liste della sezione svizzera producono la stessa keyword');
});

// ── 2. Niente dominio frontaliere ────────────────────────────────────────

test('nessuna KEYWORD del pool nazionale nomina Ticino o frontalieri', () => {
  // Sulla keyword vale per tutte e tre le liste: e' la keyword a diventare
  // titolo, slug e chiave del ledger, quindi e' li' che un token dell'altro
  // dominio produce un articolo nella sezione sbagliata.
  const sporche = tuttoIlPool.filter((t) => /frontalier|ticin/i.test(t.keyword)).map((t) => t.keyword);
  assert.deepEqual(
    sporche, [],
    'il pool nazionale ri-deriva angoli Ticino/frontaliere — e\' l\'errore corretto il 2026-07-21',
  );
});

test('il pool strutturale non nomina Ticino o frontalieri nemmeno nell\'angolo', () => {
  // Piu' stretto, e solo sulla lista generata: l'angolo entra nel prompt E nel
  // testo su cui `evergreenTopicFamily` classifica, quindi un `ticino` li'
  // dentro sposta il pezzo verso il dominio dell'altra sezione senza che la
  // keyword lo dica. La regola NON si estende alle due liste scritte a mano:
  // `costo della vita per cantone svizzera` cita il Ticino come uno dei
  // cantoni messi a confronto, che e' un uso nazionale legittimo.
  const sporche = SVI.strutturali
    .filter((t) => /frontalier|ticin/i.test(t.angle))
    .map((t) => t.keyword);
  assert.deepEqual(sporche, []);
});

test('i 25 cantoni sono quelli ufficiali meno il Ticino', () => {
  const slugs = JSON.parse(readFileSync(CANTON_SLUGS, 'utf-8'));
  // La tabella degli slug fonde i semicantoni in due gruppi URL (APPENZELLO,
  // BASILEA); qui servono i codici REALI, perche' AI/AR e BL/BS hanno leggi
  // fiscali e premi distinti e meritano keyword distinte.
  const gruppi = slugs.cantonGroups || {};
  const ufficiali = new Set();
  for (const code of Object.keys(slugs.cantons)) {
    if (gruppi[code]) for (const m of gruppi[code].members) ufficiali.add(m);
    else ufficiali.add(code);
  }
  assert.equal(ufficiali.size, 26, `la tabella degli slug non descrive 26 cantoni ma ${ufficiali.size}`);
  ufficiali.delete('TI');

  // I nomi si leggono dal blocco CANTONI del builder: e' quello a decidere
  // quante keyword esistono, e una riga cancellata restringerebbe il pool del 4%
  // senza che nulla lo dica.
  const codici = [...block('  const CANTONI = [', '\n  ];\n').matchAll(/code:\s*'([A-Z]{2})'/g)].map((m) => m[1]);
  assert.deepEqual(
    [...codici].sort(), [...ufficiali].sort(),
    'la lista CANTONI non copre esattamente i 26 cantoni meno il Ticino',
  );
});

// ── 3. Famiglie sature: il difetto che nessun conteggio vedrebbe ─────────

test('nessun candidato nazionale cade in una famiglia SATURA del pre-flight', () => {
  // Sanity: se l'estrazione di SATURATED_FAMILIES fallisse in silenzio questo
  // test passerebbe sempre. Il set di produzione ne contiene sei.
  assert.ok(SATURATED_FAMILIES instanceof Set);
  assert.ok(SATURATED_FAMILIES.size >= 5, `SATURATED_FAMILIES estratto con sole ${SATURATED_FAMILIES.size} voci`);
  assert.ok(SATURATED_FAMILIES.has('permesso-g-b'));

  const caduti = SVI.strutturali
    .map((t) => [t.keyword, evergreenTopicFamily(`${t.keyword} ${t.angle}`)])
    .filter(([, fam]) => fam && SATURATED_FAMILIES.has(fam));
  assert.deepEqual(
    caduti, [],
    'un pilastro nazionale cade in una famiglia satura: il pre-flight lo dichiara duplicato '
    + 'contro qualunque articolo esistente, senza soglia — quelle keyword sono morte all\'origine',
  );
});

// ── 4. L'anno: il pool non si deve «riaprire» il 1° gennaio ──────────────

test('il pool strutturale nazionale non interpola l\'anno', () => {
  const datate = SVI.strutturali.filter((t) => /\b(19|20)\d{2}\b/.test(t.keyword)).map((t) => t.keyword);
  assert.deepEqual(
    datate, [],
    'una keyword nazionale porta un anno: il ledger e\' indicizzato sulla stringa letterale, '
    + 'quindi a gennaio ban e strike diventano irraggiungibili e il run li riscopre a spese di un ciclo LLM',
  );
});

test('l\'anno e\' strutturale per QUALUNQUE anno, non solo 2025/2026', () => {
  // Le liste dinamiche (entrambe le sezioni) interpolano `getFullYear()`. La
  // stoplist letterale di `evergreenAngleTokens` copriva solo 2025 e 2026: dal
  // 2027 l'anno sarebbe tornato un token DISTINTIVO, abbassando la
  // sovrapposizione di famiglia e riaprendo centinaia di near-duplicate.
  const tokens = new Function(
    'tokenizeIt', 'normalizeItWord', 'filterDistinctive',
    `${block('function evergreenAngleTokens(text) {', '\n}\n')}\nreturn evergreenAngleTokens;`,
  )(tokenizeIt, normalizeItWord, filterDistinctive);
  for (const anno of ['2024', '2025', '2026', '2027', '2031']) {
    assert.ok(
      !tokens(`dichiarazione imposte ${anno} scadenze`).includes(anno),
      `l'anno ${anno} e' finito nei token distintivi: la stoplist e' di nuovo un elenco letterale`,
    );
  }
});

// ── 5. L'amnistia deve vedere il pool intero ─────────────────────────────

test('reset-evergreen-strikes ricostruisce il pool COMPLETO, non solo le liste vecchie', () => {
  const pool = svizzeraEvergreenPool(SRC);
  assert.equal(pool.length, tuttoIlPool.length, 'l\'amnistia ricostruisce un pool diverso da quello che il generatore usa');
  // Una keyword per lista: se il builder strutturale uscisse dai delimitatori
  // dell'amnistia, questa sarebbe l'unica delle tre a sparire — e l'amnistia
  // diventerebbe una no-op sull'82% del pool senza fallire.
  assert.ok(pool.includes('affitti svizzera diritti inquilino disdetta'), 'manca la lista statica');
  assert.ok(pool.some((k) => /canton (Vaud|Ginevra|Zurigo)/.test(k)), 'manca la lista dinamica');
  assert.ok(pool.includes('naturalizzazione canton Giura requisiti e procedura'), 'manca il pool strutturale nazionale');
});

// ── 6. Cablaggio: il builder deve essere DAVVERO nel pool del run ────────
//
// Stessa classe di difetto di #96 e di `SiteShellContract`: una funzione
// corretta che nessuno chiama passa ogni test sulla funzione.

test('il ramo `svizzera` di topicPool usa il builder strutturale nazionale', () => {
  const at = SRC.indexOf('const topicPool = IS_FRONTALIERE');
  assert.notEqual(at, -1, 'assegnazione di topicPool non trovata — aggiornare questo guard');
  const blocco = SRC.slice(at, SRC.indexOf('const weekNum', at));
  assert.ok(
    blocco.includes('buildStructuralEvergreenTopicsSvizzera()'),
    'il ramo svizzera non spreme il pool strutturale nazionale: la sezione torna a 110 keyword',
  );
  // E il pool frontaliere non deve ereditare quello nazionale (ne' viceversa):
  // sono due domini, e mescolarli e' il difetto del 2026-07-21 al contrario.
  const ramoFrontaliere = blocco.slice(blocco.indexOf('?'), blocco.indexOf(': ['));
  assert.ok(
    !ramoFrontaliere.includes('Svizzera'),
    'il ramo frontaliere pesca dal pool nazionale',
  );
});

// ── 7. Telemetria della saturazione ──────────────────────────────────────
//
// Il pool piu' grande sposta la data della prossima saturazione, non la
// elimina. Cio' che mancava davvero e' che la saturazione fosse VISIBILE: oggi
// produce un run da 50 secondi che esce `success` e un summary che dice
// `Generated: true`. Queste righe sono il segnale su cui si costruisce il
// watchdog, sul modello di PRESPEND_GATE_*.

test('la saturazione del pool emette una riga machine-readable', () => {
  const emit = SRC.indexOf('function reportEvergreenPoolSaturation(');
  assert.notEqual(emit, -1, 'reportEvergreenPoolSaturation non esiste piu\'');
  const corpo = SRC.slice(emit, SRC.indexOf('\n}\n', emit));
  for (const campo of [
    'EVERGREEN_POOL_SATURATED', 'section=', 'stage=', 'pool=', 'checked=',
    'skipped_banned=', 'skipped_struck=', 'skipped_topic_coverage=',
    'skipped_title_jaccard=', 'skipped_family=',
  ]) {
    assert.ok(corpo.includes(campo), `la riga di saturazione non porta \`${campo}\``);
  }

  // Chiamata da ENTRAMBE le uscite per saturazione: il pre-flight che non
  // seleziona niente, e il retry che esaurisce le keyword sicure. Coprirne una
  // sola lascia meta' dei run muti, che e' come stavamo prima.
  const chiamate = (SRC.match(/reportEvergreenPoolSaturation\('(preflight|retry)'\)/g) || []).sort();
  assert.deepEqual(chiamate, ["reportEvergreenPoolSaturation('preflight')", "reportEvergreenPoolSaturation('retry')"]);
});

test('ogni run che arriva alla Fase 2 emette il proprio denominatore', () => {
  // Senza questa riga, `EVERGREEN_POOL_SATURATED` non distingue un caso isolato
  // dallo stato stabile della sezione — che e' esattamente cio' che e' successo:
  // 4 run su 4 saturi, e nessun modo di saperlo senza scaricare i log.
  const fin = SRC.indexOf('function finalizeRunReport(');
  assert.notEqual(fin, -1);
  const corpo = SRC.slice(fin, SRC.indexOf('\n}\n', fin));
  assert.ok(corpo.includes('EVERGREEN_POOL_OUTCOME'), 'finalizeRunReport non emette EVERGREEN_POOL_OUTCOME');
  assert.ok(
    /RUN_REPORT\?\.evergreenPool\?\.ran/.test(corpo),
    'EVERGREEN_POOL_OUTCOME non e\' condizionata all\'aver raggiunto la Fase 2: i run che non ci arrivano '
    + 'non sono evidenza e falserebbero il denominatore',
  );
});

test('i motivi di scarto sono mutuamente esclusivi e coprono i tre segnali del pre-flight', () => {
  const at = SRC.indexOf('function countEvergreenPreflightDrop(');
  assert.notEqual(at, -1, 'countEvergreenPreflightDrop non esiste piu\'');
  const corpo = SRC.slice(at, SRC.indexOf('\n}\n', at));
  // I tre segnali sono quelli che `preFlightEvergreenCheck` restituisce davvero.
  assert.ok(corpo.includes('topic_coverage'), 'manca il segnale topic_coverage');
  assert.ok(corpo.includes('evergreen_family'), 'manca il segnale evergreen_family');
  assert.ok(/else\s+p\.skippedTitleJaccard/.test(corpo), 'title_jaccard non e\' il ramo di default');
  assert.ok(
    SRC.includes('skippedBanned') && SRC.includes('skippedStruck'),
    'ban e strike sono di nuovo contati insieme: chiedono due interventi diversi',
  );
});
