/**
 * canton-news-sources.test.mjs — lo scanner delle fonti delle sezioni
 * cantonali (`generator/scripts/lib/canton-news-sources.mjs`, P6b). `node
 * --test`, OFFLINE: ogni risposta HTTP e' una fixture salvata in
 * `fixtures/canton-sources/`, estratta il 2026-10-05 dalle pagine reali delle
 * fonti di `generator/data/canton-sections.json` e ridotta a poche voci.
 *
 * Cosa prova:
 *   - i parser nuovi (`json-entities`, `json-api` zh/be, `news-sitemap`,
 *     `weekly-sitemap`) leggono le forme REALI delle fonti: un parser che torna
 *     [] su una fonte del profilo e' una fonte sterile in silenzio;
 *   - RSS/Atom e link HTML passano dagli estrattori VERI di create-article.mjs
 *     (estratti dal sorgente: il modulo non e' importabile senza `npm ci`),
 *     cioe' lo scanner cantonale riusa quelli storici e non una copia;
 *   - i quirk: charset dichiarato nel prologo XML, pubDate vuoto, anno
 *     sbagliato nei `<time datetime>`, paywall title+lead, crawl-delay e
 *     budget di richieste, periodo delle sitemap settimanali;
 *   - lo User-Agent e' quello dichiarato (D10: niente UA camuffato);
 *   - P5b: su una pagina `html-links` i link di navigazione non entrano nel
 *     pool (cornice del sito tolta, `articlePathPattern` dove dichiarato), e
 *     una fonte che riusa gli URL per notizie diverse da' a ogni voce
 *     un'identita' che il ledger distingue (`urlReusedForDifferentStories`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CANTON_SOURCE_USER_AGENT,
  MAX_INLINE_CRAWL_DELAY_SECONDS,
  SUPPORTED_CANTON_PARSERS,
  applyDatetimeYearOffset,
  applyItemIdentity,
  createHostThrottle,
  decodeResponseBody,
  extractJsonApiItems,
  extractJsonEntitiesItems,
  extractSitemapNewsItems,
  feedItemDocuments,
  filterArticleLinks,
  isoWeekOf,
  periodSitemapUrls,
  scanCantonSource,
  sourceRequestBudget,
  stripPageChrome,
} from '../scripts/lib/canton-news-sources.mjs';
import { itemIdentityOf, newsUrlKey, stripItemIdentity } from '../scripts/lib/source-url-ledger.mjs';
import { PARSERS } from '../../scripts/ci/validate-canton-sections.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, 'fixtures', 'canton-sources');
const PROFILE = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'data', 'canton-sections.json'), 'utf8'));
const SRC = fs.readFileSync(path.join(HERE, '..', 'scripts', 'create-article.mjs'), 'utf8');

// Gli estrattori storici, dal sorgente vero (stessa tecnica di
// extract-headlines-sr-prefix.test.mjs e news-scan-quality.test.mjs).
const START = 'function extractDateFromUrl(url) {';
const END = '\n// ── Quota per-fonte del secchio';
const startAt = SRC.indexOf(START);
const endAt = SRC.indexOf(END, startAt);
assert.ok(startAt !== -1 && endAt !== -1, 'delimitatori degli estrattori non trovati in create-article.mjs — aggiornare questo test');
const { extractRssItems, extractHeadlines } = new Function(
  `${SRC.slice(startAt, endAt).replace(/^export /gm, '')}\nreturn { extractRssItems, extractHeadlines };`,
)();

const fixture = (name) => fs.readFileSync(path.join(FIX, name));
const sourceOf = (code, url) => {
  const c = PROFILE.cantons.find((x) => x.code === code);
  const s = c.newsSources.find((x) => x.url === url);
  assert.ok(s, `fonte ${url} non trovata nel profilo ${code}`);
  return s;
};

/** Un fetch finto: URL → fixture, con l'header dichiarato; registra le chiamate. */
function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    const route = routes[url];
    if (!route) return { ok: false, status: 404, headers: new Map(), arrayBuffer: async () => new ArrayBuffer(0) };
    const body = typeof route.body === 'string' ? Buffer.from(route.body, 'utf8') : route.body;
    return {
      ok: true,
      status: 200,
      headers: new Map([['content-type', route.contentType || 'text/html']]),
      arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
    };
  };
  return { impl, calls };
}

const NOW = new Date('2026-10-05T16:00:00Z');
const ctx = (fetchImpl, extra = {}) => ({ fetchImpl, extractRssItems, extractHeadlines, now: NOW, throttle: createHostThrottle({ sleep: async () => {} }), ...extra });

// ── Copertura dei parser del profilo ────────────────────────────────────────

test('ogni parser usato da una newsSources del profilo e\' supportato dallo scanner', () => {
  const used = new Set(PROFILE.cantons.flatMap((c) => c.newsSources.map((s) => s.parser)));
  for (const parser of used) {
    assert.ok(SUPPORTED_CANTON_PARSERS.includes(parser), `parser "${parser}" usato in canton-sections.json ma non supportato`);
    assert.ok(PARSERS.has(parser), `parser "${parser}" fuori dall'enum del validatore`);
  }
});

// ── json-entities (iCMS: NW, OW, SH) ────────────────────────────────────────

