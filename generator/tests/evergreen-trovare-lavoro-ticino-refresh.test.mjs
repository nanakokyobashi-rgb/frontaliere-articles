import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { editorialNotes, thinTranslatedFields, translationResidue } from './lib/evergreen-refresh-invariants.mjs';

// Refresh #2625: la guida riportava conteggi 2024/2025, offerte dinamiche,
// fasce salariali non tracciate e citazioni nominali senza prova. Le fonti
// ufficiali rilette l'11 ottobre 2026 sono:
// - USTAT, mercato del lavoro: https://www3.ti.ch/DFE/DR/USTAT/allegati/digitale/mercato_lavoro/psml/
// - SECO, settembre 2026: https://www.seco.admin.ch/it/newnsb/Cdju9-o8WGML
// - Cantone Ticino, trovare lavoro: https://www.ti.ch/sportello/tematiche/lavoro-e-impresa/trovare-lavoro
// - Job-Room: https://www.job-room.ch/
// - SEM, permesso G: https://www.sem.admin.ch/sem/it/home/themen/aufenthalt/eu_efta/ausweis_g_eu_efta.html
// - SEFRI, professioni regolamentate: https://www.sbfi.admin.ch/sbfi/it/home/formazione/riconoscimento-dei-diplomi-esteri/professioni-regolamentate.html

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SLUG = 'trovare-lavoro-ticino';
const LOCALES = ['it', 'en', 'de', 'fr'];
const REFRESHED_ON = '2026-10-11';
const SOURCES = [
  'https://www3.ti.ch/DFE/DR/USTAT/allegati/digitale/mercato_lavoro/psml/',
  'https://www.seco.admin.ch/it/newnsb/Cdju9-o8WGML',
  'https://www.ti.ch/sportello/tematiche/lavoro-e-impresa/trovare-lavoro',
  'https://www.job-room.ch/',
  'https://www.sem.admin.ch/sem/it/home/themen/aufenthalt/eu_efta/ausweis_g_eu_efta.html',
  'https://www.sbfi.admin.ch/sbfi/it/home/formazione/riconoscimento-dei-diplomi-esteri/professioni-regolamentate.html',
];

const CURRENT = {
  it: [/79\.121/, /2,9\s*%/, /4\.803/, /6,1\s*%/, /5\.393/, /4\.800/],
  en: [/79,121/, /2\.9\s*%/, /4,803/, /6\.1\s*%/, /5,393/, /4,800/],
  de: [/79\.121/, /2,9\s*%/, /4\.803/, /6,1\s*%/, /5\.393/, /4\.800/],
  fr: [/79\s121/, /2,9\s*%/, /4\s803/, /6,1\s*%/, /5\s393/, /4\s800/],
};

const STALE = [
  /79[.,\s’]109/, /28[.,]3\s*%/, /2[.,]5\s*%/, /5[.,\s]400/, /6[.,\s]788/, /4[.,\s]200/,
  /100[.,\s]000/, /4[.,\s]000/, /2[.,\s]000\s*[-–]\s*3[.,\s]000/, /12[.,\s]000/,
  /5[.,\s]000/, /60\s*%/, /Prof\.?\s+Roberto|Avv\.?\s+Marco|Professor\s+Roberto|Prof\. Roberto/i,
];

