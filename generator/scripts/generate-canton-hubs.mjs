#!/usr/bin/env node
/**
 * generate-canton-hubs.mjs — producer dei DATI dei 6 hub evergreen di una
 * sezione cantonale (piano «sezioni articoli per cantone», P10, D17):
 * carburanti, fisco, mobilita', eventi, pensioni, servizi.
 *
 * Per ogni (sezione, tema) scrive `content/cantons/<sezione>/hubs/<tema>.json`
 * con le 4 locali; ogni `locales[<loc>]` e' l'input di `renderCantonTopicHub`
 * (`engine/cantonSectionPages.ts`). Il rendering e la pubblicazione su R2 sono
 * del publisher (`scripts/publish-section-pages.mjs`, P7b): qui non si rende
 * HTML e non si tocca la rete.
 *
 * DATI (D11): i blocchi leggono le cache dei dataset di categoria che i
 * `refresh-*.mjs` scaricano dal sito; nessun crawl. Un dataset assente o
 * vecchio toglie il SUO blocco, non la pagina: l'hub resta valido e
 * indicizzabile (nessun `noindex`, decisions.md).
 *
 * NEWS (D13): la sezione del cantone + frontaliere/svizzera con il campo
 * `canton`, assegnate al tema dalla tassonomia dell'engine (o dal
 * classificatore a parole chiave per eventi e servizi).
 *
 * STABILE: id `<sezione>:<tema>`, scrittura atomica, `updatedAt` cambia solo
 * se cambia il contenuto. Una seconda esecuzione non produce diff.
 *
 * Uso:
 *   node generator/scripts/generate-canton-hubs.mjs --section canton-ti [--topic fisco] [--dry-run]
 *   node generator/scripts/generate-canton-hubs.mjs --all-enabled        # sezioni attive nel core o accese (profilo / Remote Config)
 *   node generator/scripts/generate-canton-hubs.mjs --list-enabled       # stampa le sezioni che --all-enabled lavorerebbe
 *   node generator/scripts/generate-canton-hubs.mjs --section canton-ti --print-paths
 *
 * Opzioni: `--report <file.json>` scrive il riepilogo; `--now <ISO>` (o
 * CANTON_HUBS_NOW) fissa l'orologio; DRY_RUN=1 equivale a --dry-run.
 * Gira sotto `node` (>= 22.18) o sotto `npx -y tsx@4.23.15`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ARTICLE_SECTION_CORE, ARTICLE_SECTION_CORE_ALL } from '../../engine/shared/articleSectionCore.mjs';
import { CANTON_HUB_TOPIC_KEYS } from '../../engine/shared/cantonArticleSectionCore.generated.mjs';
import { writeJsonAtomic } from './lib/atomic-write-json.mjs';
import { cantonSectionIds, cantonSectionProfile, loadCantonSectionProfiles, resolveCantonSectionGate } from './lib/canton-section-profile.mjs';
import { loadCantonPool, loadSectionArticles, selectCuratedArticles } from './lib/canton-hubs/articles.mjs';
import { parseCrossingNames } from './lib/canton-hubs/blocks-border-wait.mjs';
import { buildHubFile, hubFilePath, hubFilePaths } from './lib/canton-hubs/build.mjs';
import { loadTopicEngine } from './lib/canton-hubs/engine-loader.mjs';
import { borderRankingArticleId, eventsDigestArticleId } from './lib/canton-hubs/links.mjs';
import { sanitizeDatasetEvents } from './lib/events-utils.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Dove ogni `refresh-*.mjs` scrive la sua cache (path relativi alla radice). */
export const DATASET_CACHES = Object.freeze({
  fuel: 'generator/data/fuel-prices-cantons.json',
  events: 'data/events.json',
  borderWait: 'generator/data/border-wait-ranking-window.json',
  roadEvents: 'generator/data/road-events.json',
  notices: 'generator/data/canton-notices.json',
  services: 'generator/data/canton-services.json',
  tax: 'generator/data/canton-tax.json',
  pensions: 'generator/data/pension-parameters.json',
});

function readJson(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
  return JSON.parse(raw);
}

