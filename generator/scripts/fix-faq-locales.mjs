#!/usr/bin/env node
/**
 * fix-faq-locales.mjs
 * 
 * Scans EN/DE/FR blog body files for FAQ keys that are still in Italian
 * or missing entirely. Uses the same detection (trigram-based detectLanguage)
 * and translation (freeTranslateWithRetry cascade) as the job crawlers.
 *
 * Usage:
 *   node scripts/fix-faq-locales.mjs [--dry-run] [--limit N] [--section=frontaliere|svizzera]
 *
 * `--reescape-broken` e' una modalita' a se': non traduce e non chiama nessun
 * modello, riscrive soltanto le chiavi `.faq` prodotte dall'escape rotto che
 * questo file usava fino a oggi (vedi il blocco «Il literal TS che porta
 * l'array FAQ»). Opt-in: la run schedulata non la passa.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync, renameSync, mkdirSync } from 'fs';
import { createHash } from 'crypto';
import { resolve, basename } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname } from 'path';
import { freeTranslateWithRetry, logCascadeSummary } from './lib/free-translate.mjs';
import { detectLanguageWithConfidence } from './lib/detect-language.mjs';
import { corpusPath } from './lib/corpus-paths.mjs';
import { sanitizeText } from '../../scripts/lib/sanitize-control-chars.mjs';
import { parsePositiveNum } from '../../scripts/lib/parse-positive-num.mjs';
import { reportStrippedControlChars } from './lib/control-char-write-report.mjs';
import { escapeForSingleQuoteTS, unescapeForSingleQuoteTS } from './lib/article-meta-block.mjs';

// Write-time guard (issue #66): strip any C0 control character other than
// TAB/LF/CR before it reaches content/ — same rule as create-article.mjs write().
//
// Commits via temp+rename (issue #561, same rule as create-article.mjs's
// write()): this rewrites an EXISTING content/*.faq body in place, reached
// from `batch-faq-articles.yml` (`timeout-minutes`, same SIGKILL mechanism
// issue #561 fixes) — a direct writeFileSync on the target can leave it
// truncated mid-write. `renameSync` is a single POSIX syscall, atomic on the
// same filesystem; the temp file lives next to the target so the rename
// never crosses a filesystem boundary.
let writeTmpSeq = 0;
function writeCorpusFile(filePath, content) {
  const clean = sanitizeText(content);
  // Non basta togliere il byte: toglierlo distrugge il MARKER che rende
  // esatta una riparazione futura (issue #95). Si registra prima, con il
  // contesto che conserva la coppia (byte, carattere seguente).
  reportStrippedControlChars(filePath, content, clean);
  const tmp = `${filePath}.${process.pid}.${writeTmpSeq++}.tmp`;
  try {
    writeFileSync(tmp, clean, 'utf-8');
    renameSync(tmp, filePath);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* best-effort cleanup */ }
    throw err;
  }
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// `../..`: the transport moved this from `scripts/` to `generator/scripts/`,
// so one level up is now the generator directory, not the repo root.
const ROOT = resolve(__dirname, '..', '..');

const args = process.argv.slice(2);
const HELP = args.includes('--help') || args.includes('-h');
// `DRY_RUN=1` e' la convenzione del generator, non un extra: e' cio' che
// `generator/tests/dry-run-entrypoints.mjs` passa a ogni entry point per
// caricarlo senza fargli toccare il corpus. Questo script non la onorava — ne'
// quella ne' `--help` — e finiva per fare lavoro vero mentre l'armatura
// credeva di starlo solo importando. Non si vedeva perche' il lettore rotto lo
// rendeva cieco su quasi tutto: appena ha ricominciato a vedere, ha scritto.
// E' lo stesso difetto che l'intestazione di quell'armatura racconta per
// generate-border-wait-ranking-article.mjs, che riscrisse quattro body.
const DRY_RUN = args.includes('--dry-run') || process.env.DRY_RUN === '1';
export function normalizeFaqLimit(value) {
  if (value === undefined) return Infinity;
  const raw = String(value).trim();
  if (!raw) throw new RangeError('--limit richiede un intero >= 0');
  const parsed = parsePositiveNum(raw, Number.NaN, {
    label: '--limit',
    integer: true,
    sentinels: [0],
    warn: () => {},
  });
  if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  throw new RangeError(`--limit richiede un intero >= 0; ricevuto ${String(value)}`);
}

export function parseFaqLimitArgs(argv) {
  const limitIdx = argv.indexOf('--limit');
  if (limitIdx < 0) return Infinity;
  const value = argv[limitIdx + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new RangeError('--limit richiede un valore intero >= 0');
  }
  return normalizeFaqLimit(value);
}

function parseFaqLimitOrExit(argv) {
  try {
    return parseFaqLimitArgs(argv);
  } catch (err) {
    console.error(`Invalid --limit: ${err.message}`);
    process.exit(2);
  }
}

const LIMIT = parseFaqLimitOrExit(args);
// Riparazione pura dei file gia' scritti con l'escape rotto: nessuna chiamata
// di traduzione, nessun modello. Opt-in, e la run schedulata NON lo passa.
const REESCAPE_BROKEN = args.includes('--reescape-broken');

