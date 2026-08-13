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
  orphanFaqLocales,
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
//
// ── FAULT ISOLATION, NON TRANSAZIONALITA' (issue #245 item 1) ────────────────
//
// Il rimedio ovvio — rendere questo passo transazionale e fare rollback se un
// file lancia — e' impossibile e sarebbe DANNOSO. Impossibile perche' il passo
// 2 ha gia' scritto su disco (`sweep()`, `fs.writeFileSync`) molto prima di
// arrivare qui, quindi non c'e' nessuno stato pulito a cui tornare. Dannoso
// perche' il rollback del solo post-processo lascerebbe il sentinella LETTERALE
// — `'blog.article.X.faq': '__DROP_FAQ__'` — dentro un corpo pubblicato, cioe'
// un difetto piu' grave della FAQ orfana che stava riparando: quel valore
// arriva al render come testo della FAQ.
//
// La proprieta' che serve davvero c'e' gia' per costruzione: il passo e'
// IDEMPOTENTE. La worklist non e' tenuta in memoria, e' ri-derivata dal disco a
// ogni esecuzione (`walkBodies` + `src.includes('__DROP_FAQ__')`), quindi
// rilanciare lo script dopo un errore riprende esattamente da dove si era
// fermato senza toccare cio' che aveva gia' finito.
//
// Quello che mancava e' che un solo file imprevisto (permessi, encoding, file
// sparito sotto i piedi fra la `readdirSync` e la `readFileSync`) faceva morire
// il loop e lasciava TUTTI i file successivi col sentinella dentro. Ora l'errore
// e' confinato al file che lo produce: si accumula in `problems` — che fa
// uscire lo script non-zero in coda — e gli altri file vengono comunque puliti.
if (!CHECK_ONLY) {
  for (const abs of [...walkBodies(path.join(ROOT, 'content', 'blog-body')), ...walkBodies(path.join(ROOT, 'content', 'blog-body-ch'))]) {
    try {
      let src = fs.readFileSync(abs, 'utf-8');
      if (!src.includes('__DROP_FAQ__')) continue;
      src = src.replace(/\n[ \t]*'blog\.article\.[^']+\.faq'\s*:\s*'__DROP_FAQ__',?/g, '');
      fs.writeFileSync(abs, src);
    } catch (err) {
      problems.push(`${path.relative(ROOT, abs)}: rimozione della riga __DROP_FAQ__ fallita (${err.message}) — FILE SALTATO`);
    }
  }
}

