#!/usr/bin/env node
/**
 * batch-add-faq-to-articles.mjs — Add AI-generated FAQ to existing blog articles.
 *
 * Scans all 720 blog articles, generates 3-5 FAQ pairs per article via AI,
 * translates to EN/DE/FR, and writes the FAQ key to all 4 locale body files.
 *
 * Usage:
 *   node scripts/batch-add-faq-to-articles.mjs                  # process all articles
 *   node scripts/batch-add-faq-to-articles.mjs --limit 10       # process first 10
 *   node scripts/batch-add-faq-to-articles.mjs --dry-run         # preview without API calls
 *   node scripts/batch-add-faq-to-articles.mjs --concurrency 5   # 5 parallel articles
 *   node scripts/batch-add-faq-to-articles.mjs --skip-translate   # Italian FAQ only
 *   node scripts/batch-add-faq-to-articles.mjs --help             # show help
 *
 * Requires: GH_MODELS_PAT env var (or other AI provider keys — uses centralized ai-models.mjs)
 *
 * Progress is saved to data/batch-faq-progress.json for resumability.
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'fs';
import { resolve, basename, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// `../..`: the transport moved this from `scripts/` to `generator/scripts/`,
// so one level up is now the generator directory, not the repo root.
const ROOT = resolve(__dirname, '..', '..');
import { corpusPath, resolveGitAddPath } from './lib/corpus-paths.mjs';
import { sanitizeText } from '../../scripts/lib/sanitize-control-chars.mjs';
import { reportStrippedControlChars } from './lib/control-char-write-report.mjs';
import { callLLM, callSingleModel, AI_MODELS, initScoreStore, getStats, flushScores, resetExhaustedModel, printRunSummary } from './lib/ai-models.mjs';
import { freeTranslateWithRetry, logCascadeSummary } from './lib/free-translate.mjs';
import { stripCodeFences, findMatchingClose, fixJsonStringBody, JSON_QUOTE_SAFETY_RULE_IT, describeJsonParseError, describeRawForDiagnostics } from './lib/llm-json-repair.mjs';
import { detectLanguage } from './lib/detect-language.mjs';
import { unescapeTsString } from './lib/unescape-ts-string.mjs';

// ── CLI argument parsing ─────────────────────────────────────
const args = process.argv.slice(2);

function getArg(name) {
  const idx = args.indexOf(name);
  if (idx === -1) return undefined;
  return args[idx + 1];
}

const HELP = args.includes('--help') || args.includes('-h');
const DRY_RUN = args.includes('--dry-run');
const SKIP_TRANSLATE = args.includes('--skip-translate');
const LIMIT = getArg('--limit') ? parseInt(getArg('--limit'), 10) : Infinity;
const CONCURRENCY = getArg('--concurrency') ? parseInt(getArg('--concurrency'), 10) : 3;

// ── Section selection (--section=frontaliere|svizzera, default frontaliere) ──
// Switches the body-dir enumeration source between the cross-border and the
// Switzerland-wide article sets. The i18n key namespace (blog.article.{id}.*)
// is shared, so only the directory differs. frontaliere = byte-identical.
function getSectionArg() {
  let section = 'frontaliere';
  for (const a of args) {
    const m = /^--section=(.+)$/.exec(a);
    if (m) section = m[1];
  }
  const inline = getArg('--section');
  if (inline) section = inline;
  if (!['frontaliere', 'svizzera'].includes(section)) {
    console.error(`Invalid --section="${section}". Valid: frontaliere, svizzera`);
    process.exit(1);
  }
  return section;
}
const SECTION = getSectionArg();
const SECTION_BODY_DIR = SECTION === 'svizzera' ? 'blog-body-ch' : 'blog-body';

if (HELP) {
  console.log(`
batch-add-faq-to-articles.mjs — Add AI-generated FAQ to existing blog articles

USAGE:
  node scripts/batch-add-faq-to-articles.mjs [options]

OPTIONS:
  --help, -h        Show this help message
  --dry-run         Preview what would be done without making API calls or modifying files
  --limit N         Process only the first N articles (useful for testing)
  --concurrency N   Number of articles to process in parallel (default: 3)
  --skip-translate  Only generate Italian FAQ, skip EN/DE/FR translation
  --section NAME    Article section: frontaliere (default) | svizzera.
                    svizzera scans services/locales/blog-body-ch instead.

ENVIRONMENT:
  GH_MODELS_PAT     GitHub Models token (required, or other AI provider keys)
  See scripts/lib/ai-models.mjs for all supported providers.

PROGRESS:
  Progress is saved to data/batch-faq-progress.json after each article.
  Re-running the script will skip already-completed articles.
  Delete the progress file to start fresh.

EXAMPLES:
  # Test with 5 articles first
  node scripts/batch-add-faq-to-articles.mjs --limit 5

  # Full run, higher concurrency
  node scripts/batch-add-faq-to-articles.mjs --concurrency 5

  # Preview only
  node scripts/batch-add-faq-to-articles.mjs --dry-run

  # Italian FAQ only (no translation cost)
  node scripts/batch-add-faq-to-articles.mjs --skip-translate --limit 10
`);
  process.exit(0);
}

// ── Constants ────────────────────────────────────────────────
const LOCALES = ['it', 'en', 'de', 'fr'];
// Mapped to this repo's `content/` layout; see lib/corpus-paths.mjs.
const BODY_DIR = corpusPath(`services/locales/${SECTION_BODY_DIR}`);
// Section-keyed progress file so a svizzera run does not skip frontaliere
// articles (and vice versa). frontaliere keeps the original filename.
const PROGRESS_FILE = SECTION === 'svizzera'
  ? 'data/batch-faq-progress-ch.json'
  : 'data/batch-faq-progress.json';

// ── Helpers ──────────────────────────────────────────────────

function read(filePath) {
  return readFileSync(resolve(filePath), 'utf-8');
}

// Same write-time guard as create-article.mjs write() (issue #66): strip any
// C0 control character other than TAB/LF/CR before it reaches content/.
function write(filePath, content) {
  const clean = sanitizeText(content);
  // Non basta togliere il byte: toglierlo distrugge il MARKER che rende
  // esatta una riparazione futura (issue #95). Si registra prima, con il
  // contesto che conserva la coppia (byte, carattere seguente).
  reportStrippedControlChars(filePath, content, clean);
  writeFileSync(resolve(filePath), clean, 'utf-8');
}

/** Same escaping as create-article.mjs buildBodyFile() */
function escapeForSingleQuoteTS(s) {
  return String(s || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '');
}

/** Strip markdown fences and extract JSON array from LLM output.
 *  Bracket-balanced extraction + string repair live in ./lib/llm-json-repair.mjs
 *  (shared with create-article.mjs's repairLlmJson — same LLM-JSON quirks). */
function repairJsonArray(s) {
  let c = stripCodeFences(s);
  // Bracket-balanced extraction so trailing prose (LLM "Note: ..." after the
  // array) does not pull in a foreign ']' via lastIndexOf.
  const arrStart = c.indexOf('[');
  if (arrStart !== -1) {
    const arrEnd = findMatchingClose(c, arrStart);
    if (arrEnd !== -1) c = c.slice(arrStart, arrEnd + 1);
    else {
      const lastClose = c.lastIndexOf(']');
      if (lastClose > arrStart) c = c.slice(arrStart, lastClose + 1);
    }
  } else {
    const objStart = c.indexOf('{');
    if (objStart !== -1) {
      const objEnd = findMatchingClose(c, objStart);
      if (objEnd !== -1) c = c.slice(objStart, objEnd + 1);
    }
  }
  return fixJsonStringBody(c);
}

/** Extract FAQ array from various LLM response shapes:
 *  - direct array: [...]
 *  - wrapped object: {"faq": [...]} or {"faqs": [...]} or {"questions": [...]}
 *  - single-key object with array value: {"anything": [...]}
 *  - object with q/a keys directly: {"q":"...","a":"..."} → wrap as [obj]
 */
function extractFaqArray(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object') {
    // Try known keys first
    for (const key of ['faq', 'faqs', 'questions', 'data', 'results', 'items']) {
      if (Array.isArray(parsed[key])) return parsed[key];
    }
    // Fallback: first array-valued property
    const vals = Object.values(parsed);
    const arrVal = vals.find((v) => Array.isArray(v));
    if (arrVal) return arrVal;
    // Single Q&A object: {"q": "...", "a": "..."}
    if (typeof parsed.q === 'string' && typeof parsed.a === 'string') return [parsed];
    // Numbered keys: {"1": {"q":"...","a":"..."}, "2": {...}}
    const numVals = Object.values(parsed).filter((v) => v && typeof v === 'object' && v.q && v.a);
    if (numVals.length >= 2) return numVals;
  }
  return null;
}

