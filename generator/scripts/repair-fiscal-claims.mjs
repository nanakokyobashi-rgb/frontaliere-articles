#!/usr/bin/env node
/**
 * repair-fiscal-claims.mjs — toglie dal corpus pubblicato le affermazioni fiscali
 * smentite dalle fonti primarie (`lib/fiscal-claims-guard.mjs`).
 *
 * Il gate impedisce agli errori di nascere; questo script ripara quelli usciti.
 * Stessa divisione di `repair-prompt-placeholders.mjs`.
 *
 * Tre passaggi, dal piu' chirurgico al piu' netto:
 *
 *  1. coppie di importi: «franchigia 7.500/10.000 €», «(7.500 € o 10.000 €)» e
 *     varianti diventano il solo importo in vigore; il resto della frase resta;
 *  2. «mai in entrambi i Paesi»: si toglie solo l'inciso, perche' «trattenuta solo
 *     in Svizzera» e' vero per la ritenuta;
 *  3. la frase che resta falsa si sostituisce con quella corretta, nella lingua del
 *     file. Nello stesso file la frase corretta compare una volta nella prosa: le
 *     successive si tolgono. Bullet, celle e FAQ mantengono la propria struttura.
 *     Le altre regole del guard (forfait sanitario, 38,8%, credito 80%, 20%
 *     retrocesso) non hanno una frase sostitutiva sicura: la frase esce.
 *
 * Gli esempi aritmetici non si toccano qui: un calcolo con una base sbagliata ha
 * righe successive che ne dipendono, e sostituire la riga lascerebbe un totale
 * falso. Vengono elencati in `arith` e si correggono a mano; `--replace-arithmetic`
 * sostituisce quelli rimasti, che nessuna riga successiva usa piu'.
 *
 * Lavora sul letterale grezzo: le frasi sostitutive non contengono apostrofi dritti
 * ne' virgolette, quindi non serve riscrivere gli escape del file.
 *
 * Uso:
 *   node generator/scripts/repair-fiscal-claims.mjs --check   # misura, non scrive
 *   node generator/scripts/repair-fiscal-claims.mjs           # applica
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeFileSnapshotAtomically } from '../../scripts/lib/write-file-pair-atomically.mjs';
import { AMOUNT_7500, findFiscalClaims, findTaxHealthParameterErrors } from './lib/fiscal-claims-guard.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const TEXTS = {
  it: {
    sentence: 'I vecchi frontalieri (art. 9 dell’Accordo) sono tassati sul salario solo in Svizzera; la franchigia IRPEF di 10.000 € vale dal 2024 per i frontalieri il cui reddito è tassato in Italia.',
    short: 'Vecchi frontalieri tassati solo in Svizzera; franchigia IRPEF di 10.000 € per chi è tassato in Italia.',
    cell: 'tassati solo in Svizzera (art. 9)',
    question: 'Quale franchigia IRPEF si applica ai frontalieri?',
    heading: 'Franchigia IRPEF dei frontalieri',
    amount: '10.000 €',
  },
  en: {
    sentence: 'Old cross-border workers (Art. 9 of the Agreement) are taxed on their salary only in Switzerland; the €10,000 IRPEF allowance has applied since 2024 to cross-border workers whose income is taxed in Italy.',
    short: 'Old cross-border workers are taxed only in Switzerland; €10,000 IRPEF allowance if taxed in Italy.',
    cell: 'taxed only in Switzerland (Art. 9)',
    question: 'Which IRPEF allowance applies to cross-border workers?',
    heading: 'IRPEF allowance for cross-border workers',
    amount: '€10,000',
  },
  de: {
    sentence: 'Altgrenzgänger (Art. 9 des Abkommens) werden auf ihren Lohn nur in der Schweiz besteuert; der IRPEF-Freibetrag von 10.000 € gilt seit 2024 für Grenzgänger, deren Einkommen in Italien besteuert wird.',
    short: 'Altgrenzgänger werden nur in der Schweiz besteuert; IRPEF-Freibetrag von 10.000 € bei Besteuerung in Italien.',
    cell: 'nur in der Schweiz besteuert (Art. 9)',
    question: 'Welcher IRPEF-Freibetrag gilt für Grenzgänger?',
    heading: 'IRPEF-Freibetrag für Grenzgänger',
    amount: '10.000 €',
  },
  fr: {
    sentence: 'Les anciens frontaliers (art. 9 de l’Accord) sont imposés sur leur salaire uniquement en Suisse ; la franchise IRPEF de 10 000 € s’applique depuis 2024 aux frontaliers dont le revenu est imposé en Italie.',
    short: 'Anciens frontaliers imposés uniquement en Suisse ; franchise IRPEF de 10 000 € en cas d’imposition en Italie.',
    cell: 'imposés uniquement en Suisse (art. 9)',
    question: 'Quelle franchise IRPEF s’applique aux frontaliers ?',
    heading: 'Franchise IRPEF des frontaliers',
    amount: '10 000 €',
  },
};

const CURRENCY_BEFORE = String.raw`(?:(?:€|EUR|CHF|Fr\.)[  ]?)?`;
const CURRENCY_AFTER = String.raw`(?:[  ]?(?:€|EUR|euro|Euro|CHF|Franken|francs))?`;
const A7 = `${CURRENCY_BEFORE}${AMOUNT_7500}${CURRENCY_AFTER}`;
const A10 = `${CURRENCY_BEFORE}10(?:\\\\?['’]|[.,\\u00a0 ])?000${CURRENCY_AFTER}`;
const SEPARATOR = String.raw`[\u00a0 ]*(?:\((?:vecchi|nuovi|old|new|alte|neue|anciens|nouveaux)\)[\u00a0 ]*)?(?:\/|–|—|-|vs\.?|o|or|oder|ou|e|and|und|et|bzw\.|bis|fino a|to|à)[\u00a0 ]*`;
const PAIR_RE = new RegExp(`(?<![\\d.,])(?:${A7}${SEPARATOR}${A10}|${A10}${SEPARATOR}${A7})(?![\\d])`, 'g');
const PLURAL_RE = /\b(franchigie|allowances|Freibeträge|franchises)(\s+(?:IRPEF\s+)?(?:di\s+|von\s+|de\s+|of\s+)?)$/;
const SINGULAR = { franchigie: 'franchigia', allowances: 'allowance', 'Freibeträge': 'Freibetrag', franchises: 'franchise' };

const NEVER_BOTH = [
  /\s+(?:e|and|und|et)\s+(?:mai in entrambi i paesi|never in both countries|nie(?:mals)? in beiden Ländern|jamais dans les deux pays)/gi,
  /\s*[,—–-]\s*(?:ma\s+)?mai in entrambi i [Pp]aesi/g,
  /\s*\(mai in entrambi i [Pp]aesi[^)]{0,30}\)/g,
  /\s*[,—–-]\s*never in both countries(?: at the same time)?/g,
  /\s*\(never in both countries(?: at the same time)?\)/g,
  /\s*[,—–-]\s*nie(?:mals)? in beiden Ländern(?: gleichzeitig)?/g,
  /\s*\(nie(?:mals)? in beiden Ländern(?: gleichzeitig)?\)/g,
  /\s*[,—–-]\s*jamais dans les deux pays(?: en même temps)?/g,
  /\s*\(jamais dans les deux pays(?: en même temps)?\)/g,
];

/** L'Accordo e' in vigore dal 17/7/2023: dal 1/1/2024 si applica. */
const IN_FORCE_2024 = [
  [/\bin vigore dal(?:l)?\s+(1°?\s*(?:o\s+)?gennaio 2024)/gi, 'applicato dal $1'],
  [/\b(?:in force from|in force since|effective from)\s+((?:1 January|January 1,?) 2024)/gi, 'applied since $1'],
  [/\bentered into force on\s+((?:1 January|January 1,?) 2024)/gi, 'applied from $1'],
  [/\b(?:has been in force since|entered into force on|in force from|in force since)\s+1° gennaio 2024/gi, 'applied since 1 January 2024'],
  [/\bin Kraft seit\s+(1\.\s*Januar 2024)/gi, 'anwendbar seit $1'],
  [/\ben vigueur depuis\s+(?:le\s+)?(1er janvier 2024)/gi, 'appliqué depuis le $1'],
];