// ── 2b. Le FAQ ORFANE nelle traduzioni ──────────────────────────────────────
//
// Il passo 2 vede un segnaposto solo dove i letterali dello schema — che sono
// ITALIANI — compaiono nel testo. La FAQ di en/de/fr non e' generata: e'
// TRADOTTA da quella di `it` (`translateArticle()`), quindi lo stesso
// segnaposto vi arriva gia' voltato in un'altra lingua e nessuna regola di
// `findPromptPlaceholders` lo tocca. Il passo 2 toglieva percio' la chiave da
// `it` e lasciava le tre traduzioni al loro posto.
//
// MISURATO: la bonifica di #196 ha fatto esattamente questo su 19 articoli, e
// le **57 chiavi** rimaste (19 × en/de/fr) sono l'unico test rosso del job
// `tests` del sito — `tests/i18n-completeness.test.ts`, «consistent keys across
// all locales» — che tenendo `main` rosso teneva ferme tutte le PR aperte,
// perche' `pr-review-loop` parte solo su `tests` verde.
//
// Questo passo va DOPO la rimozione delle righe `__DROP_FAQ__`: una faq `it`
// tolta in questo stesso giro crea orfani qui. In `--check` quella rimozione
// non e' avvenuta, quindi `faqStateOf()` conta `__DROP_FAQ__` come assenza.
//
// Il criterio e' in `orphanFaqLocales()`, ed e' strutturale invece che
// testuale di proposito: vedi l'intestazione della funzione.
//
// `g` e' obbligatorio su entrambe le regex sotto: senza, sia la lettura di
// stato sia la rimozione si fermano al PRIMO match. Una seconda chiave `.faq`
// nello stesso file — residuo plausibile di un merge, mai osservato nel
// corpus attuale ma non escluso da uno futuro — resterebbe cosi' invisibile a
// `faqStateOf()` e sopravviverebbe alla rimozione: e' pubblicata come
// FAQPage JSON-LD, quindi orfana e live.
const FAQ_LINE_RE = /\n[ \t]*'blog\.article\.[^']+\.faq'\s*:\s*'((?:[^'\\]|\\.)*)',?/g;

function faqStateOf(abs) {
  if (!fs.existsSync(abs)) return { hasFile: false, hasFaq: false };
  const src = fs.readFileSync(abs, 'utf-8');
  const re = /'blog\.article\.[^']+\.faq'\s*:\s*'((?:[^'\\]|\\.)*)'/g;
  let hasFaq = false;
  let m;
  // Basta UNA occorrenza con contenuto vero: e' la stessa soglia con cui
  // il passo 2b decide se una locale ha ancora una FAQ da orfanare.
  while ((m = re.exec(src)) !== null) {
    if (m[1] !== '__DROP_FAQ__') { hasFaq = true; break; }
  }
  return { hasFile: true, hasFaq };
}

// Stessa fault isolation del post-processo `__DROP_FAQ__` sopra, e per la
// stessa ragione: e' questo il loop che #245 item 1 nomina per esteso. Un
// singolo articolo che lancia — `faqStateOf()` legge quattro file per articolo,
// e uno di quei quattro puo' sparire, essere illeggibile o non decodificare —
// fermava il passo a meta', lasciando orfane tutte le traduzioni degli articoli
// non ancora visitati. Il confinamento e' PER ARTICOLO: e' l'unita' su cui il
// passo decide (`byLocale` mette in relazione i quattro locali fra loro), quindi
// e' anche la piu' piccola unita' che si possa saltare senza produrre uno stato
// a meta' fra un locale e l'altro.
for (const dir of ['blog-body', 'blog-body-ch']) {
  const itDir = path.join(ROOT, 'content', dir, 'it');
  if (!fs.existsSync(itDir)) continue;
  for (const name of fs.readdirSync(itDir)) {
    if (!name.endsWith('.ts')) continue;
    const id = name.slice(0, -3);
    try {
      const byLocale = Object.fromEntries(
        LOCALES.map((l) => [l, faqStateOf(path.join(ROOT, 'content', dir, l, name))]),
      );
      for (const locale of orphanFaqLocales(byLocale)) {
        const rel = path.join('content', dir, locale, name);
        const abs = path.join(ROOT, rel);
        const src = fs.readFileSync(abs, 'utf-8');
        // `g` su FAQ_LINE_RE fa si' che `replace` tolga OGNI occorrenza, non
        // solo la prima: un file con due chiavi `.faq` (residuo di merge) le
        // perde entrambe invece di lasciarne una orfana e live.
        const dropped = [];
        const next = src.replace(FAQ_LINE_RE, (_m, raw) => {
          dropped.push(raw);
          return '';
        });
        if (next === src) {
          residuals.push({ label: rel, id, field: 'faq', locale, value: '', reason: 'chiave faq presente ma non isolabile come riga' });
          continue;
        }
        if (!CHECK_ONLY) fs.writeFileSync(abs, next);
        total += dropped.length;
        const how = dropped.length > 1 ? `faq-orfana rimossa (assente in it, ${dropped.length}×)` : 'faq-orfana rimossa (assente in it)';
        changes.push({ rel, id, field: 'faq', locale, how, before: dropped[0], after: '(chiave rimossa)' });
      }
    } catch (err) {
      problems.push(`${path.join('content', dir, '*', name)}: potatura delle faq orfane fallita (${err.message}) — ARTICOLO SALTATO`);
    }
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

// ── SENTINELLA: nessun `__DROP_FAQ__` puo' sopravvivere su disco ─────────────
//
// La meta' che rende utile la fault isolation sopra. Confinare l'errore al
// singolo file evita che un imprevisto fermi la bonifica, ma da solo trasforma
// un crash rumoroso in un'uscita SILENZIOSA con il sentinella ancora dentro un
// corpo — e `__DROP_FAQ__` non e' testo neutro: e' il valore che il render
// pubblicherebbe come testo della FAQ.
//
// Quindi la worklist si ri-deriva dal disco un'ultima volta (stessa sorgente di
// verita' del passo, non un contatore tenuto in memoria: cio' che conta e' cosa
// c'e' scritto, non cosa lo script crede di aver scritto) e qualunque
// sopravvissuto fa uscire lo script non-zero. Vale anche in `--check`, dove il
// passo non scrive: li' un sentinella su disco e' un residuo di un giro
// precedente morto a meta', ed e' esattamente cio' che si vuole vedere.
const dropFaqSurvivors = [];
for (const abs of [...walkBodies(path.join(ROOT, 'content', 'blog-body')), ...walkBodies(path.join(ROOT, 'content', 'blog-body-ch'))]) {
  try {
    if (fs.readFileSync(abs, 'utf-8').includes('__DROP_FAQ__')) dropFaqSurvivors.push(path.relative(ROOT, abs));
  } catch (err) {
    problems.push(`${path.relative(ROOT, abs)}: rilettura per il controllo finale fallita (${err.message}) — sentinella NON verificato`);
  }
}
if (dropFaqSurvivors.length) {
  console.error(`\n✖ ${dropFaqSurvivors.length} file contengono ancora il sentinella __DROP_FAQ__ e verrebbero pubblicati cosi':`);
  for (const rel of dropFaqSurvivors.slice(0, 20)) console.error(`   ${rel}`);
  if (dropFaqSurvivors.length > 20) console.error(`   … e altri ${dropFaqSurvivors.length - 20}`);
  console.error('   Rilancia lo script (e\' idempotente); se persiste, il file va riparato a mano PRIMA di pubblicare.');
}

if (problems.length) {
  console.error(`\n✖ ${problems.length} campi/file SALTATI (escape non round-trippabile, o errore di I/O confinato):`);
  for (const p of problems) console.error(`   ${p}`);
}
if (problems.length || dropFaqSurvivors.length) process.exit(1);
