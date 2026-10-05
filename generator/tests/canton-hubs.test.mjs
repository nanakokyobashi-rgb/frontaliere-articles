/**
 * Producer degli hub tematici cantonali (P10, D17): costruzione dei dati per
 * canton-ti, canton-gr e canton-be nelle 4 locali, blocchi omessi sotto
 * soglia, nessun noindex, stabilita' (seconda esecuzione = nessun diff), news
 * promosse e link.
 *
 * Niente rete: i dataset sono le registrazioni REWIRE gia' in repo
 * (`fixtures/rewire/`), rimesse in data con gli stessi helper dei test di
 * contratto, piu' due registrazioni ridotte di fisco e pensioni
 * (`fixtures/canton-hubs/`). Il corpus e' un albero temporaneo scritto qui,
 * nella forma che i lettori veri leggono (registro, mappa slug, meta).
 * L'engine (tassonomia e TF-IDF) e' quello VERO, caricato da `engine/`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ARTICLE_SECTION_CORE_ALL } from '../../engine/shared/articleSectionCore.mjs';
import { CANTON_HUB_TOPIC_KEYS } from '../../engine/shared/cantonArticleSectionCore.generated.mjs';
import { CANTON_HUB_TOPIC_CLUSTERS } from '../../engine/shared/cantonSectionCopy.mjs';
import { sectionWriteSurfaces } from '../../scripts/lib/article-surfaces.mjs';
import { sectionSourceSurfaces } from '../../scripts/lib/corpus-sections.mjs';
import { sectionRebaseSurfaces } from '../../scripts/ci/rebase-section-args.mjs';
import { cantonSectionIds, cantonSectionProfile } from '../scripts/lib/canton-section-profile.mjs';
import { CANTON_GROUPS, buildCantonServices } from '../scripts/lib/canton-services-data.mjs';
import { keywordTopicScore, loadCantonPool, selectCuratedArticles, sidecarQuality } from '../scripts/lib/canton-hubs/articles.mjs';
import { BLOCK_THRESHOLDS, CLOCK_SKEW_MS, DAY_MS, HOUR_MS, OMIT_CODES } from '../scripts/lib/canton-hubs/blocks-common.mjs';
import { parseCrossingNames } from '../scripts/lib/canton-hubs/blocks-border-wait.mjs';
import { shapeRoadEventsBlock } from '../scripts/lib/canton-hubs/blocks-road-events.mjs';
import { HUB_MIN_CONTENT_WORDS, TOPIC_BLOCKS, buildHubFile, hubContentHash, hubFilePaths, validateHubInput } from '../scripts/lib/canton-hubs/build.mjs';
import { buildHubIntro, cantonPlace, foreignToponymsInCopy } from '../scripts/lib/canton-hubs/copy.mjs';
import { loadTopicEngine } from '../scripts/lib/canton-hubs/engine-loader.mjs';
import { HUB_LOCALES, fmtDay, fmtNumber, fmtPct } from '../scripts/lib/canton-hubs/format.mjs';
import { buildHubLinks, jobsPagePath } from '../scripts/lib/canton-hubs/links.mjs';
import { enabledCantonSections, generateCantonHubs, parseArgs } from '../scripts/generate-canton-hubs.mjs';
import { contract, freshenGeneratedAt, freshenRecording, freshenWindow } from './lib/rewire-contracts.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

const NOW = Date.parse('2026-10-05T09:00:00.000Z');
const NOW_ISO = new Date(NOW).toISOString();
const PILOTS = ['canton-ti', 'canton-gr', 'canton-be'];

const CONFIG = readJson('generator/data/canton-hub-topics.json');
const CATALOGUE = readJson('generator/data/canton-hub-links.json');
const CANTON_URL_SLUGS = readJson('generator/data/canton-url-slugs.json');

// ── Dataset: le registrazioni REWIRE, rimesse in data su NOW ────────────────

function fixtureDatasets() {
  const rewire = (id) => readJson(contract(id).fixture);
  const shifted = (id) => freshenRecording({ freshen: 'shift-timestamps' }, rewire(id), NOW);
  const day = (offset) => new Date(NOW + offset * DAY_MS).toISOString().slice(0, 10);

  // Gli eventi registrati stanno su un weekend fisso: li si porta nei prossimi giorni.
  const events = rewire('events-dataset');
  events.generatedAt = new Date(NOW - 3 * HOUR_MS).toISOString();
  events.events.forEach((e, i) => {
    e.startDate = day(1 + i);
    if (e.endDate) e.endDate = e.startDate;
  });
  // Tre eventi nei Grigioni e nessuno a Berna: sopra e sotto la soglia minima.
  for (const [i, title] of ['Mercato di Poschiavo', 'Concerto a Coira', 'Festa del paese a Roveredo'].entries()) {
    events.events.push({ id: `fixture:gr-${i}`, title, titleByLocale: { it: title, en: title, de: title, fr: title }, startDate: day(2 + i), canton: 'GR', comune: 'Poschiavo', url: `https://example.org/gr-${i}` });
  }

  // La finestra dei valichi finisce ieri; due valichi grigionesi oltre agli otto ticinesi.
  const borderWait = freshenWindow(rewire('border-wait-window'), day(0));
  borderWait.current.perCrossing['castasegna-villa-di-chiavenna'] = { weightedAvgMinutes: 1.5, totalSamples: 40, canton: 'GR' };
  borderWait.current.perCrossing['campocologno-tirano'] = { weightedAvgMinutes: 3.25, totalSamples: 44, canton: 'GR' };

  const services = buildCantonServices({
    premiums: freshenRecording(contract('health-premiums'), rewire('health-premiums'), NOW),
    plateAuctions: shifted('plate-auctions'),
    pharmacyDuties: shifted('pharmacy-duty-cantons'),
    weather: shifted('weather-snapshot'),
  }, CANTON_GROUPS, { nowMs: NOW });

  return {
    fuel: freshenGeneratedAt(shifted('fuel-cantons'), new Date(NOW - 2 * HOUR_MS).toISOString()),
    events,
    borderWait,
    roadEvents: shifted('road-events'),
    notices: shifted('canton-notices'),
    services,
    tax: readJson('generator/tests/fixtures/canton-hubs/canton-tax.json'),
    pensions: readJson('generator/tests/fixtures/canton-hubs/pension-parameters.json'),
  };
}

const NO_DATASETS = Object.freeze({ fuel: null, events: null, borderWait: null, roadEvents: null, notices: null, services: null, tax: null, pensions: null });

// ── Corpus: un albero temporaneo nella forma dei sorgenti veri ─────────────

const ago = (days) => new Date(NOW - days * DAY_MS).toISOString();

/** Un articolo di fixture: titolo ed estratto italiani, le altre locali derivate. */
function article(id, section, title, excerpt, { days = 3, cantons = [], category = 'novita', quality = null } = {}) {
  return { id, section, title, excerpt, date: ago(days), cantons, category, quality };
}

