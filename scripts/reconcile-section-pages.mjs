#!/usr/bin/env node
/**
 * reconcile-section-pages.mjs — riconcilia cio' che il corpus ANNUNCIA per le
 * sezioni cantonali `live` con le pagine che R2 ha davvero (piano «sezioni
 * articoli per cantone», P7b). Gemello di reconcile-article-shards.mjs per le
 * sezioni servite dal Worker invece che da uno shard Pages.
 *
 * Perche' serve: fast-publish-section.yml rende gli id del piano del push, ma
 * lo stato delle chiavi gia' sull'edge vive nel manifest scritto solo dopo una
 * pubblicazione verificata. Un push con piu' commit, una run fallita a meta' o
 * un upload non confermato possono lasciare un articolo annunciato in
 * `slugs.json`, nella sitemap della sezione e assente su R2; lo stesso
 * manifest permette di vedere una pagina ritirata rimasta sull'edge.
 *
 * Cosa confronta, da UNA osservazione della superficie pubblicata (`manifest`,
 * `sections`, `slugs` e il registro edge CANDIDATO su Pages devono avere lo
 * stesso `commit`):
 *
 *   atteso    ogni URL annunciato dalla sitemap pubblicata della sezione
 *             (loc e tutti gli xhtml:link href), quindi landing, hub,
 *             archivio con ogni page-N e articoli nelle locali disponibili
 *   presente  HEAD sulla chiave che il Worker legge, per le pagine annunciate
 *             e per le pagine articolo candidate come orfane dal manifest,
 *             `https://cdn.frontaliereticino.ch/edge/sections/<path>/index.html`
 *             e contenuto delle quattro landing confrontato con gli articoli
 *             annunciati dall'API (un HTML 200 da solo non basta)
 *
 * Il registro R2 puo' essere ancora sul commit precedente: e' precisamente il
 * caso di recovery in cui publish-api ha gia' pubblicato Pages ma ha rifiutato
 * il flip perche' mancano pagine. Lo stato candidato resta verificabile dal
 * registro generato su Pages; il registro R2 deve comunque essere valido,
 * perche' publish-section-pages lo usa per proteggere la release servita.
 *
 * Solo un 404 conta come «mancante». Ogni altra risposta (5xx, timeout) e'
 * «non verificabile»: non si ripubblica su un dubbio, lo si riporta.
 *
 * CAP PER SEZIONE (D8): al massimo N articoli per sezione per giro (default
 * 3, `--cap` o RECONCILE_SECTION_CAP), i piu' recenti prima. Il workflow
 * dispatcha fast-publish-section.yml una volta per sezione con quegli id e
 * trasporta separatamente tutti i 404 osservati, cosi' i leftover restano
 * fuori dall'inventario immutabile mentre attendono il giro successivo; se
 * manca solo una pagina di sezione, con `ids: []` (rinfresco di landing,
 * archivio e hub).
 *
 * Uso: node scripts/reconcile-section-pages.mjs --out <report.json> [--cap N] [--budget-ms N]
 * Solo builtin Node: gira senza npm ci.
 */
import '../host/cantonSectionsBootstrap.mjs';
import fs, { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ARTICLE_SECTION_CORE_ALL } from '../engine/shared/articleSectionCore.mjs';
import { CANTON_ARCHIVE_ALL_SLUG } from '../engine/shared/cantonSectionCopy.mjs';
import { fetchPageManifest, pageManifestUrl } from './lib/section-page-manifest.mjs';
import { assertHubLocaleSlug, assertHubTopicEntries } from './lib/assert-hub-locale-slug.mjs';
import { sitemapPaths } from './publish-section-edge.mjs';
import { validateEdgeSectionRegistry } from './lib/section-registry.mjs';
import { fetchWithRefTimeout, releaseFetchWithRefTimeout } from '../generator/scripts/lib/fetch-with-ref-timeout.mjs';
import {
  parseRetryAfterHeader,
  parseStrictRetryAfterValue as parseStrictRetryAfterValueShared,
} from '../generator/scripts/lib/retry-after.mjs';

export const API_BASE_DEFAULT = 'https://nanakokyobashi-rgb.github.io/frontaliere-articles';
export const CDN_BASE = 'https://cdn.frontaliereticino.ch';
const LOCALES = ['it', 'en', 'de', 'fr'];
// The renderer owns this contract in TypeScript. The reconciler runs under
// plain Node, so generate its adapter from the mirrored source instead of
// maintaining a second numeric owner that can drift on the next lockstep.
const ENGINE_CANTON_SECTION_PAGES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../engine/cantonSectionPages.ts',
);
const engineCantonSectionPages = fs.readFileSync(ENGINE_CANTON_SECTION_PAGES, 'utf8');
const engineLandingCardLimit = /^export const CANTON_LANDING_CARD_LIMIT = (\d+);$/mu.exec(engineCantonSectionPages);
if (!engineLandingCardLimit) {
  throw new Error(`[reconcile-section-pages] CANTON_LANDING_CARD_LIMIT non trovato in ${ENGINE_CANTON_SECTION_PAGES}`);
}
const parsedLandingCardLimit = Number(engineLandingCardLimit[1]);
if (!Number.isSafeInteger(parsedLandingCardLimit) || parsedLandingCardLimit < 1) {
  throw new Error(`[reconcile-section-pages] CANTON_LANDING_CARD_LIMIT non valido: ${engineLandingCardLimit[1]}`);
}
export const CANTON_LANDING_CARD_LIMIT = parsedLandingCardLimit;
const UA = 'frontaliere-corpus-reconcile/1 (+https://frontaliereticino.ch)';
export const RECONCILE_FETCH_ATTEMPTS = 3;
export const RECONCILE_FETCH_RETRY_DELAY_MS = 1000;
export const RECONCILE_FETCH_MAX_RETRY_AFTER_MS = 300_000;
export const RECONCILE_FETCH_MAX_DURATION_MS = 180_000;

