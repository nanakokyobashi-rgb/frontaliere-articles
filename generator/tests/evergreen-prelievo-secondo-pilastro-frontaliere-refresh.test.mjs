import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Refresh evergreen di `prelievo-secondo-pilastro-frontaliere` (corpus #1791).
// L'articolo dava cifre senza fonte primaria («Frontalieri Ticino, 2023»):
// tetto di 50'000 CHF, tassazione oltre il 30%, 15'000 CHF di imposte in
// Svizzera e 10'000 in Italia su 50'000, preavviso di 3 mesi agli uffici
// cantonali, prelievo per emergenze e trasferimento a un conto pensionistico
// italiano. Fatti corretti, con fonte:
// - parte obbligatoria LPP non incassabile da chi è assicurato
//   obbligatoriamente in un Paese UE/AELS dal 1° giugno 2007 (art. 5 e 25f
//   LFLP), versata all'età di pensionamento o al più presto 5 anni prima;
//   accertamento del Fondo di garanzia LPP al più presto 90 giorni dopo la
//   partenza (faq.bsv.admin.ch, sfbvg.ch);
// - imposta alla fonte ticinese sul capitale: tabella VIC valida dal
//   1° gennaio 2025, 1'877.50 CHF su 50'000 CHF per una persona sola;
//   rimborso con il modulo Q-IS entro 3 anni se l'Italia ha tassato la
//   prestazione (art. 18 CDI, AFC);
// - Italia: 5% a titolo d'imposta con intermediario italiano, imposta
//   sostitutiva del 5% senza (art. 76, commi 1-bis e 1-ter, L. 413/1991;
//   comma 1-ter dall'art. 1, c. 77, L. 197/2022; risoluzione AdE 3/E/2020).

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SLUG = 'prelievo-secondo-pilastro-frontaliere';
const LOCALES = ['it', 'en', 'de', 'fr'];
const REFRESHED_ON = '2026-09-25';

// Una cifra con il separatore delle migliaia della locale: apostrofo svizzero
// (scritto `\'` nel sorgente TS) in it/de/fr, virgola in en.
const n = (thousands, rest) => new RegExp(`${thousands}(?:\\\\'|,)${rest}`);

const SOURCES = [
  /faq\.bsv\.admin\.ch\/it\/previdenza-professionale-e-terzo-pilastro\/caso-di-partenza-dalla-svizzera-si-puo-prelevare-il/,
  /sfbvg\.ch\//,
  /www4\.ti\.ch\/fileadmin\/DFE\/DC\/DOC-IF\/Aliquote_2025\/Tabelle_VIC_2025_PERSONE_SOLE\.pdf/,
  /estv\.admin\.ch\/dam\/it\/sd-web\/GaTvEbTDJpY5\/Form-Q-IS-2026-05-it\.pdf/,
  /fedlex\.admin\.ch\/eli\/cc\/1979\/461_461_461/,
  /Risoluzione_3_del_27_01_2020\.pdf/,
  /normattiva\.it\/uri-res\/N2Ls\?urn:nir:stato:legge:2022-12-29;197/,
];

const OUTDATED = Object.freeze({
  it: ['Fino a 50.000 CHF', 'fino al 30%', 'superare il 30%', 'superiori al 30%', 'circa 15.000 CHF', 'ulteriori 10.000 CHF', 'preavviso di almeno 3 mesi', 'con 3 mesi di anticipo', 'emergenze', 'conto pensionistico italiano', 'tassazione progressiva. Ad esempio', 'Frontalieri Ticino, 2023'],
  de: ['Bis zu 50.000 CHF', 'bis zu 30%', '30 % übersteigen', 'über 30 %', 'Ca. 15.000 CHF', 'Ca. 10.000 CHF', 'mindestens 3 Monaten vor', 'Mindestens 3 Monate vor', 'Hauskauf oder Notfällen', 'Liquidität im Notfall', 'Bedarf an Liquidität in Notfällen', 'italienisches Pensionskonto', 'progressive Besteuerung an. Zum Beispiel', 'Frontalieri Ticino, 2023'],
  fr: ['jusqu\\\'à 30%', 'pouvant dépasser 30%', 'dépasser 30 %', 'environ 15 000 CHF', '10 000 CHF supplémentaires', 'préavis d\\\'au moins 3 mois', '3 mois avant la date de sortie', 'liquidités en cas d\\\'urgence', 'compte de retraite italien', 'imposition progressive. Par exemple', 'Frontalieri Ticino, 2023'],
  en: ['exceeding 30%', 'exceed 30%', 'about 15,000 CHF', 'additional 10,000 CHF', 'at least 3 months\\\' notice', 'notice of at least 3 months', 'liquidity in case of emergencies', 'liquidity in the event of emergencies', 'Italian pension account', 'progressive taxation system. For instance', 'Frontalieri Ticino, 2023'],
});

function bodySource(locale) {
  return fs.readFileSync(path.join(ROOT, 'content', 'blog-body', locale, `${SLUG}.ts`), 'utf8');
}

test('il registry data il refresh fattuale di prelievo-secondo-pilastro-frontaliere', () => {
  const registry = fs.readFileSync(path.join(ROOT, 'content', 'blog-articles-data.ts'), 'utf8');
  assert.match(registry, new RegExp(`id: '${SLUG}'[\\s\\S]{0,220}updatedAt: '${REFRESHED_ON}'`));
});

for (const locale of LOCALES) {
  test(`${locale}: limite UE/AELS sulla parte obbligatoria e accertamento del Fondo di garanzia`, () => {
    const source = bodySource(locale);
    assert.match(source, /25f/, 'art. 25f LFLP');
    assert.match(source, /2007/, 'regime in vigore dal 1° giugno 2007');
    assert.match(source, /\b90\b/, 'accertamento al più presto 90 giorni dopo la partenza');
    assert.match(source, /\b5\b[^0-9%]{1,40}(?:anni|Jahre|ans|years)/, 'versamento al più presto 5 anni prima del pensionamento');
  });

  test(`${locale}: imposta alla fonte ticinese, rimborso e 5% italiano con fonte`, () => {
    const source = bodySource(locale);
    assert.match(source, n('1', '877\\.50'), 'tabella VIC 2025, persona sola, su 50000 CHF');
    assert.match(source, n('1', '827\\.50'), 'tabella VIC 2025, altri contribuenti, su 50000 CHF');
    assert.match(source, n('2', '500'), '5% di 50000 CHF');
    assert.match(source, n('4', '377\\.50'), 'carico totale senza rimborso svizzero');
    assert.match(source, /Q-IS/, 'modulo di rimborso AFC');
    assert.match(source, /1-ter/, 'art. 76, comma 1-ter, L. 413/1991');
    assert.match(source, /413\/1991/, 'legge 413/1991');
    for (const pattern of SOURCES) assert.match(source, pattern);
  });

  test(`${locale}: niente tetto di 50000 CHF, 30%, esempio 15000+10000, preavviso di 3 mesi o prelievo per emergenze`, () => {
    const source = bodySource(locale);
    for (const claim of OUTDATED[locale]) {
      assert.equal(source.includes(claim), false, `affermazione superata ancora presente: ${claim}`);
    }
    assert.doesNotMatch(source, /(?:15|10)[.,' ]000 CHF/, 'importi di imposta dell\'esempio superato');
  });
}
