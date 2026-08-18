/**
 * news-url-key.test.mjs — la chiave del ledger delle fonti conserva l'identità
 * del documento anche quando la fonte la mette solo nella query.
 *
 * ## Il difetto che tiene chiuso
 *
 * `normalizeNewsUrl` costruiva la chiave come `protocol//hostname + pathname`.
 * Su una fonte che identifica il documento SOLO nella query, ogni articolo del
 * feed collassa sulla stessa chiave: pubblicato un comunicato, il giorno dopo
 * un comunicato completamente diverso trova un hit esatto in
 * `isSourceUrlAlreadyUsed` e finisce in `preFilterDrops.urlAlreadyUsed`. Il
 * ramo fuzzy non salva: `extractUrlSlugWords` su `.../dettaglio-comunicato`
 * non trova parole descrittive.
 *
 * MISURATO il 2026-08-18 con l'estrattore reale (`extractRssItems`) sui 69 feed
 * di `NEWS_SOURCES`, 1.121 item raccolti:
 *
 *   https://www.uil.it/feed                              60 item → 1 chiave
 *   https://www3.ti.ch/xml/rss/rss-comunicati-1108.xml   10 item → 1 chiave
 *   https://www3.ti.ch/xml/rss/rss-attualita.xml         10 item → 2 chiavi
 *   https://www3.ti.ch/xml/rss/rss-comunicati.xml         8 item → 2 chiavi
 *
 * Gli URL di questo file sono quelli veri, copiati da quella scansione. Con la
 * chiave di forma 1 il primo test qui sotto legge 2 invece di 8: è il test che
 * senza la fix è rosso.
 *
 * ## Perché gli URL sono cablati e non riletti dai feed
 *
 * Un test che va in rete è un flake, e uno che conta le voci di
 * `data/article-source-urls.json` nasce instabile — quel file lo riscrivono i
 * bot su `main` in continuazione. Ciò che va tenuto fermo è la FORMA della
 * chiave, e per quella bastano gli URL osservati.
 *
 * Esegui:
 *   node --test generator/tests/news-url-key.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SOURCE_URL_KEY_FORM,
  isTrackingParam,
  legacyNewsUrlKey,
  ledgerViewsForLookup,
  makeLedgerEntry,
  newsUrlKey,
} from '../scripts/lib/source-url-ledger.mjs';
import { findCrossSectionSourceDuplicate } from '../scripts/lib/cross-section-dedup.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');

/** Gli 8 item veri di `rss-comunicati.xml`, letti il 2026-08-18. */
const TI_CH_COMUNICATI = [
  'https://www4.ti.ch/tich/area-media/comunicati/dettaglio-comunicato/?NEWS_ID=260792',
  'https://www4.ti.ch/tich/area-media/comunicati/dettaglio-comunicato/?NEWS_ID=260773',
  'https://www4.ti.ch/tich/area-media/comunicati/dettaglio-comunicato/?NEWS_ID=260729',
  'https://www4.ti.ch/tich/area-media/comunicati/dettaglio-comunicato/?NEWS_ID=260803',
  'https://www4.ti.ch/tich/area-media/comunicati/dettaglio-comunicato/?NEWS_ID=260737',
  'https://www4.ti.ch/tich/area-media/comunicati/dettaglio-comunicato/?NEWS_ID=260727',
  'https://www4.ti.ch/index.php?id=41987',
  'https://www4.ti.ch/tich/area-media/comunicati/dettaglio-comunicato/?NEWS_ID=260744',
];

// ── Strato 1: l'identità che si perdeva ──────────────────────────────────────

test('gli 8 comunicati ti.ch danno 8 chiavi distinte', () => {
  const chiavi = new Set(TI_CH_COMUNICATI.map(newsUrlKey));
  assert.equal(
    chiavi.size,
    TI_CH_COMUNICATI.length,
    'due comunicati diversi condividono la chiave del ledger: pubblicato il primo, gli altri '
    + `vengono scartati come urlAlreadyUsed. Chiavi prodotte:\n  ${[...chiavi].join('\n  ')}`,
  );
  // E il contrario, che è ciò che rende il test non vacuo: con la chiave
  // storica ne restano 2, non 8. Se questa riga smettesse di valere, il primo
  // assert sopra passerebbe anche senza la fix.
  assert.equal(new Set(TI_CH_COMUNICATI.map(legacyNewsUrlKey)).size, 2);
});

