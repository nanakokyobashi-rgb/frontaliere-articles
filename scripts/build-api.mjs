/**
 * Build the public data surface of this repository.
 *
 * This repo owns the article corpus; the site that renders it is a separate
 * repository and must consume this data as plain JSON over HTTP — never by
 * reaching into these sources at build time. That boundary is the point: the
 * previous coupling shipped the registry as a Rollup-shaped ES module, and when
 * it was republished out-of-band as a standalone esbuild bundle the two disagreed
 * about a generated namespace export. The consumer dereferenced `undefined`, threw
 * past its own chunk-load recovery, and every article page on the live site sat on
 * a loading skeleton with nothing in the console.
 *
 * JSON cannot fail that way. There is no module shape to agree on — only keys.
 *
 * Emits, into dist/api/:
 *   manifest.json      commit, generatedAt, counts, per-file byte sizes
 *   articles.json      the frontaliere registry (ARTICLES)
 *   swiss-articles.json the svizzera registry (SWISS_ARTICLES)
 *   meta-<locale>.json      title/excerpt/imageAlt per article, frontaliere
 *   meta-ch-<locale>.json   same, svizzera
 *   slugs.json         id -> per-locale slug, reverse map, and fallback provenance
 *   (the sections are the ACTIVE ones of the section core, with the published
 *   names above declared once in scripts/lib/corpus-sections.mjs)
 *   sitemap-blog.xml / sitemap-blog-ch.xml   article sitemaps, with hreflang
 *   rss*.xml           ten RSS feeds (two sections x four locales + main copy)
 *   news-ticker-live.json  the homepage ticker's five newest articles
 *   plate-auction-editorial.json  localized evergreen/weekly editorial blocks
 *                      built from the public plate-auction snapshot over HTTP
 *                      (static CDN file first, the Cloud Function as fallback)
 *   sitemap-news-candidates.xml  Google News candidates (migration §7.2)
 *   images-manifest.json + images/blog/*.webp  hero images (migration §7.1),
 *                      emitted ONLY when this repo actually holds images
 *
 * Run with tsx: the corpus sources use extensionless relative specifiers, which
 * plain Node ESM does not resolve.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { buildSectionFeeds, RSS_SECTIONS } from '../engine/rssFeeds.mjs';
// repairSerpSnippet vive in clauseTail.mjs (un .mjs) proprio perche' questo file
// non puo' importare un .ts: e' la sorgente unica che il layer TS riesporta.
// Senza passarla, rssFeeds.mjs spedirebbe le description verbatim (#5453).
import { repairSerpSnippet } from '../host/shared/clauseTail.mjs';
// The vendored Google News whitelist (issue #4974 item 3, §5.3). Imported, not
// re-copied: main pulls the eligibility decision from this repo and a third copy
// of the token list is exactly the drift that module's header warns about. A
// static import is also the point — the failure this replaced was a regex parse
// that silently returned [], which `isArticleNewsEligible` would read as
// allow-all. A missing module throws; an empty list does not.
import {
  isArticleNewsEligible,
  NEWS_SITEMAP_WINDOW_HOURS,
} from '../generator/data/news-sitemap-whitelist.mjs';
// Sitemap retention for the dated daily editions (Bollettino del Frontaliere):
// the newest N stay listed, older ones are DE-LISTED but never deleted — same
// semantics as the swiss canonical-override shadowing below, same house rule
// ("never noindex, never delete HTML"). Imported so the selector has exactly
// one implementation, shared with the generator's tests.
import { selectRetiredDailyEditions } from '../generator/scripts/lib/daily-brief-content.mjs';
// Output-boundary sanitisation. The corpus is allowed to hold a control
// character — the generator wrote it, and two titles do — but nothing this
// script emits is: XML 1.0 admits no C0 but TAB/LF/CR, so a single 0x08 in one
// <image:title> makes the whole 3120-url sitemap not well-formed and a strict
// consumer may drop all of it. Applied at the four places bytes actually leave
// this process (write / writeXml / the RSS + candidates writes / the verbatim
// republishes), not at each field, so an emitter added later inherits it.
import {
  sanitizeDeep,
  sanitizeXmlDocument,
  sanitizeJsonText,
  assertNoControlChars,
} from './lib/sanitize-control-chars.mjs';
// Sanificare non basta: togliere il byte C0 distrugge il MARKER che rende esatta
// una riparazione futura. Qui si registra prima di distruggere (#95, #133).
import {
  reportStrippedControlChars,
  reportStrippedControlCharsDeep,
} from '../generator/scripts/lib/control-char-write-report.mjs';
// Pure XML builder, no .ts imports on purpose (see that file's header): lets
// generator/tests/frontaliere-sitemap-shadow.test.mjs exercise it directly
// under plain `node --test`, without a tsx subprocess.
import {
  SITE,
  xmlEsc,
  SECTION_PATHS,
  ARCHIVE_ALL_SLUG,
  buildSitemap,
  buildFamilySectionSitemap,
  countSitemapEntries,
} from './lib/build-sitemap.mjs';
// Le sezioni da pubblicare vengono dal core (lista ATTIVA), con i nomi della
// superficie pubblicata dichiarati una volta in corpus-sections.mjs.
import {
  API_SECTIONS,
  PUBLISHED_API_SECTIONS,
  activeApiFamilies,
  sectionRssLayout,
  assertActiveSectionsPublishable,
} from './lib/corpus-sections.mjs';
// Il registro delle sezioni (dichiarato in sections/registry.json, verita' del
// rollout) e i documenti che ne derivano: catalogo per il sito, copia per il
// Worker, indice delle sitemap per sezione (piano «sezioni cantonali», P7).
import {
  EDGE_SECTION_REGISTRY_FILE,
  SECTIONS_CATALOG_FILE,
  SECTION_SITEMAP_INDEX_FILE,
  buildEdgeRegistry,
  buildSectionsCatalog,
  buildSitemapIndex,
  edgeRegistryPublishable,
  effectiveStatuses,
  familySourceMissing,
  latestArticleDate,
  loadDeclaredRegistry,
  registryRetiredSlugs,
  resolveKillSwitch,
  validateEdgeSectionRegistry,
} from './lib/section-registry.mjs';
import { isReservedPublishedSlug } from './lib/published-slug-guard.mjs';
// Il corpus nel layout dell'engine, per i feed delle sezioni di famiglia.
import { createEngineCorpusView, engineViewRssLayout } from './lib/engine-corpus-view.mjs';
// Allowlist dei campi pubblici di articles.json / swiss-articles.json.
import { toPublicRegistryEntry } from './lib/registry-api-entry.mjs';
// Detection (not filtering — see its header) for issue #166: surfaces a
// same-day canonical-override landing on a still-in-window ticker article.
import { findShadowedTickerArticles } from './lib/ticker-shadow-check.mjs';
// Writer e gate contano i tag con LA STESSA funzione, e quella funzione conta
// il markup, non il testo: una description RSS in CDATA che cita `<item>`
// gonfiava identicamente il dichiarato e il ri-derivato (vedi il suo header).
import { countXmlTags } from './lib/count-xml-tags.mjs';
import {
  buildPlateAuctionEditorial,
  fetchPlateAuctionEditorialInput,
} from './lib/plate-auction-editorial.mjs';
import {
  collectSeoEntryMetadata,
  floorFrom,
  ARCHIVE_SITEMAP,
  countSourceArticles,
  countSourceSitemapEntries,
  familyFloorVerdict,
  floorPolicyOf,
  sectionFloor,
} from './lib/corpus-floors.mjs';
import {
  RELEASE_MARKER_CONTRACT_FIELD,
  RELEASE_MARKER_CONTRACT_VERSION,
  validateReleaseMarkers,
} from './lib/announced-surface.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'dist', 'api');
const LOCALES = ['it', 'en', 'de', 'fr'];

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

// Migration artifact names (docs/articles-generator-migration.md §7). Spelled
// exactly as scripts/pull-articles-api.mjs fetches them in the site repo.
const NEWS_CANDIDATES = 'sitemap-news-candidates.xml';
const IMAGE_MANIFEST = 'images-manifest.json';
/** Site-consumed ranking snapshot republished from the generator's output (§4). */
const BORDER_RANKING = 'border-wait-ranking.json';
/** Daily-brief snapshot (Bollettino del Frontaliere) — same republish contract. */
const DAILY_BRIEF = 'daily-brief.json';
/** Localized editorial companion for the public plate-auction catalogue. */
const PLATE_AUCTION_EDITORIAL = 'plate-auction-editorial.json';

// Gli INPUT dei tre artefatti condizionali, in una sorgente sola perche' due
// posti li leggono e devono leggere lo stesso: il ramo che decide se emettere,
// e il gate `manifest.counts` che decide se un artefatto assente lo e'
// legittimamente. Se i due si sfasano il gate torna cieco proprio dove serve —
// l'assenza tornerebbe a valere 0 in accordo con un `counts` che vale 0 per la
// stessa ragione (AGENTS.md #6: un valore condiviso ha UNA sorgente).
const IMAGE_SRC_DIR = ['public', 'images', 'blog'];
const BORDER_RANKING_SRC = ['public', 'data', 'border-wait-ranking.json'];
const DAILY_BRIEF_SRC = ['public', 'data', 'daily-brief.json'];

let newsCandidateCount = 0;
let imageCount = 0;
let borderRankingEntries = 0;
let dailyBriefBlocks = 0;
let plateAuctionEditorialLocales = 0;

const written = {};
// Sanitised on the value, not on the serialised text: JSON.stringify ESCAPES a
// control character into `\u0008`, which is valid JSON and therefore survives
// any scan of the emitted bytes — while every consumer that parses the file
// gets the control character back. The only place to catch it is before the
// stringify. `written[name]` records the sanitised text, so manifest.json
// keeps describing what is actually served.
//
// ── Bytes, non code unit ──────────────────────────────────────────────────
//
// `manifest.files` e' documentato come «per-file byte sizes», ed e' cio' che
// permette a un consumer di rifiutare un payload troncato confrontandolo con il
// `Content-Length` servito. `String.length` conta code unit UTF-16, non byte:
// su un corpus italiano/tedesco ogni accento, ogni virgoletta tipografica e
// ogni emoji fa divergere i due numeri. Misurato il 2026-09-05 sul corpus
// reale: 24 delle 29 voci sbagliate, fino a +16.941 su `meta-de.json`. Il
// confronto quindi non falliva su un file troncato — falliva SEMPRE, il che e'
// il modo piu' sicuro per far disattivare il controllo a chi lo consuma.
const byteSize = (text) => Buffer.byteLength(text, 'utf-8');
const write = (name, value) => {
  const file = path.join(OUT, name);
  const cleanValue = sanitizeDeep(value);
  // Prima della stringify, non dopo: JSON.stringify escapa i byte C0, quindi
  // sulla forma serializzata non ci sarebbe piu' niente da vedere (#133).
  reportStrippedControlCharsDeep(file, value, cleanValue);
  const json = JSON.stringify(cleanValue);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, json);
  written[name] = byteSize(json);
  console.log(`[build-api] ${name}: ${byteSize(json)} bytes`);
  return value;
};

const load = async (rel) => import(path.join(ROOT, rel));

