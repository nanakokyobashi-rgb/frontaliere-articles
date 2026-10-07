import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { editorialNotes, thinTranslatedFields, translationResidue } from './lib/evergreen-refresh-invariants.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SLUG = 'assicurazione-malattia-famiglia';
const LOCALES = ['it', 'en', 'de', 'fr'];
const SYSTEM = {
  it: /Servizio sanitario italiano \(SSN\)/i,
  en: /Italian National Health Service/i,
  de: /italien(?:ischen|ischer) Gesundheitsdienst/i,
  fr: /service de santé italien/i,
};
const CARD = {
  it: /TEAM/i,
  en: /Europäische|European Health Insurance Card \(EHIC\)/i,
  de: /Europäische Krankenversicherungskarte \(EKVK\)/i,
  fr: /carte européenne d’assurance maladie \(CEAM\)/i,
};
const FAMILY = {
  it: /tutta la famiglia segue|stesso assicuratore|figli restano|entrambi.*figli/i,
  en: /whole family follows|same insurer|children remain|both parents.*children/i,
  de: /ganze Familie folgt|derselben Krankenkasse|Kinder.*Italien|beide Eltern/i,
  fr: /toute la famille suit|même caisse|enfants restent|deux parents/i,
};
const STALE = [
  /350\s*(?:-|–|to|bis|à)\s*480/i,
  /350\s*(?:-|–|to|bis|à)\s*500/i,
  /2[.,]500\b/i,
  /30(?:\.|th)?\s*(?:November|novembre|novembre|novembre)/i,
  /200\s*(?:-|–|to|bis|à)\s*350/i,
  /(?:Libera|Free|Frei|Libre)\s*\((?:modello standard|standard model|Standardmodell|modèle standard)\)\s*(?:o|or|oder|ou)\s*(?:limitata|limited|eingeschränkt|limité)\s*\(HMO\/Telmed\)/i,
  /1[.,]200\s*€?/i,
  /only for emergencies/i,
  /nur für Notfälle/i,
  /uniquement pour les urgences/i,
  /solo per emergenze/i,
];

function bodyFields(source) {
  const fields = new Map();
  for (const match of source.matchAll(/'([^'\n]+)':\s*(?:'((?:[^'\\]|\\.)*)'|\x60((?:[^\x60\\]|\\.)*)\x60)/g)) {
    if (match[3] !== undefined) {
      fields.set(match[1], match[3].replace(new RegExp('\\\\' + String.fromCharCode(96), 'g'), String.fromCharCode(96)).replace(/\\\$/g, '$').replace(/\\\\/g, '\\'));
    } else {
      fields.set(match[1], JSON.parse('"' + match[2].replace(/\\'/g, "'").replace(/"/g, '\\"') + '"'));
    }
  }
  return fields;
}

function article(locale) {
  const source = fs.readFileSync(path.join(ROOT, 'content/blog-body', locale, SLUG + '.ts'), 'utf8');
  const fields = bodyFields(source);
  const body = [1, 2, 3].map((n) => fields.get('blog.article.' + SLUG + '.body' + n)).join('\n');
  const faq = JSON.parse(fields.get('blog.article.' + SLUG + '.faq'));
  return { body, faq, all: body + '\n' + JSON.stringify(faq) };
}

function registryChunk() {
  const source = fs.readFileSync(path.join(ROOT, 'content/blog-articles-data.ts'), 'utf8');
  const start = source.indexOf("id: '" + SLUG + "'");
  assert.notEqual(start, -1, 'voce registry presente');
  return source.slice(start, source.indexOf('\n  },', start));
}

test('assicurazione famiglia: registry aggiornato al 7 ottobre 2026', () => {
  assert.match(registryChunk(), /updatedAt: '2026-10-07'/);
});

