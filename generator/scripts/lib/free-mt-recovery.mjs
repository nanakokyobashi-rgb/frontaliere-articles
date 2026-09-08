/**
 * Run-scoped accounting for free-MT recovery.
 *
 * A malformed free-MT result is deliberately rejected by article-free-mt.mjs.
 * The caller may then use one focused LLM retry, but an endpoint that returns
 * objects instead of translations must not turn one article into an unbounded
 * LLM quota sink.
 */

export const MAX_FREE_MT_LLM_FALLBACKS_PER_RUN = 5;

export function createFreeMtRecoveryReport() {
  return {
    unusableOutputs: 0,
    nonStringOutputs: 0,
    unusableByLocale: {},
    unusableFields: {},
    llmFallbacks: 0,
    llmFallbackCapped: false,
  };
}

export function recordFreeMtUnusableOutput(report, { targetLang, fieldName, reason } = {}) {
  if (!report || typeof report !== 'object') return;
  report.unusableOutputs = (report.unusableOutputs || 0) + 1;
  const locale = String(targetLang || 'unknown');
  report.unusableByLocale = report.unusableByLocale || {};
  report.unusableByLocale[locale] = (report.unusableByLocale[locale] || 0) + 1;
  if (fieldName) {
    report.unusableFields = report.unusableFields || {};
    const key = `${locale}:${fieldName}`;
    report.unusableFields[key] = (report.unusableFields[key] || 0) + 1;
  }
  if (reason === 'non-string') {
    report.nonStringOutputs = (report.nonStringOutputs || 0) + 1;
  }
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
