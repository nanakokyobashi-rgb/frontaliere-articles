import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CLOSING_LABELS, SOURCES, TOPICS } from './corpus-official-source-map.mjs';

const ROOT = process.cwd();
const APPLY = process.argv.includes('--apply');
const LANGS = new Set(['it', 'de', 'fr', 'en']);
const FIELD_RE = /^([ \t]*)(['"])([^'"\n]+\.body\d+)\2([ \t]*:[ \t]*)(['"])((?:\\.|(?!\5)[^\n])*)\5(,?)([ \t]*)$/gm;

const SUMMARY_REPAIRS = {
  'content/blog-body/en/grigioni-frontalieri-italiani-1-6-milioni.ts': {
    key: 'blog.article.grigioni-frontalieri-italiani-1-6-milioni.body1',
    marker: '## In brief',
    text: `## In brief\n- The Switzerland–Italy tax agreement has applied since 1 January 2024.\n- Article 9 keeps qualifying “old frontier workers” taxable exclusively in Switzerland; other workers follow the ordinary Italian regime, with a credit for Swiss tax and Swiss withholding at 80% of ordinary rates.\n- The article reports 1,479 and “1.6 million” but does not state a period, source, or currency for those figures.\n\n## Key facts\n- **What**: Italian cross-border workers in Graubünden and the Switzerland–Italy tax agreement.\n- **When**: The agreement entered into force on 1 January 2024.\n- **Where**: Italy and Switzerland; Article 9 names Graubünden, Ticino, and Valais for its transitional category.\n- **Who**: People residing in Italy and working in Switzerland; Article 9 treatment depends on its eligibility conditions.\n- **Amount**: The article states “1.6 million” without specifying currency, period, or source.\n\n`,
  },
  'content/blog-body-ch/fr/frontaliere-2026-residenza-italia-svizzera.ts': {
    key: 'blog.article.frontaliere-2026-residenza-italia-svizzera.body1',
    marker: '## En résumé',
    text: `## En résumé\n- L’accord entre la Suisse et l’Italie s’applique depuis le 1er janvier 2024.\n- Selon l’art. 9, l’imposition exclusivement à la source en Suisse concerne les salaires des anciens frontaliers qui remplissent les conditions; les autres relèvent du régime ordinaire italien, avec crédit d’impôt et retenue suisse à 80 % des taux ordinaires.\n- Les 10 000 € visés par la loi italienne n° 83/2023 ne constituent pas une franchise générale.\n\n## Faits clés\n- **Quoi** : Règles fiscales de l’accord Suisse–Italie du 23 décembre 2020.\n- **Quand** : En vigueur depuis le 1er janvier 2024; ratification italienne par la loi n° 83 du 13 juin 2023.\n- **Où** : Suisse et Italie; l’art. 9 vise les Grisons, le Tessin et le Valais selon les conditions transitoires prévues.\n- **Qui** : Résidents d’Italie travaillant en Suisse; la catégorie des anciens frontaliers dépend des conditions de l’art. 9.\n- **Montant** : 10 000 € est la limite de revenu visée par l’art. 1, al. 175, de la loi n° 147/2013, pas une déduction générale.\n\n`,
  },
};

