// Osservatore del refresh evergreen di `costo-vita-ticino-vs-lombardia`
// (corpus #1754, migrata dal sito #9472). Fissa nelle quattro lingue i fatti
// verificati il 2026-09-26 e fallisce se torna uno dei valori superati:
// - franchigia-valore IVA nel traffico turistico: CHF 150 per persona e giorno
//   dal 1.1.2025 (UDSC), non piu' CHF 300; oltre soglia IVA sul totale al
//   2,6% per gli alimentari, 8,1% aliquota normale;
// - benzina: media svizzera UST agosto 2026 CHF 1.95/l, media italiana MIMIT
//   self 2,154 EUR/l al 24.9.2026 (non piu' 1,85 CHF / 1,75 EUR);
// - LAMal: premio medio adulti 26+ in Ticino 2026 CHF 582.60/mese (UFSP),
//   non "assicurazioni private CHF 800-1.500 all'anno".
// Il registry deve portare `updatedAt` alla data del refresh fattuale.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SLUG = 'costo-vita-ticino-vs-lombardia';
const LOCALES = ['it', 'en', 'de', 'fr'];
const REFRESHED_ON = '2026-09-26';

function bodySource(locale) {
  return fs.readFileSync(path.join(ROOT, 'content', 'blog-body', locale, `${SLUG}.ts`), 'utf8');
}

test('il registry segna il refresh fattuale di costo-vita-ticino-vs-lombardia', () => {
  const registry = fs.readFileSync(path.join(ROOT, 'content', 'blog-articles-data.ts'), 'utf8');
  assert.match(registry, new RegExp(`id: '${SLUG}'[\\s\\S]{0,220}updatedAt: '${REFRESHED_ON}'`));
});

test('franchigia doganale: CHF 150 per persona dal 2025, IVA 2,6%/8,1% sul totale', () => {
  for (const locale of LOCALES) {
    const source = bodySource(locale);
    const mentions150 = source.match(/CHF 150\b/g) ?? [];
    assert.ok(mentions150.length >= 3, `${locale}: franchigia CHF 150 in fatti chiave, corpo e FAQ`);
    assert.doesNotMatch(source, /CHF 300 (?:di|pro|par|per|in|customs)\b/, `${locale}: franchigia CHF 300 superata`);
    assert.doesNotMatch(source, /\(8[.,]1\s?%\)/, `${locale}: IVA unica 8,1% sugli alimentari`);
    assert.match(source, /2[.,]6\s?%/, `${locale}: aliquota ridotta alimentari`);
    assert.match(source, /8[.,]1\s?%/, `${locale}: aliquota normale`);
    assert.match(source, /2025/, `${locale}: data di entrata in vigore`);
  }
});

test('benzina: valori UST/MIMIT correnti al posto di 1,85 CHF / 1,75 EUR', () => {
  for (const locale of LOCALES) {
    const source = bodySource(locale);
    assert.match(source, /1[.,]95 CHF/, `${locale}: media svizzera UST agosto 2026`);
    assert.match(source, /2[.,]154/, `${locale}: media italiana MIMIT`);
    assert.match(source, /MIMIT/, `${locale}: fonte MIMIT citata`);
    assert.doesNotMatch(source, /1[.,]85\b|1[.,]75 (?:EUR|€)|€1[.,]75|\+15-20%/, `${locale}: prezzi carburante superati`);
  }
});

test('sanita: premio medio LAMal adulti Ticino 2026 al posto di CHF 800-1.500 all anno', () => {
  for (const locale of LOCALES) {
    const source = bodySource(locale);
    assert.match(source, /582[.,]60/, `${locale}: premio medio UFSP adulti TI 2026`);
    assert.doesNotMatch(source, /CHF 800 (?:e|und|et|and) 1[.,]500/, `${locale}: premio superato`);
  }
});

test('fiscalita: aliquota ticinese qualificata, senza confronto generico 11-13%', () => {
  for (const locale of LOCALES) {
    const source = bodySource(locale);
    assert.match(source, /14\s?%/, `${locale}: aliquota massima di categoria TI 2026`);
    assert.match(source, /ti-it\.pdf/, `${locale}: fonte AFC/ESTV ufficiale`);
    assert.match(source, /(?:varia secondo regime e reddito|varies by regime and income|variiert die Steuerbelastung je nach Regime und Einkommen|varie selon le régime et le revenu)/i, `${locale}: qualificazione per regime e reddito`);
    assert.doesNotMatch(source, /11\s?(?:-|à)\s?13\s?%/, `${locale}: confronto 11-13% non documentato`);
    assert.doesNotMatch(source, /43\s?% (?:in Italia|in Italy|in Italien|en Italie)/i, `${locale}: confronto IRPEF semplificato`);
  }
});
