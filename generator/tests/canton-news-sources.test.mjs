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
 *   - lo User-Agent e' quello dichiarato (D10: niente UA camuffato).
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
  createHostThrottle,
  decodeResponseBody,
  extractJsonApiItems,
  extractJsonEntitiesItems,
  extractSitemapNewsItems,
  isoWeekOf,
  periodSitemapUrls,
  scanCantonSource,
  sourceRequestBudget,
} from '../scripts/lib/canton-news-sources.mjs';
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
