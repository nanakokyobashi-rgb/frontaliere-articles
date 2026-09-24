import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Refresh #1803 (sito #9629): l'articolo chiedeva 18 settimane di contributi
// e 30 giornate di lavoro nei 12 mesi, e legava il diritto alla residenza in
// Italia «al momento della domanda». Il D.Lgs. 22/2015 vigente chiede 13
// settimane (art. 3) e ha abolito le 30 giornate per le cessazioni dal
// 1.1.2022 (art. 3 c. 1-bis); per il frontaliere disoccupato completo l'art.
// 65 del regolamento (CE) 883/2004 attribuisce la prestazione allo Stato di
// residenza durante l'ultimo impiego. Fonti:
// https://www.lavoro.gov.it/temi-e-priorita/ammortizzatori-sociali/focus-on/indennita-disoccupazione/naspi/pagine/naspi
// https://www.normattiva.it/uri-res/N2Ls?urn:nir:stato:decreto.legislativo:2015-03-04;22
// https://eur-lex.europa.eu/legal-content/IT/TXT/?uri=CELEX:02004R0883-20190731

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SLUG = 'naspi-ex-frontalieri-2026';
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
  test(`${locale}: requisiti, residenza durante l'impiego e fonti ufficiali`, () => {
    const source = bodySource(locale);
    assert.match(source, /\b13 (?:settimane|Beitragswochen|weeks|semaines)/, '13 settimane di contribuzione');
    assert.match(source, /2022/, 'abolizione delle 30 giornate dal 2022');
    assert.match(source, /\b68\b/, 'termine di 68 giorni');
    assert.match(source, /(?:art\.|Art\.|Artikel|Article|article|l\\'article) 65/, 'art. 65 del regolamento 883/2004');
    assert.match(source, /883\/2004/);
    assert.match(source, /normattiva\.it\/uri-res\/N2Ls\?urn:nir:stato:decreto\.legislativo:2015-03-04;22/);
    assert.match(source, /lavoro\.gov\.it\/temi-e-priorita\/ammortizzatori-sociali\/focus-on\/indennita-disoccupazione\/naspi/);
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
    assert.doesNotMatch(source, /30 (?:giornate di lavoro negli ultimi 12 mesi|Arbeitstage in den letzten 12 Monaten|actual workdays in the last 12 months|jours de travail effectifs? sur les 12)/, '30 giornate nei 12 mesi');
    assert.doesNotMatch(
      source,
      /residente in Italia al momento della domanda|residenza in Italia al momento della domanda|Wohnsitz in Italien zum Zeitpunkt des Antrags|Must be in Italy when applying|residence in Italy (?:when the application is filed|at the time of application)|r[eé]sidence en Italie au moment de la demande|r[eé]sider en Italie au moment de la demande/,
      'residenza al momento della domanda',
    );
  });
}