const ARITHMETIC_RE = new RegExp(`[-−–]\\s*(?:€\\s?)?${AMOUNT_7500}|${AMOUNT_7500}\\s?(?:€\\s?)?\\)?\\s*=|=\\s*€?\\s?\\d`);

function localeOf(rel, sentence) {
  const fromPath = /\/(it|en|de|fr)\//.exec(rel)?.[1] ?? /-(it|en|de|fr)\.ts$/.exec(rel)?.[1];
  if (fromPath) return fromPath;
  if (/\b(the|and|workers|cross-border)\b/i.test(sentence)) return 'en';
  if (/(grenzg|\bund\b|\bdie\b)/i.test(sentence)) return 'de';
  if (/(frontaliers|\ble\b|\bles\b)/i.test(sentence)) return 'fr';
  return 'it';
}

function repairPairs(text, rel) {
  let out = '';
  let last = 0;
  for (const match of text.matchAll(PAIR_RE)) {
    const locale = localeOf(rel, text.slice(Math.max(0, match.index - 120), match.index));
    const head = text.slice(last, match.index).replace(PLURAL_RE, (all, word, tail) => `${SINGULAR[word]}${tail}`);
    out += head + TEXTS[locale].amount;
    last = match.index + match[0].length;
  }
  return out + text.slice(last);
}

const LABEL_RE = /^(\s*(?:[-*•]\s+|\d+\.\s+)?(?:\*\*[^*\n]{1,50}\*\*\s*:?\s*|[^\s:|*][^:|\n]{0,38}:\s+))/;

