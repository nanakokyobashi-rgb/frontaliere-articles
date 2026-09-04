/**
 * split-merge-abort-flag.test.mjs — `abort_topical_relevance`/`reason` della
 * chiamata 2/2 non devono sopravvivere al merge dello split (#829).
 *
 * IL DIFETTO. Il merge delle due meta' partiva da `const merged = { ...metaData,
 * ... }`. La meta' `meta` non dovrebbe portare il flag di REGOLA #0 — lo schema
 * `article_metadata_only` non lo dichiara e il prompt della 2/2 non nomina
 * nemmeno il gate — ma la forma che i provider ricevono e' permissiva
 * (`sanitizeSchemaForGemini` toglie `additionalProperties: false`), quindi il
 * modello puo' emetterlo lo stesso. Propagato dentro `merged`, a valle il gate
 * lo rileggeva su un payload il cui CORPO viene dalla 1/2:
 * `isTopicGateAbortVerdict(itData)` e' falso, quindi il ramo preso era quello
 * di auto-contraddizione — «contract violation, trusting content over the
 * flag» piu' `RUN_REPORT.topicGateSelfContradictions++` — per una meta' che il
 * flag non doveva emettere. Il contatore contava non-casi, e li contava DUE
 * volte quando l'auto-contraddizione vera era della 1/2 (gia' contata li').
 *
 * IL FIX. Il merge esclude le due chiavi dallo spread di `metaData`, come gia'
 * faceva per le sottochiavi di `content` con `META_CONTENT_KEYS`. Un abort VERO
 * non passa di qui: quando la 1/2 aborta, `_generateSplit` torna
 * `JSON.stringify(bodyData)` senza fare la 2/2.
 *
 * COME GIRA. Il blocco del merge e' ritagliato VERBATIM dal sorgente ed
 * eseguito con `new Function` — la stessa tecnica di
 * create-article-wall-budget.test.mjs e news-prompt-token-budget.test.mjs:
 * create-article.mjs non e' importabile dalle gate del generatore (niente
 * `npm ci`). Cosi' il comportamento misurato e' quello vero, non una copia.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  META_ONLY_FIELDS,
  BODY_ONLY_FIELDS,
  recoverMisplacedFaq,
  normalizeItalianContentFromPayload,
  isTopicGateAbortVerdict,
} from '../scripts/lib/body2-payload-verdict.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.resolve(HERE, '../scripts/create-article.mjs'), 'utf-8');

/** Ritaglia il blocco del merge, da `META_CONTENT_KEYS` fino a `merged`. */
function extractMergeBlock() {
  const anchor = "const META_CONTENT_KEYS = [...META_ONLY_FIELDS, 'faq'];";
  const a = src.indexOf(anchor);
  assert.notEqual(a, -1, 'anchor `META_CONTENT_KEYS` non trovata — aggiornare questo test');
  const tail = 'return JSON.stringify(merged);';
  const t = src.indexOf(tail, a);
  assert.notEqual(t, -1, 'chiusura del merge non trovata — aggiornare questo test');
  return src.slice(a, t);
}

const MERGE_BLOCK = extractMergeBlock();

const DEPS = [
  'metaData', 'bodyData', 'bodyContent', 'metaBlock', 'primaryLocale',
  'META_ONLY_FIELDS', 'BODY_ONLY_FIELDS', 'recoverMisplacedFaq',
];
const runMerge = new Function(...DEPS, `${MERGE_BLOCK}\nreturn merged;`);

const CORPO = 'x'.repeat(600);

/** Esegue il merge con la 1/2 «buona» e la 2/2 data. */
function mergeWith(metaData, { bodyData = {}, bodyContent } = {}) {
  const body = bodyContent || { body1: CORPO, body2: CORPO, body3: CORPO };
  const metaBlock = normalizeItalianContentFromPayload(metaData, 'it', META_ONLY_FIELDS);
  return runMerge(
    metaData, bodyData, body, metaBlock, 'it',
    META_ONLY_FIELDS, BODY_ONLY_FIELDS, recoverMisplacedFaq,
  );
}

const META_BUONA = {
  id: 'un-articolo', category: 'lavoro', image: 'lugano.webp',
  hasCalculator: false, imagePrompt: 'p', imageAlt: { it: 'a' },
  slugs: { it: 'un-articolo' }, seo: { title: 'T' },
  content: { it: { title: 'Titolo', excerpt: 'Sommario' } },
};

