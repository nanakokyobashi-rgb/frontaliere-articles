/**
 * I pavimenti anti-troncamento devono scalare col corpus. Run with `node --test`.
 *
 * IL DIFETTO. Il gate `Verify artifact` di `publish-api.yml` esiste per
 * rifiutare un set troncato prima che venga servito — e il sito non ribuilda
 * quando questo repo pubblica, quindi cio' che passa di qui e' live subito. Il
 * suo pavimento era pero' una costante scritta a mano nello YAML:
 * `counts.articles -lt 100`.
 *
 * MISURATO il 2026-09-05 sul corpus reale: `counts.articles` = 3782,
 * `counts.swissArticles` = 1850. Il pavimento stava al 2,6% del valore atteso,
 * cioe' una perdita del 97% del corpus passava il gate, e su `swissArticles`
 * non c'era pavimento affatto. Stesso difetto, stessa classe, in
 * `scripts/build-blog-index.mjs`: `MIN_ENTRIES = 50` contro le stesse due
 * sezioni da 3785 e 1850 file di corpo.
 *
 * LA ROOT CAUSE NON E' IL NUMERO. E' che il numero e' ASSOLUTO: tarato una
 * volta contro il corpus di quel giorno, non si muove piu' mentre il corpus
 * cresce di due ordini di grandezza. Il gate non si rompe — si svuota, e resta
 * verde mentre si svuota. Alzare 100 a 3500 ricomprerebbe qualche mese e
 * ricreerebbe lo stesso difetto, con la stessa data di scadenza silenziosa.
 *
 * PERCHE' UN TEST. Un pavimento dentro uno step di shell non e' eseguibile da
 * `node --test`: e' esattamente per questo che il suo decadimento non e' stato
 * visto da nessuno per tutta la crescita del corpus. Spostare il confronto in
 * un modulo e' meta' della fix; l'altra meta' e' asserire qui che il pavimento
 * e' derivato e non riscritto a mano, perche' la prossima costante assoluta
 * scivolerebbe dentro con la stessa facilita' della prima.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { spawnSync } from 'node:child_process';

import {
  FLOOR_RETENTION,
  FLOOR_WARN_RETENTION,
  retentionRatio,
  retentionLine,
  retentionWarning,
  floorFrom,
  countSourceArticles,
  countSourceImages,
  countSeoEntries,
  collectSeoEntryIds,
  collectSeoEntryMetadata,
  latestSeoPublication,
  sectionFloor,
} from '../../scripts/lib/corpus-floors.mjs';
import {
  SECTION_COUNTERS,
  feedSection,
  expectedFeedNames,
  floorViolations,
  retentionReport,
  retentionAdvisories,
  retentionLines,
  measureDist,
  expectFromCorpus,
  FEED_POPULATION_WARN_RETENTION,
  FEED_FRESHNESS_MAX_LAG_HOURS,
  feedSourceFloor,
  previousRevision,
} from '../../scripts/ci/verify-api-floors.mjs';
import { RSS_SECTIONS } from '../../engine/rssFeeds.mjs';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const WORKFLOW = fs.readFileSync(join(ROOT, '.github/workflows/publish-api.yml'), 'utf-8');
const BLOG_INDEX = fs.readFileSync(join(ROOT, 'scripts/build-blog-index.mjs'), 'utf-8');

/** Una superficie sana su un corpus della taglia di quello reale. */
function healthy() {
  const expected = {
    sourceArticles: { frontaliere: 3785, svizzera: 1850 },
    // La popolazione che GENERA i feed: le voci datate dei chunk SEO, non i
    // file di corpo. Diverge dai corpi per costruzione — e' il punto.
    feedSources: { frontaliere: 3750, svizzera: 1936 },
    previousFeedSources: { frontaliere: 3750, svizzera: 1936 },
    sourceImages: 1990,
    rssMaxItems: 50,
  };
  const measured = {
    articleCounts: { articles: 3782, swissArticles: 1850 },
    feeds: [
      { name: 'rss.xml', items: 50 },
      { name: 'rss-it.xml', items: 50 },
      { name: 'rss-svizzera.xml', items: 50 },
      { name: 'rss-svizzera-de.xml', items: 50 },
    ],
    images: 1990,
  };
  return { measured, expected };
}

function writeHealthyFeeds(dir) {
  const pubDate = new Date(Date.now() + FEED_FRESHNESS_MAX_LAG_HOURS * 60 * 60 * 1000).toUTCString();
  const item = `<item><pubDate>${pubDate}</pubDate></item>`;
  const xml = `<rss><channel>${item.repeat(50)}</channel></rss>`;
  for (const name of expectedFeedNames(RSS_SECTIONS)) fs.writeFileSync(join(dir, name), xml);
}

test('floorFrom scala col valore atteso e non produce mai un pavimento negativo', () => {
  assert.equal(floorFrom(1000), Math.floor(1000 * FLOOR_RETENTION));
  assert.equal(floorFrom(0), 0);
  assert.equal(floorFrom(-5), 0);
  assert.equal(floorFrom(Number.NaN), 0);
  // Il punto della fix: il pavimento cresce col corpus invece di restare fermo.
  assert.ok(floorFrom(3785) > floorFrom(100));
});

test("la superficie reale del 2026-09-05 passa: il pavimento non e' stretto", () => {
  const { measured, expected } = healthy();
  assert.deepEqual(floorViolations(measured, expected), []);
});

test('un troncamento che il pavimento assoluto di 100 accettava viene ora rifiutato', () => {
  const { measured, expected } = healthy();
  // 500 articoli su 3782: perdita dell'87%, e cinque volte il vecchio `-lt 100`.
  const truncated = { ...measured, articleCounts: { ...measured.articleCounts, articles: 500 } };
  assert.ok(500 > 100, 'il vecchio pavimento assoluto avrebbe accettato questo set');
  const violations = floorViolations(truncated, expected);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /counts\.articles: 500 contro 3785/);
});

test('swissArticles ha un pavimento, che prima mancava del tutto', () => {
  const { measured, expected } = healthy();
  const truncated = { ...measured, articleCounts: { ...measured.articleCounts, swissArticles: 40 } };
  const violations = floorViolations(truncated, expected);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /counts\.swissArticles: 40 contro 1850/);
});

