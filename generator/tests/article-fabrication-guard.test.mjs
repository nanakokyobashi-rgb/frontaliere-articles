/**
 * PORTATO da valerielinc-ops/frontaliere-si-o-no `tests/article-fabrication-guard.test.ts`
 * (manifest: `adapted`). È la rete di sicurezza permanente contro le
 * allucinazioni note: istituzioni e acronimi inventati, fatti sbagliati
 * ricorrenti, statistiche precise con fonte vaga. Gli articoli si GENERANO in
 * questo repo, quindi è qui che un corpo appena scritto va scandito — sul sito
 * il gate scatta solo dopo il mirror, a pubblicazione avvenuta.
 *
 * ## ADATTAMENTI rispetto al sito
 *  - Path: `content/blog-body{,-ch}/<locale>/` al posto di
 *    `services/locales/blog-body{,-ch}/<locale>/` (layout di questo repo,
 *    stessa mappa di generator/scripts/lib/corpus-paths.mjs).
 *  - `node:test` + expect-shim al posto di vitest (niente npm ci in CI).
 *  - Granularità: il sito fa `it.each` per file (~15k subtest); qui ogni
 *    classe di pattern è UN test che accumula gli offender e fallisce
 *    elencandoli tutti. Stessa severità, output leggibile sotto `node --test`.
 *  - La sanity "ci sono file da scandire" è rafforzata: > 3000 corpi IT invece
 *    di > 0. In un worktree sparse `content/` non esiste, e un gate che passa
 *    su 0 file scanditi è il falso verde più facile da produrre qui.
 *
 * I PATTERN sono byte-identici al sito (verificato 2026-08-08, main d99617+):
 * se ne aggiungi uno, aggiungilo PRIMA sul sito e ricopialo qui, o il mirror
 * successivo del sito non lo avrà e i due lati divergono in silenzio.
 *
 * Misurato sul corpus attuale (15.076 file, 3.769 IT): 0 offender in ogni
 * classe — il gate parte severo e verde.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * Intestazione originale del sito:
 *
 * Scans ALL blog body files (blog-body + blog-body-ch, all 4 locales) for
 * known hallucination patterns:
 * - Fabricated Swiss/Italian laws and legal references
 * - Fabricated institutions and acronyms
 * - Known incorrect facts (fake tax rates)
 * - Fabricated statistics (unsourced precise percentages)
 *
 * This test acts as a permanent safety net: any article containing
 * fabricated content will fail the test suite and block deployment.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { CORPUS_SECTIONS } from '../../scripts/lib/corpus-sections.mjs';
import { expect } from './lib/expect-shim.mjs';
import {
  FABRICATED_INSTITUTION_ACRONYMS,
  checkFabricatedInstitutionAcronyms,
} from '../scripts/lib/article-factuality-gates.mjs';
import { checkCorpusFabricatedInstitutionNames } from '../scripts/lib/corpus-fabricated-institution-names.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// Dal core (sezioni attive), come ogni altro elenco di radici dei corpi.
const BODY_ROOTS = CORPUS_SECTIONS.map((section) => path.basename(section.bodyDir));
const LOCALES = ['it', 'de', 'en', 'fr'];

function getArticleFiles() {
  const results = [];
  for (const root of BODY_ROOTS) {
    for (const locale of LOCALES) {
      const dir = path.join(ROOT, 'content', root, locale);
      if (!fs.existsSync(dir)) continue;
      for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
        results.push({
          id: `${root}/${locale}/${path.basename(f, '.ts')}`,
          path: path.join(dir, f),
          locale,
        });
      }
    }
  }
  return results;
}

function extractTextContent(filePath) {
  const raw = fs.readFileSync(filePath, 'utf-8');
  // Extract string values from the TS export (body1, body2, body3, faq content).
  // Must treat a backslash-escaped quote (`\'`) as part of the string content,
  // not a terminator — `/'[^']*'/g` (the prior version) stopped at the FIRST
  // `\'` it saw (e.g. "dell\'Ufficio..."), silently truncating the extracted
  // text and losing everything after it. That's exactly where Italian/French/
  // German elisions put an apostrophe right before a fabricated institution
  // name ("dell\'Ufficio federale...", "l\'Office fédéral...") — this safety
  // net had a blind spot for the single most common surrounding grammar
  // pattern of the exact fabrication it exists to catch (confirmed live: 2
  // articles with the fabricated institution sitting immediately after an
  // escaped apostrophe passed this test undetected until this fix).
  const stringMatches = raw.match(/'(?:[^'\\]|\\.)*'/g) || [];
  return stringMatches.join(' ');
}

// Fabricated institution patterns
const FABRICATED_INSTITUTIONS = [
  { pattern: /Codice\s+federale\s+del\s+lavoro/i, desc: '"Codice federale del lavoro" non esiste (reale: Legge sul lavoro LL/ArG)' },
  { pattern: /\bCFL\b(?!\s*[A-Z])/, desc: '"CFL" è un acronimo inventato' },
  { pattern: /Dipartimento\s+delle\s+Entrate\b/i, desc: '"Dipartimento delle Entrate" non esiste' },
  { pattern: /Codice\s+federale\s+(?:della\s+)?(?:salute|sanità)/i, desc: '"Codice federale della salute" non esiste' },
  { pattern: /Ministero\s+(?:federale|cantonale)\s+del(?:la)?\s+(?:lavoro|salute|finanz)/i, desc: 'Ministero federale/cantonale non esiste in Svizzera (reale: Dipartimento)' },
  { pattern: /Ufficio\s+federale\s+del(?:la)?\s+(?:lavoro\s+transfrontaliero|migrazione\s+lavorativa)/i, desc: '"Ufficio federale del lavoro transfrontaliero" non esiste' },
  { pattern: /Legge\s+cantonale\s+(?:sui|del)\s+frontalier/i, desc: '"Legge cantonale sui frontalieri" non esiste' },
  { pattern: /Regolamento\s+ticinese\s+(?:del|sul)\s+lavoro/i, desc: '"Regolamento ticinese del lavoro" non esiste' },
  { pattern: /Commissione\s+(?:federale|cantonale)\s+(?:per\s+i\s+)?frontalier/i, desc: '"Commissione federale per i frontalieri" non esiste' },
  { pattern: /Osservatorio\s+nazionale\s+(?:del|sulla)\s+sicurezza\s+(?:sul\s+)?lavoro/i, desc: '"Osservatorio nazionale sulla sicurezza sul lavoro" non esiste (reale: SUVA)' },
];

// Fabricated Swiss acronyms
const FABRICATED_ACRONYMS = [
  { pattern: /\bUFOL\b/, desc: '"UFOL" non esiste (reale: SECO)' },
  { pattern: /\bUWL\b/, desc: '"UWL" non esiste (reale: SECO)' },
  { pattern: /\bUSTTI\b/, desc: '"USTTI" non esiste (reale: USTAT)' },
  { pattern: /\bUBSP\b/, desc: '"UBSP" non esiste (reale: UFSP/BAG)' },
  { pattern: /\bONSSL\b/, desc: '"ONSSL" non esiste (reale: SUVA)' },
  { pattern: /\bROSSL\b/, desc: '"ROSSL" non esiste' },
  { pattern: /\bLCFL\b/, desc: '"LCFL" non esiste (reale: LL/ArG)' },
  { pattern: /\bLTL\b/, desc: '"LTL" non esiste' },
  { pattern: /\bCCFL\b/, desc: '"CCFL" non esiste' },
  { pattern: /\bUFML\b/, desc: '"UFML" non esiste (reale: SEM)' },
];

// Known incorrect facts (proximity-constrained patterns).
// Convention date: it is 9 March 1976 (RS 0.672.945.41, Fedlex). The pattern
// that stood here until #1751 rejected the correct date; the two below are
// its inverse, same text as mentionsWrongConventionDate in the generator.
// They could land only after the corpus correction removed the ~550 IT
// bodies that carried «9 dicembre 1976» from the old prompt ground truth.
const INCORRECT_FACTS = [
  { pattern: /convenzione.*\b0?9\s*(?:dicembre|[./]\s*12\s*[./])\s*1976\b/i, desc: 'Convenzione italo-svizzera: 9 marzo 1976, non 9 dicembre' },
  { pattern: /\b0?9\s*(?:dicembre|[./]\s*12\s*[./])\s*1976\b.*convenzione/i, desc: 'Convenzione italo-svizzera: 9 marzo 1976, non 9 dicembre' },
  { pattern: /tassa\s+(?:sulla\s+)?salute\s+(?:\w+\s+){0,5}(?:del\s+)?10\s*%/i, desc: '"Tassa sulla salute del 10%" è un dato inventato' },
];

// Vague source attributions that are red flags for fabricated stats
const VAGUE_SOURCING = [
  { pattern: /secondo\s+(?:uno\s+)?studio\s+(?:recente|del\s+20\d{2})[^.]{0,40}\d{2,3}[.,]\d+\s*%/i, desc: 'Percentuale precisa attribuita a "uno studio" senza nome specifico' },
  { pattern: /secondo\s+(?:un(?:a|')\s+)?(?:indagine|ricerca|sondaggio)[^.]{0,40}\d{2,3}[.,]\d+\s*%/i, desc: 'Percentuale precisa attribuita a indagine/ricerca senza fonte' },
];

// Cross-locale: the same fabricated "federal labour office" institution
// (real: SECO) recurs under a different fake acronym per article — matching
// the institution NAME itself (not a fixed acronym list) catches every
// variant regardless of what acronym a future auto-generated article invents.
const FABRICATED_LABOR_OFFICE = {
  it: /\b[Uu]fficio federale(?: svizzero)? del lavoro\b/i,
  de: /\b([Bb]undesamt(?:es)? für Arbeit|[Bb]undesarbeitsamt)\b/,
  fr: /\b(?:[Oo]ffice|[Bb]ureau) fédéral du travail\b/,
  en: /\b[Ff]ederal (?:Labou?r Office|Office of Labou?r)\b/,
};

// Cross-locale: the Convention's wrong date in any of its written forms. No
// keyword proximity here — a translation calls the Convention «Vereinbarung»,
// «traité» or «agreement» as often as «Convention», and after the corpus
// correction no body mentions 9 December 1976 for any other reason.
const NUMERIC_WRONG_CONVENTION_DATE = String.raw`\b0?9\s*[./]\s*12\s*[./]\s*1976\b`;
const WRONG_CONVENTION_DATE = {
  it: new RegExp(String.raw`\b0?9\.?\s*dicembre\s*(?:del\s+)?1976\b|${NUMERIC_WRONG_CONVENTION_DATE}`, 'i'),
  en: new RegExp(String.raw`\b0?9(?:th)?\s*December,?\s*1976\b|\bDecember\s+0?9(?:th)?,?\s+1976\b|${NUMERIC_WRONG_CONVENTION_DATE}`, 'i'),
  de: new RegExp(String.raw`\b0?9\.?\s*Dezember\s*1976\b|${NUMERIC_WRONG_CONVENTION_DATE}`, 'i'),
  fr: new RegExp(String.raw`\b0?9\s*décembre\s*1976\b|${NUMERIC_WRONG_CONVENTION_DATE}`, 'i'),
};

// ── Enti inventati della denylist CURATA del generatore (issue corpus 2115) ──
//
// Le liste FABRICATED_INSTITUTIONS / FABRICATED_ACRONYMS qui sopra sono una
// copia corta e congelata: `(UFI)`, `(OFOS)`, `(UAFS)`, `(UJF)` stanno nella
// denylist che il generatore usa per bloccare un articolo nuovo
// (FABRICATED_INSTITUTION_ACRONYMS in article-factuality-gates.mjs), ma questo
// gate sul contenuto non le guardava. Quattro corpi IT pubblicati prima che le
// sigle entrassero in denylist sono quindi rimasti online senza che nessun
// gate su `main` diventasse rosso: li vedeva solo la scansione della bonifica.
//
// Il test non copia la lista: importa la stessa funzione del gate, così ogni
// sigla aggiunta alla denylist vale da subito anche per il corpus già scritto.
// Solo la parte CURATA (nessuna memoria appresa): il verdetto non dipende da
// `data/article-defect-memory.json`, che un cron riscrive.
//
// I locali: INSTITUTION_RE del gate riconosce solo sostantivi italiani
// («Ufficio», «Istituto», …), quindi la traduzione dello stesso ente inventato
// — «Federal Office of Switzerland (OFOS)», «Bundesamt für Rechtsangelegenheiten
// (UJF)» — gli era invisibile. Qui la stessa denylist vale con un sostantivo di
// ente nella lingua del locale, nella stessa finestra di 80 caratteri senza
// parentesi né punto.
const LOCALE_INSTITUTION_NOUN = {
  en: String.raw`(?:Office|Offices|Agency|Department|Commission|Institute|Authority|Secretariat|Directorate|Administration|Observatory|Bureau)`,
  de: String.raw`(?:[A-Za-zÄÖÜäöüß]*(?:amt|amtes|amts)|Departement|Departements|Kommission|Institut|Instituts|Behörde|Sekretariat|Sekretariats|Direktion|Verwaltung|Agentur)`,
  fr: String.raw`(?:Office|Offices|Agence|Département|Commission|Institut|Autorité|Secrétariat|Direction|Administration|Observatoire|Bureau)`,
};

function unescapeTsString(text) {
  return text.replace(/\\n/g, '\n').replace(/\\(['"\\])/g, '$1');
}

// Osservatore di classe: nei corpi italiani di blog-body-ch, «Ufficio
// federale …» è un candidato valido solo se il nome compare nell’elenco
// curato degli uffici federali svizzeri. I candidati non elencati non sono
// tutti falsi per definizione: il test li misura e impedisce che la classe
// cresca in silenzio, lasciando la verifica editoriale al triage.
const SWISS_FEDERAL_OFFICE_NAMES = [
  "Ufficio federale dell'agricoltura",
  "Ufficio federale dell'ambiente",
  "Ufficio federale dell'armamento",
  "Ufficio federale dell'aviazione civile",
  "Ufficio federale dell'energia",
  "Ufficio federale dell'informatica e della telecomunicazione",
  "Ufficio federale della cibersicurezza",
  "Ufficio federale della comunicazione",
  "Ufficio federale della cultura",
  "Ufficio federale della dogana e della sicurezza dei confini",
  "Ufficio federale della formazione professionale e della tecnologia",
  "Ufficio federale della migrazione",
  "Ufficio federale della proprietà intellettuale",
  "Ufficio federale della protezione della popolazione",
  "Ufficio federale della sanità pubblica",
  "Ufficio federale della sicurezza alimentare e di veterinaria",
  "Ufficio federale della statistica",
  "Ufficio federale delle abitazioni",
  "Ufficio federale delle assicurazioni sociali",
  "Ufficio federale delle comunicazioni",
  "Ufficio federale delle costruzioni e della logistica",
  "Ufficio federale delle dogane",
  "Ufficio federale delle migrazioni",
  "Ufficio federale delle strade",
  "Ufficio federale dei trasporti",
  "Ufficio federale di giustizia",
  "Ufficio federale di meteorologia",
  "Ufficio federale di meteorologia e climatologia",
  "Ufficio federale di polizia",
  "Ufficio federale di statistica",
  "Ufficio federale di topografia",
  "Ufficio federale del personale",
  "Ufficio federale del servizio civile",
  "Ufficio federale dello sport",
  "Ufficio federale per l'approvvigionamento economico",
  "Ufficio federale per l'armamento",
  "Ufficio federale per la formazione professionale e la tecnologia",
  "Ufficio federale per la migrazione",
  "Ufficio federale per la parità fra donna e uomo",
  "Ufficio federale per la protezione dei dati e la trasparenza",
  "Ufficio federale per la protezione della popolazione",
  "Ufficio federale per la sicurezza alimentare e di veterinaria",
  "Ufficio federale per la sicurezza informatica",
  "Ufficio federale per le pari opportunità",
  "Ufficio federale per le questioni spaziali",
  "Ufficio federale per lo sviluppo territoriale",
  "Ufficio federale per l'uguaglianza fra donna e uomo",
].map(normalizeObserverText);

const FOREIGN_MINISTRY_MARKER = /\b(?:italian[oa]|frances[ei]|francese|tedesc[oa]|austriac[oa]|europe[oa]|spagnol[oa]|britannic[oa]|belg[ia]|olandese|portoghes[ei]|statunitens[ei]|american[oa])\b/i;

function normalizeObserverText(text) {
  return text
    .replace(/[’']/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase('it-CH');
}

function scanSwissInstitutionCandidates(entries) {
  const unlistedOfficeIds = new Set();
  const unlistedMinistryIds = new Set();
  const officeRe = /\bUfficio federale\b[^.!?;\n]{0,100}/gi;
  const ministryRe = /\bMinistero\b[^.!?;\n]{0,100}/gi;

  for (const entry of entries) {
    const text = unescapeTsString(entry.text);
    for (const match of text.matchAll(officeRe)) {
      const candidate = normalizeObserverText(match[0])
        .replace(/\s+\([^)]*\).*/, '')
        .trim();
      if (!SWISS_FEDERAL_OFFICE_NAMES.some((name) => candidate.startsWith(name))) {
        unlistedOfficeIds.add(entry.id);
      }
    }
    for (const match of text.matchAll(ministryRe)) {
      const candidate = normalizeObserverText(match[0]);
      if (
        !/^ministero pubblico della confederazione\b/i.test(candidate)
        && !FOREIGN_MINISTRY_MARKER.test(candidate)
      ) {
        unlistedMinistryIds.add(entry.id);
      }
    }
  }

  const overlap = [...unlistedOfficeIds].filter((id) => unlistedMinistryIds.has(id)).length;
  return {
    filesScanned: entries.length,
    unlistedOfficeArticles: unlistedOfficeIds.size,
    unlistedSwissMinistryArticles: unlistedMinistryIds.size,
    candidateArticles: new Set([...unlistedOfficeIds, ...unlistedMinistryIds]).size,
    overlap,
  };
}