export class ReconcileBudgetExceededError extends Error {
  constructor() {
    super('budget wall-clock del reconcile esaurito');
    this.name = 'ReconcileBudgetExceededError';
  }
}

const RETRYABLE_HTTP_STATUSES = new Set([408, 425, 429]);

function isRetryableStatus(status) {
  return RETRYABLE_HTTP_STATUSES.has(status) || status >= 500;
}

function defaultSleep(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

/**
 * Restituisce il tempo residuo di una osservazione condivisa.
 *
 * Tutte le letture della riconciliazione ricevono lo stesso callback: un
 * retry di una fetch non puo' quindi moltiplicare il budget per il numero di
 * documenti o di sezioni che stanno lavorando in parallelo.
 */
export function remainingBudgetMs(deadline, now = Date.now) {
  const current = now();
  if (!Number.isFinite(deadline) || !Number.isFinite(current)) return 0;
  return Math.max(0, Math.floor(deadline - current));
}

function budgetTimeoutMs(defaultTimeoutMs, remainingBudget) {
  const remaining = remainingBudget();
  if (remaining <= 0) throw new ReconcileBudgetExceededError();
  return Number.isFinite(remaining)
    ? Math.max(1, Math.min(defaultTimeoutMs, remaining))
    : defaultTimeoutMs;
}

async function waitBeforeRetry(
  attempt,
  retryDelayMs,
  sleepImpl,
  retryAfterMs,
  maxAttempts,
  remainingBudget,
  allowFinalServerDelay = false,
) {
  if (attempt >= maxAttempts
      && !(allowFinalServerDelay && Number.isFinite(retryAfterMs) && retryAfterMs > 0)) return true;
  const remaining = remainingBudget();
  if (remaining <= 0) return false;
  const baseDelayMs = Number.isFinite(retryDelayMs) && retryDelayMs > 0
    ? retryDelayMs * attempt
    : 0;
  const requestedDelayMs = retryAfterMs === null ? baseDelayMs : Math.max(baseDelayMs, retryAfterMs);
  const delayMs = Number.isFinite(remaining) ? Math.min(requestedDelayMs, remaining) : requestedDelayMs;
  if (delayMs > 0) await sleepImpl(delayMs);
  return remainingBudget() > 0;
}

/**
 * Legge `Retry-After` da una risposta HTTP come millisecondi da attendere.
 * Sono accettati sia i delta-secondes RFC 9110 sia una data HTTP; un valore
 * invalido lascia il backoff locale al controllo del chiamante. Il cap evita
 * che una risposta remota possa tenere il reconcile sospeso indefinitamente.
 *
 * @param {Response|{headers?: {get?: Function}}|null} response
 * @param {number} [nowMs]
 * @returns {number|null}
 */
/**
 * Parse one Retry-After value with the reconcile-specific cap.
 *
 * @param {unknown} raw
 * @param {number} [nowMs]
 * @returns {number|null}
 */
export function parseStrictRetryAfterValue(raw, nowMs = Date.now()) {
  return parseStrictRetryAfterValueShared(raw, nowMs, RECONCILE_FETCH_MAX_RETRY_AFTER_MS);
}

export function parseRetryAfter(response, nowMs = Date.now()) {
  return parseRetryAfterHeader(response, nowMs, RECONCILE_FETCH_MAX_RETRY_AFTER_MS);
}

/** La chiave R2 (come URL sul CDN) di un path canonico di sezione. */
export function cdnUrlFor(canonicalPath) {
  return `${CDN_BASE}/edge/sections${canonicalPath}index.html`;
}

/**
 * La sitemap e la mappa slug possono attraversare una pubblicazione Pages in
 * momenti diversi pur portando lo stesso commit nel manifest. In quel caso la
 * superficie non e' abbastanza affidabile per calcolare un backfill, ma non e'
 * un errore di parsing del reconcile: il giro deve rimandare la sezione.
 */
export class SectionSitemapIncoherentError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SectionSitemapIncoherentError';
  }
}

/**
 * Le pagine attese di una sezione live.
 * @param {{ id: string, paths: Record<string, string> }} entry voce di sections.json
 * @param {Record<string, Record<string, string>>} slugs slugs.json.cantons[<sezione>]
 * @param {string} sitemapXml sitemap della sezione pubblicata
 * @returns {Array<{ kind: 'section' | 'article', id?: string, locale: string, path: string }>}
 */
