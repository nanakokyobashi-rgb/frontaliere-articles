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
 * Uso:
 *   node generator/scripts/verify-canton-hub-links.mjs [--section canton-ti[,canton-gr]] [--warn]
 * Senza --section controlla tutti i 24 gruppi. `--warn` esce 0 anche con link
 * mancanti (annotazione GitHub), per i workflow che non devono fermarsi.
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
import { buildHubLinks } from './lib/canton-hubs/links.mjs';
import { REWIRE_FETCH_HEADERS } from './lib/rewire-fetch.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ORIGIN = (process.env.SITE_ORIGIN || 'https://frontaliereticino.ch').replace(/\/$/, '');
/** Le sitemap che contengono le pagine linkate: le altre (annunci, articoli) non servono. */
const RELEVANT = /sitemap-(pages|fuel-[a-z-]+|border-wait|health-premiums|farmacie|plate-auctions-\d+|weather|eventi|jobs-[a-z-]+)\.xml$/;

const args = process.argv.slice(2);
const warnOnly = args.includes('--warn');
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

const index = await get(`${ORIGIN}/sitemap.xml`);
const children = [...index.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]).filter((u) => RELEVANT.test(u));
if (children.length === 0) {
  console.error('::error::[verify-canton-hub-links] nessuna sitemap pertinente nell\'indice: il controllo sarebbe vuoto');
  process.exit(1);
}
const published = new Set();
for (const url of children) {
  const xml = await get(url);
  for (const m of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) published.add(toPath(m[1]));
  for (const m of xml.matchAll(/hreflang="[^"]+"\s+href="([^"]+)"/g)) published.add(toPath(m[1]));
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

let checked = 0;
const missing = [];
for (const section of sections) {
  const canton = ARTICLE_SECTION_CORE_ALL[section].canton;
  for (const topic of CANTON_HUB_TOPIC_KEYS) {
    for (const locale of HUB_LOCALES) {
      for (const link of buildHubLinks({ canton, topic, locale, catalogue, cantonUrlSlugs })) {
        const probe = sitemapTwin(canton, locale, link.url);
        if (probe === null) continue;
        checked += 1;
        if (!published.has(probe)) missing.push(`${section}/${topic}/${locale}: ${link.url}`);
      }
    }
  }
}

console.log(`[verify-canton-hub-links] ${checked} link di ${sections.length} sezioni controllati su ${children.length} sitemap (${published.size} URL pubblicati), ${missing.length} mancanti`);
if (missing.length) {
  for (const m of [...new Set(missing)]) console.log(`${warnOnly ? '::warning::' : '::error::'}[verify-canton-hub-links] non in sitemap: ${m}`);
  process.exit(warnOnly ? 0 : 1);
}
