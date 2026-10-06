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
 *   - `articlePathPattern` → fonti `html-links`: regex su path + query dei link
 *                            che sono articoli; gli altri sono navigazione
 *                            (vedi `filterArticleLinks`)
 *   - `urlReusedForDifferentStories` → la fonte riemette lo stesso URL con
 *                            notizie diverse (ticker, «Kurzmeldungen»),
 *                            ovunque (`true`) o sui path di una regex:
 *                            l'identita' dell'item e' URL + titolo, portata
 *                            nell'URL come `#ft-item=…` (vedi
 *                            `applyItemIdentity` e `source-url-ledger.mjs`)
 *
 * Su ogni fonte `html-links` la cornice del sito (`<nav>`, header e footer di
 * pagina) si toglie prima di cercare i link: vedi `stripPageChrome`.
 *
 * User-Agent onesto (D10: niente UA camuffato), lo stesso dei crawler eventi.
 */

import {
  itemIdentityToken,
  maskInactiveMarkup as maskLedgerInactiveMarkup,
  newsUrlKey,
  withItemIdentity,
} from './source-url-ledger.mjs';

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

const CHARSET_VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'param', 'source', 'track', 'wbr',
]);
const CHARSET_RAW_TEXT_TAGS = new Set([
  'script', 'style', 'textarea', 'title', 'noscript', 'iframe', 'xmp',
  'noembed', 'noframes',
]);

function isHtmlWhitespace(char) {
  return char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === '\f';
}

function findCharsetTagEnd(html, start) {
  let quote = '';
  for (let i = start + 1; i < html.length; i++) {
    const char = html[i];
    if (quote) {
      if (char === quote) quote = '';
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '>') {
      return i;
    }
  }
  return -1;
}

function isCharsetSelfClosingStartTag(html, nameEnd, end) {
  let i = nameEnd;
  while (i < end) {
    while (i < end && isHtmlWhitespace(html[i])) i++;
    if (i >= end) return false;
    if (html[i] === '/') {
      return i + 1 === end;
    }

    while (
      i < end &&
      !isHtmlWhitespace(html[i]) &&
      html[i] !== '=' &&
      html[i] !== '/' &&
      html[i] !== '>'
    ) i++;
    if (html[i] !== '=') continue;

    i++;
    while (i < end && isHtmlWhitespace(html[i])) i++;
    if (i >= end) return false;
    const quote = html[i];
    if (quote === '"' || quote === "'") {
      i++;
      while (i < end && html[i] !== quote) i++;
      if (i >= end) return false;
      i++;
      continue;
    }
    // In HTML's unquoted attribute-value state `/` belongs to the value.
    while (i < end && !isHtmlWhitespace(html[i]) && html[i] !== '>') i++;
  }
  return false;
}

function readCharsetTag(html, start) {
  if (html[start] !== '<') return null;
  let i = start + 1;
  const closing = html[i] === '/';
  if (closing) i++;
  const nameStart = i;
  while (i < html.length && /[A-Za-z0-9:_-]/.test(html[i])) i++;
  if (i === nameStart) return null;
  const boundary = html[i] ?? '';
  if (boundary && !/[\s/>]/.test(boundary)) return null;
  const end = findCharsetTagEnd(html, start);
  if (end < 0) return null;
  const name = html.slice(nameStart, i).toLowerCase();
  return {
    closing,
    end,
    name,
    selfClosing: !closing && CHARSET_VOID_ELEMENTS.has(name)
      && isCharsetSelfClosingStartTag(html, i, end),
  };
}

function skipCharsetComment(html, start) {
  const end = html.indexOf('-->', start + 4);
  return end < 0 ? -1 : end + 3;
}

function skipCharsetRawText(html, afterOpening, name) {
  const closing = new RegExp(`</${name}\\s*>`, 'ig');
  closing.lastIndex = afterOpening;
  const match = closing.exec(html);
  return match ? match.index + match[0].length : -1;
}