export function expectedSectionPages(entry, slugs, sitemapXml) {
  if (!ARTICLE_SECTION_CORE_ALL[entry.id]) throw new Error(`sezione sconosciuta nel catalogo: ${entry.id}`);
  if (typeof sitemapXml !== 'string') throw new Error(`sitemap mancante per ${entry.id}: il reconcile deve usare la superficie pubblicata`);
  const articleByPath = new Map();
  for (const id of Object.keys(slugs ?? {})) {
    for (const locale of LOCALES) {
      const slug = slugs[id]?.[locale];
      // Una locale senza slug non ha una pagina annunciata: niente da cercare.
      if (slug) articleByPath.set(`${entry.paths[locale]}${slug}/`, { kind: 'article', id, locale, path: `${entry.paths[locale]}${slug}/` });
    }
  }
  const paths = sitemapPaths(sitemapXml, `sitemap di ${entry.id}`);
  return [...paths].map((canonicalPath) => {
    const article = articleByPath.get(canonicalPath);
    if (article) return article;
    const locale = LOCALES.find((candidate) => {
      const prefix = entry.paths[candidate];
      return typeof prefix === 'string' && (canonicalPath === prefix || canonicalPath.startsWith(prefix));
    });
    if (!locale) {
      throw new SectionSitemapIncoherentError(
        `sitemap di ${entry.id}: URL ${canonicalPath} fuori dai prefissi della sezione`,
      );
    }
    const prefix = entry.paths[locale];
    const archivePrefix = `${prefix}${CANTON_ARCHIVE_ALL_SLUG[locale]}/`;
    const isLanding = canonicalPath === prefix;
    const hubSlugs = assertHubTopicEntries(entry.id, ARTICLE_SECTION_CORE_ALL[entry.id].topicHubs)
      .map(([topic, localizedSlugs]) => assertHubLocaleSlug(entry.id, topic, locale, localizedSlugs));
    const isHub = hubSlugs.some((slug) => canonicalPath === `${prefix}${slug}/`);
    const isArchive = canonicalPath === archivePrefix || (
      canonicalPath.startsWith(archivePrefix) && /^page-\d+\/$/.test(canonicalPath.slice(archivePrefix.length))
    );
    if (!isLanding && !isHub && !isArchive) {
      throw new SectionSitemapIncoherentError(
        `sitemap di ${entry.id}: URL articolo ${canonicalPath} non compare in slugs.json.cantons — ` +
          'superficie sitemap/slugs incoerente, backfill bloccato',
      );
    }
    return { kind: 'section', locale, path: canonicalPath };
  });
}

/**
 * Articoli che il manifest dell'edge considera presenti ma che il registro
 * corrente non contiene più, oppure il cui slug è cambiato.
 */
export function orphanedArticleCandidates(entry, manifest, slugs, activeIds = Object.keys(slugs ?? {})) {
  const active = new Set(activeIds);
  return (manifest?.pages?.article ?? [])
    .filter((row) => {
      if (!active.has(row.id)) return true;
      const expectedSlug = slugs?.[row.id]?.[row.locale];
      const expectedPath = expectedSlug ? `${entry.paths[row.locale]}${expectedSlug}/` : null;
      return expectedPath !== row.canonicalPath;
    })
    .map((row) => ({ kind: 'article', id: row.id, locale: row.locale, path: row.canonicalPath }));
}

/**
 * Da pagine attese e loro stato a cosa ripubblicare, con il cap per sezione.
 * @param {Array<{ kind: string, id?: string, path: string, state: 'present' | 'missing' | 'unknown' }>} pages
 * @param {Map<string, string>} dateById id → data dell'articolo
 */
export function planSectionBackfill(section, pages, dateById, cap, orphanPages = []) {
  const n = Number(cap);
  if (!Number.isInteger(n) || n < 1) throw new Error(`cap non valido: ${cap}`);
  const missing = pages.filter((page) => page.state === 'missing');
  const missingIds = [...new Set(missing.filter((page) => page.kind === 'article').map((page) => page.id))].sort((a, b) => {
    const byDate = String(dateById.get(b) ?? '').localeCompare(String(dateById.get(a) ?? ''));
    return byDate || a.localeCompare(b);
  });
  const sectionMissing = missing.filter((page) => page.kind === 'section').map((page) => page.path);
  const selected = missingIds.slice(0, n);
  const selectedIds = new Set(selected);
  const missingOrphanPagePaths = orphanPages.filter((page) => page.state === 'missing').map((page) => page.path);
  const expectedMissingPagePaths = [...new Set(missing.map((page) => page.path))];
  const knownMissingPagePaths = [...new Set([...missing.map((page) => page.path), ...missingOrphanPagePaths])];
  const missingPagePaths = missing
    .filter((page) => page.kind === 'section' || selectedIds.has(page.id))
    .map((page) => page.path);
  const orphaned = orphanPages.filter((page) => page.state === 'present');
  const orphanedUnknown = orphanPages.filter((page) => page.state === 'unknown').map((page) => page.path);
  return {
    section,
    expected: pages.length,
    unknown: [...pages.filter((page) => page.state === 'unknown').map((page) => page.path), ...orphanedUnknown],
    sectionMissing,
    orphaned: orphaned.map((page) => page.path),
    orphanedIds: [...new Set(orphaned.map((page) => page.id))].sort(),
    orphanedUnknown,
    missingIds,
    selected,
    missingPagePaths,
    expectedMissingPagePaths,
    knownMissingPagePaths,
    leftover: missingIds.slice(n),
    // Un giro di sola sezione (ids vuoti) serve quando manca una pagina di
    // sezione e nessun articolo: con articoli selezionati la sezione viene
    // comunque resa per intero dallo stesso publish.
    dispatch: missingIds.length > 0 || sectionMissing.length > 0 || orphaned.length > 0 || missingOrphanPagePaths.length > 0,
  };
}

