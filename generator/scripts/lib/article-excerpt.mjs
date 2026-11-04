/**
 * Plain-text contract for the short excerpt and the metadata descriptions
 * derived from it.
 *
 * Article bodies are Markdown, but an excerpt is a reader-facing sentence:
 * it is emitted into locale metadata, cards, feeds and SEO surfaces.  Keep
 * the repair deterministic and small enough to use without loading the
 * generator's model/network dependencies.  Completion checks use the shared
 * SERP tail repair so the generator and publisher reject the same dangling
 * clause patterns.
 */

import { TRAILING_STOPWORDS } from '../../../host/shared/clauseTail.mjs';
import {
  SEO_DESCRIPTION_MAX,
  SEO_DESCRIPTION_MIN,
  SEO_OG_DESCRIPTION_MAX,
} from './seo-description-contract.mjs';
import { detectWrongLatinLanguageInField } from './itLanguageCheck.mjs';

export const EXCERPT_MAX_LENGTH = 280;
export const EXCERPT_MIN_LENGTH = 60;

export const SENTENCE_ABBREVIATIONS = Object.freeze([
  'n.', 'nr.', 'art.', 'artt.', 'cpv.', 'lett.', 'par.', 'cfr.', 'ecc.', 'p.es.', 'ca.', 'ss.',
  'sig.', 'dott.', 'prof.', 'on.', 'S.', 'St.', 'Dr.', 'Abs.', 'Ziff.', 'bzw.', 'z.B.', 'u.a.',
  'etc.', 'e.g.', 'i.e.', 'no.', 'vs.', 'M.', 'Mme.',
]);
const SENTENCE_ABBREVIATION_SET = new Set(SENTENCE_ABBREVIATIONS.map((value) => value.toLocaleLowerCase()));
const MULTI_INITIAL_ABBREVIATION_RE = /^(?:[A-ZÀ-ÖØ-Þ]\.){2,}$/u;
const GERMAN_DATE_ORDINAL_PREFIX_RE = /(?:^|\s)(?:am|ab dem|seit dem|dem|den|zum|bis zum|vom)\s+\d{1,2}$/iu;
const TERMINAL_DATE_FRAGMENT_RE = /(?:^|\s)(?:am|ab dem|seit dem|dem|den|zum|bis zum|vom|on|from|until|le|du|au|dal|al|il|per il|entro(?: il)?|da|scadenza|deadline)\s+\d{1,2}$/iu;
const TERMINAL_DATE_RANGE_YEAR_FRAGMENT_RE = /\b(?:dal|da|from|du|de|vom)\s+\d{1,2}\s+(?:al|au|to|bis)\s+\d{1,2}\s+(?:gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre|january|february|march|april|may|june|july|august|september|october|november|december|januar|februar|märz|mai|juni|juli|oktober|dezember|janvier|février|juin|juillet|août|septembre|octobre|décembre)\s+\d{1,2}$/iu;
const TERMINAL_NUMBER_AFTER_LIST_CONNECTOR_RE = /\d[\d.,%]*\s+(?:\p{L}[\p{L}'’.-]*\s+){1,5}(?:e|ed|and|or|und|oder|et|ou)\s+\d{1,4}$/iu;
const PERMIT_CODE_CONTEXT_RE = /\b(?:ausweis|bewilligung|permit|permis|permesso)\b[^.!?]{0,64}$/iu;
const TERMINAL_LABEL_INITIAL_CONTEXT_RE = /\b(?:serie|series|série|piano|plan|gruppo|gruppe|groupe|group|punkt|point|tipo|typ|type|classe|klasse|class|categoria|catégorie|category|fase|phase|girone|pool|league|liga|ligue|lega|divisione|division|versione|version|livello|level|grado|grade|section|sezione)\s*$/iu;
const TERMINAL_SENTENCE_PUNCTUATION_RE = /[.!?…]["'’”»)}\]]*$/u;
const PUBLISHING_KEYWORD_EQUIVALENTS = new Set([
  'pubblicato', 'pubblicata', 'pubblicati', 'pubblicate', 'pubblicare', 'pubblicazione',
  'published', 'publish', 'publishes', 'publishing', 'publication',
  'publié', 'publiée', 'publiés', 'publiées', 'publier', 'publication',
  'publiziert', 'publizierte', 'publizierten', 'publizieren', 'veröffentlicht', 'veröffentlichung', 'veröffentlichen',
]);

const LABEL_RE = /^(?:In breve|In short|Kurz gesagt|En bref)\b/i;
const LABEL_START_RE = /^(?:#{1,6}\s*)?(?:In breve|In short|Kurz gesagt|En bref)\b/i;
const LABEL_PREFIX_RE = /^(?:(?:In breve|In short|Kurz gesagt|En bref)\b\s*(?::|[-–—])?\s*)+/i;
const HEADING_RE = /^\s*#{1,6}\s+(.+?)\s*$/;
const LIST_ITEM_RE = /^\s*(?:[-*+]|\d+\.)\s+\S/;
const DATE_PREFIX_RE = /^\s*(?:0?[1-9]|[12]\d|3[01])\.\s+(?:gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre|january|february|march|april|may|june|july|august|september|october|november|december|januar|februar|märz|mai|juni|juli|oktober|dezember|janvier|février|juin|juillet|août|septembre|octobre|décembre)\b/iu;
const TABLE_SEPARATOR_RE = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/;
const TABLE_ROW_RE = /^\s*\|?[^\n|]+\|[^\n]*\|?\s*$/;
const REFERENCE_LINK_RE = /\[[^\]\n]+\]\[[^\]\n]*\]/;
const REFERENCE_DEFINITION_LINE_RE = /^\s{0,3}\[[^\]\n]+\]:\s+\S+/m;
const HORIZONTAL_RULE_LINE_RE = /^\s{0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})\s*$/;

const PLAIN_DESCRIPTION_FIELDS = Object.freeze([
  'excerpt',
  'seoDescription',
  'ogDescription',
  'description',
]);

