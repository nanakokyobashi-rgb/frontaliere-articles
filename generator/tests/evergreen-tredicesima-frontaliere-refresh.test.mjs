/**
 * Refresh evergreen di `tredicesima-frontaliere` (sito, issue 7295).
 *
 * Fissa nelle quattro lingue i fatti verificati il 2026-10-06 e fallisce se
 * tornano i valori smentiti dalle fonti:
 *  - i premi per infortuni non professionali e per l'indennita' giornaliera di
 *    malattia non sono aliquote di legge: dipendono dall'assicuratore e dal
 *    contratto del datore di lavoro, quindi vanno presentati come ordini di
 *    grandezza, non come percentuali fisse;
 *  - in Italia la tredicesima non ha una tassazione separata: sconta l'IRPEF
 *    ordinaria senza le detrazioni per lavoro dipendente (la tassazione
 *    separata riguarda il TFR);
 *  - contributi 2026 a carico del salariato: AVS/AI/IPG 5,3 %, AD 1,1 %
 *    (promemoria AVS/AI 2.01).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SLUG = 'tredicesima-frontaliere';
const REFRESHED_ON = '2026-10-07';

const LOCALES = {
  it: { varies: /variano da datore a datore/, fixed: /LAINF allo 0[.,]7 ?%|LAINF 0[.,]7 ?%, IJM 0[.,]8 ?%/ },
  en: { varies: /depending on the employer/, fixed: /\(0\.7%\), IJM \(0\.8%\)|UVG 0\.7%, IJM 0\.8%/ },
  de: { varies: /je nach Arbeitgeber/, fixed: /BUV \(0,7 %\)|KTG \(0,8 %\)|UVG 0,7 %, IJM 0,8 %/ },
  fr: { varies: /selon l\\?'employeur/, fixed: /LAA \(0,7 %\)|IJM \(0,8 %\)|UVG 0,7 %, IJM 0,8 %/ },
};

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

test('il registry porta updatedAt del refresh fattuale', () => {
  const registry = read('content/blog-articles-data.ts');
  assert.match(registry, new RegExp(`id: '${SLUG}'[\\s\\S]{0,220}updatedAt: '${REFRESHED_ON}'`));
});

for (const [locale, expected] of Object.entries(LOCALES)) {
  test(`${locale}: premi LAINF e IJM come ordini di grandezza, contributi 2026`, () => {
    const source = read(`content/blog-body/${locale}/${SLUG}.ts`);
    assert.match(source, expected.varies, 'premi che variano da datore a datore');
    assert.doesNotMatch(source, expected.fixed, 'premi presentati come aliquote fisse');
    assert.match(source, /5[.,]3 ?%/, 'contributo AVS/AI/IPG 2026');
    assert.match(source, /1[.,]1 ?%/, 'contributo AD 2026');
  });
}

test('it: la tredicesima italiana non ha una tassazione separata', () => {
  const source = read(`content/blog-body/it/${SLUG}.ts`);
  assert.match(source, /IRPEF ordinaria/, 'IRPEF ordinaria');
  assert.doesNotMatch(source, /aliquota TFR separata/, 'tassazione separata attribuita alla tredicesima');
});