function replacementFor(text, rel, claim, state) {
  const locale = localeOf(rel, claim.sentence);
  const copy = TEXTS[locale];
  const before = text.slice(Math.max(0, claim.start - 2), claim.start);
  const after = text.slice(claim.end, claim.end + 1);
  const atLineStart = before.endsWith('\\n') || before.endsWith('\n') || claim.start === 0;
  const trimmed = claim.sentence.trim();
  const isCompact = /^(?:blog-meta|seo\/)/.test(rel);
  if (before.endsWith('|') || after === '|') {
    return ` ${copy.cell} `;
  }
  if (/^#{1,6}\s/.test(trimmed)) {
    return claim.sentence.replace(/^(\s*#{1,6}\s).*$/s, `$1${copy.heading}`);
  }
  if (trimmed.endsWith('?')) return copy.question;
  if (isCompact) return copy.short;
  const inFaq = /":\s?"$/.test(text.slice(Math.max(0, claim.start - 5), claim.start));
  const bullet = atLineStart ? /^\s*(?:[-*•]\s+|\d+\.\s+)/.exec(claim.sentence)?.[0] ?? '' : '';
  const rawLabel = atLineStart ? LABEL_RE.exec(claim.sentence)?.[1] ?? bullet : '';
  const label = new RegExp(AMOUNT_7500).test(rawLabel) ? bullet : rawLabel;
  const sentence = copy.sentence;
  if (!inFaq && !label && !bullet && state.used) return '';
  if (!inFaq) state.used = true;
  return `${label}${sentence}`;
}

export function repairFiscalText(input, rel, { replaceArithmetic = false } = {}) {
  let text = repairPairs(input, rel);
  for (const re of NEVER_BOTH) text = text.replace(re, '');
  for (const [re, replacement] of IN_FORCE_2024) text = text.replace(re, replacement);
  const state = { used: false };
  const arith = [];
  const claims = findFiscalClaims(text).filter((claim) => claim.id === 'franchigia-7500');
  let out = '';
  let last = 0;
  for (const claim of claims) {
    if (claim.start < last) continue;
    if (ARITHMETIC_RE.test(claim.sentence) && !replaceArithmetic) {
      arith.push(claim.sentence.trim().slice(0, 160));
      continue;
    }
    let replacement = replacementFor(text, rel, claim, state);
    let start = claim.start;
    if (replacement === '' && out.endsWith(' ') === false && text[start - 1] === ' ') start -= 1;
    if (replacement && /\s$/.test(claim.sentence) && !/\s$/.test(replacement)) replacement += ' ';
    if (replacement && /^\s/.test(claim.sentence) && !/^\s/.test(replacement)) replacement = ` ${replacement}`;
    out += text.slice(last, start) + replacement;
    last = claim.end;
  }
  return { text: dropWrongTaxHealthRates(dropRefutedSentences(out + text.slice(last), rel), rel), arith };
}

/**
 * Le altre regole non hanno una frase sostitutiva sicura: la frase e' falsa per
 * intero, e l'unica correzione generale e' toglierla.
 */
function dropRefutedSentences(text, rel) {
  if (FABRICATED_TAX_HEALTH_ARTICLES.test(rel)) return text;
  let out = text;
  for (const claim of findFiscalClaims(text).filter(({ id }) => id !== 'franchigia-7500').reverse()) {
    out = out.slice(0, claim.start) + out.slice(claim.end);
  }
  return out;
}

/**
 * Una percentuale sbagliata della quota SSN non si puo' correggere: la cifra vera
 * dipende dalla Regione. La frase esce. Gli articoli costruiti su quelle cifre
 * stanno in `manualExclusions` del ledger: la frase, li', e' il meno.
 */
const FABRICATED_TAX_HEALTH_ARTICLES = /\/tassa-salute-frontalieri-ticino-2026\.ts$/;

function dropWrongTaxHealthRates(text, rel) {
  if (FABRICATED_TAX_HEALTH_ARTICLES.test(rel)) return text;
  let out = text;
  for (const error of findTaxHealthParameterErrors(text).reverse()) {
    out = out.slice(0, error.start) + out.slice(error.end);
  }
  return out;
}

function* corpusFiles(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'image-credits') yield* corpusFiles(full);
    } else if (entry.name.endsWith('.ts')) {
      yield full;
    }
  }
}

function main(argv) {
  const check = argv.includes('--check');
  const contentDir = path.join(ROOT, 'content');
  const touched = [];
  const arith = [];
  for (const file of corpusFiles(contentDir)) {
    const rel = path.relative(contentDir, file);
    if (/(-articles-data|routerBlogData|routerSwissData|blogArticleIds|registry|slugs)\.ts$/.test(rel)) continue;
    const source = fs.readFileSync(file, 'utf8');
    const { text, arith: found } = repairFiscalText(source, rel, { replaceArithmetic: argv.includes('--replace-arithmetic') });
    for (const sentence of found) arith.push(`${rel}: ${sentence}`);
    if (text === source) continue;
    touched.push(rel);
    if (!check) writeFileSnapshotAtomically(file, source, text);
  }
  console.log(JSON.stringify({ fileRiparati: touched.length, esempiAritmetici: arith.length }));
  for (const row of arith) console.log(`ARITH ${row}`);
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
