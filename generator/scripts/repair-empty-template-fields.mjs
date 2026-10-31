#!/usr/bin/env node
/**
 * repair-empty-template-fields.mjs — toglie dai corpi pubblicati i campi del
 * template rimasti senza valore e i marcatori del prompt finiti nel testo.
 *
 * «Importo: Non specificato» in un blocco Fatti chiave non e' un'informazione: e'
 * lo schema del prompt rimasto vuoto, e nel generatore `stripVacuousFacts` lo
 * toglie gia'. Qui si ripara l'arretrato: 684 file italiani, piu' le lingue.
 * Il generatore rifiuta una sezione che scende sotto tre fatti; sul corpus gia'
 * pubblicato una riga vuota non vale piu' di una riga in meno, quindi si toglie
 * sempre, e con l'ultima riga se ne va anche il titolo della sezione.
 *
 * `TITRE DE L'ARTICLE :` e i gemelli sono il marcatore di sezione del prompt,
 * tradotto. A inizio riga si toglie la riga, che ripete il titolo; dentro una frase
 * si toglie il marcatore con il titolo che lo segue, se e' quello dell'articolo.
 *
 * Round-trip come in `repair-prompt-placeholders.mjs`: un campo il cui letterale
 * non si ricostruisce identico viene saltato e segnalato.
 *
 * Uso:
 *   node generator/scripts/repair-empty-template-fields.mjs --check
 *   node generator/scripts/repair-empty-template-fields.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { escapeForSingleQuoteTS, unescapeForSingleQuoteTS } from './lib/article-meta-block.mjs';
import { factValueOf, isEmptyAmountFact, matchesVacuousValue, parseAiSearchSections } from './lib/key-facts-specificity.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BODY_FIELD_RE = /('blog\.article\.[^']+\.body\d+':\s*')((?:[^'\\]|\\.)*)(')/g;
const TITLE_MARKER = "(?:TITOLO ARTICOLO|ARTICLE TITLE|ARTIKEL-?TITEL|TITEL DES ARTIKELS|TITRE (?:DE L['’]ARTICLE|ARTICLE))";
const MARKER_LINE_RE = new RegExp(`^[^\\S\\n]*#{0,4}[^\\S\\n]*${TITLE_MARKER}[^\\S\\n]*:?[^\\n]*\\n?`, 'gmu');
const MARKER_INLINE_RE = new RegExp(`[^\\S\\n]*(?<![\\p{L}\\p{N}])${TITLE_MARKER}[^\\S\\n]*:[^\\S\\n]*`, 'gu');
const FACT_LINE_RE = /^\s*(?:[-*•]\s+|\*\*)[^\n]{1,90}$|^[^\s#|][^:\n]{1,60}:\s*\S[^\n]{0,40}$/;

/** «Importo: Non specificato, ma stimato in 2 milioni»: il valore e' cio' che segue. */
const QUALIFIED_EMPTY_RE = /^(\s*(?:[-*•]\s+)?(?:\*\*)?[^:\n]{1,40}(?:\*\*)?:(?:\*\*)?\s*)(?:Non specificat[oa]|Not specified|Nicht angegeben|Non spécifiée?),?\s+(?:ma|but|aber|mais)\s+(\S)/gmu;
const TRAILING_EMPTY_RE = /^\s*(?:[-*•]\s+)?(?:\*\*)?[^:\n]{1,40}(?:\*\*)?:(?:\*\*)?\s*(?:Non specificat[oa] (?:nella fonte|nell['’]articolo)|Not specified in the (?:source|article)|In der Quelle nicht angegeben|Non précisée? dans la source)\.?[^\S\n]*\n?/gimu;
/** I corpi su una riga sola: «- Betrag: Nicht angegeben. Im Mai 2026 ...». */
const INLINE_EMPTY_RE = /[^\S\n]+[-*•][^\S\n]+(?:\*\*)?(?:Importo|Amount|Betrag|Montant)(?:\*\*)?:(?:\*\*)?[^\S\n]*(?:Non specificat[oa]|Not specified|Nicht angegeben|Non spécifiée?)(?: nella fonte| nell['’]articolo| in the source| in the article)?\.?(?=\s|$)/gu;

function removeEmptyFacts(input) {
  let removed = 0;
  let value = input
    .replace(QUALIFIED_EMPTY_RE, (all, label, first) => {
      removed += 1;
      return `${label}${first.toLocaleUpperCase('it')}`;
    })
    .replace(TRAILING_EMPTY_RE, () => {
      removed += 1;
      return '';
    })
    .replace(INLINE_EMPTY_RE, () => {
      removed += 1;
      return '';
    });
  const body = value;
  for (const section of parseAiSearchSections(value).reverse()) {
    const bad = section.bullets.filter((bullet) => matchesVacuousValue(bullet.value) || isEmptyAmountFact(bullet.raw));
    if (bad.length === 0) continue;
    const emptied = bad.length === section.bullets.length;
    for (const bullet of [...bad].reverse()) {
      value = value.slice(0, bullet.start) + value.slice(bullet.end);
      removed += 1;
    }
    if (emptied) {
      const end = value.indexOf('\n', section.headingStart);
      value = value.slice(0, section.headingStart) + value.slice(end === -1 ? value.length : end + 1);
    }
  }
  const lines = value.split('\n').filter((line) => {
    if (!FACT_LINE_RE.test(line)) return true;
    const empty = matchesVacuousValue(factValueOf(line)) || isEmptyAmountFact(line);
    if (empty) removed += 1;
    return !empty;
  });
  if (removed === 0) return { value: body, removed };
  return { value: lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd(), removed };
}

function removeMarkers(body, title) {
  let removed = 0;
  let value = body.replace(MARKER_LINE_RE, () => {
    removed += 1;
    return '';
  });
  value = value.replace(MARKER_INLINE_RE, (marker, offset, whole) => {
    removed += 1;
    return title && whole.startsWith(title, offset + marker.length) ? ' \u0000' : ' ';
  });
  if (title) value = value.split(` \u0000${title}`).join('');
  return { value: value.replace(/\u0000/g, ''), removed };
}

export function repairBody(body, title = '') {
  const markers = removeMarkers(body, title);
  const facts = removeEmptyFacts(markers.value);
  return { value: facts.value, facts: facts.removed, markers: markers.removed };
}

function readTitles(contentDir) {
  const titles = new Map();
  for (const name of fs.readdirSync(contentDir)) {
    const match = /^blog-meta(?:-ch|-canton-[a-z]+)?-(it|en|de|fr)\.ts$/.exec(name);
    if (!match) continue;
    const source = fs.readFileSync(path.join(contentDir, name), 'utf8');
    for (const [, id, title] of source.matchAll(/'blog\.article\.([^.']+)\.title':\s*'((?:[^'\\]|\\.)*)'/g)) {
      titles.set(`${match[1]}|${id}`, unescapeForSingleQuoteTS(title));
    }
  }
  return titles;
}

function main(argv) {
  const check = argv.includes('--check');
  const contentDir = path.join(ROOT, 'content');
  const titles = readTitles(contentDir);
  const totals = { file: 0, fatti: 0, marcatori: 0, saltati: 0 };
  for (const dir of fs.readdirSync(contentDir).filter((name) => name.startsWith('blog-body'))) {
    for (const locale of fs.readdirSync(path.join(contentDir, dir))) {
      const localeDir = path.join(contentDir, dir, locale);
      for (const name of fs.readdirSync(localeDir)) {
        const file = path.join(localeDir, name);
        const source = fs.readFileSync(file, 'utf8');
        const id = name.replace(/\.ts$/, '');
        const title = titles.get(`${locale}|${id}`) ?? '';
        const next = source.replace(BODY_FIELD_RE, (all, head, literal, tail) => {
          const decoded = unescapeForSingleQuoteTS(literal);
          if (escapeForSingleQuoteTS(decoded) !== literal) {
            totals.saltati += 1;
            return all;
          }
          const repaired = repairBody(decoded, title);
          totals.fatti += repaired.facts;
          totals.marcatori += repaired.markers;
          if (repaired.value === decoded) return all;
          return `${head}${escapeForSingleQuoteTS(repaired.value)}${tail}`;
        });
        if (next === source) continue;
        totals.file += 1;
        if (!check) fs.writeFileSync(file, next);
      }
    }
  }
  console.log(JSON.stringify(totals));
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
