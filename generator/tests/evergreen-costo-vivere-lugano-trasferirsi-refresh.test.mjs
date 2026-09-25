// Osservatore del refresh evergreen di `costo-vivere-lugano-trasferirsi`
// (corpus #1808, parent sito #9629). Fissa nelle quattro lingue i fatti
// verificati il 2026-09-25 e fallisce se torna uno dei valori superati:
// - moltiplicatore comunale di Lugano per le persone fisiche: 80% nel 2026,
//   77% fino al 2025 (Divisione delle contribuzioni TI, tabella
//   https://www4.ti.ch/dfe/dc/sportello/moltiplicatori-comunali);
// - con il permesso B si resta all'imposta alla fonte fino al permesso C;
//   tassazione ordinaria ulteriore obbligatoria oltre CHF 120'000 lordi,
//   altrimenti su richiesta entro il 31 marzo (Direttiva UIF TI 2025);
// - LAMal 2026, adulti 26+ a Lugano (regione di premio TI-1), senza
//   infortunio: con franchigia 2'500 da CHF 449.90 a 649.30, con franchigia
//   ordinaria 300 nel modello standard da 645.10 a 768.70 (UFSP, dati
//   Prämien_CH 2026); premio medio adulti TI CHF 582.60. Non piu'
//   "380-450 CHF" con una "franchigia standard" di 2'500;
// - i ristorni vanno ai Comuni italiani di confine (Accordo 2020, art. 9),
//   non sono un beneficio del lavoratore.
// Il registry deve portare `updatedAt` alla data del refresh fattuale.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SLUG = 'costo-vivere-lugano-trasferirsi';
const LOCALES = ['it', 'en', 'de', 'fr'];
const REFRESHED_ON = '2026-09-25';

const TAX = Object.freeze({
  it: { stillSource: /non si esce dall\\'imposizione alla fonte/, deadline: /31 marzo/ },
  en: { stillSource: /you do not leave the withholding tax system/, deadline: /31 March/ },
  de: { stillSource: /verlässt man das Quellensteuersystem allerdings nicht/, deadline: /31\. März/ },
  fr: { stillSource: /on ne quitte pourtant pas l\\'imposition à la source/, deadline: /31 mars/ },
});

const STALE_TAX_CLAIMS = Object.freeze({
  it: /Si abbandona l\\'imposizione alla fonte|Non si beneficia più dei ristorni/,
  en: /You leave the withholding tax system|no tax refunds|benefit from tax refunds/,
  de: /Man verlässt das Quellensteuersystem und|profitiert nicht mehr von Steuerrückerstattungen/,
  fr: /On quitte le système de l\\'imposition à la source|ne bénéficie plus des ristournes/,
});

function bodySource(locale) {
  return fs.readFileSync(path.join(ROOT, 'content', 'blog-body', locale, `${SLUG}.ts`), 'utf8');
}

function metaExcerpt(locale) {
  const meta = fs.readFileSync(path.join(ROOT, 'content', `blog-meta-${locale}.ts`), 'utf8');
  const match = meta.match(new RegExp(`'blog\\.article\\.${SLUG}\\.excerpt': '((?:[^'\\\\]|\\\\.)*)'`));
  assert.ok(match, `${locale}: excerpt di ${SLUG} presente`);
  return match[1];
}

test('il registry segna il refresh fattuale di costo-vivere-lugano-trasferirsi', () => {
  const registry = fs.readFileSync(path.join(ROOT, 'content', 'blog-articles-data.ts'), 'utf8');
  assert.match(registry, new RegExp(`id: '${SLUG}'[\\s\\S]{0,220}updatedAt: '${REFRESHED_ON}'`));
});

test('moltiplicatore comunale di Lugano 2026: 80%, non piu 77%', () => {
  for (const locale of LOCALES) {
    const source = bodySource(locale);
    const mentions80 = source.match(/\b80\s?%/g) ?? [];
    assert.ok(mentions80.length >= 2, `${locale}: 80% nei fatti chiave e nel paragrafo fiscale`);
    assert.match(source, /77\s?% (?:fino al|until|bis|jusqu)[^)]*2025/, `${locale}: 77% solo come valore fino al 2025`);
    assert.doesNotMatch(source, /\*\*77\s?%\*\*|77\s?% (?:moltiplicatore|for Lugano in 2026|für Lugano)|Multiplicateur impôt\*\*: 77/, `${locale}: 77% presentato come valore 2026`);
  }
});

test('permesso B: resta l imposta alla fonte, TOU oltre 120.000 CHF o su richiesta', () => {
  for (const locale of LOCALES) {
    const source = bodySource(locale);
    assert.match(source, TAX[locale].stillSource, `${locale}: il permesso B non fa uscire dall imposta alla fonte`);
    assert.match(source, /120[.,\s]000 CHF/, `${locale}: soglia TOU obbligatoria`);
    assert.match(source, TAX[locale].deadline, `${locale}: termine della TOU su richiesta`);
    assert.match(source, /\(C\)/, `${locale}: permesso di domicilio C`);
    assert.doesNotMatch(source, STALE_TAX_CLAIMS[locale], `${locale}: regime fiscale o ristorni superati`);
  }
});

test('LAMal 2026 a Lugano: 450-650 CHF con franchigia 2.500, media TI 582.60', () => {
  for (const locale of LOCALES) {
    const source = bodySource(locale);
    assert.match(source, /450-650 CHF/, `${locale}: forchetta nei fatti chiave`);
    assert.match(source, /\*\*450 (?:e|and|und|et) 650 CHF\*\*/, `${locale}: forchetta nel corpo`);
    assert.match(source, /645-769 CHF/, `${locale}: modello standard con franchigia ordinaria`);
    assert.match(source, /582[.,]60/, `${locale}: premio medio adulti TI 2026`);
    assert.match(source, /\b300 CHF/, `${locale}: franchigia ordinaria`);
    assert.doesNotMatch(source, /380-450|800-900 CHF/, `${locale}: premi superati`);
    assert.doesNotMatch(source, /franchigia standard|standard deductible|Standardfranchise|franchise standard/, `${locale}: 2.500 non e la franchigia standard`);
    assert.doesNotMatch(source, /(?:Proiezioni|proiezioni|Projections|Prognosen|projections) (?:per il |for |für |pour )?2026/, `${locale}: premi 2026 ufficiali, non proiezioni`);
  }
});

test('budget mensile coerente con il premio LAMal minimo 2026', () => {
  for (const locale of LOCALES) {
    const source = bodySource(locale);
    assert.match(source, /\(LAMal\)\s?:\*\* 450 CHF/, `${locale}: voce LAMal del budget`);
    assert.match(source, /3[.,\s]145 CHF/, `${locale}: totale spese fisse`);
    assert.doesNotMatch(source, /3[.,\s]095|\(LAMal\)\s?:\*\* 400 CHF/, `${locale}: budget superato`);
  }
});

test('excerpt: LAMal da 450 CHF, non da 380', () => {
  for (const locale of LOCALES) {
    const excerpt = metaExcerpt(locale);
    assert.match(excerpt, /LAMal (?:da|from|ab|dès) 450 CHF/, `${locale}: excerpt aggiornato`);
    assert.doesNotMatch(excerpt, /380/, `${locale}: excerpt superato`);
  }
});

test('canone Serafe 2026 resta CHF 335', () => {
  for (const locale of LOCALES) {
    assert.match(bodySource(locale), /335 CHF|CHF 335/, `${locale}: canone UFCOM 2026 invariato`);
  }
});