test('gli item di uil.it restano distinti nonostante i parametri di campagna', () => {
  // Forma reale del feed: `&amp;` non de-escapato da extractRssItems, e i
  // marcatori utm_* attaccati all'identificatore.
  const url = (id) => 'https://www.uil.it/newssx.asp?ID_News=' + id
    + '&amp;Provenienza=1&amp;utm_source=rssfeed&amp;utm_medium=links&amp;utm_campaign=spreadlinks';
  const chiavi = new Set([17391, 17390, 17389, 17388].map((id) => newsUrlKey(url(id))));
  assert.equal(chiavi.size, 4, `4 notizie diverse su ${chiavi.size} chiave/i: ${[...chiavi].join(' ')}`);
  for (const k of chiavi) {
    assert.ok(!k.includes('utm_'), `parametro di campagna finito nella chiave: ${k}`);
    assert.ok(!k.includes('amp;'), `entità XML non de-escapata nella chiave: ${k}`);
  }
});

test('il feed USTAT (fuseaction) non collassa su index.php', () => {
  const a = newsUrlKey('https://www3.ti.ch/dfe/dr/ustat/index.php?fuseaction=news.dettaglio&amp;tipo=1&amp;id=1234');
  const b = newsUrlKey('https://www3.ti.ch/dfe/dr/ustat/index.php?fuseaction=news.dettaglio&amp;tipo=1&amp;id=5678');
  assert.notEqual(a, b);
});

// ── Strato 2: il dedup che NON deve smettere di funzionare ───────────────────

test('senza query la chiave non cambia di un byte', () => {
  // È la forma di TUTTE le 414 voci committate il 2026-08-18: se questa
  // uguaglianza saltasse, ogni articolo già pubblicato tornerebbe ammissibile.
  for (const u of [
    'https://www.tio.ch/ticino/attualita/1941660/sa-lavoro-vallemaggia-posti-matrimonio-vale',
    'https://www.rsi.ch/s/3926505',
    'https://www.varesenews.it/2026/08/accise-232-milioni-arrivano-dai-ministeri/2653150/',
    'https://cassa-disoccupazione.unia.ch',
    'stats-bfs://2026-q2',
  ]) {
    assert.equal(newsUrlKey(u), legacyNewsUrlKey(u), `chiave cambiata su un URL senza query: ${u}`);
  }
});

test('una query di solo tracciamento lascia la chiave uguale a quella storica', () => {
  const base = 'https://www.tio.ch/ticino/attualita/1941660/sa-lavoro-vallemaggia';
  for (const q of [
    '?utm_source=facebook&utm_medium=social&utm_campaign=post',
    '?fbclid=IwAR0abcdef',
    '?gclid=Cj0KCQ&ref=homepage',
    '?utm_source=newsletter',
    '?source=rss&from=timeline',
  ]) {
    assert.equal(newsUrlKey(base + q), legacyNewsUrlKey(base), `il tracciamento è entrato nella chiave: ${q}`);
  }
});

test('lo stesso URL condiviso da due strade dà una chiave sola', () => {
  // È il caso che una allowlist non avrebbe protetto meglio e che una denylist
  // protegge: due arrivi dello stesso documento (scan diretto vs Google News
  // decodificato) non devono produrre due voci.
  const a = 'https://www.laregione.ch/cantone/lugano/1806/frontalieri-in-aumento';
  const b = `${a}?utm_source=google_news&utm_medium=referral`;
  assert.equal(newsUrlKey(a), newsUrlKey(b));
});

