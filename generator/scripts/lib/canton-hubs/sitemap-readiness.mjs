const defaultSleep = (durationMs) => new Promise((resolve) => setTimeout(resolve, durationMs));

const SITEMAP_LOC_RE = /<(?:[a-z]+:)?loc>\s*(?:<!\[CDATA\[)?\s*([^<\]\s]+)\s*(?:\]\]>)?\s*<\/(?:[a-z]+:)?loc>/g;
const EDGE_SECTION_REGISTRY = 'edge/sections/registry.json';

export function sitemapUrls(xml) {
  const text = String(xml ?? '');
  const urls = new Set([...text.matchAll(SITEMAP_LOC_RE)].map((match) => urlPath(match[1].replace(/&amp;/g, '&'))));
  for (const tag of text.matchAll(/<(?:[a-z]+:)?link\b[^>]*>/g)) {
    if (!/\bhreflang\s*=/.test(tag[0])) continue;
    const href = /\bhref\s*=\s*["']([^"']+)["']/.exec(tag[0]);
    if (href) urls.add(urlPath(href[1].replace(/&amp;/g, '&')));
  }
  urls.delete('');
  return [...urls];
}

function urlPath(value) {
  try {
    return new URL(String(value), 'https://frontaliereticino.ch').pathname;
  } catch {
    return '';
  }
}

/** Confronta URL attese con loc e alternate hreflang della sitemap pubblica. */
export function sitemapContainsUrls(xml, expectedUrls) {
  const published = new Set(sitemapUrls(xml));
  const missing = [...new Set((expectedUrls ?? []).map(urlPath))].filter((url) => !published.has(url));
  return { ready: missing.length === 0, missing };
}

/**
 * Legge l'aspettativa dal Pages artifact creato dal publisher stesso. Il
 * manifest e il registro edge devono appartenere allo stesso commit; per una
 * sezione live la sitemap deve essere presente e coerente con i byte dichiarati.
 * Draft/retired sono intenzionalmente non pubbliche e non possono portare una
 * sitemap nell'artefatto.
 */
export function resolveStagedCantonSitemap({ section, manifest, edgeRegistryText, sitemapFile, sitemapXml }) {
  if (!/^canton-[a-z]+$/.test(String(section ?? ''))) throw new Error(`sezione cantonale non valida: ${section}`);
  if (!manifest || typeof manifest !== 'object' || typeof manifest.commit !== 'string' || !manifest.files || typeof manifest.files !== 'object') {
    throw new Error('Pages artifact manifest.json non valido');
  }
  if (typeof edgeRegistryText !== 'string') throw new Error('Pages artifact senza edge/sections/registry.json');
  const edgeBytes = Buffer.byteLength(edgeRegistryText, 'utf8');
  if (manifest.files[EDGE_SECTION_REGISTRY] !== edgeBytes) {
    throw new Error('manifest.json non descrive i byte di edge/sections/registry.json');
  }

  let edgeRegistry;
  try {
    edgeRegistry = JSON.parse(edgeRegistryText);
  } catch (error) {
    throw new Error(`edge/sections/registry.json non valido: ${error.message}`, { cause: error });
  }
  if (edgeRegistry?.commit !== manifest.commit || !edgeRegistry.sections || typeof edgeRegistry.sections !== 'object') {
    throw new Error('manifest.json e edge/sections/registry.json non appartengono alla stessa release');
  }
  const status = edgeRegistry.sections[section]?.status;
  if (!['live', 'draft', 'retired'].includes(status)) {
    throw new Error(`release publisher senza stato valido per ${section}`);
  }
  if (sitemapFile !== `sitemap-articles-${section}.xml`) {
    throw new Error(`nome sitemap non canonico per ${section}`);
  }
  const declaredBytes = manifest.files[sitemapFile];
  if (status !== 'live') {
    if (declaredBytes !== undefined || sitemapXml != null) {
      throw new Error(`${section} e' ${status} ma l'artefatto include ${sitemapFile}`);
    }
    return { section, status, sitemapFile, urls: [] };
  }
  if (!Number.isSafeInteger(declaredBytes) || typeof sitemapXml !== 'string') {
    throw new Error(`${section} e' live ma l'artefatto publisher non contiene ${sitemapFile}`);
  }
  if (Buffer.byteLength(sitemapXml, 'utf8') !== declaredBytes) {
    throw new Error(`manifest.json non descrive i byte di ${sitemapFile}`);
  }
  const urls = sitemapUrls(sitemapXml);
  if (urls.length === 0) throw new Error(`${sitemapFile} del publisher non contiene URL`);
  return { section, status, sitemapFile, urls };
}

/**
 * Ritenta una verifica pubblica fino alla prova positiva o alla scadenza.
 * Un errore di rete e un link ancora assente sono entrambi non-readiness: non
 * vengono mai trasformati in successo quando il budget termina.
 */
export async function waitForSitemapReadiness({
  probe,
  timeoutMs = 10 * 60_000,
  intervalMs = 20_000,
  now = Date.now,
  sleep = defaultSleep,
} = {}) {
  if (typeof probe !== 'function') throw new TypeError('sitemap readiness richiede una funzione probe');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RangeError('timeoutMs deve essere positivo');
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new RangeError('intervalMs deve essere positivo');
  if (typeof now !== 'function' || typeof sleep !== 'function') throw new TypeError('clock/sleep non validi');

  const deadline = now() + timeoutMs;
  let attempt = 0;
  let lastFailure = 'nessun link atteso trovato';
  while (true) {
    if (now() >= deadline) {
      throw new Error(`sitemap non pronta dopo ${attempt} tentativi: ${lastFailure}`);
    }
    attempt += 1;
    const remainingMs = Math.max(0, deadline - now());
    try {
      const result = await probe({ attempt, remainingMs });
      if (result === true || result?.ready === true) return { attempts: attempt, ready: true };
      if (result?.reason) lastFailure = String(result.reason);
    } catch (error) {
      lastFailure = String(error?.message || error);
    }

    const waitMs = Math.min(intervalMs, deadline - now());
    if (waitMs <= 0) {
      throw new Error(`sitemap non pronta dopo ${attempt} tentativi: ${lastFailure}`);
    }
    await sleep(waitMs);
  }
}