test("un contatore mancante e' una violazione, non un pass silenzioso", () => {
  const { measured, expected } = healthy();
  const violations = floorViolations({ ...measured, articleCounts: { articles: 3782 } }, expected);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /counts\.swissArticles assente/);
});

test('un feed troncato viene visto, e un feed corto per corpus corto no', () => {
  const { measured, expected } = healthy();
  const short = {
    ...measured,
    feeds: [...measured.feeds, { name: 'rss-fr.xml', items: 3 }],
  };
  const violations = floorViolations(short, expected);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /rss-fr\.xml: 3 <item>/);

  // Sezione da 10 articoli: un feed da 10 e' completo, non troncato — e'
  // il motivo per cui l'atteso e' min(RSS_MAX_ITEMS, popolazione) e non il tetto.
  const tiny = {
    measured: { articleCounts: { articles: 10, swissArticles: 10 }, feeds: [{ name: 'rss.xml', items: 10 }], images: null },
    expected: {
      sourceArticles: { frontaliere: 10, svizzera: 10 },
      feedSources: { frontaliere: 10, svizzera: 10 },
      sourceImages: null,
      rssMaxItems: 50,
    },
  };
  assert.deepEqual(floorViolations(tiny.measured, tiny.expected), []);
});

test('un calo dei chunk sotto il cap non puo\' abbassare da solo il pavimento del feed', () => {
  const expected = {
    sourceArticles: { frontaliere: 3785, svizzera: 1850 },
    feedSources: { frontaliere: 5, svizzera: 1936 },
    previousFeedSources: { frontaliere: 50, svizzera: 1936 },
    sourceImages: null,
    rssMaxItems: 50,
  };
  const measured = {
    articleCounts: { articles: 3782, swissArticles: 1850 },
    feeds: [{ name: 'rss.xml', items: 5 }],
    images: null,
  };

  assert.equal(feedSourceFloor(expected, 'frontaliere'), 50);
  const violations = floorViolations(measured, expected);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /rss\.xml: 5 <item> contro 45 attesi/);
  assert.match(violations[0], /5 voci nei chunk SEO.*riferimento storico\/floor 50/);
});

/*
 * IL PAVIMENTO DEI FEED SI DERIVA DALLA POPOLAZIONE CHE LI GENERA.
 *
 * Gli `<item>` non nascono dai file di corpo: `buildSectionFeeds` li costruisce
 * da `parseSeoBlogs` sui chunk elencati in `RSS_SECTIONS[].seoFiles`. Le due
 * popolazioni sono scollegate e divergono gia' oggi. Un pavimento tarato sui
 * corpi sbaglia in entrambe le direzioni, e la peggiore per il ciclo non e' il
 * falso negativo: una sezione con pochi chunk e un feed corto ma COMPLETO
 * bloccherebbe l'intera pubblicazione.
 */
test('un feed corto ma completo non blocca la pubblicazione, anche con molti corpi', () => {
  const measured = {
    articleCounts: { articles: 3782, swissArticles: 1850 },
    feeds: [{ name: 'rss.xml', items: 30 }, { name: 'rss-de.xml', items: 30 }],
    images: null,
  };
  // 3785 corpi ma solo 30 voci nei chunk: il feed da 30 e' tutto cio' che i
  // chunk possono produrre. Col vecchio riferimento il pavimento era
  // floor(min(50, 3785) * 0,9) = 45, e questo set — corretto — sfondava.
  const expected = {
    sourceArticles: { frontaliere: 3785, svizzera: 1850 },
    feedSources: { frontaliere: 30, svizzera: 1936 },
    sourceImages: null,
    rssMaxItems: 50,
  };
  assert.equal(floorFrom(Math.min(50, 3785)), 45, 'il pavimento derivato dai corpi sarebbe stato 45');
  assert.deepEqual(floorViolations(measured, expected), []);
});

test('chunk pieni e feed troncato restano una violazione, con la misura giusta', () => {
  const measured = {
    articleCounts: { articles: 3782, swissArticles: 1850 },
    feeds: [{ name: 'rss.xml', items: 12 }],
    images: null,
  };
  const expected = {
    sourceArticles: { frontaliere: 3785, svizzera: 1850 },
    feedSources: { frontaliere: 3750, svizzera: 1936 },
    sourceImages: null,
    rssMaxItems: 50,
  };
  const violations = floorViolations(measured, expected);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /rss\.xml: 12 <item> contro 45 attesi/);
  assert.match(violations[0], /3750 voci nei chunk SEO di frontaliere/);
});

test("chunk SEO assenti = violazione, una per sezione e non una per feed", () => {
  const { measured, expected } = healthy();
  // Corpi intatti, chunk irraggiungibili: e' la lista dei chunk che non
  // risolve — il modo esatto in cui rss.xml e' rimasto fermo tre mesi. Senza
  // questa regola il pavimento dei feed sarebbe 0, cioe' nessun gate.
  const noChunks = { ...expected, feedSources: { frontaliere: 0, svizzera: 0 } };
  const violations = floorViolations(measured, noChunks);
  assert.equal(violations.length, 2, `una riga per sezione: ${JSON.stringify(violations)}`);
  assert.match(violations.join('\n'), /chunk di frontaliere/);
  assert.match(violations.join('\n'), /chunk di svizzera/);
  for (const v of violations) assert.match(v, /content[\\/]seo/);
});

/*
 * IL SECONDO MODO DI FALLIRE, che il pavimento assoluto non aveva: il derivato
 * e' corretto finche' il suo riferimento esiste, e diventa un no-op silenzioso
 * quando non esiste. `floorFrom(0)` e' 0, e `x < 0` e' falso per qualunque `x`.
 * Un solo `content/` non materializzato — checkout parziale, symlink del corpus
 * non risolto — azzera insieme sorgente e artefatto, e il gate uscirebbe verde
 * su un artefatto arbitrariamente troncato. `MIN_ENTRIES = 50` e `-lt 100`
 * erano sbagliati ma INCONDIZIONATI: non potevano svuotarsi.
 */
