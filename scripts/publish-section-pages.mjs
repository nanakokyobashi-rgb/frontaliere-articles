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
 * Esce 1 se una pagina non passa la validazione, se un upload non e'
 * confermato o se il verify fallisce.
 */
import '../host/cantonSectionsBootstrap.mjs';
import fs, { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { ARTICLE_SECTION_CORE_ALL } from '../engine/shared/articleSectionCore.mjs';
import { ARTICLES_PAGE_SIZE } from '../engine/shared/articleArchiveConfig.mjs';
import { CANTON_ARCHIVE_ALL_SLUG } from '../engine/shared/cantonSectionCopy.mjs';
import { parseArticleUrlSlugs } from '../engine/shared/articleReaderSource.mjs';
import { CORPUS_ROUTE_OWNER_META_TAG } from '../engine/shared/corpusRouteOwner.mjs';
import { CDN_BASE, heroCdnUploads, renderSectionArticlePipeline } from './lib/article-render-pipeline.mjs';
import { CANTON_HUB_LOCALES, cantonHubDataFile, cantonHubTopics, readCantonHubData } from './lib/canton-hub-data.mjs';
import { sourceRegistryIds } from './lib/corpus-floors.mjs';
import { createEngineCorpusView } from './lib/engine-corpus-view.mjs';
import { sanitizeHtmlDocument } from './lib/sanitize-control-chars.mjs';
import { reportStrippedControlChars } from '../generator/scripts/lib/control-char-write-report.mjs';
import { activeCorpusCoreMap, sectionSourceSurfaces } from './lib/corpus-sections.mjs';
import { EDGE_SECTION_REGISTRY_FILE, SECTION_REGISTRY_FILE, sectionRoutes, validateEdgeSectionRegistry } from './lib/section-registry.mjs';
import { purgeChunks } from './publish-section-edge.mjs';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOG = 'publish-section-pages';
export const APEX = 'https://frontaliereticino.ch';
export const EDGE_PREFIX = 'edge/sections';
export const API_BASE = 'https://nanakokyobashi-rgb.github.io/frontaliere-articles';
/** Le pagine si riscrivono a ogni publish e il Worker le tiene 5 min: stessa classe delle sitemap. */
export const PAGE_CACHE_CONTROL = 'public,max-age=600';
/** Dopo il deploy API la superficie pubblica puo' arrivare in ritardo: la delete attende, ma con un limite. */
export const RELEASE_READY_MAX_WAIT_MS = 120_000;
export const RELEASE_READY_RETRY_DELAY_MS = 10_000;
/** Ordine di upload: la landing per ultima, perche' linka tutto il resto. */
export const UPLOAD_ORDER = Object.freeze(['article', 'archive', 'hub', 'landing']);

export function parseArgs(argv, { all = ARTICLE_SECTION_CORE_ALL, active = activeCorpusCoreMap() } = {}) {
  const out = { ids: [], bootstrap: false, publish: false, dryRun: false };
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
export function pageEntry(section, rel, kind) {
  if (!rel.endsWith('/index.html')) throw new Error(`pagina non canonica (attesa …/index.html): ${rel}`);
  const canonicalPath = `/${rel.slice(0, -'index.html'.length)}`;
  const route = sectionRoutes(section).find((r) => canonicalPath === `${r.prefix}/` || canonicalPath.startsWith(`${r.prefix}/`));
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

const RELEASE_LOCALES = Object.freeze(['it', 'en', 'de', 'fr']);
const REGISTRY_ID_RE = /^\s*id:\s*(?:'([^']+)'|"([^"]+)")/gm;
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function releaseRegistryIds(source, rel) {
  const ids = [...source.matchAll(REGISTRY_ID_RE)].map((match) => match[1] ?? match[2]);
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
  const routes = new Map(sectionRoutes(section).map((route) => [route.locale, route]));
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
export function obsoleteArticlePages(previousPages, currentPages) {
  const current = new Set(currentPages.map((page) => page.canonicalPath));
  return previousPages.filter((page) => !current.has(page.canonicalPath));
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
  const routes = new Map(sectionRoutes(section).map((route) => [route.locale, route]));
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
export function pageDefects(page, html) {
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
  previousArchivePages,
  currentArchivePages,
  aggregatePagesAllowed,
}) {
  if (typeof aggregatePagesAllowed !== 'boolean') throw new Error('aggregatePagesAllowed deve essere booleano');
  if (!aggregatePagesAllowed) return [];
  return [
    ...obsoleteArticlePages(previousArticlePages, currentArticlePages),
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
        page = renderCantonTopicHub({ keyFacts: [], dataBlocks: [], curatedArticles: [], links: [], ...data[locale], canton, topic, locale });
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** GET con cache-buster, ritentata: una pagina appena caricata puo' metterci qualche secondo. */
async function probe(url, { attempts = 6, delayMs = 4000, want = () => true } = {}) {
  let last = 'nessuna risposta';
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(`${url}${url.includes('?') ? '&' : '?'}_spcb=${Date.now()}.${i}`, {
        redirect: 'manual',
        headers: { 'user-agent': 'frontaliere-corpus-publisher/1 (+https://frontaliereticino.ch)' },
        signal: AbortSignal.timeout(20000),
      });
      const body = res.status === 200 ? await res.text() : '';
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
    return status === 'live' || status === 'draft' ? status : null;
  } catch {
    return null;
  }
}

async function fetchJsonAt(url, fetchImpl) {
  try {
    const res = await fetchImpl(`${url}${url.includes('?') ? '&' : '?'}_sppr=${Date.now()}`, {
      headers: { 'user-agent': 'frontaliere-section-pages/1 (+https://frontaliereticino.ch)' },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * La delete delle URL ritirate e' sicura solo dopo il flip della stessa
 * release che ha aggiornato sitemap e slug. `publish-api` e fast-publish
 * partono dallo stesso push, quindi la verifica locale dei nuovi HTML non
 * basta: attendiamo manifest, catalogo, slugs e puntatore edge sul commit
 * corrente. Se uno e' ancora vecchio, il run fallisce senza cancellare; il
 * retry del workflow ripete la prova dopo il deploy API.
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
  return { ok: true, commit: expectedCommit };
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
    releaseReadyImpl = publishedReleaseReady,
    sleepImpl = sleep,
    maxWaitMs = RELEASE_READY_MAX_WAIT_MS,
    retryDelayMs = RELEASE_READY_RETRY_DELAY_MS,
  } = {},
) {
  const deadline = Date.now() + Math.max(0, maxWaitMs);
  let last = { ok: false, reason: 'verifica release non eseguita' };
  while (true) {
    last = await releaseReadyImpl(expectedCommit, { section });
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
  obsoletePages,
  distDir,
  section,
  releaseCommit = null,
  runImpl = run,
  publishedStatusImpl = publishedStatus,
  probeImpl = probe,
  releaseReadyImpl = publishedReleaseReady,
  releaseReadyMaxWaitMs = RELEASE_READY_MAX_WAIT_MS,
  releaseReadyRetryDelayMs = RELEASE_READY_RETRY_DELAY_MS,
  sleepImpl = sleep,
}) {
  let failures = 0;
  // A missing or malformed edge registry is UNKNOWN, not draft. Do not upload
  // into that state: otherwise the CDN verify below can be green while a live
  // apex still serves stale/404 pages. A valid draft is the bootstrap case.
  const beforeStatus = await publishedStatusImpl(section);
  if (beforeStatus === null) {
    console.error(`::error::[${LOG}] registro edge della sezione ${section} illeggibile o con stato sconosciuto: pubblicazione bloccata`);
    return { failures: 1, uploaded: 0, status: null };
  }
  console.log(`[${LOG}] preflight: sezione ${section} nel registro pubblicato = ${beforeStatus}`);
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
  const uploaded = [];
  for (const page of inUploadOrder(pages)) {
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
    return { failures, uploaded: uploaded.length, deleted: 0, status: beforeStatus };
  }

  const purgePages = (pageList) => {
    if (pageList.length === 0) return;
    const urls = pageList.flatMap((page) => [page.apexUrl, page.cdnUrl]);
    for (const chunk of purgeChunks(urls)) {
      const { code } = runImpl('bash', ['scripts/ci/retry-cmd.sh', 'node', 'scripts/cf-purge-cache.mjs', `--files=${chunk.join(',')}`]);
      if (code !== 0) failures++;
    }
  };

  // Purge/verify only the current release first. Obsolete keys stay present
  // until this pass is green, so a stale sitemap never points at a 404 caused
  // by a partially published replacement.
  purgePages(uploaded);
  const status = await publishedStatusImpl(section);
  console.log(`[${LOG}] verify: sezione ${section} nel registro pubblicato = ${status ?? 'registro illeggibile'}`);
  if (status === null) {
    console.error(`::error::[${LOG}] registro edge della sezione ${section} diventato illeggibile durante la pubblicazione`);
    return { failures: failures + 1, uploaded: uploaded.length, deleted: 0, status: null };
  }
  const hasMeta = (body) => body.includes(CORPUS_ROUTE_OWNER_META_TAG);
  for (const page of uploaded) {
    const cdn = await probeImpl(page.cdnUrl, { want: hasMeta });
    if (!cdn.ok) {
      failures++;
      console.log(`::error::[${LOG}] non leggibile sul CDN: ${page.cdnUrl} (${cdn.status})`);
      continue;
    }
    if (status === 'live') {
      const apex = await probeImpl(page.apexUrl, { want: hasMeta });
      if (!apex.ok) {
        failures++;
        console.log(`::error::[${LOG}] non leggibile all'apex: ${page.apexUrl} (${apex.status})`);
      }
    }
  }

  if (failures) {
    console.error(`::error::[${LOG}] release corrente non verificata: nessuna pagina obsoleta viene cancellata`);
    return { failures, uploaded: uploaded.length, deleted: 0, status };
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
      return { failures: failures + 1, uploaded: uploaded.length, deleted: 0, status };
    }
  }

  const deleted = [];
  for (const page of obsoletePages) {
    const { stdout } = runImpl('bash', ['scripts/lib/delete-cdn-file.sh', page.edgeKey]);
    if (stdout.includes('✅ deleted')) deleted.push(page);
    else {
      failures++;
      console.log(`::error::[${LOG}] vecchia pagina non cancellata: ${page.edgeKey}`);
    }
  }
  // The current release was already served before the delete. Purge the old
  // keys only after successful delete requests, then retain the 404 verification.
  purgePages(deleted);
  for (const page of obsoletePages) {
    const old = await probeImpl(page.cdnUrl, { attempts: 3, delayMs: 1000 });
    if (old.status !== 'HTTP 404') {
      failures++;
      console.log(`::error::[${LOG}] vecchia pagina ancora servita o non verificabile: ${page.cdnUrl} (${old.status})`);
    }
  }
  return { failures, uploaded: uploaded.length, deleted: deleted.length, status };
}

export async function main(argv = process.argv.slice(2)) {
  const t0 = Date.now();
  const args = parseArgs(argv);
  const section = args.section;
  const distDir = path.resolve(args.out);
  fs.mkdirSync(distDir, { recursive: true });
  const ids = args.bootstrap ? sourceRegistryIds(ROOT_DIR, section) : args.ids;
  const publishing = args.publish && !args.dryRun;
  const previousArticlePages = previousArticleReleasePages(ROOT_DIR, section, args.previousRevision);
  const previousArchivePages = previousArchiveReleasePages(ROOT_DIR, section, args.previousRevision);
  // Preflight the same registry the Worker serves before deciding whether a
  // partial hub set is merely a draft refresh or a live-page defect. A draft
  // checkout must not override an edge registry that is still live.
  const effectiveStatus = publishing ? await publishedStatus(section) : null;

  let hubs = { rels: [], pages: [], missing: [] };
  let landingPages = [];
  const renderRoot = createRenderRoot(ROOT_DIR, process.env.RUNNER_TEMP || os.tmpdir());
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
    beforeOffload: async ({ hubResult: archive }) => {
      for (const rel of CANTON_HUB_LOCALES.flatMap((loc) => archive.pathsByLocale[loc] ?? [])) {
        const abs = path.join(distDir, rel);
        const html = fs.readFileSync(abs, 'utf-8');
        const owned = ensureRouteOwnerMeta(html);
        if (owned !== html) fs.writeFileSync(abs, owned, 'utf-8');
      }
      hubs = await renderHubs({ section, distDir });
      const { renderCantonSectionLandingPages } = await import('../engine/cantonSectionPages.ts');
      const landings = await renderCantonSectionLandingPages({ rootDir: renderRoot, section });
      for (const page of landings) writePage(distDir, page.relPath, page.html);
      landingPages = landings;
      return [...hubs.rels, ...landingPages.map((page) => page.relPath)];
    },
  });

  fs.rmSync(renderRoot, { recursive: true, force: true });

  const currentArticlePages = articleReleaseSnapshot(ROOT_DIR, section);
  const pages = [
    ...entries.flatMap((entry) => CANTON_HUB_LOCALES.map((loc) => entry.paths[loc]).filter(Boolean)).map((rel) => pageEntry(section, rel, 'article')),
    ...CANTON_HUB_LOCALES.flatMap((loc) => hubResult.pathsByLocale[loc] ?? []).map((rel) => pageEntry(section, rel, 'archive')),
    ...hubs.pages.map((page) => rendererPageEntry(section, page, 'hub')),
    ...landingPages.map((page) => rendererPageEntry(section, page, 'landing')),
  ];
  const currentArchivePages = pages.filter((page) => page.kind === 'archive');
  const renderedIds = [...new Set(entries.map((entry) => String(entry.articleId)).filter(Boolean))];
  const missingArticleIds = missingRenderedArticleIds(ids, entries);
  const obsoletePages = obsoleteReleasePages({
    previousArticlePages,
    currentArticlePages,
    previousArchivePages,
    currentArchivePages,
    aggregatePagesAllowed,
  });

  const defects = [];
  if (publishing && effectiveStatus === null) {
    defects.push('registro edge illeggibile o non valido: stato effettivo della sezione non dimostrato');
  }
  for (const page of pages) {
    const abs = path.join(distDir, page.rel);
    const html = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf-8') : '';
    for (const defect of pageDefects(page, html)) defects.push(`${page.rel}: ${defect}`);
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
    effectiveStatus,
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
  const releaseCommit = execFileSync('git', ['-C', ROOT_DIR, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  summary.published = await publish({ pages, cdnUploads, obsoletePages, distDir, section, releaseCommit });
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
