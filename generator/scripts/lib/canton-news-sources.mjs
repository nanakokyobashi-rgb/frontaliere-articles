/**
 * canton-news-sources.mjs — lo scanner delle fonti news delle sezioni
 * cantonali (P6b, D10/D14). Le fonti vengono da `newsSources` di
 * `generator/data/canton-sections.json`: ognuna dichiara un `parser` e i
 * `quirks` misurati da E-src il 2026-10-05.
 *
 * Lo scanner delle sezioni storiche (`scanNewsSources` in create-article.mjs)
 * sa leggere solo RSS/Atom e link `<a>` di una pagina HTML. Qui si aggiungono i
 * formati che le fonti cantonali usano davvero, e si RIUSANO gli estrattori
 * esistenti (`extractRssItems`, `extractHeadlines`, iniettati dal chiamante:
 * vivono in create-article.mjs, che non e' importabile senza `npm ci`):
 *
 *   - `rss` / `atom`       → `extractRssItems`
 *   - `html-links`         → `extractHeadlines`
 *   - `json-entities`      → la lista e' un JSON HTML-escaped nell'attributo
 *                            `data-entities` (iCMS di NW, OW, SH): nessun `<a>`
 *                            nel sorgente, l'estrattore HTML ne trova zero
 *   - `json-api`           → zh.ch (`{news:[{title,date,link,teaserText}]}`) e
 *                            be.ch (`[{id,publishOn,contentList:[{title,lead}]}]`)
 *   - `news-sitemap` / `sitemap` → `<url><loc>` con `news:title` e
 *                            `news:publication_date` (o `lastmod`)
 *   - `weekly-sitemap`     → sitemap a periodo (`sitemap_<AAAA><settimana ISO>.xml`
 *                            di Pomona/ajour, `<AAAA>-<MM>-medias.xml` di Canal
 *                            Alpha): l'URL del profilo e' un ESEMPIO, il periodo
 *                            corrente (e il precedente, se il budget lo consente)
 *                            si calcolano dalla data.
 *
 * E i quirk dichiarati dal profilo:
 *
 *   - `crawlDelaySeconds`  → richieste allo stesso host distanziate di almeno
 *                            tanto; sopra `MAX_INLINE_CRAWL_DELAY_SECONDS` una
 *                            sola richiesta per host per run (500 s non si
 *                            aspettano dentro un run, si rispettano fra un run e
 *                            l'altro, che sono ore)
 *   - `maxRequestsPerRun`  → tetto di richieste per la fonte
 *   - `emptyPubDate`       → nessuna data dal feed: le voci restano SENZA data e
 *                            passano dalla quota undated esistente; la data vera
 *                            la legge dalla pagina `fetchPageContent` al momento
 *                            della generazione (gate di freschezza)
 *   - `charset`            → forza la decodifica; senza, vale il charset
 *                            dichiarato (header `Content-Type`, prologo XML,
 *                            `<meta charset>`), poi UTF-8
 *   - `http1Only`          → `fetch` di Node (undici) parla HTTP/1.1 se non gli
 *                            si chiede `allowH2`, e questo modulo non lo fa mai:
 *                            il quirk e' rispettato per costruzione
 *   - `paywall: title+lead`→ della fonte si leggono solo titolo e attacco: il
 *                            lead del feed viaggia con la headline (`lead`) e fa
 *                            da sommario al classifier
 *   - `datetimeYearOffset` → `<time datetime>` con l'anno sbagliato (ur.ch:
 *                            2626): le date oltre domani si correggono dell'offset
 *
 * User-Agent onesto (D10: niente UA camuffato), lo stesso dei crawler eventi.
 */

/** UA dichiarato delle richieste alle fonti cantonali (D10). */
export const CANTON_SOURCE_USER_AGENT = 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch)';

/** Oltre questa attesa fra due richieste allo stesso host, una sola richiesta per run. */
export const MAX_INLINE_CRAWL_DELAY_SECONDS = 60;

/** Timeout di una richiesta, come lo scanner storico. */
export const CANTON_SOURCE_TIMEOUT_MS = 15_000;

/**
 * `Accept-Language` della richiesta: la lingua della fonte, poi qualunque.
 * Non e' cosmesi: senza, `fetch` di Node manda `*` e l'API news di be.ch
 * risponde 500 a ogni richiesta (misurato il 2026-10-05; con `de` risponde
 * 200 come al probe di E-src, fatto con curl che l'header non lo manda).
 */
