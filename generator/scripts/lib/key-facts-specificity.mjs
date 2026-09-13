/**
 * Rilevazione e riparazione deterministica dei fatti chiave senza valore.
 *
 * La forma che ci interessa e' una coppia termine -> valore il cui valore e'
 * un non-valore («Quando: non specificato»). Il rilevatore resta ancorato al
 * valore intero: la frase «il servizio non e' disponibile il sabato» e' prosa
 * utile, non un fatto vuoto.
 *
 * Il modulo e' puro. Lo scanner del corpus lo usa per la misura; il generatore
 * lo usa per togliere una coppia vuota quando restano almeno tre fatti, oppure
 * per rifiutare il payload quando la sezione scende sotto quella soglia.
 */

import { getKeyFactsHeading } from './ai-search-template.mjs';

export const SUPPORTED_LOCALES = Object.freeze(['it', 'en', 'de', 'fr']);
export const KEY_FACTS_HEADINGS = Object.freeze(
  SUPPORTED_LOCALES.map((locale) => getKeyFactsHeading(locale)),
);

/** La stessa soglia minima richiesta dal serializzatore AI-search. */
export const MIN_FACTS_PER_SECTION = 3;

/**
 * Forma di riferimento usata dalla metrica di #1054. E' volutamente piu'
 * stretta del gate: il numero deve restare confrontabile con il grep
 * versionato nell'issue, mentre il gate puo' riconoscere anche sinonimi e
 * varianti morfologiche.
 */
export const REFERENCE_FACT_TERMS = Object.freeze([
  'Cosa', 'Quando', 'Dove', 'Chi', 'Perché',
  'What', 'When', 'Where', 'Who', 'Why',
  'Was', 'Wann', 'Wo', 'Wer', 'Warum',
  'Quoi', 'Quand', 'Où', 'Qui', 'Pourquoi',
]);
export const REFERENCE_VACUOUS_VALUES = Object.freeze([
  'non specificato',
  'not specified',
  'nicht angegeben',
  'non spécifié',
]);

/** Frasi che indicano un dato assente, senza ancore di parola. */
export const VACUOUS_PHRASES = Object.freeze([
  // Italiano
  String.raw`non\s+(?:(?:e|è|e'|sono|sta|stato|stati|state)\s+)?(?:ancora\s+)?(?:stat[oaie]\s+)?(?:specificat[oaie]|indicat[oaie]|precisat[oaie]|definit[oaie]|dichiarat[oaie]|comunicat[oaie]|disponibil[ei])`,
  String.raw`nessun\s+dato(?:\s+disponibile)?`,
  String.raw`(?:dato|informazione|importo|cifra)\s+non\s+disponibil[ei]`,
  String.raw`da\s+(?:definire|specificare|confermare)`,
  String.raw`non\s+applicabile`,
  String.raw`sconosciut[oaie]`,
  // English
  String.raw`not\s+(?:yet\s+)?(?:specified|stated|indicated|disclosed|available|provided|known)`,
  String.raw`to\s+be\s+(?:defined|confirmed|announced)`,
  String.raw`unspecified`,
  String.raw`unknown`,
  // Deutsch
  String.raw`(?:(?:noch|derzeit|bislang|bisher)\s+)?nicht\s+(?:(?:näher|naeher)\s+)?(?:angegeben|spezifiziert|genannt|bekannt|verfügbar|verfuegbar)`,
  String.raw`keine\s+angaben?`,
  String.raw`unbekannt`,
  // Francais
  String.raw`non\s+(?:encore\s+)?(?:spécifi(?:é|ée|és|ées)|précis(?:é|ée|és|ées)|indiqu(?:é|ée|és|ées)|communiqu(?:é|ée|és|ées)|disponible(?:s)?)`,
  String.raw`à\s+définir`,
  String.raw`inconnu(?:e|es|s)?`,
  String.raw`sans\s+objet`,
]);

/** Sigle/parola sola: valgono solo sul valore intero. */
export const VACUOUS_TOKENS = Object.freeze([
  String.raw`n\s*[./]\s*[ad]`,
  String.raw`n\s*[ad]`,
  String.raw`non\s+applicable`,
  String.raw`tbd`,
  String.raw`n/?a`,
  String.raw`k\.?a\.?`,
]);

export const VACUOUS_VALUE_ALTERNATIVES = Object.freeze([
  ...VACUOUS_PHRASES,
  ...VACUOUS_TOKENS,
]);

