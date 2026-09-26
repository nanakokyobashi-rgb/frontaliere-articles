/**
 * Refresh evergreen di `lamal-cmi-scelta-frontaliere-2026` (corpus #1761, sito #9628).
 *
 * Fissa nelle quattro lingue i fatti verificati il 2026-09-26 e fallisce se
 * tornano i valori smentiti dalle fonti ufficiali:
 *  - termine dell'opzione: 3 mesi dall'inizio dell'attivita' in Svizzera
 *    (IAS Ticino, UFSP), non "90 giorni dal varco di frontiera";
 *  - premi LAMal 2026 per adulti residenti in Italia: 279.00-487.20 CHF/mese
 *    (UFSP, panoramica dei premi UE/AELS/UK 2026, senza infortuni), non la
 *    stima "350 CHF in Ticino";
 *  - la CMI e' il SSN via esenzione, non una polizza privata "da 180 euro"
 *    con massimali; compartecipazione legge 213/2023 3-6%, 30-200 euro/mese;
 *  - l'ufficio competente e' l'IAS, Ufficio dei contributi (non "UAM");
 *  - con la LAMal il frontaliere si cura anche in Italia (UFSP), non solo
 *    urgenze con la TEAM.
 * I premi 2027 non erano pubblicati alla data del refresh: il body lo dichiara.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SLUG = 'lamal-cmi-scelta-frontaliere-2026';
const LOCALES = ['it', 'en', 'de', 'fr'];
const REFRESHED_ON = '2026-09-26';

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

test('il registry porta updatedAt del refresh fattuale', () => {
  const registry = read('content/blog-articles-data.ts');
  assert.match(
    registry,
    new RegExp(`id: '${SLUG}'[\\s\\S]{0,220}updatedAt: '${REFRESHED_ON}'`),
  );
});

test('i quattro body portano i fatti verificati e le fonti ufficiali', () => {
  for (const locale of LOCALES) {
    const source = read(`content/blog-body/${locale}/${SLUG}.ts`);
    assert.match(source, /\b3 (?:mesi|months|Monate|Monaten|mois)\b/, `${locale}: termine di 3 mesi`);
    assert.match(source, /279\.00/, `${locale}: premio minimo Italia 2026`);
    assert.match(source, /487\.20/, `${locale}: premio massimo Italia 2026`);
    assert.match(source, /213\/2023/, `${locale}: legge di bilancio 2024`);
    assert.match(source, /\b30\b[^.]{0,80}\b200\b/, `${locale}: minimo e massimo mensile`);
    assert.match(source, /IAS/, `${locale}: ufficio competente`);
    assert.match(source, /2027/, `${locale}: premi 2027 dichiarati non ancora pubblicati`);
    assert.match(source, /priminfo\.admin\.ch\/downloads\/gesamtbericht_eu\.pdf/);
    assert.match(source, /bag\.admin\.ch/);
    assert.match(source, /angehoerige-von-grenzgaenger-aus-italien-mit-arbeitsort-ch\.pdf/, `${locale}: caso familiare documentato dal BAG/OFSP`);
    assert.match(source, /(?:nascita di un figlio|birth of a child|Geburt eines Kindes|naissance d.{0,2}un enfant)/i, `${locale}: nuovo diritto di opzione documentato`);
    assert.match(source, /ti\.ch\/fileadmin\/DSS\/IAS/);
    assert.match(source, /gazzettaufficiale\.it/);
    assert.doesNotMatch(source, /(?:Scelta vincolante e irreversibile salvo|Choice for CMI is binding, can only be changed|Nur bei Wechsel des Arbeitgebers|Choix CMI souvent définitif sauf changement)/, `${locale}: eccezione generica non verificata`);
  }
});

test('nessun body ne excerpt ripropone i valori smentiti', () => {
  for (const locale of LOCALES) {
    const source = read(`content/blog-body/${locale}/${SLUG}.ts`);
    assert.doesNotMatch(source, /90 (?:giorni|days|Tage|Tagen|jours)/i, `${locale}: termine 90 giorni`);
    assert.doesNotMatch(source, /180\s*€|€\s*180|180 euro/i, `${locale}: premio CMI inventato`);
    assert.doesNotMatch(source, /\bUAM\b/, `${locale}: ufficio inesistente`);
    assert.doesNotMatch(source, /(?:CHF\s*350|350\s*CHF)/, `${locale}: stima 350 CHF`);
    assert.doesNotMatch(source, /5[.,  ]?000[^.]{0,20}10[.,  ]?000/, `${locale}: massimali CMI inventati`);
    assert.doesNotMatch(source, /20[-–]30 CHF|CHF 20-30/, `${locale}: ticket specialistico inventato`);
    assert.doesNotMatch(source, /Convenzione di Mobilit|Mobility Agreement|Mobilitätskonvention|Convention de Mobilit/i);

    const meta = read(`content/blog-meta-${locale}.ts`);
    const excerpt = meta.split('\n').find((l) => l.includes(`'blog.article.${SLUG}.excerpt'`));
    assert.ok(excerpt, `${locale}: excerpt presente`);
    assert.doesNotMatch(excerpt, /350|180/, `${locale}: excerpt con premi smentiti`);
    assert.match(excerpt, /279/);
  }
});