/** Le cache dei dataset: `null` se manca, `{}` (→ blocco `invalid`) se non e' JSON. */
export function loadDatasets(root = ROOT, log = () => {}) {
  const out = {};
  for (const [key, rel] of Object.entries(DATASET_CACHES)) {
    try {
      const dataset = readJson(path.join(root, rel));
      if (key === 'events' && dataset && Array.isArray(dataset.events)) {
        // Gli hub e il digest pubblicano lo stesso testo: il confine di lettura
        // deve applicare la stessa sanitizzazione, senza perdere generatedAt.
        out[key] = { ...dataset, events: sanitizeDatasetEvents(dataset.events).events };
      } else {
        out[key] = dataset;
      }
    } catch (err) {
      log(`::warning::[generate-canton-hubs] ${rel} non e' JSON valido (${err.message}): i suoi blocchi si omettono`);
      out[key] = {};
    }
  }
  return out;
}

/** Le sezioni cantonali attive nel core o accese dal gate di generazione (D9/D16). */
export function enabledCantonSections(env = process.env) {
  const profiles = loadCantonSectionProfiles();
  return cantonSectionIds().filter((id) =>
    Object.prototype.hasOwnProperty.call(ARTICLE_SECTION_CORE, id) || resolveCantonSectionGate(id, { env, profiles }).enabled);
}

export function parseArgs(argv, env = process.env) {
  const opts = { sections: [], topics: [], dryRun: env.DRY_RUN === '1' || env.DRY_RUN === 'true', allEnabled: false, listEnabled: false, printPaths: false, report: null, now: env.CANTON_HUBS_NOW || null };
  const value = (i, flag) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`${flag} richiede un valore`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const [flag, inline] = a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, null];
    const take = () => (inline !== null ? inline : value(i++, flag));
    if (flag === '--section') opts.sections.push(...take().split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
    else if (flag === '--topic') opts.topics.push(...take().split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
    else if (flag === '--report') opts.report = take();
    else if (flag === '--now') opts.now = take();
    else if (flag === '--dry-run') opts.dryRun = true;
    else if (flag === '--all-enabled') opts.allEnabled = true;
    else if (flag === '--list-enabled') opts.listEnabled = true;
    else if (flag === '--print-paths') opts.printPaths = true;
    else throw new Error(`argomento sconosciuto: ${a}`);
  }
  for (const s of opts.sections) {
    if (ARTICLE_SECTION_CORE_ALL[s]?.kind !== 'canton') throw new Error(`--section ${s}: non e' una sezione cantonale del core (attese: canton-<codice>)`);
  }
  for (const t of opts.topics) {
    if (!CANTON_HUB_TOPIC_KEYS.includes(t)) throw new Error(`--topic ${t}: tema sconosciuto (attesi: ${CANTON_HUB_TOPIC_KEYS.join(', ')})`);
  }
  if (opts.now !== null && !Number.isFinite(Date.parse(opts.now))) throw new Error(`--now ${opts.now}: non e' una data ISO`);
  return opts;
}

/**
 * Genera gli hub delle sezioni richieste.
 *
 * @param {object} args
 * @param {string} [args.root]
 * @param {string[]} args.sections
 * @param {string[]} [args.topics] vuoto = tutti e 6
 * @param {boolean} [args.dryRun]
 * @param {number} args.nowMs
 * @param {Record<string, any>} [args.datasets] iniettabile nei test
 * @param {(msg: string) => void} [args.log]
 */
