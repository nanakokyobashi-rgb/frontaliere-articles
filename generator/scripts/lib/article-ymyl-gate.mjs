/**
 * article-ymyl-gate.mjs — fisco, previdenza e tassa salute non escono in automatico
 * senza una fonte ufficiale e senza passare il controllo dei parametri fiscali.
 *
 * ## Il difetto
 *
 * Audit del 2026-10-31: importi inventati della tassa salute, una «esenzione» che
 * non esiste, un articolo francese che confonde 2.500 e 10.000 CHF. Misurato sul
 * corpus: 1.350 articoli YMYL dichiarati nel titolo, 66 con un link a una fonte
 * ufficiale (4,9%). Un articolo fiscale pubblicato senza una fonte primaria non ha
 * niente che lo tenga ancorato ai fatti.
 *
 * ## Il contratto
 *
 * Un articolo e' YMYL se titolo, id o excerpt parlano di fisco, previdenza, sanita'
 * dei frontalieri. Per questi, prima della pubblicazione automatica:
 *
 *  1. almeno un link a un dominio ufficiale, nel testo o come fonte dell'articolo;
 *  2. nessun errore di `findFiscalErrors` (lib/fiscal-claims-guard.mjs).
 *
 * Il rifiuto e' un rifiuto del topic-gate: l'articolo non esce, il ranker prosegue e
 * la fonte viene ricordata. La redazione puo' sempre pubblicarlo dal percorso del
 * giornalista, che e' umano e non passa da qui.
 *
 * Modulo puro.
 */
import { normalizeText } from './profession-taxonomy.mjs';
import { findFiscalErrors } from './fiscal-claims-guard.mjs';

/** Domini delle fonti primarie, sottodomini compresi. */
export const OFFICIAL_SOURCE_DOMAINS = Object.freeze([
  'admin.ch', 'ti.ch', 'ch.ch', 'ahv-iv.ch', 'parlament.ch',
  'agenziaentrate.gov.it', 'inps.it', 'normattiva.it', 'gazzettaufficiale.it',
  'mef.gov.it', 'finanze.gov.it', 'salute.gov.it', 'governo.it', 'camera.it', 'senato.it',
  'regione.lombardia.it', 'regione.piemonte.it',
]);

/**
 * Pagine verificate il 2026-10-31 nella scheda fonti primarie: il prompt le offre al
 * modello, cosi' il gate non rifiuta per mancanza di un link che il modello non
 * avrebbe saputo scrivere.
 */
export const OFFICIAL_SOURCE_LINKS = Object.freeze([
  { topic: 'imposte dei frontalieri', label: 'Foglio informativo AFC', url: 'https://m4.ti.ch/fileadmin/DFE/DC/DOC-IF/nuovo_accordo/nuovo_accordo_foglio_informativo_FAQ.pdf' },
  { topic: 'franchigia e credito in Italia', label: 'Agenzia delle Entrate', url: 'https://www.agenziaentrate.gov.it/portale/norme-per-i-pendolari-transfrontalieri-dei-paesi-confinanti' },
  { topic: 'Accordo sui frontalieri', label: 'L. 83/2023', url: 'https://www.normattiva.it/uri-res/N2Ls?urn:nir:stato:legge:2023-06-13;83' },
  { topic: 'AVS, AI e IPG', label: 'Tabella sinottica AVS 2026', url: 'https://www.ahv-iv.ch/p/2.01.i' },
  { topic: 'previdenza', label: 'UFAS', url: 'https://www.bsv.admin.ch/it/telelavoro' },
  { topic: 'quota SSN, detta tassa salute', label: 'DM Salute 14/11/2025', url: 'https://www.gazzettaufficiale.it/eli/gu/2025/12/18/293/sg/pdf' },
]);

const sourcesBrief = (links) => `FONTI UFFICIALI (per fisco, previdenza e tassa salute l'articolo non esce senza almeno un link a una di queste, in formato [etichetta](url)):
${links.map(({ topic, label, url }) => `- ${topic}: [${label}](${url})`).join('\n')}`;

