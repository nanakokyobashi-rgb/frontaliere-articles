/**
 * batch-faq-robustness.test.mjs — le tre falle di
 * `generator/scripts/batch-add-faq-to-articles.mjs` trovate dalla review locale
 * di #392: issue #393 (corpo non ancorato all'id), #394 (il lettore non e'
 * l'inverso dello scrittore), #395 (testo FAQ interpolato in una replacement
 * string). `node --test` via `tsx`, come il gemello `faq-key-anchoring.test.mjs`
 * — da cui questo file eredita fixture e forma.
 *
 * ## PERCHE' UN FILE A PARTE
 *
 * `faq-key-anchoring.test.mjs` prova UNA proprieta' (la chiave `.faq` toccata e'
 * quella del proprio id) su TRE script. Qui e' l'opposto: tre proprieta'
 * diverse su un file solo. Tenerle di la' avrebbe fatto mentire il titolo di
 * quel file, che e' il primo posto dove si guarda quando diventa rosso.
 *
 * ## L'IMPORT NON DEVE FARE NIENTE
 *
 * `batch-add-faq-to-articles.mjs` arma un handler SIGTERM che fa `git add
 * content/ && git commit && git push origin main`. Fino a #392 si armava a
 * module scope, quindi anche quando il file veniva importato solo per riusarne
 * una funzione — e un SIGTERM a quel processo (`tests.yml` ha
 * `cancel-in-progress: true`) faceva pushare su main da un processo che non
 * stava generando niente. Ora sta dentro la guardia sull'entry point, e il
 * primo test qui sotto e' cio' che impedisce che ci torni: questo file IMPORTA
 * il modulo, quindi se l'handler tornasse a module scope se ne accorgerebbe.
 *
 * ## MUTAZIONI (la prova che il test vede il difetto)
 *
 * Ogni gruppo e' stato falsificato ripristinando il comportamento vecchio e
 * verificando che il test diventasse rosso — la riga esatta e' scritta sopra
 * ciascun `describe`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as batch from '../scripts/batch-add-faq-to-articles.mjs';

const QUI = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(QUI, '..', 'scripts', 'batch-add-faq-to-articles.mjs');

const ALPHA = 'alpha-uno';
const BETA = 'beta-due';

const bodyLine = (id, n, testo) => `    'blog.article.${id}.body${n}': '${testo}',`;
const faqLine = (id, pairs) => `    'blog.article.${id}.faq': '${JSON.stringify(pairs)}',`;

function bodyFile(...righe) {
  return ['const blogBody: Record<string, string> = {', ...righe, '};', '', 'export default blogBody;', ''].join('\n');
}

function fileTemporaneo(t, nome, contenuto) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faq-robust-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const p = path.join(dir, nome);
  fs.writeFileSync(p, contenuto, 'utf-8');
  return p;
}

/**
 * L'oracolo: rilegge il valore `.faq` di un id SENZA passare da nessuna delle
 * funzioni sotto esame. Decodifica solo `\\` e `\'` e lascia intatto tutto il
 * resto, che e' cio' che `JSON.parse` deve vedere.
 */
function faqDiId(testo, id) {
  const m = new RegExp(`'blog\\.article\\.${id}\\.faq'\\s*:\\s*'((?:[^'\\\\]|\\\\.)*)'`).exec(testo);
  if (!m) return null;
  return JSON.parse(m[1].replace(/\\([\s\S])/g, (whole, c) => (c === '\\' || c === "'" ? c : whole)));
}

// ── L'import resta senza effetti ─────────────────────────────────────────────
//
// MUTAZIONE: spostare `installSigtermCheckpoint()` fuori dalla guardia
// `import.meta.url === ...` in fondo allo script → rosso.

test('importare il modulo non arma nessun handler di segnale', () => {
  assert.equal(process.listenerCount('SIGTERM'), 0,
    'l handler SIGTERM committa e pusha su main: non deve esistere in un processo che ha solo IMPORTATO lo script');
  const src = fs.readFileSync(SCRIPT, 'utf-8');
  const guardia = src.indexOf('if (import.meta.url ===');
  assert.ok(guardia > 0, 'la guardia sull entry point deve esserci');
  // Le CHIAMATE, non la definizione: `function installSigtermCheckpoint()` sta
  // per forza sopra la guardia, ed e' giusto che ci stia.
  const chiamate = [...src.matchAll(/(?<!function\s)\binstallSigtermCheckpoint\(\)/g)].map((m) => m.index);
  assert.ok(chiamate.length > 0, 'lo script deve pur armarlo quando gira davvero');
  for (const i of chiamate) {
    assert.ok(i > guardia,
      'installSigtermCheckpoint() va CHIAMATA solo dentro la guardia sull entry point: a module scope si arma anche su un import');
  }
});

