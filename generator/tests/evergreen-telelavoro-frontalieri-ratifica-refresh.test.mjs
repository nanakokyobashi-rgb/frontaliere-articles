import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Refresh #1841, residuo della PR #1838 (#1790). Due articoli sul telelavoro
// dei frontalieri contraddicevano i fatti verificati per
// `smart-working-frontalieri-2026`, e questo test riusa gli stessi valori e le
// stesse fonti.
//
// `frontalieri-telelavoro-2026` dava la legge 29.12.2025 n. 217 «in vigore dal
// 1° gennaio 2027», una normativa «entrata in vigore il 1° gennaio 2023» con
// una «legge federale del 15 dicembre 2022» sul lavoro, e imponeva una
// «richiesta alla propria amministrazione fiscale entro il 31 dicembre 2026»,
// con una soglia di reddito di 150.000 franchi e redditi «senza tasse».
// Nessuna di queste regole esiste. Il Protocollo di modifica dell'Accordo del
// 2020 e' in vigore dal 9.2.2026 e si applica dall'1.1.2024 (Consiglio
// federale, 13.2.2026; testo del Protocollo, art. II). Il 25% vale sull'anno
// civile, non sulla singola giornata, e non richiede alcuna domanda. Entro la
// quota il salario del telelavoro si tassa come lavoro svolto in Svizzera
// (punto 2.2): non e' un'esenzione.
//
// `telelavoro-italia-svizzera-ratifica` e' una notizia datata (laRegione,
// 13.2.2026): corretti solo gli errori evidenti. La ratifica italiana e' la
// legge 29.12.2025 n. 217, non un atto del 13.2.2026, e il Protocollo non
// disciplina i contributi, che seguono l'accordo quadro sul telelavoro (UFAS).
// Il limite corrisponde a circa 55 giorni su 220, non a «circa 50». Oltre il
// 25% cambia lo status, non la sola tassazione delle «ore extra». La FAQ
// imponeva una comunicazione delle ore all'«Ufficio Imposte del DFE», ma lo
// scambio dell'art. 7 dell'Accordo non contiene le giornate. Gli unici
// obblighi documentati sono il certificato A1 (UFAS) e, in Ticino,
// l'attestazione su richiesta dei giorni di telelavoro alla cessazione in
// corso d'anno (art. 5a RFLT, DFE 13.1.2025). Fonti:
// https://www.admin.ch/it/newnsb/KIyFJwwqspqaOcHDaT7u0
// https://www.newsd.admin.ch/newsd/message/attachments/88035.pdf
// https://www.fiscooggi.it/portale/-/accordo-frontalieri-italia-svizzera-ratificato-l-aggiornamento-sul-telelavoro
// https://www.bsv.admin.ch/it/telelavoro
// https://www4.ti.ch/tich/area-media/comunicati/dettaglio-comunicato?NEWS_ID=247871
// https://www4.ti.ch/fileadmin/DFE/DC/DOC-IF/nuovo_accordo/Scambio_automatico_di_informazioni_CH-I.pdf

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const GUIDE = 'frontalieri-telelavoro-2026';
const NEWS = 'telelavoro-italia-svizzera-ratifica';
const LOCALES = ['it', 'en', 'de', 'fr'];
const REFRESHED_ON = '2026-09-25';

const IN_FORCE = /9\.? (?:febbraio|Februar|février|February) 2026/;
const APPLIES_FROM = /1(?:°|er|\.)? (?:gennaio|Januar|janvier|January) 2024/;
const LAW_DATE = /29\.? (?:dicembre|Dezember|décembre|December) 2025/;
const DAYS_55 = /55 (?:giorni|Tage|Tagen|jours|days)/;
const ADMIN_CH = /admin\.ch\/(?:it|de|fr|en)\/newnsb\/KIyFJwwqspqaOcHDaT7u0/;
const PROTOCOL_PDF = /newsd\.admin\.ch\/newsd\/message\/attachments\/88035\.pdf/;
const DFE_5A = /ti\.ch\/tich\/area-media\/comunicati\/dettaglio-comunicato\?NEWS_ID=247871/;
const EXCHANGE_PDF = /Scambio_automatico_di_informazioni_CH-I\.pdf/;
const BSV_URL = /bsv\.admin\.ch\/(?:it\/telelavoro|de\/telearbeit|fr\/teletravail)/;

function bodySource(locale, slug) {
  return fs.readFileSync(path.join(ROOT, 'content', 'blog-body', locale, `${slug}.ts`), 'utf8');
}