const ORPHANED_DESCRIPTION_LABEL_RE = /(?:\b(?:Statements|Dichiarazioni|Déclarations|Gegenstand|Subject|Objet|Oggetto|Focus)|\b(?:with|con|mit|avec)\s+(?:a\s+)?focus|would remain subject)$/iu;
const INCOMPLETE_SHORT_SENTENCE_VERBS = new Set([
  'valuta', 'valutano', 'analizza', 'analizzano', 'esamina', 'esaminano', 'considera', 'considerano',
  'introduce', 'introducono', 'applica', 'applicano', 'spiega', 'spiegano', 'prevede', 'prevedono',
  'consente', 'consentono', 'mostra', 'mostrano', 'indica', 'indicano', 'conferma', 'confermano',
  'affronta', 'affrontano', 'definisce', 'discute', 'richiede', 'chiarisce', 'comprende',
  'evaluates', 'assesses', 'analyzes', 'analyses', 'examines', 'introduces', 'applies', 'explains',
  'predicts', 'allows', 'shows', 'indicates', 'confirms', 'announces', 'addresses', 'defines',
  'discusses', 'argues', 'requires', 'clarifies', 'includes', 'covers', 'offers',
  'bewertet', 'analysiert', 'untersucht', 'erklärt', 'zeigt', 'bestätigt', 'kündigt', 'betrifft',
  'definiert', 'diskutiert', 'fordert', 'erfordert', 'klärt', 'umfasst', 'bietet', 'beinhaltet',
  'évalue', 'évaluent', 'analyse', 'analysent', 'examine', 'examinent', 'introduit', 'applique',
  'explique', 'prévoit', 'permet', 'montre', 'indique', 'confirme', 'annonce', 'concerne',
  'définit', 'discute', 'soutient', 'exige', 'précise', 'comprend',
]);
const GERMAN_SEPARABLE_PARTICLE_PATTERNS = Object.freeze({
  aus: /\b(?:weisen|weist|weise|wies|wiesen|stellen|stellt|stelle|stellte|zahlen|zahlt|zahlte|gehen|geht|ging|geben|gibt|gab|sehen|sieht|sah|führen|führt|führte|fallen|fällt|fiel|machen|macht|machte|werfen|wirft|warf|zeichnen|zeichnet|zeichnete|lösen|löst|löste|lösten|schließen|schließt|schliesst|schloss|schlossen)\b[^.!?]{0,280}\baus$/iu,
  auf: /\b(?:stehen|steht|stehe|stand|standen|wachen|wacht|baue|bauen|baut|nahm|nehmen|nimmt|passen|passt|passte|greifen|greift|treten|tritt|kommen|kommt|werfen|wirft|warf)\b[^.!?]{0,280}\bauf$/iu,
  an: /\b(?:fangen|fängt|fing|rufen|ruft|rief|melden|meldet|sehen|sieht|nehmen|nimmt|bieten|bietet|liegen|liegt|stellen|stellt|kündigen|kündigt|kündigte|klagen|klagt|klagte|steigen|steigt|stieg|stiegen)\b[^.!?]{0,280}\ban$/iu,
  ab: /\b(?:geben|gibt|gab|sagen|sagt|stimmen|stimmt|fahren|fährt|laufen|läuft|hängen|hängt|schließen|schließt|zeichnen|zeichnet)\b[^.!?]{0,280}\bab$/iu,
  ein: /\b(?:laden|lädt|führen|führt|stellen|stellt|richten|richtet|zahlen|zahlt|steigen|steigt|stieg|stufen|stuft|leiten|leitet|leitete|greifen|greift)\b[^.!?]{0,280}\bein$/iu,
  mit: /\b(?:arbeiten|arbeitet|bringen|bringt|machen|macht|teilen|teilt|kommen|kommt|spielen|spielt|wirken|wirkt)\b[^.!?]{0,280}\bmit$/iu,
  vor: /\b(?:stellen|stellt|sehen|sieht|liegen|liegt|kommen|kommt|bereiten|bereitet|tragen|trägt)\b[^.!?]{0,280}\bvor$/iu,
  nach: /\b(?:fragen|fragt|denken|denkt|dachte|suchen|sucht|schauen|schaut|machen|macht)\b[^.!?]{0,280}\bnach$/iu,
  durch: /\b(?:führen|führt|setzen|setzt|gehen|geht|lesen|liest)\b[^.!?]{0,280}\bdurch$/iu,
  um: /\b(?:ziehen|zieht|steigen|steigt|stellen|stellt|bauen|baut|drehen|dreht|setzen|setzt)\b[^.!?]{0,280}\bum$/iu,
  über: /\b(?:legen|legt|nehmen|nimmt|geben|gibt|weisen|weist|tragen|trägt|setzen|setzt|schreiben|schreibt)\b[^.!?]{0,280}\büber$/iu,
  unter: /\b(?:bringen|bringt|stellen|stellt|gehen|geht)\b[^.!?]{0,280}\bunter$/iu,
  zu: /\b(?:nehmen|nimmt|lassen|lässt|machen|macht|stimmen|stimmt|hören|hört)\b[^.!?]{0,280}\bzu$/iu,
});
const AUXILIARY_ENDINGS = new Set([
  'è', 'sono', 'era', 'erano', 'stato', 'stata', 'stati', 'state', 'essere', 'essendo',
  'be', 'been', 'being', 'was', 'were', 'am', 'is', 'are',
  'ist', 'sind', 'war', 'waren', 'sein', 'gewesen',
  'est', 'sont', 'être', 'été', 'était', 'étaient',
]);
const FINITE_AUXILIARY_ENDINGS = new Set([
  'è', 'sono', 'era', 'erano', 'was', 'were', 'am', 'is', 'are',
  'ist', 'sind', 'war', 'waren', 'est', 'sont', 'était', 'étaient',
]);
const NONFINITE_AUXILIARY_ENDINGS = new Set([
  'stato', 'stata', 'stati', 'state', 'essere', 'essendo',
  'be', 'been', 'being', 'sein', 'gewesen', 'être', 'été',
]);
const SUBORDINATE_FUNCTION_WORDS = new Set([
  'a', 'an', 'the', 'this', 'that', 'these', 'those', 'it', 'they', 'he', 'she', 'we', 'you',
  'which', 'who', 'what', 'when', 'where', 'how', 'as', 'because', 'while',
  'der', 'die', 'das', 'ein', 'eine', 'einer', 'eines', 'es', 'er', 'sie', 'wir', 'ihr',
  'welcher', 'welches', 'dessen', 'deren', 'denen', 'wie', 'was', 'wann', 'wo', 'weil', 'dass',
  'muss', 'müssen', 'soll', 'sollen', 'kann', 'können', 'darf', 'dürfen', 'will', 'wollen', 'mag', 'mögen', 'möchte',
  'le', 'la', 'les', 'un', 'une', 'des', 'ce', 'ces', 'il', 'elle', 'ils', 'elles', 'qui', 'que',
  'lo', 'gli', 'uno', 'una', 'questo', 'questa', 'quello', 'quella', 'che', 'come', 'dove', 'quando',
]);
const SUBORDINATE_SUBJECT_PRONOUNS = new Set([
  'it', 'they', 'he', 'she', 'we', 'you', 'es', 'er', 'sie', 'wir', 'ihr', 'il', 'elle', 'ils', 'elles',
]);
const SUBORDINATE_MARKERS_AS_SUBJECT = new Set(['which', 'who', 'what', 'was', 'die', 'der', 'das', 'welche', 'welcher', 'welches']);
const PREDICATIVE_COMPLEMENTS = Object.freeze({
  en: new Set(['absent', 'available', 'aware', 'different', 'difficult', 'effective', 'eligible', 'false', 'final', 'high', 'important', 'impossible', 'incomplete', 'incorrect', 'large', 'late', 'legal', 'liable', 'low', 'necessary', 'old', 'official', 'possible', 'present', 'protected', 'public', 'ready', 'responsible', 'safe', 'separate', 'serious', 'short', 'similar', 'small', 'strong', 'sufficient', 'true', 'uncertain', 'valid', 'weak', 'wide']),
  de: new Set(['alt', 'ausgenommen', 'bekannt', 'beschäftigt', 'betroffen', 'erforderlich', 'gefallen', 'gewidmet', 'gescheitert', 'gestiegen', 'gültig', 'geeignet', 'hoch', 'klar', 'komplex', 'kurz', 'lang', 'möglich', 'niedrig', 'notwendig', 'offen', 'richtig', 'schwierig', 'sicher', 'stark', 'tief', 'ungewiss', 'verbunden', 'verfügbar', 'wichtig', 'zuständig']),
  fr: new Set(['applicable', 'disponible', 'important', 'nécessaire', 'possible', 'présent', 'responsable', 'valable', 'vrai']),
  it: new Set(['applicabile', 'disponibile', 'importante', 'necessario', 'possibile', 'presente', 'responsabile', 'valido', 'vero']),
});
const DEGREE_PREDICATIVE_COMPLEMENTS = Object.freeze({
  en: new Set(['absent', 'available', 'aware', 'different', 'difficult', 'effective', 'eligible', 'expensive', 'high', 'higher', 'important', 'impossible', 'incorrect', 'large', 'larger', 'late', 'legal', 'liable', 'low', 'lower', 'necessary', 'old', 'older', 'possible', 'present', 'public', 'safe', 'serious', 'short', 'shorter', 'similar', 'small', 'smaller', 'strong', 'stronger', 'sufficient', 'true', 'uncertain', 'valid', 'weak', 'weaker', 'wide', 'wider']),
  de: new Set(['alt', 'älter', 'besser', 'billiger', 'erforderlich', 'groß', 'größer', 'gültig', 'hoch', 'höher', 'klar', 'kleiner', 'komplex', 'kurz', 'kürzer', 'langsam', 'langsamer', 'länger', 'möglich', 'niedrig', 'niedriger', 'notwendig', 'offen', 'richtig', 'schlechter', 'schwierig', 'schwächer', 'schnell', 'schneller', 'sicher', 'stark', 'stärker', 'teuer', 'teurer', 'tief', 'ungewiss', 'wichtig', 'zuständig', 'jünger']),
});
const COMPARATIVE_PREDICATES = Object.freeze({
  en: new Set(['cheaper', 'easier', 'earlier', 'faster', 'higher', 'larger', 'later', 'longer', 'lower', 'older', 'safer', 'shorter', 'smaller', 'stronger', 'weaker', 'wider', 'younger']),
  de: new Set(['älter', 'besser', 'billiger', 'einfacher', 'früher', 'größer', 'häufiger', 'höher', 'interessanter', 'kleiner', 'kürzer', 'langsamer', 'länger', 'niedriger', 'seltener', 'schneller', 'schlechter', 'schwächer', 'sicherer', 'stärker', 'teurer', 'wichtiger', 'weniger', 'jünger', 'später']),
});
const COMPARATIVE_INTENSIFIERS = Object.freeze({
  en: new Set(['considerably', 'even', 'far', 'marginally', 'much', 'significantly', 'slightly', 'substantially']),
  de: new Set(['deutlich', 'erheblich', 'etwas', 'merklich', 'noch', 'spürbar', 'viel', 'wesentlich']),
});
const GERMAN_GENITIVE_MARKERS = new Set(['des', 'eines', 'einer', 'dessen', 'deren', 'seines', 'seiner', 'ihres', 'ihrer']);
const GERMAN_DATIVE_PREPOSITIONS = new Set(['ab', 'an', 'auf', 'aus', 'bei', 'gegenüber', 'hinter', 'in', 'mit', 'nach', 'neben', 'über', 'unter', 'vor', 'von', 'zwischen', 'zu']);
const GERMAN_NONPREDICATIVE_ADVERBS = new Set(['damals', 'danach', 'davor', 'derzeit', 'gestern', 'heute', 'inzwischen', 'jetzt', 'morgen', 'nahezu', 'später', 'weiterhin']);
const SUBORDINATE_LOCATIVE_MARKERS = new Set(['where', 'wo', 'où', 'dove']);
const LOCATIVE_SUBJECT_WORDS = new Set(['this', 'that', 'these', 'those']);
const EN_QUANTITY_WORDS = new Set(['many', 'much', 'few', 'little']);
const DEGREE_DETERMINERS = Object.freeze({
  en: new Set(['a', 'an', 'the', 'this', 'that', 'these', 'those', 'some', 'any', 'each', 'every']),
  de: new Set(['der', 'die', 'das', 'ein', 'eine', 'einer', 'eines', 'einem', 'einen', 'dieser', 'diese', 'dieses', 'diesem', 'diesen']),
});
const DEGREE_INTENSIFIERS = Object.freeze({
  en: new Set(['especially', 'even', 'extremely', 'fairly', 'far', 'incredibly', 'more', 'much', 'quite', 'really', 'remarkably', 'significantly', 'slightly', 'so', 'substantially', 'too', 'unusually', 'very']),
  de: new Set(['besonders', 'deutlich', 'erheblich', 'etwas', 'äußerst', 'merklich', 'noch', 'sehr', 'spürbar', 'überaus', 'ungewöhnlich', 'unglaublich', 'viel', 'wesentlich', 'wirklich', 'ziemlich', 'so']),
});
const EXTRA_TERMINAL_FUNCTION_WORDS = new Set(['secondo', 'because', 'perché']);
const COMPLETE_SUBORDINATE_MARKERS = Object.freeze({
  de: /^(?:wie|was|wann|nachdem|dass|ob|wenn|weil|während|wobei|bevor|obwohl|sobald|welcher|welches|dessen|deren|denen)\b/iu,
  en: /^(?:as|how|when|where|what|that|which|because|while)\b/iu,
  fr: /^(?:que|qui|quoi|dont|où|comme|si|lorsque)\b/iu,
  it: /^(?:che|come|dove|quando|quanto|quello che|ciò che)\b/iu,
});
const GERMAN_SUBORDINATE_MARKER_RE = /\b(?:wie|was|wann|wo|nachdem|dass|ob|wenn|weil|während|wobei|bevor|obwohl|sobald|welcher|welches|dessen|deren|denen)\b/iu;

