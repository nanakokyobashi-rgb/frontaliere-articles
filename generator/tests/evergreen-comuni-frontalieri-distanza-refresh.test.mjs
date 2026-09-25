import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Refresh #1801 (sito #9629), fonti verificate il 2026-09-25:
// - Accordo concluso il 23.12.2020, in vigore dal 17.7.2023, applicato dal
//   1.1.2024; nuovi frontalieri tassati in Svizzera all'80% e in Italia con
//   credito d'imposta: https://www.fedlex.admin.ch/eli/cc/2023/410/it e il
//   foglio informativo AFC
//   https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf
// - elenco dei Comuni nella zona di 20 km (procedura amichevole MEF/SFI del
//   22.12.2023, applicata dal 1.1.2024; Misinto n. 195, 17'088 m):
//   https://www.finanze.gov.it/export/sites/finanze/.galleries/Documenti/Varie/20231222-procedura-amichevole-elenco-comuni-frontiera-firmata.pdf
// - i 72 Comuni mai inclusi negli elenchi cantonali (allegato 1 del DL
//   113/2024, Misinto compreso) possono optare dal 2024 per l'imposta
//   sostitutiva del 25% delle imposte svizzere, senza credito d'imposta, se
//   lavoravano in GR/TI/VS tra il 31.12.2018 e il 17.7.2023: art. 6 DL 9 agosto
//   2024, n. 113 (in vigore fino al 31.12.2026), poi art. 221 del Testo unico
//   delle imposte sui redditi (D.Lgs. 19 giugno 2026, n. 117) e il dossier
//   della Camera https://documenti.camera.it/leg19/dossier/pdf/D24113.pdf
// - la risoluzione AdE 38/E del 28.3.2017 non «stabilì» i 20 km (già nel DM
//   sui ristorni): chiarì che non serve il Cantone «frontista».
// - I ristorni vanno ai Comuni di confine, non ai lavoratori; la citazione di
//   Andrea Puglia è quella pubblicata da tvsvizzera.it il 28.2.2026.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SLUG = 'comuni-frontalieri-distanza';
const LOCALES = ['it', 'en', 'de', 'fr'];
const REFRESHED_ON = '2026-09-25';

const DL113_ART6_URL = 'https://www.normattiva.it/uri-res/N2Ls?urn:nir:stato:decreto.legge:2024-08-09;113~art6!vig=2026-09-25';
const TU_ART221_URL = 'https://www.normattiva.it/uri-res/N2Ls?urn:nir:stato:decreto.legislativo:2026-06-19;117~art221';
const DOSSIER_URL = 'https://documenti.camera.it/leg19/dossier/pdf/D24113.pdf';
const RIS38_URL = 'https://def.finanze.it/DocTribFrontend/getContent.do?id=%7B470DA678-E02F-44C2-A3D4-6C947E544DD1%7D';