test("corpus sorgente assente = violazione, non un pass silenzioso", () => {
  const { measured } = healthy();
  const noCorpus = {
    sourceArticles: { frontaliere: 0, svizzera: 0 },
    feedSources: { frontaliere: 0, svizzera: 0 },
    sourceImages: 0,
    rssMaxItems: 50,
  };
  // Artefatto arbitrariamente troncato: un articolo per sezione, feed a un item.
  const truncated = {
    articleCounts: { articles: 1, swissArticles: 1 },
    feeds: [{ name: 'rss.xml', items: 1 }],
    images: 1,
  };
  for (const m of [measured, truncated]) {
    const violations = floorViolations(m, noCorpus);
    assert.ok(violations.length >= 2, `un corpus assente non puo' uscire pulito: ${JSON.stringify(violations)}`);
    assert.match(violations.join('\n'), /content[\\/]blog-body[\\/]it/);
    assert.match(violations.join('\n'), /content[\\/]blog-body-ch[\\/]it/);
  }
});

test("una sola sezione senza corpus e' segnalata una volta, e non spegne l'altra", () => {
  const { measured, expected } = healthy();
  // Solo i CORPI svizzera mancano: i chunk ci sono, quindi i feed svizzera
  // restano gatati contro il loro riferimento invece di aggiungere una riga.
  const noSwissBodies = { ...expected, sourceArticles: { frontaliere: 3785, svizzera: 0 } };
  const violations = floorViolations(measured, noSwissBodies);
  assert.equal(violations.length, 1, 'il feed svizzera non deve aggiungere una seconda riga sullo stesso riferimento');
  assert.match(violations[0], /manifest\.counts\.swissArticles/);
  // I feed frontaliere restano gatati contro i chunk, che ci sono.
  const alsoTruncated = { ...measured, feeds: [...measured.feeds, { name: 'rss-fr.xml', items: 2 }] };
  assert.equal(floorViolations(alsoTruncated, noSwissBodies).length, 2);
});

test("images-manifest emesso senza public/images/blog e' una violazione", () => {
  const { measured, expected } = healthy();
  const violations = floorViolations(measured, { ...expected, sourceImages: 0 });
  assert.equal(violations.length, 1);
  assert.match(violations[0], /public[\\/]images[\\/]blog/);
});

test('sectionFloor lancia sul corpus assente invece di restituire un pavimento a zero', () => {
  const root = fs.mkdtempSync(join(os.tmpdir(), 'corpus-floors-'));
  assert.throws(() => sectionFloor(root, 'frontaliere'), /riferimento del pavimento assente/);

  fs.mkdirSync(join(root, 'content/blog-body/it'), { recursive: true });
  for (let i = 0; i < 10; i += 1) fs.writeFileSync(join(root, `content/blog-body/it/a${i}.ts`), 'export const body = "";');
  assert.equal(sectionFloor(root, 'frontaliere'), floorFrom(10));
  fs.rmSync(root, { recursive: true, force: true });
});

test('build-blog-index tratta il corpus assente come un rifiuto, non come un indice vuoto', () => {
  assert.match(
    BLOG_INDEX,
    /catch \(err\)[\s\S]{0,200}failed = true/,
    'sectionEntryFloor lancia: il chiamante deve fallire, non pubblicare',
  );
});

test("images: manifest assente o senza sorgente e' una violazione esplicita", () => {
  const { measured, expected } = healthy();
  const missingManifest = floorViolations({ ...measured, images: null }, expected);
  assert.equal(missingManifest.length, 1);
  assert.match(missingManifest[0], /images-manifest\.json assente/);

  const missingSource = floorViolations(
    { ...measured, images: null },
    { ...expected, sourceImages: 0 },
  );
  assert.equal(missingSource.length, 1);
  assert.match(missingSource[0], /public[\\/]images[\\/]blog/);

  const violations = floorViolations({ ...measured, images: 3 }, expected);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /images-manifest\.json: 3 immagini contro 1990/);
});

test('un input di corpus che punta a un file o a un symlink pendente vale come directory mancante', () => {
  const root = fs.mkdtempSync(join(os.tmpdir(), 'corpus-input-'));
  const bodyRoot = join(root, 'content', 'blog-body');
  fs.mkdirSync(bodyRoot, { recursive: true });
  fs.writeFileSync(join(root, 'not-a-directory'), 'input');
  fs.symlinkSync(join(root, 'not-a-directory'), join(bodyRoot, 'it'));
  assert.equal(countSourceArticles(root, 'frontaliere'), 0);

  fs.rmSync(join(bodyRoot, 'it'));
  fs.symlinkSync(join(root, 'missing-target'), join(bodyRoot, 'it'));
  assert.equal(countSourceArticles(root, 'frontaliere'), 0);
  fs.rmSync(root, { recursive: true, force: true });
});