const TARGETED_CONTENT_REPAIRS = {
  'content/blog-body/de/trasferirsi-la-salle-frontaliere-pro-e-contro.ts': {
    'blog.article.trasferirsi-la-salle-frontaliere-pro-e-contro.body1': [
      {
        from: 'Die Neue Frontalieri-Vereinbarung sieht den Quellensteuerabzug in der Schweiz vor, was bedeutet, dass Sie in Italien keine Steuern zahlen müssen. Darüber hinaus vermeidet Italien mit der Steuergutschrift die Doppelbesteuerung, was bedeutet, dass Sie keine Steuern doppelt zahlen müssen.',
        to: 'Eine Quellensteuer in der Schweiz schließt eine Steuerpflicht in Italien nicht automatisch aus. Die Doppelbesteuerung richtet sich nach dem anwendbaren Abkommen und den nationalen Regeln; eine ausländische Steuer kann nur im vorgesehenen Umfang angerechnet werden.',
      },
      {
        from: 'Wenn du beispielsweise 50 \'000 CHF pro Jahr verdienst und die Quellensteuer in der Schweiz 20 % beträgt, musst du in der Schweiz 10\' 000 CHF pro Jahr bezahlen. In Italien müssen Sie dank der Steuergutschrift keine Steuern zahlen.',
        to: 'Eine Steuergutschrift kann eine italienische Nachzahlung mindern, schließt sie aber nicht automatisch aus. Das Ergebnis hängt vom anwendbaren Regime und den individuellen Angaben ab.',
      },
      {
        from: 'In Italien müssen Sie dank der Steuergutschrift keine Steuern zahlen.',
        to: 'Eine Steuergutschrift kann eine italienische Nachzahlung mindern, schließt sie aber nicht automatisch aus; das Ergebnis hängt vom anwendbaren Regime und den individuellen Angaben ab.',
      },
    ],
    'blog.article.trasferirsi-la-salle-frontaliere-pro-e-contro.body2': [
      {
        marker: '## Eckdaten',
        replacement: `## Eckdaten
* Was: Steuerregeln für Grenzgänger zwischen der Schweiz und Italien.
* Wann: Das Abkommen gilt seit dem 1. Januar 2024.
* Wo: Schweiz und Italien.
* Wer: Grenzgänger; die Übergangsregel für ehemalige Grenzgänger gilt nur bei erfüllten Voraussetzungen aus Art. 9.
* Betrag: Keine allgemeine Quellensteuerbefreiung oder Selbstbeteiligung von 10.000 Euro für neue Grenzgänger.

Das Abkommen unterscheidet zwischen der Übergangsregel für bestimmte ehemalige Grenzgänger und den Regeln für andere Grenzgänger. Die Schweizer Quellensteuer bedeutet nicht automatisch, dass in Italien keine weitere Steuer geschuldet ist.

## Als Grenzgänger nach La Salle ziehen: Vor- und Nachteile

Die Entscheidung, als Grenzgänger nach La Salle zu ziehen, kann eine attraktive Option sein. Dabei sollten die persönlichen Vor- und Nachteile sowie die konkrete steuerliche Situation geprüft werden.

### Mögliche Vorteile

* **Lebensqualität**: Ein Umzug kann die Lebensqualität verändern. Gesundheitsversorgung, Bildung und öffentlicher Verkehr sind wichtige Rahmenbedingungen, die am konkreten Wohnort verglichen werden sollten.
* **Berufliche Möglichkeiten**: Die Schweiz bietet Arbeitsplätze in Bereichen wie Finanzwesen und Technologie; passende Möglichkeiten hängen von Qualifikation und verfügbaren Stellen ab.
* **Marktzugang**: Die Schweiz ist kein EU-Mitglied. Der Zugang zu EU-Märkten beruht auf bilateralen Abkommen in bestimmten Bereichen und ist nicht uneingeschränkt.

### Steuerliche Einordnung

Die Grenze von 10.000 Euro nach Art. 4 des italienischen Gesetzes Nr. 83/2023 betrifft ausschließlich die dort genannten Einkünfte aus unselbständiger Arbeit von in Italien ansässigen Personen; sie ist kein allgemeiner Freibetrag und befreit nicht von der Schweizer Quellensteuer.

## Nützliche Tools zum Schutz Ihres Nettolohns
Um Wechselkursverluste zu reduzieren, vergleichen Sie [CHF-EUR-Wechseloptionen](nav:exchange) und [Banken für Grenzgänger](nav:banks).

Offizielle Quellen: [Überblick bilateraler Weg (EDA)](https://www.europa.eda.admin.ch/de/ueberblick-bilateraler-weg) · [Steuerabkommen Schweiz–Italien (Fedlex)](https://www.fedlex.admin.ch/eli/cc/2023/410/de) · [TUIR, Art. 165 (MEF)](https://def.giustiziatributaria.gov.it/DocTribFrontend/executePrintArticolo.do?articolo=Articolo+165&codiceOrdinamento=0000000000001650000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000&id=%7B31D694E8-4398-4030-873B-FEAF5A6647F9%7D) · [Gesetz Nr. 83/2023 (Gazzetta Ufficiale)](https://www.gazzettaufficiale.it/atto/serie_generale/caricaDettaglioAtto/originario?atto.codiceRedazionale=23G00087&atto.dataPubblicazioneGazzetta=2023-06-30).
`,
      },
    ],
  },
  'content/blog-body/fr/trasferirsi-la-salle-frontaliere-pro-e-contro.ts': {
    'blog.article.trasferirsi-la-salle-frontaliere-pro-e-contro.body1': [
      {
        from: "Le nouvel accord frontalier prévoit la retenue de l'impôt à la source en Suisse, ce qui signifie que vous n'aurez pas à payer d'impôts en Italie.",
        to: "La retenue à la source en Suisse n'exclut pas automatiquement un impôt dû en Italie. Le traitement de la double imposition dépend du régime applicable et des règles d'imputation prévues par le droit suisse et italien.",
      },
      {
        from: "Si vous gagnez 50 000 CHF par an et que l'impôt à la source en Suisse est de 20 %, vous devrez payer 10 000 CHF par an en Suisse. En Italie, vous n'aurez pas à payer d'impôts, grâce au crédit d'impôt.",
        to: "Un crédit d'impôt peut réduire un solde dû en Italie, mais ne l'exclut pas automatiquement. Le résultat dépend du régime applicable et de la situation personnelle.",
      },
      {
        from: "En Italie, vous n'aurez pas à payer d'impôts, grâce au crédit d'impôt.",
        to: "Un crédit d'impôt peut réduire un solde dû en Italie, mais ne l'exclut pas automatiquement; le résultat dépend du régime applicable et de la situation personnelle.",
      },
    ],
  },
  'content/blog-body/it/trasferirsi-la-salle-frontaliere-pro-e-contro.ts': {
    'blog.article.trasferirsi-la-salle-frontaliere-pro-e-contro.body1': [
      {
        from: "In Italia, non dovrai pagare le tasse, grazie al credito d'imposta.",
        to: "Il credito d'imposta può ridurre l'eventuale saldo dovuto in Italia, ma non lo esclude automaticamente; l'esito dipende dal regime applicabile e dalla situazione individuale.",
      },
    ],
  },
  'content/blog-body/it/credito-imposta-doppia-tassazione.ts': {
    'blog.article.credito-imposta-doppia-tassazione.body3': [
      {
        appendUnless: 'TUIR, art. 165 (MEF)',
        append: `\n\nFonti: [Accordo fiscale tra Italia e Svizzera (Fedlex)](https://www.fedlex.admin.ch/eli/cc/2023/410/it) · [TUIR, art. 165 (MEF)](https://def.giustiziatributaria.gov.it/DocTribFrontend/executePrintArticolo.do?articolo=Articolo+165&codiceOrdinamento=0000000000001650000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000&id=%7B31D694E8-4398-4030-873B-FEAF5A6647F9%7D) · [Circolare n. 25/E del 18 agosto 2023 (Agenzia delle Entrate)](https://www.agenziaentrate.gov.it/portale/documents/20143/5476618/Circolare+Smart+working+e+Frontalieri+18+ago+2023.pdf/988122df-912b-afd1-8942-c2b20f0ab64c) · [FAQ frontalieri (AFC)](https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf) · [Tabella R 2026 (Canton Ticino)](https://www4.ti.ch/dfe/dc/dichiarazione/imposte-alla-fonte-1/tabelle-di-calcolo-dellimposta-alla-fonte) · [Aliquote IRPEF (Agenzia delle Entrate)](https://www.agenziaentrate.gov.it/portale/imposta-sul-reddito-delle-persone-fisiche-irpef-/aliquote-e-calcolo-dell-irpef)`,
      },
    ],
  },
  'content/blog-body/en/credito-imposta-doppia-tassazione.ts': {
    'blog.article.credito-imposta-doppia-tassazione.body3': [
      {
        appendUnless: 'Italian Income Tax Code, Article 165 (MEF)',
        collapseRepeatedMarker: 'Official sources: [Switzerland–Italy tax agreement (Fedlex)]',
        append: `\n\nOfficial sources: [Switzerland–Italy tax agreement (Fedlex)](https://www.fedlex.admin.ch/eli/cc/2023/410/en) · [Italian Income Tax Code, Article 165 (MEF)](https://def.giustiziatributaria.gov.it/DocTribFrontend/executePrintArticolo.do?articolo=Articolo+165&codiceOrdinamento=0000000000001650000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000&id=%7B31D694E8-4398-4030-873B-FEAF5A6647F9%7D) · [Revenue Agency Circular No. 25/E of 18 August 2023](https://www.agenziaentrate.gov.it/portale/documents/20143/5476618/Circolare+Smart+working+e+Frontalieri+18+ago+2023.pdf/988122df-912b-afd1-8942-c2b20f0ab64c) · [Swiss Federal Tax Administration FAQ](https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf) · [Canton Ticino 2026 source-tax table](https://www4.ti.ch/dfe/dc/dichiarazione/imposte-alla-fonte-1/tabelle-di-calcolo-dellimposta-alla-fonte) · [IRPEF rates (Italian Revenue Agency)](https://www.agenziaentrate.gov.it/portale/imposta-sul-reddito-delle-persone-fisiche-irpef-/aliquote-e-calcolo-dell-irpef)`,
      },
    ],
  },
};