export const YMYL_SOURCES_BRIEF = sourcesBrief(OFFICIAL_SOURCE_LINKS);

/** Sezione svizzera: il suo brief non deve portare il ground truth frontaliero. */
export const YMYL_SOURCES_BRIEF_CH = sourcesBrief([
  OFFICIAL_SOURCE_LINKS.find(({ label }) => label.startsWith('Tabella sinottica')),
  OFFICIAL_SOURCE_LINKS.find(({ label }) => label === 'UFAS'),
]);

const YMYL_RE = /(?:^| )(?:tassa salute|tassa sulla salute|imposta alla fonte|imposte alla fonte|irpef|dichiarazione dei redditi|franchigia|detrazion|deduzion|avs|lpp|pilastro|previdenz|pension|inps|naspi|ristorn|lamal|cassa malati|casse malati|accordo fiscale|doppia imposizione|fisco|fiscal)/;

/**
 * @param {{id?: string, title?: string, excerpt?: string}} article testi italiani
 * @returns {boolean}
 */
export function isYmylArticle({ id = '', title = '', excerpt = '' }) {
  return YMYL_RE.test(` ${normalizeText(`${id} ${title} ${excerpt}`)} `);
}

function hostnameOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

export function isOfficialSourceUrl(url) {
  const host = hostnameOf(url);
  return OFFICIAL_SOURCE_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

/** Link assoluti del testo, in markdown o nudi. */
export function linksIn(text) {
  return [...String(text ?? '').matchAll(/https?:\/\/[^\s)\]"'<>]+/g)].map((match) => match[0]);
}

function articleText(it = {}) {
  return Object.keys(it)
    .filter((key) => /^(?:title|excerpt|faq|body\d+)$/.test(key))
    .map((key) => (typeof it[key] === 'string' ? it[key] : JSON.stringify(it[key])))
    .join('\n');
}

/**
 * @param {{id?: string, content?: {it?: Record<string, unknown>}}} data
 * @param {{sourceUrl?: string}} [options] fonte da cui l'articolo e' stato generato
 * @returns {{ymyl: boolean, problems: string[]}}
 */
export function checkYmylPublishable(data, { sourceUrl = '' } = {}) {
  const it = data?.content?.it ?? {};
  if (!isYmylArticle({ id: data?.id, title: it.title, excerpt: it.excerpt })) {
    return { ymyl: false, problems: [] };
  }
  const text = articleText(it);
  const problems = findFiscalErrors(text).map((error) => `${error.id} (${error.source}): ${error.sentence.trim().slice(0, 120)}`);
  if (![sourceUrl, ...linksIn(text)].some(isOfficialSourceUrl)) {
    problems.unshift('nessun link a una fonte ufficiale');
  }
  return { ymyl: true, problems };
}

/**
 * Da chiamare prima della pubblicazione automatica.
 *
 * @throws {Error} con `topicGateAbort`, come ogni rifiuto che non deve pubblicare
 */
export function assertYmylPublishable(data, options) {
  const { problems } = checkYmylPublishable(data, options);
  if (problems.length === 0) return;
  const error = new Error(`topic-gate abort: articolo YMYL non pubblicabile in automatico: ${problems.join('; ')}`);
  error.topicGateAbort = true;
  throw error;
}

/**
 * Le traduzioni possono reintrodurre un errore che l'italiano non ha.
 *
 * @param {Record<string, Record<string, unknown>>} contentByLocale
 */
export function assertNoFiscalErrorsInLocales(contentByLocale) {
  for (const [locale, content] of Object.entries(contentByLocale)) {
    const errors = findFiscalErrors(articleText(content));
    if (errors.length === 0) continue;
    const error = new Error(`[fiscal-claims] ${locale}: ${errors[0].id} (${errors[0].source}): ${errors[0].sentence.trim().slice(0, 120)}`);
    error.qualityReject = true;
    throw error;
  }
}
