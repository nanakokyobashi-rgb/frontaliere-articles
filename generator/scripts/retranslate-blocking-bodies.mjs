#!/usr/bin/env node
/**
 * retranslate-blocking-bodies.mjs — bonifica dei body-locale che la guardia di
 * factuality rifiuta, facendoli RIPASSARE dalla pipeline di traduzione vera.
 *
 * ── PERCHE' ESISTE ─────────────────────────────────────────────────────────
 *
 * `audit-article-factuality.mjs` sa DIRE quali pagine pubblicate la guardia
 * rifiuterebbe, ma nessuno script sapeva RIPARARLE: `create-article.mjs` e'
 * append-only (`registerArticleFiles: article "..." already exists`) e
 * `translateArticle()` lavora solo su un articolo nuovo in memoria, mai su un
 * `content/**` gia' scritto. Lo stock misurato il 2026-09-06 e' 459 coppie
 * articolo×locale bloccanti su 22'696 (2,0%), tutte pre-guardia: sui 544
 * body-locale aggiunti dal 2026-09-01 le coppie bloccanti sono ZERO, quindi
 * l'ingresso e' chiuso e questa e' bonifica dell'esistente, non una toppa a
 * un difetto ancora attivo.
 *
 * ── IL VINCOLO CHE DA' FORMA A QUESTO FILE ─────────────────────────────────
 *
 * Qui NON si riscrive testo pubblicato con una euristica. Ogni carattere che
 * finisce in `content/` esce da `translateFieldFreeMt()`, cioe' dalla stessa
 * cascata MT che traduce gli articoli nuovi, col glossario e col balance dei
 * marker markdown gia' applicati nel suo unico punto di uscita. Non c'e' un
 * `sed`, non c'e' una regex di riparazione, non c'e' un fix-up mirato: il
 * detector che nel 2026-07 riscriveva i titoli e' stato ritirato al 33% di
 * falsi positivi, e un rilevatore abbastanza buono da SEGNALARE un campo non
 * e' abbastanza buono da EDITARLO.
 *
 * Da cui le due regole che governano la scrittura, entrambe verificate dal
 * test `retranslate-blocking-bodies.test.mjs`:
 *
 *   1. si scrive SOLO se la nuova traduzione passa la guardia con zero
 *      `critical` — una ri-traduzione che ri-fallisce si scarta e la pagina
 *      pubblicata resta com'e';
 *   2. si scrive SOLO se la vecchia era bloccante — mai "migliorare" una
 *      pagina che la guardia gia' accetta.
 *
 * Se un campo torna vuoto dalla cascata (motore giu', sentinella nav-link
 * mangled, marker `Null` di fallimento) l'articolo si SALTA per intero: in
 * produzione il chiamante ha una recovery per-campo (retry LLM → fallback IT),
 * qui no, e mezza traduzione nuova cucita su mezza vecchia sarebbe testo che
 * nessuna pipeline ha mai prodotto.
 *
 * ── COSTO ──────────────────────────────────────────────────────────────────
 *
 * Zero quota LLM: `freeTranslateWithRetry` e' la cascata di motori gratuiti.
 * Il costo e' wall-clock e rate limit degli endpoint pubblici, non il budget
 * condiviso che ferma il ciclo agentico. Il "cascade" da ~265 job/giorno e'
 * un'altra cosa (gli annunci di lavoro) e non viene toccato.
 *
 * Usage:
 *   node generator/scripts/retranslate-blocking-bodies.mjs --audit a.json
 *   ...--audit a.json --code translation-false-friend --limit 20   # pilota
 *   ...--audit a.json --apply                                      # scrive
 *
 * Flag:
 *   --audit <file>     JSON di audit-article-factuality.mjs --json (richiesto)
 *   --apply            scrive davvero. SENZA questo flag e' un dry-run.
 *   --limit N          massimo di coppie trattate
 *   --locale a,b       filtra le coppie per locale (default en,de,fr)
 *   --code <code>      filtra per codice bloccante (stratificazione del pilota)
 *   --stratify         una fetta per ogni codice, fino a --limit complessivo
 *   --concurrency N    articoli in parallelo (default 2, gentile coi motori)
 *   --content-root <p> radice che contiene content/ (default: root del repo)
 *   --json             report macchina invece della tabella
 *   --out <file>       scrive il report `--json` in un file. Serve davvero: i
 *                      tier della cascata loggano le rotazioni di chiave su
 *                      STDOUT ("DeepL key #1 quota exhausted"), quindi un
 *                      `--json` rediretto con `>` non e' parsabile.
 */