test('json-entities: la lista nell\'attributo data-entities, senza un solo <a> nella pagina', async () => {
  const html = fixture('nw-aktuellesinformationen.html').toString('utf8');
  assert.equal(extractHeadlines(html, 'https://www.nw.ch/aktuellesinformationen').length, 0, 'premessa: l\'estrattore HTML storico non vede niente');
  const items = extractJsonEntitiesItems(html, 'https://www.nw.ch/aktuellesinformationen');
  assert.equal(items.length, 4);
  assert.equal(items[0].url, 'https://www.nw.ch/_rte/information/137686');
  assert.equal(items[0].headline, 'Waldbrandgefahr in Nidwalden zurückgestuft');
  assert.equal(items[0].date.getFullYear(), 2026);
  assert.equal(items[0].date.getMonth(), 7);
  assert.equal(items[0].date.getDate(), 28);

  const { impl } = fakeFetch({ 'https://www.nw.ch/aktuellesinformationen': { body: html, contentType: 'text/html; charset=UTF-8' } });
  const out = await scanCantonSource(sourceOf('NW', 'https://www.nw.ch/aktuellesinformationen'), ctx(impl));
  assert.equal(out.headlines.length, 4);
  assert.equal(out.requests, 1);
});

// ── json-api (zh.ch, be.ch) ─────────────────────────────────────────────────

