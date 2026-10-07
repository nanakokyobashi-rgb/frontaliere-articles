/**
 * Refresh evergreen di `guida-pensione-frontaliere-avs-lpp` (sito, issue 7295).
 *
 * Fissa nelle quattro lingue i fatti verificati il 2026-10-06/07 e fallisce
 * se tornano i valori smentiti dalle fonti ufficiali:
 *  - eta' di riferimento AVS: 65 anni per gli uomini; per le donne 64 anni e
 *    6 mesi nel 2026, 65 dal 2028 — non «65 per uomini e donne dal 2025»
 *    (promemoria AVS/AI 3.01, stato al 1.1.2026);
 *  - rendita AVS 2026: da CHF 1'260 a CHF 2'520 al mese (promemoria 3.01);
 *  - aliquota minima di conversione LPP 6,8 %: la riforma che l'avrebbe
 *    portata al 6,0 % e' stata respinta il 22.9.2024, non e' «in discussione»;
 *  - secondo pilastro percepito da residenti in Italia: imposta sostitutiva
 *    del 5 % (art. 76 L. 413/1991), senza soglia a 60 anni;
 *  - totalizzazione: per la rendita AVS basta un anno intero di contribuzione
 *    (promemoria 3.01); la totalizzazione con UE, SEE e Svizzera richiede
 *    almeno un anno (52 settimane) di assicurazione e non trasferisce i
 *    contributi (INPS, scheda aggiornata al 9.6.2025); la domanda va all'ente
 *    dello Stato di domicilio se vi sono stati versati contributi (DFAE,
 *    1.2.2026). Le soglie «12 anni complessivi», «15 anni in ciascuno» e
 *    «6 mesi» non risultano da nessuna fonte.
 *
 * Il blocco iniziale della pagina francese era rimasto in italiano e
 * l'esempio tedesco dava un capitale incoerente con la rendita: due difetti
 * che un controllo solo sull'italiano non vede.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SLUG = 'guida-pensione-frontaliere-avs-lpp';
const REFRESHED_ON = '2026-10-07';

const LOCALES = {
  it: {
    womenAge: /64 anni e 6 mesi/,
    unisex65: /65 anni dal 2025 per uomini e donne|65 anni sia per uomini che per donne/,
    underDiscussion: /in discussione per una (?:riduzione|revisione)/,
    after60: /dopo i 60 anni/,
    thresholds: /12 anni complessivi|15 anni in ciascuno|entro 6 mesi dalla scadenza/,
    oneYear: /un anno intero di contribuzione/,
  },
  en: {
    womenAge: /64 years and 6 months/,
    unisex65: /for both men and women as of 2025/,
    underDiscussion: /under discussion for a reduction/,
    after60: /after the age of 60/,
    thresholds: /at least 12 years in total|at least 15 years in each|within 6 months of expiration/,
    oneYear: /one full year of contributions/,
  },
  de: {
    womenAge: /64 Jahre und 6 Monate/,
    unisex65: /Männer und Frauen nach (?:der )?AHV 21-Reform/,
    underDiscussion: /zur Diskussion|in Diskussion/,
    after60: /nach dem 60\. Lebensjahr/,
    thresholds: /mindestens 12 Jahre angesammelt|mindestens 15 Jahre in jedem Land|innerhalb von 6 Monaten nach Ablauf/,
    oneYear: /ein volles Beitragsjahr/,
  },
  fr: {
    womenAge: /64 ans et 6 mois/,
    unisex65: /en voie d.{1,2}harmonisation à 65 ans/,
    underDiscussion: /in discussione per una revisione|une révision à la baisse est envisagée/,
    after60: /après l.{1,2}âge de 60 ans/,
    thresholds: /au moins 12 ans au total|au moins 15 ans dans chacun|dans les 6 mois suivant l.{1,2}expiration/,
    oneYear: /une année entière de cotisation/,
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
  test(`${locale}: eta' di riferimento, rendita AVS e conversione LPP`, () => {
    const source = read(`content/blog-body/${locale}/${SLUG}.ts`);
    assert.match(source, expected.womenAge, 'eta di riferimento delle donne nel 2026');
    assert.doesNotMatch(source, expected.unisex65, '65 anni per uomini e donne gia dal 2025');
    assert.match(source, /1[.,' ]?260/, 'rendita AVS minima 2026');
    assert.match(source, /2[.,' ]?520/, 'rendita AVS massima 2026');
    assert.match(source, /6[.,]8 ?%/, 'aliquota minima di conversione LPP');
    assert.doesNotMatch(source, expected.underDiscussion, 'riduzione del tasso di conversione ancora in discussione');
    assert.match(source, /7[.,' ]?258/, 'versamento massimo 3a 2026');
  });

  test(`${locale}: FAQ su tassazione del secondo pilastro e totalizzazione`, () => {
    const faq = faqOf(read(`content/blog-body/${locale}/${SLUG}.ts`));
    assert.equal(faq.length, 3, 'tre domande');
    const [, taxation, totalisation] = faq.map((item) => item.a);
    assert.match(taxation, /5 ?%/, 'imposta sostitutiva del 5 %');
    assert.match(taxation, /413\/1991/, 'legge 413/1991');
    assert.doesNotMatch(taxation, expected.after60, 'soglia inesistente dei 60 anni');
    assert.doesNotMatch(totalisation, expected.thresholds, 'soglie di totalizzazione senza fonte');
    assert.match(totalisation, expected.oneYear, 'un anno intero per la rendita AVS');
    assert.match(totalisation, /\b20\b/, '20 anni di contributi per la pensione di vecchiaia italiana');
    assert.match(totalisation, /52/, 'periodo minimo di 52 settimane');
    assert.match(totalisation, /883\/2004/, 'regolamento UE 883/2004');
    assert.match(totalisation, /INPS/, 'domanda tramite INPS');
  });
}

test('fr: il blocco iniziale e in francese, senza residui in italiano', () => {
  const source = read(`content/blog-body/fr/${SLUG}.ts`);
  assert.doesNotMatch(
    source,
    /Sistema previdenziale|Cotizzazione|Renta AVS|Anni di cotizzazione|Tasso di conversione|Massimale 3a|Età di riferimento|Età pensionamento|Totalizzazione periodi|Imposta sul capitale/,
    'voci in italiano nella pagina francese',
  );
  assert.doesNotMatch(source, /in transizione a 45/, 'durata di contribuzione delle donne «in transizione a 45»');
  assert.match(source, /Âge de référence/, 'voce sull age de reference');
});

test('de: nell esempio il capitale LPP e coerente con la rendita mensile', () => {
  const source = read(`content/blog-body/de/${SLUG}.ts`);
  // 280.000 CHF × 6,8 % ÷ 12 = 1.587 CHF al mese; 233.000 darebbe 1.320.
  assert.match(source, /280\.000 CHF/, 'capitale dell esempio');
  assert.match(source, /1\.587 CHF/, 'rendita mensile dell esempio');
  assert.doesNotMatch(source, /233\.000/, 'capitale incoerente con la rendita');
});
