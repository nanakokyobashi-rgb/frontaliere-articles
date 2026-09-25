import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Issue corpus #1755 (sito #9473). L'articolo e' una notizia datata
// (17-02-2026) sulle tensioni Italia-Ticino: non e' stato riscritto come guida,
// sono stati corretti solo i fatti falsi. Il test fissa le correzioni nelle
// quattro lingue e fallirebbe con i valori precedenti.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SLUG = 'tassa-salute-tensioni-ticino';
const LOCALES = ['it', 'en', 'de', 'fr'];
const REFRESHED_ON = '2026-09-24';

function bodySource(locale) {
  return fs.readFileSync(
    path.join(ROOT, 'content', 'blog-body', locale, `${SLUG}.ts`),
    'utf8',
  );
}

test('tassa-salute-tensioni-ticino: registry con updatedAt del refresh fattuale', () => {
  const registry = fs.readFileSync(path.join(ROOT, 'content', 'blog-articles-data.ts'), 'utf8');
  assert.match(
    registry,
    new RegExp(`id: '${SLUG}'[\\s\\S]{0,220}updatedAt: '${REFRESHED_ON}'`),
  );
});

test('tassa-salute-tensioni-ticino: la tassa e\' una quota italiana (L. 213/2023), non ticinese', () => {
  for (const locale of LOCALES) {
    const source = bodySource(locale);
    // Regola corretta: 3-6% del netto, 30-200 euro per mese lavorato.
    assert.match(source, /213\/2023/, `${locale}: riferimento alla legge 213/2023`);
    assert.match(source, /3\s?% (?:e|and|und|et) (?:il |un )?6\s?%/, `${locale}: forbice 3-6%`);
    assert.match(source, /30 euro/i, `${locale}: minimo mensile 30 euro`);
    assert.match(source, /200 euro/i, `${locale}: massimo mensile 200 euro`);
    assert.match(source, /normattiva\.it/, `${locale}: fonte legge`);
    assert.match(source, /gazzettaufficiale\.it\/eli\/id\/2025\/12\/18\/25A06706/, `${locale}: fonte DM 14-11-2025`);
    assert.match(source, /fedlex\.admin\.ch\/eli\/cc\/2023\/410/, `${locale}: fonte accordo 2020`);

    // Valori inventati rimossi.
    assert.doesNotMatch(source, /150\s?CHF|CHF\s?150/, `${locale}: tetto 150 CHF inventato`);
    assert.doesNotMatch(source, /0[,.]03\s?=/, `${locale}: calcolo 3% sul lordo inventato`);
    assert.doesNotMatch(source, /30 (?:giugno|June|juin) 2025|30\. Juni 2025/, `${locale}: scadenza modulo ACIF inventata`);
    assert.doesNotMatch(source, /10\s? ?%/, `${locale}: sanzione 10% inventata`);
    assert.doesNotMatch(
      source,
      /introdotta dal Canton Ticino|introduced by the Canton of Ticino|vom Kanton Tessin eingef|introduite par le canton du Tessin/,
      `${locale}: attribuzione della tassa al Ticino`,
    );
    assert.doesNotMatch(
      source,
      /costi sanitari sostenuti dal Canton Ticino|health costs incurred by the Canton of Ticino|Gesundheitskosten des Kantons Tessin|coûts de santé supportés par le canton du Tessin/,
      `${locale}: finalita' ticinese inventata`,
    );
  }
});

test('tassa-salute-tensioni-ticino: commissione mista = art. 6 dell\'Accordo 2020, riunita a ottobre 2025', () => {
  for (const locale of LOCALES) {
    const source = bodySource(locale);
    assert.match(source, /(?:articolo|Article|Artikel|article) 6\b/, `${locale}: articolo 6`);
    assert.doesNotMatch(source, /(?:articolo|Article|Artikel|article) 5\b/, `${locale}: articolo 5 errato`);
    assert.match(source, /ottobre 2025|Oktober 2025/, `${locale}: data commissione`);
    assert.doesNotMatch(source, /ottobre 2023|Oktober 2023/, `${locale}: data commissione errata`);
  }
});

test('tassa-salute-tensioni-ticino: ristorni non tradotti come ristoranti o rinfreschi', () => {
  for (const locale of ['en', 'de', 'fr']) {
    const source = bodySource(locale);
    assert.doesNotMatch(source, /restaurants|refreshments|Erfrischungen|repromotions/, `${locale}: traduzione errata di ristorni`);
    assert.match(source, /ristorni/i, `${locale}: termine ristorni`);
  }
});
