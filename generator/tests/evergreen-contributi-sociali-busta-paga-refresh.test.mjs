import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Refresh #1793 (sito #9629): l'articolo applicava un contributo AD dello
// 0.5% sul reddito oltre 148'200 CHF, abolito dal 1° gennaio 2023, e nel suo
// esempio su 72'000 CHF indicava come trattenuta AD il contributo totale
// (1'584 CHF, 2.2%) invece della quota del lavoratore (792 CHF, 1.1%), mentre
// per l'AVS dava gia' la quota del lavoratore. Fonti:
// https://www.ahv-iv.ch/p/2.01.i (AVS/AI/IPG 10.6%, stato 1° gennaio 2026) e
// https://www.ahv-iv.ch/p/2.08.i (AD 2.2% fino a 148'200 CHF, niente
// contributo oltre la soglia dal 2023). Gli stessi valori sono fissati per
// `guida-contributi-sociali-svizzera` da
// `evergreen-guida-contributi-sociali-svizzera-refresh.test.mjs`.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SLUG = 'contributi-sociali-busta-paga';
const LOCALES = ['it', 'en', 'de', 'fr'];
const LEAFLET_201 = { it: '2.01.i', en: '2.01.e', de: '2.01.d', fr: '2.01.f' };
const REFRESHED_ON = '2026-09-24';

function bodySource(locale) {
  return fs.readFileSync(path.join(ROOT, 'content', 'blog-body', locale, `${SLUG}.ts`), 'utf8');
}

test('la voce del registro porta la data del refresh fattuale', () => {
  const registry = fs.readFileSync(path.join(ROOT, 'content', 'blog-articles-data.ts'), 'utf8');
  assert.match(registry, new RegExp(`id: '${SLUG}'[\\s\\S]{0,220}updatedAt: '${REFRESHED_ON}'`));
});

for (const locale of LOCALES) {
  test(`${locale}: aliquote 2026, esempio con la quota del lavoratore e fonti ufficiali`, () => {
    const source = bodySource(locale);
    assert.match(source, /10[.,]6\s?%/, 'AVS/AI/IPG 10.6%');
    assert.match(source, /2[.,]2\s?%/, 'AD 2.2%');
    assert.match(source, /148[.,' ]200/, 'tetto AD');
    assert.match(source, /3[.,]816/, 'AVS/AI/IPG del lavoratore su 72000 CHF');
    assert.match(source, /\b792 CHF/, 'AD del lavoratore su 72000 CHF');
    assert.match(source, /2023/, 'abolizione del contributo oltre il tetto dal 2023');
    assert.ok(source.includes(`ahv-iv.ch/p/${LEAFLET_201[locale]}"`), 'promemoria 2.01 nella lingua');
    assert.match(source, /ahv-iv\.ch\/p\/2\.08\.[idf]"/, 'promemoria AD 2.08 esistente');
  });

  test(`${locale}: niente contributo AD oltre il tetto ne' totale spacciato per trattenuta`, () => {
    const source = bodySource(locale);
    assert.doesNotMatch(source, /0[.,]5\s?%/, 'contributo AD dello 0.5% abolito dal 2023');
    assert.doesNotMatch(source, /1[.,]584/, 'contributo AD totale indicato come trattenuta');
    assert.doesNotMatch(source, /2\.08\.e/, 'promemoria 2.08 inglese inesistente (404)');
  });
}