import { readFileSync, writeFileSync, existsSync, renameSync, unlinkSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { translateFieldFreeMt } from './lib/article-free-mt.mjs';
import { freeTranslateWithRetry, balanceMarkdownMarkers } from './lib/free-translate.mjs';
import { runFactualityGates } from './lib/article-factuality-gates.mjs';
import { unescapeTsString } from './lib/unescape-ts-string.mjs';
import { sanitizeText } from '../../scripts/lib/sanitize-control-chars.mjs';
import { reportStrippedControlChars } from './lib/control-char-write-report.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
// `../..`: il transport ha spostato `scripts/` sotto `generator/scripts/`,
// quindi due livelli su sono la root del repo, non la cartella generator.
const ROOT = resolve(__dirname, '..', '..');

/** I campi che la guardia concatena: si ri-traducono insieme o niente. */
export const BODY_FIELDS = ['body1', 'body2', 'body3'];

/**
 * L'audit riporta il path del SYMLINK (`services/locales/blog-body`), non
 * quello reale. Su `services/...` `git log` rende vuoto con exit 0, e ogni
 * scrittura passerebbe comunque dal link: si lavora sul path reale.
 */
export const DIR_TO_REAL = {
  'services/locales/blog-body': 'content/blog-body',
  'services/locales/blog-body-ch': 'content/blog-body-ch',
};

/** Chiave i18n di un campo body dentro il file di un articolo. */
const bodyKey = (id, field) => `'blog.article.${id}.${field}': `;

/**
 * Legge un campo body dal sorgente TS.
 *
 * Lo scrittore emette una stringa single-quoted con `\\`, `\'` e `\n`
 * escapati; alcuni file storici usano il template literal. Si riconosce la
 * virgoletta effettiva e si applica l'inverso ESATTO di quello scrittore —
 * `unescapeTsString` con la sola tabella che lo scrittore produce — perche' un
 * inverso che spoglia ogni `\x` mangerebbe gli escape del JSON che vive dentro
 * il campo `faq` (issue #394).
 */
export function readBodyField(src, id, field) {
  const key = bodyKey(id, field);
  const i = src.indexOf(key);
  if (i === -1) return null;
  let j = i + key.length;
  const quote = src[j];
  if (quote !== "'" && quote !== '`') return null;
  j += 1;
  const start = j;
  while (j < src.length) {
    if (src[j] === '\\') { j += 2; continue; }
    if (src[j] === quote) break;
    j += 1;
  }
  if (j >= src.length) return null;
  const raw = src.slice(start, j);
  return quote === "'"
    ? unescapeTsString(raw, { "'": "'", n: '\n', '\\': '\\' })
    : unescapeTsString(raw, { '`': '`', $: '$', '\\': '\\' });
}

/** Stesso escaping di `buildBodyFile()` in create-article.mjs. */
export function escapeForSingleQuoteTS(s) {
  return String(s || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '');
}

/**
 * Sostituisce UN campo body nel sorgente, lasciando intatto tutto il resto del
 * file (le altre chiavi, `faq`, l'export finale). Ritorna `null` se la chiave
 * non c'e': meglio saltare l'articolo che riscriverlo a meta'.
 */
export function replaceBodyField(src, id, field, value) {
  const key = bodyKey(id, field);
  const i = src.indexOf(key);
  if (i === -1) return null;
  let j = i + key.length;
  const quote = src[j];
  if (quote !== "'" && quote !== '`') return null;
  j += 1;
  while (j < src.length) {
    if (src[j] === '\\') { j += 2; continue; }
    if (src[j] === quote) break;
    j += 1;
  }
  if (j >= src.length) return null;
  // Si riscrive sempre come single-quoted: e' la forma che lo scrittore
  // canonico emette, e `escapeForSingleQuoteTS` e' il suo inverso esatto.
  return `${src.slice(0, i + key.length)}'${escapeForSingleQuoteTS(value)}'${src.slice(j + 1)}`;
}

/** Scrittura atomica: un SIGKILL a meta' non lascia il body troncato. */
let writeTmpSeq = 0;
export function writeAtomic(filePath, content) {
  const clean = sanitizeText(content);
  // Togliere il byte di controllo senza registrarlo distrugge il marker che
  // rende esatta una riparazione futura (issue #95).
  reportStrippedControlChars(filePath, content, clean);
  const file = resolve(filePath);
  const tmp = `${file}.${process.pid}.${writeTmpSeq++}.tmp`;
  try {
    writeFileSync(tmp, clean, 'utf-8');
    renameSync(tmp, file);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* best-effort */ }
    throw err;
  }
}

