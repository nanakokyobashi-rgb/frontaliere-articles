/**
 * Minimal server-side client for OpenAI's Decisions API.
 *
 * This module deliberately uses the platform fetch API instead of adding an
 * SDK dependency to the corpus generator. It returns only the normalized
 * choice needed by the pre-spend gate and never includes the request body,
 * response body, or API key in an error.
 */

export const DECISIONS_API_URL = 'https://api.openai.com/v1/decisions';
export const DECISIONS_API_MODEL = 'gpt-6-luna';
export const DEFAULT_DECISIONS_API_TIMEOUT_MS = 30_000;

const RELEVANT_CHOICES = new Set(['relevant', 'yes', 'true', 'si', 'sì']);
const NOT_RELEVANT_CHOICES = new Set([
  'not_relevant',
  'not-relevant',
  'not relevant',
  'irrelevant',
  'no',
  'false',
]);

export class DecisionsApiError extends Error {
  constructor(message, { code = 'DECISIONS_API_ERROR', status = null } = {}) {
    super(message);
    this.name = 'DecisionsApiError';
    this.code = code;
    this.status = status;
  }
}

function asFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeChoice(answer) {
  const raw = answer?.choice ?? answer?.value ?? answer?.answer;
  if (raw && typeof raw === 'object') {
    return String(raw.value ?? raw.choice ?? '').trim().toLowerCase();
  }
  return String(raw ?? '').trim().toLowerCase();
}

function normalizeProbabilities(value) {
  if (!value || typeof value !== 'object') return null;
  const entries = Array.isArray(value)
    ? value.map((entry) => [
      String(entry?.value ?? entry?.choice ?? '').trim(),
      asFiniteNumber(entry?.probability ?? entry?.confidence),
    ])
    : Object.entries(value).map(([key, probability]) => [key, asFiniteNumber(probability)]);
  const usableEntries = entries.filter(([key, probability]) => key && probability !== null);
  return usableEntries.length > 0 ? Object.fromEntries(usableEntries) : null;
}

function safeTimeout(timeoutMs) {
  const value = Number(timeoutMs);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_DECISIONS_API_TIMEOUT_MS;
  return Math.max(1, Math.floor(value));
}

function cancelResponseBody(response) {
  try {
    const cancellation = response?.body?.cancel?.();
    if (cancellation && typeof cancellation.then === 'function') {
      void Promise.resolve(cancellation).catch(() => {});
    }
  } catch {
    // Disposal must not replace the request error that triggers the fallback.
  }
}

/**
 * Classify one editorial input with a Decisions API choice question.
 *
 * @param {object} options
 * @param {string} options.input text to classify
 * @param {string} options.instructions decision criteria for the question
 * @param {string} [options.apiKey] defaults to DECISION_API_KEY
 * @param {number} [options.timeoutMs]
 * @param {typeof fetch} [options.fetchImpl] injectable fetch for tests
 * @returns {Promise<{relevant: boolean, reason: string, parsed: true, provider: string, model: string, confidence: number|null, probabilities: object|null, usage: object|null}>}
 */
export async function classifyWithDecisionsApi({
  input,
  instructions,
  apiKey = process.env.DECISION_API_KEY,
  timeoutMs = DEFAULT_DECISIONS_API_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
} = {}) {
  const key = String(apiKey ?? '').trim();
  if (!key) {
    throw new DecisionsApiError('Decision API key is not configured', {
      code: 'DECISIONS_API_KEY_MISSING',
    });
  }
  if (typeof fetchImpl !== 'function') {
    throw new DecisionsApiError('fetch is not available', {
      code: 'DECISIONS_API_FETCH_UNAVAILABLE',
    });
  }

  const normalizedInput = String(input ?? '').trim();
  const normalizedInstructions = String(instructions ?? '').trim();
  if (!normalizedInput || !normalizedInstructions) {
    throw new DecisionsApiError('Decision API input is incomplete', {
      code: 'DECISIONS_API_INPUT_INVALID',
    });
  }

  const controller = new AbortController();
  const timeout = safeTimeout(timeoutMs);
  let timedOut = false;
  let rejectTimeout;
  const timeoutPromise = new Promise((_, reject) => {
    rejectTimeout = reject;
  });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
    rejectTimeout(new DecisionsApiError('Decision API request timed out', {
      code: 'DECISIONS_API_TIMEOUT',
    }));
  }, timeout);

  try {
    let response;
    try {
      const fetchPromise = fetchImpl(DECISIONS_API_URL, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          model: DECISIONS_API_MODEL,
          input: normalizedInput,
          questions: [{
            type: 'choice',
            name: 'relevance',
            instructions: normalizedInstructions,
            choices: [
              {
                value: 'relevant',
                description: 'The content satisfies the editorial relevance criteria.',
              },
              {
                value: 'not_relevant',
                description: 'The content does not satisfy the editorial relevance criteria.',
              },
            ],
          }],
        }),
        signal: controller.signal,
      });
      const trackedFetchPromise = Promise.resolve(fetchPromise).then((lateResponse) => {
        if (timedOut) void cancelResponseBody(lateResponse);
        return lateResponse;
      });
      response = await Promise.race([
        trackedFetchPromise,
        timeoutPromise,
      ]);
    } catch (error) {
      if (error instanceof DecisionsApiError) throw error;
      throw new DecisionsApiError(
        timedOut ? 'Decision API request timed out' : 'Decision API request failed',
        { code: timedOut ? 'DECISIONS_API_TIMEOUT' : 'DECISIONS_API_TRANSPORT_ERROR' },
      );
    }

    if (!response || !response.ok) {
      cancelResponseBody(response);
      throw new DecisionsApiError('Decision API returned an HTTP error', {
        code: 'DECISIONS_API_HTTP_ERROR',
        status: response?.status ?? null,
      });
    }

    let payload;
    try {
      payload = await Promise.race([response.json(), timeoutPromise]);
    } catch (error) {
      if (error instanceof DecisionsApiError) throw error;
      throw new DecisionsApiError('Decision API returned invalid JSON', {
        code: timedOut ? 'DECISIONS_API_TIMEOUT' : 'DECISIONS_API_INVALID_JSON',
      });
    }

    const answer = Array.isArray(payload?.answers)
      ? payload.answers.find((candidate) => candidate?.name === 'relevance') ?? payload.answers[0]
      : null;
    const choice = normalizeChoice(answer);
    let relevant;
    if (RELEVANT_CHOICES.has(choice)) {
      relevant = true;
    } else if (NOT_RELEVANT_CHOICES.has(choice)) {
      relevant = false;
    } else {
      throw new DecisionsApiError('Decision API returned an unknown choice', {
        code: 'DECISIONS_API_INVALID_CHOICE',
      });
    }

    const confidence = asFiniteNumber(answer?.confidence ?? answer?.probability);
    const probabilities = normalizeProbabilities(answer?.probabilities);
    const confidenceText = confidence === null ? '' : ` confidence=${confidence}`;

    return {
      relevant,
      reason: `decisions-api: ${choice}${confidenceText}`,
      parsed: true,
      provider: 'openai-decisions',
      model: String(payload?.model || DECISIONS_API_MODEL),
      confidence,
      probabilities,
      usage: payload?.usage && typeof payload.usage === 'object' ? payload.usage : null,
    };
  } finally {
    clearTimeout(timer);
  }
}
