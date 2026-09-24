import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Refresh #1757 (sito #9624): l'articolo annunciava come futura la votazione
// federale dell'8 marzo 2026 sull'imposizione individuale e dava aliquote e
// un netto «dopo la riforma» che nessuna tariffa vigente sostiene. Fonti:
// https://www.estv.admin.ch/it/imposizione-individuale (esito 54,23% di sì,
// deduzione figli 6'800 -> 12'000) e
// https://www.admin.ch/de/newnsb/khPH1Sn08Zr6iGZYe4tsB (entrata in vigore
// 1.1.2032, Consiglio federale 19.8.2026).

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SLUG = 'tassazione-individuale-lavoro-ticino';
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
  test(`${locale}: esito del voto, entrata in vigore e fonti ufficiali`, () => {
    const source = bodySource(locale);
    assert.match(source, /54[.,]23\s?%/, 'percentuale dei sì');
    assert.match(source, /45[.,]77\s?%/, 'percentuale dei no');
    assert.match(source, /2032/, 'anno di entrata in vigore');
    assert.match(source, /19\.? (?:agosto|August|août) 2026/, 'data della decisione del Consiglio federale');
    assert.match(source, /estv\.admin\.ch\/it\/imposizione-individuale/);
    assert.match(source, /admin\.ch\/de\/newnsb\/khPH1Sn08Zr6iGZYe4tsB/);
    assert.match(source, /6\\'800[\s\S]{0,40}12\\'000/, 'deduzione per figli IFD');
  });

  test(`${locale}: niente voto al futuro, aliquote inventate o attribuzioni errate`, () => {
    const source = bodySource(locale);
    assert.doesNotMatch(source, /si voterà|wird über .* abgestimmt|une votation aura lieu|a vote will be held/);
    assert.doesNotMatch(source, /(?:5%|5 %)[^"]{0,60}30[.,' \\]*000/, 'aliquota 5% fino a 30000 CHF');
    assert.doesNotMatch(source, /2\\'600 CHF/, 'netto inventato');
    assert.doesNotMatch(source, /70%/, 'statistica attribuita a EFD 2022');
    assert.doesNotMatch(source, /Ticino votes|in Ticino l\\'8 marzo|imponibile individuale in Ticino|Ticino potrebbe introdurre/);
  });
}
