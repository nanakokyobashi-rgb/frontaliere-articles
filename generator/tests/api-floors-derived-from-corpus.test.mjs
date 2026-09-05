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
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import {
  FLOOR_RETENTION,
  floorFrom,
  countSourceArticles,
  sectionFloor,
} from '../../scripts/lib/corpus-floors.mjs';
import {
  SECTION_COUNTERS,
  feedSection,
  floorViolations,
  measureDist,
  expectFromCorpus,
} from '../../scripts/ci/verify-api-floors.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const WORKFLOW = fs.readFileSync(join(ROOT, '.github/workflows/publish-api.yml'), 'utf-8');
const BLOG_INDEX = fs.readFileSync(join(ROOT, 'scripts/build-blog-index.mjs'), 'utf-8');

/** Una superficie sana su un corpus della taglia di quello reale. */
function healthy() {
  const expected = {
    sourceArticles: { frontaliere: 3785, svizzera: 1850 },
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
  // il motivo per cui l'atteso e' min(RSS_MAX_ITEMS, corpus) e non il tetto.
  const tiny = {
    measured: { articleCounts: { articles: 10, swissArticles: 10 }, feeds: [{ name: 'rss.xml', items: 10 }], images: null },
    expected: { sourceArticles: { frontaliere: 10, svizzera: 10 }, sourceImages: 0, rssMaxItems: 50 },
  };
  assert.deepEqual(floorViolations(tiny.measured, tiny.expected), []);
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
  const noCorpus = { sourceArticles: { frontaliere: 0, svizzera: 0 }, sourceImages: 0, rssMaxItems: 50 };
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
  const violations = floorViolations(measured, { ...expected, sourceArticles: { frontaliere: 3785, svizzera: 0 } });
  assert.equal(violations.length, 1, 'il feed svizzera non deve aggiungere una seconda riga sullo stesso riferimento');
  assert.match(violations[0], /manifest\.counts\.swissArticles/);
  // I feed frontaliere restano gatati contro il loro corpus, che c'e'.
  const alsoTruncated = { ...measured, feeds: [...measured.feeds, { name: 'rss-fr.xml', items: 2 }] };
  assert.equal(
    floorViolations(alsoTruncated, { ...expected, sourceArticles: { frontaliere: 3785, svizzera: 0 } }).length,
    2,
  );
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

test("images: manifest non emesso e' valido, manifest svuotato no", () => {
  const { measured, expected } = healthy();
  assert.deepEqual(floorViolations({ ...measured, images: null }, expected), []);
  const violations = floorViolations({ ...measured, images: 3 }, expected);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /images-manifest\.json: 3 immagini contro 1990/);
});

test('feedSection separa le due sezioni dai nomi che RSS_SECTIONS genera', () => {
  assert.equal(feedSection('rss-svizzera.xml'), 'svizzera');
  assert.equal(feedSection('rss-svizzera-fr.xml'), 'svizzera');
  assert.equal(feedSection('rss.xml'), 'frontaliere');
  assert.equal(feedSection('rss-de.xml'), 'frontaliere');
  assert.deepEqual(Object.keys(SECTION_COUNTERS).sort(), ['frontaliere', 'svizzera']);
});

test('measureDist riconosce i feed dal documento, non dal nome del file', () => {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'api-floors-'));
  fs.writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ counts: { articles: 7, swissArticles: 2 } }));
  fs.writeFileSync(join(dir, 'rss.xml'), '<rss><item>a</item><item>b</item></rss>');
  // Una sitemap e' <urlset>, non <rss>: non deve entrare nel conteggio dei feed.
  fs.writeFileSync(join(dir, 'sitemap-blog.xml'), '<urlset><url>x</url></urlset>');

  const measured = measureDist(dir);
  assert.deepEqual(measured.feeds, [{ name: 'rss.xml', items: 2 }]);
  assert.equal(measured.images, null, 'images-manifest.json assente ⇒ null, che e\' un caso valido');
  assert.equal(measured.articleCounts.articles, 7);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("il corpus di questo checkout e' la verita' di terra, e regge i due contatori", async () => {
  const expected = await expectFromCorpus(ROOT);
  assert.ok(expected.sourceArticles.frontaliere > 1000, `frontaliere: ${expected.sourceArticles.frontaliere}`);
  assert.ok(expected.sourceArticles.svizzera > 500, `svizzera: ${expected.sourceArticles.svizzera}`);
  assert.equal(expected.rssMaxItems, 50, 'RSS_MAX_ITEMS arriva da engine/rssFeeds.mjs, non da una copia');
  assert.equal(expected.sourceArticles.frontaliere, countSourceArticles(ROOT, 'frontaliere'));
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

test("build-blog-index non porta piu' MIN_ENTRIES, ma il pavimento derivato", () => {
  assert.doesNotMatch(BLOG_INDEX, /^const MIN_ENTRIES\b/m, 'la costante assoluta e\' tornata');
  assert.ok(
    BLOG_INDEX.includes("from './lib/corpus-floors.mjs'"),
    'il pavimento deve venire dalla stessa sorgente unica del gate di pubblicazione',
  );
  assert.match(BLOG_INDEX, /registry\.length < registryFloor/);
  assert.match(BLOG_INDEX, /entries\.length < localeFloor/);
});
