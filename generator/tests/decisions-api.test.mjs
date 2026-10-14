import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DECISIONS_API_MODEL,
  DECISIONS_API_URL,
  classifyWithDecisionsApi,
} from '../scripts/lib/decisions-api.mjs';

function fakeResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return payload;
    },
  };
}

test('invia una choice question Decisions API e normalizza una decisione rilevante', async () => {
  let request;
  const result = await classifyWithDecisionsApi({
    apiKey: 'test-decision-key',
    input: 'HEADLINE: Nuove regole fiscali per i frontalieri',
    instructions: 'Valuta la rilevanza per il pubblico editoriale.',
    fetchImpl: async (url, options) => {
      request = { url, options };
      return fakeResponse({
        model: DECISIONS_API_MODEL,
        answers: [{
          type: 'choice',
          name: 'relevance',
          choice: 'relevant',
          confidence: 0.98,
          probabilities: [
            { value: 'relevant', probability: 0.98 },
            { value: 'not_relevant', probability: 0.02 },
          ],
        }],
        usage: { input_tokens: 20, total_tokens: 20 },
      });
    },
  });

  assert.equal(request.url, DECISIONS_API_URL);
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.headers.Authorization, 'Bearer test-decision-key');
  const body = JSON.parse(request.options.body);
  assert.equal(body.model, DECISIONS_API_MODEL);
  assert.equal(body.input, 'HEADLINE: Nuove regole fiscali per i frontalieri');
  assert.equal(body.questions[0].type, 'choice');
  assert.equal(body.questions[0].name, 'relevance');
  assert.deepEqual(body.questions[0].choices.map(({ value }) => value), ['relevant', 'not_relevant']);
  assert.equal(result.relevant, true);
  assert.equal(result.provider, 'openai-decisions');
  assert.equal(result.confidence, 0.98);
  assert.deepEqual(result.probabilities, { relevant: 0.98, not_relevant: 0.02 });
  assert.deepEqual(result.usage, { input_tokens: 20, total_tokens: 20 });
});

test('normalizza la scelta not_relevant come decisione negativa', async () => {
  const result = await classifyWithDecisionsApi({
    apiKey: 'test-decision-key',
    input: 'HEADLINE: Evento senza impatto sul pubblico',
    instructions: 'Valuta la rilevanza per il pubblico editoriale.',
    fetchImpl: async () => fakeResponse({
      answers: [{ name: 'relevance', choice: 'not_relevant' }],
    }),
  });

  assert.equal(result.relevant, false);
  assert.match(result.reason, /not_relevant/);
});

test('rifiuta una richiesta senza chiave senza chiamare la rete', async () => {
  let called = false;
  await assert.rejects(
    classifyWithDecisionsApi({
      apiKey: '',
      input: 'contenuto',
      instructions: 'criteri',
      fetchImpl: async () => {
        called = true;
        return fakeResponse({});
      },
    }),
    (error) => error.code === 'DECISIONS_API_KEY_MISSING',
  );
  assert.equal(called, false);
});

test('mantiene gli errori HTTP sicuri e non propaga chiave o body', async () => {
  const secret = 'test-secret-that-must-not-leak';
  await assert.rejects(
    classifyWithDecisionsApi({
      apiKey: secret,
      input: 'contenuto',
      instructions: 'criteri',
      fetchImpl: async () => fakeResponse({ error: secret, message: 'upstream body' }, 401),
    }),
    (error) => {
      assert.equal(error.code, 'DECISIONS_API_HTTP_ERROR');
      assert.equal(error.status, 401);
      assert.doesNotMatch(error.message, /test-secret/);
      assert.doesNotMatch(error.message, /upstream body/);
      return true;
    },
  );
});
test('trasforma il timeout AbortController in un errore classificabile', async () => {
  await assert.rejects(
    classifyWithDecisionsApi({
      apiKey: 'test-decision-key',
      input: 'contenuto',
      instructions: 'criteri',
      timeoutMs: 5,
      fetchImpl: async (_url, { signal }) => new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      }),
    }),
    (error) => error.code === 'DECISIONS_API_TIMEOUT',
  );
});

test('mantiene la deadline anche se il body HTTP non termina', async () => {
  await assert.rejects(
    classifyWithDecisionsApi({
      apiKey: 'test-decision-key',
      input: 'contenuto',
      instructions: 'criteri',
      timeoutMs: 5,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => new Promise(() => {}),
      }),
    }),
    (error) => error.code === 'DECISIONS_API_TIMEOUT',
  );
});