test('l\'ordine dei parametri non cambia la chiave, il valore sì', () => {
  assert.equal(
    newsUrlKey('https://x.ch/n?b=2&a=1'),
    newsUrlKey('https://x.ch/n?a=1&b=2'),
  );
  // Nome minuscolizzato: uil.it emette lo STESSO feed con `ID_News` e `ID_NEWS`.
  assert.equal(
    newsUrlKey('https://www.uil.it/newssx.asp?ID_News=17391'),
    newsUrlKey('https://www.uil.it/newssx.asp?ID_NEWS=17391'),
  );
  // Valore NON minuscolizzato: un id può essere un hashid o base64, e fondere
  // due documenti è la direzione di rischio che questa fix esiste per togliere.
  assert.notEqual(newsUrlKey('https://x.ch/n?id=AbC'), newsUrlKey('https://x.ch/n?id=abc'));
});

test('un parametro senza valore non fabbrica una chiave diversa', () => {
  const base = 'https://x.ch/rubrica/notizia';
  assert.equal(newsUrlKey(`${base}?id=`), legacyNewsUrlKey(base));
});

test('un URL non parsabile sopravvive come prima', () => {
  assert.equal(newsUrlKey('non-un-url/'), 'non-un-url');
  assert.equal(newsUrlKey(''), '');
  assert.equal(newsUrlKey(null), '');
});

test('isTrackingParam copre le famiglie a prefisso, non solo i nomi interi', () => {
  for (const n of ['utm_source', 'UTM_Campaign', 'fbclid', 'gclid', 'at_medium', 'mtm_source', '_ga']) {
    assert.equal(isTrackingParam(n), true, `non riconosciuto come tracciamento: ${n}`);
  }
  for (const n of ['NEWS_ID', 'ID_News', 'fuseaction', 'user_polizia_pi1[newsId]', 'tipo']) {
    assert.equal(isTrackingParam(n), false, `identificatore scambiato per tracciamento: ${n}`);
  }
});

// ── Strato 3: il ponte verso le voci di forma 1 ──────────────────────────────

const LEDGERS = (voci) => ({ frontaliere: voci, svizzera: {} });

test('una voce STORICA sul path nudo blocca ancora un URL con query', () => {
  const u = 'https://www4.ti.ch/tich/area-media/comunicati/dettaglio-comunicato/?NEWS_ID=260792';
  const storico = LEDGERS({ [legacyNewsUrlKey(u)]: 'comunicato-vecchio' });

  // Ricerca principale: la chiave di forma 2 non c'è.
  assert.equal(
    findCrossSectionSourceDuplicate(newsUrlKey(u), ledgerViewsForLookup(storico, 'frontaliere'), 'frontaliere').used,
    false,
  );
  // Ponte: la voce senza `keyForm` è di forma 1 e va vista.
  const ponte = findCrossSectionSourceDuplicate(
    legacyNewsUrlKey(u),
    ledgerViewsForLookup(storico, 'frontaliere', { keyForm: 1 }),
    'frontaliere',
  );
  assert.equal(ponte.used, true);
  assert.equal(ponte.articleId, 'comunicato-vecchio');
});

test('il ponte NON vede le voci nuove: è ciò che impedisce al collasso di tornare', () => {
  // Pubblicato il comunerato 260792 con la chiave di forma 2. Il 260773 ha lo
  // stesso path nudo: se il ponte guardasse anche le voci `keyForm: 2` lo
  // troverebbe e lo scarterebbe — cioè esattamente il difetto, riaperto dal
  // meccanismo che doveva solo fare da ponte.
  const pubblicato = 'https://www4.ti.ch/tich/area-media/comunicati/dettaglio-comunicato/?NEWS_ID=260792';
  const nuovo = 'https://www4.ti.ch/tich/area-media/comunicati/dettaglio-comunicato/?NEWS_ID=260773';
  const ledgers = LEDGERS({ [newsUrlKey(pubblicato)]: makeLedgerEntry('comunicato-260792') });

  assert.equal(
    findCrossSectionSourceDuplicate(newsUrlKey(nuovo), ledgerViewsForLookup(ledgers, 'frontaliere'), 'frontaliere').used,
    false,
  );
  assert.equal(
    findCrossSectionSourceDuplicate(
      legacyNewsUrlKey(nuovo),
      ledgerViewsForLookup(ledgers, 'frontaliere', { keyForm: 1 }),
      'frontaliere',
    ).used,
    false,
    'il ponte ha ritrovato una voce di forma 2 dal path nudo: il collasso è tornato',
  );
});