async function getJson(
  url,
  fetchImpl,
  {
    retryDelayMs = RECONCILE_FETCH_RETRY_DELAY_MS,
    sleepImpl = defaultSleep,
    remainingBudget = () => Number.POSITIVE_INFINITY,
  } = {},
) {
  for (let attempt = 1; attempt <= RECONCILE_FETCH_ATTEMPTS; attempt++) {
    let res;
    try {
      res = await fetchWithRefTimeout(
        `${url}?_rcb=${Date.now()}.${attempt}`,
        { headers: { 'user-agent': UA } },
        budgetTimeoutMs(30_000, remainingBudget),
        fetchImpl,
      );
    } catch (error) {
      if (attempt === RECONCILE_FETCH_ATTEMPTS) throw error;
      if (!(await waitBeforeRetry(
        attempt,
        retryDelayMs,
        sleepImpl,
        null,
        RECONCILE_FETCH_ATTEMPTS,
        remainingBudget,
      ))) throw new ReconcileBudgetExceededError();
      continue;
    }
    if (!res.ok) {
      const status = res.status;
      const retryAfterMs = parseRetryAfter(res);
      releaseFetchWithRefTimeout(res);
      if (!isRetryableStatus(status) || attempt === RECONCILE_FETCH_ATTEMPTS) {
        throw new Error(`${url}: HTTP ${status}`);
      }
      if (!(await waitBeforeRetry(
        attempt,
        retryDelayMs,
        sleepImpl,
        retryAfterMs,
        RECONCILE_FETCH_ATTEMPTS,
        remainingBudget,
      ))) throw new ReconcileBudgetExceededError();
      continue;
    }
    try {
      return await res.json();
    } catch (error) {
      if (attempt === RECONCILE_FETCH_ATTEMPTS) throw error;
      if (!(await waitBeforeRetry(
        attempt,
        retryDelayMs,
        sleepImpl,
        null,
        RECONCILE_FETCH_ATTEMPTS,
        remainingBudget,
      ))) throw new ReconcileBudgetExceededError();
    }
  }
  throw new Error(`${url}: tentativi esauriti`);
}

/**
 * Legge il registry candidato su Pages conservando la differenza fra 404
 * (build-api non lo ha pubblicato, tipicamente per un gate Remote Config non
 * verificato) e una risposta corrotta/non verificabile. Entrambi fermano il
 * backfill, ma il report deve dire quale superficie manca.
 */
async function getJsonState(
  url,
  fetchImpl,
  {
    retryDelayMs = RECONCILE_FETCH_RETRY_DELAY_MS,
    sleepImpl = defaultSleep,
    remainingBudget = () => Number.POSITIVE_INFINITY,
  } = {},
) {
  let lastError = null;
  let lastStatus = null;
  for (let attempt = 1; attempt <= RECONCILE_FETCH_ATTEMPTS; attempt++) {
    try {
      const res = await fetchWithRefTimeout(
        `${url}?_rcb=${Date.now()}.${attempt}`,
        { headers: { 'user-agent': UA } },
        budgetTimeoutMs(30_000, remainingBudget),
        fetchImpl,
      );
      lastStatus = res.status;
      if (res.status === 404) {
        releaseFetchWithRefTimeout(res);
        return { state: 'absent', url, status: 404 };
      }
      if (!res.ok) {
        const status = res.status;
        const retryAfterMs = parseRetryAfter(res);
        releaseFetchWithRefTimeout(res);
        if (!isRetryableStatus(status) || attempt === RECONCILE_FETCH_ATTEMPTS) {
          return { state: 'unknown', url, status, reason: `HTTP ${status}` };
        }
        if (!(await waitBeforeRetry(
          attempt,
          retryDelayMs,
          sleepImpl,
          retryAfterMs,
          RECONCILE_FETCH_ATTEMPTS,
          remainingBudget,
        ))) break;
        continue;
      }
      return { state: 'ok', url, status: res.status, value: await res.json() };
    } catch (error) {
      lastError = error;
      if (error instanceof ReconcileBudgetExceededError) break;
      if (attempt < RECONCILE_FETCH_ATTEMPTS && !(await waitBeforeRetry(
        attempt,
        retryDelayMs,
        sleepImpl,
        null,
        RECONCILE_FETCH_ATTEMPTS,
        remainingBudget,
      ))) break;
    }
  }
  return { state: 'unknown', url, ...(lastStatus === null ? {} : { status: lastStatus }), reason: lastError?.message ?? String(lastError) };
}

async function getText(
  url,
  fetchImpl,
  {
    retryDelayMs = RECONCILE_FETCH_RETRY_DELAY_MS,
    sleepImpl = defaultSleep,
    remainingBudget = () => Number.POSITIVE_INFINITY,
  } = {},
) {
  for (let attempt = 1; attempt <= RECONCILE_FETCH_ATTEMPTS; attempt++) {
    let res;
    try {
      res = await fetchWithRefTimeout(
        `${url}?_rcb=${Date.now()}.${attempt}`,
        { headers: { 'user-agent': UA } },
        budgetTimeoutMs(30_000, remainingBudget),
        fetchImpl,
      );
    } catch (error) {
      if (attempt === RECONCILE_FETCH_ATTEMPTS) throw error;
      if (!(await waitBeforeRetry(
        attempt,
        retryDelayMs,
        sleepImpl,
        null,
        RECONCILE_FETCH_ATTEMPTS,
        remainingBudget,
      ))) throw new ReconcileBudgetExceededError();
      continue;
    }
    if (!res.ok) {
      const status = res.status;
      const retryAfterMs = parseRetryAfter(res);
      releaseFetchWithRefTimeout(res);
      if (!isRetryableStatus(status) || attempt === RECONCILE_FETCH_ATTEMPTS) {
        throw new Error(`${url}: HTTP ${status}`);
      }
      if (!(await waitBeforeRetry(
        attempt,
        retryDelayMs,
        sleepImpl,
        retryAfterMs,
        RECONCILE_FETCH_ATTEMPTS,
        remainingBudget,
      ))) throw new ReconcileBudgetExceededError();
      continue;
    }
    try {
      return await res.text();
    } catch (error) {
      if (attempt === RECONCILE_FETCH_ATTEMPTS) throw error;
      if (!(await waitBeforeRetry(
        attempt,
        retryDelayMs,
        sleepImpl,
        null,
        RECONCILE_FETCH_ATTEMPTS,
        remainingBudget,
      ))) throw new ReconcileBudgetExceededError();
    }
  }
  throw new Error(`${url}: tentativi esauriti`);
}

