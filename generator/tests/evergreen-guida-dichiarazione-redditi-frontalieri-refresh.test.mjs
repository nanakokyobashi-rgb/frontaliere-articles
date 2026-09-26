// Fissa i fatti verificati il 2026-09-26 per `guida-dichiarazione-redditi-frontalieri`
// (issue corpus #1760). Ogni asserzione fallisce con i valori precedenti al refresh:
// franchigia 7.500 euro attribuita ai vecchi frontalieri, quadro CE indicato per il 730,
// cambio medio annuale, sanzioni "a partire dal 120%" per gli errori, credito
// dell'esempio calcolato senza franchigia. Fonti: istruzioni 730/2026 e Redditi PF
// 2026, circolare 25/E del 18 agosto 2023, comunicato admin.ch del 17 luglio 2023,
// art. 27 D.Lgs. 173/2024.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SLUG = 'guida-dichiarazione-redditi-frontalieri';
const LOCALES = ['it', 'en', 'de', 'fr'];
const REFRESHED_ON = '2026-09-26';

const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const body = (locale) => read('content', 'blog-body', locale, `${SLUG}.ts`);

const PF_DEADLINE = {
  it: /2 novembre 2026/,
  en: /November 2, 2026/,
  de: /2\. November 2026/,
  fr: /2 novembre 2026/,
};
const DEADLINE_730 = {
  it: /30 settembre 2026/,
  en: /September 30, 2026/,
  de: /30\. September 2026/,
  fr: /30 septembre 2026/,
};
const TRANSITION_WINDOW = {
  it: /31 dicembre 2018[^.]{0,20}17 luglio 2023/,
  en: /December 31, 2018 and July 17, 2023/,
  de: /31\. Dezember 2018 und dem 17\. Juli 2023/,
  fr: /31 décembre 2018 et le 17 juillet 2023/,
};
const PREVIOUSLY = {
  it: /prima\s*$/,
  en: /previously\s*$/,
  de: /vorher\s*$/,
  fr: /auparavant\s*$/,
};

test('registry: updatedAt allineato al refresh fattuale', () => {
  const registry = read('content', 'blog-articles-data.ts');
  assert.match(
    registry,
    new RegExp(`id: '${SLUG}'[\\s\\S]{0,120}updatedAt: '${REFRESHED_ON}'`),
  );
});

for (const locale of LOCALES) {
  test(`${locale}: scadenze 2026 del 730 e del Redditi PF`, () => {
    const src = body(locale);
    assert.match(src, DEADLINE_730[locale]);
    assert.match(src, PF_DEADLINE[locale], 'Redditi PF: 31 ottobre 2026 e sabato, slitta al 2 novembre');
  });

  test(`${locale}: vecchi frontalieri tassati solo in CH, franchigia 10.000 euro`, () => {
    const src = body(locale);
    assert.match(src, TRANSITION_WINDOW[locale]);
    assert.match(src, /10[.,   ]000/);
    // 7.500 compare soltanto come valore storico ("prima 7.500 euro").
    for (const m of src.matchAll(/7[.,   ]500/g)) {
      const before = src.slice(Math.max(0, m.index - 25), m.index);
      assert.match(before, PREVIOUSLY[locale], `${locale}: 7.500 presentato come soglia attuale`);
    }
  });

  test(`${locale}: quadri corretti per 730 e Redditi PF`, () => {
    const src = body(locale);
    assert.match(src, /G4/);
    assert.match(src, /RC5/);
    assert.doesNotMatch(src, /(?:Quadro|Feld|Cadre) CE\*\* - (?:Redditi|Einkünfte|Revenus|Income)/);
  });

  test(`${locale}: cambio del giorno di percezione, non media annuale`, () => {
    const src = body(locale);
    assert.doesNotMatch(src, /cambio medio del 2025|Durchschnittskurs von 2025|taux moyen de 2025|2025 average rate/);
    assert.doesNotMatch(src, /cambio medio ufficiale dell|durchschnittlichen Veränderung des Jahres|taux de change moyen officiel|official average exchange rate/);
  });

  test(`${locale}: sanzioni D.Lgs. 173/2024 ed esempio con franchigia`, () => {
    const src = body(locale);
    assert.match(src, /70\s?%/);
    assert.match(src, /250/);
    assert.doesNotMatch(src, /(?:partono dal|ab|à partir de|starting from) 120/);
    assert.match(src, /4[.,   ]533/);
    assert.match(src, /17[.,   ]007/);
    assert.match(src, /56[.,   ]667/);
    assert.doesNotMatch(src, /21[.,   ]800/);
  });

  test(`${locale}: fonti ufficiali citate`, () => {
    const src = body(locale);
    assert.match(src, /agenziaentrate\.gov\.it/);
    assert.match(src, /quadro-g-crediti-d-imposta/);
    assert.match(src, /admin\.ch/);
    assert.match(src, /normattiva\.it/);
    assert.doesNotMatch(src, /(?:fornita dall|provided by the cantonal tax office|ausgestellt vom kantonalen Steueramt|fournie par l'office cantonal)/i, `${locale}: emittente non verificato`);
    assert.doesNotMatch(src, /(?:almeno cinque anni|at least five years|mindestens fünf Jahre|au moins cinq ans)/i, `${locale}: conservazione quinquennale non documentata`);
    assert.match(src, /(?:periodo previsto dalle regole applicabili|period required by the applicable rules|nach den anwendbaren Regeln erforderlichen Zeitraum|période prévue par les règles applicables)/i, `${locale}: regola di conservazione qualificata`);
  });

  test(`${locale}: excerpt senza quadro CE attribuito al 730`, () => {
    const meta = read('content', `blog-meta-${locale}.ts`);
    const line = meta.split('\n').find((l) => l.includes(`${SLUG}.excerpt`));
    assert.ok(line, 'excerpt presente');
    assert.doesNotMatch(line, /(?:Quadro|Feld|Cadre) CE/);
  });
}
