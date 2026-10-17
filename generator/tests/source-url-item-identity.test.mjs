/**
 * source-url-item-identity.test.mjs — l'identita' dell'ITEM nella chiave del
 * ledger delle fonti (P5b). `node --test`, offline.
 *
 * ## Il difetto
 *
 * La chiave del ledger (`newsUrlKey`) e' l'URL: un URL, un documento. Sui feed
 * di suedostschweiz.ch (canton-gr, canton-gl) e sui «Ticker» di Tamedia una
 * pagina-contenitore a URL fisso porta la notizia del momento, e il feed la
 * riemette con lo stesso `<link>`/`<guid>` e un titolo nuovo. Misurato il
 * 2026-10-05 sulla Wayback Machine, `/graubuenden/verkehrsticker-1574112`:
 *
 *   2026-05-11  «Vorsicht: Isla-Bella-Tunnel in beide Richtungen gesperrt»
 *   2026-06-25  «Pontresina: Beinverletzung nach Unfall mit Töff auf schneebedeckter Strasse»
 *   2026-08-26  «Schwerer Töffunfall bei Pontresina: Betrieb der RhB kurzzeitig eingestellt»
 *   2026-10-05  «Nach Unfall zwischen Flims und Trin: Verkehr fliesst wieder» (feed)
 *
 * Quattro notizie, una chiave: generato un articolo dalla prima, le altre tre
 * erano «URL gia' usata».
 *
 * ## Cosa prova
 *
 *   - `newsUrlKey` conserva `#ft-item=<impronta>` e ignora ogni altro
 *     frammento: per gli URL senza identita' la chiave non cambia;
 *   - `isSourceUrlAlreadyUsed` (il codice VERO di create-article.mjs, estratto
 *     dal sorgente) lascia passare una notizia nuova allo stesso indirizzo e
 *     blocca la stessa notizia riletta — e per un URL riusato non interroga
 *     ne' il ponte verso le chiavi di forma 1 ne' il ramo fuzzy sullo slug,
 *     che descrivono il contenitore e non la notizia;
 *   - la generazione usa l'indirizzo SENZA identita' (pagina da scaricare,
 *     citazione pubblicata) e registra nel ledger quello CON l'identita'.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ITEM_IDENTITY_FRAGMENT,
  itemIdentityOf,
  itemIdentityToken,
  ledgerViewsForLookup,
  legacyNewsUrlKey,
  makeLedgerEntry,
  newsUrlKey,
  checkItemOnPage,
  pageCarriesItem,
  pageTitleEvidence,
  shortHeadlineEvidence,
  shortHeadlineTokenPolicy,
  selectConsistentTitleEvidence,
  stripItemIdentity,
  withItemIdentity,
} from '../scripts/lib/source-url-ledger.mjs';
import { findCrossSectionSourceDuplicate } from '../scripts/lib/cross-section-dedup.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(HERE, '..', 'scripts', 'create-article.mjs'), 'utf8');

const TICKER = 'https://www.suedostschweiz.ch/graubuenden/verkehrsticker-1574112';
const TITLES = [
  'Vorsicht: Isla-Bella-Tunnel in beide Richtungen gesperrt',
  'Pontresina: Beinverletzung nach Unfall mit Töff auf schneebedeckter Strasse',
  'Schwerer Töffunfall bei Pontresina: Betrieb der RhB kurzzeitig eingestellt',
  'Nach Unfall zwischen Flims und Trin: Verkehr fliesst wieder',
];
const itemUrl = (title, url = TICKER) => withItemIdentity(url, itemIdentityToken(title));

function readRssFixtureItem(filename, url) {
  const xml = readFileSync(path.join(HERE, 'fixtures', 'canton-sources', filename), 'utf8');
  const item = [...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/g)]
    .map((match) => match[1])
    .find((entry) => entry.includes(`<link>${url}</link>`));
  assert.ok(item, `${filename}: item non trovato per ${url}`);
  const value = (tag) => item.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`))?.[1]?.trim() || '';
  return { url: value('link'), headline: value('title'), date: value('pubDate') };
}

function cutDecl(startAnchor) {
  const a = SRC.indexOf(startAnchor);
  assert.notEqual(a, -1, `dichiarazione non trovata — aggiornare questo test: ${startAnchor}`);
  const rel = SRC.slice(a).indexOf('\n}\n');
  assert.notEqual(rel, -1, `chiusura non trovata per: ${startAnchor}`);
  return SRC.slice(a, a + rel + 3);
}

/** `isSourceUrlAlreadyUsed` vero, con ledger e id articolo iniettati. */
function makeIsSourceUrlAlreadyUsed({ ledgers, articleIds = [], section = 'canton-gr' }) {
  const body = [
    cutDecl('function extractUrlSlugWords(rawUrl) {'),
    cutDecl('function isSourceUrlAlreadyUsed(headlineUrl) {'),
  ].join('\n');
  return new Function(
    'deps',
    `const { newsUrlKey, legacyNewsUrlKey, itemIdentityOf, ledgerViewsForLookup, findCrossSectionSourceDuplicate, ledgers, articleIds, SECTION_NAME } = deps;
     const normalizeNewsUrl = (u) => newsUrlKey(u);
     const loadAllSectionSourceUrls = () => ledgers;
     const getAllArticleIds = () => articleIds;
     ${body}
     return isSourceUrlAlreadyUsed;`,
  )({ newsUrlKey, legacyNewsUrlKey, itemIdentityOf, ledgerViewsForLookup, findCrossSectionSourceDuplicate, ledgers, articleIds, SECTION_NAME: section });
}