// ── Le sezioni vengono dal core ────────────────────────────────────────────
//
// Ogni loop qui sotto itera `API_SECTIONS`, cioe' le sezioni ATTIVE del core
// (`engine/shared/articleSectionCore.mjs`) che hanno una superficie pubblicata
// propria, nell'ordine del core: frontaliere, svizzera. I nomi dei file
// (`articles.json`, `meta-ch-<loc>.json`, la chiave `swiss` di slugs.json, …)
// sono quelli di sempre, dichiarati in `scripts/lib/corpus-sections.mjs`.
// Una sezione attiva SENZA superficie pubblicata (oggi: qualunque cantone,
// finche' non arrivano le superfici di famiglia) e' un rifiuto qui, prima di
// scrivere un solo byte: saltarla pubblicherebbe un set troncato.
assertActiveSectionsPublishable();
const PUBLISHED_BY_SECTION = Object.fromEntries(PUBLISHED_API_SECTIONS.map((section) => [section.section, section]));
// Il registro dichiarato delle sezioni si valida PRIMA di scrivere un solo
// byte: un registro fuori contratto e' un errore del commit che l'ha toccato.
const declaredSections = loadDeclaredRegistry(ROOT);
// Le sezioni di FAMIGLIA (le cantonali accese) si leggono come le storiche, con
// una differenza sola: una sezione di famiglia appena accesa non ha ancora i
// suoi file (create-article li crea TUTTI INSIEME al primo articolo), e
// l'assenza vale sezione vuota — la stessa regola di `isNewFamilySection` nei
// pavimenti. Vale solo per la sezione INTERA: e' «nuova» la sezione di
// famiglia senza registro, e allora non deve avere nemmeno mappa slug e meta.
// Un insieme parziale (registro senza meta di una locale, meta senza
// registro) e' un rifiuto: trattarlo come vuoto pubblicherebbe una famiglia
// troncata con registro, sitemap e counts verdi. Un file presente ma
// illeggibile resta un errore.
const isNewFamilySection = (section) =>
  section.api.family !== null && !fs.existsSync(path.join(ROOT, section.registryFile));
const familyFileMissing = (section, rel) =>
  section.api.family !== null &&
  familySourceMissing({
    section: section.section,
    rel,
    registryRel: section.registryFile,
    present: fs.existsSync(path.join(ROOT, rel)),
    registryPresent: !isNewFamilySection(section),
  });
const SECTION_REGISTRIES = {};
for (const section of PUBLISHED_API_SECTIONS) {
  if (isNewFamilySection(section)) {
    SECTION_REGISTRIES[section.section] = [];
    continue;
  }
  const registry = (await load(section.registryFile))[section.registryExport];
  if (!Array.isArray(registry) || (section.kind === 'frontaliere' && registry.length === 0)) {
    throw new Error(
      section.kind === 'frontaliere'
        ? `${section.registryExport} is empty — refusing to publish an empty registry`
        : `${section.registryExport} is not an array`,
    );
  }
  SECTION_REGISTRIES[section.section] = registry;
}
// Il registro frontaliere ha consumer che sono suoi per costruzione (ticker
// della homepage, edizioni quotidiane ritirate): li si nomina per tipo.
const FRONTALIERE = API_SECTIONS.find((section) => section.kind === 'frontaliere');
if (!FRONTALIERE) throw new Error('nessuna sezione di tipo frontaliere attiva nel core — refusing to publish');
const ARTICLES = SECTION_REGISTRIES[FRONTALIERE.section];

const commit = (() => {
  try {
    return execSync('git rev-parse HEAD', { cwd: ROOT }).toString().trim();
  } catch {
    return null;
  }
})();
if (!commit) {
  throw new Error('git commit non verificabile — refusing to publish an unmarked release');
}

// Ogni documento che il detector legge deve portare la stessa release del
// manifest. Senza il marker per-riga, counts e insieme di ID possono restare
// identici mentre il registro appartiene a un commit diverso da slugs.json.
// La voce e' proiettata sull'allowlist pubblica, mai copiata con uno spread:
// un campo interno del registry (es. `articleType`) non entra nel contratto
// HTTP per caso (scripts/lib/registry-api-entry.mjs).
const markRegistryRelease = (registry) => registry.map((article) => toPublicRegistryEntry(article, commit));
for (const section of API_SECTIONS) {
  write(section.api.registry, markRegistryRelease(SECTION_REGISTRIES[section.section]));
}

// Per locale e poi per sezione: e' l'ordine in cui i file sono sempre stati
// scritti, quindi anche l'ordine di `manifest.files`.
for (const loc of LOCALES) {
  for (const section of API_SECTIONS) {
    const metaName = path.basename(section.metaFile(loc), '.ts');
    const meta = (await load(section.metaFile(loc))).default;
    if (!meta || typeof meta !== 'object') throw new Error(`${metaName} default is not an object`);
    write(section.api.metaFile(loc), meta);
  }
}

/** Il meta di una sezione per locale; `{}` solo per una sezione di famiglia NUOVA (nessun file). */
async function loadSectionMeta(section, loc) {
  if (familyFileMissing(section, section.metaFile(loc))) return {};
  const meta = (await load(section.metaFile(loc))).default;
  if (!meta || typeof meta !== 'object') throw new Error(`${path.basename(section.metaFile(loc), '.ts')} default is not an object`);
  return meta;
}

// ── Superfici di famiglia (le sezioni cantonali accese) ──────────────────
//
// Una famiglia pubblica UN registro (`canton-articles.json`, ogni riga con la
// sua `section`), UN meta per locale (`meta-canton-<loc>.json`) e UNA chiave di
// slugs.json (sotto). Le chiavi `blog.article.<id>.*` e gli id articolo sono
// un namespace unico fra tutte le sezioni (i18n condiviso, D6/D14), quindi
// unire i meta e' sicuro solo se nessuna chiave si ripete: una ripetizione e'
// un rifiuto, non un «vince l'ultima». Senza famiglie accese (oggi) non si
// scrive niente qui, e dist/api resta quello di prima.
const API_FAMILIES = activeApiFamilies(PUBLISHED_API_SECTIONS);
for (const family of API_FAMILIES) {
  const seen = new Map();
  const rows = [];
  for (const section of family.sections) {
    for (const article of SECTION_REGISTRIES[section.section]) {
      if (seen.has(article.id)) {
        throw new Error(`${family.api.registry}: id "${article.id}" in ${seen.get(article.id)} e in ${section.section} — refusing`);
      }
      seen.set(article.id, section.section);
      rows.push({ ...toPublicRegistryEntry(article, commit), section: section.section });
    }
  }
  write(family.api.registry, rows);
  for (const loc of LOCALES) {
    const merged = {};
    const owner = {};
    for (const section of family.sections) {
      for (const [key, value] of Object.entries(await loadSectionMeta(section, loc))) {
        if (Object.prototype.hasOwnProperty.call(merged, key)) {
          throw new Error(`${family.api.metaFile(loc)}: chiave "${key}" in ${owner[key]} e in ${section.section} — refusing`);
        }
        merged[key] = value;
        owner[key] = section.section;
      }
    }
    write(family.api.metaFile(loc), merged);
  }
}

/** Il modulo della mappa slug di ogni sezione: mappa, inversa e provenienza dei fallback. */
const SECTION_SLUG_MODULES = {};
for (const section of PUBLISHED_API_SECTIONS) {
  if (familyFileMissing(section, section.slugFile)) {
    SECTION_SLUG_MODULES[section.section] = { slugs: {}, reverse: null, fallbackReasons: {} };
    continue;
  }
  const mod = await load(section.slugFile);
  SECTION_SLUG_MODULES[section.section] = {
    slugs: mod[section.slugExport],
    reverse: section.reverseExport ? mod[section.reverseExport] : null,
    fallbackReasons: mod[section.fallbackReasonsExport],
  };
}
const slugMapOf = (section) => SECTION_SLUG_MODULES[section].slugs;
const reservedSlugEntries = [];
for (const section of PUBLISHED_API_SECTIONS) {
  const key = section.api.family === null ? section.api.slugsKey : `${section.api.slugsKey}.${section.section}`;
  for (const [id, locales] of Object.entries(slugMapOf(section.section) ?? {})) {
    for (const [locale, slug] of Object.entries(locales ?? {})) {
      if (isReservedPublishedSlug(slug)) reservedSlugEntries.push(`${key}.${id}.${locale}=${slug}`);
    }
  }
}
for (const section of PUBLISHED_API_SECTIONS) {
  if (!section.api.reverseKey) continue;
  for (const [locale, slugs] of Object.entries(SECTION_SLUG_MODULES[section.section].reverse ?? {})) {
    for (const slug of Object.keys(slugs ?? {})) {
      if (isReservedPublishedSlug(slug)) reservedSlugEntries.push(`${section.api.reverseKey}.${locale}.${slug}`);
    }
  }
}
if (reservedSlugEntries.length > 0) {
  throw new Error(`reserved published slug(s) in source maps: ${reservedSlugEntries.join(', ')}`);
}
// L'ordine delle chiavi e' quello storico — la prima sezione, poi
// `fallbackReasons` di tutte, poi le altre — perche' slugs.json resti
// byte-identico a prima che le sezioni venissero dal core.
{
  const [first, ...rest] = API_SECTIONS;
  const slugsDoc = {
    commit,
    [first.api.slugsKey]: slugMapOf(first.section) ?? null,
    [first.api.reverseKey]: SECTION_SLUG_MODULES[first.section].reverse ?? null,
    fallbackReasons: Object.fromEntries(
      API_SECTIONS.map((section) => [
        section.api.slugsKey,
        SECTION_SLUG_MODULES[section.section].fallbackReasons ?? {},
      ]),
    ),
  };
  for (const section of rest) {
    slugsDoc[section.api.slugsKey] = slugMapOf(section.section) ?? null;
    slugsDoc[section.api.reverseKey] = SECTION_SLUG_MODULES[section.section].reverse ?? null;
  }
  // Le famiglie in coda, solo se accese: senza cantoni slugs.json resta
  // byte-identico. Annidate per sezione (`cantons.<canton-id>.<id>`), perche'
  // chi risolve uno slug deve sapere sotto quale prefisso vive; niente mappa
  // inversa, che il consumer deriva.
  for (const family of API_FAMILIES) {
    slugsDoc[family.api.slugsKey] = Object.fromEntries(
      family.sections.map((section) => [section.section, slugMapOf(section.section) ?? {}]),
    );
    slugsDoc.fallbackReasons[family.api.slugsKey] = Object.fromEntries(
      family.sections.map((section) => [section.section, SECTION_SLUG_MODULES[section.section].fallbackReasons ?? {}]),
    );
  }
  write('slugs.json', slugsDoc);
}



// ── Sitemaps ──────────────────────────────────────────────────────
//
// The article sitemaps are derived entirely from data this repo owns — registry,
// per-locale meta, slug maps — so they belong here, not in the site repo. Emitting
// them alongside the JSON is what lets a new article be announced to crawlers
// without the site deploying: the site serves these as static files.
//
// Shape matches what the site published before the split, byte-for-byte in
// structure: IT locs only, an image block, lastmod, monthly/0.7.
//
// SITE, xmlEsc, SECTION_PATHS and buildSitemap() itself live in
// ./lib/build-sitemap.mjs (imported above) — moved there so the sitemap logic
// can be unit-tested under plain `node --test` (see that file's header).

// One sanitisation point for every sitemap this file emits, on the assembled
// document rather than on each interpolated field: xmlEsc() escapes the five
// markup characters and has nothing to say about a control byte, and the parts
// that skip xmlEsc entirely (<loc>, <lastmod>) are as capable of carrying one.
const writeXml = (name, { xml, count }) => {
  const clean = sanitizeXmlDocument(xml);
  reportStrippedControlChars(path.join(OUT, name), xml, clean);
  assertNoControlChars(clean, name);
  fs.writeFileSync(path.join(OUT, name), clean);
  written[name] = byteSize(clean);
  console.log(`[build-api] ${name}: ${count} urls, ${(clean.match(/xhtml:link/g) ?? []).length} alternates, ${byteSize(clean)} bytes`);
  return count;
};

