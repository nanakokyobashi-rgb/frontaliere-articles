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
  pageCarriesItem,
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
  const page = readFileSync(path.join(HERE, 'fixtures', 'canton-sources', 'suedostschweiz-verkehrsticker-page.html'), 'utf8').replace(/<[^>]+>/g, ' ');
  assert.equal(pageCarriesItem(page, TITLES[3]), true, 'il titolo del feed di oggi');
  for (const earlier of TITLES.slice(0, 3)) assert.equal(pageCarriesItem(page, earlier), false, earlier);
  // Il corpo non ripete il titolo alla lettera: contano le parole distintive.
  assert.equal(pageCarriesItem('Zwischen Flims und Trin kam es zu einem Unfall. Der Verkehr fliesst inzwischen wieder.', TITLES[3]), true);
  // Un titolo senza parole distintive non si puo' verificare: non passa.
  assert.equal(pageCarriesItem(page, 'A 13: Stau'), false);
  assert.equal(pageCarriesItem('', TITLES[3]), false);
});

test('la generazione si ferma se la pagina di un URL riusato non porta piu\' l\'item scelto', () => {
  const start = SRC.indexOf('async function generateAndValidateArticle(sourceUrl, sourceContext = null) {');
  const fn = SRC.slice(start, SRC.indexOf('\n}\n', start));
  const fetchAt = fn.indexOf('const pageContent = await fetchPageContent(url);');
  const guardAt = fn.indexOf('if (itemIdentityOf(sourceUrl) !== null) {');
  const firstLlm = fn.indexOf('callGemini(');
  assert.ok(fetchAt !== -1 && guardAt > fetchAt, 'la guardia deve stare subito dopo la fetch della pagina');
  assert.ok(firstLlm > guardAt, 'e prima della prima chiamata al modello');
  const guard = fn.slice(guardAt, fn.indexOf('\n  }\n', guardAt));
  assert.match(guard, /!pageCarriesItem\(pageContent, itemHeadline\)/);
  // Fail-closed: una pagina non scaricata non ha verificato niente.
  assert.match(guard, /pageContent\.length === 0 \|\| !pageCarriesItem/);
  assert.match(guard, /err\.topicGateAbort = true;/, 'un abort che il ciclo ricorda sull\'item e passa alla headline successiva');
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
