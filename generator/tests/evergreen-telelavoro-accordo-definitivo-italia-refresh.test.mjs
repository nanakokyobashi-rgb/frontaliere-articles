import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Correzione #1854, gemello delle PR #1838 (#1790) e #1849 (#1841).
// `telelavoro-accordo-definitivo-italia` e' una notizia datata (laRegione,
// 13.2.2026): sono corretti solo gli errori fattuali evidenti, con gli stessi
// valori e le stesse fonti delle due PR.
//
// L'articolo presentava come regola vigente un limite di telelavoro del 40%,
// con «tassazione esclusiva in Svizzera se sotto la soglia del 40%». Il 40%
// valeva solo nel regime transitorio 1.2-31.12.2023 (MEF, 28.11.2023). Dal
// 1.1.2024 il limite e' il 25% del tempo di lavoro nell'anno civile (punto 2.2
// del Protocollo, applicabile dall'1.1.2024 per l'art. II, in vigore dal
// 9.2.2026). Entro il 25% il salario si tassa come lavoro svolto in Svizzera:
// in modo esclusivo solo per i frontalieri del regime transitorio (art. 9
// dell'Accordo del 2020, finestra 31.12.2018-17.7.2023), mentre per i nuovi
// frontalieri resta l'imposizione concorrente, con l'imposta svizzera limitata
// all'80% di quella ordinaria (non all'80% del reddito, ne' un 80/20) e
// l'Italia che tassa ed elimina la doppia imposizione (art. 3). La ratifica
// italiana e' la legge 29.12.2025 n. 217, non un voto del 13.2.2026. Oltre il
// 25% cambia lo status di frontaliere (formulazione della PR #1838). Fonti:
// https://www.admin.ch/it/newnsb/KIyFJwwqspqaOcHDaT7u0
// https://www.newsd.admin.ch/newsd/message/attachments/88035.pdf
// https://www.fiscooggi.it/portale/-/accordo-frontalieri-italia-svizzera-ratificato-l-aggiornamento-sul-telelavoro
// https://www.mef.gov.it/inevidenza/Frontalieri-accordo-Italia-Svizzera-telelavoro-fino-al-25-dal-1-gennaio-2024/
// https://www.fedlex.admin.ch/eli/cc/2023/410/it
// https://www.bsv.admin.ch/it/telelavoro

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SLUG = 'telelavoro-accordo-definitivo-italia';
const LOCALES = ['it', 'en', 'de', 'fr'];
const REFRESHED_ON = '2026-09-25';

