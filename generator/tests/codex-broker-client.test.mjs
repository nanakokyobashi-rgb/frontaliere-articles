/**
 * Il client della lane Codex (`_requestCodexExecution`) davanti al broker del
 * job. Il broker esegue una richiesta alla volta: il client deve misurare il
 * timeout di esecuzione dal segnale di avvio (\x01), non dalla connect(), e i
 * guasti del canale non devono pesare sullo score del modello (gemello del
 * sito, send-newsletter run 36116142119: coda, TTL e socket sparito avevano
 * portato lo score di codex-cli da 676 a 573 senza una sola risposta del
 * modello). Un broker finto su socket Unix, nessun processo Codex.
 */
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import {
  AI_MODELS,
  DEFAULT_CHAIN,
  __installScoreStoreForTests,
  callLLM,
  callSingleModel,
  classifyExhaustionCause,
  getScoreBoard,
  getPreferredModel,
  isModelAvailable,
  resetState,
} from '../scripts/lib/ai-models.mjs';

const CODEX = AI_MODELS.CODEX_CLI_PRIMARY;
const ENV_KEYS = [
  'CODEX_AUTH_BROKER_SOCKET',
  'ENABLE_CODEX_ARTICLE_FALLBACK',
  'CODEX_CLI_TIMEOUT_MS',
  'CODEX_BROKER_QUEUE_WAIT_MS',
  'AI_MODELS_PREFER',
  'AI_MODELS_FORCE_CHAIN',
  'AI_MODELS_SCHEMA_MODE',
  'GEMINI_API_KEY',
  'CODEX_AUTH_JSON',
];
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
const originalWarn = console.warn;
let server;
let sockets;
let root;
let socketPath;
let requests;
let behavior;
let warnings;

