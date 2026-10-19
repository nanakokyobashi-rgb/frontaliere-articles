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
 * Uso: node scripts/reconcile-section-pages.mjs --out <report.json> [--cap N]
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
  const knownMissingPagePaths = [...new Set(missing.map((page) => page.path))];
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
    knownMissingPagePaths,
    leftover: missingIds.slice(n),
    // Un giro di sola sezione (ids vuoti) serve quando manca una pagina di
    // sezione e nessun articolo: con articoli selezionati la sezione viene
    // comunque resa per intero dallo stesso publish.
    dispatch: missingIds.length > 0 || sectionMissing.length > 0 || orphaned.length > 0,
  };
}

async function getJson(url, fetchImpl) {
  const res = await fetchWithRefTimeout(`${url}?_rcb=${Date.now()}`, { headers: { 'user-agent': UA } }, 30000, fetchImpl);
  if (!res.ok) {
    releaseFetchWithRefTimeout(res);
    throw new Error(`${url}: HTTP ${res.status}`);
  }
  return res.json();
}

/**
 * Legge il registry candidato su Pages conservando la differenza fra 404
 * (build-api non lo ha pubblicato, tipicamente per un gate Remote Config non
 * verificato) e una risposta corrotta/non verificabile. Entrambi fermano il
 * backfill, ma il report deve dire quale superficie manca.
 */
async function getJsonState(url, fetchImpl) {
  try {
    const res = await fetchWithRefTimeout(`${url}?_rcb=${Date.now()}`, { headers: { 'user-agent': UA } }, 30000, fetchImpl);
    if (res.status === 404) {
      releaseFetchWithRefTimeout(res);
      return { state: 'absent', url, status: 404 };
    }
    if (!res.ok) {
      const status = res.status;
      releaseFetchWithRefTimeout(res);
      return { state: 'unknown', url, status, reason: `HTTP ${status}` };
    }
    return { state: 'ok', url, status: res.status, value: await res.json() };
  } catch (error) {
    return { state: 'unknown', url, reason: error?.message ?? String(error) };
  }
}

async function getText(url, fetchImpl) {
  const res = await fetchWithRefTimeout(`${url}?_rcb=${Date.now()}`, { headers: { 'user-agent': UA } }, 30000, fetchImpl);
  if (!res.ok) {
    releaseFetchWithRefTimeout(res);
    throw new Error(`${url}: HTTP ${res.status}`);
  }
  return res.text();
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
export async function headState(url, fetchImpl = fetch) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const request = (method) => fetchWithRefTimeout(`${url}?_rcb=${Date.now()}.${attempt}.${method.toLowerCase()}`, {
        method,
        headers: { 'user-agent': UA },
      }, 15000, fetchImpl);
      const res = await request('HEAD');
      if (res.status === 200) {
        releaseFetchWithRefTimeout(res);
        return 'present';
      }
      if (res.status === 404) {
        releaseFetchWithRefTimeout(res);
        return 'missing';
      }
      releaseFetchWithRefTimeout(res);
      if (res.status !== 405 && res.status !== 501) continue;
      const get = await request('GET');
      if (get.status === 200) {
        releaseFetchWithRefTimeout(get);
        return 'present';
      }
      if (get.status === 404) {
        releaseFetchWithRefTimeout(get);
        return 'missing';
      }
      releaseFetchWithRefTimeout(get);
    } catch {
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
export async function reconcile({ apiBase = API_BASE_DEFAULT, cap = 3, fetchImpl = fetch } = {}) {
  const [manifest, catalog, slugs, candidateRegistryResult, edgeRegistry] = await Promise.all(
    ['manifest.json', 'sections.json', 'slugs.json'].map((name) => getJson(`${apiBase}/${name}`, fetchImpl)).concat(
      getJsonState(`${apiBase}/edge/sections/registry.json`, fetchImpl),
      getJson(`${CDN_BASE}/edge/sections/registry.json`, fetchImpl),
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
  const rows = await getJson(`${apiBase}/canton-articles.json`, fetchImpl);
  const dateById = new Map(rows.map((row) => [row.id, row.updatedAt || row.date || '']));
  const sections = [];
  for (const entry of live) {
    const sitemapUrl = `${apiBase}${entry.sitemap}`;
    let sitemapXml;
    try {
      sitemapXml = await getText(sitemapUrl, fetchImpl);
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
    const states = await mapLimit(expected, 8, (page) => headState(cdnUrlFor(page.path), fetchImpl));
    const activeRows = rows.filter((row) => row.section === entry.id);
    const activeIds = activeRows.length
      ? new Set(activeRows.map((row) => row.id))
      : new Set(Object.keys(slugs.cantons?.[entry.id] ?? {}));
    const pageManifest = await fetchPageManifest(pageManifestUrl(entry.id, CDN_BASE), { fetchImpl, section: entry.id });
    let orphanPages = [];
    if (pageManifest.state === 'ok') {
      const candidates = orphanedArticleCandidates(entry, pageManifest.doc, slugs.cantons?.[entry.id] ?? {}, activeIds);
      const orphanStates = await mapLimit(candidates, 8, (page) => headState(cdnUrlFor(page.path), fetchImpl));
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
    if (argv[i] === '--out' || argv[i] === '--cap') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${argv[i]} richiede un valore`);
      args[argv[i].slice(2)] = value;
      i++;
    } else throw new Error(`argomento sconosciuto: ${argv[i]} (uso: --out <report.json> [--cap N])`);
  }
  if (!args.out) throw new Error('manca --out <report.json>');
  const cap = Number(args.cap ?? process.env.RECONCILE_SECTION_CAP ?? 3);
  const apiBase = (process.env.RECONCILE_API_BASE || API_BASE_DEFAULT).replace(/\/+$/, '');
  const report = await reconcile({ apiBase, cap });
  report.counts = {
    sections: report.sections.length,
    dispatch: report.sections.filter((s) => s.dispatch).length,
    missing: report.sections.reduce((n, s) => n + s.missingIds.length, 0),
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
      `da ripubblicare ${report.counts.dispatch}, articoli mancanti ${report.counts.missing} (oltre il cap ${report.counts.leftover}), ` +
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
