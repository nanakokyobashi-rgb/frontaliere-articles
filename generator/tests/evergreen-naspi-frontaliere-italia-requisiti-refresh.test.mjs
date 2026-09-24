import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Refresh #1802 (sito #9629): l'articolo chiedeva 18 settimane di contributi
// e 30 giornate di lavoro nei 12 mesi, e faceva partire la riduzione del 3%
// dal quarto mese. Il D.Lgs. 22/2015 vigente chiede 13 settimane (art. 3),
// ha abolito le 30 giornate per le cessazioni dal 1.1.2022 (art. 3 c. 1-bis,
// legge 234/2021) e fa partire la riduzione dal sesto mese, dall'ottavo con
// 55 anni compiuti (art. 4 c. 3). Fonti:
// https://www.lavoro.gov.it/temi-e-priorita/ammortizzatori-sociali/focus-on/indennita-disoccupazione/naspi/pagine/naspi
// https://www.normattiva.it/uri-res/N2Ls?urn:nir:stato:decreto.legislativo:2015-03-04;22
// INPS circolare n. 4 del 28.1.2026 (massimale 1.584,70 EUR, soglia 1.456,72 EUR).

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SLUG = 'naspi-frontaliere-italia-requisiti';
const LOCALES = ['it', 'en', 'de', 'fr'];
const REFRESHED_ON = '2026-09-24';

function bodySource(locale) {
  return fs.readFileSync(path.join(ROOT, 'content', 'blog-body', locale, `${SLUG}.ts`), 'utf8');
}

test('la voce del registro porta la data del refresh fattuale', () => {
  const registry = fs.readFileSync(path.join(ROOT, 'content', 'blog-articles-data.ts'), 'utf8');
  assert.match(registry, new RegExp(`id: '${SLUG}'[\\s\\S]{0,220}updatedAt: '${REFRESHED_ON}'`));
});

for (const locale of LOCALES) {
  test(`${locale}: requisiti, importi 2026, riduzione e fonti ufficiali`, () => {
    const source = bodySource(locale);
    assert.match(source, /\b13 (?:settimane|Beitragswochen|weeks|semaines)/, '13 settimane di contribuzione');
    assert.match(source, /2022/, 'abolizione delle 30 giornate dal 2022');
    assert.match(source, /1[.,]584[.,]70/, 'massimale mensile 2026');
    assert.match(source, /1[.,]456[.,]72/, 'retribuzione di riferimento 2026');
    assert.match(source, /sesto mese|sechsten|sixth month|6ème mois|sixième mois/, 'riduzione dal sesto mese');
    assert.match(source, /940[.,]90/, 'esempio di riduzione composta');
    assert.match(source, /normattiva\.it\/uri-res\/N2Ls\?urn:nir:stato:decreto\.legislativo:2015-03-04;22/);
    assert.match(source, /lavoro\.gov\.it\/temi-e-priorita\/ammortizzatori-sociali\/focus-on\/indennita-disoccupazione\/naspi/);
    assert.match(source, /circolare-numero-4-del-28-01-2026/);
    assert.match(source, /CELEX:02004R0883/);
  });

  test(`${locale}: niente requisiti superati`, () => {
    const source = bodySource(locale);
    assert.doesNotMatch(source, /\b18 (?:settimane|Wochen|weeks|semaines)/, '18 settimane');
    assert.doesNotMatch(
      source,
      /(?:almeno|minimo(?: di)?|mindestens|at least|a minimum of|au moins|un minimum de) 30 (?:giorn|Tage|actual days|days|jours)/i,
      '30 giornate come requisito vigente',
    );
    assert.doesNotMatch(source, /quarto mese|vierten Monat|fourth month|4ème mois|quatrième mois/, 'riduzione dal quarto mese');
    assert.doesNotMatch(source, /940[.,]70/, 'esempio di riduzione errato');
  });
}