const VACUOUS_VALUE_RX = new RegExp(
  `^(?:${VACUOUS_VALUE_ALTERNATIVES.join('|')})$`,
  'iu',
);
const VACUOUS_ANYWHERE_RX = new RegExp(`(?:${VACUOUS_PHRASES.join('|')})`, 'iu');

function normalizeText(value) {
  return String(value)
    .normalize('NFKC')
    .replace(/[’‘]/gu, "'")
    .replace(/\s+/gu, ' ')
    .trim()
    .toLowerCase();
}

function trimValueMarkup(value) {
  return normalizeText(value)
    .replace(/^[\s"'«»()[\]*_`]+/u, '')
    .replace(/[\s"'«»()[\]*_`.,;:!?]+$/u, '')
    .trim();
}

/** Vero se il valore completo del fatto e' un non-valore. */
export function matchesVacuousValue(value) {
  if (typeof value !== 'string') return false;
  return VACUOUS_VALUE_RX.test(trimValueMarkup(value));
}

/**
 * Estrae il valore dopo l'ultimo `:`. Alcuni modelli scrivono, per esempio,
 * `Chi: Ente competente: non specificato`.
 */
export function factValueOf(item) {
  const clean = String(item)
    .replace(/\*\*/gu, '')
    .replace(/^[\s>*•-]+/u, '')
    .trim();
  const lastColon = clean.lastIndexOf(':');
  return lastColon === -1 ? clean : clean.slice(lastColon + 1).trim();
}

const HEADING_RX = /^\s{0,3}#{1,6}\s/;
const isHeading = (line) => HEADING_RX.test(line);
const isKeyFactsHeading = (line) => KEY_FACTS_HEADINGS.some(
  (heading) => line.trim().toLowerCase() === heading.toLowerCase(),
);

/**
 * Divide il corpo della sezione nei bullet. I corpi pubblicati usano un
 * bullet per riga; viene mantenuto anche il caso di più bullet sulla stessa
 * riga, pur evitando di scambiare un trattino numerico (`200 - 300`) per un
 * nuovo bullet.
 */
function splitBullets(sectionBody) {
  const bulletRx = /(?:^|\n)[ \t]*[-*•](?=\s+)|[ \t]+[-*•](?=\s+(?:\*\*|[A-ZÀ-ÖØ-Þ][^:\n]{0,40}:))/gu;
  const bullets = [];
  let match;
  let start = -1;

  while ((match = bulletRx.exec(sectionBody)) !== null) {
    const markerOffset = match[0].search(/[-*•]/u);
    const markerStart = match.index + markerOffset;
    if (start !== -1) bullets.push({ start, end: markerStart });
    start = markerStart;
  }
  if (start === -1) return [];
  bullets.push({ start, end: sectionBody.length });

  return bullets.map(({ start: bulletStart, end: bulletEnd }) => {
    const rawSpan = sectionBody.slice(bulletStart, bulletEnd);
    const blankLine = rawSpan.search(/\n[ \t]*\n/u);
    const end = blankLine === -1 ? bulletEnd : bulletStart + blankLine;
    return {
      start: bulletStart,
      end,
      raw: sectionBody.slice(bulletStart, end),
      value: factValueOf(sectionBody.slice(bulletStart, end)),
    };
  });
}

/**
 * @param {string} body
 * @returns {Array<{heading: string, headingStart: number, start: number, end: number, bullets: Array<{start: number, end: number, raw: string, value: string}>}>}
 */
export function parseAiSearchSections(body) {
  if (typeof body !== 'string' || body.length === 0) return [];
  const lines = body.split('\n');
  const lineStarts = [];
  let offset = 0;
  for (const line of lines) {
    lineStarts.push(offset);
    offset += line.length + 1;
  }

  const sections = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!isKeyFactsHeading(lines[i])) continue;
    let next = i + 1;
    while (next < lines.length && !isHeading(lines[next])) next += 1;
    const start = lineStarts[i] + lines[i].length + 1;
    const end = next < lines.length ? lineStarts[next] : body.length;
    const sectionBody = body.slice(start, end);
    sections.push({
      heading: lines[i].trim(),
      headingStart: lineStarts[i],
      start,
      end,
      bullets: splitBullets(sectionBody).map((bullet) => ({
        ...bullet,
        start: bullet.start + start,
        end: bullet.end + start,
      })),
    });
    i = next - 1;
  }
  return sections;
}

/**
 * Misura sia il valore-segnaposto riparabile sia la prosa prudenziale. La
 * seconda forma viene segnalata ma non modificata automaticamente.
 */
export function findVacuousFacts(body) {
  const hits = [];
  for (const section of parseAiSearchSections(body)) {
    for (const bullet of section.bullets) {
      const text = bullet.raw.trim();
      if (matchesVacuousValue(bullet.value)) {
        hits.push({
          heading: section.heading,
          kind: 'placeholder-value',
          text,
          value: bullet.value,
          start: bullet.start,
          end: bullet.end,
        });
      } else if (VACUOUS_ANYWHERE_RX.test(normalizeText(bullet.value)) && !/\d/u.test(bullet.value)) {
        hits.push({
          heading: section.heading,
          kind: 'hedged-prose',
          text,
          value: bullet.value,
          start: bullet.start,
          end: bullet.end,
        });
      }
    }
  }
  return hits;
}

/**
 * Trova esattamente la forma usata dal comando di riferimento dell'issue:
 * case-sensitive, quattro valori letterali e fino a due `*` fra termine e
 * `:`. Non sostituire questa misura con `findVacuousFacts()`: allargherebbe il
 * baseline a sinonimi storici e renderebbe il 53 non riproducibile.
 */
export function findReferenceVacuousFacts(body) {
  if (typeof body !== 'string' || body.length === 0) return [];
  const terms = REFERENCE_FACT_TERMS.join('|');
  const values = REFERENCE_VACUOUS_VALUES.map((value) => value.replace(/\s+/gu, '\\s+')).join('|');
  const referenceRx = new RegExp(`(${terms})\\*{0,2}: ?(${values})`, 'g');
  return [...body.matchAll(referenceRx)].map((match) => ({
    term: match[1],
    value: match[2],
    text: match[0],
    index: match.index,
  }));
}

/**
 * Toglie le coppie `placeholder-value` solo quando la sezione conserva almeno
 * tre fatti. In caso contrario ritorna `rejected: true` senza mutare il body:
 * il caller deve rigenerare l'articolo, non pubblicare una sezione vuota.
 */
export function stripVacuousFacts(body) {
  const empty = {
    value: body,
    changed: false,
    dropped: [],
    sectionsRemoved: [],
    rejected: false,
    rejectedSections: [],
    rejectedFacts: [],
    residual: [],
  };
  if (typeof body !== 'string' || body.length === 0) return empty;

  const cuts = [];
  const dropped = [];
  const rejectedSections = [];
  const rejectedFacts = [];
  const residual = [];

  for (const section of parseAiSearchSections(body)) {
    const bad = section.bullets.filter((bullet) => matchesVacuousValue(bullet.value));
    for (const bullet of section.bullets) {
      if (bad.includes(bullet)) continue;
      if (VACUOUS_ANYWHERE_RX.test(normalizeText(bullet.value)) && !/\d/u.test(bullet.value)) {
        residual.push({ heading: section.heading, kind: 'hedged-prose', text: bullet.raw.trim() });
      }
    }
    if (bad.length === 0) continue;

    const survivors = section.bullets.length - bad.length;
    if (survivors < MIN_FACTS_PER_SECTION) {
      rejectedSections.push(section.heading);
      rejectedFacts.push(...bad.map((bullet) => bullet.raw.trim()));
      continue;
    }
    dropped.push(...bad.map((bullet) => bullet.raw.trim()));
    cuts.push(...bad.map((bullet) => ({ start: bullet.start, end: bullet.end })));
  }

  if (rejectedSections.length > 0) {
    return {
      ...empty,
      rejected: true,
      rejectedSections,
      rejectedFacts,
      residual,
    };
  }
  if (cuts.length === 0) return { ...empty, residual };

  cuts.sort((a, b) => b.start - a.start);
  let value = body;
  for (const cut of cuts) value = value.slice(0, cut.start) + value.slice(cut.end);
  value = value.replace(/\n{3,}/gu, '\n\n').trimEnd();

  return {
    ...empty,
    value,
    changed: value !== body,
    dropped,
    residual,
  };
}

export default {
  SUPPORTED_LOCALES,
  KEY_FACTS_HEADINGS,
  MIN_FACTS_PER_SECTION,
  REFERENCE_FACT_TERMS,
  REFERENCE_VACUOUS_VALUES,
  VACUOUS_PHRASES,
  VACUOUS_TOKENS,
  VACUOUS_VALUE_ALTERNATIVES,
  matchesVacuousValue,
  factValueOf,
  parseAiSearchSections,
  findVacuousFacts,
  findReferenceVacuousFacts,
  stripVacuousFacts,
};
