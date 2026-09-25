/**
 * Refresh evergreen di `congedo-genitori-frontaliere-ticino` (corpus #1805).
 *
 * Fissa nelle quattro lingue i fatti verificati il 2026-09-25 e fallisce se
 * tornano i valori smentiti dalle fonti ufficiali:
 *  - massimale IPG CHF 220 al giorno: e' il limite di legge, non una stima
 *    (promemoria AVS/AI 6.02 e 6.04);
 *  - indennita' per l'altro genitore: 14 indennita' giornaliere, quindi al
 *    massimo CHF 3'080, non 10 giorni per CHF 2'200 (promemoria 6.04);
 *  - moduli di richiesta 318.750 (maternita') e 318.747 (altro genitore),
 *    non 318.753 / 318.755;
 *  - assegni familiari Ticino 2026: CHF 215 per figli, CHF 268 di formazione
 *    (IAS Ticino, informazioni valide dal 1.1.2026), non 200 / 250.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SLUG = 'congedo-genitori-frontaliere-ticino';
const LOCALES = ['it', 'en', 'de', 'fr'];
const REFRESHED_ON = '2026-09-25';
const MEMENTO_SUFFIX = { it: 'i', en: 'e', de: 'd', fr: 'f' };
const IAS_2026 = 'https://m4.ti.ch/fileadmin/DSS/IAS/pdf/informazioni_periodiche/2026_Info_periodiche_AF.pdf';

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

test('il registry porta updatedAt del refresh fattuale', () => {
  const registry = read('content/blog-articles-data.ts');
  assert.match(registry, new RegExp(`id: '${SLUG}'[\\s\\S]{0,220}updatedAt: '${REFRESHED_ON}'`));
});

for (const locale of LOCALES) {
  test(`${locale}: IPG, moduli e assegni familiari 2026 con fonte`, () => {
    const source = read(`content/blog-body/${locale}/${SLUG}.ts`);
    assert.match(source, /CHF 220|220 CHF/, 'massimale IPG');
    assert.doesNotMatch(
      source,
      /si stima|tetto massimo stimato|\(stime\)|it is estimated|estimated maximum|\(estimates\)|wird geschätzt|geschätzte|\(Schätzungen\)|on estime|estimé à|\(estimations\)/,
      'massimale presentato come stima',
    );
    assert.match(source, /3(?:\\'|,)080/, 'totale massimo per 14 indennita');
    assert.doesNotMatch(source, /2(?:\\'|,)200/, 'totale su 10 giorni');
    assert.match(source, /318\.750/, 'modulo maternita');
    assert.match(source, /318\.747/, "modulo altro genitore");
    assert.doesNotMatch(source, /318\.753|318\.755/, 'numeri di modulo inesistenti');
    assert.match(source, /215/, 'assegno per figli 2026');
    assert.match(source, /268/, 'assegno di formazione 2026');
    assert.doesNotMatch(source, /\b(?:CHF )?200(?: CHF)? (?:mensili|per month|\/month|pro Monat|par mois)/, 'assegno per figli superato');
    assert.doesNotMatch(source, /CHF 250\b|\b250 CHF/, 'assegno di formazione superato');
    assert.doesNotMatch(source, /proiezioni|projections|Prognosen/, 'fonte a proiezioni');
    const suffix = MEMENTO_SUFFIX[locale];
    assert.ok(source.includes(`https://www.ahv-iv.ch/p/6.02.${suffix}`), 'fonte promemoria 6.02');
    assert.ok(source.includes(`https://www.ahv-iv.ch/p/6.04.${suffix}`), 'fonte promemoria 6.04');
    assert.ok(source.includes(IAS_2026), 'fonte IAS Ticino 2026');
  });
}