test('il flag di abort emesso dalla 2/2 non entra in `merged`', () => {
  const merged = mergeWith({
    ...META_BUONA,
    abort_topical_relevance: true,
    reason: 'la fonte non riguarda i frontalieri',
  });
  assert.equal('abort_topical_relevance' in merged, false,
    '`abort_topical_relevance` della 2/2 sopravvive al merge: a valle diventa una falsa auto-contraddizione (#829)');
  assert.equal('reason' in merged, false,
    '`reason` della 2/2 sopravvive al merge: e\' la meta\' dell\'abort, e senza flag non descrive piu\' niente');
});

test('anche i valori NON-`true` del flag vengono tolti, non solo `true`', () => {
  for (const valore of [false, null, 'no', 0, {}]) {
    const merged = mergeWith({ ...META_BUONA, abort_topical_relevance: valore, reason: 'r' });
    assert.equal('abort_topical_relevance' in merged, false,
      `flag=${JSON.stringify(valore)} sopravvive: lo strip deve essere sulla CHIAVE, non sul valore`);
    assert.equal('reason' in merged, false, `reason sopravvive con flag=${JSON.stringify(valore)}`);
  }
});

test('a valle il ramo di auto-contraddizione non scatta piu\' su un merge dello split', () => {
  const merged = mergeWith({
    ...META_BUONA,
    abort_topical_relevance: true,
    reason: 'la fonte non riguarda i frontalieri',
  });
  // La coppia di condizioni del gate di valle (`REGOLA #0 abort gate` in
  // create-article.mjs): flag stretto `=== true` E abort NON riconosciuto —
  // che era `true` prima del fix, perche' il corpo (dalla 1/2) c'e'.
  const ramoAutoContraddizione = merged.abort_topical_relevance === true
    && !isTopicGateAbortVerdict(merged);
  assert.equal(ramoAutoContraddizione, false,
    'il merge fa ancora scattare «trusting content over the flag» a valle: topicGateSelfContradictions conta un non-caso, e lo conta due volte quando la 1/2 l\'ha gia\' contato');
});

test('NON-VACUITA\': il merge continua a portare tutto il resto della 2/2', () => {
  const merged = mergeWith({ ...META_BUONA, abort_topical_relevance: true, reason: 'r' });
  for (const k of ['id', 'category', 'image', 'hasCalculator', 'imagePrompt', 'imageAlt', 'slugs', 'seo']) {
    assert.ok(k in merged, `lo strip ha portato via anche \`${k}\`: il filtro e' troppo largo`);
  }
  assert.equal(merged.id, 'un-articolo');
  assert.equal(merged.seo.title, 'T');
  assert.equal(merged.content.it.title, 'Titolo');
  assert.equal(merged.content.it.excerpt, 'Sommario');
  // Il corpo della 1/2 sopravvive byte per byte, come prima del fix.
  assert.equal(merged.content.it.body1, CORPO);
  assert.equal(merged.content.it.body2, CORPO);
  assert.equal(merged.content.it.body3, CORPO);
  // E un payload che il flag non lo porta affatto passa identico.
  const pulito = mergeWith({ ...META_BUONA });
  assert.deepEqual(Object.keys(pulito).sort(), Object.keys(merged).sort());
});

test('una 2/2 in forma inattesa non fa esplodere il merge', () => {
  for (const metaData of [null, undefined, 42, [], 'testo']) {
    assert.doesNotThrow(() => mergeWith(metaData),
      `metaData=${JSON.stringify(metaData)} rompe il merge: lo strip deve tollerare cio' che \`...metaData\` tollerava`);
  }
});

test('il commento del contatore della 1/2 non afferma piu\' l\'opposto del codice', () => {
  assert.equal(
    src.includes("nasce da `metaData`, la cui meta' non ha"),
    false,
    'il commento afferma ancora che `merged` non puo\' portare il flag perche\' nasce da `metaData`: e\' vero solo grazie allo strip, e prima del fix era falso (#829)',
  );
  const i = src.indexOf('const merged = {');
  assert.match(
    src.slice(i, i + 900),
    /abort_topical_relevance/,
    'il blocco `merged` non nomina piu\' lo strip: senza, la ragione per cui le due chiavi mancano e\' invisibile a chi legge il merge',
  );
});
