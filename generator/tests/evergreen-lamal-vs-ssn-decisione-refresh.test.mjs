import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(process.env.CORPUS_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'));
const SLUG = 'lamal-vs-ssn-decisione';
const REFRESHED_ON = '2026-10-07';
const LOCALES = ['it', 'en', 'de', 'fr'];
const INSURERS = [
  'Agrisano', 'Aquilana', 'Assura', 'Concordia', 'CSS', 'Helsana', 'KPT',
  'Mutuel', 'ÖKK', 'Sanitas', 'Sodalis', 'Swica', 'Visana', 'Vivao Sympany',
];

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function loadBody(locale) {
  const file = path.join(ROOT, 'content', 'blog-body', locale, SLUG + '.ts');
  let source = fs.readFileSync(file, 'utf8')
    .replace(/const bodyLamalVsSsnDecisione:\s*Record<string, string>\s*=\s*/, 'const bodyLamalVsSsnDecisione = ')
    .replace(/export default bodyLamalVsSsnDecisione;\s*$/, '');
  const sandbox = {};
  vm.runInNewContext(source + '\nthis.out = bodyLamalVsSsnDecisione;', sandbox, { filename: file });
  return Object.fromEntries(
    ['body1', 'body2', 'body3', 'body4', 'body5', 'faq'].map((field) => [
      field,
      sandbox.out['blog.article.' + SLUG + '.' + field],
    ]),
  );
}

function count(text, pattern) {
  return (text.match(pattern) || []).length;
}

function structure(text) {
  const lines = text.split('\n');
  return {
    lines: lines.length,
    h2: count(text, /^## /gm),
    h3: count(text, /^### /gm),
    tableRows: lines.filter((line) => line.startsWith('|')).length,
    listItems: lines.filter((line) => line.startsWith('- ')).length,
  };
}

function hasPositiveSevenFive(text, locale) {
  const negation = {
    it: /non esiste|non c'è/i,
    en: /no\b|does not exist/i,
    de: /gibt es nicht|kein(?:e|en)?/i,
    fr: /n['’]existe pas|aucune cotisation|aucune contribution/i,
  }[locale];
  return text
    .split(/[.!?]\s+/)
    .filter((sentence) => /7[,.]5\s*%?/.test(sentence))
    .filter((sentence) => !negation.test(sentence))
    .join(' ');
}

function assertUnavailableModels(text, locale) {
  const negative = {
    it: /non sono disponibili/i,
    en: /are not available/i,
    de: /nicht verfügbar/i,
    fr: /ne sont pas disponibles/i,
  }[locale];
  const sentences = text.match(/[^.!?]*(?:Telmed|HMO)[^.!?]*[.!?]/gi) || [];
  assert.ok(sentences.length > 0, locale + ': Telmed/HMO devono comparire solo nel caveat');
  for (const sentence of sentences) {
    assert.match(sentence, negative, locale + ': modello presentato come disponibile');
  }
}

test('il registry porta updatedAt del refresh fattuale', () => {
  const registry = read('content/blog-articles-data.ts');
  assert.match(
    registry,
    new RegExp("id: '" + SLUG + "'[\\s\\S]{0,220}updatedAt: '" + REFRESHED_ON + "'"),
  );
});

for (const locale of LOCALES) {
  test(locale + ': fatti verificati, tabella premi e divieti', () => {
    const bodies = loadBody(locale);
    const text = Object.values(bodies).join('\n');
    const premiumRange = {
      it: /CHF 279,00[\s\S]*CHF 487,20/,
      en: /CHF 279\.00[\s\S]*CHF 487\.20/,
      de: /CHF 279,00[\s\S]*CHF 487,20/,
      fr: /CHF 279,00[\s\S]*CHF 487,20/,
    }[locale];

    assert.match(text, premiumRange, locale + ': premi adulti 2026');
    assert.match(text, /CHF 300/, locale + ': franchigia ordinaria');
    assert.match(text, /CHF 700/, locale + ': tetto della partecipazione');
    assert.match(text, /3\s*%[\s\S]{0,180}6\s*%/, locale + ': quota 3-6%');
    assert.match(text, /30[\s\S]{0,120}200/, locale + ': minimo e massimo della quota');
    assert.match(text, /CHF 92/, locale + ': partecipazione TEAM');
    for (const insurer of INSURERS) {
      assert.match(text, new RegExp(insurer), locale + ': ' + insurer);
    }

    assert.equal(hasPositiveSevenFive(text, locale), '', locale + ': 7,5% usato come contributo');
    assert.doesNotMatch(text, /0[,.]93/, locale + ': conversione di valuta');
    assert.doesNotMatch(text, /(?:^|\D)(?:35|65)\s?%/, locale + ': percentuale di frontalieri');
    assertUnavailableModels(text, locale);
    assert.doesNotMatch(text, /2[.,\s]500/, locale + ': franchigia opzionale');
    assert.doesNotMatch(text, /Laura Mantovani|Elena Colombo/, locale + ': citazione attribuita');
    assert.doesNotMatch(text, /break[- ]?even/i, locale + ': break-even');
    assert.doesNotMatch(text, /OECD|INPS/, locale + ': fonte non ammessa');
  });

  test(locale + ': FAQ JSON con cinque domande', () => {
    const faq = JSON.parse(loadBody(locale).faq);
    assert.equal(faq.length, 5, locale + ': numero di domande');
    for (const item of faq) {
      assert.equal(typeof item.q, 'string');
      assert.equal(typeof item.a, 'string');
      assert.ok(item.q.length > 10);
      assert.ok(item.a.length > 20);
    }
  });
}

test('le quattro lingue hanno struttura identica per ogni campo', () => {
  const all = Object.fromEntries(LOCALES.map((locale) => [locale, loadBody(locale)]));
  for (const field of ['body1', 'body2', 'body3', 'body4', 'body5']) {
    const expected = structure(all.it[field]);
    for (const locale of LOCALES.slice(1)) {
      assert.deepEqual(structure(all[locale][field]), expected, field + ': struttura ' + locale);
    }
  }
});
