// Refresh evergreen di `calcolo-tasse-entro-confine` (corpus #1795, parent sito
// #9629). Fissa nelle quattro lingue i fatti verificati su fonte ufficiale:
// - Accordo Italia-Svizzera in vigore dal 17 luglio 2023 e applicato dal
//   1° gennaio 2024 (admin.ch, comunicato 96751; circolare AdE 25/E del
//   18 agosto 2023): il vecchio regime vale fino al 31 dicembre 2023, i vecchi
//   frontalieri restano tassati solo in Svizzera, i nuovi hanno una tassazione
//   concorrente (Svizzera al massimo 80%, Italia con credito d'imposta);
// - tabelle 2026 dell'imposta alla fonte della Divisione delle contribuzioni
//   del Canton Ticino: A0 8,40% e R0 6,70% a 60'000 CHF, A0 6,80% e R0 5,40%
//   a 50'000 CHF (non «circa 7'500 CHF», «12,5% a Lugano», «6'250 CHF»);
// - aliquote IRPEF 2026 23/33/43 (legge 199/2025) e riduzione proporzionale
//   dell'imposta estera quando il reddito concorre solo in parte (istruzioni
//   730/2026, rigo G4): la catena dell'esempio di Marco è ricalcolata qui;
// - scadenze 2026: 730 entro il 30 settembre, Redditi PF online entro il
//   2 novembre (non «tra maggio e giugno»);
// - il datore di lavoro svizzero rilascia il certificato di salario (ESTV,
//   modulo 11), non la Certificazione Unica italiana.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SLUG = 'calcolo-tasse-entro-confine';
const LOCALES = ['it', 'en', 'de', 'fr'];
const REFRESHED_ON = '2026-09-25';

// Separatore delle migliaia come compare nel sorgente: `.` (it/de), `,` (en), spazio (fr).
const THOUSANDS = { it: '.', de: '.', en: ',', fr: ' ' };
const DECIMAL = { it: ',', de: ',', en: '.', fr: ',' };

function bodySource(locale) {
  return fs.readFileSync(path.join(ROOT, 'content', 'blog-body', locale, `${SLUG}.ts`), 'utf8');
}