// Canonical overrides travel WITH the corpus: they decide which swiss articles
// may appear in the sitemap at all, so keeping them in the site repo would leave
// this publisher unable to produce a correct file.
//
// The frontaliere file (issue #138 item 1) is the engine's, not the corpus's:
// it ships inside packages/articles/engine/shared/ on the site and lands at
// engine/shared/ here via mirror-articles-engine.yml (see that file's _doc for
// why it lives in the engine and not in content/). Same shape as the swiss map
// — a flat `overrides` object keyed by the shadowed slug — so the same
// Object.keys() extraction applies unchanged; the only structural difference
// is an extra `_groups` block that documents which shadowed slugs share a
// winner, which this reader does not need. Which file belongs to which section
// is declared once, in corpus-sections.mjs (`canonicalOverrides`).
const SECTION_CANONICAL_SHADOW = {};
for (const section of PUBLISHED_API_SECTIONS) {
  const shadowed = new Set(
    section.canonicalOverrides
      ? Object.keys(JSON.parse(fs.readFileSync(path.join(ROOT, section.canonicalOverrides), 'utf-8')).overrides ?? {})
      : [],
  );
  SECTION_CANONICAL_SHADOW[section.section] = shadowed;
  console.log(`[build-api] shadowed ${section.section} slugs excluded: ${shadowed.size}`);
}
const shadowedFrontaliereSlugs = SECTION_CANONICAL_SHADOW[FRONTALIERE.section];

const SECTION_META_IT = {};
for (const section of PUBLISHED_API_SECTIONS) {
  SECTION_META_IT[section.section] = await loadSectionMeta(section, 'it');
}
// Daily editions carry their date in the id, and slugs.it === id, so the
// retired set plugs straight into buildSitemap's shadowed parameter.
const retiredDailyEditions = selectRetiredDailyEditions(ARTICLES.map((a) => a.id));
console.log(`[build-api] retired daily editions de-listed from sitemap: ${retiredDailyEditions.size}`);
const retiredDailyEditionSlugs = new Set(
  [...retiredDailyEditions].map((id) => slugMapOf(FRONTALIERE.section)?.[id]?.it ?? id),
);
// buildSitemap takes a single `shadowed` set, so the section that publishes
// daily editions (frontaliere) unions the two de-listing reasons — retired
// daily editions and canonical-shadowed duplicates — while every other section
// gets its own canonical set alone, as svizzera always did.
//
// Una sezione di famiglia de-lista anche gli articoli che il SUO registro
// dichiarato ritira (`gone`) o sposta (`redirects`): il Worker li serve 410 o
// 301, e ne' una `<loc>` ne' un alternate che non risponde 200 stanno in una
// sitemap. Il registro accetta path canonici in QUALSIASI locale, quindi
// basta che UNA variante dell'articolo sia ritirata per toglierlo intero
// (la voce porta loc IT e i quattro alternate insieme).
const retiredByRegistry = (section) =>
  registryRetiredSlugs(declaredSections.sections[section.section], slugMapOf(section.section), SECTION_PATHS[section.section]);
const SECTION_SITEMAP_SHADOW = Object.fromEntries(
  PUBLISHED_API_SECTIONS.map((section) => [
    section.section,
    section.retiredDailyEditions
      ? new Set([...retiredDailyEditionSlugs, ...SECTION_CANONICAL_SHADOW[section.section]])
      : section.api.family !== null
        ? new Set([...SECTION_CANONICAL_SHADOW[section.section], ...retiredByRegistry(section)])
        : SECTION_CANONICAL_SHADOW[section.section],
  ]),
);
// La dimensione di pagina dell'archivio viene dalla sorgente unica dell'host
// (il valore cablato nel SiteShellContract dell'engine): la usano la sitemap
// dell'archivio storico e quella di ogni sezione di famiglia.
const { ARTICLES_PAGE_SIZE } = await load('host/seoHubsData.ts');
const sitemapCounts = {};
/** Articoli emessi per sezione di famiglia: il pavimento si misura su questi, non su landing e hub. */
const familySitemapArticles = {};
for (const section of PUBLISHED_API_SECTIONS) {
  if (section.api.family !== null) {
    const built = buildFamilySectionSitemap({
      section: section.section,
      entries: SECTION_REGISTRIES[section.section],
      slugMap: slugMapOf(section.section),
      meta: SECTION_META_IT[section.section],
      pageSize: ARTICLES_PAGE_SIZE,
      shadowed: SECTION_SITEMAP_SHADOW[section.section],
      retiredPaths: new Set([
        ...Object.keys(declaredSections.sections[section.section]?.redirects ?? {}),
        ...(declaredSections.sections[section.section]?.gone ?? []),
      ]),
    });
    sitemapCounts[section.section] = writeXml(section.api.sitemap, built);
    familySitemapArticles[section.section] = built.articleCount;
    continue;
  }
  sitemapCounts[section.section] = writeXml(
    section.api.sitemap,
    buildSitemap(
      SECTION_REGISTRIES[section.section],
      section.section,
      slugMapOf(section.section),
      SECTION_META_IT[section.section],
      SECTION_SITEMAP_SHADOW[section.section],
    ),
  );
}
// I pavimenti sono relativi al registro IT meno le esclusioni esplicite già
// validate (canonical override e daily edition ritirate), non al predicato del
// builder: un filtro nuovo o una slug map troncata deve far scattare il floor,
// non abbassarlo insieme alla sitemap. Gli override hanno una chiave per
// locale, mentre questa sitemap ha una sola URL per articolo. Il vecchio `< 100`
// proteggeva il 2,6% del corpus frontaliere e non proteggeva affatto la sitemap
// svizzera; un parse troncato restava quindi pubblicabile senza errori.
//
// Politica per tipo (corpus-floors.mjs, `KIND_FLOOR_POLICY`): le sezioni
// storiche hanno il pavimento proprio e una sitemap vuota e' un rifiuto; una
// sezione di famiglia (cantonale) parte legittimamente a zero, quindi si
// giudica la famiglia nel suo insieme. Con le due sezioni storiche la regola e'
// esattamente quella di prima.
const sitemapSources = {};
const familySitemapRows = [];
for (const section of PUBLISHED_API_SECTIONS) {
  const file = section.api.sitemap;
  const source = countSourceSitemapEntries(ROOT, section.section);
  sitemapSources[section.section] = source;
  if (floorPolicyOf(section.section) === 'family') {
    // Gli articoli che il registro ritira (`gone`/`redirects`) escono dalla
    // sitemap per scelta dichiarata: vanno tolti anche dal RIFERIMENTO, come
    // gli override canonici, altrimenti un ritiro intenzionale oltre il 10%
    // sembrerebbe un troncamento e fermerebbe l'intera pubblicazione.
    const retired = new Set(retiredByRegistry(section));
    const retiredSource = countSitemapEntries(
      SECTION_REGISTRIES[section.section].filter((article) => retired.has(slugMapOf(section.section)?.[article.id]?.it)),
      slugMapOf(section.section),
      SECTION_CANONICAL_SHADOW[section.section],
    );
    familySitemapRows.push({
      section: section.section,
      source: Math.max(0, source - retiredSource),
      emitted: familySitemapArticles[section.section] ?? 0,
    });
    continue;
  }
  if (source <= 0) {
    throw new Error(`${file} has no emittable IT registry entries — refusing to publish an empty sitemap`);
  }
  const floor = floorFrom(source);
  if (sitemapCounts[section.section] < floor) {
    throw new Error(
      `${file} has only ${sitemapCounts[section.section]} urls against ${source} emittable IT registry entries ` +
        `(floor ${floor}) — refusing to publish a truncated sitemap`,
    );
  }
  console.log(`[build-api] ${file}: ${sitemapCounts[section.section]} urls (floor ${floor}, derived from emitted IT entries)`);
}
if (familySitemapRows.length > 0) {
  const verdict = familyFloorVerdict(familySitemapRows);
  if (verdict.truncated) {
    throw new Error(
      `family sitemaps (${verdict.sections.join(', ')}) have only ${verdict.emitted} urls against ${verdict.source} ` +
        `emittable IT registry entries (floor ${verdict.floor}; emptied: ${verdict.emptied.join(', ') || 'none'}) ` +
        '— refusing to publish a truncated family',
    );
  }
}

// ── Archive pages (issue #4974) ───────────────────────────────────────────
// `/{section}/{all}/` and its `page-N` chain existed and appeared in NO
// sitemap. `emitSeoHubs` pushes an entry per page, but only into the sitemap
// the site build writes — and the site stopped emitting these pages when
// BUILD_EMIT_SKIP went on, while fast-publish (which does emit them) passes
// `sitemapEntries: []`. Measured on the live index: zero archive URLs across
// every sitemap it lists. With every locale now emitting every page, that is
// ~240 indexable pages declared nowhere.
//
// Page count comes from the SAME union the emitter paginates
// (`readArticleArchiveUnionSlugs`), so this file cannot list a page the
// archive does not have. The page size comes from the host's single source,
// which is the value wired into the engine's SiteShellContract.
//
// Solo le sezioni con superficie PROPRIA: l'archivio di una sezione di
// famiglia sta nella SUA sitemap (`buildFamilySectionSitemap`), che il Worker
// serve solo mentre la sezione e' live — questo file invece e' servito sempre.
// `ARCHIVE_ALL_SLUG` viene da build-sitemap.mjs, la stessa tabella che usa la
// sitemap di famiglia.
const { readArticleArchiveUnionSlugs } = await load('engine/shared/articleArchiveUnion.ts');
const { ARTICLE_SECTIONS } = await load('articleSections.ts');

function archiveBase(section, locale) {
  const prefix = locale === 'it' ? '' : `/${locale}`;
  return `${prefix}/${ARTICLE_SECTIONS[section].indexSlug[locale]}/${ARCHIVE_ALL_SLUG[locale]}/`;
}

const archiveSources = {};
function buildArchiveSitemap() {
  const urls = [];
  const familyRows = [];
  for (const section of API_SECTIONS.map(({ section: id }) => id)) {
    const total = readArticleArchiveUnionSlugs(fs, path, ROOT, section).size;
    // Per una sezione di famiglia `sectionFloor` vale 0 (sezione nuova): il
    // troncamento si giudica sulla famiglia, dopo il loop.
    const floor = sectionFloor(ROOT, section);
    if (floorPolicyOf(section) === 'family') {
      familyRows.push({ section, source: countSourceArticles(ROOT, section), emitted: total });
    } else if (total < floor) {
      throw new Error(
        `${section} archive has only ${total} entries against ${floor} required by the corpus floor ` +
          `— refusing to publish a truncated archive sitemap`,
      );
    }
    const pages = Math.max(1, Math.ceil(total / ARTICLES_PAGE_SIZE));
    archiveSources[section] = { total, floor, pages };
    for (const locale of LOCALES) {
      for (let page = 1; page <= pages; page++) {
        const base = archiveBase(section, locale);
        const loc = page === 1 ? base : `${base.slice(0, -1)}/page-${page}/`;
        const parts = [`  <url>`, `    <loc>${SITE}${loc}</loc>`];
        // Alternates on page 1 only — that is where the emitted page carries
        // hreflang (buildHtml gates them the same way). Declaring alternates
        // the page itself does not serve is its own SEO defect.
        if (page === 1) {
          for (const alt of LOCALES) {
            parts.push(
              `    <xhtml:link rel="alternate" hreflang="${alt}" href="${SITE}${archiveBase(section, alt)}" />`,
            );
          }
          parts.push(
            `    <xhtml:link rel="alternate" hreflang="x-default" href="${SITE}${archiveBase(section, 'it')}" />`,
          );
        }
        parts.push(`    <changefreq>daily</changefreq>`);
        parts.push(`    <priority>${page === 1 ? '0.6' : '0.4'}</priority>`);
        parts.push(`  </url>`);
        urls.push(parts.join('\n'));
      }
    }
  }
  if (familyRows.length > 0) {
    const verdict = familyFloorVerdict(familyRows);
    if (verdict.truncated) {
      throw new Error(
        `family archives (${verdict.sections.join(', ')}) have only ${verdict.emitted} entries against ` +
          `${verdict.floor} required by the corpus floor (emptied: ${verdict.emptied.join(', ') || 'none'}) ` +
          '— refusing to publish a truncated archive sitemap',
      );
    }
  }
  return {
    xml:
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"\n` +
      `        xmlns:xhtml="http://www.w3.org/1999/xhtml">\n` +
      urls.join('\n') +
      `\n</urlset>\n`,
    count: urls.length,
  };
}

