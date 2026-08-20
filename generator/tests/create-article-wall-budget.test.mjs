/**
 * create-article-wall-budget.test.mjs — il floor interno non deve rialzare un
 * cap esplicito sotto il default (review PR #515, follow-up di #462).
 *
 * IL DIFETTO. #462 ha aggiunto l'export di `CREATE_ARTICLE_MAX_WALL_MS` da
 * `generate-article.yml` (il cap di sezione reale, meno la grazia di 60s di
 * `timeout --kill-after`). Ma `RUN_WALL_BUDGET_MS` in create-article.mjs
 * applicava `Math.max(5*60_000, valore)` a QUALUNQUE valore, esplicito o no.
 * Per un cap di sezione < 360s l'export scende sotto 300000ms e il floor lo
 * rialza a 5min — il processo torna a credersi piu' libero del kill esterno,
 * la stessa classe di bug di #462 con magnitudo minore. Questa banda e'
 * raggiungibile con i default del workflow (`min_attempt_s = budget_s/16`,
 * quindi ~187s con `budget_s=3000`): sono esattamente gli ultimi tentativi di
 * un run che sta esaurendo budget, i piu' a rischio di kill duro.
 *
 * IL FIX. Il floor di 5min si applica SOLO al percorso di default (env var
 * assente o non parsabile). Un valore esplicito viene onorato com'e'.
 *
 * COME GIRA. Il blocco di calcolo e' ritagliato VERBATIM dal sorgente ed
 * eseguito con `new Function`, iniettando `process.env` mockato — la stessa
 * tecnica di body2-expected-fields.test.mjs: create-article.mjs non e'
 * importabile dalle gate del generatore (niente `npm ci`, niente jsdom).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CREATE_ARTICLE = path.resolve(HERE, '../scripts/create-article.mjs');
const src = readFileSync(CREATE_ARTICLE, 'utf-8');

/** Ritaglia il blocco `const CREATE_ARTICLE_MAX_WALL_MS_ENV = ... : CREATE_ARTICLE_MAX_WALL_MS_PARSED;`. */
function extractWallBudgetBlock() {
  const anchor = 'const CREATE_ARTICLE_MAX_WALL_MS_ENV = process.env.CREATE_ARTICLE_MAX_WALL_MS;';
  const a = src.indexOf(anchor);
  assert.notEqual(a, -1, 'anchor non trovata — aggiornare questo test');
  const tail = ': CREATE_ARTICLE_MAX_WALL_MS_PARSED;';
  const t = src.indexOf(tail, a);
  assert.notEqual(t, -1, 'chiusura del blocco non trovata — aggiornare questo test');
  return src.slice(a, t + tail.length);
}

const WALL_BUDGET_BLOCK = extractWallBudgetBlock();

/** Esegue il blocco ritagliato con `process.env.CREATE_ARTICLE_MAX_WALL_MS` dato, torna RUN_WALL_BUDGET_MS. */
function computeRunWallBudgetMs(envValue) {
  const fn = new Function(
    'process',
    `${WALL_BUDGET_BLOCK}\nreturn RUN_WALL_BUDGET_MS;`,
  );
  const fakeProcess = { env: {} };
  if (envValue !== undefined) fakeProcess.env.CREATE_ARTICLE_MAX_WALL_MS = envValue;
  return fn(fakeProcess);
}

test('un cap esplicito sotto i 5min non viene rialzato dal floor interno (#462 follow-up)', () => {
  // cap=200s dalla shell → export = (200-60)*1000 = 140000ms, in piena banda
  // 187-360s: prima del fix il Math.max lo avrebbe rialzato a 300000.
  assert.equal(computeRunWallBudgetMs('140000'), 140000);
});

test('un cap esplicito appena sopra il vecchio floor resta invariato', () => {
  assert.equal(computeRunWallBudgetMs('300001'), 300001);
});

test('la regressione originale di #462 resta corretta: cap grande onorato per intero', () => {
  // Misura reale del run 32147257594: cap=1184s → export = 1124000ms.
  assert.equal(computeRunWallBudgetMs('1124000'), 1124000);
});

test('senza env var il default resta 30min', () => {
  assert.equal(computeRunWallBudgetMs(undefined), 30 * 60_000);
});

test('un valore non parsabile ricade sul default di 30min, non sul floor di 5min', () => {
  assert.equal(computeRunWallBudgetMs('not-a-number'), 30 * 60_000);
});

test('cap=60 dalla shell esporta "0" esplicito, e "0" non ricade sul default di 30min (review round 2)', () => {
  // cap=60s -> export = (60-60)*1000 = "0". Prima del fix round-2 il
  // `Number.parseInt(...) || 30*60_000` trattava "0" come falsy e ricadeva
  // sul default: il processo si credeva libero 30min mentre l'esterno lo
  // stava per killare in ~60s. Deve restare 0.
  assert.equal(computeRunWallBudgetMs('0'), 0);
});

test('stringa vuota (env var settata senza valore) ricade sul default di 30min', () => {
  assert.equal(computeRunWallBudgetMs(''), 30 * 60_000);
});
