#!/usr/bin/env node
/**
 * Backfill deterministico delle label dei link `nav:` nei body tradotti.
 *
 * La run e' dry-run per default. `--apply` scrive solo i body nei quali
 * `localizeNavLinkLabels()` ha prodotto una sostituzione nota; le label che la
 * mappa non conosce restano intatte e vengono riportate nel riepilogo.
 *
 * Uso:
 *   node generator/scripts/backfill-nav-link-labels.mjs
 *   node generator/scripts/backfill-nav-link-labels.mjs --apply --limit 60 \
 *     --order hits --lang de --lang fr --lang en
 *   node generator/scripts/backfill-nav-link-labels.mjs --apply --start-after <id>
 */

import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { findItalianNavLinkLabels, localizeNavLinkLabels } from '../../scripts/lib/nav-link-labels.mjs';
import { writeFileSnapshotAtomically } from '../../scripts/lib/write-file-pair-atomically.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const LOCALES = Object.freeze(['de', 'fr', 'en']);
export const BODY_ROOTS = Object.freeze(['content/blog-body', 'content/blog-body-ch']);
export const ORDERS = Object.freeze(['id', 'hits']);

const STRING_QUOTES = new Set(["'", '"', '`']);
const BODY_KEY_RE = /^blog\.article\.([^'"\r\n]+)\.(body(?:[1-9]|1[0-9]|20))$/u;
const NAV_LINK_RE = /\[([^\]\n]+)\]\((nav:[^)]*)\)/gu;

const HELP = `Uso: node generator/scripts/backfill-nav-link-labels.mjs [opzioni]

  --apply                 scrive i body; senza, la run e' dry-run
  --lang de|fr|en         locale da trattare; ripetibile (default: tutti)
  --limit N               massimo di articoli nel lotto per locale
  --offset N              salta N articoli nell'ordine alfabetico stabile
  --start-after <id>      riprende dopo l'articolo con questo id
  --order id|hits         ordine alfabetico stabile (default) o priorita' per hit
                           hits vieta --start-after e --offset
  --help                  mostra questo messaggio

Un'interruzione durante --apply non perde le label: rilanciare gli stessi
argomenti completa il lotto senza riscrivere i file gia' localizzati.
`;

function fail(message) {
  throw new Error(`backfill-nav-link-labels: ${message}`);
}

function parseNonNegativeInteger(value, flag) {
  if (!/^\d+$/u.test(value)) fail(`${flag} richiede un intero >= 0, ricevuto: ${value}`);
  const number = Number(value);
  if (!Number.isSafeInteger(number)) fail(`${flag} fuori dal range safe integer: ${value}`);
  return number;
}

function readFlagValue(argv, index, flag, inlineValue) {
  if (inlineValue !== undefined) {
    if (inlineValue === '') fail(`${flag} richiede un valore`);
    return { value: inlineValue, next: index };
  }
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) fail(`${flag} richiede un valore`);
  return { value, next: index + 1 };
}

export function parseArgs(argv = process.argv.slice(2)) {
  const locales = [];
  let apply = false;
  let limit = Number.POSITIVE_INFINITY;
  let offset = 0;
  let offsetProvided = false;
  let startAfter = null;
  let order = 'id';
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') {
      apply = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      help = true;
      continue;
    }

    const match = /^(--lang|--limit|--offset|--start-after|--order)(?:=(.*))?$/u.exec(arg);
    if (!match) fail(`opzione sconosciuta: ${arg}`);
    const { value, next } = readFlagValue(argv, index, match[1], match[2]);
    index = next;
    if (match[1] === '--lang') {
      if (!LOCALES.includes(value)) fail(`locale non supportato: ${value}`);
      if (!locales.includes(value)) locales.push(value);
    } else if (match[1] === '--limit') {
      limit = parseNonNegativeInteger(value, '--limit');
    } else if (match[1] === '--offset') {
      offset = parseNonNegativeInteger(value, '--offset');
      offsetProvided = true;
    } else if (match[1] === '--order') {
      if (!ORDERS.includes(value)) fail(`ordine non supportato: ${value}; usare id o hits`);
      order = value;
    } else {
      startAfter = value;
    }
  }

  if (!help && order === 'hits' && startAfter !== null) {
    fail('--order hits non puo\' usare --start-after: l\'ordine per hit non e\' stabile tra una run e l\'altra');
  }
  if (!help && order === 'hits' && offsetProvided) {
    fail('--order hits non puo\' usare --offset: l\'ordine per hit non e\' stabile tra una run e l\'altra');
  }

  return {
    apply,
    help,
    locales: locales.length ? locales : [...LOCALES],
    limit,
    offset,
    offsetProvided,
    order,
    startAfter,
  };
}

