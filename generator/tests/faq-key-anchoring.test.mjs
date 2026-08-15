/**
 * faq-key-anchoring.test.mjs — la chiave `.faq` che uno script TOCCA deve
 * essere quella del PROPRIO id, non una qualunque nel file. Issue #301 item 2.
 * `node --test` (via `tsx`, per i moduli che importano sorgenti senza estensione).
 *
 * ## COSA DEVE DIMOSTRARE
 *
 * #294 ha ancorato all'id i tre gate di sola LETTURA (`find-dirty-content-ids`
 * & co.): il pattern di riferimento e' `faqQuestionsInBodyText()`, che compone
 * `'blog\.article\.<id>\.faq'` con l'id escapato per la regex. I tre script che
 * SCRIVONO erano rimasti con la forma non ancorata — `\.faq'\s*:` — che matcha
 * qualunque chiave `.faq` presente nel file:
 *
 *   · `generator/scripts/batch-add-faq-to-articles.mjs` (`hasFaqKey`,
 *     `extractFaqFromContent`, `replaceFaqInBodyFile`);
 *   · `generator/scripts/fix-faq-locales.mjs` (`FAQ_VALUE_RE` → `rawFaqLiteral`,
 *     `hasFaqKey`, `replaceFaqInFile`);
 *   · `generator/scripts/repair-prompt-placeholders.mjs` (`FAQ_LINE_RE` e la
 *     regex di `faqStateOf`, ora in `lib/prompt-placeholder-guard.mjs`).
 *
 * Su questi la differenza non e' un falso negativo di un rapporto: e' una
 * SCRITTURA sul file sbagliato. Con due chiavi `.faq` di id diversi nello
 * stesso file, `replaceFaqInBodyFile` scriveva la FAQ dell'articolo A dentro la
 * chiave dell'articolo B (le tre funzioni prendono l'ULTIMA occorrenza,
 * semantica dell'object literal JS — corretta per una chiave DUPLICATA, cieca
 * su una chiave ALTRUI), `hasFaqKey` dichiarava presente una FAQ che per quel
 * id non c'era, e `faqStateOf` faceva potare a `repair-prompt-placeholders` una
 * FAQ viva e non orfana.
 *
 * ## PERCHE' FIXTURE SINTETICHE
 *
 * L'assunzione «un file body porta un solo id» non e' mai stata violata sui
 * 16.648 file reali, e non c'e' quindi un fixture reale da cui partire: il file
 * a due id qui sotto e' costruito. Ma niente nel formato la impone — un residuo
 * di merge la rompe senza che nessun gate lo veda — ed e' esattamente lo
 * scenario che le tre funzioni gestiscono gia' esplicitamente con `g` +
 * ultima occorrenza.
 *
 * ## MUTAZIONE (la prova che il test vede il difetto)
 *
 * Ogni asserzione qui sotto e' stata falsificata togliendo l'ancoraggio dallo
 * script corrispondente (`'blog\\.article\\.${idPart}\\.faq'` → `\\.faq'`) e
 * verificando che il test diventasse rosso.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as batch from '../scripts/batch-add-faq-to-articles.mjs';
import * as fixLocales from '../scripts/fix-faq-locales.mjs';
import { faqLineRe, faqPresentForId } from '../scripts/lib/prompt-placeholder-guard.mjs';

const QUI = path.dirname(fileURLToPath(import.meta.url));

const ALPHA = 'alpha-uno';
const BETA = 'beta-due';

const FAQ_ALPHA = [{ q: 'Domanda alpha lunga a sufficienza?', a: 'Risposta alpha, lunga abbastanza per essere valida.' }];
const FAQ_BETA = [{ q: 'Domanda beta lunga a sufficienza?', a: 'Risposta beta, lunga abbastanza per essere valida.' }];
const FAQ_NUOVA = [{ q: 'Domanda nuova lunga a sufficienza?', a: 'Risposta nuova, lunga abbastanza per essere valida.' }];

const bodyLine = (id) => `    'blog.article.${id}.body1': 'Corpo di ${id}, abbastanza lungo da sembrare un articolo.',`;
const faqLine = (id, pairs) => `    'blog.article.${id}.faq': '${JSON.stringify(pairs)}',`;

/** Un file body con le righe passate, nella forma che il corpus usa davvero. */
function bodyFile(...righe) {
  return ['const blogBody: Record<string, string> = {', ...righe, '};', '', 'export default blogBody;', ''].join('\n');
}

