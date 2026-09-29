#!/usr/bin/env node
/**
 * Misura prima/dopo delle tre modifiche che tolgono a create-article il lavoro
 * buttato: gate dei duplicati prima del fact-check, memoria degli abort del
 * topic-gate per fonte, articolo intero nel body1 diviso invece di rigenerato.
 * Nessuna rete, nessun modello, nessuna scrittura.
 *
 * PRIMA e' il costo che il codice di prima ha pagato davvero: gli eventi delle
 * sei run di generate-article del 2026-09-29, con i secondi letti dai
 * timestamp dei log (generator/tests/fixtures/article-waste-2026-09-29.json).
 * DOPO e' lo stesso flusso di eventi ripassato dal codice di questa HEAD:
 *
 *   - abort del topic-gate: la memoria vera (`recordTopicGateAbortedUrl` /
 *     `isTopicGateAbortedUrl`, chiave `newsUrlKey` come in create-article),
 *     letta all'inizio di ogni run come il pre-filtro. Un URL gia' scartato in
 *     una run precedente della stessa sezione, entro 48 h, non viene piu'
 *     scelto: il suo tentativo costa 0. Dentro una run lo stesso URL non torna
 *     comunque, lo esclude `triedUrls`.
 *   - duplicati: il sorgente di create-article, letto qui, deve avere il gate
 *     anticipato (Step 3a.0-dup) prima di `llmFactCheck(`: allora i secondi fra
 *     «Articolo IT generato» e il rigetto non si pagano piu'. Se l'ordine
 *     manca, il DOPO resta uguale al PRIMA.
 *   - body1: il testo del payload rigettato non e' nei log (solo la forma:
 *     body1 5100 caratteri, body2 e body3 vuoti), quindi si misura su articoli
 *     VERI: ogni body IT pubblicato in `content/blog-body/it/` viene rimesso
 *     nella forma del difetto (body1+body2+body3 tutto nel body1) e passato a
 *     `classifyBody2Payload` di questa HEAD, con i campi della chiamata body
 *     dello split. La quota salvata e' la probabilita' che la rigenerazione non
 *     serva; il DOPO dell'evento e' la sua parte non salvata.
 *
 *   node generator/scripts/measure-article-waste.mjs [--json]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { isTopicGateAbortedUrl, recordTopicGateAbortedUrl } from './lib/article-topic-selector.mjs';
import { BODY_ONLY_FIELDS, classifyBody2Payload } from './lib/body2-payload-verdict.mjs';
import { newsUrlKey } from './lib/source-url-ledger.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
export const FIXTURE = path.join(ROOT, 'generator/tests/fixtures/article-waste-2026-09-29.json');
const CREATE_ARTICLE = path.join(HERE, 'create-article.mjs');
const IT_BODIES = path.join(ROOT, 'content/blog-body/it');

/** Il gate anticipato dei duplicati sta prima del fact-check nel sorgente di questa HEAD? */
export function earlyDuplicateGateBeforeFactCheck(src = fs.readFileSync(CREATE_ARTICLE, 'utf8')) {
  const fn = src.slice(src.indexOf('async function generateAndValidateArticle('));
  const early = fn.indexOf('Step 3a.0-dup:');
  const factCheck = fn.indexOf('await llmFactCheck(');
  return early > 0 && factCheck > early && /checkForDuplicates\(data, \{ localizedSlugs: false \}\);/.test(fn.slice(early, factCheck));
}

/** I tre body di un file `content/blog-body/it/<id>.ts`, o null. */
export function readItBodies(file) {
  const src = fs.readFileSync(file, 'utf8');
  const bodies = {};
  for (const field of BODY_ONLY_FIELDS) {
    const m = new RegExp(`'blog\\.article\\.[^']+\\.${field}':\\s*('(?:[^'\\\\]|\\\\.)*')`).exec(src);
    if (!m) return null;
    // Letterale JS a virgolette singole del repo stesso: lo si valuta come stringa.
    bodies[field] = Function(`"use strict"; return (${m[1]});`)();
  }
  return bodies;
}

/** Quota di articoli veri che, scritti tutti nel body1, il verdetto salva senza rigenerare. */
export function body1SalvageRate(dir = IT_BODIES) {
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.ts')).sort(); } catch { return null; }
  let articles = 0;
  let salvaged = 0;
  for (const f of files) {
    const bodies = readItBodies(path.join(dir, f));
    if (!bodies || !bodies.body1 || !bodies.body2 || !bodies.body3) continue;
    articles += 1;
    const parsed = { content: { it: { body1: [bodies.body1, bodies.body2, bodies.body3].join('\n\n'), body2: '', body3: '' } } };
    const v = classifyBody2Payload({ parsed, expectedFields: BODY_ONLY_FIELDS });
    if (v.verdict === 'ok' && v.salvagedPayload) salvaged += 1;
  }
  return articles ? { articles, salvaged, rate: salvaged / articles } : null;
}

export function measureArticleWaste({ fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')), salvage = body1SalvageRate(), earlyGate = earlyDuplicateGateBeforeFactCheck() } = {}) {
  let tracker = { keywords: [], strikes: {}, topicGateUrls: {} };
  const rows = [];
  for (const { run, events } of fixture.runs) {
    // Il pre-filtro legge la memoria una volta, all'inizio della run.
    const atStart = tracker;
    const row = { run, before: 0, after: 0, repeatAborts: 0, duplicates: 0, body1: 0 };
    for (const e of events) {
      row.before += e.seconds;
      if (e.kind === 'topic-gate-abort') {
        const key = newsUrlKey(e.url);
        const now = Date.parse(e.at);
        if (isTopicGateAbortedUrl(atStart, key, e.section, now)) row.repeatAborts += 1;
        else row.after += e.seconds;
        tracker = recordTopicGateAbortedUrl(tracker, key, e.section, now);
      } else if (e.kind === 'duplicate-after-body') {
        row.duplicates += 1;
        if (!earlyGate) row.after += e.seconds;
      } else if (e.kind === 'body1-only-regenerated') {
        row.body1 += 1;
        row.after += e.seconds * (1 - (salvage?.rate ?? 0));
      }
    }
    row.before = Math.round(row.before);
    row.after = Math.round(row.after);
    rows.push(row);
  }
  const total = rows.reduce((acc, r) => ({ before: acc.before + r.before, after: acc.after + r.after }), { before: 0, after: 0 });
  return { rows, total, salvage, earlyGate };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = measureArticleWaste();
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const s = result.salvage;
    console.log(`gate dei duplicati prima del fact-check: ${result.earlyGate ? 'si' : 'NO'}`);
    console.log(`articoli veri salvati nella forma body1-only: ${s ? `${s.salvaged}/${s.articles} (${(s.rate * 100).toFixed(1)}%)` : 'content/blog-body/it assente'}`);
    console.log('| run | secondi negli eventi: PRIMA | DOPO (questa HEAD) | abort ripetuti saltati | duplicati | body1 |');
    console.log('|---|---|---|---|---|---|');
    for (const r of result.rows) console.log(`| ${r.run} | ${r.before} | ${r.after} | ${r.repeatAborts} | ${r.duplicates} | ${r.body1} |`);
    console.log(`| totale | ${result.total.before} | ${result.total.after} | | | |`);
  }
}
