/**
 * What the page that is online right now shows as its image, read for the
 * articles the image postcondition would keep out of the push.
 *
 * The postcondition exists so that a page with an image of its own is never
 * replaced by the generic one. An article with no page online has nothing to
 * protect: holding it back only delays it. Owner decision of 2026-10-07
 * (valerielinc-ops/frontaliere-si-o-no#12091): a new article whose declared
 * image is missing both from the checkout and from the CDN goes out at once
 * with the generic image, flagged, and a later render replaces it when the
 * image exists.
 *
 * So an article is held only when one of its pages is online with an image of
 * its own, or when the answer could not be read: a failed read is not a proof
 * that there is nothing to protect.
 */
import { extractOgImage, isGenericOgImage, normalizeImagePath } from './article-image-postcondition.mjs';

export const ONLINE_IMAGE = Object.freeze({
  ABSENT: 'absent',
  GENERIC: 'generic',
  OWN: 'own',
  UNKNOWN: 'unknown',
});

const PROBE_TIMEOUT_MS = 15_000;
// Three reads leave room for one unreadable answer before the two that confirm
// an absent page.
const PROBE_ATTEMPTS = 3;
const PROBE_CONCURRENCY = 4;
// Same query name as the publish gate of fast-publish-article.yml and as
// live-link-check.mjs on the site, so that a grep finds every probe.
const CACHE_BUST_PARAM = '_fpcb';
// The apex answers 403 to the default User-Agent of Node's fetch (measured on
// 2026-10-07: `node` 403, this one 200/404), so a probe without its own name
// would read every page as unreadable. Same name as the other reads of the
// publisher (publish-section-pages.mjs).
const PROBE_USER_AGENT = 'frontaliere-corpus-publisher/1 (+https://frontaliereticino.ch)';

function tagAttributes(tag) {
  const attrs = {};
  for (const match of String(tag).matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    attrs[String(match[1]).toLowerCase()] = match[2] ?? match[3] ?? '';
  }
  return attrs;
}

function pagePath(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  try {
    return new URL(raw, 'https://frontaliereticino.ch').pathname.replace(/\/+$/, '') || '/';
  } catch {
    return null;
  }
}

/** The paths a page declares as its own: `og:url` and the canonical link. */
function declaredPagePaths(html) {
  const paths = [];
  for (const match of String(html ?? '').matchAll(/<(?:meta|link)\b[^>]*>/gi)) {
    const attrs = tagAttributes(match[0]);
    if (String(attrs.property || '').toLowerCase() === 'og:url') paths.push(pagePath(attrs.content));
    if (String(attrs.rel || '').toLowerCase() === 'canonical') paths.push(pagePath(attrs.href));
  }
  return paths.filter(Boolean);
}

/**
 * A 404 page, a challenge or the shell of another route also answer with HTML
 * and a generic `og:image`: the answer counts as the article page only when it
 * names the requested URL as its own.
 */
export function classifyOnlinePage({ status, html = '', url }) {
  if (status === 404 || status === 410) return { state: ONLINE_IMAGE.ABSENT, reason: `HTTP ${status}` };
  if (status !== 200) return { state: ONLINE_IMAGE.UNKNOWN, reason: `HTTP ${status}` };
  const expected = pagePath(url);
  if (!expected || !declaredPagePaths(html).includes(expected)) {
    return { state: ONLINE_IMAGE.UNKNOWN, reason: 'la risposta non è la pagina richiesta' };
  }
  const image = extractOgImage(html);
  if (!image) return { state: ONLINE_IMAGE.UNKNOWN, reason: 'pagina senza og:image' };
  if (isGenericOgImage(html)) return { state: ONLINE_IMAGE.GENERIC, reason: 'og:image generico' };
  return { state: ONLINE_IMAGE.OWN, reason: `og:image ${normalizeImagePath(image)}` };
}

let probeSequence = 0;

function bustedUrl(target) {
  const busted = new URL(target.href);
  probeSequence += 1;
  busted.searchParams.set(CACHE_BUST_PARAM, `${Date.now()}-${probeSequence}`);
  return busted;
}