function hasTableSyntax(value) {
  const lines = String(value ?? '').replace(/\r\n?/g, '\n').split('\n');
  return lines.some((line, index) => {
    if (TABLE_SEPARATOR_RE.test(line)) return true;
    if (!TABLE_ROW_RE.test(line)) return false;
    return TABLE_SEPARATOR_RE.test(lines[index - 1] || '')
      || TABLE_SEPARATOR_RE.test(lines[index + 1] || '')
      || /^\s*\|[^|]+\|/.test(line);
  });
}

function hasHorizontalRuleSyntax(value) {
  return String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .some((line) => HORIZONTAL_RULE_LINE_RE.test(line));
}

function hasListSyntax(value) {
  return String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .some((line) => LIST_ITEM_RE.test(line) && !DATE_PREFIX_RE.test(line));
}

function hasUnmatchedMarkdownDelimiter(value) {
  const text = String(value ?? '').replace(/\\./gu, '');
  return ['**', '__', '~~', '`'].some((delimiter) => {
    let count = 0;
    let offset = 0;
    while ((offset = text.indexOf(delimiter, offset)) >= 0) {
      count += 1;
      offset += delimiter.length;
    }
    return count % 2 === 1;
  });
}

/**
 * Return the Markdown constructs that make a value invalid as an excerpt.
 * The names are stable so callers can put the reason in a gate diagnostic.
 */
export function findExcerptMarkdownDefects(value) {
  const text = String(value ?? '');
  const defects = [];
  if (/(?:^|\n)\s{0,3}#{1,6}\s+\S/m.test(text)) defects.push('heading');
  if (hasListSyntax(text)) defects.push('list');
  if (/\*\*[^*\n]+\*\*/.test(text)) defects.push('bold');
  if (/(?<![\w*])\*(?!\*)[^*\n]+(?<!\*)\*(?!\*)|(?<![\w_])_(?!_)[^_\n]+(?<!_)_(?!_)/.test(text)) defects.push('italic');
  if (/\[[^\]]+\]\([^)]*\)/.test(text)) defects.push('link');
  if (REFERENCE_LINK_RE.test(text) || REFERENCE_DEFINITION_LINE_RE.test(text)) defects.push('reference-link');
  if (hasTableSyntax(text)) defects.push('table');
  if (hasHorizontalRuleSyntax(text)) defects.push('horizontal-rule');
  if (/`[^`\n]+`/.test(text)) defects.push('code');
  if (hasUnmatchedMarkdownDelimiter(text)) defects.push('unmatched-markdown-delimiter');
  if (/(?:^|\n)\s*>\s*\S/m.test(text)) defects.push('blockquote');
  if (/~~[^~\n]+~~/.test(text)) defects.push('strike');
  if (LABEL_START_RE.test(text.trim())) defects.push('label');
  return defects;
}

function findUnmatchedParentheses(text) {
  const openings = [];
  let unmatchedClosing = false;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '(') openings.push(index);
    if (text[index] === ')') {
      if (openings.length === 0) unmatchedClosing = true;
      else openings.pop();
    }
  }
  return { openings, unmatchedClosing };
}

function terminalWord(text) {
  return rawTerminalWord(text).toLocaleLowerCase();
}

function rawTerminalWord(text) {
  const content = String(text ?? '').replace(/[\s.!?…"'’”»)}\]]+$/u, '');
  return content.match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)?$/u)?.[0] ?? '';
}

function isTerminalPermitCodeOrCelsiusUnit(text, tokenStart, token) {
  const letter = String(token ?? '').replace(/\.$/u, '').toLocaleUpperCase();
  if (letter === 'C' && text[tokenStart - 1] === '°') return true;
  return ['B', 'C', 'G'].includes(letter)
    && PERMIT_CODE_CONTEXT_RE.test(text.slice(Math.max(0, tokenStart - 64), tokenStart));
}

function isContextualTerminalInitial(text, tokenStart, token) {
  if (!/^[A-ZÀ-ÖØ-Þ]\.$/u.test(String(token ?? ''))) return false;
  return TERMINAL_LABEL_INITIAL_CONTEXT_RE.test(String(text ?? '').slice(0, tokenStart));
}

function isNonSentencePeriod(text, periodIndex, locale = '') {
  if (periodIndex < 0 || text[periodIndex] !== '.') return false;
  const previous = text[periodIndex - 1] ?? '';
  const next = text[periodIndex + 1] ?? '';
  if (/\d/u.test(previous) && /\d/u.test(next)) return true;

  let start = periodIndex;
  while (start > 0 && /[\p{L}\p{N}.]/u.test(text[start - 1])) start -= 1;
  let end = periodIndex + 1;
  while (end < text.length && /[\p{L}\p{N}.]/u.test(text[end])) end += 1;
  const token = text.slice(start, end);
  const lowerToken = token.toLocaleLowerCase();
  if (SENTENCE_ABBREVIATION_SET.has(lowerToken) || MULTI_INITIAL_ABBREVIATION_RE.test(token)) return true;
  if (/^[BCG]\.$/u.test(token) && isTerminalPermitCodeOrCelsiusUnit(text, start, token)) return false;
  if (/^[A-ZÀ-ÖØ-Þ]\.$/u.test(token)) return !isContextualTerminalInitial(text, start, token);

  // German date ordinals continue into the following word (for example,
  // "am 17. Mai"). A terminal ordinal is handled as an incomplete date.
  if (String(locale ?? '').toLowerCase().split('-')[0] === 'de'
    && /(?:^|\s)\d{1,2}$/u.test(text.slice(0, periodIndex))
    && /^\s+[\p{L}]/u.test(text.slice(periodIndex + 1))) return true;
  return false;
}

/** Detect a value that starts mid-sentence after an abbreviation or ordinal in its source body. */
export function startsAfterNonSentenceBoundary(value, body = [], locale = '') {
  const needle = String(value ?? '').trim();
  if (!needle) return false;
  for (const source of Array.isArray(body) ? body : [body]) {
    const text = String(source ?? '');
    let offset = 0;
    let splitOccurrence = false;
    let sentenceOccurrence = false;
    while (offset < text.length) {
      const index = text.indexOf(needle, offset);
      if (index < 0) break;
      const before = text.slice(0, index);
      const trimmedBefore = before.trimEnd();
      const previous = trimmedBefore.length - 1;
      const gap = before.slice(trimmedBefore.length);
      const lineStart = before.lastIndexOf('\n') + 1;
      const linePrefix = text.slice(lineStart, index).replace(/(?:\*\*|__|~~|`)/gu, '');
      const startsListItem = /^\s{0,3}(?:[-*+]\s+|\d{1,3}\.\s+)$/u.test(linePrefix);
      if (startsListItem || previous < 0 || /\n/u.test(gap)) {
        sentenceOccurrence = true;
      } else if (/[.!?…]/u.test(text[previous])) {
        if (text[previous] === '.' && isNonSentencePeriod(text, previous, locale)) splitOccurrence = true;
        else sentenceOccurrence = true;
      } else if (/[-*+>:]/u.test(text[previous]) && /\n/u.test(before.slice(before.lastIndexOf('\n') + 1))) {
        sentenceOccurrence = true;
      }
      offset = index + 1;
    }
    if (splitOccurrence && !sentenceOccurrence) return true;
  }
  return false;
}

