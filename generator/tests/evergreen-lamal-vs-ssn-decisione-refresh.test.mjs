import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { getKeyFactsHeading, getTldrHeading } from '../scripts/lib/ai-search-template.mjs';

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

/** Importi con due decimali, nel formato di qualunque lingua, resi come `1257.00`. */
function amounts(text) {
  const found = new Set();
  for (const match of text.matchAll(/\d{1,3}(?:[.,\u0020\u00a0\u202f’']\d{3})*[.,]\d{2}(?!\d)/g)) {
    const raw = match[0];
    found.add(raw.slice(0, -3).replace(/\D/g, '') + '.' + raw.slice(-2));
  }
  return found;
}

// Le cifre derivate si rifanno dalla tabella, non si scrivono a mano: la prima
// stesura dava come «massimo» della famiglia tipo il conto fatto sul premio
// adulti piu' alto (Concordia), mentre presso lo stesso assicuratore due
// adulti e due minorenni pagano di piu' con Assura.
for (const locale of LOCALES) {
  test(locale + ': minimo e massimo della famiglia tipo sono quelli che la tabella da', () => {
    const bodies = loadBody(locale);
    const rows = bodies.body1
      .split('\n')
      .filter((line) => line.startsWith('|'))
      .map((line) => line.split('|').map((cell) => cell.trim()).filter(Boolean))
      .filter((cells) => INSURERS.includes(cells[0]));
    assert.equal(rows.length, INSURERS.length, locale + ': una riga di premi per assicuratore');
    const amount = (cell) => Number([...amounts(cell)][0]);
    const totals = rows.map((cells) => 2 * amount(cells[1]) + 2 * amount(cells[3]));
    assert.ok(totals.every(Number.isFinite), locale + ': premi adulti e minorenni leggibili in ogni riga');
    const written = amounts(Object.values(bodies).join('\n'));
    for (const total of [Math.min(...totals), Math.max(...totals)]) {
      assert.ok(
        written.has(total.toFixed(2)),
        locale + ': il testo deve riportare ' + total.toFixed(2) + ' (2 adulti + 2 minorenni presso lo stesso assicuratore)',
      );
    }
  });
}

// I due riquadri iniziali si riconoscono dal titolo: il motore e i gate cercano
// quelli del template. La prima stesura li aveva chiamati «In brief», «Kurz
// erklärt» e «Faits essentiels».
for (const locale of LOCALES) {
  test(locale + ': i due riquadri iniziali hanno i titoli del template', () => {
    const headings = loadBody(locale).body1.split('\n').filter((line) => line.startsWith('## '));
    assert.deepEqual(headings.slice(0, 2), [getTldrHeading(locale), getKeyFactsHeading(locale)]);
  });
}

// La voce SEO porta un secondo blocco FAQ scritto a mano. La pagina pubblica
// le FAQ del body, ma quel blocco resta nel sorgente e nell'API: la prima
// stesura di questo refresh lo aveva lasciato con i premi «CHF 200-600», il
// contributo del 7,5%, la soglia di reddito e la scelta «che si cambia con un
// nuovo rapporto di lavoro».
test('la voce SEO della guida non porta i fatti smentiti nel suo blocco FAQ', () => {
  const seo = read('content/seo/seo-blog-3.ts');
  const start = seo.indexOf("'blog-" + SLUG + "': {");
  assert.ok(start >= 0, 'voce SEO della guida non trovata in content/seo/seo-blog-3.ts');
  const rest = seo.slice(start + 1);
  const next = rest.search(/\n\s*'blog-[a-z0-9-]+': \{/);
  const entry = next >= 0 ? rest.slice(0, next) : rest;
  assert.match(entry, /"@type": "FAQPage"/, 'blocco FAQ presente');
  assert.match(entry, /CHF 279,00[\s\S]*CHF 487,20/, 'premi adulti 2026');
  assert.doesNotMatch(entry, /CHF 200-600|200 a CHF 600/, 'premi senza riscontro');
  assert.doesNotMatch(entry, /7[.,]5\s?%/, 'contributo del 7,5%');
  assert.doesNotMatch(entry, /5\.000\/mese/, 'soglia di reddito');
  assert.doesNotMatch(entry, /2\.500/, 'franchigia opzionale');
  assert.doesNotMatch(entry, /nuovo rapporto di lavoro|cambio di cantone o variazioni/i, 'scelta presentata come modificabile');
  assert.match(entry, /definitiva/, 'la scelta e definitiva');
});

test('le quattro lingue hanno struttura identica per ogni campo', () => {
  const all = Object.fromEntries(LOCALES.map((locale) => [locale, loadBody(locale)]));
  for (const field of ['body1', 'body2', 'body3', 'body4', 'body5']) {
    const expected = structure(all.it[field]);
    for (const locale of LOCALES.slice(1)) {
      assert.deepEqual(structure(all[locale][field]), expected, field + ': struttura ' + locale);
    }
  }
});