const IN_FORCE = /9\.? (?:febbraio|Februar|février|February) 2026/;
const APPLIES_FROM = /1(?:°|er|\.)? (?:gennaio|Januar|janvier|January) 2024/;
const LAW_DATE = /29\.? (?:dicembre|Dezember|décembre|December) 2025/;
const DAYS_55 = /55 (?:giorni|Tage|Tagen|jours|days)/;
const SWISS_CAP_80 = /(?:al massimo (?:l|all)\\'|at most |höchstens |au maximum )80\s?%/;
// Nel sorgente TS gli apostrofi sono `\\'`; nelle FAQ, gia' decodificate, no.
const SWISS_CAP_80_TEXT = /(?:al massimo (?:l|all)'|at most |höchstens |au maximum )80\s?%/;
const OLD_WINDOW = {
  it: /tra il 31 dicembre 2018 e il 17 luglio 2023/,
  en: /between December 31, 2018 and July 17, 2023/,
  de: /zwischen dem 31\. Dezember 2018 und dem 17\. Juli 2023/,
  fr: /entre le 31 décembre 2018 et le 17 juillet 2023/,
};
const SOURCES = [
  /admin\.ch\/(?:it|de|fr|en)\/newnsb\/KIyFJwwqspqaOcHDaT7u0/,
  /newsd\.admin\.ch\/newsd\/message\/attachments\/88035\.pdf/,
  /fiscooggi\.it\/portale\/-\/accordo-frontalieri-italia-svizzera-ratificato-l-aggiornamento-sul-telelavoro/,
  /mef\.gov\.it\/inevidenza\/Frontalieri-accordo-Italia-Svizzera-telelavoro-fino-al-25-dal-1-gennaio-2024/,
  /fedlex\.admin\.ch\/eli\/cc\/2023\/410\/(?:it|de|fr)/,
  /bsv\.admin\.ch\/(?:it\/telelavoro|de\/telearbeit|fr\/teletravail)/,
];

function read(...parts) {
  return fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
}

function bodySource(locale) {
  return read('content', 'blog-body', locale, `${SLUG}.ts`);
}

function faq(source) {
  const match = source.match(new RegExp(`'blog\\.article\\.${SLUG}\\.faq': '(.*)',\\s*$`, 'm'));
  assert.ok(match, 'FAQ non trovata');
  return JSON.parse(match[1].replace(/\\'/g, "'"));
}

// Ogni «40%» rimasto deve riferirsi al regime transitorio 2023 o a un esempio
// («circa il 40%»), mai alla soglia vigente.
function assertFortyOnlyAsHistoryOrExample(text, label) {
  for (const match of text.matchAll(/40\s?%/g)) {
    const window = text.slice(Math.max(0, match.index - 160), match.index + 160);
    assert.match(
      window,
      /2023|circa il 40|about 40|etwa 40|environ 40/,
      `${label}: 40% presentato come soglia vigente: «${window}»`,
    );
  }
}

test('la voce del registro porta la data del refresh fattuale', () => {
  const registry = read('content', 'blog-articles-data.ts');
  assert.match(registry, new RegExp(`id: '${SLUG}'[\\s\\S]{0,200}updatedAt: '${REFRESHED_ON}'`));
});

for (const locale of LOCALES) {
  test(`${locale}: soglia del 25% dal 2024, il 40% solo come regime transitorio 2023`, () => {
    const source = bodySource(locale);
    assert.match(source, /\*\*25\s?%/, 'soglia del 25% in evidenza');
    assert.match(source, APPLIES_FROM, 'applicabile dall\'1.1.2024');
    assertFortyOnlyAsHistoryOrExample(source, locale);
    assert.doesNotMatch(source, /104 (?:giorni|days|Tage|jours)/, '40% di 260 giorni');
  });

  test(`${locale}: ratifica con la legge 217/2025 e Protocollo in vigore dal 9.2.2026`, () => {
    const source = bodySource(locale);
    assert.match(source, IN_FORCE);
    assert.match(source, LAW_DATE);
    assert.match(source, /217/);
    assert.doesNotMatch(
      source,
      /\*\*(?:Data accordo|Abkommen ratifiziert|Date ratification)\*\*: 13/,
      'la ratifica non e\' del 13.2.2026',
    );
    assert.doesNotMatch(
      source,
      /(?:In data|On|Am|Le) \*\*13\.? (?:febbraio|February|Februar|février) 2026\*\*/,
      'il Parlamento non ha votato il 13.2.2026',
    );
    assert.doesNotMatch(source, /ratifié le 13\/02\/2026/);
  });

  test(`${locale}: vecchi frontalieri in esclusiva, nuovi in imposizione concorrente`, () => {
    const source = bodySource(locale);
    assert.match(source, OLD_WINDOW[locale], 'finestra del regime transitorio (art. 9)');
    assert.match(source, SWISS_CAP_80, 'imposta svizzera al massimo l\'80% di quella ordinaria');
    assert.doesNotMatch(
      source,
      /assunt[io] (?:dopo|prima)|hired (?:after|before)|eingestellt|embauchés? (?:après|avant)/,
      'lo status dipende dalla finestra 2018-2023, non dall\'assunzione',
    );
    assert.doesNotMatch(
      source,
      /80\s?% (?:del reddito|of the income|des Einkommens|du revenu)|80\s?%,? (?:Italia|Italy|Italie) 20|(?:Svizzera|Switzerland|Schweiz|Suisse) 80\s?%, (?:Italia|Italy|Italien|Italie) 20|80\s?% (?:Svizzera|Suisse|Switzerland|Schweiz), (?:100|20)/,
      'l\'80% riguarda l\'imposta, non il reddito',
    );
    assert.doesNotMatch(
      source,
      /esclusivamente in Svizzera se sotto|exclusively in Switzerland if below|Imposition exclusive en Suisse sous|potestà impositiva resta interamente|taxing right remains entirely|Besteuerungsrecht verbleibt vollständig|pouvoir d\\'imposition reste entièrement/,
      'la tassazione esclusiva vale solo per i vecchi frontalieri',
    );
  });

  test(`${locale}: oltre il 25% cambia lo status, niente ripartizione inventata`, () => {
    const source = bodySource(locale);
    assert.match(source, /caso per caso|case by case|Einzelfall|au cas par cas/);
    assert.doesNotMatch(
      source,
      /Italia acquisirà|Italy will acquire|Italien erwirbt|Italie acquerra/,
      'nessuna fonte per la quota italiana sui giorni di telelavoro',
    );
    assert.doesNotMatch(
      source,
      /ripartizione del reddito imponibile|allocation of taxable income|Aufteilung des steuerpflichtigen Einkommens|répartition du revenu imposable/,
    );
  });

  test(`${locale}: FAQ allineate (25%, 55 giorni, A1)`, () => {
    const entries = faq(bodySource(locale));
    assert.equal(entries.length, 5);
    for (const [i, entry] of entries.entries()) {
      assertFortyOnlyAsHistoryOrExample(`${entry.q} ${entry.a}`, `${locale} FAQ ${i + 1}`);
    }
    assert.match(entries[0].a, /25\s?%/);
    assert.match(entries[1].a, SWISS_CAP_80_TEXT, 'nuovi frontalieri: imposta svizzera al massimo l\'80%');
    assert.match(entries[1].a, OLD_WINDOW[locale]);
    assert.match(entries[2].q, /25\s?%/);
    assert.match(entries[2].a, DAYS_55, '25% di 220 giorni');
    assert.match(entries[3].q, /25\s?%/);
    assert.match(entries[3].a, /\bA1\b/);
    assert.match(entries[3].a, /49[.,]9\s?%/);
    assert.match(entries[4].a, /25\s?%/);
  });

  test(`${locale}: fonti ufficiali citate`, () => {
    const source = bodySource(locale);
    for (const url of SOURCES) {
      assert.match(source, url);
    }
    assert.match(source, /laRegione/, 'la fonte giornalistica originale resta');
  });

  test(`${locale}: excerpt senza la soglia del 40%`, () => {
    const meta = read('content', `blog-meta-${locale}.ts`);
    const line = meta.split('\n').find((l) => l.includes(`'blog.article.${SLUG}.excerpt'`));
    assert.ok(line, 'excerpt non trovato');
    assert.doesNotMatch(line, /40\s?%/);
    assert.match(line, /25\s?%/);
  });
}

test('en: i fatti chiave sono in inglese', () => {
  const source = bodySource('en');
  assert.doesNotMatch(source, /\*\*(?:Data accordo|Soglia telelavoro|Vecchi frontalieri|Nuovi frontalieri|Superamento soglia)\*\*/);
  assert.doesNotMatch(source, /rimborso tasse|tax refunds/, 'i ristorni non sono un rimborso al lavoratore');
});

test('seo: description e ogDescription senza la soglia del 40%', () => {
  const seo = read('content', 'seo', 'seo-blog.ts');
  const start = seo.indexOf(`'blog-${SLUG}': {`);
  assert.ok(start >= 0, 'voce SEO non trovata');
  const next = seo.indexOf("\n 'blog-", start + 1);
  const block = seo.slice(start, next === -1 ? undefined : next);
  assert.doesNotMatch(block, /40\s?%/);
  assert.match(block, /25\s?%/);
});
