/**
 * section-page-manifest.mjs — inventario delle pagine cantonali realmente
 * pubblicate dal publisher R2.
 *
 * Il manifest della release corrente viene scritto solo dopo che upload,
 * verify e cancellazioni della release sono riusciti. Durante la prima
 * migrazione, quando il manifest non esiste, il publisher può scrivere prima
 * un checkpoint dell'inventario precedente: così anche un run fallito prima
 * della prima cancellazione lascia una base leggibile al giro successivo.
 */

export const PAGE_MANIFEST_SCHEMA = 1;
export const PAGE_MANIFEST_PREFIX = 'edge/sections/_page-manifests';
export const PAGE_MANIFEST_KINDS = Object.freeze(['article', 'archive', 'hub', 'landing']);
export const PAGE_MANIFEST_LOCALES = Object.freeze(['it', 'en', 'de', 'fr']);

const CANONICAL_PATH_RE = /^\/[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*\/$/;
const REL_PATH_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*\/index\.html$/;

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function manifestCounts(pagesByKind) {
  const counts = Object.fromEntries(PAGE_MANIFEST_KINDS.map((kind) => [kind, pagesByKind[kind].length]));
  counts.total = PAGE_MANIFEST_KINDS.reduce((total, kind) => total + counts[kind], 0);
  return counts;
}

export function pageManifestKey(section) {
  if (typeof section !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(section)) {
    throw new Error(`sezione non valida per il manifest: ${section}`);
  }
  return `${PAGE_MANIFEST_PREFIX}/${section}.json`;
}

export function pageManifestUrl(section, cdnBase) {
  if (typeof cdnBase !== 'string' || !cdnBase) throw new Error('cdnBase mancante per il manifest delle pagine');
  return `${cdnBase.replace(/\/+$/, '')}/${pageManifestKey(section)}`;
}

function rowFromPage(page) {
  if (!isPlainObject(page) || !PAGE_MANIFEST_KINDS.includes(page.kind)) {
    throw new Error(`pagina non valida nel manifest: ${JSON.stringify(page)}`);
  }
  if (typeof page.rel !== 'string' || !REL_PATH_RE.test(page.rel)) throw new Error(`rel non canonico nel manifest: ${page.rel}`);
  if (typeof page.canonicalPath !== 'string' || !CANONICAL_PATH_RE.test(page.canonicalPath)) {
    throw new Error(`canonicalPath non canonico nel manifest: ${page.canonicalPath}`);
  }
  if (page.rel !== `${page.canonicalPath.slice(1)}index.html`) {
    throw new Error(`rel/canonicalPath incoerenti nel manifest: ${page.rel}`);
  }
  const expectedEdgeKey = `edge/sections${page.canonicalPath}index.html`;
  if (page.edgeKey !== expectedEdgeKey) throw new Error(`edgeKey non canonica nel manifest: ${page.edgeKey}`);
  if (!PAGE_MANIFEST_LOCALES.includes(page.locale)) throw new Error(`locale non valida nel manifest: ${page.locale}`);
  const row = {
    locale: page.locale,
    rel: page.rel,
    canonicalPath: page.canonicalPath,
    edgeKey: page.edgeKey,
  };
  if (page.kind === 'article') {
    if (typeof page.id !== 'string' || !page.id) throw new Error(`articolo senza id nel manifest: ${page.rel}`);
    row.id = page.id;
  }
  return row;
}

/** Costruisce un manifest deterministico dai page entry del publisher. */
export function pageManifestFromPages({ section, commit, pages }) {
  if (typeof commit !== 'string' || !commit) throw new Error('commit mancante nel manifest delle pagine');
  if (!Array.isArray(pages)) throw new Error('pages deve essere un array nel manifest delle pagine');
  const byKind = Object.fromEntries(PAGE_MANIFEST_KINDS.map((kind) => [kind, []]));
  const seen = new Set();
  for (const page of pages) {
    const row = rowFromPage(page);
    if (seen.has(row.edgeKey)) throw new Error(`pagina duplicata nel manifest: ${row.edgeKey}`);
    seen.add(row.edgeKey);
    byKind[page.kind].push(row);
  }
  for (const kind of PAGE_MANIFEST_KINDS) byKind[kind].sort((a, b) => a.edgeKey.localeCompare(b.edgeKey));
  return { schema: PAGE_MANIFEST_SCHEMA, section, commit, counts: manifestCounts(byKind), pages: byKind };
}

/**
 * In un giro article-only gli aggregati precedenti restano online e gli
 * articoli sani nuovi vengono aggiunti. Il manifest risultante deve quindi
 * rappresentare l'unione osservata, non una release incompleta.
 */
export function mergePageManifests(previous, current) {
  if (!previous) return current;
  if (previous.section !== current.section) throw new Error('manifest di sezioni diverse non combinabili');
  const pages = {};
  for (const kind of PAGE_MANIFEST_KINDS) {
    const rows = [...(previous.pages?.[kind] ?? []), ...(current.pages?.[kind] ?? [])];
    const byKey = new Map(rows.map((row) => [row.edgeKey, row]));
    pages[kind] = [...byKey.values()].sort((a, b) => a.edgeKey.localeCompare(b.edgeKey));
  }
  return { ...current, counts: manifestCounts(pages), pages };
}

/** Ritorna gli errori strutturali; un array vuoto significa manifest leggibile. */
export function pageManifestErrors(doc, { section } = {}) {
  const errors = [];
  if (!isPlainObject(doc)) return ['documento non oggetto'];
  if (doc.schema !== PAGE_MANIFEST_SCHEMA) errors.push(`schema ${doc.schema ?? 'assente'} inatteso`);
  if (section !== undefined && doc.section !== section) errors.push(`sezione ${doc.section ?? 'assente'} diversa da ${section}`);
  if (typeof doc.section !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(doc.section)) errors.push('sezione assente o non canonica');
  if (typeof doc.commit !== 'string' || !doc.commit) errors.push('commit assente');
  const declaredCounts = isPlainObject(doc.counts) ? doc.counts : null;
  if (!declaredCounts) {
    errors.push('counts assente o non oggetto');
  } else {
    for (const kind of PAGE_MANIFEST_KINDS) {
      if (!Number.isInteger(declaredCounts[kind]) || declaredCounts[kind] < 0) {
        errors.push(`counts.${kind} assente o non intero non negativo`);
      }
    }
    if (!Number.isInteger(declaredCounts.total) || declaredCounts.total < 0) {
      errors.push('counts.total assente o non intero non negativo');
    }
  }
  if (!isPlainObject(doc.pages)) {
    errors.push('pages assente o non oggetto');
    return errors;
  }
  const seen = new Set();
  let actualTotal = 0;
  for (const kind of PAGE_MANIFEST_KINDS) {
    const rows = doc.pages[kind];
    if (!Array.isArray(rows)) {
      errors.push(`pages.${kind} assente o non array`);
      continue;
    }
    actualTotal += rows.length;
    if (declaredCounts && Number.isInteger(declaredCounts[kind]) && declaredCounts[kind] >= 0 && declaredCounts[kind] !== rows.length) {
      errors.push(`counts.${kind}=${declaredCounts[kind]} ma pages.${kind} contiene ${rows.length} voci`);
    }
    for (const row of rows) {
      try {
        const checked = rowFromPage({ ...row, kind });
        if (seen.has(checked.edgeKey)) errors.push(`pagina duplicata: ${checked.edgeKey}`);
        seen.add(checked.edgeKey);
      } catch (error) {
        errors.push(error.message);
      }
    }
  }
  if (declaredCounts && Number.isInteger(declaredCounts.total) && declaredCounts.total >= 0 && declaredCounts.total !== actualTotal) {
    errors.push(`counts.total=${declaredCounts.total} ma pages contiene ${actualTotal} voci`);
  }
  return errors;
}

export function isValidPageManifest(doc, options) {
  return pageManifestErrors(doc, options).length === 0;
}

/** Lettura fail-closed del manifest pubblico: 404 = mai pubblicato, altro errore = unknown. */
export async function fetchPageManifest(url, { fetchImpl = fetch, section } = {}) {
  try {
    const response = await fetchImpl(`${url}${url.includes('?') ? '&' : '?'}_spm=${Date.now()}`, {
      headers: { 'user-agent': 'frontaliere-section-pages/1 (+https://frontaliereticino.ch)' },
      signal: AbortSignal.timeout(20_000),
    });
    if (response.status === 404) return { state: 'absent' };
    if (response.status !== 200 && !response.ok) return { state: 'unknown', reason: `HTTP ${response.status}` };
    const doc = await response.json();
    const errors = pageManifestErrors(doc, { section });
    return errors.length === 0 ? { state: 'ok', doc } : { state: 'unknown', reason: errors.join('; ') };
  } catch (error) {
    return { state: 'unknown', reason: error?.message ?? String(error) };
  }
}
