import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Refresh #1792 (sito #9629): l'articolo dava la soglia d'entrata LPP del
// 2023-2024 (22'050 CHF) come «valore 2026», calcolava la LPP dell'esempio sul
// lordo invece che sul salario coordinato, citava un contributo di
// solidarieta' AD abolito dal 2023 e, nelle FAQ, un rimborso AVS e un regime
// fiscale che per i frontalieri italiani non esistono piu'. Fonti:
// https://www.bsv.admin.ch/dam/it/sd-web/sAgdISSXenMT/i_Betr%C3%A4ge%202026.pdf
// (UFAS, importi 2026: 22'680 / 26'460), https://www.ahv-iv.ch/p/2.08.i
// (AD dal 2023), https://www.zas.admin.ch/it/rimborso-dei-contributi,
// https://sfbvg.ch/it/compiti/pagamento-in-contanti-in-caso-di-partenza-per-lestero,
// https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf
// (AFC: accordo sui frontalieri in vigore dal 17 luglio 2023, applicato dal
// 1° gennaio 2024, nuovi frontalieri all'80% dell'imposta alla fonte) e
// https://www.ti.ch/iasticino (sito dell'IAS: il vecchio www.ias.ti.ch non
// risolve piu' nel DNS).
// I valori condivisi con `contributi-sociali-busta-paga` sono fissati da
// `evergreen-contributi-sociali-busta-paga-refresh.test.mjs`.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SLUG = 'guida-contributi-sociali-svizzera';
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
  test(`${locale}: importi LPP 2026, esempio ricalcolato e fonti ufficiali`, () => {
    const source = bodySource(locale);
    assert.match(source, /22[.,' \\]{1,2}680/, "soglia d'entrata LPP 2026");
    assert.match(source, /26[.,' \\]{1,2}460/, 'deduzione di coordinamento 2026');
    assert.match(source, /39[.,' \\]{1,2}540/, 'salario coordinato annuo dell\'esempio');
    assert.match(source, /164\.75/, 'quota LPP sul salario coordinato');
    assert.match(source, /582\.75/, 'totale trattenute dell\'esempio');
    assert.match(source, /4[.,' ]?917/, 'netto indicativo dell\'esempio');
    assert.match(source, /bsv\.admin\.ch\/dam\/it\/sd-web\/sAgdISSXenMT\//, 'importi UFAS 2026');
    assert.match(source, /ahv-iv\.ch\/p\/2\.08\.[idf]"/, 'promemoria AD 2.08 esistente');
    assert.match(source, /(?:almeno|mindestens|au moins|at least) 8 (?:ore|Stunden|heures|hours)/, 'soglia INP: almeno 8 ore (art. 13 OAINF)');
    assert.match(source, /17\.? (?:luglio|Juli|juillet|July) 2023/, 'entrata in vigore dell\'accordo sui frontalieri');
    assert.match(source, /80 ?%/, 'nuovi frontalieri: 80% dell\'imposta alla fonte ordinaria');
    assert.match(source, /(?:AELS|EFTA|AELE)/, 'rimborso AVS escluso per i cittadini UE/AELS');
  });

  test(`${locale}: niente valori superati o regimi abrogati`, () => {
    const source = bodySource(locale);
    assert.doesNotMatch(source, /22[.,' \\]{1,2}050/, "soglia LPP 2023-2024");
    assert.doesNotMatch(source, /693/, 'totale trattenute calcolato sul lordo');
    assert.doesNotMatch(source, /4[.,' ]?807/, 'netto calcolato sul lordo');
    assert.doesNotMatch(source, /-(?:CHF )?275\.00/, 'LPP calcolata sul lordo');
    assert.doesNotMatch(source, /contributo di solidariet|Solidarit\u00e4tsbeitrag|cotisation de solidarit|solidarity contribution/, 'contributo di solidarieta\' AD abolito dal 2023');
    assert.doesNotMatch(source, /2\.08\.e/, 'promemoria 2.08 inglese inesistente (404)');
    assert.doesNotMatch(source, /1995/, 'riscatto LPP «dopo il 1995» inventato');
    assert.doesNotMatch(source, /31\.12\.2020/, 'data di assunzione del vecchio regime');
    assert.doesNotMatch(source, /\(IAS\)[^"]{0,40}(?:entro|within|innerhalb|dans un délai)/, 'rimborso AVS presso lo IAS entro 5 anni');
    assert.doesNotMatch(source, /www\.ias\.ti\.ch/, 'dominio IAS che non risolve piu\'');
  });
}
