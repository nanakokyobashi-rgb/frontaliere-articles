/**
 * Refresh evergreen di `pilastro-3a-frontaliere` (sito, issue 7295).
 *
 * Fissa nelle quattro lingue i fatti verificati il 2026-10-06 e fallisce se
 * tornano i valori smentiti dalle fonti:
 *  - la deduzione del 3a non e' automatica: in Ticino va chiesta con il
 *    ricalcolo dell'imposta alla fonte entro il 31 marzo dell'anno successivo,
 *    richiede almeno il 90 % dei redditi imponibili in Svizzera e dal 2024 e'
 *    riservata ai «vecchi» frontalieri (Divisione delle contribuzioni del
 *    Cantone Ticino; SUPSI, nuovi aspetti fiscali dei frontalieri);
 *  - versamento massimo 2026 con cassa pensione: CHF 7'258 (UFAS);
 *  - previdenza complementare italiana: deducibilita' fino a 5.300 euro dal
 *    periodo d'imposta 2026, non piu' 5.164,57 (legge di bilancio 2026);
 *  - Credit Suisse non e' piu' un fornitore: la fondazione 3a e' confluita in
 *    UBS a dicembre 2024;
 *  - eta' di riferimento AVS: 65 anni; per le donne 64 anni e 6 mesi nel
 *    2026, 65 dal 2028 (riforma AVS 21), non «64/65».
 *
 * La risposta FAQ sui vantaggi fiscali era rimasta sbagliata in inglese,
 * tedesco e francese dopo la prima correzione: il test legge anche il JSON
 * delle FAQ, non solo il corpo.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SLUG = 'pilastro-3a-frontaliere';
const REFRESHED_ON = '2026-10-07';

const LOCALES = {
  it: {
    deadline: /31 marzo/, cohort: /«vecchi?»/, womenAge: /64 anni e 6 mesi/,
    automatic: /con un risparmio immediato|deducibili dall.{1,2}imposta alla fonte cantonale ma non/,
    oldCap: /fino a €5\.164\/anno/,
  },
  en: {
    deadline: /31 March/, cohort: /“old”/, womenAge: /64 years and 6 months/,
    automatic: /which saves you immediately|only deductible from Swiss withholding tax/,
    oldCap: /up to €5,164\/year/,
  },
  de: {
    deadline: /31\. März/, cohort: /«alte»/, womenAge: /64 Jahre und 6 Monate/,
    automatic: /mit sofortigen Einsparungen|nur von der Schweizer Quellensteuer abziehbar/,
    oldCap: /bis €5\.164\/Jahr/,
  },
  fr: {
    deadline: /31 mars/, cohort: /«anciens?»/, womenAge: /64 ans et 6 mois/,
    automatic: /avec des économies immédiates|ne sont déductibles que de l.{1,2}impôt à la source suisse/,
    oldCap: /jusqu.{1,2}à 5 164 €\/an/,
  },
};

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function faqOf(source) {
  const match = source.match(/\.faq':\s*'((?:[^'\\]|\\.)*)'/);
  assert.ok(match, 'campo faq presente');
  return JSON.parse(match[1].replace(/\\'/g, "'"));
}

test('il registry porta updatedAt del refresh fattuale', () => {
  const registry = read('content/blog-articles-data.ts');
  assert.match(registry, new RegExp(`id: '${SLUG}'[\\s\\S]{0,220}updatedAt: '${REFRESHED_ON}'`));
});

for (const [locale, expected] of Object.entries(LOCALES)) {
  test(`${locale}: deduzione su richiesta, massimale, fornitori ed eta' di riferimento`, () => {
    const source = read(`content/blog-body/${locale}/${SLUG}.ts`);
    assert.match(source, expected.deadline, 'termine del 31 marzo');
    assert.match(source, /90 ?%/, 'soglia del 90 % dei redditi');
    assert.match(source, expected.cohort, 'deduzione riservata ai «vecchi» frontalieri');
    assert.doesNotMatch(source, expected.automatic, 'deduzione presentata come automatica');
    assert.match(source, /7[.,' ]?258/, 'versamento massimo 2026');
    assert.match(source, /725-870/, 'esempio di risparmio per chi ha diritto alla deduzione');
    assert.doesNotMatch(source, expected.oldCap, 'limite italiano di 5.164 euro presentato come vigente');
    assert.doesNotMatch(source, /Credit Suisse/, 'Credit Suisse fra i fornitori');
    assert.match(source, expected.womenAge, 'eta di riferimento delle donne nel 2026');
    assert.doesNotMatch(source, /64\/65/, 'eta pensionabile «64/65»');
  });

  test(`${locale}: la FAQ non promette una deduzione automatica`, () => {
    const faq = faqOf(read(`content/blog-body/${locale}/${SLUG}.ts`));
    const fiscal = faq.at(-1).a;
    assert.match(fiscal, expected.deadline, 'termine del 31 marzo nella risposta');
    assert.match(fiscal, /90 ?%/, 'soglia del 90 % nella risposta');
    assert.match(fiscal, expected.cohort, '«vecchi» frontalieri nella risposta');
    assert.doesNotMatch(JSON.stringify(faq), expected.automatic, 'deduzione automatica nella FAQ');
  });
}