sitemapCounts.archive = writeXml(ARCHIVE_SITEMAP, buildArchiveSitemap());
console.log(
  `[build-api] ${ARCHIVE_SITEMAP}: ${sitemapCounts.archive} urls ` +
    `(pages derived from ${Object.entries(archiveSources)
      .map(([section, { total, floor, pages }]) => `${section}=${total} entries/${floor} floor/${pages} pages`)
      .join(', ')})`,
);

// ── RSS feeds ─────────────────────────────────────────────────────
//
// Same argument as the sitemaps: the feeds are a pure function of the corpus,
// so the repo that owns the corpus is the one that can emit them without being
// a publish cycle behind. The generator itself is NOT reimplemented here — it
// is `engine/rssFeeds.mjs`, the very module the site repo calls, arriving with
// the mirror. A second copy would drift silently: nobody diffs a feed once it
// is served, so a divergence surfaces only when an aggregator drops the channel.
//
// `layout` is the whole difference between the two callers: the site keeps the
// corpus under services/, this repo under content/.
//
// ── `registries` is passed UNFILTERED, and that is the decision, not an omission ──
//
// The canonical-override shadowing applied above stops at the sitemaps. Both
// override files say so in their own `_doc`, which is where the rule was
// written down before any of this code existed:
//
//   content/swiss-article-canonical-overrides.json:
//     "RSS (rss-svizzera*.xml) is NOT touched by this: RSS item lists are not
//      covered by the self-canonical sitemap gate, and normal RSS semantics
//      include all published items regardless of canonical hint."
//   engine/shared/frontaliere-article-canonical-overrides.json:
//     "RSS is NOT touched, same as the svizzera precedent."
//
// The rule the shadowing implements is narrow and mechanical: "a sitemap <loc>
// whose page canonicalises elsewhere is a hard CI gate failure"
// (scripts/audit-sitemap-canonicals.mjs, scripts/validate-sitemap-pages.mjs).
// sitemap-blog.xml and sitemap-news-candidates.xml are sitemaps and are gated;
// an RSS <item> is not a <loc> and no gate reads it. The shadowed page also
// stays live by house rule — no removal, no noindex, no redirect — so dropping
// its already-published item from the feed would be a retroactive un-publish of
// a page that is still there, which is the "cut" that rule exists to forbid.
//
// Measured on the emitted feeds (2026-08-10, 3166 articles, this script run
// end to end): of the 8 override keys, exactly ONE article carries a `<link>` in
// any feed — `lavoro-piastrellista-ticino-frontaliere` and its three localised
// slugs, one item per locale. The other shadowed article
// (`piastrellista-frontaliere-ticino-guadagno`, dated 2026-07-20) is already
// past RSS_MAX_ITEMS=50 in all ten feeds. So the reach of this decision is one
// article, and the winner is in the same feeds alongside it — which is the
// documented outcome, not a leak.
//
// If the policy is ever reversed, the filter does NOT belong on this line: the
// `_doc` of both override files has to change first, and the exclusion belongs
// inside engine/rssFeeds.mjs (one module, two callers — that module's header
// forbids caller-side divergence by construction). generator/tests/frontaliere-sitemap-shadow.test.mjs
// pins both halves of that.
//
// Una chiamata PER SEZIONE (e' cio' che `buildAllRssFeeds` fa, sezione per
// sezione) invece di una sola con un layout unico, perche' radice e layout non
// sono gli stessi per tutte:
//   - le due storiche si leggono dalla radice del repo col layout di sempre
//     (`sectionRssLayout`: `content/seo`, `content`, mappa slug in `content/`),
//     quindi i loro feed sono byte-identici;
//   - una sezione di famiglia (cantonale) si legge attraverso la VISTA nel
//     layout dell'engine (scripts/lib/engine-corpus-view.mjs): la sua mappa
//     slug sta nella sua cartella, e il suo chunk SEO ha nel corpus un nome
//     (`content/cantons/<id>/seo.ts`) diverso da quello che l'engine cerca
//     (`seo-blog-<id>.ts`). Senza la vista il feed uscirebbe senza item, o con
//     gli id al posto degli slug nei link.
const familyRssView = API_FAMILIES.length ? createEngineCorpusView(ROOT, process.env.RUNNER_TEMP || os.tmpdir()) : null;
let rssSections;
try {
  rssSections = RSS_SECTIONS.map((section) => {
    const published = PUBLISHED_BY_SECTION[section.id];
    const viaView = Boolean(familyRssView && published?.api.family !== null);
    return buildSectionFeeds({
      fs,
      path,
      rootDir: viaView ? familyRssView : ROOT,
      section,
      registry: SECTION_REGISTRIES[section.id] ?? [],
      layout: viaView ? engineViewRssLayout(published.slugFile) : sectionRssLayout(section.id),
      // Il corpus e' il produttore REALE dei feed: il sito chiama l'engine solo
      // dai test. Se questa riga manca, la riparazione della coda resta inerte
      // in produzione dietro una CI verde del sito — la stessa forma
      // dell'incidente SiteShellContract.
      repairSerpSnippet,
    });
  });
} finally {
  if (familyRssView) fs.rmSync(familyRssView, { recursive: true, force: true });
}
// La mappa slug che il feed ha letto deve essere quella che questo script ha
// emesso in slugs.json: se l'engine ne trova un'altra (o nessuna) i link dei
// feed ricadono sugli id grezzi, e il feed resta «valido». Per le sezioni di
// famiglia e' un rifiuto; le storiche hanno il loro confronto nel gate dei
// counts (slugs.json contro il registro).
for (const section of rssSections) {
  const published = PUBLISHED_BY_SECTION[section.id];
  if (!published || published.api.family === null) continue;
  const emitted = Object.keys(slugMapOf(section.id) ?? {}).length;
  if (section.slugCount !== emitted) {
    throw new Error(
      `rss: la sezione ${section.id} ha letto ${section.slugCount} slug da ${published.slugFile}, ` +
        `slugs.json ne pubblica ${emitted} — refusing (i link dei feed userebbero gli id grezzi)`,
    );
  }
}

let rssFeedCount = 0;
let rssItemTotal = 0;
// Stessa politica per tipo delle sitemap: una sezione storica senza feed, o un
// suo feed senza item, e' un rifiuto; una sezione di famiglia nuova puo' non
// averne, e il rifiuto passa alla famiglia (articoli in sorgente, zero item
// emessi in tutta la famiglia).
const familyRssRows = [];
for (const section of rssSections) {
  const familyPolicy = floorPolicyOf(section.id) === 'family';
  if (section.feeds.length === 0 && !familyPolicy) {
    throw new Error(
      `rss: section '${section.id}' produced no feeds (${section.articleCount} articles parsed) — refusing to publish`,
    );
  }
  let sectionItems = 0;
  for (const [name, xml] of section.feeds) {
    const items = countXmlTags(xml, 'item');
    if (items === 0 && !familyPolicy) throw new Error(`rss: ${name} has no <item> entries — refusing to publish`);
    sectionItems += items;
    // The feeds come out of engine/rssFeeds.mjs, which arrives by mirror and is
    // not ours to edit here (a change would be overwritten on the next mirror
    // run). Sanitising where this script writes them keeps the fix in the repo
    // that owns the write, and covers whatever the shared builder hands over.
    const clean = sanitizeXmlDocument(xml);
    reportStrippedControlChars(path.join(OUT, name), xml, clean);
    assertNoControlChars(clean, name);
    fs.writeFileSync(path.join(OUT, name), clean);
    written[name] = byteSize(clean);
    rssFeedCount++;
    rssItemTotal += items;
    console.log(`[build-api] ${name}: ${items} items, ${byteSize(clean)} bytes`);
  }
  // Il riferimento e' il corpus (i corpi IT della sezione), non
  // `section.articleCount`: quello lo produce lo stesso parser dei chunk SEO
  // che scrive il feed, quindi un chunk SEO mancante o troncato lo azzererebbe
  // insieme agli item e la sezione svuotata passerebbe per «nuova».
  if (familyPolicy) familyRssRows.push({ section: section.id, source: countSourceArticles(ROOT, section.id), emitted: sectionItems });
}
// Per i feed vale solo la meta' «nessuna sezione svuotata» del verdetto di
// famiglia: un feed e' una finestra (RSS_MAX_ITEMS), quindi la somma degli item
// non si confronta con la somma degli articoli. Ogni sezione di famiglia con
// articoli in sorgente deve emettere almeno un item, anche se le altre ne
// emettono.
if (familyRssRows.length > 0) {
  const { emptied } = familyFloorVerdict(familyRssRows);
  if (emptied.length > 0) {
    throw new Error(
      `rss: family section(s) ${emptied.join(', ')} have articles but no <item> in any feed — refusing to publish`,
    );
  }
}

