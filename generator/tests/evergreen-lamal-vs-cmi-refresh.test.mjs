import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { editorialNotes, thinTranslatedFields, translationResidue } from './lib/evergreen-refresh-invariants.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SLUG = 'lamal-vs-cmi';
const LOCALES = ['it', 'en', 'de', 'fr'];
const VOCABULARY = {
  it: { system: /Servizio sanitario italiano \(SSN\)/i, card: /TEAM/i },
  en: { system: /Italian National Health Service \(SSN\)/i, card: /European Health Insurance Card \(EHIC\)/i },
  de: { system: /italien(?:ischen|ischer) Gesundheitsdienst \(SSN\)/i, card: /Europäische Krankenversicherungskarte \(EKVK\)/i },
  fr: { system: /service de santé italien \(SSN\)/i, card: /carte européenne d’assurance maladie \(CEAM\)/i },
};
const STALE = [
  /350\s*(?:-|–|to|bis|à)\s*480/i,
  /350\s*(?:-|–|to|bis|à)\s*500/i,
  /200\s*(?:-|–|to|bis|à)\s*350/i,
  /2[.,]500\b/i,
  /30(?:\.|th)?\s*(?:November|novembre|novembre|novembre)/i,
  /(?:Libera|Free|Frei|Libre)\s*\((?:modello standard|standard model|Standardmodell|modèle standard)\)\s*(?:o|or|oder|ou)\s*(?:limitata|limited|eingeschränkt|limité)\s*\(HMO\/Telmed\)/i,
  /without waiting lists/i,
  /ohne Wartelisten/i,
  /sans listes d[’']attente/i,
  /senza liste d[’']attesa/i,
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

function registryChunk() {
  const source = fs.readFileSync(path.join(ROOT, 'content/blog-articles-data.ts'), 'utf8');
  const start = source.indexOf("id: '" + SLUG + "'");
  assert.notEqual(start, -1, 'voce registry presente');
  const end = source.indexOf('\n  },', start);
  return source.slice(start, end);
}

function article(locale) {
  const source = fs.readFileSync(path.join(ROOT, 'content/blog-body', locale, SLUG + '.ts'), 'utf8');
  const fields = bodyFields(source);
  const body = [1, 2, 3].map((n) => fields.get('blog.article.' + SLUG + '.body' + n)).join('\n');
  const faq = JSON.parse(fields.get('blog.article.' + SLUG + '.faq'));
  return { source, body, faq, all: body + '\n' + JSON.stringify(faq) };
}

test('LAMal vs CMI: registry aggiornato al 7 ottobre 2026', () => {
  assert.match(registryChunk(), /updatedAt: '2026-10-07'/);
});

test('LAMal vs CMI: fatti 2026 e terminologia sono presenti in tutte le lingue', () => {
  for (const locale of LOCALES) {
    const { body, faq, all } = article(locale);
    assert.match(all, /279/);
    assert.match(all, /487/);
    assert.match(all, /300/);
    assert.match(all, /10\s*%/);
    assert.match(all, /700/);
    assert.match(all, /92/);
    assert.match(all, /33/);
    assert.match(all, /3\s*[–-]\s*6|3\s*%\s*[–-]\s*6\s*%/);
    assert.match(all, /200/);
    assert.match(all, /14/);
    assert.match(all, /ASL/i);
    assert.match(all, /S2/i);
    assert.match(body, VOCABULARY[locale].system);
    assert.match(body, VOCABULARY[locale].card);
    assert.equal(faq.length, 5, locale + ': cinque FAQ');
    assert.match(faq[0].a, /279|2026/);
    assert.match(body, /definit|définit|endgült|final/i);
    assert.match(faq[1].a, /92|33|S2/);
    assert.match(faq[2].a, /tempi di attesa|waiting times|Wartezeiten|délais d[’']attente/i);
    assert.match(faq[3].a, /300|10|700/);
    assert.match(faq[4].a, /220|S2|matern|Mutter|maternité/i);
    for (const pattern of STALE) assert.doesNotMatch(all, pattern, locale + ': residuo non verificato ' + pattern);
  }
});

function fieldsByName(locale) {
  const source = fs.readFileSync(path.join(ROOT, 'content/blog-body', locale, SLUG + '.ts'), 'utf8');
  const out = {};
  for (const [key, value] of bodyFields(source)) out[key.split('.').pop()] = value;
  return out;
}

test('LAMal vs CMI: nessuna nota redazionale, nessun residuo di traduzione automatica, traduzioni non svuotate', () => {
  const italian = fieldsByName('it');
  for (const locale of LOCALES) {
    const fields = fieldsByName(locale);
    const text = Object.values(fields).join('\n');
    assert.deepEqual(editorialNotes(text, locale), [], locale + ': istruzioni di chi corregge finite nel testo');
    assert.deepEqual(translationResidue(text, locale), [], locale + ': residuo di traduzione automatica o sigla della lingua sbagliata');
    if (locale !== 'it') assert.deepEqual(thinTranslatedFields(italian, fields), [], locale + ': campo tradotto svuotato rispetto all\'italiano');
  }
});

test('LAMal vs CMI: regimi datati, risposta diretta sulla tessera e maternità completa', () => {
  const regime = { it: /17 luglio 2023/, en: /17 July 2023/, de: /17\. Juli 2023/, fr: /17 juillet 2023/ };
  const no = { it: /^No:/, en: /^No:/, de: /^Nein:/, fr: /^Non :/ };
  const week13 = { it: /tredicesima settimana/i, en: /thirteenth week/i, de: /dreizehnten Schwangerschaftswoche/i, fr: /treizième semaine/i };
  const unplanned = { it: /parto non programmato/i, en: /unplanned birth/i, de: /nicht geplante Geburt/i, fr: /accouchement non programmé/i };
  for (const locale of LOCALES) {
    const { body, faq } = article(locale);
    assert.match(body, regime[locale], locale + ': nuovi e vecchi frontalieri senza la data che li distingue');
    assert.match(faq[1].a, no[locale], locale + ': la domanda sulle cure programmate vuole una risposta diretta');
    assert.match(faq[4].a, /LAMal/, locale + ': risposta sulla maternità senza la metà LAMal');
    assert.match(faq[4].a, week13[locale], locale + ': esenzione dalla partecipazione ai costi in maternità');
    assert.match(faq[4].a, unplanned[locale], locale + ': tessera europea e parto non programmato');
    assert.match(faq[4].a, /S2/, locale + ': parto programmato e autorizzazione');
  }
});
