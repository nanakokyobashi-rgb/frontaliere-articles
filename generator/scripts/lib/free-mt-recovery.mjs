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
  'semantic-truncation',
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
    // `<locale>:<bodyN>` -> motivo, per i body che nessun tier ha tradotto e
    // che restano quindi NON tradotti (vedi `markBodyTranslationPending`).
    pendingBodyFields: {},
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
 * senza traduzione un title/excerpt/FAQ ricade sull'ITALIANO sotto `/en/`,
 * `/de/`, `/fr/` (#831) e un bodyN resta non tradotto (#1875).
 */
export function wasFreeMtUnusable(report, targetLang, field) {
  if (!report || typeof report !== 'object') return false;
  return Boolean(report.unusableFields?.[freeMtFieldKey(targetLang, field)]);
}

/**
 * Ripartisce il cap globale in modo deterministico, usando solo i locali che
 * hanno davvero campi rifiutati. La capacita' di un locale e' il minimo fra
 * il suo cap dinamico e i campi rifiutati: cosi' un locale con due soli campi
 * non trattiene una quota inutilizzata che il locale successivo non potrebbe
 * piu' recuperare nel loop `en` → `de` → `fr`.
 */
function fairFreeMtFallbackAllocations(report, faqCount, bodyFieldCount) {
  const rejectedFieldKeys = Object.keys(report.unusableFields || {});
  const pendingLocales = FREE_MT_LLM_FALLBACK_LOCALES.filter((candidate) => {
    const rejectedCount = rejectedFieldKeys.filter((fieldKey) => fieldKey.startsWith(`${candidate}:`)).length;
    return rejectedCount > 0;
  });
  if (pendingLocales.length === 0) return null;

  const capacities = Object.fromEntries(pendingLocales.map((locale) => {
    const rejectedCount = rejectedFieldKeys.filter((fieldKey) => fieldKey.startsWith(`${locale}:`)).length;
    return [
      locale,
      Math.min(rejectedCount, maxFreeMtLlmFallbacksPerLocale(faqCount, bodyFieldCount)),
    ];
  }));
  const allocations = Object.fromEntries(pendingLocales.map((locale) => [locale, 0]));
  let remainingBudget = MAX_FREE_MT_LLM_FALLBACKS_PER_RUN;
  while (remainingBudget > 0) {
    let allocatedThisRound = false;
    for (const locale of pendingLocales) {
      if (remainingBudget === 0) break;
      if (allocations[locale] >= capacities[locale]) continue;
      allocations[locale] += 1;
      remainingBudget -= 1;
      allocatedThisRound = true;
    }
    if (!allocatedThisRound) break;
  }
  return allocations;
}

/**
 * Riserva un retry LLM mirato per `locale`. Le assegnazioni vengono calcolate
 * sul set completo dei campi rifiutati a ogni chiamata, quindi restano stabili
 * durante il loop e trasferiscono subito il budget non utilizzabile da un
 * locale ai locali successivi. Lo stato viene mutato in un solo punto.
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
  // Con tre locali e capacita' sufficiente il round-robin produce `3,2,2`.
  // Se `en` ha solo due campi, la sua capacita' e' due e il budget residuo
  // diventa subito disponibile: `2,3,2`, non `2,4,1`. Un report senza campi
  // rifiutati e' usato solo da chiamanti/test legacy e conserva il limite
  // dinamico del singolo locale.
  const fairAllocations = fairFreeMtFallbackAllocations(report, faqCount, bodyFieldCount);
  const fairLocaleLimit = fairAllocations
    ? (Object.prototype.hasOwnProperty.call(fairAllocations, key) ? fairAllocations[key] : 0)
    : localeLimit;
  if (usedHere >= Math.min(localeLimit, fairLocaleLimit)
    || (report.llmFallbacks || 0) >= MAX_FREE_MT_LLM_FALLBACKS_PER_RUN) {
    report.llmFallbackCapped = true;
    return false;
  }
  report.llmFallbacks = (report.llmFallbacks || 0) + 1;
  report.llmFallbacksByLocale[key] = usedHere + 1;
  return true;
}

// ── Esito terminale della recovery su un bodyN: NON tradotto (#1875) ─────────
//
// Quando ne' il free-MT ne' il retry LLM mirato producono un `bodyN` usabile
// (tier a quota esaurita, retry saltato dal cap, traduzione ancora troncata),
// `translateArticle()` pubblicava il valore ITALIANO come body en/de/fr: la
// run 36119335123 ha messo online `fr/ridurre-tempi-ripristino-a2-mezzovico`
// in italiano, e dal 18-09 e' successo al 48% degli articoli nuovi. Nessun
// gate lo vede dopo: una copia italiana ha gli stessi numeri della sorgente.
//
// Ora il campo resta ASSENTE dal contenuto del locale, e l'assenza e' il
// marker di «traduzione in attesa»:
//   - e' deterministica. Su origin/main 85fd0abf nessuna delle 18.558 coppie
//     articolo×locale di `content/blog-body{,-ch}` manca di un `bodyN` che
//     l'italiano ha, quindi chi recupera la trova confrontando le chiavi, senza
//     un rilevatore di lingua;
//   - il sito la gestisce gia'. La SPA risolve una chiave mancante
//     sull'italiano (`t()` in services/i18n.ts), il prerender rende solo le
//     sezioni presenti senza spostare le intestazioni (ogPagesPlugin), i feed
//     concatenano le parti presenti, e `scripts/build-api.mjs` non legge i body.
//
// Il marker vive anche su `data`, come proprieta' NON enumerabile, perche' i
// mutatori a valle (CTA in body3, link interni in body2) non ricreino il campo
// con un moncone di sola CTA: cancellerebbe il marker e, nella SPA, il moncone
// vincerebbe sull'intero body italiano.
const PENDING_BODY_TRANSLATIONS = '_pendingBodyTranslations';

function pendingList(data, { create = false } = {}) {
  if (!data || typeof data !== 'object') return null;
  const existing = data[PENDING_BODY_TRANSLATIONS];
  if (Array.isArray(existing)) return existing;
  if (!create) return null;
  const list = [];
  Object.defineProperty(data, PENDING_BODY_TRANSLATIONS, {
    value: list,
    configurable: true,
    writable: true,
    enumerable: false,
  });
  return list;
}

/** Azzera i marker: `translateArticle()` riparte sempre da una traduzione nuova. */
export function resetBodyTranslationPending(data) {
  if (data && typeof data === 'object' && PENDING_BODY_TRANSLATIONS in data) {
    delete data[PENDING_BODY_TRANSLATIONS];
  }
}

/**
 * Lascia `data.content[locale][field]` NON tradotto: toglie qualunque valore
 * inutilizzabile (vuoto, `null` serializzato, traduzione troncata) e registra
 * `{id, locale, field, reason}` su `data` e, se passato, nel report della run.
 * Non scrive MAI il valore italiano.
 */
export function markBodyTranslationPending(data, { locale, field, reason = 'unknown', report = null } = {}) {
  if (!/^body\d+$/.test(String(field || ''))) {
    throw new Error(`markBodyTranslationPending: "${field}" non e' un campo bodyN`);
  }
  const content = data?.content?.[locale];
  if (content && typeof content === 'object') delete content[field];
  const record = { id: data?.id ?? null, locale, field, reason };
  const list = pendingList(data, { create: true });
  if (list) {
    const at = list.findIndex((r) => r.locale === locale && r.field === field);
    if (at === -1) list.push(record);
    else list[at] = record;
  }
  if (report && typeof report === 'object') {
    if (!report.pendingBodyFields || typeof report.pendingBodyFields !== 'object') report.pendingBodyFields = {};
    report.pendingBodyFields[freeMtFieldKey(locale, field)] = reason;
  }
  return { ...record };
}

/** Il `field` di `locale` e' stato lasciato non tradotto da questa traduzione? */
export function isBodyTranslationPending(data, locale, field) {
  const list = pendingList(data);
  return Boolean(list && list.some((r) => r.locale === locale && r.field === field));
}

/** Copia dei marker, per log e report. */
export function pendingBodyTranslations(data) {
  const list = pendingList(data);
  return list ? list.map((r) => ({ ...r })) : [];
}