// ── La chiave ───────────────────────────────────────────────────────────────

test('newsUrlKey conserva l\'identita\' dell\'item: quattro notizie, quattro chiavi', () => {
  const keys = TITLES.map((t) => newsUrlKey(itemUrl(t)));
  assert.equal(new Set(keys).size, 4);
  for (const k of keys) assert.match(k, /^https:\/\/www\.suedostschweiz\.ch\/graubuenden\/verkehrsticker-1574112#ft-item=[0-9a-f]{12}$/);
});

test('newsUrlKey: ogni altro frammento resta ignorato, la chiave degli URL normali non cambia', () => {
  const plain = 'https://www.rsi.ch/info/ticino/Un-articolo--123.html';
  assert.equal(newsUrlKey(plain), legacyNewsUrlKey(plain));
  for (const frag of ['#commenti', '#ft-item', '#ft-item=', '#ft-item=XYZ', '#ft-item=abc', '#ft-item=0123456789abcdef', '#x=ft-item=0123456789ab']) {
    assert.equal(newsUrlKey(plain + frag), newsUrlKey(plain), `frammento ${frag}`);
    assert.equal(itemIdentityOf(plain + frag), null, `frammento ${frag}`);
    assert.equal(stripItemIdentity(plain + frag), plain + frag, `${frag}: non e' un'identita', non si tocca`);
  }
});

test('newsUrlKey: l\'identita\' convive con la query identificante e con i parametri di tracciamento', () => {
  const token = itemIdentityToken('Un titolo qualunque di prova');
  const url = withItemIdentity('https://example.ch/dettaglio?NEWS_ID=42&utm_source=rss', token);
  assert.equal(newsUrlKey(url), `https://example.ch/dettaglio?news_id=42#${ITEM_IDENTITY_FRAGMENT}=${token}`);
});

test('itemIdentityToken: maiuscole, accenti, punteggiatura e forma delle entita\' non contano; il testo si\'', () => {
  const a = itemIdentityToken('Schwerer Töffunfall bei Pontresina: Betrieb der RhB kurzzeitig eingestellt');
  assert.match(a, /^[0-9a-f]{12}$/);
  assert.equal(itemIdentityToken('  SCHWERER TOFFUNFALL bei Pontresina – Betrieb der RhB kurzzeitig eingestellt!  '), a);
  // Lo stesso titolo, tre serializzazioni: una chiave sola.
  for (const variant of ['Schwerer T&ouml;ffunfall', 'Schwerer T&#246;ffunfall', 'Schwerer T&#xF6;ffunfall', 'Schwerer To\u0308ffunfall']) {
    assert.equal(itemIdentityToken(`${variant} bei Pontresina: Betrieb der RhB kurzzeitig eingestellt`), a, variant);
  }
  assert.equal(itemIdentityToken('Caf&eacute; &amp; Bar: l&#039;apertura &laquo;storica&raquo;'), itemIdentityToken('Café & Bar: l\'apertura «storica»'));
  assert.equal(itemIdentityToken('Stra&szlig;e gesperrt'), itemIdentityToken('Straße gesperrt'));
  assert.notEqual(itemIdentityToken(TITLES[1]), itemIdentityToken(TITLES[2]), 'due incidenti a Pontresina sono due notizie');
  for (const empty of ['', '   ', '—', '&nbsp;&hellip;', null, undefined]) assert.equal(itemIdentityToken(empty), null);
  // La giornata di pubblicazione fa parte dell'identita'; l'ora no.
  const day = (iso) => itemIdentityToken(TITLES[0], new Date(iso));
  assert.equal(day('2026-10-05T06:00:00Z'), day('2026-10-05T21:30:00Z'));
  assert.notEqual(day('2026-10-05T06:00:00Z'), day('2026-10-08T06:00:00Z'));
  assert.notEqual(day('2026-10-05T06:00:00Z'), itemIdentityToken(TITLES[0]));
  assert.equal(itemIdentityToken(TITLES[0], new Date('non una data')), itemIdentityToken(TITLES[0]));
});

test('un titolo riscritto allo stesso URL e nella stessa giornata conserva una nuova identita\' (fixture feed)', () => {
  const url = 'https://www.bazonline.ch/femizid-binningen-gerichtspraesident-wird-geruegt-173243769017';
  const earlier = readRssFixtureItem('tamedia-bazonline.xml', url);
  const later = readRssFixtureItem('tamedia-bazonline-later.xml', url);

  assert.equal(earlier.url, later.url);
  assert.equal(new Date(earlier.date).toISOString().slice(0, 10), '2026-10-05');
  assert.equal(new Date(later.date).toISOString().slice(0, 10), '2026-10-05');
  assert.notEqual(earlier.headline, later.headline);
  assert.notEqual(
    itemIdentityToken(earlier.headline, new Date(earlier.date)),
    itemIdentityToken(later.headline, new Date(later.date)),
  );
});

test('withItemIdentity / stripItemIdentity: andata e ritorno, e un frammento preesistente e\' sostituito', () => {
  const token = itemIdentityToken(TITLES[0]);
  assert.equal(stripItemIdentity(withItemIdentity(TICKER, token)), TICKER);
  assert.equal(withItemIdentity(`${TICKER}#kommentare`, token), `${TICKER}#${ITEM_IDENTITY_FRAGMENT}=${token}`);
  assert.equal(withItemIdentity(TICKER, null), TICKER);
  assert.equal(itemIdentityOf(withItemIdentity(TICKER, token)), token);
  // Il frammento non arriva al server: l'URL resta quello della pagina.
  const parsed = new URL(withItemIdentity(TICKER, token));
  assert.equal(parsed.origin + parsed.pathname, TICKER);
});

// ── isSourceUrlAlreadyUsed, il codice vero ──────────────────────────────────

test('ledger: la notizia gia\' usata e\' bloccata, la successiva allo stesso indirizzo passa', () => {
  const ledgers = { 'canton-gr': { [newsUrlKey(itemUrl(TITLES[1]))]: makeLedgerEntry('pontresina-incidente-moto-neve') }, frontaliere: {}, svizzera: {} };
  const used = makeIsSourceUrlAlreadyUsed({ ledgers });
  assert.equal(used(itemUrl(TITLES[1])).used, true);
  assert.equal(used(itemUrl(TITLES[1])).articleId, 'pontresina-incidente-moto-neve');
  assert.equal(used(itemUrl(TITLES[2])).used, false, 'un altro incidente, stesso contenitore: non e\' un duplicato');
  assert.equal(used(itemUrl(TITLES[3])).used, false);
});

test('ledger: senza identita\' lo stesso scenario blocca tutto (il difetto, su codice vero)', () => {
  const ledgers = { 'canton-gr': { [newsUrlKey(TICKER)]: makeLedgerEntry('pontresina-incidente-moto-neve') }, frontaliere: {}, svizzera: {} };
  const used = makeIsSourceUrlAlreadyUsed({ ledgers });
  assert.equal(used(TICKER).used, true, 'qualunque notizia successiva a quell\'indirizzo e\' «gia\' usata»');
});

test('ledger: il blocco cross-sezione vale anche per una notizia con identita\'', () => {
  const ledgers = { 'canton-gr': {}, 'canton-gl': { [newsUrlKey(itemUrl(TITLES[3]))]: makeLedgerEntry('flims-trin-incidente') }, frontaliere: {} };
  const check = makeIsSourceUrlAlreadyUsed({ ledgers })(itemUrl(TITLES[3]));
  assert.equal(check.used, true);
  assert.equal(check.crossSection, true);
  assert.equal(check.section, 'canton-gl');
});

test('URL riusato: ne\' il ponte di forma 1 ne\' il ramo fuzzy sullo slug del contenitore', () => {
  // Una voce storica (stringa nuda, forma 1) sul path del contenitore, e un
  // articolo esistente il cui id somiglia allo SLUG del contenitore: sotto
  // questo indirizzo il feed del 2026-10-05 porta un incidente stradale.
  const container = 'https://www.suedostschweiz.ch/graubuenden/bonaduz-feuerwehr-loescht-brand-auf-dach-mit-photovoltaikanlage-1413717';
  const ledgers = { 'canton-gr': {}, svizzera: { [legacyNewsUrlKey(container)]: 'bonaduz-incendio-tetto-fotovoltaico' } };
  const articleIds = ['bonaduz-feuerwehr-loescht-brand-dach-photovoltaikanlage'];
  const used = makeIsSourceUrlAlreadyUsed({ ledgers, articleIds });
  const story = itemUrl('Deshalb war die Strasse gesperrt: Anhänger von Lastwagen gerät in Brand', container);
  assert.deepEqual(used(story), { used: false });
  // Lo stesso indirizzo SENZA identita' (fonte che non riusa gli URL) resta
  // bloccato dal ramo esatto, che per un path senza query coincide con la forma 1,
  // e — tolta quella voce — dal ramo fuzzy: nessuna delle due reti e' allentata.
  assert.equal(used(container).used, true);
  const fuzzy = makeIsSourceUrlAlreadyUsed({ ledgers: { 'canton-gr': {}, svizzera: {} }, articleIds })(container);
  assert.equal(fuzzy.signal, 'url_slug_match');
});

// ── La pagina porta ancora l'item? ──────────────────────────────────────────

test('pageCarriesItem: la pagina reale del ticker porta la notizia di oggi e nessuna delle precedenti', () => {
  // La pagina del 2026-10-05 (ridotta: script e stile tolti), come testo.
  const html = readFileSync(path.join(HERE, 'fixtures', 'canton-sources', 'suedostschweiz-verkehrsticker-page.html'), 'utf8');
  const page = html.replace(/<[^>]+>/g, ' ');
  const title = pageTitleEvidence(html);
  const current = readRssFixtureItem('suedostschweiz-graubuenden.xml', TICKER);
  assert.equal(current.headline, TITLES[3]);
  assert.equal(new Date(current.date).toISOString(), '2026-10-05T10:49:15.000Z');
  assert.equal(pageCarriesItem(page, current.headline), true, 'il titolo del feed di oggi');
  for (const earlier of TITLES.slice(0, 3)) assert.equal(pageCarriesItem(page, earlier), false, earlier);
  // Il corpo non ripete il titolo alla lettera: contano le parole distintive.
  assert.equal(pageCarriesItem('Zwischen Flims und Trin kam es zu einem Unfall. Der Verkehr fliesst inzwischen wieder.', TITLES[3]), true);
  // Un titolo breve non passa dalla sola parola nel testo; la pagina reale non lo dichiara come titolo.
  assert.equal(pageCarriesItem(page, 'A 13: Stau'), false);
  assert.equal(pageCarriesItem(page, 'A 13: Stau', { titleEvidence: title }), false);
  assert.equal(pageCarriesItem('', TITLES[3]), false);
});

test('shortHeadlineEvidence: richiede il titolo completo fra i titoli dichiarati dalla pagina', () => {
  // Esempi sintetici per il predicato puro; le prove di pagina sono testate
  // separatamente con i fixture RSS/HTML acquisiti dalla fonte.
  assert.equal(shortHeadlineEvidence('A 13: Stau', 'A 13: Stau'), true);
  assert.equal(shortHeadlineEvidence('Titolo diverso\rA 13: Stau', 'A 13: Stau'), false);
  assert.equal(shortHeadlineEvidence('A 13: Stau | Südostschweiz', 'A 13: Stau'), false);
  assert.equal(shortHeadlineEvidence('A 13: Unfall', 'A 13: Stau'), false);
  assert.equal(shortHeadlineEvidence('Stau im Verkehr auf der A 13', 'A 13: Stau'), false);
  assert.equal(shortHeadlineEvidence('Stau – A13', 'Stau'), false);
  assert.equal(shortHeadlineEvidence('Stau — A13', 'Stau'), false);
  assert.equal(shortHeadlineEvidence('Stau - A13', 'Stau'), false);
  assert.equal(shortHeadlineEvidence('Stau | A13', 'Stau'), false);
  assert.equal(shortHeadlineEvidence('A 13: Stau', TITLES[3]), false);

  // Il testo generico da solo non basta; il titolo dichiarato si'.
  assert.equal(pageCarriesItem('Stau, Erdrutsch oder sonst ein Ereignis', 'A 13: Stau'), false);
  assert.equal(pageCarriesItem('testo generico con Stau', 'A 13: Stau', { titleEvidence: 'A 13: Stau' }), true);
  assert.equal(pageCarriesItem('testo generico con Stau', 'A 13: Stau', { titleEvidence: 'Titolo diverso' }), false);
});

test('shortHeadlineTokenPolicy counts visible Unicode characters instead of UTF-16 code units', () => {
  assert.equal(shortHeadlineTokenPolicy('abcd'), true);
  assert.equal(shortHeadlineTokenPolicy('abc'), false);
  assert.equal(shortHeadlineTokenPolicy('𐐀𐐁'), false, 'two astral letters are two visible characters');
  assert.equal(shortHeadlineTokenPolicy('e\u0301x'), false, 'a combining sequence is one visible character');
  assert.equal(shortHeadlineTokenPolicy('e\u0301xit'), true, 'four grapheme clusters meet the threshold');

  const headline = '𐐀𐐁 𐐂𐐃';
  assert.equal(shortHeadlineEvidence(headline, headline), true);
  assert.equal(pageCarriesItem('', headline, { titleEvidence: headline }), true);
});

test('selectConsistentTitleEvidence rejects conflicting declarations before matching a headline', () => {
  const matching = 'A 13: Stau';
  const equivalent = 'a 13 – STAU';
  const conflicting = `A 13: Unfall\r${matching}`;
  const conflictingHtml = pageTitleEvidence(
    '<meta property="og:title" content="A 13: Unfall">'
      + '<meta name="twitter:title" content="A 13: Stau">',
  );

  assert.equal(selectConsistentTitleEvidence(`${matching}\r${equivalent}`), matching);
  assert.equal(selectConsistentTitleEvidence([`${matching}\r${equivalent}`, 'A 13: STAU']), matching);
  assert.equal(selectConsistentTitleEvidence(conflicting), '');
  assert.equal(selectConsistentTitleEvidence([conflicting]), '');
  assert.equal(shortHeadlineEvidence(conflicting, matching), false);
  assert.equal(shortHeadlineEvidence(conflictingHtml, matching), false);
});

test('checkItemOnPage: titoli della pagina, testo e giornata — sulla pagina reale del ticker', () => {
  const html = readFileSync(path.join(HERE, 'fixtures', 'canton-sources', 'suedostschweiz-verkehrsticker-page.html'), 'utf8');
  const title = pageTitleEvidence(html);
  assert.match(title, /Nach Unfall zwischen Flims und Trin: Verkehr fliesst wieder/);
  // Il corpo estratto non porta l'h1 (extractArticleText da' i paragrafi):
  // qui un corpo che del titolo non ripete quasi niente.
  const body = 'Die Strasse war am Mittag während rund einer Stunde nur einspurig befahrbar. Verletzt wurde niemand.';
  assert.equal(pageCarriesItem(body, TITLES[3]), false, 'premessa: il solo corpo non basterebbe');
  const page = { title, text: body, publishedAt: '2026-10-05T10:49:15.000Z' };
  const current = readRssFixtureItem('suedostschweiz-graubuenden.xml', TICKER);
  const today = new Date(current.date);
  assert.deepEqual(checkItemOnPage(page, current), { ok: true, reason: 'ok' });
  // Un'altra notizia allo stesso indirizzo.
  assert.deepEqual(checkItemOnPage(page, { headline: TITLES[2], date: new Date('2026-08-26T09:00:00Z') }), { ok: false, reason: 'title-not-on-page' });
  // Lo stesso titolo, ma l'item e' di un altro giorno: e' un'altra notizia.
  assert.deepEqual(checkItemOnPage(page, { headline: TITLES[3], date: new Date('2026-10-02T08:00:00Z') }), { ok: false, reason: 'other-day' });
  // La pagina non dichiara una data: decide il titolo.
  assert.equal(checkItemOnPage({ title, text: body, publishedAt: '' }, { headline: TITLES[3], date: today }).ok, true);
  assert.equal(checkItemOnPage({ title, text: body, publishedAt: 'non una data' }, { headline: TITLES[3], date: today }).ok, true);
  // Pagina non scaricata, o item senza titolo: non si e' verificato niente.
  assert.deepEqual(checkItemOnPage({ title: '', text: '', publishedAt: '' }, { headline: TITLES[3], date: today }), { ok: false, reason: 'no-page' });
  assert.equal(checkItemOnPage(page, { headline: '', date: today }).ok, false);
  assert.equal(checkItemOnPage(page, {}).ok, false);
});

test('pageTitleEvidence: og:title, twitter:title, <title> e <h1>; niente da una pagina che non ne ha', () => {
  const html = '<html><head><title>Titolo | Testata</title><meta content="Titolo da og" property="og:title"><meta name=\'twitter:title\' content=\'Titolo da twitter\'><meta property="og:description" content="non un titolo"></head><body><h1 class="t">Titolo <em>in pagina</em></h1><p>corpo</p></body></html>';
  assert.deepEqual(pageTitleEvidence(html).split('\n'), ['Titolo da og', 'Titolo da twitter', 'Titolo | Testata', 'Titolo in pagina']);
  // Un titolo in un commento, in uno script o in un template non e' della pagina.
  assert.equal(pageTitleEvidence('<!-- <h1>Titolo vecchio</h1> --><script>var t = "<title>Titolo in uno script</title>";</script><template><h1>Titolo in un template</h1></template><h1>Titolo vero</h1>'), 'Titolo vero');
  assert.equal(pageTitleEvidence('<p>solo corpo</p>'), '');
  assert.equal(pageTitleEvidence(''), '');
});

test('pageTitleEvidence non legge i meta letterali dentro il testo di <title>', () => {
  const html = '<html><head><title><meta property="og:title" content="FALSO_META_TITLE">Titolo vero</title>'
    + '</head><body><p>corpo</p></body></html>';
  assert.equal(pageTitleEvidence(html), 'Titolo vero');
});

test('pageTitleEvidence tratta il fallback noscript come markup attivo solo con scripting disabilitato', () => {
  const html = '<noscript><h1>Titolo di fallback</h1></noscript>';
  assert.equal(pageTitleEvidence(html), '');
  assert.equal(pageTitleEvidence(html, { scriptingDisabled: true }), 'Titolo di fallback');
});

test('pageTitleEvidence attiva noscript solo nel body, mai in head o template', () => {
  const html = '<html><head><noscript><h1>TITOLO_HEAD_INATTIVO</h1></noscript></head><body>'
    + '<noscript><h1>TITOLO_BODY_ATTIVO</h1></noscript>'
    + '<template><noscript><h1>TITOLO_TEMPLATE_INATTIVO</h1></noscript></template>'
    + '</body></html>';
  assert.equal(pageTitleEvidence(html, { scriptingDisabled: true }), 'TITOLO_BODY_ATTIVO');

  const implicitHead = '<html><noscript><h1>TITOLO_HEAD_IMPLICITO</h1></noscript><body>'
    + '<noscript><h1>TITOLO_BODY_IMPLICITO</h1></noscript></body></html>';
  assert.equal(pageTitleEvidence(implicitHead, { scriptingDisabled: true }), 'TITOLO_BODY_IMPLICITO');

  const textClosesHead = '<html><head>testo non whitespace<noscript>'
    + '<h1>TITOLO_BODY_DOPO_CHIUSURA_IMPLICITA</h1></noscript></html>';
  assert.equal(pageTitleEvidence(textClosesHead, { scriptingDisabled: true }), 'TITOLO_BODY_DOPO_CHIUSURA_IMPLICITA');
});

test('pageTitleEvidence mantiene inattivo noscript dopo il testo raw di title nell’head', () => {
  const explicitHead = '<html><head><title>TITOLO_ESPLICITO</title>'
    + '<noscript><h1>TITOLO_HEAD_ESPLICITO_INATTIVO</h1></noscript></head>'
    + '<body><h1>TITOLO_BODY_ESPLICITO</h1></body></html>';
  assert.equal(
    pageTitleEvidence(explicitHead, { scriptingDisabled: true }),
    'TITOLO_ESPLICITO\nTITOLO_BODY_ESPLICITO',
  );

  const implicitHead = '<html><title>TITOLO_IMPLICITO</title>'
    + '<noscript><h1>TITOLO_HEAD_IMPLICITO_INATTIVO</h1></noscript><body>'
    + '<noscript><h1>TITOLO_BODY_IMPLICITO_ATTIVO</h1></noscript></body></html>';
  assert.equal(
    pageTitleEvidence(implicitHead, { scriptingDisabled: true }),
    'TITOLO_IMPLICITO\nTITOLO_BODY_IMPLICITO_ATTIVO',
  );
});

test('pageTitleEvidence non interpreta metadata letterale dentro il testo RCDATA di title', () => {
  const html = '<html><head><title>Titolo principale '
    + '<meta property="og:title" content="TITOLO_STALE_NEL_TITLE"></title>'
    + '<meta property="og:title" content="TITOLO_REALE"></head>'
    + '<body><h1>Corpo</h1></body></html>';
  assert.deepEqual(pageTitleEvidence(html).split('\n'), ['TITOLO_REALE', 'Titolo principale', 'Corpo']);
});

test('pageTitleEvidence esclude title SVG e markup letterale nel textarea', () => {
  const html = '<html><head><title>TITLE_REALE</title></head><body>'
    + '<svg><title>SVG_TITLE</title><h1>SVG_H1</h1>'
    + '<meta property="og:title" content="SVG_META"></svg>'
    + '<svg><foreignObject><textarea></svg><h1>TEXTAREA_SVG_CLOSE</h1></textarea>'
    + '</foreignObject></svg>'
    + '<textarea><h1>TEXTAREA_H1</h1><title>TEXTAREA_TITLE</title></textarea>'
    + '<h1>H1_REALE</h1></body></html>';
  assert.deepEqual(pageTitleEvidence(html).split('\n'), ['TITLE_REALE', 'H1_REALE']);
  assert.equal(pageTitleEvidence('<plaintext><h1>PLAINTEXT_H1</h1>'), '');
});

test('pageTitleEvidence non riapre l’head dopo la chiusura del documento', () => {
  const html = '<html><title>TITLE_DOCUMENTALE</title></html>'
    + '<head><title>TITLE_STALE</title><meta property="og:title" content="META_STALE"></head>';
  assert.equal(pageTitleEvidence(html), 'TITLE_DOCUMENTALE');
});

test('pageTitleEvidence esclude i metadata e i title dei head annidati nel body', () => {
  const html = '<html><head><meta property="og:title" content="META_REALE">'
    + '<title>TITLE_REALE</title></head><body><article><head>'
    + '<meta property="og:title" content="META_STALE_HEAD_NESTED">'
    + '<title>TITLE_STALE_HEAD_NESTED</title></head>'
    + '<h1>H1_REALE</h1></article></body></html>';
  assert.deepEqual(pageTitleEvidence(html).split('\n'), ['META_REALE', 'TITLE_REALE', 'H1_REALE']);
});

test('pageTitleEvidence ignora DOCTYPE e prologo XML prima dell’head documentale', () => {
  const declarations = ['<!doctype html>', '<?xml version="1.0"?>'];
  for (const declaration of declarations) {
    const html = declaration + '<html><head>'
      + '<meta property="og:title" content="TITLE_DOCUMENTALE">'
      + '<title>TITLE_DOCUMENTALE</title></head><body><h1>H1_DOCUMENTALE</h1></body></html>';
    assert.deepEqual(
      pageTitleEvidence(html).split('\n'),
      ['TITLE_DOCUMENTALE', 'TITLE_DOCUMENTALE', 'H1_DOCUMENTALE'],
      `${declaration} non deve spostare l’head nel body`,
    );
  }
});

test('pageTitleEvidence chiude il percorso su un tag non terminato', () => {
  const malformed = '<meta data="<title>Titolo falso</title>';
  assert.equal(pageTitleEvidence(malformed), '', 'un titolo dopo il tag malformato non e\' evidenza attiva');

  // Ogni apertura apparente lascia la ricerca di `>` senza una chiusura: il
  // vecchio caller riprovava dall\'apertura successiva e diventava quadratico.
  const repeated = '<meta data=' + '<x '.repeat(16000) + '"';
  const started = performance.now();
  assert.equal(pageTitleEvidence(repeated), '');
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 250, `ledger scanner troppo lento su markup malformato: ${elapsed.toFixed(1)}ms`);
});