/** Piano conservativo per una sitemap che non si e' potuta verificare. */
function unknownSitemapPlan(section, detail) {
  return {
    section,
    // Non e' stato possibile contare le pagine annunciate: zero sarebbe un
    // conteggio falsamente verificato e potrebbe far sembrare completa la
    // superficie.
    expected: null,
    unknown: [detail],
    sectionMissing: [],
    orphaned: [],
    orphanedIds: [],
    orphanedUnknown: [],
    pageManifest: 'unknown',
    pageManifestReason: detail,
    missingIds: [],
    selected: [],
    leftover: [],
    dispatch: false,
  };
}

function sitemapFailureDetail(url, error) {
  const reason = String(error?.message ?? error);
  return reason.startsWith(`${url}:`) ? reason : `${url}: ${reason}`;
}

function landingHrefPath(rawHref) {
  const href = String(rawHref ?? '')
    .trim()
    .replace(/&amp;/giu, '&')
    .replace(/&#x2f;|&#47;/giu, '/');
  const pathname = new URL(href, 'https://frontaliereticino.ch').pathname;
  return pathname.split('/').map((segment) => {
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment;
    }
  }).join('/');
}

function jsonLdNumberOfItems(html) {
  let fallback = null;
  const scripts = String(html ?? '').matchAll(
    /<script\b[^>]*\btype\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/giu,
  );
  for (const match of scripts) {
    let parsed;
    try {
      parsed = JSON.parse(match[1].trim().replace(/^\uFEFF/u, ''));
    } catch {
      continue;
    }
    const queue = Array.isArray(parsed) ? [...parsed] : [parsed];
    while (queue.length) {
      const value = queue.pop();
      if (!value || typeof value !== 'object') continue;
      const type = value['@type'];
      const isItemList = type === 'ItemList' || (Array.isArray(type) && type.includes('ItemList'));
      const count = value.numberOfItems;
      if (Number.isSafeInteger(count) && count >= 0) {
        if (isItemList) return count;
        if (fallback === null) fallback = count;
      }
      for (const child of Object.values(value)) {
        if (child && typeof child === 'object') queue.push(child);
      }
    }
  }
  return fallback;
}

/**
 * Confronta gli articoli annunciati con i link realmente presenti nella
 * landing pubblicata. Il manifest edge prova che esiste un file HTML, non che
 * quel file sia stato rigenerato dopo l'ultimo aggiornamento dell'indice API.
 *
 * @param {{ paths: Record<string, string> }} entry
 * @param {Array<{ id: string, date?: string }>} rows
 * @param {Record<string, Record<string, string>>} slugs
 * @param {string} locale
 * @param {string} html
 * @param {number} [limit]
 */
export function landingArticleCoverage({
  entry,
  rows,
  slugs,
  locale,
  html,
  limit = CANTON_LANDING_CARD_LIMIT,
}) {
  const prefix = entry?.paths?.[locale];
  if (typeof prefix !== 'string' || !prefix.endsWith('/')) {
    throw new Error(`prefisso landing non valido per ${locale}`);
  }
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error(`limite landing non valido: ${limit}`);
  }
  const orderedRows = (rows ?? [])
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const dateA = String(a.row?.date ?? '');
      const dateB = String(b.row?.date ?? '');
      if (dateA && dateB && dateA !== dateB) return dateB.localeCompare(dateA);
      if (dateA && !dateB) return -1;
      if (!dateA && dateB) return 1;
      return a.index - b.index;
    })
    .map(({ row }) => row);
  const articleRows = [];
  for (const row of orderedRows) {
    const id = String(row?.id ?? '');
    // `renderCantonSectionLanding` falls back to the article id when a
    // localized slug is absent; use the same path so a valid fallback card
    // does not look stale to the reconciler.
    const slug = slugs?.[id]?.[locale] ?? id;
    if (id && typeof slug === 'string' && slug) articleRows.push({ id, path: `${prefix}${slug}/` });
  }
  const articleByPath = new Map(articleRows.map(({ id, path: articlePath }) => [articlePath, id]));
  const expectedArticleByPath = new Map(articleRows
    .slice(0, limit)
    .map(({ id, path: articlePath }) => [articlePath, id]));
  const found = new Set();
  const extraIds = new Set();
  const extraPaths = new Set();
  for (const match of String(html ?? '').matchAll(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/giu)) {
    try {
      const pathname = landingHrefPath(match[1] ?? match[2] ?? match[3]);
      const id = articleByPath.get(pathname);
      if (!id) continue;
      if (expectedArticleByPath.has(pathname)) found.add(id);
      else {
        extraIds.add(id);
        extraPaths.add(pathname);
      }
    } catch {
      // Un href non URL non può dimostrare la presenza di un articolo.
    }
  }
  const expectedIds = [...expectedArticleByPath.values()];
  const missingIds = expectedIds.filter((id) => !found.has(id));
  const declaredCount = jsonLdNumberOfItems(html);
  const problems = [];
  if (missingIds.length > 0) problems.push(`missing-articles:${missingIds.join(',')}`);
  if (extraIds.size > 0) problems.push(`extra-articles:${[...extraIds].join(',')}`);
  if (declaredCount === null) {
    problems.push(`numberOfItems:missing/${expectedIds.length}`);
  } else if (declaredCount !== expectedIds.length) {
    problems.push(`numberOfItems:${declaredCount}/${expectedIds.length}`);
  }
  return {
    expectedCount: expectedIds.length,
    foundCount: found.size,
    declaredCount,
    missingIds,
    extraIds: [...extraIds],
    extraPaths: [...extraPaths],
    problems,
  };
}

