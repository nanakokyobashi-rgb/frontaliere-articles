/**
 * Run-scoped accounting for free-MT recovery.
 *
 * A malformed free-MT result is deliberately rejected by article-free-mt.mjs.
 * The caller may then use one focused LLM retry, but an endpoint that returns
 * objects instead of translations must not turn one article into an unbounded
 * LLM quota sink.
 */

// La superficie del loop missing-field e' composta dai due campi meta, dai
// bodyN realmente presenti e da due chiavi per ogni coppia FAQ indicizzata
// (`faq.q[n]`/`faq.a[n]`). Il cap per locale deve quindi seguire l'articolo,
// non una costante tarata sul caso senza FAQ o sui soli body1..body3.
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
 * 'bodyN','faq.q','faq.a']`: con un solo contatore per run, in una run in cui
 * il free-MT degrada su tutti i campi i 7 claim finiscono TUTTI su `en`, e da
 * `de:title` in poi ogni campo salta il retry mirato e cade sul valore
 * italiano. Risultato: `/en/` recuperato, `/de/` e `/fr/` pubblicati con prosa
 * ITALIANA in `content/`, in `meta-<locale>.json` e nei feed RSS — cioe' il
 * difetto #831 che questa catena esiste per chiudere, live senza rebuild del
 * sito. Nel caso storico (body1..body3 e una coppia FAQ) i candidati sono 7
 * per locale. Il report amplia il conteggio per body4+ e FAQ aggiuntive; il
 * cap globale viene comunque ripartito fra i locali con recovery pendente
 * prima di concedere a uno solo la quota dinamica maggiore.
 *
 * Con tre locali pendenti la ripartizione e' `en:3`, `de:2`, `fr:2`; con due
 * locali e' `4,3`. E' la stessa correzione gia' applicata al budget undated
 * dello scan news (#190 punto 1, `selectUndatedBySourceQuota`), dove un budget
 * globale riempito nell'ordine della lista lasciava a zero ogni fonte dopo la
 * prima.
 */
export const MAX_FREE_MT_LLM_FALLBACKS_PER_LOCALE = Math.ceil(
  MAX_FREE_MT_LLM_FALLBACKS_PER_RUN / FREE_MT_LLM_FALLBACK_LOCALES.length,
);

export const FREE_MT_FIXED_FIELDS_PER_LOCALE = 2;
export const FREE_MT_DEFAULT_BODY_FIELDS = 3;
// Compatibilita' per i consumatori che usavano il totale storico dei campi
// senza FAQ: il calcolo effettivo sotto riceve il numero dei bodyN dal report.
export const FREE_MT_BASE_FIELDS_PER_LOCALE =
  FREE_MT_FIXED_FIELDS_PER_LOCALE + FREE_MT_DEFAULT_BODY_FIELDS;
export const FREE_MT_FIELDS_PER_FAQ_PAIR = 2;
export const FREE_MT_QUOTA_REFERENCE_FIELDS =
  FREE_MT_FIXED_FIELDS_PER_LOCALE
  + FREE_MT_DEFAULT_BODY_FIELDS
  + FREE_MT_FIELDS_PER_FAQ_PAIR;
const FREE_MT_CAP_REASONS = new Set([
  'error',
  'unusable-text',
  'non-string',
  'passthrough',
  'mangled-nav-link',
  'mangled-municipality-name',
  'lone-surrogate',
]);

function normalizeFaqCount(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function normalizeBodyFieldCount(value) {
  return Number.isInteger(value) && value >= 0 ? value : FREE_MT_DEFAULT_BODY_FIELDS;
}

export function freeMtCandidateFieldCount(
  faqCount = 0,
  bodyFieldCount = FREE_MT_DEFAULT_BODY_FIELDS,
) {
  return FREE_MT_FIXED_FIELDS_PER_LOCALE
    + normalizeBodyFieldCount(bodyFieldCount)
    + FREE_MT_FIELDS_PER_FAQ_PAIR * normalizeFaqCount(faqCount);
}

/**
 * Cap proporzionale al numero di campi che il locale deve davvero tradurre.
 * Il caso di riferimento e' un articolo con body1..body3 e una coppia FAQ:
 * sette campi e tre retry, cioe' il cap storico; body4+ e FAQ aggiuntive
 * ampliano la quota locale prima del tetto globale della run.
 */
export function maxFreeMtLlmFallbacksPerLocale(
  faqCount = 1,
  bodyFieldCount = FREE_MT_DEFAULT_BODY_FIELDS,
) {
  return Math.max(1, Math.ceil(
    MAX_FREE_MT_LLM_FALLBACKS_PER_LOCALE
      * freeMtCandidateFieldCount(faqCount, bodyFieldCount)
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

export function createFreeMtRecoveryReport({
  faqCount = 0,
  bodyFieldCount = FREE_MT_DEFAULT_BODY_FIELDS,
} = {}) {
  return {
    faqCount: normalizeFaqCount(faqCount),
    bodyFieldCount: normalizeBodyFieldCount(bodyFieldCount),
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
 * Reserve one focused LLM retry FOR `locale`. Returns false once the effective
 * per-locale allocation or the run cap is reached. The state is mutated so the
 * same function is the only counter/decision point used by the generator.
 *
 * Vedi `MAX_FREE_MT_LLM_FALLBACKS_PER_LOCALE`: il `locale` non e' opzionale
 * nella sostanza — senza, tutti i claim finirebbero nello stesso secchio e la
 * quota tornerebbe un budget globale. Un chiamante che non lo passa ricade su
 * `?`, che ha la sua quota e quindi non puo' comunque svuotare il budget dei
 * locali veri.
 */
export function claimFreeMtLlmFallback(
  report,
  locale,
  faqCount = report?.faqCount ?? 0,
  bodyFieldCount = report?.bodyFieldCount ?? FREE_MT_DEFAULT_BODY_FIELDS,
) {
  if (!report || typeof report !== 'object') return false;
  if (!report.llmFallbacksByLocale || typeof report.llmFallbacksByLocale !== 'object') {
    report.llmFallbacksByLocale = {};
  }
  const key = locale || '?';
  const usedHere = report.llmFallbacksByLocale[key] || 0;
  const localeLimit = maxFreeMtLlmFallbacksPerLocale(faqCount, bodyFieldCount);
  const rejectedFieldKeys = Object.keys(report.unusableFields || {});
  const rejectedFieldsByLocale = Object.fromEntries(
    FREE_MT_LLM_FALLBACK_LOCALES.map((candidate) => [
      candidate,
      rejectedFieldKeys.filter((fieldKey) => fieldKey.startsWith(`${candidate}:`)).length,
    ]),
  );
  // Allocate the global cap before allowing a dynamic locale cap to dominate:
  // with all three locales pending, the seven claims become 3/2/2 instead of
  // 5/1/1 for an article with three body fields and three FAQ pairs. A report
  // without rejected fields is only used by direct callers/tests; keep its
  // historical single-locale behavior, since production calls this function
  // only for a field recorded by free-MT.
  const pendingLocales = rejectedFieldKeys.length > 0
    ? FREE_MT_LLM_FALLBACK_LOCALES.filter((candidate) =>
      rejectedFieldsByLocale[candidate] > (report.llmFallbacksByLocale[candidate] || 0))
    : [key];
  const pendingLocaleIndex = pendingLocales.indexOf(key);
  const fairLocaleLimit = pendingLocaleIndex === -1
    ? localeLimit
    : Math.floor(MAX_FREE_MT_LLM_FALLBACKS_PER_RUN / pendingLocales.length)
      + (pendingLocaleIndex < MAX_FREE_MT_LLM_FALLBACKS_PER_RUN % pendingLocales.length ? 1 : 0);
  if (usedHere >= Math.min(localeLimit, fairLocaleLimit)
    || (report.llmFallbacks || 0) >= MAX_FREE_MT_LLM_FALLBACKS_PER_RUN) {
    report.llmFallbackCapped = true;
    return false;
  }
  report.llmFallbacks = (report.llmFallbacks || 0) + 1;
  report.llmFallbacksByLocale[key] = usedHere + 1;
  return true;
}
