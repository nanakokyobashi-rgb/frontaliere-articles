/**
 * Run-scoped accounting for free-MT recovery.
 *
 * A malformed free-MT result is deliberately rejected by article-free-mt.mjs.
 * The caller may then use one focused LLM retry, but an endpoint that returns
 * objects instead of translations must not turn one article into an unbounded
 * LLM quota sink.
 */

export const MAX_FREE_MT_LLM_FALLBACKS_PER_RUN = 5;

/**
 * Chiave di un campo rifiutato: `<locale>:<campo>`, dove `<campo>` e' il nome
 * del campo di contenuto (`title`, `excerpt`, `body1`...), NON il `fieldType`
 * passato al motore MT (`title`/`description`) — e' il nome che il loop
 * missing-field di `create-article.mjs` conosce.
 */
export function freeMtFieldKey(targetLang, field) {
  return `${targetLang || '?'}:${field || '?'}`;
}

export function createFreeMtRecoveryReport() {
  return {
    unusableOutputs: 0,
    nonStringOutputs: 0,
    llmFallbacks: 0,
    llmFallbackCapped: false,
    // Mappa serializzabile (il RUN_REPORT finisce in JSON: un Set diventerebbe
    // `{}`) delle coppie (locale, campo) che il free-MT ha davvero rifiutato.
    unusableFields: {},
  };
}

export function recordFreeMtUnusableOutput(report, { reason, targetLang, field } = {}) {
  if (!report || typeof report !== 'object') return;
  report.unusableOutputs = (report.unusableOutputs || 0) + 1;
  if (reason === 'non-string') {
    report.nonStringOutputs = (report.nonStringOutputs || 0) + 1;
  }
  if (targetLang && field) {
    if (!report.unusableFields || typeof report.unusableFields !== 'object') report.unusableFields = {};
    const key = freeMtFieldKey(targetLang, field);
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
 * Reserve one focused LLM retry. Returns false once the run cap is reached.
 * The state is mutated so the same function is the only counter/decision
 * point used by the generator.
 */
export function claimFreeMtLlmFallback(report) {
  if (!report || typeof report !== 'object') return false;
  if ((report.llmFallbacks || 0) >= MAX_FREE_MT_LLM_FALLBACKS_PER_RUN) {
    report.llmFallbackCapped = true;
    return false;
  }
  report.llmFallbacks = (report.llmFallbacks || 0) + 1;
  return true;
}