function bodyFields(source) {
  const fields = new Map();
  for (const match of source.matchAll(/'([^'\n]+)':\s*'((?:[^'\\]|\\.)*)'/g)) {
    const value = match[2]
      .replace(/\\n/g, '\n')
      .replace(/\\'/g, "'")
      .replace(/\\\\/g, '\\');
    fields.set(match[1], value);
  }
  return fields;
}

function bodySource(locale) {
  return fs.readFileSync(path.join(ROOT, 'content', 'blog-body', locale, `${SLUG}.ts`), 'utf8');
}

function fieldsFor(locale) {
  return bodyFields(bodySource(locale));
}

function articleText(locale) {
  const fields = fieldsFor(locale);
  const body = Array.from({ length: 10 }, (_, i) => fields.get(`blog.article.${SLUG}.body${i + 1}`)).join('\n');
  const faq = fields.get(`blog.article.${SLUG}.faq`);
  assert.ok(body && faq, `${locale}: body e FAQ presenti`);
  return { fields, body, faq, all: `${body}\n${faq}` };
}

function metaExcerpt(locale) {
  const source = fs.readFileSync(path.join(ROOT, `content/blog-meta-${locale}.ts`), 'utf8');
  const match = source.match(new RegExp(`'blog\\.article\\.${SLUG}\\.excerpt':\\s*'((?:[^'\\\\]|\\\\.)*)'`));
  assert.ok(match, `${locale}: excerpt presente`);
  return match[1].replace(/\\'/g, "'");
}

test('il registry porta updatedAt del refresh fattuale', () => {
  const registry = fs.readFileSync(path.join(ROOT, 'content', 'blog-articles-data.ts'), 'utf8');
  assert.match(registry, new RegExp(`id: '${SLUG}'[\\s\\S]{0,220}updatedAt: '${REFRESHED_ON}'`));
});

for (const locale of LOCALES) {
  test(`${locale}: dati correnti, definizioni e fonti ufficiali`, () => {
    const { all, faq } = articleText(locale);
    for (const pattern of CURRENT[locale]) assert.match(all, pattern, `${locale}: dato corrente assente ${pattern}`);
    for (const pattern of STALE) assert.doesNotMatch(all, pattern, `${locale}: residuo superato ${pattern}`);
    for (const url of SOURCES) assert.ok(all.includes(url), `${locale}: fonte mancante ${url}`);
    assert.match(all, /2026/);
    assert.match(all, /2024/);
    assert.doesNotMatch(all, /job\.ticino\.ch|jobs\.ch|jobup\.ch|Indeed|LinkedIn/);
    assert.doesNotMatch(all, /[—-]\s*(?:Prof\.?|Avv\.?|Professor|Lawyer|Professorin|Anwalt|Avocat)/i);
    assert.doesNotMatch(all, /(?:oltre|over|more than|über|plus de)\s+(?:4[.,\s]000|100[.,\s]000)/i);
    const questions = JSON.parse(faq);
    assert.equal(questions.length, 5, `${locale}: cinque FAQ`);
  });

  test(`${locale}: estratto allineato e traduzione non impoverita`, () => {
    const excerpt = metaExcerpt(locale);
    assert.match(excerpt, /USTAT|SECO|USTAT|SECO/i);
    assert.doesNotMatch(excerpt, /4[.,\s]000|5[.,\s]400|6[.,\s]788/);
    const italian = fieldsFor('it');
    const translated = fieldsFor(locale);
    assert.deepEqual(editorialNotes(Object.values(translated).join('\n'), locale), []);
    assert.deepEqual(translationResidue(Object.values(translated).join('\n'), locale), []);
    if (locale !== 'it') assert.deepEqual(thinTranslatedFields(Object.fromEntries(italian), Object.fromEntries(translated)), []);
  });
}

test('SEO aggiornata senza conteggi dinamici o vecchie statistiche', () => {
  const source = fs.readFileSync(path.join(ROOT, 'content', 'seo', 'seo-blog-3.ts'), 'utf8');
  const start = source.indexOf(`'blog-${SLUG}':`);
  assert.ok(start >= 0, 'voce SEO presente');
  const block = source.slice(start, source.indexOf("'blog-guida-completa-frontaliere':", start));
  assert.match(block, /dateModified": "2026-10-11T00:00:00\+00:00"/);
  assert.match(block, /79\.121/);
  assert.match(block, /5\.393/);
  assert.match(block, /4\.800/);
  assert.doesNotMatch(block, /job\.ticino\.ch|oltre 4\.000|CHF 5\.400|CHF 6\.788|2\.000-3\.000/);
});
