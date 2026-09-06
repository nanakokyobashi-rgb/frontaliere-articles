/**
 * ai-search-template.mjs — Shared helpers for AI Search optimization
 * (Semrush "AI Search optimization" check, issue 223 — A6).
 *
 * Provides:
 * - PROMPT instruction blocks injected into create-article.mjs
 * - Detector predicates used by backfill-ai-search-optimization.mjs
 * - Markdown serializers that embed TL;DR + key-facts at the top of body1
 *   so the existing build pipeline (build-plugins/ogPagesPlugin.ts) emits
 *   them in the static article HTML without any plugin change.
 *
 * Why TL;DR / key-facts live INSIDE body1:
 *   build-plugins/ogPagesPlugin.ts parses only `body\d+` and `faq` keys
 *   (regex `'blog.article.([^']+)\.(body\d+|faq)'`). Adding new top-level
 *   keys would require a plugin change which is out of scope for this
 *   patch. Embedding the content as a clearly-labeled leading section in
 *   body1 (`## In breve\n- ...`, `## Fatti chiave\n- ...`) keeps the
 *   solution surgical and renders correctly in the static HTML and SPA.
 *
 * FAQPage JSON-LD is already emitted by ogPagesPlugin.ts from the `faq`
 * key — no change needed.
 */

import { matchesVacuousValue } from './key-facts-specificity.mjs';

// ── Markdown markers (used to detect existing AI-search optimization) ──
export const TLDR_HEADING_MARKER = '## In breve';
export const KEY_FACTS_HEADING_MARKER = '## Fatti chiave';

const TLDR_MARKERS_BY_LOCALE = {
  it: '## In breve',
  en: '## TL;DR',
  de: '## Auf einen Blick',
  fr: '## En bref',
};

const KEY_FACTS_MARKERS_BY_LOCALE = {
  it: '## Fatti chiave',
  en: '## Key facts',
  de: '## Wichtige Fakten',
  fr: '## Faits clés',
};

/**
 * Tutte le intestazioni di sezione AI-search, nelle quattro locali. UNA sola
 * sorgente: `key-facts-specificity.mjs` deve riconoscere le stesse sezioni che
 * questo modulo emette, e ricopiarle di la' le farebbe divergere al primo
 * locale aggiunto.
 */
export const AI_SEARCH_SECTION_HEADINGS = Object.freeze([
  ...Object.values(TLDR_MARKERS_BY_LOCALE),
  ...Object.values(KEY_FACTS_MARKERS_BY_LOCALE),
]);

/**
 * Returns the localized heading used to mark the TL;DR section.
 * @param {'it'|'en'|'de'|'fr'} locale
 */
export function getTldrHeading(locale) {
  return TLDR_MARKERS_BY_LOCALE[locale] ?? TLDR_MARKERS_BY_LOCALE.it;
}

/**
 * Returns the localized heading used to mark the key-facts section.
 * @param {'it'|'en'|'de'|'fr'} locale
 */
export function getKeyFactsHeading(locale) {
  return KEY_FACTS_MARKERS_BY_LOCALE[locale] ?? KEY_FACTS_MARKERS_BY_LOCALE.it;
}

/**
 * Detects whether a body1 string already contains the AI-search optimization
 * blocks. Used by the backfill script to skip already-processed articles.
 * @param {string} body1
 */
export function hasAiSearchOptimization(body1) {
  if (!body1 || typeof body1 !== 'string') return false;
  // Accept any locale variant of the heading
  const allTldr = Object.values(TLDR_MARKERS_BY_LOCALE);
  const allKeyFacts = Object.values(KEY_FACTS_MARKERS_BY_LOCALE);
  const hasTldr = allTldr.some((m) => body1.includes(m));
  const hasKeyFacts = allKeyFacts.some((m) => body1.includes(m));
  return hasTldr && hasKeyFacts;
}

/**
 * Serializes TL;DR + key-facts as markdown to be prepended to body1.
 *
 * @param {object} params
 * @param {string[]} params.tldr — 3-4 short bullet points (≤80 chars each)
 * @param {Array<{term: string, value: string}>} params.keyFacts — 5-8 facts
 * @param {'it'|'en'|'de'|'fr'} [params.locale='it']
 * @returns {string} markdown block ending with `\n\n`
 */