async function readOnlinePage(target, { fetchImpl, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(bustedUrl(target), {
      headers: { accept: 'text/html', 'cache-control': 'no-cache', 'user-agent': PROBE_USER_AGENT },
      redirect: 'manual',
      signal: controller.signal,
    });
    const status = Number(response.status);
    const html = status === 200 ? await response.text() : '';
    return classifyOnlinePage({ status, html, url: target.href });
  } catch (error) {
    const reason = error?.name === 'AbortError' ? `timeout ${Math.round(timeoutMs / 1000)}s` : error?.message || String(error);
    return { state: ONLINE_IMAGE.UNKNOWN, reason };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `absent` is the one answer that lets an article out, so it has to be read
 * twice: a single 404 during a shard deploy must not pass for a new article.
 * An unreadable answer is retried; `own` and `generic` are final at once.
 */
export async function probeOnlineImage(url, {
  fetchImpl = globalThis.fetch,
  timeoutMs = PROBE_TIMEOUT_MS,
  attempts = PROBE_ATTEMPTS,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  if (typeof fetchImpl !== 'function') return { state: ONLINE_IMAGE.UNKNOWN, reason: 'fetch non disponibile' };
  let target;
  try {
    target = new URL(String(url));
  } catch {
    return { state: ONLINE_IMAGE.UNKNOWN, reason: 'URL non valido' };
  }
  if (target.protocol !== 'https:') return { state: ONLINE_IMAGE.UNKNOWN, reason: 'URL non https' };

  let last = { state: ONLINE_IMAGE.UNKNOWN, reason: 'nessuna risposta' };
  let absentReads = 0;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    last = await readOnlinePage(target, { fetchImpl, timeoutMs });
    if (last.state === ONLINE_IMAGE.OWN || last.state === ONLINE_IMAGE.GENERIC) return last;
    if (last.state === ONLINE_IMAGE.ABSENT) {
      absentReads += 1;
      if (absentReads >= 2) return last;
    }
    if (attempt < attempts) await sleep(500 * attempt);
  }
  if (last.state === ONLINE_IMAGE.ABSENT) {
    return { state: ONLINE_IMAGE.UNKNOWN, reason: `${last.reason} non confermato da una seconda lettura` };
  }
  return last;
}

async function mapPool(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const run = async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, Math.max(1, items.length)) }, run));
  return results;
}

/**
 * Splits the articles the postcondition excluded into the ones that stay out
 * (`excludedArticles`) and the ones that go out with the generic image
 * (`releasedArticles`), and puts the latter back into the push set in the
 * order the renderer produced them. Every page of an article is read: one
 * locale online with an image of its own holds all of them, because the push
 * set is per article.
 */
export async function releaseArticlesWithNothingToProtect({
  entries = [],
  postcondition,
  probe = probeOnlineImage,
  concurrency = PROBE_CONCURRENCY,
} = {}) {
  const candidates = postcondition?.excludedArticles ?? [];
  if (candidates.length === 0) return { ...postcondition, releasedArticles: [] };

  const entryById = new Map(entries.map((entry) => [entry.articleId, entry]));
  const read = await mapPool(candidates, concurrency, async (article) => {
    const urls = Object.entries(entryById.get(article.articleId)?.urls ?? {}).filter(([, url]) => Boolean(url));
    const online = [];
    for (const [locale, url] of urls) online.push({ locale, url, ...(await probe(url)) });
    const nothingToProtect = online.length > 0
      && online.every((page) => page.state === ONLINE_IMAGE.ABSENT || page.state === ONLINE_IMAGE.GENERIC);
    return { article: { ...article, online }, nothingToProtect };
  });

  const excludedArticles = read.filter((item) => !item.nothingToProtect).map((item) => item.article);
  const releasedArticles = read.filter((item) => item.nothingToProtect).map((item) => item.article);
  const heldIds = new Set(excludedArticles.map((article) => article.articleId));
  return {
    ...postcondition,
    entries: entries.filter((entry) => !heldIds.has(entry.articleId)),
    excludedArticles,
    excludedPages: excludedArticles.reduce((sum, article) => sum + article.paths.length, 0),
    firstExcludedArticleIds: excludedArticles.slice(0, 10).map((article) => article.articleId),
    firstFallbackPaths: excludedArticles.flatMap((article) => article.fallbackPaths).slice(0, 10),
    releasedArticles,
  };
}
