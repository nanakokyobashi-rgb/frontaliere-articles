import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Refresh #1800 (sito #9629): l'articolo diceva ai frontalieri di dichiarare
// in Ticino i redditi svizzeri e italiani, con una «tassazione differenziata
// a seconda del tipo di contratto», chiedeva la CU italiana e attribuiva alla
// Divisione delle contribuzioni una citazione che il comunicato non contiene.
// Fonti:
// - comunicato DC del 26.2.2026 (termine 30.4.2026, eTax 2025, proroga
//   online): https://www4.ti.ch/tich/area-media/comunicati/dettaglio-comunicato?NEWS_ID=257983
// - Direttiva UIF valida dal 1.1.2025 (frontalieri dell'Accordo: niente TOU,
//   ricalcolo entro il 31 marzo, soglia 90%; vecchi frontalieri
//   31.12.2018-17.7.2023, fascia di 20 km):
//   https://m4.ti.ch/fileadmin/DFE/DC/DOC-IF/Direttive/Direttiva_UIF__vers._1.0_del_01.01.2025_.pdf
// - Accordo CH-IT del 23.12.2020: https://www.fedlex.admin.ch/eli/cc/2023/410/it

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SLUG = 'dichiarazione-redditi-ticino-2026';
const LOCALES = ['it', 'en', 'de', 'fr'];
const REFRESHED_ON = '2026-09-24';

function bodySource(locale) {
  return fs.readFileSync(path.join(ROOT, 'content', 'blog-body', locale, `${SLUG}.ts`), 'utf8');
}

test('la voce del registro porta la data del refresh fattuale', () => {
  const registry = fs.readFileSync(path.join(ROOT, 'content', 'blog-articles-data.ts'), 'utf8');
  assert.match(registry, new RegExp(`id: '${SLUG}'[\\s\\S]{0,220}updatedAt: '${REFRESHED_ON}'`));
});

const DEADLINE = {
  it: /30 aprile 2026/,
  en: /(?:30 April 2026|April 30, 2026)/,
  de: /30\. April 2026/,
  fr: /30 avril 2026/,
};
const OLD_FRONTIER = {
  it: /31 dicembre 2018[\s\S]{0,20}17 luglio 2023/,
  en: /31 December 2018[\s\S]{0,20}17 July 2023/,
  de: /31\. Dezember 2018[\s\S]{0,20}17\. Juli 2023/,
  fr: /31 décembre 2018[\s\S]{0,20}17 juillet 2023/,
};
const RECALC_DEADLINE = {
  it: /31 marzo/,
  en: /31 March/,
  de: /31\. März/,
  fr: /31 mars/,
};

for (const locale of LOCALES) {
  test(`${locale}: termine, eTax, regime dei frontalieri e fonti ufficiali`, () => {
    const source = bodySource(locale);
    assert.match(source, DEADLINE[locale], 'termine di consegna 30.4.2026');
    assert.match(source, /eTax 2025/);
    assert.match(source, OLD_FRONTIER[locale], 'periodo transitorio dei vecchi frontalieri');
    assert.match(source, RECALC_DEADLINE[locale], 'termine del ricalcolo');
    assert.match(source, /90\s?%/, 'soglia per riscatti 2° pilastro e 3a');
    assert.match(source, /20 km/, 'fascia di confine');
    assert.match(source, /dettaglio-comunicato\?NEWS_ID=257983/);
    assert.match(source, /Direttiva_UIF__vers\._1\.0_del_01\.01\.2025_\.pdf/);
    assert.match(source, /fedlex\.admin\.ch\/eli\/cc\/2023\/410/);
  });

  test(`${locale}: niente regime frontalieri superato, CU o citazione inventata`, () => {
    const source = bodySource(locale);
    assert.doesNotMatch(
      source,
      /tipo di contratto|Art des Vertrags|type de contrat|type of contract/,
      'tassazione differenziata per tipo di contratto',
    );
    assert.doesNotMatch(source, /\bCU\b/, 'la CU italiana non serve alla dichiarazione ticinese');
    assert.doesNotMatch(
      source,
      /obiettivo è semplificare le procedure|Das Ziel ist es, die Verfahren|objectif est de simplifier les procédures|goal is to simplify procedures/,
      'citazione assente dal comunicato ufficiale',
    );
  });
}
