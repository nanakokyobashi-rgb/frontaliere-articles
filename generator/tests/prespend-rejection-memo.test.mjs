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
import {
  PRESPEND_RELEVANCE_URL_MAX,
  TOPIC_GATE_URL_MAX,
  TOPIC_GATE_URL_TTL_MS,
  isTopicGateAbortedUrl,
  recordTopicGateAbortedUrl,
} from '../scripts/lib/article-topic-selector.mjs';
import {
  classifyWithRejectionMemo,
  contentFingerprint,
  isPrespendRejectedUrl,
  memoUrlKey,
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
  // F3.A.6 r3: il "no" incerto (confidenza <= 0,5 non confermata) non e' definitivo.
  assert.equal(isDefinitiveRejection({ relevant: false, parsed: true, confidence: 0.2, uncertain: true }), false);
});

test('il memo non interferisce col memo del topic-gate (chiavi disgiunte) e il cablaggio e\' presente', () => {
  const t = recordPrespendRejectedUrls({}, ['https://esempio.ch/n/0'], 'svizzera', NOW);
  const keys = Object.keys(t.topicGateUrls);
  assert.deepEqual(keys, ['svizzera::prespend-relevance:https://esempio.ch/n/0']);
  const src = readFileSync(path.join(HERE, '../scripts/create-article.mjs'), 'utf8');
  assert.match(src, /_classifyWithRejectionMemo\(/);
  assert.match(src, /newRejections\.length > 0 && !DRY_RUN_SCAN/, 'il dry-run-scan non scrive stato');
});

test('un "no" incerto non viene memorizzato: il run dopo riclassifica', async () => {
  const uncertain = async (item) => withLlmCallStage('selection', async () => {
    recordLlmProviderRequest();
    return { relevant: false, parsed: true, confidence: 0.2, uncertain: true };
  });
  const first = await run({}, { classify: uncertain });
  assert.deepEqual(first.newRejections, []);
  const tracker = recordPrespendRejectedUrls({}, first.newRejections, 'svizzera', NOW);
  assert.equal((await run(tracker)).selection, 10);
});

test('la chiave include un hash di titolo+sommario: una notizia aggiornata sullo stesso URL si rivaluta', async () => {
  const items = POOL.map((p, i) => ({ ...p, title: `Titolo ${i}`, summary: 'Sommario' }));
  const fp = (item) => contentFingerprint(item.title, item.summary);
  const runItems = async (list, tracker) => {
    resetLlmProviderRequests();
    const out = await classifyWithRejectionMemo(list, {
      tracker, section: 'svizzera', normalizeUrl: norm, classify, runAll, fingerprint: fp, now: NOW,
    });
    return { ...out, selection: getLlmProviderRequestsByStage().selection };
  };
  const first = await runItems(items, {});
  assert.equal(first.newRejections.length, 5);
  assert.ok(first.newRejections.every((k) => /#[0-9a-f]{8}$/.test(k)), 'la chiave porta l\'hash');
  const tracker = recordPrespendRejectedUrls({}, first.newRejections, 'svizzera', NOW);
  assert.equal((await runItems(items, tracker)).selection, 5, 'stesso contenuto: hit');
  // Maiuscole e spazi non cambiano l'hash.
  assert.equal(contentFingerprint('Titolo  X', 'S'), contentFingerprint('titolo x', ' s '));
  const updated = items.map((it) => ({ ...it, title: `${it.title} - aggiornato` }));
  const after = await runItems(updated, tracker);
  assert.equal(after.selection, 10, 'titolo diverso: nessun hit');
  assert.equal(after.memoHits, 0);
  assert.equal(memoUrlKey('https://a.ch/x', ''), 'https://a.ch/x');
  assert.equal(isPrespendRejectedUrl(tracker, 'https://esempio.ch/n/0', 'svizzera', NOW), false, 'senza hash la chiave non c\'e\'');
});

test('le voci del memo pre-spend hanno un tetto proprio: un abort recente del topic-gate sopravvive a 300+ "no"', () => {
  let tracker = recordTopicGateAbortedUrl({}, 'https://esempio.ch/abort', 'svizzera', NOW - 3_600_000);
  const keys = Array.from({ length: TOPIC_GATE_URL_MAX + 100 }, (_, i) => `https://esempio.ch/no/${i}`);
  tracker = recordPrespendRejectedUrls(tracker, keys, 'svizzera', NOW);
  assert.equal(isTopicGateAbortedUrl(tracker, 'https://esempio.ch/abort', 'svizzera', NOW), true, 'l\'abort di 1 h fa resta');
  assert.equal(isPrespendRejectedUrl(tracker, keys.at(-1), 'svizzera', NOW), true);
  assert.equal(isPrespendRejectedUrl(tracker, keys[0], 'svizzera', NOW), true, 'sotto il tetto proprio nessuna voce e\' persa');
  // Oltre il tetto proprio si pota il piu' vecchio del solo memo.
  const many = Array.from({ length: PRESPEND_RELEVANCE_URL_MAX + 5 }, (_, i) => `https://esempio.ch/m/${i}`);
  const full = recordPrespendRejectedUrls(tracker, many, 'svizzera', NOW);
  assert.equal(isTopicGateAbortedUrl(full, 'https://esempio.ch/abort', 'svizzera', NOW), true);
  assert.equal(Object.keys(full.topicGateUrls).filter((k) => k.includes('::prespend-relevance:')).length, PRESPEND_RELEVANCE_URL_MAX);
  assert.equal(isPrespendRejectedUrl(full, many[0], 'svizzera', NOW), false, 'la voce piu\' vecchia del memo e\' potata');
  assert.equal(isPrespendRejectedUrl(full, many.at(-1), 'svizzera', NOW), true);
  // E il tetto degli abort non e' toccato dal memo: oltre 300 abort il piu' vecchio cade.
  let aborts = {};
  for (let i = 0; i < TOPIC_GATE_URL_MAX + 3; i += 1) aborts = recordTopicGateAbortedUrl(aborts, `https://esempio.ch/a/${i}`, 'svizzera', NOW);
  assert.equal(isTopicGateAbortedUrl(aborts, 'https://esempio.ch/a/0', 'svizzera', NOW), false);
  assert.equal(isTopicGateAbortedUrl(aborts, 'https://esempio.ch/a/3', 'svizzera', NOW), true);
});
