/**
 * frontalieri-ticino-fact-parity.test.mjs — E-E-A-T P0 (sito: services/seo/keyFacts.ts).
 *
 * Il numero dei frontalieri e la loro quota sugli occupati vivono in due
 * blocchi letterali di create-article.mjs: `VERIFIED_DOMAIN_FACTS` (foglio del
 * fact-checker) e `EVERGREEN_FACTS_BRIEF` (brief di generazione). Altri test
 * ritagliano quei blocchi dal sorgente, quindi la riga non puo' essere
 * interpolata da una costante: questo test li tiene identici fra loro e
 * allineati ai valori del sito (USTAT, Notiziario statistico 2026-18).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.resolve(HERE, '../scripts/create-article.mjs'), 'utf-8');

function block(open) {
  const start = src.indexOf(open);
  assert.ok(start !== -1, `${open} non trovato`);
  const body = start + open.length;
  return src.slice(body, src.indexOf('`;', body));
}

const factLine = (text) => text.split('\n').find((l) => l.startsWith('- Frontalieri in Ticino:'))?.replace(/\.$/, '');

test('fact-checker e brief evergreen dichiarano la stessa riga sui frontalieri in Ticino', () => {
  const sheet = factLine(block('const VERIFIED_DOMAIN_FACTS = `'));
  const brief = factLine(block('const EVERGREEN_FACTS_BRIEF = `'));
  assert.ok(sheet, 'riga frontalieri assente da VERIFIED_DOMAIN_FACTS');
  assert.equal(brief, sheet);
});

test('la riga usa i valori USTAT del sito (circa 79\'000, 32%) e non la quota storica', () => {
  const sheet = factLine(block('const VERIFIED_DOMAIN_FACTS = `'));
  assert.match(sheet, /79'000/);
  assert.match(sheet, /32%/);
  assert.doesNotMatch(sheet, /30%|2[-–]3%/);
});