test('la generazione si ferma se la pagina di un URL riusato non e\' l\'item scelto', () => {
  const start = SRC.indexOf('async function generateAndValidateArticle(sourceUrl, sourceContext = null) {');
  const fn = SRC.slice(start, SRC.indexOf('\n}\n', start));
  const fetchAt = fn.indexOf('const pageContent = await fetchPageContent(url);');
  const guardAt = fn.indexOf('if (itemIdentityOf(sourceUrl) !== null) {');
  const firstLlm = fn.indexOf('callGemini(');
  assert.ok(fetchAt !== -1 && guardAt > fetchAt, 'la guardia deve stare subito dopo la fetch della pagina');
  assert.ok(firstLlm > guardAt, 'e prima della prima chiamata al modello');
  const guard = fn.slice(guardAt, fn.indexOf('\n  }\n', guardAt));
  // Titoli, testo e data della pagina contro titolo e data dell'item.
  assert.match(guard, /checkItemOnPage\(\s*\{ title: lastSourcePageTitle, text: [^}]*pageContent[^}]*, publishedAt: lastSourcePublishedAt \},\s*\{ headline: sourceContext\?\.headline, date: sourceContext\?\.date \},/);
  assert.match(guard, /if \(!itemCheck\.ok\) \{/);
  assert.match(guard, /err\.topicGateAbort = true;/, 'un abort che il ciclo ricorda sull\'item e passa alla headline successiva');
  // I titoli della pagina vengono dalla stessa fetch del testo, e si azzerano con lei.
  const fetchFn = SRC.slice(SRC.indexOf('async function fetchPageContent(url) {'), SRC.indexOf('\nconst MAX_ARTICLE_AGE_DAYS'));
  assert.match(fetchFn, /lastSourcePageTitle = '';/);
  // Title evidence must come from the same isolated source passed to the
  // extractor; the full page can contain stale chrome titles outside the item.
  assert.match(fetchFn, /lastSourcePageTitle = pageTitleEvidence\(isolation\.html,\s*\{\s*scriptingDisabled:\s*isolation\.isolated,?\s*\}\);/);
});

