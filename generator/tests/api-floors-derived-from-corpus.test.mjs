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
  WARN_MARGIN,
  floorFrom,
  countSeoEntries,
  countSourceArticles,
  retentionOf,
  sectionFloor,
  withinWarnBand,
  SEO_ENTRY_RE,
} from '../../scripts/lib/corpus-floors.mjs';
import { countTags, stripTextSections } from '../../scripts/lib/xml-counts.mjs';
import {
  SECTION_COUNTERS,
  retentionWarnings,
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
    // La popolazione che GENERA i feed: le voci dei chunk SEO, non i corpi.
    seoEntries: { frontaliere: 3780, svizzera: 1848 },
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
    expected: {
      sourceArticles: { frontaliere: 10, svizzera: 10 },
      seoEntries: { frontaliere: 10, svizzera: 10 },
      sourceImages: 0,
      rssMaxItems: 50,
    },
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
  const noCorpus = {
    sourceArticles: { frontaliere: 0, svizzera: 0 },
    seoEntries: { frontaliere: 0, svizzera: 0 },
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

test("una sola sezione senza corpus e' segnalata, e non spegne l'altra", () => {
  const { measured, expected } = healthy();
  const halfCorpus = { ...expected, sourceArticles: { frontaliere: 3785, svizzera: 0 } };
  const violations = floorViolations(measured, halfCorpus);
  assert.equal(violations.length, 1, 'i corpi svizzera mancanti riguardano il contatore, non i feed');
  assert.match(violations[0], /manifest\.counts\.swissArticles/);
  // I feed frontaliere restano gatati contro la LORO popolazione, che c'e'.
  const alsoTruncated = { ...measured, feeds: [...measured.feeds, { name: 'rss-fr.xml', items: 2 }] };
  assert.equal(floorViolations(alsoTruncated, halfCorpus).length, 2);
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
  // Le voci SEO devono bastare a riempire un feed intero in entrambe le
  // sezioni: e' la popolazione da cui gli <item> vengono davvero.
  assert.ok(expected.seoEntries.frontaliere > expected.rssMaxItems, `voci SEO frontaliere: ${expected.seoEntries.frontaliere}`);
  assert.ok(expected.seoEntries.svizzera > expected.rssMaxItems, `voci SEO svizzera: ${expected.seoEntries.svizzera}`);
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

/*
 * ─────────────────────────────────────────────────────────────────────────
 * #917 item 2 — il pavimento dei feed era tarato sulla popolazione SBAGLIATA.
 *
 * `buildSectionFeeds` costruisce gli <item> da `parseSeoBlogs(section.seoFiles)`,
 * non dai file di corpo che `countSourceArticles` conta. Le due popolazioni
 * possono divergere senza che nulla le colleghi — e' gia' successo, il feed
 * fermo tre mesi perche' i chunk letti erano due su sette — e la divergenza
 * andava nella direzione che BLOCCA: un feed legittimamente corto faceva
 * fallire l'intera pubblicazione.
 */
test('il pavimento di un feed segue le voci SEO, non i corpi della sezione', () => {
  const { measured, expected } = healthy();
  // Corpus di corpi pieno, popolazione SEO ridotta a 12 voci: un feed da 12
  // item e' COMPLETO, e il vecchio atteso (min(50, 3785) = 45) l'avrebbe
  // dichiarato troncato fermando la pubblicazione.
  const thin = { ...expected, seoEntries: { ...expected.seoEntries, frontaliere: 12 } };
  const feeds = [
    { name: 'rss.xml', items: 12 },
    { name: 'rss-it.xml', items: 12 },
    { name: 'rss-svizzera.xml', items: 50 },
    { name: 'rss-svizzera-de.xml', items: 50 },
  ];
  assert.deepEqual(floorViolations({ ...measured, feeds }, thin), []);

  // E resta un gate: sulla stessa popolazione, tre item sono un troncamento.
  const truncated = floorViolations({ ...measured, feeds: [{ name: 'rss.xml', items: 3 }] }, thin);
  assert.equal(truncated.length, 1);
  assert.match(truncated[0], /rss\.xml: 3 <item> contro 12 attesi/);
  assert.match(truncated[0], /12 voci SEO nella sezione frontaliere/);
});

test('voci SEO a zero = riferimento assente, non un feed senza pavimento', () => {
  const { measured, expected } = healthy();
  const noSeo = { ...expected, seoEntries: { frontaliere: 0, svizzera: 0 } };
  // Artefatto arbitrariamente troncato: un item per feed.
  const feeds = measured.feeds.map((f) => ({ ...f, items: 1 }));
  const violations = floorViolations({ ...measured, feeds }, noSeo);
  assert.equal(violations.length, feeds.length, 'ogni feed senza riferimento va segnalato');
  assert.ok(violations.every((v) => /riferimento del pavimento assente/.test(v)));
});

test('countSeoEntries conta le voci dei chunk e tratta un chunk assente come zero', () => {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'seo-count-'));
  fs.mkdirSync(join(dir, 'content', 'seo'), { recursive: true });
  fs.writeFileSync(
    join(dir, 'content', 'seo', 'seo-blog.ts'),
    "export const X = {\n  'blog-uno': { headline: 'a' },\n  'blog-due': { headline: 'b' },\n};\n",
  );
  assert.equal(countSeoEntries(dir, ['seo-blog.ts', 'seo-blog-2.ts']), 2);
  assert.equal(countSeoEntries(dir, ['seo-blog-2.ts']), 0, "un chunk assente vale zero voci, come in parseSeoBlogs");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("SEO_ENTRY_RE e' la stessa regex che l'engine usa per spezzare le voci", () => {
  // `entryRe` non e' esportata da engine/rssFeeds.mjs, e l'engine arriva per
  // mirror dal sito: non e' modificabile da qui. Il legame regge solo se un
  // test lo sorveglia — se l'engine cambia parser, questo cade invece di
  // lasciare il pavimento dei feed tarato su una popolazione fantasma.
  const engine = fs.readFileSync(join(ROOT, 'engine', 'rssFeeds.mjs'), 'utf-8');
  const declared = engine.match(/const entryRe = (\/.*\/g);/);
  assert.ok(declared, "parseSeoBlogs non dichiara piu' `entryRe`: il pavimento dei feed va riallineato");
  assert.equal(declared[1], SEO_ENTRY_RE.source.replace(/^/, '/') + '/g');
});

/*
 * ─────────────────────────────────────────────────────────────────────────
 * #917 item 3 — `<item>` veniva contato anche DENTRO il CDATA.
 */
test('gli <item> si contano sulla struttura, non dentro il corpo dell\'articolo', () => {
  const xml =
    '<rss><channel>' +
    '<item><title>a</title>' +
    '<content:encoded><![CDATA[<p>come si scrive un <item> in RSS</p><item>]]></content:encoded>' +
    '</item>' +
    '<item><title>b</title></item>' +
    '<!-- <item> in un commento -->' +
    '</channel></rss>';
  assert.equal(countTags(xml, 'item'), 2, 'due elementi: il testo del corpo non e\' struttura');
  // La direzione dell'errore era quella che MASCHERA un troncamento: il
  // pavimento e' un `<`, e un conteggio gonfiato lo supera.
  assert.ok(xml.split('<item>').length - 1 > 2, 'il conteggio testuale gonfiava, e il gate passava');
  assert.ok(!stripTextSections(xml).includes('come si scrive'));
});

test('countTags non confonde un tag col suo prefisso, e ignora le chiusure', () => {
  assert.equal(countTags('<urlset><url>a</url><url>b</url></urlset>', 'url'), 2);
  assert.equal(countTags('<items><item/></items>', 'item'), 1, 'anche un elemento auto-chiuso e\' un elemento');
  assert.equal(countTags('<rss><item xmlns:x="y">a</item></rss>', 'item'), 1, 'un attributo non nasconde il tag');
  assert.equal(countTags(null, 'item'), 0);
});

test("un feed troncato non si nasconde piu' dietro un corpo che parla di markup", () => {
  const { measured, expected } = healthy();
  // Il feed ha 3 <item> veri; il corpo del primo cita `<item>` cinquanta volte.
  const xml = '<rss>' + '<item>x</item>'.repeat(3) +
    '<content:encoded><![CDATA[' + '<item>'.repeat(50) + ']]></content:encoded></rss>';
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'api-floors-cdata-'));
  fs.writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ counts: measured.articleCounts }));
  fs.writeFileSync(join(dir, 'rss.xml'), xml);
  const m = measureDist(dir);
  assert.deepEqual(m.feeds, [{ name: 'rss.xml', items: 3 }]);
  const violations = floorViolations({ ...m, images: null }, expected);
  assert.ok(violations.some((v) => /rss\.xml: 3 <item>/.test(v)), `il troncamento deve emergere: ${JSON.stringify(violations)}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

/*
 * ─────────────────────────────────────────────────────────────────────────
 * #917 item 4 — FLOOR_RETENTION vive su un rapporto NON stazionario, e nessuno
 * lo sorvegliava. La banda di margine non muove nessun pass/fail: rende
 * visibile l'avvicinamento prima che diventi un blocco.
 */
test('retentionOf misura il rapporto, e su un riferimento assente non lo inventa', () => {
  assert.equal(retentionOf(90, 100), 0.9);
  assert.equal(retentionOf(50, 0), null, 'un rapporto su zero non e\' infinito: e\' assenza di misura');
  assert.equal(retentionOf(Number.NaN, 100), null);
});

test('la banda di margine si accende sopra il pavimento, non sotto e non a regime', () => {
  const at = (r) => withinWarnBand(Math.round(1000 * r), 1000);
  assert.equal(at(1.0), false, 'un rapporto sano non allarma');
  assert.equal(at(FLOOR_RETENTION + WARN_MARGIN / 2), true, 'dentro la banda: la deriva e\' visibile prima del muro');
  assert.equal(at(FLOOR_RETENTION), true, 'il bordo inferiore della banda e\' il pavimento stesso');
  assert.equal(at(FLOOR_RETENTION - 0.01), false, 'sotto il pavimento non e\' un avviso: e\' gia\' una violazione');
  assert.equal(withinWarnBand(10, 0), false, 'nessuna misura, nessun avviso doppio');
});

test('retentionWarnings avvisa senza aggiungere una violazione', () => {
  const { measured, expected } = healthy();
  assert.deepEqual(retentionWarnings(measured, expected), [], 'la superficie sana non deve rumoreggiare');

  // 3450/3785 = 91,1%: sopra il pavimento (3406) e dentro la banda.
  const drifting = { ...measured, articleCounts: { ...measured.articleCounts, articles: 3450 } };
  assert.deepEqual(floorViolations(drifting, expected), [], 'la banda non muove il pass/fail');
  const warnings = retentionWarnings(drifting, expected);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /manifest\.counts\.articles: 3450\/3785/);
});

/*
 * ─────────────────────────────────────────────────────────────────────────
 * #917 item 5 — build-blog-index scriveva PRIMA di rifiutare.
 *
 * Con `content/blog-body-ch/it` vuota e il resto del checkout intero, lo script
 * emetteva comunque gli otto file della sezione `frontaliere` e solo POI usciva
 * 1: il ramo di rifiuto fa `continue`, non un abort. Nella run normale l'upload
 * sta a valle e viene saltato — ma un retry del solo step di push, o un riuso
 * della workdir, raccoglierebbe quella directory a meta'.
 */
test('build-blog-index aborta prima della prima scrittura, non dopo', () => {
  const abort = BLOG_INDEX.indexOf('process.exit(1)');
  assert.ok(abort > 0, "l'abort deve esistere: un indice a meta' non puo' uscire 0");
  const firstWrite = BLOG_INDEX.indexOf('fs.writeFileSync(');
  assert.ok(firstWrite > 0, 'lo script deve pur scrivere qualcosa');
  assert.ok(
    firstWrite > abort,
    'ogni scrittura deve stare a valle del rifiuto: una sezione valida non compensa una rotta',
  );
  // E la directory di output non va nemmeno creata prima del verdetto.
  assert.ok(BLOG_INDEX.indexOf('fs.mkdirSync(OUT') > abort);
  assert.match(BLOG_INDEX, /pendingWrites/, 'le scritture vanno trattenute, non emesse man mano');
});