function skipComment(source, offset) {
  if (source.startsWith('//', offset)) {
    const newline = source.indexOf('\n', offset + 2);
    return newline === -1 ? source.length : newline;
  }
  if (source.startsWith('/*', offset)) {
    const end = source.indexOf('*/', offset + 2);
    return end === -1 ? source.length : end + 2;
  }
  return offset;
}

function decodeEscape(character) {
  return {
    n: '\n',
    r: '\r',
    t: '\t',
    b: '\b',
    f: '\f',
    v: '\v',
    0: '\0',
  }[character] ?? character;
}

/**
 * Legge un literal TS e conserva, per ogni carattere decodificato, il range
 * raw che lo ha prodotto. Questo permette di cambiare soltanto la label, senza
 * ricodificare il body e quindi senza normalizzare altri byte del file.
 */
function readStringToken(source, offset) {
  const quote = source[offset];
  if (!STRING_QUOTES.has(quote)) return null;

  const spans = [];
  let value = '';
  for (let index = offset + 1; index < source.length; index += 1) {
    const character = source[index];
    if (character === quote) {
      return {
        quote,
        value,
        spans,
        contentStart: offset + 1,
        end: index + 1,
      };
    }
    if (character === '\\' && index + 1 < source.length) {
      const rawStart = index;
      const decoded = decodeEscape(source[index + 1]);
      value += decoded;
      for (let decodedIndex = 0; decodedIndex < decoded.length; decodedIndex += 1) {
        spans.push({ start: rawStart, end: index + 2 });
      }
      index += 1;
      continue;
    }
    value += character;
    spans.push({ start: index, end: index + 1 });
  }
  return null;
}

function readBodyFields(source) {
  const fields = [];
  for (let index = 0; index < source.length;) {
    const afterComment = skipComment(source, index);
    if (afterComment !== index) {
      index = afterComment;
      continue;
    }

    const key = readStringToken(source, index);
    if (!key) {
      index += 1;
      continue;
    }
    let next = key.end;
    while (/\s/u.test(source[next] ?? '')) next += 1;
    const keyMatch = BODY_KEY_RE.exec(key.value);
    if (keyMatch && source[next] === ':') {
      let valueStart = next + 1;
      while (/\s/u.test(source[valueStart] ?? '')) valueStart += 1;
      const value = readStringToken(source, valueStart);
      if (value) {
        fields.push({
          id: keyMatch[1],
          field: keyMatch[2],
          ...value,
        });
      }
    }
    index = key.end;
  }
  return fields;
}

function encodeFragment(value, quote) {
  let encoded = String(value)
    .replaceAll('\\', '\\\\')
    .replaceAll('\n', '\\n')
    .replaceAll('\r', '\\r');
  if (quote === "'") return encoded.replaceAll("'", "\\'");
  if (quote === '"') return encoded.replaceAll('"', '\\"');
  if (quote === '`') return encoded.replaceAll('`', '\\`');
  fail(`delimitatore TS non supportato: ${quote}`);
}

function linkChanges(body, locale) {
  const beforeHits = findItalianNavLinkLabels(body, locale);
  const localizedBody = localizeNavLinkLabels(body, locale);
  const substitutions = [];

  for (const match of body.matchAll(NAV_LINK_RE)) {
    const whole = match[0];
    const localizedWhole = localizeNavLinkLabels(whole, locale);
    if (localizedWhole === whole) continue;

    const originalTargetAt = whole.indexOf('](');
    const localizedTargetAt = localizedWhole.indexOf('](');
    if (originalTargetAt < 0 || localizedTargetAt < 0
      || whole.slice(originalTargetAt) !== localizedWhole.slice(localizedTargetAt)) {
      fail(`localizzazione ha alterato il target del link in locale ${locale}`);
    }
    substitutions.push({
      after: localizedWhole.slice(1, localizedTargetAt),
      before: match[1],
      end: (match.index ?? 0) + 1 + match[1].length,
      start: (match.index ?? 0) + 1,
      target: match[2],
    });
  }

  return {
    afterHits: findItalianNavLinkLabels(localizedBody, locale),
    beforeHits,
    localizedBody,
    substitutions,
  };
}