function bodySource(locale) {
  return fs
    .readFileSync(path.join(ROOT, 'content', 'blog-body', locale, `${SLUG}.ts`), 'utf8')
    .replace(/\\'/g, "'");
}

test('la voce del registro porta la data del refresh fattuale', () => {
  const registry = fs.readFileSync(path.join(ROOT, 'content', 'blog-articles-data.ts'), 'utf8');
  assert.match(registry, new RegExp(`id: '${SLUG}'[\\s\\S]{0,220}updatedAt: '${REFRESHED_ON}'`));
});

const SIGNED = {
  it: /23 dicembre 2020/,
  en: /December 23, 2020/,
  de: /23\. Dezember 2020/,
  fr: /23 décembre 2020/,
};
const MUTUAL_AGREEMENT = {
  it: /procedura amichevole del 22 dicembre 2023/,
  en: /mutual agreement procedure of December 22, 2023/,
  de: /Verständigungsverfahren vom 22\. Dezember 2023/,
  fr: /procédure amiable du 22 décembre 2023/,
};
const LIST_APPLIED = {
  it: /1° gennaio 2024/,
  en: /January 1, 2024/,
  de: /1\. Januar 2024/,
  fr: /1er janvier 2024/,
};
const CREDIT = {
  it: /elimina la doppia imposizione con un credito/,
  en: /eliminat\w+ double taxation (?:with|through) a (?:tax )?credit/,
  de: /beseitigt die Doppelbesteuerung durch/,
  fr: /élimine la double imposition par un crédit/,
};
// Art. 6 DL 113/2024, poi art. 221 TU: 25% delle imposte svizzere, senza
// credito, per chi lavorava in GR/TI/VS tra il 31.12.2018 e il 17.7.2023.
const SUBSTITUTE_TAX = {
  it: [/decreto-legge 9 agosto 2024, n\. 113/, /imposta sostitutiva dell'IRPEF e delle addizionali pari al 25% delle imposte pagate in Svizzera, senza credito d'imposta/, /tra il 31 dicembre 2018 e il 17 luglio 2023/, /articolo 221 del nuovo Testo unico delle imposte sui redditi/, /Dal 1° gennaio 2027/],
  en: [/Decree-Law No\. 113 of August 9, 2024/, /25% of the taxes paid in Switzerland, without a tax credit/, /between December 31, 2018 and July 17, 2023/, /Article 221 of Italy's new Consolidated Income Tax Act/, /From January 1, 2027/],
  de: [/Gesetzesdekrets Nr\. 113 vom 9\. August 2024/, /25 % der in der Schweiz bezahlten Steuern beträgt, ohne Steueranrechnung/, /zwischen dem 31\. Dezember 2018 und dem 17\. Juli 2023/, /Artikel 221 des neuen italienischen Einheitstexts der Einkommensteuern/, /Ab dem 1\. Januar 2027/],
  fr: [/décret-loi italien n° 113 du 9 août 2024/, /25 % des impôts payés en Suisse, sans crédit d'impôt/, /entre le 31 décembre 2018 et le 17 juillet 2023/, /article 221 du nouveau texte unique italien des impôts sur le revenu/, /À partir du 1er janvier 2027/],
};
// Risoluzione 38/E del 28.3.2017: chiarimento, niente Cantone «frontista».
const RESOLUTION_38E = {
  it: /risoluzione n\. 38\/E del 28 marzo 2017 l'Agenzia delle Entrate italiana chiarì/,
  en: /Resolution No\. 38\/E of March 28, 2017 did the Italian Revenue Agency clarify/,
  de: /Resolution Nr\. 38\/E vom 28\. März 2017 stellte die italienische Steuerbehörde klar/,
  fr: /résolution n° 38\/E du 28 mars 2017 que l'Agence des Revenus italienne a précisé/,
};
// Art. 2 lett. b) dell'Accordo: territorio totalmente o parzialmente nei 20 km.
const ART2_DEFINITION = {
  it: /Secondo l'articolo 2 dell'Accordo del 23 dicembre 2020, bisogna risiedere in un Comune il cui territorio si trova, totalmente o parzialmente, entro 20 chilometri/,
  en: /Under Article 2 of the Agreement of December 23, 2020, you must reside in a municipality whose territory lies wholly or partly within 20 kilometers/,
  de: /Nach Artikel 2 des Abkommens vom 23\. Dezember 2020 muss man in einer Gemeinde wohnen, deren Gebiet ganz oder teilweise innerhalb von 20 Kilometern/,
  fr: /Selon l'article 2 de l'Accord du 23 décembre 2020, il faut résider dans une commune dont le territoire se trouve, totalement ou partiellement, à moins de 20 kilomètres/,
};
// I ristorni sono la compensazione versata ai Comuni, non ai lavoratori.
const RISTORNI = {
  it: /ristorni, la compensazione finanziaria che i Cantoni versano ai Comuni italiani di confine/,
  en: /ristorni, the financial compensation the cantons pay to Italian border municipalities/,
  de: /Ristorni verloren, des finanziellen Ausgleichs, den die Kantone an die italienischen Grenzgemeinden zahlen/,
  fr: /ristournes, la compensation financière que les Cantons versent aux Communes italiennes frontalières/,
};
// Citazione pubblicata da tvsvizzera.it il 28.2.2026.
const PUGLIA = {
  it: /'C'è stata enorme confusione\. Abbiamo proposto di applicare la retroattività, ma i Cantoni si sono rifiutati'/,
  en: /'There has been enormous confusion\. We proposed applying retroactivity, but the cantons refused'/,
  de: /'Es gab enorme Verwirrung\. Wir haben vorgeschlagen, die Rückwirkung anzuwenden, aber die Kantone haben abgelehnt\.'/,
  fr: /'Il y a eu une énorme confusion\. Nous avons proposé d'appliquer la rétroactivité, mais les Cantons ont refusé\.'/,
};
const STALE = {
  it: /Accordo fiscale italo-svizzero del 2023|nuovo accordo del 2023|soggetti a doppia imposizione|Doppia imposizione fiscale per nuovi|impatto della doppia imposizione|Agenzia delle Entrate italiana, che ha aggiornato le liste|stabilì il parametro dei 20 chilometri|usufruito dei ristorni|penalizza lavoratori che da anni|Secondo l'Agenzia delle Entrate italiana, per essere/,
  en: /new 2023 agreement|subject to double taxation|impact of double taxation|Revenue Agency, which has updated the official lists|established the 20-kilometer|benefited from the tax refunds|penalizes workers who have contributed|but not recognized as border municipality|According to the Italian Revenue Agency/,
  de: /Abkommen von 2023|doppelt besteuert|'neue' doppelt|unterliegen einer Doppelbesteuerung|Auswirkungen der Doppelbesteuerung|Revenue Agency überprüfen|legte die italienische Steuerbehörde den Parameter|steuerlichen Rückvergütungen|Arbeiter bestraft|kämpft für Anerkennung|Nach Angaben der italienischen Revenue Agency/,
  fr: /nouvel accord de 2023|soumis à une double imposition|Soumis à une double imposition|Double imposition pour les nouveaux|impact de la double imposition|Agence italienne du revenu, qui a mis à jour|a établi le paramètre des 20|ristournes fiscales prévues pour les frontaliers|pénalise des travailleurs|Selon l'Agence italienne du Revenu/,
};

for (const locale of LOCALES) {
  test(`${locale}: data dell'Accordo, elenco ufficiale dei Comuni e fonti`, () => {
    const source = bodySource(locale);
    assert.match(source, SIGNED[locale], 'firma dell\'Accordo il 23.12.2020');
    assert.match(source, /17 luglio 2023|July 17, 2023|17\. Juli 2023|17 juillet 2023/, 'entrata in vigore');
    assert.match(source, MUTUAL_AGREEMENT[locale], 'procedura amichevole sull\'elenco dei Comuni');
    assert.match(source, LIST_APPLIED[locale], 'elenco applicato dal 1.1.2024');
    assert.match(source, /20 k(?:m|ilom)/, 'fascia dei 20 km');
    assert.match(source, CREDIT[locale], 'credito d\'imposta in Italia per i nuovi frontalieri');
    assert.match(source, /fedlex\.admin\.ch\/eli\/cc\/2023\/410\/it/);
    assert.match(source, /finanze\.gov\.it\/[^)]*20231222-procedura-amichevole-elenco-comuni-frontiera-firmata\.pdf/);
    assert.match(source, /estv\.admin\.ch\/dam\/it\/sd-web\/Zbr5Jb-40aYm\/int-laender-it-faktenblatt-faqs-it\.pdf/);
  });

  test(`${locale}: imposta sostitutiva del 25% per i 72 Comuni (art. 6 DL 113/2024, art. 221 TU)`, () => {
    const source = bodySource(locale);
    for (const pattern of SUBSTITUTE_TAX[locale]) assert.match(source, pattern);
    assert.ok((source.match(/\b72\b/g) ?? []).length >= 3, '72 Comuni nel testo, nei fatti chiave e nella nuova regola');
    for (const url of [DL113_ART6_URL, TU_ART221_URL, DOSSIER_URL]) {
      assert.ok(source.includes(url), `fonte ${url}`);
    }
  });

  test(`${locale}: definizione dell'art. 2, risoluzione 38/E, ristorni e citazione`, () => {
    const source = bodySource(locale);
    assert.match(source, ART2_DEFINITION[locale]);
    assert.match(source, RESOLUTION_38E[locale]);
    assert.ok(source.includes(RIS38_URL), 'fonte della risoluzione 38/E');
    assert.match(source, RISTORNI[locale]);
    assert.match(source, PUGLIA[locale]);
  });

  test(`${locale}: niente valori superati`, () => {
    assert.doesNotMatch(bodySource(locale), STALE[locale]);
  });
}