export function buildAiSearchMarkdown({ tldr, keyFacts, locale = 'it' }) {
  if (!Array.isArray(tldr) || tldr.length < 2) {
    throw new Error('buildAiSearchMarkdown: tldr must be an array of ≥2 bullets');
  }
  if (!Array.isArray(keyFacts) || keyFacts.length < 3) {
    throw new Error('buildAiSearchMarkdown: keyFacts must be an array of ≥3 entries');
  }
  const tldrHeading = getTldrHeading(locale);
  const keyFactsHeading = getKeyFactsHeading(locale);
  const tldrBlock = `${tldrHeading}\n${tldr.map((b) => `- ${String(b).trim()}`).join('\n')}`;
  const keyFactsBlock = `${keyFactsHeading}\n${keyFacts
    .map((kf) => `- **${String(kf.term).trim()}**: ${String(kf.value).trim()}`)
    .join('\n')}`;
  return `${tldrBlock}\n\n${keyFactsBlock}\n\n`;
}

/**
 * Prepends the AI-search markdown block to body1 (skips if already present).
 * @param {string} body1
 * @param {{ tldr: string[], keyFacts: Array<{term:string,value:string}>, locale?: 'it'|'en'|'de'|'fr' }} params
 */
export function prependAiSearchToBody1(body1, params) {
  if (hasAiSearchOptimization(body1)) return body1;
  const block = buildAiSearchMarkdown(params);
  return `${block}${body1}`;
}

// ── Prompt instruction blocks ────────────────────────────────────────────

/**
 * System/user prompt instruction injected into create-article.mjs to
 * make new articles AI-Search-ready out of the box.
 *
 * Italian by default — the article generator writes IT first, then translates.
 */
export const AI_SEARCH_PROMPT_BLOCK_IT = `
═══ AI SEARCH OPTIMIZATION (CRITICO — Semrush check 'AI Search optimization') ═══

OGNI articolo DEVE includere all'inizio di body1, PRIMA del lead giornalistico:

1) TL;DR — sezione "## In breve" con 3-4 bullet brevi (max 80 caratteri ciascuno):
   ## In breve
   - <punto chiave 1: fatto/cifra/data dalla fonte>
   - <punto chiave 2>
   - <punto chiave 3>

2) FATTI CHIAVE — sezione "## Fatti chiave" con 5-8 coppie termine→valore:
   ## Fatti chiave
   - **Cosa**: <descrizione breve>
   - **Quando**: <data o periodo dalla fonte>
   - **Dove**: <luogo specifico>
   - **Chi**: <ente o soggetto>
   - **Importo**: <cifra o percentuale, se presente nella fonte>

   OMETTI la riga se la fonte non porta quel dato. Una coppia il cui valore e'
   "non specificato" / "non disponibile" / "da definire" NON e' un fatto
   chiave: e' la domanda ricopiata al posto della risposta, e viene scartata.
   Meglio 5 righe piene che 8 di cui tre vuote — il minimo e' 3 righe piene.
   Vale identico per i bullet del TL;DR.

DOPO queste due sezioni, prosegui con il lead giornalistico normale di body1.
Le sezioni TL;DR + Fatti chiave NON contano verso il minimo parole di body1.
NON ripetere TL;DR/Fatti chiave in body2 o body3.

Tutti i fatti devono provenire dal SOURCE CONTENT. NON inventare nulla.
`;

/**
 * Backfill prompt — given an existing article body, ask the AI to extract
 * a TL;DR + key-facts list. Used by scripts/backfill-ai-search-optimization.mjs.
 * @param {{ title: string, fullBody: string, locale?: 'it'|'en'|'de'|'fr' }} params
 */
export function buildBackfillPrompt({ title, fullBody, locale = 'it' }) {
  const langInstr = {
    it: 'Rispondi in italiano.',
    en: 'Respond in English.',
    de: 'Antworte auf Deutsch.',
    fr: 'Réponds en français.',
  }[locale];
  return `Sei un editor SEO esperto di ottimizzazione per AI Search (ChatGPT, Perplexity, Google AI Overviews).
${langInstr}

Dato il seguente articolo, estrai:
1) Un TL;DR (3-4 bullet, max 80 caratteri ciascuno) — i punti chiave più importanti.
2) Una lista di "Fatti chiave" (5-8 coppie {term, value}) — dati strutturati: cosa, quando, dove, chi, importo, scadenza, ecc.

REGOLE:
- Ogni fatto DEVE essere presente nel testo dell'articolo. NON inventare nulla.
- OMETTI la coppia se il valore non e' nell'articolo. Mai "non specificato",
  "non disponibile", "da definire" o simili come valore: quelle coppie vengono
  scartate, quindi restituirle equivale a restituirne meno.
- Bullet TL;DR: brevi, autoconclusivi, leggibili da soli.
- "term" max 25 caratteri; "value" max 120 caratteri.
- NON includere markdown nei valori (no **bold**, no link).

ARTICLE TITLE: ${title}

ARTICLE BODY:
${fullBody}

Rispondi SOLO con JSON valido in questo formato (no markdown fences):
{
  "tldr": ["bullet 1", "bullet 2", "bullet 3"],
  "keyFacts": [
    {"term": "Cosa", "value": "..."},
    {"term": "Quando", "value": "..."}
  ]
}`;
}

