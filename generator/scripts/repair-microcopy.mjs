#!/usr/bin/env node
/**
 * repair-microcopy.mjs — passa la guardia deterministica di
 * `lib/it-microcopy-guard.mjs` sul corpus GIA' PUBBLICATO.
 *
 * La guardia nuova impedisce ai difetti di nascere; questo script ripara quelli
 * gia' usciti. Sono due lavori diversi e vanno tenuti separati: il primo gira a
 * ogni articolo, questo gira una volta e poi resta come rete per un eventuale
 * arretrato (stessa forma di repair-mangled-chars.mjs).
 *
 * ## Le due superfici, che portano LO STESSO testo
 *
 *   · `content/blog-meta*.ts`  — title/excerpt per i 4 locali. Alimenta hub,
 *     RSS, card e la SPA.
 *   · `content/seo/seo-blog*.ts` — title/description/ogTitle/ogDescription piu'
 *     i gemelli JSON dentro `structuredData` (headline/description). Alimenta
 *     `<title>` e la meta description delle pagine shard.
 *
 * Ripararne una sola lascia il difetto visibile dall'altra: la stessa frase
 * sbagliata vive fino a 5 volte per articolo.
 *
 * ## Perche' opera sul testo ANCORA ESCAPATO
 *
 * I valori stanno in stringhe TS a virgoletta singola (`\'`) e in stringhe JSON
 * a virgoletta doppia (`\"`). Riscriverli richiederebbe un giro
 * unescape → fix → escape, e ogni giro del genere e' un'occasione di corrompere
 * byte che nessuno stava correggendo — ed e' esattamente il difetto che
 * `repair-mangled-chars.mjs` e' esistito per riparare.
 *
 * Le regole della guardia sostituiscono solo sequenze di LETTERE (articoli,
 * sostantivi, toponimi) o rimuovono un avverbio in testa: nessuna puo' attraversare
 * una barra rovesciata, che non e' una lettera. Lo script non si fida comunque
 * di questo argomento e lo VERIFICA su ogni campo prima di scrivere
 * (`assertEscapeSafe`): se `fix(raw)` e `fix(unescaped)` non descrivono la
 * stessa modifica, si ferma senza toccare niente.
 *
 * Uso:
 *   node generator/scripts/repair-microcopy.mjs --check   # elenca, non scrive
 *   node generator/scripts/repair-microcopy.mjs           # applica
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixMicrocopy } from './lib/it-microcopy-guard.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHECK_ONLY = process.argv.includes('--check');

/** Campi TS a virgoletta singola nei file seo, col tipo di campo per R4. */
const SEO_TS_FIELDS = {
  title: 'title', ogTitle: 'title', twitterTitle: 'title',
  description: 'excerpt', ogDescription: 'excerpt', twitterDescription: 'excerpt',
};
/** Gemelli JSON dentro `structuredData`. */
const SEO_JSON_FIELDS = { headline: 'title', description: 'excerpt' };