test('ELOOP/EACCES del corpus diventano un errore di riferimento diagnosticabile', () => {
  const originalStat = fs.statSync;
  const root = fs.mkdtempSync(join(os.tmpdir(), 'corpus-errno-'));
  try {
    for (const code of ['ELOOP', 'EACCES']) {
      fs.statSync = () => {
        const error = new Error(`simulated ${code}`);
        error.code = code;
        throw error;
      };
      assert.throws(
        () => countSourceArticles(root, 'frontaliere'),
        (error) => error.code === 'MISSING_CORPUS'
          && error.cause?.code === code
          && /riferimento del pavimento assente/.test(error.message)
          && /content[\\/]blog-body[\\/]it/.test(error.message),
      );
    }
  } finally {
    fs.statSync = originalStat;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('il conteggio delle immagini legge la directory sorgente una sola volta', () => {
  const root = fs.mkdtempSync(join(os.tmpdir(), 'image-input-'));
  const imageDir = join(root, 'public', 'images', 'blog');
  fs.mkdirSync(imageDir, { recursive: true });
  fs.writeFileSync(join(imageDir, 'a.webp'), 'a');
  fs.writeFileSync(join(imageDir, 'b.webp'), 'b');
  const original = fs.readdirSync;
  let reads = 0;
  fs.readdirSync = (...args) => {
    if (args[0] === imageDir) reads += 1;
    return original(...args);
  };
  try {
    assert.equal(countSourceImages(root), 2);
    assert.equal(reads, 1);
  } finally {
    fs.readdirSync = original;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('feedSection separa le due sezioni dai nomi che RSS_SECTIONS genera', () => {
  assert.equal(feedSection('rss-svizzera.xml'), 'svizzera');
  assert.equal(feedSection('rss-svizzera-fr.xml'), 'svizzera');
  assert.equal(feedSection('rss.xml'), 'frontaliere');
  assert.equal(feedSection('rss-de.xml'), 'frontaliere');
  assert.equal(feedSection('rss-future.xml'), null, 'un feed non censito non deve ricadere su frontaliere');
  assert.equal(
    feedSection('rss-nuova-de.xml', [
      { id: 'nuova', mainFeed: 'rss-nuova.xml', feedFile: (locale) => `rss-nuova-${locale}.xml` },
    ]),
    'nuova',
  );
  assert.deepEqual(Object.keys(SECTION_COUNTERS).sort(), ['frontaliere', 'svizzera']);
});

test('feedSection rispetta il primo match e riconosce anche una sezione senza feedFile', () => {
  const sections = [
    { id: 'prima', mainFeed: 'rss-duplicato.xml', feedFile: () => 'rss-duplicato.xml' },
    { id: 'seconda', mainFeed: 'rss-duplicato.xml' },
    { id: 'solo-main', mainFeed: 'rss-solo-main.xml' },
  ];

  assert.equal(feedSection('rss-duplicato.xml', sections), 'prima');
  assert.equal(feedSection('rss-solo-main.xml', sections), 'solo-main');
  assert.equal(feedSection('rss-non-censito.xml', sections), null);
});

test('un feed non mappato produce una violazione esplicita', () => {
  const { measured, expected } = healthy();
  const violations = floorViolations(
    { ...measured, feeds: [{ name: 'rss-future.xml', items: 50 }] },
    expected,
  );
  assert.equal(violations.length, 1);
  assert.match(violations[0], /rss-future\.xml: nessuna sezione RSS_SECTIONS corrispondente/);
});

test('un feed RSS atteso assente o non RSS produce una violazione esplicita', () => {
  const { measured, expected } = healthy();
  const violations = floorViolations(
    { ...measured, missingFeeds: ['rss-it.xml', 'rss-svizzera-fr.xml'] },
    expected,
  );
  assert.equal(violations.length, 2);
  assert.match(violations.join('\n'), /rss-it\.xml: feed RSS atteso da RSS_SECTIONS assente o non è un documento RSS/);
  assert.match(violations.join('\n'), /rss-svizzera-fr\.xml: feed RSS atteso da RSS_SECTIONS assente o non è un documento RSS/);
});

test('measureDist riconosce i feed dal documento, non dal nome del file', () => {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'api-floors-'));
  fs.writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ counts: { articles: 7, swissArticles: 2 } }));
  fs.writeFileSync(
    join(dir, 'rss.xml'),
    '<rss><description><![CDATA[<pubDate>Fri, 11 Sep 2026 00:00:00 GMT</pubDate>]]></description>' +
      '<!-- <pubDate>Sat, 12 Sep 2026 00:00:00 GMT</pubDate> -->' +
      '<item><pubDate>Tue, 09 Sep 2026 00:00:00 GMT</pubDate></item>' +
      '<item><pubDate>Wed, 10 Sep 2026 00:00:00 GMT</pubDate></item></rss>',
  );
  fs.writeFileSync(join(dir, 'rss-it.xml'), '<urlset><url>x</url></urlset>');
  // Una sitemap e' <urlset>, non <rss>: non deve entrare nel conteggio dei feed.
  fs.writeFileSync(join(dir, 'sitemap-blog.xml'), '<urlset><url>x</url></urlset>');

  const measured = measureDist(dir);
  assert.deepEqual(measured.feeds, [{
    name: 'rss.xml',
    items: 2,
    latestPublication: {
      datePublished: 'Wed, 10 Sep 2026 00:00:00 GMT',
      timestamp: Date.parse('Wed, 10 Sep 2026 00:00:00 GMT'),
    },
  }]);
  assert.equal(measured.missingFeeds.length, expectedFeedNames().length - 1);
  assert.ok(measured.missingFeeds.includes('rss-it.xml'), 'un feed atteso non-RSS deve risultare mancante');
  assert.ok(measured.missingFeeds.includes('rss-de.xml'), 'un feed atteso assente deve risultare mancante');
  assert.equal(measured.images, null, 'images-manifest.json assente ⇒ null, che e\' un caso valido');
  assert.equal(measured.articleCounts.articles, 7);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('measureDist trasforma un images-manifest malformato in una violazione esplicita', () => {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'api-floors-images-shape-'));
  fs.writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ counts: { articles: 7, swissArticles: 2 } }));
  fs.writeFileSync(join(dir, 'images-manifest.json'), JSON.stringify({ images: { length: 7 } }));
  writeHealthyFeeds(dir);

  const measured = measureDist(dir);
  assert.equal(measured.images, null);
  assert.deepEqual(measured.imageErrors, ['images-manifest.json: campo "images" assente o non è un array']);
  const violations = floorViolations(measured, {
    sourceArticles: { frontaliere: 7, svizzera: 2 },
    feedSources: { frontaliere: 10, svizzera: 10 },
    sourceImages: 10,
    rssMaxItems: 50,
  });
  assert.deepEqual(violations, measured.imageErrors);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("il corpus di questo checkout e' la verita' di terra, e regge i due contatori", async () => {
  const expected = await expectFromCorpus(ROOT);
  assert.ok(expected.sourceArticles.frontaliere > 1000, `frontaliere: ${expected.sourceArticles.frontaliere}`);
  assert.ok(expected.sourceArticles.svizzera > 500, `svizzera: ${expected.sourceArticles.svizzera}`);
  assert.equal(expected.rssMaxItems, 50, 'RSS_MAX_ITEMS arriva da engine/rssFeeds.mjs, non da una copia');
  assert.equal(expected.sourceArticles.frontaliere, countSourceArticles(ROOT, 'frontaliere'));
});