/** Last-resort: extract Q&A pairs from plain text using regex patterns */
function extractFaqFromText(raw) {
  const pairs = [];
  // Pattern: **D: ...** / **R: ...** or "Domanda: ... Risposta: ..."
  const qaPat = /(?:domanda|question|q)\s*[:.]?\s*["""]?(.{15,200}?)["""]?\s*(?:risposta|answer|a)\s*[:.]?\s*["""]?(.{20,500}?)["""]?\s*(?=(?:domanda|question|q)\s*[:.]\s|$)/gis;
  let m;
  while ((m = qaPat.exec(raw)) !== null) {
    pairs.push({ q: m[1].trim(), a: m[2].trim() });
  }
  if (pairs.length >= 2) return pairs;
  // Pattern: numbered "1. Q: ... A: ..."
  const numPat = /\d+\.\s*(?:Q|D)[:.]\s*(.{15,200}?)\s*(?:A|R)[:.]\s*(.{20,500}?)(?=\d+\.\s*(?:Q|D)[:.]\s|$)/gis;
  while ((m = numPat.exec(raw)) !== null) {
    pairs.push({ q: m[1].trim(), a: m[2].trim() });
  }
  return pairs.length >= 2 ? pairs : null;
}

/** Load progress file or create empty state */
function loadProgress() {
  if (existsSync(resolve(PROGRESS_FILE))) {
    try {
      return JSON.parse(read(PROGRESS_FILE));
    } catch {
      console.error('⚠️  Corrupted progress file, starting fresh');
    }
  }
  return { completed: [], failed: [], startedAt: new Date().toISOString() };
}

function saveProgress(progress) {
  progress.updatedAt = new Date().toISOString();
  write(PROGRESS_FILE, JSON.stringify(progress, null, 2));
}

/** Incremental git commit — saves work so CI timeout doesn't lose progress */
let _lastCommitStep = 0;
const COMMIT_EVERY = 25;

function gitCommitAndPush(label) {
  try {
    const bodyDirGitPath = resolveGitAddPath(ROOT, `services/locales/${SECTION_BODY_DIR}/`);
    execSync(
      `git add ${bodyDirGitPath} && git add -f ${PROGRESS_FILE} 2>/dev/null; ` +
      `git diff --cached --quiet || git commit -m "❓ FAQ batch checkpoint (${label})"`,
      { cwd: ROOT, stdio: 'pipe', timeout: 30000 }
    );
    // Push using default GITHUB_TOKEN (permissions: contents: write)
    try {
      execSync('git push origin main', { cwd: ROOT, stdio: 'pipe', timeout: 60000 });
      console.error(`💾 Checkpoint pushed: ${label}`);
    } catch (pushErr) {
      // Rebase and retry once (handles concurrent pushes)
      try {
        execSync('git pull --rebase origin main', { cwd: ROOT, stdio: 'pipe', timeout: 30000 });
        execSync('git push origin main', { cwd: ROOT, stdio: 'pipe', timeout: 60000 });
        console.error(`💾 Checkpoint pushed (after rebase): ${label}`);
      } catch {
        // A conflicting rebase leaves an in-progress rebase state that wedges every
        // subsequent run on the same runner; abort it so the loop can't stay stuck
        // (mirrors the `git rebase --abort` recovery added to the bash loops in #2721).
        try { execSync('git rebase --abort', { cwd: ROOT, stdio: 'pipe', timeout: 30000 }); } catch { /* no rebase in progress */ }
        console.error(`⚠️  Checkpoint committed but push failed: ${pushErr.message?.slice(0, 100)}`);
      }
    }
  } catch (err) {
    console.error(`⚠️  Checkpoint failed: ${err.message?.slice(0, 100)}`);
  }
}

function commitIfNeeded(currentStep) {
  if ((currentStep - _lastCommitStep) >= COMMIT_EVERY) {
    _lastCommitStep = currentStep;
    gitCommitAndPush(`step ${currentStep}`);
  }
}

// Graceful shutdown: commit+push on SIGTERM (GitHub Actions sends this before kill).
// La REGISTRAZIONE sta dentro la guardia sull'entry point in coda al file, non
// qui: questo modulo viene IMPORTATO — da `publish-journalist-article.mjs` per
// `generateFaqIT`, e ora dai test — e a module scope l'handler si armava anche
// li'. Un SIGTERM a quei processi (`tests.yml` ha `cancel-in-progress: true`,
// e in locale basta un kill) faceva partire `git add content/ && git commit &&
// git push origin main` da un processo che non stava generando niente. Armarlo
// solo quando il file E' l'entry point non toglie niente al job vero, che passa
// sempre di la'.
// La stessa perdita che #433 chiude in create-article.mjs (`exitAfterFlush`)
// era ancora viva qui: questo handler chiama `callLLM` da `genTasks` /
// `topUpTasks` / `transTasks` durante la run, e un SIGTERM a meta' run
// (workflow cancellato) usciva con `process.exit(0)` sincrono senza mai dare
// al ledger dei punteggi una finestra per scrivere gli esiti accumulati.
//
// Il primo giro di questo fix rendeva l'handler `async` e chiamava lui stesso
// `flushScoresBeforeExit()` + `process.exit(0)` — ma questo handler si registra
// PRIMA che `main()` arrivi a `initScoreStore()`, che arma il proprio pair
// SIGTERM (`_registerExitHooks()` in `ai-models.mjs`). Su un SIGTERM reale
// correvano entrambi: il nostro restava sospeso al vero `await ref.set()` di
// rete (`_persistScoresToFirestore()` svuota `_dirtyModels` PRIMA di quell'
// await), l'altro trovava `_dirtyModels` gia' vuoto, ritornava quasi subito e
// chiamava `process.exit(143)` mentre la nostra scrittura era ancora in volo —
// abortendola. Questo handler ora resta sincrono e fa SOLO il checkpoint git:
// nessun `await` prima del suo ritorno, quindi l'emit di `SIGTERM` non puo'
// interlacciarsi con l'altro listener, che parte solo a checkpoint concluso e
// possiede da solo flush + exit(143). Se il SIGTERM arriva prima che
// `initScoreStore()` abbia armato quel pair, non c'e' ancora niente di sporco
// da perdere, e il processo termina sul SIGKILL che Actions manda dopo la
// grace window — lo stesso esito di sempre.
function installSigtermCheckpoint() {
  process.on('SIGTERM', () => {
    console.error('\n⚠️  SIGTERM — saving progress...');
    gitCommitAndPush('interrupted');
  });
}

// ── Article discovery ────────────────────────────────────────

/**
 * Extract article ID from a body file's content by scanning for the key pattern.
 *
 * `fileName` non e' decorativo (issue #393). La forma precedente prendeva il
 * PRIMO `body1` del file e basta: in un file a due id — lo scenario che tutto
 * questo blocco esiste per difendere — l'identita' dell'articolo veniva decisa
 * dalla POSIZIONE, e il secondo articolo restava invisibile a `discoverArticles`.
 * Il corpus ha gia' una definizione di identita' che non dipende dall'ordine, ed
 * e' il nome del file: `fix-faq-locales.mjs` (`basename(file, '.ts')`) e
 * `repair-prompt-placeholders.mjs` (`name.slice(0, -3)`) usano quella. Qui la si
 * PREFERISCE quando il file la nomina davvero, e si ricade sul primo `body1`
 * quando non la nomina — cosi' i fixture sintetici e i file rinominati a mano
 * continuano a risolvere come prima.
 */
export function extractArticleId(fileContent, fileName) {
  const ids = [...fileContent.matchAll(/'blog\.article\.([a-z0-9-]+)\.body1'/g)].map(m => m[1]);
  if (!ids.length) return null;
  const fromName = fileName ? basename(fileName, '.ts') : null;
  return fromName && ids.includes(fromName) ? fromName : ids[0];
}