// ── Il cablaggio in create-article.mjs ──────────────────────────────────────

test('la generazione lavora sull\'indirizzo senza identita\' e registra nel ledger quello con', () => {
  const start = SRC.indexOf('async function generateAndValidateArticle(sourceUrl, sourceContext = null) {');
  assert.notEqual(start, -1, 'firma di generateAndValidateArticle cambiata — aggiornare questo test');
  const end = SRC.indexOf('\n}\n', start);
  const fn = SRC.slice(start, end);
  assert.match(fn, /const url = stripItemIdentity\(sourceUrl\);/, 'la pagina da scaricare e la citazione devono usare l\'indirizzo del sito');
  assert.match(fn, /recordSourceUrl\(sourceUrl, data\.id\);/, 'il ledger deve ricevere l\'URL CON l\'identita\' dell\'item');
  assert.doesNotMatch(fn, /recordSourceUrl\(url,/, 'registrare l\'URL nudo rimetterebbe in piedi il collasso');
  assert.doesNotMatch(fn, /fetchPageContent\(sourceUrl\)|citationUrl[^;]*sourceUrl/, 'l\'identita\' non deve arrivare ne\' alla fetch ne\' alla citazione');
});

test('lo scanner e\' l\'unico a costruire l\'identita\', con le funzioni del ledger', () => {
  const scanner = readFileSync(path.join(HERE, '..', 'scripts', 'lib', 'canton-news-sources.mjs'), 'utf8');
  assert.match(scanner, /import \{[^}]*\bitemIdentityToken\b[^}]*\bwithItemIdentity\b[^}]*\} from '\.\/source-url-ledger\.mjs';/);
  // Un valore condiviso ha UNA sorgente: il nome del frammento non si riscrive altrove.
  assert.doesNotMatch(scanner.replace(/^\s*(\*|\/\/).*$/gm, ''), /ft-item/);
  assert.doesNotMatch(SRC.replace(/^\s*(\*|\/\/).*$/gm, ''), /ft-item/);
});
