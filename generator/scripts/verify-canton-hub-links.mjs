#!/usr/bin/env node
/**
 * verify-canton-hub-links.mjs — ricontrolla contro le sitemap PUBBLICATE ogni
 * link a strumenti e pagine di categoria che gli hub cantonali possono
 * emettere (`lib/canton-hubs/links.mjs` + `generator/data/canton-hub-links.json`).
 *
 * Perche' le sitemap e non una GET: il sito e' una SPA con fallback, e un path
 * inesistente risponde 200 (misurato 2026-10-05: `/en/health-insurance-premiums/ticino/`,
 * che non esiste, da' 200). «Esiste» qui vuol dire «e' in una sitemap», come
 * `<loc>` o come alternate hreflang.
 *
 * Un caso a parte, dichiarato: le pagine eventi per cantone sono in
 * `sitemap-eventi.xml` solo in italiano; en/de/fr derivano dallo stesso
 * `canton-url-slugs.json` che usa il sito (`eventsBasePathForCanton`), quindi
 * per quelle si verifica il gemello italiano.
 *
 * Copre TUTTI i link che il producer puo' emettere, compresi quelli agli
 * articoli evergreen del cantone (digest eventi del weekend, classifica dei
 * valichi): la mappa degli evergreen si costruisce qui come la costruisce
 * `generate-canton-hubs.mjs`, dal registro frontaliere, e i loro URL si
 * cercano in `sitemap-blog.xml` nella locale del link.
 *
 * Uso:
 *   node generator/scripts/verify-canton-hub-links.mjs [--section canton-ti[,canton-gr]] [--warn]
 * Senza --section controlla tutti i 24 gruppi. Un link mancante e' sempre
 * exit 1. `--soft-network` rende exit 0 (con annotazione) il SOLO caso in cui
 * le sitemap non si riescono a scaricare: e' la modalita' del workflow, che
 * non deve fermarsi per un guasto di rete ma deve fermarsi per un link rotto.
 * `--warn` (diagnostica a mano) esce 0 anche con link mancanti.
 * SITE_ORIGIN cambia l'origine (default https://frontaliereticino.ch).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ARTICLE_SECTION_CORE_ALL } from '../../engine/shared/articleSectionCore.mjs';
import { CANTON_HUB_TOPIC_KEYS } from '../../engine/shared/cantonArticleSectionCore.generated.mjs';
import { cantonSectionIds } from './lib/canton-section-profile.mjs';
import { eventsBasePathForCanton } from './lib/events-utils.mjs';
import { HUB_LOCALES } from './lib/canton-hubs/format.mjs';
import { loadSectionArticles } from './lib/canton-hubs/articles.mjs';
import { borderRankingArticleId, buildHubLinks, eventsDigestArticleId } from './lib/canton-hubs/links.mjs';
import { REWIRE_FETCH_HEADERS } from './lib/rewire-fetch.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ORIGIN = (process.env.SITE_ORIGIN || 'https://frontaliereticino.ch').replace(/\/$/, '');
/** Le sitemap che contengono le pagine linkate: le altre (annunci, articoli) non servono. */
const RELEVANT = /sitemap-(pages|fuel-[a-z-]+|border-wait|health-premiums|farmacie|plate-auctions-\d+|weather|eventi|jobs-[a-z-]+|blog)\.xml$/;

const args = process.argv.slice(2);
const warnOnly = args.includes('--warn');
const softNetwork = args.includes('--soft-network');
const sectionArg = args.find((a) => a.startsWith('--section='))?.slice('--section='.length) ?? (args.includes('--section') ? args[args.indexOf('--section') + 1] : null);
const sections = sectionArg ? sectionArg.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean) : cantonSectionIds();
for (const s of sections) {
  if (ARTICLE_SECTION_CORE_ALL[s]?.kind !== 'canton') {
    console.error(`::error::[verify-canton-hub-links] "${s}" non e' una sezione cantonale`);
    process.exit(2);
  }
}

async function get(url) {
  const res = await fetch(url, { headers: { ...REWIRE_FETCH_HEADERS, accept: 'application/xml,text/xml,*/*' }, redirect: 'follow' });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.text();
}

const toPath = (u) => u.replace(ORIGIN, '').replace(/&amp;/g, '&');