function escape(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function amount(n, locale) {
  const s = String(n);
  const text = s.length > 3 ? `${s.slice(0, -3)}${THOUSANDS[locale]}${s.slice(-3)}` : s;
  return new RegExp(`(?<!\\d)(?<!\\d[ .,])${escape(text)}(?![\\d]|[.,]\\d)`);
}

function rate(r, locale) {
  return new RegExp(`(?<!\\d)${escape(r.toFixed(2).replace('.', DECIMAL[locale]))} ?%`);
}

// Catena dell'esempio: nuovo frontaliere single senza figli, 50'000 CHF lordi.
function marco() {
  const gross = 50000;
  const fx = 1.068; // media BNS di agosto 2026: 1 EUR = 0,93629 CHF
  const r0 = 0.054; // tabella R0 2026, 49'801-50'400 CHF
  const a0 = 0.068; // tabella A0 2026, 49'801-50'400 CHF
  const swiss = gross * r0;
  const grossEur = gross * fx;
  const base = grossEur - 10000; // franchigia frontalieri, art. 4 legge 83/2023
  const irpef = Math.min(base, 28000) * 0.23
    + Math.max(0, Math.min(base, 50000) - 28000) * 0.33
    + Math.max(0, base - 50000) * 0.43;
  const swissEur = swiss * fx;
  const credit = swissEur * base / grossEur;
  const r = Math.round;
  return {
    swiss: r(swiss),
    swissOld: r(gross * a0),
    grossEur: r(grossEur),
    base: r(base),
    irpef: r(irpef),
    swissEur: r(swissEur),
    credit: r(credit),
  };
}

test('la catena ricalcolata con tabella R0 2026 e IRPEF 2026 dà i valori pubblicati', () => {
  assert.deepEqual(marco(), {
    swiss: 2700,
    swissOld: 3400,
    grossEur: 53400,
    base: 43400,
    irpef: 11522,
    swissEur: 2884,
    credit: 2344,
  });
  assert.equal(Math.round(1 / 0.93629 * 1000) / 1000, 1.068, 'cambio BNS agosto 2026');
});

test('il registro marca il refresh fattuale con updatedAt', () => {
  const registry = fs.readFileSync(path.join(ROOT, 'content', 'blog-articles-data.ts'), 'utf8');
  assert.match(registry, new RegExp(`id: '${SLUG}'[\\s\\S]{0,160}updatedAt: '${REFRESHED_ON}'`));
});

const DATES = {
  it: [/17 luglio 2023/, /1° gennaio 2024/, /31 dicembre 2023/, /31 dicembre 2018/, /30 settembre/, /2 novembre/],
  en: [/17 July 2023/, /1 January 2024/, /December 31, 2023/, /31 December 2018/, /30 September/, /2 November/],
  de: [/17\. Juli 2023/, /1\. Januar 2024/, /31\. Dezember 2023/, /31\. Dezember 2018/, /30\. September/, /2\. November/],
  fr: [/17 juillet 2023/, /1er janvier 2024/, /31 décembre 2023/, /31 décembre 2018/, /30 septembre/, /2 novembre/],
};

const SALARY_CERTIFICATE = {
  it: /certificato di salario/,
  en: /salary certificate/,
  de: /Lohnausweis/,
  fr: /certificat de salaire/,
};

for (const locale of LOCALES) {
  test(`${locale}: tariffe 2026, esempio ricalcolato, scadenze e fonti ufficiali`, () => {
    const source = bodySource(locale);
    for (const n of [5040, 4020, ...Object.values(marco())]) {
      assert.match(source, amount(n, locale), `manca ${n}`);
    }
    for (const r of [8.4, 6.7, 6.8, 5.4]) {
      assert.match(source, rate(r, locale), `manca l'aliquota ${r}%`);
    }
    assert.match(source, /A0/);
    assert.match(source, /R0/);
    assert.match(source, /23 ?%/);
    assert.match(source, /33 ?%/);
    assert.match(source, /43 ?%/);
    assert.match(source, /199\/2025/, 'legge di bilancio 2026');
    assert.match(source, /1[.,]068 EUR/, 'cambio dichiarato');
    for (const d of DATES[locale]) assert.match(source, d);
    assert.match(source, SALARY_CERTIFICATE[locale]);
    assert.match(source, /www4\.ti\.ch\/dfe\/dc\/dichiarazione\/imposte-alla-fonte-1\/tabelle-di-calcolo-dellimposta-alla-fonte/);
    assert.match(source, /comunicati-stampa\.msg-id-96751\.html/);
    assert.match(source, /Circolare\+Smart\+working\+e\+Frontalieri\+18\+ago\+2023\.pdf/);
    assert.match(source, /agenziaentrate\.gov\.it\/portale\/imposta-sul-reddito-delle-persone-fisiche-irpef-\/aliquote-e-calcolo-dell-irpef/);
    assert.match(source, /agenziaentrate\.gov\.it\/portale\/quando-e-come-presentare-il-730-2026-cittadini/);
    assert.match(source, /quando-e-come-presentare-il-modello-redditi-persone-fisiche/);
    assert.match(source, /estv\.admin\.ch\/it\/certificato-di-salario-e-attestazione-delle-rendite/);
  });

  test(`${locale}: nessun valore superato o attribuzione errata`, () => {
    const source = bodySource(locale);
    for (const stale of [7500, 6250, 1500]) {
      assert.doesNotMatch(source, amount(stale, locale), `valore obsoleto ${stale}`);
    }
    assert.doesNotMatch(source, /12[.,]5 ?%/, 'aliquota «a Lugano» senza fonte');
    assert.doesNotMatch(source, /35 ?%/, 'secondo scaglione IRPEF pre-2026');
    assert.doesNotMatch(source, /Certificazione Unica|Einheitliche Bescheinigung/, 'documento italiano attribuito al datore svizzero');
    assert.doesNotMatch(source, /maggio e giugno|May and June|Mai und Juni|mai et juin/, 'scadenze superate');
    assert.doesNotMatch(source, /31 dicembre 2022|December 31, 2022|31\. Dezember 2022|31 décembre 2022/, 'fine del vecchio regime errata');
    assert.doesNotMatch(source, /operativo nel 2026|operational by 2026|2026 vollständig umgesetzt|opérationnel en 2026/, 'applicazione dal 2024, non dal 2026');
    assert.doesNotMatch(source, /imposizione\*\*? attenuata|double taxation attenuated|mitigated double taxation|gemilderten Doppelbesteuerung|Doppelbesteuerung abgeschwächt|imposition\*\*? atténué/, 'la doppia imposizione è eliminata, non attenuata');
    assert.doesNotMatch(source, /Dal 2023|Since 2023|Seit 2023|Depuis 2023/, 'decorrenza del nuovo regime');
  });
}