// ── Section selection (--section=frontaliere|svizzera, default frontaliere) ──
// Switches the body-dir enumeration between the cross-border and the
// Switzerland-wide article sets. frontaliere is byte-identical.
function getSectionArg() {
  let section = 'frontaliere';
  for (const a of args) {
    const m = /^--section=(.+)$/.exec(a);
    if (m) section = m[1];
  }
  const inlineIdx = args.indexOf('--section');
  if (inlineIdx >= 0 && args[inlineIdx + 1] && !args[inlineIdx + 1].startsWith('--')) {
    section = args[inlineIdx + 1];
  }
  if (!['frontaliere', 'svizzera'].includes(section)) {
    console.error(`Invalid --section="${section}". Valid: frontaliere, svizzera`);
    process.exit(1);
  }
  return section;
}
const SECTION = getSectionArg();
const SECTION_BODY_SUBDIR = SECTION === 'svizzera' ? 'blog-body-ch' : 'blog-body';

const BODY_DIR = resolve(ROOT, corpusPath(`services/locales/${SECTION_BODY_SUBDIR}`));

// ── Il literal TS che porta l'array FAQ ─────────────────────
//
// La chiave `.faq` non e' testo: e' un documento JSON che vive dentro una
// stringa TypeScript a singoli apici. Ci sono quindi DUE codifiche annidate, e
// l'unico modo di non sbagliarle e' che scrittore e lettore siano l'uno
// l'inverso dell'altro — che e' precisamente cio' che qui mancava.
//
// Lo scrittore precedente escapava l'apostrofo e NON il backslash:
//
//     JSON.stringify(faqArray).replace(/'/g, "\\'")
//
// `JSON.stringify` produce `\"` per ogni virgoletta nel testo della FAQ. Senza
// raddoppiare il backslash, quel `\"` finisce verbatim nel literal TS, il
// parser TS lo legge come `"` — e il JSON si spacca a meta' di una stringa.
// Nessuno se ne accorge alla scrittura: il file `.ts` compila lo stesso, il
// commit passa, e il danno si vede solo dove il documento viene riletto.
// A valle `engine/ogPagesPlugin.ts` fa `JSON.parse` del valore per emettere il
// FAQPage JSON-LD, la `JSON.parse` lancia, il `catch` e' vuoto — e la pagina
// esce senza rich result e senza accordion, con la CI verde.
//
// Misurato su origin/main a08f37e8: 72 file body su 15.560 con chiave `.faq`.

/** Il corpo del literal TS che rappresenta `faqArray`. */
export function serializeFaqLiteral(faqArray) {
  return escapeForSingleQuoteTS(JSON.stringify(faqArray));
}

/**
 * Legge il corpo di un literal TS che dovrebbe contenere un array FAQ.
 *
 * Prova due decodifiche, nell'ordine, e dice QUALE ha funzionato:
 *   1. quella esatta — l'inverso di `escapeForSingleQuoteTS`, il formato che
 *      questo script scrive da adesso e che `create-article.mjs` ha sempre
 *      scritto;
 *   2. quella LEGACY — l'inverso dello scrittore rotto descritto sopra, che e'
 *      il formato in cui stanno i file gia' prodotti.
 *
 * Serve leggerle entrambe per due ragioni distinte. Senza la (1) lo script
 * diventerebbe cieco su cio' che scrive lui stesso, e su ogni FAQ italiana che
 * contiene una virgoletta: `extractFaqFromFile` tornerebbe `null`, l'articolo
 * verrebbe saltato in silenzio e la locale non verrebbe mai controllata.
 * Senza la (2) i file gia' rotti diventerebbero illeggibili, e con essi
 * irreparabili.
 *
 * `legacy: true` e' quindi anche il RILEVATORE: e' vero esattamente sui file
 * che vanno riscritti (`--reescape-broken`).
 *
 * @returns {{ pairs: Array|null, legacy: boolean }}
 */
