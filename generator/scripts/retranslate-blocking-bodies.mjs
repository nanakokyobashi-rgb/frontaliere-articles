#!/usr/bin/env node
/**
 * retranslate-blocking-bodies.mjs — bonifica dei body-locale che la guardia di
 * factuality rifiuta, facendoli RIPASSARE dalla pipeline di traduzione vera.
 *
 * ── PERCHE' ESISTE ─────────────────────────────────────────────────────────
 *
 * `audit-article-factuality.mjs` sa DIRE quali pagine pubblicate la guardia
 * rifiuterebbe, e lo scan-v2 di #1875 sa DIRE quali contengono residui
 * italiani per riga, ma nessuno script sapeva RIPARARLE: `create-article.mjs` e'
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
 * Da cui le regole che governano la scrittura, tutte verificate dal
 * test `retranslate-blocking-bodies.test.mjs`:
 *
 *   1. si scrive SOLO se la nuova traduzione passa la guardia con zero
 *      `critical` — una ri-traduzione che ri-fallisce si scarta e la pagina
 *      pubblicata resta com'e';
 *   2. si scrive SOLO se la vecchia era bloccante — mai "migliorare" una
 *      pagina che la guardia gia' accetta;
 *   3. una pagina con almeno tre righe italiane porta il codice bloccante
 *      `italian-residue`, anche se la guardia factuality non trova `critical`;
 *   4. si scrive SOLO se il testo nuovo supera anche i controlli locali di
 *      `translationSanityIssue`: non e' drasticamente piu' corto del body
 *      pubblicato — il tier HuggingFace tronca la SORGENTE a 2000 caratteri e
 *      il taglio esce con marker bilanciati e zero `critical` — e ogni campo
 *      resta nella lingua richiesta. Il passthrough esatto e' gia' rifiutato
 *      fail-closed dalla cascata condivisa; questo controllo resta una difesa
 *      ulteriore per residui parziali o per chiamanti futuri della funzione.
 *
 * UNA eccezione, solo sull'italiano e solo per `leaked-prompt-scaffolding`:
 * l'italiano e' il sorgente, la cascata non lo puo' rifare, e il gate stesso
 * prescrive di cancellare il marcatore del prompt («Rimuovi il blocco… Non
 * riscrivere l'istruzione in prosa»). Il proprietario ha approvato il
 * 2026-10-04 (site 7682) la cancellazione della sola riga
 * `TITOLO ARTICOLO: <titolo>` invece di una rigenerazione LLM. E' la
 * cancellazione di un token esatto del prompt (`lib/strip-leaked-title-marker.mjs`),
 * non una regex di riparazione: nessun testo viene generato o riscritto, si
 * scrive solo se la pagina aveva quel SOLO codice `critical`, se la guardia
 * sul testo nuovo torna a zero `critical` e se il diff riga per riga (e il
 * file, byte per byte fuori dal campo) e' esattamente la riga tolta. Ogni
 * altra forma del marcatore resta intatta e si risolve a mano
 * (`planTitleMarkerRemoval`).
 *
 * E dalla regola di forma: l'uscita della cascata passa da `sanitizeBodyText()`
 * come nel percorso di produzione. Le graffe spaiate dell'MT (la chiusura mal
 * fatta delle virgolette basse tedesche) non sono nel vocabolario di
 * `runFactualityGates`: se il post-processing non fosse lo stesso, "stessa
 * cascata degli articoli nuovi" non sarebbe "stesso percorso di scrittura".
 *
 * Se un campo torna vuoto dalla cascata (motore giu', sentinella nav-link
 * mangled, marker `Null` di fallimento) l'articolo si SALTA per intero: in
 * produzione il chiamante ha una recovery per-campo (retry LLM, poi body
 * lasciato non tradotto — #1875), qui no, e mezza traduzione nuova cucita su
 * mezza vecchia sarebbe testo che nessuna pipeline ha mai prodotto.
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
 *   ...--scan --count-only --out stock.json      # misura lo stock, non scrive
 *   ...--scan --code translation-false-friend --limit 20           # pilota
 *
 * Flag:
 *   --audit <file>     JSON di audit-article-factuality.mjs --json oppure
 *                      scan-v2 (`results[]`); richiesto, salvo --slug,
 *                      --missing o --scan
 *   --scan             seleziona le coppie bloccanti leggendo `content/` con
 *                      la stessa guardia (`runFactualityGates`, codici
 *                      `critical`), un file alla volta: zero rete, zero MT,
 *                      niente audit da 6 GB del sito. Non si combina con
 *                      --audit, --slug o --missing. Il resto (--code,
 *                      --locale, --limit, --stratify, --apply) e' invariato.
 *                      Esce 2 se manca una cartella `<albero>/<locale>` (o
 *                      l'`it`), se un body tracciato da git manca dal
 *                      worktree (cancellato o skip-worktree) o se non legge
 *                      nessun body: una conta parziale non deve sembrare uno
 *                      stock bonificato. La stessa guardia sui body tracciati
 *                      vale per --missing, --slug e i file di un --audit.
 *   --count-only       solo con --scan: non tratta nessuna coppia, stampa
 *                      `{ scanned, byCode: { <codice>: { it, en, de, fr,
 *                      total } } }` su stdout (e su --out). Default locali
 *                      it,en,de,fr. Non si combina con --apply.
 *   --list-out <file>  solo con --scan: JSONL ordinato per `key`, una coppia
 *                      per riga, `{ key, codes, evidence: [{ code, excerpt }] }`
 *                      (primo rilievo `critical` per codice). Rispetta
 *                      --locale e --code, non --limit.
 *   --missing          seleziona i body con chiavi mancanti o copia italiana
 *                      dal gate FU-009; usa la stessa cascata e gli stessi
 *                      guard prima di aggiungere/sostituire i campi
 *   --slug a,b         id articolo (slug) da trattare. Con --audit filtra;
 *                      senza, sintetizza le coppie dai file gia' in content/.
 *                      E' l'entry point in-place per uno slug arbitrario,
 *                      italiano compreso: non passa da registerArticleFiles().
 *   --apply            scrive davvero. SENZA questo flag e' un dry-run.
 *   --limit N          massimo di coppie trattate
 *   --locale a,b       filtra le coppie per locale (default en,de,fr).
 *                      `it` e' opt-in: e' il sorgente, non una traduzione.
 *                      Una lista vuota (`--locale=`) esce 2: non e' "nessun
 *                      filtro" e non e' "zero coppie".
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
import { readFileSync, writeFileSync, existsSync, renameSync, unlinkSync, realpathSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { translateFieldFreeMt } from './lib/article-free-mt.mjs';
import { freeTranslateWithRetry, balanceMarkdownMarkers } from './lib/free-translate.mjs';
import { runFactualityGates } from './lib/article-factuality-gates.mjs';
import {
  MIN_FACTS_PER_SECTION,
  matchesVacuousValue,
  parseAiSearchSections,
  stripVacuousFacts,
} from './lib/key-facts-specificity.mjs';
import { unescapeTsString } from './lib/unescape-ts-string.mjs';
import { escapeForSingleQuoteTS } from './lib/article-meta-block.mjs';
import { sanitizeBodyText } from './lib/sanitize-body-braces.mjs';
import { stripLeakedTitleMarkerLine, diffIsExactlyRemovedLines } from './lib/strip-leaked-title-marker.mjs';
import { detectLanguage, detectLanguageWithConfidence } from './lib/detect-language.mjs';
import { sanitizeText } from '../../scripts/lib/sanitize-control-chars.mjs';
import { reportStrippedControlChars } from './lib/control-char-write-report.mjs';
import {
  BODY_FIELDS as WRITER_BODY_FIELDS,
  extractBodyFields,
  inspectBlogLocaleCompleteness,
} from '../../scripts/ci/check-blog-locale-completeness.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
// `../..`: il transport ha spostato `scripts/` sotto `generator/scripts/`,
// quindi due livelli su sono la root del repo, non la cartella generator.
const ROOT = resolve(__dirname, '..', '..');

/** I campi che la guardia concatena: si ri-traducono insieme o niente. */
export const BODY_FIELDS = [...WRITER_BODY_FIELDS];

/** Campi body effettivamente emessi per questo articolo dal writer. */
export function bodyFieldsForSource(src, id) {
  const fields = new Set(
    extractBodyFields(src)
      .filter((entry) => entry.id === id)
      .map((entry) => entry.field),
  );
  return BODY_FIELDS.filter((field) => fields.has(field));
}

/**
 * Lo scan storico degli articoli misura i residui per RIGA, non sul body
 * concatenato: un blocco italiano di tre righe dentro una traduzione buona
 * deve restare visibile anche quando la lingua dominante e' quella attesa.
 * La soglia e' deliberatamente quella usata dal report di #1875: la coda di
 * una o due righe contiene toponimi, nomi propri e tabelle legittime, quindi
 * non e' abbastanza probante per autorizzare una riscrittura automatica.
 */
