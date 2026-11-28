#!/usr/bin/env node
/**
 * verify-canton-evergreen-topics.mjs — verifica (e, con `--write`, timbra) i
 * pool di argomenti non-news per cantone (F4.2, `CANTON_NONNEWS_SECTIONS`).
 *
 *   node generator/scripts/verify-canton-evergreen-topics.mjs --check
 *       Offline. Schema, argomenti minimi (15 sulle sezioni pilota), id/keyword/
 *       URL unici, host ufficiale del cantone, >= 3 citazioni per argomento e
 *       nessun argomento-clone fra cantoni diversi (stesso scheletro, solo il
 *       nome del cantone cambiato).
 *
 *   node generator/scripts/verify-canton-evergreen-topics.mjs --check --online
 *       In piu': ogni fonte ufficiale risponde HTTP 200 e almeno 3 citazioni
 *       compaiono verbatim nel testo della pagina. E' la stessa prova che il
 *       generatore ripete a ogni run prima di usare l'argomento.
 *
 *   ... --section canton-vs   limita a una sezione
 *   ... --write               (con --online) riscrive `verifiedAt` del pool
 *                             solo se TUTTI gli argomenti passano.
 *
 * Exit: 0 tutto ok, 1 errori di verifica, 2 uso errato.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MIN_POOL_TOPICS,
  MIN_VERIFIED_FACTS,
  fetchSourcePage,
  findCrossCantonTemplateClones,
  validateTopicPool,
  verifyTopicOnPage,
} from './lib/canton-nonnews.mjs';

/** Le sezioni pilota del piano F4.2: almeno `MIN_POOL_TOPICS` argomenti. */
export const PILOT_SECTIONS = Object.freeze(['canton-basilea', 'canton-be', 'canton-vs']);

const POOL_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'canton-evergreen-topics');
const POLITE_DELAY_MS = 400;

export function loadAllPools(dir = POOL_DIR, only = null) {
  const pools = {};
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
    const section = file.replace(/\.json$/, '');
    if (only && section !== only) continue;
    pools[section] = JSON.parse(readFileSync(path.join(dir, file), 'utf8'));
  }
  return pools;
}

/** Controlli offline: `{ errors: string[] }`. */
export function checkOffline(pools) {
  const errors = [];
  for (const [section, pool] of Object.entries(pools)) {
    const min = PILOT_SECTIONS.includes(section) ? MIN_POOL_TOPICS : 1;
    for (const e of validateTopicPool(pool, { section, minTopics: min })) errors.push(`${section}: ${e}`);
  }
  for (const c of findCrossCantonTemplateClones(pools)) {
    errors.push(`anti-template: ${c.a} ~ ${c.b} (somiglianza ${c.sim.toFixed(2)})`);
  }
  return { errors };
}

/** Controlli online sulle fonti, in sequenza e con una pausa fra le richieste. */
export async function checkOnline(pools, { fetchPage = fetchSourcePage, delayMs = POLITE_DELAY_MS, log = () => {} } = {}) {
  const errors = [];
  const okSections = new Set();
  for (const [section, pool] of Object.entries(pools)) {
    let sectionOk = true;
    for (const topic of pool.topics || []) {
      const page = await fetchPage(topic.source.url);
      let problem = '';
      if (!page.ok) problem = `fonte non raggiungibile (${page.error || `HTTP ${page.status}`})`;
      else {
        const check = verifyTopicOnPage(topic, page.text);
        if (!check.ok) problem = `solo ${check.found.length}/${MIN_VERIFIED_FACTS} citazioni trovate; mancano: ${check.missing.join(' | ')}`;
      }
      if (problem) {
        sectionOk = false;
        errors.push(`${section}/${topic.id}: ${problem}`);
        log(`✖ ${section}/${topic.id}: ${problem}`);
      } else {
        log(`✓ ${section}/${topic.id}`);
      }
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    }
    if (sectionOk) okSections.add(section);
  }
  return { errors, okSections };
}

async function main(argv) {
  const args = new Set(argv.filter((a) => a.startsWith('--') && !a.startsWith('--section')));
  const sectionIdx = argv.findIndex((a) => a === '--section');
  const only = sectionIdx >= 0 ? argv[sectionIdx + 1] : (argv.find((a) => a.startsWith('--section='))?.split('=')[1] ?? null);
  if (!args.has('--check') && !args.has('--online')) {
    console.error('uso: verify-canton-evergreen-topics.mjs --check [--online] [--section <id>] [--write]');
    return 2;
  }
  const pools = loadAllPools(POOL_DIR, only);
  if (Object.keys(pools).length === 0) {
    console.error(`nessun pool${only ? ` per ${only}` : ''} in ${POOL_DIR}`);
    return 1;
  }
  const offline = checkOffline(pools);
  for (const e of offline.errors) console.error(`✖ ${e}`);
  let failed = offline.errors.length > 0;
  if (args.has('--online')) {
    const online = await checkOnline(pools, { log: (m) => console.error(m) });
    failed = failed || online.errors.length > 0;
    if (args.has('--write')) {
      const today = new Date().toISOString().slice(0, 10);
      for (const section of online.okSections) {
        const file = path.join(POOL_DIR, `${section}.json`);
        writeFileSync(file, `${JSON.stringify({ ...pools[section], verifiedAt: today }, null, 2)}\n`);
        console.error(`✎ ${section}: verifiedAt=${today}`);
      }
    }
  }
  const count = Object.values(pools).reduce((n, p) => n + (p.topics?.length || 0), 0);
  console.error(failed ? `✖ verifica fallita (${count} argomenti)` : `✓ ${Object.keys(pools).length} pool, ${count} argomenti: ok`);
  return failed ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