// ── News-ticker payload ───────────────────────────────────────────
//
// The homepage ticker shows the 5 newest articles. The site used to compute
// this at build time from its own copy of the corpus; it now consumes this
// file, which means a newly published article reaches the ticker without a
// site build. `hubLocales` is passed explicitly — `computeTickerArticles`
// otherwise reads it from the site shell, which does not exist here (that
// coupling is exactly what issue #4974 item 2 removed).
//
// ── ARTICLES is passed UNFILTERED here too, for a second and harder reason ──
//
// Same sitemap-only scope as the RSS block above (see it for the `_doc`
// citations): news-ticker-live.json is a homepage widget payload, not a sitemap,
// and no self-canonical gate reads it.
//
// But this artifact has THREE producers, all calling this same
// `computeTickerArticles` with an unfiltered registry:
//   1. frontaliere-si-o-no/vite.config.ts -> newsTickerDataPlugin -> the
//      committed data/news-ticker-data.ts (site build time);
//   2. frontaliere-si-o-no/scripts/publish-article-chunks.mjs -> the CDN key
//      `data/news-ticker-live.json` (fast-publish, out of band);
//   3. this call -> dist/api/news-ticker-live.json, which the site pulls back
//      via scripts/pull-articles-api.mjs.
// Producers 2 and 3 write the SAME payload for the SAME consumer. Filtering
// only here would make the homepage's top-5 depend on which of the two wrote
// last — a real, visible divergence introduced by a fix, and precisely the
// caller-side drift engine/newsTickerDataPlugin.ts is shared to make impossible.
//
// Measured on the emitted payload (2026-08-10): the five slugs in
// news-ticker-live.json are all dated 2026-08-10 and none is shadowed — zero
// exposure today. The exposure is latent and bounded by the ~2h window the five
// newest articles span at the current publishing rate, while a canonical
// override is an owner decision taken hours later (the piastrellista group was
// decided the day after publication, when the newest of the three was already
// 29 articles deep).
//
// So if the ticker should ever exclude shadowed articles, the filter goes inside
// computeTickerArticles — which lives in the engine and is edited on the SITE
// (packages/articles/engine), never here, or the next mirror overwrites it.
//
// Issue #166 (round-3 adversarial follow-up to #152): the "latent" window above
// is real, not zero, so the same-day case is DETECTED — not filtered, for the
// exact caller-drift reason above — via findShadowedTickerArticles below. It
// logs and counts (manifest.json `counts.tickerArticlesShadowed`) so the risk
// is visible the day it stops being latent, instead of only in this comment.
const { computeTickerArticles } = await load('engine/newsTickerDataPlugin.ts');
const tickerArticles = computeTickerArticles(fs, path, ROOT, ARTICLES, {
  hubLocales: LOCALES,
  metaDir: 'content',
  slugDataFile: FRONTALIERE.slugFile,
});
if (tickerArticles.length === 0) {
  throw new Error('news-ticker-live.json would be empty — refusing to publish');
}
for (const art of tickerArticles) {
  for (const loc of LOCALES) {
    if (!art.title?.[loc] || art.title[loc] === `blog.article.${art.id}.title`) {
      throw new Error(
        `news-ticker: article '${art.id}' has no ${loc} title (raw i18n key would ship) — refusing to publish`,
      );
    }
    if (!art.slug?.[loc]) {
      throw new Error(`news-ticker: article '${art.id}' has no ${loc} slug — refusing to publish`);
    }
  }
}
// Detect-only, not filter (see the long _doc above and
// scripts/lib/ticker-shadow-check.mjs): a same-day canonical-override on a
// still-in-window ticker article is published exactly as before, but now
// loud in the build log and countable in manifest.json instead of silent.
const shadowedTickerArticles = findShadowedTickerArticles(tickerArticles, shadowedFrontaliereSlugs);
if (shadowedTickerArticles.length > 0) {
  console.warn(
    `[build-api] news-ticker-live.json: ${shadowedTickerArticles.length} of ${tickerArticles.length} ` +
      `ticker articles are canonical-overridden (shadowed) — homepage ticker may link a superseded slug ` +
      `(issue #166): ${shadowedTickerArticles.map((a) => a.id).join(', ')}`,
  );
}
write('news-ticker-live.json', { schema: 1, articles: tickerArticles });

// ── Google News candidates (migration §7.2) ───────────────────────
//
// §3 picks option (a): THIS repo decides Google News eligibility once, from the
// whitelist vendored into its own tree, and publishes the resulting <url> blocks
// as candidates. The site never re-decides eligibility — it merges these over
// what it is serving and applies the mechanical 48h prune. Two independent
// eligibility codepaths is the "two producers, last writer wins" failure that
// create-article's own modifySitemap() comment warns about.
//
// Derived from the corpus rather than accumulated in a committed file, for the
// same reason sitemap-blog.xml and the feeds are: a state file that create-article
// appends to would be a second source of truth that drifts the moment a run dies
// between writing the corpus and writing the file. This is a pure function of the
// registry, so republishing on every push is idempotent and self-healing.
//
// The candidate set is ALLOWED to be empty, and the file is emitted anyway: the
// window prunes it every day and a quiet day is a correct outcome, not an absence.
// The consumer accepts an empty <urlset> and refuses a non-sitemap document, so
// emitting always is also what lets it run under --require-new.
{
  /**
   * Per-article SEO text the whitelist matches on. `keywords` lives only in the
   * seo-blog*.ts chunks, so it has to be read from there; `articleSection` and
   * `tags` are NOT persisted anywhere in this repo (create-article has them only
   * in memory during generation), so the registry's `category` stands in for
   * articleSection and tags are simply absent. That is the whole of what the
   * corpus retains — not a sampling of it.
   */
  const seoTextById = new Map();
  for (const section of RSS_SECTIONS) {
    for (const file of section.seoFiles) {
      const fp = path.join(ROOT, 'content', 'seo', file);
      if (!fs.existsSync(fp)) continue;
      const src = fs.readFileSync(fp, 'utf-8');
      for (const [id, metadata] of collectSeoEntryMetadata(src)) {
        seoTextById.set(id, metadata);
      }
    }
  }

  const NEWS_PUBLICATION = 'Frontaliere Ticino';
  const now = Date.now();

  const candidateBlocks = [];
  let considered = 0;

  const collect = (entries, sectionId, slugMap, meta, shadowed = new Set()) => {
    const paths = SECTION_PATHS[sectionId];
    for (const a of entries) {
      const slug = slugMap?.[a.id]?.it;
      if (!slug || isReservedPublishedSlug(slug)) continue;
      // Same self-canonical gate sitemap-blog.xml enforces (buildSitemap in
      // scripts/lib/build-sitemap.mjs): a canonical-shadowed article's own page
      // points elsewhere, so listing its <loc> here is the same defect this PR
      // fixes for the blog sitemap, just in the news-candidates feed instead.
      if (shadowed.has(slug)) continue;
      const publishedAt = a.date;
      if (!publishedAt) continue;
      considered += 1;

      const title = meta[`blog.article.${a.id}.title`] || '';
      const seo = seoTextById.get(a.id) ?? {};
      // headline and title are the same string for every generator-written
      // article, but create-article's own gate reads BOTH — so both are fed in
      // rather than assuming they agree. They go into the `title` slot because
      // the vendored predicate is a byte-faithful mirror of main's, and adding a
      // field to it here is precisely the divergence the vendoring forbids.
      const titleText = [title, seo.headline].filter(Boolean).join(' ');

      if (
        !isArticleNewsEligible(
          {
            slug,
            title: titleText,
            articleSection: a.category,
            keywords: seo.keywords,
            publishedAt,
          },
          now,
        )
      ) {
        continue;
      }

      const itLoc = `${SITE}${paths.it}${xmlEsc(slug)}/`;
      const img = a.image ? (a.image.startsWith('http') ? a.image : SITE + a.image) : null;

      // Match the blog sitemap: initial publication is the first content change;
      // an editorial update supersedes it. Rebuilding is not a content change.
      const lastmod = a.updatedAt || publishedAt;
      const parts = [`  <url>`, `    <loc>${itLoc}</loc>`, `    <lastmod>${xmlEsc(lastmod)}</lastmod>`];
      for (const loc of LOCALES) {
        const s2 = slugMap?.[a.id]?.[loc];
        if (s2 && !isReservedPublishedSlug(s2)) {
          parts.push(
            `    <xhtml:link rel="alternate" hreflang="${loc}" href="${SITE}${paths[loc]}${xmlEsc(s2)}/" />`,
          );
        }
      }
      parts.push(
        `    <xhtml:link rel="alternate" hreflang="x-default" href="${itLoc}" />`,
        `    <news:news>`,
        `      <news:publication>`,
        `        <news:name>${NEWS_PUBLICATION}</news:name>`,
        `        <news:language>it</news:language>`,
        `      </news:publication>`,
        // The consumer refuses a block without this field and prunes on it, so
        // it carries the registry's own timestamp verbatim. Generator-written
        // entries hold a full ISO instant; the handful of legacy day-only dates
        // resolve to midnight UTC, which costs part of a window but never
        // fabricates freshness.
        `      <news:publication_date>${xmlEsc(publishedAt)}</news:publication_date>`,
        `      <news:title>${xmlEsc(title)}</news:title>`,
        `    </news:news>`,
      );
      if (img) {
        parts.push(
          `    <image:image>`,
          `      <image:loc>${xmlEsc(img)}</image:loc>`,
          `      <image:title>${xmlEsc(title)}</image:title>`,
          `    </image:image>`,
        );
      }
      parts.push(`  </url>`);
      candidateBlocks.push(parts.join('\n'));
    }
  };

  for (const section of API_SECTIONS) {
    collect(
      SECTION_REGISTRIES[section.section],
      section.section,
      slugMapOf(section.section),
      SECTION_META_IT[section.section],
      SECTION_SITEMAP_SHADOW[section.section],
    );
  }

  const candidatesXmlRaw =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"\n` +
      `        xmlns:news="http://www.google.com/schemas/sitemap-news/0.9"\n` +
      `        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1"\n` +
      `        xmlns:xhtml="http://www.w3.org/1999/xhtml">\n` +
      (candidateBlocks.length ? candidateBlocks.join('\n') + '\n' : '') +
      `</urlset>\n`;
  const candidatesXml = sanitizeXmlDocument(candidatesXmlRaw);
  reportStrippedControlChars(path.join(OUT, NEWS_CANDIDATES), candidatesXmlRaw, candidatesXml);
  assertNoControlChars(candidatesXml, NEWS_CANDIDATES);

  fs.writeFileSync(path.join(OUT, NEWS_CANDIDATES), candidatesXml);
  written[NEWS_CANDIDATES] = byteSize(candidatesXml);
  newsCandidateCount = candidateBlocks.length;
  console.log(
    `[build-api] ${NEWS_CANDIDATES}: ${candidateBlocks.length} candidates from ` +
      `${considered} dated articles (${NEWS_SITEMAP_WINDOW_HOURS}h window), ${byteSize(candidatesXml)} bytes`,
  );
}

// ── Hero images (migration §7.1) ──────────────────────────────────
//
// Unlike every other artifact here an image cannot be re-derived by the consumer,
// so it has to be transferred. The manifest is a plain list, not a diff: it is
// republished whole on every push and the site downloads only what it is missing,
// which keeps the pull idempotent without either side tracking the other's state.
//
// Emitted ONLY when there is at least one image. The consumer refuses a manifest
// listing zero images — deliberately, since an empty list is indistinguishable
// from a publisher that broke halfway — so publishing one while generation still
// runs in the site repo (and this repo therefore holds no images at all) would
// turn every sync red. Absence is the correct signal until the generator cuts
// over and starts writing public/images/blog/ here.
{
  const srcDir = path.join(ROOT, ...IMAGE_SRC_DIR);
  const files = fs.existsSync(srcDir)
    ? fs.readdirSync(srcDir).filter((f) => f.endsWith('.webp')).sort()
    : [];

  if (files.length === 0) {
    console.log(
      `[build-api] ${IMAGE_MANIFEST}: not emitted — public/images/blog holds no .webp ` +
        `(the consumer refuses a zero-image manifest; absence is the correct signal)`,
    );
  } else {
    const destDir = path.join(OUT, 'images', 'blog');
    fs.mkdirSync(destDir, { recursive: true });
    const images = [];
    for (const file of files) {
      const bytes = fs.readFileSync(path.join(srcDir, file));
      fs.writeFileSync(path.join(destDir, file), bytes);
      images.push({ id: file.replace(/\.webp$/, ''), path: `images/blog/${file}`, bytes: bytes.length });
    }
    write(IMAGE_MANIFEST, { commit, images });
    imageCount = images.length;
    console.log(`[build-api] images/blog: ${images.length} files copied to dist/api`);
  }
}