export async function generateCantonHubs({ root = ROOT, sections, topics = [], dryRun = false, nowMs, datasets, log = console.log }) {
  const engine = await loadTopicEngine();
  const data = datasets ?? loadDatasets(root, log);
  const config = readJson(path.join(root, 'generator/data/canton-hub-topics.json'));
  const catalogue = readJson(path.join(root, 'generator/data/canton-hub-links.json'));
  const cantonUrlSlugs = readJson(path.join(root, 'generator/data/canton-url-slugs.json'));
  let crossingNames = new Map();
  try {
    crossingNames = parseCrossingNames(fs.readFileSync(path.join(root, 'generator/data/borderCrossings.ts'), 'utf8'));
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
  // frontaliere e svizzera si leggono una volta sola per tutti i cantoni del run.
  const memo = new Map();
  const load = (r, section) => {
    if (!memo.has(section)) memo.set(section, loadSectionArticles(r, section));
    return memo.get(section);
  };
  const wantedTopics = topics.length ? CANTON_HUB_TOPIC_KEYS.filter((t) => topics.includes(t)) : CANTON_HUB_TOPIC_KEYS;

  const hubs = [];
  const errors = [];
  for (const section of sections) {
    const canton = ARTICLE_SECTION_CORE_ALL[section].canton;
    const profile = cantonSectionProfile(section);
    const pool = loadCantonPool(root, section, load);
    const { byTopic, stats } = selectCuratedArticles({ pool, section, config, engine, nowMs });
    const frontaliere = new Map(load(root, 'frontaliere').map((a) => [a.id, a]));
    const evergreenArticles = new Map(
      [eventsDigestArticleId(canton), borderRankingArticleId(canton, cantonUrlSlugs)]
        .filter((id) => id && frontaliere.has(id))
        .map((id) => [id, frontaliere.get(id)]),
    );
    log(`[generate-canton-hubs] ${section}: bacino ${stats.pool} articoli (${stats.clusterAssigned} via tassonomia, ${stats.keywordAssigned} via parole chiave, ${stats.unassigned} senza tema hub)`);
    for (const topic of wantedTopics) {
      const rel = hubFilePath(section, topic);
      const file = path.join(root, rel);
      try {
        let previous = null;
        try {
          previous = readJson(file);
        } catch {
          previous = null; // file corrotto: si riscrive da zero
        }
        const built = buildHubFile({ section, topic, profile, datasets: data, curated: byTopic[topic], config, catalogue, cantonUrlSlugs, evergreenArticles, crossingNames, previous, nowMs });
        if (built.changed && !dryRun) writeJsonAtomic(file, built.file);
        const it = built.file.locales.it;
        hubs.push({
          section,
          canton,
          topic,
          path: rel,
          changed: built.changed,
          written: built.changed && !dryRun,
          updatedAt: built.file.updatedAt,
          curatedArticles: it.curatedArticles.length,
          keyFacts: it.keyFacts.length,
          links: it.links.length,
          dataBlocks: built.blocks.filter((b) => b.status !== 'omitted').map((b) => (b.status === 'carried' ? `${b.id} (conservato)` : b.id)),
          omittedBlocks: built.blocks.filter((b) => b.status === 'omitted').map((b) => ({ id: b.id, code: b.code, reason: b.reason })),
        });
        const last = hubs[hubs.length - 1];
        log(`[generate-canton-hubs]   ${topic}: ${last.curatedArticles} news, blocchi [${last.dataBlocks.join(', ') || 'nessuno'}], omessi [${last.omittedBlocks.map((b) => `${b.id}:${b.code}`).join(', ') || 'nessuno'}] → ${built.changed ? (dryRun ? 'cambierebbe' : 'scritto') : 'invariato'}`);
      } catch (err) {
        errors.push({ section, topic, message: err?.message ?? String(err) });
        log(`::error::[generate-canton-hubs] ${section}/${topic}: ${err?.message ?? err}`);
      }
    }
  }
  return { generatedAt: new Date(nowMs).toISOString(), dryRun, hubs, errors };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.listEnabled) {
    process.stdout.write(`${enabledCantonSections().join('\n')}${enabledCantonSections().length ? '\n' : ''}`);
    return 0;
  }
  const sections = opts.allEnabled ? enabledCantonSections() : opts.sections;
  if (opts.printPaths) {
    for (const s of sections) process.stdout.write(`${hubFilePaths(s).join('\n')}\n`);
    return 0;
  }
  if (sections.length === 0) {
    if (!opts.allEnabled) throw new Error('nessuna sezione: passa --section canton-<codice> oppure --all-enabled');
    console.log('[generate-canton-hubs] nessuna sezione cantonale attiva o accesa: niente da generare');
    return 0;
  }
  const nowMs = opts.now ? Date.parse(opts.now) : Date.now();
  const result = await generateCantonHubs({ sections, topics: opts.topics, dryRun: opts.dryRun, nowMs });
  if (opts.report) writeJsonAtomic(path.resolve(opts.report), result);
  const changed = result.hubs.filter((h) => h.changed).length;
  console.log(`[generate-canton-hubs] ${result.hubs.length} hub, ${changed} ${opts.dryRun ? 'cambierebbero' : 'scritti'}, ${result.errors.length} errori${opts.dryRun ? ' (--dry-run: nessun file scritto)' : ''}`);
  return result.errors.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  main().then((code) => process.exit(code)).catch((err) => {
    console.error(`::error::[generate-canton-hubs] ${err?.message ?? err}`);
    process.exit(1);
  });
}
