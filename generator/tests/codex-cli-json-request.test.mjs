/**
 * Cosa arriva al broker Codex per una chiamata JSON.
 *
 * Run 36020533094: la selezione headline (jsonMode senza schema) e' arrivata a
 * Codex con `--output-schema {"type":"object"}`, e ogni chiamata e' finita in
 * `invalid_request_error`: gli structured output di OpenAI in modalita' strict
 * vogliono `additionalProperties: false` e ogni proprieta' in `required`. Il
 * corpo articolo passava invece uno schema completo, ed e' per questo che
 * funzionava. Qui un broker finto su socket Unix registra la richiesta vera che
 * `callSingleModel` costruisce, senza avviare nessun processo Codex.
 */
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { AI_MODELS, callSingleModel, resetState } from '../scripts/lib/ai-models.mjs';

const ENV_KEYS = ['CODEX_AUTH_BROKER_SOCKET', 'HAIKU_FALLBACK_GATE', 'ENABLE_CODEX_ARTICLE_FALLBACK', 'AI_MODELS_SCHEMA_MODE'];
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
let server;
let root;
let requests;
let reply;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-json-request-'));
  const socketPath = path.join(root, 'auth.sock');
  requests = [];
  reply = '{"selectedId":"H1","reason":"prova"}';
  server = net.createServer({ allowHalfOpen: true }, (client) => {
    let buffer = '';
    client.setEncoding('utf8');
    client.on('data', (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      requests.push(JSON.parse(buffer.slice(0, newline)));
      client.end(`${JSON.stringify({ ok: true, result: reply })}\n`);
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  process.env.CODEX_AUTH_BROKER_SOCKET = socketPath;
  process.env.HAIKU_FALLBACK_GATE = '1';
  process.env.ENABLE_CODEX_ARTICLE_FALLBACK = '1';
  delete process.env.AI_MODELS_SCHEMA_MODE;
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetState();
});

const messages = [{ role: 'user', content: 'Scegli una headline.' }];

test('una chiamata jsonMode senza schema non manda nessun output schema a Codex', async () => {
  const text = await callSingleModel(messages, {
    model: AI_MODELS.CODEX_CLI_PRIMARY,
    jsonMode: true,
    maxRetriesPerModel: 1,
  });
  assert.equal(text, reply);
  assert.equal(requests.length, 1);
  assert.equal(
    requests[0].schema,
    null,
    `schema inviato: ${JSON.stringify(requests[0].schema)} — un oggetto senza additionalProperties:false viene rifiutato in strict mode`,
  );
  assert.match(requests[0].prompt, /Return exactly one valid JSON object/);
});

test('uno schema esplicito del chiamante arriva a Codex intatto', async () => {
  const schema = {
    type: 'object',
    properties: { selectedId: { type: 'string' }, reason: { type: 'string' } },
    required: ['selectedId', 'reason'],
    additionalProperties: false,
  };
  await callSingleModel(messages, {
    model: AI_MODELS.CODEX_CLI_PRIMARY,
    jsonMode: true,
    jsonSchema: { name: 'selection', schema },
    maxRetriesPerModel: 1,
  });
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].schema, schema);
});

test('senza schema resta il contratto locale: jsonMode rifiuta cio\' che non e\' un oggetto', async () => {
  reply = '["H1"]';
  await assert.rejects(
    () => callSingleModel(messages, {
      model: AI_MODELS.CODEX_CLI_PRIMARY,
      jsonMode: true,
      maxRetriesPerModel: 1,
    }),
    /not an object/,
  );
});