test('assicurazione famiglia: premi, CEAM/TEAM e regola familiare sono coerenti', () => {
  for (const locale of LOCALES) {
    const { body, faq, all } = article(locale);
    assert.match(all, /279/);
    assert.match(all, /487/);
    assert.match(all, /64/);
    assert.match(all, /203/);
    assert.match(all, /239/);
    assert.match(all, /475/);
    assert.match(all, /92/);
    assert.match(all, /33/);
    assert.match(all, /ASL/i);
    assert.match(all, /14/);
    assert.match(body, SYSTEM[locale]);
    assert.match(body, CARD[locale]);
    assert.match(all, FAMILY[locale]);
    assert.equal(faq.length, 5, locale + ': cinque FAQ');
    assert.match(faq[0].a, /279|487/);
    assert.match(faq[1].a, /92|33|ASL/i);
    assert.match(faq[2].a, /verlässlich|reliable|affidabil|fiable/i);
    assert.match(faq[3].a, /14|family|Familie|famille|famiglia/i);
    assert.match(faq[4].a, /same(?: Swiss health)? insurer|derselben (?:Schweizer )?Krankenkasse|stesso assicuratore|même caisse/i);
    assert.doesNotMatch(all, /(?:spiega un consulente|explains a consultant|erklärt ein(?:en)? Berater|explique un conseiller)/i, locale + ': citazione non verificata');
    for (const pattern of STALE) assert.doesNotMatch(all, pattern, locale + ': residuo non verificato ' + pattern);
  }
});

function fieldsByName(locale) {
  const source = fs.readFileSync(path.join(ROOT, 'content/blog-body', locale, SLUG + '.ts'), 'utf8');
  const out = {};
  for (const [key, value] of bodyFields(source)) out[key.split('.').pop()] = value;
  return out;
}

test('assicurazione famiglia: nessuna nota redazionale, nessun residuo di traduzione automatica, traduzioni non svuotate', () => {
  const italian = fieldsByName('it');
  for (const locale of LOCALES) {
    const fields = fieldsByName(locale);
    const text = Object.values(fields).join('\n');
    assert.deepEqual(editorialNotes(text, locale), [], locale + ': istruzioni di chi corregge finite nel testo');
    assert.deepEqual(translationResidue(text, locale), [], locale + ': residuo di traduzione automatica o sigla della lingua sbagliata');
    if (locale !== 'it') assert.deepEqual(thinTranslatedFields(italian, fields), [], locale + ': campo tradotto svuotato rispetto all\'italiano');
  }
});

function seoEntry() {
  const dir = path.join(ROOT, 'content/seo');
  for (const name of fs.readdirSync(dir).filter((n) => /^seo-blog.*\.ts$/.test(n))) {
    const source = fs.readFileSync(path.join(dir, name), 'utf8');
    const start = source.indexOf("'blog-" + SLUG + "':");
    if (start !== -1) return source.slice(start, source.indexOf("canonicalPath:", start));
  }
  assert.fail('voce SEO della guida non trovata in content/seo/seo-blog*.ts');
}

function excerpt(locale) {
  const source = fs.readFileSync(path.join(ROOT, 'content/blog-meta-' + locale + '.ts'), 'utf8');
  const match = source.match(new RegExp("'blog\\.article\\." + SLUG + "\\.excerpt':\\s*'((?:[^'\\\\]|\\\\.)*)'"));
  assert.ok(match, locale + ': estratto presente in blog-meta');
  return match[1];
}

test('assicurazione famiglia: descrizione ed estratti presentano le due opzioni vere, non la tessera europea come alternativa', () => {
  const asOption = /LAMal, (?:la )?(?:EHIC|CEAM|EKVK|TEAM)\b/i; // «LAMal, EHIC, integrative»: la tessera messa in fila con le coperture
  const named = { it: /Servizio sanitario italiano/i, en: /Italian National Health Service/i, de: /italienischer Gesundheitsdienst/i, fr: /service de santé italien/i };
  assert.match(seoEntry(), /Servizio sanitario italiano/);
  assert.doesNotMatch(seoEntry(), /\bEHIC\b/);
  for (const locale of LOCALES) {
    assert.match(excerpt(locale), named[locale], locale + ': estratto senza il Servizio sanitario italiano');
    assert.doesNotMatch(excerpt(locale), asOption, locale + ': tessera europea presentata come copertura alternativa');
  }
});
