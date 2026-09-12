/**
 * Run-scoped accounting for free-MT recovery.
 *
 * A malformed free-MT result is deliberately rejected by article-free-mt.mjs.
 * The caller may then use one focused LLM retry, but an endpoint that returns
 * objects instead of translations must not turn one article into an unbounded
 * LLM quota sink.
 */

// La superficie del loop missing-field e' 5 campi fissi piu' due chiavi per
// ogni coppia FAQ indicizzata (`faq.q[n]`/`faq.a[n]`). Il cap per locale deve
// quindi seguire l'articolo, non una costante tarata sul caso senza FAQ.
export const MAX_FREE_MT_LLM_FALLBACKS_PER_RUN = 7;

/**
 * I locali tradotti che competono per quel budget. La lista vive qui e non nel
 * loop di `create-article.mjs` perche' e' il DENOMINATORE della quota: cambiare
 * i locali senza cambiare la quota rimetterebbe in piedi la fame di locale.
 */
export const FREE_MT_LLM_FALLBACK_LOCALES = ['en', 'de', 'fr'];

/**
 * QUOTA PER LOCALE, non budget globale consumato nell'ordine del loop.
 *
 * Il loop missing-field scorre `['en','de','fr']` × `['title','excerpt',
 * 'body1','body2','body3','faq.q','faq.a']`: con un solo contatore per run, in
 * una run in cui il free-MT degrada su tutti i campi i 7 claim finiscono TUTTI
 * su `en`, e da
 * `de:title` in poi ogni campo salta il retry mirato e cade sul valore
 * italiano. Risultato: `/en/` recuperato, `/de/` e `/fr/` pubblicati con prosa
 * ITALIANA in `content/`, in `meta-<locale>.json` e nei feed RSS — cioe' il
 * difetto #831 che questa catena esiste per chiudere, live senza rebuild del
 * sito. Oggi i candidati sono 7 per locale (21 complessivi), quindi il
 * tetto proporzionale è 7 e la quota per locale è 3: `en` 3, `de` 3, a `fr`
 * resta sempre almeno 1.
 *
 * Con la quota nessun locale puo' affamare gli altri: `en` ne prende al
 * massimo 3, `de` 3, quindi a `fr` ne resta sempre almeno 1 (7 - 3 - 3). E' la
 * stessa correzione gia' applicata al budget undated dello scan news (#190
 * punto 1, `selectUndatedBySourceQuota`), dove un budget globale riempito
 * nell'ordine della lista lasciava a zero ogni fonte dopo la prima.
 */
export const MAX_FREE_MT_LLM_FALLBACKS_PER_LOCALE = Math.ceil(
  MAX_FREE_MT_LLM_FALLBACKS_PER_RUN / FREE_MT_LLM_FALLBACK_LOCALES.length,
);

export const FREE_MT_BASE_FIELDS_PER_LOCALE = 5;
export const FREE_MT_FIELDS_PER_FAQ_PAIR = 2;
export const FREE_MT_QUOTA_REFERENCE_FIELDS = 7;
const FREE_MT_CAP_REASONS = new Set([
  'unusable-text',
  'non-string',
  'passthrough',
  'mangled-nav-link',
]);

