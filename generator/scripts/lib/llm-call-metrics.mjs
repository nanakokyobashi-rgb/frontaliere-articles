import { AsyncLocalStorage } from 'node:async_hooks';

const STAGES = Object.freeze(['selection', 'generation', 'factCheck', 'translation', 'unclassified']);
const stageContext = new AsyncLocalStorage();
const counts = Object.fromEntries(STAGES.map((stage) => [stage, 0]));

/** Count one request actually sent to an LLM provider or model process. */
export function recordLlmProviderRequest() {
  const stage = STAGES.includes(stageContext.getStore()) ? stageContext.getStore() : 'unclassified';
  counts[stage] += 1;
}

/** Run an operation with a stage label inherited by async work it starts. */
export function withLlmCallStage(stage, operation) {
  if (typeof operation !== 'function') throw new TypeError('withLlmCallStage: operation must be a function');
  return stageContext.run(STAGES.includes(stage) && stage !== 'unclassified' ? stage : 'unclassified', operation);
}

/** Return a snapshot so report consumers cannot mutate the process counters. */
export function getLlmProviderRequestsByStage() {
  return { ...counts };
}

/** Reset counters for the one article-generation lifecycle in this process. */
export function resetLlmProviderRequests() {
  for (const stage of STAGES) counts[stage] = 0;
}

export { STAGES as LLM_CALL_STAGES };