const unescapeTs = (s) => s.replace(/\\'/g, "'").replace(/\\\\/g, '\\');
const unescapeJson = (s) => s.replace(/\\"/g, '"').replace(/\\\\/g, '\\');

/**
 * Prova, campo per campo, che correggere il testo escapato equivale a
 * correggere il testo vero. Se non lo e', il campo va saltato e segnalato: e'
 * il solo modo in cui questo script puo' rompere qualcosa.
 */
function assertEscapeSafe(raw, fixedRaw, unescape, opts, problems, label) {
  const fromUnescaped = fixMicrocopy(unescape(raw), opts).value;
  if (unescape(fixedRaw) !== fromUnescaped) {
    problems.push(`${label}: fix su testo escapato != fix su testo reale\n    raw: ${raw.slice(0, 120)}`);
    return false;
  }
  return true;
}

const changes = [];
const problems = [];

function sweepFile(rel, patterns) {
  const abs = path.join(ROOT, rel);
  let src = fs.readFileSync(abs, 'utf-8');
  let fileChanges = 0;
  for (const { re, unescape, fieldOf, localeOf } of patterns) {
    src = src.replace(re, (match, pre, rawValue, post, ...rest) => {
      const offset = rest[rest.length - 2];
      const opts = { locale: localeOf(match), field: fieldOf(match) };
      const { value, fixes } = fixMicrocopy(rawValue, opts);
      if (!fixes.length) return match;
      if (!assertEscapeSafe(rawValue, value, unescape, opts, problems, `${rel}@${offset}`)) return match;
      fileChanges++;
      for (const f of fixes) changes.push({ rel, rule: f.rule, found: f.found, expected: f.expected, before: unescape(rawValue), after: unescape(value) });
      return `${pre}${value}${post}`;
    });
  }
  if (fileChanges && !CHECK_ONLY) fs.writeFileSync(abs, src);
  return fileChanges;
}

// ── content/blog-meta*.ts ──────────────────────────────────────────────────
const metaFiles = fs.readdirSync(path.join(ROOT, 'content')).filter((f) => /^blog-meta(-ch)?-(it|en|de|fr)\.ts$/.test(f));
if (metaFiles.length !== 8) {
  console.error(`✖ attesi 8 file blog-meta, trovati ${metaFiles.length} — checkout parziale?`);
  process.exit(1);
}
let touched = 0;
for (const f of metaFiles) {
  const locale = f.match(/-(it|en|de|fr)\.ts$/)[1];
  touched += sweepFile(path.join('content', f), [{
    re: /('blog\.article\.[^.']+\.(?:title|excerpt)'\s*:\s*')((?:\\'|[^'])*)(')/g,
    unescape: unescapeTs,
    fieldOf: (m) => (m.includes(".title'") ? 'title' : 'excerpt'),
    localeOf: () => locale,
  }]);
}

// ── content/seo/seo-blog*.ts (italiano) ────────────────────────────────────
const seoDir = path.join(ROOT, 'content', 'seo');
for (const f of fs.readdirSync(seoDir).filter((x) => /^seo-blog.*\.ts$/.test(x))) {
  touched += sweepFile(path.join('content', 'seo', f), [
    {
      re: new RegExp(`(\\n\\s*(?:${Object.keys(SEO_TS_FIELDS).join('|')}):\\s*')((?:\\\\'|[^'])*)(')`, 'g'),
      unescape: unescapeTs,
      fieldOf: (m) => SEO_TS_FIELDS[m.match(/\n\s*(\w+):/)[1]],
      localeOf: () => 'it',
    },
    {
      re: new RegExp(`("(?:${Object.keys(SEO_JSON_FIELDS).join('|')})":\\s*")((?:\\\\"|[^"])*)(")`, 'g'),
      unescape: unescapeJson,
      fieldOf: (m) => SEO_JSON_FIELDS[m.match(/"(\w+)":/)[1]],
      localeOf: () => 'it',
    },
  ]);
}

// ── Esito ─────────────────────────────────────────────────────────────────
const byRule = {};
for (const c of changes) (byRule[c.rule] ||= []).push(c);
console.log(`${CHECK_ONLY ? '🔍 [check]' : '✅'} campi corretti: ${touched} (${changes.length} sostituzioni)`);
for (const [rule, list] of Object.entries(byRule)) {
  console.log(`\n  ${rule}: ${list.length}`);
  const counts = {};
  for (const c of list) counts[`"${c.found}" → "${c.expected}"`] = (counts[`"${c.found}" → "${c.expected}"`] || 0) + 1;
  for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) console.log(`     ${String(v).padStart(3)}  ${k}`);
}
if (problems.length) {
  console.error(`\n✖ ${problems.length} campi SALTATI (escape non round-trippabile):`);
  for (const p of problems) console.error(`   ${p}`);
  process.exit(1);
}