function normalizeFaqCount(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

export function freeMtCandidateFieldCount(faqCount = 0) {
  return FREE_MT_BASE_FIELDS_PER_LOCALE
    + FREE_MT_FIELDS_PER_FAQ_PAIR * normalizeFaqCount(faqCount);
}

/**
 * Cap proporzionale al numero di campi che il locale deve davvero tradurre.
 * Il caso di riferimento e' un articolo con una coppia FAQ: sette campi e
 * tre retry, cioe' il cap storico; con sette coppie i 19 campi indicizzati
 * ricevono nove tentativi prima del tetto globale della run.
 */
export function maxFreeMtLlmFallbacksPerLocale(faqCount = 1) {
  return Math.max(1, Math.ceil(
    MAX_FREE_MT_LLM_FALLBACKS_PER_LOCALE
      * freeMtCandidateFieldCount(faqCount)
      / FREE_MT_QUOTA_REFERENCE_FIELDS,
  ));
}

/**
 * Chiave di un campo rifiutato: `<locale>:<campo>`, dove `<campo>` e' il nome
 * del campo di contenuto (`title`, `excerpt`, `body1`...), NON il `fieldType`
 * passato al motore MT (`title`/`description`) — e' il nome che il loop
 * missing-field di `create-article.mjs` conosce.
 */
export function freeMtFieldKey(targetLang, field) {
  return `${targetLang || '?'}:${field || '?'}`;
}

export function createFreeMtRecoveryReport({ faqCount = 0 } = {}) {
  return {
    faqCount: normalizeFaqCount(faqCount),
    unusableOutputs: 0,
    nonStringOutputs: 0,
    unusableByLocale: {},
    llmFallbacks: 0,
    // Mappa serializzabile locale -> claim spesi, il contatore su cui agisce
    // la quota per locale.
    llmFallbacksByLocale: {},
    llmFallbackCapped: false,
    // Mappa serializzabile (il RUN_REPORT finisce in JSON: un Set diventerebbe
    // `{}`) delle coppie (locale, campo) che il free-MT ha davvero rifiutato.
    unusableFields: {},
  };
}

export function recordFreeMtUnusableOutput(report, { reason, targetLang, field, fieldName } = {}) {
  if (!report || typeof report !== 'object') return;
  report.unusableOutputs = (report.unusableOutputs || 0) + 1;
  if (targetLang) {
    const locale = String(targetLang);
    if (!report.unusableByLocale || typeof report.unusableByLocale !== 'object') report.unusableByLocale = {};
    report.unusableByLocale[locale] = (report.unusableByLocale[locale] || 0) + 1;
  }
  if (reason === 'non-string') {
    report.nonStringOutputs = (report.nonStringOutputs || 0) + 1;
  }
  const countsTowardCap = FREE_MT_CAP_REASONS.has(reason);
  const fieldKey = field || fieldName;
  if (countsTowardCap && targetLang && fieldKey) {
    if (!report.unusableFields || typeof report.unusableFields !== 'object') report.unusableFields = {};
    const key = freeMtFieldKey(targetLang, fieldKey);
    report.unusableFields[key] = (report.unusableFields[key] || 0) + 1;
  }
}

/**
 * Il campo (locale, nome) e' fra quelli che il free-MT ha rifiutato in questa
 * run? Solo per questi il cap ha titolo di negare il retry mirato: un campo
 * mancante per cause estranee al free-MT (floor-miss, output vuoto del
 * percorso LLM) non consuma budget e non deve mai saltare il retry, perche'
 * il suo fallback pubblica ITALIANO sotto `/en/`, `/de/`, `/fr/` (#831).
 */
export function wasFreeMtUnusable(report, targetLang, field) {
  if (!report || typeof report !== 'object') return false;
  return Boolean(report.unusableFields?.[freeMtFieldKey(targetLang, field)]);
}

/**
 * Reserve one focused LLM retry FOR `locale`. Returns false once either the
 * per-locale quota or the run cap is reached. The state is mutated so the same
 * function is the only counter/decision point used by the generator.
 *
 * Vedi `MAX_FREE_MT_LLM_FALLBACKS_PER_LOCALE`: il `locale` non e' opzionale
 * nella sostanza — senza, tutti i claim finirebbero nello stesso secchio e la
 * quota tornerebbe un budget globale. Un chiamante che non lo passa ricade su
 * `?`, che ha la sua quota e quindi non puo' comunque svuotare il budget dei
 * locali veri.
 */
export function claimFreeMtLlmFallback(report, locale, faqCount = report?.faqCount ?? 0) {
  if (!report || typeof report !== 'object') return false;
  if (!report.llmFallbacksByLocale || typeof report.llmFallbacksByLocale !== 'object') {
    report.llmFallbacksByLocale = {};
  }
  const key = locale || '?';
  const usedHere = report.llmFallbacksByLocale[key] || 0;
  const localeLimit = maxFreeMtLlmFallbacksPerLocale(faqCount);
  if (usedHere >= localeLimit
    || (report.llmFallbacks || 0) >= MAX_FREE_MT_LLM_FALLBACKS_PER_RUN) {
    report.llmFallbackCapped = true;
    return false;
  }
  report.llmFallbacks = (report.llmFallbacks || 0) + 1;
  report.llmFallbacksByLocale[key] = usedHere + 1;
  return true;
}