// ── L'ancora all'id (issue #301 item 2) ──────────────────────
//
// La chiave che questo script legge e SCRIVE e' quella dell'articolo che sta
// trattando, non un `.faq` qualunque nel file. Il pattern e' quello con cui
// #294 ha ancorato i gate di sola lettura (`find-dirty-content-ids.mjs`,
// `faqQuestionsInBodyText`): chiave intera piu' id ESCAPATO per la regex.
//
// Senza l'ancora, in un file con due id — un residuo di merge: mai osservato
// sui 16.648 file reali, ma niente nel formato lo impedisce — `hasFaqKey`
// dichiarava presente una FAQ che per QUEL id non c'era (l'articolo veniva
// saltato invece di essere generato) e `replaceFaqInBodyFile` scriveva la FAQ
// di un articolo dentro la chiave di un altro. Su uno script che scrive nel
// corpus e' una perdita di dato, non un rapporto sbagliato.
//
// L'«ultima occorrenza» resta, e resta per la ragione di prima: una chiave
// DUPLICATA dello stesso id e' vinta dall'ultima nell'object literal JS, quindi
// e' quella viva al render. Le due regole sono ortogonali — si legge e si
// scrive l'ultima occorrenza DEL PROPRIO id.
//
// Il pattern e' ricopiato invece che condiviso, come in `find-dirty-content-ids.mjs`
// (#294): questo file e' un gemello `adapted` di uno del sito
// (`scripts/batch-add-faq-to-articles.mjs`) e importare qui una lib `corpus-only` aggiungerebbe una
// divergenza in piu' fra i due, per tre righe di regex.
const rxEscape = (id) => String(id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const faqKeyRx = (id) => `'blog\\.article\\.${rxEscape(id)}\\.faq'`;
// Stessa ancora, altra chiave (issue #393). `extractBodyContent` leggeva
// `\.body\d+'` — qualunque corpo nel file — e il testo cosi' raccolto e' il
// PROMPT da cui nasce la FAQ. In un file a due id i `bodyN` di entrambi gli
// articoli finivano concatenati nel prompt: la FAQ generata era il prodotto di
// due articoli e veniva scritta nella chiave (dal #392 correttamente ancorata)
// di uno solo. La scrittura finiva nel posto giusto, il contenuto no — un
// difetto che nessun controllo di sintassi puo' vedere, perche' il file
// prodotto e' perfettamente valido.
const bodyKeyRx = (id) => `'blog\\.article\\.${rxEscape(id)}\\.body\\d+'`;

/**
 * Check if a body file already has a .faq key for THIS article id.
 *
 * Primo argomento: il CONTENUTO del file. L'omonima di `fix-faq-locales.mjs`
 * prende invece un PATH — sono due moduli diversi e i due nomi ora sono
 * entrambi esportati, quindi la differenza va letta qui prima di importare.
 */
export function hasFaqKey(fileContent, articleId) {
  return new RegExp(`${faqKeyRx(articleId)}\\s*:`).test(fileContent);
}

/**
 * C'e' almeno una chiave `bodyN` per QUESTO id? Gemella di `hasFaqKey`, e serve
 * a distinguere «corpo corto» (da arricchire) da «nessun corpo per questo id»
 * (da fermare) — due casi che prima della fix di #393 non potevano essere
 * distinti, perche' la regex non ancorata trovava sempre qualcosa.
 */
export function hasBodyKey(fileContent, articleId) {
  return new RegExp(`${bodyKeyRx(articleId)}\\s*:`).test(fileContent);
}

/** Read and concatenate all bodyN keys OF THIS ARTICLE from file content.
 *  Supports both single-quoted ('...') and backtick-quoted (`...`) string values,
 *  and any number of body keys (body1, body2, ..., bodyN).
 *
 *  `articleId` e' obbligatorio (issue #393): il testo che esce di qui e' il
 *  prompt da cui nasce la FAQ, quindi un corpo di troppo non e' rumore in un
 *  rapporto — e' un articolo estraneo che entra nel contenuto pubblicato.
 */
export function extractBodyContent(fileContent, articleId) {
  // Rumoroso e non vuoto. Ancorando la chiave, questa funzione ha acquistato un
  // esito che prima non poteva avere: `''` perche' l'id non compare fra le
  // chiavi. Il chiamante non lo distingue da «corpo corto», e il ramo che
  // raccoglie il corpo corto chiama `enrichBodyForFaq`, che fa scrivere all'LLM
  // 1500-2500 parole a partire dal solo slug: un id sbagliato — o un chiamante
  // futuro che dimentica il secondo argomento, che senza questa guardia
  // cercherebbe `'blog.article.undefined.bodyN'` e tornerebbe `''` senza un
  // fiato — diventerebbe un articolo INVENTATO scritto nel corpus. Meglio
  // fermarsi: vedi `hasBodyKey`, che i due chiamanti usano per non arrivarci.
  if (!articleId) throw new Error('extractBodyContent: articleId obbligatorio (issue #393)');
  const bodies = [];
  // Match `'blog.article.<id>.bodyN':` followed by either a single-quoted or
  // backtick-quoted value. `bodyKeyRx` ancora la chiave all'id (vedi il blocco
  // sopra); il gruppo di cattura \1 pinza la virgoletta di apertura alla sua
  // chiusura. L'id e' gia' escapato e non introduce gruppi, quindi \1 continua
  // a riferirsi alla virgoletta.
  const re = new RegExp(`${bodyKeyRx(articleId)}\\s*:\\s*(['\`])((?:\\\\.|(?!\\1)[\\s\\S])*?)\\1`, 'g');
  let m;
  while ((m = re.exec(fileContent)) !== null) {
    const quoteChar = m[1];
    let content = m[2];
    if (quoteChar === "'") {
      // Single-quoted TS string: unescape \' \n \\
      content = unescapeTsString(content, { "'": "'", n: '\n', '\\': '\\' });
    } else {
      // Backtick (template literal): unescape \` \$ \\
      content = unescapeTsString(content, { '`': '`', $: '$', '\\': '\\' });
    }
    bodies.push(content);
  }
  return bodies.join('\n\n');
}

/** Check if FAQ text is in the wrong locale (same logic as job crawlers) */
function isWrongLocale(faqArray, expectedLocale) {
  const allText = faqArray.map(p => `${p.q} ${p.a}`).join(' ');
  if (allText.length < 50) return false;
  const detected = detectLanguage(allText, expectedLocale);
  return detected !== expectedLocale;
}

/**
 * Il LETTORE simmetrico allo scrittore di questo file (issue #394).
 *
 * Chi scrive qui (`replaceFaqInBodyFile`, `insertFaqIntoBodyFile`) passa da
 * `escapeForSingleQuoteTS`, che RADDOPPIA il backslash. Chi leggeva era rimasto
 * al decoder legacy — `raw.replace(/\\'/g, "'")` — che conosce solo l'apostrofo:
 * su cio' che questo script scrive lasciava `\\"` intatto, `JSON.parse` vedeva
 * finire la stringa a meta' e tornava `null`. Misurato prima della fix sui
 * 16.676 campi `.faq` del corpus: **377 illeggibili**, e siccome
 * `discoverArticles` fa `continue` quando l'italiano torna `null`, **96 articoli
 * IT** (82 in blog-body, 14 in blog-body-ch) venivano saltati in silenzio —
 * niente top-up, e le loro traduzioni en/de/fr mai controllate. Nessun errore,
 * nessun contatore. Dopo la fix: 0 illeggibili.
 *
 * Due decodifiche in ordine, come `parseFaqLiteral` di `fix-faq-locales.mjs`
 * (il gemello che ha gia' chiuso la stessa cosa): la prima e' l'inversa dello
 * scrittore di oggi, la seconda regge i file gia' scritti dallo scrittore
 * legacy. Vince la prima che produce un array — senza la (1) lo script e' cieco
 * su cio' che scrive lui stesso, senza la (2) i file gia' prodotti diventano
 * illeggibili e con essi irreparabili.
 *
 * La decodifica esatta passa da `unescapeTsString` (gia' importata) con la
 * mappa MINIMA `{ \\, ' }`, non da un inverso a tavolino di
 * `escapeForSingleQuoteTS`. Sono le sole due sequenze che lo scrittore emette,
 * e ogni altro `\x` va lasciato INTATTO perche' e' un escape del JSON che sta
 * sotto e lo deve vedere `JSON.parse`, non noi. La differenza non e' teorica:
 * un inverso che spoglia ogni `\x` (la forma di `unescapeForSingleQuoteTS`)
 * legge ` ` come la lettera `u`, e su due file reali del corpus —
 * `aufenthaltsbewilligung-b-quellensteuer-2026` it/fr — produce `CHF 5u00a0000`
 * al posto di `CHF 5<nbsp>000`. Parsa senza lamentarsi, quindi il fallback
 * legacy non scatta mai e il valore sbagliato passa: un JSON valido con dentro
 * un testo che nessuno ha scritto. Misurato: mappa minima e mappa larga
 * (`\n`/`\r` inclusi) danno 0 illeggibili e 0 divergenze sui 16.676 campi, ma
 * la minima e' quella di cui si puo' dimostrare la regola.
 *
 * OMONIMIA DA CONOSCERE PRIMA DI IMPORTARE. `fix-faq-locales.mjs` esporta una
 * `parseFaqLiteral` con lo STESSO nome, una forma di ritorno DIVERSA
 * (`{ pairs, legacy }` invece di `Array|null`) e un primo decoder diverso
 * (`unescapeForSingleQuoteTS`, quello che spoglia ogni `\x`). La stessa trappola
 * che questo file documenta gia' per `hasFaqKey` qui sopra: due moduli, due
 * contratti, un nome solo.
 *
 * L'ORDINE DEI DECODER RESTA AMBIGUO IN DUE CASI, non uno. Oltre al `\u` di
 * sopra: un literal scritto dallo scrittore LEGACY il cui testo contenga un
 * backslash letterale seguito da una lettera di escape JSON (`" \ / b f n r t
 * u`) viene dimezzato dal decoder 1, `JSON.parse` riesce lo stesso e il
 * fallback non scatta — array valido, valore sbagliato. Occorrenze oggi: 0.
 * L'ambiguita' non e' risolvibile dal literal da solo (chi l'ha scritto non e'
 * scritto da nessuna parte); l'ordine esatto-poi-legacy e' quello che sbaglia
 * meno, ed e' lo stesso del gemello.
 *
 * COSA CAMBIA PER I FILE GIA' LEGGIBILI. Sui 16.676 campi vivi: 377 passano da
 * illeggibili a leggibili, 16.277 restano identici, e **22 cambiano valore** —
 * sono i file col control-char mangling gia' noto, dove il sorgente porta
 * `\\u0000a1`. Li' il decoder legacy leggeva gli otto caratteri letterali
 * di quell escape e il nuovo restituisce U+0000 seguito da `a1`: la lettura
 * NUOVA e' quella fedele, perche' quel doppio backslash e' esattamente cio'
 * che `escapeForSingleQuoteTS` produce per un U+0000 che stava nel documento
 * JSON. Tutti e 22 introducono un C0 vero nel valore letto. Non e'
 * un danno introdotto qui, e' danno pre-esistente finalmente visibile — e in
 * riscrittura la `write()` di questo file lo toglie comunque, perche' applica
 * `sanitizeText` (issue #66).
 *
 * @param {string} raw - il testo catturato TRA le virgolette.
 * @returns {Array|null} le coppie, o `null` se nessuna decodifica da' un array.
 */
export function parseFaqLiteral(raw) {
  const decoders = [
    (s) => unescapeTsString(String(s ?? ''), { '\\': '\\', "'": "'" }),
    (s) => String(s ?? '').replace(/\\'/g, "'"),
  ];
  for (const decode of decoders) {
    try {
      const parsed = JSON.parse(decode(raw));
      if (Array.isArray(parsed)) return parsed;
    } catch { /* prova la decodifica successiva */ }
  }
  return null;
}

export function extractFaqFromContent(fileContent, articleId) {
  // Use escape-aware regex: (?:[^'\\]|\\.)* correctly skips \' sequences.
  // `g` + last match: a duplicate `.faq` key (merge residue) resolves to
  // the LAST occurrence at runtime (JS object literal semantics), so
  // that's the value actually live — matching only the first would read
  // dead content and mis-detect the locale. Ancorata all'id: vedi `faqKeyRx`.
  const matches = [...fileContent.matchAll(new RegExp(`${faqKeyRx(articleId)}\\s*:\\s*'((?:[^'\\\\]|\\\\.)*)'\\s*[,}]`, 'g'))];
  if (!matches.length) return null;
  return parseFaqLiteral(matches[matches.length - 1][1]);
}

const MIN_FAQ_PAIRS = 3;

/**
 * Discover articles that need work:
 * - needsGeneration: IT has no .faq key → needs AI generation
 * - needsTopUp: IT .faq exists but < MIN_FAQ_PAIRS → needs extra AI pairs
 * - needsTranslation: EN/DE/FR missing or wrong locale
 */
function discoverArticles() {
  const itDir = resolve(BODY_DIR, 'it');
  const files = readdirSync(itDir).filter(f => f.endsWith('.ts')).sort();
  const needsGeneration = [];
  const needsTopUp = [];
  const needsTranslation = [];

  for (const file of files) {
    const itPath = `${BODY_DIR}/it/${file}`;
    const itContent = read(itPath);
    const articleId = extractArticleId(itContent, file);
    if (!articleId) continue;

    const itHasFaq = hasFaqKey(itContent, articleId);

    if (!itHasFaq) {
      needsGeneration.push({ id: articleId, file, itContent });
      continue;
    }

    // IT FAQ exists — check pair count and locale translations
    const itFaq = extractFaqFromContent(itContent, articleId);
    if (!itFaq || itFaq.length === 0) continue;

    // Top-up: not enough pairs
    if (itFaq.length < MIN_FAQ_PAIRS) {
      needsTopUp.push({ id: articleId, file, itContent, existingFaq: itFaq });
    }

    // Translation: check each non-IT locale
    const missingLocales = [];
    for (const locale of ['en', 'de', 'fr']) {
      const localePath = `${BODY_DIR}/${locale}/${file}`;
      if (!existsSync(resolve(localePath))) continue;
      const locContent = read(localePath);
      if (!hasFaqKey(locContent, articleId)) {
        missingLocales.push(locale);
      } else {
        const localeFaq = extractFaqFromContent(locContent, articleId);
        if (localeFaq && isWrongLocale(localeFaq, locale)) {
          missingLocales.push(locale);
        }
      }
    }

    if (missingLocales.length > 0) {
      needsTranslation.push({ id: articleId, file, itFaq, missingLocales });
    }
  }

  return { needsGeneration, needsTopUp, needsTranslation };
}

// ── FAQ generation via AI ────────────────────────────────────

// Preferred models for FAQ (Gemini free tier — reliable JSON output)
const FAQ_MODELS = [
  AI_MODELS.GEMINI_FLASH,
  // Era AI_MODELS.GEMINI_2_FLASH, ritirato da Google il 2026-08-14 (HTTP 404 "no
  // longer available"). Resta in AI_MODELS perche' il matcher del 404 lo esaurisce
  // da solo al primo tentativo, ma non ha senso metterlo QUI come preferenza: una
  // catena di preferenza dovrebbe nominare modelli vivi.
  AI_MODELS.GEMINI_FLASH_LITE_LATEST,
  AI_MODELS.GEMINI_FLASH_LITE,
];

// Rate limiter: space out calls to avoid 503 on Gemini free tier (15 RPM).
// Reserve a slot SYNCHRONOUSLY (read + write _nextSlotMs with no await between)
// so the parallel workers (runWithConcurrency, --concurrency up to 5) each get a
// distinct minGapMs-spaced slot instead of all reading the same timestamp,
// waiting the same delta, and bursting → 503 on Gemini's free tier, which would
// degrade the FAQPage JSON-LD on indexed article pages.
let _nextSlotMs = 0;
async function rateLimitedDelay() {
  const minGapMs = 4500; // ~13 RPM max, safe for Gemini free tier
  const now = Date.now();
  const slot = Math.max(now, _nextSlotMs);
  _nextSlotMs = slot + minGapMs;
  const wait = slot - now;
  if (wait > 0) {
    await new Promise((r) => setTimeout(r, wait));
  }
}

async function callFaqModel(messages, opts = {}) {
  await rateLimitedDelay();
  // Try Gemini models first — force-clear exhaustion from previous runs
  // (ScoreStore persists exhaustion to Firestore, but with rate limiting we're safe)
  for (const model of FAQ_MODELS) {
    try {
      resetExhaustedModel(model);
      return await callSingleModel(messages, { ...opts, model, maxRetriesPerModel: 4, backoffMs: 5000 });
    } catch {
      // Model genuinely failed — try next Gemini variant
    }
  }
  // All Gemini failed — fall back to general chain
  return callLLM(messages, opts);
}

/**
 * Enrich body context when the article body is genuinely short.
 * Instead of skipping, synthesize a richer explainer from the article ID
 * (and whatever body text is available) so the FAQ generator has something
 * to work with. Does NOT modify the article body files — only produces an
 * in-memory context string used for FAQ generation.
 */
async function enrichBodyForFaq(articleId, shortBody) {
  const topic = articleId.replace(/-/g, ' ');
  const prompt = `Sei un esperto di lavoro transfrontaliero Svizzera-Italia. Scrivi un testo informativo in italiano (circa 1500-2500 parole) sull'argomento seguente, con dati concreti, cifre, riferimenti normativi 2026 e aspetti pratici rilevanti per un frontaliere italiano che lavora in Ticino.

ARGOMENTO (dallo slug dell'articolo): "${topic}"

${shortBody && shortBody.trim().length > 0 ? `TESTO ESISTENTE (estendilo e arricchiscilo, NON ripeterlo identicamente):\n${shortBody.slice(0, 2000)}\n` : ''}
REGOLE:
- Copri aspetti DIVERSI: contesto, normativa, dati, calcoli di esempio, casi pratici, scadenze, errori comuni
- Dati concreti (aliquote, importi CHF/EUR, soglie, anni)
- Tono professionale, non promozionale
- NON generare FAQ o domande qui — solo contenuto informativo continuo
- Usa apostrofi diritti ('), mai virgolette curve
- Rispondi SOLO con il testo, senza titoli markdown iniziali, senza code fences

Scrivi ora il testo:`;

  const raw = await callFaqModel(
    [{ role: 'user', content: prompt }],
    { temperature: 0.5, maxTokens: 4000 },
  );
  const text = String(raw || '').replace(/^```[a-z]*\s*/i, '').replace(/\s*```\s*$/, '').trim();
  return text;
}

// Salvage last resort: pull out whichever {"q":"...","a":"..."} objects are
// already complete in a response that got cut off mid-array (maxTokens hit
// before the model finished) — JSON.parse-per-field un-escapes properly
// (handles the same embedded-quote/apostrophe content extractFaqFromText's
// plain-label regex can't), and any still-incomplete trailing object is
// simply not matched, so nothing malformed leaks through.
function _extractCompleteJsonFaqPairs(raw) {
  const pairs = [];
  const objRe = /\{\s*"q"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,\s*"a"\s*:\s*"((?:[^"\\]|\\.)*)"\s*\}/g;
  let m;
  while ((m = objRe.exec(raw)) !== null) {
    try {
      pairs.push({ q: JSON.parse(`"${m[1]}"`), a: JSON.parse(`"${m[2]}"`) });
    } catch {
      // Malformed individual pair — skip, keep scanning for the rest.
    }
  }
  return pairs;
}