test('i feed di questo checkout sono gatati contro i chunk che li generano', async () => {
  const expected = await expectFromCorpus(ROOT);
  for (const section of RSS_SECTIONS) {
    assert.equal(
      expected.feedSources[section.id],
      countSeoEntries(ROOT, section.seoFiles),
      `${section.id}: la lista dei chunk arriva da RSS_SECTIONS, non da una seconda copia`,
    );
    assert.ok(expected.feedSources[section.id] > 500, `${section.id}: ${expected.feedSources[section.id]}`);
  }
  // Le due popolazioni divergono davvero: se coincidessero, questo fix non
  // avrebbe oggetto e il test non starebbe misurando niente.
  assert.notEqual(expected.feedSources.frontaliere, expected.sourceArticles.frontaliere);
});

test('countSeoEntries conta le voci come le conta parseSeoBlogs', () => {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'seo-entries-'));
  const seoDir = join(dir, 'content', 'seo');
  fs.mkdirSync(seoDir, { recursive: true });
  const entry = (id, extra = '"datePublished": "2026-01-01",') =>
    `  'blog-${id}': {\n    "headline": "T ${id}",\n    ${extra}\n  },\n`;
  fs.writeFileSync(
    join(seoDir, 'seo-blog.ts'),
    `export const SEO = {\n${entry('a')}${entry('b')}${entry('c', '')}` +
      `  'blog-d': {\n    "headline": "",\n    "datePublished": "2026-01-01",\n  },\n};\n`,
  );
  // Lo stesso id in due chunk: un solo `<item>`, perche' parseSeoBlogs chiave
  // una Map per articleId.
  fs.writeFileSync(join(seoDir, 'seo-blog-2.ts'), `export const SEO = {\n${entry('a')}${entry('e')}};\n`);

  assert.equal(countSeoEntries(dir, ['seo-blog.ts', 'seo-blog-2.ts']), 3, 'a, b, e — non c (senza data), non d (headline vuota), e a una volta sola');
  // Un chunk assente viene saltato, come lo salta parseSeoBlogs.
  assert.equal(countSeoEntries(dir, ['seo-blog.ts', 'mai-esistito.ts']), 2);
  assert.equal(collectSeoEntryIds('nessuna voce qui').size, 0);
  const metadata = collectSeoEntryMetadata(entry('long'));
  assert.equal(metadata.get('long').headline, 'T long');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('collectSeoEntryMetadata filtra prima del dedupe una voce successiva invalida', () => {
  const metadata = collectSeoEntryMetadata(
    `'blog-keep': { "headline": "Keep", "datePublished": "2026-01-02T00:00:00Z" },\n` +
      `'blog-keep': { "headline": "", "datePublished": "" },\n`,
  );
  assert.equal(metadata.get('keep').headline, 'Keep');
  assert.equal(metadata.get('keep').datePublished, '2026-01-02T00:00:00Z');
});