const CORPUS = [
  // Sezione propria del Ticino.
  article('ti-benzina-prezzi', 'canton-ti', 'Prezzi di benzina e diesel in Ticino: carburanti in rialzo', 'I distributori ticinesi ritoccano i prezzi dei carburanti: benzina e diesel al rifornimento.', { days: 1 }),
  article('ti-festival-locarno', 'canton-ti', 'Festival di Locarno: concerti ed eventi del fine settimana', 'Il programma di concerti, mostre ed eventi in piazza per il weekend.', { days: 2 }),
  // Frontaliere, etichettati col cantone.
  article('imposta-fonte-ticino', 'frontaliere', 'Imposta alla fonte in Ticino: aliquote e dichiarazione delle imposte', 'Come si calcola l’imposta alla fonte, le aliquote e la dichiarazione dei redditi per i frontalieri.', { cantons: ['TI'], days: 4, quality: 0.9 }),
  article('imposta-fonte-ticino-doppione', 'frontaliere', 'Imposta alla fonte in Ticino: aliquote e dichiarazione delle imposte', 'Stesso titolo di un altro articolo: deve restarne uno.', { cantons: ['TI'], days: 30 }),
  article('avs-rendite-ticino', 'frontaliere', 'Rendite AVS e pensione in Ticino: cosa cambia per la previdenza', 'Le rendite AVS, il secondo pilastro e la pensione dei frontalieri.', { cantons: ['TI'], days: 6 }),
  article('dogana-chiasso-traffico', 'frontaliere', 'Dogana di Chiasso: traffico e code al valico di confine', 'Tempi di attesa alla dogana, traffico sull’autostrada e treni TILO.', { cantons: ['TI'], days: 2 }),
  article('farmacie-turno-ticino', 'svizzera', 'Farmacie di turno in Ticino e premi di cassa malati', 'Le farmacie aperte, l’ospedale e la cassa malati: i servizi sanitari del cantone.', { cantons: ['TI'], days: 5 }),
  article('incidente-ospedale', 'frontaliere', 'Incidente in moto: ferito portato in ospedale', 'Un incidente sulla cantonale, il ferito è in ospedale.', { cantons: ['TI'], days: 1 }),
  article('vivere-a-comune', 'frontaliere', 'Vivere a Castelseprio e lavorare in Ticino da frontaliere', 'Guida pratica: tasse, imposte, pensione, trasporti e benzina per chi si trasferisce.', { cantons: ['TI'], days: 1 }),
  article('bollettino-frontaliere-2026-10-04', 'frontaliere', 'Bollettino del frontaliere: benzina, dogana e cambio', 'Prezzi della benzina e dei carburanti, code in dogana.', { cantons: ['TI'], days: 1 }),
  article('ti-futuro', 'frontaliere', 'Imposte in Ticino: la dichiarazione delle imposte del futuro', 'Imposte e dichiarazione.', { cantons: ['TI'], days: -5 }),
  // Nove ore nel futuro: oltre lo sfasamento d'orologio ammesso, quindi non ancora
  // una news (e non lo diventa nemmeno nei run successivi del test di stabilita').
  article('ti-fra-nove-ore', 'frontaliere', 'Imposte in Ticino: la dichiarazione delle imposte di stasera', 'Imposte e dichiarazione.', { cantons: ['TI'], days: -0.375 }),
  // Multi-label: Ticino e Grigioni.
  article('trasporti-ti-gr', 'svizzera', 'Trasporti pubblici e treni tra Ticino e Grigioni: nuovi abbonamenti', 'Abbonamenti dei trasporti pubblici, treni e autobus fra i due cantoni.', { cantons: ['TI', 'GR'], days: 3 }),
  // Grigioni.
  article('imposte-grigioni', 'svizzera', 'Imposte cantonali nei Grigioni: aliquote e deduzioni fiscali', 'Le imposte cantonali, le aliquote e le deduzioni della dichiarazione.', { cantons: ['GR'], days: 8, category: 'fiscale' }),
  article('carnevale-roveredo', 'frontaliere', 'Carnevale di Roveredo: eventi e concerti in Mesolcina', 'Il festival di carnevale con concerti ed eventi per tutti.', { cantons: ['GR'], days: 20 }),
  // Berna.
  article('avs-berna', 'svizzera', 'AVS nel Canton Berna: rendite e pensione di vecchiaia', 'Rendite AVS, lacune contributive e pensione.', { cantons: ['BE'], days: 10, category: 'pensione' }),
  article('imposte-berna', 'svizzera', 'Imposte cantonali a Berna: dichiarazione e aliquote fiscali', 'La dichiarazione delle imposte e le aliquote cantonali.', { cantons: ['BE'], days: 12, category: 'fiscale' }),
  // Zurigo: non deve comparire in nessuno dei tre piloti.
  article('imposte-zurigo', 'svizzera', 'Imposte cantonali a Zurigo: dichiarazione e aliquote fiscali', 'La dichiarazione delle imposte a Zurigo.', { cantons: ['ZH'], days: 2 }),
];

const LOCALE_TAG = { it: '', en: ' (EN)', de: ' (DE)', fr: ' (FR)' };
const tsString = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

function writeCorpus(root, articles = CORPUS) {
  const bySection = new Map();
  for (const a of articles) bySection.set(a.section, [...(bySection.get(a.section) ?? []), a]);
  for (const section of new Set(['frontaliere', 'svizzera', ...articles.map((a) => a.section)])) {
    // Le due sezioni storiche non sono mai vuote: un riempitivo zurighese, fuori dai piloti.
    const list = bySection.get(section) ?? [article(`riempitivo-${section}`, section, 'Notizie da Zurigo', 'Un articolo che non riguarda i cantoni pilota.', { cantons: ['ZH'] })];
    const src = sectionSourceSurfaces(section);
    const write = (rel, content) => {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), content);
    };
    write(src.registryFile, `export const ARTICLES = [\n${list.map((a) =>
      `  {\n    id: '${a.id}',\n    category: '${a.category}',\n    date: '${a.date}',\n${a.cantons.length && !section.startsWith('canton-') ? `    canton: [${a.cantons.map((c) => `'${c}'`).join(', ')}],\n` : ''}  },`).join('\n')}\n];\n`);
    write(src.slugFile, `const ${src.slugExport}: Record<string, Record<string, string>> = {\n${list.map((a) =>
      `  '${a.id}': { it: '${a.id}', en: '${a.id}-en', de: '${a.id}-de', fr: '${a.id}-fr' },`).join('\n')}\n};\n`);
    for (const locale of HUB_LOCALES) {
      write(src.metaFile(locale), `const meta: Record<string, string> = {\n${list.map((a) =>
        `  'blog.article.${a.id}.title': ${tsString(a.title + LOCALE_TAG[locale])},\n  'blog.article.${a.id}.excerpt': ${tsString(a.excerpt + LOCALE_TAG[locale])},`).join('\n')}\n};\nexport default meta;\n`);
    }
    for (const a of list) {
      if (a.quality == null) continue;
      write(`${sectionWriteSurfaces(section).sidecarDir}/${a.id}.json`, JSON.stringify({ id: a.id, _score_breakdown: { score: a.quality } }));
    }
  }
  // I dati che il producer legge dalla radice, oltre al corpus.
  for (const rel of ['generator/data/canton-hub-topics.json', 'generator/data/canton-hub-links.json', 'generator/data/canton-url-slugs.json']) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, rel), path.join(root, rel));
  }
  return root;
}

const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'canton-hubs-'));
const quiet = () => {};

async function runAll(root, { datasets = fixtureDatasets(), nowMs = NOW, sections = PILOTS, dryRun = false } = {}) {
  return generateCantonHubs({ root, sections, datasets, nowMs, dryRun, log: quiet });
}

const readHub = (root, section, topic) => JSON.parse(fs.readFileSync(path.join(root, `content/cantons/${section}/hubs/${topic}.json`), 'utf8'));
const blockIds = (hub, locale = 'it') => hub.locales[locale].dataBlocks.map((b) => b.id);