function _isTruncationError(err) {
  return /Unterminated|Unexpected end/i.test(err?.message || '');
}

function _faqPrompt({ isTopUp, needed, existingQs, bodyText }) {
  const countInstruction = isTopUp
    ? `genera esattamente ${needed} coppie FAQ (domanda/risposta) NUOVE in italiano.\n\nDOMANDE GIÀ ESISTENTI (NON ripeterle né riformularle):\n- ${existingQs}`
    : `genera ESATTAMENTE 5 coppie FAQ (domanda/risposta) in italiano. Il MINIMO ASSOLUTO è 3 coppie.`;
  const rules = isTopUp
    ? `- Le nuove FAQ devono coprire aspetti DIVERSI da quelli già presenti`
    : `- Genera ALMENO 3 coppie, idealmente 5\n- Le FAQ devono coprire aspetti DIVERSI dell'articolo\n- NON ripetere il titolo dell'articolo nelle domande`;

  return `Sei un esperto di lavoro transfrontaliero Svizzera-Italia. Leggi questo articolo e ${countInstruction}

REGOLE:
${rules}
- Ogni domanda deve essere una query di ricerca naturale che un frontaliere potrebbe digitare su Google
- Ogni risposta deve essere concisa e autosufficiente (40-80 parole), con dati concreti
- Usa apostrofi diritti ('), mai virgolette curve

ARTICOLO:
${bodyText.slice(0, 6000)}

${JSON_QUOTE_SAFETY_RULE_IT}

Rispondi SOLO con un JSON array (no markdown, no code fences):
[{"q":"Domanda 1?","a":"Risposta 1."},{"q":"Domanda 2?","a":"Risposta 2."}]`;
}

