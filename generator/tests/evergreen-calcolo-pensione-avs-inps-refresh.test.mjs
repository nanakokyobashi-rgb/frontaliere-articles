import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Refresh evergreen di `calcolo-pensione-avs-inps` (corpus #1758).
// Fissa i fatti corretti con fonte nelle quattro lingue e rende rosso un
// ritorno ai valori superati:
// - rendita AVS completa 2026: minimo CHF 1'260, massimo CHF 2'520
//   (Memento AVS 3.01, stato 1° gennaio 2026), non 1'255 / 2'510;
// - contributi AVS/AI/IPG 10,6% (5,3% + 5,3%), Memento 2.01 stato 2026;
// - pratiche italo-svizzere dei residenti in Lombardia gestite dal Polo
//   nazionale INPS "Svizzera" di Bergamo (messaggio INPS n. 3352/2018),
//   non dall'INPS di Varese "anche per Como e VCO".

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SLUG = 'calcolo-pensione-avs-inps';
const LOCALES = ['it', 'en', 'de', 'fr'];
const REFRESHED_ON = '2026-09-24';

function bodySource(locale) {
  return fs.readFileSync(path.join(ROOT, 'content', 'blog-body', locale, `${SLUG}.ts`), 'utf8');
}

test('il registry data il refresh fattuale di calcolo-pensione-avs-inps', () => {
  const registry = fs.readFileSync(path.join(ROOT, 'content', 'blog-articles-data.ts'), 'utf8');
  assert.match(registry, new RegExp(`id: '${SLUG}'[\\s\\S]{0,220}updatedAt: '${REFRESHED_ON}'`));
});

for (const locale of LOCALES) {
  test(`${locale}: rendita AVS 2026, contributi e competenza INPS aggiornati con fonte`, () => {
    const source = bodySource(locale);
    assert.match(source, /1(?:\\'|,)260/, 'rendita minima 2026');
    assert.match(source, /2(?:\\'|,)520/, 'rendita massima 2026');
    assert.doesNotMatch(source, /1(?:\\'|,)255|2(?:\\'|,)510/, 'importi AVS superati');
    assert.match(source, /10\.6%/, 'aliquota AVS/AI/IPG');
    assert.match(source, /5\.3%/, 'quota lavoratore/datore');
    assert.match(source, /Bergam[oe]/, 'polo INPS Svizzera di Bergamo');
    assert.doesNotMatch(source, /Varese per Como|Varese for Como|Varese für Como|Varese pour Côme/);
    assert.doesNotMatch(source, /INPS di Varese|INPS office in Varese|INPS-Büro in Varese|INPS de Varèse/);
    assert.match(source, /ahv-iv\.ch\/p\/3\.01\./, 'fonte Memento 3.01');
    assert.match(source, /ahv-iv\.ch\/p\/2\.01\./, 'fonte Memento 2.01');
    assert.match(source, /Messaggio\+numero\+3352/, 'fonte messaggio INPS 3352/2018');
  });
}