export function acceptLanguageFor(source) {
  const lang = /^[a-z]{2}$/.test(String(source?.language || '')) ? source.language : 'de';
  return `${lang}, *;q=0.5`;
}

/** I parser che questo modulo sa eseguire. */
export const SUPPORTED_CANTON_PARSERS = Object.freeze([
  'rss', 'atom', 'html-links', 'json-entities', 'json-api', 'news-sitemap', 'sitemap', 'weekly-sitemap',
]);

// ── Decodifica ───────────────────────────────────────────────────────────────

/** Il charset dichiarato da un header `Content-Type`, o null. */
export function charsetFromContentType(contentType) {
  const m = /charset\s*=\s*["']?([\w.:-]+)/i.exec(String(contentType || ''));
  return m ? m[1].toLowerCase() : null;
}

/** Il charset dichiarato DENTRO il documento (prologo XML o meta HTML), o null. */
export function charsetFromDocumentHead(asciiHead) {
  const head = String(asciiHead || '');
  const xml = /<\?xml[^>]*\bencoding\s*=\s*["']([\w.:-]+)["']/i.exec(head);
  if (xml) return xml[1].toLowerCase();
  const meta = /<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i.exec(head);
  return meta ? meta[1].toLowerCase() : null;
}

/**
 * Decodifica il corpo di una risposta. Ordine: quirk `charset`, header,
 * documento, UTF-8. Un charset che TextDecoder non conosce ricade su UTF-8.
 *
 * @param {Uint8Array | ArrayBuffer} body
 * @param {{ contentType?: string | null, forcedCharset?: string | null }} [opts]
 * @returns {{ text: string, charset: string }}
 */
export function decodeResponseBody(body, { contentType = null, forcedCharset = null } = {}) {
  const bytes = body instanceof Uint8Array ? body : new Uint8Array(body);
  const head = Buffer.from(bytes.subarray(0, 1024)).toString('latin1');
  const declared = forcedCharset || charsetFromContentType(contentType) || charsetFromDocumentHead(head) || 'utf-8';
  let charset = declared.toLowerCase();
  let decoder;
  try {
    decoder = new TextDecoder(charset);
  } catch {
    charset = 'utf-8';
    decoder = new TextDecoder('utf-8');
  }
  return { text: decoder.decode(bytes), charset };
}

// ── Entita' e testo ──────────────────────────────────────────────────────────

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Decodifica le entita' HTML (nominate di base, decimali, esadecimali). */
export function decodeHtmlEntities(value) {
  return String(value || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    const named = NAMED_ENTITIES[code.toLowerCase()];
    return named === undefined ? m : named;
  });
}

function stripTags(value) {
  return decodeHtmlEntities(String(value || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function absoluteUrl(href, base) {
  try {
    const u = new URL(String(href || '').trim(), base);
    return /^https?:$/.test(u.protocol) ? u.href : null;
  } catch {
    return null;
  }
}

function validDate(raw) {
  if (!raw) return null;
  const d = raw instanceof Date ? raw : new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** `dd.mm.yyyy` (e `dd.mm.yyyy hh:mm`) → Date locale, o null. */
export function parseDottedDate(raw) {
  const m = /^\s*(\d{1,2})\.(\d{1,2})\.(\d{4})(?:[\sT]+(\d{1,2}):(\d{2}))?/.exec(String(raw || ''));
  if (!m) return null;
  const d = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]), Number(m[4] || 0), Number(m[5] || 0));
  return d.getDate() === Number(m[1]) && d.getMonth() === Number(m[2]) - 1 ? d : null;
}

/** `2026-08-28 07:58:00` (spazio, non `T`) → Date locale, o null. */
function parseSqlDateTime(raw) {
  const m = /^\s*(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?\s*$/.exec(String(raw || ''));
  if (!m) return null;
  return validDate(new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] || 0), Number(m[5] || 0), Number(m[6] || 0)));
}

// ── Parser ───────────────────────────────────────────────────────────────────

/**
 * `json-entities`: la lista iCMS (nw.ch, ow.ch, stadt-schaffhausen.ch) e' un
 * JSON HTML-escaped nell'attributo `data-entities`, righe `{ name: '<a
 * href="/_rte/information/<id>">titolo</a>', datum: 'dd.mm.yyyy', _datum:
 * 'yyyy-mm-dd hh:mm:ss' }`.
 *
 * @param {string} html
 * @param {string} pageUrl
 * @returns {Array<{url: string, headline: string, date: Date | null}>}
 */
