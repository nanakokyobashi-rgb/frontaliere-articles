import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { editorialNotes, thinTranslatedFields, translationResidue } from './lib/evergreen-refresh-invariants.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SLUG = 'fatture-mediche-gonfiate-ticino';
const LOCALES = ['it', 'en', 'de', 'fr'];
const NATIONAL = {
  it: /In Svizzera.*almeno 4 miliardi/i,
  en: /In Switzerland.*at least .*4 billion/i,
  de: /In der Schweiz.*mindestens 4 Milliarden/i,
  fr: /En Suisse.*au moins 4 milliards/i,
};
const FIRST_STEP = {
  it: /Prima (?:si chiede|chiedi).*?(?:medico|struttura)/i,
  en: /(?:first ask.*(?:doctor|facility)|ask for a correction first|contact the doctor)/i,
  de: /(?:Zuerst.*(?:Arzt|Einrichtung)|Sprechen Sie.*(?:Arzt|Einrichtung))/i,
  fr: /(?:D[’']abord[^.]*(?:médecin|établissement)|demand(?:er|ez) d[’']abord[^.]*(?:médecin|établissement))/i,
};
const COMMISSION = {
  it: /Commissione deontologica/i,
  en: /(?:Ethical|Ethics|Deontological) Commission/i,
  de: /(?:Standesethik-Kommission|Deontologische Kommission)/i,
  fr: /Commission de déontologie/i,
};
const NO_CAUSALITY = [
  /ha portato|ha causato/i,
  /has led to|caused by the bills/i,
  /hat .*geführt|verursacht/i,
  /a entraîné|en est la cause/i,
];
const STALE = [
  /(?:In Ticino|nel Canton Ticino|in the Canton of Ticino|im Tessin|dans le canton du Tessin)[^.\n]{0,100}(?:4\s*miliardi|4\s*billion|4\s*Milliarden|4\s*milliards)/i,
  /(?:4\s*miliardi di franchi incassati|4\s*billion francs (?:collected|in inappropriate bills)|4\s*Milliarden Franken jährlich durch unangemessene Rechnungen|4\s*milliards de francs en factures inappropriées)/i,
  /(?:spiega un consulente|explains a consultant|erklärt ein(?:en)? Berater|explique un conseiller)/i,
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

test('fatture mediche: registry aggiornato al 7 ottobre 2026', () => {
  assert.match(registryChunk(), /updatedAt: '2026-10-07'/);
});

test('fatture mediche: cifra nazionale, aumento premi e contestazione sono corretti', () => {
  for (const locale of LOCALES) {
    const { body, faq, all } = article(locale);
    assert.match(body[0], NATIONAL[locale], locale + ': cifra riferita alla Svizzera');
    assert.match(all, /60\s*%/);
    assert.match(all, /7[.,]1\s*%/);
    assert.match(all, /4[.,]4\s*%/);
    assert.match(body[0], FIRST_STEP[locale], locale + ': primo interlocutore');
    assert.match(all, COMMISSION[locale]);
    assert.equal(faq.length, 5, locale + ': cinque FAQ');
    assert.match(faq[0].a, COMMISSION[locale]);
    assert.match(faq[1].a, FIRST_STEP[locale]);
    assert.match(faq[2].a, COMMISSION[locale]);
    assert.match(faq[3].a, /7[.,]1\s*%/);
    assert.match(faq[3].a, /4[.,]4\s*%/);
    assert.match(faq[4].a, /detailed|dettagliat|detaill|détaill/i);
    for (const pattern of NO_CAUSALITY) assert.doesNotMatch(faq[3].a, pattern, locale + ': causalità non dimostrata');
    for (const pattern of STALE) assert.doesNotMatch(all, pattern, locale + ': residuo non verificato ' + pattern);
  }
});

function fieldsByName(locale) {
  const source = fs.readFileSync(path.join(ROOT, 'content/blog-body', locale, SLUG + '.ts'), 'utf8');
  const out = {};
  for (const [key, value] of bodyFields(source)) out[key.split('.').pop()] = value;
  return out;
}

test('fatture mediche: nessuna nota redazionale, nessun residuo di traduzione automatica, traduzioni non svuotate', () => {
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

test('fatture mediche: descrizione ed estratti attribuiscono il 60% al sondaggio, non ai pazienti', () => {
  const generalised = /60\s*%\s*(?:dei pazienti|of patients|der Patienten|des patients)/i;
  assert.match(seoEntry(), /ACSI/);
  assert.doesNotMatch(seoEntry(), generalised);
  for (const locale of LOCALES) {
    assert.match(excerpt(locale), /ACSI/, locale + ': estratto senza la fonte del dato');
    assert.doesNotMatch(excerpt(locale), generalised, locale + ': estratto che generalizza il sondaggio');
  }
});