test('il ponte resta permanente sulla sezione SORELLA', () => {
  // La garanzia di #251 non ha una rete a valle e non scade: una voce storica
  // dell'altra sezione deve bloccare anche attraverso il ponte, per vecchia
  // che sia.
  const u = 'https://www4.ti.ch/tich/area-media/comunicati/dettaglio-comunicato/?NEWS_ID=260792';
  const vecchissima = new Date(Date.now() - 400 * 24 * 3600 * 1000).toISOString();
  const ledgers = {
    frontaliere: {},
    svizzera: { [legacyNewsUrlKey(u)]: { articleId: 'gemello-svizzera', ts: vecchissima } },
  };
  const ponte = findCrossSectionSourceDuplicate(
    legacyNewsUrlKey(u),
    ledgerViewsForLookup(ledgers, 'frontaliere', { keyForm: 1 }),
    'frontaliere',
  );
  assert.equal(ponte.used, true);
  assert.equal(ponte.crossSection, true);
});

// ── Strato 4: cablaggio, e il vincolo del manifest ───────────────────────────

const CREATE_ARTICLE = readFileSync(path.join(ROOT, 'generator/scripts/create-article.mjs'), 'utf-8');

test('create-article.mjs costruisce la chiave dalla libreria, non a mano', () => {
  assert.match(
    CREATE_ARTICLE,
    /import \{[^}]*\bnewsUrlKey\b[^}]*\} from '\.\/lib\/source-url-ledger\.mjs'/,
    'newsUrlKey non è più importato: la chiave è tornata a essere costruita nel file grande, '
    + 'dove nessun test può raggiungerla senza node_modules',
  );
  assert.ok(
    !/\$\{u\.protocol\}\/\/\$\{u\.hostname\}\$\{u\.pathname\}/.test(CREATE_ARTICLE),
    'la costruzione path-only della chiave è ricomparsa in create-article.mjs',
  );
});

test('il ponte verso la forma 1 è ancora cablato in isSourceUrlAlreadyUsed', () => {
  const i = CREATE_ARTICLE.indexOf('function isSourceUrlAlreadyUsed(');
  assert.ok(i > 0, 'isSourceUrlAlreadyUsed non trovata — aggiornare questo test');
  const fn = CREATE_ARTICLE.slice(i, CREATE_ARTICLE.indexOf('\nfunction ', i + 1));
  assert.match(fn, /legacyNewsUrlKey\(headlineUrl\)/, 'il ponte è sparito: per la durata della '
    + 'transizione una fonte già usata dall’altra sezione sotto la chiave vecchia tornerebbe libera');
  assert.match(fn, /\{\s*keyForm:\s*1\s*\}/, 'il ponte non è più ristretto alle voci di forma 1');
});

test('cross-section-dedup.mjs resta ignaro della forma della chiave', () => {
  // È `mode: identical` nel loop-sync-manifest: toccarlo qui aprirebbe un
  // corpus-ahead su un file dichiarato uguale al sito, e la fix andrebbe fatta
  // là. La chiave arriva già costruita, come sempre.
  const dedup = readFileSync(path.join(ROOT, 'generator/scripts/lib/cross-section-dedup.mjs'), 'utf-8');
  assert.ok(
    !/newsUrlKey|keyForm|searchParams|isTrackingParam/.test(dedup),
    'cross-section-dedup.mjs ha imparato la forma della chiave: è `mode: identical`, va replicato sul sito',
  );
});

test('la costante della forma di chiave è quella che il ledger scrive', () => {
  assert.equal(makeLedgerEntry('x').keyForm, SOURCE_URL_KEY_FORM);
});