/** `<loc>` con o senza prefisso di namespace e con eventuale CDATA. */
const LOC_RE = /<(?:[a-z]+:)?loc>\s*(?:<!\[CDATA\[)?\s*([^<\]\s]+)\s*(?:\]\]>)?\s*<\/(?:[a-z]+:)?loc>/g;

/** Guasto di rete o del server: l'unico esito che `--soft-network` perdona. */
function networkFailure(err) {
  const line = `[verify-canton-hub-links] sitemap non scaricabili (${err?.message ?? err}): link NON verificati in questo run`;
  console.log(`${softNetwork ? '::warning::' : '::error::'}${line}`);
  process.exit(softNetwork ? 0 : 1);
}

let index;
try {
  index = await get(`${ORIGIN}/sitemap.xml`);
} catch (err) {
  networkFailure(err);
}
const children = [...index.matchAll(LOC_RE)].map((m) => m[1]).filter((u) => RELEVANT.test(u));
if (children.length === 0) {
  console.error('::error::[verify-canton-hub-links] nessuna sitemap pertinente nell\'indice: il controllo sarebbe vuoto');
  process.exit(1);
}
const published = new Set();
for (const url of children) {
  let xml;
  try {
    xml = await get(url);
  } catch (err) {
    networkFailure(err);
  }
  // `<loc>` con o senza prefisso di namespace e con eventuale CDATA; gli
  // alternate si leggono tag per tag, qualunque sia l'ordine degli attributi.
  for (const m of xml.matchAll(LOC_RE)) published.add(toPath(m[1]));
  for (const tag of xml.matchAll(/<(?:[a-z]+:)?link\b[^>]*>/g)) {
    if (!/\bhreflang\s*=/.test(tag[0])) continue;
    const href = /\bhref\s*=\s*["']([^"']+)["']/.exec(tag[0]);
    if (href) published.add(toPath(href[1]));
  }
}

const catalogue = JSON.parse(fs.readFileSync(path.join(ROOT, 'generator/data/canton-hub-links.json'), 'utf8'));
const cantonUrlSlugs = JSON.parse(fs.readFileSync(path.join(ROOT, 'generator/data/canton-url-slugs.json'), 'utf8'));

/** Il path da cercare in sitemap: per le pagine eventi non italiane, il gemello italiano. */
function sitemapTwin(canton, locale, url) {
  if (locale === 'it') return url;
  const base = eventsBasePathForCanton(canton);
  if (url === `${base[locale]}/`) return `${base.it}/`;
  if (url.startsWith(`${base[locale]}/`)) return null; // digest per locale: coperto dalla pagina del cantone
  return url;
}

// Gli evergreen come li vede il producer: solo quelli davvero nel registro.
const frontaliere = new Map(loadSectionArticles(ROOT, 'frontaliere').map((a) => [a.id, a]));

let checked = 0;
let evergreenLinks = 0;
const missing = [];
for (const section of sections) {
  const canton = ARTICLE_SECTION_CORE_ALL[section].canton;
  const evergreenArticles = new Map(
    [eventsDigestArticleId(canton), borderRankingArticleId(canton, cantonUrlSlugs)]
      .filter((id) => id && frontaliere.has(id))
      .map((id) => [id, frontaliere.get(id)]),
  );
  evergreenLinks += evergreenArticles.size;
  for (const topic of CANTON_HUB_TOPIC_KEYS) {
    for (const locale of HUB_LOCALES) {
      for (const link of buildHubLinks({ canton, topic, locale, catalogue, cantonUrlSlugs, evergreenArticles })) {
        const probe = sitemapTwin(canton, locale, link.url);
        if (probe === null) continue;
        checked += 1;
        if (!published.has(probe)) missing.push(`${section}/${topic}/${locale}: ${link.url}`);
      }
    }
  }
}

console.log(`[verify-canton-hub-links] ${checked} link di ${sections.length} sezioni (di cui ${evergreenLinks} articoli evergreen, nelle 4 locali) controllati su ${children.length} sitemap (${published.size} URL pubblicati), ${missing.length} mancanti`);
if (missing.length) {
  for (const m of [...new Set(missing)]) console.log(`${warnOnly ? '::warning::' : '::error::'}[verify-canton-hub-links] non in sitemap: ${m}`);
  process.exit(warnOnly ? 0 : 1);
}