function skippedSurface({ code, reason, apiCommit = null, edgeCommit = null, pendingEdgeFlip = null, url = null, status = null }) {
  return {
    skipped: reason,
    skip: { code, reason, ...(url ? { url } : {}), ...(status === null ? {} : { status }) },
    apiCommit,
    edgeCommit,
    ...(pendingEdgeFlip === null ? {} : { pendingEdgeFlip }),
    sections: [],
  };
}

/** HEAD con due tentativi; 405/501 ricadono su GET, 200 presente, 404 mancante. */
export async function headState(
  url,
  fetchImpl = fetch,
  {
    retryDelayMs = RECONCILE_FETCH_RETRY_DELAY_MS,
    sleepImpl = defaultSleep,
    remainingBudget = () => Number.POSITIVE_INFINITY,
  } = {},
) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const request = (method) => fetchWithRefTimeout(
        `${url}?_rcb=${Date.now()}.${attempt}.${method.toLowerCase()}`,
        {
          method,
          headers: { 'user-agent': UA },
        },
        budgetTimeoutMs(15_000, remainingBudget),
        fetchImpl,
      );
      const res = await request('HEAD');
      if (res.status === 200) {
        releaseFetchWithRefTimeout(res);
        return 'present';
      }
      if (res.status === 404) {
        releaseFetchWithRefTimeout(res);
        return 'missing';
      }
      const headStatus = res.status;
      const headRetryAfterMs = parseRetryAfter(res);
      releaseFetchWithRefTimeout(res);
      if (headStatus !== 405 && headStatus !== 501) {
        if (!(await waitBeforeRetry(
          attempt,
          retryDelayMs,
          sleepImpl,
          headRetryAfterMs,
          2,
          remainingBudget,
        ))) return 'unknown';
        continue;
      }
      // A HEAD endpoint can be unsupported while still telling us when the
      // fallback is safe to retry. Preserve that server-directed delay before
      // issuing GET; otherwise the fallback immediately defeats Retry-After.
      if (headRetryAfterMs !== null && !(await waitBeforeRetry(
        attempt,
        0,
        sleepImpl,
        headRetryAfterMs,
        2,
        remainingBudget,
        true,
      ))) return 'unknown';
      const get = await request('GET');
      if (get.status === 200) {
        releaseFetchWithRefTimeout(get);
        return 'present';
      }
      if (get.status === 404) {
        releaseFetchWithRefTimeout(get);
        return 'missing';
      }
      const getRetryAfterMs = parseRetryAfter(get);
      releaseFetchWithRefTimeout(get);
      if (!(await waitBeforeRetry(
        attempt,
        retryDelayMs,
        sleepImpl,
        getRetryAfterMs,
        2,
        remainingBudget,
      ))) return 'unknown';
    } catch (error) {
      if (error instanceof ReconcileBudgetExceededError) return 'unknown';
      if (!(await waitBeforeRetry(
        attempt,
        retryDelayMs,
        sleepImpl,
        null,
        2,
        remainingBudget,
      ))) return 'unknown';
      /* ritenta, poi non verificabile */
    }
  }
  return 'unknown';
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

/**
 * @returns {Promise<{ skipped: string | null, apiCommit: string | null, edgeCommit?: string | null, pendingEdgeFlip?: boolean, sections: ReturnType<typeof planSectionBackfill>[] }>}
 */