function buildOne(section, topic, overrides = {}) {
  return buildHubFile({
    section,
    topic,
    profile: cantonSectionProfile(section),
    datasets: fixtureDatasets(),
    curated: [],
    config: CONFIG,
    catalogue: CATALOGUE,
    cantonUrlSlugs: CANTON_URL_SLUGS,
    nowMs: NOW,
    ...overrides,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Costruzione: 3 cantoni pilota x 6 temi x 4 locali
// ─────────────────────────────────────────────────────────────────────────────

test('canton-ti, canton-gr e canton-be: 6 hub ciascuno, 4 locali, forma del renderer', async () => {
  const root = writeCorpus(tmpRoot());
  const result = await runAll(root);
  assert.deepEqual(result.errors, []);
  assert.equal(result.hubs.length, PILOTS.length * CANTON_HUB_TOPIC_KEYS.length);

  for (const section of PILOTS) {
    const canton = ARTICLE_SECTION_CORE_ALL[section].canton;
    assert.deepEqual(
      fs.readdirSync(path.join(root, `content/cantons/${section}/hubs`)).sort(),
      CANTON_HUB_TOPIC_KEYS.map((t) => `${t}.json`).sort(),
    );
    for (const topic of CANTON_HUB_TOPIC_KEYS) {
      const hub = readHub(root, section, topic);
      assert.equal(hub.schemaVersion, 1);
      assert.equal(hub.id, `${section}:${topic}`, 'id stabile <sezione>:<tema>');
      assert.equal(hub.updatedAt, NOW_ISO);
      assert.match(hub.contentHash, /^[0-9a-f]{64}$/);
      assert.deepEqual(Object.keys(hub.locales), HUB_LOCALES);
      for (const locale of HUB_LOCALES) {
        const input = hub.locales[locale];
        // La firma di CantonTopicHubInput, campo per campo e nient'altro.
        assert.deepEqual(Object.keys(input), ['canton', 'topic', 'locale', 'intro', 'keyFacts', 'dataBlocks', 'curatedArticles', 'links', 'updatedAt']);
        assert.equal(input.canton, canton);
        assert.equal(input.topic, topic);
        assert.equal(input.locale, locale);
        assert.equal(input.updatedAt, hub.updatedAt);
        assert.doesNotThrow(() => validateHubInput(input));
        assert.ok(input.links.length >= 2, `${section}/${topic}/${locale}: almeno due strumenti`);
        assert.ok(input.keyFacts.length <= CONFIG.maxKeyFacts);
        assert.ok(input.curatedArticles.length <= CONFIG.maxCuratedArticles);
      }
      // Stessa struttura in tutte le locali: stessi blocchi, stesso numero di righe, stesse news.
      for (const locale of HUB_LOCALES.slice(1)) {
        assert.deepEqual(blockIds(hub, locale), blockIds(hub, 'it'));
        assert.deepEqual(hub.locales[locale].dataBlocks.map((b) => b.items.length), hub.locales.it.dataBlocks.map((b) => b.items.length));
        assert.equal(hub.locales[locale].keyFacts.length, hub.locales.it.keyFacts.length);
        assert.equal(hub.locales[locale].curatedArticles.length, hub.locales.it.curatedArticles.length);
      }
      assert.deepEqual(hub.blocks.map((b) => b.id), blockIds(hub));
    }
  }
});

test('i blocchi vengono dai dataset di categoria, per cantone', async () => {
  const root = writeCorpus(tmpRoot());
  await runAll(root);
  const ids = (section, topic) => blockIds(readHub(root, section, topic));

  assert.deepEqual(ids('canton-ti', 'carburanti'), ['prezzi-carburanti']);
  assert.deepEqual(ids('canton-ti', 'fisco'), ['onere-fiscale', 'imposta-alla-fonte']);
  assert.ok(ids('canton-ti', 'mobilita').includes('attese-valichi'));
  assert.ok(ids('canton-ti', 'mobilita').includes('chiusure-cantieri'));
  assert.deepEqual(ids('canton-ti', 'eventi'), ['prossimi-eventi']);
  assert.deepEqual(ids('canton-ti', 'pensioni').slice(0, 3), ['parametri-previdenza', 'casse-cantonali', 'imposta-capitale']);
  assert.ok(ids('canton-ti', 'servizi').includes('premi-cassa-malati'));

  // Il Ticino ha lato svizzero e italiano; le cifre sono quelle del dataset.
  const fuel = readHub(root, 'canton-ti', 'carburanti').locales.it.dataBlocks[0];
  const record = fixtureDatasets().fuel.records.find((r) => r.canton === 'TI' && r.side === 'CH' && r.fuel === 'sp95');
  assert.equal(fuel.items[0].label, 'Benzina 95 — Svizzera');
  assert.equal(fuel.items[0].value, `${fmtNumber(record.avg, 'it', 3)} CHF/l`);
  assert.ok(fuel.items.some((it) => it.label.endsWith('Italia') && it.value.endsWith('EUR/l')), 'il lato estero resta in euro, non convertito');
  assert.ok(fuel.sourceName, 'ogni blocco di cifre dichiara la fonte');

  // Grigioni: valichi propri, eventi propri; nessun prezzo carburanti nella registrazione.
  assert.ok(ids('canton-gr', 'mobilita').includes('attese-valichi'));
  assert.deepEqual(ids('canton-gr', 'eventi'), ['prossimi-eventi']);
  assert.ok(!ids('canton-gr', 'carburanti').includes('prezzi-carburanti'));
  const grWait = readHub(root, 'canton-gr', 'mobilita').locales.de.dataBlocks.find((b) => b.id === 'attese-valichi');
  assert.deepEqual(grWait.items.map((it) => it.url), [
    '/de/wartezeit-grenze/castasegna-villa-di-chiavenna/heute/',
    '/de/wartezeit-grenze/campocologno-tirano/heute/',
  ]);

  // Berna: cantone interno, nessun valico e nessun prezzo. L'hub c'e' lo stesso.
  assert.ok(!ids('canton-be', 'mobilita').includes('attese-valichi'));
  assert.deepEqual(ids('canton-be', 'carburanti'), []);
  assert.ok(ids('canton-be', 'fisco').includes('onere-fiscale'));
  const burden = readHub(root, 'canton-be', 'fisco').locales.fr.dataBlocks[0];
  const tax = fixtureDatasets().tax;
  assert.equal(burden.items.length, tax.burden.incomeBracketsCHF.length);
  assert.equal(burden.items[0].value, fmtPct(tax.cantons.BE.burdenPct[String(tax.year)][0], 'fr'));
});

test('nessun noindex: ne\' nel file ne\' fra i campi, anche senza un solo blocco o una sola news', async () => {
  const root = writeCorpus(tmpRoot(), []);
  const result = await runAll(root, { datasets: NO_DATASETS });
  assert.deepEqual(result.errors, []);
  for (const section of PILOTS) {
    for (const topic of CANTON_HUB_TOPIC_KEYS) {
      const raw = fs.readFileSync(path.join(root, `content/cantons/${section}/hubs/${topic}.json`), 'utf8');
      assert.doesNotMatch(raw, /noindex|indexable|nofollow|"robots"/i);
      const hub = JSON.parse(raw);
      for (const locale of HUB_LOCALES) {
        const input = hub.locales[locale];
        assert.deepEqual(input.dataBlocks, []);
        assert.deepEqual(input.keyFacts, []);
        assert.deepEqual(input.curatedArticles, []);
        // La pagina si regge sull'intro evergreen: sopra la soglia del renderer.
        assert.doesNotThrow(() => validateHubInput(input));
        const words = input.intro.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
        assert.ok(words >= HUB_MIN_CONTENT_WORDS, `${section}/${topic}/${locale}: intro di ${words} parole`);
      }
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Soglie minime: un blocco sotto soglia si omette, la pagina resta
// ─────────────────────────────────────────────────────────────────────────────

test('ogni blocco ha una soglia: dataset assente, vecchio, malformato o troppo scarno → omesso con un codice', () => {
  const omittedCode = (section, topic, id, mutate) => {
    const datasets = fixtureDatasets();
    mutate(datasets);
    const built = buildOne(section, topic, { datasets });
    const block = built.blocks.find((b) => b.id === id);
    assert.ok(block, `${id} non e' fra i blocchi di ${topic}`);
    assert.ok(!built.file.locales.it.dataBlocks.some((b) => b.id === id) || block.status !== 'omitted');
    assert.doesNotThrow(() => HUB_LOCALES.forEach((l) => validateHubInput(built.file.locales[l])));
    return block.status === 'omitted' ? block.code : block.status;
  };
  const old = (ms) => new Date(NOW - ms).toISOString();

  // carburanti
  assert.equal(omittedCode('canton-ti', 'carburanti', 'prezzi-carburanti', () => {}), 'fresh');
  assert.equal(omittedCode('canton-ti', 'carburanti', 'prezzi-carburanti', (d) => { d.fuel = null; }), 'missing');
  assert.equal(omittedCode('canton-ti', 'carburanti', 'prezzi-carburanti', (d) => { d.fuel.generatedAt = old(BLOCK_THRESHOLDS.fuel.maxAgeMs + HOUR_MS); }), 'stale');
  assert.equal(omittedCode('canton-ti', 'carburanti', 'prezzi-carburanti', (d) => { d.fuel.generatedAt = new Date(NOW + DAY_MS).toISOString(); }), 'invalid');
  assert.equal(omittedCode('canton-ti', 'carburanti', 'prezzi-carburanti', (d) => { d.fuel = { records: 'x' }; }), 'invalid');
  assert.equal(omittedCode('canton-ti', 'carburanti', 'prezzi-carburanti', (d) => { d.fuel.records.forEach((r) => { r.stations = BLOCK_THRESHOLDS.fuel.minStations - 1; }); }), 'empty');
  assert.equal(omittedCode('canton-be', 'carburanti', 'prezzi-carburanti', () => {}), 'empty');

  // eventi
  assert.equal(omittedCode('canton-ti', 'eventi', 'prossimi-eventi', (d) => { d.events.generatedAt = old(BLOCK_THRESHOLDS.events.maxAgeMs + HOUR_MS); }), 'stale');
  assert.equal(omittedCode('canton-ti', 'eventi', 'prossimi-eventi', (d) => { d.events.events = d.events.events.filter((e) => e.canton !== 'TI').concat(d.events.events.filter((e) => e.canton === 'TI').slice(0, BLOCK_THRESHOLDS.events.minRows - 1)); }), 'empty');
  assert.equal(omittedCode('canton-be', 'eventi', 'prossimi-eventi', () => {}), 'empty');

  // mobilita'
  assert.equal(omittedCode('canton-be', 'mobilita', 'attese-valichi', () => {}), 'not-applicable');
  assert.equal(omittedCode('canton-ti', 'mobilita', 'attese-valichi', (d) => { d.borderWait = freshenWindow(d.borderWait, new Date(NOW - 20 * DAY_MS).toISOString().slice(0, 10)); }), 'stale');
  assert.equal(omittedCode('canton-ti', 'mobilita', 'attese-valichi', (d) => { for (const s of Object.values(d.borderWait.current.perCrossing)) delete s.canton; }), 'invalid');
  assert.equal(omittedCode('canton-ti', 'mobilita', 'chiusure-cantieri', (d) => { d.roadEvents.generatedAt = old(BLOCK_THRESHOLDS.roadEvents.maxAgeMs + HOUR_MS); }), 'stale');
  assert.equal(omittedCode('canton-ti', 'mobilita', 'chiusure-cantieri', (d) => { d.roadEvents.events.forEach((e) => { e.validFrom = old(10 * DAY_MS); e.validTo = old(DAY_MS); }); }), 'empty');

  // fisco e pensioni: opzionali finche' il loro refresh non e' su main
  assert.equal(omittedCode('canton-ti', 'fisco', 'onere-fiscale', (d) => { d.tax = null; }), 'missing');
  assert.equal(omittedCode('canton-ti', 'fisco', 'imposta-alla-fonte', (d) => { d.tax.year = 2020; }), 'stale');
  assert.equal(omittedCode('canton-ti', 'pensioni', 'parametri-previdenza', (d) => { d.pensions = null; }), 'missing');
  assert.equal(omittedCode('canton-ti', 'pensioni', 'parametri-previdenza', (d) => { d.pensions.federal.avs.maxMonthlyCHF += 1; }), 'invalid');
  assert.equal(omittedCode('canton-ti', 'pensioni', 'imposta-capitale', (d) => { d.pensions.year = 2020; }), 'stale');

  // servizi e avvisi
  assert.equal(omittedCode('canton-ti', 'servizi', 'premi-cassa-malati', (d) => { d.services.generatedAt = old(BLOCK_THRESHOLDS.services.maxAgeMs + HOUR_MS); }), 'stale');
  assert.equal(omittedCode('canton-ti', 'servizi', 'premi-cassa-malati', (d) => { d.services.cantons.TI.blocks.premiums = { available: false, reason: 'x' }; }), 'empty');
  assert.equal(omittedCode('canton-ti', 'mobilita', 'avvisi-ufficiali', (d) => { d.notices.generatedAt = old(BLOCK_THRESHOLDS.notices.maxAgeMs + HOUR_MS); }), 'stale');
  assert.equal(omittedCode('canton-ti', 'mobilita', 'avvisi-ufficiali', (d) => { d.notices.notices.forEach((n) => { n.publishedAt = null; }); }), 'empty');
  // Un avviso datato nel futuro non e' ancora uscito: non entra, nemmeno di poche ore.
  assert.equal(omittedCode('canton-ti', 'mobilita', 'avvisi-ufficiali', (d) => { d.notices.notices.forEach((n) => { n.publishedAt = new Date(NOW + 3 * HOUR_MS).toISOString(); }); }), 'empty');
  // Dataset annuali: anno in corso o precedente, mai il prossimo.
  const nextYear = new Date(NOW).getUTCFullYear() + 1;
  assert.equal(omittedCode('canton-ti', 'fisco', 'onere-fiscale', (d) => { d.tax.cantons.TI.burdenPct[String(nextYear)] = d.tax.cantons.TI.burdenPct[String(d.tax.year)]; d.tax.year = nextYear; }), 'invalid');
  assert.equal(omittedCode('canton-ti', 'fisco', 'imposta-alla-fonte', (d) => { d.tax.year = nextYear; }), 'invalid');
  assert.equal(omittedCode('canton-ti', 'pensioni', 'parametri-previdenza', (d) => { d.pensions.year = nextYear; }), 'invalid');
  assert.equal(omittedCode('canton-ti', 'pensioni', 'casse-cantonali', (d) => { d.pensions.year = nextYear; }), 'invalid');
  assert.equal(omittedCode('canton-ti', 'fisco', 'onere-fiscale', (d) => { d.tax.cantons.TI.burdenPct[String(d.tax.year - 1)] = d.tax.cantons.TI.burdenPct[String(d.tax.year)]; d.tax.year -= 1; }), 'fresh');

  // Ogni blocco dichiarato appartiene a un dataset noto e ha un'eta' di conservazione.
  for (const [topic, specs] of Object.entries(TOPIC_BLOCKS)) {
    assert.ok(CANTON_HUB_TOPIC_KEYS.includes(topic));
    for (const spec of specs) {
      assert.ok(Object.keys(NO_DATASETS).includes(spec.dataset), `${topic}: dataset sconosciuto ${spec.dataset}`);
      assert.ok(spec.carryMs > 0);
      const out = spec.shape(null, { canton: 'TI', members: ['TI'], topic, nowMs: NOW });
      assert.equal(out.available, false);
      assert.ok(OMIT_CODES.includes(out.code));
      assert.equal(out.code, 'missing', 'cache assente = missing, per ogni blocco');
    }
  }
});

test('chiusure e cantieri: oltre il tetto restano le limitazioni in corso e le piu\' imminenti', () => {
  const at = (days) => new Date(NOW + days * DAY_MS).toISOString();
  const closure = (id, startDays) => ({ id, canton: 'TI', type: 'chiusura', title: `Chiusura ${id}`, url: null, validFrom: at(startDays), validTo: at(startDays + 30), source: 'fixture', observedAt: at(0) });
  const dataset = {
    schemaVersion: 1,
    generatedAt: at(0),
    events: [
      closure('fra-12-giorni', 12), closure('fra-5-giorni', 5), closure('domani', 1),
      ...[1, 2, 3, 4, 5, 6, 7].map((d) => closure(`in-corso-da-${d}`, -d)),
      { ...closure('cantiere-in-corso', -2), type: 'cantiere' },
      { ...closure('oltre-orizzonte', BLOCK_THRESHOLDS.roadEvents.horizonDays + 3) },
      { ...closure('finita', -20), validTo: at(-1) },
    ],
  };
  const block = shapeRoadEventsBlock(dataset, { canton: 'TI', nowMs: NOW });
  assert.equal(block.available, true);
  const labels = block.render('it').items.map((it) => it.label.replace('Chiusura ', ''));
  assert.equal(labels.length, BLOCK_THRESHOLDS.roadEvents.maxRows);
  assert.deepEqual(labels, [7, 6, 5, 4, 3, 2, 1].map((d) => `in-corso-da-${d}`).concat('domani'), 'prima in corso, poi imminenti, dal piu\' vicino');
  assert.ok(!labels.includes('fra-12-giorni') && !labels.includes('oltre-orizzonte') && !labels.includes('finita'));
  // I conteggi dei fatti chiave restano sul totale attivo, non sulle righe mostrate.
  assert.deepEqual(block.render('it').keyFacts.map((f) => f.value), ['10', '1']);
});

test('qualita\' del sidecar: scala dichiarata, nessuna saturazione a 1', () => {
  assert.equal(sidecarQuality(null), null);
  assert.equal(sidecarQuality({ _score_breakdown: null }), null);
  assert.equal(sidecarQuality({ _score_breakdown: { stage: 'x' } }), null);
  assert.equal(sidecarQuality({ _score_breakdown: { score: 0 } }), 0);
  assert.equal(sidecarQuality({ _score_breakdown: { score: -3 } }), 0);
  assert.equal(sidecarQuality({ _score_breakdown: { finalScore: 1 } }), 0.5);
  // Il punteggio del ranker a cascata non ha tetto: due valori sopra 1 devono restare distinti e ordinati.
  const low = sidecarQuality({ _score_breakdown: { score: 3 } });
  const high = sidecarQuality({ _score_breakdown: { score: 9 } });
  assert.ok(low < high && high < 1, `${low} < ${high} < 1`);
});

test('un fetch fallito non toglie un blocco ancora valido: si conserva quello pubblicato, entro la sua eta\' massima', () => {
  const first = buildOne('canton-ti', 'carburanti');
  assert.deepEqual(first.blocks, [{ id: 'prezzi-carburanti', status: 'fresh' }, first.blocks[1]]);
  const withoutFuel = { ...fixtureDatasets(), fuel: null };

  // Il giorno dopo la cache manca: il blocco resta, il file non cambia.
  const next = buildOne('canton-ti', 'carburanti', { datasets: withoutFuel, previous: first.file, nowMs: NOW + DAY_MS });
  assert.equal(next.blocks[0].status, 'carried');
  assert.equal(next.changed, false);
  assert.deepEqual(next.file, first.file);

  // Oltre l'eta' massima il blocco esce, e con lui i suoi fatti chiave.
  const late = buildOne('canton-ti', 'carburanti', { datasets: withoutFuel, previous: first.file, nowMs: NOW + BLOCK_THRESHOLDS.fuel.maxAgeMs + DAY_MS });
  assert.equal(late.blocks[0].status, 'omitted');
  assert.equal(late.changed, true);
  assert.deepEqual(late.file.locales.it.dataBlocks, []);
  assert.deepEqual(late.file.locales.it.keyFacts, []);

  // Un dataset presente ma VECCHIO non si conserva: e' il produttore fermo, non un fetch perso.
  const stale = fixtureDatasets();
  stale.fuel.generatedAt = new Date(NOW - BLOCK_THRESHOLDS.fuel.maxAgeMs - HOUR_MS).toISOString();
  assert.equal(buildOne('canton-ti', 'carburanti', { datasets: stale, previous: first.file }).blocks[0].status, 'omitted');
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Stabilita'
// ─────────────────────────────────────────────────────────────────────────────

test('seconda esecuzione = nessun diff; updatedAt cambia solo se cambia il contenuto', async () => {
  const root = writeCorpus(tmpRoot());
  const snapshot = () => Object.fromEntries(PILOTS.flatMap((s) => hubFilePaths(s)).map((rel) => [rel, fs.readFileSync(path.join(root, rel), 'utf8')]));

  const first = await runAll(root);
  assert.ok(first.hubs.every((h) => h.changed && h.written));
  const before = snapshot();
  assert.ok(Object.values(before).every((raw) => raw.endsWith('\n')));

  // Stessi dati, stesso istante.
  const second = await runAll(root);
  assert.ok(second.hubs.every((h) => !h.changed && !h.written), 'la seconda esecuzione non deve riscrivere nulla');
  assert.deepEqual(snapshot(), before);

  // Stessi dati, tre ore dopo, con i dataset riscaricati (timestamp nuovi, valori uguali).
  const later = fixtureDatasets();
  for (const key of ['fuel', 'events', 'roadEvents', 'notices', 'services']) later[key].generatedAt = new Date(NOW + 2 * HOUR_MS).toISOString();
  const third = await runAll(root, { datasets: later, nowMs: NOW + 3 * HOUR_MS });
  assert.ok(third.hubs.every((h) => !h.changed), `hub cambiati senza che cambi il contenuto: ${third.hubs.filter((h) => h.changed).map((h) => h.path).join(', ')}`);
  assert.deepEqual(snapshot(), before);
  assert.ok(third.hubs.every((h) => h.updatedAt === NOW_ISO));

  // Cambia UN prezzo: cambia solo l'hub carburanti del Ticino, e il suo updatedAt.
  const moved = fixtureDatasets();
  moved.fuel.records.find((r) => r.canton === 'TI' && r.side === 'CH' && r.fuel === 'sp95').avg += 0.01;
  const fourth = await runAll(root, { datasets: moved, nowMs: NOW + 6 * HOUR_MS });
  assert.deepEqual(fourth.hubs.filter((h) => h.changed).map((h) => h.path), ['content/cantons/canton-ti/hubs/carburanti.json']);
  const hub = readHub(root, 'canton-ti', 'carburanti');
  assert.equal(hub.updatedAt, new Date(NOW + 6 * HOUR_MS).toISOString());
  assert.ok(HUB_LOCALES.every((l) => hub.locales[l].updatedAt === hub.updatedAt));
  assert.equal(hub.id, 'canton-ti:carburanti');
  assert.equal(hub.contentHash, hubContentHash(hub));

  // Nessun file temporaneo lasciato accanto ai dati.
  for (const section of PILOTS) {
    assert.ok(fs.readdirSync(path.join(root, `content/cantons/${section}/hubs`)).every((f) => f.endsWith('.json')));
  }
});

test('--dry-run non scrive niente', async () => {
  const root = writeCorpus(tmpRoot());
  const result = await runAll(root, { dryRun: true });
  assert.deepEqual(result.errors, []);
  assert.ok(result.hubs.every((h) => h.changed && !h.written));
  assert.ok(!fs.existsSync(path.join(root, 'content/cantons/canton-ti/hubs')));
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. News promosse
// ─────────────────────────────────────────────────────────────────────────────

async function curatedFor(section, articles = CORPUS) {
  const root = writeCorpus(tmpRoot(), articles);
  const pool = loadCantonPool(root, section);
  const engine = await loadTopicEngine();
  return { pool, ...selectCuratedArticles({ pool, section, config: CONFIG, engine, nowMs: NOW }) };
}
const idsOf = (list) => list.map((a) => a.id);

test('il bacino e\' la sezione del cantone piu\' frontaliere/svizzera etichettati; un articolo sta in un solo hub', async () => {
  const { pool, byTopic } = await curatedFor('canton-ti');
  assert.ok(idsOf(pool).includes('ti-benzina-prezzi'), 'sezione propria');
  assert.ok(idsOf(pool).includes('imposta-fonte-ticino'), 'frontaliere con canton TI');
  assert.ok(idsOf(pool).includes('farmacie-turno-ticino'), 'svizzera con canton TI');
  assert.ok(idsOf(pool).includes('trasporti-ti-gr'), 'multi-label');
  assert.ok(!idsOf(pool).includes('imposte-zurigo'), 'un altro cantone resta fuori');
  assert.ok(!idsOf(pool).includes('bollettino-frontaliere-2026-10-04'), 'le edizioni datate del bollettino non sono news da promuovere');

  assert.deepEqual(idsOf(byTopic.carburanti), ['ti-benzina-prezzi']);
  assert.deepEqual(idsOf(byTopic.fisco), ['imposta-fonte-ticino'], 'titolo doppio deduplicato, articoli datati nel futuro esclusi (anche di poche ore)');
  assert.ok(9 * HOUR_MS > CLOCK_SKEW_MS, 'il caso «fra nove ore» deve stare oltre la tolleranza d\'orologio');
  assert.deepEqual(idsOf(byTopic.pensioni), ['avs-rendite-ticino']);
  assert.deepEqual(idsOf(byTopic.mobilita), ['dogana-chiasso-traffico', 'trasporti-ti-gr'], 'a parita\' di tema, prima il piu\' del cantone e il piu\' recente');
  assert.deepEqual(idsOf(byTopic.eventi), ['ti-festival-locarno']);
  assert.deepEqual(idsOf(byTopic.servizi), ['farmacie-turno-ticino'], 'la cronaca con «ospedale» nel titolo e\' esclusa');

  const everywhere = Object.values(byTopic).flatMap(idsOf);
  assert.equal(new Set(everywhere).size, everywhere.length, 'nessun articolo in due hub dello stesso cantone');
  assert.ok(!everywhere.includes('vivere-a-comune'), 'una guida che sfiora il tema solo nell\'estratto non e\' una news del tema');

  const gr = await curatedFor('canton-gr');
  assert.deepEqual(idsOf(gr.byTopic.fisco), ['imposte-grigioni']);
  assert.deepEqual(idsOf(gr.byTopic.mobilita), ['trasporti-ti-gr']);
  assert.deepEqual(idsOf(gr.byTopic.eventi), ['carnevale-roveredo']);
  const be = await curatedFor('canton-be');
  assert.deepEqual(idsOf(be.byTopic.fisco), ['imposte-berna']);
  assert.deepEqual(idsOf(be.byTopic.pensioni), ['avs-berna']);
});

test('link delle news: URL della sezione di ORIGINE, nella locale della pagina', async () => {
  const root = writeCorpus(tmpRoot());
  await runAll(root);
  const urls = (topic, locale) => readHub(root, 'canton-ti', topic).locales[locale].curatedArticles.map((a) => a.url);
  assert.deepEqual(urls('carburanti', 'it'), ['/articoli-ticino/ti-benzina-prezzi/']);
  assert.deepEqual(urls('carburanti', 'de'), ['/de/tessin-artikel/ti-benzina-prezzi-de/']);
  assert.deepEqual(urls('fisco', 'it'), ['/articoli-frontaliere/imposta-fonte-ticino/']);
  assert.deepEqual(urls('fisco', 'en'), ['/en/cross-border-articles/imposta-fonte-ticino-en/']);
  assert.deepEqual(urls('servizi', 'fr'), ['/fr/articles-suisse/farmacie-turno-ticino-fr/']);
  const entry = readHub(root, 'canton-ti', 'fisco').locales.de.curatedArticles[0];
  assert.equal(entry.title, 'Imposta alla fonte in Ticino: aliquote e dichiarazione delle imposte (DE)', 'titolo nella locale della pagina');
  assert.ok(entry.excerpt.endsWith('(DE)'));
  assert.ok(Number.isFinite(Date.parse(entry.date)));
});

test('tetto, ordinamento e qualita\' gia\' calcolata', async () => {
  const many = Array.from({ length: CONFIG.maxCuratedArticles + 4 }, (_, i) =>
    article(`fisco-${String(i).padStart(2, '0')}`, 'frontaliere', `Imposte in Ticino, dichiarazione delle imposte numero ${i}`, 'Imposte, aliquote e dichiarazione dei redditi.', { cantons: ['TI'], days: 1 + i }));
  // Il bacino vero di un cantone e' fatto soprattutto d'altro: senza, «imposte»
  // starebbe in meta' dei documenti e non distinguerebbe niente (IDF quasi nullo).
  const filler = Array.from({ length: 80 }, (_, i) =>
    article(`cronaca-${i}`, 'svizzera', `Cronaca locale numero ${i}: vicenda${i} a Lugano`, `Resoconto${i} della giornata con dettaglio${i}.`, { cantons: ['TI'], days: 40 }));
  const { byTopic } = await curatedFor('canton-ti', [...CORPUS, ...filler, ...many]);
  assert.equal(byTopic.fisco.length, CONFIG.maxCuratedArticles, 'tetto di news per hub');
  const serial = idsOf(byTopic.fisco).filter((id) => id.startsWith('fisco-'));
  assert.ok(serial.length >= CONFIG.maxCuratedArticles - 1);
  assert.deepEqual(serial, [...serial].sort(), 'a parita\' di tema vince la freschezza');
  assert.equal(serial[0], 'fisco-00');

  // Due articoli gemelli per tema e data, entrambi con un punteggio del ranker
  // sopra 1: quello piu' alto sta davanti (un taglio a 1 li metterebbe alla pari).
  const pair = [
    article('fisco-basso', 'frontaliere', 'Imposte in Ticino: la dichiarazione delle imposte, parte prima', 'Imposte e aliquote.', { cantons: ['TI'], days: 3, quality: 2 }),
    article('fisco-alto', 'frontaliere', 'Imposte in Ticino: la dichiarazione delle imposte, parte seconda', 'Imposte e aliquote.', { cantons: ['TI'], days: 3, quality: 12 }),
  ];
  const ranked = idsOf((await curatedFor('canton-ti', [...CORPUS, ...filler, ...pair])).byTopic.fisco);
  assert.ok(ranked.includes('fisco-alto') && ranked.includes('fisco-basso'));
  assert.ok(ranked.indexOf('fisco-alto') < ranked.indexOf('fisco-basso'));
});

test('classificatore a parole chiave di eventi e servizi: dichiarato nel file dati, multilingue', () => {
  const emptyClusters = CANTON_HUB_TOPIC_KEYS.filter((t) => CANTON_HUB_TOPIC_CLUSTERS[t].length === 0);
  assert.deepEqual(Object.keys(CONFIG.keywordTopics).sort(), [...emptyClusters].sort(), 'un classificatore per ogni tema senza cluster nell\'engine, e solo per quelli');
  for (const [topic, cfg] of Object.entries(CONFIG.keywordTopics)) {
    assert.ok(Number.isInteger(cfg.minScore) && cfg.minScore >= 3);
    for (const locale of HUB_LOCALES) {
      assert.ok(cfg.terms[locale].length >= 8, `${topic}/${locale}: troppo pochi termini`);
      assert.ok(Array.isArray(cfg.exclude[locale]));
      assert.equal(new Set(cfg.terms[locale]).size, cfg.terms[locale].length, `${topic}/${locale}: termini duplicati`);
    }
  }
  const art = (title, excerpt) => ({ title, excerpt });
  const same = (s) => ({ it: s, en: s, de: s, fr: s });
  const eventi = CONFIG.keywordTopics.eventi;
  const servizi = CONFIG.keywordTopics.servizi;

  const concert = keywordTopicScore(art(
    { it: 'Concerti e mercatini di Natale a Lugano', en: 'Concerts and Christmas market in Lugano', de: 'Konzerte und Weihnachtsmarkt in Lugano', fr: 'Concerts et marché de Noël à Lugano' },
    same(''),
  ), eventi);
  assert.ok(concert.titleHit && !concert.excluded && concert.score >= eventi.minScore);
  // Ogni lingua contribuisce: il solo titolo tedesco non basta, ma conta.
  const onlyDe = keywordTopicScore(art({ it: 'x', en: 'x', de: 'Konzert in Chur', fr: 'x' }, same('')), eventi);
  assert.equal(onlyDe.score, 3);
  assert.ok(onlyDe.score < eventi.minScore);
  // Solo l'estratto: nessun titleHit, quindi fuori.
  assert.equal(keywordTopicScore(art(same('Consiglio di Stato'), same('concerto festival mostra')), eventi).titleHit, false);
  // Cronaca nera con una parola del tema nel titolo.
  assert.equal(keywordTopicScore(art(same('Incidente al festival: due arresti'), same('')), eventi).excluded, true);
  // Inizio di parola, nella lingua del testo: «eventuale» non e' «evento», «premiato» non e' «premi di cassa».
  const onlyIt = (s) => ({ it: s, en: 'x', de: 'x', fr: 'x' });
  assert.equal(keywordTopicScore(art(onlyIt('Una eventuale riforma'), same('')), eventi).score, 0);
  assert.equal(keywordTopicScore(art(onlyIt('Sportivo premiato a Bellinzona'), same('')), servizi).score, 0);
  const pharmacy = keywordTopicScore(art(
    { it: 'Farmacie di turno e cassa malati', en: 'On-duty pharmacies and health insurance', de: 'Notfall-Apotheke und Krankenkasse', fr: 'Pharmacies de garde et caisse maladie' },
    same(''),
  ), servizi);
  assert.ok(pharmacy.titleHit && pharmacy.score >= servizi.minScore);
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Link a strumenti e pagine di categoria
// ─────────────────────────────────────────────────────────────────────────────

test('link: validi per forma e locale, senza doppioni, per tutti i 24 gruppi', () => {
  const sections = cantonSectionIds();
  assert.equal(sections.length, 24);
  let total = 0;
  for (const section of sections) {
    const canton = ARTICLE_SECTION_CORE_ALL[section].canton;
    for (const topic of CANTON_HUB_TOPIC_KEYS) {
      for (const locale of HUB_LOCALES) {
        const links = buildHubLinks({ canton, topic, locale, catalogue: CATALOGUE, cantonUrlSlugs: CANTON_URL_SLUGS });
        assert.ok(links.length >= 2, `${section}/${topic}/${locale}: ${links.length} link`);
        assert.equal(new Set(links.map((l) => l.url)).size, links.length);
        for (const l of links) {
          total += 1;
          assert.match(l.url, /^\/[a-z0-9/-]+\/$/, `${section}/${topic}/${locale}: ${l.url}`);
          assert.ok(!l.url.includes('//'));
          if (locale === 'it') assert.doesNotMatch(l.url, /^\/(en|de|fr)\//, `link italiano con prefisso di lingua: ${l.url}`);
          else assert.ok(l.url.startsWith(`/${locale}/`), `${section}/${topic}/${locale}: link in un'altra lingua: ${l.url}`);
          assert.ok(l.label.trim().length >= 4);
          assert.doesNotMatch(l.label, /undefined|null|\$\{/);
        }
      }
    }
  }
  assert.ok(total > 2000, `solo ${total} link controllati`);
});

test('link: il catalogo e\' fatto di path verificati sulle sitemap, non di URL composti', () => {
  assert.match(CATALOGUE.verifiedAt, /^\d{4}-\d{2}-\d{2}$/);
  const groups = Object.keys(CANTON_URL_SLUGS.cantons);
  const ids = new Set();
  for (const entry of CATALOGUE.static) {
    assert.ok(!ids.has(entry.id), `id duplicato ${entry.id}`);
    ids.add(entry.id);
    assert.ok(entry.topics.length && entry.topics.every((t) => CANTON_HUB_TOPIC_KEYS.includes(t)));
    assert.ok(entry.cantons === null || entry.cantons.every((c) => groups.includes(c)), `${entry.id}: cantone sconosciuto`);
    for (const [locale, p] of Object.entries(entry.paths)) {
      assert.ok(HUB_LOCALES.includes(locale));
      assert.match(p, locale === 'it' ? /^\/(?!(en|de|fr)\/)[a-z0-9/-]+\/$/ : new RegExp(`^/${locale}/[a-z0-9/-]+/$`));
      assert.ok(entry.label[locale], `${entry.id}: etichetta ${locale} mancante`);
    }
  }
  for (const table of ['borderWaitRegions', 'plateAuctions', 'healthPremiums']) {
    for (const canton of Object.keys(CATALOGUE[table])) assert.ok(groups.includes(canton), `${table}: ${canton} non e' un gruppo URL`);
  }
  assert.deepEqual(Object.keys(CATALOGUE.plateAuctions).sort(), [...groups].sort());
  assert.deepEqual(Object.keys(CATALOGUE.healthPremiums).sort(), [...groups].sort());
  assert.deepEqual(CATALOGUE.plateAuctions.APPENZELLO.map((p) => p.member).sort(), ['AI', 'AR']);

  // I link derivati dai file slug: pagine lavoro ed eventi.
  assert.equal(jobsPagePath('TI', 'de', CANTON_URL_SLUGS), '/de/jobs-im-tessin/');
  assert.equal(jobsPagePath('AG', 'de', CANTON_URL_SLUGS), '/de/jobs-im-aargau/');
  assert.equal(jobsPagePath('VD', 'de', CANTON_URL_SLUGS), '/de/jobs-in-der-waadt/');
  assert.equal(jobsPagePath('BE', 'fr', CANTON_URL_SLUGS), '/fr/trouver-emploi-berne/');
  assert.equal(jobsPagePath('GR', 'it', CANTON_URL_SLUGS), '/cerca-lavoro-grigioni/');
  const urls = (canton, topic, locale, extra = {}) => buildHubLinks({ canton, topic, locale, catalogue: CATALOGUE, cantonUrlSlugs: CANTON_URL_SLUGS, ...extra }).map((l) => l.url);
  assert.deepEqual(urls('GR', 'eventi', 'it').slice(0, 2), ['/eventi/grigioni/', '/eventi/grigioni/questo-weekend/']);
  assert.deepEqual(urls('BE', 'eventi', 'fr').slice(0, 2), ['/fr/evenements/berne/', '/fr/evenements/berne/ce-week-end/']);
  assert.ok(urls('TI', 'mobilita', 'en').includes('/en/border-wait/ticino-como/'));
  assert.ok(!urls('BE', 'mobilita', 'it').some((u) => u.startsWith('/traffico-dogane/')), 'un cantone interno non linka le attese ai valichi');
  assert.ok(urls('TI', 'servizi', 'it').includes('/premi-cassa-malati/ticino/'));
  assert.ok(!urls('TI', 'servizi', 'en').some((u) => u.includes('premi-cassa-malati')), 'pagina solo italiana: nelle altre lingue non si linka');
  assert.ok(urls('BE', 'servizi', 'it').includes('/cerca-lavoro-berna/'));

  // Gli evergreen del cantone si linkano solo se l'articolo e' davvero nel registro.
  assert.ok(!urls('TI', 'eventi', 'it').some((u) => u.includes('eventi-weekend-ticino')));
  const digest = { id: 'eventi-weekend-ticino', section: 'frontaliere', slug: { it: 'eventi-weekend-ticino', en: 'weekend-events-ticino', de: 'wochenend-veranstaltungen-tessin', fr: 'evenements-week-end-tessin' } };
  assert.ok(urls('TI', 'eventi', 'de', { evergreenArticles: new Map([[digest.id, digest]]) }).includes('/de/grenzgaenger-artikel/wochenend-veranstaltungen-tessin/'));
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Intro evergreen e copy
// ─────────────────────────────────────────────────────────────────────────────

test('intro evergreen: deterministica, senza cifre, sopra soglia per ogni cantone, tema e locale', () => {
  for (const section of cantonSectionIds()) {
    const canton = ARTICLE_SECTION_CORE_ALL[section].canton;
    const profile = cantonSectionProfile(section);
    assert.ok(Array.isArray(CONFIG.neighbours[canton]), `Paesi confinanti non dichiarati per ${canton}`);
    for (const topic of CANTON_HUB_TOPIC_KEYS) {
      for (const locale of HUB_LOCALES) {
        const args = { canton, topic, locale, neighbours: CONFIG.neighbours[canton], languages: profile.languages };
        const intro = buildHubIntro(args);
        assert.equal(intro, buildHubIntro(args));
        assert.equal(intro.split(/\n\s*\n/).length, 2, 'due paragrafi');
        assert.doesNotMatch(intro, /\d/, `${section}/${topic}/${locale}: l'intro evergreen non porta cifre`);
        assert.doesNotMatch(intro, /undefined|null|\$\{| {2,}/);
        assert.ok(intro.toLowerCase().includes(cantonPlace(canton, locale).toLowerCase()));
        const words = intro.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
        assert.ok(words >= HUB_MIN_CONTENT_WORDS, `${section}/${topic}/${locale}: ${words} parole`);
      }
    }
  }
  assert.match(buildHubIntro({ canton: 'GR', topic: 'mobilita', locale: 'it', neighbours: CONFIG.neighbours.GR, languages: ['de', 'it', 'rm'] }), /confina con l’Italia, l’Austria e il Liechtenstein.*tedesco, italiano e romancio/s);
  assert.match(buildHubIntro({ canton: 'BE', topic: 'fisco', locale: 'de', neighbours: [], languages: ['de', 'fr'] }), /keine Landesgrenze.*Deutsch und Französisch/s);
});

test('i Paesi confinanti dichiarati coprono quelli del registro dei valichi', () => {
  const src = fs.readFileSync(path.join(ROOT, 'generator/data/borderCrossings.ts'), 'utf8');
  const group = (code) => Object.entries(CANTON_URL_SLUGS.cantonGroups).find(([, g]) => g.members.includes(code))?.[0] ?? code;
  const seen = new Map();
  for (const m of src.matchAll(/country:\s*'([A-Z]{2})',\s*foreignSide:[^\n]*\n\s*canton:\s*'([A-Z]{2})'/g)) {
    const canton = group(m[2]);
    seen.set(canton, new Set([...(seen.get(canton) ?? []), m[1]]));
  }
  assert.ok(seen.size >= 10, `registro dei valichi letto male: ${seen.size} cantoni`);
  for (const [canton, countries] of seen) {
    for (const country of countries) assert.ok(CONFIG.neighbours[canton].includes(country), `${canton}: il registro dei valichi ha ${country}, la tabella no`);
  }
  assert.deepEqual(Object.keys(CONFIG.neighbours).sort(), Object.keys(CANTON_URL_SLUGS.cantons).sort());
  assert.ok(parseCrossingNames(src).size > 100);
});

test('coerenza toponimi/cantone: il testo evergreen di un hub non nomina un altro cantone', () => {
  for (const section of PILOTS) {
    for (const topic of CANTON_HUB_TOPIC_KEYS) assert.doesNotThrow(() => buildOne(section, topic));
  }
  // Un toponimo di un altro cantone nel testo evergreen ferma l'hub, non esce in pagina.
  const tiIntro = buildHubIntro({ canton: 'TI', topic: 'eventi', locale: 'it', neighbours: ['IT'], languages: ['it'] });
  assert.deepEqual(foreignToponymsInCopy('TI', [tiIntro]), []);
  assert.deepEqual(foreignToponymsInCopy('TI', [tiIntro, 'Prezzi rilevati nei Grigioni']).map((f) => f.canton), ['grigioni']);
  assert.deepEqual(foreignToponymsInCopy('GR', ['Eventi a Lugano e in Ticino']).map((f) => f.canton), ['ticino', 'ticino']);
  // Per i cantoni di cui la tabella dei toponimi non sa nulla il controllo non inventa esiti.
  assert.deepEqual(foreignToponymsInCopy('BE', ['Eventi a Lugano']), []);
});

test('formattazione per locale, senza Intl', () => {
  assert.equal(fmtNumber(1234.5, 'it', 2), '1234,50');
  assert.equal(fmtNumber(12345.5, 'it', 2), '12.345,50');
  assert.equal(fmtNumber(12345.5, 'en', 2), '12,345.50');
  assert.equal(fmtNumber(12345.5, 'de', 2), '12’345.50');
  assert.equal(fmtNumber(12345.5, 'fr', 2), '12 345,50');
  assert.equal(fmtPct(8.92, 'it'), '8,92 %');
  assert.equal(fmtPct(10.1, 'en'), '10.1%');
  assert.equal(fmtDay('2026-10-05T09:00:00Z', 'it'), '5 ottobre 2026');
  assert.equal(fmtDay('2026-10-05', 'de'), '5. Oktober 2026');
  assert.equal(fmtDay('2026-10-01', 'fr'), '1er octobre 2026');
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Il confine col renderer dell'engine
// ─────────────────────────────────────────────────────────────────────────────

test('la soglia di parole e la firma dell\'hub sono quelle del renderer dell\'engine', () => {
  const engine = fs.readFileSync(path.join(ROOT, 'engine/cantonSectionPages.ts'), 'utf8');
  const min = /export const CANTON_HUB_MIN_CONTENT_WORDS = (\d+);/.exec(engine);
  assert.ok(min, 'CANTON_HUB_MIN_CONTENT_WORDS non trovato nel renderer');
  assert.equal(HUB_MIN_CONTENT_WORDS, Number(min[1]));
  const fieldsOf = (name) => {
    const body = new RegExp(`export interface ${name} \\{([\\s\\S]*?)\\n\\}`).exec(engine);
    assert.ok(body, `interfaccia ${name} non trovata`);
    return [...body[1].matchAll(/^\s*readonly (\w+)\??:/gm)].map((m) => m[1]);
  };
  const built = buildOne('canton-ti', 'servizi').file.locales.it;
  assert.deepEqual(Object.keys(built), fieldsOf('CantonTopicHubInput'));
  const allowed = { keyFacts: fieldsOf('CantonHubKeyFact'), dataBlocks: fieldsOf('CantonHubDataBlock'), links: fieldsOf('CantonHubLink'), curatedArticles: fieldsOf('CantonHubArticle') };
  for (const hubTopic of CANTON_HUB_TOPIC_KEYS) {
    const input = buildOne('canton-ti', hubTopic).file.locales.de;
    for (const [list, fields] of Object.entries(allowed)) {
      for (const row of input[list]) for (const key of Object.keys(row)) assert.ok(fields.includes(key), `${list}: campo "${key}" fuori dalla firma del renderer`);
    }
    for (const b of input.dataBlocks) for (const it of b.items) for (const key of Object.keys(it)) assert.ok(fieldsOf('CantonHubDataItem').includes(key));
  }
});

test('il producer rifiuta cio\' che il renderer rifiuterebbe o scarterebbe in silenzio', () => {
  const good = () => structuredClone(buildOne('canton-ti', 'servizi').file.locales.it);
  assert.doesNotThrow(() => validateHubInput(good()));
  const bad = (mutate, re) => {
    const input = good();
    mutate(input);
    assert.throws(() => validateHubInput(input), re);
  };
  bad((i) => { i.indexable = false; }, /campo non previsto/);
  bad((i) => { i.noindex = true; }, /campo non previsto/);
  bad((i) => { i.image = ''; }, /campo non previsto/);
  bad((i) => { i.limit = 0; }, /campo non previsto/);
  bad((i) => { delete i.dataBlocks[0].sourceName; i.dataBlocks[0].sourceUrl = 'https://example.org/'; }, /sourceUrl senza sourceName/);
  bad((i) => { i.keyFacts.push({ label: 'x', value: 'y', sourceUrl: 'https://example.org/' }); }, /sourceUrl senza sourceName/);
  bad((i) => { i.links[0].url = 'http://example.org/'; }, /URL non ammesso/);
  bad((i) => { i.links[0].url = '/senza-slash'; }, /senza slash finale/);
  bad((i) => { i.links.push({ ...i.links[0] }); }, /link duplicato/);
  bad((i) => { i.dataBlocks[0].id = 'Non Valido'; }, /id non valido/);
  bad((i) => { i.dataBlocks[0].items = []; }, /blocco senza righe/);
  bad((i) => { i.dataBlocks[0].items[0].date = 'ieri'; }, /data non valida/);
  bad((i) => { i.intro = 'Troppo corta.'; }, /contenuto insufficiente|intro evergreen di/);
  bad((i) => { i.intro = ''; }, /intro evergreen mancante/);
  bad((i) => { i.updatedAt = ''; }, /data non valida/);
  bad((i) => { i.canton = 'XX'; }, /codice cantone non valido/);
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. Superfici della sezione, CLI e workflow
// ─────────────────────────────────────────────────────────────────────────────

test('i file degli hub sono superfici della sezione: il rebase li copre', () => {
  for (const section of PILOTS) {
    const surfaces = sectionWriteSurfaces(section);
    assert.deepEqual(surfaces.hubDataFiles, hubFilePaths(section));
    assert.deepEqual(hubFilePaths(section), CANTON_HUB_TOPIC_KEYS.map((t) => `content/cantons/${section}/hubs/${t}.json`));
    // Accanto a registro e slug della stessa sezione.
    assert.equal(path.dirname(path.dirname(surfaces.hubDataFiles[0])), path.dirname(surfaces.registryFile));
    const { bookkeeping, registries, takeTheirs } = sectionRebaseSurfaces({ [section]: surfaces });
    for (const file of surfaces.hubDataFiles) {
      assert.ok(bookkeeping.includes(file), `${file} non dichiarato al rebase`);
      assert.ok(!registries.includes(file) && !takeTheirs.some((p) => file.startsWith(p)), 'un file rigenerato per intero non e\' un registro ne\' un file per-articolo');
    }
  }
  assert.equal(sectionWriteSurfaces('frontaliere').hubDataFiles, undefined);
});

test('CLI: argomenti validati, sezioni accese dal profilo o da Remote Config, default nessuna', () => {
  assert.deepEqual(parseArgs(['--section', 'canton-ti,CANTON-GR', '--topic=fisco', '--dry-run'], {}).sections, ['canton-ti', 'canton-gr']);
  assert.equal(parseArgs(['--section', 'canton-ti', '--dry-run'], {}).dryRun, true);
  assert.equal(parseArgs(['--section', 'canton-ti'], { DRY_RUN: '1' }).dryRun, true);
  assert.throws(() => parseArgs(['--section', 'svizzera'], {}), /non e' una sezione cantonale/);
  assert.throws(() => parseArgs(['--section', 'canton-xx'], {}), /non e' una sezione cantonale/);
  assert.throws(() => parseArgs(['--topic', 'meteo'], {}), /tema sconosciuto/);
  assert.throws(() => parseArgs(['--now', 'ieri'], {}), /non e' una data ISO/);
  assert.throws(() => parseArgs(['--sezione', 'x'], {}), /argomento sconosciuto/);

  const committed = cantonSectionIds().filter((id) => Object.prototype.hasOwnProperty.call(ARTICLE_SECTION_CORE_ALL, id) && cantonSectionProfile(id).enabled === true);
  const base = enabledCantonSections({});
  for (const id of committed) assert.ok(base.includes(id));
  const withRc = enabledCantonSections({ CANTON_ARTICLE_SECTIONS_ENABLED: 'TI, gr' });
  assert.ok(withRc.includes('canton-ti') && withRc.includes('canton-gr'));
  assert.equal(withRc.length, new Set([...base, 'canton-ti', 'canton-gr']).size);
});

test('workflow refresh-canton-hubs: cron giornaliero, zero sezioni = successo, refresh soft, rebase per superfici', () => {
  const wf = fs.readFileSync(path.join(ROOT, '.github/workflows/refresh-canton-hubs.yml'), 'utf8');
  const cron = /- cron: '(\d+) (\d+) \* \* \*'/.exec(wf);
  assert.ok(cron, 'cron giornaliero mancante');
  assert.ok(Number(cron[1]) % 15 !== 0, 'il minuto del cron va sfalsato dai quarti d\'ora');
  assert.match(wf, /workflow_dispatch:/);
  assert.match(wf, /--list-enabled/);
  assert.match(wf, /count=0/);
  // Ogni step dopo la risoluzione delle sezioni e' condizionato a count != 0.
  const steps = wf.split(/\n {6}- name: /).slice(1);
  const after = steps.slice(steps.findIndex((s) => s.startsWith('Resolve canton sections')) + 1);
  assert.ok(after.length >= 9);
  for (const step of after) assert.match(step, /if: .*steps\.sections\.outputs\.count != '0'/, `step senza guardia: ${step.split('\n')[0]}`);
  // I refresh di produzione: uno per dataset, nessuno puo' fermare il job.
  for (const name of ['fuel-cantons', 'events', 'border-wait-window', 'road-events', 'canton-notices', 'canton-services']) {
    const line = wf.split('\n').find((l) => l.includes(`npm run refresh:${name} `));
    assert.ok(line, `refresh:${name} non cablato`);
    assert.match(line, /\|\| echo "::warning::/, `refresh:${name} deve essere soft`);
    assert.ok(JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts[`refresh:${name}`]);
  }
  // Un `run:` su una riga e' uno scalare YAML semplice: un «: » dentro lo rende
  // un file non valido, e il workflow fallisce all'avvio senza eseguire un job
  // (successo al primo push di questo file, sugli `echo "::warning::…: …"`).
  for (const line of wf.split('\n')) {
    const inline = /^\s+run: (?![|>])(.*)$/.exec(line);
    if (inline) assert.doesNotMatch(inline[1], /: /, `run: su una riga con «: » — usa un blocco \`run: |\`: ${line.trim()}`);
  }
  assert.match(wf, /rebase-onto-remote\.sh "\$REMOTE" "\$TARGET" \\\n\s+--section-surfaces/);
  assert.match(wf, /persist-credentials: false/);
  // Push col PAT della regola di AGENTS.md, con quello degli altri produttori come riserva; mai il GITHUB_TOKEN.
  assert.match(wf, /PUSH_TOKEN="\$\{GITHUB_PAT_NANAKO:-\$\{GITHUB_PAT:-\}\}"/);
  assert.match(wf, /REMOTE="https:\/\/x-access-token:\$\{PUSH_TOKEN\}@github\.com\//);
  assert.doesNotMatch(wf, /x-access-token:\$\{GITHUB_TOKEN\}|secrets\.GITHUB_TOKEN/);
  assert.match(wf, /group: refresh-canton-hubs/);
  // Il producer gira DOPO i refresh e PRIMA del commit; il commit non gira in dry-run.
  const order = ['Fetch fuel prices per canton', 'Generate the canton hubs', 'Commit and push'].map((n) => wf.indexOf(`- name: ${n}`));
  assert.ok(order.every((i) => i > 0) && order[0] < order[1] && order[1] < order[2]);
  assert.match(steps.find((s) => s.startsWith('Commit and push')), /steps\.mode\.outputs\.dry != 'true'/);
});
