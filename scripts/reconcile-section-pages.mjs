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

export const API_BASE_DEFAULT = 'https://nanakokyobashi-rgb.github.io/frontaliere-articles';
export const CDN_BASE = 'https://cdn.frontaliereticino.ch';
const LOCALES = ['it', 'en', 'de', 'fr'];
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
) {
  if (attempt >= maxAttempts) return true;
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
export function parseRetryAfter(response, nowMs = Date.now()) {
  let raw;
  try {
    raw = response?.headers?.get?.('retry-after');
  } catch {
    return null;
  }
  if (raw === null || raw === undefined) return null;
  const value = String(raw).trim();
  if (!value) return null;

  let delayMs;
  if (/^\d+$/.test(value)) {
    const seconds = Number(value);
    delayMs = Number.isFinite(seconds) ? seconds * 1000 : Number.NaN;
  } else {
    const retryAtMs = Date.parse(value);
    delayMs = Number.isFinite(retryAtMs) && Number.isFinite(nowMs)
      ? retryAtMs - nowMs
      : Number.NaN;
  }
  if (!Number.isFinite(delayMs)) return null;
  return Math.min(RECONCILE_FETCH_MAX_RETRY_AFTER_MS, Math.max(0, Math.ceil(delayMs)));
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
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error('budgetMs deve essere una durata positiva finita');
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
    const states = await mapLimit(expected, 8, (page) => headState(cdnUrlFor(page.path), fetchImpl, fetchOptions));
    const activeRows = rows.filter((row) => row.section === entry.id);
    const activeIds = activeRows.length
      ? new Set(activeRows.map((row) => row.id))
      : new Set(Object.keys(slugs.cantons?.[entry.id] ?? {}));
    const pageManifest = await fetchPageManifest(pageManifestUrl(entry.id, CDN_BASE), { fetchImpl, section: entry.id });
    let orphanPages = [];
    if (pageManifest.state === 'ok') {
      const candidates = orphanedArticleCandidates(entry, pageManifest.doc, slugs.cantons?.[entry.id] ?? {}, activeIds);
      const orphanStates = await mapLimit(candidates, 8, (page) => headState(cdnUrlFor(page.path), fetchImpl, fetchOptions));
      orphanPages = candidates.map((page, i) => ({ ...page, state: orphanStates[i] }));
    }
    const plan = planSectionBackfill(entry.id, expected.map((page, i) => ({ ...page, state: states[i] })), dateById, cap, orphanPages);
    plan.pageManifest = pageManifest.state;
    if (pageManifest.reason) plan.pageManifestReason = pageManifest.reason;
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
      `da ripubblicare ${report.counts.dispatch}, pagine mancanti ${report.counts.missingPages}, articoli mancanti ${report.counts.missing} (oltre il cap ${report.counts.leftover}), ` +
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