async function _generateFaqITAttempt(bodyText, maxTokens) {
  const prompt = _faqPrompt({ isTopUp: false, bodyText });

  const raw = await callFaqModel(
    [{ role: 'user', content: prompt }],
    { temperature: 0.5, maxTokens, jsonMode: true },
  );

  const repaired = repairJsonArray(raw);
  let parsed;
  try {
    parsed = JSON.parse(repaired);
  } catch (parseErr) {
    // Try extracting Q&A pairs via regex as last resort
    const regexFaq = extractFaqFromText(raw);
    if (regexFaq && regexFaq.length >= 2) return regexFaq;
    // A cut-off array (maxTokens hit mid-generation) still has complete
    // leading pairs worth salvaging instead of discarding the whole response.
    const salvaged = _extractCompleteJsonFaqPairs(repaired);
    if (salvaged.length >= 2) return salvaged;
    console.error(`  [JSON parse failed] ${parseErr.message} — ${describeJsonParseError(repaired, parseErr)}`);
    console.error(`  ${describeRawForDiagnostics(raw)}`);
    throw new Error(`JSON non valido dalla generazione FAQ: ${parseErr.message}`);
  }
  const faq = extractFaqArray(parsed);
  if (!faq) {
    // Try extracting from raw text as last resort
    const regexFaq = extractFaqFromText(raw);
    if (regexFaq && regexFaq.length >= 2) return regexFaq;
    console.error(`  [extractFaqArray null] type=${typeof parsed} keys=${parsed ? Object.keys(parsed).join(',') : 'N/A'} ${describeRawForDiagnostics(raw)}`);
    throw new Error('FAQ response is not an array');
  }
  return faq;
}

// Live incident: a redazione article's FAQ generation died on a single
// malformed-JSON response ("Unterminated string in JSON") with zero retries
// — the regex last-resort fallback only recognizes labeled plain-text Q&A
// ("Domanda: ... Risposta: ..."), not a truncated JSON array, so it couldn't
// recover either. generateTopUpFaqIT (below) hits the same LLM-JSON-array
// shape with the same single-attempt fragility, so both share this retry
// wrapper rather than duplicating the loop.
//
// Follow-up (same article, next publish attempt): the retry alone wasn't
// enough — all 3 attempts truncated identically at maxTokens:2000, each
// cutting off mid-answer at a different point (raw response lengths ~1300,
// ~2330, ~2350 chars each time — real content, not a corruption artifact,
// see the salvage extractor above), because this article's 5 detailed
// 40-80-word answers plus JSON overhead don't fit in 2000 tokens. Escalating
// maxTokens on a detected truncation mirrors translateArticle's
// callWithRetry elsewhere in this pipeline (3x on truncation, capped) instead
// of retrying the exact same insufficient budget 3 times for an identical
// result.
async function _withFaqRetry(label, attemptFn) {
  let lastErr;
  let maxTokens = 2000;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await attemptFn(maxTokens);
    } catch (err) {
      lastErr = err;
      console.error(`  ⚠️  ${label} tentativo ${attempt} fallito: ${err.message}`);
      if (_isTruncationError(err)) maxTokens = Math.min(maxTokens * 2, 8000);
    }
  }
  throw lastErr;
}

export async function generateFaqIT(articleId, bodyText) {
  return _withFaqRetry('generateFaqIT', (maxTokens) => _generateFaqITAttempt(bodyText, maxTokens));
}

async function _generateTopUpFaqITAttempt(bodyText, existingFaq, maxTokens) {
  const needed = MIN_FAQ_PAIRS - existingFaq.length;
  const existingQs = existingFaq.map(p => p.q).join('\n- ');
  const prompt = _faqPrompt({ isTopUp: true, needed: needed + 2, existingQs, bodyText });

  const raw = await callFaqModel(
    [{ role: 'user', content: prompt }],
    { temperature: 0.5, maxTokens, jsonMode: true },
  );

  const repaired = repairJsonArray(raw);
  let parsed;
  try {
    parsed = JSON.parse(repaired);
  } catch (parseErr) {
    const regexFaq = extractFaqFromText(raw);
    if (regexFaq && regexFaq.length >= 1) return regexFaq;
    const salvaged = _extractCompleteJsonFaqPairs(repaired);
    if (salvaged.length >= 1) return salvaged;
    console.error(`  [JSON parse failed] ${parseErr.message} — ${describeJsonParseError(repaired, parseErr)}`);
    console.error(`  ${describeRawForDiagnostics(raw)}`);
    throw new Error(`JSON non valido dalla generazione top-up FAQ: ${parseErr.message}`);
  }
  const faq = extractFaqArray(parsed);
  if (!faq) {
    const regexFaq = extractFaqFromText(raw);
    if (regexFaq && regexFaq.length >= 1) return regexFaq;
    throw new Error('Top-up FAQ response is not an array');
  }

  // Deduplicate: remove any pair whose question is too similar to existing ones
  const existingLower = existingFaq.map(p => p.q.toLowerCase());
  return faq.filter(p => {
    const qLower = p.q.toLowerCase();
    return !existingLower.some(eq => eq === qLower || eq.includes(qLower) || qLower.includes(eq));
  });
}