export async function reconcile({
  apiBase = API_BASE_DEFAULT,
  cap = 3,
  fetchImpl = fetch,
  retryDelayMs = RECONCILE_FETCH_RETRY_DELAY_MS,
  sleepImpl = defaultSleep,
  budgetMs = RECONCILE_FETCH_MAX_DURATION_MS,
  now = Date.now,
} = {}) {
  const duration = Number(budgetMs);
  if (!Number.isSafeInteger(duration) || duration <= 0) {
    throw new Error('budgetMs deve essere una durata positiva intera finita');
  }
  const startedAt = now();
  const deadline = startedAt + duration;
  if (!Number.isFinite(startedAt) || !Number.isFinite(deadline)) {
    throw new Error('budgetMs produce una deadline non finita');
  }
  const remainingBudget = () => remainingBudgetMs(deadline, now);
  const fetchOptions = { retryDelayMs, sleepImpl, remainingBudget };
  const [manifest, catalog, slugs, candidateRegistryResult, edgeRegistry] = await Promise.all(
    ['manifest.json', 'sections.json', 'slugs.json'].map((name) => getJson(`${apiBase}/${name}`, fetchImpl, fetchOptions)).concat(
      getJsonState(`${apiBase}/edge/sections/registry.json`, fetchImpl, fetchOptions),
      getJson(`${CDN_BASE}/edge/sections/registry.json`, fetchImpl, fetchOptions),
    ),
  );
  if (candidateRegistryResult.state === 'absent') {
    return skippedSurface({
      code: 'pages-registry-absent',
      reason: 'registry edge Pages assente (build-api non ha dimostrato la configurazione Remote Config; backfill rimandato)',
      apiCommit: manifest?.commit ?? null,
      edgeCommit: edgeRegistry?.commit ?? null,
      url: candidateRegistryResult.url,
      status: candidateRegistryResult.status,
    });
  }
  if (candidateRegistryResult.state !== 'ok') {
    return skippedSurface({
      code: 'pages-registry-unknown',
      reason: `registry edge Pages non verificabile (${candidateRegistryResult.reason ?? 'risposta sconosciuta'}; backfill rimandato)`,
      apiCommit: manifest?.commit ?? null,
      edgeCommit: edgeRegistry?.commit ?? null,
      url: candidateRegistryResult.url,
      status: candidateRegistryResult.status ?? null,
    });
  }
  const candidateRegistry = candidateRegistryResult.value;
  if (!manifest?.commit || catalog?.commit !== manifest.commit || slugs?.commit !== manifest.commit || candidateRegistry?.commit !== manifest.commit) {
    return skippedSurface({
      code: 'pages-surface-mismatch',
      reason: 'superficie API a meta\' deploy: manifest, sections, slugs e registro edge candidato non portano lo stesso commit',
      apiCommit: manifest?.commit ?? null,
      edgeCommit: edgeRegistry?.commit ?? null,
    });
  }
  if (!validateEdgeSectionRegistry(candidateRegistry)) {
    return skippedSurface({
      code: 'pages-registry-invalid',
      reason: 'registry edge Pages non valido: release API non dimostrata; backfill rimandato',
      apiCommit: manifest.commit,
      edgeCommit: edgeRegistry?.commit ?? null,
    });
  }
  if (!validateEdgeSectionRegistry(edgeRegistry)) {
    return skippedSurface({
      code: 'edge-registry-invalid',
      reason: 'registro edge non valido o non leggibile: stato servito non dimostrato',
      apiCommit: manifest.commit,
      edgeCommit: edgeRegistry?.commit ?? null,
    });
  }
  const pendingEdgeFlip = edgeRegistry.commit !== manifest.commit;
  const catalogById = new Map((catalog.sections ?? []).map((entry) => [entry.id, entry]));
  const live = Object.entries(candidateRegistry.sections ?? {})
    .filter(([, state]) => state.status === 'live')
    .map(([id]) => catalogById.get(id));
  if (live.some((entry) => !entry || typeof entry.sitemap !== 'string' || !entry.sitemap)) {
    return skippedSurface({
      code: 'candidate-live-section-incomplete',
      reason: 'superficie API a meta\' deploy: una sezione live nel registro edge candidato non ha catalogo o sitemap',
      apiCommit: manifest.commit,
      edgeCommit: edgeRegistry.commit,
      pendingEdgeFlip,
    });
  }
  if (live.length === 0) return { skipped: null, apiCommit: manifest.commit, edgeCommit: edgeRegistry.commit, pendingEdgeFlip, sections: [] };
  const rows = await getJson(`${apiBase}/canton-articles.json`, fetchImpl, fetchOptions);
  const dateById = new Map(rows.map((row) => [row.id, row.updatedAt || row.date || '']));
  const sections = [];
  for (const entry of live) {
    const sitemapUrl = `${apiBase}${entry.sitemap}`;
    let sitemapXml;
    try {
      sitemapXml = await getText(sitemapUrl, fetchImpl, fetchOptions);
    } catch (error) {
      const detail = sitemapFailureDetail(sitemapUrl, error);
      console.warn(`::warning::[reconcile-sections] ${entry.id}: sitemap non verificabile (${detail}); nessun backfill`);
      sections.push(unknownSitemapPlan(entry.id, detail));
      continue;
    }
    let expected;
    try {
      expected = expectedSectionPages(entry, slugs.cantons?.[entry.id] ?? {}, sitemapXml);
    } catch (error) {
      if (!(error instanceof SectionSitemapIncoherentError)) throw error;
      const detail = sitemapFailureDetail(sitemapUrl, error);
      console.warn(`::warning::[reconcile-sections] ${entry.id}: sitemap non verificabile (${detail}); nessun backfill`);
      sections.push(unknownSitemapPlan(entry.id, detail));
      continue;
    }
    const activeRows = rows.filter((row) => row.section === entry.id);
    const sectionSlugs = slugs.cantons?.[entry.id] ?? {};
    const landingChecks = [];
    for (const locale of LOCALES) {
      const landingPath = entry.paths[locale];
      const landingUrl = cdnUrlFor(landingPath);
      try {
        const html = await getText(landingUrl, fetchImpl, fetchOptions);
        const coverage = landingArticleCoverage({
          entry,
          rows: activeRows,
          slugs: sectionSlugs,
          locale,
          html,
        });
        landingChecks.push({ locale, path: landingPath, state: coverage.problems.length ? 'invalid' : 'ok', ...coverage });
      } catch (error) {
        landingChecks.push({
          locale,
          path: landingPath,
          state: 'unknown',
          reason: sitemapFailureDetail(landingUrl, error),
          expectedCount: Math.min(activeRows.length, CANTON_LANDING_CARD_LIMIT),
          foundCount: null,
          declaredCount: null,
          missingIds: [],
          extraIds: [],
          extraPaths: [],
          problems: [],
        });
      }
    }
    const pagesWithLandingState = expected.map((page) => {
      const check = landingChecks.find((candidate) => candidate.path === page.path && candidate.state === 'invalid');
      return check && page.kind === 'section' ? { ...page, state: 'missing' } : page;
    });
    for (const check of landingChecks.filter((candidate) => candidate.state === 'invalid')) {
      if (!pagesWithLandingState.some((page) => page.kind === 'section' && page.path === check.path)) {
        pagesWithLandingState.push({ kind: 'section', locale: check.locale, path: check.path, state: 'missing' });
      }
    }
    const states = await mapLimit(pagesWithLandingState, 8, (page) => (
      page.state === 'missing' ? 'missing' : headState(cdnUrlFor(page.path), fetchImpl, fetchOptions)
    ));
    const activeIds = activeRows.length
      ? new Set(activeRows.map((row) => row.id))
      : new Set(Object.keys(sectionSlugs));
    const pageManifest = await fetchPageManifest(pageManifestUrl(entry.id, CDN_BASE), {
      fetchImpl,
      section: entry.id,
      remainingBudget,
    });
    let orphanPages = [];
    if (pageManifest.state === 'ok') {
      const candidates = orphanedArticleCandidates(entry, pageManifest.doc, slugs.cantons?.[entry.id] ?? {}, activeIds);
      const orphanStates = await mapLimit(candidates, 8, (page) => headState(cdnUrlFor(page.path), fetchImpl, fetchOptions));
      orphanPages = candidates.map((page, i) => ({ ...page, state: orphanStates[i] }));
    }
    const plan = planSectionBackfill(entry.id, pagesWithLandingState.map((page, i) => ({ ...page, state: states[i] })), dateById, cap, orphanPages);
    plan.pageManifest = pageManifest.state;
    if (pageManifest.reason) plan.pageManifestReason = pageManifest.reason;
    plan.landingContent = landingChecks.map(({ locale, path: landingPath, state, expectedCount, foundCount, declaredCount, missingIds, extraIds, extraPaths, problems, reason }) => ({
      locale,
      path: landingPath,
      state,
      expectedCount,
      foundCount,
      declaredCount,
      missingIds,
      extraIds,
      extraPaths,
      problems,
      ...(reason ? { reason } : {}),
    }));
    for (const check of landingChecks.filter((candidate) => candidate.state === 'unknown')) {
      plan.unknown.push(check.reason);
    }
    sections.push(plan);
  }
  return { skipped: null, apiCommit: manifest.commit, edgeCommit: edgeRegistry.commit, pendingEdgeFlip, sections };
}

