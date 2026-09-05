/**
 * #798 (follow-up di #786, da #768): il floor di plausibilita' sui campi meta.
 *
 * `normalizeItalianContentFromPayload` cerca OGNI campo attraverso TUTTI i
 * candidati (`content[locale]`, `content`, radice del payload) e adotta la
 * prima stringa non vuota. Dopo #768 la ricerca e' per campo, quindi un
 * `title` di tre caratteri parcheggiato alla radice — o un eco del prompt —
 * bastava a far uscire il verdetto `ok`. Sui body il danno moriva a valle,
 * contro `body2<40` e la lunghezza dell'articolo; sui META no: il `title`
 * diventa slug e canonical, e questo repo pubblica senza che il sito ribuildi,
 * quindi l'URL sbagliato e' LIVE subito e non e' rigenerabile.
 *
 * Il file pinna DUE strati, e servono entrambi:
 *
 *   1. che il floor SCATTI — un campo meta implausibile non esce piu' `ok`,
 *      ne' dal verdetto ne' dal gate a valle sull'articolo mergiato;
 *   2. che il floor sia DIMENSIONATO SUL CORPUS PUBBLICATO e non a tavolino:
 *      si scandiscono i `title` e gli `excerpt` italiani realmente pubblicati
 *      e si pretende ZERO offender. Se qualcuno alza la soglia verso la
 *      mediana (title 57, excerpt 138) questo strato cade, ed e' il punto: il
 *      gate deve prendere il moncone, non arbitrare lo stile editoriale.
 *
 * Lo strato 2 ha una soglia di CONTEGGIO MINIMO: uno sparse checkout senza
 * `content/` farebbe passare a vuoto uno scan su zero campi, cioe' esattamente
 * la forma di test che dice verde senza aver guardato niente.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  META_FIELD_PLAUSIBILITY_FLOORS,
  META_ONLY_FIELDS,
  REQUIRED_IT_BODY_FIELDS,
  classifyBody2Payload,
  metaFieldPlausibilityMiss,
} from '../scripts/lib/body2-payload-verdict.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const TITLE_OK = 'Frontalieri e imposta alla fonte: cosa cambia nel 2026';
const EXCERPT_OK = 'Guida pratica alle nuove aliquote per chi lavora in Ticino e risiede in Italia.';
const BODY_OK = 'Un corpo abbastanza lungo da superare la soglia dei quaranta caratteri del verdetto.';

function payloadMeta({ title, excerpt }) {
  return { parsed: { content: { it: { title, excerpt } } }, expectedFields: META_ONLY_FIELDS };
}

// ── 1. Il floor scatte sul verdetto ────────────────────────────────────────

test('un title sotto il floor non esce piu\' ok: e\' un reject con la voce in missing', () => {
  const { verdict, missing } = classifyBody2Payload(payloadMeta({ title: 'abc', excerpt: EXCERPT_OK }));
  assert.equal(verdict, 'reject');
  assert.ok(
    missing.includes(`title<${META_FIELD_PLAUSIBILITY_FLOORS.title.minChars}`),
    `atteso title<${META_FIELD_PLAUSIBILITY_FLOORS.title.minChars}, ricevuto ${missing.join(', ')}`,
  );
});

test('la forma di #798: il title corto parcheggiato alla RADICE non diventa slug', () => {
  // Il caso misurato: `content.it` vuoto, i campi adottati dalla radice.
  const { verdict, missing } = classifyBody2Payload({
    parsed: { title: 'abc', excerpt: EXCERPT_OK, content: { it: { title: '', excerpt: '' } } },
    expectedFields: META_ONLY_FIELDS,
  });
  assert.equal(verdict, 'reject');
  assert.deepEqual(missing, [`title<${META_FIELD_PLAUSIBILITY_FLOORS.title.minChars}`]);
});

test('un excerpt sotto il floor non esce ok', () => {
  const { verdict, missing } = classifyBody2Payload(payloadMeta({ title: TITLE_OK, excerpt: 'Boh.' }));
  assert.equal(verdict, 'reject');
  assert.ok(missing.some((m) => m.startsWith('excerpt<')), `ricevuto ${missing.join(', ')}`);
});

test('una parola sola lunga non e\' un titolo, anche se supera il floor sui caratteri', () => {
  const unaParola = 'Frontalierifrontalieri';
  assert.ok(unaParola.length >= META_FIELD_PLAUSIBILITY_FLOORS.title.minChars);
  const { verdict, missing } = classifyBody2Payload(payloadMeta({ title: unaParola, excerpt: EXCERPT_OK }));
  assert.equal(verdict, 'reject');
  assert.ok(missing.includes(`title<${META_FIELD_PLAUSIBILITY_FLOORS.title.minWords}w`), missing.join(', '));
});

test('campi meta plausibili restano ok', () => {
  const { verdict, missing } = classifyBody2Payload(payloadMeta({ title: TITLE_OK, excerpt: EXCERPT_OK }));
  assert.deepEqual(missing, []);
  assert.equal(verdict, 'ok');
});

test('il campo VUOTO resta segnalato come mancante, non come corto', () => {
  // Duplicare l'assenza col floor nasconderebbe il motivo vero nel log.
  const { verdict, missing } = classifyBody2Payload(payloadMeta({ title: '', excerpt: EXCERPT_OK }));
  assert.equal(verdict, 'reject');
  assert.deepEqual(missing, ['title']);
});

test('sulla meta\' body dello split il floor meta non scatta: quei campi non sono chiesti', () => {
  const { verdict, missing } = classifyBody2Payload({
    parsed: { content: { it: { body1: BODY_OK, body2: BODY_OK, body3: BODY_OK } } },
    expectedFields: ['body1', 'body2', 'body3'],
  });
  assert.deepEqual(missing, []);
  assert.equal(verdict, 'ok');
});

test('metaFieldPlausibilityMiss non giudica i campi che non ha dimensionato', () => {
  for (const field of REQUIRED_IT_BODY_FIELDS.filter((f) => !META_ONLY_FIELDS.includes(f))) {
    assert.equal(metaFieldPlausibilityMiss(field, 'x'), null, `${field} non ha un floor meta`);
  }
  assert.equal(metaFieldPlausibilityMiss('title', undefined), null);
  assert.equal(metaFieldPlausibilityMiss('title', 42), null);
});

// ── 2. Il gate a valle sull'articolo MERGIATO porta lo stesso floor ────────

test('validateItalianPayload importa il floor invece di ricopiarlo', () => {
  // `create-article.mjs` non e' importabile dai test (tira dentro jsdom via
  // extract-article-text.mjs, e le gate girano senza `npm ci`), quindi il
  // legame si verifica sul testo — stessa tecnica di split-merge-abort-flag.
  const src = fs.readFileSync(path.join(REPO, 'generator/scripts/create-article.mjs'), 'utf8');
  const gate = src.slice(src.indexOf('function validateItalianPayload('));
  assert.ok(gate.includes('metaFieldPlausibilityMiss('), 'il gate a valle non applica il floor sui campi meta');
  assert.ok(
    /import \{[^}]*\bmetaFieldPlausibilityMiss\b[^}]*\} from '\.\/lib\/body2-payload-verdict\.mjs'/.test(src),
    'metaFieldPlausibilityMiss va importato dal verdetto, non ridefinito (AGENTS.md #6)',
  );
  assert.ok(
    /troppo corto per \$\{locale\}/.test(gate.slice(0, gate.indexOf('\n}\n'))),
    'il messaggio deve contenere «troppo corto», che isQualityRejectError() riconosce',
  );
});

// ── 3. Il floor sta sotto il corpus PUBBLICATO ────────────────────────────

const META_FILES = ['content/blog-meta-it.ts', 'content/blog-meta-ch-it.ts'];
// Il corpus italiano pubblicato al 2026-09-05 porta 5.658 title e 5.658
// excerpt. Un ordine di grandezza sotto significa che lo scan sta guardando un
// checkout parziale: meglio fallire che dire verde senza aver letto niente.
const CONTEGGIO_MINIMO = 4000;

function raccogliCampo(suffix) {
  const valori = [];
  const re = new RegExp(`\\.${suffix}':\\s*'((?:[^'\\\\]|\\\\.)*)'`, 'g');
  for (const rel of META_FILES) {
    const file = path.join(REPO, rel);
    if (!fs.existsSync(file)) continue;
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(re)) valori.push(m[1].replace(/\\(.)/g, '$1'));
  }
  return valori;
}

for (const field of META_ONLY_FIELDS) {
  test(`il floor ${field} non rigetta nessun ${field} gia' pubblicato`, () => {
    const valori = raccogliCampo(field).map((v) => v.trim()).filter(Boolean);
    assert.ok(
      valori.length >= CONTEGGIO_MINIMO,
      `letti solo ${valori.length} ${field} da ${META_FILES.join(' + ')}: lo scan non sta guardando il corpus`,
    );
    const offender = valori
      .map((v) => [v, metaFieldPlausibilityMiss(field, v)])
      .filter(([, miss]) => miss !== null);
    assert.deepEqual(
      offender.slice(0, 5),
      [],
      `il floor ${field} (${JSON.stringify(META_FIELD_PLAUSIBILITY_FLOORS[field])}) rigetterebbe ${offender.length} campi REALI del corpus`,
    );
  });
}