// ── Validators ───────────────────────────────────────────────────────────

/**
 * Validates the AI response shape for backfill. Throws on invalid input.
 * @param {unknown} payload
 * @returns {{ tldr: string[], keyFacts: Array<{term:string,value:string}> }}
 */
export function validateBackfillPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('validateBackfillPayload: payload is not an object');
  }
  const obj = /** @type {Record<string, unknown>} */ (payload);
  // Truncate runaway AI output rather than fail the whole article. Dense
  // factual pieces routinely generate 13-27 keyFacts and verbose 7-bullet
  // tldrs; capping here recovers ~30 articles per backfill run.
  if (Array.isArray(obj.tldr) && obj.tldr.length > 6) obj.tldr.length = 6;
  if (Array.isArray(obj.keyFacts) && obj.keyFacts.length > 12) obj.keyFacts.length = 12;
  // ── I NON-VALORI si tolgono PRIMA delle soglie, non dopo ─────────────────
  //
  // Il modello che non trova il dato nella fonte non salta la coppia: la
  // riempie con «non specificato» (vedi `key-facts-specificity.mjs`). Filtrare
  // qui, e non a valle, e' cio' che fa cadere sulle soglie sotto un payload
  // fatto di soli non-valori: un backfill che non ha estratto niente deve
  // FALLIRE, non pubblicare una sezione «Fatti chiave» finta. Il conteggio
  // pieno passerebbe la soglia e nasconderebbe il vuoto.
  if (Array.isArray(obj.tldr)) {
    obj.tldr = obj.tldr.filter((b) => typeof b !== 'string' || !matchesVacuousValue(b));
  }
  if (Array.isArray(obj.keyFacts)) {
    obj.keyFacts = obj.keyFacts.filter(
      (kf) => !kf || typeof kf !== 'object' || !matchesVacuousValue(String(/** @type {any} */ (kf).value ?? '')),
    );
  }
  const tldrChecked = obj.tldr;
  const keyFactsChecked = obj.keyFacts;
  if (!Array.isArray(tldrChecked) || tldrChecked.length < 2) {
    throw new Error(`validateBackfillPayload: tldr must be an array of 2-6 strings, got ${Array.isArray(tldrChecked) ? tldrChecked.length : typeof tldrChecked}`);
  }
  if (!tldrChecked.every((b) => typeof b === 'string' && b.length > 0 && b.length <= 200)) {
    throw new Error('validateBackfillPayload: every tldr bullet must be a non-empty string ≤200 chars');
  }
  if (!Array.isArray(keyFactsChecked) || keyFactsChecked.length < 3) {
    throw new Error(`validateBackfillPayload: keyFacts must be an array of 3-12 entries, got ${Array.isArray(keyFactsChecked) ? keyFactsChecked.length : typeof keyFactsChecked}`);
  }
  for (const kf of keyFactsChecked) {
    if (!kf || typeof kf !== 'object') {
      throw new Error('validateBackfillPayload: every keyFacts entry must be an object');
    }
    const k = /** @type {Record<string, unknown>} */ (kf);
    if (typeof k.term !== 'string' || k.term.length === 0 || k.term.length > 50) {
      throw new Error('validateBackfillPayload: keyFacts.term must be a non-empty string ≤50 chars');
    }
    if (typeof k.value !== 'string' || k.value.length === 0 || k.value.length > 240) {
      throw new Error('validateBackfillPayload: keyFacts.value must be a non-empty string ≤240 chars');
    }
  }
  return /** @type {any} */ (payload);
}

export default {
  TLDR_HEADING_MARKER,
  KEY_FACTS_HEADING_MARKER,
  getTldrHeading,
  getKeyFactsHeading,
  hasAiSearchOptimization,
  buildAiSearchMarkdown,
  prependAiSearchToBody1,
  AI_SEARCH_PROMPT_BLOCK_IT,
  buildBackfillPrompt,
  validateBackfillPayload,
};
