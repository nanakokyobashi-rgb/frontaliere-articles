/**
 * convention-date-ground-truth.test.mjs — la Convenzione del 9 marzo 1976.
 *
 * La Convenzione Italia-Svizzera contro le doppie imposizioni e' stata
 * conclusa il 9 marzo 1976 (RS 0.672.945.41, «Convenzione del 9 marzo 1976»,
 * https://www.fedlex.admin.ch/eli/cc/1979/461_461_461/it). Il generatore
 * dettava ai modelli «9 DICEMBRE 1976 (NON marzo)» in quattro prompt e il gate
 * di `assertNoFabricatedReferences` bocciava la data giusta: la run
 * 36029664367 ha perso ogni tentativo su un corpo corretto, e il feedback del
 * retry chiedeva di scrivere la data sbagliata.
 *
 * Pinna le due meta': il predicato rifiuta il 9 dicembre e accetta il 9 marzo,
 * e nessuna riga di `create-article.mjs` torna a dettare la data sbagliata.
 * `create-article.mjs` non si importa sotto `node --test` (vedi
 * evergreen-brief-section-aware.test.mjs), quindi il sorgente si legge come
 * testo e lo si passa allo stesso predicato che usa il gate.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { mentionsWrongConventionDate, CONVENTION_DATE_IT } from '../scripts/lib/article-factuality-gates.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CREATE_ARTICLE = path.resolve(HERE, '../scripts/create-article.mjs');
const FABRICATION_GUARD = path.resolve(HERE, 'article-fabrication-guard.test.mjs');

test('il predicato rifiuta il 9 dicembre 1976 accanto a «Convenzione», scritto o numerico', () => {
  for (const text of [
    'La Convenzione italo-svizzera contro le doppie imposizioni, firmata il 9 dicembre 1976, resta in vigore.',
    'Firmata il 9 Dicembre 1976, la Convenzione regola il credito d\'imposta.',
    'Convenzione doppie imposizioni: 09/12/1976',
    'Convenzione IT-CH del 9.12.1976',
  ]) {
    assert.equal(mentionsWrongConventionDate(text), true, text);
  }
});

test('il predicato accetta la data giusta e non scatta fuori contesto', () => {
  for (const text of [
    'La Convenzione italo-svizzera contro le doppie imposizioni del 9 marzo 1976 resta in vigore.',
    'Convenzione doppie imposizioni: 9/3/1976',
    // Un altro giorno di dicembre non e' la data della Convenzione.
    'La Convenzione citata nel verbale del 19 dicembre 1976.',
    // Prossimita' sulla stessa riga, come gli altri controlli italiani.
    'Il 9 dicembre 1976 e\' una data qualunque.\nLa Convenzione e\' del 9 marzo 1976.',
  ]) {
    assert.equal(mentionsWrongConventionDate(text), false, text);
  }
  assert.equal(mentionsWrongConventionDate(undefined), false);
  assert.equal(CONVENTION_DATE_IT, '9 marzo 1976');
});

test('create-article.mjs non detta piu\' la data sbagliata e il gate usa il predicato', () => {
  const src = readFileSync(CREATE_ARTICLE, 'utf-8');
  const offenders = src.split('\n')
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => mentionsWrongConventionDate(line) || /DICEMBRE\s+1976/.test(line));
  assert.deepEqual(offenders, [], 'righe che associano la Convenzione al 9 dicembre 1976');

  // I tre ground truth in prosa (fatti verificati, brief evergreen, regole del
  // writer) piu' la data numerica del fact-checker.
  const correct = src.match(/9\s+marzo\s+1976/gi) || [];
  assert.ok(correct.length >= 3, `attese almeno 3 menzioni del 9 marzo 1976, trovate ${correct.length}`);
  assert.match(src, /Convenzione 9\/3\/1976/);

  assert.match(src, /if \(mentionsWrongConventionDate\(articleText\)\)/);
  assert.doesNotMatch(src, /convenzione\.\*9\\s\+marzo\\s\+1976/i, 'il vecchio pattern invertito e\' tornato');
});

test('la guardia del corpus non rifiuta il 9 marzo 1976', () => {
  const src = readFileSync(FABRICATION_GUARD, 'utf-8');
  assert.doesNotMatch(src, /marzo\\s\+1976/, 'article-fabrication-guard rifiuterebbe la data giusta');
});
