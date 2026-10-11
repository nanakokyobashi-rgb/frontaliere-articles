/**
 * Refresh source-backed della guida CHF-EUR per frontalieri (#2623).
 *
 * Il controllo osserva il corpus pubblicato, non una data isolata: richiede
 * nella stessa revisione la quotazione documentata, i costi correnti dei
 * servizi, il contesto fiscale e la rimozione delle cifre ereditate dal
 * confronto precedente in tutte le quattro lingue.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { editorialNotes, thinTranslatedFields, translationResidue } from './lib/evergreen-refresh-invariants.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SLUG = 'guida-cambio-franco-euro-frontaliere';
const REFRESHED_ON = '2026-10-11';
const LOCALES = ['it', 'en', 'de', 'fr'];

const FACTS = {
  it: {
    rate: /1 EUR = 0,9313 CHF/,
    limit: /CHF 1\.250/,
    agreement: /17 luglio 2023/,
    date: /9 ottobre 2026/,
    tax: /80% dell'aliquota ordinaria/,
  },
  en: {
    rate: /1 EUR = 0\.9313 CHF/,
    limit: /CHF 1,250/,
    agreement: /17 July 2023/,
    date: /9 October 2026/,
    tax: /80% of the ordinary rate/,
  },
  de: {
    rate: /1 EUR = 0,9313 CHF/,
    limit: /CHF 1\.250/,
    agreement: /17\. Juli 2023/,
    date: /9\. Oktober 2026/,
    tax: /80 % des ordentlichen Tarifs/,
  },
  fr: {
    rate: /1 EUR = 0,9313 CHF/,
    limit: /1 250 CHF/,
    agreement: /17 juillet 2023/,
    date: /9 octobre 2026/,
    tax: /80 % du taux ordinaire/,
  },
};

const STALE = [
  /0[.,]95\s*(?:-|–|—|a|to|bis|à)\s*0[.,]97/i,
  /0[.,]92\s*(?:vs\.?|\/|-|–|—|a|to|bis|à)\s*0[.,]94/i,
  /0[.,]8\s*%?\s*(?:-|–|—|a|to|bis|à)\s*1[.,]5\s*%?/i,
  /0[.,]3\s*%?\s*(?:-|–|—|a|to|bis|à)\s*0[.,]5\s*%?/i,
  /600\s*(?:-|–|—|a|to|bis|à)\s*900\s*(?:EUR|€)?/i,
  /1[.,]000\s*(?:-|–|—|a|to|bis|à)\s*1[.,]250/i,
  /2[.,\s\u202f]000\s*CHF/i,
  /1[.,]0540|0[.,]9387/i,
  /2025.{0,60}(?:media|average|Durchschnitt|moyenne)/i,
  /(?:gennaio|january|januar|janvier)[\s-]+(?:febbraio|february|februar|février)/i,
  /(?:giugno|june|juni|juin)[\s-]+(?:luglio|july|juli|juillet)/i,
  /16\s+(?:operatori|providers|Anbieter|opérateurs)/i,
  /900\s*(?:EUR|€).{0,40}(?:anno|year|Jahr|an|risparmi|saving|Ersparnis|économ)/i,
];

function read(...parts) {
  return fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
}

function bodyFields(source) {
  const fields = new Map();
  for (const match of source.matchAll(/'([^'\n]+)':\s*(?:'((?:[^'\\]|\\.)*)'|\x60((?:[^\x60\\]|\\.)*)\x60)/g)) {
    if (match[3] !== undefined) {
      fields.set(
        match[1],
        match[3]
          .replace(new RegExp('\\\\' + String.fromCharCode(96), 'g'), String.fromCharCode(96))
          .replace(/\\\$/g, '$')
          .replace(/\\\\/g, '\\'),
      );
    } else {
      fields.set(match[1], JSON.parse('"' + match[2].replace(/\\'/g, "'").replace(/"/g, '\\"') + '"'));
    }
  }
  return fields;
}

function fieldsByName(locale) {
  const fields = {};
  for (const [key, value] of bodyFields(read('content', 'blog-body', locale, SLUG + '.ts'))) {
    fields[key.split('.').pop()] = value;
  }
  return fields;
}

function article(locale) {
  const fields = fieldsByName(locale);
  const body = ['body1', 'body2', 'body3'].map((field) => fields[field]).join('\n');
  assert.ok(fields.faq, locale + ': FAQ presente');
  const faq = JSON.parse(fields.faq);
  return { fields, body, faq, all: body + '\n' + JSON.stringify(faq) };
}

function registryChunk() {
  const source = read('content', 'blog-articles-data.ts');
  const start = source.indexOf("id: '" + SLUG + "'");
  assert.notEqual(start, -1, 'voce registry presente');
  const end = source.indexOf('\n  },', start);
  return source.slice(start, end);
}

function seoChunk() {
  const source = read('content', 'seo', 'seo-blog-2.ts');
  const start = source.indexOf("'blog-" + SLUG + "':");
  assert.notEqual(start, -1, 'voce SEO presente');
  const end = source.indexOf("\n 'blog-", start + 1);
  return source.slice(start, end);
}

test('registry e SEO segnano il refresh dell’11 ottobre 2026', () => {
  assert.match(registryChunk(), /updatedAt: '2026-10-11'/);
  assert.match(seoChunk(), /"dateModified": "2026-10-11T/);
});

for (const locale of LOCALES) {
  test(locale + ': dati di cambio, provider, fiscalità e fonti sono presenti', () => {
    const { body, faq, all } = article(locale);
    const expected = FACTS[locale];

    assert.match(all, expected.rate, 'quotazione CHF-EUR aggiornata');
    assert.match(all, expected.limit, 'limite Revolut Standard svizzero');
    assert.match(all, expected.agreement, 'data dell’accordo Italia-Svizzera');
    assert.match(all, expected.date, 'data della fonte del tasso');
    assert.match(all, expected.tax, 'regola fiscale dei nuovi frontalieri');
    assert.match(all, /Wise/i);
    assert.match(all, /Revolut/i);
    assert.match(all, /SEPA/);
    assert.match(all, /1\s*%/);
    assert.match(all, /bancaditalia\.it/);
    assert.match(all, /wise\.com\/help\/articles\/2522717\/fees-for-sending-money/);
    assert.match(all, /help\.revolut\.com\/en-CH\//);
    assert.ok(body.length > 2500, locale + ': corpo aggiornato non ridotto a un avviso');
    assert.equal(faq.length, 5, locale + ': cinque FAQ');
    for (const item of faq) {
      assert.ok(item.q && item.a, locale + ': FAQ con domanda e risposta');
    }
    for (const pattern of STALE) {
      assert.doesNotMatch(all, pattern, locale + ': residuo obsoleto ' + pattern);
    }
  });
}

test('estratti e SEO non promettono più risparmi o confronti numerici non dimostrati', () => {
  const expectedExcerpt = {
    it: /Guida aggiornata al cambio CHF-EUR/,
    en: /Updated CHF-EUR guide/,
    de: /Aktualisierter CHF-EUR-Ratgeber/,
    fr: /Guide mis à jour du change CHF-EUR/,
  };
  for (const locale of LOCALES) {
    assert.match(read('content', 'blog-meta-' + locale + '.ts'), expectedExcerpt[locale], locale + ': estratto aggiornato');
  }
  assert.doesNotMatch(seoChunk(), /16 operatori|900 EUR\/anno/i);
});

test('le traduzioni mantengono contenuto e non espongono note redazionali o residui automatici', () => {
  const italian = fieldsByName('it');
  for (const locale of LOCALES) {
    const fields = fieldsByName(locale);
    const text = Object.values(fields).join('\n');
    assert.deepEqual(editorialNotes(text, locale), [], locale + ': note redazionali nel testo');
    assert.deepEqual(translationResidue(text, locale), [], locale + ': residui di traduzione');
    if (locale !== 'it') {
      assert.deepEqual(
        thinTranslatedFields(italian, fields),
        [],
        locale + ': campo tradotto svuotato rispetto all’italiano',
      );
    }
  }
});