// Baseline captured immediately before issue #2522 was rewritten. The
// original cassis-duedingen body contributed one office and one ministry
// candidate to this observer; the counts are a ratchet, not an expectation
// that every candidate is already confirmed as fabricated.
const SWISS_INSTITUTION_OBSERVER_BASELINE = Object.freeze({
  filesScanned: 2641,
  unlistedOfficeArticles: 265,
  unlistedSwissMinistryArticles: 70,
  candidateArticles: 323,
  overlap: 12,
});

function localeFabricatedInstitutions(locale, text) {
  const noun = LOCALE_INSTITUTION_NOUN[locale];
  if (!noun) return [];
  // Lookaround su \p{L} invece di \b: \b è solo ASCII e non chiude «Autorité».
  const re = new RegExp(String.raw`(?<!\p{L})${noun}(?!\p{L})[^().\n]{0,80}?\(([A-Z]{2,8})\)`, 'gu');
  const hits = [];
  for (const m of text.matchAll(re)) {
    if (FABRICATED_INSTITUTION_ACRONYMS.has(m[1])) hits.push(m[0].trim());
  }
  return hits;
}

describe('article fabrication guard', () => {
  const files = getArticleFiles();
  const itFiles = files.filter((f) => f.locale === 'it');
  // Il testo estratto è riusato da 4 classi di pattern: una lettura sola.
  const itTexts = itFiles.map((f) => ({ id: f.id, text: extractTextContent(f.path) }));
  const swissChItTexts = files
    .filter((f) => f.id.startsWith('blog-body-ch/it/'))
    .map((f) => ({ id: f.id, text: extractTextContent(f.path) }));

  it('should have blog body files to check (a sparse checkout must NOT pass vacuously)', () => {
    expect(itFiles.length).toBeGreaterThan(3000);
    expect(files.length).toBeGreaterThan(10000);
  });

  const scanIt = (patterns) => {
    const offenders = [];
    for (const { id, text } of itTexts) {
      for (const { pattern, desc } of patterns) {
        if (pattern.test(text)) offenders.push(`${id}: ${desc}`);
      }
    }
    return offenders;
  };

  it('no fabricated institutions in any IT body', () => {
    expect(scanIt(FABRICATED_INSTITUTIONS)).toEqual([]);
  });

  it('no fabricated acronyms in any IT body', () => {
    expect(scanIt(FABRICATED_ACRONYMS)).toEqual([]);
  });

  it('no IT body names an institution in the generator curated denylist (fabricated-institution)', () => {
    const offenders = [];
    for (const { id, text } of itTexts) {
      for (const i of checkFabricatedInstitutionAcronyms(unescapeTsString(text))) {
        if (i.code === 'fabricated-institution') offenders.push(`${id}: ${i.evidence}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no body names the issue #2522 fabricated institutions in any locale', () => {
    const offenders = [];
    for (const f of files) {
      for (const issue of checkCorpusFabricatedInstitutionNames(
        unescapeTsString(extractTextContent(f.path)),
      )) {
        offenders.push(f.id + ': ' + issue.evidence);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the corpus institution guard recognises each translated #2522 alias', () => {
    const fixtures = [
      'Ufficio federale per la politica estera (UPEP), Istituto federale di statistica (IFS), Ministero dell’agricoltura, dell’ambiente e dello spazio',
      'Federal Office for Foreign Policy (UPEP) and Swiss Federal Statistical Office (IFS)',
      'Bundesamt für Außenpolitik (UPEP) und Bundesamt für Statistik (IFS)',
      'Office fédéral de la politique étrangère (UPEP) et Office fédéral de la statistique (IFS)',
    ];
    for (const fixture of fixtures) {
      expect(checkCorpusFabricatedInstitutionNames(fixture).length).toBeGreaterThan(0);
    }
  });

  it('no en/de/fr body names an institution in the generator curated denylist', () => {
    const offenders = [];
    for (const f of files) {
      if (f.locale === 'it') continue;
      for (const hit of localeFabricatedInstitutions(f.locale, unescapeTsString(extractTextContent(f.path)))) {
        offenders.push(`${f.id}: ${hit}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the locale denylist matcher recognises the translated form of an invented body', () => {
    expect(localeFabricatedInstitutions('en', 'established by the Federal Office of Switzerland (OFOS) and')).toEqual(['Office of Switzerland (OFOS)']);
    expect(localeFabricatedInstitutions('de', 'die Website des Bundesamtes für Rechtsangelegenheiten (UJF) zu')).toEqual(['Bundesamtes für Rechtsangelegenheiten (UJF)']);
    expect(localeFabricatedInstitutions('fr', "établie par l'Office fédéral de la Suisse (OFOS) et")).toEqual(['Office fédéral de la Suisse (OFOS)']);
    // Real bodies and acronyms outside the denylist stay clean.
    expect(localeFabricatedInstitutions('en', 'the Federal Tax Administration (AFC) publishes')).toEqual([]);
    expect(localeFabricatedInstitutions('de', 'das Bundesamt für Gesundheit (BAG) publiziert')).toEqual([]);
  });

  it('the Swiss institution observer distinguishes allowlisted and suspicious names', () => {
    const report = scanSwissInstitutionCandidates([
      {
        id: 'invented',
        text: 'Ufficio federale per la politica estera (UPEP). Ministero dell’agricoltura, dell’ambiente e dello spazio.',
      },
      {
        id: 'real',
        text: 'Ufficio federale di statistica (UST). Ministero pubblico della Confederazione.',
      },
      {
        id: 'foreign',
        text: 'Ministero della Salute italiana.',
      },
    ]);
    expect(report.unlistedOfficeArticles).toBe(1);
    expect(report.unlistedSwissMinistryArticles).toBe(1);
  });

  it('measures unlisted Swiss institution candidates without allowing class growth', () => {
    const report = scanSwissInstitutionCandidates(swissChItTexts);
    expect(report.filesScanned).toBeGreaterThan(2600);
    expect(report.unlistedOfficeArticles <= SWISS_INSTITUTION_OBSERVER_BASELINE.unlistedOfficeArticles).toBeTruthy();
    expect(report.unlistedSwissMinistryArticles <= SWISS_INSTITUTION_OBSERVER_BASELINE.unlistedSwissMinistryArticles).toBeTruthy();
    expect(report.candidateArticles <= SWISS_INSTITUTION_OBSERVER_BASELINE.candidateArticles).toBeTruthy();
    expect(report.overlap <= SWISS_INSTITUTION_OBSERVER_BASELINE.overlap).toBeTruthy();
  });

  it('no known incorrect facts in any IT body', () => {
    expect(scanIt(INCORRECT_FACTS)).toEqual([]);
  });

  it('no vague sourcing with precise statistics in any IT body', () => {
    expect(scanIt(VAGUE_SOURCING)).toEqual([]);
  });

  it('no fabricated "federal labour office" institution in any locale (real: SECO)', () => {
    const offenders = [];
    for (const f of files) {
      const pattern = FABRICATED_LABOR_OFFICE[f.locale];
      if (!pattern) continue;
      if (pattern.test(extractTextContent(f.path))) {
        offenders.push(`${f.id}: fabricated "federal labour office" (real: SECO)`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no body in any locale dates the Italy-Switzerland Convention 9 December 1976 (it is 9 March 1976)', () => {
    const offenders = [];
    for (const f of files) {
      const pattern = WRONG_CONVENTION_DATE[f.locale];
      if (!pattern) continue;
      if (pattern.test(extractTextContent(f.path))) {
        offenders.push(`${f.id}: Convenzione del 9 marzo 1976, non 9 dicembre`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