const PATTERNS = {
  fuel: /\b(benzina|gasolio|diesel|carburant\w*|benzine|kraftstoff\w*|treibstoff\w*|fuel|petrol|gasoline|essence)\b/,
  fuelSpecificTax: /\b(mineraloelsteuer\w*|mineralolsteuer\w*|mineral oil tax|tassa sugli oli minerali|tassa sul carburante|taxe sur les huiles minerales|taxe sur les carburants|fuel tax|fuel excise|accise sui carburanti|imposta sui carburanti|treibstoffsteuer|benzinst\w*)\b/,
  roadDetail: /\b(traffic data|traffic counts|traffic volume|traffic jam\w*|congestion\w*|strassenverkehr|stau\w*|coda\w*|ingorg\w*|bouchon\w*|autoroute|autostrada|highway\w*|motorway\w*)\b/,
  publicTransport: /\b(trasporto pubblico|transports publics|public transport|oeffentlicher verkehr|offentlicher verkehr|transport public|sbb|cff|ffs|swisspass|halbtax|ga travelcard|generalabonnement|abbonament\w*|abonnement\w*|abos|travelcard\w*|arcobaleno)\b/,
  pass: /\b(abbonament\w*|abonnement\w*|abo\w*|halbtax|swisspass|travelcard\w*|generalabonnement|ga travelcard|arcobaleno)\b/,
  healthInsurance: /\b(lamal|lammal|kvg|assicurazion\w* malatt\w*|assurance\w* maladie|krankenversicherung\w*|krankenkasse\w*|health insurance|medical insurance|assicurazione sanitaria)\b/,
  tax: /\b(impost\w*|fiscal\w*|steuer\w*|tax\w*|impot\w*|fiscalite|taxation|tassazion\w*)\b/,
  cantonTaxDetail: /\b(aliquot\w*|coefficients? d['’]?impot|barem\w*|tax rates|tax multipliers|multiplikator\w*|multiplicateur\w*|steuerfuss\w*|kantonalsteuerfuss\w*|gemeindesteuerfuss\w*|impost\w* comunal\w*|impot communal\w*)\b/,
  agreement: /\b(accord\w*|agreement\w*|abkommen\w*|convenzion\w*|treaty|accordo)\b/,
  italySwiss: /\b(ital\w*|svizz\w*|suisse|schweiz\w*|switzerland|italy)\b/,
  labourLaw: /\b(diritto del lavoro|droit du travail|arbeitsrecht|labour law|labor law|licenziament\w*|dismissal\w*|termination of employment|kündigung\w*|kuendigung\w*|preavvis\w*|notice period\w*|overtime|straordinari\w*|heures supplementaires|ueberstund\w*|working hours|orario di lavoro|temps de travail|arbeitszeit\w*|ferienanspruch|conged\w*|vacation entitlement)\b/,
  workingHours: /\b(working hours|work hours|overtime|hours of work|hours per week|worktime|working-time)\b/,
  gPermit: /\b(permesso g|permis g|g[- ]ausweis|ausweis g|g permit|permit g|bewilligung g)\b/,
  pension: /\b(2nd pillar|second pillar|pension\w*|previdenz\w*|prevoyance|altersvorsorge|retirement|vecchiaia|vieillesse|rente\w*|pensionskasse)\b/,
  crossBorder: /\b(frontali\w*|grenzgaenger\w*|grenzganger\w*|cross.border\w*|navetteur\w*|frontalier\w*)\b/,
  commuterCount: /\b(?:cross.border )?(?:commuter\w*|frontali\w*|grenzgaenger\w*|grenzganger\w*|navetteur\w*)\b.{0,80}\b(statistic\w*|statistik\w*|statistiqu\w*|count\w*|number|anzahl|zahl|numero|nombre|chiffre\w*)\b|\b(statistic\w*|statistik\w*|statistiqu\w*|count\w*|number|anzahl|zahl|numero|nombre|chiffre\w*)\b.{0,80}\b(?:cross.border )?(?:commuter\w*|frontali\w*|grenzgaenger\w*|grenzganger\w*|navetteur\w*)\b/,
  populationData: /\b(population\w*|bevoelkerung\w*|einwohnerzahl\w*|abitant\w*|popolazion\w*|habitants?\b|population density|census|censimento|recensement)\b/,
  municipality: /\b(comun\w*|gemeind\w*|commune\w*|municipal\w*|municipality|municipio|municipio)\b/,
  prices: /\b(cpi|consumer price index|indice dei prezzi al consumo|indice des prix a la consommation|landesindex der konsumentenpreise|lik)\b/,
  labourMarket: /\b(unemployment\w*|disoccupazion\w*|chomage|arbeitslos\w*|jobseekers|demandeurs d emploi|stellensuchend\w*|vacanc\w*|posti vacanti|offene stellen|emplois vacants)\b/,
  salary: /\b(salari\w*|stipendi\w*|l[oö]hn\w*|wage\w*|salary|salaries|salaire\w*|remuner\w*|retribuzion\w*|income level\w*)\b/,
  jobListing: /\b(offert\w* (?:di )?lavoro|annunci\w* (?:di )?lavoro|job listings|job ads|job postings|job portal|jobroom|currently hiring|careers at|open positions|stellenangebot\w*|stellenanzeigen|recherche d emploi)\b/,
  titleRoad: /\b(traffico|verkehr|traffic|trafic|autostrada|highway|motorway|congestion|stau|coda)\b/,
  titlePass: /\b(abbonament|abonnement|halbtax|swisspass|travelcard|arcobaleno)\b/,
  titleTaxAgreement: /\b(accord\w* frontalier|accord\w* fiscal|abkommen.*grenzgaenger|tax agreement|double taxation|doppelte besteuerung|doppia tassazione|double imposition)\b/,
  titleMunicipality: /\b(population|census|censimento|recensement|gemeind\w*|comun\w*|commune\w*|municipality|municipio)\b/,
  titleSalary: /\b(salari\w*|stipendi\w*|l[oö]hn\w*|wage\w*|salary|salaire\w*)\b/,
  titlePension: /\b(avs|ahv|lpp|bvg|pension\w*|previdenz\w*|prevoyance|altersvorsorge|retirement|vecchiaia|vieillesse|rente\w*|pensionskasse|second pillar|2nd pillar)\b/,
  salaryData: /\b(median (?:salary|wage)|average (?:salary|wage)|salary calculator|wage calculator|salarium|salary data|wage data|salary levels?|wage levels?|salary scale|wage scale|salary by (?:sector|occupation|region)|salary estimate|salary range|salary comparison|salary statistics|medianlohn|durchschnittslohn|lohnrechner|calculateur de salaire|salaire median|salaire moyen|calcolatore salariale|salario mediano|salario medio)\b/,
  titleJobs: /\b(job listings|job search|jobsuche|cerca lavoro|annunci\w* (?:di )?lavoro|offert\w* (?:di )?lavoro|offres? d emploi|recherche d emploi|stellenangebot\w*)\b/,
  titleEmploymentContract: /\b(contratt\w* di lavor\w*|contrat\w* de travail|arbeitsvertrag\w*|employment contract\w*|work contract\w*|apprenticeship contract)\b/,
};

function decodeJsString(raw) {
  let out = '';
  for (let i = 0; i < raw.length; i += 1) {
    const char = raw[i];
    if (char !== '\\') {
      out += char;
      continue;
    }
    const next = raw[++i];
    if (next === undefined) break;
    const simple = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0' };
    if (Object.hasOwn(simple, next)) out += simple[next];
    else if (next === 'x' && /^[\da-f]{2}$/i.test(raw.slice(i + 1, i + 3))) {
      out += String.fromCharCode(parseInt(raw.slice(i + 1, i + 3), 16));
      i += 2;
    } else if (next === 'u' && raw[i + 1] === '{') {
      const close = raw.indexOf('}', i + 2);
      if (close >= 0) {
        out += String.fromCodePoint(parseInt(raw.slice(i + 2, close), 16));
        i = close;
      } else out += next;
    } else if (next === 'u' && /^[\da-f]{4}$/i.test(raw.slice(i + 1, i + 5))) {
      out += String.fromCharCode(parseInt(raw.slice(i + 1, i + 5), 16));
      i += 4;
    } else if (next === '\n') {
      // JavaScript line continuation.
    } else if (next === '\r' && raw[i + 1] === '\n') {
      i += 1;
    } else out += next;
  }
  return out;
}

function encodeJsString(value, quote) {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll(quote, `\\${quote}`)
    .replaceAll('\n', '\\n')
    .replaceAll('\r', '\\r')
    .replaceAll('\t', '\\t')
    .replaceAll('\b', '\\b')
    .replaceAll('\f', '\\f')
    .replaceAll('\v', '\\v');
}

function getLocale(file) {
  const parts = file.split(path.sep);
  return [...parts].reverse().find(part => LANGS.has(part)) ?? null;
}

function getFields(contents) {
  const fields = [];
  for (const match of contents.matchAll(FIELD_RE)) {
    fields.push({ key: match[3], quote: match[5], value: decodeJsString(match[6]) });
  }
  return fields;
}

function rewriteFields(contents, transform) {
  return contents.replace(FIELD_RE, (...args) => {
    const [whole, leading, keyQuote, key, delimiter, valueQuote, rawValue, comma, trailing] = args;
    const decoded = decodeJsString(rawValue);
    const next = transform(key, decoded);
    if (next === decoded) return whole;
    return `${leading}${keyQuote}${key}${keyQuote}${delimiter}${valueQuote}${encodeJsString(next, valueQuote)}${valueQuote}${comma}${trailing}`;
  });
}

function normalizeSentence(sentence) {
  const normalized = sentence
    .replace(/^\s*(?:#{1,6}\s*)?(?:[-*+]\s+|\d+[.)]\s+)?/, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .normalize('NFC')
    .toLowerCase();
  const datePart = normalized.replace(/^[*_~`]+|[*_~`]+$/gu, '').replace(/[.,;:!?]+$/u, '').trim();
  if (/^\d{1,2}$/u.test(datePart) || /^\d{1,4}\.?\s*(?:[-–]\s*\d{1,4}\.?)*$/u.test(datePart) || /^\p{L}\.$/u.test(normalized)) return '';
  if (/^(?:jan(?:uary|vier)?|feb(?:ruary|ruar)?|mar(?:ch|s|zo)?|apr(?:il)?|may|mai|maggio|juin|junio|july|juillet|luglio|aug(?:ust)?|ao[uû]t|agosto|sep(?:tember)?|septembre|settembre|oct(?:ober)?|oktober|octobre|ottobre|nov(?:ember)?|novembre|dec(?:ember)?|dezember|d[eé]cembre|dicembre)$/u.test(datePart)) return '';
  return normalized;
}

function dedupeSentences(value, locale) {
  let segmenter = SENTENCE_SEGMENTERS.get(locale);
  if (!segmenter) {
    segmenter = new Intl.Segmenter(locale, { granularity: 'sentence' });
    SENTENCE_SEGMENTERS.set(locale, segmenter);
  }
  const seen = new Set();
  let removed = 0;
  const samples = [];
  const next = [...segmenter.segment(value)].map(({ segment }) => {
    const key = normalizeSentence(segment);
    if (!key || !/[\p{L}\p{N}]/u.test(key)) return segment;
    if (seen.has(key)) {
      removed += 1;
      if (samples.length < 2) samples.push(key.slice(0, 100));
      return '';
    }
    seen.add(key);
    return segment;
  }).join('');
  return { value: next, removed, samples };
}

function fold(value) {
  return value.normalize('NFD').replace(/\p{M}/gu, '').replaceAll('ß', 'ss').toLowerCase();
}

function has(regex, text) {
  regex.lastIndex = 0;
  return regex.test(text);
}

function sourceIdsFor(file, locale, values) {
  const stem = path.basename(file, path.extname(file)).replaceAll('-', ' ');
  const title = fold(stem);
  const lead = fold((values[0] ?? '').slice(0, 1_000));
  const headings = fold(values.flatMap(value => value.match(/^#{1,6}[^\n]*/gm) ?? []).join('\n'));
  const context = `${lead}\n${headings}`;
  const full = `${title}\n${context}`;
  const titleIs = regex => has(regex, title);
  const is = regex => has(regex, full);
  const topics = [];
  const add = id => { if (!topics.includes(id)) topics.push(id); };
  let segmenter = SENTENCE_SEGMENTERS.get(locale);
  if (!segmenter) {
    segmenter = new Intl.Segmenter(locale, { granularity: 'sentence' });
    SENTENCE_SEGMENTERS.set(locale, segmenter);
  }
  const sameTopicSentence = (left, right) => [...segmenter.segment(context)]
    .some(({ segment }) => has(left, segment) && has(right, segment));

  if (is(PATTERNS.fuel) && is(PATTERNS.fuelSpecificTax)) add('fuelTax');
  if (titleIs(PATTERNS.titleRoad) || is(PATTERNS.roadDetail)) add('roadTraffic');
  if ((titleIs(PATTERNS.titlePass) || is(PATTERNS.pass)) && is(PATTERNS.publicTransport)) add('transitPasses');
  if (is(/\barcobaleno\b/)) add('arcobaleno');
  if (is(PATTERNS.healthInsurance) && is(PATTERNS.crossBorder)) add('healthInsurance');
  if (is(PATTERNS.tax) && is(PATTERNS.cantonTaxDetail) && !titleIs(PATTERNS.titleTaxAgreement)) add('cantonTax');
  const pensionFocused = titleIs(PATTERNS.titlePension);
  if (!pensionFocused && is(PATTERNS.tax) && (titleIs(PATTERNS.titleTaxAgreement) || (is(PATTERNS.agreement) && is(PATTERNS.italySwiss)))) add('crossBorderTaxAgreement');
  if (titleIs(PATTERNS.titleEmploymentContract)) add('employmentContract');
  if (is(PATTERNS.labourLaw)) {
    add('labourLaw');
    if (locale === 'en' && is(PATTERNS.workingHours)) add('workingHours');
  }
  if (is(PATTERNS.gPermit)) add('gPermit');
  if (titleIs(PATTERNS.titlePension) || is(PATTERNS.pension)) add('pension');
  if (sameTopicSentence(PATTERNS.crossBorder, PATTERNS.commuterCount)) add('crossBorderStatistics');
  if (titleIs(PATTERNS.titleMunicipality) && is(PATTERNS.municipality) && is(PATTERNS.populationData) && /\b\d{2,}\b/u.test(lead)) add('municipalityPopulation');
  if (is(PATTERNS.prices)) add('consumerPrices');
  if (is(PATTERNS.labourMarket)) add('labourMarketStatistics');
  if (titleIs(PATTERNS.titleSalary) || (is(PATTERNS.salary) && is(PATTERNS.salaryData))) add('salary');
  if (titleIs(PATTERNS.titleJobs) || is(PATTERNS.jobListing)) add('jobListings');

  return topics;
}

const SENTENCE_SEGMENTERS = new Map();

async function listBodyFiles() {
  const contentRoot = path.join(ROOT, 'content');
  const roots = (await readdir(contentRoot, { withFileTypes: true }))
    .filter(entry => entry.isDirectory() && entry.name.startsWith('blog-body'))
    .map(entry => path.join(contentRoot, entry.name));
  const output = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const resolved = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(resolved);
      else if (entry.isFile() && entry.name.endsWith('.ts')) output.push(resolved);
    }
  }
  for (const root of roots) await walk(root);
  return output.sort();
}

function markdownSources(locale, ids) {
  const rendered = [];
  for (const id of ids) {
    const sourceIds = TOPICS[id] ?? [];
    for (const sourceId of sourceIds) {
      const item = SOURCES[sourceId];
      const url = item?.urls[locale];
      const name = item?.names[locale];
      if (url && name) rendered.push(`[${name}](${url})`);
    }
  }
  return [...new Set(rendered)];
}

function summaryRepair(file, key, value) {
  const repair = SUMMARY_REPAIRS[path.relative(ROOT, file)];
  if (!repair || repair.key !== key || value.startsWith(repair.marker)) return value;
  return repair.text + value;
}

function targetedContentRepair(file, key, value) {
  const repairs = TARGETED_CONTENT_REPAIRS[path.relative(ROOT, file)]?.[key] ?? [];
  let next = value;
  for (const repair of repairs) {
    if (repair.replacement !== undefined) {
      if (!next.includes(repair.appendUnless ?? 'Offizielle Quellen: [Überblick bilateraler Weg')) next = repair.replacement;
    } else if (repair.append !== undefined) {
      if (!next.includes(repair.appendUnless)) next = `${next.trimEnd()}${repair.append}`;
    } else if (repair.from && next.includes(repair.from)) {
      next = next.replace(repair.from, repair.to);
    }
    if (repair.collapseRepeatedMarker) {
      const first = next.indexOf(repair.collapseRepeatedMarker);
      const second = first < 0 ? -1 : next.indexOf(repair.collapseRepeatedMarker, first + repair.collapseRepeatedMarker.length);
      if (second >= 0) next = next.slice(0, second).trimEnd();
    }
  }
  return next;
}

const files = await listBodyFiles();
const stats = {
  files: files.length,
  fields: 0,
  duplicatedFields: 0,
  duplicateOccurrencesRemoved: 0,
  duplicateExamples: [],
  missingUrlBefore: 0,
  classified: 0,
  sourceLinksAdded: 0,
  missingLocaleSource: 0,
  noRelevantSource: 0,
  missingUrlAfter: 0,
  restoredSummaryBlocks: 0,
  targetedContentFields: 0,
  targetedContentExamples: [],
  topics: {},
  languages: {},
  examples: {},
  examplesByTopic: {},
};

for (const file of files) {
  const relative = path.relative(ROOT, file);
  const locale = getLocale(relative);
  if (!locale) continue;
  const original = await readFile(file, 'utf8');
  const fields = getFields(original);
  if (!fields.length) continue;
  stats.fields += fields.length;

  let localDuplicates = 0;
  let deduped = rewriteFields(original, (key, value) => {
    if (!/\.body\d+$/.test(key)) return value;
    const result = dedupeSentences(value, locale);
    localDuplicates += result.removed;
    if (result.removed && stats.duplicateExamples.length < 5) {
      stats.duplicateExamples.push({ file: relative, field: key.split('.').at(-1), examples: result.samples });
    }
    return result.value;
  });
  if (localDuplicates) {
    stats.duplicatedFields += 1;
    stats.duplicateOccurrencesRemoved += localDuplicates;
  }

  const dedupedFields = getFields(deduped);
  const fileHasUrl = /https?:\/\//i.test(original);
  if (!fileHasUrl) {
    stats.missingUrlBefore += 1;
    const topics = sourceIdsFor(relative, locale, dedupedFields.map(field => field.value));
    const sourceLinks = markdownSources(locale, topics);
    const lacksLocalizedSource = topics.some(topic =>
      (TOPICS[topic] ?? []).some(sourceId => !SOURCES[sourceId]?.urls[locale]),
    );
    for (const topic of topics) {
      stats.topics[topic] = (stats.topics[topic] ?? 0) + 1;
      const examples = stats.examplesByTopic[topic] ??= [];
      if (examples.length < 2) examples.push(relative);
    }
    if (topics.length) stats.classified += 1;
    if (lacksLocalizedSource) stats.missingLocaleSource += 1;
    if (!sourceLinks.length) {
      if (!topics.length) stats.noRelevantSource += 1;
      const examples = stats.examples[topics.length ? 'missingLocaleSource' : 'noRelevantSource'] ??= [];
      if (examples.length < 3) examples.push(relative);
    } else {
      const lastField = [...dedupedFields].sort((a, b) => Number(a.key.match(/\.body(\d+)$/)?.[1] ?? 0) - Number(b.key.match(/\.body(\d+)$/)?.[1] ?? 0)).at(-1);
      const sourceBlock = `${CLOSING_LABELS[locale]} ${sourceLinks.join(' · ')}`;
      deduped = rewriteFields(deduped, (key, value) => key === lastField.key ? `${value.trimEnd()}\n\n${sourceBlock}` : value);
      stats.sourceLinksAdded += sourceLinks.length;
      stats.languages[locale] = (stats.languages[locale] ?? 0) + 1;
    }
    if (!sourceLinks.length) stats.missingUrlAfter += 1;
  }

  let repaired = deduped;
  if (relative in SUMMARY_REPAIRS) {
    repaired = rewriteFields(repaired, summaryRepair.bind(null, file));
    if (repaired !== deduped) stats.restoredSummaryBlocks += 1;
  }
  const beforeTargetedContentRepair = repaired;
  const targetedKeys = [];
  repaired = rewriteFields(repaired, (key, value) => {
    const next = targetedContentRepair(file, key, value);
    if (next !== value) targetedKeys.push(key);
    return next;
  });
  if (repaired !== beforeTargetedContentRepair) {
    stats.targetedContentFields += 1;
    if (stats.targetedContentExamples.length < 5) stats.targetedContentExamples.push({ file: relative, fields: targetedKeys });
  }

  if (APPLY && repaired !== original) await writeFile(file, repaired);
}

console.log(JSON.stringify({ mode: APPLY ? 'apply' : 'dry-run', ...stats }, null, 2));
