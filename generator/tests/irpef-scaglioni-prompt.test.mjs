/**
 * irpef-scaglioni-prompt.test.mjs — issue #1777.
 *
 * Il fact-check LLM (`llmFactCheck`, create-article.mjs) confrontava ogni
 * aliquota con «IRPEF 23%/35%/43%» e marcava `critical` ogni divergenza. Dal
 * periodo d'imposta 2026 il secondo scaglione e' al 33% (Legge 199/2025,
 * art. 1 c. 3): un articolo corretto veniva quindi bloccato, e il brief di
 * generazione (EVERGREEN_FACTS_BRIEF) spingeva il writer verso il valore
 * superato.
 *
 * Pinna tre cose:
 *   1. la sorgente unica (lib/irpef-scaglioni.mjs) dice 33% dal 2026 e 35%
 *      per il 2024-2025, distinguendo gli anni;
 *   2. create-article.mjs non scrive piu' a mano nessuna aliquota IRPEF: ogni
 *      riga che nomina l'IRPEF con una percentuale del triplo la prende dalla
 *      lib (altrimenti al prossimo cambio le copie divergono di nuovo);
 *   3. i tre prompt RENDERIZZATI (foglio del fact-check, criteri 3 e 4, brief
 *      evergreen) citano 23%/33%/43% per il 2026 e nominano il 35% solo
 *      accanto al periodo 2024-2025.
 *
 * Estrae i template invece di importare create-article.mjs: il modulo tira
 * l'intero albero del generatore (stessa ragione di
 * evergreen-brief-section-aware.test.mjs). I template vengono valutati con gli
 * STESSI export della lib che il modulo importa.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as IRPEF from '../scripts/lib/irpef-scaglioni.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CREATE_ARTICLE = path.resolve(HERE, '../scripts/create-article.mjs');
const SRC = readFileSync(CREATE_ARTICLE, 'utf-8');

function renderTemplate(raw) {
  const names = Object.keys(IRPEF);
  // eslint-disable-next-line no-new-func
  return new Function(...names, `return \`${raw}\`;`)(...names.map((k) => IRPEF[k]));
}

function extractConstTemplate(name) {
  const open = `const ${name} = \``;
  const start = SRC.indexOf(open);
  assert.ok(start !== -1, `${name} non trovato in create-article.mjs — aggiornare i delimitatori`);
  const bodyStart = start + open.length;
  const end = SRC.indexOf('`;', bodyStart);
  assert.ok(end !== -1, `fine di ${name} non trovata — aggiornare i delimitatori`);
  return SRC.slice(bodyStart, end);
}

function extractPromptLine(marker) {
  const lines = SRC.split('\n').filter((l) => l.includes(marker));
  assert.equal(lines.length, 1, `riga del prompt «${marker}» non trovata (o duplicata) in create-article.mjs`);
  return lines[0];
}

const RATE_2026 = '23%/33%/43%';
const RATE_2025 = '23%/35%/43%';

test('sorgente unica: 33% dal 2026, 35% nel 2024-2025, limiti invariati', () => {
  assert.equal(IRPEF.IRPEF_ANNO_CORRENTE, 2026);
  assert.equal(IRPEF.irpefAliquoteBreve(2026), RATE_2026);
  assert.equal(IRPEF.irpefAliquoteBreve(2027), RATE_2026);
  assert.equal(IRPEF.irpefAliquoteBreve(2025), RATE_2025);
  assert.equal(IRPEF.irpefAliquoteBreve(2024), RATE_2025);
  assert.equal(IRPEF.irpefScaglioniTesto(2026), "23% fino €28'000, 33% €28'001–€50'000, 43% oltre €50'000");
  assert.equal(IRPEF.irpefScaglioniTesto(2025), "23% fino €28'000, 35% €28'001–€50'000, 43% oltre €50'000");
  assert.match(IRPEF.IRPEF_FONTE_CORRENTE, /Legge 199\/2025/);
  assert.throws(() => IRPEF.irpefScaglioniPer(2023), RangeError, 'prima del 2024 gli scaglioni erano quattro: non inventarli');
});

test('create-article.mjs non scrive a mano aliquote IRPEF del triplo 23/33/35/43', () => {
  const offending = SRC.split('\n')
    .map((l, i) => ({ n: i + 1, l }))
    .filter(({ l }) => /IRPEF/.test(l) && /\b(?:23|33|35|43) ?%/.test(l));
  assert.deepEqual(
    offending.map(({ n, l }) => `${n}: ${l.trim().slice(0, 120)}`),
    [],
    'aliquota IRPEF hard-coded: interpolala da lib/irpef-scaglioni.mjs',
  );
});

/** Ogni «35%» del testo renderizzato deve stare nella stessa frase del periodo 2024-2025. */
function assert35OnlyAs2025(text, label) {
  for (const line of text.split('\n')) {
    if (!/\b35 ?%/.test(line)) continue;
    assert.match(line, /2024[-–]2025/, `${label}: 35% citato senza il periodo 2024-2025 → «${line.trim()}»`);
  }
}

test('foglio VERIFIED_DOMAIN_FACTS: scaglioni 2026 con fonte, 2024-2025 marcati come tali', () => {
  const facts = renderTemplate(extractConstTemplate('VERIFIED_DOMAIN_FACTS'));
  assert.ok(facts.includes("IRPEF dal periodo d'imposta 2026: 23% fino €28'000, 33% €28'001–€50'000"), facts);
  assert.ok(facts.includes('Legge 199/2025'));
  assert.ok(facts.includes("IRPEF periodi d'imposta 2024-2025: 23% fino €28'000, 35%"));
  assert35OnlyAs2025(facts, 'VERIFIED_DOMAIN_FACTS');
});

test('criteri 3 e 4 del fact-check: IRPEF 2026 = 23%/33%/43%', () => {
  const c3 = renderTemplate(extractPromptLine('**ALIQUOTE E CIFRE FISCALI**'));
  const c4 = renderTemplate(extractPromptLine('**STATISTICHE E PERCENTUALI**'));
  assert.ok(c3.includes(`IRPEF 2026 ${RATE_2026}`), c3);
  assert.ok(c4.includes(`IRPEF ${RATE_2026}`), c4);
  assert35OnlyAs2025(c3, 'criterio 3');
  assert35OnlyAs2025(c4, 'criterio 4');
});

test('EVERGREEN_FACTS_BRIEF: il writer vede gli scaglioni 2026', () => {
  const brief = renderTemplate(extractConstTemplate('EVERGREEN_FACTS_BRIEF'));
  assert.ok(brief.includes("IRPEF italiana dal 2026: 23% fino €28'000, 33% €28'001–€50'000, 43% oltre €50'000"), brief);
  assert35OnlyAs2025(brief, 'EVERGREEN_FACTS_BRIEF');
});