export const ITALIAN_RESIDUE_MIN_LINES = 3;
const ITALIAN_RESIDUE_MIN_CONFIDENCE = 0.15;
const ITALIAN_RESIDUE_HEADING_RE = /^(?:#{1,6}\s*)?(?:in breve|fatti chiave|domande frequenti|punti chiave|conclusione|conclusioni|fonti|consiglio pratico|cosa cambia|attenzione|da sapere|in sintesi)\s*:?[ \t]*$/iu;
const ITALIAN_RESIDUE_WORD_RE = /[\p{L}]+(?:['’][\p{L}]+)*/gu;
const ITALIAN_HEADING_HINT_RE = /\b(?:aggiornament(?:i|o)|canton(?:e|i)|contribut(?:i|o)|cos(?:a|e)|fiscal(?:e|i)|frontalier(?:a|e|i|o)|impatt(?:i|o)|impost(?:a|e)|italian(?:a|e|i|o)|lavorator(?:e|i)|misur(?:a|e)|nuov(?:a|e|i|o)|pension(?:e|i)|reddit(?:i|o)|regol(?:a|e)|salar(?:i|io)|tass(?:a|e)|ticin(?:o|esi)|titol(?:i|o))\b/iu;
// `fiscale` is valid Italian and French. It must go through the detector
// independently of the expected locale instead of the unconditional
// short-heading fast-path: the same French heading can be audited with a
// stale or non-French locale hint.
const AMBIGUOUS_ITALIAN_HEADING_HINT_RE = /\bfiscale\b/iu;
const ITALIAN_SHORT_HEADING_HINT_RE = /\b(?:come fare|chi paga|quando)\b/iu;
const LOCALIZED_HEADING_HINT_RE = {
  en: /\b(?:and|are|avoid|by|closure|contact|delays|do|facts|future|history|how|nutshell|our|phase|the|these|this|those|to|what|when|where|which|who|why|with|without|your)\b/iu,
  de: /\b(?:aber|auch|auf|aus|bei|das|der|die|digitale|ein|eine|einer|einem|einen|für|ist|mit|nach|nutzen|oder|praktische|schritt|straßennetz|stress|tools|über|und|unter|von|wichtig|zu|zum|zur)\b/iu,
  // `qui` e' condiviso con l'italiano: il detector deve poter risolvere il
  // contesto di un titolo come `Qui sono le novità` prima del fast-path.
  fr: /\b(?:activités|au|aux|avec|cette|ces|contacter|dans|délais|des|du|envoi|et|les|olympique|pour|sont|sur|une|village|votre|vos)\b/iu,
};

/** Conta le colonne Markdown, espandendo i tab ai successivi stop da quattro. */
function markdownColumns(text) {
  let columns = 0;
  for (const char of String(text ?? '')) {
    columns += char === '\t' ? 4 - (columns % 4) : 1;
  }
  return columns;
}

function normalizeItalianResidueLine(line) {
  return String(line ?? '')
    .replace(/\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/https?:\/\/\S+/gu, ' ')
    .replace(/[\*_`>#|]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

/** Rimuove i contenitori Markdown che possono precedere un heading. */
function stripMarkdownContainerPrefixes(line) {
  return markdownContainerContext(line).rest;
}

function isListContainer(container) {
  return container.kind === 'ordered-list' || container.kind === 'unordered-list';
}

/**
 * Parse only the Markdown containers that precede a line. The semantic
 * context is retained for fenced-code matching: a list/blockquote marker in
 * the body of a root-level fence is code, not a closing fence.
 */
function markdownContainerContext(line) {
  let rest = String(line ?? '').replace(/\r$/u, '');
  const containers = [];
  for (;;) {
    const quoted = rest.match(/^[ \t]{0,3}>[ \t]?/u);
    const quotedIndent = quoted ? (quoted[0].match(/^[ \t]*/u) || [''])[0] : '';
    if (quoted && markdownColumns(quotedIndent) <= 3) {
      containers.push({
        kind: 'blockquote',
        width: markdownColumns(quoted[0]),
        indent: markdownColumns(quotedIndent),
      });
      rest = rest.slice(quoted[0].length);
      continue;
    }
    const listed = rest.match(/^[ \t]{0,3}(?:[-+*]|\d{1,9}[.)])[ \t]+/u);
    const listIndent = listed ? (listed[0].match(/^[ \t]*/u) || [''])[0] : '';
    if (listed && markdownColumns(listIndent) <= 3) {
      containers.push({
        kind: /^\d/u.test(listed[0].trim()) ? 'ordered-list' : 'unordered-list',
        // The consumed prefix is also the minimum indentation needed when a
        // list container continues without repeating its marker.
        width: markdownColumns(listed[0]),
        indent: markdownColumns(listIndent),
      });
      rest = rest.slice(listed[0].length);
      continue;
    }
    return {
      rest,
      containerKey: containers.map(({ kind }) => kind).join('|'),
      containers,
      contentIndent: markdownColumns((rest.match(/^[ \t]*/u) || [''])[0]),
    };
  }
}

/**
 * A child line may omit list markers while continuing the same list item.
 * Blockquotes cannot be omitted: `> title` followed by a root-level `---` is
 * a separator, not a Setext underline. Omitted lists can occur before a
 * later blockquote as well as at the end; their content indent must then be
 * present before that blockquote or before the fence marker itself.
 */
function compatibleContainerContinuation(openingContext, candidateContext) {
  const opening = openingContext.containers;
  const candidate = candidateContext.containers;
  let openingIndex = 0;
  let omittedListIndent = 0;

  for (const candidateContainer of candidate) {
    while (
      openingIndex < opening.length
      && opening[openingIndex].kind !== candidateContainer.kind
    ) {
      if (!isListContainer(opening[openingIndex])) return null;
      omittedListIndent += opening[openingIndex].width;
      openingIndex += 1;
    }
    if (openingIndex >= opening.length) return null;
    if (candidateContainer.indent < omittedListIndent) return null;
    openingIndex += 1;
    omittedListIndent = 0;
  }

  while (openingIndex < opening.length) {
    if (!isListContainer(opening[openingIndex])) return null;
    omittedListIndent += opening[openingIndex].width;
    openingIndex += 1;
  }
  if (candidateContext.contentIndent < omittedListIndent) return null;
  return { omittedListIndent };
}

/** Restituisce il testo di un heading ATX, oppure null. */
function atxHeadingText(line) {
  const rest = stripMarkdownContainerPrefixes(line);
  const match = rest.match(/^([ \t]*)(#{1,6})(?:[ \t]+(.*))?$/u);
  if (!match || markdownColumns(match[1]) > 3) return null;
  return (match[3] || '').replace(/[ \t]+#+[ \t]*$/u, '').trim();
}

function isSetextUnderline(line) {
  const rest = stripMarkdownContainerPrefixes(line);
  const match = rest.match(/^([ \t]*)(?:=+|-+)[ \t]*$/u);
  return Boolean(match && markdownColumns(match[1]) <= 3);
}

function markdownFenceMarker(line, expectedContext = null) {
  const context = markdownContainerContext(line);
  const continuation = expectedContext
    ? compatibleContainerContinuation(expectedContext, context)
    : { omittedListIndent: 0 };
  if (!continuation) return null;
  const indentation = markdownColumns((context.rest.match(/^[ \t]*/u) || [''])[0]);
  const match = context.rest.match(/^[ \t]*(`{3,}|~{3,})(.*)$/u);
  if (!match || indentation > 3 + continuation.omittedListIndent) return null;
  const trailing = match[2];
  // CommonMark forbids backticks in a backtick fence's info string. Treating
  // such a line as a marker could close a real fence from inside its code.
  if (match[1][0] === '`' && trailing.includes('`')) return null;
  return {
    char: match[1][0],
    length: match[1].length,
    trailing,
    containerKey: context.containerKey,
    context,
  };
}

function compatibleSetextContexts(titleContext, underlineContext) {
  const continuation = compatibleContainerContinuation(titleContext, underlineContext);
  if (!continuation) return false;

  // `- title\n- ---` starts a second list item. A Setext underline in a list
  // continues by indentation (`  ---`), while blockquote markers must be
  // repeated explicitly (`> ---`).
  const titleHasList = titleContext.containers.some(isListContainer);
  const underlineRepeatsList = underlineContext.containers.some(isListContainer);
  return !(titleHasList && underlineRepeatsList);
}

/**
 * Restituisce il testo di un heading Markdown, incluse le forme dentro
 * blockquote/lista e Setext. Il testo viene normalizzato solo dopo aver
 * rimosso la sintassi contenitore, così il detector non deve indovinare che
 * `- ## Titolo` e `> ## Titolo` sono heading. Con `fenceState` i blocchi di
 * codice fenced vengono ignorati per campo, inclusa la loro coppia Setext.
 */
function markdownHeadingText(line, nextLine, fenceState = null) {
  if (fenceState) {
    fenceState.fenceLine = false;
    const marker = markdownFenceMarker(line, fenceState.marker?.context ?? null);
    if (fenceState.marker) {
      const closes = marker
        && marker.char === fenceState.marker.char
        && marker.length >= fenceState.marker.length
        && !marker.trailing.trim()
        // A repeated list marker is a list item inside the fence, not its
        // closing continuation. The indented, marker-free continuation is
        // handled by compatibleContainerContinuation above.
        && !(
          fenceState.marker.context.containers.some(isListContainer)
          && marker.context.containers.some(isListContainer)
        );
      if (closes) fenceState.marker = null;
      fenceState.fenceLine = true;
      return null;
    }
    if (marker) {
      fenceState.marker = marker;
      fenceState.fenceLine = true;
      return null;
    }
  }
  const atx = atxHeadingText(line);
  if (atx !== null) return normalizeItalianResidueLine(atx);
  if (nextLine !== undefined && isSetextUnderline(nextLine)) {
    const titleContext = markdownContainerContext(line);
    const underlineContext = markdownContainerContext(nextLine);
    if (compatibleSetextContexts(titleContext, underlineContext)) {
      return normalizeItalianResidueLine(titleContext.rest);
    }
  }
  return null;
}

function italianMarkdownHeadingReason(text, locale) {
  const localizedHint = LOCALIZED_HEADING_HINT_RE[locale];
  const ambiguousHint = AMBIGUOUS_ITALIAN_HEADING_HINT_RE.test(text);
  const hasItalianHint = (ITALIAN_HEADING_HINT_RE.test(text)
    || ITALIAN_SHORT_HEADING_HINT_RE.test(text))
    && !ambiguousHint;
  const detected = detectLanguageWithConfidence(text, locale);

  if (ambiguousHint) {
    return detected.lang === 'it' && detected.confidence >= ITALIAN_RESIDUE_MIN_CONFIDENCE
      ? 'language'
      : null;
  }

  // Il detector trigramma puo' chiamare italiano un titolo breve inglese,
  // quindi un segnale lessicale della lingua attesa vince sul suo verdetto.
  // I segnali italiani servono a conservare titoli non canonici anche quando
  // il titolo e' troppo corto per il profilo trigramma.
  if (localizedHint?.test(text) && !hasItalianHint) return null;
  if (hasItalianHint) return 'language';
  return detected.lang === 'it' && detected.confidence >= ITALIAN_RESIDUE_MIN_CONFIDENCE
    ? 'language'
    : null;
}

/** Ritorna il tipo di segnale, oppure null se la riga non e' probante. */
function italianResidueLineReason(line, locale, nextLine, heading = undefined) {
  if (locale === 'it') return null;
  const clean = normalizeItalianResidueLine(line);
  if (!clean) return null;
  const headingText = heading === undefined
    ? markdownHeadingText(line, nextLine)
    : heading;
  if (headingText !== null) {
    if (!headingText) return null;
    if (ITALIAN_RESIDUE_HEADING_RE.test(headingText)) return 'heading';
    return italianMarkdownHeadingReason(headingText, locale);
  }
  if (ITALIAN_RESIDUE_HEADING_RE.test(clean)) return 'heading';

  const words = clean.match(ITALIAN_RESIDUE_WORD_RE) || [];
  if (words.length < 3) return null;
  const { lang, confidence } = detectLanguageWithConfidence(clean, locale);
  return lang === 'it' && confidence >= ITALIAN_RESIDUE_MIN_CONFIDENCE ? 'language' : null;
}

/**
 * Scans the fields independently, preserving field and line provenance for
 * the dry-run report. A field is not concatenated with its siblings: that was
 * the exact blind spot that let an Italian AI-search block hide in a good
 * translation.
 */
export function scanItalianResidue(sections, locale) {
  if (!sections || typeof sections !== 'object' || locale === 'it') return [];
  const hits = [];
  for (const [field, value] of Object.entries(sections)) {
    if (typeof value !== 'string') continue;
    const fenceState = { marker: null, fenceLine: false };
    const lines = value.split(/\r?\n/u);
    lines.forEach((line, index) => {
      const nextLine = lines[index + 1];
      const heading = markdownHeadingText(line, nextLine, fenceState);
      if (fenceState.fenceLine || fenceState.marker) return;
      const reason = italianResidueLineReason(line, locale, nextLine, heading);
      if (!reason) return;
      hits.push({
        field,
        line: index + 1,
        reason,
        text: (heading ?? normalizeItalianResidueLine(line)).slice(0, 300),
      });
    });
  }
  return hits;
}

export function hasItalianResidue(sections, locale) {
  return scanItalianResidue(sections, locale).length >= ITALIAN_RESIDUE_MIN_LINES;
}

export function currentBlockingCodes({ factualityCodes = [], italianResidue = [] }) {
  return [...new Set([
    ...factualityCodes,
    ...(italianResidue.length >= ITALIAN_RESIDUE_MIN_LINES ? ['italian-residue'] : []),
  ])].sort();
}

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
const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

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

// `escapeForSingleQuoteTS` NON si ridichiara qui: la copia canonica sta in
// `lib/article-meta-block.mjs` accanto al suo inverso, perche' le copie private
// dello scrittore e del lettore erano gia' divergute una volta. Ri-esportata
// perche' il test la usa per costruire le fixture con lo stesso escape dello
// scrittore vero.
export { escapeForSingleQuoteTS };

/**
 * Applica il post-processing della pipeline e rende esplicito il fallimento
 * quando la sanitizzazione svuota l'uscita MT.
 */
export function sanitizeTranslatedField(value) {
  const sanitized = sanitizeBodyText(value);
  return sanitized.trim() ? sanitized : null;
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

/**
 * Inserisce un campo body assente in un file locale già registrato.
 *
 * Il registrar resta append-only: questa funzione non crea file né id nuovi,
 * aggiunge solo la chiave dichiarata dalla sorgente italiana dentro il file
 * esistente. Il campo viene inserito prima della prima chiave dello stesso
 * articolo (quindi prima di `.faq` nei file storici che ne contengono solo
 * quella), mantenendo il formato single-quoted dello writer canonico.
 */
export function insertBodyField(src, id, field, value) {
  const key = bodyKey(id, field);
  if (src.includes(key)) return null;
  const firstKey = new RegExp(
    `^([ \\t]*)['"]blog\\.article\\.${escapeRegExp(id)}\\.(?:body[123]|faq)['"]\\s*:`,
    'mu',
  ).exec(src);
  const indent = firstKey?.[1] ?? '    ';
  const insertionAt = firstKey
    ? firstKey.index
    : (src.lastIndexOf('};') >= 0 ? src.lastIndexOf('};') : src.length);
  const line = `${indent}${key}'${escapeForSingleQuoteTS(value)}',\n`;
  return `${src.slice(0, insertionAt)}${line}${src.slice(insertionAt)}`;
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
 * Applica alla ri-traduzione la stessa guardia dei nuovi articoli.
 *
 * `runFactualityGates()` non controlla la specificita' dei fatti chiave: una
 * ri-traduzione che trasformi tre fatti in `not specified` puo' quindi avere
 * zero `critical` e arrivare alla scrittura. Il guard e' volutamente
 * fail-closed: rimuove i fatti vacui solo se restano almeno tre superstiti,
 * altrimenti lascia il payload immutato e restituisce un motivo di rifiuto.
 *
 * @param {Record<string, string>} sections
 * @returns {{sections: Record<string, string>, issue: string|null, changed: boolean, result: object|null}}
 */
export function guardTranslatedKeyFacts(sections, {
  requireRecognizedSection = true,
  maxSourceBackedResiduals = 0,
} = {}) {
  const body1 = sections?.body1;
  if (typeof body1 !== 'string' || body1.length === 0) {
    return { sections, issue: null, changed: false, result: null };
  }

  const result = stripVacuousFacts(body1);
  if (result.rejected) {
    return {
      sections,
      issue: `[key-facts-specificity] body1 sotto la soglia di ${MIN_FACTS_PER_SECTION} fatti dopo la ri-traduzione`,
      changed: false,
      result,
    };
  }
  const recognizedSections = parseAiSearchSections(result.value);
  const hasUsableFact = recognizedSections.some((section) => section.bullets.some(({ value }) => {
    const text = typeof value === 'string' ? value.trim() : '';
    return text.length > 0
      && /[\p{L}\p{N}]/u.test(text)
      && !matchesVacuousValue(text);
  }));
  if (result.residual.length > maxSourceBackedResiduals || (requireRecognizedSection && !hasUsableFact)) {
    return {
      sections,
      issue: '[key-facts-specificity] la ri-traduzione non conserva una sezione Fatti chiave riconosciuta con almeno un fatto non vuoto/non vacuo senza residui',
      changed: false,
      result,
    };
  }
  if (!result.changed) return { sections, issue: null, changed: false, result };
  return { sections: { ...sections, body1: result.value }, issue: null, changed: true, result };
}

/**
 * Decide se la nuova traduzione va scritta.
 *
 * E' il cuore del vincolo "mai peggiorare, mai riscrivere a mano", isolato in
 * una funzione pura proprio per essere testabile senza toccare la rete.
 */
export function shouldWrite({
  oldCodes,
  newCodes,
  missingField,
  sanity = null,
  qualityIssue = null,
  structuralDefect = false,
}) {
  if (missingField) return { write: false, reason: 'campo-vuoto-dalla-cascata' };
  if (qualityIssue) return { write: false, reason: qualityIssue };
  if (oldCodes.length === 0 && !structuralDefect) return { write: false, reason: 'vecchia-gia-pulita' };
  if (newCodes.length > 0) return { write: false, reason: `ri-fallita: ${newCodes.join(',')}` };
  if (sanity) return { write: false, reason: sanity };
  return { write: true, reason: 'pulita' };
}

/**
 * Il minimo di caratteri sotto cui il confronto di lunghezza non dice niente:
 * su un campo cortissimo la variazione naturale fra due traduzioni della stessa
 * frase supera qualunque soglia.
 */
export const LENGTH_FLOOR_MIN_CHARS = 400;

/**
 * Soglie del pavimento di lunghezza, come frazione del riferimento.
 *
 * `VS_OLD` confronta la ri-traduzione col body PUBBLICATO, cioe' con un testo
 * nella STESSA lingua e dalla STESSA sorgente italiana: due traduzioni sane
 * dello stesso originale stanno entro pochi punti percentuali, quindi 0,7 e'
 * larghissimo e scatta solo su un taglio vero. E' il motivo per cui qui si puo'
 * mettere un pavimento dove sulle traduzioni NUOVE non si poteva: li' il
 * riferimento era l'italiano (rapporto mediano 0,54, code sovrapposte, 17,7% di
 * falsi rifiuti misurati), qui c'e' il testo vecchio.
 *
 * `VS_IT` e' il ripiego per un campo che nel file di destinazione non esiste o
 * non e' leggibile: senza il vecchio resta solo l'italiano, e fra lingue
 * diverse il rapporto oscilla molto di piu' — 0,4 e' un taglio grossolano che
 * intercetta il clip a 2000 caratteri del tier HuggingFace
 * (`lib/free-translate.mjs`, `clean.slice(0, 2000)`) senza pretendere di
 * misurare la fedelta'.
 */
export const LENGTH_FLOOR = { VS_OLD: 0.7, VS_IT: 0.4 };

/**
 * Lunghezza minima di testo sotto cui `detectLanguage` non ha segnale — stessa
 * soglia di `isWrongLocale()` in `batch-add-faq-to-articles.mjs` e
 * `fix-faq-locales.mjs`, che gattano la scrittura per-locale allo stesso modo.
 */
export const LANG_CHECK_MIN_CHARS = 50;

/**
 * I modi in cui una ri-traduzione puo' essere INUTILIZZABILE senza che la
 * guardia se ne accorga. Nessuno dei due e' nel vocabolario di
 * `runFactualityGates`, che sul ramo non-italiano fa solo aggiudicazione
 * numerica, coerenza dei numeri e falsi amici:
 *
 *   1. TRONCAMENTO. Il tier HuggingFace tronca la SORGENTE a 2000 caratteri
 *      prima di tradurla, e il suo guard confronta l'output col testo intero,
 *      quindi non somiglia mai e passa. `detectTruncation` vede solo il testo
 *      tradotto: dopo un taglio a fine frase i marker restano bilanciati e i
 *      `critical` sono zero. Risultato senza questo controllo: una pagina
 *      pubblicata sostituita da una versione priva di tutto cio' che seguiva i
 *      primi 2000 caratteri dell'italiano, senza un errore.
 *   2. PASSTHROUGH DELL'ITALIANO. Un italiano ricopiato ha per costruzione gli
 *      stessi numeri e nessun falso amico: zero `critical`, si scriverebbe.
 *   3. RESIDUO PARZIALE. Un blocco italiano puo' essere minoritario rispetto
 *      alla prosa tradotta: per questo `scanItalianResidue()` guarda le righe
 *      e non la lingua del body concatenato.
 *
 * Ritorna `null` se il testo e' scrivibile, altrimenti la ragione del rifiuto
 * (che il report conta come tale, invece di lasciarla nel secchio "altro").
 */
export function translationSanityIssue({ oldSections, newSections, italianSections, locale, structuralRepair = false }) {
  const italianResidue = scanItalianResidue(newSections, locale);
  // Structural FU-009 repairs operate on whole missing/copied fields. The
  // line detector is deliberately sensitive for the historical residue audit,
  // but short fact bullets containing proper names are too small for a
  // language verdict (for example "Bologna coach → Alex Mumbrù") and would
  // reject valid translations. Keep long residual prose fail-closed; exact
  // source echoes are independently rejected by the caller and completeness
  // gate.
  const residueForWrite = structuralRepair
    ? italianResidue.filter((hit) => hit.text.length >= 120)
    : italianResidue;
  if (residueForWrite.length >= ITALIAN_RESIDUE_MIN_LINES) {
    return `italian-residue: ${residueForWrite.length} righe residue`;
  }
  for (const [f, text] of Object.entries(newSections)) {
    // DUE confronti, non uno scelto fra i due. Il pavimento contro la
    // pubblicata non puo' vedere un troncamento che vecchio e nuovo
    // CONDIVIDONO, ed e' il caso piu' probabile di questo lotto, non un angolo:
    // il body pubblicato viene gia' dal tier che taglia la sorgente a 2000
    // caratteri, la ri-traduzione riparte dalla stessa sorgente italiana e —
    // finche' i due tier alti sono indisponibili — ricade sullo stesso tier e
    // esce troncata uguale. `VS_OLD` la trova della stessa lunghezza e la
    // lascerebbe passare: si scriverebbe un body ancora mutilato dichiarandolo
    // riparato. 322 delle 459 coppie bloccanti sono troncamento.
    //
    // L'italiano e' l'unico riferimento che il taglio non ha accorciato, quindi
    // si guarda SEMPRE quando c'e'; la pubblicata resta il confronto stretto
    // (stessa lingua, stessa sorgente) che vale solo quando esiste.
    const itText = italianSections?.[f] || '';
    if (itText.length >= LENGTH_FLOOR_MIN_CHARS) {
      const ratio = text.length / itText.length;
      if (ratio < LENGTH_FLOOR.VS_IT) {
        return `troncata: ${f} ${text.length}/${itText.length} car. `
          + `(${ratio.toFixed(2)} < ${LENGTH_FLOOR.VS_IT} vs italiano)`;
      }
    }
    const ref = oldSections?.[f] || null;
    // `if` e non `continue`: un campo troppo corto per il pavimento di lunghezza
    // deve comunque passare dal controllo di lingua qui sotto.
    if (ref && ref.length >= LENGTH_FLOOR_MIN_CHARS) {
      const ratio = text.length / ref.length;
      if (ratio < LENGTH_FLOOR.VS_OLD) {
        return `troncata: ${f} ${text.length}/${ref.length} car. `
          + `(${ratio.toFixed(2)} < ${LENGTH_FLOOR.VS_OLD} vs pubblicata)`;
      }
    }
    // PER CAMPO, come il pavimento di lunghezza accanto, e non sui tre campi
    // concatenati. `translateFieldFreeMt` rifiuta gia' il passthrough esatto
    // confrontando l'uscita normalizzata con la sorgente (#1084); qui resta la
    // difesa indipendente contro un residuo PARZIALE o un chiamante che fornisca
    // direttamente le sezioni. Sul testo concatenato un solo `body2` italiano
    // sarebbe un terzo del totale: il rilevatore vedrebbe due terzi di inglese,
    // risponderebbe `en`, e la pagina /en/ prenderebbe comunque un paragrafo
    // italiano.
    if (text.length >= LANG_CHECK_MIN_CHARS) {
      // `locale` come fallback: un testo su cui il rilevatore non ha segnale non
      // deve diventare un rifiuto. Stessa forma di `isWrongLocale()`.
      const detected = detectLanguage(text, locale);
      if (detected !== locale) return `lingua-sbagliata: ${f} ${detected} invece di ${locale}`;
    }
  }
  return null;
}

const SCAN_V2_BODY_DIR = 'services/locales/blog-body';

/**
 * Coppie bloccanti dall'audit factuality o dal JSON prodotto da scan-v2.
 *
 * `scan-v2` non conosce la struttura dell'audit factuality: espone invece
 * `results: [{ lang, slug, count, hits }]`. Supportare entrambi i formati in
 * questo punto evita che il rilevatore dica «808 coppie» e il retranslator
 * torni comunque a zero perche' cercava solo `findings[].criticalCount`.
 */
export function blockingPairsFromAudit(audit) {
  const factualityPairs = (audit?.findings || [])
    .filter((f) => f.criticalCount > 0)
    .map((f) => ({
      id: f.id,
      locale: f.locale,
      dir: f.dir,
      codes: [...new Set((f.issues || [])
        .filter((i) => i.severity === 'critical')
        .map((i) => i.code))].sort(),
    }));
  const residuePairs = (audit?.results || [])
    .filter((r) => ['en', 'de', 'fr'].includes(r?.lang))
    .filter((r) => {
      const count = Array.isArray(r.hits) ? r.hits.length : Number(r.count);
      return Number.isFinite(count) && count >= ITALIAN_RESIDUE_MIN_LINES;
    })
    .map((r) => ({
      id: r.slug,
      locale: r.lang,
      dir: SCAN_V2_BODY_DIR,
      codes: ['italian-residue'],
    }));
  const merged = new Map();
  for (const pair of [...factualityPairs, ...residuePairs]) {
    const key = `${pair.dir || ''}\u0000${pair.locale}\u0000${pair.id}`;
    const current = merged.get(key);
    if (!current) {
      merged.set(key, { ...pair, codes: [...new Set(pair.codes)] });
      continue;
    }
    current.codes = [...new Set([...current.codes, ...pair.codes])].sort();
  }
  return [...merged.values()];
}

/** Id articolo da `--slug a,b`. Vuoto se il flag manca o e' una stringa vuota. */
export function parseSlugList(raw) {
  if (raw == null || raw === '') return [];
  return [...new Set(String(raw).split(',').map((s) => s.trim()).filter(Boolean))];
}

export function parseLocaleList(raw) {
  if (raw == null || raw === '') return [];
  return [...new Set(String(raw).split(',').map((s) => s.trim()).filter(Boolean))];
}

/**
 * Filtra le coppie per locale e slug. `it` entra SOLO se e' nella lista
 * locali: il default resta en,de,fr, ma `--locale it` non lo droppa piu'
 * in silenzio (follow-up #1084: nessun entry point rigenerava un italiano
 * esistente). Non chiama `registerArticleFiles()`: la scrittura resta
 * `replaceBodyField` + `writeAtomic` sul file gia' registrato.
 */
export function selectBlockingPairs(pairs, { locales, slugs } = {}) {
  const localeSet = new Set(Array.isArray(locales) ? locales : []);
  // `null`/`undefined` mean that --slug was absent; an explicit empty list is
  // an active filter and must select nothing. Treating both as `null` lets an
  // empty shell variable turn an --apply audit into a whole-corpus rewrite.
  const slugSet = slugs == null
    ? null
    : new Set(Array.isArray(slugs) ? slugs : []);
  return (Array.isArray(pairs) ? pairs : []).filter((p) => {
    if (!localeSet.has(p.locale)) return false;
    if (slugSet && !slugSet.has(p.id)) return false;
    return true;
  });
}

/**
 * Sintetizza le coppie dai body gia' in `content/` per uno slug arbitrario.
 * Serve quando non c'e' un audit: e' il percorso in-place generalizzato
 * oltre i tre evergreen a id fisso, senza toccare il registrar append-only.
 */
export function pairsForSlugs(slugs, locales, contentRoot) {
  const out = [];
  const uniqueSlugs = [...new Set(Array.isArray(slugs) ? slugs.filter(Boolean) : [])];
  const uniqueLocales = [...new Set(Array.isArray(locales) ? locales.filter(Boolean) : [])];
  for (const id of uniqueSlugs) {
    if (!id) continue;
    for (const locale of uniqueLocales) {
      for (const [dir, realDir] of Object.entries(DIR_TO_REAL)) {
        const file = resolve(contentRoot, realDir, locale, `${id}.ts`);
        if (existsSync(file)) out.push({ id, locale, dir, codes: ['in-place'] });
      }
    }
  }
  return out;
}

/** Locali misurati da `--count-only`: lo stock comprende anche l'italiano. */
export const SCAN_COUNT_LOCALES = Object.freeze(['it', 'en', 'de', 'fr']);

/** Chiave stabile di una coppia, la stessa di `--list-out`. */
export const scanPairKey = (pair) => `${pair.dir}/${pair.locale}/${pair.id}`;

function readSections(src, id, fields = bodyFieldsForSource(src, id)) {
  const sections = {};
  for (const f of fields) {
    const v = readBodyField(src, id, f);
    if (v) sections[f] = v;
  }
  return sections;
}

/**
 * Le cartelle che `--scan` deve vedere per dare una conta completa: per ogni
 * albero di `DIR_TO_REAL`, ogni locale chiesto e l'`it` di riferimento.
 * Restituisce i path relativi a `contentRoot` che mancano sul disco.
 *
 * Senza questo controllo una cartella assente (worktree sparse, checkout
 * parziale, `--content-root` sbagliato) verrebbe saltata e la conta uscirebbe
 * piu' bassa con exit 0: uno stock dimezzato che si legge come bonificato.
 */
export function scanContentGaps(contentRoot, { locales = ['en', 'de', 'fr'] } = {}) {
  const wanted = [...new Set(['it', ...(Array.isArray(locales) ? locales.filter(Boolean) : [])])];
  const missing = [];
  for (const realDir of Object.values(DIR_TO_REAL)) {
    if (!existsSync(resolve(contentRoot, realDir))) {
      missing.push(realDir);
      continue;
    }
    for (const locale of wanted) {
      if (!existsSync(resolve(contentRoot, realDir, locale))) missing.push(`${realDir}/${locale}`);
    }
  }
  return missing;
}

const isRegularFile = (file) => {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
};

/**
 * Confronta i body che git TRACCIA sotto gli alberi di `DIR_TO_REAL` con quelli
 * presenti sul disco, per l'`it` di riferimento e i `locales` chiesti (e, se
 * `ids` e' dato, solo per quegli id).
 *
 * Chiedere a `git ls-files -v` il solo bit `S` (skip-worktree) non bastava: un
 * body tracciato e CANCELLATO dal worktree resta fuori da `readdirSync`, e la
 * conta usciva 0, piu' bassa, come uno stock bonificato. Qui conta l'elenco
 * atteso contro i file materializzati, qualunque sia la causa dell'assenza
 * (sparse, `rm`, un `x.ts` diventato cartella).
 *
 * Fuori da un checkout git (fixture, archivio estratto da `git archive`) non
 * c'e' un elenco atteso: `{ git: false }`. Un git che risponde con un errore
 * diverso da "not a git repository" NON e' un'assenza: torna `error`, e chi
 * chiama fallisce chiuso.
 *
 * @param {string} contentRoot radice che contiene `content/`
 * @param {{ locales?: string[], ids?: string[] | null }} [opts]
 * @returns {{ git: boolean, missing: string[], skipWorktree: number, error?: string }}
 */
export function trackedBodyGaps(contentRoot, { locales = ['en', 'de', 'fr'], ids = null } = {}) {
  const wanted = new Set(['it', ...(Array.isArray(locales) ? locales.filter(Boolean) : [])]);
  const idSet = ids == null ? null : new Set(ids);
  const result = { git: false, missing: [], skipWorktree: 0 };
  const probe = spawnSync('git', ['-C', contentRoot, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' });
  if (probe.error) return { ...result, error: `git non eseguibile: ${probe.error.message}` };
  if (probe.status !== 0) {
    if (/not a git repository/i.test(probe.stderr || '')) return result;
    return { ...result, error: `git rev-parse: ${(probe.stderr || '').trim() || `exit ${probe.status}`}` };
  }
  if (String(probe.stdout).trim() !== 'true') return result;
  const res = spawnSync('git', ['-C', contentRoot, 'ls-files', '-v', '-z', '--', ...Object.values(DIR_TO_REAL)], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  if (res.error || res.status !== 0 || typeof res.stdout !== 'string') {
    return { ...result, git: true, error: `git ls-files: ${res.error?.message || (res.stderr || '').trim() || `exit ${res.status}`}` };
  }
  result.git = true;
  for (const entry of res.stdout.split('\0')) {
    if (entry.length < 3) continue;
    const tag = entry[0];
    const rel = entry.slice(2);
    const realDir = Object.values(DIR_TO_REAL).find((d) => rel.startsWith(`${d}/`));
    if (!realDir) continue;
    const parts = rel.slice(realDir.length + 1).split('/');
    if (parts.length !== 2 || !parts[1].endsWith('.ts')) continue;
    const [locale, name] = parts;
    if (!wanted.has(locale)) continue;
    if (idSet && !idSet.has(name.slice(0, -'.ts'.length))) continue;
    if (tag === 'S') result.skipWorktree += 1;
    if (!isRegularFile(resolve(contentRoot, rel))) result.missing.push(rel);
  }
  result.missing.sort();
  return result;
}

/**
 * Messaggi d'errore della guardia sui body tracciati; vuoto se il set e'
 * completo. Unico punto usato da tutti i rami che leggono `content/`.
 */
export function trackedBodyGapErrors(contentRoot, opts = {}) {
  const gaps = trackedBodyGaps(contentRoot, opts);
  const errors = [];
  if (gaps.error) errors.push(`impossibile verificare i body tracciati sotto ${contentRoot} (${gaps.error}).`);
  if (gaps.skipWorktree > 0) {
    errors.push(`${gaps.skipWorktree} body tracciati ma non materializzati (skip-worktree) sotto ${contentRoot}.`);
  }
  if (gaps.missing.length) {
    const shown = gaps.missing.slice(0, 10).join(', ');
    const more = gaps.missing.length > 10 ? ` (e altri ${gaps.missing.length - 10})` : '';
    errors.push(`${gaps.missing.length} body tracciati ma assenti dal worktree sotto ${contentRoot}: ${shown}${more}.`);
  }
  return errors;
}

/**
 * Selettore dal CONTENUTO: le coppie bloccanti senza il file `--audit`.
 *
 * L'audit ufficiale (`audit-article-factuality.mjs`) vive solo nel sito e
 * tiene in memoria l'intero corpus (~6 GB di heap): nessun workflow del corpus
 * lo puo' ne' importare (il confine e' HTTP) ne' lanciare, e senza il suo file
 * lo strumento usciva 2. Qui si applica la STESSA guardia che `processPair`
 * usa per decidere `oldCodes` — `runFactualityGates` sui campi body del file,
 * con l'italiano dello stesso id come riferimento, e i soli `critical` — un
 * file alla volta: per ogni `content/blog-body[-ch]/<locale>/<id>.ts` si leggono
 * quel file e il suo `it`, poi si lasciano andare.
 *
 * Il `dir` restituito e' quello dell'audit (`services/locales/blog-body[-ch]`)
 * perche' `processPair` lo traduce con `DIR_TO_REAL`: le coppie entrano nella
 * pipeline esistente senza adattatori. Ogni coppia porta anche `evidence`
 * (primo rilievo `critical` per codice, l'estratto gia' troncato a 200
 * caratteri dalla guardia): serve a chi deve GIUDICARE un campione prima di
 * una scrittura, perche' il report di `processPair` non contiene contesti.
 *
 * Una traduzione senza il suo italiano resta valutata (scaffolding e
 * troncamenti non dipendono dal riferimento): la conta dello stock deve
 * vederla, e `processPair` la salta come `sorgente-mancante`.
 *
 * Una cartella assente qui viene saltata: la completezza dell'albero la
 * prova `main` con `scanContentGaps` e `trackedBodyGaps` PRIMA della
 * scansione, e senza quella prova (o con `scanned` a zero) `--scan` esce 2.
 * Una voce `.ts` che non e' un file regolare non viene letta: se git la
 * traccia come body, `trackedBodyGaps` l'ha gia' segnalata.
 *
 * Funzione pura sul filesystem in sola lettura: zero rete, zero MT, nessuna
 * scrittura.
 *
 * @param {string} contentRoot radice che contiene `content/`
 * @param {{ locales?: string[] }} [opts]
 * @returns {{ scanned: number, pairs: Array<{ id: string, locale: string, dir: string, codes: string[], evidence: Array<{ code: string, excerpt: string }> }> }}
 */
export function scanContentForBlockingPairs(contentRoot, { locales = ['en', 'de', 'fr'] } = {}) {
  const uniqueLocales = [...new Set(Array.isArray(locales) ? locales.filter(Boolean) : [])];
  const pairs = [];
  let scanned = 0;
  for (const [dir, realDir] of Object.entries(DIR_TO_REAL)) {
    for (const locale of uniqueLocales) {
      const localeDir = resolve(contentRoot, realDir, locale);
      if (!existsSync(localeDir)) continue;
      const files = readdirSync(localeDir)
        .filter((name) => name.endsWith('.ts') && isRegularFile(resolve(localeDir, name)))
        .sort();
      for (const name of files) {
        const id = name.slice(0, -'.ts'.length);
        const src = readFileSync(resolve(localeDir, name), 'utf8');
        scanned += 1;
        let sections;
        let italianSections = null;
        if (locale === 'it') {
          sections = readSections(src, id);
          italianSections = sections;
        } else {
          // Come `processPair`: i campi della traduzione sono quelli dell'`it`
          // (`bodyFieldsForSource(itSrc)`), cosi' un bodyN che esiste solo
          // nella traduzione non fa entrare una coppia che `processPair`
          // giudicherebbe 'vecchia-gia-pulita'. Senza `it` si usano i campi
          // della traduzione stessa.
          const itPath = resolve(contentRoot, realDir, 'it', name);
          const itSrc = existsSync(itPath) ? readFileSync(itPath, 'utf8') : null;
          const itFields = itSrc === null ? [] : bodyFieldsForSource(itSrc, id);
          if (itFields.length) {
            const itSections = readSections(itSrc, id, itFields);
            if (Object.keys(itSections).length) italianSections = itSections;
            sections = readSections(src, id, itFields);
          } else {
            sections = readSections(src, id);
          }
        }
        if (!Object.keys(sections).length) continue;
        const result = runFactualityGates({ sections, locale, italianSections });
        const codes = criticalCodes(result);
        if (!codes.length) continue;
        const evidence = codes.map((code) => ({
          code,
          excerpt: (result.issues || []).find((i) => i.severity === 'critical' && i.code === code)?.evidence || '',
        }));
        pairs.push({ id, locale, dir, codes, evidence });
      }
    }
  }
  pairs.sort((a, b) => (scanPairKey(a) < scanPairKey(b) ? -1 : scanPairKey(a) > scanPairKey(b) ? 1 : 0));
  return { scanned, pairs };
}

/**
 * Coppie bloccanti dal contenuto, nello stesso formato di
 * `blockingPairsFromAudit` (`{ id, locale, dir, codes }`).
 */
export function blockingPairsFromContent(contentRoot, { locales } = {}) {
  return scanContentForBlockingPairs(contentRoot, { locales })
    .pairs.map(({ id, locale, dir, codes }) => ({ id, locale, dir, codes }));
}

/**
 * Conteggio per codice e locale: la metrica dello stock. Una coppia con due
 * codici conta in entrambi; `total` e' per codice, non coppie distinte.
 */
export function countBlockingPairs(pairs, { scanned = 0, locales = SCAN_COUNT_LOCALES } = {}) {
  const localeKeys = [...new Set([...SCAN_COUNT_LOCALES, ...(locales || [])])];
  const byCode = {};
  for (const pair of Array.isArray(pairs) ? pairs : []) {
    for (const code of pair.codes || []) {
      if (!byCode[code]) {
        byCode[code] = Object.fromEntries([...localeKeys.map((l) => [l, 0]), ['total', 0]]);
      }
      byCode[code][pair.locale] = (byCode[code][pair.locale] || 0) + 1;
      byCode[code].total += 1;
    }
  }
  const sorted = Object.fromEntries(Object.keys(byCode).sort().map((code) => [code, byCode[code]]));
  return { scanned, byCode: sorted };
}

/** Righe JSONL di `--list-out`, ordinate per `key`. */
export function scanListLines(pairs) {
  return (Array.isArray(pairs) ? pairs : [])
    .map((pair) => ({ key: scanPairKey(pair), codes: pair.codes, evidence: pair.evidence || [] }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((row) => JSON.stringify(row));
}

/**
 * Converte il report strutturale FU-009 in coppie consumabili dalla pipeline
 * di ri-traduzione. Si selezionano solo difetti riparabili per campo: un file
 * con un body corretto non viene riscritto insieme a quello mancante/italiano.
 */
export function completenessPairsFromReport(report) {
  const byPair = new Map();
  for (const violation of report?.violations || []) {
    if (!['missing-key', 'source-echo', 'wrong-locale'].includes(violation.code)) continue;
    const dir = violation.section === 'svizzera'
      ? 'services/locales/blog-body-ch'
      : violation.section === 'frontaliere'
        ? 'services/locales/blog-body'
        : null;
    if (!dir || !violation.locale || !violation.file) continue;
    const id = violation.file.replace(/\.ts$/u, '');
    const key = `${dir}\u0000${violation.locale}\u0000${id}`;
    const current = byPair.get(key) || {
      id,
      locale: violation.locale,
      dir,
      codes: [],
      fields: [],
      structural: true,
    };
    if (!current.codes.includes(violation.code)) current.codes.push(violation.code);
    if (violation.field && !current.fields.includes(violation.field)) current.fields.push(violation.field);
    byPair.set(key, current);
  }
  return [...byPair.values()].map((pair) => ({
    ...pair,
    codes: pair.codes.sort(),
    fields: pair.fields.sort(),
  }));
}

/**
 * Riscrive i campi body di un file locale GIA' registrato. Non crea id
 * nuovi e non chiama `registerArticleFiles()` (append-only). `null` su
 * una chiave assente: meglio saltare che riscrivere a meta'.
 */
export function rewriteExistingLocaleBody(src, id, sections, { allowMissing = false } = {}) {
  let next = src;
  for (const [field, value] of Object.entries(sections || {})) {
    const replaced = replaceBodyField(next, id, field, value);
    if (replaced !== null) {
      next = replaced;
      continue;
    }
    const inserted = allowMissing ? insertBodyField(next, id, field, value) : null;
    if (inserted === null) return { src: next, missing: field };
    next = inserted;
  }
  return { src: next, missing: null };
}

/** Il solo codice per cui l'italiano ha una riparazione (riga del prompt). */
export const TITLE_MARKER_REPAIR_CODE = 'leaked-prompt-scaffolding';

/**
 * Decide se la rimozione della riga `TITOLO ARTICOLO: <titolo>` da un body
 * italiano si puo' scrivere, e prepara il sorgente da scrivere.
 *
 * Ritorna `{ issue, src }`: `issue` e' il motivo del rifiuto (che diventa il
 * `reason` del report, e la pagina resta intatta), altrimenti `null` e `src`
 * e' il file da scrivere. Rifiuta, nell'ordine:
 *
 *   - `codici-misti`: la pagina ha altri `critical` oltre allo scaffolding.
 *     Togliere la riga la lascerebbe comunque bloccata, e un'altra
 *     riparazione non passa di qui;
 *   - `forma-non-riparabile: <motivo>: <riga>`: il token compare in una forma
 *     che non e' una riga intera (intestazione, titolo su un'altra riga…);
 *   - `forma-non-riparabile: nessuna-riga-marcatore`: niente da togliere;
 *   - `forma-non-riparabile: diff-oltre-la-riga (<campo>)`: il testo che si
 *     scriverebbe (dopo sanificazione e guardia dei fatti chiave) differisce
 *     dal pubblicato per piu' della riga tolta;
 *   - `forma-non-riparabile: file-oltre-la-riga`: riscrivere il campo
 *     cambierebbe altri byte del file (campo non nella forma canonica dello
 *     scrittore, caratteri di controllo che `writeAtomic` toglierebbe).
 *
 * Si riscrivono SOLO i campi da cui una riga e' stata tolta: gli altri restano
 * byte per byte come sono.
 */
export function planTitleMarkerRemoval({
  src, id, oldCodes = [], oldSections = {}, newSections = {}, removedByField = {}, skipped = [],
}) {
  const others = oldCodes.filter((code) => code !== TITLE_MARKER_REPAIR_CODE);
  if (others.length) return { issue: 'codici-misti', src: null };
  if (skipped.length) return { issue: `forma-non-riparabile: ${skipped.join(' | ')}`, src: null };
  const changed = Object.keys(removedByField).filter((f) => removedByField[f]?.length);
  if (!changed.length) return { issue: 'forma-non-riparabile: nessuna-riga-marcatore', src: null };
  const fields = [...new Set([...Object.keys(oldSections), ...Object.keys(newSections)])];
  for (const f of fields) {
    if (!diffIsExactlyRemovedLines(oldSections[f], newSections[f], removedByField[f] || [])) {
      return { issue: `forma-non-riparabile: diff-oltre-la-riga (${f})`, src: null };
    }
  }
  const toWrite = Object.fromEntries(changed.map((f) => [f, newSections[f]]));
  const rewritten = rewriteExistingLocaleBody(src, id, toWrite);
  if (rewritten.missing) return { issue: `chiave-assente: ${rewritten.missing}`, src: null };
  // Prova a livello di file: rimettere i valori pubblicati nei campi toccati
  // deve ridare il file originale byte per byte, e `writeAtomic` non deve
  // avere niente da togliere. Altrimenti la scrittura cambierebbe altro.
  const restored = rewriteExistingLocaleBody(
    rewritten.src,
    id,
    Object.fromEntries(changed.map((f) => [f, oldSections[f]])),
  );
  if (restored.missing || restored.src !== src || sanitizeText(rewritten.src) !== rewritten.src) {
    return { issue: 'forma-non-riparabile: file-oltre-la-riga', src: null };
  }
  return { issue: null, src: rewritten.src };
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
  const exact = `--${name}`;
  const i = argv.indexOf(exact);
  // Il flag SUCCESSIVO non e' il valore di questo: `--slug --audit a.json`
  // consumava `--audit` come slug letterale, selezionava zero coppie e usciva
  // 0 — il no-op silenzioso che si legge come "non c'era niente da fare".
  //
  // Ma "valore mancante" NON puo' ricadere sul default, ed e' il verso
  // pericoloso: `--limit --apply` diventerebbe `LIMIT=Infinity` e
  // `--code --apply` TOGLIEREBBE il filtro per codice, allargando la
  // riscrittura all'audit intero. Un flag che chiede un valore e non lo ha e'
  // un errore di invocazione, quindi si esce 2 prima di applicare qualsiasi
  // default. Il flag ASSENTE resta il caso legittimo del default.
  if (i !== -1) {
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      console.error(`❌ ${exact} richiede un valore${next === undefined ? '' : ` (trovato "${next}")`}.`);
      process.exit(2);
    }
    return next;
  }
  const inline = argv.find((arg) => arg.startsWith(`${exact}=`));
  return inline === undefined ? dflt : inline.slice(exact.length + 1);
};
// `has()` risponde alla PRESENZA del flag, qualunque sia il valore inline.
// Serve a `--slug`, dove `--slug=` e' un filtro attivo e vuoto che deve far
// scattare la guardia qui sotto: se `has('slug')` tornasse `false` sul valore
// vuoto, il filtro risulterebbe ASSENTE e si tornerebbe alla riscrittura di
// tutto il corpus, cioe' esattamente il difetto che questa PR chiude.
const has = (name) => {
  const exact = `--${name}`;
  return argv.includes(exact) || argv.some((arg) => arg.startsWith(`${exact}=`));
};
/** Negazioni inline riconosciute per i flag BOOLEANI. */
const NEGATED_INLINE = new Set(['false', '0', 'no', 'off']);

/**
 * Presenza MENO negazione inline: e' cio' che serve a un flag BOOLEANO.
 *
 * Con la sola presenza (`has()`) `--apply=false` entrava nel percorso di
 * SCRITTURA e poteva riscrivere body pubblicati — il valore diceva "no" e il
 * parser leggeva "si'". Stessa classe per `--json=false` e `--stratify=false`.
 *
 * NON si puo' usare `bool()` per `--slug`: la' il valore vuoto e' un filtro
 * attivo, non un "no", e confonderli riapre la riscrittura di tutto il corpus.
 *
 * Puro ed esportato perche' e' la logica su cui sta un percorso di scrittura,
 * e un test la esercita senza lanciare la pipeline.
 *
 * @param {string[]} args
 * @param {string} name
 * @returns {boolean}
 */
export function inlineBoolean(args, name) {
  const list = Array.isArray(args) ? args : [];
  const exact = `--${name}`;
  if (list.includes(exact)) return true;
  const inline = list.find((arg) => typeof arg === 'string' && arg.startsWith(`${exact}=`));
  if (inline === undefined) return false;
  const value = inline.slice(exact.length + 1).trim().toLowerCase();
  // `--apply=` senza valore NON abilita la scrittura: su un flag che riscrive
  // contenuto pubblicato un'invocazione malformata cade sul lato sicuro. E' la
  // differenza con `has()`, dove il valore vuoto e' un filtro e non un "si'".
  return value !== '' && !NEGATED_INLINE.has(value);
}
const bool = (name) => inlineBoolean(argv, name);

async function main() {
  const auditPath = flag('audit');
  const rawSlug = flag('slug');
  const SLUGS = parseSlugList(rawSlug);
  const MISSING = bool('missing');
  // `--slug` is a safety boundary for --apply: an explicitly empty value
  // must not silently become "no filter" and let an audit rewrite every pair.
  // Keep the parser's null/empty result useful to callers, but reject the
  // ambiguous CLI spelling before reading any audit or content tree.
  if (has('slug') && SLUGS.length === 0) {
    console.error(`❌ --slug "${rawSlug ?? ''}" è vuoto. Indica almeno uno slug.`);
    process.exit(2);
  }
  // `--out=` vuoto ricadeva su stdout in silenzio, e questo flag esiste proprio
  // perche' stdout NON e' parsabile: i tier della cascata ci loggano le
  // rotazioni di chiave. Una destinazione chiesta e persa e' il report perso.
  if (has('out') && !flag('out')) {
    console.error('❌ --out è vuoto. Indica un file oppure ometti il flag per il report su stdout.');
    process.exit(2);
  }
  const SCAN = bool('scan');
  const COUNT_ONLY = bool('count-only');
  if (!auditPath && SLUGS.length === 0 && !MISSING && !SCAN) {
    console.error('❌ --audit <file.json>, --slug <id>, --missing oppure --scan è richiesto.');
    process.exit(2);
  }
  if (MISSING && (auditPath || SLUGS.length > 0)) {
    console.error('❌ --missing non si combina con --audit o --slug.');
    process.exit(2);
  }
  // Un solo sorgente di coppie: `--scan --audit` non deve decidere in silenzio
  // quale dei due vince, perche' con --apply sarebbe la differenza fra il
  // lotto chiesto e un altro.
  if (SCAN && (has('audit') || has('slug') || MISSING)) {
    console.error('❌ --scan non si combina con --audit, --slug o --missing.');
    process.exit(2);
  }
  if ((COUNT_ONLY || has('list-out')) && !SCAN) {
    console.error('❌ --count-only e --list-out valgono solo con --scan.');
    process.exit(2);
  }
  if (has('list-out') && !flag('list-out')) {
    console.error('❌ --list-out è vuoto. Indica un file oppure ometti il flag.');
    process.exit(2);
  }
  const APPLY = bool('apply');
  // `--count-only --apply` e' contraddittorio: la conta non scrive mai, e
  // ignorare l'--apply farebbe credere a chi lancia di aver bonificato.
  if (COUNT_ONLY && APPLY) {
    console.error('❌ --count-only non si combina con --apply.');
    process.exit(2);
  }
  const AS_JSON = bool('json');
  // `|| Infinity` sarebbe sbagliato: `--limit 0` e' zero, non "nessun limite".
  const rawLimit = flag('limit');
  const LIMIT = rawLimit === null ? Infinity : Number(rawLimit);
  // Il negativo va rifiutato ESPLICITAMENTE, e non e' pedanteria: `Number('-1')`
  // e' finito, quindi passerebbe il controllo qui sotto, e `pairs.slice(0, -1)`
  // non seleziona una coppia — le seleziona TUTTE MENO L'ULTIMA. `--apply
  // --limit -1`, che e' il modo naturale di scrivere "nessun limite" per chi non
  // sa che il default e' gia' `Infinity`, trasformerebbe un pilota nella
  // bonifica completa delle 416 coppie.
  if (Number.isFinite(LIMIT) && LIMIT < 0) {
    console.error(`❌ --limit "${rawLimit}" è negativo. Ometti il flag per non avere limite.`);
    process.exit(2);
  }
  if (!Number.isFinite(LIMIT) && rawLimit !== null) {
    console.error(`❌ --limit "${rawLimit}" non è un numero.`);
    process.exit(2);
  }
  const CONCURRENCY = Math.max(1, Number(flag('concurrency', 2)) || 2);
  const CONTENT_ROOT = resolve(flag('content-root', ROOT));
  const rawLocale = flag('locale', COUNT_ONLY ? SCAN_COUNT_LOCALES.join(',') : 'en,de,fr');
  const LOCALES = parseLocaleList(rawLocale);
  // `--locale=` (o `--locale ' , '`) dava `LOCALES=[]`: nessun locale da
  // leggere, nessuna coppia, exit 0 — con --count-only uno stock vuoto che si
  // legge come bonificato. Come per `--slug=`, una lista chiesta e vuota e' un
  // errore di invocazione, in TUTTI i rami, prima di leggere audit o content/.
  if (LOCALES.length === 0) {
    console.error(`❌ --locale "${rawLocale ?? ''}" è vuoto. Indica almeno un locale (it, en, de, fr) oppure ometti il flag.`);
    process.exit(2);
  }
  const CODE = flag('code');
  const SLUG_FILTER = has('slug') ? SLUGS : undefined;

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

  // Ogni ramo che legge `content/` passa da qui: la guardia globale sopra
  // scatta solo se mancano TUTTI gli alberi, e una cartella o un body assente
  // altrove dava una selezione parziale con exit 0. `ids` restringe il
  // confronto agli articoli del ramo (--slug, --audit); `dirs` aggiunge il
  // controllo delle cartelle `<albero>/<locale>` per i rami che scansionano
  // l'albero intero (--scan, --missing).
  const failClosedOnIncompleteTree = (branch, { ids = null, dirs = false } = {}) => {
    const errors = [];
    if (dirs) {
      const gaps = scanContentGaps(CONTENT_ROOT, { locales: LOCALES });
      if (gaps.length) errors.push(`albero dei body incompleto sotto ${CONTENT_ROOT}, mancano: ${gaps.join(', ')}.`);
    }
    errors.push(...trackedBodyGapErrors(CONTENT_ROOT, { locales: LOCALES, ids }));
    if (!errors.length) return;
    for (const message of errors) console.error(`❌ ${branch}: ${message}`);
    console.error('   Una selezione parziale si leggerebbe come stock bonificato: passa --content-root su un checkout completo.');
    process.exit(2);
  };

  let pairs;
  if (SCAN) {
    // `--scan` e' la metrica (e la base del ratchet): in uno sparse
    // `content/blog-body/it` con un solo file dava `{ scanned: 1, byCode: {} }`
    // con exit 0, e un body tracciato ma cancellato abbassava la conta in
    // silenzio. Fallisce chiuso su cartelle mancanti e body tracciati assenti.
    failClosedOnIncompleteTree('--scan', { dirs: true });
    const scan = scanContentForBlockingPairs(CONTENT_ROOT, { locales: LOCALES });
    // Cartelle tutte presenti ma vuote (o un archivio senza body): zero file
    // letti non e' "zero bloccanti".
    if (scan.scanned === 0) {
      console.error(`❌ --scan: nessun body letto sotto ${CONTENT_ROOT} per i locali ${LOCALES.join(',')}.`);
      process.exit(2);
    }
    const selected = scan.pairs.filter((p) => !CODE || p.codes.includes(CODE));
    if (has('list-out')) {
      const lines = scanListLines(selected);
      writeAtomic(flag('list-out'), lines.length ? `${lines.join('\n')}\n` : '');
    }
    if (COUNT_ONLY) {
      const counts = JSON.stringify(countBlockingPairs(selected, { scanned: scan.scanned, locales: LOCALES }), null, 2);
      if (flag('out')) writeAtomic(flag('out'), `${counts}\n`);
      console.log(counts);
      return;
    }
    // Stesso formato dell'audit: `evidence` resta nel --list-out, non nel report.
    pairs = selected.map(({ id, locale, dir, codes }) => ({ id, locale, dir, codes }));
  } else if (MISSING) {
    // Anche --missing scansiona l'albero intero: un body tracciato e assente
    // sparirebbe dal report di completezza invece di comparire come difetto.
    failClosedOnIncompleteTree('--missing', { dirs: true });
    pairs = completenessPairsFromReport(inspectBlogLocaleCompleteness({ root: CONTENT_ROOT }));
    pairs = selectBlockingPairs(pairs, { locales: LOCALES, slugs: undefined });
  } else if (auditPath) {
    const audit = JSON.parse(readFileSync(auditPath, 'utf8'));
    pairs = selectBlockingPairs(blockingPairsFromAudit(audit), {
      locales: LOCALES,
      slugs: SLUG_FILTER,
    });
    // Le coppie dell'audit si leggono da content/: un loro body tracciato e
    // assente uscirebbe 'sorgente-mancante' con exit 0.
    if (pairs.length) failClosedOnIncompleteTree('--audit', { ids: [...new Set(pairs.map((p) => p.id))] });
  } else {
    // Senza audit lo slug e' l'unica chiave: riscrittura in-place di un
    // articolo gia' registrato, italiano compreso. Nessun id nuovo.
    failClosedOnIncompleteTree('--slug', { ids: SLUGS });
    pairs = selectBlockingPairs(pairsForSlugs(SLUGS, LOCALES, CONTENT_ROOT), {
      locales: LOCALES,
      slugs: SLUG_FILTER,
    });
    // Uno slug chiesto che non corrisponde a nessun body nei locali chiesti
    // (refuso, locale sbagliato, articolo non ancora nel checkout) era un
    // no-op a exit 0: "niente da fare" invece di "non l'ho trovato".
    const found = new Set(pairs.map((p) => p.id));
    const ghosts = SLUGS.filter((id) => !found.has(id));
    if (ghosts.length) {
      console.error(`❌ --slug: nessun body per ${ghosts.join(', ')} nei locali ${LOCALES.join(',')} sotto ${CONTENT_ROOT}.`);
      process.exit(2);
    }
  }
  pairs = pairs.filter((p) => !CODE || p.codes.includes(CODE));

  pairs = bool('stratify') && LIMIT !== Infinity ? stratify(pairs, LIMIT) : pairs.slice(0, LIMIT);

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

  const availableBodyFields = bodyFieldsForSource(itSrc, pair.id);
  const repairFields = pair.structural && Array.isArray(pair.fields) && pair.fields.length > 0
    ? availableBodyFields.filter((field) => pair.fields.includes(field))
    : availableBodyFields;
  const italianSections = {};
  for (const f of repairFields) {
    const v = readBodyField(itSrc, pair.id, f);
    if (v) italianSections[f] = v;
  }
  if (!Object.keys(italianSections).length) {
    return { ...base, written: false, reason: 'italiano-illeggibile' };
  }

  const isSourceLocale = pair.locale === 'it';
  const oldSections = {};
  if (isSourceLocale) {
    Object.assign(oldSections, italianSections);
  } else {
    for (const f of repairFields) {
      const v = readBodyField(trSrc, pair.id, f);
      if (v) oldSections[f] = v;
    }
  }
  const factualityCodes = criticalCodes(runFactualityGates({ sections: oldSections, locale: pair.locale, italianSections }));
  const oldItalianResidue = scanItalianResidue(oldSections, pair.locale);
  const oldCodes = [...new Set([
    ...currentBlockingCodes({ factualityCodes, italianResidue: oldItalianResidue }),
    ...(pair.structural ? (pair.codes || []) : []),
  ])].sort();

  const newSections = {};
  let missingField = null;
  // Solo sull'italiano con scaffolding: la riga del prompt da togliere, per campo.
  const titleMarkerRepair = isSourceLocale && oldCodes.includes(TITLE_MARKER_REPAIR_CODE)
    ? { removedByField: {}, skipped: [] }
    : null;
  if (isSourceLocale) {
    // L'italiano e' il sorgente: ri-tradurlo non ha senso. Si riscrive IN
    // PLACE sullo stesso file, con lo stesso `shouldWrite` della bonifica
    // dei locale, senza `registerArticleFiles()` (append-only). Il contenuto
    // nuovo e' il body esistente passato da `sanitizeBodyText` — la stessa
    // sanificazione del percorso di produzione.
    //
    // Con `leaked-prompt-scaffolding`, PRIMA della sanificazione si toglie la
    // sola riga `TITOLO ARTICOLO: <titolo>` (approvazione del proprietario del
    // 2026-10-04, site 7682): e' la cancellazione del token esatto del prompt
    // che il gate stesso prescrive, non una riscrittura, e si scrive solo se
    // `planTitleMarkerRemoval` prova che il diff e' quella riga e nient'altro.
    // Ogni altra forma del marcatore, e ogni rigenerazione editoriale
    // (istituzioni fabbricate, scaffolding in prosa), resta un'altra
    // operazione: qui la pagina non si tocca.
    for (const f of Object.keys(italianSections)) {
      let source = italianSections[f];
      if (titleMarkerRepair) {
        const stripped = stripLeakedTitleMarkerLine(source);
        source = stripped.value;
        titleMarkerRepair.removedByField[f] = stripped.removed;
        titleMarkerRepair.skipped.push(...stripped.skipped.map((s) => `${f} ${s}`));
      }
      const sanitized = sanitizeTranslatedField(source);
      if (sanitized === null) { missingField = f; break; }
      newSections[f] = sanitized;
    }
  } else {
    // Ri-traduzione: OGNI carattere qui esce dalla cascata MT, mai da una regex.
    for (const f of Object.keys(italianSections)) {
      const out = await translateFieldFreeMt({
        text: italianSections[f],
        sourceLang: 'it',
        targetLang: pair.locale,
        fieldType: 'description',
        fieldName: f,
        translate: freeTranslateWithRetry,
        balanceMarkdown: balanceMarkdownMarkers,
      });
      if (!out) { missingField = f; break; }
      // Stesso post-processing del percorso di produzione (`create-article.mjs`
      // lo applica alla stessa identica uscita di `translateFieldFreeMt`): la
      // cascata e' la stessa, e da qui in poi lo e' anche cio' che le succede.
      const sanitized = sanitizeTranslatedField(out);
      if (sanitized === null) { missingField = f; break; }
      newSections[f] = sanitized;
    }
  }

  // La guardia dei fatti chiave deve precedere factuality e writeAtomic: il
  // primo puo' vedere zero `critical` anche quando il secondo non deve mai
  // ricevere una sezione fatta solo di placeholder.
  const sourceKeyFacts = stripVacuousFacts(italianSections.body1 || '');
  const sourceHasKeyFacts = parseAiSearchSections(italianSections.body1 || '').length > 0;
  const keyFactsGuard = missingField
    ? { sections: newSections, issue: null }
    : guardTranslatedKeyFacts(newSections, {
      requireRecognizedSection: !pair.structural || sourceHasKeyFacts,
      maxSourceBackedResiduals: pair.structural ? sourceKeyFacts.residual.length : 0,
    });
  const checkedSections = keyFactsGuard.sections;
  const newCodes = missingField
    ? []
    : criticalCodes(runFactualityGates({ sections: checkedSections, locale: pair.locale, italianSections }));

  const sanity = missingField || isSourceLocale
    ? null
    : translationSanityIssue({
      oldSections,
      newSections: checkedSections,
      italianSections,
      locale: pair.locale,
      structuralRepair: Boolean(pair.structural),
    });
  // Calcolato sul testo che verrebbe scritto (`checkedSections`), cioe' dopo
  // sanificazione e guardia dei fatti chiave: se una delle due cambia altro,
  // il diff non e' piu' la sola riga e la pagina resta intatta.
  const titleMarkerPlan = titleMarkerRepair && !missingField
    ? planTitleMarkerRemoval({
      src: trSrc,
      id: pair.id,
      oldCodes,
      oldSections,
      newSections: checkedSections,
      removedByField: titleMarkerRepair.removedByField,
      skipped: titleMarkerRepair.skipped,
    })
    : null;
  const verdict = shouldWrite({
    oldCodes,
    newCodes,
    missingField,
    sanity,
    qualityIssue: titleMarkerPlan?.issue || keyFactsGuard.issue,
    structuralDefect: Boolean(pair.structural),
  });
  const row = { ...base, oldCodes, newCodes, missingField, written: false, reason: verdict.reason };
  if (titleMarkerRepair) {
    row.removedLines = Object.values(titleMarkerRepair.removedByField).flat();
    // Sull'italiano non c'e' cascata: un campo che resta vuoto e' un campo
    // fatto della sola riga del prompt. La pagina resta intatta come prima
    // (fail-closed); cambia solo il motivo, che non deve citare la cascata.
    if (missingField && titleMarkerRepair.removedByField[missingField]?.length) {
      row.reason = `forma-non-riparabile: campo-solo-marcatore (${missingField})`;
    }
  }
  if (!verdict.write || !APPLY) return row;

  if (titleMarkerPlan) {
    writeAtomic(trPath, titleMarkerPlan.src);
    return { ...row, written: true };
  }

  const rewritten = rewriteExistingLocaleBody(trSrc, pair.id, checkedSections, {
    allowMissing: Boolean(pair.structural),
  });
  if (rewritten.missing) return { ...row, reason: `chiave-assente: ${rewritten.missing}` };
  writeAtomic(trPath, rewritten.src);
  return { ...row, written: true };
}

function report(results, { APPLY, AS_JSON, total, OUT }) {
  const payload = () => JSON.stringify({ mode: APPLY ? 'apply' : 'dry-run', total, results }, null, 2);
  if (OUT) {
    // Su file, non su stdout: i tier loggano li' e romperebbero il parse.
    writeAtomic(OUT, payload());
    console.log(`report JSON → ${OUT}`);
  } else if (AS_JSON) {
    console.log(payload());
    return;
  }
  const written = results.filter((r) => r.written).length;
  const clean = results.filter((r) => r.reason === 'pulita').length;
  const refailed = results.filter((r) => r.reason.startsWith('ri-fallita')).length;
  const empty = results.filter((r) => r.reason === 'campo-vuoto-dalla-cascata').length;
  const truncated = results.filter((r) => r.reason.startsWith('troncata')).length;
  const wrongLang = results.filter((r) => r.reason.startsWith('lingua-sbagliata')).length;
  const residue = results.filter((r) => r.oldCodes?.includes('italian-residue')).length;

  console.log(`\nmodalità: ${APPLY ? 'APPLY (scrive)' : 'DRY-RUN (non scrive)'} — coppie trattate: ${results.length}/${total}`);
  console.log(`  ri-traduzione pulita : ${clean}${APPLY ? ` (scritte ${written})` : ''}`);
  console.log(`  ri-fallita           : ${refailed}`);
  console.log(`  campo vuoto (skip)   : ${empty}`);
  console.log(`  troncata (skip)      : ${truncated}`);
  console.log(`  lingua sbagliata     : ${wrongLang}`);
  console.log(`  italian-residue      : ${residue}`);
  console.log(`  altro                : ${results.length - clean - refailed - empty - truncated - wrongLang}`);

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

// `import` dal test non deve far partire una run di rete. Risolviamo entrambi
// i lati per mantenere attiva la guardia anche via symlink.
const invokedDirectly = (() => {
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1] || '');
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
