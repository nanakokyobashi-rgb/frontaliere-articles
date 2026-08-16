/**
 * faq-ts-literal-escaping.test.mjs — la chiave `.faq` sopravvive al viaggio
 * dentro un literal TypeScript a singoli apici.
 *
 * ## Il difetto che pinna
 *
 * `blog.article.<id>.faq` e' un documento JSON dentro una stringa TS a singoli
 * apici: due codifiche annidate. Gli scrittori di questo repo ne escapavano
 * una sola:
 *
 *     JSON.stringify(faqArray).replace(/'/g, "\\'")     // ← rotto
 *
 * L'apostrofo si', il backslash no. `JSON.stringify` produce `\"` per ogni
 * virgoletta nel testo della FAQ; senza raddoppiare il backslash quel `\"`
 * entra verbatim nel file `.ts`, il parser TS lo legge come `"`, e la stringa
 * JSON si chiude in mezzo a una frase.
 *
 * Nulla protesta al momento della scrittura. Il file `.ts` compila, la
 * validazione di sintassi di `batch-add-faq-to-articles.mjs` passa — perche' il
 * literal E' sintatticamente valido, il difetto sta nel livello annidato — e il
 * commit va live. Il danno si vede solo dove il documento viene riletto:
 * `engine/ogPagesPlugin.ts` fa `JSON.parse` del valore per emettere il FAQPage
 * JSON-LD, la parse lancia, e il `catch` accanto e' vuoto. La pagina esce senza
 * rich result e senza accordion FAQ, con la CI verde da entrambi i lati.
 *
 * Misurato su origin/main a08f37e8, simulando il lettore dell'engine su tutti i
 * body: 15.560 chiavi `.faq`, 102 pagine senza FAQPage, di cui **72 scritte da
 * questo escape**. `batch-faq-articles.yml` gira in cron ogni giorno alle 00:30
 * UTC, quindi il numero cresceva da solo.
 *
 * ## Perche' i casi sono `"` e `\n` e non altri
 *
 * Sono i due caratteri che `JSON.stringify` trasforma in una sequenza che INIZIA
 * con un backslash. Sono quindi gli unici che distinguono un escape corretto da
 * uno che ignora il backslash: su un testo che non li contiene i due scrittori
 * producono byte identici, ed e' per questo che il difetto ha potuto convivere
 * per mesi con migliaia di articoli sani.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  escapeForSingleQuoteTS,
  unescapeForSingleQuoteTS,
} from '../scripts/lib/article-meta-block.mjs';
import { serializeFaqLiteral, parseFaqLiteral } from '../scripts/fix-faq-locales.mjs';

const SCRIPTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts');

/** Lo scrittore ROTTO, tenuto qui per provare che i casi sotto lo bocciano. */
const brokenEscape = (faqArray) => JSON.stringify(faqArray).replace(/'/g, "\\'");

/** FAQ con una virgoletta nel testo: il caso dei 72 file misurati. */
const FAQ_WITH_QUOTE = [
  { q: 'Cosa e\' la campagna "Frontaliers Sabotage" a Varese?', a: 'E\' una protesta contro i cartelli "anti-frontalieri" comparsi in provincia, documentata dalla stampa locale.' },
  { q: 'Chi ha rivendicato l\'azione "Sabotage"?', a: 'Nessun gruppo l\'ha rivendicata ufficialmente; le autorita\' parlano di "atti isolati" ancora in fase di accertamento.' },
];

/** FAQ con un a capo dentro la risposta. */
const FAQ_WITH_NEWLINE = [
  { q: 'Quali documenti servono per il permesso G?', a: 'Servono tre documenti:\n- contratto di lavoro\n- documento di identita\n- prova di residenza in Italia' },
  { q: 'Quanto dura la procedura di rilascio?', a: 'In genere due settimane.\nNei periodi di picco puo\' arrivare a un mese, e il datore di lavoro va avvisato.' },
];

/** Un backslash letterale nel testo: il terzo carattere che JSON raddoppia. */
const FAQ_WITH_BACKSLASH = [
  { q: 'Come si scrive il percorso di rete aziendale?', a: 'Il formato UNC e\' \\\\server\\condivisione, e va indicato cosi\' nel modulo IT.' },
  { q: 'Serve la barra rovesciata nel codice fiscale?', a: 'No, il codice fiscale non contiene mai il carattere \\ ne\' altri separatori.' },
];

const CASES = [
  ['virgoletta nel testo (`\\"`)', FAQ_WITH_QUOTE],
  ['a capo nel testo (`\\n`)', FAQ_WITH_NEWLINE],
  ['backslash letterale', FAQ_WITH_BACKSLASH],
];

// ─────────────────────────────────────────────────────────────────────────────
// 1. Il contratto: cio' che si scrive e' cio' che si rilegge
// ─────────────────────────────────────────────────────────────────────────────

for (const [label, faq] of CASES) {
  test(`round-trip esatto — ${label}`, () => {
    const literal = serializeFaqLiteral(faq);

    // Il literal deve essere richiudibile in un file .ts: nessun apostrofo nudo.
    assert.equal(
      /(^|[^\\])(\\\\)*'/.test(literal),
      false,
      'il literal contiene un apostrofo non escapato: chiuderebbe la stringa TS',
    );

    // Decodifica ESATTA (cio' che fa il parser TypeScript) → JSON valido.
    const decoded = unescapeForSingleQuoteTS(literal);
    const parsed = JSON.parse(decoded);
    assert.deepEqual(parsed, faq, 'il round-trip ha alterato il contenuto della FAQ');

    // E il lettore di produzione lo riconosce come formato CORRENTE, non legacy.
    const read = parseFaqLiteral(literal);
    assert.deepEqual(read.pairs, faq);
    assert.equal(read.legacy, false, 'un literal appena scritto non puo\' essere legacy');
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. La controprova: con lo scrittore vecchio gli stessi casi si spaccano
//
// Senza questo blocco i test sopra sarebbero verdi anche con l'escape rotto sui
// casi che non contengono backslash, e non proverebbero niente. Qui si misura
// che i tre casi scelti sono esattamente quelli che lo bocciano.
// ─────────────────────────────────────────────────────────────────────────────

for (const [label, faq] of CASES) {
  test(`lo scrittore vecchio produce JSON illeggibile — ${label}`, () => {
    const broken = brokenEscape(faq);
    assert.throws(
      () => JSON.parse(unescapeForSingleQuoteTS(broken)),
      'lo scrittore vecchio avrebbe prodotto un literal valido su questo caso: ' +
        'non e\' un caso rappresentativo del difetto e va sostituito',
    );
    // E il literal corretto sugli stessi dati non e' lo stesso testo: se lo
    // fosse, la fix non avrebbe cambiato nulla per questo caso.
    assert.notEqual(serializeFaqLiteral(faq), broken);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Il lettore legge ANCHE il formato rotto — e lo dichiara tale
//
// E' cio' che rende riparabili i 72 file gia' committati: senza la decodifica
// legacy diventerebbero illeggibili, e con essi irrecuperabili senza tradurre
// di nuovo. `legacy: true` e' il rilevatore su cui lavora `--reescape-broken`.
// ─────────────────────────────────────────────────────────────────────────────

test('parseFaqLiteral legge il formato legacy e lo marca', () => {
  // FAQ_WITH_BACKSLASH, non FAQ_WITH_QUOTE (issue #401): il decoder esatto ora
  // e' `unescapeTsString` con la mappa minima `{ \\, ' }`, che lascia intatto
  // ogni `\x` che non e' `\\` o `\'` — inclusa la `\"` di JSON.stringify. Su un
  // testo SENZA backslash letterale la forma legacy (che escapa solo
  // l'apostrofo) decodifica correttamente anche col decoder esatto, quindi il
  // fallback non verrebbe mai raggiunto e il test non proverebbe niente. Il
  // backslash letterale di FAQ_WITH_BACKSLASH forza il decoder esatto a
  // dimezzarlo e a fallire il parse, esercitando davvero il fallback legacy —
  // stessa cautela gia' documentata in batch-faq-robustness.test.mjs (#394).
  const broken = brokenEscape(FAQ_WITH_BACKSLASH);
  const read = parseFaqLiteral(broken);
  assert.deepEqual(read.pairs, FAQ_WITH_BACKSLASH, 'il contenuto del file rotto non e\' recuperabile');
  assert.equal(read.legacy, true, 'un literal in formato rotto deve essere marcato legacy');

  // Ri-serializzandolo si ottiene il formato corrente: e' la riparazione.
  const repaired = parseFaqLiteral(serializeFaqLiteral(read.pairs));
  assert.deepEqual(repaired.pairs, FAQ_WITH_BACKSLASH);
  assert.equal(repaired.legacy, false);
});

test('parseFaqLiteral lascia intatti gli escape del JSON sottostante (#401)', () => {
  // Il caso reale che ha deciso la mappa di decodifica, gia' pinnato lato
  // `batch-add-faq-to-articles.mjs` da batch-faq-robustness.test.mjs: un
  // \u00a0 scritto dallo scrittore legacy. Un inverso che spoglia OGNI `\x`
  // (`unescapeForSingleQuoteTS`, cio' che questo file usava come decoder
  // esatto prima della fix) legge la `u` come lettera e produce
  // `CHF 5u00a0000` — e siccome il risultato resta JSON valido, il fallback
  // legacy sotto non scatta mai: il valore sbagliato passa in silenzio.
  const raw = String.raw`[{"q":"Quanto vale la deduzione?","a":"Vale CHF 5\u00a0000 pieni, cifra tonda."}]`;
  const { pairs, legacy } = parseFaqLiteral(raw);
  assert.equal(pairs[0].a, 'Vale CHF 5\u00a0000 pieni, cifra tonda.');
  assert.ok(!pairs[0].a.includes('u00a0'), 'il \\u e\' stato spogliato del backslash e letto come lettera');
  assert.equal(legacy, false, 'un literal ben formato con \\u non e\' legacy');
});

test('un literal senza caratteri da escapare non e\' legacy', () => {
  // I due scrittori sono indistinguibili qui: e' la ragione per cui il difetto
  // ha colpito 72 file su 15.560 invece che tutti.
  const plain = [
    { q: 'Chi puo richiedere il permesso G in Ticino?', a: 'Chi risiede in una zona di frontiera e lavora in Svizzera con un contratto valido.' },
    { q: 'Ogni quanto va rinnovato il permesso G?', a: 'La durata segue il contratto di lavoro e in genere si rinnova ogni cinque anni.' },
  ];
  assert.equal(serializeFaqLiteral(plain), brokenEscape(plain));
  assert.equal(parseFaqLiteral(serializeFaqLiteral(plain)).legacy, false);
});

test('un literal che non e\' un array FAQ non finge di esserlo', () => {
  for (const junk of ['', 'non json', '{"q":"x"}', '[']) {
    const read = parseFaqLiteral(junk);
    assert.equal(read.pairs, null, `ha accettato un valore non-array: ${JSON.stringify(junk)}`);
    assert.equal(read.legacy, false);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Il lettore dell'engine, che e' il consumatore che conta
//
// `engine/ogPagesPlugin.ts` vive nel repo del SITO e scende qui col mirror: fra
// lo scrittore e lui non c'e' nessun import, quindi nessun guard che segue gli
// import puo' vedere questo contratto — la stessa forma di SiteShellContract.
// Qui si riproduce il suo `unescapeTsStringRaw` per la sola sequenza `\\"`, che
// e' quella dei 72 file misurati.
//
// La meta' `\n` NON e' asserita qui apposta: su quella il decoder dell'engine
// sbaglia da solo, a monte di qualunque cosa faccia il corpus, e la sua fix e'
// una PR sul sito. Asserire qui il comportamento attuale la pinnerebbe.
// ─────────────────────────────────────────────────────────────────────────────

test('il literal prodotto attraversa il decoder dell\'engine — caso `\\"`', () => {
  const engineUnescapeTsStringRaw = (value) =>
    value
      .replace(/\\'/g, '\'')
      .replace(/\\"/g, '"')
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '')
      .replace(/\\t/g, ' ')
      .replace(/\\\\/g, '\\');

  const literal = serializeFaqLiteral(FAQ_WITH_QUOTE);
  const parsed = JSON.parse(engineUnescapeTsStringRaw(literal));

  // Gli stessi filtri dell'engine: >= 2 coppie con q > 10 e a > 20 caratteri,
  // altrimenti il FAQPage non viene emesso comunque.
  assert.ok(Array.isArray(parsed) && parsed.length >= 2);
  const usable = parsed.filter((p) => p && p.q && p.a && p.q.length > 10 && p.a.length > 20);
  assert.ok(usable.length >= 2, 'meno di due coppie utili: nessun FAQPage');

  // E con lo scrittore vecchio lo stesso percorso lancia: e' il difetto vivo.
  assert.throws(() => JSON.parse(engineUnescapeTsStringRaw(brokenEscape(FAQ_WITH_QUOTE))));
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Il guard: nessuno scrittore di `.faq` torna alla `.replace()` a mano
//
// I tre punti di scrittura sono stati corretti uno per uno; questo impedisce
// che ne ricompaia un quarto. Il difetto e' esattamente «un escape rifatto a
// mano accanto a uno corretto»: in batch-add-faq-to-articles.mjs la funzione
// giusta era gia' nel file, e il percorso di REPLACE non la usava.
// ─────────────────────────────────────────────────────────────────────────────

test('nessuno scrittore di .faq escapa il solo apostrofo', () => {
  const offenders = [];
  for (const file of ['fix-faq-locales.mjs', 'batch-add-faq-to-articles.mjs']) {
    const src = fs.readFileSync(path.join(SCRIPTS, file), 'utf-8');
    src.split('\n').forEach((line, i) => {
      if (line.trimStart().startsWith('//') || line.trimStart().startsWith('*')) return;
      if (/JSON\.stringify\([^)]*\)\s*\.replace\(\/'\/g/.test(line)) {
        offenders.push(`${file}:${i + 1}: ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(
    offenders,
    [],
    'un escape a mano che ignora il backslash e\' tornato. Usa serializeFaqLiteral() ' +
      '(fix-faq-locales.mjs) o escapeForSingleQuoteTS() (lib/article-meta-block.mjs):\n  ' +
      offenders.join('\n  '),
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. `--help` e `DRY_RUN=1` non toccano il corpus
//
// Non e' igiene: e' il contratto che `dry-run-entrypoints.mjs` da' per scontato
// su ogni entry point, e che questo script non ha mai onorato. Non si vedeva
// perche' il lettore rotto lo rendeva cieco su quasi tutti gli articoli: con
// niente da fare, non scriveva, e l'armatura lo dichiarava «loaded». Riparato
// il lettore, la prima cosa che ha fatto e' stata riscrivere un file del corpus
// mentre veniva soltanto caricato — esattamente il difetto che l'intestazione
// di quell'armatura racconta per generate-border-wait-ranking-article.mjs.
// ─────────────────────────────────────────────────────────────────────────────

test('`--help` esce senza leggere ne\' scrivere il corpus', () => {
  const res = spawnSync(
    process.execPath,
    [path.join(SCRIPTS, 'fix-faq-locales.mjs'), '--help'],
    { env: { ...process.env, DRY_RUN: '1', CI: '1' }, encoding: 'utf-8', timeout: 20_000 },
  );
  assert.equal(res.status, 0, `uscita non zero: ${res.stderr}`);
  assert.match(res.stdout, /--reescape-broken/, 'l\'usage non descrive le opzioni');
  // Se avesse scansionato il corpus ci avrebbe messo secondi e avrebbe parlato
  // di articoli: qui non deve esserci traccia di lavoro.
  assert.doesNotMatch(res.stdout, /Scanning for FAQ locale issues/);
});

test('DRY_RUN=1 vale come --dry-run', () => {
  const src = fs.readFileSync(path.join(SCRIPTS, 'fix-faq-locales.mjs'), 'utf-8');
  assert.match(
    src,
    /const DRY_RUN = [^\n]*process\.env\.DRY_RUN === '1'/,
    'DRY_RUN=1 non e\' piu\' un alias di --dry-run: l\'armatura dry-run passa quella ' +
      'variabile e non l\'argomento, quindi lo script tornerebbe a scrivere mentre viene caricato',
  );
});

test('escapeForSingleQuoteTS e unescapeForSingleQuoteTS sono inversi', () => {
  const samples = [
    'niente da escapare',
    'l\'apostrofo di dell\'A9',
    'virgolette "dritte" e \\backslash\\',
    'a capo\nvero e tab\tvero',
    JSON.stringify(FAQ_WITH_QUOTE),
    JSON.stringify(FAQ_WITH_NEWLINE),
    JSON.stringify(FAQ_WITH_BACKSLASH),
  ];
  for (const s of samples) {
    // `\r` viene tolto dallo scrittore per scelta, quindi il confronto e' con
    // l'input gia' privo di CR — l'unica perdita dichiarata della coppia.
    const expected = s.replace(/\r/g, '');
    assert.equal(unescapeForSingleQuoteTS(escapeForSingleQuoteTS(s)), expected, `round-trip rotto su: ${s}`);
  }
});
