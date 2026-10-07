import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
  fr: /(?:demander d’abord.*(?:médecin|établissement)|Adressez-vous.*(?:médecin|établissement))/i,
};
const COMMISSION = {
  it: /Commissione deontologica/i,
  en: /Deontological Commission/i,
  de: /Deontologische Kommission/i,
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
