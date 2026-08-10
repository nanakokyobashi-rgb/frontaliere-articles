#!/usr/bin/env node
/**
 * repair-prompt-placeholders.mjs — passa il guard dei segnaposto sul corpus
 * GIA' PUBBLICATO.
 *
 * `lib/prompt-placeholder-guard.mjs` impedisce ai segnaposto di nascere; questo
 * script ripara quelli gia' usciti. Sono due lavori diversi e vanno tenuti
 * separati — stessa forma di `repair-microcopy.mjs` e `repair-mangled-chars.mjs`:
 * il guard gira a ogni articolo, questo gira una volta e resta come rete per un
 * eventuale arretrato.
 *
 * ## Le TRE superfici, che portano LO STESSO testo
 *
 *   · `content/blog-meta*.ts`     — title/excerpt/imageAlt per i 4 locali.
 *   · `content/blog-body[-ch]/<locale>/<id>.ts`  — body1..N e il campo `faq`.
 *   · `content/seo/seo-blog*.ts`  — description/ogDescription piu' i gemelli
 *     JSON dentro `structuredData` (`caption` e' il gemello di `imageAlt.it`,
 *     `description` quello dell'excerpt).
 *
 * Ripararne una sola lascia il difetto visibile dall'altra: lo stesso
 * `Max 125 caratteri` vive nel meta di 4 locali E nella `caption` del JSON-LD.
 *
 * ## Perche' qui si fa il round-trip, e repair-microcopy.mjs no
 *
 * `repair-microcopy.mjs` opera sul testo ANCORA ESCAPATO, e argomenta bene
 * perche': le sue regole sostituiscono sequenze di LETTERE, che non possono
 * attraversare una barra rovesciata. Le riparazioni di QUESTO script non hanno
 * quella proprieta' — troncano il campo e riscrivono un array JSON — e un
 * troncamento su testo escapato puo' cadere in mezzo a `\'` e produrre un file
 * che non compila.
 *
 * Quindi qui si fa unescape → riparazione → escape, con la stessa disciplina
 * («provalo prima di scrivere») applicata all'operazione giusta: per ogni campo
 * si verifica che `escape(unescape(raw)) === raw` PRIMA di toccarlo
 * (`assertRoundTrip`). Se il round-trip non e' esatto il campo viene saltato e
 * segnalato, senza scrivere niente.
 *
 * ## Cosa NON ripara, e perche'
 *
 * `ristorni-frontalieri-…` (it + en) ha in body1 il preambolo del prompt
 * preceduto da 1.961 caratteri di pagina di origine scrapata (boilerplate
 * VareseNews + la lista dei commenti). Il taglio al marcatore toglie il
 * preambolo — cio' che questo guard sa identificare — e LASCIA il boilerplate,
 * che e' un difetto di un'altra classe (eco della fonte) con un altro rilevatore.
 * Lo script lo dice invece di far finta di aver finito: vedi il riepilogo
 * `⚠ RESIDUI` in coda.
 *
 * Uso:
 *   node generator/scripts/repair-prompt-placeholders.mjs --check   # elenca, non scrive
 *   node generator/scripts/repair-prompt-placeholders.mjs           # applica
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { truncateToClause } from '../../host/shared/clauseTail.mjs';
import {
  findPromptPlaceholders,
  stripFaqNumberedLabels,
  stripSchemaHeadingLine,
  truncateAtPromptScaffold,
  cleanFaqPairs,
} from './lib/prompt-placeholder-guard.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHECK_ONLY = process.argv.includes('--check');

const LOCALES = ['it', 'en', 'de', 'fr'];
const EXCERPT_MAX = 160;

// ─────────────────────────────────────────────────────────────────────────────
// Escape / unescape, e la prova che il round-trip e' esatto
// ─────────────────────────────────────────────────────────────────────────────

/** L'inverso ESATTO di `escapeForSingleQuoteTS` (article-meta-block.mjs). */
const unescapeTs = (s) => s.replace(/\\(.)/gs, (_, c) => (c === 'n' ? '\n' : c === 'r' ? '\r' : c));
const escapeTs = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '');
/** Gemelli per le stringhe JSON dentro `structuredData`. */
const unescapeJson = (s) => JSON.parse(`"${s}"`);
const escapeJson = (s) => JSON.stringify(String(s)).slice(1, -1);

