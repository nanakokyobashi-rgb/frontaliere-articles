#!/usr/bin/env -S npx -y tsx
/**
 * publish-section-pages.mjs — rende e pubblica su R2 le pagine di UNA sezione
 * articoli cantonale (piano «sezioni articoli per cantone», D3; P7b parte B).
 *
 * Le sezioni cantonali non hanno uno shard Pages: il Worker del sito serve
 * `https://frontaliereticino.ch/<path>/` da R2 `edge/sections/<path>/index.html`
 * (`serveCorpusSection` in infra/cloudflare-worker/locale-router.js) quando il
 * registro pubblicato da build-api.mjs dichiara la sezione `live`. Questo
 * script e' cio' che mette quelle pagine su R2, con l'engine condiviso:
 *
 *   articoli   engine/ogPagesPlugin.ts            (gli id chiesti, o tutti con --bootstrap)
 *   archivio   engine/articleHubPagesPlugin.ts    (`/tutti/` + page-N, sempre)
 *   landing    engine/cantonSectionPages.ts       (4 locali, sempre)
 *   hub        engine/cantonSectionPages.ts       (i temi che hanno il file dati
 *                                                  scritto dal producer degli hub,
 *                                                  vedi scripts/lib/canton-hub-data.mjs)
 *
 * La catena di render (ordine #5270: l'offload CDN per ULTIMO, dopo ogni
 * pagina) e' scripts/lib/article-render-pipeline.mjs, la stessa del
 * fast-publish verso gli shard: landing e hub entrano nel suo passo 6b.
 *
 * NESSUNA pagina cantonale e' `noindex` (decisione del proprietario,
 * 2026-10-05): una pagina resa con un `noindex` e' un rifiuto, e un hub senza
 * dati non viene pubblicato affatto. Una sezione a cui manca qualcosa resta
 * `draft` nel registro (il Worker risponde 404), non esce «nascosta».
 *
 * FLAT BRIDGE: i file `<slug>.html` che la catena scrive per gli shard qui non
 * si caricano. Il Worker riconduce da solo `/x`, `/x.html` e `/x/index.html`
 * alla forma canonica `/x/` con un 301.
 *
 * PUBBLICAZIONE (--publish): immagini hero, poi articoli, archivio, hub, e per
 * ultima la landing (che linka tutto il resto); purge mirato di apex e cdn a
 * blocchi da 30; verify. Il verify legge SEMPRE la chiave sul CDN (e' cio' che
 * il Worker serve) e, se il registro pubblicato dice che la sezione e' live,
 * anche l'URL dell'apex. Una sezione `draft` si verifica solo sul CDN: e' il
 * caso del bootstrap, che carica le pagine PRIMA del flip a live.
 *
 * Uso:
 *   npx -y tsx scripts/publish-section-pages.mjs --section canton-ti \
 *     (--bootstrap | --ids '["id1","id2"]' | --id <id> …) \
 *     --out <scratchDir> --summary <summary.json> [--publish | --dry-run]
 *   Senza id e senza --bootstrap rende solo landing, archivio e hub (un giro
 *   di rinfresco: un hub aggiornato, un articolo ritirato). Senza --publish
 *   il comportamento resta dry-run per compatibilita'; --dry-run lo rende
 *   esplicito e non si combina con --publish.
 *
 * Le pagine obsolete si confrontano con `edge/sections/_page-manifests/`,
 * scritto solo dopo upload, verify e delete riusciti. `--previous-revision`
 * resta soltanto il ponte per la prima run, prima che esista il manifest.
 *
 * Esce 1 se una pagina non passa la validazione, se un upload non e'
 * confermato o se il verify fallisce.
 */
import '../host/cantonSectionsBootstrap.mjs';
import fs, { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fetchWithRefTimeout, releaseFetchWithRefTimeout } from '../generator/scripts/lib/fetch-with-ref-timeout.mjs';

import { ARTICLE_SECTION_CORE_ALL } from '../engine/shared/articleSectionCore.mjs';
import { ARTICLES_PAGE_SIZE } from '../engine/shared/articleArchiveConfig.mjs';
import { CANTON_ARCHIVE_ALL_SLUG } from '../engine/shared/cantonSectionCopy.mjs';
import { parseArticleUrlSlugs } from '../engine/shared/articleReaderSource.mjs';
import { CORPUS_ROUTE_OWNER_META_TAG } from '../engine/shared/corpusRouteOwner.mjs';
import { CDN_BASE, heroCdnUploads, renderSectionArticlePipeline as defaultRenderSectionArticlePipeline, rewriteGenericImageRefs } from './lib/article-render-pipeline.mjs';
import { CANTON_HUB_LOCALES, cantonHubDataFile, cantonHubTopics, readCantonHubData } from './lib/canton-hub-data.mjs';
import { sourceRegistryIds } from './lib/corpus-floors.mjs';
import { scanTopLevelArticleRecords } from './lib/article-registry-reader.mjs';
import { createEngineCorpusView } from './lib/engine-corpus-view.mjs';
import { sanitizeHtmlDocument } from './lib/sanitize-control-chars.mjs';
import { reportStrippedControlChars } from '../generator/scripts/lib/control-char-write-report.mjs';
import { activeCorpusCoreMap, sectionSourceSurfaces } from './lib/corpus-sections.mjs';
import { assertHubLocaleSlug, assertHubTopicEntries } from './lib/assert-hub-locale-slug.mjs';
import { EDGE_SECTION_REGISTRY_FILE, SECTION_REGISTRY_FILE, sectionRoutes, validateEdgeSectionRegistry } from './lib/section-registry.mjs';
import {
  PAGE_MANIFEST_KINDS,
  fetchPageManifest,
  mergePageManifests,
  pageManifestFromPages,
  pageManifestKey,
  pageManifestUrl,
} from './lib/section-page-manifest.mjs';
import { purgeChunks } from './publish-section-edge.mjs';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOG = 'publish-section-pages';
export const APEX = 'https://frontaliereticino.ch';
export const EDGE_PREFIX = 'edge/sections';
export const API_BASE = 'https://nanakokyobashi-rgb.github.io/frontaliere-articles';
export const CANTON_RSS_PREFIX = `${EDGE_PREFIX}/_feeds`;
/** Le pagine si riscrivono a ogni publish e il Worker le tiene 5 min: stessa classe delle sitemap. */
export const PAGE_CACHE_CONTROL = 'public,max-age=600';
/** Dopo il deploy API la superficie pubblica puo' arrivare in ritardo: la delete attende, ma con un limite. */
export const RELEASE_READY_MAX_WAIT_MS = 120_000;
export const RELEASE_READY_RETRY_DELAY_MS = 10_000;
/** Inventario delle pagine: si aggiorna solo dopo una pubblicazione verificata. */
export const PAGE_MANIFEST_CACHE_CONTROL = 'public,max-age=60';
/** Ordine di upload: la landing per ultima, perche' linka tutto il resto. */
export const UPLOAD_ORDER = Object.freeze(['article', 'archive', 'hub', 'landing']);
const PUBLISH_API_WORKFLOW = '.github/workflows/publish-api.yml';
const FULL_GIT_SHA_RE = /^[a-f0-9]{40}$/;

function publishedMainHead() {
  const repository = process.env.GITHUB_REPOSITORY;
  if (!repository || !/^[^/]+\/[^/]+$/.test(repository)) {
    throw new Error('GITHUB_REPOSITORY non disponibile per il guard di freschezza');
  }
  const current = execFileSync(
    'gh',
    ['api', `repos/${repository}/git/ref/heads/main`, '--jq', '.object.sha'],
    { encoding: 'utf8' },
  ).trim();
  if (!FULL_GIT_SHA_RE.test(current)) throw new Error('revisione corrente di main non valida');
  return current;
}

async function assertExpectedMainHead(expected, readMainHead = publishedMainHead) {
  if (!FULL_GIT_SHA_RE.test(String(expected ?? ''))) {
    throw new Error('EXPECTED_MAIN_HEAD non contiene una SHA completa');
  }
  const current = await readMainHead();
  if (!FULL_GIT_SHA_RE.test(String(current ?? ''))) {
    throw new Error('revisione corrente di main non valida');
  }
  if (current !== expected) {
    throw new Error(`main e' avanzato durante il render (${expected} → ${current}); pubblicazione interrotta`);
  }
}

export function parseArgs(argv, { all = ARTICLE_SECTION_CORE_ALL, active = activeCorpusCoreMap() } = {}) {
  const out = { ids: [], bootstrap: false, publish: false, dryRun: false, removeStaleCantonRssFeeds: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} richiede un valore`);
      return v;
    };
    if (a === '--section') out.section = value();
    else if (a === '--previous-revision') out.previousRevision = value();
    else if (a === '--id') out.ids.push(value());
    else if (a === '--ids') {
      let ids;
      try {
        ids = JSON.parse(value());
      } catch (error) {
        throw new Error(`--ids deve essere un array JSON di id: ${error.message}`);
      }
      if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string' || !id)) throw new Error('--ids deve essere un array JSON di id non vuoti');
      out.ids.push(...ids);
    } else if (a === '--bootstrap') out.bootstrap = true;
    else if (a === '--remove-stale-canton-rss-feeds') out.removeStaleCantonRssFeeds = true;
    else if (a === '--publish') out.publish = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--out') out.out = value();
    else if (a === '--summary') out.summary = value();
    else throw new Error(`argomento sconosciuto: ${a}`);
  }
  out.ids = [...new Set(out.ids)];
  for (const flag of ['section', 'out', 'summary']) if (!out[flag]) throw new Error(`manca --${flag}`);
  if (out.publish && out.dryRun) throw new Error('--publish e --dry-run sono alternativi');
  if (out.bootstrap && out.ids.length) throw new Error('--bootstrap rende tutti gli articoli della sezione: non si combina con --id/--ids');
  assertPublishableSection(out.section, { all, active });
  return out;
}

export function missingRenderedArticleIds(requestedIds, entries) {
  const rendered = new Set((entries || []).map((entry) => String(entry?.articleId || '')).filter(Boolean));
  return [...new Set((requestedIds || []).map(String))].filter((articleId) => !rendered.has(articleId));
}

/** Rimuove gli slash finali dalla forma usata per match e join delle route. */
export function normalizeRoutePrefix(prefix) {
  const normalized = prefix.replace(/\/+$/u, '');
  if (!normalized) throw new Error('prefisso di route vuoto');
  return normalized;
}

function normalizedSectionRoutes(section, all = ARTICLE_SECTION_CORE_ALL) {
  return sectionRoutes(section, all).map((route) => ({
    ...route,
    prefix: normalizeRoutePrefix(route.prefix),
  }));
}

/** La sezione deve essere cantonale (R2) e ATTIVA nel core: l'engine rende solo le sezioni attive. */
export function assertPublishableSection(section, { all = ARTICLE_SECTION_CORE_ALL, active = activeCorpusCoreMap() } = {}) {
  const core = Object.prototype.hasOwnProperty.call(all, section) ? all[section] : undefined;
  if (!core) throw new Error(`sezione sconosciuta: "${section}"`);
  if (core.kind !== 'canton' || core.shardKey) {
    throw new Error(`la sezione "${section}" e' servita da uno shard Pages: usa publish-article-fast.mjs`);
  }
  if (!Object.prototype.hasOwnProperty.call(active, section)) {
    throw new Error(
      `la sezione "${section}" non e' attiva nel core (ACTIVE_CANTON_SECTIONS): l'engine rende solo le sezioni attive. ` +
        'Si accende sul sito, scende col mirror, e solo dopo si fa il bootstrap.',
    );
  }
  return core;
}

/**
 * Una pagina resa → la sua voce di pubblicazione. `rel` e' il path in dist
 * (`articoli-ticino/x/index.html`); la chiave R2 e' quella che il Worker
 * calcola (`corpusSectionCdnKey`). Lancia se il path non sta sotto uno dei
 * quattro prefissi della sezione o non e' una pagina `index.html`.
 */
export function pageEntry(section, rel, kind, all = ARTICLE_SECTION_CORE_ALL) {
  if (!rel.endsWith('/index.html')) throw new Error(`pagina non canonica (attesa …/index.html): ${rel}`);
  const canonicalPath = `/${rel.slice(0, -'index.html'.length)}`;
  const route = normalizedSectionRoutes(section, all).find((r) => canonicalPath === `${r.prefix}/` || canonicalPath.startsWith(`${r.prefix}/`));
  if (!route) throw new Error(`"${rel}" non sta sotto un prefisso della sezione ${section}`);
  if (!/^\/[a-z0-9/-]*\/$/.test(canonicalPath) || canonicalPath.includes('//')) throw new Error(`percorso canonico non valido: ${canonicalPath}`);
  return {
    kind,
    locale: route.locale,
    rel,
    canonicalPath,
    edgeKey: `${EDGE_PREFIX}${canonicalPath}index.html`,
    apexUrl: `${APEX}${canonicalPath}`,
    cdnUrl: `${CDN_BASE}/${EDGE_PREFIX}${canonicalPath}index.html`,
  };
}

/** Adatta una pagina restituita dall'engine e verifica la chiave R2 che l'engine ha calcolato. */
export function rendererPageEntry(section, rendered, kind) {
  if (!rendered?.relPath || !rendered?.edgeKey) throw new Error(`renderer ${kind}: relPath/edgeKey mancanti`);
  const entry = pageEntry(section, rendered.relPath, kind);
  if (rendered.edgeKey !== entry.edgeKey) {
    throw new Error(`renderer ${kind}: edgeKey ${rendered.edgeKey} diverso da ${entry.edgeKey} per ${rendered.relPath}`);
  }
  return { ...entry, edgeKey: rendered.edgeKey };
}

