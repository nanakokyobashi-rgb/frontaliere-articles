// Refresh evergreen di `credito-imposta-doppia-tassazione` (corpus #1794,
// parent sito #9629). Fissa nelle quattro lingue i fatti verificati il
// 2026-09-25 su fonti ufficiali:
// - quadri: nel 730 lo stipendio va nel quadro C (codice 4) e il credito nel
//   quadro G (rigo G4); il quadro CE è del Redditi PF (istruzioni 730/2026 e
//   Redditi PF 2026 dell'Agenzia delle Entrate);
// - cambio: quello del giorno in cui è percepito ogni stipendio (o, se non
//   fissato, il medio del mese), non la media annuale (stesse istruzioni);
// - vecchi frontalieri: finestra 31.12.2018-17.7.2023, tassazione esclusiva in
//   Svizzera (Accordo 2020 art. 9, circolare 25/E del 18.8.2023, FAQ AFC);
// - esempio da 65'000 CHF: tabella R0 2026 del Canton Ticino al 7,30% (4'745 CHF
//   invece di 4'784 = 80% dell'A0) e IRPEF 2026 al 23/33/43 (Legge n. 199/2025).
// Le assunzioni del modello (cambio 1,099, contributi 7'410 CHF, addizionali 2%)
// restano quelle dichiarate dall'articolo e sono replicate qui per ricalcolare
// la catena invece di copiarne i risultati.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SLUG = 'credito-imposta-doppia-tassazione';
const LOCALES = ['it', 'en', 'de', 'fr'];
const REFRESHED_ON = '2026-09-25';

const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const body = (locale) => read('content', 'blog-body', locale, `${SLUG}.ts`);

// Separatore delle migliaia come compare nel sorgente: `.` (it/de), spazio (fr), `,` (en).
function amount(n) {
  const s = String(n);
  const head = s.slice(0, -3);
  const tail = s.slice(-3);
  return new RegExp(`(?<![\\d.,])${head}[., ]${tail}(?!\\d)`);
}

function simulate() {
  const fx = 1.099;
  const gross = 65000;
  const contrib = 7410;
  const swiss = gross * 0.073; // tabella R0 2026, 64'801-65'400 CHF
  const grossEur = gross * fx;
  const taxable = grossEur - contrib * fx - 10000;
  const irpef = Math.min(taxable, 28000) * 0.23
    + Math.max(0, Math.min(taxable, 50000) - 28000) * 0.33
    + Math.max(0, taxable - 50000) * 0.43;
  const addizionali = taxable * 0.02;
  const credit = swiss * fx * taxable / grossEur;
  const saldoEur = irpef + addizionali - credit;
  const r = Math.round;
  return {
    swiss: r(swiss),
    swissEur: r(swiss * fx),
    taxable: r(taxable),
    irpef: r(irpef),
    addizionali: r(addizionali),
    credit: r(credit),
    saldoEur: r(saldoEur),
    saldoChf: r(saldoEur / fx),
  };
}

const OLD_WINDOW = {
  it: /tra il 31 dicembre 2018 e il 17 luglio 2023/,
  en: /between December 31, 2018 and July 17, 2023/,
  de: /zwischen dem 31\. Dezember 2018 und dem 17\. Juli 2023/,
  fr: /entre le 31 décembre 2018 et le 17 juillet 2023/,
};
const ANNUAL_AVERAGE = /medio annuale|tasso medio annuale|durchschnittliche[nr]? (?:jährliche[nr]? )?(?:CHF\/EUR-)?(?:Jahres)?(?:wechsel)?kurs|Jahreswechselkurs|CHF\/EUR-Jahreskurs|taux (?:de change )?annuel moyen|average annual/i;
const HIRED_AFTER = /assunt[io] dopo il 17 luglio|eingestellt wurden|nach dem 17\. Juli 2023, mit|embauchés? après|hired after/;

test('la catena ricalcolata con tabella R0 2026 e IRPEF 2026 dà i valori pubblicati', () => {
  assert.deepEqual(simulate(), {
    swiss: 4745,
    swissEur: 5215,
    taxable: 53291,
    irpef: 15115,
    addizionali: 1066,
    credit: 3890,
    saldoEur: 12291,
    saldoChf: 11184,
  });
});

test('il registro marca il refresh fattuale con updatedAt', () => {
  const registry = read('content', 'blog-articles-data.ts');
  assert.match(registry, new RegExp(`id: '${SLUG}'[\\s\\S]{0,120}updatedAt: '${REFRESHED_ON}'`));
});

test('la description SEO non attribuisce il quadro CE al 730', () => {
  const seo = read('content', 'seo', 'seo-blog.ts');
  const start = seo.indexOf(`'blog-${SLUG}': {`);
  assert.ok(start >= 0, 'voce SEO presente');
  const description = seo.slice(start).split('\n').find((l) => l.trim().startsWith('description:'));
  assert.doesNotMatch(description, /Quadro CE del 730/i);
  assert.match(description, /quadri C e G del 730/);
});

for (const locale of LOCALES) {
  test(`${locale}: esempio con i valori ricalcolati`, () => {
    const src = body(locale);
    for (const n of Object.values(simulate())) {
      assert.match(src, amount(n), `${locale}: manca ${n}`);
    }
    assert.match(src, /R0 2026/, `${locale}: tabella R0 2026`);
    assert.match(src, /7[.,]30%/, `${locale}: aliquota R0`);
    assert.match(src, /23%, 33%, 43%/, `${locale}: scaglioni IRPEF 2026`);
    assert.match(src, /199\/2025/, `${locale}: legge di bilancio 2026`);
  });

  test(`${locale}: nessun valore calcolato con IRPEF 35% o con l'80% dell'A0`, () => {
    const src = body(locale);
    for (const stale of [4784, 5258, 15555, 3922, 12699, 11555]) {
      assert.doesNotMatch(src, amount(stale), `${locale}: valore obsoleto ${stale}`);
    }
    assert.doesNotMatch(src, /stimata all'80%|auf 80% geschätzt|estimée à 80%|estimated at 80%/);
  });

  test(`${locale}: quadri del 730 e del Redditi PF`, () => {
    const src = body(locale);
    assert.match(src, /G4/);
    assert.match(src, /quadr[io] C\b/i);
    assert.match(src, /RC/);
    assert.doesNotMatch(src, /Lohnausweis (?:e|und|et|and) Quadro CE/);
  });

  test(`${locale}: cambio del giorno di percezione, non media annuale`, () => {
    const src = body(locale);
    assert.doesNotMatch(src, ANNUAL_AVERAGE);
    assert.match(src, /Banca d\\'Italia/);
  });

  test(`${locale}: vecchi e nuovi frontalieri definiti dallo status, non dall'assunzione`, () => {
    const src = body(locale);
    assert.match(src, OLD_WINDOW[locale]);
    assert.doesNotMatch(src, HIRED_AFTER);
    assert.match(src, /80%/);
    assert.match(src, /10[., ]000/);
  });

  test(`${locale}: fonti ufficiali citate`, () => {
    const src = body(locale);
    assert.match(src, /agenziaentrate\.gov\.it\/portale\/730-2026/);
    assert.match(src, /www4\.ti\.ch/);
    assert.match(src, /fedlex\.admin\.ch\/eli\/cc\/2023\/410/);
    assert.match(src, /normattiva\.it/);
    assert.match(src, /estv\.admin\.ch/);
    assert.match(src, /aliquote-e-calcolo-dell-irpef/);
  });
}