// ── Border-wait ranking snapshot (migration §4) ───────────────────
//
// generate-border-wait-ranking-article.mjs writes public/data/border-wait-ranking.json
// alongside the article bodies. That file is NOT article content — it feeds the
// site's InlineBorderWaitRanking chart — so §4 left it as an open question:
// either the site keeps producing it, or this repo produces it and the site pulls
// it. This is the second option, and it is the only one consistent with the rest
// of the split: the ranking is computed from the same 7-day window this repo
// already fetches, so having the site recompute it would mean two producers of
// one number, disagreeing whenever their windows differ by a run.
//
// Republished verbatim, not re-derived: whatever the generator wrote is what the
// site gets. Absent until the ranking producer has run at least once here, which
// is why this is emitted conditionally rather than gated — the site's pull treats
// it exactly like the image manifest, absence meaning "not produced yet".
{
  const src = path.join(ROOT, ...BORDER_RANKING_SRC);
  if (fs.existsSync(src)) {
    const raw = fs.readFileSync(src, 'utf-8');
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`public/data/border-wait-ranking.json is not valid JSON: ${err.message}`);
    }
    // A ranking with no crossings would blank the live chart. Refuse rather than
    // publish it — the site cannot tell an empty ranking from a broken one.
    const entries = Array.isArray(parsed?.ranking) ? parsed.ranking : null;
    if (!entries || entries.length === 0) {
      throw new Error('border-wait-ranking.json carries no ranking entries — refusing to publish');
    }
    // Still verbatim in the normal case: sanitizeJsonText returns the original
    // text unless the document actually carries a control character.
    const clean = sanitizeJsonText(raw);
    reportStrippedControlChars(path.join(OUT, BORDER_RANKING), raw, clean);
    fs.writeFileSync(path.join(OUT, BORDER_RANKING), clean);
    written[BORDER_RANKING] = byteSize(clean);
    borderRankingEntries = entries.length;
    console.log(`[build-api] ${BORDER_RANKING}: ${entries.length} crossings, ${byteSize(clean)} bytes`);
  } else {
    console.log(
      `[build-api] ${BORDER_RANKING}: not emitted — the ranking producer has not run here yet`,
    );
  }
}

// Daily-brief snapshot (Bollettino del Frontaliere): same contract as the
// border-wait ranking above — republished verbatim from the generator's
// output, absent until refresh-daily-brief-data.mjs has run here at least
// once. Consumers (the daily email digest) refuse a set they can't trust via
// `counts.availableBlocks` and `dateIso`, so the only thing worth refusing at
// build time is a payload that carries no blocks at all.
{
  const src = path.join(ROOT, ...DAILY_BRIEF_SRC);
  if (fs.existsSync(src)) {
    const raw = fs.readFileSync(src, 'utf-8');
    try {
      JSON.parse(raw);
    } catch (err) {
      throw new Error(`public/data/daily-brief.json is not valid JSON: ${err.message}`);
    }
    const clean = sanitizeJsonText(raw);
    const served = JSON.parse(clean);
    const available = Object.values(served?.blocks ?? {}).filter((b) => b?.available).length;
    if (available < 1) {
      throw new Error('daily-brief.json carries no available blocks — refusing to publish');
    }
    reportStrippedControlChars(path.join(OUT, DAILY_BRIEF), raw, clean);
    fs.writeFileSync(path.join(OUT, DAILY_BRIEF), clean);
    written[DAILY_BRIEF] = byteSize(clean);
    dailyBriefBlocks = available;
    console.log(`[build-api] ${DAILY_BRIEF}: ${available}/4 blocks (${served?.dateIso}), ${byteSize(clean)} bytes`);
  } else {
    console.log(
      `[build-api] ${DAILY_BRIEF}: not emitted — the daily-brief producer has not run here yet`,
    );
  }
}

// Plate-auction editorial companion. The upstream catalogue belongs to the
// site/API side of the boundary, so this publisher reads it over HTTP and never
// imports a site file or copies its static fallback. An unavailable upstream
// must not erase the evergreen guide or block the otherwise healthy article
// publish: the weekly block records the unavailable state explicitly.
{
  const input = await fetchPlateAuctionEditorialInput();
  const editorial = buildPlateAuctionEditorial({
    snapshot: input.snapshot,
    upstreamStatus: input.status,
    generatedAt: new Date().toISOString(),
  });
  if (input.errorCode) editorial.source.errorCode = input.errorCode;
  write(PLATE_AUCTION_EDITORIAL, editorial);
  plateAuctionEditorialLocales = Object.keys(editorial.evergreen ?? {}).length;
  console.log(
    `[build-api] ${PLATE_AUCTION_EDITORIAL}: ${editorial.status}, ` +
      `${plateAuctionEditorialLocales} evergreen locales`,
  );
}

// ── Registro delle sezioni (piano «sezioni articoli per cantone», P7) ────────
//
// `sections/registry.json` dichiara lo stato di ogni sezione cantonale; qui
// diventa il catalogo per il sito (`sections.json`), la copia che il Worker
// legge da R2 (`edge/sections/registry.json`) e l'indice delle sitemap per
// sezione (`sitemap-cantons.xml`). Il kill-switch di Remote Config spegne le
// sezioni elencate; la copia per il Worker non si scrive se il kill-switch non
// e' verificabile e una sezione e' dichiarata live (vedi section-registry.mjs).
// Con tutte le sezioni in `draft` (oggi) i documenti esistono ma non accendono
// niente: il Worker resta fail-closed e l'indice non viene emesso.
const killSwitch = resolveKillSwitch(process.env);
const effectiveSections = effectiveStatuses(declaredSections, killSwitch);
if (killSwitch.unknown.length) {
  console.warn(
    `::warning::CANTON_ARTICLE_SECTIONS_KILL: token non riconosciuti ignorati: ${killSwitch.unknown.join(', ')} ` +
      '(attesi codici di gruppo, id canton-<x> o all)',
  );
}
const killedSections = Object.keys(effectiveSections).filter((id) => effectiveSections[id].killed);
console.log(
  `[build-api] sections: kill-switch ${killSwitch.state}` +
    (killedSections.length ? `, spente: ${killedSections.join(', ')}` : ', nessuna sezione spenta'),
);
// Il catalogo NON porta lo stato delle sezioni: quello ha una sola fonte, il
// registro che il Worker legge da R2 (vedi buildSectionsCatalog).
const sectionsCatalog = buildSectionsCatalog({
  declared: declaredSections,
  commit,
  articles: Object.fromEntries(
    Object.keys(declaredSections.sections).map((id) => [id, SECTION_REGISTRIES[id]?.length ?? 0]),
  ),
  sitemapOf: (id) => PUBLISHED_BY_SECTION[id]?.api.sitemap ?? null,
});
write(SECTIONS_CATALOG_FILE, sectionsCatalog);
// Registro e indice si emettono INSIEME o per niente: sono la release che
// publish-section-edge.mjs porta su R2 con un solo flip. Senza kill-switch
// verificabile e con una sezione dichiarata live non si emette nessuno dei
// due, e su R2 resta la release precedente.
let liveSectionIds = [];
if (edgeRegistryPublishable(declaredSections, killSwitch)) {
  const edgeRegistry = buildEdgeRegistry({ declared: declaredSections, effective: effectiveSections, commit });
  if (!validateEdgeSectionRegistry(edgeRegistry)) {
    throw new Error(`${EDGE_SECTION_REGISTRY_FILE}: il Worker rifiuterebbe questo registro — refusing`);
  }
  write(EDGE_SECTION_REGISTRY_FILE, edgeRegistry);
  liveSectionIds = Object.keys(edgeRegistry.sections).filter((id) => edgeRegistry.sections[id].status === 'live');
  const sitemapIndexXml = buildSitemapIndex(
    liveSectionIds.map((id) => {
      // Una sezione live e' attiva per costruzione (declaredRegistryErrors),
      // quindi ha la sua sitemap scritta qui sopra; il controllo resta, perche'
      // una sitemap annunciata e non emessa e' un 404 dichiarato in robots.txt.
      const file = PUBLISHED_BY_SECTION[id]?.api.sitemap;
      if (!file || !Object.prototype.hasOwnProperty.call(written, file)) {
        throw new Error(`sezione live ${id} senza sitemap emessa — refusing`);
      }
      return { file, lastmod: latestArticleDate(SECTION_REGISTRIES[id]) };
    }),
  );
  if (sitemapIndexXml) {
    writeXml(SECTION_SITEMAP_INDEX_FILE, { xml: sitemapIndexXml, count: liveSectionIds.length });
  } else {
    console.log(`[build-api] ${SECTION_SITEMAP_INDEX_FILE}: not emitted — nessuna sezione live (un indice vuoto viola lo schema)`);
  }
} else {
  console.warn(
    `::warning::${EDGE_SECTION_REGISTRY_FILE} e ${SECTION_SITEMAP_INDEX_FILE} non emessi: Remote Config non verificato ` +
      '(manca RC_ENV_LOADED=1) e almeno una sezione e\' dichiarata live — il Worker resta sull\'ultima release pubblicata su R2',
  );
}

// Written last: it records the byte size of every other artifact.
write('manifest.json', {
  schema: 1,
  [RELEASE_MARKER_CONTRACT_FIELD]: RELEASE_MARKER_CONTRACT_VERSION,
  commit,
  generatedAt: new Date().toISOString(),
  counts: {
    // I contatori storici col loro nome (`articles`, `swissArticles`,
    // `sitemapBlogUrls`, `sitemapBlogChUrls`): li leggono il sito e i gate.
    ...Object.fromEntries(API_SECTIONS.map((section) => [section.api.counter, SECTION_REGISTRIES[section.section].length])),
    ...Object.fromEntries(API_SECTIONS.map((section) => [section.api.sitemapCounter, sitemapCounts[section.section]])),
    // Le famiglie accese: un contatore aggregato per registro e uno per le
    // sitemap delle sue sezioni. Assenti finche' la famiglia e' spenta.
    ...Object.fromEntries(API_FAMILIES.flatMap((family) => [
      [family.api.counter, family.sections.reduce((n, section) => n + SECTION_REGISTRIES[section.section].length, 0)],
      [family.api.sitemapCounter, family.sections.reduce((n, section) => n + sitemapCounts[section.section], 0)],
    ])),
    sitemapArchiveUrls: sitemapCounts.archive,
    rssFeeds: rssFeedCount,
    rssItems: rssItemTotal,
    tickerArticles: tickerArticles.length,
    tickerArticlesShadowed: shadowedTickerArticles.length,
    newsCandidates: newsCandidateCount,
    images: imageCount,
    borderRankingEntries,
    dailyBriefBlocks,
    plateAuctionEditorialLocales,
    // Le sezioni del catalogo e le sitemap elencate dall'indice (0 = indice
    // non emesso). Quante sezioni sono LIVE non e' un contatore del manifest:
    // lo stato servito lo dice solo il registro su R2.
    sections: sectionsCatalog.sections.length,
    sectionSitemaps: liveSectionIds.length,
    // Additiva: la stessa cardinalita' per sezione, con l'id del core come
    // chiave. E' la forma che non cambia quando si accende una sezione: i
    // contatori col nome fisso qui sopra restano per i consumer che li leggono.
    bySection: Object.fromEntries(
      PUBLISHED_API_SECTIONS.map((section) => [
        section.section,
        { articles: SECTION_REGISTRIES[section.section].length, sitemapUrls: sitemapCounts[section.section] },
      ]),
    ),
  },
  files: written,
});

console.log(`[build-api] wrote ${Object.keys(written).length} files to dist/api`);