function skipCharsetTemplate(html, afterOpening) {
  let depth = 1;
  let cursor = afterOpening;
  while (cursor < html.length) {
    const start = html.indexOf('<', cursor);
    if (start < 0) return -1;
    if (html.startsWith('<!--', start)) {
      const afterComment = skipCharsetComment(html, start);
      if (afterComment < 0) return -1;
      cursor = afterComment;
      continue;
    }
    const tag = readCharsetTag(html, start);
    if (!tag) {
      cursor = start + 1;
      continue;
    }
    if (tag.name === 'template') {
      if (tag.closing) {
        depth--;
        if (depth === 0) return tag.end + 1;
      } else if (!tag.selfClosing) {
        depth++;
      }
    } else if (!tag.closing && !tag.selfClosing && CHARSET_RAW_TEXT_TAGS.has(tag.name)) {
      const afterRawText = skipCharsetRawText(html, tag.end + 1, tag.name);
      if (afterRawText < 0) return -1;
      cursor = afterRawText;
      continue;
    }
    cursor = tag.end + 1;
  }
  return -1;
}

/**
 * Mask inactive markup for the charset prefix. An incomplete comment/raw-text
 * block/template masks to EOF: the prefix is deliberately treated as
 * untrusted when its closing context is outside the 1024-byte window.
 */
function maskCharsetInactiveMarkup(html) {
  const source = String(html || '');
  const output = source.split('');
  const blank = (start, end) => {
    for (let index = start; index < end; index++) output[index] = ' ';
  };
  let cursor = 0;
  while (cursor < source.length) {
    const start = source.indexOf('<', cursor);
    if (start < 0) break;
    if (source.startsWith('<!--', start)) {
      const afterComment = skipCharsetComment(source, start);
      blank(start, afterComment < 0 ? source.length : afterComment);
      if (afterComment < 0) break;
      cursor = afterComment;
      continue;
    }
    const tag = readCharsetTag(source, start);
    if (!tag) {
      cursor = start + 1;
      continue;
    }
    if (!tag.closing && !tag.selfClosing && CHARSET_RAW_TEXT_TAGS.has(tag.name)) {
      const afterRawText = skipCharsetRawText(source, tag.end + 1, tag.name);
      blank(start, afterRawText < 0 ? source.length : afterRawText);
      if (afterRawText < 0) break;
      cursor = afterRawText;
      continue;
    }
    if (tag.name === 'template' && !tag.closing && !tag.selfClosing) {
      const afterTemplate = skipCharsetTemplate(source, tag.end + 1);
      blank(start, afterTemplate < 0 ? source.length : afterTemplate);
      if (afterTemplate < 0) break;
      cursor = afterTemplate;
      continue;
    }
    cursor = tag.end + 1;
  }
  return output.join('');
}

