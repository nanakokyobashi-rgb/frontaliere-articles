/**
 * codex-bridge-client-pipe.test.mjs — i client del bridge gh/git del lane
 * Codex consegnano a un lettore lento su pipe TUTTO l'output, non i primi
 * 64 KiB.
 *
 * Porta in node:test il caso aggiunto al `tests/codex-file-transport.test.ts`
 * del sito insieme a `writeResultAndExit()` (bridge-transport.mjs, gemello
 * `identical`). `process.exit()` subito dopo `process.stdout.write()` butta
 * cio' che la pipe non ha ancora preso: dentro la sandbox Codex ogni `gh` e
 * `git` passa da questi client, e `gh issue view … --json body | jq` si fermava
 * alla colonna 65536 (run 36782064837). Il 2026-10-01 un agente follow-up ha
 * riscritto i primi 65536 byte del bucket giornaliero #10433 (75 KB) sopra il
 * body intero; quel bucket l'aveva scritto la run corpus di
 * post-merge-followup 36794773927.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../../.github/actions/claude-codex-fallback/bridge-transport.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ACTION_DIR = path.join(ROOT, '.github/actions/claude-codex-fallback');

const roots = [];
const servers = [];
const previousTransport = process.env.CODEX_BRIDGE_TRANSPORT;

function setup(handler) {
  // `createServer()` sceglie il trasporto a file leggendo l'env al momento
  // della chiamata, come fa `vi.stubEnv` nel test del sito.
  process.env.CODEX_BRIDGE_TRANSPORT = 'files';
  const root = mkdtempSync(path.join(tmpdir(), 'codex-ipc-'));
  roots.push(root);
  const endpoint = path.join(root, 'mailbox');
  const server = createServer({}, handler);
  server.listen(endpoint);
  servers.push(server);
  return { endpoint };
}

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (previousTransport === undefined) delete process.env.CODEX_BRIDGE_TRANSPORT;
  else process.env.CODEX_BRIDGE_TRANSPORT = previousTransport;
});

for (const [client, socketVar] of [
  ['gh-bridge-client.mjs', 'CODEX_GH_SOCKET'],
  ['git-bridge-client.mjs', 'CODEX_GIT_SOCKET'],
]) {
  test(`${client} consegna a un lettore lento su pipe l'output intero, non i primi 64 KiB`, async () => {
    const stdout = `${'x'.repeat(199_999)}\n`;
    const { endpoint } = setup((peer) => {
      peer.on('data', () => {});
      peer.on('end', () => peer.end(JSON.stringify({ code: 0, stdout, stderr: '' })));
    });
    const child = spawn(process.execPath, [path.join(ACTION_DIR, client), 'issue', 'view', '1'], {
      env: { CODEX_BRIDGE_TRANSPORT: 'files', [socketVar]: endpoint },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const exited = new Promise((done) => child.once('exit', done));
    let received = '';
    child.stdout.setEncoding('utf8');
    const drained = new Promise((done) => child.stdout.once('end', done));
    // Un consumatore che non sta ancora leggendo (jq che parte, un processo
    // node occupato): la pipe si riempie a 64 KiB e il resto della write resta
    // in coda nel client.
    child.stdout.pause();
    child.stdout.on('data', (chunk) => { received += chunk; });
    await new Promise((done) => setTimeout(done, 400));
    child.stdout.resume();
    const [code] = await Promise.all([exited, drained]);
    assert.equal(code, 0);
    assert.equal(received.length, stdout.length);
  });
}