// ── Final gate: no control character leaves this process ──────────────────
//
// Deliberately a tautology over the writers above — its job is the writer that
// does NOT exist yet. Every artifact here went through a sanitiser, so this
// pass is silent today; the day someone adds an emitter and forgets, the build
// that adds it fails, instead of a crawler discovering three days later that
// sitemap-blog.xml is not well-formed. The scan is on the RAW BYTES of every
// text artifact, which is why it can only ever be the last word: JSON hides a
// control character behind an escape, so this catches the XML spelling and
// `sanitizeDeep` (at `write`) catches the JSON one.
//
// RICORSIVO, e non e' un dettaglio: `readdirSync(OUT)` senza discesa vede solo
// il livello superiore, quindi un artefatto scritto in una sottocartella di
// `dist/api/` non veniva scandito affatto. E' esattamente cio' che succede a
// `data/blog-index-*.json`, gli shard da cui il sito rende le liste — che hanno
// il proprio gate nel loro produttore, ma un `readdir` piatto qui e' una rete
// che si ferma alla prima cartella, non alla prima cosa non coperta.
{
  const textFiles = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else if (e.name.endsWith('.xml') || e.name.endsWith('.json')) textFiles.push(abs);
    }
  };
  walk(OUT);
  for (const abs of textFiles) {
    assertNoControlChars(fs.readFileSync(abs, 'utf-8'), `dist/api/${path.relative(OUT, abs)}`);
  }
  console.log(`[build-api] control-character gate: ${textFiles.length} text artifacts clean`);
}

// ── Final gate: manifest.files descrive i byte davvero serviti ────────────
//
// Deliberatamente tautologico rispetto ai writer qui sopra, come il gate sui
// control character: serve al writer che ancora non esiste, e a quello che
// ricomincia a contare code unit invece che byte. `manifest.files` e' il solo
// modo che un consumer ha di rifiutare un payload troncato *prima* di usarlo —
// e un contatore sbagliato non e' un dettaglio cosmetico: rende il confronto
// sempre falso, quindi inutile, quindi disattivato. Il set troncato e' il caso
// peggiore proprio perche' non fallisce da solo (AGENTS.md).
{
  const declared = JSON.parse(fs.readFileSync(path.join(OUT, 'manifest.json'), 'utf-8')).files;
  const mismatches = [];
  for (const [name, size] of Object.entries(declared)) {
    const actual = fs.statSync(path.join(OUT, name)).size;
    if (actual !== size) mismatches.push(`${name}: declared ${size}, on disk ${actual}`);
  }
  if (mismatches.length) {
    throw new Error(`manifest.files does not describe the bytes served:\n  ${mismatches.join('\n  ')}`);
  }
  console.log(`[build-api] manifest byte-size gate: ${Object.keys(declared).length} artifacts match on disk`);
}

