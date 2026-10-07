import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { editorialNotes, thinTranslatedFields, translationResidue } from './lib/evergreen-refresh-invariants.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SLUG = 'malattia-frontaliere-guida-assicurazione';
const LOCALES = ['it', 'en', 'de', 'fr'];
const CARDS = {
  it: /TEAM/i,
  en: /European Health Insurance Card \(EHIC\)/i,
  de: /Europäische Krankenversicherungskarte \(EKVK\)/i,
  fr: /carte européenne d’assurance maladie \(CEAM\)/i,
};
const THRESHOLDS = {
  it: /almeno otto ore/i,
  en: /at least 8 hours/i,
  de: /mindestens acht Stunden/i,
  fr: /au moins huit heures/i,
};
const CHOICE = {
  it: /scelta è definitiva|scelta definitiva/i,
  en: /choice is definitive|definitive.*choice/i,
  de: /Wahl ist endgültig|Wahl ist definitiv/i,
  fr: /choix est définitif|choix définitif/i,
};
const STALE = [
  /350\s*(?:-|–|to|bis|à)\s*480/i,
  /350\s*(?:-|–|to|bis|à)\s*500/i,
  /200\s*(?:-|–|to|bis|à)\s*350/i,
  /2[.,]500\b/i,
  /30(?:\.|th)?\s*(?:November|novembre|novembre|novembre)/i,
  /(?:chosen (?:insurance )?model|modello scelto|gewählten Modell|modèle d’assurance)[^.\n]{0,100}(?:HMO|Telmed|Hausarzt|médecin de famille|family doctor|medico di famiglia)/i,
  /(?:Family Doctor Model|modello (?:medico|medico di famiglia)|Hausarztmodell|Modèle médecin de famille)[^.\n]{0,120}(?:15\s*(?:-|–|to|bis|à)\s*25|ridott|reduces|Rabatt|réduction|saving)/i,
  /196\b/i,
  /15\s*(?:-|–|to|bis|à)\s*25\s*%/i,
  /without waiting lists/i,
  /ohne Wartelisten/i,
  /sans listes d[’']attente/i,
  /senza liste d[’']attesa/i,
  /7[.,]5\s*%/i,
  /2\s*(?:weeks|Wochen|semaines|settimane)/i,
  /specific procedure|spezielle Verfahren|procédure spécifique|procedura specifica/i,
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

test('guida malattia: registry aggiornato al 7 ottobre 2026', () => {
  assert.match(registryChunk(), /updatedAt: '2026-10-07'/);
});

test('guida malattia: scelta, premi, cura, infortuni e maternità sono coerenti', () => {
  for (const locale of LOCALES) {
    const { body, faq, all } = article(locale);
    assert.match(all, /279/);
    assert.match(all, /487/);
    assert.match(all, /300/);
    assert.match(all, /10\s*%/);
    assert.match(all, /700/);
    assert.match(all, /92/);
    assert.match(all, /33/);
    assert.match(all, /220/);
    assert.match(all, /14/);
    assert.match(all, /98/);
    assert.match(all, /ASL/i);
    assert.match(all, /S2/i);
    assert.match(all, CARDS[locale]);
    assert.match(body, THRESHOLDS[locale]);
    assert.match(body, CHOICE[locale]);
    assert.match(all, /0[.,]8\s*%?/);
    assert.match(all, /3\s*[–-]\s*6|3\s*%\s*(?:to|bis|à|à)\s*6\s*%/i);
    assert.equal(faq.length, 3, locale + ': tre FAQ');
    assert.match(body, /3|three|drei|trois/i);
    assert.match(faq[1].a, /definit|définit|endgült/i);
    assert.match(faq[1].a, /employer|canton|income|datore|cantone|Einkommen|employeur|canton/i);
    assert.match(faq[2].a, /92|33/);
    assert.match(faq[2].a, /S2|ASL/i);
    for (const pattern of STALE) assert.doesNotMatch(all, pattern, locale + ': residuo non verificato ' + pattern);
  }
});

function fieldsByName(locale) {
  const source = fs.readFileSync(path.join(ROOT, 'content/blog-body', locale, SLUG + '.ts'), 'utf8');
  const out = {};
  for (const [key, value] of bodyFields(source)) out[key.split('.').pop()] = value;
  return out;
}

test('guida malattia: nessuna nota redazionale, nessun residuo di traduzione automatica, traduzioni non svuotate', () => {
  const italian = fieldsByName('it');
  for (const locale of LOCALES) {
    const fields = fieldsByName(locale);
    const text = Object.values(fields).join('\n');
    assert.deepEqual(editorialNotes(text, locale), [], locale + ': istruzioni di chi corregge finite nel testo');
    assert.deepEqual(translationResidue(text, locale), [], locale + ': residuo di traduzione automatica o sigla della lingua sbagliata');
    if (locale !== 'it') assert.deepEqual(thinTranslatedFields(italian, fields), [], locale + ': campo tradotto svuotato rispetto all\'italiano');
  }
});

test('guida malattia: regimi datati e scala bernese nominata in ogni lingua', () => {
  const regime = { it: /17 luglio 2023/, en: /17 July 2023/, de: /17\. Juli 2023/, fr: /17 juillet 2023/ };
  const scale = { it: /scala bernese/i, en: /Bernese scale/i, de: /Berner Skala/i, fr: /échelle bernoise/i };
  for (const locale of LOCALES) {
    const { body } = article(locale);
    assert.match(body, regime[locale], locale + ': nuovo regime senza la data che lo definisce');
    assert.match(body, scale[locale], locale + ': elenco delle durate senza il nome della scala');
  }
});