test('latestSeoPublication prende la data piu\' recente dai chunk che alimentano la sezione', () => {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'seo-latest-'));
  const seoDir = join(dir, 'content', 'seo');
  fs.mkdirSync(seoDir, { recursive: true });
  fs.writeFileSync(
    join(seoDir, 'older.ts'),
    `'blog-old': { "headline": "Old", "datePublished": "2026-01-01T00:00:00Z" },\n` +
      `'blog-duplicato': { "headline": "Old duplicate", "datePublished": "2026-04-01T00:00:00Z" },\n`,
  );
  fs.writeFileSync(
    join(seoDir, 'newer.ts'),
    `'blog-new': { "headline": "New", "datePublished": "2026-02-03T04:05:06Z" },\n` +
      `'blog-duplicato': { "headline": "New duplicate", "datePublished": "2026-01-01T00:00:00Z" },\n`,
  );

  assert.deepEqual(latestSeoPublication(dir, ['older.ts', 'newer.ts']), {
    articleId: 'new',
    datePublished: '2026-02-03T04:05:06Z',
    timestamp: Date.parse('2026-02-03T04:05:06Z'),
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('latestSeoPublication rifiuta un chunk SEO dichiarato ma assente', () => {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'seo-missing-'));
  const seoDir = join(dir, 'content', 'seo');
  fs.mkdirSync(seoDir, { recursive: true });
  fs.writeFileSync(
    join(seoDir, 'present.ts'),
    `'blog-present': { "headline": "Present", "datePublished": "2026-01-01T00:00:00Z" },\n`,
  );

  assert.throws(
    () => latestSeoPublication(dir, ['present.ts', 'missing.ts']),
    (error) => error.code === 'MISSING_CORPUS' && /missing\.ts/.test(error.message),
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test('expectFromCorpus legge davvero un root alternativo e non il checkout del test', async () => {
  const root = fs.mkdtempSync(join(os.tmpdir(), 'api-floors-root-'));
  try {
    fs.mkdirSync(join(root, 'content', 'blog-body', 'it'), { recursive: true });
    fs.mkdirSync(join(root, 'content', 'blog-body-ch', 'it'), { recursive: true });
    fs.mkdirSync(join(root, 'content', 'seo'), { recursive: true });
    fs.mkdirSync(join(root, 'public', 'images', 'blog'), { recursive: true });
    fs.writeFileSync(join(root, 'content', 'blog-body', 'it', 'frontaliere.ts'), 'export {};');
    fs.writeFileSync(join(root, 'content', 'blog-body-ch', 'it', 'svizzera.ts'), 'export {};');
    for (const section of RSS_SECTIONS) {
      for (const [index, file] of section.seoFiles.entries()) {
        const source = section.id === 'frontaliere' && index === 0
          ? `'blog-alt': { "headline": "Alt", "datePublished": "2026-02-03T04:05:06Z" },\n`
          : section.id === 'svizzera' && index === 0
            ? `'blog-alt-ch': { "headline": "Alt CH", "datePublished": "2026-02-04T04:05:06Z" },\n`
            : '';
        fs.writeFileSync(join(root, 'content', 'seo', file), source);
      }
    }
    fs.writeFileSync(join(root, 'public', 'images', 'blog', 'alt.webp'), 'image');

    const configuredRevision = process.env.API_FLOOR_BASE_REVISION;
    process.env.API_FLOOR_BASE_REVISION = '0000000000000000000000000000000000000000';
    let expected;
    try {
      expected = await expectFromCorpus(root);
    } finally {
      if (configuredRevision === undefined) delete process.env.API_FLOOR_BASE_REVISION;
      else process.env.API_FLOOR_BASE_REVISION = configuredRevision;
    }
    assert.deepEqual(expected.sourceArticles, { frontaliere: 1, svizzera: 1 });
    assert.deepEqual(expected.feedSources, { frontaliere: 1, svizzera: 1 });
    assert.deepEqual(expected.latestSeoPublications.frontaliere, {
      articleId: 'alt',
      datePublished: '2026-02-03T04:05:06Z',
      timestamp: Date.parse('2026-02-03T04:05:06Z'),
    });
    assert.equal(expected.sourceImages, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('un feed oltre la soglia di freschezza viene rifiutato rispetto ai chunk SEO', () => {
  const { measured, expected } = healthy();
  const sourceDate = '2026-09-10T00:00:00Z';
  const staleDate = '2026-09-06T00:00:00Z';
  const expectedWithFreshness = {
    ...expected,
    latestSeoPublications: {
      frontaliere: {
        articleId: 'newest',
        datePublished: sourceDate,
        timestamp: Date.parse(sourceDate),
      },
    },
  };
  const stale = floorViolations(
    {
      ...measured,
      feeds: [{
        ...measured.feeds[0],
        latestPublication: { datePublished: staleDate, timestamp: Date.parse(staleDate) },
      }],
    },
    expectedWithFreshness,
  );
  assert.equal(stale.length, 1);
  assert.match(stale[0], /feed stantio/);
  assert.match(stale[0], /96\.0h/);
  assert.match(stale[0], new RegExp(`${FEED_FRESHNESS_MAX_LAG_HOURS}h`));

  const freshDate = '2026-09-07T01:00:00Z';
  assert.deepEqual(
    floorViolations(
      {
        ...measured,
        feeds: [{
          ...measured.feeds[0],
          latestPublication: { datePublished: freshDate, timestamp: Date.parse(freshDate) },
        }],
      },
      expectedWithFreshness,
    ),
    [],
  );

  const missingDate = floorViolations(
    { ...measured, feeds: [{ ...measured.feeds[0], latestPublication: null }] },
    expectedWithFreshness,
  );
  assert.equal(missingDate.length, 1);
  assert.match(missingDate[0], /nessun <pubDate> valido/);
});

test('build-api usa il parser SEO condiviso, non una terza finestra locale', () => {
  const build = readFileSync(join(ROOT, 'scripts/build-api.mjs'), 'utf8');
  assert.match(build, /collectSeoEntryMetadata/);
  assert.doesNotMatch(build, /const entryRe = \/'blog-\(\[\^'\]\+\):\\s\*\\{\/g/);
  assert.doesNotMatch(build, /start \+ 4000/);
});

test("publish-api.yml non porta piu' un pavimento assoluto scritto a mano", () => {
  assert.ok(
    WORKFLOW.includes('node scripts/ci/verify-api-floors.mjs'),
    'lo step Verify artifact deve invocare il verificatore testabile',
  );
  assert.doesNotMatch(
    WORKFLOW,
    /counts\.articles"\)[\s\S]{0,200}-lt 100/,
    'il pavimento assoluto su counts.articles e\' tornato nello YAML',
  );
  assert.doesNotMatch(
    WORKFLOW,
    /items" -lt 1\b/,
    'il pavimento `-lt 1` sui feed accettava un feed troncato a un item',
  );
  assert.doesNotMatch(
    WORKFLOW,
    /imgs" -lt 1\b/,
    'il pavimento `-lt 1` sulle immagini accettava 1990 immagini ridotte a una',
  );
});

test('il floor storico usa github.event.before e conserva un fallback esplicito', () => {
  assert.equal(previousRevision(ROOT, 'before-sha'), 'before-sha');
  assert.equal(previousRevision(ROOT, '0'.repeat(40)), null);
  assert.match(
    WORKFLOW,
    /API_FLOOR_BASE_REVISION:\s*\$\{\{ github\.event\.before \}\}/,
    'publish-api deve passare la base del push, non lasciare che lo script scelga HEAD^',
  );
});

test("build-blog-index non porta piu' MIN_ENTRIES, ma il pavimento derivato", () => {
  assert.doesNotMatch(BLOG_INDEX, /^const MIN_ENTRIES\b/m, 'la costante assoluta e\' tornata');
  assert.ok(
    BLOG_INDEX.includes("from './lib/corpus-floors.mjs'"),
    'il pavimento deve venire dalla stessa sorgente unica del gate di pubblicazione',
  );
  assert.match(BLOG_INDEX, /registry\.length < registryFloor/);
  assert.match(BLOG_INDEX, /entries\.length < localeFloor/);
});

// ─────────────────────────────────────────────────────────────────────────────
// Il livello ADVISORY sopra il gate (#998).
//
// IL DIFETTO. `FLOOR_RETENTION` e' tarato sullo scarto osservato una volta
// (0,9992 e 1,0000), ma i due lati del rapporto contano cose diverse: i file di
// corpo da una parte, cio' che l'artefatto dichiara dall'altra. Ogni corpo
// lasciato senza la sua voce sposta il rapporto verso il basso in modo
// MONOTONO, e nulla lo misurava: la prima notizia del drift sarebbe stata la
// pubblicazione BLOCCATA a -10%, su un corpus sano.
//
// Il livello aggiunto sta SOPRA il gate e non lo muove: 0,90 resta 0,90 e resta
// l'unico a uscire 1.
// ─────────────────────────────────────────────────────────────────────────────

test('il preallarme sta stretto fra il gate e 1, o e\' irraggiungibile', () => {
  assert.ok(
    FLOOR_WARN_RETENTION > FLOOR_RETENTION,
    `preallarme ${FLOOR_WARN_RETENTION} <= gate ${FLOOR_RETENTION}: invertirli rende il warning irraggiungibile, ` +
      'cioe' + ' ricrea la cecita\' che questo livello chiude',
  );
  assert.ok(FLOOR_WARN_RETENTION < 1, 'un preallarme a 1 avviserebbe su ogni rapporto non perfetto');
  // Il gate non si e' mosso: questa issue aggiunge un livello, non ne sposta uno.
  assert.equal(FLOOR_RETENTION, 0.9, 'FLOOR_RETENTION e\' bloccante e resta 0,9 (AGENTS.md #1)');
});

test('rapporto fra preallarme e gate: warning, nessuna violazione', () => {
  const { measured, expected } = healthy();
  // 95%: sotto il preallarme, ben sopra il gate.
  const eroded = { ...measured, articleCounts: { ...measured.articleCounts, articles: Math.round(3785 * 0.95) } };

  assert.deepEqual(floorViolations(eroded, expected), [], 'il gate non deve scattare: 95% > 90%');

  const advisories = retentionAdvisories(retentionReport(eroded, expected));
  assert.equal(advisories.length, 1, `un solo preallarme, ricevuti: ${JSON.stringify(advisories)}`);
  assert.match(advisories[0], /manifest\.counts\.articles/);
  assert.match(advisories[0], /preallarme/);
});

test('il warning usa lo stesso pavimento intero del gate sul bordo', () => {
  // 3432/3814 = 89,984%, ma floor(3814 * 0,9) = 3432: il gate passa sul
  // bordo e il preallarme deve restare osservabile.
  assert.equal(floorFrom(3814), 3432);
  assert.match(retentionWarning('x', 3432, 3814), /sotto il preallarme/);
  assert.doesNotMatch(retentionWarning('x', 3432, 3814), /-0\.0 pp/);
  assert.equal(retentionWarning('x', 3431, 3814), null, 'sotto il floor il gate ha gia\' il verdetto');
});

test('rapporto sotto il gate: violazione, e nessun preallarme che la raddoppi', () => {
  const { measured, expected } = healthy();
  const truncated = { ...measured, articleCounts: { ...measured.articleCounts, articles: 500 } };

  assert.equal(floorViolations(truncated, expected).length, 1, 'sotto 90% il gate deve scattare');
  assert.deepEqual(
    retentionAdvisories(retentionReport(truncated, expected)),
    [],
    'sotto il gate non e\' un preallarme ma una violazione: annunciarla due volte confonde il verdetto',
  );
});

test('una superficie sana non produce nessun preallarme', () => {
  const { measured, expected } = healthy();
  assert.deepEqual(retentionAdvisories(retentionReport(measured, expected)), []);
});

test('il report copre ogni rapporto che un pavimento sorveglia, coi riferimenti del gate', () => {
  const { measured, expected } = healthy();
  const rows = retentionReport(measured, expected);

  const byLabel = Object.fromEntries(rows.map((r) => [r.label, r]));
  assert.equal(byLabel['manifest.counts.articles'].source, 3785, 'il riferimento dei corpi, non dei chunk SEO');
  assert.equal(byLabel['manifest.counts.swissArticles'].source, 1850);
  // Un feed e' tagliato a RSS_MAX_ITEMS: il suo 100% e' 50 item, non 3750,
  // altrimenti ogni feed sano sembrerebbe eroso all'1%.
  assert.equal(byLabel['rss.xml'].source, Math.min(expected.rssMaxItems, expected.feedSources.frontaliere));
  assert.equal(byLabel['rss-svizzera.xml'].source, Math.min(expected.rssMaxItems, expected.feedSources.svizzera));
  assert.equal(byLabel['images-manifest.json'].source, 1990);
  assert.equal(rows.length, 2 + 2 + measured.feeds.length + 1);
  assert.ok(rows.some((r) => r.label === 'chunk SEO frontaliere/run precedente'));
  assert.ok(rows.some((r) => r.label === 'chunk SEO svizzera/run precedente'));

  // Un preallarme su un feed resta uno per feed: e' il report intero a
  // produrli, non la riga rappresentativa che si stampa.
  const shortFeeds = {
    ...measured,
    feeds: measured.feeds.map((f) => ({ ...f, items: 47 })),
  };
  assert.equal(retentionAdvisories(retentionReport(shortFeeds, expected)).length, measured.feeds.length);
});

test('l\'erosione dei chunk SEO resta un advisory anche quando il feed e\' capato', () => {
  const { measured, expected } = healthy();
  const eroded = {
    ...expected,
    feedSources: { ...expected.feedSources, frontaliere: 60 },
    previousFeedSources: { ...expected.previousFeedSources, frontaliere: 3750 },
  };
  const rows = retentionReport(measured, eroded);
  const population = rows.find((r) => r.label === 'chunk SEO frontaliere/run precedente');
  assert.deepEqual(population, {
    kind: 'feed-population',
    label: 'chunk SEO frontaliere/run precedente',
    declared: 60,
    source: 3750,
  });
  assert.equal(measured.feeds[0].items, 50, 'il feed resta pieno del suo cap');
  const advisories = retentionAdvisories(rows);
  assert.equal(advisories.length, 1);
  assert.match(advisories[0], /chunk SEO frontaliere\/run precedente/);
  assert.match(advisories[0], /popolazione 60\/3750/);
  assert.equal(FEED_POPULATION_WARN_RETENTION, 0.9);
});

test('una differenza storica fisiologica dei chunk non produce il warning retention degli articoli', () => {
  const { measured, expected } = healthy();
  const nearCurrent = {
    ...expected,
    feedSources: { ...expected.feedSources, frontaliere: 3784 },
    previousFeedSources: { ...expected.previousFeedSources, frontaliere: 3847 },
  };
  const population = retentionReport(measured, nearCurrent)
    .find((row) => row.label === 'chunk SEO frontaliere/run precedente');
  assert.deepEqual(population, {
    kind: 'feed-population',
    label: 'chunk SEO frontaliere/run precedente',
    declared: 3784,
    source: 3847,
  });
  assert.deepEqual(
    retentionAdvisories(retentionReport(measured, nearCurrent))
      .filter((line) => line.includes('chunk SEO frontaliere/run precedente')),
    [],
  );
});

test('il report tace dove il riferimento manca: quello e\' una violazione, non un rapporto', () => {
  const { measured, expected } = healthy();
  const noCorpus = { ...expected, sourceArticles: { frontaliere: 0, svizzera: 0 }, feedSources: { frontaliere: 0, svizzera: 0 }, sourceImages: 0 };

  assert.deepEqual(retentionReport(measured, noCorpus), []);
  assert.deepEqual(retentionAdvisories(retentionReport(measured, noCorpus)), []);
  assert.ok(floorViolations(measured, noCorpus).length > 0, 'il riferimento assente resta bloccante');
  assert.equal(retentionRatio(10, 0), null, 'sorgente a zero non e\' un rapporto zero: e\' assenza di riferimento');
});

test('le righe stampate: i due rapporti del manifest, le immagini, e il feed piu\' magro', () => {
  const { measured, expected } = healthy();
  const uneven = {
    ...measured,
    feeds: [
      { name: 'rss.xml', items: 50 },
      { name: 'rss-it.xml', items: 46 },
      { name: 'rss-svizzera.xml', items: 50 },
      { name: 'rss-svizzera-de.xml', items: 50 },
    ],
  };
  const lines = retentionLines(retentionReport(uneven, expected));

  assert.equal(lines.length, 6, `2 manifest + 2 popolazioni + 1 feed rappresentativo + 1 immagini, ricevute: ${lines.join(' | ')}`);
  assert.ok(lines.some((l) => l.startsWith('manifest.counts.articles:')));
  assert.ok(lines.some((l) => l.startsWith('manifest.counts.swissArticles:')));
  assert.ok(lines.some((l) => l.startsWith('chunk SEO frontaliere/run precedente:')));
  assert.ok(lines.some((l) => l.startsWith('chunk SEO svizzera/run precedente:')));
  assert.ok(lines.some((l) => l.includes('rss-it.xml') && l.includes('piu\' magro')), 'il rappresentante e\' il minimo');
  assert.ok(lines.some((l) => l.startsWith('images-manifest.json:')));
  // Il margine e' in punti percentuali dal gate, che e' la grandezza che dice
  // quanto manca al blocco.
  assert.match(retentionLine('x', 3789, 3792), /3789\/3792 = 99\.92% \(margine 9\.9 pp dal gate 90%\)/);
  assert.equal(retentionWarning('x', 3789, 3792), null, 'a 99,92% non c\'e\' niente da avvisare');
});

test('end-to-end: un rapporto eroso stampa ::warning:: ed esce 0', () => {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'api-floors-warn-'));
  const source = countSourceArticles(ROOT, 'frontaliere');
  const sourceImages = countSourceImages(ROOT);
  // I feed sono completi per isolare il livello advisory sul manifest. Le
  // immagini attese vanno invece dichiarate, altrimenti il nuovo floor
  // segnala correttamente un manifest assente.
  fs.writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({
      counts: {
        articles: Math.round(source * 0.95),
        swissArticles: countSourceArticles(ROOT, 'svizzera'),
      },
    }),
  );
  fs.writeFileSync(join(dir, 'images-manifest.json'), JSON.stringify({ images: Array(sourceImages).fill('image') }));
  writeHealthyFeeds(dir);

  const run = spawnSync(process.execPath, [join(ROOT, 'scripts/ci/verify-api-floors.mjs'), '--dist', dir], {
    encoding: 'utf-8',
  });
  fs.rmSync(dir, { recursive: true, force: true });

  assert.equal(run.status, 0, `il preallarme non blocca la pubblicazione:\n${run.stdout}\n${run.stderr}`);
  const out = `${run.stdout}${run.stderr}`;
  assert.match(out, /\[api-floors\] chunk SEO .*run precedente:/, 'la run deve esporre il riferimento storico dei chunk');
  assert.match(out, /::warning::\[api-floors\] manifest\.counts\.articles: rapporto 9[45]\.\d\d% sotto il preallarme/);
  assert.match(out, /manifest\.counts\.swissArticles: \d+\/\d+ = 100\.00% \(margine 10\.0 pp/);
});

test('end-to-end: una run rossa conserva gli advisory degli altri rapporti', () => {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'api-floors-red-warn-'));
  const sourceFrontaliere = countSourceArticles(ROOT, 'frontaliere');
  const sourceSvizzera = countSourceArticles(ROOT, 'svizzera');
  const sourceImages = countSourceImages(ROOT);
  fs.writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({
      counts: {
        articles: 500,
        swissArticles: Math.round(sourceSvizzera * 0.95),
      },
    }),
  );
  fs.writeFileSync(join(dir, 'images-manifest.json'), JSON.stringify({ images: Array(sourceImages).fill('image') }));
  writeHealthyFeeds(dir);

  const run = spawnSync(process.execPath, [join(ROOT, 'scripts/ci/verify-api-floors.mjs'), '--dist', dir], {
    encoding: 'utf-8',
  });
  fs.rmSync(dir, { recursive: true, force: true });

  assert.equal(run.status, 1, `il pavimento articles deve bloccare la pubblicazione:\n${run.stdout}\n${run.stderr}`);
  const out = `${run.stdout}${run.stderr}`;
  assert.match(out, /::warning::\[api-floors\] manifest\.counts\.swissArticles: rapporto/);
  assert.match(out, /::error::manifest\.counts\.articles: 500 contro/);
  assert.ok(sourceFrontaliere > 0);
});

test('build-blog-index sorveglia i suoi pavimenti con lo stesso livello advisory', () => {
  // Gemelli della stessa classe: `registryFloor` e `localeFloor` erano gate
  // muti quanto quello di publish, e il loro primo sintomo sarebbe un indice
  // che si rifiuta di pubblicarsi.
  assert.ok(BLOG_INDEX.includes('retentionWarning'), 'il preallarme deve valere anche qui');
  assert.ok(BLOG_INDEX.includes('retentionLine'), 'il rapporto registro/corpus va stampato a ogni run');
  assert.doesNotMatch(
    BLOG_INDEX,
    /const\s+(FLOOR_WARN|WARN_RETENTION)/,
    'la soglia di preallarme ha UNA sorgente: corpus-floors.mjs (AGENTS.md #6)',
  );
});