export async function main(argv = process.argv.slice(2)) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out' || argv[i] === '--cap' || argv[i] === '--budget-ms') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${argv[i]} richiede un valore`);
      args[argv[i].slice(2)] = value;
      i++;
    } else throw new Error(`argomento sconosciuto: ${argv[i]} (uso: --out <report.json> [--cap N] [--budget-ms N])`);
  }
  if (!args.out) throw new Error('manca --out <report.json>');
  const cap = Number(args.cap ?? process.env.RECONCILE_SECTION_CAP ?? 3);
  const budgetMs = Number(
    args['budget-ms']
      ?? process.env.RECONCILE_SECTION_BUDGET_MS
      ?? RECONCILE_FETCH_MAX_DURATION_MS,
  );
  const apiBase = (process.env.RECONCILE_API_BASE || API_BASE_DEFAULT).replace(/\/+$/, '');
  const report = await reconcile({ apiBase, cap, budgetMs });
  report.counts = {
    sections: report.sections.length,
    dispatch: report.sections.filter((s) => s.dispatch).length,
    landingContentStale: report.sections.reduce((n, s) => n + (s.landingContent?.filter((landing) => landing.state === 'invalid').length ?? 0), 0),
    missing: report.sections.reduce((n, s) => n + s.missingIds.length, 0),
    missingPages: report.sections.reduce((n, s) => n + (s.expectedMissingPagePaths?.length ?? 0), 0),
    leftover: report.sections.reduce((n, s) => n + s.leftover.length, 0),
    orphaned: report.sections.reduce((n, s) => n + s.orphaned.length, 0),
    manifestUnknown: report.sections.filter((s) => s.pageManifest !== 'ok').length,
    unknown: report.sections.reduce((n, s) => n + s.unknown.length, 0),
  };
  fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
  fs.writeFileSync(path.resolve(args.out), `${JSON.stringify(report, null, 2)}\n`);
  if (report.skipped) console.log(`[reconcile-sections] rimandato: ${report.skipped}`);
  console.log(
    `[reconcile-sections] corpus @${String(report.apiCommit).slice(0, 8)} — sezioni live ${report.counts.sections}, ` +
      `da ripubblicare ${report.counts.dispatch}, landing non sincronizzate ${report.counts.landingContentStale}, pagine mancanti ${report.counts.missingPages}, articoli mancanti ${report.counts.missing} (oltre il cap ${report.counts.leftover}), ` +
      `orfane ${report.counts.orphaned}, manifest non verificabili ${report.counts.manifestUnknown}, ` +
      `non verificabili ${report.counts.unknown}`,
  );
  for (const s of report.sections.filter((x) => x.dispatch)) {
    console.log(
      `  ${s.section}: articoli ${s.selected.join(', ') || '—'}; ` +
      `pagine di sezione mancanti ${s.sectionMissing.length}; orfane ${s.orphaned.length}`,
    );
  }
  return 0;
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
      console.error(`::error::[reconcile-sections] ${error?.message ?? error}`);
      process.exitCode = 1;
    },
  );
}