export function extractJsonEntitiesItems(html, pageUrl) {
  const out = [];
  const attrRe = /data-entities\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
  let m;
  while ((m = attrRe.exec(String(html || ''))) !== null) {
    let parsed;
    try {
      parsed = JSON.parse(decodeHtmlEntities(m[1] ?? m[2] ?? ''));
    } catch {
      continue;
    }
    const rows = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.data) ? parsed.data : [];
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      const name = String(row.name ?? row.title ?? '');
      const hrefMatch = /href\s*=\s*["']([^"']+)["']/i.exec(name);
      const url = absoluteUrl(hrefMatch?.[1] ?? row.url ?? row.link, pageUrl);
      const headline = stripTags(name);
      if (!url || headline.length < 10) continue;
      const date = parseSqlDateTime(row._datum) || parseDottedDate(row.datum) || null;
      out.push({ url, headline, date });
    }
  }
  return dedupByUrl(out);
}

/**
 * `json-api`: le due API cantonali del profilo, riconosciute dalla forma.
 *   - zh.ch: `{ news: [{ title, date: 'dd.mm.yyyy', link: '/de/…', teaserText }] }`
 *   - be.ch: `[{ id, publishOn, contentList: [{ title, lead, languageCode }] }]`,
 *     pagina pubblica `https://www.be.ch/<lingua>/start.html?newsID=<id>` (la
 *     forma che la news sitemap di be.ch elenca)
 * Una forma diversa torna [] e la fonte risulta sterile: un'API non
 * documentata che cambia forma si deve vedere nel log, non indovinare.
 *
 * @param {string} text
 * @param {string} apiUrl
 * @returns {Array<{url: string, headline: string, date: Date | null, lead?: string}>}
 */
export function extractJsonApiItems(text, apiUrl) {
  let data;
  try {
    data = JSON.parse(String(text || ''));
  } catch {
    return [];
  }
  const out = [];
  if (data && Array.isArray(data.news)) {
    for (const n of data.news) {
      const url = absoluteUrl(n?.link, apiUrl);
      const headline = stripTags(n?.title);
      if (!url || headline.length < 10) continue;
      const lead = stripTags(n?.teaserText);
      out.push({ url, headline, date: parseDottedDate(n?.date), ...(lead ? { lead } : {}) });
    }
    return dedupByUrl(out);
  }
  if (Array.isArray(data) && data.some((n) => Array.isArray(n?.contentList))) {
    const origin = 'https://www.be.ch';
    for (const n of data) {
      const content = Array.isArray(n?.contentList) ? n.contentList.find((c) => c && c.enabled !== false && c.title) : null;
      if (!n?.id || !content) continue;
      const lang = /^[a-z]{2}$/.test(String(content.languageCode || '')) ? content.languageCode : 'de';
      const headline = stripTags(content.title);
      if (headline.length < 10) continue;
      const lead = stripTags(content.lead);
      out.push({
        url: `${origin}/${lang}/start.html?newsID=${encodeURIComponent(n.id)}`,
        headline,
        date: validDate(n.publishOn),
        ...(lead ? { lead } : {}),
      });
    }
    return dedupByUrl(out);
  }
  return [];
}

/** Un titolo leggibile dall'ultimo segmento di un URL (`…/glarus/strasse-gesperrt-123` → «strasse gesperrt»). */
export function headlineFromUrlSlug(url) {
  try {
    const seg = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || '');
    const words = seg.replace(/\.[a-z]{2,5}$/i, '').split(/[-_]+/).filter((w) => w && !/^\d+$/.test(w) && !/^[a-z]?\d{4,}$/i.test(w));
    return words.join(' ').trim();
  } catch {
    return '';
  }
}

/**
 * `news-sitemap` / `sitemap` / `weekly-sitemap`: voci `<url>` con `news:title` e
 * `news:publication_date`; senza `news:*`, `lastmod` e un titolo dallo slug
 * (`titleFromSlug: true`, la sitemap di suedostschweiz non porta titoli).
 *
 * @param {string} xml
 * @param {string} sitemapUrl
 * @returns {Array<{url: string, headline: string, date: Date | null, language?: string, titleFromSlug?: boolean}>}
 */