/**
 * Generate additional FAQ pairs to reach MIN_FAQ_PAIRS (3-5).
 * Provides existing FAQ so AI avoids duplicates.
 *
 * Shares _withFaqRetry with generateFaqIT (PR #3629 review): same LLM-JSON-
 * array shape, same single-attempt fragility to a malformed/truncated
 * response.
 */
export async function generateTopUpFaqIT(articleId, bodyText, existingFaq) {
  return _withFaqRetry('generateTopUpFaqIT', (maxTokens) => _generateTopUpFaqITAttempt(bodyText, existingFaq, maxTokens));
}

async function translateFaq(faqArray, targetLang) {
  const results = [];
  for (const pair of faqArray) {
    const [translatedQ, translatedA] = await Promise.all([
      freeTranslateWithRetry({ text: pair.q, sourceLang: 'it', targetLang }),
      freeTranslateWithRetry({ text: pair.a, sourceLang: 'it', targetLang }),
    ]);
    if (translatedQ && translatedA && translatedQ.length > 10 && translatedA.length > 20) {
      results.push({ q: translatedQ, a: translatedA });
    } else {
      results.push(pair); // Keep Italian pair as fallback
    }
  }
  return results.length > 0 ? results : null;
}

/** Validate FAQ array: min 1 pair, q>10 chars, a>20 chars */
function validateFaq(faq) {
  if (!Array.isArray(faq)) return null;
  const valid = faq
    .filter(pair =>
      pair && typeof pair.q === 'string' && typeof pair.a === 'string' &&
      pair.q.length > 10 && pair.a.length > 20
    )
    .slice(0, 7); // Cap at 7 pairs
  return valid.length >= 1 ? valid : null;
}

// ── File modification ────────────────────────────────────────

/** Replace existing FAQ value in a body file */
export function replaceFaqInBodyFile(filePath, faqArray, articleId) {
  let content = read(filePath);
  // `escapeForSingleQuoteTS`, non una `.replace()` a mano: quella escapava
  // l'apostrofo e NON il backslash, quindi il `\"` che JSON.stringify produce
  // per ogni virgoletta finiva verbatim nel literal TS, il parser TS lo leggeva
  // come `"` e il documento JSON si spaccava. Il percorso di INSERT qui sotto
  // usava gia' la funzione giusta: solo questo di REPLACE era rimasto indietro.
  //
  // La validazione post-scrittura qui sotto non lo vedeva e non poteva vederlo:
  // controlla la sintassi JS del file, e un literal TS con un backslash di
  // troppo e' sintatticamente perfetto. Il difetto e' nel LIVELLO ANNIDATO, e
  // si manifesta solo quando qualcun altro fa JSON.parse del valore.
  const jsonStr = escapeForSingleQuoteTS(JSON.stringify(faqArray));
  // Use escape-aware regex: (?:[^'\\]|\\.)* correctly skips \' sequences.
  // `g` + last match: write the occurrence that is actually LIVE at
  // runtime — a duplicate `.faq` key resolves to the last one in a JS
  // object literal, same reasoning as extractFaqFromContent above.
  // Ancorata all'id (`faqKeyRx`): qui la mancanza dell'ancora non e' un
  // rapporto sbagliato, e' la FAQ di un articolo scritta sopra quella di un altro.
  const matches = [...content.matchAll(new RegExp(`(${faqKeyRx(articleId)}\\s*:\\s*')((?:[^'\\\\]|\\\\.)*)('\\s*,)`, 'g'))];
  if (!matches.length) return false;
  const last = matches[matches.length - 1];
  const start = last.index;
  const end = start + last[0].length;
  const replaced = content.slice(0, start) + last[1] + jsonStr + last[3] + content.slice(end);
  // Post-write validation: strip TS type annotations before JS syntax check
  try {
    new Function(replaced.replace(/:\s*Record<[^>]+>\s*=/g, ' =').replace(/^export default .+$/m, ''));
  } catch (syntaxErr) {
    console.error(`  ❌ replaceFaqInBodyFile produced invalid TS in ${filePath}: ${syntaxErr.message}`);
    return false;
  }
  write(filePath, replaced);
  return true;
}

/**
 * Insert FAQ key into a body file.
 * Finds the last body key line and appends the FAQ key after it, before `};`
 */
export function insertFaqIntoBodyFile(filePath, articleId, faqArray) {
  let content = read(filePath);

  // Already has FAQ? Replace instead of insert.
  if (hasFaqKey(content, articleId)) {
    return replaceFaqInBodyFile(filePath, faqArray, articleId);
  }

  const faqJsonStr = JSON.stringify(faqArray);
  const escapedFaq = escapeForSingleQuoteTS(faqJsonStr);
  const faqLine = `    'blog.article.${articleId}.faq': '${escapedFaq}',`;

  // Strategy: insert before the closing `};`
  // Find the last property line (body3 or similar) and insert after it
  const closingMatch = content.match(/^(\s*)\};\s*$/m);
  if (!closingMatch) {
    console.error(`  ⚠️  Cannot find closing }; in ${filePath}`);
    return false;
  }

  // Insert FAQ line before the `};` line.
  //
  // Il replacer e' una FUNZIONE, non una stringa (issue #395). In una stringa
  // di sostituzione `$1`…`$9`, `$&`, `` $` ``, `$'` e `$$` sono PATTERN, e
  // `faqLine` porta testo FAQ arbitrario: `escapeForSingleQuoteTS` escapa `\`,
  // `'` e `\n`, ma non il `$`. Una risposta che dice «un massimo di $2
  // milioni» si portava dentro il literal il gruppo di cattura 2 — cioe' la
  // coda `};\nexport default` — e il file risultante poteva anche compilare:
  // niente errore, solo testo che nessuno ha scritto, sul percorso di scrittura
  // del corpus pubblicato. Misurato sui 16.676 campi `.faq` vivi: **11**
  // contengono una sequenza che questa regex a tre gruppi avrebbe espansa
  // (`$1`/`$2`/`$3`/`$&`/`` $` ``/`$'`/`$$`) — prezzi e cifre in dollari,
  // «$100,000», «$13.5 billion», «$3.04 billion». Raro, mai rumoroso.
  //
  // Un replacer-funzione non interpreta niente: il valore che torna finisce nel
  // risultato verbatim. E' la stessa forma delle due gemelle che il difetto non
  // ce l'hanno — `replaceFaqInBodyFile` qui sopra («Escape-aware regex +
  // function replacer to avoid $-pattern issues») e `insertFaqKey()` di
  // `fix-faq-locales.mjs`, che ricostruiscono per slicing.
  content = content.replace(
    /(\n)((\s*)\};\s*\n\s*export default)/,
    (_m, _nl, coda) => `\n${faqLine}\n${coda}`,
  );

  // Verify the insertion worked
  if (!hasFaqKey(content, articleId)) {
    // Fallback: more aggressive replacement (stesso replacer-funzione, stessa ragione)
    content = read(filePath);
    content = content.replace(
      /(\.body3':\s*'(?:[^'\\]|\\.)*',)\n(\};)/s,
      (_m, ultimoBody, chiusura) => `${ultimoBody}\n${faqLine}\n${chiusura}`,
    );
  }

  if (!hasFaqKey(content, articleId)) {
    console.error(`  ❌ Failed to insert FAQ into ${filePath}`);
    return false;
  }

  // Post-write validation: strip TS type annotations before JS syntax check
  try {
    new Function(content.replace(/:\s*Record<[^>]+>\s*=/g, ' =').replace(/^export default .+$/m, ''));
  } catch (syntaxErr) {
    console.error(`  ❌ insertFaqIntoBodyFile produced invalid TS in ${filePath}: ${syntaxErr.message}`);
    return false;
  }

  write(filePath, content);
  return true;
}

// ── Process single article ───────────────────────────────────

