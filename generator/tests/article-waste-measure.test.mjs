/**
 * Misura prima/dopo di generator/scripts/measure-article-waste.mjs: gli eventi
 * delle sei run di generate-article del 2026-09-29 ripassati dal codice di
 * questa HEAD. La quota di salvataggio del body1 si inietta, cosi' il test non
 * dipende dai 4000 body di `content/` (lo script la misura su di essi).
 * Run with `node --test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  earlyDuplicateGateBeforeFactCheck,
  measureArticleWaste,
} from '../scripts/measure-article-waste.mjs';

test('il gate anticipato dei duplicati sta prima del fact-check nel sorgente', () => {
  assert.equal(earlyDuplicateGateBeforeFactCheck(), true);
});

test('PRIMA: 933 s negli eventi delle sei run; DOPO senza salvataggi del body1: 620 s', () => {
  const { rows, total } = measureArticleWaste({ salvage: { rate: 0 } });
  assert.equal(total.before, 933);
  assert.equal(total.after, 620);
  const r = rows.find((x) => x.run === 36514673677);
  assert.equal(r.repeatAborts, 5, 'cinque URL gia\' scartati 45 minuti prima nella stessa sezione');
  const d = rows.find((x) => x.run === 36519078323);
  assert.equal(d.duplicates, 3);
  assert.equal(d.after, d.before - 105, 'i 105 s dopo il corpo non si pagano piu\'');
});

test('ogni body1 salvato toglie la sua rigenerazione, 184 s', () => {
  assert.equal(measureArticleWaste({ salvage: { rate: 1 } }).total.after, 620 - 184);
});

test('senza il gate anticipato i duplicati restano pagati', () => {
  assert.equal(measureArticleWaste({ salvage: { rate: 0 }, earlyGate: false }).total.after, 620 + 105);
});
