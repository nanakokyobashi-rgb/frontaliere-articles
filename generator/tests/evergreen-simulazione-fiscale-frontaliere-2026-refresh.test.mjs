// Refresh evergreen di `simulazione-fiscale-frontaliere-2026` (corpus #1759,
// migrata dal sito #9626). Fissa i due parametri ufficiali cambiati e la catena
// della simulazione ricalcolata su di essi, nelle quattro lingue:
// - tabella R0 2026 della Divisione delle contribuzioni del Canton Ticino per i
//   nuovi frontalieri: 7,30% a 65'000 CHF (A0: 9,20%), cioè 4'745 CHF e non
//   5'980 * 0.80 = 4'784 CHF;
// - aliquote IRPEF 2026 23/33/43 (Legge n. 199/2025, art. 1 c. 3-4): il secondo
//   scaglione non è più al 35%.
// Le assunzioni del modello (cambio 1.099, contributi 7'410 CHF, addizionali 2%)
// restano quelle dichiarate dall'articolo e sono replicate qui per ricalcolare
// la catena invece di copiarne i risultati.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SLUG = 'simulazione-fiscale-frontaliere-2026';
const LOCALES = ['it', 'en', 'de', 'fr'];
const REFRESHED_ON = '2026-09-24';

function bodySource(locale) {
  return fs.readFileSync(path.join(ROOT, 'content', 'blog-body', locale, `${SLUG}.ts`), 'utf8');
}

// Separatore delle migliaia come compare nel sorgente TS: `\'` (it/de/fr) o `,` (en).
function amount(n) {
  const s = String(n);
  const head = s.slice(0, -3);
  const tail = s.slice(-3);
  return new RegExp(`(?<![\\d,'])${head}(?:\\\\'|,)${tail}(?!\\d)`);
}

function simulate() {
  const fx = 1.099;
  const gross = 65000;
  const contrib = 5135 + 2275;
  const swissOld = gross * 0.092; // tabella A0 2026, 64'801-65'400 CHF
  const swissNew = gross * 0.073; // tabella R0 2026, 64'801-65'400 CHF
  const grossEur = gross * fx;
  const taxable = grossEur - contrib * fx - 10000;
  const irpef = Math.min(taxable, 28000) * 0.23
    + Math.max(0, Math.min(taxable, 50000) - 28000) * 0.33
    + Math.max(0, taxable - 50000) * 0.43;
  const addizionali = taxable * 0.02;
  const credit = swissNew * fx * taxable / grossEur;
  const saldoEur = irpef + addizionali - credit;
  const netNew = gross - contrib - swissNew - saldoEur / fx;
  const netOld = gross - contrib - swissOld;
  const r = Math.round;
  return {
    swissNew: r(swissNew),
    swissNewEur: r(swissNew * fx),
    netSwissNew: r(gross - contrib - swissNew),
    netSwissNewMonth: r((gross - contrib - swissNew) / 12),
    irpef: r(irpef),
    credit: r(credit),
    saldoEur: r(saldoEur),
    saldoChf: r(saldoEur / fx),
    netNew: r(netNew),
    netNewEur: r(netNew * fx),
    netNewMonth: r(netNew / 12),
    netOld: r(netOld),
    diff: r(netOld - netNew),
  };
}

test('la catena ricalcolata con tabella R0 2026 e IRPEF 2026 dà i valori pubblicati', () => {
  assert.deepEqual(simulate(), {
    swissNew: 4745,
    swissNewEur: 5215,
    netSwissNew: 52845,
    netSwissNewMonth: 4404,
    irpef: 15115,
    credit: 3890,
    saldoEur: 12291,
    saldoChf: 11184,
    netNew: 41661,
    netNewEur: 45786,
    netNewMonth: 3472,
    netOld: 51610,
    diff: 9949,
  });
});

test('il registro marca il refresh fattuale con updatedAt', () => {
  const registry = fs.readFileSync(path.join(ROOT, 'content', 'blog-articles-data.ts'), 'utf8');
  assert.match(registry, new RegExp(`id: '${SLUG}'[\\s\\S]{0,160}updatedAt: '${REFRESHED_ON}'`));
});

test('le quattro lingue portano i valori ricalcolati e le fonti ufficiali', () => {
  const expected = Object.values(simulate());
  for (const locale of LOCALES) {
    const source = bodySource(locale);
    for (const n of expected) {
      if (n >= 1000) assert.match(source, amount(n), `${locale}: manca ${n}`);
    }
    assert.match(source, /R0 2026/, `${locale}: tabella R0 2026`);
    assert.match(source, /7[.,]30%/, `${locale}: aliquota R0`);
    assert.match(source, /9[.,]20%/, `${locale}: aliquota A0`);
    assert.match(source, /23%, 33%, 43%/, `${locale}: scaglioni IRPEF 2026`);
    assert.match(source, /199\/2025/, `${locale}: legge di bilancio 2026`);
    assert.match(source, /www4\.ti\.ch/, `${locale}: fonte Divisione delle contribuzioni`);
    assert.match(source, /agenziaentrate\.gov\.it/, `${locale}: fonte Agenzia delle Entrate`);
  }
});

test('nessuna lingua conserva i valori calcolati con IRPEF 35% e 80% di A0', () => {
  for (const locale of LOCALES) {
    const source = bodySource(locale);
    for (const stale of [4784, 5258, 52806, 4401, 15555, 3922, 12699, 11555, 41251, 45335, 3438, 10359]) {
      assert.doesNotMatch(source, amount(stale), `${locale}: valore obsoleto ${stale}`);
    }
    assert.doesNotMatch(source, /\* 0\.80/, `${locale}: formula 80% di A0`);
    assert.doesNotMatch(source, /stimato dal calcolatore|vom Rechner geschätzte|estimé par le calculateur|estimated by the calculator/);
  }
});
