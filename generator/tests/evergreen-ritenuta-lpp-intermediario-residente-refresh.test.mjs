import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Correzione fattuale di `ritenuta-lpp-intermediario-residente` (corpus #1855).
// È una notizia datata (legge di bilancio 2023), non una guida: si correggono
// solo gli errori evidenti. L'articolo attribuiva il 5% alla «normativa fiscale
// svizzera», lo collocava in Svizzera e diceva che la ritenuta si applica
// «direttamente» anche senza intermediario, senza altri adempimenti né
// scadenze. Fatti corretti, con fonte:
// - il 5% è italiano: ritenuta a titolo d'imposta dell'intermediario italiano
//   che interviene nel pagamento, su incarico del beneficiario (art. 76,
//   comma 1-bis, L. 413/1991; risoluzione AdE 3/E/2020); senza intermediario,
//   imposta sostitutiva del 5% (comma 1-ter, da L. 197/2022 art. 1 c. 77)
//   autoliquidata in dichiarazione, quadro RM, e versata con F24 (risposta AdE
//   n. 125/2024);
// - prima del comma 1-ter, senza intermediario il 5% non si applicava
//   (risoluzione 3/E/2020);
// - in Svizzera: rendite LPP di diritto privato senza imposta alla fonte per i
//   residenti in Italia; sulle prestazioni in capitale imposta alla fonte del
//   Cantone di sede (Ticino: tabella VIC), rimborsabile con il modulo Q-IS entro
//   3 anni se l'Italia ha tassato (art. 18 CDI; promemoria AFC 2025).

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SLUG = 'ritenuta-lpp-intermediario-residente';
const LOCALES = ['it', 'en', 'de', 'fr'];
const REFRESHED_ON = '2026-09-25';

const SOURCES = [
  /normattiva\.it\/uri-res\/N2Ls\?urn:nir:stato:legge:1991-12-30;413~art76/,
  /normattiva\.it\/uri-res\/N2Ls\?urn:nir:stato:legge:2022-12-29;197/,
  /Risoluzione_3_del_27_01_2020\.pdf/,
  /Risposta\+n\.\+125_2024\.pdf/,
  /fedlex\.admin\.ch\/eli\/cc\/1979\/461_461_461/,
  /merkblatt-estv-vorsorge-privatrechtlich-ab-2025\.pdf/,
  /estv\.admin\.ch\/dam\/it\/sd-web\/GaTvEbTDJpY5\/Form-Q-IS-2026-05-it\.pdf/,
  /Tabelle_VIC_2025_PERSONE_SOLE\.pdf/,
];

// Affermazioni errate del testo originale, per lingua. Nel sorgente TS
// l'apostrofo ASCII è scritto `\'`.
const WRONG = Object.freeze({
  it: [
    'Normativa fiscale svizzera',
    'La normativa fiscale svizzera prevede',
    'Dove: Svizzera',
    'Recentemente, è stato chiarito',
    'non è necessario intraprendere ulteriori azioni fiscali',
    'Non ci sono scadenze specifiche',
    'viene applicata direttamente sulle prestazioni',
    'vedrà applicata la ritenuta del 5% direttamente',
    'in presenza di un intermediario residente.',
  ],
  en: [
    'Swiss tax regulations provide for a 5%',
    '- Swiss tax regulations',
    'Where: Switzerland',
    'Recently, it has been clarified',
    'no further tax actions',
    'There are no specific deadlines',
    'is applied directly to LPP benefits',
    'will see the 5% withholding applied directly',
    'when a resident intermediary was involved',
  ],
  de: [
    'Schweizer Steuergesetzgebung',
    'Wo: Schweiz',
    'Kürzlich wurde klargestellt',
    'in der Schweiz ansässiger Vermittler',
    'keine weiteren steuerlichen Maßnahmen',
    'keine spezifischen Fristen',
    'direkt auf die LPP-Leistungen erhoben',
    'direkt auf die Dienstleistungen angezogen',
    'in Anwesenheit eines ansässigen Vermittlers.',
  ],
  fr: [
    'Réglementation fiscale suisse',
    'La réglementation fiscale suisse prévoit',
    'Où: Suisse',
    'Récemment, il a été clarifié',
    'd\\\'entreprendre d\\\'autres actions fiscales',
    'pas de délais spécifiques',
    'est appliquée directement sur les prestations',
    'verra appliquer la retenue de 5 % directement',
    'en présence d\\\'un intermédiaire résidente',
  ],
});

// Il 5% collocato in Italia nei «Fatti chiave».
const WHERE_ITALY = Object.freeze({
  it: /- Dove: Italia\\n/,
  en: /- Where: Italy\\n/,
  de: /- Wo: Italien\\n/,
  fr: /- Où: Italie\\n/,
});

// Distinzione fra ritenuta dell'intermediario e imposta sostitutiva.
const SUBSTITUTE_TAX = Object.freeze({
  it: /imposta sostitutiva/,
  en: /substitute tax/,
  de: /Ersatzsteuer/,
  fr: /impôt de substitution/,
});

function bodySource(locale) {
  return fs.readFileSync(path.join(ROOT, 'content', 'blog-body', locale, `${SLUG}.ts`), 'utf8');
}

test('il registry data la correzione fattuale di ritenuta-lpp-intermediario-residente', () => {
  const registry = fs.readFileSync(path.join(ROOT, 'content', 'blog-articles-data.ts'), 'utf8');
  assert.match(registry, new RegExp(`id: '${SLUG}'[\\s\\S]{0,120}updatedAt: '${REFRESHED_ON}'`));
});

for (const locale of LOCALES) {
  test(`${locale}: il 5% è italiano, con ritenuta (1-bis) o imposta sostitutiva (1-ter)`, () => {
    const source = bodySource(locale);
    assert.match(source, WHERE_ITALY[locale], '«Dove» dei Fatti chiave');
    assert.match(source, /413\/1991/, 'legge 413/1991');
    assert.match(source, /1-bis/, 'art. 76, comma 1-bis: ritenuta dell\'intermediario italiano');
    assert.match(source, /1-ter/, 'art. 76, comma 1-ter: imposta sostitutiva senza intermediario');
    assert.match(source, /197\/2022/, 'legge 197/2022, che ha introdotto il comma 1-ter');
    assert.match(source, SUBSTITUTE_TAX[locale], 'imposta sostitutiva senza intermediario');
    assert.match(source, /3\/E\/2020/, 'risoluzione AdE 3/E/2020');
    assert.match(source, /125\/2024/, 'risposta AdE n. 125/2024');
    assert.match(source, /(?:quadro|schedule|Teil|cadre) RM/, 'autoliquidazione nel quadro RM');
    assert.match(source, /F24/, 'versamento con F24');
  });

  test(`${locale}: lato svizzero con imposta alla fonte VIC e rimborso Q-IS`, () => {
    const source = bodySource(locale);
    assert.match(source, /VIC/, 'tabella VIC del Canton Ticino');
    assert.match(source, /Q-IS/, 'modulo di rimborso AFC');
    assert.match(source, /art\. 18|Art\. 18/, 'art. 18 della convenzione italo-svizzera');
    for (const pattern of SOURCES) assert.match(source, pattern);
  });

  test(`${locale}: niente 5% svizzero, «ritenuta diretta» senza intermediario o assenza di scadenze`, () => {
    const source = bodySource(locale);
    for (const claim of WRONG[locale]) {
      assert.equal(source.includes(claim), false, `affermazione errata ancora presente: ${claim}`);
    }
  });
}