/** Codici `critical` di un risultato di guardia, deduplicati e ordinati. */
export function criticalCodes(gateResult) {
  const issues = gateResult?.issues || [];
  return [...new Set(issues.filter((i) => i.severity === 'critical').map((i) => i.code))].sort();
}

/**
 * Decide se la nuova traduzione va scritta.
 *
 * E' il cuore del vincolo "mai peggiorare, mai riscrivere a mano", isolato in
 * una funzione pura proprio per essere testabile senza toccare la rete.
 */
export function shouldWrite({ oldCodes, newCodes, missingField }) {
  if (missingField) return { write: false, reason: 'campo-vuoto-dalla-cascata' };
  if (oldCodes.length === 0) return { write: false, reason: 'vecchia-gia-pulita' };
  if (newCodes.length > 0) return { write: false, reason: `ri-fallita: ${newCodes.join(',')}` };
  return { write: true, reason: 'pulita' };
}

/** Coppie bloccanti dall'audit, con i codici `critical` di ciascuna. */
export function blockingPairsFromAudit(audit) {
  return (audit.findings || [])
    .filter((f) => f.criticalCount > 0)
    .map((f) => ({
      id: f.id,
      locale: f.locale,
      dir: f.dir,
      codes: [...new Set(f.issues.filter((i) => i.severity === 'critical').map((i) => i.code))].sort(),
    }));
}

/**
 * Sceglie il campione del pilota: una fetta per ciascun codice presente, a
 * turno, finche' non si raggiunge `limit`. Round-robin invece di "i primi N"
 * perche' i primi N sono ordinati per id e ricadrebbero tutti sullo stesso
 * codice, misurando un solo difetto e dichiarandolo rappresentativo.
 */
export function stratify(pairs, limit) {
  const byCode = new Map();
  for (const p of pairs) {
    const k = p.codes[0];
    if (!byCode.has(k)) byCode.set(k, []);
    byCode.get(k).push(p);
  }
  const queues = [...byCode.values()];
  const out = [];
  let progressed = true;
  while (out.length < limit && progressed) {
    progressed = false;
    for (const q of queues) {
      if (out.length >= limit) break;
      const next = q.shift();
      if (next) { out.push(next); progressed = true; }
    }
  }
  return out;
}

// ── CLI ────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const flag = (name, dflt = null) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? dflt : (argv[i + 1] ?? dflt);
};
const has = (name) => argv.includes(`--${name}`);