export function extractSitemapNewsItems(xml, sitemapUrl) {
  const out = [];
  const urlRe = /<url[\s>][\s\S]*?<\/url>/gi;
  let m;
  while ((m = urlRe.exec(String(xml || ''))) !== null) {
    const block = m[0];
    const loc = /<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]]+?)\s*(?:\]\]>)?\s*<\/loc>/i.exec(block);
    const url = absoluteUrl(decodeHtmlEntities(loc?.[1] || ''), sitemapUrl);
    if (!url) continue;
    const title = /<news:title>([\s\S]*?)<\/news:title>/i.exec(block);
    const pub = /<news:publication_date>([\s\S]*?)<\/news:publication_date>/i.exec(block)
      || /<lastmod>([\s\S]*?)<\/lastmod>/i.exec(block);
    const lang = /<news:language>([\s\S]*?)<\/news:language>/i.exec(block);
    let headline = stripTags(title?.[1] || '');
    let titleFromSlug = false;
    if (!headline) {
      headline = headlineFromUrlSlug(url);
      titleFromSlug = true;
    }
    if (headline.length < 10) continue;
    out.push({
      url,
      headline,
      date: validDate(stripTags(pub?.[1] || '')),
      ...(lang ? { language: stripTags(lang[1]) } : {}),
      ...(titleFromSlug ? { titleFromSlug: true } : {}),
    });
  }
  return dedupByUrl(out);
}

/**
 * Il lead (`<description>`) di ogni item RSS, per link. Serve alle fonti
 * `paywall: title+lead`, dove l'attacco del feed e' tutto cio' che si legge.
 *
 * @param {string} xml
 * @param {string} feedUrl
 * @returns {Map<string, string>}
 */
export function rssItemLeads(xml, feedUrl) {
  const leads = new Map();
  const itemRe = /<(item|entry)[\s>][\s\S]*?<\/\1>/gi;
  let m;
  while ((m = itemRe.exec(String(xml || ''))) !== null) {
    const block = m[0];
    const link = /<link[^>]*href=["']([^"']+)["']/i.exec(block)
      || /<link[^>]*>\s*(?:<!\[CDATA\[)?\s*([^<\]\s]+)\s*(?:\]\]>)?\s*<\/link>/i.exec(block);
    const desc = /<description[^>]*>([\s\S]*?)<\/description>/i.exec(block)
      || /<summary[^>]*>([\s\S]*?)<\/summary>/i.exec(block);
    const url = absoluteUrl(link?.[1], feedUrl);
    const lead = stripTags(desc?.[1] || '').slice(0, 600);
    if (url && lead) leads.set(url, lead);
  }
  return leads;
}

function dedupByUrl(items) {
  const seen = new Set();
  return items.filter((it) => {
    if (seen.has(it.url)) return false;
    seen.add(it.url);
    return true;
  });
}

// ── Periodi delle sitemap ────────────────────────────────────────────────────

/** Settimana ISO (anno ISO, numero) di una data, in UTC. */
export function isoWeekOf(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return { year: d.getUTCFullYear(), week: Math.ceil(((d - yearStart) / 86_400_000 + 1) / 7) };
}

/** Inizio (UTC) del periodo che contiene `date`. */
function periodStart(period, date) {
  if (period === 'iso-week') {
    const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() || 7) - 1));
    return d;
  }
  if (period === 'month') return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  return new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
}

/** Un istante del periodo precedente a quello che contiene `date`. */
function previousPeriodDate(period, date) {
  const start = periodStart(period, date);
  return new Date(start.getTime() - 86_400_000);
}

