import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Refresh #1810 (sito #9629): il costo annuo dell'auto per un frontaliere
// poggiava su un prezzo della benzina «ipotizzato» (1,85 EUR/l) e su una
// tariffa TILO/Arcobaleno «circa 1.900 CHF». Solo le cifre verificabili su
// fonti ufficiali diventano fatti; le altre restano stime datate.
// - Benzina self-service, media nazionale 24-09-2026: 2,154 EUR/l
//   https://www.mimit.gov.it/it/prezzi-carburanti-media-nazionale
// - Cambio di riferimento BCE EUR/CHF 24-09-2026: 0,9409
//   https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/eurofxref-graph-chf.en.html
// - Vignetta 40 CHF, valida dal 1 dicembre dell'anno precedente al 31 gennaio
//   dell'anno successivo: https://www.bazg.admin.ch/it/faq-contrassegno-e-acquisto-e-vignetta
// - Annuale transfrontaliero Arcobaleno Como-Lugano 2a classe 1638 CHF, valido
//   dal 14.12.2025: https://arcobaleno.ch/it/home/abbonamenti/abbonamento-annuale-transfrontaliero
// - FAQ fiscale: la risposta prometteva detrazioni in Italia per carburante,
//   assicurazione e manutenzione. Per chi rientra nell'Accordo CH-IT del
//   23.12.2020 l'imposta alla fonte e' definitiva e la TOU non e' piu' ammessa:
//   https://www4.ti.ch/dfe/dc/dichiarazione/imposte-alla-fonte-1/richiesta-di-correzione-dellimposizione-alla-fonte
//   In Italia il reddito di lavoro dipendente e' costituito da tutte le somme
//   percepite (art. 51 c. 1 TUIR), senza deduzioni per l'auto casa-lavoro:
//   https://www.normattiva.it/uri-res/N2Ls?urn:nir:stato:decreto.del.presidente.della.repubblica:1986-12-22;917~art51
// Conti: 13.200 km x 6,5 l/100 km x 2,154 = 1.848 EUR -> 1.850 EUR -> 1.740 CHF;
// 950 EUR -> 890 CHF; visibili 1.740 + 40 + 1.800 = 3.580; nascosti
// 890 + 900 + 3.300 = 5.090; totale 8.670; risparmio 8.670 - 1.638 > 7.000.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SLUG = 'costo-pendolare-auto-ticino-2026';
const LOCALES = ['it', 'en', 'de', 'fr'];
const REFRESHED_ON = '2026-09-24';

// Separatore delle migliaia: punto (it, de), virgola (en), spazio (fr).
const n = (digits) => digits.replace(/^(\d+)(\d{3})$/, '$1[.,  ]$2');

function bodySource(locale) {
  return fs.readFileSync(path.join(ROOT, 'content', 'blog-body', locale, `${SLUG}.ts`), 'utf8');
}

function faqAnswers(locale) {
  const line = bodySource(locale).split('\n').find((l) => l.includes(`'blog.article.${SLUG}.faq'`));
  assert.ok(line, `faq ${locale} presente`);
  const literal = line.slice(line.indexOf(": '") + 3, line.lastIndexOf("',"));
  return JSON.parse(literal.replace(/\\'/g, "'")).map((item) => item.a).join('\n');
}

function metaExcerpt(locale) {
  const source = fs.readFileSync(path.join(ROOT, 'content', `blog-meta-${locale}.ts`), 'utf8');
  const line = source.split('\n').find((l) => l.includes(`'blog.article.${SLUG}.excerpt'`));
  assert.ok(line, `excerpt ${locale} presente`);
  return line;
}

test('la voce del registro porta la data del refresh fattuale', () => {
  const registry = fs.readFileSync(path.join(ROOT, 'content', 'blog-articles-data.ts'), 'utf8');
  assert.match(registry, new RegExp(`id: '${SLUG}'[\\s\\S]{0,220}updatedAt: '${REFRESHED_ON}'`));
});

test('og:title non promette un tetto inferiore al totale calcolato', () => {
  const seo = fs.readFileSync(path.join(ROOT, 'content', 'seo', 'seo-blog.ts'), 'utf8');
  const block = seo.slice(seo.indexOf(`'blog-${SLUG}'`), seo.indexOf(`'blog-${SLUG}'`) + 1200);
  assert.doesNotMatch(block, /fino a 8\.500 CHF/);
  assert.match(block, /ogTitle: 'L\\'auto ti costa quasi 8\.700 CHF/);
});

for (const locale of LOCALES) {
  test(`${locale}: cifre ufficiali datate e totale ricalcolato`, () => {
    const source = bodySource(locale);
    assert.match(source, /2[.,]154/, 'benzina self-service MIMIT');
    assert.match(source, /MIMIT/);
    assert.match(source, /0[.,]9409/, 'cambio BCE');
    assert.match(source, /24(?:\.)? (?:settembre|September|septembre) 2026/, 'data di rilevazione');
    assert.match(source, new RegExp(n('1740')), 'carburante in CHF');
    assert.match(source, new RegExp(n('1638')), 'annuale Arcobaleno Como-Lugano');
    assert.match(source, /14(?:\.)? (?:dicembre|December|Dezember|décembre) 2025/, 'validita tariffa Arcobaleno');
    assert.match(source, /31(?:\.)? (?:gennaio|January|Januar|janvier) 2027/, 'validita vignetta 2026');
    assert.match(source, /UDSC|FOCBS|BAZG|OFDF/, 'fonte della vignetta');
    assert.match(source, new RegExp(n('3580')), 'costi visibili');
    assert.match(source, new RegExp(n('5090')), 'costi nascosti');
    assert.match(source, new RegExp(n('8670')), 'totale annuo');
    assert.match(source, new RegExp(n('7000')), 'risparmio');
    assert.match(metaExcerpt(locale), new RegExp(n('8670')), 'excerpt allineato al totale');
  });

  test(`${locale}: niente prezzo ipotizzato ne cifre superate`, () => {
    const source = bodySource(locale);
    assert.doesNotMatch(source, /1[.,]85 ?€|€ ?1[.,]85\b/, 'benzina ipotizzata a 1,85');
    for (const stale of ['8510', '1550', '1590', '3390', '5120', '6000']) {
      assert.doesNotMatch(source, new RegExp(n(stale)), `valore superato ${stale}`);
    }
    assert.doesNotMatch(source, /\b920 CHF|CHF 920\b|\*\*920/, 'assicurazione al vecchio cambio');
    assert.doesNotMatch(source, /TCS/, 'fonte non verificata');
    assert.doesNotMatch(metaExcerpt(locale), new RegExp(n('7500')), 'excerpt con tetto superato');
  });

  test(`${locale}: la FAQ fiscale non promette detrazioni per l'auto`, () => {
    const answers = faqAnswers(locale);
    assert.match(answers, /23(?:\.)? (?:dicembre|December|Dezember|décembre) 2020/, 'Accordo CH-IT del 23.12.2020');
    assert.match(answers, /tassazione ordinaria ulteriore|nachträgliche ordentliche Veranlagung|taxation ordinaire ultérieure|subsequent ordinary assessment/);
    assert.match(answers, /art\. 51 TUIR/i);
    assert.doesNotMatch(answers, /beneficiare di detrazioni fiscali per le spese di trasporto|Steuerabzügen für Transportkosten|déductions fiscales pour les coûts de transport|tax deductions for transport costs/);
    assert.doesNotMatch(answers, /Frontiers can|Les frontières peuvent|Die Grenzen können/);
  });
}