async function main() {
  const auditPath = flag('audit');
  if (!auditPath) {
    console.error('❌ --audit <file.json> è richiesto (output di audit-article-factuality.mjs --json).');
    process.exit(2);
  }
  const APPLY = has('apply');
  const AS_JSON = has('json');
  // `|| Infinity` sarebbe sbagliato: `--limit 0` e' zero, non "nessun limite".
  const rawLimit = flag('limit');
  const LIMIT = rawLimit === null ? Infinity : Number(rawLimit);
  if (!Number.isFinite(LIMIT) && rawLimit !== null) {
    console.error(`❌ --limit "${rawLimit}" non è un numero.`);
    process.exit(2);
  }
  const CONCURRENCY = Math.max(1, Number(flag('concurrency', 2)) || 2);
  const CONTENT_ROOT = resolve(flag('content-root', ROOT));
  const LOCALES = String(flag('locale', 'en,de,fr')).split(',').map((s) => s.trim()).filter(Boolean);
  const CODE = flag('code');

  // Un worktree sparse NON ha `content/`, e senza questo controllo ogni coppia
  // uscirebbe 'sorgente-mancante' con exit 0: un no-op che si legge come "non
  // c'era niente da fare". L'assenza di un path in uno sparse non prova che il
  // file non esista nel repository — qui va provato prima di dichiarare zero.
  const missingDirs = Object.values(DIR_TO_REAL).filter((d) => !existsSync(resolve(CONTENT_ROOT, d)));
  if (missingDirs.length === Object.keys(DIR_TO_REAL).length) {
    console.error(`❌ nessun albero di body sotto ${CONTENT_ROOT} (cercati: ${missingDirs.join(', ')}).`);
    console.error('   Se sei in un worktree sparse, passa --content-root sul checkout che ha content/.');
    process.exit(2);
  }

  const audit = JSON.parse(readFileSync(auditPath, 'utf8'));
  let pairs = blockingPairsFromAudit(audit)
    // L'italiano è il sorgente, non una traduzione: ri-tradurlo non ha senso e
    // rigenerarlo è un'altra operazione (che oggi nessun entry point espone).
    .filter((p) => p.locale !== 'it' && LOCALES.includes(p.locale))
    .filter((p) => !CODE || p.codes.includes(CODE));

  pairs = has('stratify') && LIMIT !== Infinity ? stratify(pairs, LIMIT) : pairs.slice(0, LIMIT);

  const results = [];
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const idx = cursor++;
      if (idx >= pairs.length) return;
      const p = pairs[idx];
      results.push(await processPair(p, { CONTENT_ROOT, APPLY }));
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pairs.length) }, worker));

  report(results, { APPLY, AS_JSON, total: pairs.length, OUT: flag('out') && resolve(flag('out')) });
}