const PERIOD_TOKEN = {
  'iso-week': { re: /(\d{4})(\d{2})(?=\.xml\b)/, render: (d) => { const { year, week } = isoWeekOf(d); return `${year}${String(week).padStart(2, '0')}`; } },
  month: { re: /(\d{4})-(\d{2})(?=[-./])/, render: (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}` },
  year: { re: /(?<!\d)(20\d{2})(?!\d)/, render: (d) => String(d.getUTCFullYear()) },
};

/**
 * Gli URL del periodo corrente e del precedente, a partire dall'URL d'esempio
 * del profilo. Con budget 1 si sceglie il periodo che copre meglio la finestra
 * di recency: all'inizio di un periodo (meno di `freshDays` trascorsi) e' il
 * precedente a contenere le notizie degli ultimi giorni.
 *
 * @param {string} sampleUrl
 * @param {'iso-week' | 'month' | 'year'} period
 * @param {{ now?: Date, budget?: number, freshDays?: number }} [opts]
 * @returns {string[]}
 */
export function periodSitemapUrls(sampleUrl, period, { now = new Date(), budget = 2, freshDays = 1.5 } = {}) {
  const token = PERIOD_TOKEN[period];
  if (!token || !token.re.test(sampleUrl)) return [sampleUrl];
  const current = sampleUrl.replace(token.re, token.render(now));
  const previous = sampleUrl.replace(token.re, token.render(previousPeriodDate(period, now)));
  if (budget >= 2) return current === previous ? [current] : [current, previous];
  const elapsedDays = (now - periodStart(period, now)) / 86_400_000;
  return [elapsedDays < freshDays ? previous : current];
}

// ── Date con l'anno sbagliato ────────────────────────────────────────────────

/**
 * `datetimeYearOffset`: una data oltre domani e' l'anno sbagliato del CMS
 * (ur.ch scrive 2626 per 2026); si sposta di `offset` anni. Una data che anche
 * dopo la correzione resta nel futuro si scarta (senza data), mai tenuta come
 * «recente».
 */
export function applyDatetimeYearOffset(items, offset, now = new Date()) {
  const tomorrow = now.getTime() + 86_400_000;
  return items.map((it) => {
    if (!it.date || it.date.getTime() <= tomorrow) return it;
    const fixed = new Date(it.date);
    fixed.setFullYear(fixed.getFullYear() + Number(offset || 0));
    return { ...it, date: fixed.getTime() <= tomorrow ? fixed : null };
  });
}

// ── Cortesia verso l'host ────────────────────────────────────────────────────

/**
 * Quante richieste puo' fare la fonte in questo run: `maxRequestsPerRun`, e 1
 * se il crawl-delay non si puo' attendere dentro il run.
 */
export function sourceRequestBudget(source) {
  const q = source?.quirks || {};
  let budget = Number.isInteger(q.maxRequestsPerRun) && q.maxRequestsPerRun >= 1 ? q.maxRequestsPerRun : Infinity;
  if (Number(q.crawlDelaySeconds) > MAX_INLINE_CRAWL_DELAY_SECONDS) budget = Math.min(budget, 1);
  return budget;
}

/**
 * Serializza le richieste allo stesso host rispettando il crawl-delay piu'
 * severo dichiarato per quell'host. `sleep` e `now` iniettabili per i test.
 */
export function createHostThrottle({ sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => Date.now() } = {}) {
  const hosts = new Map(); // host -> { tail: Promise, last: number, used: number }
  return {
    /**
     * @param {string} host
     * @param {number} delaySeconds
     * @param {() => Promise<any>} task
     */
    run(host, delaySeconds, task) {
      const entry = hosts.get(host) || { tail: Promise.resolve(), last: 0, used: 0 };
      hosts.set(host, entry);
      const delayMs = Math.min(Number(delaySeconds) || 0, MAX_INLINE_CRAWL_DELAY_SECONDS) * 1000;
      const result = entry.tail.then(async () => {
        if (entry.used > 0 && delayMs > 0) {
          const wait = entry.last + delayMs - now();
          if (wait > 0) await sleep(wait);
        }
        entry.used += 1;
        try {
          return await task();
        } finally {
          entry.last = now();
        }
      });
      entry.tail = result.catch(() => {});
      return result;
    },
    requestsTo(host) {
      return hosts.get(host)?.used || 0;
    },
  };
}

// ── Una fonte ────────────────────────────────────────────────────────────────

/**
 * Scarica e legge UNA fonte cantonale. Restituisce le headline nella forma
 * dello scanner storico (`{ url, headline, date }` piu' `lead`/`_paywall`
 * dove serve). Lancia sull'errore di rete o HTTP: il chiamante lo conta come
 * fonte fallita, come per le fonti storiche.
 *
 * @param {{ url: string, parser: string, quirks?: object }} source
 * @param {{
 *   fetchImpl?: typeof fetch,
 *   throttle?: ReturnType<typeof createHostThrottle>,
 *   extractRssItems: (xml: string, url: string) => Array<{url: string, headline: string, date: Date | null}>,
 *   extractHeadlines: (html: string, url: string) => Array<{url: string, headline: string, date: Date | null}>,
 *   now?: Date,
 * }} ctx
 * @returns {Promise<{ headlines: Array<object>, requests: number, notes: string[] }>}
 */
export async function scanCantonSource(source, ctx) {
  const fetchImpl = ctx.fetchImpl || globalThis.fetch;
  const throttle = ctx.throttle || createHostThrottle();
  const now = ctx.now || new Date();
  const quirks = source.quirks || {};
  const budget = sourceRequestBudget(source);
  const host = new URL(source.url).hostname;
  const notes = [];
  let requests = 0;

  if (!SUPPORTED_CANTON_PARSERS.includes(source.parser)) {
    throw new Error(`parser "${source.parser}" non supportato dallo scanner cantonale`);
  }

  const get = async (url, accept) => {
    if (requests >= budget) throw new Error(`budget di ${budget} richieste per run esaurito`);
    requests += 1;
    return throttle.run(host, quirks.crawlDelaySeconds || 0, async () => {
      const res = await fetchImpl(url, {
        headers: { 'User-Agent': CANTON_SOURCE_USER_AGENT, Accept: accept, 'Accept-Language': acceptLanguageFor(source) },
        redirect: 'follow',
        signal: AbortSignal.timeout(CANTON_SOURCE_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const decoded = decodeResponseBody(await res.arrayBuffer(), {
        contentType: res.headers?.get?.('content-type') ?? null,
        forcedCharset: quirks.charset || null,
      });
      if (decoded.charset !== 'utf-8') notes.push(`charset ${decoded.charset}`);
      return decoded.text;
    });
  };

  const XML_ACCEPT = 'application/rss+xml, application/atom+xml, application/xml, text/xml';
  const HTML_ACCEPT = 'text/html,application/xhtml+xml';

  /** Una risposta → headline, secondo il parser dichiarato. */
  const extract = (text, url) => {
    switch (source.parser) {
      case 'rss':
      case 'atom': {
        const items = ctx.extractRssItems(text, url);
        if (!quirks.paywall) return items;
        const leads = rssItemLeads(text, url);
        return items.map((h) => (leads.has(h.url) ? { ...h, lead: leads.get(h.url) } : h));
      }
      case 'html-links':
        return ctx.extractHeadlines(text, url);
      case 'json-entities':
        return extractJsonEntitiesItems(text, url);
      case 'json-api':
        return extractJsonApiItems(text, url);
      default:
        // news-sitemap, sitemap, weekly-sitemap
        return extractSitemapNewsItems(text, url);
    }
  };
  const accept = ['html-links', 'json-entities'].includes(source.parser)
    ? HTML_ACCEPT
    : source.parser === 'json-api' ? 'application/json' : XML_ACCEPT;

  // Un URL a periodo (`urlPeriod`: la sitemap della settimana ISO, l'elenco
  // dei comunicati dell'anno) e' un ESEMPIO: si leggono il periodo corrente e
  // il precedente, o il solo piu' utile se il budget e' 1. `weekly-sitemap`
  // senza `urlPeriod` e' settimanale ISO per definizione.
  const period = quirks.urlPeriod || (source.parser === 'weekly-sitemap' ? 'iso-week' : null);
  const urls = period ? periodSitemapUrls(source.url, period, { now, budget: Math.min(budget, 2) }) : [source.url];
  let headlines = [];
  const failures = [];
  for (const url of urls) {
    try {
      headlines.push(...extract(await get(url, accept), url));
    } catch (err) {
      // Il periodo corrente puo' non esistere ancora (primo giorno della
      // settimana o dell'anno): e' una nota, non una fonte fallita, se un
      // altro periodo ha risposto.
      failures.push(`${url}: ${err?.message || err}`);
    }
  }
  if (failures.length === urls.length) throw new Error(failures.join('; '));
  notes.push(...failures);
  if (period) notes.push(`periodi: ${urls.map((u) => u.split('/').pop()).join(', ')}`);
  headlines = dedupByUrl(headlines);
  if (quirks.emptyPubDate) notes.push('pubDate vuoto: voci senza data (quota undated, data dalla pagina in generazione)');

  if (Number.isInteger(quirks.datetimeYearOffset)) {
    headlines = applyDatetimeYearOffset(headlines, quirks.datetimeYearOffset, now);
  }
  if (quirks.paywall) {
    headlines = headlines.map((h) => ({ ...h, _paywall: quirks.paywall }));
  }
  if (quirks.emptyPubDate) {
    headlines = headlines.map((h) => (h.date ? h : { ...h, _undatedReason: 'emptyPubDate' }));
  }
  return { headlines, requests, notes };
}