// ── #393 — il corpo che entra nel prompt e' quello del proprio id ────────────
//
// MUTAZIONE: rimettere `const re = /\.body\d+'\s*:\s*(['`])((?:\\.|(?!\1)[\s\S])*?)\1/g`
// al posto di `bodyKeyRx(articleId)` in `extractBodyContent` → rosso (il corpo
// di beta-due entra nel testo di alpha-uno).

const CORPO_ALPHA_1 = 'Primo corpo di alpha, abbastanza lungo da sembrare un articolo vero.';
const CORPO_ALPHA_2 = 'Secondo corpo di alpha, che deve essere concatenato al primo.';
const CORPO_BETA = 'Corpo di beta, un articolo COMPLETAMENTE estraneo ad alpha.';

const DUE_ID = bodyFile(
  bodyLine(ALPHA, 1, CORPO_ALPHA_1),
  bodyLine(ALPHA, 2, CORPO_ALPHA_2),
  bodyLine(BETA, 1, CORPO_BETA),
);

test('#393 extractBodyContent prende SOLO i bodyN del proprio id', () => {
  const testoAlpha = batch.extractBodyContent(DUE_ID, ALPHA);
  assert.ok(testoAlpha.includes(CORPO_ALPHA_1), 'manca il primo corpo di alpha');
  assert.ok(testoAlpha.includes(CORPO_ALPHA_2), 'manca il secondo corpo di alpha');
  assert.ok(!testoAlpha.includes(CORPO_BETA),
    'il corpo di beta-due e finito nel prompt di alpha-uno: la FAQ nascerebbe da due articoli');

  const testoBeta = batch.extractBodyContent(DUE_ID, BETA);
  assert.ok(testoBeta.includes(CORPO_BETA));
  assert.ok(!testoBeta.includes(CORPO_ALPHA_1));
});

test('#393 extractBodyContent tiene i bodyN in ordine e concatena', () => {
  const testo = batch.extractBodyContent(DUE_ID, ALPHA);
  assert.ok(testo.indexOf(CORPO_ALPHA_1) < testo.indexOf(CORPO_ALPHA_2), 'l ordine dei bodyN va conservato');
});

test('#393 extractBodyContent legge anche i valori fra backtick', () => {
  const src = bodyFile(
    "    'blog.article.alpha-uno.body1': `Corpo di alpha fra backtick, lungo il giusto.`,",
    '    ' + "'blog.article.beta-due.body1': `Corpo di beta fra backtick, da NON leggere.`,",
  );
  const testo = batch.extractBodyContent(src, ALPHA);
  assert.ok(testo.includes('Corpo di alpha fra backtick'));
  assert.ok(!testo.includes('Corpo di beta fra backtick'));
});

test('#393 extractBodyContent non lascia che un id matchi un id piu lungo', () => {
  // Nessuna coppia del corpus e' oggi in questa relazione, ma senza l'ancora
  // alla chiave INTERA un prefisso matcherebbe il suo estensore.
  const src = bodyFile(
    bodyLine('alpha', 1, 'Corpo del solo alpha, che deve restare separato.'),
    bodyLine('alpha-uno', 1, 'Corpo di alpha-uno, un ALTRO articolo.'),
  );
  const testo = batch.extractBodyContent(src, 'alpha');
  assert.ok(testo.includes('Corpo del solo alpha'));
  assert.ok(!testo.includes('Corpo di alpha-uno'), "l'id 'alpha' non deve matchare 'alpha-uno'");
});