const problems = [];

/**
 * Un campo si tocca solo se ri-escapando cio' che si e' letto si riottiene
 * BYTE PER BYTE cio' che c'era. E' il solo modo in cui questo script puo'
 * rompere qualcosa che nessuno gli aveva chiesto di correggere.
 */
function assertRoundTrip(raw, unescape, escape, label) {
  try {
    if (escape(unescape(raw)) !== raw) {
      problems.push(`${label}: round-trip non esatto — campo SALTATO`);
      return false;
    }
  } catch (err) {
    problems.push(`${label}: unescape fallito (${err.message}) — campo SALTATO`);
    return false;
  }
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Inventario: titoli e body1 per locale, che servono a ricostruire i campi persi
// ─────────────────────────────────────────────────────────────────────────────

const metaFiles = fs.readdirSync(path.join(ROOT, 'content')).filter((f) => /^blog-meta(-ch)?-(it|en|de|fr)\.ts$/.test(f));
if (metaFiles.length !== 8) {
  console.error(`✖ attesi 8 file blog-meta, trovati ${metaFiles.length} — checkout parziale?`);
  process.exit(1);
}

/** `titles[locale][id] = titolo` — la base della ricetta di imageAlt. */
const titles = Object.fromEntries(LOCALES.map((l) => [l, new Map()]));
for (const f of metaFiles) {
  const locale = f.match(/-(it|en|de|fr)\.ts$/)[1];
  const src = fs.readFileSync(path.join(ROOT, 'content', f), 'utf-8');
  const re = /'blog\.article\.([^.']+)\.title'\s*:\s*'((?:\\'|[^'])*)'/g;
  let m;
  while ((m = re.exec(src)) !== null) titles[locale].set(m[1], unescapeTs(m[2]));
}