export function localizeBodySource(source, locale) {
  if (!LOCALES.includes(locale)) fail(`locale non supportato: ${locale}`);
  const original = String(source);
  const fields = readBodyFields(original);
  const patches = [];
  const substitutions = [];
  const beforeHits = [];
  const afterHits = [];

  for (const field of fields) {
    const result = linkChanges(field.value, locale);
    beforeHits.push(...result.beforeHits);
    afterHits.push(...result.afterHits);
    for (const substitution of result.substitutions) {
      const first = field.spans[substitution.start];
      const last = field.spans[substitution.end - 1];
      if (!first || !last || field.value.slice(substitution.start, substitution.end) !== substitution.before) {
        fail(`range raw non risolvibile per ${field.id}.${field.field}`);
      }
      patches.push({
        after: encodeFragment(substitution.after, field.quote),
        before: substitution.before,
        end: last.end,
        start: first.start,
      });
      substitutions.push({
        after: substitution.after,
        before: substitution.before,
        field: field.field,
        id: field.id,
        target: substitution.target,
      });
    }
  }

  patches.sort((left, right) => right.start - left.start);
  let localizedSource = original;
  let nextEnd = Number.POSITIVE_INFINITY;
  for (const patch of patches) {
    if (patch.end > nextEnd) fail('sostituzioni nav sovrapposte');
    localizedSource = localizedSource.slice(0, patch.start)
      + patch.after
      + localizedSource.slice(patch.end);
    nextEnd = patch.start;
  }

  return {
    afterHits,
    beforeHits,
    changed: localizedSource !== original,
    source: localizedSource,
    substitutions,
  };
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareArticlesByHits(left, right) {
  const byLabels = right.beforeHits.length - left.beforeHits.length;
  if (byLabels) return byLabels;
  const byId = compareStrings(left.id, right.id);
  if (byId) return byId;
  return compareStrings(left.relativePath, right.relativePath);
}

function compareArticlesById(left, right) {
  const byId = compareStrings(left.id, right.id);
  if (byId) return byId;
  return compareStrings(left.relativePath, right.relativePath);
}

export function scanLocale(root, locale) {
  if (!LOCALES.includes(locale)) fail(`locale non supportato: ${locale}`);
  const articles = [];
  for (const bodyRoot of BODY_ROOTS) {
    const directory = path.join(root, bodyRoot, locale);
    if (!existsSync(directory)) fail(`directory mancante: ${path.relative(root, directory)}`);
    const files = readdirSync(directory)
      .filter((file) => file.endsWith('.ts'))
      .sort(compareStrings);
    for (const file of files) {
      const filePath = path.join(directory, file);
      const source = readFileSync(filePath, 'utf8');
      const plan = localizeBodySource(source, locale);
      articles.push({
        ...plan,
        file,
        filePath,
        id: file.slice(0, -3),
        relativePath: path.join(bodyRoot, locale, file),
        source,
        afterSource: plan.source,
      });
    }
  }
  return articles;
}

function summarizeHits(hits) {
  const unmapped = new Map();
  for (const hit of hits) {
    if (hit.canonicalLabel !== null) continue;
    unmapped.set(hit.label, (unmapped.get(hit.label) ?? 0) + 1);
  }
  const top = [...unmapped.entries()]
    .sort((left, right) => right[1] - left[1] || compareStrings(left[0], right[0]))
    .map(([label, count]) => ({ count, label }));
  return {
    articles: new Set(hits.map((hit) => hit.articlePath).filter(Boolean)).size,
    italianLabels: hits.length,
    topUnmapped: top,
  };
}

function annotateHits(articles, selected) {
  const selectedSet = new Set(selected);
  const beforeHits = [];
  const afterHits = [];
  for (const article of articles) {
    const chosenHits = selectedSet.has(article) ? article.afterHits : article.beforeHits;
    for (const hit of chosenHits) {
      afterHits.push({ ...hit, articlePath: article.relativePath });
    }
    for (const hit of article.beforeHits) {
      beforeHits.push({ ...hit, articlePath: article.relativePath });
    }
  }
  return { afterHits, beforeHits };
}

function selectArticles(articles, { limit, offset, offsetProvided = false, order, startAfter }) {
  if (!ORDERS.includes(order)) fail(`ordine non supportato: ${order}; usare id o hits`);
  if (order === 'hits' && startAfter !== null) {
    fail('--order hits non puo\' usare --start-after: l\'ordine per hit non e\' stabile tra una run e l\'altra');
  }
  if (order === 'hits' && (offsetProvided || offset !== 0)) {
    fail('--order hits non puo\' usare --offset: l\'ordine per hit non e\' stabile tra una run e l\'altra');
  }

  const compare = order === 'hits' ? compareArticlesByHits : compareArticlesById;
  const ordered = [...articles].sort(compare);
  const labeled = ordered.filter((article) => article.beforeHits.length > 0);
  let startIndex = 0;
  if (startAfter !== null) {
    const index = labeled.findIndex((article) => article.id === startAfter);
    if (index < 0) {
      fail(`id non trovato nell'elenco completo degli articoli con almeno un'etichetta italiana: ${startAfter}`);
    }
    startIndex = index + 1;
  }

  if (order === 'hits') {
    const candidates = ordered.filter((article) => article.substitutions.length > 0);
    return {
      candidates,
      selected: candidates.slice(0, Number.isFinite(limit) ? limit : undefined),
    };
  }

  const afterCursor = labeled.slice(startIndex);
  const candidates = afterCursor.filter((article) => article.substitutions.length > 0);
  const windowStart = offset;
  const windowEnd = Number.isFinite(limit) ? windowStart + limit : undefined;
  return {
    candidates,
    selected: afterCursor.slice(windowStart, windowEnd)
      .filter((article) => article.substitutions.length > 0),
  };
}

function formatResiduals(topUnmapped) {
  if (!topUnmapped.length) return 'nessuna';
  return topUnmapped.slice(0, 10).map(({ label, count }) => `${label} (${count})`).join('; ');
}

function printReport(report, logger) {
  const mode = report.apply ? 'APPLY' : 'DRY-RUN';
  logger(`${report.locale} — ${mode}`);
  logger(`  prima: articoli coinvolti ${report.before.articles}; etichette italiane ${report.before.italianLabels}`);
  logger(`  dopo:  articoli coinvolti ${report.after.articles}; etichette italiane ${report.after.italianLabels}; `
    + `sostituite ${report.after.substituted}; lasciate ${report.after.left}`);
  logger(`  lotto: ${report.selected}/${report.candidates} articoli${report.apply ? ` scritti ${report.written}` : ' da scrivere in apply'}`);
  logger(`  non mappate (top 10): ${formatResiduals(report.after.topUnmapped)}`);
}

export function runBackfill({
  root = ROOT,
  locales = LOCALES,
  apply = false,
  limit = Number.POSITIVE_INFINITY,
  offset = 0,
  offsetProvided = false,
  order = 'id',
  startAfter = null,
  writeFile = writeFileSnapshotAtomically,
  logger = console.log,
} = {}) {
  if (!Array.isArray(locales) || locales.length === 0) fail('serve almeno un locale');
  if (locales.some((locale) => !LOCALES.includes(locale))) fail(`locale non supportato: ${locales.join(', ')}`);
  if (!Number.isSafeInteger(offset) || offset < 0) fail(`offset non valido: ${offset}`);
  if (!(limit === Number.POSITIVE_INFINITY || (Number.isSafeInteger(limit) && limit >= 0))) {
    fail(`limit non valido: ${limit}`);
  }
  if (!ORDERS.includes(order)) fail(`ordine non supportato: ${order}; usare id o hits`);
  if (order === 'hits' && startAfter !== null) {
    fail('--order hits non puo\' usare --start-after: l\'ordine per hit non e\' stabile tra una run e l\'altra');
  }
  if (order === 'hits' && (offsetProvided || offset !== 0)) {
    fail('--order hits non puo\' usare --offset: l\'ordine per hit non e\' stabile tra una run e l\'altra');
  }
  if (typeof writeFile !== 'function') fail('writeFile non valido');

  const modifiedFiles = [];
  const reports = [];
  const plans = [];
  for (const locale of locales) {
    const articles = scanLocale(root, locale);
    const { candidates, selected } = selectArticles(articles, {
      limit,
      offset,
      offsetProvided,
      order,
      startAfter,
    });
    const { beforeHits, afterHits } = annotateHits(articles, selected);
    const substituted = selected.reduce((sum, article) => sum + article.substitutions.length, 0);
    const before = summarizeHits(beforeHits);
    const after = summarizeHits(afterHits);
    plans.push({
      after: {
        ...after,
        left: after.italianLabels,
        substituted,
      },
      before,
      candidates: candidates.length,
      locale,
      selected: selected.length,
      selectedArticles: selected,
    });
  }

  for (const plan of plans) {
    let written = 0;
    if (apply) {
      for (const article of plan.selectedArticles) {
        writeFile(article.filePath, article.source, article.afterSource);
        written += 1;
        modifiedFiles.push(article.relativePath);
      }
    }
    const report = {
      after: plan.after,
      apply,
      before: plan.before,
      candidates: plan.candidates,
      locale: plan.locale,
      selected: plan.selected,
      written,
    };
    reports.push(report);
    printReport(report, logger);
  }
  return { modifiedFiles, reports };
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(HELP);
    return 0;
  }
  runBackfill(options);
  return 0;
}

const invokedDirectly = (() => {
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1] || '');
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(error?.message || error);
    process.exitCode = 1;
  }
}
