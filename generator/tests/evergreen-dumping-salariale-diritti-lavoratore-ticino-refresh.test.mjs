import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { editorialNotes, thinTranslatedFields, translationResidue } from './lib/evergreen-refresh-invariants.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SLUG = 'dumping-salariale-diritti-lavoratore-ticino';
const LOCALES = ['it', 'en', 'de', 'fr'];
const SOURCES = [
  'https://m3.ti.ch/CAN/RLeggi/public/index.php/raccolta-leggi/pdfatto/atto/11806',
  'https://dam-api.bfs.admin.ch/hub/api/dam/assets/36195849/master',
  'https://www.seco.admin.ch/it/esecuzione-delle-misure-collaterali',
  'https://www.seco.admin.ch/it/distacco-spese-e-sanzioni',
  'https://www4.ti.ch/tich/area-media/comunicati/dettaglio-comunicato/?NEWS_ID=257720',
  'https://www.fedlex.admin.ch/eli/cc/2010/262/it',
  'https://www.seco.admin.ch/it/faq-disdetta',
];
const CURRENT = {
  it: { median: /5\.708/, minimum: /20,00[\s\S]*20,50/, checks: /4\.164[\s\S]*17\.667[\s\S]*186[\s\S]*463/ },
  en: { median: /5,708/, minimum: /20\.00[\s\S]*20\.50/, checks: /4,164[\s\S]*17,667[\s\S]*186[\s\S]*463/ },
  de: { median: /5\.708/, minimum: /20,00[\s\S]*20,50/, checks: /4\.164[\s\S]*17\.667[\s\S]*186[\s\S]*463/ },
  fr: { median: /5\s?708/, minimum: /20,00[\s\S]*20,50/, checks: /4\s?164[\s\S]*17\s?667[\s\S]*186[\s\S]*463/ },
};
const STALE = [
  /5[.,\s]?487/,
  /19[.,]75/,
  /5[.,\s]?184/,
  /3[.,\s]?530/,
  /50[.,\s]?000/,
  /(?:median|mediana|Medianlohn|médian)[^.\n]{0,80}2025/i,
  /2025[^.\n]{0,80}(?:median|mediana|Medianlohn|médian)/i,
];

function bodyFields(source) {
  const fields = new Map();
  for (const match of source.matchAll(/'([^'\n]+)':\s*(?:'((?:[^'\\]|\\.)*)'|\x60((?:[^\x60\\]|\\.)*)\x60)/g)) {
    fields.set(match[1], match[3] !== undefined ? match[3] : match[2]);
  }
  return fields;
}

function article(locale) {
  const source = fs.readFileSync(path.join(ROOT, 'content/blog-body', locale, SLUG + '.ts'), 'utf8');
  const fields = bodyFields(source);
  const body = [1, 2, 3].map((n) => fields.get('blog.article.' + SLUG + '.body' + n));
  const faq = JSON.parse(fields.get('blog.article.' + SLUG + '.faq'));
  return { body, faq, all: body.join('\n') + '\n' + JSON.stringify(faq) };
}

function registryChunk() {
  const source = fs.readFileSync(path.join(ROOT, 'content/blog-articles-data.ts'), 'utf8');
  const start = source.indexOf("id: '" + SLUG + "'");
  assert.notEqual(start, -1, 'voce registry presente');
  return source.slice(start, source.indexOf('\n  },', start));
}

test('dumping salariale: registry aggiornato dopo il refresh dell’11 ottobre 2026', () => {
  assert.match(registryChunk(), /updatedAt: '2026-10-11'/);
  assert.match(registryChunk(), /articleType: 'evergreen'/);
});

test('dumping salariale: mediana, minimo, controlli e costi giudiziari sono source-backed', () => {
  for (const locale of LOCALES) {
    const { body, faq, all } = article(locale);
    assert.match(body[0], CURRENT[locale].median, locale + ': mediana RSS 2024');
    assert.match(body[0], CURRENT[locale].minimum, locale + ': minimi cantonali 2026');
    assert.match(all, CURRENT[locale].checks, locale + ': controlli ticinesi 2025');
    assert.match(all, /30[.,\s]?000/, locale + ': soglia procedurale');
    assert.match(all, /(?:court fees|spese giudiziarie|Gerichtskosten|frais judiciaires)/i, locale + ': distinzione costi');
    assert.match(all, /(?:SECO|seco)/i, locale + ': fonte SECO');
    assert.match(all, /(?:six months|sei mensilità|sechs Monatslöhnen|six mois)/i, locale + ': rimedio per licenziamento abusivo');
    assert.equal(faq.length, 5, locale + ': cinque FAQ');
    assert.match(faq[1].a, CURRENT[locale].minimum, locale + ': FAQ minimo');
    assert.match(faq[2].a, /30[.,\s]?000/, locale + ': FAQ sanzioni');
    assert.match(faq[3].a, /30[.,\s]?000/, locale + ': FAQ spese');
    for (const source of SOURCES) assert.ok(all.includes(source), locale + ': fonte mancante ' + source);
    for (const pattern of STALE) assert.doesNotMatch(all, pattern, locale + ': residuo non source-backed ' + pattern);
  }
});

function fieldsByName(locale) {
  const source = fs.readFileSync(path.join(ROOT, 'content/blog-body', locale, SLUG + '.ts'), 'utf8');
  const out = {};
  for (const [key, value] of bodyFields(source)) out[key.split('.').pop()] = value;
  return out;
}

test('dumping salariale: nessuna nota redazionale, nessun residuo di traduzione e campi non svuotati', () => {
  const italian = fieldsByName('it');
  for (const locale of LOCALES) {
    const fields = fieldsByName(locale);
    const text = Object.values(fields).join('\n');
    assert.deepEqual(editorialNotes(text, locale), [], locale + ': nota redazionale nel testo');
    assert.deepEqual(translationResidue(text, locale), [], locale + ': residuo di traduzione automatica');
    if (locale !== 'it') assert.deepEqual(thinTranslatedFields(italian, fields), [], locale + ': campo tradotto svuotato');
  }
});

function seoEntry() {
  const source = fs.readFileSync(path.join(ROOT, 'content/seo/seo-blog-2.ts'), 'utf8');
  const start = source.indexOf("'blog-" + SLUG + "':");
  assert.notEqual(start, -1, 'voce SEO presente');
  return source.slice(start, source.indexOf("canonicalPath:", start));
}

function excerpt(locale) {
  const source = fs.readFileSync(path.join(ROOT, 'content/blog-meta-' + locale + '.ts'), 'utf8');
  const match = source.match(new RegExp("'blog\\.article\\." + SLUG + "\\.excerpt':\\s*'((?:[^'\\\\]|\\\\.)*)'"));
  assert.ok(match, locale + ': estratto presente');
  return match[1];
}

test('dumping salariale: estratti e SEO descrivono il refresh e non i valori storici', () => {
  const seo = seoEntry();
  assert.match(seo, /2024/);
  assert.match(seo, /2026/);
  assert.match(seo, /source-backed/);
  for (const locale of LOCALES) {
    const text = excerpt(locale);
    assert.match(text, /2024/);
    assert.match(text, /2026/);
    assert.doesNotMatch(text, /5[.,\s]?487|19[.,]75|5[.,\s]?184|3[.,\s]?530/);
  }
  assert.doesNotMatch(seo, /5[.,\s]?487|19[.,]75|5[.,\s]?184|3[.,\s]?530|50[.,\s]?000/);
});