export function parseFaqLiteral(raw) {
  const decoders = [
    [unescapeForSingleQuoteTS, false],
    [(s) => s.replace(/\\'/g, "'"), true],
  ];
  for (const [decode, legacy] of decoders) {
    try {
      const parsed = JSON.parse(decode(raw));
      if (Array.isArray(parsed)) return { pairs: parsed, legacy };
    } catch { /* prova la decodifica successiva */ }
  }
  return { pairs: null, legacy: false };
}

// ── File helpers ────────────────────────────────────────────

// Escape-aware regex: (?:[^'\\]|\\.)* correctly skips \' sequences.
// `g` + last match: a duplicate `.faq` key (merge residue) resolves to
// the LAST occurrence at runtime (JS object literal semantics), so
// that's the value actually live — matching only the first would read
// dead content and mis-detect the locale.
//
// ── L'ancora all'id (issue #301 item 2) ─────────────────────
//
// La chiave e' quella dell'articolo in corso, non un `.faq` qualunque nel file:
// stesso pattern con cui #294 ha ancorato i gate di sola lettura
// (`find-dirty-content-ids.mjs`, `faqQuestionsInBodyText`), id ESCAPATO per la
// regex. Le due regole non si escludono: si legge e si scrive l'ULTIMA
// occorrenza DEL PROPRIO id.
//
// L'id e' il NOME DEL FILE — e' la definizione che `main()` usa gia'
// (`basename(file, '.ts')`), quindi ricavarlo dal path che queste funzioni
// ricevono da' esattamente lo stesso id senza cambiare i chiamanti. Il
// parametro resta esplicito per i test e per un chiamante futuro che
// enumeri un file dove i due non coincidono.
//
// Il pattern e' ricopiato invece che condiviso, come in `find-dirty-content-ids.mjs`
// (#294): questo file e' un gemello `adapted` di uno del sito
// (`scripts/fix-faq-locales.mjs`) e importare qui una lib `corpus-only` aggiungerebbe una
// divergenza in piu' fra i due, per tre righe di regex.
const idOfBodyPath = (filePath) => basename(filePath, '.ts');
const faqKeyRx = (id) => `'blog\\.article\\.${String(id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.faq'`;
const faqValueRe = (id) => new RegExp(`${faqKeyRx(id)}\\s*:\\s*'((?:[^'\\\\]|\\\\.)*)'\\s*[,}]`, 'g');

/** Il literal `.faq` vivo di un file, ancora escapato. `null` se non c'e'. */
function rawFaqLiteral(filePath, id = idOfBodyPath(filePath)) {
  if (!existsSync(filePath)) return null;
  const content = readFileSync(filePath, 'utf-8');
  const matches = [...content.matchAll(faqValueRe(id))];
  return matches.length ? matches[matches.length - 1][1] : null;
}

export function extractFaqFromFile(filePath, id = idOfBodyPath(filePath)) {
  const raw = rawFaqLiteral(filePath, id);
  return raw === null ? null : parseFaqLiteral(raw).pairs;
}

/**
 * Primo argomento: un PATH. L'omonima di `batch-add-faq-to-articles.mjs`
 * prende invece il CONTENUTO del file: passarle un path (o viceversa) non
 * lancia, risponde solo `false` in silenzio.
 */
export function hasFaqKey(filePath, id = idOfBodyPath(filePath)) {
  if (!existsSync(filePath)) return false;
  return new RegExp(`${faqKeyRx(id)}\\s*:`).test(readFileSync(filePath, 'utf-8'));
}

export function replaceFaqInFile(filePath, newFaqArray, id = idOfBodyPath(filePath)) {
  let content = readFileSync(filePath, 'utf-8');
  const jsonStr = serializeFaqLiteral(newFaqArray);
  // Escape-aware regex + function replacer to avoid $-pattern issues.
  // `g` + last match: write the occurrence that is actually LIVE at
  // runtime, same reasoning as extractFaqFromFile above. Ancorata all'id:
  // qui sbagliare chiave non e' un rapporto storto, e' la FAQ di un articolo
  // scritta sopra quella di un altro.
  const matches = [...content.matchAll(new RegExp(`(${faqKeyRx(id)}\\s*:\\s*')((?:[^'\\\\]|\\\\.)*)('\\s*[,}])`, 'g'))];
  if (matches.length) {
    const last = matches[matches.length - 1];
    const start = last.index;
    const end = start + last[0].length;
    content = content.slice(0, start) + last[1] + jsonStr + last[3] + content.slice(end);
  }
  writeCorpusFile(filePath, content);
}

function insertFaqKey(filePath, articleId, faqArray) {
  let content = readFileSync(filePath, 'utf-8');
  const jsonStr = serializeFaqLiteral(faqArray);
  const closingIdx = content.lastIndexOf('};');
  if (closingIdx === -1) return false;
  const faqLine = `    'blog.article.${articleId}.faq': '${jsonStr}',\n`;
  content = content.slice(0, closingIdx) + faqLine + content.slice(closingIdx);
  writeCorpusFile(filePath, content);
  return true;
}

// ── Language detection (same as job crawlers) ───────────────

// `isWrongLocale()` — la versione sul testo CONCATENATO — e' stata tolta invece
// che lasciata accanto inutilizzata. Non e' pulizia: era il difetto. Diluiva la
// coppia sbagliata nella media delle altre, e finche' restava qui il prossimo
// call-site l'avrebbe ripresa perche' ha il nome piu' ovvio dei due.

const normPairText = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

// Segnale minimo per rifiutare una TERZA lingua (ne' l'attesa ne' la sorgente).
// Tarati sulle FAQ pubblicate — la misura sta nel commento di `wrongLocalePair`.
const THIRD_LANG_MIN_CONFIDENCE = 0.6; // affidabilita' dichiarata dal rilevatore
const THIRD_LANG_MIN_SCORE = 500;      // evidenza assoluta, non solo margine
const THIRD_LANG_SHORT_TEXT_CONFIDENCE = 0.85; // ramo strong-marker senza scores

/** La chiave stabile di una coppia FAQ (confronto normalizzato, non `===`). */
function pairKey(pair) {
  if (!pair) return null;
  return `${normPairText(pair.q)}\u0000${normPairText(pair.a)}`;
}

/**
 * La stessa domanda, ma per COPPIA — ed e' quella che serve prima di scrivere.
 *
 * `translateFaqArray()` traduce una coppia alla volta e, quando il motore
 * fallisce, rimette dentro la coppia ITALIANA come fallback
 * (`results.push(pair)`): il fallimento tipico non e' totale, e' parziale. Sul
 * testo concatenato una coppia italiana su otto resta un ottavo del campione,
 * il rilevatore vede il resto in inglese, dice `en`, e l'italiano finisce
 * pubblicato sulla pagina `/en/` dentro il JSON-LD della FAQ. Il gate di
 * scrittura guarda quindi ogni coppia da sola, con la stessa soglia di 50
 * caratteri sotto cui il rilevatore non ha segnale.
 *
 * ── COSA RIFIUTA, E PERCHE' NON PIU' «DIVERSO DALL'ATTESO» ─────────────────
 *
 * Il difetto da intercettare e' il PASSTHROUGH: il testo e' rimasto nella
 * lingua SORGENTE e verrebbe pubblicato come traduzione. Il predicato invece
 * rifiutava su `detected !== expectedLocale`, cioe' su qualunque scarto — e su
 * coppie FAQ, che stanno fra 57 e 89 caratteri, il rilevatore e' incerto
 * proprio fra `en`, `de` e `fr`. Un `de` rilevato su una traduzione inglese non
 * e' un passthrough italiano: e' rumore, e costava caro perche' UNA coppia mal
 * rilevata scarta la traduzione INTERA dell'articolo, che resta senza FAQ.
 *
 * Misurato su una run reale del workflow FAQ (40 articoli, 2026-09-06): 31
 * coppie rifiutate, di cui **solo 8 rilevate `it`** — le altre 23 erano
 * mismatch fra lingue non-sorgente, e hanno buttato 8 traduzioni complete.
 *
 * Misurato sulle FAQ GIA' PUBBLICATE (16'968 articoli×locale del corpus a
 * questo commit, con verita' di riferimento indipendente dal rilevatore: una
 * coppia identica verbatim all'italiana e' un passthrough, una che differisce
 * e' tradotta). E' UNA sola estrazione, e i quattro predicati sono valutati
 * sulla stessa:
 *
 *   predicato                falsi positivi        passthrough intercettati
 *   `!== expectedLocale`     344 / 16'968 (2,0%)   7 / 7 (100%)
 *   `=== sourceLang`         113 / 16'968 (0,7%)   7 / 7 (100%)
 *   + ramo verbatim          113 / 16'968 (0,7%)   7 / 7 (100%)
 *   + ramo terza lingua      113 / 16'968 (0,7%)   7 / 7 (100%)
 *
 * Le ultime tre righe hanno lo STESSO numero di falsi positivi, e non e' una
 * svista: con questa verita' di riferimento il ramo verbatim rifiuta solo
 * coppie identiche all'italiana, che sono passthrough per definizione, quindi
 * non puo' aggiungerne; e il ramo di terza lingua, tarato come sotto, non ne
 * aggiunge nessuno su questa popolazione. Il predicato e' l'OR dei tre rami:
 * i suoi falsi positivi non potrebbero comunque essere MENO di quelli del
 * singolo ramo di lingua.
 *
 * Da cui la forma: piu' segnali, non uno scelto fra i tanti. L'uguaglianza con
 * la coppia sorgente e' il riferimento che non mente e non ha bisogno di
 * soglie; il rilevatore di lingua copre il passthrough che il motore ha
 * ritoccato quanto basta a non essere piu' byte-uguale. Il valore del ramo
 * verbatim NON e' visibile in questa tabella (il suo recall e' 7/7 per
 * costruzione della verita' di riferimento): e' che sul percorso di SCRITTURA
 * il fallback di `translateFaqArray()` produce esattamente una coppia
 * byte-identica alla sorgente, cioe' il caso che il solo rilevatore perde
 * quando risponde `de` su testo italiano (vedi il test omonimo).
 *
 * Nei falsi positivi del vecchio predicato la lingua rilevata era `fr` 126,
 * `it` 110, `de` 58, `en` 50: **il 68% non riguardava affatto l'italiano**.
 *
 * ── E LA TERZA LINGUA: PERCHE' `=== sourceLang` DA SOLO SAREBBE FAIL-OPEN ──
 *
 * `detected === sourceLang` accetta tutto cio' che non e' italiano, quindi una
 * coppia chiesta in `fr` e resa in inglese verrebbe scritta sotto `/fr/` come
 * traduzione — la classe che il vecchio predicato fermava per caso, insieme al
 * rumore. Qui non si ribalta il difetto da un lato all'altro: il terzo ramo
 * rifiuta la terza lingua solo quando il rilevatore ha DAVVERO segnale.
 *
 * «Davvero segnale» sono due condizioni, e la seconda e' quella che conta:
 * confidenza >= 0,60 (la soglia di affidabilita' dichiarata da
 * `detectLanguageWithConfidence`) **e** punteggio assoluto >= 500. La
 * confidenza da sola non basta perche' e' un margine relativo
 * (`(primo - secondo) / primo`): su testo corto e povero di trigrammi i
 * punteggi crollano e il margine SALE. Misurato: le 11 coppie pubblicate che
 * un rilevatore diverso dall'atteso segnala con confidenza >= 0,60 hanno tutte
 * punteggio <= 322 (la peggiore e' un testo inglese di 100 caratteri su
 * Thusis, dato `de` con confidenza 0,92 e punteggio 145), mentre sulle 60'492
 * coppie riconosciute nella loro lingua il punteggio mediano e' 1436 e il 5°
 * percentile 455. Un pavimento a 500 azzera i falsi positivi su tutta la
 * popolazione (0 / 16'968) e lascia passare il caso reale della classe: un
 * testo tedesco lungo sotto `/en/` sta a 4227.
 *
 * Il costo dichiarato: sotto quel pavimento il ramo e' inerte, quindi una
 * uscita in terza lingua corta e poco caratterizzata resta accettata. E' il
 * lato su cui si sbaglia per scelta — il ramo esiste per fermare la terza
 * lingua CONCLAMATA, non per indovinarla.
 *
 * La soglia di 50 caratteri resta, e vale solo per i rami che usano il
 * rilevatore: misurata, con 50 da' zero falsi positivi su 8 traduzioni buone e
 * coglie 3 italiane su 4; a 80 controllerebbe 2 coppie su 8 e ne coglierebbe 0,
 * cioe' si spegnerebbe. Il ramo dell'uguaglianza non ha soglia perche' non e'
 * una stima.
 *
 * @param {{q: string, a: string}[]} faqArray  le coppie da giudicare
 * @param {string} expectedLocale
 * @param {{q: string, a: string}[]|null} [sourceFaq] le coppie SORGENTE, quando
 *   il chiamante ce l'ha. Senza, resta il solo controllo di lingua e si perde
 *   il ramo che coglie il fallback per-coppia di `translateFaqArray()`.
 * @param {string} [sourceLang='it']
 * @returns {Array<{index: number, detected: string, via: 'verbatim'|'lingua'|'terza-lingua'}>|null}
 */
export function wrongLocalePair(faqArray, expectedLocale, sourceFaq = null, sourceLang = 'it') {
  // Su `expectedLocale === sourceLang` non c'e' traduzione da giudicare: la
  // sorgente italiana sotto `/it/` e' l'esito giusto, non un passthrough.
  if (expectedLocale === sourceLang) return null;
  const sourcePairs = Array.isArray(sourceFaq)
    ? new Set(sourceFaq.map(pairKey).filter(Boolean))
    : null;
  const wrong = [];
  for (let i = 0; i < faqArray.length; i++) {
    if (sourcePairs?.has(pairKey(faqArray[i]))) {
      wrong.push({ index: i, detected: sourceLang, via: 'verbatim' });
      continue;
    }
    const text = `${faqArray[i].q} ${faqArray[i].a}`;
    if (text.length < 50) continue; // too short to detect
    const { lang: detected, confidence, scores } = detectLanguageWithConfidence(text, expectedLocale);
    if (detected === sourceLang) {
      wrong.push({ index: i, detected, via: 'lingua' });
      continue;
    }
    // Terza lingua: rifiuta solo col segnale forte (vedi sopra), altrimenti il
    // ramo si riprende i falsi positivi che questo predicato serve a togliere.
    if (detected !== expectedLocale
      && confidence >= THIRD_LANG_MIN_CONFIDENCE
      && (Object.keys(scores || {}).length === 0
        ? confidence >= THIRD_LANG_SHORT_TEXT_CONFIDENCE
        : (scores?.[detected] ?? 0) >= THIRD_LANG_MIN_SCORE)) {
      wrong.push({ index: i, detected, via: 'terza-lingua' });
    }
  }
  return wrong.length > 0 ? wrong : null;
}

/** Rimuove solo le coppie giudicate sbagliate, conservando quelle sane. */
export function filterWrongLocalePairs(faqArray, wrong) {
  if (!Array.isArray(wrong) || wrong.length === 0) return faqArray;
  const rejected = new Set(wrong.map(({ index }) => index));
  return faqArray.filter((_, index) => !rejected.has(index));
}

// Il minimo di coppie che una FAQ pubblicata deve avere. UNA sorgente per i due
// scrittori (`batch-add-faq-to-articles.mjs` lo importa da qui): il ramo IT lo
// impone gia' sulla generazione, e un locale scritto sotto questo numero
// sarebbe una FAQ piu' povera dell'italiano sulla stessa pagina.
export const MIN_FAQ_PAIRS = 3;

/**
 * Il pavimento di una scrittura potata, e insieme la condizione che il
 * RILEVATORE usa per riaccodare il locale.
 *
 * Perche' esiste: conservare le coppie sane invece di buttare l'articolo e'
 * giusto, ma senza pavimento la potatura e' PERMANENTE. Il rilevatore riaccoda
 * un locale solo se manca la chiave `.faq` o se `wrongLocalePair` trova ancora
 * una coppia sbagliata: dopo una scrittura parziale nessuna delle due vale
 * piu', e la FAQ pubblicata resta sotto il minimo per sempre, senza un errore.
 * Sotto il pavimento quindi NON si scrive: la FAQ vecchia resta, il rilevatore
 * la rivede al giro dopo e la traduzione viene ritentata.
 *
 * `Math.min` con la sorgente: pretendere 3 coppie da una sorgente che ne ha 2
 * sarebbe un pavimento irraggiungibile, cioe' un locale mai piu' scritto.
 */
export function minPairsForWrite(sourceFaq) {
  const sourceLen = Array.isArray(sourceFaq) ? sourceFaq.length : 0;
  return Math.min(sourceLen || MIN_FAQ_PAIRS, MIN_FAQ_PAIRS);
}

/** true quando l'array potato non raggiunge il pavimento e non va scritto. */
export function belowFaqFloor(keptFaq, sourceFaq) {
  return (keptFaq?.length ?? 0) < minPairsForWrite(sourceFaq);
}

/** True when a readable locale has fewer FAQ pairs than its Italian source. */
export function belowFaqSourceCount(localeFaq, sourceFaq) {
  return Array.isArray(localeFaq)
    && Array.isArray(sourceFaq)
    && localeFaq.length < sourceFaq.length;
}

// A deterministic FAQ rejection is a recoverable work item, but retrying the
// same source forever only burns translation quota. Keep the state per
// article/locale and reset it automatically when the Italian source changes.
// `prunedWrite` distinguishes a published above-floor partial from a rejected
// below-floor write, so the former can be retried without freezing the FAQ.
export const FAQ_REJECTION_MAX_CONSECUTIVE = 2;

export function faqLocaleIssueKey(articleId, locale, section = 'frontaliere') {
  return `${String(section)}/${String(articleId)}/${String(locale)}`;
}

export function faqSourceFingerprint(sourceFaq) {
  return createHash('sha256')
    .update(JSON.stringify(Array.isArray(sourceFaq) ? sourceFaq : null))
    .digest('hex')
    .slice(0, 16);
}

export function nextFaqRejection(previous, sourceFaq, { prunedWrite = false, keptPairs } = {}) {
  const source = faqSourceFingerprint(sourceFaq);
  const hasKeptPairs = Number.isInteger(keptPairs) && keptPairs >= 0;
  const previousKeptPairs = Number.isInteger(previous?.keptPairs) && previous.keptPairs >= 0
    ? previous.keptPairs
    : undefined;
  // The live ledger predates `keptPairs`: an old partial write is evidence of
  // progress, but its amount is unknown. Let the first measured write reopen
  // the counter instead of throttling it forever on the legacy count.
  const previousPrunedWriteIsUnmeasured = previous?.prunedWrite === true
    && previousKeptPairs === undefined;
  const priorConsecutive = Number(previous?.consecutive);
  const improvedPrunedWrite = prunedWrite
    && hasKeptPairs
    && (previousPrunedWriteIsUnmeasured
      || previousKeptPairs === undefined
      || keptPairs > previousKeptPairs);
  const consecutive = improvedPrunedWrite
    ? 1
    : previous?.source === source
    && Number.isFinite(priorConsecutive)
    && priorConsecutive > 0
    ? priorConsecutive + 1
    : 1;
  return {
    source,
    sourceCount: Array.isArray(sourceFaq) ? sourceFaq.length : 0,
    consecutive,
    ...(prunedWrite ? {
      prunedWrite: true,
      ...(hasKeptPairs ? { keptPairs } : {}),
    } : {}),
    ...(!hasKeptPairs && previousKeptPairs !== undefined
      ? { keptPairs: previousKeptPairs }
      : {}),
  };
}

export function shouldSkipFaqRejection(previous, sourceFaq) {
  const hasMeasuredPrunedWrite = Number.isInteger(previous?.keptPairs)
    && previous.keptPairs >= 0;
  const legacyPrunedWrite = previous?.prunedWrite === true && !hasMeasuredPrunedWrite;
  return !legacyPrunedWrite
    && previous?.source === faqSourceFingerprint(sourceFaq)
    && Number(previous.consecutive) >= FAQ_REJECTION_MAX_CONSECUTIVE;
}

/**
 * Separa gli issue gia' throttled prima di consumare il limite del run.
 * Restituire il gruppo escluso rende osservabile la differenza fra lavoro
 * parcheggiato e lavoro che non entra nel batch per il limite esplicito.
 */
export function selectFaqIssuesForProcessing(issues, rejectionLedger, section, limit) {
  const ledger = rejectionLedger && typeof rejectionLedger === 'object'
    ? rejectionLedger
    : {};
  const throttled = [];
  const eligible = [];
  for (const issue of issues) {
    if (shouldSkipFaqRejection(
      ledger[faqLocaleIssueKey(issue.articleId, issue.locale, section)],
      issue.itFaq,
    )) {
      throttled.push(issue);
    } else {
      eligible.push(issue);
    }
  }
  return {
    toProcess: eligible.slice(0, limit),
    throttled,
  };
}

const FAQ_REJECTION_LEDGER_PATH = resolve(ROOT, 'data/faq-locale-rejections.json');

function loadFaqRejectionLedger() {
  if (!existsSync(FAQ_REJECTION_LEDGER_PATH)) return {};
  try {
    const parsed = JSON.parse(readFileSync(FAQ_REJECTION_LEDGER_PATH, 'utf-8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (err) {
    console.error(`⚠️ Impossibile leggere ${FAQ_REJECTION_LEDGER_PATH}: ${err.message}`);
    return {};
  }
}

function saveFaqRejectionLedger(ledger) {
  mkdirSync(dirname(FAQ_REJECTION_LEDGER_PATH), { recursive: true });
  const ordered = Object.fromEntries(Object.entries(ledger).sort(([a], [b]) => a.localeCompare(b)));
  const tmp = `${FAQ_REJECTION_LEDGER_PATH}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(ordered, null, 2)}\n`, 'utf-8');
    renameSync(tmp, FAQ_REJECTION_LEDGER_PATH);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* best-effort cleanup */ }
    throw err;
  }
}

// ── Translation (same cascade as job crawlers) ──────────────

async function translateFaqArray(faqArray, targetLang) {
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

// ── Riparazione dei file gia' scritti con l'escape rotto ────
//
// La fix dello scrittore ferma la PRODUZIONE di file rotti; non tocca quelli
// gia' committati, che restano senza FAQPage finche' non vengono riscritti.
// Rieseguire la modalita' normale NON li ripara — misurato su tutti e 72:
// `hasFaqKey` e' vero (la chiave c'e'), quindi non sono `missing`; e il testo
// tradotto e' nella locale giusta, quindi non sono `wrong_locale`. Zero su 72
// verrebbero toccati.
//
// Questa modalita' non traduce e non chiama nessun modello: rilegge il literal
// con la decodifica legacy, che su quei file funziona per costruzione, e lo
// riscrive con l'escape corretto. Il contenuto non cambia — cambia la codifica.

function reescapeBroken() {
  const locales = ['it', 'en', 'de', 'fr'];
  const repaired = [];
  for (const locale of locales) {
    const dir = resolve(BODY_DIR, locale);
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter(f => f.endsWith('.ts'))) {
      if (repaired.length >= LIMIT) break;
      const filePath = resolve(dir, file);
      const raw = rawFaqLiteral(filePath);
      if (raw === null) continue;
      const { pairs, legacy } = parseFaqLiteral(raw);
      if (!legacy || !pairs) continue;
      // Il ri-escape deve essere una IDENTITA' sul contenuto: se ricodificando
      // cio' che si e' letto non si riottiene lo stesso array, il file non si
      // tocca. E' il solo modo in cui questa riparazione puo' rompere qualcosa.
      const rewritten = serializeFaqLiteral(pairs);
      const back = parseFaqLiteral(rewritten);
      if (back.legacy || JSON.stringify(back.pairs) !== JSON.stringify(pairs)) {
        console.error(`  ⚠️  round-trip non esatto, SALTATO: ${locale}/${file}`);
        continue;
      }
      repaired.push(`${locale}/${file}`);
      if (!DRY_RUN) replaceFaqInFile(filePath, pairs);
    }
  }
  console.log(`\n📊 ${DRY_RUN ? 'Da riparare' : 'Riparati'}: ${repaired.length} file`);
  for (const f of repaired.slice(0, 50)) console.log(`  ${f}`);
  if (repaired.length > 50) console.log(`  ... e altri ${repaired.length - 50}`);
}

// ── Main ────────────────────────────────────────────────────

const USAGE = `fix-faq-locales.mjs — allinea le chiavi .faq di en/de/fr all'italiano.

  --dry-run              elenca cosa farebbe, senza scrivere (anche DRY_RUN=1)
  --limit N              quante voci trattare in questa run
  --section=<sezione>    frontaliere (default) | svizzera
  --reescape-broken      riscrive le .faq prodotte dall'escape rotto: nessuna
                         traduzione, nessun modello, solo la codifica
  --help                 questo testo, senza leggere ne' scrivere niente
`;

async function main() {
  // Prima di qualunque lettura del corpus: `--help` non deve toccare il disco.
  if (HELP) {
    console.log(USAGE);
    return;
  }

  if (REESCAPE_BROKEN) {
    console.log(`🔧 Ri-escape dei .faq scritti con l'escape rotto (${SECTION})...\n`);
    reescapeBroken();
    return;
  }

  console.log('🔍 Scanning for FAQ locale issues...\n');

  const itDir = resolve(BODY_DIR, 'it');
  const itFiles = readdirSync(itDir).filter(f => f.endsWith('.ts'));
  const issues = [];

  for (const file of itFiles) {
    const articleId = basename(file, '.ts');
    const itPath = resolve(BODY_DIR, 'it', file);
    const itFaq = extractFaqFromFile(itPath);
    if (!itFaq || itFaq.length === 0) continue;

    for (const locale of ['en', 'de', 'fr']) {
      const localePath = resolve(BODY_DIR, locale, file);
      if (!existsSync(localePath)) continue;

      if (!hasFaqKey(localePath)) {
        issues.push({ articleId, file, locale, reason: 'missing', itFaq });
      } else {
        const localeFaq = extractFaqFromFile(localePath);
        // Per COPPIA anche qui, e non solo nel gate di scrittura: questo e' il
        // punto che decide COSA riparare. Col testo concatenato un articolo
        // /en/ con una coppia italiana su otto non veniva nemmeno SELEZIONATO —
        // il rilevatore vedeva il resto in inglese e rispondeva `en` — quindi
        // il gate di scrittura, per stretto che fosse, non lo vedeva mai.
        if (localeFaq && wrongLocalePair(localeFaq, locale, itFaq)) {
          issues.push({ articleId, file, locale, reason: 'wrong_locale', itFaq });
        } else if (localeFaq && belowFaqSourceCount(localeFaq, itFaq)) {
          issues.push({ articleId, file, locale, reason: 'below_source_count', itFaq });
        }
      }
    }
  }

  const rejectionLedger = loadFaqRejectionLedger();
  const liveIssueKeys = new Set(issues.map((issue) => faqLocaleIssueKey(issue.articleId, issue.locale, SECTION)));
  let ledgerDirty = false;
  const sectionPrefix = SECTION + '/';
  for (const key of Object.keys(rejectionLedger)) {
    if (key.startsWith(sectionPrefix) && !liveIssueKeys.has(key)) {
      delete rejectionLedger[key];
      ledgerDirty = true;
    }
  }
  const persistLedger = () => {
    if (!DRY_RUN && ledgerDirty) {
      saveFaqRejectionLedger(rejectionLedger);
      ledgerDirty = false;
    }
  };
  persistLedger();

  const byReason = {};
  for (const i of issues) byReason[i.reason] = (byReason[i.reason] || 0) + 1;
  console.log(`Found ${issues.length} FAQ locale issues:`);
  for (const [reason, count] of Object.entries(byReason)) console.log(`  ${reason}: ${count}`);

  if (DRY_RUN) {
    console.log('\n🏁 Dry run — first 50 issues:');
    for (const i of issues.slice(0, 50)) console.log(`  ${i.locale.toUpperCase()} ${i.reason}: ${i.articleId}`);
    if (issues.length > 50) console.log(`  ... and ${issues.length - 50} more`);
    return;
  }

  if (issues.length === 0) {
    console.log('\n✅ All FAQ locales are correct!');
    return;
  }

  const { toProcess, throttled } = selectFaqIssuesForProcessing(issues, rejectionLedger, SECTION, LIMIT);
  console.log(`\nProcessing ${toProcess.length} issues...\n`);

  const repeatedRejectionSkips = throttled.length;
  let fixed = 0;
  let failed = 0;
  for (const issue of throttled) {
    const issueKey = faqLocaleIssueKey(issue.articleId, issue.locale, SECTION);
    const previousRejection = rejectionLedger[issueKey];
    const rejectionKind = previousRejection.prunedWrite
      ? 'potatura sopra pavimento già pubblicata'
      : 'rifiuto sotto pavimento';
    console.error(`[${issue.locale.toUpperCase()}] ${issue.articleId} ⏭️  ${rejectionKind} `
      + `registrata ${previousRejection.consecutive} volte consecutive: salto la ritraduzione`);
    if (!previousRejection.prunedWrite) failed++;
  }
  for (let idx = 0; idx < toProcess.length; idx++) {
    const issue = toProcess[idx];
    const label = `[${idx + 1}/${toProcess.length}] [${issue.locale.toUpperCase()}] ${issue.articleId}`;
    const issueKey = faqLocaleIssueKey(issue.articleId, issue.locale, SECTION);
    try {
      const previousRejection = rejectionLedger[issueKey];

      const translated = await translateFaqArray(issue.itFaq, issue.locale);
      if (!translated) {
        console.error(`${label} ❌ Translation produced no valid FAQ`);
        failed++;
        continue;
      }

      // Verify the translation is actually in the right locale — per coppia,
      // perche' il fallback italiano di `translateFaqArray()` e' per coppia.
      const wrong = wrongLocalePair(translated, issue.locale, issue.itFaq);
      let toWrite = translated;
      if (wrong) {
        toWrite = filterWrongLocalePairs(translated, wrong);
        console.error(`${label} ⚠️  ${wrong.length} coppia/e non in ${issue.locale} `
          + `(${wrong.map((pair) => `${pair.index + 1}:${pair.detected}/${pair.via}`).join(', ')}): `
          + `${toWrite.length} coppia/e sane conservate`);
        // Una potatura sopra il pavimento si puo' pubblicare: il rilevatore la
        // riaccoda per conteggio della sorgente, mentre il ledger prunedWrite
        // limita la sola ritraduzione ripetuta senza rifiutare il residuo.
      }

      if (belowFaqFloor(toWrite, issue.itFaq)) {
        const nextRejection = nextFaqRejection(rejectionLedger[issueKey], issue.itFaq);
        rejectionLedger[issueKey] = nextRejection;
        ledgerDirty = true;
        persistLedger();
        console.error(`${label} ❌ Solo ${toWrite.length}/${issue.itFaq.length} coppie sane: `
          + `non scrivo; rifiuto consecutivo ${nextRejection.consecutive}/${FAQ_REJECTION_MAX_CONSECUTIVE}, `
          + 'ritento al giro dopo');
        failed++;
        continue;
      }

      const localePath = resolve(BODY_DIR, issue.locale, issue.file);
      if (issue.reason === 'missing') {
        if (!insertFaqKey(localePath, issue.articleId, toWrite)) {
          console.error(`${label} ❌ Could not insert FAQ key`);
          failed++;
          continue;
        }
      } else {
        replaceFaqInFile(localePath, toWrite);
      }

      console.log(`${label} ✅ Fixed (${toWrite.length} pairs`
        + (wrong ? `, ${wrong.length} skipped)` : ')'));
      const partialWrite = belowFaqSourceCount(toWrite, issue.itFaq);
      if (partialWrite) {
        const nextRejection = nextFaqRejection(previousRejection, issue.itFaq, {
          prunedWrite: true,
          keptPairs: toWrite.length,
        });
        rejectionLedger[issueKey] = nextRejection;
        ledgerDirty = true;
        persistLedger();
      } else if (rejectionLedger[issueKey]) {
        delete rejectionLedger[issueKey];
        ledgerDirty = true;
        persistLedger();
      }
      fixed++;
    } catch (err) {
      console.error(`${label} ❌ ${err.message}`);
      failed++;
    }
  }

  const remaining = Math.max(0, issues.length - toProcess.length - throttled.length);
  console.log(`\n📊 Results: ${fixed} fixed, ${failed} failed, ${remaining} remaining`
    + ` (${repeatedRejectionSkips} repeated FAQ rejections skipped)`);
  logCascadeSummary();
}

// `main()` parte solo se questo file E' l'entry point, come gia' fa
// `batch-add-faq-to-articles.mjs`. Senza la guardia, importare il modulo per
// testarne le funzioni pure lo ESEGUE: leggerebbe `content/` e scriverebbe.
// E' la guardia a rendere testabili `serializeFaqLiteral`/`parseFaqLiteral`,
// cioe' le due meta' del difetto che questa PR chiude.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