async function processArticle(articleId, file, itBodyContent) {
  const label = `[${articleId}]`;

  // 1. Extract Italian body text
  // Nessuna chiave `bodyN` per questo id non e' un corpo corto: e' il file
  // sbagliato, o un id sbagliato. Arricchirlo significherebbe pubblicare un
  // articolo scritto dall'LLM a partire dal solo slug (#393, review di #397).
  if (!hasBodyKey(itBodyContent, articleId)) {
    console.error(`${label} ❌ Nessuna chiave bodyN per questo id: non arricchisco, sarebbe un articolo inventato`);
    return { success: false, error: 'No bodyN key for this article id' };
  }
  let bodyText = extractBodyContent(itBodyContent, articleId);
  if (!bodyText || bodyText.length < 200) {
    console.error(`${label} ⚠️  Body text short (${bodyText?.length || 0} chars), enriching before FAQ generation...`);
    try {
      const enriched = await enrichBodyForFaq(articleId, bodyText || '');
      if (!enriched || enriched.length < 500) {
        console.error(`${label} ❌ Enrichment returned too little content (${enriched?.length || 0} chars)`);
        return { success: false, error: 'Body too short (enrichment failed)' };
      }
      bodyText = enriched;
      console.error(`${label} ✅ Enriched body to ${bodyText.length} chars`);
    } catch (enrichErr) {
      console.error(`${label} ❌ Enrichment failed: ${enrichErr.message}`);
      return { success: false, error: `Enrichment failed: ${enrichErr.message}` };
    }
  }

  // 2. Generate Italian FAQ
  // generateFaqIT() already retries internally (3 attempts, PR #3629) — the
  // outer retry-once this caller used to add is now redundant (a genuine
  // failure would cost up to 6 total attempts otherwise).
  console.error(`${label} 🇮🇹 Generating FAQ...`);
  let itFaq;
  try {
    itFaq = await generateFaqIT(articleId, bodyText);
  } catch (err) {
    console.error(`${label} ❌ FAQ generation failed: ${err.message}`);
    return { success: false, error: err.message };
  }

  // 3. Validate — need at least MIN_FAQ_PAIRS. If the first call produced
  // 1-2 valid pairs, top up via a second LLM call instead of failing here.
  let validFaq = validateFaq(itFaq);
  if (validFaq && validFaq.length > 0 && validFaq.length < MIN_FAQ_PAIRS) {
    console.error(`${label} ⚠️  Only ${validFaq.length}/${MIN_FAQ_PAIRS} pairs from first call — topping up...`);
    try {
      const extraFaq = await generateTopUpFaqIT(articleId, bodyText, validFaq);
      const extraValid = validateFaq(extraFaq) || [];
      if (extraValid.length > 0) validFaq = validFaq.concat(extraValid);
    } catch (topupErr) {
      console.error(`${label} ⚠️  Top-up call failed: ${topupErr.message}`);
    }
  }
  if (!validFaq || validFaq.length < MIN_FAQ_PAIRS) {
    console.error(`${label} ❌ FAQ validation failed (got ${validFaq?.length || itFaq?.length || 0} pairs, need ≥${MIN_FAQ_PAIRS})`);
    return { success: false, error: `Only ${validFaq?.length || 0} pairs (need ≥${MIN_FAQ_PAIRS})` };
  }
  console.error(`${label} ✅ ${validFaq.length} FAQ pairs generated`);

  // 4. Write Italian FAQ
  const itPath = `${BODY_DIR}/it/${file}`;
  if (!insertFaqIntoBodyFile(itPath, articleId, validFaq)) {
    return { success: false, error: 'Failed to write IT FAQ' };
  }

  // 5. Translate to EN, DE, FR (parallel)
  if (!SKIP_TRANSLATE) {
    const translations = await Promise.allSettled([
      translateFaq(validFaq, 'en'),
      translateFaq(validFaq, 'de'),
      translateFaq(validFaq, 'fr'),
    ]);

    const localeMap = { 0: 'en', 1: 'de', 2: 'fr' };

    for (let i = 0; i < translations.length; i++) {
      const locale = localeMap[i];
      const localePath = `${BODY_DIR}/${locale}/${file}`;

      if (!existsSync(resolve(localePath))) {
        console.error(`${label} ⚠️  ${locale} body file missing, skipping`);
        continue;
      }

      let faqForLocale;
      if (translations[i].status === 'fulfilled' && translations[i].value) {
        faqForLocale = translations[i].value;
        console.error(`${label} ✅ ${locale.toUpperCase()} translated (${faqForLocale.length} pairs)`);
      } else {
        const reason = translations[i].status === 'rejected' ? translations[i].reason?.message : 'null result';
        console.error(`${label} ⚠️  ${locale.toUpperCase()} translation failed: ${reason}, using Italian fallback`);
        faqForLocale = validFaq;
      }

      insertFaqIntoBodyFile(localePath, articleId, faqForLocale);
    }
  }

  return { success: true, faqCount: validFaq.length };
}

// ── Process article top-up (existing FAQ < MIN_FAQ_PAIRS) ────

async function processTopUp(articleId, file, itContent, existingFaq) {
  const label = `[${articleId}] [TOP-UP ${existingFaq.length}→${MIN_FAQ_PAIRS}+]`;

  // Stessa guardia di `processArticle`: niente chiave `bodyN` per questo id
  // significa fermarsi, non arricchire (#393, review di #397).
  if (!hasBodyKey(itContent, articleId)) {
    console.error(`${label} ❌ Nessuna chiave bodyN per questo id: non arricchisco, sarebbe un articolo inventato`);
    return { success: false, error: 'No bodyN key for this article id' };
  }
  let bodyText = extractBodyContent(itContent, articleId);
  if (!bodyText || bodyText.length < 200) {
    console.error(`${label} ⚠️  Body short (${bodyText?.length || 0} chars), enriching before top-up...`);
    try {
      const enriched = await enrichBodyForFaq(articleId, bodyText || '');
      if (!enriched || enriched.length < 500) {
        console.error(`${label} ❌ Enrichment returned too little content (${enriched?.length || 0} chars)`);
        return { success: false, error: 'Body too short (enrichment failed)' };
      }
      bodyText = enriched;
      console.error(`${label} ✅ Enriched body to ${bodyText.length} chars`);
    } catch (enrichErr) {
      console.error(`${label} ❌ Enrichment failed: ${enrichErr.message}`);
      return { success: false, error: `Enrichment failed: ${enrichErr.message}` };
    }
  }

  // 1. Generate additional FAQ pairs
  console.error(`${label} 🇮🇹 Generating ${MIN_FAQ_PAIRS - existingFaq.length}+ extra FAQ pairs...`);
  let newPairs;
  try {
    newPairs = await generateTopUpFaqIT(articleId, bodyText, existingFaq);
  } catch (err) {
    console.error(`${label} ❌ Top-up generation failed: ${err.message}`);
    return { success: false, error: err.message };
  }

  if (!newPairs || newPairs.length === 0) {
    console.error(`${label} ❌ No new pairs generated`);
    return { success: false, error: 'No new pairs' };
  }

  // 2. Merge: existing + new, cap at 7
  const merged = [...existingFaq, ...newPairs].slice(0, 7);
  const validMerged = validateFaq(merged);
  if (!validMerged || validMerged.length <= existingFaq.length) {
    console.error(`${label} ❌ No improvement (${validMerged?.length || 0} pairs, had ${existingFaq.length})`);
    return { success: false, error: 'No improvement after merge' };
  }
  console.error(`${label} ✅ ${existingFaq.length} existing + ${newPairs.length} new = ${validMerged.length} total`);

  // 3. Write updated IT FAQ
  const itPath = `${BODY_DIR}/it/${file}`;
  if (!replaceFaqInBodyFile(itPath, validMerged, articleId)) {
    return { success: false, error: 'Failed to write updated IT FAQ' };
  }

  // 4. Translate and update all locales
  if (!SKIP_TRANSLATE) {
    for (const locale of ['en', 'de', 'fr']) {
      const localePath = `${BODY_DIR}/${locale}/${file}`;
      if (!existsSync(resolve(localePath))) continue;

      try {
        const translated = await translateFaq(validMerged, locale);
        if (translated) {
          insertFaqIntoBodyFile(localePath, articleId, translated);
          console.error(`${label} ✅ ${locale.toUpperCase()} translated (${translated.length} pairs)`);
        } else {
          insertFaqIntoBodyFile(localePath, articleId, validMerged);
          console.error(`${label} ⚠️  ${locale.toUpperCase()} translation failed, using Italian`);
        }
      } catch (err) {
        insertFaqIntoBodyFile(localePath, articleId, validMerged);
        console.error(`${label} ⚠️  ${locale.toUpperCase()} error: ${err.message}, using Italian`);
      }
    }
  }

  return { success: true, faqCount: validMerged.length };
}

