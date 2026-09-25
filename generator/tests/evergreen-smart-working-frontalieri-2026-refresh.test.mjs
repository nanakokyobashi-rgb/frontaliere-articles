import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Refresh #1790 (sito #9629): l'articolo dava come regola 2026 un limite di
// telelavoro del 40% (88 giorni su 220) e lo presentava come aumento rispetto
// a un 25% «iniziale». E' il contrario: il 40% era il regime transitorio
// 1.2.2023-31.12.2023 (MEF, 28.11.2023); dal 1.1.2024 il limite fiscale e' il
// 25% del Protocollo di modifica dell'accordo sui frontalieri, in vigore dal
// 9.2.2026 (Consiglio federale, 13.2.2026; ratifica italiana legge 29.12.2025
// n. 217). La sicurezza sociale e' un piano distinto: accordo quadro
// multilaterale sul telelavoro, < 50% con certificato A1, per l'Italia dal
// 1.1.2024 (UFAS). Il body affermava anche che il datore di lavoro deve
// «monitorare e comunicare» le giornate al fisco italiano: ne' il Protocollo
// ne' l'art. 7 dell'Accordo del 2020 (scambio tra autorita' fiscali: dati
// anagrafici, salario, contributi, imposta alla fonte) lo prevedono. Gli
// obblighi documentati sono il certificato A1 (UFAS) e, in Ticino,
// l'attestazione su richiesta dei giorni di telelavoro alla cessazione in corso
// d'anno (art. 5a RFLT, DFE 13.1.2025). I «ristorni» non sono un'agevolazione
// del lavoratore ma la compensazione finanziaria ai Comuni di confine (art. 9
// dell'Accordo del 2020). Fonti:
// https://www.admin.ch/it/newnsb/KIyFJwwqspqaOcHDaT7u0
// https://www.newsd.admin.ch/newsd/message/attachments/88035.pdf
// https://www.mef.gov.it/inevidenza/Frontalieri-accordo-Italia-Svizzera-telelavoro-fino-al-25-dal-1-gennaio-2024/
// https://www.bsv.admin.ch/it/telelavoro
// https://www4.ti.ch/tich/area-media/comunicati/dettaglio-comunicato?NEWS_ID=247871
// https://www4.ti.ch/fileadmin/DFE/DC/DOC-IF/nuovo_accordo/Scambio_automatico_di_informazioni_CH-I.pdf

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SLUG = 'smart-working-frontalieri-2026';
const LOCALES = ['it', 'en', 'de', 'fr'];
const REFRESHED_ON = '2026-09-25';

const BSV_URL = {
  it: /bsv\.admin\.ch\/it\/telelavoro/,
  de: /bsv\.admin\.ch\/de\/telearbeit/,
  fr: /bsv\.admin\.ch\/fr\/teletravail/,
  en: /bsv\.admin\.ch\/de\/telearbeit/,
};

function bodySource(locale) {
  return fs.readFileSync(path.join(ROOT, 'content', 'blog-body', locale, `${SLUG}.ts`), 'utf8');
}

test('la voce del registro porta la data del refresh fattuale', () => {
  const registry = fs.readFileSync(path.join(ROOT, 'content', 'blog-articles-data.ts'), 'utf8');
  assert.match(registry, new RegExp(`id: '${SLUG}'[\\s\\S]{0,220}updatedAt: '${REFRESHED_ON}'`));
});

for (const locale of LOCALES) {
  test(`${locale}: soglia fiscale 25%, date del Protocollo e fonti ufficiali`, () => {
    const source = bodySource(locale);
    assert.match(source, /\*\*25\s?%/, 'soglia fiscale 25% in evidenza');
    assert.match(source, /9\.? (?:febbraio|Februar|février|February) 2026/, 'entrata in vigore del Protocollo');
    assert.match(source, /1(?:°|er|\.)? (?:gennaio|Januar|janvier|January) 2024/, 'applicazione dal 2024');
    assert.match(source, /217/, 'legge italiana di ratifica n. 217');
    assert.match(source, /55 (?:giorni|giornate|Tage|Tagen|jours|days)/, '25% di 220 giorni');
    assert.match(source, /admin\.ch\/(?:it|de|fr|en)\/newnsb\/KIyFJwwqspqaOcHDaT7u0/);
    assert.match(source, /mef\.gov\.it\/inevidenza\/Frontalieri-accordo-Italia-Svizzera-telelavoro-fino-al-25-dal-1-gennaio-2024/);
    assert.match(source, BSV_URL[locale]);
  });

  test(`${locale}: sicurezza sociale distinta dal fisco (A1, meno del 50%)`, () => {
    const source = bodySource(locale);
    assert.match(source, /49[.,]9\s?%/, 'tetto previdenziale sotto il 50%');
    assert.match(source, /A1/, 'certificato A1');
    assert.match(source, /883\/2004/, 'Regolamento (CE) n. 883/2004');
    assert.match(source, /1\. Februar bis 31\. Dezember 2023|1° febbraio al 31 dicembre 2023|1er février au 31 décembre 2023|1 February to 31 December 2023/, 'il 40% era il regime transitorio 2023');
  });

  test(`${locale}: obblighi del datore di lavoro verificati, niente obbligo di comunicare le giornate`, () => {
    const source = bodySource(locale);
    assert.match(source, /\b5a\b/, 'art. 5a del regolamento ticinese sull\'imposta alla fonte');
    assert.match(source, /\b7\b[^.]{0,40}(?:Accordo|Abkommens|accord|agreement)/, 'art. 7 dell\'Accordo del 2020');
    assert.match(source, /newsd\.admin\.ch\/newsd\/message\/attachments\/88035\.pdf/, 'testo del Protocollo');
    assert.match(source, /ti\.ch\/tich\/area-media\/comunicati\/dettaglio-comunicato\?NEWS_ID=247871/, 'DFE Ticino 13.1.2025');
    assert.match(source, /Scambio_automatico_di_informazioni_CH-I\.pdf/, 'Divisione delle contribuzioni, scambio automatico');
    assert.doesNotMatch(
      source,
      /monitorare e comunicare|überwachen und (?:zu )?melden|surveiller et de communiquer|Surveillance et communication|[Mm]onitor and (?:report|communicate)/,
      'obbligo di comunicare le giornate non documentato da fonti ufficiali',
    );
    assert.doesNotMatch(source, /"a":"(?:Sì|Ja|Oui|Yes), (?:il datore|der Arbeitgeber|l\\'employeur|the employer)/);
    assert.doesNotMatch(
      source,
      /agevolazioni fiscali come i ristorni|Vergünstigungen wie Rückerstattungen|avantages fiscaux tels que les remboursements|tax benefits, such as reimbursements/,
      'i ristorni non sono un\'agevolazione del lavoratore',
    );
  });

  test(`${locale}: niente 40% come regola vigente ne 88 giorni`, () => {
    const source = bodySource(locale);
    assert.doesNotMatch(source, /\b88\b/, '88 giorni = 40% di 220');
    assert.doesNotMatch(source, /40\s?%-(?:Grenze|Schwelle)|(?:soglia|limite|seuil|limit|threshold) (?:del |de |of )?40\s?%|40\s?% (?:threshold|annual)/, '40% presentato come soglia');
    assert.doesNotMatch(source, /\*\*40\s?%/, '40% in evidenza');
    assert.doesNotMatch(source, /aumento rispetto al limite del 25%|Anstieg im Vergleich zur ursprünglich|augmentation significative par rapport|significant increase from the initial 25%/);
  });
}