// MUTAZIONE: rimettere `fileContent.match(/…/)` (primo match, senza `g`) e
// ignorare `fileName` in `extractArticleId` → rosso.
test('#393 extractArticleId decide per NOME, non per posizione', () => {
  assert.equal(batch.extractArticleId(DUE_ID, `${BETA}.ts`), BETA,
    'in un file a due id l identita dell articolo non puo dipendere da chi viene prima');
  assert.equal(batch.extractArticleId(DUE_ID, `${ALPHA}.ts`), ALPHA);
  // Nome che non compare nel file: si ricade sul primo `body1`, come prima.
  assert.equal(batch.extractArticleId(DUE_ID, 'nessuno.ts'), ALPHA);
  assert.equal(batch.extractArticleId(DUE_ID), ALPHA, 'senza nome file il comportamento resta quello vecchio');
  assert.equal(batch.extractArticleId(bodyFile('    // niente'), 'x.ts'), null);
});

// ── #394 — il lettore e' l'inverso dello scrittore ──────────────────────────
//
// MUTAZIONE: rimettere `JSON.parse(raw.replace(/\\'/g, "'"))` come unica
// decodifica in `extractFaqFromContent` → rosso su ogni round-trip qui sotto
// che contiene una virgoletta o un backslash.

/** Testo che esercita tutte le sequenze che lo scrittore deve saper riportare. */
const FAQ_OSTILE = [
  { q: 'Che cosa dice la "circolare" del 2026?', a: 'Dice che l\'imposta si calcola cosi\': prima la base, poi l\'aliquota.' },
  { q: 'Come si scrive un percorso Windows?', a: 'Per esempio C:\\Users\\frontaliere\\documenti — con i backslash.' },
  { q: 'La risposta puo andare a capo?', a: 'Si\':\nprima riga\nseconda riga, e un tab\tin mezzo.' },
];

test('#394 round-trip: cio che insertFaqIntoBodyFile scrive, extractFaqFromContent rilegge', (t) => {
  const p = fileTemporaneo(t, `${ALPHA}.ts`, bodyFile(bodyLine(ALPHA, 1, 'Corpo di alpha.')));
  assert.equal(batch.insertFaqIntoBodyFile(p, ALPHA, FAQ_OSTILE), true);
  const dopo = fs.readFileSync(p, 'utf-8');
  assert.deepEqual(batch.extractFaqFromContent(dopo, ALPHA), FAQ_OSTILE,
    'lo script non rilegge cio che ha appena scritto: e la forma di #394');
  // E l'oracolo indipendente vede la stessa cosa, quindi non e' un difetto
  // simmetrico fra scrittore e lettore che si nasconde a vicenda.
  assert.deepEqual(faqDiId(dopo, ALPHA), FAQ_OSTILE);
});

test('#394 round-trip anche sul percorso di REPLACE', (t) => {
  const primo = [{ q: 'Domanda iniziale lunga abbastanza?', a: 'Risposta iniziale lunga abbastanza per essere valida.' }];
  const p = fileTemporaneo(t, `${ALPHA}.ts`, bodyFile(bodyLine(ALPHA, 1, 'Corpo.'), faqLine(ALPHA, primo)));
  assert.equal(batch.replaceFaqInBodyFile(p, FAQ_OSTILE, ALPHA), true);
  assert.deepEqual(batch.extractFaqFromContent(fs.readFileSync(p, 'utf-8'), ALPHA), FAQ_OSTILE);
});