// ── Process translation-only (IT FAQ ok, locale missing/wrong) ──

async function processTranslation(articleId, file, itFaq, missingLocales) {
  const label = `[${articleId}] [TRANSLATE ${missingLocales.join(',')}]`;
  let fixed = 0;

  for (const locale of missingLocales) {
    const localePath = `${BODY_DIR}/${locale}/${file}`;
    if (!existsSync(resolve(localePath))) continue;

    try {
      const translated = await translateFaq(itFaq, locale);
      if (translated) {
        insertFaqIntoBodyFile(localePath, articleId, translated);
        console.error(`${label} ✅ ${locale.toUpperCase()} (${translated.length} pairs)`);
        fixed++;
      } else {
        console.error(`${label} ⚠️  ${locale.toUpperCase()} translation null`);
      }
    } catch (err) {
      console.error(`${label} ❌ ${locale.toUpperCase()}: ${err.message}`);
    }
  }

  return { success: fixed > 0, faqCount: fixed };
}

// ── Concurrency control ──────────────────────────────────────

async function runWithConcurrency(tasks, concurrency) {
  const results = [];
  let idx = 0;

  async function worker() {
    while (idx < tasks.length) {
      const currentIdx = idx++;
      results[currentIdx] = await tasks[currentIdx]();
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

// ── Main ─────────────────────────────────────────────────────

async function main() {
  console.error('═══════════════════════════════════════════════════════════');
  console.error('  batch-add-faq-to-articles.mjs');
  console.error('═══════════════════════════════════════════════════════════');
  console.error(`  Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
  console.error(`  Concurrency: ${CONCURRENCY}`);
  console.error(`  Limit: ${LIMIT === Infinity ? 'none' : LIMIT}`);
  console.error(`  Translate: ${SKIP_TRANSLATE ? 'NO (Italian only)' : 'YES (all 4 locales)'}`);
  console.error('');

  // Initialize AI model scoring
  if (!DRY_RUN) {
    await initScoreStore();
  }

  // 1. Discover articles needing work
  console.error('📂 Scanning articles...');
  const { needsGeneration, needsTopUp, needsTranslation } = discoverArticles();
  console.error(`   🆕 Need generation:  ${needsGeneration.length}`);
  console.error(`   📈 Need top-up (<${MIN_FAQ_PAIRS} pairs): ${needsTopUp.length}`);
  console.error(`   🌐 Need translation: ${needsTranslation.length}`);

  // 2. Load progress and filter already-completed (only for generation)
  const progress = loadProgress();
  const completedSet = new Set(progress.completed);
  const pendingGeneration = needsGeneration.filter(a => !completedSet.has(a.id));
  console.error(`   Already generated:  ${progress.completed.length}`);
  console.error(`   Pending generation: ${pendingGeneration.length}`);

  const totalWork = pendingGeneration.length + needsTopUp.length + needsTranslation.length;
  if (totalWork === 0) {
    console.error('\n✅ Nothing to process — all articles have ≥3 FAQ pairs in all locales.');
    return;
  }

  // 3. Apply limit (generation first, then top-up, then translation)
  let remaining = LIMIT;
  const genSlice = pendingGeneration.slice(0, remaining);
  remaining -= genSlice.length;
  const topUpSlice = needsTopUp.slice(0, remaining);
  remaining -= topUpSlice.length;
  const transSlice = needsTranslation.slice(0, remaining);
  console.error(`   Will process: ${genSlice.length} gen + ${topUpSlice.length} top-up + ${transSlice.length} translate`);
  console.error('');

  // 4. Dry run
  if (DRY_RUN) {
    console.error('── DRY RUN ──');
    if (genSlice.length > 0) {
      console.error('\n🆕 Generation:');
      for (const a of genSlice) console.error(`  • ${a.id}`);
    }
    if (topUpSlice.length > 0) {
      console.error(`\n📈 Top-up (to ≥${MIN_FAQ_PAIRS} pairs):`);
      for (const a of topUpSlice) console.error(`  • ${a.id} (${a.existingFaq.length} → ${MIN_FAQ_PAIRS}+)`);
    }
    if (transSlice.length > 0) {
      console.error('\n🌐 Translation:');
      for (const a of transSlice) console.error(`  • ${a.id} [${a.missingLocales.join(',')}]`);
    }
    return;
  }

  // 5. Process all work
  let successCount = 0;
  let failCount = 0;
  let totalFaq = 0;
  let step = 0;
  const totalSteps = genSlice.length + topUpSlice.length + transSlice.length;

  // 5a. Generation tasks
  const genTasks = genSlice.map((article) => async () => {
    step++;
    console.error(`\n[${step}/${totalSteps}] 🆕 ${article.id}`);
    const result = await processArticle(article.id, article.file, article.itContent);
    if (result.success) {
      successCount++;
      totalFaq += result.faqCount || 0;
      progress.completed.push(article.id);
    } else {
      failCount++;
      progress.failed.push({ id: article.id, error: result.error, at: new Date().toISOString() });
    }
    saveProgress(progress);
    commitIfNeeded(step);
    return result;
  });

  // 5b. Top-up tasks
  const topUpTasks = topUpSlice.map((article) => async () => {
    step++;
    console.error(`\n[${step}/${totalSteps}] 📈 ${article.id} (${article.existingFaq.length} pairs)`);
    const result = await processTopUp(article.id, article.file, article.itContent, article.existingFaq);
    if (result.success) {
      successCount++;
      totalFaq += result.faqCount || 0;
    } else {
      failCount++;
    }
    commitIfNeeded(step);
    return result;
  });

  // 5c. Translation tasks
  const transTasks = transSlice.map((article) => async () => {
    step++;
    console.error(`\n[${step}/${totalSteps}] 🌐 ${article.id} [${article.missingLocales.join(',')}]`);
    const result = await processTranslation(article.id, article.file, article.itFaq, article.missingLocales);
    if (result.success) successCount++;
    else failCount++;
    commitIfNeeded(step);
    return result;
  });

  await runWithConcurrency([...genTasks, ...topUpTasks, ...transTasks], CONCURRENCY);

  // 6. Flush AI model scores
  try {
    await flushScores();
  } catch {
    // Non-critical
  }

  // 7. Summary
  const stats = getStats();
  console.error('\n═══════════════════════════════════════════════════════════');
  console.error('  SUMMARY');
  console.error('═══════════════════════════════════════════════════════════');
  console.error(`  Total processed:    ${successCount + failCount}`);
  console.error(`  ✅ Succeeded:       ${successCount}`);
  console.error(`  ❌ Failed:          ${failCount}`);
  console.error(`  🆕 Generated:       ${genSlice.length}`);
  console.error(`  📈 Top-ups:         ${topUpSlice.length}`);
  console.error(`  🌐 Translations:    ${transSlice.length}`);
  console.error(`  🤖 AI calls:        ${stats.calls || 0}`);
  console.error(`  🔄 AI fallbacks:    ${stats.fallbacks || 0}`);
  console.error(`  📊 Total completed: ${progress.completed.length}/${needsGeneration.length + progress.completed.length}`);
  console.error('═══════════════════════════════════════════════════════════');
  // FRO-325: full run summary (cache hits, exhausted models, cooldowns,
  // 429 streaks, error count) — superset of the calls/fallbacks lines
  // above, not tracked anywhere else in this script (#3091).
  printRunSummary();

  // Translation cascade stats
  try { logCascadeSummary(); } catch { /* optional */ }

  if (failCount > 0) {
    console.error('\n❌ Failed articles:');
    for (const f of progress.failed.slice(-failCount)) {
      console.error(`  • ${f.id}: ${f.error}`);
    }
  }
}

// Only auto-run the batch job when this file is executed directly (`node
// batch-add-faq-to-articles.mjs`) — NOT when it's imported elsewhere just to
// reuse `generateFaqIT` (e.g. publish-journalist-article.mjs), which would
// otherwise trigger the entire batch scan as an import side effect.
if (import.meta.url === `file://${process.argv[1]}`) {
  installSigtermCheckpoint();
  main().catch(err => {
    console.error(`\n💥 Fatal error: ${err.message}`);
    console.error(err.stack);
    process.exit(1);
  });
}