test('json-api zh.ch: titolo, data dd.mm.yyyy, link relativo reso assoluto, teaser come lead', () => {
  const url = 'https://www.zh.ch/de/news-uebersicht/_jcr_content.zhweb-news.zhweb-cache.json';
  const items = extractJsonApiItems(fixture('zh-news.json').toString('utf8'), url);
  assert.equal(items.length, 3);
  assert.match(items[0].url, /^https:\/\/www\.zh\.ch\/de\/news-uebersicht\/medienmitteilungen\/2026\/10\//);
  assert.equal(items[0].date.getDate(), 5);
  assert.equal(items[0].date.getMonth(), 9);
  assert.ok(items[0].lead.length > 40, 'il teaserText viaggia come lead');
});

test('json-api be.ch: pagina pubblica ?newsID=, data publishOn, lingua del contenuto', () => {
  const items = extractJsonApiItems(fixture('be-news.json').toString('utf8'), 'https://www.api.news.apps.be.ch/api/news');
  assert.equal(items.length, 3);
  assert.equal(items[0].url, 'https://www.be.ch/de/start.html?newsID=d755c2ec-3e6f-4cd5-b8ac-13a9bc3f9fe7');
  assert.match(items[0].headline, /Blumenstein/);
  assert.equal(items[0].date.toISOString().slice(0, 10), '2026-10-05');
});

test('json-api: una forma sconosciuta non si indovina (sterile, non inventata)', () => {
  assert.deepEqual(extractJsonApiItems('{"items":[{"t":"x"}]}', 'https://example.ch/api'), []);
  assert.deepEqual(extractJsonApiItems('non json', 'https://example.ch/api'), []);
});

// ── sitemap ─────────────────────────────────────────────────────────────────

test('news-sitemap: news:title e news:publication_date', () => {
  const items = extractSitemapNewsItems(fixture('frapp-news.xml').toString('utf8'), 'https://frapp.ch/sitemaps/fr/news.xml');
  assert.equal(items.length, 2);
  assert.match(items[0].headline, /Veronica Vancardo/);
  assert.equal(items[0].language, 'fr');
  assert.equal(items[0].date.toISOString(), '2026-10-05T12:39:00.000Z');
});

test('sitemap senza news:title: titolo dallo slug, marcato', () => {
  const xml = '<urlset><url><loc>https://www.suedostschweiz.ch/glarus/strasse-nach-braunwald-wegen-steinschlag-gesperrt-1234567</loc><lastmod>2026-10-05T08:00:00+02:00</lastmod></url></urlset>';
  const [item] = extractSitemapNewsItems(xml, 'https://www.suedostschweiz.ch/news-sitemap.xml');
  assert.equal(item.headline, 'strasse nach braunwald wegen steinschlag gesperrt');
  assert.equal(item.titleFromSlug, true);
});

test('sitemap con prefisso di namespace (<sm:url>): letta, non sterile', () => {
  const xml = '<sm:urlset xmlns:sm="http://www.sitemaps.org/schemas/sitemap/0.9"><sm:url><sm:loc>https://www.example.ch/news/kantonsstrasse-wegen-bauarbeiten-gesperrt</sm:loc><sm:lastmod>2026-10-05</sm:lastmod></sm:url></sm:urlset>';
  const [item] = extractSitemapNewsItems(xml, 'https://www.example.ch/sitemap.xml');
  assert.equal(item.url, 'https://www.example.ch/news/kantonsstrasse-wegen-bauarbeiten-gesperrt');
  assert.equal(item.date.toISOString().slice(0, 10), '2026-10-05');
});

test('weekly-sitemap: periodo ISO corrente e precedente; budget 1 sceglie il piu\' utile', () => {
  assert.deepEqual(isoWeekOf(new Date('2026-10-05T10:00:00Z')), { year: 2026, week: 41 });
  assert.deepEqual(isoWeekOf(new Date('2027-01-01T10:00:00Z')), { year: 2026, week: 53 });
  const sample = 'https://www.pomona.ch/sitemap_202641.xml';
  assert.deepEqual(periodSitemapUrls(sample, 'iso-week', { now: new Date('2026-10-14T10:00:00Z') }), [
    'https://www.pomona.ch/sitemap_202642.xml',
    'https://www.pomona.ch/sitemap_202641.xml',
  ]);
  // Lunedi' mattina: la settimana nuova ha poche voci, gli ultimi giorni stanno nella precedente.
  assert.deepEqual(periodSitemapUrls(sample, 'iso-week', { now: new Date('2026-10-05T08:00:00Z'), budget: 1 }), ['https://www.pomona.ch/sitemap_202640.xml']);
  assert.deepEqual(periodSitemapUrls(sample, 'iso-week', { now: new Date('2026-10-08T08:00:00Z'), budget: 1 }), ['https://www.pomona.ch/sitemap_202641.xml']);
  assert.deepEqual(periodSitemapUrls('https://api.canalalpha.ch/sitemap/2026-10-medias.xml', 'month', { now: new Date('2026-12-15T00:00:00Z') }), [
    'https://api.canalalpha.ch/sitemap/2026-12-medias.xml',
    'https://api.canalalpha.ch/sitemap/2026-11-medias.xml',
  ]);
});

test('weekly-sitemap reale (Pomona, crawl-delay 500): UNA richiesta per run, al periodo scelto', async () => {
  const source = sourceOf('VS', 'https://www.pomona.ch/sitemap_202641.xml');
  assert.equal(sourceRequestBudget(source), 1, 'crawl-delay 500 s non si aspetta dentro un run');
  const { impl, calls } = fakeFetch({ 'https://www.pomona.ch/sitemap_202641.xml': { body: fixture('pomona-sitemap_202641.xml'), contentType: 'application/xml; charset=utf-8' } });
  const out = await scanCantonSource(source, ctx(impl, { now: new Date('2026-10-07T12:00:00Z') }));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://www.pomona.ch/sitemap_202641.xml');
  assert.equal(out.headlines.length, 3);
  assert.match(out.headlines[0].headline, /Walliser Hotellerie/);
});

test('weekly-sitemap: il periodo corrente che non esiste ancora e\' una nota, non un fallimento', async () => {
  const source = { url: 'https://ajour.ch/sitemap_202640.xml', parser: 'weekly-sitemap', quirks: { urlPeriod: 'iso-week' } };
  const { impl, calls } = fakeFetch({ 'https://ajour.ch/sitemap_202640.xml': { body: fixture('pomona-sitemap_202641.xml'), contentType: 'application/xml' } });
  const out = await scanCantonSource(source, ctx(impl, { now: new Date('2026-10-05T07:00:00Z') }));
  assert.deepEqual(calls.map((c) => c.url), ['https://ajour.ch/sitemap_202641.xml', 'https://ajour.ch/sitemap_202640.xml']);
  assert.equal(out.headlines.length, 3);
  assert.ok(out.notes.some((n) => /sitemap_202641\.xml: HTTP 404/.test(n)));
});

// ── RSS/HTML: gli estrattori storici, riusati ───────────────────────────────

test('charset: il prologo XML ISO-8859-1 vince sull\'assenza di charset nell\'header', async () => {
  const bytes = fixture('ge-ocstat-latin1.xml');
  const decoded = decodeResponseBody(bytes, { contentType: 'text/xml' });
  assert.equal(decoded.charset, 'iso-8859-1');
  assert.match(decoded.text, /L'économie genevoise/);
  const odd = decodeResponseBody(Buffer.from('abc'), { contentType: 'text/xml; charset=x-unknown-cs' });
  assert.equal(odd.charset, 'utf-8');
  assert.equal(odd.unsupported, 'x-unknown-cs', 'un charset sconosciuto si dichiara, non si nasconde');
  assert.doesNotMatch(decodeResponseBody(bytes, { contentType: 'text/xml', forcedCharset: 'utf-8' }).text, /L'économie genevoise/, 'premessa: in UTF-8 le lettere accentate si rompono');

  const source = sourceOf('GE', 'https://statistique.ge.ch/rss');
  const { impl } = fakeFetch({ 'https://statistique.ge.ch/rss': { body: bytes, contentType: 'text/xml' } });
  const out = await scanCantonSource(source, ctx(impl));
  assert.ok(out.headlines.some((h) => /L'économie genevoise/.test(h.headline)), 'il titolo arriva decodificato giusto');
  assert.ok(out.notes.includes('charset iso-8859-1'));
});

test('pubDate vuoto (bs.ch): voci SENZA data per la quota undated, mai «recenti»', async () => {
  const source = sourceOf('BASILEA', 'https://www.bs.ch/rss');
  assert.equal(source.quirks.emptyPubDate, true);
  const { impl } = fakeFetch({ 'https://www.bs.ch/rss': { body: fixture('bs-empty-pubdate.xml'), contentType: 'application/rss+xml; charset=utf-8' } });
  const out = await scanCantonSource(source, ctx(impl));
  assert.equal(out.headlines.length, 2);
  for (const h of out.headlines) {
    assert.equal(h.date, null);
    assert.equal(h._undatedReason, 'emptyPubDate');
  }
});

test('anno sbagliato nei <time datetime> (ur.ch, offset -600): data corretta, non «futura»', async () => {
  const source = sourceOf('UR', 'https://www.ur.ch/polizeimeldungen');
  const html = fixture('ur-polizeimeldungen.html').toString('utf8');
  const raw = extractHeadlines(html, source.url);
  assert.ok(raw.length >= 2);
  assert.equal(raw[0].date.getFullYear(), 2626, 'premessa: senza il quirk la data e\' nel 2626');
  const { impl } = fakeFetch({ [source.url]: { body: html, contentType: 'text/html; charset=UTF-8' } });
  const out = await scanCantonSource(source, ctx(impl));
  const first = out.headlines.find((h) => /Flüelen/.test(h.headline));
  assert.equal(first.url, 'https://www.ur.ch/_rte/information/138754');
  assert.equal(first.date.getFullYear(), 2026);
  assert.equal(first.date.getMonth(), 9);
  assert.equal(first.date.getDate(), 1);
  // Una data che resta futura anche dopo l'offset non diventa «recente».
  const [still] = applyDatetimeYearOffset([{ url: 'u', headline: 'h', date: new Date('3700-01-01') }], -600, NOW);
  assert.equal(still.date, null);
});

test('paywall title+lead: il lead del feed viaggia con la headline', async () => {
  const source = { url: 'https://www.suedostschweiz.ch/feed/graubuenden', parser: 'rss', quirks: { paywall: 'title+lead' } };
  const rss = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel>
<item><title>Chur: Kantonsstrasse wegen Bauarbeiten gesperrt</title><link>https://www.suedostschweiz.ch/graubuenden/chur-kantonsstrasse-gesperrt</link><description><![CDATA[<p>Die Strasse bleibt bis Freitag zu. Umleitung via Felsberg.</p>]]></description><pubDate>Mon, 05 Oct 2026 07:00:00 +0200</pubDate></item>
</channel></rss>`;
  const { impl } = fakeFetch({ [source.url]: { body: rss, contentType: 'application/rss+xml' } });
  const out = await scanCantonSource(source, ctx(impl));
  assert.equal(out.headlines[0].lead, 'Die Strasse bleibt bis Freitag zu. Umleitung via Felsberg.');
  assert.equal(out.headlines[0]._paywall, 'title+lead');
});

// ── Cortesia verso l'host ───────────────────────────────────────────────────

test('crawl-delay: due richieste allo stesso host distanziate, host diversi no', async () => {
  let clock = 0;
  const waits = [];
  const throttle = createHostThrottle({ sleep: async (ms) => { waits.push(ms); clock += ms; }, now: () => clock });
  await throttle.run('a.ch', 10, async () => { clock += 100; });
  await throttle.run('a.ch', 10, async () => {});
  await throttle.run('b.ch', 10, async () => {});
  assert.deepEqual(waits, [10000], 'la seconda richiesta ad a.ch aspetta 10 s dalla fine della prima; b.ch non aspetta');
  assert.equal(throttle.requestsTo('a.ch'), 2);
  // Il ritardo e' dell'host: una seconda fonte dello stesso host che dichiara
  // un crawl-delay minore non accorcia l'attesa.
  waits.length = 0;
  await throttle.run('c.ch', 30, async () => {});
  await throttle.run('c.ch', 1, async () => {});
  assert.deepEqual(waits, [30000]);
  // Oltre la soglia vale una richiesta per run all'HOST: la seconda fonte
  // dello stesso host non la ottiene, nemmeno dichiarando un ritardo minore.
  await throttle.run('d.ch', 500, async () => {});
  await assert.rejects(throttle.run('d.ch', 1, async () => {}), /una sola richiesta per run/);
  // Un crawl-delay oltre la soglia non si aspetta: diventa una richiesta per run.
  assert.equal(sourceRequestBudget({ quirks: { crawlDelaySeconds: MAX_INLINE_CRAWL_DELAY_SECONDS + 1 } }), 1);
  assert.equal(sourceRequestBudget({ quirks: { crawlDelaySeconds: 30 } }), Infinity);
});

test('maxRequestsPerRun: il budget si applica anche alle sitemap a periodo', async () => {
  const source = { url: 'https://www.gl.ch/news_202641.xml', parser: 'weekly-sitemap', quirks: { urlPeriod: 'iso-week', maxRequestsPerRun: 1 } };
  const { impl, calls } = fakeFetch({});
  await assert.rejects(scanCantonSource(source, ctx(impl, { now: new Date('2026-10-14T12:00:00Z') })), /HTTP 404/);
  assert.equal(calls.length, 1, 'una sola richiesta, anche se il periodo ne vorrebbe due');
});

test('User-Agent dichiarato (D10) e niente HTTP/2 chiesto a undici (http1Only per costruzione)', async () => {
  const { impl, calls } = fakeFetch({ 'https://www.zh.ch/api.json': { body: '{"news":[]}', contentType: 'application/json' } });
  await scanCantonSource({ url: 'https://www.zh.ch/api.json', parser: 'json-api', quirks: { http1Only: true } }, ctx(impl));
  assert.equal(calls[0].init.headers['User-Agent'], CANTON_SOURCE_USER_AGENT);
  // be.ch risponde 500 a `Accept-Language: *` (il default di undici): la
  // lingua della fonte va dichiarata.
  assert.equal(calls[0].init.headers['Accept-Language'], 'de, *;q=0.5');
  assert.match(CANTON_SOURCE_USER_AGENT, /FrontaliereTicinoBot/);
  const moduleSrc = fs.readFileSync(path.join(HERE, '..', 'scripts', 'lib', 'canton-news-sources.mjs'), 'utf8');
  assert.doesNotMatch(moduleSrc.replace(/^\s*\*.*$/gm, ''), /allowH2/, 'lo scanner non deve abilitare HTTP/2');
});

test('un parser fuori elenco e\' un errore, non una fonte vuota', async () => {
  const { impl } = fakeFetch({});
  await assert.rejects(scanCantonSource({ url: 'https://x.ch/a.csv', parser: 'csv', quirks: {} }, ctx(impl)), /non supportato/);
});

// ── P5b: navigazione delle pagine html-links ────────────────────────────────
//
// Le tre pagine sono le risposte reali del 2026-10-05, ridotte (script, stile
// e immagini tolti; al massimo 3 voci per lista e 4 blocchi uguali per
// contenitore): la struttura nav/header/main/footer e' quella del sito.

const EOC_URL = 'https://www.eoc.ch/media-e-news/news.html';

test('eoc.ch: il menu del sito non entra nel pool, restano i comunicati', async () => {
  const html = fixture('eoc-news.html').toString('utf8');
  const before = extractHeadlines(html, EOC_URL);
  // La premessa, cioe' il difetto: 53 link, 4 comunicati, e fra gli altri la
  // voce di menu che il dry-run di P6b ha scelto come notizia.
  assert.equal(before.length, 53);
  assert.equal(before.filter((h) => h.date).length, 4);
  assert.ok(before.some((h) => h.headline === 'Soggiorno in ospedale'), 'premessa: il menu e\' nel pool dell\'estrattore storico');

  const source = sourceOf('TI', EOC_URL);
  const { impl } = fakeFetch({ [EOC_URL]: { body: html, contentType: 'text/html; charset=UTF-8' } });
  const out = await scanCantonSource(source, ctx(impl));
  assert.equal(out.headlines.length, 4);
  for (const h of out.headlines) {
    assert.match(new URL(h.url).pathname, /^\/media-e-news\/news\/2026\//);
    assert.ok(h.date, `${h.url} e' un comunicato datato`);
  }
  assert.ok(out.notes.some((n) => /navigazione: 4 aree tolte, 3 link non articolo scartati/.test(n)), `nota della fonte: ${out.notes.join(' | ')}`);
});

test('eoc.ch: tolta la cornice restano link che non sono comunicati, e li toglie articlePathPattern', () => {
  const html = fixture('eoc-news.html').toString('utf8');
  const page = stripPageChrome(html);
  assert.equal(page.removed, 4, 'header, footer, breadcrumb e menu mobile');
  const links = extractHeadlines(page.html, EOC_URL);
  // La ricerca suggerita, il sondaggio e l'elenco stesso stanno in <main>,
  // fuori da ogni <nav>: e' il caso per cui serve il pattern dichiarato.
  assert.deepEqual(
    links.filter((h) => !h.date).map((h) => new URL(h.url).pathname).sort(),
    ['/eoc-sport.html', '/info/search.html', '/media-e-news/news.html'],
  );
  // La pagina stessa in forma canonica: slash, frammento e tracciamento non
  // la rendono un articolo; un parametro identificante si'.
  const selfForms = ['https://www.eoc.ch/media-e-news/news.html/', 'https://WWW.eoc.ch/media-e-news/news.html#top', 'https://www.eoc.ch/media-e-news/news.html?utm_source=nav&fbclid=x']
    .map((url) => ({ url, headline: 'Tutte le notizie e i comunicati', date: null }));
  assert.equal(filterArticleLinks(selfForms, EOC_URL, { quirks: {} }).headlines.length, 0);
  assert.equal(filterArticleLinks([{ url: `${EOC_URL}?id=7`, headline: 'Un comunicato identificato dalla query', date: null }], EOC_URL, { quirks: {} }).headlines.length, 1);
  // Senza pattern cade solo il link alla pagina stessa (vale per ogni fonte).
  const generic = filterArticleLinks(links, EOC_URL, { quirks: {} });
  assert.equal(generic.dropped, 1);
  assert.ok(!generic.headlines.some((h) => new URL(h.url).pathname === '/media-e-news/news.html'));
  const declared = filterArticleLinks(links, EOC_URL, sourceOf('TI', EOC_URL));
  assert.equal(declared.headlines.length, 4);
  assert.equal(declared.dropped, 3);
});

test('zug4you.ch: <header> dentro <article> e\' il titolo dell\'articolo e resta', async () => {
  const url = 'https://www.zug4you.ch/en/news';
  const html = fixture('zug4you-news.html').toString('utf8');
  // Togliere OGNI <header> (la regola ingenua) azzererebbe la fonte: i 4
  // titoli stanno tutti in `<article><header><h2><a>`.
  const naive = html.replace(/<(header|footer)\b[\s\S]*?<\/\1>/gi, '');
  assert.equal(extractHeadlines(naive, url).length, 0, 'premessa: i titoli sono dentro <header>');
  const { impl } = fakeFetch({ [url]: { body: html, contentType: 'text/html' } });
  const out = await scanCantonSource(sourceOf('ZG', url), ctx(impl));
  assert.equal(out.headlines.length, 4);
  assert.ok(out.headlines.every((h) => /^\/en\/news\/news-articles\/a\//.test(new URL(h.url).pathname)));
});

test('aarau.ch: un role="navigation" che contiene <main> non e\' un menu', async () => {
  const url = 'https://www.aarau.ch/politik-verwaltung/news.html/203';
  const html = fixture('aarau-news.html').toString('utf8');
  assert.match(html, /<div[^>]*role="navigation"[^>]*>[\s\S]*<main[\s>]/, 'premessa: il wrapper marcato navigazione avvolge <main>');
  const before = extractHeadlines(html, url);
  const { impl } = fakeFetch({ [url]: { body: html, contentType: 'text/html' } });
  const out = await scanCantonSource(sourceOf('AG', url), ctx(impl));
  // Nessun comunicato datato perso, e il menu (38 link su 48) fuori.
  assert.equal(out.headlines.filter((h) => h.date).length, before.filter((h) => h.date).length);
  assert.equal(before.filter((h) => h.date).length, 9);
  assert.equal(before.length, 48);
  assert.equal(out.headlines.length, 10);
});

test('stripPageChrome: nav, ruoli ARIA, header/footer di pagina; il resto intatto', () => {
  const html = [
    '<body><header><a href="/chi">Chi siamo, la nostra storia</a></header>',
    '<div role="navigation"><a href="/menu">Una voce del menu laterale</a></div>',
    '<main><nav class="crumb"><a href="/">Torna alla pagina iniziale</a></nav>',
    '<article><header><h2><a href="/news/1">Titolo del primo comunicato</a></h2></header><footer><a href="/news/1#c">Commenta questo comunicato</a></footer></article>',
    '<section><header><a href="/news/2">Titolo del secondo comunicato</a></header></section></main>',
    '<script>var t = "<nav><a href=\\"/x\\">non e\' markup</a>";</script>',
    '<footer><a href="/privacy-policy">Informativa sulla privacy</a></footer></body>',
  ].join('\n');
  const out = stripPageChrome(html);
  assert.equal(out.removed, 4);
  for (const gone of ['/chi', '/menu', 'Torna alla pagina iniziale', '/privacy-policy']) assert.ok(!out.html.includes(gone), `${gone} doveva sparire`);
  for (const kept of ['/news/1"', '/news/1#c', '/news/2']) assert.ok(out.html.includes(kept), `${kept} doveva restare`);
  // Lo script non apre un <nav> (le aree tolte restano 4) e il suo contenuto
  // esce reso spazi: un <a> scritto in uno script, un template o un commento
  // non e' un link della pagina.
  assert.ok(!out.html.includes('non e\' markup'));
  const inactive = '<template><a href="/menu/t">Voce di un menu in un template</a></template><!-- <a href="/old">Un vecchio link commentato via</a> --><style>a{}</style><p><a href="/news/9">Titolo del nono comunicato</a></p>';
  const cleaned = stripPageChrome(inactive);
  assert.equal(cleaned.removed, 0);
  assert.equal(cleaned.html.length, inactive.length, 'a pari lunghezza');
  assert.deepEqual(extractHeadlines(cleaned.html, 'https://x.ch/').map((h) => h.url), ['https://x.ch/news/9']);
  assert.equal(extractHeadlines(inactive, 'https://x.ch/').length, 3, 'premessa: l\'estrattore storico li prende tutti');
  // header/footer dentro role="main" o role="article" sono della sezione.
  const ariaSection = '<div role="main"><header><a href="/news/10">Titolo del decimo comunicato</a></header><div role="article"><footer><a href="/news/11">Titolo dell undicesimo comunicato</a></footer></div></div><footer><a href="/impressum">Impressum e note legali</a></footer>';
  const aria = stripPageChrome(ariaSection);
  assert.equal(aria.removed, 1);
  assert.ok(aria.html.includes('/news/10') && aria.html.includes('/news/11') && !aria.html.includes('/impressum'));
  // Solo l'attributo `role`: data-role e aria-role non marcano niente, e
  // role="main" dentro un'area la rende contenuto (come <main>).
  const dataRole = '<article data-role="navigation"><a href="/news/4">Titolo del quarto comunicato</a></article><div aria-role="banner"><a href="/news/5">Titolo del quinto comunicato</a></div>';
  assert.deepEqual(stripPageChrome(dataRole), { html: dataRole, removed: 0 });
  const roleMain = '<div role="navigation"><div role="main"><a href="/news/6">Titolo del sesto comunicato</a></div></div>';
  assert.deepEqual(stripPageChrome(roleMain), { html: roleMain, removed: 0 });
  const dataMain = '<div class="x" role="navigation"><div data-role="main"><a href="/menu/2">Seconda voce del menu laterale</a></div></div>';
  assert.deepEqual(stripPageChrome(dataMain), { html: '', removed: 1 });
  assert.equal(stripPageChrome("<ul ROLE='presentation Navigation'><li><a href=\"/m\">Voce di menu qualunque</a></li></ul><p>resta</p>").html, '<p>resta</p>');
  // `role=` scritto DENTRO il valore di un altro attributo non e' un ruolo.
  const inValue = '<main data-note="foo role=navigation"><a href="/news/7">Titolo del settimo comunicato</a></main><div title=\'x role="banner"\'><a href="/news/8">Titolo dell ottavo comunicato</a></div>';
  assert.deepEqual(stripPageChrome(inValue), { html: inValue, removed: 0 });
  assert.equal(stripPageChrome('<div class=menu role=navigation><a href="/m3">Terza voce del menu laterale</a></div>ok').html, 'ok');
  // Un'area senza chiusura non si taglia fino in fondo al documento.
  const open = '<nav><a href="/a">Voce di un menu non chiuso</a><main><a href="/news/3">Titolo del terzo comunicato</a></main>';
  assert.deepEqual(stripPageChrome(open), { html: open, removed: 0 });
  assert.deepEqual(stripPageChrome(''), { html: '', removed: 0 });
});

test('articlePathPattern: ogni dichiarazione del profilo e\' su una fonte html-links e compila', () => {
  const declared = PROFILE.cantons.flatMap((c) => c.newsSources.filter((s) => s.quirks?.articlePathPattern).map((s) => ({ code: c.code, ...s })));
  assert.ok(declared.length >= 20, `attese almeno 20 fonti con articlePathPattern, trovate ${declared.length}`);
  for (const s of declared) {
    assert.equal(s.parser, 'html-links', `${s.code} ${s.url}`);
    assert.doesNotThrow(() => new RegExp(s.quirks.articlePathPattern), `${s.code} ${s.url}`);
    // Il pattern non deve tenere la pagina-elenco stessa.
    assert.equal(filterArticleLinks([{ url: s.url, headline: 'x', date: null }], s.url, s).headlines.length, 0, `${s.url}: l'elenco non e' un articolo`);
  }
});

// ── P5b: fonti che riusano gli URL ──────────────────────────────────────────

const SOS_FEED = 'https://www.suedostschweiz.ch/feed/graubuenden';
const TICKER_URL = 'https://www.suedostschweiz.ch/graubuenden/verkehrsticker-1574112';

test('suedostschweiz: lo stesso URL con un\'altra notizia e\' un\'altra voce per il ledger', async () => {
  const xml = fixture('suedostschweiz-graubuenden.xml').toString('utf8');
  const source = sourceOf('GR', SOS_FEED);
  assert.equal(source.quirks.urlReusedForDifferentStories, true);
  const { impl } = fakeFetch({ [SOS_FEED]: { body: xml, contentType: 'application/rss+xml; charset=UTF-8' } });
  const out = await scanCantonSource(source, ctx(impl));
  assert.equal(out.headlines.length, 5);
  const ticker = out.headlines.find((h) => stripItemIdentity(h.url) === TICKER_URL);
  assert.equal(ticker.headline, 'Nach Unfall zwischen Flims und Trin: Verkehr fliesst wieder');
  assert.match(ticker.url, /#ft-item=[0-9a-f]{12}$/);
  assert.ok(ticker.lead, 'il lead (paywall title+lead) si aggancia ancora per URL');
  assert.ok(out.headlines.every((h) => itemIdentityOf(h.url)), 'ogni voce della fonte porta l\'identita\'');

  // La stessa pagina il 2026-06-25 (Wayback Machine, snapshot 20260625124821)
  // titolava un incidente a Pontresina: stesso URL, stesso guid, altra notizia.
  const [earlier] = applyItemIdentity([{ url: TICKER_URL, headline: 'Pontresina: Beinverletzung nach Unfall mit Töff auf schneebedeckter Strasse', date: new Date('2026-06-25T10:00:00Z') }]).headlines;
  assert.notEqual(newsUrlKey(earlier.url), newsUrlKey(ticker.url), 'due notizie, due chiavi');
  assert.equal(newsUrlKey(TICKER_URL), 'https://www.suedostschweiz.ch/graubuenden/verkehrsticker-1574112', 'premessa: senza identita\' la chiave e\' il contenitore');
  // La stessa notizia riletta (maiuscole, punteggiatura, entita') resta se' stessa.
  const [again] = applyItemIdentity([{ url: TICKER_URL, headline: 'NACH UNFALL zwischen Flims und Trin – Verkehr fliesst wieder!', date: ticker.date }]).headlines;
  assert.equal(newsUrlKey(again.url), newsUrlKey(ticker.url));
  // L'indirizzo da scaricare e da citare e' quello del sito.
  assert.equal(stripItemIdentity(ticker.url), TICKER_URL);
});

test('suedostschweiz: tutte le fonti del dominio dichiarano il riuso degli URL', () => {
  const sources = PROFILE.cantons.flatMap((c) => c.newsSources.filter((s) => new URL(s.url).hostname === 'www.suedostschweiz.ch').map((s) => `${c.code} ${s.url} ${s.quirks.urlReusedForDifferentStories}`));
  assert.equal(sources.length, 4);
  for (const s of sources) assert.match(s, / true$/, s);
});

test('Tamedia: identita\' dell\'item solo sui ticker; un articolo ritoccato nel titolo resta la stessa voce', async () => {
  const feed = 'https://partner-feeds.publishing.tamedia.ch/rss/bazonline/';
  const source = sourceOf('BASILEA', feed);
  assert.equal(source.quirks.urlReusedForDifferentStories, '^/ticker-');
  const scan = async (name) => {
    const { impl } = fakeFetch({ [feed]: { body: fixture(name), contentType: 'application/rss+xml; charset=utf-8' } });
    return (await scanCantonSource(source, ctx(impl))).headlines;
  };
  // Due letture reali a 16 minuti (2026-10-05): fra l'una e l'altra la
  // redazione ha cambiato il titolo dell'articolo sul processo di Binningen.
  const first = await scan('tamedia-bazonline.xml');
  const later = await scan('tamedia-bazonline-later.xml');
  const binningen = (list) => list.find((h) => h.url.includes('/femizid-binningen-'));
  assert.notEqual(binningen(first).headline, binningen(later).headline, 'premessa: il titolo e\' cambiato');
  assert.equal(itemIdentityOf(binningen(first).url), null);
  assert.equal(newsUrlKey(binningen(first).url), newsUrlKey(binningen(later).url), 'stesso articolo, stessa chiave');
  const tickers = first.filter((h) => new URL(h.url).pathname.startsWith('/ticker-'));
  assert.equal(tickers.length, 2);
  assert.ok(tickers.every((h) => itemIdentityOf(h.url)), 'i ticker portano l\'identita\' dell\'item');
  assert.equal(first.filter((h) => itemIdentityOf(h.url)).length, 2, 'e solo loro');
});

test('applyItemIdentity: l\'identita\' e\' sempre il titolo della fonte; un titolo ricavato dallo slug non ne ha', () => {
  const url = 'https://www.suedostschweiz.ch/glarus/meldungen-aus-dem-glarnerland-1916134';
  const title = 'Bye bye Billettschalter: SBB schliessen Reisezentrum in Ziegelbrücke';
  // Lo stesso item dal feed e dalla news sitemap (date diverse: pubDate e
  // news:publication_date non coincidono al secondo): UNA chiave.
  const fromFeed = applyItemIdentity([{ url, headline: title, date: new Date('2026-10-05T12:54:14Z') }]).headlines[0];
  const fromSitemap = applyItemIdentity([{ url, headline: title, date: new Date('2026-10-05T12:55:02Z') }]).headlines[0];
  assert.equal(newsUrlKey(fromFeed.url), newsUrlKey(fromSitemap.url));
  // Lo stesso titolo un altro giorno e' un'altra notizia (un contenitore
  // ripete i titoli), e una voce senza data ha per identita' il solo titolo.
  const nextDay = applyItemIdentity([{ url, headline: title, date: new Date('2026-10-08T07:00:00Z') }]).headlines[0];
  const undated = applyItemIdentity([{ url, headline: title, date: null }]).headlines[0];
  assert.equal(new Set([fromFeed, nextDay, undated].map((h) => newsUrlKey(h.url))).size, 3);
  // Una sitemap senza news:title darebbe lo slug del contenitore come titolo:
  // non identifica la notizia, e un'impronta della data farebbe una seconda
  // chiave per l'item che il feed identifica col titolo.
  const slugged = { url, headline: 'meldungen aus dem glarnerland', date: new Date('2026-10-05T12:54:14Z'), titleFromSlug: true };
  assert.deepEqual(applyItemIdentity([slugged]), { headlines: [], identified: 0, dropped: 1 });
});

test('URL riusati: due voci con lo stesso link nello STESSO feed restano due notizie (identita\' prima del dedup)', async () => {
  // Il feed reale, con la voce del ticker ripetuta sotto un altro titolo: e'
  // cio' che il contenitore titolava il 2026-08-26 (Wayback Machine). Stesso
  // <link>, stesso <guid>.
  const xml = fixture('suedostschweiz-graubuenden.xml').toString('utf8');
  const item = /<item>(?:(?!<\/item>)[\s\S])*verkehrsticker-1574112[\s\S]*?<\/item>/.exec(xml)[0];
  const earlierTitle = 'Schwerer Töffunfall bei Pontresina: Betrieb der RhB kurzzeitig eingestellt';
  const twice = xml.replace(item, `${item}\n${item.replace(/<title>[\s\S]*?<\/title>/, `<title>${earlierTitle}</title>`).replace(/<description>[\s\S]*?<\/description>/, '<description>Die RhB-Strecke war kurz unterbrochen.</description>')}`);
  assert.equal(extractRssItems(twice, SOS_FEED).filter((h) => h.url === TICKER_URL).length, 1, 'premessa: l\'estrattore storico ne tiene una');
  assert.equal(feedItemDocuments(twice).length, 6);

  const { impl } = fakeFetch({ [SOS_FEED]: { body: twice, contentType: 'application/rss+xml; charset=UTF-8' } });
  const out = await scanCantonSource(sourceOf('GR', SOS_FEED), ctx(impl));
  const ticker = out.headlines.filter((h) => stripItemIdentity(h.url) === TICKER_URL);
  assert.equal(ticker.length, 2);
  assert.equal(new Set(ticker.map((h) => newsUrlKey(h.url))).size, 2);
  assert.deepEqual(ticker.map((h) => h.headline).sort(), ['Nach Unfall zwischen Flims und Trin: Verkehr fliesst wieder', earlierTitle].sort());
  // Ognuna col SUO lead, non con quello dell'altra (la mappa dei lead e' per URL).
  assert.match(ticker.find((h) => h.headline === earlierTitle).lead, /RhB-Strecke/);
  assert.doesNotMatch(ticker.find((h) => h.headline !== earlierTitle).lead, /RhB-Strecke/);
  assert.ok(out.notes.some((n) => /URL riusati: 6 voci con l'identita' dell'item/.test(n)), out.notes.join(' | '));
  // La stessa voce ripetuta identica, invece, resta una.
  const { impl: impl2 } = fakeFetch({ [SOS_FEED]: { body: xml.replace(item, `${item}\n${item}`), contentType: 'application/rss+xml' } });
  const dup = await scanCantonSource(sourceOf('GR', SOS_FEED), ctx(impl2));
  assert.equal(dup.headlines.length, 5);
});

test('URL riusati in una sitemap: stesso <loc> in due voci, due notizie; senza il quirk resta il dedup', async () => {
  const url = 'https://www.suedostschweiz.ch/news-sitemap.xml';
  const entry = (title, at) => `<url><loc>${TICKER_URL}</loc><news:news><news:publication_date>${at}</news:publication_date><news:title>${title}</news:title></news:news></url>`;
  const xml = `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">${entry('Nach Unfall zwischen Flims und Trin: Verkehr fliesst wieder', '2026-10-05T12:49:15+02:00')}${entry('Julierpass nach Steinschlag wieder offen', '2026-10-05T08:10:00+02:00')}</urlset>`;
  assert.equal(extractSitemapNewsItems(xml, url).length, 1);
  assert.equal(extractSitemapNewsItems(xml, url, { dedup: false }).length, 2);
  const { impl } = fakeFetch({ [url]: { body: xml, contentType: 'application/xml' } });
  const out = await scanCantonSource(sourceOf('GL', url), ctx(impl));
  assert.equal(out.headlines.length, 2);
  assert.equal(new Set(out.headlines.map((h) => newsUrlKey(h.url))).size, 2);
});

test('feedItemDocuments: Atom e RSS, e un documento senza voci torna com\'e\'', () => {
  const atom = '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>F</title><entry><title>Primo titolo di prova</title><link href="https://x.ch/a"/><updated>2026-10-05T10:00:00Z</updated></entry><entry><title>Secondo titolo di prova</title><link href="https://x.ch/a"/><updated>2026-10-05T11:00:00Z</updated></entry></feed>';
  const docs = feedItemDocuments(atom);
  assert.equal(docs.length, 2);
  assert.deepEqual(docs.flatMap((d) => extractRssItems(d, 'https://x.ch/feed')).map((h) => h.headline), ['Primo titolo di prova', 'Secondo titolo di prova']);
  assert.deepEqual(feedItemDocuments('<rss><channel></channel></rss>'), ['<rss><channel></channel></rss>']);
});