test('#394 i file scritti dallo scrittore LEGACY restano leggibili', () => {
  // Lo scrittore legacy escapava solo l'apostrofo: il `\"` di JSON.stringify
  // finiva nel literal con UN backslash solo. E' la forma in cui stanno i 377
  // campi `.faq` misurati sul corpus, e vanno letti o diventano irreparabili.
  const pairs = [
    { q: 'Che cosa dice la "circolare"?', a: 'Dice cosi\', in modo abbastanza lungo da valere.' },
    { q: 'E la seconda domanda lunga?', a: 'La seconda risposta, lunga abbastanza per valere.' },
  ];
  const legacy = JSON.stringify(pairs).replace(/'/g, "\\'");
  const src = bodyFile(bodyLine(ALPHA, 1, 'Corpo.'), `    'blog.article.${ALPHA}.faq': '${legacy}',`);
  assert.deepEqual(batch.extractFaqFromContent(src, ALPHA), pairs);
});

test('#394 parseFaqLiteral lascia intatti gli escape del JSON sottostante', () => {
  // Il caso reale che ha deciso la mappa di decodifica: un `\u00a0` scritto
  // dallo scrittore legacy. Un inverso che spoglia OGNI `\x` legge la `u` e
  // produce `5u00a0000` — e parsa, quindi il fallback legacy non scatta mai.
  const raw = String.raw`[{"q":"Quanto vale la deduzione?","a":"Vale CHF 5\u00a0000 pieni, cifra tonda."}]`;
  const letto = batch.parseFaqLiteral(raw);
  assert.equal(letto[0].a, 'Vale CHF 5\u00a0000 pieni, cifra tonda.');
  assert.ok(!letto[0].a.includes('u00a0'), 'il \\u e stato spogliato del backslash e letto come lettera');
});

test('#394 parseFaqLiteral torna null quando nessuna decodifica da un array', () => {
  assert.equal(batch.parseFaqLiteral('non e json'), null);
  assert.equal(batch.parseFaqLiteral('{"q":"un oggetto, non un array"}'), null);
  assert.equal(batch.parseFaqLiteral(''), null);
});

test('#394 una .faq illeggibile non viene confusa con una assente', () => {
  const src = bodyFile(bodyLine(ALPHA, 1, 'Corpo.'), `    'blog.article.${ALPHA}.faq': 'rotta senza rimedio',`);
  assert.equal(batch.hasFaqKey(src, ALPHA), true, 'la chiave c e');
  assert.equal(batch.extractFaqFromContent(src, ALPHA), null, 'ma non si legge');
});

// ── #395 — il testo FAQ non e' un pattern di sostituzione ───────────────────
//
// MUTAZIONE: rimettere il replacer STRINGA (`` `\n${faqLine}\n$2` ``) in
// `insertFaqIntoBodyFile` → rosso, e il file su disco contiene `};\nexport
// default` dentro il literal della FAQ.

const FAQ_CON_DOLLARI = [
  { q: 'Quanto vale il primo gruppo di cattura?', a: 'Vale $1 e non deve espandersi in niente.' },
  { q: 'E il match intero quanto vale?', a: 'Vale $& e nemmeno lui deve espandersi.' },
  { q: 'E le altre sequenze speciali?', a: "Restano $2, $3, $`, $' e $$ — un massimo di $2 milioni." },
];

test('#395 un $1/$&/$` nel testo FAQ finisce su disco VERBATIM (insert)', (t) => {
  const p = fileTemporaneo(t, `${ALPHA}.ts`, bodyFile(bodyLine(ALPHA, 1, 'Corpo di alpha.')));
  assert.equal(batch.insertFaqIntoBodyFile(p, ALPHA, FAQ_CON_DOLLARI), true);
  const dopo = fs.readFileSync(p, 'utf-8');
  assert.deepEqual(faqDiId(dopo, ALPHA), FAQ_CON_DOLLARI, 'il testo FAQ e stato espanso come pattern di sostituzione');
  assert.ok(!/export default[\s\S]*export default/.test(dopo),
    "l'espansione di $2 duplica la coda `};\\nexport default` dentro il literal");
});

test('#395 lo stesso vale sul percorso di FALLBACK (quello via body3)', (t) => {
  // Il fallback scatta quando la prima regex non matcha: qui il file non ha
  // `export default` sulla riga dopo `};`, che e' cio' che la prima pretende.
  const src = [
    'const blogBody: Record<string, string> = {',
    bodyLine(ALPHA, 1, 'Primo.'),
    bodyLine(ALPHA, 2, 'Secondo.'),
    bodyLine(ALPHA, 3, 'Terzo.'),
    '};',
    '',
  ].join('\n');
  const p = fileTemporaneo(t, `${ALPHA}.ts`, src);
  assert.equal(batch.insertFaqIntoBodyFile(p, ALPHA, FAQ_CON_DOLLARI), true);
  assert.deepEqual(faqDiId(fs.readFileSync(p, 'utf-8'), ALPHA), FAQ_CON_DOLLARI);
});

test('#395 e sul percorso di REPLACE, che ricostruisce per slicing', (t) => {
  const primo = [{ q: 'Domanda iniziale lunga abbastanza?', a: 'Risposta iniziale lunga abbastanza per valere.' }];
  const p = fileTemporaneo(t, `${ALPHA}.ts`, bodyFile(bodyLine(ALPHA, 1, 'Corpo.'), faqLine(ALPHA, primo)));
  assert.equal(batch.replaceFaqInBodyFile(p, FAQ_CON_DOLLARI, ALPHA), true);
  assert.deepEqual(faqDiId(fs.readFileSync(p, 'utf-8'), ALPHA), FAQ_CON_DOLLARI);
});

test('#395 insert e replace producono lo stesso literal per la stessa FAQ', (t) => {
  const conFaq = fileTemporaneo(t, `${ALPHA}-r.ts`,
    bodyFile(bodyLine(ALPHA, 1, 'Corpo.'), faqLine(ALPHA, [{ q: 'Segnaposto lungo?', a: 'Segnaposto lungo abbastanza.' }])));
  const senzaFaq = fileTemporaneo(t, `${ALPHA}-i.ts`, bodyFile(bodyLine(ALPHA, 1, 'Corpo.')));
  batch.replaceFaqInBodyFile(conFaq, FAQ_CON_DOLLARI, ALPHA);
  batch.insertFaqIntoBodyFile(senzaFaq, ALPHA, FAQ_CON_DOLLARI);
  const rigaDi = (p) => fs.readFileSync(p, 'utf-8').split('\n').find((r) => r.includes('.faq'));
  assert.equal(rigaDi(conFaq).trim(), rigaDi(senzaFaq).trim(),
    'i due percorsi di scrittura devono produrre lo stesso byte, o uno dei due ha un escaping diverso');
});

// ── Il guard strutturale: nessun ALTRO punto interpola in una replacement ───
//
// #395 nomina due siti, ma la domanda giusta e' «ce ne sono altri?». Questo
// scanner li cerca tutti invece di fidarsi dell'elenco: trova ogni `.replace(`
// il cui SECONDO argomento e' un template literal con dentro un `${…}`. Un
// replacer-funzione e uno letterale non matchano; un template interpolato si',
// ed e' esattamente la forma del difetto.
//
// MUTAZIONE: lo scanner e' provato QUI SOTTO contro uno snippet costruito, cosi'
// un rosso sul file vero non e' l'unica prova che sappia vedere qualcosa.

function replaceInterpolanti(src) {
  const trovati = [];
  const rx = /\.replace\s*\(/g;
  let m;
  while ((m = rx.exec(src)) !== null) {
    // Scansione a parentesi bilanciate dell'elenco argomenti, saltando
    // stringhe, template e regex letterali.
    let i = m.index + m[0].length;
    let depth = 1;
    const virgole = [];
    while (i < src.length && depth > 0) {
      const c = src[i];
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') depth--;
      else if (c === ',' && depth === 1) virgole.push(i);
      else if (c === "'" || c === '"' || c === '`') {
        const quote = c;
        i++;
        while (i < src.length && src[i] !== quote) i += src[i] === '\\' ? 2 : 1;
      } else if (c === '/' && /[(,=:[]\s*$/.test(src.slice(Math.max(0, i - 30), i))) {
        i++; // regex literal
        while (i < src.length && src[i] !== '/') i += src[i] === '\\' ? 2 : 1;
      }
      i++;
    }
    if (!virgole.length) continue;
    const secondo = src.slice(virgole[0] + 1, i - 1).trim();
    if (secondo.startsWith('`') && /\$\{/.test(secondo)) {
      trovati.push(src.slice(m.index, Math.min(src.length, m.index + 90)).split('\n')[0]);
    }
  }
  return trovati;
}

test('#395 lo scanner vede la forma del difetto (mutazione dello scanner stesso)', () => {
  const cattivo = 'content = content.replace(/(a)(b)/, `\\n${faqLine}\\n$2`);';
  assert.equal(replaceInterpolanti(cattivo).length, 1, 'lo scanner deve vedere un replacement template interpolato');
  const buono = 'content = content.replace(/(a)(b)/, (_m, x, y) => `${x}${faqLine}${y}`);';
  assert.equal(replaceInterpolanti(buono).length, 0, 'un replacer-funzione non e un pattern');
  const letterale = "s.replace(/\\\\/g, '\\\\\\\\')";
  assert.equal(replaceInterpolanti(letterale).length, 0, 'un replacement stringa senza interpolazione non e il difetto');
});

test('#395 nessun .replace() dello script interpola testo in una replacement string', () => {
  const trovati = replaceInterpolanti(fs.readFileSync(SCRIPT, 'utf-8'));
  assert.deepEqual(trovati, [],
    'un replacement come TEMPLATE interpolato espande i $ del testo che ci finisce dentro: usare un replacer-funzione');
});