// ── Final gate: manifest.counts descrive il set davvero servito ───────────
//
// Terzo gate della stessa famiglia dei due qui sopra, e per lo stesso motivo.
// `manifest.json` ha due meta': `files` (byte per artefatto) e `counts`
// (cardinalita' del set). AGENTS.md nomina `counts` per PRIMA — «permette di
// rifiutare un set troncato *prima* di usarlo» — ma fino a qui era l'unica
// meta' senza rete: ogni numero veniva da una variabile in memoria catturata a
// meta' pipeline, mai riletta dai byte che finiscono davvero in `dist/api/`.
// Un filtro applicato alla serializzazione ma non al contatore (o viceversa)
// non rompe niente: il manifest resta internamente coerente e il set servito
// e' un altro. E' esattamente il caso peggiore di AGENTS.md, quello che non
// fallisce da solo — e il sito non ribuilda, quindi va live subito.
//
// La rilettura e' dal DISCO, non dalle variabili: un gate che ricontrolla la
// stessa memoria che ha scritto il numero verifica se stesso e non puo' mai
// fallire.
//
// E per la stessa ragione l'ASSENZA di un artefatto non e' una risposta. Se
// `border-wait-ranking.json`, `daily-brief.json` o `images-manifest.json`
// smettono silenziosamente di essere emessi, la ri-derivazione da' 0 e
// `counts` dichiara 0 per la stessa identica ragione — i rami `not emitted`
// qui sopra lasciano il contatore a 0 — quindi le due meta' del gate
// concordano e il gate resta VERDE: dimostra la coerenza interna del
// manifest, non che l'artefatto dovesse esserci. E' il troncamento-a-zero che
// AGENTS.md chiede a `counts` di rifiutare, su una superficie che il sito
// serve senza ribuildare.
//
// La legittimita' dell'assenza si decide quindi da una sorgente TERZA — che
// non e' ne' il manifest ne' il contatore: per un artefatto sempre emesso,
// l'assenza e' un errore e basta; per uno opzionale, l'INPUT del produttore
// su disco, cioe' esattamente la condizione che i writer qui sopra usano per
// decidere se emettere.
{
  const outPath = (name) => path.join(OUT, name);
  const exists = (name) => fs.existsSync(outPath(name));
  const readOut = (name) => fs.readFileSync(outPath(name), 'utf-8');
  const jsonOut = (name) => JSON.parse(readOut(name));

  const absent = [];
  // Artefatto scritto incondizionatamente: assente = troncamento, sempre.
  // `null` (non 0) esce dal confronto per valore, che qui non ha piu' niente
  // da dire — la voce e' gia' nella lista degli assenti.
  const derivedAlways = (name, derive) => {
    if (exists(name)) return derive();
    absent.push(`${name}: assente da dist/api — questo artefatto e' sempre emesso`);
    return null;
  };
  // Artefatto opzionale: `producerInput()` restituisce la descrizione
  // dell'input trovato su disco, o `null` se il produttore non ha davvero
  // girato qui. L'assenza vale 0 SOLO nel secondo caso.
  const derivedOptional = (name, producerInput, derive) => {
    if (exists(name)) return derive();
    const input = producerInput();
    if (input) {
      absent.push(
        `${name}: assente da dist/api mentre il suo input esiste (${input}) — ` +
          `counts dichiara 0 per la stessa ragione, quindi il confronto per valore non lo vedrebbe`,
      );
    }
    return 0;
  };
  const fileInput = (...parts) => () => (fs.existsSync(path.join(ROOT, ...parts)) ? path.join(...parts) : null);

  // `countXmlTags` conta i tag del DOCUMENTO: e' la stessa funzione che usa il
  // writer sopra, e ignora CDATA e commenti. Contare col needle testuale
  // rendeva il gate incapace di fallire proprio dove serve — un `<item>` citato
  // in una description gonfia dichiarato e ri-derivato allo stesso modo.
  const sitemapUrls = (name) => derivedAlways(name, () => countXmlTags(readOut(name), 'url'));

  // I feed si riconoscono dal documento, non dal nome: una convenzione di
  // naming e' proprio cio' che un writer nuovo puo' non rispettare, e le
  // sitemap sono `<urlset>`, quindi non c'e' collisione.
  const feeds = fs
    .readdirSync(OUT)
    .filter((f) => f.endsWith('.xml'))
    .map((f) => readOut(f))
    .filter((xml) => countXmlTags(xml, 'rss') > 0);

  const derived = {
    ...Object.fromEntries(API_SECTIONS.map((section) => [
      section.api.counter,
      derivedAlways(section.api.registry, () => jsonOut(section.api.registry).length),
    ])),
    ...Object.fromEntries(API_SECTIONS.map((section) => [section.api.sitemapCounter, sitemapUrls(section.api.sitemap)])),
    ...Object.fromEntries(API_FAMILIES.flatMap((family) => [
      [family.api.counter, derivedAlways(family.api.registry, () => jsonOut(family.api.registry).length)],
      [family.api.sitemapCounter, family.sections.reduce((n, section) => n + (sitemapUrls(section.api.sitemap) ?? 0), 0)],
    ])),
    sitemapArchiveUrls: sitemapUrls(ARCHIVE_SITEMAP),
    rssFeeds: feeds.length,
    rssItems: feeds.reduce((total, xml) => total + countXmlTags(xml, 'item'), 0),
    tickerArticles: derivedAlways('news-ticker-live.json', () => jsonOut('news-ticker-live.json').articles.length),
    newsCandidates: sitemapUrls(NEWS_CANDIDATES),
    // L'input e' la cartella sorgente, non `dist/api/images/blog`: quella la
    // popola lo stesso ramo che scrive il manifest, quindi sarebbe di nuovo
    // una meta' del gate a testimoniare per l'altra.
    images: derivedOptional(
      IMAGE_MANIFEST,
      () => {
        const srcDir = path.join(ROOT, ...IMAGE_SRC_DIR);
        const webp = fs.existsSync(srcDir)
          ? fs.readdirSync(srcDir).filter((f) => f.endsWith('.webp')).length
          : 0;
        return webp ? `${webp} .webp in ${IMAGE_SRC_DIR.join('/')}` : null;
      },
      () => jsonOut(IMAGE_MANIFEST).images.length,
    ),
    borderRankingEntries: derivedOptional(
      BORDER_RANKING,
      fileInput(...BORDER_RANKING_SRC),
      () => jsonOut(BORDER_RANKING).ranking.length,
    ),
    // Il payload servito porta anche il proprio `counts.availableBlocks`, ed e'
    // quello che il consumer legge — ma ri-derivare DA LI' e' lo stesso «gate
    // che ricontrolla chi ha scritto il numero» che l'header rifiuta, spostato
    // di un livello: e' il produttore stesso ad averlo autodichiarato. La
    // cardinalita' vera sta nei `blocks` serviti, con la formula del produttore
    // (`generator/scripts/lib/daily-brief-data.mjs`), quindi il gate confronta
    // il numero DICHIARATO nel manifest (che viene da `counts.availableBlocks`)
    // contro i blocchi effettivamente presenti nel payload su disco. Un blocco
    // perso fra il calcolo e la serializzazione qui non passa piu'.
    dailyBriefBlocks: derivedOptional(
      DAILY_BRIEF,
      fileInput(...DAILY_BRIEF_SRC),
      () => Object.values(jsonOut(DAILY_BRIEF).blocks ?? {}).filter((b) => b?.available).length,
    ),
    plateAuctionEditorialLocales: derivedAlways(
      PLATE_AUCTION_EDITORIAL,
      () => Object.keys(jsonOut(PLATE_AUCTION_EDITORIAL).evergreen ?? {}).length,
    ),
    sections: derivedAlways(SECTIONS_CATALOG_FILE, () => jsonOut(SECTIONS_CATALOG_FILE).sections.length),
    // L'indice e' opzionale per costruzione, e la sua assenza e' legittima
    // solo se il registro edge emesso non ha sezioni live (o non e' stato
    // emesso affatto: release intera rimandata). La sorgente terza e' il
    // registro su disco, non il contatore.
    sectionSitemaps: derivedOptional(
      SECTION_SITEMAP_INDEX_FILE,
      () => {
        if (!exists(EDGE_SECTION_REGISTRY_FILE)) return null;
        const live = Object.values(jsonOut(EDGE_SECTION_REGISTRY_FILE).sections ?? {}).filter((entry) => entry?.status === 'live').length;
        return live ? `${live} sezioni live in ${EDGE_SECTION_REGISTRY_FILE}` : null;
      },
      () => countXmlTags(readOut(SECTION_SITEMAP_INDEX_FILE), 'sitemap'),
    ),
  };

  // `tickerArticlesShadowed` conta cio' che e' stato ESCLUSO dal ticker:
  // non ha una controparte fra i byte serviti, per costruzione. Va elencato
  // qui e non semplicemente dimenticato, perche' il controllo di
  // esaustivita' sotto e' la parte che protegge dal contatore FUTURO.
  const NOT_ON_DISK = new Set(['tickerArticlesShadowed']);
  // `bySection` non e' un numero: e' la stessa cardinalita' dei contatori
  // storici, per sezione. Si ri-deriva dai byte serviti come gli altri e si
  // confronta per valore qui sotto, quindi NON sta in NOT_ON_DISK.
  const derivedBySection = Object.fromEntries(
    PUBLISHED_API_SECTIONS.map((section) => [
      section.section,
      {
        articles: !exists(section.api.registry)
          ? null
          : section.api.family === null
            ? jsonOut(section.api.registry).length
            : jsonOut(section.api.registry).filter((row) => row?.section === section.section).length,
        sitemapUrls: exists(section.api.sitemap) ? countXmlTags(readOut(section.api.sitemap), 'url') : null,
      },
    ]),
  );

  const declared = jsonOut('manifest.json').counts;
  const declaredCommit = jsonOut('manifest.json').commit;
  const unchecked = Object.keys(declared).filter(
    (key) => !(key in derived) && !NOT_ON_DISK.has(key) && key !== 'bySection',
  );
  if (unchecked.length) {
    throw new Error(
      `manifest.counts carries counters this gate does not re-derive: ${unchecked.join(', ')} — ` +
        `wire them into the gate, or declare them in NOT_ON_DISK with the reason`,
    );
  }

  const mismatches = [...absent];
  for (const [key, actual] of Object.entries(derived)) {
    if (actual === null) continue; // artefatto assente: gia' segnalato sopra
    if (declared[key] !== actual) {
      mismatches.push(`${key}: declared ${declared[key]}, on disk ${actual}`);
    }
  }
  // Sezioni dichiarate e sezioni ri-derivate devono essere lo STESSO insieme:
  // una sezione in piu' o in meno in `bySection` e' un set diverso, non un
  // dettaglio di presentazione.
  const declaredBySection = declared.bySection ?? {};
  const bySectionIds = new Set([...Object.keys(declaredBySection), ...Object.keys(derivedBySection)]);
  for (const id of bySectionIds) {
    for (const field of ['articles', 'sitemapUrls']) {
      const want = derivedBySection[id]?.[field];
      if (want === null) continue; // artefatto assente: gia' segnalato sopra
      if (declaredBySection[id]?.[field] !== want) {
        mismatches.push(`bySection.${id}.${field}: declared ${declaredBySection[id]?.[field]}, on disk ${want}`);
      }
    }
  }
  // `slugs.json` non ha un contatore proprio in `counts`, ma indicizza lo
  // stesso set di `articles.json`, e il consumer lo verifica gia' contro il
  // manifest: `validateAnnouncedSurface()` in scripts/reconcile-article-shards.mjs
  // rifiuta la superficie se `slugs.blog` e `counts.articles` non combaciano.
  // Senza la stessa asserzione qui, questo repo puo' PUBBLICARE una superficie
  // che il consumer rifiutera' a valle — e il sito non ribuilda, quindi il
  // rifiuto arriva in produzione invece che alla build che l'ha prodotta.
  //
  // Il confronto e' per INSIEME, non per cardinalita': `slugs.json` mappa
  // id -> slug per locale, cioe' e' la sorgente dei canonical. Un giro che
  // rimuove un articolo e ne aggiunge un altro lascia il numero di chiavi
  // identico con un id SOSTITUITO — la cardinalita' pareggia da entrambi i
  // lati e va live un canonical sbagliato per quell'articolo, che e' il caso
  // peggiore di AGENTS.md: non fallisce, e il sito non ribuilda.
  //
  // `slugs.json` e i due registri sono scritti incondizionatamente: la loro
  // assenza NON e' un caso da saltare — saltarla e' lo stesso «l'assente vale
  // 0» dell'header, che qui varrebbe «l'assente e' d'accordo».
  if (!exists('slugs.json')) {
    mismatches.push('slugs.json: assente da dist/api — la sorgente dei canonical e\' sempre emessa');
  } else {
    const slugs = jsonOut('slugs.json');
    mismatches.push(
      ...validateReleaseMarkers(
        {
          manifest: jsonOut('manifest.json'),
          slugs,
          articles: exists('articles.json') ? jsonOut('articles.json') : null,
          swissArticles: exists('swiss-articles.json') ? jsonOut('swiss-articles.json') : null,
        },
        { requireMarkers: true },
      ),
    );
    const indexed = Object.fromEntries(
      API_SECTIONS.map((section) => [section.api.slugsKey, [section.api.registry, section.api.counter]]),
    );
    for (const [section, [registry, counter]] of Object.entries(indexed)) {
      const keys = Object.keys(slugs?.[section] ?? {});
      if (keys.length !== declared[counter]) {
        mismatches.push(`slugs.${section}: ${keys.length} ids, manifest.counts.${counter} declares ${declared[counter]}`);
      }
      if (!exists(registry)) continue; // assenza gia' in `absent`, con la sua diagnosi
      const registryRows = jsonOut(registry);
      const ids = registryRows.map((a) => a?.id);
      const duplicates = [...new Set(ids.filter((id) => id != null).filter((id, i) => ids.indexOf(id) !== i))];
      const missingId = ids.filter((id) => id == null).length;
      if (duplicates.length) mismatches.push(`${registry} contains duplicate ids: ${duplicates.slice(0, 5).join(', ')}`);
      if (missingId) mismatches.push(`${registry} contains ${missingId} missing ids`);
      const registryIds = new Set(ids.filter((id) => id != null));
      const indexedIds = new Set(keys);
      const missing = [...registryIds].filter((id) => !indexedIds.has(id));
      const extra = keys.filter((id) => !registryIds.has(id));
      if (missing.length || extra.length) {
        mismatches.push(
          `slugs.${section} indexes a different set than ${registry}: ` +
            `${missing.length} ids senza slug (${missing.slice(0, 5).join(', ') || '—'}), ` +
            `${extra.length} slug senza articolo (${extra.slice(0, 5).join(', ') || '—'})`,
        );
      }
    }
  }

  // Le famiglie: stesso confronto per INSIEME del blocco qui sopra, sezione per
  // sezione — `slugs.<famiglia>.<id>` contro le righe del registro aggregato
  // con `section === <id>` — piu' il marker di release su ogni riga, che per i
  // registri storici controlla `validateReleaseMarkers`.
  // L'assenza di slugs.json e' gia' un mismatch del blocco qui sopra.
  const familySlugs = exists('slugs.json') ? jsonOut('slugs.json') : null;
  for (const family of familySlugs ? API_FAMILIES : []) {
    if (!exists(family.api.registry)) continue; // gia' in `absent`
    const rows = jsonOut(family.api.registry);
    const staleRows = rows.filter((row) => row?.commit !== declaredCommit).length;
    if (staleRows) mismatches.push(`${family.api.registry}: ${staleRows} righe senza il commit del manifest`);
    const known = new Set(family.sections.map((section) => section.section));
    const stray = rows.filter((row) => !known.has(row?.section)).length;
    if (stray) mismatches.push(`${family.api.registry}: ${stray} righe con una section fuori dalla famiglia attiva`);
    const nested = familySlugs[family.api.slugsKey] ?? {};
    for (const id of Object.keys(nested)) {
      if (!known.has(id)) mismatches.push(`slugs.${family.api.slugsKey}.${id}: sezione non attiva nella famiglia`);
    }
    for (const section of family.sections) {
      const registryIds = new Set(rows.filter((row) => row?.section === section.section).map((row) => row?.id));
      const indexed = Object.keys(nested[section.section] ?? {});
      const missing = [...registryIds].filter((id) => !indexed.includes(id));
      const extra = indexed.filter((id) => !registryIds.has(id));
      if (missing.length || extra.length) {
        mismatches.push(
          `slugs.${family.api.slugsKey}.${section.section} indexes a different set than ${family.api.registry}: ` +
            `${missing.length} ids senza slug (${missing.slice(0, 5).join(', ') || '—'}), ` +
            `${extra.length} slug senza articolo (${extra.slice(0, 5).join(', ') || '—'})`,
        );
      }
    }
  }

  // Il catalogo non porta stato (una sola fonte: il registro per il Worker) e
  // la release edge e' coerente in se': registro accettabile dal parse del
  // Worker — un registro che il Worker scarta e' un cambio che non arriva mai
  // —, stesso commit del manifest, e l'indice che elenca ESATTAMENTE le
  // sitemap delle sezioni live, tutte presenti.
  if (exists(SECTIONS_CATALOG_FILE)) {
    const catalog = jsonOut(SECTIONS_CATALOG_FILE);
    if (catalog.commit !== declaredCommit) mismatches.push(`${SECTIONS_CATALOG_FILE}: commit ${catalog.commit}, manifest ${declaredCommit}`);
    if (catalog.authoritative !== false || (catalog.sections ?? []).some((entry) => 'status' in entry || 'declaredStatus' in entry)) {
      mismatches.push(`${SECTIONS_CATALOG_FILE}: porta uno stato di sezione — lo stato servito ha una sola fonte, il registro su R2`);
    }
  }
  if (exists(EDGE_SECTION_REGISTRY_FILE)) {
    const edge = jsonOut(EDGE_SECTION_REGISTRY_FILE);
    if (!validateEdgeSectionRegistry(edge)) mismatches.push(`${EDGE_SECTION_REGISTRY_FILE}: il Worker lo rifiuterebbe`);
    if (edge.commit !== declaredCommit) mismatches.push(`${EDGE_SECTION_REGISTRY_FILE}: commit ${edge.commit}, manifest ${declaredCommit}`);
    const live = Object.keys(edge.sections ?? {}).filter((id) => edge.sections[id]?.status === 'live');
    const listed = exists(SECTION_SITEMAP_INDEX_FILE)
      ? [...readOut(SECTION_SITEMAP_INDEX_FILE).matchAll(/<loc>[^<]*\/(sitemap-articles-[a-z-]+\.xml)<\/loc>/g)].map((m) => m[1]).sort()
      : [];
    const wanted = live.map((id) => `sitemap-articles-${id}.xml`).sort();
    if (listed.join(',') !== wanted.join(',')) {
      mismatches.push(`${SECTION_SITEMAP_INDEX_FILE}: elenca [${listed.join(', ')}], le sezioni live vogliono [${wanted.join(', ')}]`);
    }
    for (const file of wanted) if (!exists(file)) mismatches.push(`${file}: sezione live senza sitemap in dist/api`);
  } else if (exists(SECTION_SITEMAP_INDEX_FILE)) {
    mismatches.push(`${SECTION_SITEMAP_INDEX_FILE}: emesso senza ${EDGE_SECTION_REGISTRY_FILE} — la release edge e' intera o assente`);
  }

  // Le immagini sono l'unico artefatto che il consumer non puo' ri-derivare,
  // quindi il file trasferito conta quanto la voce che lo indicizza: una
  // copia interrotta a meta' lascia l'indice pieno e la cartella corta.
  const webpDir = path.join(OUT, 'images', 'blog');
  const webpOnDisk = fs.existsSync(webpDir)
    ? fs.readdirSync(webpDir).filter((f) => f.endsWith('.webp')).length
    : 0;
  if (webpOnDisk !== derived.images) {
    mismatches.push(`images: ${IMAGE_MANIFEST} lists ${derived.images}, images/blog holds ${webpOnDisk}`);
  }

  if (mismatches.length) {
    throw new Error(`manifest.counts does not describe the set served:\n  ${mismatches.join('\n  ')}`);
  }
  console.log(
    `[build-api] manifest counts gate: ${Object.keys(derived).length} counters match the artifacts on disk`,
  );
}