beforeEach(async () => {
  __installScoreStoreForTests(null);
  resetState();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-broker-client-'));
  socketPath = path.join(root, 'auth.sock');
  requests = [];
  sockets = [];
  behavior = () => {};
  warnings = [];
  console.warn = (...args) => { warnings.push(args.map(String).join(' ')); };
  server = net.createServer({ allowHalfOpen: true }, (client) => {
    sockets.push(client);
    let buffer = '';
    client.setEncoding('utf8');
    client.on('error', () => {});
    client.on('data', (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      const parsed = JSON.parse(buffer.slice(0, newline));
      requests.push(parsed);
      behavior(client, parsed);
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  process.env.CODEX_AUTH_BROKER_SOCKET = socketPath;
  process.env.ENABLE_CODEX_ARTICLE_FALLBACK = '1';
  process.env.CODEX_CLI_TIMEOUT_MS = '15000';
  delete process.env.CODEX_BROKER_QUEUE_WAIT_MS;
  delete process.env.AI_MODELS_PREFER;
  delete process.env.AI_MODELS_FORCE_CHAIN;
  delete process.env.AI_MODELS_SCHEMA_MODE;
});

afterEach(async () => {
  console.warn = originalWarn;
  for (const socket of sockets) socket.destroy();
  if (server?.listening) await new Promise((resolve) => server.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetState();
});

const messages = [{ role: 'user', content: 'ping' }];
const callCodex = (opts = {}) => callLLM(messages, {
  model: CODEX,
  chain: [CODEX],
  prefer: [CODEX],
  bypassForceChain: true,
  maxRetriesPerModel: 1,
  ...opts,
});
const codexScore = () => getScoreBoard().find((entry) => entry.model === CODEX)?.score ?? 0;
const logged = () => warnings.join('\n');

test('Codex Luna Max e\' il primo della catena, ma senza broker resta il fallback storico', () => {
  assert.equal(DEFAULT_CHAIN[0], CODEX);
  process.env.GEMINI_API_KEY = 'gemini-test-key';
  assert.equal(getPreferredModel({ chain: [CODEX, AI_MODELS.GEMINI_FLASH] }), CODEX);

  delete process.env.CODEX_AUTH_BROKER_SOCKET;
  assert.equal(getPreferredModel({ chain: [CODEX, AI_MODELS.GEMINI_FLASH] }), AI_MODELS.GEMINI_FLASH);
});

test('la catena default non promuove Codex senza opt-in esplicito', () => {
  process.env.GEMINI_API_KEY = 'gemini-test-key';
  assert.equal(
    getPreferredModel({ model: AI_MODELS.GEMINI_FLASH }),
    AI_MODELS.GEMINI_FLASH,
  );
  assert.equal(
    getPreferredModel({ model: AI_MODELS.GEMINI_FLASH, prefer: [CODEX] }),
    CODEX,
  );
});

test('callLLM non apre il broker per una chiamata default senza opt-in', async () => {
  process.env.GEMINI_API_KEY = 'gemini-test-key';
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    candidates: [{ content: { parts: [{ text: 'DEFAULT FALLBACK' }] } }],
  }), { status: 200 });
  try {
    assert.equal(
      await callLLM(messages, {
        maxRetriesPerModel: 1,
      }),
      'DEFAULT FALLBACK',
    );
    assert.equal(requests.length, 0, 'la chiamata default non deve consumare la socket Codex');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('il kill-switch esistente esclude Codex senza cambiare la catena di ripiego', () => {
  process.env.GEMINI_API_KEY = 'gemini-test-key';
  process.env.ENABLE_CODEX_ARTICLE_FALLBACK = '0';
  assert.equal(getPreferredModel({ chain: [CODEX, AI_MODELS.GEMINI_FLASH] }), AI_MODELS.GEMINI_FLASH);
});

test('un timeout Codex apre il circuito per run e passa subito a Gemini', async () => {
  process.env.GEMINI_API_KEY = 'gemini-test-key';
  behavior = (client) => {
    client.end(`${JSON.stringify({ ok: false, error: 'Codex CLI timed out after 15000ms' })}\n`);
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    candidates: [{ content: { parts: [{ text: 'FALLBACK' }] } }],
  }), { status: 200 });
  try {
    const result = await callLLM(messages, {
      model: CODEX,
      chain: [CODEX, AI_MODELS.GEMINI_FLASH],
      prefer: [CODEX],
      bypassForceChain: true,
      maxRetriesPerModel: 1,
    });
    assert.equal(result, 'FALLBACK');
    assert.equal(isModelAvailable(CODEX), false);
    assert.match(logged(), /primary lane disabled for the rest of this run \(timeout\)/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('una chiamata diretta Codex successiva al circuito non riapre il broker', async () => {
  behavior = (client) => {
    client.end(`${JSON.stringify({ ok: false, error: 'Codex CLI timed out after 15000ms' })}\n`);
  };
  await assert.rejects(() => callSingleModel(messages, {
    model: CODEX,
    maxRetriesPerModel: 1,
  }), /timed out/);
  const requestsAfterFailure = requests.length;

  await assert.rejects(() => callSingleModel(messages, {
    model: CODEX,
    maxRetriesPerModel: 1,
  }), /primary circuit open for this run \(timeout\)/);
  assert.equal(requests.length, requestsAfterFailure, 'il circuito deve saltare _callModel e la socket');
});

test('una quota Codex apre il circuito senza persistere un ban del modello', async () => {
  process.env.CODEX_AUTH_JSON = '{"access_token":"secret-codex-value"}';
  behavior = (client) => {
    client.end(`${JSON.stringify({ ok: false, error: 'request limit exhausted secret-codex-value' })}\n`);
  };
  await assert.rejects(() => callCodex(), /request limit exhausted \[redacted\]/);
  assert.equal(isModelAvailable(CODEX), false);
  assert.equal(codexScore(), 0);
  assert.doesNotMatch(logged(), /secret-codex-value/);
});

test('chiede il segnale di avvio e toglie i byte di controllo prima della risposta', async () => {
  behavior = (client) => {
    client.write('\x01');
    client.write('\0');
    setTimeout(() => client.end(`${JSON.stringify({ ok: true, result: 'PONG' })}\n`), 20);
  };
  assert.equal(await callCodex(), 'PONG');
  assert.equal(requests[0].op, 'exec');
  assert.equal(requests[0].notifyStart, true);
  // callLLM non usa mai i tool dell'agente: il broker risponde col profilo function.
  assert.equal(requests[0].profile, 'function');
});

test('la traduzione batch puo\' riparare JSON fenced senza disattivare la guardia di default', async () => {
  const fenced = '```json\n{"items":[]}\n```';
  behavior = (client) => {
    client.write('\x01');
    client.end(`${JSON.stringify({ ok: true, result: fenced })}\n`);
  };

  await assert.rejects(
    () => callCodex({ jsonMode: true }),
    /invalid JSON for a JSON-mode request/,
  );

  resetState();
  assert.equal(
    await callCodex({ jsonMode: true, deferJsonValidation: true }),
    fenced,
  );
  assert.equal(requests.length, 2);
});

test('solo una chiamata di traduzione con opt-in ritenta una chiusura di trasporto', async () => {
  let attempt = 0;
  behavior = (client) => {
    attempt += 1;
    if (attempt === 1) {
      client.end();
      return;
    }
    client.write('\x01');
    client.end(`${JSON.stringify({ ok: true, result: 'PONG-RETRY' })}\n`);
  };
  assert.equal(await callCodex({
    retryCodexTransport: true,
    codexTransportRetries: 1,
    codexTransportBackoffMs: 1,
  }), 'PONG-RETRY');
  assert.equal(requests.length, 2, 'il retry deve restare confinato all\'opt-in della traduzione');
});

test('una richiesta mai partita scade come attesa in coda, senza toccare lo score', async () => {
  behavior = (client) => { client.write('\0'); };
  await assert.rejects(() => callCodex({ deadlineMs: Date.now() + 1500 }), (error) => {
    assert.match(error.message, /queue wait timed out after \d+s before Codex started/);
    assert.equal(error.transientExhaustion, true);
    return true;
  });
  assert.match(logged(), /guasto di trasporto/);
  assert.equal(codexScore(), 0);
});

test('dopo il segnale di avvio lo scadere del budget e\' un timeout del socket, di trasporto', async () => {
  behavior = (client) => { client.write('\x01'); };
  await assert.rejects(() => callCodex({ deadlineMs: Date.now() + 1500 }), /Codex auth broker socket timed out/);
  assert.match(logged(), /guasto di trasporto/);
  assert.equal(codexScore(), 0);
});

test('un broker sparito spegne la lane per il processo al primo ENOENT', async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(socketPath, { force: true });
  assert.equal(isModelAvailable(CODEX), true);

  await assert.rejects(() => callCodex(), /ENOENT/);
  assert.match(logged(), /broker non raggiungibile \(ENOENT\)/);
  assert.match(logged(), /guasto di trasporto/);
  assert.equal(isModelAvailable(CODEX), false);
  await assert.rejects(() => callCodex(), /skipped — Codex auth broker temporarily unavailable \(socket gone for this job\)/);
  assert.equal(codexScore(), 0);

  process.env.CODEX_AUTH_BROKER_SOCKET = path.join(root, 'other.sock');
  assert.equal(isModelAvailable(CODEX), false, 'il circuito resta aperto fino alla fine del run');
  resetState();
  assert.equal(isModelAvailable(CODEX), true, 'un socket diverso riapre la lane in un run nuovo');
});

// Quando tutta la catena fallisce, il testo degli errori decide fra
// differimento (transitorio) e Workflow Failure (persistente). Una coda o un
// broker sparito si riparano al run successivo: devono votare transitorio, non
// restare ambigui ne' finire nel secchio di «no API key».
test('ogni guasto del canale broker vota transitorio nel tally di esaurimento', async () => {
  const rows = [];
  behavior = (client) => { client.write('\0'); };
  await callCodex({ deadlineMs: Date.now() + 1200 }).catch((error) => rows.push(String(error.message)));
  behavior = (client) => { client.end(); };
  await callCodex().catch((error) => rows.push(String(error.message)));
  for (const socket of sockets) socket.destroy();
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(socketPath, { force: true });
  await callCodex().catch((error) => rows.push(String(error.message)));
  await callCodex().catch((error) => rows.push(String(error.message)));

  const codexRows = rows.map((message) => message.match(/Errors: (.*)$/s)?.[1] ?? message);
  assert.equal(codexRows.length, 4);
  const tally = classifyExhaustionCause(codexRows);
  assert.deepEqual(
    { transient: tally.transient, persistent: tally.persistent },
    { transient: 4, persistent: 0 },
    codexRows.join('\n'),
  );
});

// Un socket che esiste ma non si puo' aprire (permessi) e' un broker
// configurato male: non si ripara al run successivo, quindi vota persistente
// (anche come causa autorevole) e non spegne la lane come un broker sparito.
test('un EACCES sul socket vota persistente, non transitorio', { skip: process.getuid?.() === 0 }, async () => {
  fs.chmodSync(socketPath, 0o000);
  let caught = null;
  await callCodex().catch((error) => { caught = error; });
  assert.ok(caught, 'atteso un errore');
  assert.match(caught.message, /socket unusable \(EACCES\), non-retryable/);
  assert.deepEqual(
    { transient: caught.exhaustionBreakdown.transient, persistent: caught.exhaustionBreakdown.persistent },
    { transient: 0, persistent: 1 },
    caught.message,
  );
  assert.notEqual(caught.transientExhaustion, true);
  assert.equal(isModelAvailable(CODEX), false, 'anche un broker configurato male non va ritentato nel run');
  assert.equal(codexScore(), 0);
});

test('un broker che chiude senza risposta e\' un guasto di trasporto', async () => {
  behavior = (client) => { client.end(); };
  await assert.rejects(() => callCodex(), (error) => {
    assert.match(error.message, /closed without a response/);
    assert.equal(error.transientExhaustion, true);
    return true;
  });
  assert.match(logged(), /guasto di trasporto/);
  assert.equal(codexScore(), 0);
});

test('il SIGKILL a budget del broker non pesa sullo score, un errore di Codex si', async () => {
  behavior = (client) => {
    client.end(`${JSON.stringify({ ok: false, error: 'Codex CLI timed out after 15000ms' })}\n`);
  };
  await assert.rejects(() => callCodex(), /Codex CLI timed out after 15000ms/);
  assert.equal(codexScore(), 0);

  resetState();
  behavior = (client) => {
    client.end(`${JSON.stringify({ ok: false, error: 'Codex CLI exited with code 1: boom' })}\n`);
  };
  await assert.rejects(() => callCodex(), /Codex CLI exited with code 1: boom/);
  assert.ok(codexScore() < 0, `score atteso negativo, trovato ${codexScore()}`);
});