/** Nomi RSS emessi da build-api per una sezione cantonale, inclusi main e locali. */
export function cantonRssFeedEntries(section) {
  const core = ARTICLE_SECTION_CORE_ALL[section];
  if (!core || core.kind !== 'canton') throw new Error(`sezione RSS cantonale sconosciuta: "${section}"`);
  const names = [`rss-${section}.xml`, ...CANTON_HUB_LOCALES.map((locale) => `rss-${section}-${locale}.xml`)];
  return names.map((name) => {
    const key = `${CANTON_RSS_PREFIX}/${name}`;
    return { name, key, url: `${CDN_BASE}/${key}` };
  });
}

/** Il manifest API emette tutti i feed cantonali oppure nessuno (sezione vuota). */
export function cantonRssFeedsDeclaredInManifest(section, files, counts) {
  if (!files || typeof files !== 'object' || Array.isArray(files)) {
    throw new Error(`manifest API ${section}: files RSS non verificabili`);
  }
  const expected = cantonRssFeedEntries(section);
  const declared = expected.filter(({ name }) => Object.prototype.hasOwnProperty.call(files, name));
  if (declared.length !== 0 && declared.length !== expected.length) {
    throw new Error(`manifest API ${section}: set feed RSS cantonali incompleto (${declared.length}/${expected.length})`);
  }
  if (declared.length === 0) {
    const articleCount = counts?.bySection?.[section]?.articles;
    if (!Number.isSafeInteger(articleCount) || articleCount < 0) {
      throw new Error(`manifest API ${section}: counts.bySection.${section}.articles non verificabile per il set RSS vuoto`);
    }
    if (articleCount !== 0) {
      throw new Error(`manifest API ${section}: set RSS vuoto con ${articleCount} articoli dichiarati`);
    }
  }
  return declared;
}

/** I feed edge si pubblicano solo insieme alla release degli aggregati verificati. */
export function cantonRssFeedsForPublish(section, {
  publishing,
  effectiveStatus,
  aggregatePagesAllowed,
  availableFeeds = cantonRssFeedEntries(section),
} = {}) {
  return publishing && effectiveStatus === 'live' && aggregatePagesAllowed === true
    ? availableFeeds
    : [];
}

/** Il feed principale è l'alias canonico italiano; le altre landing usano il feed localizzato. */
export function cantonRssFeedUrlForLocale(section, locale) {
  if (!CANTON_HUB_LOCALES.includes(locale)) throw new Error(`locale RSS cantonale sconosciuta: "${locale}"`);
  const name = locale === 'it' ? `rss-${section}.xml` : `rss-${section}-${locale}.xml`;
  const feed = cantonRssFeedEntries(section).find((entry) => entry.name === name);
  return feed.url;
}

function escapeHtmlAttribute(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
}

/** Aggiunge link autodiscovery e un link visibile alla landing; l'operazione è idempotente. */
export function addCantonRssFeedLink(html, feedUrl) {
  if (typeof html !== 'string' || !html) throw new Error('landing RSS senza HTML');
  const url = new URL(feedUrl);
  if (url.origin !== new URL(CDN_BASE).origin || !url.pathname.startsWith(`/${CANTON_RSS_PREFIX}/`)) {
    throw new Error(`URL RSS cantonale fuori dalla superficie edge: ${feedUrl}`);
  }
  const href = escapeHtmlAttribute(url.href);
  const headLink = `<link data-canton-rss-feed rel="alternate" type="application/rss+xml" title="RSS" href="${href}">`;
  const bodyLink = `<a data-canton-rss-feed rel="alternate" type="application/rss+xml" href="${href}">RSS</a>`;
  let output = html;
  const replaceOrInsert = (source, marker, replacement, closingTag, label) => {
    const existing = [...source.matchAll(marker)];
    if (existing.length > 1) throw new Error(`landing con link RSS ${label} duplicato`);
    if (existing.length === 1) return source.replace(existing[0][0], replacement);
    if (!closingTag.test(source)) throw new Error(`landing senza chiusura ${label} per il link RSS`);
    return source.replace(closingTag, `${replacement}\n$&`);
  };
  output = replaceOrInsert(output, /<link\b[^>]*data-canton-rss-feed[^>]*>/giu, headLink, /<\/head\s*>/iu, '</head>');
  output = replaceOrInsert(output, /<a\b[^>]*data-canton-rss-feed[^>]*>[\s\S]*?<\/a\s*>/giu, bodyLink, /<\/body\s*>/iu, '</body>');
  return output;
}

/** Rimuove entrambi i link RSS quando la release API non emette alcun feed. */
export function removeCantonRssFeedLinks(html) {
  if (typeof html !== 'string') throw new Error('landing RSS senza HTML');
  return html
    .replace(/\s*<link\b[^>]*data-canton-rss-feed[^>]*>\s*/giu, '')
    .replace(/\s*<a\b[^>]*data-canton-rss-feed[^>]*>[\s\S]*?<\/a\s*>\s*/giu, '');
}

/** Trasforma le righe del manifest in page entry verificati dalla stessa allowlist del publisher. */
function manifestPageEntries(section, manifest, kind) {
  return (manifest.pages?.[kind] ?? []).map((row) => {
    const page = pageEntry(section, row.rel, kind);
    if (page.canonicalPath !== row.canonicalPath || page.edgeKey !== row.edgeKey) {
      throw new Error(`manifest ${section}: ${kind} ${row.rel} non corrisponde alla chiave del Worker`);
    }
    return kind === 'article' ? { ...page, id: row.id } : page;
  });
}

function manifestEntryFromReleasePage(section, page, kind) {
  const entry = pageEntry(section, `${page.canonicalPath.slice(1)}index.html`, kind);
  return kind === 'article' ? { ...entry, id: page.id } : entry;
}

function articlePageIdentity(page) {
  if (typeof page?.id !== 'string' || !page.id || typeof page?.locale !== 'string' || !page.locale) return null;
  return `${page.id}\u0000${page.locale}`;
}

function articleManifestEntry(section, page) {
  return page.kind === 'article' && typeof page.rel === 'string'
    ? page
    : manifestEntryFromReleasePage(section, page, 'article');
}

/**
 * Inventario articolo della release aggregate, limitato alle pagine davvero
 * verificate dal publisher. Un articolo gia' online resta nel manifest finche'
 * la sua nuova URL non e' stata caricata e letta: cosi' un reconcile parziale
 * non annuncia una chiave che non esiste ancora sull'edge.
 */
export function articleManifestPages({ section, previousArticlePages = [], currentArticlePages = [], verifiedArticlePages = [] }) {
  const currentByIdentity = new Map();
  const currentByPath = new Map();
  for (const page of currentArticlePages) {
    const identity = articlePageIdentity(page);
    if (identity) currentByIdentity.set(identity, page);
    currentByPath.set(page.canonicalPath, page);
  }
  const verifiedByIdentityPath = new Map();
  for (const page of verifiedArticlePages) {
    const identity = articlePageIdentity(page);
    const current = identity ? currentByIdentity.get(identity) : null;
    if (!identity || !current || current.canonicalPath !== page.canonicalPath) continue;
    verifiedByIdentityPath.set(`${identity}\u0000${page.canonicalPath}`, page);
  }
  for (const previous of previousArticlePages) {
    const identity = articlePageIdentity(previous);
    const current = identity ? currentByIdentity.get(identity) : null;
    if (identity && current?.canonicalPath === previous.canonicalPath) {
      verifiedByIdentityPath.set(`${identity}\u0000${current.canonicalPath}`, previous);
    }
  }

  const result = new Map();
  for (const previous of previousArticlePages) {
    const identity = articlePageIdentity(previous);
    const current = (identity ? currentByIdentity.get(identity) : null)
      ?? currentByPath.get(previous.canonicalPath);
    if (!current) continue; // articolo ritirato: obsoleteReleasePages lo cancellera' dopo la readiness gate
    const replacement = identity
      ? verifiedByIdentityPath.get(`${articlePageIdentity(current)}\u0000${current.canonicalPath}`)
      : null;
    const selected = articlePageIdentity(current) === identity && current.canonicalPath === previous.canonicalPath
      ? current
      : replacement ?? previous;
    result.set(selected.edgeKey, articleManifestEntry(section, selected));
  }
  for (const page of verifiedByIdentityPath.values()) {
    result.set(page.edgeKey, articleManifestEntry(section, page));
  }
  return [...result.values()];
}

/**
 * Prima che esista il manifest edge, un giro article-only deve comunque
 * lasciare un inventario completo abbastanza da far vedere al giro seguente
 * le pagine che il parent del push non contiene più. Gli aggregati hanno
 * percorsi derivati dal core; gli articoli e l'archivio arrivano dalla
 * release precedente usata solo per questa migrazione.
 */
export function migrationManifestPages(section, previousArticlePages, previousArchivePages, all = ARTICLE_SECTION_CORE_ALL) {
  const routes = normalizedSectionRoutes(section, all);
  const topicHubs = assertHubTopicEntries(section, all[section].topicHubs);
  return [
    ...previousArticlePages.map((page) => manifestEntryFromReleasePage(section, page, 'article')),
    ...previousArchivePages.map((page) => manifestEntryFromReleasePage(section, page, 'archive')),
    ...routes.flatMap((route) => {
      const landing = pageEntry(section, `${route.prefix.slice(1)}/index.html`, 'landing', all);
      const hubs = topicHubs.map(([topic, slugs]) => pageEntry(
        section,
        `${route.prefix.slice(1)}/${assertHubLocaleSlug(section, topic, route.locale, slugs)}/index.html`,
        'hub',
        all,
      ));
      return [landing, ...hubs];
    }),
  ];
}

const RELEASE_LOCALES = Object.freeze(['it', 'en', 'de', 'fr']);
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function releaseRegistryIds(source, rel) {
  const ids = scanTopLevelArticleRecords(source).map(({ id }) => id);
  // Una sezione cantonale appena materializzata usa il suo registro-scheletro
  // `Article[] = [\n];`: zero articoli e' uno stato legittimo della famiglia,
  // non un corpus troncato. Una forma diversa senza id resta invece un errore.
  if (!ids.length && !/=\s*\[\s*\]\s*;/.test(source)) throw new Error(`${rel}: registro senza id articolo`);
  return ids;
}

function isEmptySlugMap(source, slugConst) {
  return new RegExp(
    `\\bconst\\s+${escapeRegex(slugConst)}(?:\\s*:\\s*[^=\\n]+)?\\s*=\\s*\\{\\s*\\}\\s*;`,
    'm',
  ).test(source);
}