/** True when a value ends in a known abbreviation, initial, or ordinal. */
export function endsWithSentenceAbbreviation(value, { locale = '' } = {}) {
  const text = String(value ?? '').trim().replace(/["'’”»)}\]]+$/u, '');
  if (!text.endsWith('.')) return false;
  if (/\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}\.$/iu.test(text)) return false;
  let start = text.length - 1;
  while (start > 0 && /[\p{L}\p{N}.]/u.test(text[start - 1])) start -= 1;
  const rawToken = text.slice(start);
  const token = rawToken.toLocaleLowerCase();
  if (/^[bcg]\.$/u.test(token) && isTerminalPermitCodeOrCelsiusUnit(text, start, text.slice(start))) return false;
  if (/^[A-ZÀ-ÖØ-Þ]\.$/u.test(text.slice(start))
    && isContextualTerminalInitial(text, start, text.slice(start))) return false;
  const language = String(locale ?? '').toLowerCase().split('-')[0];
  return SENTENCE_ABBREVIATION_SET.has(token)
    || MULTI_INITIAL_ABBREVIATION_RE.test(rawToken)
    || /^[A-ZÀ-ÖØ-Þ]\.$/u.test(text.slice(start))
    || (language === 'de' && GERMAN_DATE_ORDINAL_PREFIX_RE.test(text.replace(/\.$/u, '')));
}

/** Minimum source length shared by repairs, generator validation, and the corpus gate. */
export function minimumDescriptionLength(field = 'excerpt') {
  const name = String(field ?? 'excerpt').split('.').at(-1);
  return ['description', 'seoDescription'].includes(name) ? SEO_DESCRIPTION_MIN : EXCERPT_MIN_LENGTH;
}

/** Maximum source length shared by repairs, generator validation, and the corpus gate. */
export function maximumDescriptionLength(field = 'excerpt') {
  const name = String(field ?? 'excerpt').split('.').at(-1);
  if (name === 'excerpt') return EXCERPT_MAX_LENGTH;
  if (name === 'ogDescription') return SEO_OG_DESCRIPTION_MAX;
  return SEO_DESCRIPTION_MAX;
}

/** Combine plain-text, completion, and field-specific minimum-length checks. */
export function findDescriptionDefects(value, {
  locale = '',
  field = 'excerpt',
  body = [],
  requireTerminalPunctuation = true,
  requireNonEmpty = true,
} = {}) {
  const defects = [
    ...findExcerptMarkdownDefects(value),
    ...findExcerptCompletenessDefects(value, { locale, requireTerminalPunctuation, requireNonEmpty }),
  ];
  if (startsAfterNonSentenceBoundary(value, body, locale)) defects.push('split-sentence-start');
  return [...new Set(defects)];
}

function finalSentence(text, locale = '') {
  const content = String(text ?? '')
    .replace(/[\s"'’”»)}\]]+$/u, '')
    .replace(/[.!?…]+$/u, '');
  const boundaries = [...content.matchAll(/[.!?…](?=[\s"'’”»)}\]]|$)/gu)]
    .filter((match) => !(match[0] === '.' && isNonSentencePeriod(content, match.index, locale)));
  const lastBoundary = boundaries.at(-1);
  return content.slice(lastBoundary ? lastBoundary.index + 1 : 0).trim();
}

function wordCount(text) {
  return [...String(text ?? '').matchAll(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)?/gu)].length;
}

function clauseWords(clause) {
  return [...String(clause ?? '').matchAll(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)?/gu)]
    .map((match) => ({
      word: match[0].toLocaleLowerCase(),
      raw: match[0],
      index: match.index,
      end: match.index + match[0].length,
    }));
}

function isContentWord(word) {
  return !AUXILIARY_ENDINGS.has(word)
    && !TRAILING_STOPWORDS.has(word)
    && !SUBORDINATE_FUNCTION_WORDS.has(word);
}

function germanGenitiveMarker(words, startIndex) {
  for (let index = 0; index < words.length; index += 1) {
    const current = words[index];
    if (current.index < startIndex) continue;
    if (GERMAN_DATIVE_PREPOSITIONS.has(words[index - 1]?.word)) continue;
    if (GERMAN_GENITIVE_MARKERS.has(current.word) || current.word === 'der') return current;
  }
  return undefined;
}

function isLikelyGermanPredicate(word, words, predicateIndex) {
  if (PREDICATIVE_COMPLEMENTS.de.has(word)
    || /(?:ig|lich|isch|bar|sam|los|voll|haft|arm|reich|wert|iert)$/u.test(word)
    || /^ge\p{L}+t$/u.test(word)) return true;
  const precedingWord = words.filter(({ index }) => index < predicateIndex).at(-1)?.word;
  return precedingWord === 'zu' && /en$/u.test(word);
}

function isLikelyPredicateWord(word, language, words, index) {
  if (PREDICATIVE_COMPLEMENTS[language]?.has(word)) return true;
  if (language === 'de') return isLikelyGermanPredicate(word, words, index);
  if (language === 'en') return /(?:able|ible|al|ful|less|ous|ive|ic|ed|ing|ary|ory|ent|ant)$/u.test(word);
  if (language === 'fr') return /(?:able|ible|é|ée|és|ées|if|ive|eux|euse|ique|ant|ante|ent|ente)$/u.test(word);
  if (language === 'it') return /(?:abile|ibile|ato|ata|ati|ate|uto|uta|uti|ute|ale|ile|oso|osa|osi|ose|ivo|iva|ivi|ive|ente)$/u.test(word);
  return false;
}

function hasPredicateBeforeAuxiliary(clause, terminal) {
  const words = clauseWords(clause).map(({ word }) => word);
  if (words.at(-1) === terminal) words.pop();
  return words.some(isContentWord);
}

function hasCompleteSubordinatePredicate(clause, terminal, language, allowGermanRelative) {
  const rawText = String(clause ?? '');
  const text = rawText.toLocaleLowerCase();
  const languages = language && COMPLETE_SUBORDINATE_MARKERS[language]
    ? [language]
    : Object.keys(COMPLETE_SUBORDINATE_MARKERS);
  const matches = [];
  for (const markerLanguage of languages) {
    const marker = COMPLETE_SUBORDINATE_MARKERS[markerLanguage];
    const loose = new RegExp(marker.source.replace(/^\^/u, ''), marker.flags);
    const match = loose.exec(text);
    if (match) matches.push({ index: match.index, end: match.index + match[0].length, text: match[0], language: markerLanguage });
  }
  if (language === 'de' || !language) {
    const match = GERMAN_SUBORDINATE_MARKER_RE.exec(text);
    if (match) matches.push({ index: match.index, end: match.index + match[0].length, text: match[0], language: 'de' });
    if (allowGermanRelative) {
      const relative = /,\s*(die|der|das|welche|welcher|welches)\b/iu.exec(text);
      if (relative) {
        const start = relative.index + relative[0].lastIndexOf(relative[1]);
        matches.push({ index: start, end: start + relative[1].length, text: relative[1], language: 'de' });
      }
    }
  }
  const marker = matches.sort((left, right) => left.index - right.index)[0];
  if (!marker) return false;

  const words = clauseWords(rawText).filter(({ word }) => word !== terminal);
  const afterMarker = words.filter(({ index }) => index >= marker.end);
  const markerWord = marker.text.toLocaleLowerCase();
  const subordinateLanguage = language || marker.language;
  if (SUBORDINATE_LOCATIVE_MARKERS.has(markerWord)
    && afterMarker.some(({ word }) => isContentWord(word)
      || SUBORDINATE_SUBJECT_PRONOUNS.has(word)
      || LOCATIVE_SUBJECT_WORDS.has(word))) return true;
  const degreeMarker = (subordinateLanguage === 'en' && markerWord === 'how')
    || (subordinateLanguage === 'de' && markerWord === 'wie');
  if (degreeMarker) {
    if (subordinateLanguage === 'en') {
      const there = afterMarker.find(({ word }) => word === 'there');
      if (there) {
        const wordsBeforeThere = afterMarker.filter(({ word, index }) => index < there.index && isContentWord(word));
        if (wordsBeforeThere.length >= 2 && wordsBeforeThere.some(({ word }) => EN_QUANTITY_WORDS.has(word))) return true;
      }
    }
    const degreePredicate = afterMarker.find(({ word }) => isContentWord(word) && !DEGREE_INTENSIFIERS[subordinateLanguage]?.has(word));
    const hasDeterminerBeforePredicate = degreePredicate && afterMarker.some(({ word, index }) => index < degreePredicate.index
      && DEGREE_DETERMINERS[subordinateLanguage]?.has(word));
    const isComparativePredicate = degreePredicate
      && COMPARATIVE_PREDICATES[subordinateLanguage]?.has(degreePredicate.word);
    const isListedDegreePredicate = degreePredicate
      && DEGREE_PREDICATIVE_COMPLEMENTS[subordinateLanguage]?.has(degreePredicate.word);
    if (degreePredicate && !hasDeterminerBeforePredicate && (isComparativePredicate || isListedDegreePredicate)) {
      const wordsBeforePredicate = afterMarker.filter(({ index }) => index < degreePredicate.index);
      const hasComparativeIntensifier = wordsBeforePredicate.some(({ word }) => COMPARATIVE_INTENSIFIERS[subordinateLanguage]?.has(word));
      const unmodifiedMore = subordinateLanguage === 'en'
        && wordsBeforePredicate.some(({ word }) => word === 'more' || word === 'less')
        && !hasComparativeIntensifier;
      if (!unmodifiedMore && (!isComparativePredicate || hasComparativeIntensifier)) return true;
    }
  }
  let subjectEnd;
  if (SUBORDINATE_MARKERS_AS_SUBJECT.has(markerWord)) {
    subjectEnd = marker.end;
  } else {
    const pronoun = afterMarker.find(({ word }) => SUBORDINATE_SUBJECT_PRONOUNS.has(word));
    const germanNoun = subordinateLanguage === 'de' || !language
      ? afterMarker.find(({ word, raw }) => isContentWord(word) && /^\p{Lu}/u.test(raw))
      : undefined;
    subjectEnd = pronoun?.end ?? germanNoun?.end;
  }
  const contentWords = afterMarker.filter(({ word }) => isContentWord(word));
  const predicate = (subjectEnd === undefined
    ? contentWords
    : contentWords.filter(({ index }) => index >= subjectEnd)).at(-1);
  if (!predicate) return false;
  if (subjectEnd !== undefined) {
    if (subordinateLanguage === 'de') {
      const genitiveMarker = germanGenitiveMarker(words, subjectEnd);
      if (genitiveMarker && predicate.index >= genitiveMarker.index) {
        const nominalPredicateBeforeGenitive = contentWords.find(({ index, raw }) => index >= subjectEnd
          && index < genitiveMarker.index
          && /^\p{Lu}/u.test(raw));
        const likelyPredicateAfterGenitive = isLikelyGermanPredicate(predicate.word, words, predicate.index);
        if (!nominalPredicateBeforeGenitive && !likelyPredicateAfterGenitive) return false;
      }
      if (GERMAN_NONPREDICATIVE_ADVERBS.has(predicate.word)
        && !isLikelyGermanPredicate(predicate.word, words, predicate.index)) return false;
    }
    return true;
  }

  // Without an identifiable subject, only exempt a recognizable predicate.
  // This prevents an adjective+noun subject such as "young people are" from
  // making its noun look like a second clause component.
  const languagePredicates = PREDICATIVE_COMPLEMENTS[subordinateLanguage];
  if (languagePredicates?.has(predicate.word)) return true;
  return isLikelyPredicateWord(predicate.word, subordinateLanguage, words, predicate.index);
}

function hasDanglingDegreePredicateTail(value, language) {
  const sentence = finalSentence(value, language);
  const text = sentence.toLocaleLowerCase();
  const terminal = terminalWord(sentence);
  const languages = language === 'en' || language === 'de' ? [language] : ['en', 'de'];
  return languages.some((candidate) => {
    const marker = candidate === 'en' ? /\bhow\b/iu : /\bwie\b/iu;
    return marker.test(text)
      && COMPARATIVE_PREDICATES[candidate]?.has(terminal);
  });
}

function hasDanglingTerminalFunctionWord(text, locale = '') {
  const terminal = terminalWord(text);
  const finalText = finalSentence(text, locale);
  const final = finalText.toLocaleLowerCase();
  const language = String(locale ?? '').toLowerCase().split('-')[0];
  if (language === 'de' && GERMAN_SEPARABLE_PARTICLE_PATTERNS[terminal]?.test(final)) return false;
  if (language === 'it' && /\becco perché$/iu.test(final)) return false;
  const rawTerminal = rawTerminalWord(text);
  if (/^[A-ZÀ-ÖØ-Þ]$/u.test(rawTerminal)) return false;
  if (rawTerminal === 'AI' || rawTerminal === 'Stati') return false;
  if (AUXILIARY_ENDINGS.has(terminal)) {
    const clauses = finalText.split(',').map((clause) => clause.trim());
    const lastClause = clauses.at(-1);
    if (NONFINITE_AUXILIARY_ENDINGS.has(terminal)) {
      const hasSupportedSubordinateMarker = /\b(?:where|wo|où|dove|how|wie)\b/iu.test(final);
      if (hasSupportedSubordinateMarker
        && hasCompleteSubordinatePredicate(finalText, terminal, language, language === 'de' && clauses.length > 1)) return false;
      if (terminal === 'sein'
        && /\b(?:muss|müssen|soll|sollen|kann|können|darf|dürfen|will|wollen|mag|mögen|möchte)\b/u.test(final)
        && hasPredicateBeforeAuxiliary(lastClause, terminal)) {
        return false;
      }
      return true;
    }
    if (!FINITE_AUXILIARY_ENDINGS.has(terminal)) return true;
    return !hasCompleteSubordinatePredicate(finalText, terminal, language, language === 'de' && clauses.length > 1);
  }
  if (hasDanglingDegreePredicateTail(text, language)) return true;
  if (language === 'de' && /\b(?:weil|dass|ob|wenn)\s+es$/u.test(final)) return true;
  return TRAILING_STOPWORDS.has(terminal) || EXTRA_TERMINAL_FUNCTION_WORDS.has(terminal);
}

/** True when a sentence terminator masks a known dangling function word. */
export function endsWithFunctionWordBeforePeriod(value, { locale = '' } = {}) {
  const text = String(value ?? '').trim();
  if (!/[.!?…]["'’”»)}\]]*$/u.test(text)) return false;
  return hasDanglingTerminalFunctionWord(text, locale);
}

/** Detect incomplete tails, including short clauses hidden by an added period. */
export function findExcerptCompletenessDefects(value, {
  locale = '',
  requireTerminalPunctuation = true,
  requireNonEmpty = true,
} = {}) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return requireNonEmpty ? ['empty-value'] : [];
  const defects = [];
  const parentheses = findUnmatchedParentheses(text);
  if (parentheses.openings.length > 0) defects.push('unclosed-parenthesis');
  if (parentheses.unmatchedClosing) defects.push('unmatched-parenthesis');
  if (/[\p{L}\p{N}]-[.!?…]?$/u.test(text)) defects.push('unfinished-hyphenated-word');
  if (endsWithSentenceAbbreviation(text, { locale })) defects.push('unfinished-abbreviation');
  const terminalNumberContext = text.replace(/\.$/u, '');
  if (TERMINAL_DATE_FRAGMENT_RE.test(terminalNumberContext)
    || TERMINAL_DATE_RANGE_YEAR_FRAGMENT_RE.test(terminalNumberContext)) {
    defects.push('unfinished-date');
  }
  if (TERMINAL_NUMBER_AFTER_LIST_CONNECTOR_RE.test(terminalNumberContext)) defects.push('dangling-clause');
  if (hasDanglingTerminalFunctionWord(text, locale)) defects.push('dangling-clause');
  if (ORPHANED_DESCRIPTION_LABEL_RE.test(text)) defects.push('orphaned-label');
  if (text.length >= 60 && wordCount(finalSentence(text, locale)) < 4
    && INCOMPLETE_SHORT_SENTENCE_VERBS.has(terminalWord(text))) {
    defects.push('short-final-sentence');
  }
  if (requireTerminalPunctuation && !TERMINAL_SENTENCE_PUNCTUATION_RE.test(text)) {
    defects.push('missing-final-terminator');
  }
  return defects;
}

function sentencePrefixes(value, locale = '') {
  const candidates = [];
  const re = /[.!?](?:["'’”»)}\]]*)(?=\s|$)/gu;
  for (const match of value.matchAll(re)) {
    if (match[0].startsWith('.') && isNonSentencePeriod(value, match.index, locale)) continue;
    const end = match.index + match[0].length;
    candidates.push(value.slice(0, end).trimEnd());
  }
  return candidates.reverse();
}

const sentenceSegmenters = new Map();
const bodySentenceCandidateCache = new WeakMap();
const rankedBodyCandidateCache = new WeakMap();
const bodyListItemCache = new WeakMap();

const AMBIGUOUS_ITALIAN_ARTICLE_STARTERS = new Set(['Il', 'Lo', 'La', 'I', 'Gli', 'Le', 'Un', 'Uno', 'Una']);

const UNPUNCTUATED_SENTENCE_STARTERS = Object.freeze({
  de: ['Die', 'Der', 'Das', 'Ein', 'Eine', 'Es', 'Er', 'Wir', 'Heute', 'Am', 'Im', 'Seit', 'Nach', 'Zudem', 'Damit', 'Dafür', 'Auch', 'Laut', 'Während'],
  en: ['The', 'This', 'That', 'These', 'Those', 'It', 'They', 'He', 'She', 'We', 'A', 'An', 'Today', 'After', 'However', 'Meanwhile'],
  fr: ['Le', 'La', 'Les', 'Un', 'Une', 'Des', 'Il', 'Elle', 'Ils', 'Elles', 'Selon', 'Après', 'Cependant', 'Aujourd’hui'],
  it: ['Il', 'Lo', 'La', 'I', 'Gli', 'Le', 'Un', 'Uno', 'Una', 'Oggi', 'Secondo', 'Dopo', 'Tuttavia', 'Inoltre', 'Questa', 'Questo', 'Queste', 'Questi'],
});

function hasUnpunctuatedSentenceJoin(text, locale) {
  const language = String(locale ?? '').toLowerCase().split('-')[0];
  const starters = UNPUNCTUATED_SENTENCE_STARTERS[language] ?? Object.values(UNPUNCTUATED_SENTENCE_STARTERS).flat();
  const pattern = new RegExp('(?<=[\\p{L}\\p{N}])[\\t ]+(' + starters.join('|') + ')\\b', 'gu');
  const value = String(text ?? '');
  return [...value.matchAll(pattern)].some((match) => {
    if (!/^\s+[\p{Lu}]/u.test(match[0])) return false;
    const rest = value.slice(match.index + match[0].length);
    if (language === 'it' && AMBIGUOUS_ITALIAN_ARTICLE_STARTERS.has(match[1]) && /^\s+[\p{Lu}]/u.test(rest)) return false;
    if (language === 'de' && match[1] === 'Ein' && /^-\s*(?:und|oder)\b/iu.test(rest)) return false;
    return true;
  });
}

function crossesBodyLineOrListItem(text, locale = '') {
  const value = String(text ?? '');
  const lines = value.split(/\r?\n/u);
  const hasSentenceTerminator = (fragment) => {
    const ending = String(fragment ?? '').trimEnd().replace(/["'’”»)}\]]+$/u, '');
    if (!/[.!?…]$/u.test(ending)) return false;
    const period = ending.length - 1;
    return ending[period] !== '.'
      || (!isNonSentencePeriod(ending, period, locale)
        && !endsWithSentenceAbbreviation(ending, { locale }));
  };
  if (lines.length > 1 && lines.slice(0, -1).some((line) => line.trim() && !hasSentenceTerminator(line))) return true;
  const listItems = [...value.matchAll(/(?:^|[ \t])[-*+][ \t]+\S/gu)];
  return listItems.slice(1).some((item) => !hasSentenceTerminator(value.slice(0, item.index)));
}

function sentenceCandidatesFromBody(body, locale, field = 'excerpt') {
  const cacheKey = `${locale}\0${field}`;
  let cachedByLocaleField;
  if (Array.isArray(body)) {
    cachedByLocaleField = bodySentenceCandidateCache.get(body);
    const cached = cachedByLocaleField?.get(cacheKey);
    if (cached) return cached;
  }
  if (!sentenceSegmenters.has(locale)) {
    sentenceSegmenters.set(locale, new Intl.Segmenter(locale, { granularity: 'sentence' }));
  }
  const segmenter = sentenceSegmenters.get(locale);
  const candidates = [];
  for (const source of Array.isArray(body) ? body : [body]) {
    const text = String(source ?? '');
    const segments = [];
    for (const segment of segmenter.segment(text)) {
      const previous = segments.at(-1);
      const previousEnd = previous ? previous.index + previous.segment.length : -1;
      const previousPeriod = previous
        ? previous.index + previous.segment.trimEnd().length - 1
        : -1;
      if (previous && isNonSentencePeriod(text, previousPeriod, locale)) {
        segments.pop();
        const end = segment.index + segment.segment.length;
        segments.push({ index: previous.index, segment: text.slice(previous.index, end) });
      } else {
        segments.push(segment);
      }
    }
    for (let start = 0; start < segments.length; start += 1) {
      for (let count = 1; count <= 2 && start + count <= segments.length; count += 1) {
        const first = segments[start];
        const last = segments[start + count - 1];
        const candidate = text.slice(first.index, last.index + last.segment.length).trim();
        const end = last.index + last.segment.length;
        if (isNonSentencePeriod(text, end - 1, locale)) continue;
        if (crossesBodyLineOrListItem(candidate, locale)) continue;
        const plainCandidate = stripExcerptMarkdown(candidate);
        if (!plainCandidate || plainCandidate.length > 280) continue;
        if (detectWrongLatinLanguageInField(plainCandidate, locale, field) !== null) continue;
        if (hasUnpunctuatedSentenceJoin(plainCandidate, locale)) continue;
        if (findExcerptMarkdownDefects(plainCandidate).length > 0) continue;
        if (!/[.!?…]["'’”»)}\]]*$/u.test(plainCandidate)) continue;
        if (findExcerptCompletenessDefects(plainCandidate, { locale }).length > 0) continue;
        candidates.push(plainCandidate);
      }
    }
  }
  if (Array.isArray(body)) {
    cachedByLocaleField ??= new Map();
    cachedByLocaleField.set(cacheKey, candidates);
    bodySentenceCandidateCache.set(body, cachedByLocaleField);
  }
  return candidates;
}

function descriptionKeywords(text) {
  return new Set(
    [...String(text).toLocaleLowerCase().matchAll(/[\p{L}\p{N}]{3,}|\p{N}{2,}/gu)]
      .map((match) => match[0])
      .filter(isContentWord),
  );
}

function singularPluralKeywordMatch(left, right) {
  const shorter = left.length <= right.length ? left : right;
  const longer = shorter === left ? right : left;
  return shorter.length >= 3 && (longer === shorter + 's' || longer === shorter + 'es');
}

function hasSharedDescriptionKeyword(word, sourceWords) {
  if (sourceWords.has(word)) return true;
  for (const sourceWord of sourceWords) {
    if (singularPluralKeywordMatch(word, sourceWord)
      || (Math.min(word.length, sourceWord.length) >= 4
        && (word.includes(sourceWord) || sourceWord.includes(word)))
      || (PUBLISHING_KEYWORD_EQUIVALENTS.has(word) && PUBLISHING_KEYWORD_EQUIVALENTS.has(sourceWord))) return true;
  }
  return false;
}

function sharedDescriptionKeywordCountFromSets(candidateWords, sourceWords) {
  let shared = 0;
  for (const word of candidateWords) if (hasSharedDescriptionKeyword(word, sourceWords)) shared += 1;
  return shared;
}

function sharedDescriptionKeywordCount(candidate, sources) {
  const candidateWords = descriptionKeywords(candidate);
  const sourceWords = new Set(sources.flatMap((source) => [...descriptionKeywords(source)]));
  return sharedDescriptionKeywordCountFromSets(candidateWords, sourceWords);
}

function sharedDescriptionKeywordStats(candidate, source) {
  const candidateWords = descriptionKeywords(candidate);
  const sourceWords = descriptionKeywords(source);
  let shared = 0;
  let alphabetic = 0;
  for (const word of candidateWords) {
    if (!hasSharedDescriptionKeyword(word, sourceWords)) continue;
    shared += 1;
    if (/\p{L}/u.test(word)) alphabetic += 1;
  }
  return { shared, alphabetic };
}

function overlapScore(candidate, sources) {
  const candidateWords = descriptionKeywords(candidate);
  const sourceWords = new Set(sources.flatMap((source) => [...descriptionKeywords(source)]));
  if (candidateWords.size === 0 || sourceWords.size === 0) return 0;
  return sharedDescriptionKeywordCountFromSets(candidateWords, sourceWords)
    / Math.sqrt(candidateWords.size * sourceWords.size);
}

const MIN_SEMANTIC_SIBLING_KEYWORDS = 2;
const MIN_SEMANTIC_SIBLING_ALPHABETIC_KEYWORDS = 1;

function hasMinimumSemanticSiblingOverlap(candidate, source) {
  const { shared, alphabetic } = sharedDescriptionKeywordStats(candidate, source);
  return shared >= MIN_SEMANTIC_SIBLING_KEYWORDS
    && alphabetic >= MIN_SEMANTIC_SIBLING_ALPHABETIC_KEYWORDS;
}

/**
 * Check that a complete sibling still describes the field being repaired.
 *
 * Completeness is not evidence of relevance: a sibling can be a valid
 * sentence about a different topic. Prefer the damaged field and title as
 * the direct context; when the field is empty, or too short to carry useful
 * context, the article body is the remaining same-article source. Every
 * source is checked independently: the field and title are never fused, and
 * body paragraphs cannot contribute keywords to one another. A match needs
 * two shared keywords in one source, including at least one alphabetic
 * content keyword, so dates and numbers cannot establish relevance alone.
 * Missing context is fail-closed so a sibling is never accepted merely
 * because it is syntactically complete.
 *
 * The second argument also accepts the target string directly for small
 * callers: `isSemanticallyCompatibleSibling(candidate, target, options)`.
 */
export function isSemanticallyCompatibleSibling(candidate, targetOrContext = {}, options = {}) {
  const context = typeof targetOrContext === 'string'
    ? { ...options, target: targetOrContext }
    : (targetOrContext ?? {});
  const candidateText = String(candidate ?? '').trim();
  if (!candidateText) return false;

  const target = String(context.target ?? '').trim();
  const title = String(context.title ?? '').trim();
  const bodySources = (Array.isArray(context.body) ? context.body : [context.body])
    .map((source) => String(source ?? '').trim())
    .flatMap((source) => source.split(/\r?\n\s*\r?\n/u))
    .map((source) => source.trim())
    .filter(Boolean);
  return [target, title, ...bodySources]
    .filter(Boolean)
    .some((source) => hasMinimumSemanticSiblingOverlap(candidateText, source));
}

function unpunctuatedCapitalTransitions(value) {
  const text = String(value ?? '');
  const words = [...text.matchAll(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)?/gu)];
  const transitions = [];
  for (let index = 1; index < words.length; index += 1) {
    const previous = words[index - 1];
    const current = words[index];
    const gap = text.slice(previous.index + previous[0].length, current.index);
    if (!/^\s+$/u.test(gap) || !/\p{Ll}$/u.test(previous[0]) || !/^\p{Lu}/u.test(current[0])) continue;
    if (LIST_TRANSITION_CONNECTORS.has(previous[0].toLocaleLowerCase())) continue;
    transitions.push(current[0].toLocaleLowerCase());
  }
  return transitions;
}

const TRAILING_EMOJI_SEGMENTER = new Intl.Segmenter('en', { granularity: 'grapheme' });
const EMOJI_GRAPHEME_RE = /(?:\p{Extended_Pictographic}|\p{Regional_Indicator}{2}|[#*0-9]\uFE0F?\u20E3)/u;
const LIST_TRANSITION_CONNECTORS = new Set([
  'a', 'an', 'and', 'as', 'at', 'by', 'de', 'del', 'della', 'delle', 'dello', 'di', 'do', 'du', 'en', 'et', 'for',
  'from', 'für', 'in', 'im', 'into', 'la', 'le', 'les', 'lo', 'nel', 'nella', 'nelle', 'nello', 'of', 'on', 'or',
  'per', 'pour', 'sul', 'sulla', 'sulle', 'sullo', 'to', 'tra', 'und', 'until', 'von', 'with', 'zur', 'zum', 'zu',
]);

function stripTrailingEmoji(value) {
  let text = String(value ?? '').trimEnd();
  if (!/[\p{Extended_Pictographic}\p{Regional_Indicator}\u20E3]/u.test(text)) return text;
  while (text) {
    const last = [...TRAILING_EMOJI_SEGMENTER.segment(text)].at(-1);
    if (!last || !EMOJI_GRAPHEME_RE.test(last.segment)) break;
    text = text.slice(0, last.index).trimEnd();
  }
  return text;
}

function hasTruncatedUpdatedDataTail(value) {
  return /\bDati aggiornati 2026 per(?:\s+[\p{L}\p{N}'’.-]+)*\s*$/iu.test(String(value ?? ''));
}

function addFinalTerminator(value, locale) {
  const withoutEmoji = stripTrailingEmoji(value);
  const candidate = /[.!?…]["'’”»)}\]]*$/u.test(withoutEmoji)
    ? withoutEmoji
    : withoutEmoji + '.';
  return findExcerptCompletenessDefects(candidate, { locale }).length === 0
    && findExcerptMarkdownDefects(candidate).length === 0
    ? candidate
    : null;
}

/** True when a d repair removes terminal emoji and adds no content beyond punctuation. */
export function isFinalTerminatorOnlyChange(original, repaired) {
  const withoutEmoji = stripTrailingEmoji(original);
  const expected = /[.!?…]["'’”»)}\]]*$/u.test(withoutEmoji)
    ? withoutEmoji
    : withoutEmoji + '.';
  return expected === repaired;
}

/**
 * Repair a value from its own complete prefix, its final terminator, or exact
 * body prose. Historical sweeps can restrict body replacement to flattened
 * lists so complete existing summaries are preserved.
 */
export function repairExcerptFromOriginal(value, {
  body = [],
  field = 'excerpt',
  locale = 'it',
  title = '',
  maxLength = 280,
  minLength = minimumDescriptionLength(field),
  listOnlyBody = false,
  requireTerminalPunctuation = true,
  requireNonEmpty = true,
} = {}) {
  const original = String(value ?? '');
  const defects = [
    ...findExcerptMarkdownDefects(original),
    ...findExcerptCompletenessDefects(original, {
      locale,
      requireTerminalPunctuation,
      requireNonEmpty,
    }),
  ];
  if (startsAfterNonSentenceBoundary(original, body, locale)) defects.push('split-sentence-start');
  if (defects.length === 0) return { value: original, strategy: null, defects };

  const flattenedList = hasFlattenedBodyListExcerpt(original, body, locale);
  const bodyCandidatesFor = (relevanceSources) => {
    const cacheKey = `${locale}\0${field}\0${maxLength}\0${minLength}\0${title}`;
    let cachedByTitle;
    if (listOnlyBody && relevanceSources.length === 1 && Array.isArray(body)) {
      cachedByTitle = rankedBodyCandidateCache.get(body);
      const cached = cachedByTitle?.get(cacheKey);
      if (cached) return cached;
    }
    const candidates = sentenceCandidatesFromBody(body, locale, field)
      .filter((candidate) => isCompleteSourceCandidate(candidate, {
        locale,
        maxLength,
        minLength,
        body,
        requireTerminalPunctuation,
        requireNonEmpty,
      }))
      .map((candidate, index) => ({
        candidate,
        index,
        sharedKeywords: sharedDescriptionKeywordCount(candidate, relevanceSources),
        score: overlapScore(candidate, relevanceSources),
      }))
      .filter(({ sharedKeywords }) => sharedKeywords >= 2)
      .sort((left, right) => right.score - left.score || left.index - right.index);
    if (listOnlyBody && relevanceSources.length === 1 && Array.isArray(body)) {
      cachedByTitle ??= new Map();
      cachedByTitle.set(cacheKey, candidates);
      rankedBodyCandidateCache.set(body, cachedByTitle);
    }
    return candidates;
  };

  if (flattenedList) {
    const bodyCandidates = bodyCandidatesFor(listOnlyBody ? [title] : [title, original]);
    if (bodyCandidates.length > 0) return { value: bodyCandidates[0].candidate, strategy: 'b', defects };
  }

  if (defects.length === 1
    && defects[0] === 'missing-final-terminator'
    && !flattenedList
    && !hasTruncatedUpdatedDataTail(original)) {
    const terminated = addFinalTerminator(original, locale);
    if (terminated !== null) return { value: terminated, strategy: 'd', defects };
  }

  for (const prefix of sentencePrefixes(original, locale)) {
    if (prefix === original) continue;
    if (!isCompleteSourceCandidate(prefix, {
      locale,
      maxLength,
      minLength,
      body,
      requireTerminalPunctuation,
      requireNonEmpty,
    })) continue;
    return { value: prefix, strategy: 'a', defects };
  }

  if (!listOnlyBody) {
    const bodyCandidates = bodyCandidatesFor([title, original]);
    if (bodyCandidates.length > 0) return { value: bodyCandidates[0].candidate, strategy: 'b', defects };
  }

  return { value: original, strategy: 'c', defects };
}

function hasFlattenedBodyListExcerpt(value, body, locale = '') {
  const original = String(value ?? '');
  const originalWords = descriptionKeywords(original);
  if (originalWords.size === 0) return false;
  let listItems;
  if (Array.isArray(body)) {
    listItems = bodyListItemCache.get(body);
    if (!listItems) {
      listItems = [];
      for (const source of body) {
        for (const line of String(source ?? '').split(/\r?\n/u)) {
          if (!/^\s{0,3}(?:[-*+]\s+|\d{1,3}\.\s+)/u.test(line)) continue;
          const item = stripExcerptMarkdown(line).replace(/[.!?…]+$/u, '').trim();
          const firstWord = item.match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)?/u)?.[0]?.toLocaleLowerCase();
          if (item.length >= 12) listItems.push({ words: descriptionKeywords(item), firstWord });
        }
      }
      bodyListItemCache.set(body, listItems);
    }
  } else {
    listItems = String(body ?? '').split(/\r?\n/u)
      .filter((line) => /^\s{0,3}(?:[-*+]\s+|\d{1,3}\.\s+)/u.test(line))
      .map((line) => stripExcerptMarkdown(line).replace(/[.!?…]+$/u, '').trim())
      .filter((item) => item.length >= 12)
      .map((item) => ({
        words: descriptionKeywords(item),
        firstWord: item.match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)?/u)?.[0]?.toLocaleLowerCase(),
      }));
  }
  const matchingItems = [];
  for (const { words, firstWord } of listItems) {
    if (sharedDescriptionKeywordCountFromSets(words, originalWords) < 2) continue;
    matchingItems.push(firstWord);
  }
  if (matchingItems.length < 2) return false;
  const transitions = unpunctuatedCapitalTransitions(original);
  if (transitions.length === 0) return false;
  const matchingTransitions = transitions.filter((transition) => matchingItems.includes(transition)).length;
  // German nouns are capitalized by default; require two matching list starts there.
  const language = String(locale ?? '').toLowerCase().split('-')[0];
  return matchingTransitions >= (language === 'de' ? 2 : 1);
}

export function isCompleteSourceCandidate(value, {
  locale,
  maxLength = EXCERPT_MAX_LENGTH,
  minLength = EXCERPT_MIN_LENGTH,
  body = [],
  requireTerminalPunctuation = true,
  requireNonEmpty = true,
}) {
  return typeof value === 'string'
    && value.length <= maxLength
    && value.trim().length >= minLength
    && findExcerptMarkdownDefects(value).length === 0
    && findExcerptCompletenessDefects(value, {
      locale,
      requireTerminalPunctuation,
      requireNonEmpty,
    }).length === 0
    && !startsAfterNonSentenceBoundary(value, body, locale);
}

/** Select only text already present as a complete sentence within a field's budget. */
export function selectCompleteExcerptSource(value, {
  locale = '',
  maxLength = EXCERPT_MAX_LENGTH,
  minLength = EXCERPT_MIN_LENGTH,
  body = [],
  requireTerminalPunctuation = true,
  requireNonEmpty = true,
} = {}) {
  const text = String(value ?? '').trim();
  const options = { locale, maxLength, minLength, body, requireTerminalPunctuation, requireNonEmpty };
  if (isCompleteSourceCandidate(text, options)) return text;
  return sentencePrefixes(text, locale).find((prefix) => isCompleteSourceCandidate(prefix, options)) ?? null;
}

/** Return the first complete one- or two-sentence excerpt copied from the body. */
export function firstCompleteBodyExcerpt(body, {
  locale = '',
  field = 'excerpt',
  maxLength = EXCERPT_MAX_LENGTH,
  minLength = EXCERPT_MIN_LENGTH,
  requireTerminalPunctuation = true,
  requireNonEmpty = true,
} = {}) {
  const options = { locale, maxLength, minLength, body, requireTerminalPunctuation, requireNonEmpty };
  return sentenceCandidatesFromBody(body, locale, field)
    .find((candidate) => isCompleteSourceCandidate(candidate, options)) ?? null;
}

/**
 * Repair a newly generated article's excerpt and SEO descriptions at the
 * shared pre-write boundary. Sources must belong to the same article and
 * locale: the existing field, another complete description, or its body.
 * Throws per article when none can be repaired without inventing text.
 */
export function repairGeneratedArticleDescriptions(article) {
  const content = article?.content;
  if (!content || typeof content !== 'object') return [];
  const repairs = [];

  const targetFields = ['excerpt', 'seoDescription', 'ogDescription', 'description'].map((field) => ({
    field,
    maxLength: maximumDescriptionLength(field),
    minLength: minimumDescriptionLength(field),
  }));

  const repairField = ({ fields, field, locale, title, body, siblingValues, maxLength, minLength }) => {
    const original = fields?.[field];
    if (typeof original !== 'string') return;
    const defects = findDescriptionDefects(original, { locale, field, body });
    if (defects.length === 0) return;
    const options = { locale, maxLength, minLength, body };
    const repairFromSibling = () => {
      for (const sibling of siblingValues) {
        const candidate = selectCompleteExcerptSource(sibling, { ...options, body });
        if (candidate === null) continue;
        if (!isSemanticallyCompatibleSibling(candidate, { target: original, title, body })) continue;
        fields[field] = candidate;
        repairs.push({ locale, field, source: 'sibling-description', before: original, after: candidate });
        return true;
      }
      return false;
    };
    if (original.trim() === '') {
      const bodyExcerpt = firstCompleteBodyExcerpt(body, { locale, field, maxLength, minLength });
      if (bodyExcerpt !== null) {
        fields[field] = bodyExcerpt;
        repairs.push({ locale, field, source: 'article-body', before: original, after: bodyExcerpt });
        return;
      }
      if (repairFromSibling()) return;
      const error = new Error(
        `[excerpt-complete] ${locale}/${article?.id ?? 'unknown'}/${field} is empty and has no safe body excerpt `
          + 'or sibling description',
      );
      error.qualityReject = true;
      throw error;
    }
    const selected = selectCompleteExcerptSource(original, { ...options, body });
    if (selected !== null) {
      if (selected !== original) {
        fields[field] = selected;
        repairs.push({ locale, field, source: 'existing-sentence', before: original, after: selected });
      }
      return;
    }

    const directRepair = repairExcerptFromOriginal(original, {
      body,
      field,
      locale,
      title,
      maxLength,
      minLength,
    });
    if (directRepair.strategy && directRepair.value !== original
      && isCompleteSourceCandidate(directRepair.value, options)) {
      fields[field] = directRepair.value;
      repairs.push({
        locale,
        field,
        source: directRepair.strategy === 'a' ? 'existing-sentence' : 'article-body',
        before: original,
        after: directRepair.value,
      });
      return;
    }

    if (repairFromSibling()) return;

    const reason = defects.length > 0 ? defects.join(', ') : `exceeds ${maxLength} characters without a complete sentence`;
    const error = new Error(`[excerpt-complete] ${locale}/${article?.id ?? 'unknown'}/${field} cannot be repaired safely (${reason})`);
    error.qualityReject = true;
    throw error;
  };

  for (const [locale, localeContent] of Object.entries(content)) {
    if (!localeContent || typeof localeContent !== 'object') continue;
    const body = Object.entries(localeContent)
      .filter(([field, value]) => /^body\d+$/u.test(field) && typeof value === 'string')
      .sort(([left], [right]) => Number(left.slice(4)) - Number(right.slice(4)))
      .map(([, value]) => value);
    const localeSiblings = ['excerpt', 'seoDescription', 'ogDescription', 'description']
      .map((field) => localeContent[field])
      .filter((value) => typeof value === 'string');

    for (const target of targetFields) {
      const siblingValues = localeSiblings.filter((value) => value !== localeContent[target.field]);
      if (locale === 'it' && article.seo && typeof article.seo === 'object') {
        siblingValues.push(article.seo.description, article.seo.ogDescription);
      }
      const title = typeof localeContent.title === 'string' ? localeContent.title : '';
      repairField({ fields: localeContent, locale, title, body, siblingValues, ...target });
    }
  }

  if (article.seo && typeof article.seo === 'object') {
    const italian = content.it && typeof content.it === 'object' ? content.it : {};
    const siblingValues = [
      article.seo.ogDescription,
      italian.excerpt,
      italian.seoDescription,
      italian.ogDescription,
    ].filter((value) => typeof value === 'string');
    const body = Object.entries(italian)
      .filter(([field, value]) => /^body\d+$/u.test(field) && typeof value === 'string')
      .sort(([left], [right]) => Number(left.slice(4)) - Number(right.slice(4)))
      .map(([, value]) => value);
    repairField({
      fields: article.seo,
      field: 'description',
      locale: 'it',
      title: typeof italian.title === 'string' ? italian.title : '',
      body,
      siblingValues,
      maxLength: maximumDescriptionLength('description'),
      minLength: minimumDescriptionLength('description'),
    });
    repairField({
      fields: article.seo,
      field: 'ogDescription',
      locale: 'it',
      title: typeof italian.title === 'string' ? italian.title : '',
      body,
      siblingValues: [article.seo.description, italian.excerpt, italian.seoDescription, italian.ogDescription]
        .filter((value) => typeof value === 'string'),
      maxLength: maximumDescriptionLength('ogDescription'),
      minLength: minimumDescriptionLength('ogDescription'),
    });
  }

  return repairs;
}

function cleanMarkdownLines(value) {
  const source = String(value ?? '').replace(/\r\n?/g, '\n');
  const lines = source.split('\n');
  const cleaned = [];

  for (let index = 0; index < lines.length; index += 1) {
    let line = lines[index];
    if (TABLE_SEPARATOR_RE.test(line) || HORIZONTAL_RULE_LINE_RE.test(line) || REFERENCE_DEFINITION_LINE_RE.test(line)) continue;

    const heading = line.match(HEADING_RE);
    if (heading) {
      const headingText = heading[1].trim();
      // Keep the useful part of the historical `## In breve - ...` shape,
      // while dropping real body section headings altogether.
      line = LABEL_RE.test(headingText) ? headingText : '';
    }
    if (!line.trim()) {
      cleaned.push('');
      continue;
    }

    if (TABLE_ROW_RE.test(line)) {
      line = line
        .replace(/^\s*\|/, '')
        .replace(/\|\s*$/, '')
        .replace(/\s*\|\s*/g, ' ');
    }

    if (!DATE_PREFIX_RE.test(line)) {
      line = line.replace(/^\s*(?:[-*+]|\d+\.)\s+/, '');
    }
    line = line
      .replace(/^\s*>\s?/, '')
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]\n]+)\]\[[^\]\n]*\]/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/`{1,3}([^`\n]+)`{1,3}/g, '$1')
      .replace(/\*\*([^*\n]+)\*\*/g, '$1')
      .replace(/__([^_\n]+)__/g, '$1')
      .replace(/~~([^~\n]+)~~/g, '$1')
      .replace(/(?<!\w)\*([^*\n]+)\*(?!\w)/g, '$1')
      .replace(/(?<!\w)_([^_\n]+)_(?!\w)/g, '$1')
      // A malformed/unpaired marker is still Markdown syntax.  Removing the
      // marker is safer for a card/description than leaking it publicly.
      .replace(/[\*_`]/g, '')
      .replace(/\|/g, ' ')
      .trim();
    cleaned.push(line);
  }

  return cleaned.join('\n');
}

/** Strip Markdown and labels, retaining all useful prose sentences. */
export function stripExcerptMarkdown(value) {
  return cleanMarkdownLines(value)
    .replace(/\s+/g, ' ')
    .replace(LABEL_PREFIX_RE, '')
    .trim();
}

function isUsefulSentence(value) {
  const sentence = String(value || '').trim();
  return sentence.length >= 12
    && /\p{L}/u.test(sentence)
    && !LABEL_RE.test(sentence);
}

/**
 * Deterministically choose one useful sentence from a generated excerpt or
 * body fallback.  If punctuation is absent, a dash-separated bullet summary
 * supplies the next-best sentence boundary.
 */
export function normalizeExcerpt(value, { locale = '' } = {}) {
  const plain = stripExcerptMarkdown(value);
  if (!plain) return '';

  const sentenceCandidates = sentencePrefixes(plain, locale).reverse();
  const sentence = sentenceCandidates
    .find((candidate) => candidate.length >= EXCERPT_MIN_LENGTH && isUsefulSentence(candidate));
  if (sentence) return sentence;

  const shortSentence = sentenceCandidates
    .find((candidate) => isUsefulSentence(candidate) && !endsWithSentenceAbbreviation(candidate, { locale }));
  // Some valid generated summaries are shorter than the historical 60-char
  // repair floor. Keep a complete sentence instead of normalizing it to empty.
  if (shortSentence) return shortSentence;

  const fragments = plain
    .split(/\s+[-–—]\s+/)
    .map((fragment) => fragment.trim())
    .filter((fragment) => fragment.length >= EXCERPT_MIN_LENGTH
      && isUsefulSentence(fragment)
      && TERMINAL_SENTENCE_PUNCTUATION_RE.test(fragment)
      && !endsWithSentenceAbbreviation(fragment, { locale }));
  const firstUseful = fragments[0];
  if (firstUseful) return firstUseful;
  return plain.length >= EXCERPT_MIN_LENGTH
    && TERMINAL_SENTENCE_PUNCTUATION_RE.test(plain)
    && !endsWithSentenceAbbreviation(plain, { locale })
    ? plain
    : '';
}

/** Throw the publication gate for Markdown and, by default, incomplete descriptions. */
export function assertPlainExcerpt(value, {
  field = 'excerpt',
  id = 'unknown',
  locale = 'unknown',
  body = [],
  checkCompleteness = true,
  requireTerminalPunctuation = true,
  requireNonEmpty = true,
} = {}) {
  const markdownDefects = findExcerptMarkdownDefects(value);
  if (markdownDefects.length > 0) {
    throw new Error(`[excerpt-plain] ${locale}/${id}/${field} contiene Markdown (${markdownDefects.join(', ')})`);
  }
  if (!checkCompleteness) return value;
  const completionDefects = findDescriptionDefects(value, {
    locale,
    field,
    body,
    requireTerminalPunctuation,
    requireNonEmpty,
  })
    .filter((defect) => !markdownDefects.includes(defect));
  if (completionDefects.length > 0) {
    throw new Error(`[excerpt-complete] ${locale}/${id}/${field} non rispetta il contratto (${completionDefects.join(', ')})`);
  }
  return value;
}

/**
 * Assert every reader-facing description in a record before its writer emits
 * it.  The normal generator, same-day refresh and SEO recovery use different
 * writers, so the shared field list keeps their guards in lockstep.
 */
export function assertPlainDescriptionFields(fields, {
  fieldPrefix = '',
  id = 'unknown',
  locale = 'unknown',
  requireTerminalPunctuation = true,
  requireNonEmpty = true,
} = {}) {
  const body = Object.entries(fields ?? {})
    .filter(([name, bodyValue]) => /^body\d+$/u.test(name) && typeof bodyValue === 'string')
    .sort(([left], [right]) => Number(left.slice(4)) - Number(right.slice(4)))
    .map(([, bodyValue]) => bodyValue);
  for (const field of PLAIN_DESCRIPTION_FIELDS) {
    const value = fields?.[field];
    if (typeof value !== 'string') continue;
    if (value.trim() === '' && !(field === 'excerpt' && requireNonEmpty)) continue;
    assertPlainExcerpt(value, {
      field: `${fieldPrefix}${field}`,
      id,
      locale,
      body,
      requireTerminalPunctuation,
      requireNonEmpty,
    });
  }
  return fields;
}