function faqAnswers(source, slug) {
  const match = source.match(new RegExp(`'blog\\.article\\.${slug}\\.faq': '(.*)',\\s*$`, 'm'));
  assert.ok(match, `FAQ di ${slug} non trovata`);
  return JSON.parse(match[1].replace(/\\'/g, "'")).map((entry) => entry.a);
}

test('le due voci del registro portano la data del refresh fattuale', () => {
  const registry = fs.readFileSync(path.join(ROOT, 'content', 'blog-articles-data.ts'), 'utf8');
  for (const slug of [GUIDE, NEWS]) {
    assert.match(registry, new RegExp(`id: '${slug}'[\\s\\S]{0,160}updatedAt: '${REFRESHED_ON}'`), slug);
  }
});

for (const locale of LOCALES) {
  test(`${locale} ${GUIDE}: date del Protocollo, 25% sull'anno civile e fonti ufficiali`, () => {
    const source = bodySource(locale, GUIDE);
    assert.match(source, IN_FORCE, 'Protocollo in vigore dal 9.2.2026');
    assert.match(source, APPLIES_FROM, 'applicabile dall\'1.1.2024');
    assert.match(source, LAW_DATE, 'legge di ratifica 29.12.2025');
    assert.match(source, /217/, 'legge n. 217');
    assert.match(source, /\*\*25\s?%\*\*/, 'soglia del 25% in evidenza');
    assert.match(source, DAYS_55, '25% di 220 giorni');
    for (const url of [ADMIN_CH, PROTOCOL_PDF, DFE_5A, EXCHANGE_PDF, BSV_URL]) {
      assert.match(source, url);
    }
  });

  test(`${locale} ${GUIDE}: niente richiesta, niente 2027, niente esenzione`, () => {
    const source = bodySource(locale, GUIDE);
    assert.doesNotMatch(source, /2027/, 'entrata in vigore 2027 inventata');
    assert.doesNotMatch(source, /31\.? (?:dicembre|Dezember|décembre|December) 2026|December 31, 2026/, 'termine di richiesta inventato');
    assert.doesNotMatch(source, /(?:gennaio|Januar|janvier|January) 2023/, 'entrata in vigore 2023 inventata');
    assert.doesNotMatch(source, /15\.? (?:dicembre|Dezember|décembre|December) 2022/, 'legge federale inventata');
    assert.doesNotMatch(source, /150[.,' ]?(?:\\')?000|45[.,' ]?(?:\\')?000|37[.,]500/, 'soglie e importi esenti inventati');
    assert.doesNotMatch(
      source,
      /senza dover pagare le tasse|without having to pay taxes|ohne Steuern (?:auf|zahlen)|sans avoir à payer d(?:\\')?'?impôts/,
      'il telelavoro entro il 25% non e\' un\'esenzione',
    );
    assert.doesNotMatch(source, /[234] (?:ore|hours|Stunden|heures) (?:al|a|am|par) (?:giorno|day|Tag|jour)/, 'limite giornaliero inventato');
    assert.doesNotMatch(source, /permesso di lavoro speciale/, 'permesso speciale inventato');
    const answers = faqAnswers(source, GUIDE);
    assert.doesNotMatch(answers[0], /^(?:Presentare una richiesta|Submit a request|Bitte reichen Sie|Déposer une demande)/);
    assert.match(answers[0], /A1/);
    assert.match(answers[2], IN_FORCE);
  });

  test(`${locale} ${GUIDE}: obblighi documentati (A1, art. 5a, art. 7)`, () => {
    const source = bodySource(locale, GUIDE);
    assert.match(source, /49[.,]9\s?%/, 'fascia A1 fino al 49,9%');
    assert.match(source, /\bA1\b/);
    assert.match(source, /\b5a\b/, 'art. 5a RFLT');
    assert.match(source, /\b7\b[^.]{0,40}(?:Accordo|Abkommens|Accord|Agreement)/, 'art. 7 dell\'Accordo del 2020');
  });

  test(`${locale} ${NEWS}: date della ratifica e dell'entrata in vigore`, () => {
    const source = bodySource(locale, NEWS);
    assert.match(source, IN_FORCE, 'Protocollo in vigore dal 9.2.2026');
    assert.match(source, APPLIES_FROM, 'applicabile dall\'1.1.2024');
    assert.match(source, LAW_DATE, 'legge di ratifica 29.12.2025');
    assert.match(source, /217/, 'legge n. 217');
    assert.doesNotMatch(source, /\*\*Quando\*\*:[^\n]{0,30}13\.? (?:febbraio|Februar|février|February) 2026/, 'la ratifica non e\' del 13.2.2026');
    assert.doesNotMatch(source, /pienamente operativo|fully operational|vollständigen Umsetzung|pleinement opérationnel/);
    for (const url of [ADMIN_CH, PROTOCOL_PDF, DFE_5A, BSV_URL]) {
      assert.match(source, url);
    }
  });

  test(`${locale} ${NEWS}: FAQ senza comunicazione delle ore ne 50 giorni`, () => {
    const source = bodySource(locale, NEWS);
    const answers = faqAnswers(source, NEWS);
    assert.equal(answers.length, 5);
    assert.match(answers[1], DAYS_55, '25% di 220 giorni');
    assert.doesNotMatch(source, /\b50 (?:giorni|working days|Arbeitstage|Arbeitstagen|jours)/);
    assert.match(answers[3], /\b5a\b/, 'art. 5a RFLT');
    assert.match(answers[3], /\bA1\b/);
    assert.match(answers[3], /\b7\b/, 'art. 7 dell\'Accordo');
    assert.doesNotMatch(
      source,
      /comunicazione all'Ufficio Imposte|communication to the Tax Office|Mitteilung an das Finanzamt|communication au bureau des impôts/,
      'nessun obbligo di comunicare le ore al fisco ticinese',
    );
    assert.doesNotMatch(
      source,
      /vanno segnalate nella dichiarazione|reported in the tax return|in der Steuererklärung angegeben|déclarées dans la déclaration/,
    );
    assert.doesNotMatch(source, /ore extra|extra hours|zusätzliche Stunden|heures supplémentaires/, 'oltre il 25% cambia lo status');
    assert.doesNotMatch(source, /border guard/, 'frontaliere non e\' guardia di confine');
  });
}
