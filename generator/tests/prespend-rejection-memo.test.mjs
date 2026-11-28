/**
 * F3.A.6 — richieste LLM dello stadio `selection`: un "no" del classifier
 * pre-spend non si rispende per 48 h sullo stesso URL.
 * Run with `node --test generator/tests/prespend-rejection-memo.test.mjs`.
 *
 * La prova usa il contatore M4 vero (llm-call-metrics): il classifier finto
 * registra una richiesta provider nello stadio `selection`, come fa quello di
 * create-article.mjs (non importabile in un test).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getLlmProviderRequestsByStage,
  recordLlmProviderRequest,
  resetLlmProviderRequests,
  withLlmCallStage,
} from '../scripts/lib/llm-call-metrics.mjs';
import { TOPIC_GATE_URL_TTL_MS } from '../scripts/lib/article-topic-selector.mjs';
import {
  classifyWithRejectionMemo,
  isDefinitiveRejection,
  recordPrespendRejectedUrls,
} from '../scripts/lib/prespend-rejection-memo.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NOW = Date.parse('2026-11-28T10:00:00Z');
const norm = (u) => u.replace(/\?.*$/, '');
const runAll = (items, fn) => Promise.all(items.map(fn));
const POOL = Array.from({ length: 10 }, (_, i) => ({ url: `https://esempio.ch/n/${i}?utm=x` }));

// Il classifier finto: gli URL pari sono "no" definitivi, il 3 e' un fail-open.
const classify = async (item) => withLlmCallStage('selection', async () => {
  recordLlmProviderRequest();
  const n = Number(item.url.match(/n\/(\d+)/)[1]);
  if (n === 3) return { relevant: true, reason: 'classifier-error', fromError: true };
  return n % 2 === 0 ? { relevant: false, reason: 'fuori tema', parsed: true } : { relevant: true, parsed: true };
});

async function run(tracker, extra = {}) {
  resetLlmProviderRequests();
  const out = await classifyWithRejectionMemo(POOL, {
    tracker, section: 'svizzera', normalizeUrl: norm, classify, runAll, now: NOW, ...extra,
  });
  return { ...out, selection: getLlmProviderRequestsByStage().selection };
}

test('secondo run sullo stesso pool: le richieste di selezione scendono dei soli "no" definitivi', async () => {
  const first = await run({});
  assert.equal(first.selection, 10, 'prima: ogni candidato costa una richiesta');
  assert.equal(first.memoHits, 0);
  assert.equal(first.newRejections.length, 5, 'i 5 pari sono verdetti definitivi');

  const tracker = recordPrespendRejectedUrls({}, first.newRejections, 'svizzera', NOW);
  const second = await run(tracker);
  assert.equal(second.selection, 5, 'dopo: i 5 "no" non si rispendono, i "si" e il fail-open si');
  assert.equal(second.memoHits, 5);
  assert.deepEqual(second.verdicts.map((v) => v.relevant), first.verdicts.map((v) => v.relevant),
    'stessi verdetti: il gate non cambia, cambia solo la spesa');
});

test('il memo scade a 48 h, e vale solo per la sezione che ha rifiutato', async () => {
  const tracker = recordPrespendRejectedUrls({}, POOL.map((p) => norm(p.url)), 'svizzera', NOW);
  assert.equal((await run(tracker)).selection, 0);
  assert.equal((await run(tracker, { now: NOW + TOPIC_GATE_URL_TTL_MS })).selection, 10);
  assert.equal((await run(tracker, { section: 'frontaliere' })).selection, 10);
});

test('canReuse=false (corpo CMS cantonale verificato) riclassifica', async () => {
  const tracker = recordPrespendRejectedUrls({}, POOL.map((p) => norm(p.url)), 'svizzera', NOW);
  assert.equal((await run(tracker, { canReuse: () => false })).selection, 10);
});

test('i fail-open e gli esiti del memo non vengono mai ricordati', () => {
  assert.equal(isDefinitiveRejection({ relevant: false, fromError: true }), false);
  assert.equal(isDefinitiveRejection({ relevant: true }), false);
  assert.equal(isDefinitiveRejection({ relevant: false, memo: true }), false);
  assert.equal(isDefinitiveRejection({ relevant: false, parsed: true }), true);
});

test('il memo non interferisce col memo del topic-gate (chiavi disgiunte) e il cablaggio e\' presente', () => {
  const t = recordPrespendRejectedUrls({}, ['https://esempio.ch/n/0'], 'svizzera', NOW);
  const keys = Object.keys(t.topicGateUrls);
  assert.deepEqual(keys, ['svizzera::prespend-relevance:https://esempio.ch/n/0']);
  const src = readFileSync(path.join(HERE, '../scripts/create-article.mjs'), 'utf8');
  assert.match(src, /_classifyWithRejectionMemo\(/);
  assert.match(src, /newRejections\.length > 0 && !DRY_RUN_SCAN/, 'il dry-run-scan non scrive stato');
});