async function processPair(pair, { CONTENT_ROOT, APPLY }) {
  const base = { ...pair };
  const realDir = DIR_TO_REAL[pair.dir];
  if (!realDir) return { ...base, written: false, reason: `dir-sconosciuta: ${pair.dir}` };

  const itPath = resolve(CONTENT_ROOT, realDir, 'it', `${pair.id}.ts`);
  const trPath = resolve(CONTENT_ROOT, realDir, pair.locale, `${pair.id}.ts`);
  if (!existsSync(itPath) || !existsSync(trPath)) {
    return { ...base, written: false, reason: 'sorgente-mancante' };
  }
  const itSrc = readFileSync(itPath, 'utf8');
  let trSrc = readFileSync(trPath, 'utf8');

  const italianSections = {};
  for (const f of BODY_FIELDS) {
    const v = readBodyField(itSrc, pair.id, f);
    if (v) italianSections[f] = v;
  }
  if (!Object.keys(italianSections).length) {
    return { ...base, written: false, reason: 'italiano-illeggibile' };
  }

  const oldSections = {};
  for (const f of BODY_FIELDS) {
    const v = readBodyField(trSrc, pair.id, f);
    if (v) oldSections[f] = v;
  }
  const oldCodes = criticalCodes(runFactualityGates({ sections: oldSections, locale: pair.locale, italianSections }));

  // Ri-traduzione: OGNI carattere qui esce dalla cascata MT, mai da una regex.
  const newSections = {};
  let missingField = null;
  for (const f of Object.keys(italianSections)) {
    const out = await translateFieldFreeMt({
      text: italianSections[f],
      sourceLang: 'it',
      targetLang: pair.locale,
      fieldType: 'description',
      translate: freeTranslateWithRetry,
      balanceMarkdown: balanceMarkdownMarkers,
    });
    if (!out) { missingField = f; break; }
    newSections[f] = out;
  }

  const newCodes = missingField
    ? []
    : criticalCodes(runFactualityGates({ sections: newSections, locale: pair.locale, italianSections }));

  const verdict = shouldWrite({ oldCodes, newCodes, missingField });
  const row = { ...base, oldCodes, newCodes, missingField, written: false, reason: verdict.reason };
  if (!verdict.write || !APPLY) return row;

  for (const f of Object.keys(newSections)) {
    const next = replaceBodyField(trSrc, pair.id, f, newSections[f]);
    if (next === null) return { ...row, reason: `chiave-assente: ${f}` };
    trSrc = next;
  }
  writeAtomic(trPath, trSrc);
  return { ...row, written: true };
}

function report(results, { APPLY, AS_JSON, total, OUT }) {
  const payload = () => JSON.stringify({ mode: APPLY ? 'apply' : 'dry-run', total, results }, null, 2);
  if (OUT) {
    // Su file, non su stdout: i tier loggano li' e romperebbero il parse.
    writeFileSync(OUT, payload(), 'utf-8');
    console.log(`report JSON → ${OUT}`);
  } else if (AS_JSON) {
    console.log(payload());
    return;
  }
  const written = results.filter((r) => r.written).length;
  const clean = results.filter((r) => r.reason === 'pulita').length;
  const refailed = results.filter((r) => r.reason.startsWith('ri-fallita')).length;
  const empty = results.filter((r) => r.reason === 'campo-vuoto-dalla-cascata').length;

  console.log(`\nmodalità: ${APPLY ? 'APPLY (scrive)' : 'DRY-RUN (non scrive)'} — coppie trattate: ${results.length}/${total}`);
  console.log(`  ri-traduzione pulita : ${clean}${APPLY ? ` (scritte ${written})` : ''}`);
  console.log(`  ri-fallita           : ${refailed}`);
  console.log(`  campo vuoto (skip)   : ${empty}`);
  console.log(`  altro                : ${results.length - clean - refailed - empty}`);

  // Per-codice: e' la misura che decide se un codice va escluso dal lotto.
  const perCode = new Map();
  for (const r of results) {
    for (const c of r.oldCodes || []) {
      if (!perCode.has(c)) perCode.set(c, { n: 0, ok: 0 });
      const e = perCode.get(c);
      e.n += 1;
      if (r.reason === 'pulita') e.ok += 1;
    }
  }
  if (perCode.size) {
    console.log('\n  codice bloccante di partenza      trattate  risolte');
    for (const [c, e] of [...perCode].sort((a, b) => b[1].n - a[1].n)) {
      console.log(`  ${c.padEnd(32)} ${String(e.n).padStart(8)} ${String(e.ok).padStart(8)}`);
    }
  }
  const bad = results.filter((r) => r.reason.startsWith('ri-fallita')).slice(0, 10);
  if (bad.length) {
    console.log('\n  esempi di ri-fallite (codice vecchio → nuovo):');
    for (const r of bad) console.log(`    ${r.locale}/${r.id}  ${r.oldCodes.join(',')} → ${r.newCodes.join(',')}`);
  }
}

// `import` dal test non deve far partire una run di rete.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