/** Il charset dichiarato da un header `Content-Type`, o null. */
export function charsetFromContentType(contentType) {
  const m = /charset\s*=\s*["']?([\w.:-]+)/i.exec(String(contentType || ''));
  return m ? m[1].toLowerCase() : null;
}

/** Il charset dichiarato DENTRO il documento (prologo XML o meta HTML), o null. */
export function charsetFromDocumentHead(asciiHead) {
  // Only active document markup can declare the response charset. A stale
  // `<meta charset>` in a comment, template, or script must not win over the
  // real declaration that follows it.
  const head = maskCharsetInactiveMarkup(String(asciiHead || ''));
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
  let unsupported = null;
  try {
    decoder = new TextDecoder(charset);
  } catch {
    // Dichiarato ma sconosciuto a TextDecoder: si decodifica UTF-8 e lo si
    // DICE (nota della fonte), perche' il testo potrebbe essere alterato.
    unsupported = charset;
    charset = 'utf-8';
    decoder = new TextDecoder('utf-8');
  }
  return { text: decoder.decode(bytes), charset, ...(unsupported ? { unsupported } : {}) };
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

// ── Navigazione delle pagine HTML ────────────────────────────────────────────

/** Ruoli ARIA che marcano un'area di navigazione o la cornice del sito. */
const CHROME_ROLES = new Set(['navigation', 'banner', 'contentinfo']);

/**
 * I token dell'attributo `role` di un tag. Gli attributi si leggono uno per
 * uno, col loro valore fra virgolette: solo un attributo che SI CHIAMA `role`
 * conta. `data-role="navigation"` e' un altro attributo, e in
 * `<main data-note="foo role=navigation">` la scritta `role=` e' il valore di
 * un altro attributo: cercarla nel testo grezzo toglierebbe `<main>`.
 */
function roleTokens(attrs) {
  const attrRe = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m;
  while ((m = attrRe.exec(String(attrs || ''))) !== null) {
    if (m[1].toLowerCase() === 'role') return (m[2] ?? m[3] ?? m[4] ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  }
  return [];
}

/**
 * Contenitori che rendono `<header>`/`<footer>` l'intestazione di una SEZIONE
 * e non del sito: e' la regola HTML-AAM per cui un header/footer e' landmark
 * `banner`/`contentinfo` solo fuori da article, aside, main, nav e section.
 */
const SECTIONING_TAGS = new Set(['article', 'aside', 'main', 'section']);
/** Gli stessi contenitori dichiarati con `role` su un elemento qualunque (`<div role="main">`). */
const SECTIONING_ROLES = new Set(['article', 'complementary', 'main', 'region']);
/** Il contenuto principale della pagina (`<main>` o `role="main"`) sta in questo markup? */
function containsMainContent(masked) {
  const re = /<([a-zA-Z][\w-]*)\b([^>]*)>/g;
  let m;
  while ((m = re.exec(masked)) !== null) {
    if (m[1].toLowerCase() === 'main' || roleTokens(m[2]).includes('main')) return true;
  }
  return false;
}

/**
 * Le aree di navigazione e la cornice del sito tolte da una pagina HTML:
 * ogni `<nav>`, ogni elemento con `role="navigation|banner|contentinfo"`, e
 * `<header>`/`<footer>` quando sono del sito (fuori da article, aside, main,
 * section e dai loro equivalenti `role=`). Commenti, script, stile e template
 * escono resi spazi; il resto del documento resta byte per byte com'era.
 *
 * Perche' esiste (P5b, misurato il 2026-10-05): `extractHeadlines` tiene ogni
 * `<a>` con un testo di 15-300 caratteri. Sulla pagina news di eoc.ch quelli
 * sono 93 link, 9 dei quali articoli: gli altri 84 sono il menu del sito
 * («Soggiorno in ospedale», «Orari visite e sedi»), senza data. Quando nessun
 * comunicato cade nella finestra di recency la fonte cede le sue voci SENZA
 * data, cioe' il menu, e il dry-run di P6b ne ha scelta una come notizia.
 *
 * Un `<header>` dentro `<article>` resta: e' la forma WordPress del titolo
 * dell'articolo (`<article><header><h2><a>`), cioe' proprio il link da tenere.
 * Un elemento senza chiusura bilanciata resta: tagliare fino alla fine del
 * documento costerebbe piu' di qualche link di menu.
 *
 * @param {string} html
 * @returns {{ html: string, removed: number }} la pagina senza le aree, e quante
 */
export function stripPageChrome(html) {
  // Commenti, script, stile e template non sono markup della pagina: un
  // `<nav>` scritto in un template JS non apre niente, e un `<a>` li' dentro
  // non e' un link. Resi spazi a pari lunghezza (gli indici restano quelli del
  // documento), e cosi' restano anche in uscita: l'estrattore non li vede.
  const masked = maskLedgerInactiveMarkup(html);
  const tagRe = /<(\/?)([a-zA-Z][\w-]*)\b([^>]*)>/g;
  const ranges = [];
  let sectioningDepth = 0;
  // Fine degli elementi `role="main|article|…"` aperti: finche' ce n'e' uno,
  // header e footer sono di quella sezione.
  const roleSectionEnds = [];
  let m;
  while ((m = tagRe.exec(masked)) !== null) {
    const closing = m[1] === '/';
    const name = m[2].toLowerCase();
    const attrs = m[3] || '';
    while (roleSectionEnds.length > 0 && roleSectionEnds[roleSectionEnds.length - 1] <= m.index) roleSectionEnds.pop();
    if (SECTIONING_TAGS.has(name)) {
      sectioningDepth = Math.max(0, sectioningDepth + (closing ? -1 : 1));
      if (closing) continue;
    }
    if (closing || /\/\s*$/.test(attrs)) continue;
    const roles = roleTokens(attrs);
    if (!SECTIONING_TAGS.has(name) && roles.some((r) => SECTIONING_ROLES.has(r))) {
      const sectionEnd = matchingCloseEnd(masked, name, tagRe.lastIndex);
      if (sectionEnd !== -1) roleSectionEnds.push(sectionEnd);
    }
    const inSection = sectioningDepth > 0 || roleSectionEnds.length > 0;
    const isChrome = name === 'nav'
      || roles.some((r) => CHROME_ROLES.has(r))
      || ((name === 'header' || name === 'footer') && !inSection);
    if (!isChrome) continue;
    const end = matchingCloseEnd(masked, name, tagRe.lastIndex);
    if (end === -1) continue;
    // Una «navigazione» che contiene il contenuto principale e' un wrapper
    // marcato male, non un menu: aarau.ch avvolge sottomenu E `<main>` in un
    // `<div role="navigation">`, e tagliarlo toglieva 15 comunicati datati su
    // 15. Si scende dentro: i `<nav>` veri che contiene cadono lo stesso.
    if (containsMainContent(masked.slice(tagRe.lastIndex, end))) continue;
    ranges.push([m.index, end]);
    // L'area intera e' tolta: quello che contiene (anche i tag di sezione,
    // aperti E chiusi li' dentro) non sposta il conteggio.
    tagRe.lastIndex = end;
  }
  if (ranges.length === 0) return { html: masked, removed: 0 };
  let out = '';
  let at = 0;
  for (const [start, end] of ranges) {
    out += masked.slice(at, start);
    at = end;
  }
  return { html: out + masked.slice(at), removed: ranges.length };
}

/** Fine (indice dopo `</name>`) dell'elemento `name` aperto prima di `from`, o -1. */
function matchingCloseEnd(masked, name, from) {
  const re = new RegExp(`<(/?)${name}(?=[\\s/>])[^>]*>`, 'gi');
  re.lastIndex = from;
  let depth = 1;
  let m;
  while ((m = re.exec(masked)) !== null) {
    if (m[1] === '/') {
      depth -= 1;
      if (depth === 0) return re.lastIndex;
    } else if (!/\/\s*>$/.test(m[0])) {
      depth += 1;
    }
  }
  return -1;
}

/**
 * I link di una pagina `html-links` che sono articoli, tolti quelli che la
 * cornice non marca come navigazione (menu laterali in `<div>`, ricerche
 * suggerite, «salta al contenuto»). Due regole:
 *
 *   1. un link alla pagina stessa non e' mai un articolo: vale per ogni
 *      fonte. «Stessa» e' la forma canonica del ledger (`newsUrlKey`: slash
 *      finale, maiuscole dell'host, frammento e parametri di tracciamento non
 *      contano; quelli identificanti si'), non l'uguaglianza delle stringhe:
 *      `/news/` e `/news?utm_source=nav` sono l'elenco, `/news?id=7` no;
 *   2. `quirks.articlePathPattern` (regex su path + query), dove il profilo lo
 *      dichiara: restano solo i link che lo rispettano. Su eoc.ch, dopo
 *      `stripPageChrome`, restavano 7 link che non sono comunicati (le
 *      ricerche suggerite, l'elenco stesso, un sondaggio); i 9 comunicati
 *      stanno tutti sotto `/media-e-news/news/<anno>/`.
 *
 * Il pattern e' DICHIARATO per fonte e non inferito dai link datati della
 * pagina, perche' l'inferenza sbaglia proprio sulle testate: misurato il
 * 2026-10-05, su lacote.ch i soli link datati sono il widget `/flash-sport/` e
 * su lemanbleu.ch le `/fr/Emissions/`, mentre le notizie sono i link SENZA
 * data fuori da quelle cartelle. Una regola automatica le avrebbe tolte.
 *
 * @param {Array<{url: string, headline: string, date: Date | null}>} headlines
 * @param {string} pageUrl
 * @param {{ quirks?: { articlePathPattern?: string } }} [source]
 * @returns {{ headlines: Array<object>, dropped: number }}
 */
export function filterArticleLinks(headlines, pageUrl, source = {}) {
  const self = newsUrlKey(pageUrl);
  const pattern = source?.quirks?.articlePathPattern;
  const re = pattern ? new RegExp(pattern) : null;
  const kept = headlines.filter((h) => {
    if (newsUrlKey(h.url) === self) return false;
    if (!re) return true;
    try {
      const u = new URL(h.url);
      return re.test(u.pathname + u.search);
    } catch {
      return false;
    }
  });
  return { headlines: kept, dropped: headlines.length - kept.length };
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
 * @param {{ dedup?: boolean }} [opts] `dedup: false` per le fonti che riusano
 *   gli URL: li' due voci con lo stesso `<loc>` sono due notizie, e il dedup
 *   si fa dopo l'identita' dell'item (vedi `applyItemIdentity`)
 * @returns {Array<{url: string, headline: string, date: Date | null, language?: string, titleFromSlug?: boolean}>}
 */
export function extractSitemapNewsItems(xml, sitemapUrl, { dedup = true } = {}) {
  const out = [];
  // Anche con prefisso di namespace (`<sm:url>`, `<sm:loc>`): una forma non
  // riconosciuta ridurrebbe a zero la fonte in silenzio.
  const urlRe = /<(?:[\w-]+:)?url[\s>][\s\S]*?<\/(?:[\w-]+:)?url>/gi;
  let m;
  while ((m = urlRe.exec(String(xml || ''))) !== null) {
    const block = m[0];
    const loc = /<(?:[\w-]+:)?loc>\s*(?:<!\[CDATA\[)?\s*([^<\]]+?)\s*(?:\]\]>)?\s*<\/(?:[\w-]+:)?loc>/i.exec(block);
    const url = absoluteUrl(decodeHtmlEntities(loc?.[1] || ''), sitemapUrl);
    if (!url) continue;
    const title = /<news:title>([\s\S]*?)<\/news:title>/i.exec(block);
    const pub = /<news:publication_date>([\s\S]*?)<\/news:publication_date>/i.exec(block)
      || /<(?:[\w-]+:)?lastmod>([\s\S]*?)<\/(?:[\w-]+:)?lastmod>/i.exec(block);
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
  return dedup ? dedupByUrl(out) : out;
}

/**
 * Un feed RSS/Atom spezzato in un documento per voce (stesso involucro, una
 * sola `<item>`/`<entry>`). Serve alle fonti che riusano gli URL:
 * `extractRssItems` deduplica per URL DENTRO il feed, quindi due voci con lo
 * stesso `<link>` e titoli diversi — due notizie, li' — ne lascerebbero una
 * prima che l'identita' dell'item possa distinguerle. Letta una voce alla
 * volta, l'estrattore resta quello vero e non ha niente da deduplicare.
 *
 * @param {string} xml
 * @returns {string[]} un documento per voce; `[xml]` se non si riconoscono voci
 */
export function feedItemDocuments(xml) {
  const src = String(xml || '');
  const blocks = [...src.matchAll(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi)].map((m) => m[0]);
  if (blocks.length === 0) return [src];
  const isAtom = /<feed[\s>]/i.test(src.slice(0, 500));
  return blocks.map((b) => (isAtom ? `<feed xmlns="http://www.w3.org/2005/Atom">${b}</feed>` : `<rss version="2.0"><channel>${b}</channel></rss>`));
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

// ── Fonti che riusano gli URL ────────────────────────────────────────────────

/**
 * `urlReusedForDifferentStories`: l'URL della voce prende l'identita'
 * dell'item (`#ft-item=<impronta>`), cosi' due notizie allo stesso indirizzo
 * non sono piu' la stessa voce per ledger, memo del topic-gate e dedup. Il
 * perche' e la misura sono in `source-url-ledger.mjs`.
 *
 * Il quirk dice DOVE la fonte riusa gli URL:
 *   - `true`: ovunque. suedostschweiz.ch: il contenitore non si riconosce
 *     dall'indirizzo (uno e' nato come articolo su un incendio a Bonaduz);
 *   - una regex sul path: solo li'. Tamedia: `^/ticker-`. Fuori dal pattern
 *     l'URL resta l'identita', ed e' voluto: il 2026-10-05 lo stesso articolo
 *     di bazonline (`/femizid-binningen-…`) ha cambiato titolo fra due letture
 *     a 16 minuti, e con l'impronta del titolo sarebbe ripassato dal ledger
 *     come notizia nuova.
 *
 * L'impronta e' quella di `itemIdentityToken`: il titolo dato dalla fonte piu'
 * la giornata di pubblicazione, la stessa regola per feed e sitemap, cosi' lo
 * stesso item letto dall'uno e dall'altra ha una chiave sola. Dove il titolo
 * e' ricavato dallo slug (`titleFromSlug`, sitemap senza `news:title`) la voce
 * non ha un'identita' — lo slug e' proprio cio' che la fonte riusa — e si
 * scarta: la notizia arriva dal feed, che il titolo lo porta.
 *
 * @param {Array<{url: string, headline: string, date: Date | null, titleFromSlug?: boolean}>} headlines
 * @param {true | string} scope il valore del quirk
 * @returns {{ headlines: Array<object>, identified: number, dropped: number }}
 */
export function applyItemIdentity(headlines, scope = true) {
  const pathRe = typeof scope === 'string' ? new RegExp(scope) : null;
  const out = [];
  let identified = 0;
  for (const h of headlines) {
    if (pathRe) {
      let path = null;
      try { path = new URL(h.url).pathname; } catch { /* URL illeggibile: resta com'e' */ }
      if (path === null || !pathRe.test(path)) {
        out.push(h);
        continue;
      }
    }
    const token = h.titleFromSlug ? null : itemIdentityToken(h.headline, h.date);
    if (!token) continue;
    identified += 1;
    out.push({ ...h, url: withItemIdentity(h.url, token) });
  }
  return { headlines: out, identified, dropped: headlines.length - out.length };
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
      const entry = hosts.get(host) || { tail: Promise.resolve(), last: 0, used: 0, delayMs: 0, singleShot: false };
      hosts.set(host, entry);
      // Un crawl-delay che non si aspetta dentro un run vale UNA richiesta per
      // run all'HOST, non a ciascuna delle sue fonti.
      if (Number(delaySeconds) > MAX_INLINE_CRAWL_DELAY_SECONDS) entry.singleShot = true;
      // Il crawl-delay e' dell'HOST, non della fonte: due fonti dello stesso
      // host con ritardi dichiarati diversi rispettano il piu' severo.
      entry.delayMs = Math.max(entry.delayMs, Math.min(Number(delaySeconds) || 0, MAX_INLINE_CRAWL_DELAY_SECONDS) * 1000);
      const result = entry.tail.then(async () => {
        if (entry.singleShot && entry.used > 0) {
          throw new Error(`crawl-delay di ${host} oltre ${MAX_INLINE_CRAWL_DELAY_SECONDS} s: una sola richiesta per run all'host, gia' usata`);
        }
        if (entry.used > 0 && entry.delayMs > 0) {
          const wait = entry.last + entry.delayMs - now();
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
      if (decoded.unsupported) notes.push(`charset ${decoded.unsupported} non supportato: decodificato come UTF-8, testo forse alterato`);
      else if (decoded.charset !== 'utf-8') notes.push(`charset ${decoded.charset}`);
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
        // Fonte che riusa gli URL: una voce alla volta, cosi' ne' il dedup
        // dell'estrattore ne' la mappa dei lead (per URL) fondono due notizie
        // allo stesso indirizzo. Vedi feedItemDocuments.
        const docs = quirks.urlReusedForDifferentStories ? feedItemDocuments(text) : [text];
        return docs.flatMap((doc) => {
          const items = ctx.extractRssItems(doc, url);
          if (!quirks.paywall) return items;
          const leads = rssItemLeads(doc, url);
          return items.map((h) => (leads.has(h.url) ? { ...h, lead: leads.get(h.url) } : h));
        });
      }
      case 'html-links': {
        // Prima la cornice del sito (menu, header, footer), poi i link che
        // non sono articoli: vedi stripPageChrome e filterArticleLinks.
        const page = stripPageChrome(text);
        const links = filterArticleLinks(ctx.extractHeadlines(page.html, url), url, source);
        if (page.removed > 0 || links.dropped > 0) {
          notes.push(`navigazione: ${page.removed} aree tolte, ${links.dropped} link non articolo scartati`);
        }
        return links.headlines;
      }
      case 'json-entities':
        return extractJsonEntitiesItems(text, url);
      case 'json-api':
        return extractJsonApiItems(text, url);
      default:
        // news-sitemap, sitemap, weekly-sitemap
        return extractSitemapNewsItems(text, url, { dedup: !quirks.urlReusedForDifferentStories });
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
  // L'identita' dell'item PRIMA del dedup: su una fonte che riusa gli URL due
  // voci con lo stesso indirizzo (nello stesso feed, o in due periodi della
  // stessa sitemap) sono due notizie finche' il titolo non dice il contrario.
  if (quirks.urlReusedForDifferentStories) {
    const reused = applyItemIdentity(headlines, quirks.urlReusedForDifferentStories);
    notes.push(`URL riusati: ${reused.identified} voci con l'identita' dell'item`);
    if (reused.dropped > 0) notes.push(`URL riusati: ${reused.dropped} voci senza un titolo della fonte scartate (nessuna identita')`);
    headlines = reused.headlines;
  }
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
