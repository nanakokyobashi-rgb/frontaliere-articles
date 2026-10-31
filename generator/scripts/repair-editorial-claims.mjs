#!/usr/bin/env node
/**
 * repair-editorial-claims.mjs — porta sul corpus gia' pubblicato le correzioni
 * deterministiche di `engine/shared/editorialClaims.mjs`.
 *
 * Il modulo dell'engine decide COSA e' sbagliato e come si riscrive; questo
 * script fa solo l'I/O sulle tre superfici che portano lo stesso testo:
 *
 *   · `content/blog-body[-ch]/<locale>/<id>.ts`  — body1..N e `faq`;
 *   · `content/blog-meta[-ch]-<locale>.ts`       — title, excerpt, imageAlt;
 *   · `content/seo/seo-blog*.ts`                 — description e gemelli JSON.
 *
 * Ogni campo passa da unescape → riparazione → escape, e si tocca solo se
 * `escape(unescape(raw)) === raw`: un literal con una forma diversa viene
 * elencato in `skipped` senza scrivere niente. Gli articoli cambiati ricevono
 * `updatedAt` nel registro, come ogni correzione fattuale del corpus.
 *
 * Uso:
 *   node generator/scripts/repair-editorial-claims.mjs --check [--json <path>]
 *   node generator/scripts/repair-editorial-claims.mjs [--updated-at YYYY-MM-DD] [--json <path>]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readTsStringLiteral } from './lib/ts-string-map.mjs';
import { escapeForSingleQuoteTS } from './lib/article-meta-block.mjs';
import { CLAIM_LOCALES, repairEditorialClaims } from '../../engine/shared/editorialClaims.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CONTENT = path.join(ROOT, 'content');
const argValue = (flag) => {
  const index = process.argv.indexOf(flag);
  return index === -1 ? null : process.argv[index + 1];
};
const check = process.argv.includes('--check');
const updatedAt = argValue('--updated-at') ?? new Date().toISOString().slice(0, 10);
const jsonOut = argValue('--json');

const FIELD_KEY = /(['"])blog\.article\.([^'"]+?)\.(title|excerpt|imageAlt|body\d*|faq)\1\s*:\s*/g;
const report = { changed: [], skipped: [], counts: {} };
const touched = new Set();

function record(surface, id, locale, field, changes) {
  for (const change of changes) {
    const key = `${locale}:${change.class}`;
    report.counts[key] = (report.counts[key] ?? 0) + 1;
  }
  report.changed.push({ surface, id, locale, field, changes });
  touched.add(id);
}

function repairStringFields(file, locale, surface) {
  const source = fs.readFileSync(file, 'utf8');
  let out = '';
  let cursor = 0;
  FIELD_KEY.lastIndex = 0;
  for (let match = FIELD_KEY.exec(source); match; match = FIELD_KEY.exec(source)) {
    const start = match.index + match[0].length;
    const literal = readTsStringLiteral(source, start);
    if (!literal) continue;
    const repaired = repairEditorialClaims(literal.value, { locale });
    if (repaired.changes.length === 0) continue;
    const [, , id, field] = match;
    const raw = source.slice(start + 1, literal.end - 1);
    if (source[start] !== "'" || escapeForSingleQuoteTS(literal.value) !== raw) {
      report.skipped.push({ surface, id, locale, field, reason: 'literal-non-round-trip' });
      continue;
    }
    out += `${source.slice(cursor, start + 1)}${escapeForSingleQuoteTS(repaired.value)}`;
    cursor = literal.end - 1;
    record(surface, id, locale, field, repaired.changes);
  }
  if (cursor > 0 && !check) fs.writeFileSync(file, out + source.slice(cursor));
}

function repairSeoFile(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  let changed = false;
  lines.forEach((line, index) => {
    const match = line.match(/^(\s*"?(?:description|ogDescription|caption|headline|text)"?\s*:\s*)(['"])(.*)\2(,?\s*)$/);
    if (!match) return;
    const [, head, quote, raw, tail] = match;
    const value = quote === "'" ? raw.replace(/\\'/g, "'") : raw;
    for (const locale of CLAIM_LOCALES) {
      const repaired = repairEditorialClaims(value, { locale });
      if (repaired.changes.length === 0) continue;
      const next = quote === "'" ? repaired.value.replace(/'/g, "\\'") : repaired.value;
      lines[index] = `${head}${quote}${next}${quote}${tail}`;
      changed = true;
      record('seo', path.basename(file), locale, head.trim(), repaired.changes);
      break;
    }
  });
  if (changed && !check) fs.writeFileSync(file, lines.join('\n'));
}

function touchRegistry(file) {
  const source = fs.readFileSync(file, 'utf8');
  const lines = source.split('\n');
  const out = [];
  let inTouched = false;
  let dateIndex = -1;
  let wrote = false;
  for (const line of lines) {
    const id = line.match(/^\s*id:\s*'([^']+)',\s*$/);
    if (id) {
      inTouched = touched.has(id[1]);
      dateIndex = -1;
    }
    if (inTouched && /^\s*date:\s*'/.test(line)) dateIndex = out.length;
    if (inTouched && /^\s*updatedAt:\s*'/.test(line)) {
      out.push(line.replace(/'[^']*'/, `'${updatedAt}'`));
      inTouched = false;
      wrote = true;
      continue;
    }
    out.push(line);
    if (inTouched && dateIndex !== -1 && /^\s*(?:image|hasCalculator):/.test(line)) {
      const indent = out[dateIndex].match(/^\s*/)[0];
      out.splice(dateIndex + 1, 0, `${indent}updatedAt: '${updatedAt}',`);
      inTouched = false;
      wrote = true;
    }
  }
  if (wrote && !check) fs.writeFileSync(file, out.join('\n'));
}

for (const section of ['blog-body', 'blog-body-ch']) {
  for (const locale of CLAIM_LOCALES) {
    const dir = path.join(CONTENT, section, locale);
    for (const name of fs.readdirSync(dir)) {
      if (name.endsWith('.ts')) repairStringFields(path.join(dir, name), locale, section);
    }
  }
}
for (const locale of CLAIM_LOCALES) {
  repairStringFields(path.join(CONTENT, `blog-meta-${locale}.ts`), locale, 'meta');
  repairStringFields(path.join(CONTENT, `blog-meta-ch-${locale}.ts`), locale, 'meta-ch');
}
for (const name of fs.readdirSync(path.join(CONTENT, 'seo'))) {
  if (name.startsWith('seo-blog')) repairSeoFile(path.join(CONTENT, 'seo', name));
}
touchRegistry(path.join(CONTENT, 'blog-articles-data.ts'));
touchRegistry(path.join(CONTENT, 'swiss-articles-data.ts'));

const summary = {
  fields: report.changed.length,
  articles: touched.size,
  skipped: report.skipped.length,
  counts: report.counts,
};
console.log(JSON.stringify(summary, null, 2));
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(report, null, 2));