function readGitFile(rootDir, revision, rel) {
  const result = spawnSync('git', ['-C', rootDir, 'cat-file', '-e', `${revision}:${rel}`], {
    encoding: 'utf8',
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  if (result.status !== 0) return null;
  return execFileSync('git', ['-C', rootDir, 'show', `${revision}:${rel}`], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** URL canonici articolo di una release, derivati da registry + slug map. */
export function articleReleasePages(section, { ids, slugs }) {
  const routes = new Map(normalizedSectionRoutes(section).map((route) => [route.locale, route]));
  const pages = [];
  for (const id of ids) {
    for (const locale of RELEASE_LOCALES) {
      const slug = slugs[id]?.[locale] ?? id;
      if (typeof slug !== 'string' || !slug.trim()) continue;
      const route = routes.get(locale);
      const canonicalPath = `${route.prefix}/${slug}/`.replace(/\/+/g, '/');
      if (!/^\/[a-z0-9][a-z0-9/-]*\/$/.test(canonicalPath) || canonicalPath.includes('..')) {
        throw new Error(`${section}: slug articolo non canonico per ${id}/${locale}: ${slug}`);
      }
      const edgeKey = `${EDGE_PREFIX}${canonicalPath}index.html`;
      pages.push({
        id,
        locale,
        canonicalPath,
        edgeKey,
        apexUrl: `${APEX}${canonicalPath}`,
        cdnUrl: `${CDN_BASE}/${edgeKey}`,
      });
    }
  }
  return pages;
}

/**
 * Confronta le URL della release precedente con quelle correnti. La lista e'
 * una allowlist di sole pagine articolo canoniche della sezione: un cambio di
 * slug e una rimozione producono una delete R2, mentre una URL ancora
 * annunciata non viene mai toccata.
 */
export function obsoleteArticlePages(previousPages, currentPages, verifiedPages = currentPages) {
  const currentPaths = new Set(currentPages.map((page) => page.canonicalPath));
  const currentByIdentity = new Map();
  const currentByPath = new Map();
  for (const page of currentPages) {
    const identity = articlePageIdentity(page);
    if (identity) currentByIdentity.set(identity, page);
    currentByPath.set(page.canonicalPath, page);
  }
  const verifiedByIdentityPath = new Set();
  for (const page of verifiedPages) {
    const identity = articlePageIdentity(page);
    if (identity) verifiedByIdentityPath.add(`${identity}\u0000${page.canonicalPath}`);
  }
  for (const previous of previousPages) {
    const identity = articlePageIdentity(previous);
    const current = identity ? currentByIdentity.get(identity) : null;
    if (identity && current?.canonicalPath === previous.canonicalPath) {
      verifiedByIdentityPath.add(`${identity}\u0000${current.canonicalPath}`);
    }
  }
  return previousPages.filter((page) => {
    const identity = articlePageIdentity(page);
    if (!identity) return !currentPaths.has(page.canonicalPath);
    const current = currentByIdentity.get(identity);
    if (!current) {
      // Se un altro id riusa la stessa URL, non e' una delete: la chiave
      // fisica e' anche quella della nuova pagina e va protetta finche' il
      // nuovo contenuto non e' stato verificato.
      return !currentByPath.has(page.canonicalPath);
    }
    if (current.canonicalPath === page.canonicalPath) return false;
    return verifiedByIdentityPath.has(`${identity}\u0000${current.canonicalPath}`);
  });
}

/** Vecchie pagine di archivio non piu' emesse dopo una riduzione del corpus. */
export function obsoleteArchivePages(previousPages, currentPages) {
  const current = new Set(currentPages.map((page) => page.canonicalPath));
  return previousPages.filter((page) => !current.has(page.canonicalPath));
}

export function articleReleaseSnapshot(rootDir, section, revision = null) {
  const source = sectionSourceSurfaces(section);
  const read = (rel) => {
    if (revision) return readGitFile(rootDir, revision, rel);
    const abs = path.join(rootDir, rel);
    return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
  };
  const registry = read(source.registryFile);
  const slugSource = read(source.slugFile);
  if (registry === null && slugSource === null) return [];
  if (registry === null || slugSource === null) {
    throw new Error(`${section}: release ${revision ?? 'working tree'} ha registry/slugs incompleti`);
  }
  const ids = releaseRegistryIds(registry, source.registryFile);
  if (!ids.length && isEmptySlugMap(slugSource, source.slugExport)) return [];
  const slugs = parseArticleUrlSlugs(slugSource, source.slugExport);
  if (!ids.length) {
    throw new Error(`${section}: release ${revision ?? 'working tree'} ha registry/slugs incoerenti (registro vuoto, slug non vuoti)`);
  }
  return articleReleasePages(section, {
    ids,
    slugs,
  });
}

const ARCHIVE_TITLE_ID_RE = /['"]blog\.article\.([^'"]+?)\.title['"]\s*:/g;

function archiveArticleIds(metaSource, slugSource, slugConst) {
  const ids = new Set();
  for (const match of String(metaSource ?? '').matchAll(ARCHIVE_TITLE_ID_RE)) ids.add(match[1]);
  if (slugSource !== null) {
    if (!isEmptySlugMap(slugSource, slugConst)) {
      for (const id of Object.keys(parseArticleUrlSlugs(slugSource, slugConst))) ids.add(id);
    }
  }
  return ids;
}

/** Archive `/tutti/` + page-N URLs emitted by the shared archive renderer. */
export function archiveReleasePages(section, input) {
  const articleIds = Array.isArray(input)
    ? new Set(input.map((page) => page.id).filter(Boolean))
    : (() => {
      if (input.slugSource === null) throw new Error(`${section}: archivio senza slug map`);
      return archiveArticleIds(input.metaSource, input.slugSource, input.slugConst);
    })();
  const totalPages = Math.max(1, Math.ceil(articleIds.size / ARTICLES_PAGE_SIZE));
  const routes = new Map(normalizedSectionRoutes(section).map((route) => [route.locale, route]));
  return RELEASE_LOCALES.flatMap((locale) => {
    const route = routes.get(locale);
    return Array.from({ length: totalPages }, (_, index) => {
      const page = index + 1;
      const suffix = page === 1 ? `/${CANTON_ARCHIVE_ALL_SLUG[locale]}/` : `/${CANTON_ARCHIVE_ALL_SLUG[locale]}/page-${page}/`;
      return pageEntry(section, `${route.prefix.slice(1)}${suffix}index.html`, 'archive');
    });
  });
}

function archiveReleaseSnapshot(rootDir, section, revision = null) {
  const source = sectionSourceSurfaces(section);
  const read = (rel) => {
    if (revision) return readGitFile(rootDir, revision, rel);
    const abs = path.join(rootDir, rel);
    return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
  };
  const metaSource = read(source.metaFile('it'));
  const slugSource = read(source.slugFile);
  // Before a section is materialized there is no old archive key to delete.
  if (metaSource === null && slugSource === null) return [];
  return archiveReleasePages(section, {
    metaSource,
    slugSource,
    slugConst: source.slugExport,
  });
}

function previousRevision(rootDir, requestedRevision) {
  let revision;
  try {
    revision = requestedRevision || execFileSync('git', ['-C', rootDir, 'rev-parse', 'HEAD~1'], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
  if (/^0+$/.test(revision)) return null;
  return revision;
}

function previousArticleReleasePages(rootDir, section, requestedRevision) {
  const revision = previousRevision(rootDir, requestedRevision);
  if (!revision) return [];
  return articleReleaseSnapshot(rootDir, section, revision);
}

function previousArchiveReleasePages(rootDir, section, requestedRevision) {
  const revision = previousRevision(rootDir, requestedRevision);
  if (!revision) return [];
  return archiveReleaseSnapshot(rootDir, section, revision);
}

/**
 * Cio' che una pagina cantonale deve avere per essere pubblicata; ritorna la
 * lista dei difetti (vuota = ok).
 */
function cantonRssFeedLinkDefects(html, requiredRssUrl) {
  const escapedUrl = escapeHtmlAttribute(requiredRssUrl);
  const rssHead = /<link\b(?=[^>]*data-canton-rss-feed)(?=[^>]*rel="alternate")(?=[^>]*type="application\/rss\+xml")(?=[^>]*href="([^"]+)")[^>]*>/i.exec(String(html ?? ''))?.[1];
  const rssAnchor = /<a\b(?=[^>]*data-canton-rss-feed)(?=[^>]*rel="alternate")(?=[^>]*type="application\/rss\+xml")(?=[^>]*href="([^"]+)")[^>]*>RSS<\/a\s*>/i.exec(String(html ?? ''))?.[1];
  const defects = [];
  if (rssHead !== escapedUrl) defects.push(`link RSS autodiscovery ${rssHead ?? 'assente'} diverso da ${requiredRssUrl}`);
  if (rssAnchor !== escapedUrl) defects.push(`link RSS visibile ${rssAnchor ?? 'assente'} diverso da ${requiredRssUrl}`);
  return defects;
}

function hasExpectedCantonRssFeedLinks(html, requiredRssUrl) {
  return cantonRssFeedLinkDefects(html, requiredRssUrl).length === 0;
}

export function pageDefects(page, html, { requiredRssUrl = null } = {}) {
  const defects = [];
  if (!html || html.length < 200) defects.push('vuota o troncata');
  // Il router della SPA resta in staticOverlay solo su un documento che porta
  // questo meta: senza, sopra la pagina comparirebbe NotFoundSuggestions.
  if (!html.includes(CORPUS_ROUTE_OWNER_META_TAG)) defects.push('manca il meta ft-route-owner');
  if (/<meta[^>]+name="robots"[^>]+content="[^"]*noindex/i.test(html) || /<meta[^>]+content="[^"]*noindex[^"]*"[^>]+name="robots"/i.test(html)) {
    defects.push('porta un robots noindex (nessuna pagina cantonale e\' noindex)');
  }
  if (/(?:src|href)="\/assets\//.test(html)) defects.push('riferimenti /assets/ same-origin (404 in produzione, #5270)');
  const canonical = /<link[^>]+rel="canonical"[^>]+href="([^"]+)"/i.exec(html)?.[1];
  if (canonical !== page.apexUrl) defects.push(`canonical ${canonical ?? 'assente'} diverso da ${page.apexUrl}`);
  if (page.kind === 'landing' && requiredRssUrl) {
    defects.push(...cantonRssFeedLinkDefects(html, requiredRssUrl));
  }
  return defects;
}

/**
 * La «radice di render»: una vista del repo nel LAYOUT DEL SITO, che e' quello
 * in cui l'engine legge il corpus (`services/locales/<metaPrefix>-<loc>.ts`,
 * `services/seo/seo-blog-<sezione>.ts`, `packages/articles/content/cantons/…`).
 * Per le due sezioni storiche quel layout esiste come symlink committati, uno
 * per file (`services/locales/blog-meta-ch-it.ts` → `content/…`); per 24
 * sezioni cantonali x 4 locali sarebbero un centinaio di symlink da tenere in
 * pari col generatore. Qui la vista si costruisce al volo, con tre alias di
 * CARTELLA che valgono per qualunque sezione:
 *
 *   services/locales          → content
 *   services/seo/<storico>    → content/seo/<storico>
 *   services/seo/seo-blog-<canton>.ts → content/cantons/<canton>/seo.ts
 *   packages/articles/content → content   (+ packages/articles/engine → engine)
 *
 * Tutto il resto della radice e' un symlink alla cartella vera, quindi letture
 * e sottoprocessi (offload) vedono gli stessi file. Sola lettura: niente viene
 * scritto attraverso la vista.
 */
export function createRenderRoot(rootDir, tmpBase = os.tmpdir()) {
  return createEngineCorpusView(rootDir, tmpBase);
}

/**
 * Il meta di proprieta' della route, se la pagina non lo porta gia'. Il router
 * della SPA resta in staticOverlay su un path cantonale SOLO se il documento
 * ha questo meta (engine/shared/corpusRouteOwner.mjs); landing, hub e articoli
 * lo ricevono dall'engine, l'archivio `/tutti/` no (il suo renderer e'
 * condiviso con le sezioni storiche, che non lo vogliono). Senza, sopra un
 * archivio valido comparirebbe NotFoundSuggestions: e' cio' che `pageDefects`
 * rifiuta. Idempotente — quando l'engine lo emettera' da se', non fa niente.
 */
export function ensureRouteOwnerMeta(html) {
  if (html.includes(CORPUS_ROUTE_OWNER_META_TAG)) return html;
  const anchored = html.replace(/(<meta charset="[^"]*"\s*\/?>)/i, `$1\n${CORPUS_ROUTE_OWNER_META_TAG}`);
  if (anchored !== html) return anchored;
  const headed = html.replace(/(<head[^>]*>)/i, `$1\n${CORPUS_ROUTE_OWNER_META_TAG}`);
  if (headed === html) throw new Error('pagina senza <head>: impossibile dichiarare ft-route-owner');
  return headed;
}

/** Le pagine nell'ordine di upload (`UPLOAD_ORDER`), stabile dentro ogni tipo. */
export function inUploadOrder(pages) {
  return [...pages].sort((a, b) => UPLOAD_ORDER.indexOf(a.kind) - UPLOAD_ORDER.indexOf(b.kind));
}

/**
 * Gli aggregati sono obbligatori nel percorso normale. Quando la pipeline ha
 * trattenuto un articolo, invece, devono essere tutti assenti: il publisher
 * conserva archive/landing/hub online e carica soltanto le pagine articolo
 * filtrate che hanno superato la post-condizione.
 */
export function aggregatePageDefects(pages, { aggregatePagesAllowed, locales = CANTON_HUB_LOCALES } = {}) {
  if (typeof aggregatePagesAllowed !== 'boolean') return ['verdetto aggregatePagesAllowed assente o non booleano'];
  if (!aggregatePagesAllowed) {
    const leaked = pages.filter((page) => page.kind !== 'article');
    return leaked.length > 0
      ? [`pagine aggregate presenti nel percorso article-only: ${leaked.map((page) => page.rel).join(', ')}`]
      : [];
  }
  const defects = [];
  for (const kind of ['archive', 'landing']) {
    for (const locale of locales) {
      if (!pages.some((page) => page.kind === kind && page.locale === locale)) defects.push(`nessuna pagina ${kind} per ${locale}`);
    }
  }
  return defects;
}

/**
 * Finche' gli aggregati precedenti restano online, nessuna pagina della loro
 * release puo' diventare obsoleta: potrebbero ancora linkarla. Gli articoli
 * sani del batch vengono caricati, ma cancellazioni e aggiornamento degli
 * aggregati riprendono insieme soltanto su un verdetto completo.
 */
export function obsoleteReleasePages({
  previousArticlePages,
  currentArticlePages,
  verifiedArticlePages = currentArticlePages,
  previousArchivePages,
  currentArchivePages,
  aggregatePagesAllowed,
}) {
  if (typeof aggregatePagesAllowed !== 'boolean') throw new Error('aggregatePagesAllowed deve essere booleano');
  if (!aggregatePagesAllowed) return [];
  return [
    ...obsoleteArticlePages(previousArticlePages, currentArticlePages, verifiedArticlePages),
    ...obsoleteArchivePages(previousArchivePages, currentArchivePages),
  ];
}

/** Rende i 6 hub (quelli con il file dati) nelle 4 locali. */
async function renderHubs({ section, distDir }) {
  const { renderCantonTopicHub } = await import('../engine/cantonSectionPages.ts');
  const canton = ARTICLE_SECTION_CORE_ALL[section].canton;
  const rels = [];
  const pages = [];
  const missing = [];
  for (const topic of cantonHubTopics(section)) {
    const data = readCantonHubData(ROOT_DIR, section, topic);
    if (!data) {
      missing.push(topic);
      continue;
    }
    for (const locale of CANTON_HUB_LOCALES) {
      let page;
      try {
        page = renderCantonTopicHub({ keyFacts: [], dataBlocks: [], curatedArticles: [], latestCantonArticles: [], links: [], ...data[locale], canton, topic, locale });
      } catch (error) {
        throw new Error(`${cantonHubDataFile(section, topic)} (${locale}): ${error.message}`, { cause: error });
      }
      writePage(distDir, page.relPath, page.html);
      rels.push(page.relPath);
      pages.push(page);
    }
  }
  return { rels, pages, missing };
}

function writePage(distDir, rel, html) {
  const abs = path.join(distDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  // Sanificare distrugge il marker che rende esatta una riparazione futura:
  // si registra prima di scrivere (#95, #133), come fa la catena per gli articoli.
  const clean = sanitizeHtmlDocument(html);
  reportStrippedControlChars(abs, html, clean);
  fs.writeFileSync(abs, clean, 'utf-8');
}

function run(cmd, args) {
  const res = spawnSync(cmd, args, { cwd: ROOT_DIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  process.stdout.write(res.stdout ?? '');
  process.stderr.write(res.stderr ?? '');
  return { code: res.status ?? 1, stdout: res.stdout ?? '' };
}

/** Scrive un checkpoint o la release solo nel punto deciso dal chiamante. */
export function publishPageManifest({ manifest, distDir, runImpl = run }) {
  const local = path.join(distDir, `.section-page-manifest-${manifest.section}.json`);
  try {
    fs.writeFileSync(local, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');
    const result = runImpl('bash', ['scripts/lib/upload-cdn-file.sh', local, pageManifestKey(manifest.section), PAGE_MANIFEST_CACHE_CONTROL]);
    return result.stdout.includes('✅ uploaded');
  } finally {
    fs.rmSync(local, { force: true });
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** GET con cache-buster, ritentata: una pagina appena caricata puo' metterci qualche secondo. */
async function probe(url, { attempts = 6, delayMs = 4000, want = () => true } = {}) {
  let last = 'nessuna risposta';
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetchWithRefTimeout(`${url}${url.includes('?') ? '&' : '?'}_spcb=${Date.now()}.${i}`, {
        redirect: 'manual',
        headers: { 'user-agent': 'frontaliere-corpus-publisher/1 (+https://frontaliereticino.ch)' },
      }, 20000);
      const body = res.status === 200 ? await res.text() : '';
      if (res.status !== 200) releaseFetchWithRefTimeout(res);
      if (res.status === 200 && want(body)) return { ok: true, status: 200, body };
      last = res.status === 200 ? 'risposta 200 senza il contenuto atteso' : `HTTP ${res.status}`;
    } catch (error) {
      last = error?.message ?? String(error);
    }
    if (i < attempts) await sleep(delayMs);
  }
  return { ok: false, status: last };
}

/** Lo stato della sezione nel registro che il Worker legge DAVVERO (R2), o null se illeggibile. */
export async function publishedStatus(section) {
  const res = await probe(`${CDN_BASE}/${EDGE_SECTION_REGISTRY_FILE}`, { attempts: 2, delayMs: 2000 });
  if (!res.ok) return null;
  try {
    const registry = JSON.parse(res.body);
    if (!validateEdgeSectionRegistry(registry)) return null;
    const status = registry.sections?.[section]?.status;
    return status === 'live' || status === 'draft' || status === 'retired' ? status : null;
  } catch {
    return null;
  }
}

function cacheBustedUrl(url, parameter, suffix = '') {
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}${parameter}=${Date.now()}${suffix ? `.${suffix}` : ''}`;
}

async function fetchJsonAt(url, fetchImpl) {
  try {
    const res = await fetchWithRefTimeout(cacheBustedUrl(url, '_sppr'), {
      headers: { 'user-agent': 'frontaliere-section-pages/1 (+https://frontaliereticino.ch)' },
    }, 20000, fetchImpl);
    if (!res.ok) {
      releaseFetchWithRefTimeout(res);
      return null;
    }
    return await res.json();
  } catch {
    return null;
  }
}

/** Il commit della superficie API gia' pubblicata, non quello del publisher locale. */
export async function publishedApiReleaseCommit({ fetchImpl = fetch } = {}) {
  const manifest = await fetchJsonAt(`${API_BASE}/manifest.json`, fetchImpl);
  const commit = manifest?.commit;
  return typeof commit === 'string' && commit.trim() ? commit.trim() : null;
}

/**
 * Legge i path del trigger API dal suo stesso YAML: il fallback a una release
 * gia' pubblicata non puo' mantenere una lista parallela che invecchia.
 *
 * Il workflow non viene passato a un parser YAML perche' questo script gira
 * senza dipendenze npm. Si legge pero' la struttura reale `on.push.paths`,
 * calcolando l'indentazione dei figli invece di assumere quella di una
 * particolare versione del file.
 */
export function publishApiTriggerPaths({ workflowText = null } = {}) {
  const workflow = workflowText ?? fs.readFileSync(path.join(ROOT_DIR, PUBLISH_API_WORKFLOW), 'utf8');
  const lines = workflow.split(/\r?\n/u);
  const leadingSpaces = (line) => line.match(/^ */u)?.[0].length ?? -1;
  const isIgnorable = (line) => line.trim() === '' || /^\s*#/u.test(line);
  const keyAt = (line, indent, key) => new RegExp(`^ {${indent}}${key}:\\s*(?:#.*)?$`, 'u').test(line);

  const onAt = lines.findIndex((line) => keyAt(line, leadingSpaces(line), 'on') && leadingSpaces(line) === 0);
  if (onAt < 0) throw new Error(`trigger on assente in ${PUBLISH_API_WORKFLOW}`);
  const onIndent = leadingSpaces(lines[onAt]);
  const pushAt = lines.findIndex((line, index) => {
    if (index <= onAt || isIgnorable(line)) return false;
    const indent = leadingSpaces(line);
    if (indent >= 0 && indent <= onIndent) return false;
    return keyAt(line, indent, 'push');
  });
  if (pushAt < 0) throw new Error(`trigger push assente in ${PUBLISH_API_WORKFLOW}`);
  const pushIndent = leadingSpaces(lines[pushAt]);

  let pathsAt = -1;
  let pathsIndent = -1;
  let pushChildIndent = -1;
  for (let index = pushAt + 1; index < lines.length; index++) {
    const line = lines[index];
    if (isIgnorable(line)) continue;
    const indent = leadingSpaces(line);
    if (indent <= pushIndent) break;
    pushChildIndent = pushChildIndent < 0 ? indent : pushChildIndent;
    if (indent === pushChildIndent && keyAt(line, indent, 'paths')) {
      pathsAt = index;
      pathsIndent = indent;
      break;
    }
  }
  if (pathsAt < 0) throw new Error(`trigger push.paths assente in ${PUBLISH_API_WORKFLOW}`);

  const paths = [];
  let itemIndent = -1;
  for (let index = pathsAt + 1; index < lines.length; index++) {
    const line = lines[index];
    if (isIgnorable(line)) continue;
    const indent = leadingSpaces(line);
    if (indent <= pathsIndent) break;
    itemIndent = itemIndent < 0 ? indent : itemIndent;
    if (indent !== itemIndent) {
      throw new Error(`trigger push.paths malformato in ${PUBLISH_API_WORKFLOW}`);
    }
    const item = new RegExp(`^ {${itemIndent}}-\\s+(['"])([^'"]+)\\1\\s*(?:#.*)?$`, 'u').exec(line);
    if (!item) throw new Error(`voce trigger push.paths malformata in ${PUBLISH_API_WORKFLOW}`);
    paths.push(item[2]);
  }
  if (paths.length === 0) throw new Error(`trigger paths assenti in ${PUBLISH_API_WORKFLOW}`);
  return paths;
}

/**
 * L'ultimo input di publish-api raggiungibile dal commit del publisher.
 *
 * Il diff della push corrente non basta: una push solo publisher puo' seguire
 * un input API precedente la cui release non e' mai arrivata sulla superficie
 * HTTP. Il fallback e' sicuro solo quando la release pubblicata copre questo
 * commit, quindi la ricerca attraversa tutta la storia del publisher usando
 * gli stessi path dichiarati dal workflow API.
 */
export function latestApiInputCommit(
  publisherCommit,
  { execFileSyncImpl = execFileSync, triggerPathsImpl = publishApiTriggerPaths } = {},
) {
  const commit = String(publisherCommit ?? '').trim();
  if (!commit) throw new Error('commit publisher assente: impossibile classificare gli input API');
  const triggerPaths = triggerPathsImpl();
  try {
    const latest = execFileSyncImpl(
      'git',
      ['-C', ROOT_DIR, 'rev-list', '--max-count=1', commit, '--', ...triggerPaths],
      { encoding: 'utf8' },
    );
    return String(latest ?? '').trim() || null;
  } catch (error) {
    throw new Error(
      `storia Git non verificabile per gli input API raggiungibili da ${commit}: ${error?.message ?? String(error)}`,
      { cause: error },
    );
  }
}

/**
 * Indica se l'intervallo della push/run contiene almeno un input di
 * publish-api. Il commit piu' recente nella storia non basta: quando una
 * singola push contiene I (input API) e P (solo publisher), build-api stampa
 * P nel manifest perche' costruisce dalla HEAD della push.
 */
export function apiInputChangedInRange(
  { before, after },
  { execFileSyncImpl = execFileSync, triggerPathsImpl = publishApiTriggerPaths } = {},
) {
  const base = String(before ?? '').trim();
  const head = String(after ?? '').trim();
  if (!base || !head) return false;
  if (!FULL_GIT_SHA_RE.test(head)) throw new Error(`HEAD della push non valida: ${head}`);
  if (!/^0+$/.test(base) && !FULL_GIT_SHA_RE.test(base)) {
    throw new Error(`base della push non valida: ${base}`);
  }
  const args = ['-C', ROOT_DIR, 'rev-list', '--max-count=1', head];
  if (!/^0+$/.test(base)) args.push(`^${base}`);
  args.push('--', ...triggerPathsImpl());
  try {
    const latest = execFileSyncImpl('git', args, { encoding: 'utf8' });
    return Boolean(String(latest ?? '').trim());
  } catch (error) {
    throw new Error(
      `intervallo Git non verificabile per gli input API ${base}..${head}: ${error?.message ?? String(error)}`,
      { cause: error },
    );
  }
}

function gitIsAncestor(ancestor, descendant) {
  try {
    execFileSync('git', ['-C', ROOT_DIR, 'merge-base', '--is-ancestor', ancestor, descendant], { stdio: 'ignore' });
    return true;
  } catch (error) {
    if (error?.status === 1) return false;
    throw error;
  }
}

/**
 * Se un replay stantio ha una release API che copre ancora tutti gli input
 * raggiungibili dalla HEAD corrente, puo' conservare quella release. Altrimenti
 * la HEAD corrente diventa il gate di readiness: il replay aspetta la
 * completion API corrente invece di pubblicare HTML nuovo sopra dati vecchi.
 */
export function resolveStaleReplayApiReleaseCommit(
  currentMainCommit,
  staleApiReleaseCommit,
  {
    latestApiInputCommitImpl = latestApiInputCommit,
    isAncestorImpl = gitIsAncestor,
  } = {},
) {
  const currentMain = String(currentMainCommit ?? '').trim();
  const staleRelease = String(staleApiReleaseCommit ?? '').trim();
  if (!FULL_GIT_SHA_RE.test(currentMain)) throw new Error(`HEAD corrente di main non valida: ${currentMain}`);
  if (!FULL_GIT_SHA_RE.test(staleRelease)) throw new Error(`release API stantia non valida: ${staleRelease}`);
  const latestInput = latestApiInputCommitImpl(currentMain);
  if (!latestInput) return staleRelease;
  return isAncestorImpl(latestInput, staleRelease) ? staleRelease : currentMain;
}

/**
 * Un push che cambia solo il publisher puo' legarsi alla release API gia'
 * disponibile soltanto quando questa copre l'ultimo input API raggiungibile
 * dal publisher. Se l'ultimo input appartiene invece alla push corrente,
 * l'attesa deve usare la HEAD effettiva della push: build-api registra quella
 * HEAD nel manifest anche quando l'ultimo file API e' un commit precedente.
 * Un replay bounded puo' propagare il commit della release osservata: viene
 * verificato contro il manifest HTTP e non riclassificato rispetto ai commit
 * bookkeeping successivi. Un manifest assente o illeggibile non e' una
 * provenienza: il publisher resta bloccato invece di inventare la HEAD locale.
 */
export async function resolvePublishedReleaseCommit(
  publisherCommit,
  {
    apiReleaseCommitImpl = publishedApiReleaseCommit,
    apiReleaseCommitOverride = null,
    latestApiInputCommitImpl = latestApiInputCommit,
    currentPushApiInputImpl = apiInputChangedInRange,
    pushBefore = null,
    pushAfter = publisherCommit,
    isAncestorImpl = gitIsAncestor,
    fetchImpl = fetch,
  } = {},
) {
  if (!publisherCommit) return publisherCommit;
  const override = String(apiReleaseCommitOverride ?? '').trim();
  if (override && !/^[a-f0-9]{40,64}$/iu.test(override)) {
    throw new Error(`commit API esplicito non valido: ${override}`);
  }
  const apiCommit = await apiReleaseCommitImpl({ fetchImpl });
  if (override && apiCommit !== override) {
    throw new Error(`commit API osservato ${apiCommit ?? 'assente'} diverso da quello propagato ${override}`);
  }
  if (typeof apiCommit !== 'string' || !apiCommit.trim()) {
    throw new Error('commit API pubblicato assente o non verificabile; pubblicazione interrotta');
  }
  if (apiCommit.trim() === publisherCommit) return publisherCommit;
  const publishedCommit = apiCommit.trim();
  let isAncestor = false;
  try {
    isAncestor = await isAncestorImpl(publishedCommit, publisherCommit);
  } catch (error) {
    throw new Error(
      `commit API ${publishedCommit} non verificabile rispetto al publisher ${publisherCommit}: ${error?.message ?? String(error)}`,
      { cause: error },
    );
  }
  if (isAncestor !== true) {
    throw new Error(`commit API ${publishedCommit} non e' antenato del publisher ${publisherCommit}; pubblicazione interrotta`);
  }
  if (!override) {
    let latestInputCommit = null;
    try {
      latestInputCommit = await latestApiInputCommitImpl(publisherCommit);
    } catch (error) {
      throw new Error(
        `storia degli input API non verificabile per il commit API ${apiCommit.trim()}: ${error?.message ?? String(error)}`,
        { cause: error },
      );
    }
    if (latestInputCommit) {
      let releaseCoversLatestInput = false;
      try {
        releaseCoversLatestInput = await isAncestorImpl(latestInputCommit, publishedCommit);
      } catch (error) {
        throw new Error(
          `ultimo input API ${latestInputCommit} non verificabile rispetto alla release ${publishedCommit}: ${error?.message ?? String(error)}`,
          { cause: error },
        );
      }
      if (releaseCoversLatestInput !== true) {
        const base = String(pushBefore ?? '').trim();
        if (base) {
          const head = String(pushAfter ?? publisherCommit).trim() || publisherCommit;
          let currentPushHasApiInput = false;
          try {
            currentPushHasApiInput = await currentPushApiInputImpl({ before: base, after: head });
          } catch (error) {
            throw new Error(
              `intervallo della push non verificabile per gli input API ${base}..${head}: ${error?.message ?? String(error)}`,
              { cause: error },
            );
          }
          if (currentPushHasApiInput === true) return head;
        }
        return latestInputCommit;
      }
    }
  }
  return publishedCommit;
}

/**
 * La delete delle URL ritirate e' sicura solo dopo il flip della stessa
 * release che ha aggiornato sitemap e slug. Quando il push contiene input API,
 * `publish-api` e fast-publish partono dallo stesso push; quando cambia solo
 * questo publisher, il chiamante seleziona la release API che copre l'ultimo
 * input raggiungibile e la readiness puo' attenderne la pubblicazione.
 * In entrambi i casi attendiamo manifest, catalogo, slugs e puntatore edge sul
 * commit selezionato. Se uno e' ancora vecchio, il run fallisce senza
 * cancellare; il retry del workflow ripete la prova dopo il deploy API.
 */
export async function publishedReleaseReady(expectedCommit, { fetchImpl = fetch } = {}) {
  if (!expectedCommit) return { ok: false, reason: 'commit corrente non disponibile' };
  const [manifest, catalog, slugs, edgeRegistry] = await Promise.all([
    fetchJsonAt(`${API_BASE}/manifest.json`, fetchImpl),
    fetchJsonAt(`${API_BASE}/sections.json`, fetchImpl),
    fetchJsonAt(`${API_BASE}/slugs.json`, fetchImpl),
    fetchJsonAt(`${CDN_BASE}/${EDGE_SECTION_REGISTRY_FILE}`, fetchImpl),
  ]);
  if (!manifest || manifest.commit !== expectedCommit) {
    return { ok: false, reason: `manifest API non ancora sul commit ${expectedCommit}` };
  }
  if (!catalog || catalog.commit !== expectedCommit || !slugs || slugs.commit !== expectedCommit) {
    return { ok: false, reason: `catalogo/slugs API non ancora sul commit ${expectedCommit}` };
  }
  if (!edgeRegistry || edgeRegistry.commit !== expectedCommit || !validateEdgeSectionRegistry(edgeRegistry)) {
    return { ok: false, reason: `registro edge non ancora valido sul commit ${expectedCommit}` };
  }
  return {
    ok: true,
    commit: expectedCommit,
    files: manifest.files ?? null,
    counts: manifest.counts ?? null,
  };
}

function rewriteCantonRssSelfLink(xml, { section, name, url }) {
  if (!/<rss\b[^>]*>[\s\S]*<\/rss\s*>/iu.test(xml) || !/<channel\b[^>]*>[\s\S]*<\/channel\s*>/iu.test(xml)) {
    throw new Error(`${name}: documento RSS incompleto`);
  }
  if (!/<item(?:\s|>)/iu.test(xml)) throw new Error(`${name}: feed senza item`);
  const selfLinks = [...xml.matchAll(/<atom:link\b[^>]*>/giu)].map(([tag]) => tag)
    .filter((tag) => /\brel\s*=\s*(["'])self\1/iu.test(tag));
  if (selfLinks.length !== 1) throw new Error(`${name}: atteso un solo atom:link rel="self"`);
  const isItalianAlias = name === `rss-${section}-it.xml`;
  const selfName = isItalianAlias ? `rss-${section}.xml` : name;
  const expectedSource = `${APEX}/${selfName}`;
  const href = /\bhref\s*=\s*(["'])(.*?)\1/iu.exec(selfLinks[0]);
  if (!href || href[2] !== expectedSource) {
    throw new Error(`${name}: self-link API inatteso (${href?.[2] ?? 'assente'})`);
  }
  const targetUrl = isItalianAlias ? cantonRssFeedUrlForLocale(section, 'it') : url;
  return xml.replace(selfLinks[0], selfLinks[0].replace(href[0], `href="${targetUrl}"`));
}

function isNotFoundStatus(status) {
  return status === 404 || status === 'HTTP 404';
}

/** Snapshot del feed attualmente servito, usato per ripristinare un set parziale. */
async function snapshotCantonRssFeed(url, { probeImpl = probe } = {}) {
  return probeImpl(url, { attempts: 3, delayMs: 1000, want: () => true });
}

function uniqueCantonPages(pages) {
  return [...new Map((pages ?? []).map((page) => [page.edgeKey, page])).values()];
}

function normalizeCantonPageSnapshot(page, result) {
  if (result?.exists === false || (!result?.ok && isNotFoundStatus(result?.status))) {
    return { exists: false, body: null };
  }
  if (result?.exists === true && typeof result.body === 'string') {
    return { exists: true, body: result.body };
  }
  if (result?.ok === true && typeof result.body === 'string') {
    return { exists: true, body: result.body };
  }
  throw new Error(`${page.edgeKey}: superficie CDN precedente non verificabile (${result?.status ?? 'nessuna risposta'})`);
}

/** Snapshot delle chiavi HTML che la transazione puo' sovrascrivere. */
async function snapshotCantonPages(pages, { probeImpl = probe } = {}) {
  const snapshots = new Map();
  for (const page of uniqueCantonPages(pages)) {
    const previous = await probeImpl(page.cdnUrl, { attempts: 3, delayMs: 1000, want: () => true });
    snapshots.set(page.edgeKey, normalizeCantonPageSnapshot(page, previous));
  }
  return snapshots;
}

/** Ripristina HTML, purge e verifica prima che la transazione RSS torni indietro. */
async function rollbackCantonPages({ pages, snapshots, distDir, runImpl, probeImpl, live }) {
  const rollbackFiles = [];
  const targets = uniqueCantonPages(pages);
  let failures = 0;
  try {
    fs.mkdirSync(distDir, { recursive: true });
    for (let i = 0; i < targets.length; i++) {
      const page = targets[i];
      const previous = snapshots.get(page.edgeKey);
      try {
        if (!previous) throw new Error('snapshot mancante');
        if (previous.exists) {
          const local = path.join(distDir, `.canton-page-rollback-${i}.html`);
          fs.writeFileSync(local, previous.body, 'utf8');
          rollbackFiles.push(local);
          const { stdout = '' } = runImpl('bash', [
            'scripts/lib/upload-cdn-file.sh',
            local,
            page.edgeKey,
            PAGE_CACHE_CONTROL,
          ]);
          if (!stdout.includes('✅ uploaded')) throw new Error(`restore upload non confermato: ${page.edgeKey}`);
        } else {
          const { stdout = '' } = runImpl('bash', ['scripts/lib/delete-cdn-file.sh', page.edgeKey]);
          if (!stdout.includes('✅ deleted')) throw new Error(`restore delete non confermato: ${page.edgeKey}`);
        }
      } catch (error) {
        failures++;
        console.error(`::error::[${LOG}] rollback pagina HTML ${page.edgeKey} fallito: ${error?.message ?? String(error)}`);
      }
    }

    for (const chunk of purgeChunks(targets.flatMap((page) => [page.apexUrl, page.cdnUrl]))) {
      try {
        const { code = 1 } = runImpl('bash', ['scripts/ci/retry-cmd.sh', 'node', 'scripts/cf-purge-cache.mjs', `--files=${chunk.join(',')}`]);
        if (code !== 0) throw new Error(`purge exit ${code}`);
      } catch (error) {
        failures++;
        console.error(`::error::[${LOG}] purge rollback pagine HTML fallito: ${error?.message ?? String(error)}`);
      }
    }

    const restored = async (page, url, previous) => {
      const result = await probeImpl(url, {
        attempts: 3,
        delayMs: 1000,
        want: previous.exists ? (body) => body === previous.body : () => false,
      });
      const ok = previous.exists
        ? result?.ok === true && result.body === previous.body
        : result?.ok !== true && isNotFoundStatus(result?.status);
      if (!ok) throw new Error(`${url} stato inatteso (${result?.status ?? 'nessuna risposta'})`);
      return result;
    };
    for (const page of targets) {
      const previous = snapshots.get(page.edgeKey);
      try {
        if (!previous) throw new Error('snapshot mancante');
        await restored(page, page.cdnUrl, previous);
        if (live) await restored(page, page.apexUrl, previous);
      } catch (error) {
        failures++;
        console.error(`::error::[${LOG}] verifica rollback pagina HTML ${page.edgeKey} fallita: ${error?.message ?? String(error)}`);
      }
    }
  } finally {
    for (const local of rollbackFiles) fs.rmSync(local, { force: true });
  }
  return { failures };
}

function normalizeCantonRssSnapshot(feed, result) {
  if (result?.exists === false || (!result?.ok && isNotFoundStatus(result?.status))) {
    return { exists: false, body: null };
  }
  if (result?.exists === true && typeof result.body === 'string') {
    return { exists: true, body: result.body };
  }
  if (result?.ok && typeof result.body === 'string') {
    return { exists: true, body: result.body };
  }
  throw new Error(`${feed.name}: superficie CDN precedente non verificabile (${result?.status ?? 'nessuna risposta'})`);
}

async function rollbackCantonRssFeeds({ prepared, snapshots, distDir, runImpl, probeImpl, neutralize = false }) {
  const rollbackFiles = [];
  let failures = 0;
  try {
    fs.mkdirSync(distDir, { recursive: true });
    for (const feed of prepared) {
      const previous = snapshots.get(feed.name);
      try {
        if (neutralize) {
          const { stdout = '' } = runImpl('bash', ['scripts/lib/delete-cdn-file.sh', feed.key]);
          if (!stdout.includes('✅ deleted')) throw new Error(`neutralizzazione delete non confermata: ${feed.key}`);
        } else if (previous?.exists) {
          const local = path.join(distDir, `.canton-rss-rollback-${feed.name}`);
          fs.writeFileSync(local, previous.body, 'utf8');
          rollbackFiles.push(local);
          const { stdout = '' } = runImpl('bash', [
            'scripts/lib/upload-cdn-file.sh',
            local,
            feed.key,
            PAGE_CACHE_CONTROL,
          ]);
          if (!stdout.includes('✅ uploaded')) throw new Error(`restore upload non confermato: ${feed.key}`);
        } else {
          const { stdout = '' } = runImpl('bash', ['scripts/lib/delete-cdn-file.sh', feed.key]);
          if (!stdout.includes('✅ deleted')) throw new Error(`restore delete non confermato: ${feed.key}`);
        }
      } catch (error) {
        failures++;
        console.error(`::error::[${LOG}] rollback feed RSS ${feed.key} fallito: ${error?.message ?? String(error)}`);
      }
    }

    for (const chunk of purgeChunks(prepared.map((feed) => feed.url))) {
      try {
        const { code = 1 } = runImpl('bash', ['scripts/ci/retry-cmd.sh', 'node', 'scripts/cf-purge-cache.mjs', `--files=${chunk.join(',')}`]);
        if (code !== 0) throw new Error(`purge exit ${code}`);
      } catch (error) {
        failures++;
        console.error(`::error::[${LOG}] purge rollback feed RSS ${prepared[0]?.name ?? 'cantonale'} fallito: ${error?.message ?? String(error)}`);
      }
    }

    for (const feed of prepared) {
      const previous = snapshots.get(feed.name);
      try {
        const result = await probeImpl(feed.url, {
          want: neutralize
            ? () => false
            : previous?.exists ? (body) => body === previous.body : () => false,
          attempts: 3,
          delayMs: 1000,
        });
        const restored = neutralize
          ? result?.ok !== true && isNotFoundStatus(result?.status)
          : previous?.exists
            ? result?.ok === true
            : result?.ok !== true && isNotFoundStatus(result?.status);
        if (!restored) throw new Error(`stato CDN inatteso (${result?.status ?? 'nessuna risposta'})`);
      } catch (error) {
        failures++;
        console.error(`::error::[${LOG}] verifica rollback feed RSS ${feed.key} fallita: ${error?.message ?? String(error)}`);
      }
    }
  } finally {
    for (const local of rollbackFiles) fs.rmSync(local, { force: true });
  }
  return { failures };
}

/**
 * Copia su R2 i feed cantonali pubblicati dall'API HTTP dello stesso commit,
 * riscrive il solo self-link RSS verso la superficie CDN e verifica i byte
 * serviti prima che publish() carichi pagine che li annunciano.
 */
export async function publishCantonRssFeeds({
  section,
  releaseCommit,
  effectiveStatus,
  feedEntries = cantonRssFeedEntries(section),
  distDir,
  runImpl = run,
  probeImpl = probe,
  releaseReadyImpl = publishedReleaseReady,
  publishedStatusImpl,
  removeStaleCantonRssFeeds = false,
  fetchImpl = fetch,
  snapshotImpl = snapshotCantonRssFeed,
  sleepImpl = sleep,
  releaseReadyMaxWaitMs = RELEASE_READY_MAX_WAIT_MS,
  releaseReadyRetryDelayMs = RELEASE_READY_RETRY_DELAY_MS,
  assertMainFreshImpl = async () => {},
}) {
  const cleanupRequested = removeStaleCantonRssFeeds === true;
  const inactiveCleanup = cleanupRequested && ['draft', 'retired'].includes(effectiveStatus);
  if (effectiveStatus !== 'live' && !inactiveCleanup) {
    console.error(`::error::[${LOG}] feed RSS ${section}: la sezione non è live nel registro edge`);
    return { failures: 1, uploaded: 0, verified: 0 };
  }
  const expectedFeeds = cantonRssFeedEntries(section);
  const requestedNames = new Set(feedEntries.map(({ name }) => name));
  const feeds = expectedFeeds.filter(({ name }) => requestedNames.has(name));
  if (feeds.length !== feedEntries.length) {
    return { failures: 1, uploaded: 0, verified: 0 };
  }
  const localFiles = [];
  let prepared = [];
  let snapshots = null;
  let uploaded = 0;
  let verified = 0;
  let mutationStarted = false;
  try {
    const readiness = await waitForPublishedReleaseReady(releaseCommit, {
      section,
      fetchImpl,
      releaseReadyImpl,
      sleepImpl,
      maxWaitMs: releaseReadyMaxWaitMs,
      retryDelayMs: releaseReadyRetryDelayMs,
    });
    if (!(readiness === true || readiness?.ok)) {
      console.error(`::error::[${LOG}] feed RSS ${section}: API/edge non pronti (${readiness?.reason ?? 'verifica fallita'})`);
      return { failures: 1, uploaded: 0, verified: 0 };
    }
    if (readiness?.commit && readiness.commit !== releaseCommit) {
      console.error(`::error::[${LOG}] feed RSS ${section}: la release verificata non corrisponde al commit ${releaseCommit}`);
      return { failures: 1, uploaded: 0, verified: 0 };
    }
    // Le sezioni non-live sono deliberatamente assenti da manifest/API. Il
    // cleanup e' autorizzato solo da una transizione esplicita draft/retired;
    // una sezione ancora live deve invece provare il conteggio zero nel manifest.
    const declaredFeeds = inactiveCleanup
      ? []
      : cantonRssFeedsDeclaredInManifest(section, readiness.files, readiness.counts);
    const removingStaleFeeds = inactiveCleanup || declaredFeeds.length === 0;
    if (typeof publishedStatusImpl === 'function') {
      const currentStatus = await publishedStatusImpl(section);
      if (currentStatus !== effectiveStatus) {
        console.error(`::error::[${LOG}] feed RSS ${section}: il registro edge è cambiato dopo la readiness gate`);
        return { failures: 1, uploaded: 0, verified: 0, status: currentStatus };
      }
    }
    if (!removingStaleFeeds && (declaredFeeds.length !== feeds.length || declaredFeeds.some(({ name }) => !requestedNames.has(name)))) {
      throw new Error(`manifest API ${section}: set feed RSS diverso da quello richiesto`);
    }

    if (removingStaleFeeds) {
      // Un manifest senza feed e' una dichiarazione di ritiro, non un no-op:
      // ogni oggetto precedente deve diventare 404 prima di togliere i link
      // RSS dalle landing.
      prepared = expectedFeeds.map((feed) => ({ ...feed }));
    } else {
      for (let i = 0; i < feeds.length; i++) {
        const feed = feeds[i];
        const expectedBytes = readiness.files?.[feed.name];
        if (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0) {
          throw new Error(`${feed.name} non è dichiarato nel manifest API della release ${releaseCommit}`);
        }
        const response = await fetchWithRefTimeout(cacheBustedUrl(`${API_BASE}/${feed.name}`, '_sppr', i + 1), {
          redirect: 'manual',
          headers: { 'user-agent': 'frontaliere-section-pages/1 (+https://frontaliereticino.ch)' },
        }, 20000, fetchImpl);
        if (response.status !== 200 || !response.ok) {
          releaseFetchWithRefTimeout(response);
          throw new Error(`${feed.name}: API HTTP ${response.status}`);
        }
        const sourceXml = await response.text();
        if (Buffer.byteLength(sourceXml, 'utf8') !== expectedBytes) {
          throw new Error(`${feed.name}: byte count diverso dal manifest API (${Buffer.byteLength(sourceXml, 'utf8')} != ${expectedBytes})`);
        }
        const xml = rewriteCantonRssSelfLink(sourceXml, { section, name: feed.name, url: feed.url });
        prepared.push({ ...feed, xml });
      }
    }

    snapshots = new Map();
    for (const feed of prepared) {
      const previous = await snapshotImpl(feed.url, { probeImpl });
      snapshots.set(feed.name, normalizeCantonRssSnapshot(feed, previous));
    }

    fs.mkdirSync(distDir, { recursive: true });
    for (const feed of prepared) {
      if (typeof feed.xml !== 'string') continue;
      const local = path.join(distDir, `.canton-rss-${feed.name}`);
      fs.writeFileSync(local, feed.xml, 'utf8');
      localFiles.push(local);
    }

    if (removingStaleFeeds) {
      for (const feed of prepared) {
        await assertMainFreshImpl();
        mutationStarted = true;
        const { stdout = '' } = runImpl('bash', ['scripts/lib/delete-cdn-file.sh', feed.key]);
        if (!stdout.includes('✅ deleted')) throw new Error(`feed RSS non cancellato: ${feed.key}`);
      }
    } else {
      for (let i = 0; i < prepared.length; i++) {
        const feed = prepared[i];
        await assertMainFreshImpl();
        mutationStarted = true;
        const { stdout } = runImpl('bash', [
          'scripts/lib/upload-cdn-file.sh',
          localFiles[i],
          feed.key,
          PAGE_CACHE_CONTROL,
        ]);
        if (!stdout.includes('✅ uploaded')) {
          throw new Error(`feed RSS non caricato: ${feed.key}`);
        }
        uploaded++;
      }
    }

    for (const chunk of purgeChunks(prepared.map((feed) => feed.url))) {
      await assertMainFreshImpl();
      mutationStarted = true;
      const { code } = runImpl('bash', ['scripts/ci/retry-cmd.sh', 'node', 'scripts/cf-purge-cache.mjs', `--files=${chunk.join(',')}`]);
      if (code !== 0) {
        throw new Error(`purge CDN dei feed RSS ${section} fallito`);
      }
    }

    for (const feed of prepared) {
      if (removingStaleFeeds) {
        const result = await probeImpl(feed.url, { attempts: 3, delayMs: 1000, want: () => false });
        if (result?.ok === true || !isNotFoundStatus(result?.status)) {
          throw new Error(`feed RSS ancora servito sul CDN: ${feed.url} (${result?.status ?? 'nessuna risposta'})`);
        }
      } else {
        const result = await probeImpl(feed.url, { want: (body) => body === feed.xml });
        if (!result.ok) {
          throw new Error(`feed RSS non verificato sul CDN: ${feed.url} (${result.status})`);
        }
      }
      verified++;
    }
    let rolledBack = false;
    return {
      failures: 0,
      uploaded,
      verified,
      deleted: removingStaleFeeds ? prepared.length : 0,
      feeds: removingStaleFeeds ? [] : prepared.map(({ name, key, url }) => ({ name, key, url })),
      rollback: async ({ neutralize = false } = {}) => {
        if (rolledBack) return { failures: 0 };
        rolledBack = true;
        return rollbackCantonRssFeeds({ prepared, snapshots, distDir, runImpl, probeImpl, neutralize });
      },
    };
  } catch (error) {
    let rollbackFailures = 0;
    if (mutationStarted && snapshots?.size === prepared.length && prepared.length > 0) {
      rollbackFailures = (await rollbackCantonRssFeeds({
        prepared,
        snapshots,
        distDir,
        runImpl,
        probeImpl,
      })).failures;
    }
    console.error(`::error::[${LOG}] feed RSS ${section}: ${error?.message ?? String(error)}`);
    if (rollbackFailures > 0) {
      console.error(`::error::[${LOG}] rollback feed RSS ${section} incompleto (${rollbackFailures} fallimenti)`);
    }
    return { failures: 1 + rollbackFailures, uploaded: 0, verified: 0, rollbackFailures };
  } finally {
    for (const local of localFiles) fs.rmSync(local, { force: true });
  }
}

/**
 * Aspetta il flip coordinato di API e edge prima di cancellare URL ritirate.
 * Il workflow puo' ritentare l'intero publisher, ma quel retry da solo non
 * basta: ogni tentativo deve concedere alla pubblicazione API una finestra
 * bounded, altrimenti una gara transitoria lascia per sempre chiavi obsolete
 * fuori dalla sitemap e quindi invisibili al reconcile.
 */
export async function waitForPublishedReleaseReady(
  expectedCommit,
  {
    section,
    fetchImpl = fetch,
    releaseReadyImpl = publishedReleaseReady,
    sleepImpl = sleep,
    maxWaitMs = RELEASE_READY_MAX_WAIT_MS,
    retryDelayMs = RELEASE_READY_RETRY_DELAY_MS,
  } = {},
) {
  const deadline = Date.now() + Math.max(0, maxWaitMs);
  let last = { ok: false, reason: 'verifica release non eseguita' };
  while (true) {
    last = await releaseReadyImpl(expectedCommit, { section, fetchImpl });
    if (last === true || last?.ok) return last;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return last;
    await sleepImpl(Math.min(Math.max(0, retryDelayMs), remaining));
  }
}

/**
 * I dati hub mancanti sono tollerabili solo mentre il Worker serve certamente
 * la sezione come draft. In publish il registro edge e' la fonte effettiva;
 * in dry-run non si fa rete e si usa il registro committato come guardia.
 */
export function hubMissingIsFatal({ declaredStatus, effectiveStatus, publishing }) {
  return (publishing ? effectiveStatus : declaredStatus) === 'live';
}

export async function publish({
  pages,
  cdnUploads,
  cantonRssFeeds = [],
  removeStaleCantonRssFeeds = false,
  obsoletePages,
  distDir,
  section,
  releaseCommit = null,
  runImpl = run,
  publishedStatusImpl = publishedStatus,
  probeImpl = probe,
  releaseReadyImpl = publishedReleaseReady,
  publishCantonRssFeedsImpl = publishCantonRssFeeds,
  releaseReadyMaxWaitMs = RELEASE_READY_MAX_WAIT_MS,
  releaseReadyRetryDelayMs = RELEASE_READY_RETRY_DELAY_MS,
  sleepImpl = sleep,
  assertMainFreshImpl = async () => {},
}) {
  let failures = 0;
  let verifiedRssFeeds = cantonRssFeeds;
  let rollbackRssPublication = null;
  let pageSnapshots = null;
  const rollbackRss = async ({ neutralize = false } = {}) => {
    if (!rollbackRssPublication) return 0;
    const rollback = rollbackRssPublication;
    rollbackRssPublication = null;
    try {
      const result = await rollback({ neutralize });
      return Number.isSafeInteger(result?.failures) ? result.failures : 1;
    } catch (error) {
      console.error(
        `::error::[${LOG}] ${neutralize ? 'neutralizzazione' : 'rollback'} della release RSS fallita: ${error?.message ?? String(error)}`,
      );
      return 1;
    }
  };
  const deleted = [];
  // A missing or malformed edge registry is UNKNOWN, not draft. Do not upload
  // into that state: otherwise the CDN verify below can be green while a live
  // apex still serves stale/404 pages. A valid draft is the bootstrap case.
  const beforeStatus = await publishedStatusImpl(section);
  if (beforeStatus === null) {
    console.error(`::error::[${LOG}] registro edge della sezione ${section} illeggibile o con stato sconosciuto: pubblicazione bloccata`);
    return { failures: 1, uploaded: 0, status: null };
  }
  const rollbackPages = async () => {
    if (!pageSnapshots) return 0;
    const snapshots = pageSnapshots;
    pageSnapshots = null;
    try {
      const result = await rollbackCantonPages({
        pages,
        snapshots,
        distDir,
        runImpl,
        probeImpl,
        live: beforeStatus === 'live',
      });
      return Number.isSafeInteger(result?.failures) ? result.failures : 1;
    } catch (error) {
      console.error(`::error::[${LOG}] rollback della release HTML fallito: ${error?.message ?? String(error)}`);
      return 1;
    }
  };
  const rollbackTransaction = async () => {
    const pageFailures = await rollbackPages();
    const rssFailures = await rollbackRss({ neutralize: pageFailures > 0 });
    if (pageFailures > 0) {
      console.error(
        rssFailures === 0
          ? `::error::[${LOG}] HTML precedente non completamente ripristinato: feed RSS neutralizzati e verificati come assenti`
          : `::error::[${LOG}] HTML precedente non completamente ripristinato e neutralizzazione RSS fallita (${rssFailures} errore/i)`,
      );
    }
    return pageFailures + rssFailures;
  };
  // Dopo la cancellazione di almeno una pagina precedente non si può
  // ripristinare la release HTML precedente: quelle pagine potrebbero essere
  // proprio le URL già rimosse. Il run resta rosso e il retry/reconcile
  // riparte dalla release corrente, che resta coerente col feed RSS corrente.
  const rollbackRssAfterObsoleteMutation = async () => {
    if (deleted.length > 0) {
      console.error(`::error::[${LOG}] rollback RSS saltato: ${deleted.length} pagina/e obsoleta/e sono state cancellate; la release HTML corrente resta servita per il retry`);
      return 0;
    }
    const pageFailures = await rollbackPages();
    const rssFailures = await rollbackRss({ neutralize: pageFailures > 0 });
    if (pageFailures > 0) {
      console.error(
        rssFailures === 0
          ? `::error::[${LOG}] HTML precedente non completamente ripristinato: feed RSS neutralizzati e verificati come assenti`
          : `::error::[${LOG}] HTML precedente non completamente ripristinato e neutralizzazione RSS fallita (${rssFailures} errore/i)`,
      );
    }
    return pageFailures + rssFailures;
  };
  const uploaded = [];
  let status = beforeStatus;
  console.log(`[${LOG}] preflight: sezione ${section} nel registro pubblicato = ${beforeStatus}`);
  // This is the first remote mutation after render/preflight. Recheck here,
  // not only in the workflow before rendering: main may advance while pages
  // and feeds are being built.
  await assertMainFreshImpl();
  for (const { local, key } of cdnUploads) {
    const { stdout } = runImpl('bash', ['scripts/lib/upload-cdn-file.sh', local, key]);
    if (!stdout.includes('✅ uploaded')) {
      failures++;
      console.log(`::warning::[${LOG}] immagine non caricata: ${key}`);
    }
  }
  // Un HTML che punta a un hero non ancora confermato e' una pubblicazione
  // parziale: il reconcile controlla la pagina, non ogni asset CDN. Lasciare
  // partire gli upload delle pagine qui renderebbe quindi servibile un nuovo
  // canonical con immagine 404. Gli articoli gia' presenti restano intatti e
  // il run rosso verra' ripreso dal fast-publish/reconcile successivo.
  if (failures) {
    console.error(`::error::[${LOG}] upload hero incompleto: nessuna pagina HTML viene caricata`);
    return { failures, uploaded: 0, deleted: 0, status: beforeStatus };
  }
  try {
  if (cantonRssFeeds.length > 0 || removeStaleCantonRssFeeds) {
    const rssStatus = await publishedStatusImpl(section);
    if (rssStatus !== 'live' && !removeStaleCantonRssFeeds) {
      console.error(`::error::[${LOG}] feed RSS ${section}: il registro edge non conferma lo stato live subito prima della pubblicazione`);
      return { failures: 1, uploaded: 0, deleted: 0, status: rssStatus };
    }
    // The RSS phase has its own guards, but check at the phase boundary too:
    // the release may have become stale while the edge status was read.
    await assertMainFreshImpl();
    const rssResult = await publishCantonRssFeedsImpl({
      section,
      releaseCommit,
      feedEntries: cantonRssFeeds,
      effectiveStatus: rssStatus,
      removeStaleCantonRssFeeds,
      distDir,
      runImpl,
      probeImpl,
      releaseReadyImpl,
      publishedStatusImpl,
      sleepImpl,
      releaseReadyMaxWaitMs,
      releaseReadyRetryDelayMs,
      assertMainFreshImpl,
    });
    if (rssResult.failures > 0) {
      console.error(`::error::[${LOG}] feed RSS ${section} non verificati: nessuna pagina viene caricata`);
      return { failures: rssResult.failures, uploaded: 0, deleted: 0, status: rssResult.status ?? rssStatus };
    }
    if (Array.isArray(rssResult.feeds)) verifiedRssFeeds = rssResult.feeds;
    if (Array.isArray(rssResult.feeds) && rssResult.feeds.length === 0) {
      for (const page of pages.filter(({ kind }) => kind === 'landing')) {
        const local = path.join(distDir, page.rel);
        if (!fs.existsSync(local)) continue;
        const html = fs.readFileSync(local, 'utf-8');
        const withoutRss = removeCantonRssFeedLinks(html);
        if (withoutRss !== html) fs.writeFileSync(local, withoutRss, 'utf-8');
      }
    }
    if (typeof rssResult.rollback === 'function') {
      rollbackRssPublication = rssResult.rollback;
      try {
        pageSnapshots = await snapshotCantonPages(pages, { probeImpl });
      } catch (error) {
        console.error(`::error::[${LOG}] snapshot della release HTML precedente fallito: ${error?.message ?? String(error)}`);
        const rollbackFailures = await rollbackTransaction();
        return { failures: 1 + rollbackFailures, rollbackFailures, uploaded: 0, deleted: 0, status: beforeStatus };
      }
    }
  }
  for (const page of inUploadOrder(pages)) {
    await assertMainFreshImpl();
    const { stdout } = runImpl('bash', ['scripts/lib/upload-cdn-file.sh', path.join(distDir, page.rel), page.edgeKey, PAGE_CACHE_CONTROL]);
    if (stdout.includes('✅ uploaded')) uploaded.push(page);
    else {
      failures++;
      console.log(`::error::[${LOG}] pagina non caricata: ${page.edgeKey}`);
    }
  }

  // Non cancellare URL della release precedente finche' la nuova release non
  // e' stata caricata, purgata e letta. Durante il normale interleaving con
  // publish-api una sitemap precedente puo' ancora annunciare quelle URL: una
  // failure parziale qui deve lasciare intatta la superficie vecchia.
  if (failures) {
    console.error(`::error::[${LOG}] upload HTML incompleto: nessuna pagina obsoleta viene cancellata`);
    const rollbackFailures = await rollbackTransaction();
    return { failures: failures + rollbackFailures, rollbackFailures, uploaded: uploaded.length, deleted: 0, status: beforeStatus };
  }

  const purgePages = async (pageList) => {
    if (pageList.length === 0) return;
    const urls = pageList.flatMap((page) => [page.apexUrl, page.cdnUrl]);
    for (const chunk of purgeChunks(urls)) {
      await assertMainFreshImpl();
      const { code } = runImpl('bash', ['scripts/ci/retry-cmd.sh', 'node', 'scripts/cf-purge-cache.mjs', `--files=${chunk.join(',')}`]);
      if (code !== 0) failures++;
    }
  };

  // Purge/verify only the current release first. Obsolete keys stay present
  // until this pass is green, so a stale sitemap never points at a 404 caused
  // by a partially published replacement.
  await purgePages(uploaded);
  status = await publishedStatusImpl(section);
  console.log(`[${LOG}] verify: sezione ${section} nel registro pubblicato = ${status ?? 'registro illeggibile'}`);
  if (status === null) {
    console.error(`::error::[${LOG}] registro edge della sezione ${section} diventato illeggibile durante la pubblicazione`);
    const rollbackFailures = await rollbackTransaction();
    return { failures: failures + 1 + rollbackFailures, rollbackFailures, uploaded: uploaded.length, deleted: 0, status: null };
  }
  if (status !== beforeStatus) {
    console.error(`::error::[${LOG}] stato edge della sezione ${section} cambiato durante la pubblicazione (${beforeStatus} → ${status})`);
    const rollbackFailures = await rollbackTransaction();
    return { failures: failures + 1 + rollbackFailures, rollbackFailures, uploaded: uploaded.length, deleted: 0, status };
  }
  const hasMeta = (body) => String(body ?? '').includes(CORPUS_ROUTE_OWNER_META_TAG);
  for (const page of uploaded) {
    const expectedRssUrl = page.kind === 'landing' ? cantonRssFeedUrlForLocale(section, page.locale) : null;
    const requiredRssUrl = expectedRssUrl && verifiedRssFeeds.some((feed) => feed?.url === expectedRssUrl)
      ? expectedRssUrl
      : null;
    const wantsPublishedPage = (body) => hasMeta(body)
      && (!requiredRssUrl || hasExpectedCantonRssFeedLinks(body, requiredRssUrl));
    const cdn = await probeImpl(page.cdnUrl, { want: wantsPublishedPage });
    if (!cdn.ok) {
      failures++;
      console.log(`::error::[${LOG}] non leggibile sul CDN: ${page.cdnUrl} (${cdn.status})`);
      continue;
    }
    if (status === 'live') {
      const apex = await probeImpl(page.apexUrl, { want: wantsPublishedPage });
      if (!apex.ok) {
        failures++;
        console.log(`::error::[${LOG}] non leggibile all'apex: ${page.apexUrl} (${apex.status})`);
      }
    }
  }

  if (failures) {
    console.error(`::error::[${LOG}] release corrente non verificata: nessuna pagina obsoleta viene cancellata`);
    const rollbackFailures = await rollbackTransaction();
    return { failures: failures + rollbackFailures, rollbackFailures, uploaded: uploaded.length, deleted: 0, status };
  }

  if (obsoletePages.length > 0) {
    const releaseReady = await waitForPublishedReleaseReady(releaseCommit, {
      section,
      releaseReadyImpl,
      sleepImpl,
      maxWaitMs: releaseReadyMaxWaitMs,
      retryDelayMs: releaseReadyRetryDelayMs,
    });
    if (!(releaseReady === true || releaseReady?.ok)) {
      console.error(`::error::[${LOG}] API/edge non hanno ancora servito la release corrente: ${releaseReady?.reason ?? 'verifica fallita'}; nessuna pagina obsoleta viene cancellata`);
      const rollbackFailures = await rollbackTransaction();
      return { failures: failures + 1 + rollbackFailures, rollbackFailures, uploaded: uploaded.length, deleted: 0, status };
    }
  }

  for (const page of obsoletePages) {
    await assertMainFreshImpl();
    const { stdout } = runImpl('bash', ['scripts/lib/delete-cdn-file.sh', page.edgeKey]);
    if (stdout.includes('✅ deleted')) deleted.push(page);
    else {
      failures++;
      console.log(`::error::[${LOG}] vecchia pagina non cancellata: ${page.edgeKey}`);
    }
  }
  // The current release was already served before the delete. Purge the old
  // keys only after successful delete requests, then retain the 404 verification.
  await purgePages(deleted);
  for (const page of obsoletePages) {
    const old = await probeImpl(page.cdnUrl, { attempts: 3, delayMs: 1000 });
    if (old.status !== 'HTTP 404') {
      failures++;
      console.log(`::error::[${LOG}] vecchia pagina ancora servita o non verificabile: ${page.cdnUrl} (${old.status})`);
    }
  }
  await assertMainFreshImpl();
  const rollbackFailures = failures > 0 ? await rollbackRssAfterObsoleteMutation() : 0;
  return { failures: failures + rollbackFailures, rollbackFailures, uploaded: uploaded.length, deleted: deleted.length, status };
  } catch (error) {
    console.error(`::error::[${LOG}] pubblicazione ${section} fallita: ${error?.message ?? String(error)}`);
    const rollbackFailures = await rollbackRssAfterObsoleteMutation();
    return { failures: 1 + rollbackFailures, rollbackFailures, uploaded: uploaded.length, deleted: 0, status };
  }
}

export async function main(
  argv = process.argv.slice(2),
  {
    parseArgsImpl = parseArgs,
    fetchPageManifestImpl = fetchPageManifest,
    publishedStatusImpl = publishedStatus,
    createRenderRootImpl = createRenderRoot,
    renderSectionArticlePipelineImpl = defaultRenderSectionArticlePipeline,
    articleReleaseSnapshotImpl = articleReleaseSnapshot,
    publishImpl = publish,
    publishCantonRssFeedsImpl = publishCantonRssFeeds,
    publishPageManifestImpl = publishPageManifest,
    publishedApiReleaseCommitImpl = publishedApiReleaseCommit,
    publishedReleaseReadyImpl = publishedReleaseReady,
    latestApiInputCommitImpl = latestApiInputCommit,
    currentMainHeadImpl = publishedMainHead,
    fetchImpl = fetch,
  } = {},
) {
  const t0 = Date.now();
  const args = parseArgsImpl(argv);
  const section = args.section;
  const distDir = path.resolve(args.out);
  fs.mkdirSync(distDir, { recursive: true });
  const ids = args.bootstrap ? sourceRegistryIds(ROOT_DIR, section) : args.ids;
  const publishing = args.publish && !args.dryRun;
  const publisherCommit = publishing
    ? execFileSync('git', ['-C', ROOT_DIR, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    : null;
  const expectedMainHead = process.env.EXPECTED_MAIN_HEAD || publisherCommit;
  const assertMainFreshImpl = async () => {
    if (!publishing) return;
    await assertExpectedMainHead(expectedMainHead, currentMainHeadImpl);
  };
  let releaseCommit = publisherCommit;
  let publishedManifest = { state: 'absent' };
  let publishedManifestPages = null;
  if (publishing) {
    publishedManifest = await fetchPageManifestImpl(pageManifestUrl(section, CDN_BASE), { section });
    if (publishedManifest.state === 'ok') {
      try {
        publishedManifestPages = Object.fromEntries(
          PAGE_MANIFEST_KINDS.map((kind) => [kind, manifestPageEntries(section, publishedManifest.doc, kind)]),
        );
      } catch (error) {
        publishedManifest = { state: 'unknown', reason: error?.message ?? String(error) };
      }
    }
    if (publishedManifest.state === 'absent') {
      console.log(
        `::warning::[${LOG}] manifest edge ${section} assente: uso il commit precedente solo per la migrazione`,
      );
    }
  }
  // Il manifest è la fonte normale. Il commit precedente resta solo un ponte
  // per la prima run dopo il deploy del fix, quando il manifest non esisteva.
  const previousArticlePages = publishedManifestPages?.article
    ?? (publishedManifest.state === 'absent' ? previousArticleReleasePages(ROOT_DIR, section, args.previousRevision) : []);
  const previousArchivePages = publishedManifestPages?.archive
    ?? (publishedManifest.state === 'absent' ? previousArchiveReleasePages(ROOT_DIR, section, args.previousRevision) : []);
  // Preflight the same registry the Worker serves before deciding whether a
  // partial hub set is merely a draft refresh or a live-page defect. A draft
  // checkout must not override an edge registry that is still live.
  const effectiveStatus = publishing ? await publishedStatusImpl(section) : null;
  const cleanupRssRequested = args.removeStaleCantonRssFeeds === true;
  if (publishing && (effectiveStatus === 'live' || cleanupRssRequested)) {
    releaseCommit = await resolvePublishedReleaseCommit(publisherCommit, {
      apiReleaseCommitImpl: publishedApiReleaseCommitImpl,
      apiReleaseCommitOverride: process.env.API_RELEASE_COMMIT,
      latestApiInputCommitImpl,
      pushBefore: process.env.PUSH_BEFORE,
      pushAfter: process.env.PUSH_AFTER || publisherCommit,
      fetchImpl,
    });
    if (releaseCommit !== publisherCommit) {
      console.log(
        `::notice::[${LOG}] uso la release API verificata ${releaseCommit} invece di HEAD ${publisherCommit}`,
      );
    }
  }
  let cantonRssFeeds = [];
  let removeStaleCantonRssFeeds = false;
  if (publishing && (effectiveStatus === 'live' || cleanupRssRequested)) {
    const readiness = await publishedReleaseReadyImpl(releaseCommit, { section, fetchImpl });
    // Se la readiness è transitoria, mantieni il gate fail-closed completo e
    // lascia che publishCantonRssFeeds ritenti. Quando è verificata, invece,
    // il set dichiarato dal manifest decide anche se la landing può annunciare
    // RSS: una sezione live senza articoli emette zero feed legittimamente.
    if (readiness === true || readiness?.ok) {
      const declaredFeeds = readiness?.files
        ? cantonRssFeedsDeclaredInManifest(section, readiness.files, readiness.counts)
        : cantonRssFeedEntries(section);
      cantonRssFeeds = cleanupRssRequested ? [] : declaredFeeds;
      removeStaleCantonRssFeeds = cleanupRssRequested || cantonRssFeeds.length === 0;
    } else {
      cantonRssFeeds = effectiveStatus === 'live' && !cleanupRssRequested ? cantonRssFeedEntries(section) : [];
      removeStaleCantonRssFeeds = cleanupRssRequested;
    }
  }

  let hubs = { rels: [], pages: [], missing: [] };
  let landingPages = [];
  const renderSectionArticlePipeline = renderSectionArticlePipelineImpl;
  const renderRoot = createRenderRootImpl(ROOT_DIR, process.env.RUNNER_TEMP || os.tmpdir());
  const {
    entries,
    hubResult,
    downloadedImageKeys,
    imageFetchFailures,
    imagePostcondition,
    aggregatePagesAllowed,
  } = await renderSectionArticlePipeline({
    rootDir: renderRoot,
    distDir,
    section,
    ids,
    logPrefix: LOG,
    beforeOffload: async ({ hubResult: archive, releasedArticles }) => {
      for (const rel of CANTON_HUB_LOCALES.flatMap((loc) => archive.pathsByLocale[loc] ?? [])) {
        const abs = path.join(distDir, rel);
        const html = fs.readFileSync(abs, 'utf-8');
        const owned = ensureRouteOwnerMeta(html);
        if (owned !== html) fs.writeFileSync(abs, owned, 'utf-8');
      }
      hubs = await renderHubs({ section, distDir });
      const { renderCantonSectionLandingPages } = await import('../engine/cantonSectionPages.ts');
      const landings = await renderCantonSectionLandingPages({ rootDir: renderRoot, section });
      landingPages = landings.map((page) => ({
        ...page,
        html: cantonRssFeeds.length > 0
          ? addCantonRssFeedLink(
            rewriteGenericImageRefs(page.html, releasedArticles),
            cantonRssFeedUrlForLocale(section, pageEntry(section, page.relPath, 'landing').locale),
          )
          : rewriteGenericImageRefs(page.html, releasedArticles),
      }));
      for (const page of landingPages) writePage(distDir, page.relPath, page.html);
      return [...hubs.rels, ...landingPages.map((page) => page.relPath)];
    },
  });

  const rssFeedsForPublish = cantonRssFeedsForPublish(section, {
    publishing,
    effectiveStatus,
    aggregatePagesAllowed,
    availableFeeds: cantonRssFeeds,
  });
  if (rssFeedsForPublish.length === 0 && cantonRssFeeds.length > 0) {
    console.log(`::notice::[${LOG}] feed RSS ${section} trattenuti: aggregatePagesAllowed=false`);
  }
  cantonRssFeeds = rssFeedsForPublish;
  // Una demozione/kill-switch rende invisibile la superficie HTML al Worker:
  // il cleanup dei feed obsoleti non deve restare ostaggio del verdetto
  // aggregati, che protegge invece la coerenza di una sezione ancora live.
  removeStaleCantonRssFeeds = removeStaleCantonRssFeeds
    && (aggregatePagesAllowed === true || effectiveStatus !== 'live');

  fs.rmSync(renderRoot, { recursive: true, force: true });

  const currentArticlePages = articleReleaseSnapshotImpl(ROOT_DIR, section);
  const pages = [
    ...entries.flatMap((entry) => CANTON_HUB_LOCALES.map((loc) => entry.paths[loc]).filter(Boolean).map((rel) => ({
      ...pageEntry(section, rel, 'article'),
      id: String(entry.articleId),
    }))),
    ...CANTON_HUB_LOCALES.flatMap((loc) => hubResult.pathsByLocale[loc] ?? []).map((rel) => pageEntry(section, rel, 'archive')),
    ...hubs.pages.map((page) => rendererPageEntry(section, page, 'hub')),
    ...landingPages.map((page) => rendererPageEntry(section, page, 'landing')),
  ];
  const currentArchivePages = pages.filter((page) => page.kind === 'archive');
  // `publish()` writes the manifest only when every page in `pages` has been
  // uploaded, purged and read back successfully; this is therefore the
  // verified upload set used by both deletion and the next inventory.
  const verifiedArticlePages = pages.filter((page) => page.kind === 'article');
  const renderedIds = [...new Set(entries.map((entry) => String(entry.articleId)).filter(Boolean))];
  const missingArticleIds = missingRenderedArticleIds(ids, entries);
  const obsoletePages = obsoleteReleasePages({
    previousArticlePages,
    currentArticlePages,
    verifiedArticlePages,
    previousArchivePages,
    currentArchivePages,
    aggregatePagesAllowed,
  });

  const defects = [];
  if (publishing && effectiveStatus === null) {
    defects.push('registro edge illeggibile o non valido: stato effettivo della sezione non dimostrato');
  }
  if (publishing && publishedManifest.state === 'unknown') {
    defects.push(
      `manifest edge ${section} non verificabile (${publishedManifest.reason ?? 'errore sconosciuto'}): ` +
      'pubblicazione bloccata per non calcolare cancellazioni dal parent del push',
    );
  }
  for (const page of pages) {
    const abs = path.join(distDir, page.rel);
    const html = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf-8') : '';
    const requiredRssUrl = page.kind === 'landing' && cantonRssFeeds.length > 0
      ? cantonRssFeedUrlForLocale(section, page.locale)
      : null;
    for (const defect of pageDefects(page, html, { requiredRssUrl })) defects.push(`${page.rel}: ${defect}`);
  }
  if (missingArticleIds.length) {
    defects.push(`articoli richiesti non resi dalla pipeline: ${missingArticleIds.join(', ')}`);
  }
  defects.push(...aggregatePageDefects(pages, { aggregatePagesAllowed }));

  // Una sezione dichiarata live deve avere tutti e sei gli hub (lo stesso
  // vincolo che build-api applica al registro): qui si ripete perche' questo
  // script puo' girare su un commit che il publish dell'API non ha ancora visto.
  const declared = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, SECTION_REGISTRY_FILE), 'utf8')).sections?.[section]?.status;
  if (hubs.missing.length) {
    const note = `hub senza dati, non pubblicati: ${hubs.missing.join(', ')} (${hubs.missing.map((t) => cantonHubDataFile(section, t)).join(', ')})`;
    if (hubMissingIsFatal({ declaredStatus: declared, effectiveStatus, publishing })) defects.push(`sezione live con ${note}`);
    else console.log(`::warning::[${LOG}] ${note} — la sezione deve restare draft finche' mancano`);
  }

  const missingHeroAssets = [];
  const cdnUploads = heroCdnUploads({
    rootDir: ROOT_DIR,
    entries,
    htmlPages: landingPages,
    missing: missingHeroAssets,
    logPrefix: LOG,
    downloadedImageKeys,
  });
  for (const missing of new Map(missingHeroAssets.map((asset) => [asset.key, asset])).values()) {
    defects.push(`hero landing/articolo non disponibile per l'upload: ${missing.local}`);
  }
  const countsByLocale = Object.fromEntries(
    CANTON_HUB_LOCALES.map((locale) => [locale, pages.filter((page) => page.locale === locale).length]),
  );
  const summary = {
    section,
    declaredStatus: declared ?? null,
    bootstrap: args.bootstrap,
    ids,
    requestedIds: [...new Set(ids)],
    renderedIds,
    counts: Object.fromEntries(UPLOAD_ORDER.map((kind) => [kind, pages.filter((page) => page.kind === kind).length])),
    countsByLocale,
    hubsMissing: hubs.missing,
    missingHeroAssets,
    imageFetchFailures,
    imagePostcondition,
    aggregatePagesAllowed,
    publishedPageManifest: publishedManifest.state,
    effectiveStatus,
    cantonRssFeeds: cantonRssFeeds.map(({ name, key, url }) => ({ name, key, url })),
    pages,
    cdnUploads,
    obsoletePages,
    defects,
    published: null,
  };
  const writeSummary = () => {
    fs.mkdirSync(path.dirname(path.resolve(args.summary)), { recursive: true });
    fs.writeFileSync(path.resolve(args.summary), `${JSON.stringify(summary, null, 2)}\n`, 'utf-8');
  };

  if (defects.length) {
    writeSummary();
    for (const defect of defects) console.log(`::error::[${LOG}] ${defect}`);
    console.error(`[${LOG}] ${defects.length} difetti: niente viene pubblicato`);
    return 1;
  }
  console.log(
    `[${LOG}] ${section}: ${pages.length} pagine rese (${Object.entries(summary.counts).map(([k, n]) => `${k}=${n}`).join(', ')}), ` +
      `${cdnUploads.length} immagini, locali=${Object.entries(countsByLocale).map(([locale, count]) => `${locale}:${count}`).join(',')}, ` +
      `${((Date.now() - t0) / 1000).toFixed(1)}s`,
  );

  if (args.dryRun || !args.publish) {
    writeSummary();
    console.log(`[${LOG}] dry-run: nessun upload. Summary: ${args.summary}`);
    return 0;
  }
  const migrationManifest = !publishedManifestPages && publishedManifest.state === 'absent'
    ? pageManifestFromPages({
      section,
      commit: releaseCommit,
      pages: migrationManifestPages(section, previousArticlePages, previousArchivePages),
    })
    : null;
  if (migrationManifest) {
    await assertMainFreshImpl();
    const seeded = publishPageManifestImpl({ manifest: migrationManifest, distDir });
    summary.migrationManifestSeeded = seeded;
    if (!seeded) {
      summary.published = { failures: 1, uploaded: 0, deleted: 0, status: null, manifestSeeded: false };
      console.error(`::error::[${LOG}] checkpoint manifest edge ${section} non confermato: nessuna pagina viene pubblicata`);
      writeSummary();
      return 1;
    }
  }
  summary.published = await publishImpl({
    pages,
    cdnUploads,
    cantonRssFeeds,
    removeStaleCantonRssFeeds,
    obsoletePages,
    distDir,
    section,
    releaseCommit,
    publishCantonRssFeedsImpl,
    assertMainFreshImpl,
  });
  if (summary.published.failures === 0) {
    const manifestPages = aggregatePagesAllowed
      ? [
        ...articleManifestPages({
          section,
          previousArticlePages,
          currentArticlePages,
          verifiedArticlePages,
        }),
        ...pages.filter((page) => page.kind !== 'article'),
      ]
      : verifiedArticlePages;
    const currentManifest = pageManifestFromPages({ section, commit: releaseCommit, pages: manifestPages });
    const nextManifest = aggregatePagesAllowed
      ? currentManifest
      : publishedManifestPages
        ? mergePageManifests(publishedManifest.doc, currentManifest)
        : mergePageManifests(migrationManifest, currentManifest);
    await assertMainFreshImpl();
    const manifestPublished = publishPageManifestImpl({ manifest: nextManifest, distDir });
    summary.published.manifestPublished = manifestPublished;
    if (!manifestPublished) {
      summary.published.failures++;
      console.error(`::error::[${LOG}] manifest edge ${section} non confermato: il prossimo giro deve conservare il manifest precedente`);
    }
  }
  writeSummary();
  console.log(`[${LOG}] pubblicate ${summary.published.uploaded}/${pages.length} pagine, ${summary.published.failures} fallimenti`);
  return summary.published.failures ? 1 : 0;
}

const invokedDirectly = (() => {
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1] || '');
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(`::error::[${LOG}] ${error?.message ?? error}`);
      process.exitCode = 1;
    },
  );
}