function bodyFileFor(id, locale) {
  for (const dir of ['blog-body', 'blog-body-ch']) {
    const p = path.join(ROOT, 'content', dir, locale, `${id}.ts`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** Il body1 di un articolo, gia' ripulito, o `''` se non c'e' o e' contaminato. */
function cleanBody1(id, locale) {
  const p = bodyFileFor(id, locale);
  if (!p) return '';
  const src = fs.readFileSync(p, 'utf-8');
  const m = new RegExp(`'blog\\.article\\.${id.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\.body1'\\s*:\\s*'((?:[^'\\\\]|\\\\.)*)'`).exec(src);
  if (!m) return '';
  const text = unescapeTs(m[1]);
  return findPromptPlaceholders(text).length ? '' : text;
}

/**
 * Prosa dal body1: via le intestazioni e le tabelle, e via i MARCATORI dei
 * bullet — non le righe.
 *
 * Scartare le righe puntate sembrava piu' pulito e su `trasferirsi-a-marchirolo-…`
 * non lasciava niente: quel body1 e' fatto SOLO di `##`, `-` e `+`, e l'excerpt
 * ricostruito sarebbe stato vuoto. Il testo di un bullet e' prosa a tutti gli
 * effetti una volta tolto il trattino.
 */
function proseFromBody(body) {
  return body
    .split('\n')
    .filter((l) => !/^\s*(#{1,6}\s|\|)/.test(l))
    .map((l) => l.replace(/^\s*(?:[-*+>]|\d+\.)\s+/, ''))
    .filter((l) => !/^\s*\*{0,2}[^:]{0,20}\*{0,2}:\s*$/.test(l)) // etichette nude tipo «**Pro**:»
    .join(' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const IMAGE_ALT_FALLBACK = {
  it: (t) => `Immagine editoriale relativa a: ${t}`,
  en: (t) => `Editorial image related to: ${t}`,
  de: (t) => `Redaktionelles Bild zu: ${t}`,
  fr: (t) => `Image éditoriale relative à: ${t}`,
};

/**
 * ── LE DUE RICOSTRUZIONI, e perche' non sono una sola ────────────────────
 *
 * `imageAlt` → dal TITOLO. E' la ricetta che `validate()` usa gia' quando il
 * campo manca del tutto (create-article.mjs): un alt segnaposto e' equivalente
 * a un alt assente, e usare la stessa ricetta tiene una verita' sola.
 * Quando il segnaposto e' incollato a un alt VERO («Vista di Lugano dal lago.
 * Max 125 chars») si toglie solo la coda: buttare l'alt vero sarebbe una
 * perdita gratuita.
 *
 * `excerpt` → dal BODY1 della stessa locale, troncato con `truncateToClause`
 * (lo stesso troncatore del render). E' il fallback che `generateExcerpt()`
 * dichiara per se' quando la chiamata LLM fallisce, quindi non e' una regola
 * nuova: e' quella esistente applicata all'indietro. Se il body1 di quella
 * locale porta a sua volta un segnaposto la ricostruzione NON si fa — sarebbe
 * propagare il leak — e il campo finisce nei residui.
 */
function rebuildImageAlt(value, { locale, id }) {
  const stripped = value
    .replace(/\s*\(?\s*(?:max|max\.|massimo|maximum|maximal)\s+\d{2,4}\s*(?:chars?|characters?|caratteri|carattere|caractères|caracteres|Zeichen)\s*\)?\s*[.]?\s*$/i, '')
    .replace(/[\s.;,:—–-]+$/, '')
    .trim();
  if (stripped.length >= 12 && !findPromptPlaceholders(stripped).length) return { value: stripped, how: 'coda-tolta' };
  const title = titles[locale]?.get(id) || titles.it.get(id) || '';
  if (!title) return null;
  return { value: (IMAGE_ALT_FALLBACK[locale] || IMAGE_ALT_FALLBACK.it)(title), how: 'dal-titolo' };
}

/**
 * Frasi INTERE finche' ci stanno, e solo come ultima risorsa un taglio.
 *
 * `truncateToClause` da sola pela la coda penzolante ma non sa dove finisce una
 * frase, e sul primo giro ha prodotto «…con il credito d'imposta (quadro CE» —
 * una parentesi aperta e mai chiusa dentro la meta description. Un excerpt
 * ricostruito finisce in SERP: se non e' una frase compiuta il difetto e'
 * cambiato di forma, non sparito.
 */
function rebuildExcerpt(id, locale) {
  const body = cleanBody1(id, locale) || cleanBody1(id, 'it');
  const prose = proseFromBody(body);
  if (prose.length < 60) return null;

  const frasi = prose.match(/[^.!?]+[.!?]+(?:\s|$)/g) || [];
  let out = '';
  for (const frase of frasi) {
    // Con `out + frase` la spaziatura sparisce: il match si porta dietro lo
    // spazio finale, che il trim del giro precedente ha gia' tolto
    // («…double taxation.Italy avoids…», osservato su en e fr).
    const next = out ? `${out} ${frase.trim()}` : frase.trim();
    if (next.length > EXCERPT_MAX) break;
    out = next;
  }
  if (out.length >= 60) return { value: out, how: 'dal-body1' };
  return { value: truncateToClause(prose, EXCERPT_MAX), how: 'dal-body1 (troncato)' };
}

// ─────────────────────────────────────────────────────────────────────────────
// Il motore: un campo alla volta, con la sua riparazione
// ─────────────────────────────────────────────────────────────────────────────

const changes = [];
const residuals = [];

/**
 * @param {string} rel percorso relativo del file
 * @param {RegExp} re  regex con 3 gruppi: (prefisso)(valore escapato)(suffisso)
 * @param {(ctx) => ({value: string, how: string}|null)} repair
 */
function sweep(rel, re, { unescape, escape, contextOf, repair }) {
  const abs = path.join(ROOT, rel);
  let src = fs.readFileSync(abs, 'utf-8');
  let touched = 0;
  src = src.replace(re, (match, pre, raw, post, ...rest) => {
    const offset = rest[rest.length - 2];
    let value;
    try {
      value = unescape(raw);
    } catch {
      return match;
    }
    if (!findPromptPlaceholders(value).length) return match;
    const label = `${rel}@${offset}`;
    if (!assertRoundTrip(raw, unescape, escape, label)) return match;
    const ctx = contextOf(match, value);
    const fixed = repair({ ...ctx, value, label });
    if (!fixed) {
      residuals.push({ label, ...ctx, value: value.slice(0, 120), reason: 'nessuna ricostruzione deterministica' });
      return match;
    }
    const left = findPromptPlaceholders(fixed.value);
    if (left.length) {
      residuals.push({ label, ...ctx, value: fixed.value.slice(0, 120), reason: `residuo dopo riparazione: ${left.map((h) => h.rule).join(',')}` });
      return match;
    }
    touched += 1;
    changes.push({ rel, ...ctx, how: fixed.how, before: value.slice(0, 100), after: String(fixed.value).slice(0, 100) });
    return `${pre}${escape(fixed.value)}${post}`;
  });
  if (touched && !CHECK_ONLY) fs.writeFileSync(abs, src);
  return touched;
}

let total = 0;

// ── 1. content/blog-meta*.ts ────────────────────────────────────────────────
for (const f of metaFiles) {
  const locale = f.match(/-(it|en|de|fr)\.ts$/)[1];
  total += sweep(path.join('content', f), /('blog\.article\.(?:[^.']+)\.(?:title|excerpt|imageAlt)'\s*:\s*')((?:\\'|[^'])*)(')/g, {
    unescape: unescapeTs,
    escape: escapeTs,
    contextOf: (match) => {
      const m = /'blog\.article\.([^.']+)\.(title|excerpt|imageAlt)'/.exec(match);
      return { id: m[1], field: m[2], locale };
    },
    repair: ({ id, field, value }) => {
      if (field === 'imageAlt') return rebuildImageAlt(value, { locale, id });
      if (field === 'excerpt') return rebuildExcerpt(id, locale);
      return null; // un TITLE segnaposto non si ricostruisce: va rigenerato
    },
  });
}

// ── 2. content/blog-body**/<locale>/<id>.ts ─────────────────────────────────────────────
function walkBodies(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkBodies(p, out);
    else if (e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

for (const abs of [...walkBodies(path.join(ROOT, 'content', 'blog-body')), ...walkBodies(path.join(ROOT, 'content', 'blog-body-ch'))]) {
  const rel = path.relative(ROOT, abs);
  const locale = path.basename(path.dirname(abs));
  total += sweep(rel, /('blog\.article\.(?:[^']+)\.(?:body\d+|faq)'\s*:\s*')((?:[^'\\]|\\.)*)(')/g, {
    unescape: unescapeTs,
    escape: escapeTs,
    contextOf: (match) => {
      const m = /'blog\.article\.([^']+)\.(body\d+|faq)'/.exec(match);
      return { id: m[1], field: m[2], locale };
    },
    repair: ({ field, value }) => {
      if (field === 'faq') {
        let pairs;
        try {
          pairs = JSON.parse(value);
        } catch {
          return null;
        }
        // `dropShort: false`: la bonifica toglie i segnaposto e NON le coppie corte —
        // 30 file de/en/fr ne hanno, e sono un difetto di un altra classe.
        const { pairs: kept, repaired, dropped } = cleanFaqPairs(pairs, { dropShort: false });
        if (!dropped.length && !repaired) return null;
        // Sotto le 2 coppie il campo va tolto: e' la soglia di
        // ogPagesPlugin.ts:1328. `__DROP__` lo segnala al post-processo sotto.
        if (!kept) return { value: '__DROP_FAQ__', how: `faq-rimossa (${dropped.length} coppie segnaposto)` };
        return { value: JSON.stringify(kept), how: `faq-potata (${repaired} riparate, ${dropped.length} scartate)` };
      }
      let out = stripFaqNumberedLabels(value).value;
      out = stripSchemaHeadingLine(out).value;
      const cut = truncateAtPromptScaffold(out);
      out = cut.value;
      if (out === value) return null;
      if (out.trim().length < 200) return null; // un body ridotto a un moncone non e' una riparazione
      return { value: out, how: cut.removed ? `troncato al preambolo (-${cut.removed} char)` : 'etichette dello schema rimosse' };
    },
  });
}

// Le FAQ marcate `__DROP_FAQ__` vanno rimosse come RIGA, non svuotate: una
// chiave `faq` con un array vuoto verrebbe letta da ogPagesPlugin come FAQ
// presente e malformata.
if (!CHECK_ONLY) {
  for (const abs of [...walkBodies(path.join(ROOT, 'content', 'blog-body')), ...walkBodies(path.join(ROOT, 'content', 'blog-body-ch'))]) {
    let src = fs.readFileSync(abs, 'utf-8');
    if (!src.includes('__DROP_FAQ__')) continue;
    src = src.replace(/\n[ \t]*'blog\.article\.[^']+\.faq'\s*:\s*'__DROP_FAQ__',?/g, '');
    fs.writeFileSync(abs, src);
  }
}

// ── 3. content/seo/seo-blog*.ts ─────────────────────────────────────────────
const SEO_TS_FIELDS = ['title', 'description', 'ogTitle', 'ogDescription', 'twitterTitle', 'twitterDescription'];
const SEO_JSON_FIELDS = ['headline', 'description', 'caption'];
const seoDir = path.join(ROOT, 'content', 'seo');

/** L'id dell'articolo a cui appartiene un offset dentro un file seo. */
function seoIdAt(src, offset) {
  const before = src.slice(0, offset);
  const keys = [...before.matchAll(/\n\s*'blog-([^']+)'\s*:\s*\{/g)];
  return keys.length ? keys[keys.length - 1][1] : '';
}

for (const f of fs.readdirSync(seoDir).filter((x) => /^seo-blog.*\.ts$/.test(x))) {
  const rel = path.join('content', 'seo', f);
  const whole = fs.readFileSync(path.join(ROOT, rel), 'utf-8');
  total += sweep(rel, new RegExp(`(\\n\\s*(?:${SEO_TS_FIELDS.join('|')}):\\s*')((?:\\\\'|[^'])*)(')`, 'g'), {
    unescape: unescapeTs,
    escape: escapeTs,
    contextOf: (match) => ({ id: '', field: /\n\s*(\w+):/.exec(match)[1], locale: 'it' }),
    repair: ({ value, label }) => {
      const id = seoIdAt(whole, Number(label.split('@')[1]));
      return id ? rebuildExcerpt(id, 'it') : null;
    },
  });
  total += sweep(rel, new RegExp(`("(?:${SEO_JSON_FIELDS.join('|')})":\\s*")((?:\\\\"|[^"])*)(")`, 'g'), {
    unescape: unescapeJson,
    escape: escapeJson,
    contextOf: (match) => ({ id: '', field: `sd.${/"(\w+)":/.exec(match)[1]}`, locale: 'it' }),
    repair: ({ field, value, label }) => {
      const id = seoIdAt(whole, Number(label.split('@')[1]));
      if (!id) return null;
      if (field === 'sd.caption') return rebuildImageAlt(value, { locale: 'it', id });
      return rebuildExcerpt(id, 'it');
    },
  });
}

// ── Esito ───────────────────────────────────────────────────────────────────
const byHow = {};
for (const c of changes) (byHow[c.how.replace(/\s*\(.*\)$/, '')] ||= []).push(c);
console.log(`${CHECK_ONLY ? '🔍 [check]' : '✅'} campi riparati: ${total}`);
for (const [how, list] of Object.entries(byHow).sort((a, b) => b[1].length - a[1].length)) {
  console.log(`\n  ${how}: ${list.length}`);
  for (const c of list.slice(0, 8)) console.log(`     ${c.rel.replace('content/', '')} [${c.field}] ${JSON.stringify(c.before.slice(0, 55))} → ${JSON.stringify(c.after.slice(0, 55))}`);
  if (list.length > 8) console.log(`     … e altri ${list.length - 8}`);
}
const affected = new Set(changes.map((c) => c.id).filter(Boolean));
console.log(`\nArticoli toccati: ${affected.size}`);

if (residuals.length) {
  console.log(`\n⚠ RESIDUI — ${residuals.length} campi che questo script NON ha riparato:`);
  for (const r of residuals) console.log(`   ${r.label} [${r.field}] ${r.reason}\n      ${JSON.stringify(r.value)}`);
}
if (problems.length) {
  console.error(`\n✖ ${problems.length} campi SALTATI (escape non round-trippabile):`);
  for (const p of problems) console.error(`   ${p}`);
  process.exit(1);
}