/** Due id nello stesso file, entrambi con la loro `.faq`. */
const DUE_FAQ = bodyFile(bodyLine(ALPHA), faqLine(ALPHA, FAQ_ALPHA), bodyLine(BETA), faqLine(BETA, FAQ_BETA));

/** Due id, ma la `.faq` ce l'ha solo il SECONDO. */
const SOLO_FAQ_BETA = bodyFile(bodyLine(ALPHA), bodyLine(BETA), faqLine(BETA, FAQ_BETA));

/**
 * L'oracolo del test, indipendente dal codice sotto esame: legge il valore
 * `.faq` di un id senza passare da nessuna delle funzioni che si stanno
 * verificando (altrimenti un difetto nel lettore nasconderebbe se stesso).
 */
function faqDiId(testo, id) {
  const m = new RegExp(`'blog\\.article\\.${id}\\.faq'\\s*:\\s*'((?:[^'\\\\]|\\\\.)*)'`).exec(testo);
  return m ? JSON.parse(m[1].replace(/\\'/g, "'")) : null;
}

/** Un file temporaneo che sparisce a fine test. */
function fileTemporaneo(t, nome, contenuto) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faq-anchor-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const p = path.join(dir, nome);
  fs.writeFileSync(p, contenuto, 'utf-8');
  return p;
}

// ── batch-add-faq-to-articles.mjs ────────────────────────────────────────────
//
// L'id qui NON e' il nome del file: lo script lo ricava dalla chiave `body1`
// (`extractArticleId`) e lo passa in giro, quindi le funzioni lo ricevono.

test('batch: hasFaqKey non vede la .faq di un ALTRO id', () => {
  assert.equal(batch.hasFaqKey(SOLO_FAQ_BETA, ALPHA), false);
  assert.equal(batch.hasFaqKey(SOLO_FAQ_BETA, BETA), true);
});

test('batch: extractFaqFromContent legge la .faq del proprio id, non l ultima del file', () => {
  assert.deepEqual(batch.extractFaqFromContent(DUE_FAQ, ALPHA), FAQ_ALPHA);
  assert.deepEqual(batch.extractFaqFromContent(DUE_FAQ, BETA), FAQ_BETA);
});

test('batch: replaceFaqInBodyFile scrive SOLO la .faq del proprio id', (t) => {
  const p = fileTemporaneo(t, `${ALPHA}.ts`, DUE_FAQ);
  assert.equal(batch.replaceFaqInBodyFile(p, FAQ_NUOVA, ALPHA), true);
  const dopo = fs.readFileSync(p, 'utf-8');
  assert.deepEqual(faqDiId(dopo, ALPHA), FAQ_NUOVA);
  assert.deepEqual(faqDiId(dopo, BETA), FAQ_BETA, 'la .faq di beta-due e stata sovrascritta');
  assert.ok(dopo.includes(faqLine(BETA, FAQ_BETA)), 'la riga di beta-due deve restare byte per byte');
});

// ── fix-faq-locales.mjs ──────────────────────────────────────────────────────
//
// Qui l'id e' il NOME DEL FILE: `main()` fa `basename(file, '.ts')`, e le
// funzioni lo ricavano dallo stesso path che ricevono.

test('fix-faq-locales: hasFaqKey non vede la .faq di un ALTRO id', (t) => {
  const p = fileTemporaneo(t, `${ALPHA}.ts`, SOLO_FAQ_BETA);
  assert.equal(fixLocales.hasFaqKey(p), false);
  assert.equal(fixLocales.hasFaqKey(p, BETA), true);
});

test('fix-faq-locales: extractFaqFromFile legge la .faq del proprio id', (t) => {
  const p = fileTemporaneo(t, `${ALPHA}.ts`, DUE_FAQ);
  assert.deepEqual(fixLocales.extractFaqFromFile(p), FAQ_ALPHA);
  assert.deepEqual(fixLocales.extractFaqFromFile(p, BETA), FAQ_BETA);
});

test('fix-faq-locales: replaceFaqInFile scrive SOLO la .faq del proprio id', (t) => {
  const p = fileTemporaneo(t, `${ALPHA}.ts`, DUE_FAQ);
  fixLocales.replaceFaqInFile(p, FAQ_NUOVA);
  const dopo = fs.readFileSync(p, 'utf-8');
  assert.deepEqual(faqDiId(dopo, ALPHA), FAQ_NUOVA);
  assert.deepEqual(faqDiId(dopo, BETA), FAQ_BETA, 'la .faq di beta-due e stata sovrascritta');
  assert.ok(dopo.includes(faqLine(BETA, FAQ_BETA)), 'la riga di beta-due deve restare byte per byte');
});

// ── repair-prompt-placeholders.mjs ───────────────────────────────────────────
//
// Lo script e' tutto a top level (non ha una guardia sull'entry point: importarlo
// lo ESEGUE sul corpus reale), quindi le due meta' ancorate vivono nella lib che
// gia' importa — `lib/prompt-placeholder-guard.mjs` — ed e' li' che si provano.
// L'id lo conosce dal nome del file body (`name.slice(0, -3)`), ed e' lo stesso
// per i quattro locali.

test('repair: faqPresentForId non vede la .faq di un ALTRO id', () => {
  assert.equal(faqPresentForId(SOLO_FAQ_BETA, ALPHA), false);
  assert.equal(faqPresentForId(SOLO_FAQ_BETA, BETA), true);
});

test('repair: faqPresentForId ignora il sentinella __DROP_FAQ__', () => {
  const src = bodyFile(bodyLine(ALPHA), `    'blog.article.${ALPHA}.faq': '__DROP_FAQ__',`, bodyLine(BETA), faqLine(BETA, FAQ_BETA));
  assert.equal(faqPresentForId(src, ALPHA), false, '__DROP_FAQ__ e assenza di FAQ, non presenza');
  assert.equal(faqPresentForId(src, BETA), true);
});

test('repair: faqLineRe toglie SOLO la riga .faq del proprio id', () => {
  const dropped = [];
  const dopo = DUE_FAQ.replace(faqLineRe(ALPHA), (_m, raw) => { dropped.push(raw); return ''; });
  assert.equal(dropped.length, 1);
  assert.deepEqual(JSON.parse(dropped[0]), FAQ_ALPHA);
  assert.equal(faqDiId(dopo, ALPHA), null, 'la riga di alpha-uno doveva sparire');
  assert.ok(dopo.includes(faqLine(BETA, FAQ_BETA)), 'la riga di beta-due deve restare byte per byte');
});

test('repair: faqLineRe toglie OGNI duplicato dello stesso id', () => {
  const src = bodyFile(bodyLine(ALPHA), faqLine(ALPHA, FAQ_ALPHA), faqLine(ALPHA, FAQ_NUOVA), faqLine(BETA, FAQ_BETA));
  const dropped = [];
  const dopo = src.replace(faqLineRe(ALPHA), (_m, raw) => { dropped.push(raw); return ''; });
  assert.equal(dropped.length, 2, 'una chiave duplicata e viva al render: vanno tolte tutte');
  assert.ok(dopo.includes(faqLine(BETA, FAQ_BETA)));
});

test("repair: un id con caratteri di regex non allarga il match", () => {
  // Nessun id del corpus li contiene, ma l'escaping e' meta' del pattern di
  // riferimento (#294): senza, un id costruito matcherebbe altre chiavi.
  const src = bodyFile(`    'blog.article.a.c.faq': '${JSON.stringify(FAQ_ALPHA)}',`, faqLine('abc', FAQ_BETA));
  assert.equal(faqPresentForId(src, 'a.c'), true);
  const dopo = src.replace(faqLineRe('a.c'), '');
  assert.ok(dopo.includes(faqLine('abc', FAQ_BETA)), "l'id 'a.c' non deve matchare 'abc'");
});

// ── Il cablaggio: le funzioni ancorate vanno CHIAMATE con l'id ───────────────
//
// Le prove sopra vivono nella lib; questa e' la meta' che tiene lo script
// attaccato ad esse. `repair-prompt-placeholders.mjs` non e' importabile
// (esegue), quindi qui si legge il sorgente — l'unico modo di vedere che
// l'ancoraggio e' quello che gira davvero e non un'ancora ferma nella lib.
test('repair: lo script passa l id alle due funzioni ancorate', () => {
  // `assert.ok` e non `assert.match`: il messaggio di `match` stampa i 25 KB
  // dello script a ogni fallimento e seppellisce l'esito degli altri test.
  const src = fs.readFileSync(path.join(QUI, '..', 'scripts', 'repair-prompt-placeholders.mjs'), 'utf-8');
  assert.ok(/faqStateOf\(path\.join\(ROOT, 'content', dir, l, name\), id\)/.test(src), 'faqStateOf va chiamata con l id dell articolo');
  assert.ok(/faqLineRe\(id\)/.test(src), 'la potatura va fatta con faqLineRe(id)');
  assert.ok(
    !/'blog\\\.article\\\.\[\^'\]\+\\\.faq'\\s\*:\\s\*'\(\(\?:/.test(src),
    'regex .faq non ancorata all id rimasta nello script',
  );
});
