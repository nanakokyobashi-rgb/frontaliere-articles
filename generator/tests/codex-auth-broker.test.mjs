import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BROKER = path.join(ROOT, '.github/actions/setup-claude-haiku-fallback/codex-auth-broker.mjs');

// macOS limits Unix-socket paths to a little over 100 bytes. Keep the broker
// directory prefix short because the broker briefly appends `.listening` while
// it binds the socket.
const tempBrokerDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cb.'));
const normalizeTempPath = (value) => path.normalize(value).replace(/^\/private\/tmp(?=\/|$)/, '/tmp');

function waitForSocket(socketPath, child, timeoutMs = 5000, getStderr = () => '') {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (fs.existsSync(socketPath)) {
        resolve();
        return;
      }
      if (child.exitCode !== null) {
        setImmediate(() => {
          const stderr = getStderr().trim();
          reject(new Error(`broker exited before becoming ready (${child.exitCode})${stderr ? `: ${stderr}` : ''}`));
        });
        return;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        reject(new Error('broker did not become ready'));
        return;
      }
      setTimeout(poll, 20).unref?.();
    };
    poll();
  });
}

function openRequest(socketPath, payload) {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(socketPath);
    client.once('error', reject);
    client.once('connect', () => {
      client.write(`${JSON.stringify(payload)}\n`);
      resolve(client);
    });
  });
}

function request(socketPath, payload) {
  return new Promise((resolve, reject) => {
    let response = '';
    let settled = false;
    const client = net.createConnection(socketPath);
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      client.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    client.setEncoding('utf8');
    client.setTimeout(5000, () => finish(new Error('broker request timed out')));
    client.on('error', (error) => finish(error));
    client.on('data', (chunk) => {
      response += chunk;
      if (response.startsWith('\0')) response = response.slice(1);
      const newline = response.indexOf('\n');
      if (newline < 0) return;
      try {
        finish(null, JSON.parse(response.slice(0, newline)));
      } catch (error) {
        finish(error);
      }
    });
    client.on('end', () => {
      if (!settled) finish(new Error('broker closed without a response'));
    });
    client.on('connect', () => client.end(`${JSON.stringify(payload)}\n`));
  });
}

function waitForExit(child, timeoutMs = 5000) {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('broker did not exit')), timeoutMs);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('il broker Codex serializza più richieste senza consumare una slot globale', async () => {
  const brokerDir = tempBrokerDir();
  const cliPrefix = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-haiku-codex-cli.'));
  const socketPath = path.join(brokerDir, 'auth.sock');
  const cliPath = path.join(cliPrefix, 'codex');
  const fakeCli = `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('codex 0.153.4'); process.exit(0); }
const output = args[args.indexOf('--output-last-message') + 1];
if (!output) process.exit(2);
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { prompt += chunk; });
process.stdin.on('end', () => fs.writeFileSync(output, JSON.stringify({ prompt }), 'utf8'));
`;
  fs.writeFileSync(cliPath, fakeCli, { mode: 0o700 });
  fs.chmodSync(cliPath, 0o700);
  const cliSha256 = crypto.createHash('sha256').update(fs.readFileSync(cliPath)).digest('hex');
  const broker = spawn(process.execPath, [
    BROKER,
    '--socket', socketPath,
    '--ttl-ms', '60000',
    '--max-requests', '2',
    '--codex-bin', cliPath,
    '--codex-realpath', cliPath,
    '--codex-sha256', cliSha256,
    '--codex-prefix', cliPrefix,
  ], {
    cwd: ROOT,
    stdio: ['pipe', 'ignore', 'pipe'],
  });
  let stderr = '';
  broker.stderr.setEncoding('utf8');
  broker.stderr.on('data', (chunk) => { stderr += chunk; });
  broker.stdin.end('{"access_token":"test"}');

  try {
    await waitForSocket(socketPath, broker, 5000, () => stderr);
    const [first, second] = await Promise.all([
      request(socketPath, { op: 'exec', prompt: 'first', timeoutMs: 5000 }),
      request(socketPath, { op: 'exec', prompt: 'second', timeoutMs: 5000 }),
    ]);
    assert.equal(first.ok, true, stderr);
    assert.equal(second.ok, true, stderr);
    assert.deepEqual(
      [JSON.parse(first.result).prompt, JSON.parse(second.result).prompt].sort(),
      ['first', 'second'],
    );

    const exhausted = await request(socketPath, { op: 'exec', prompt: 'third', timeoutMs: 5000 });
    assert.deepEqual(exhausted, { ok: false, error: 'request limit exhausted' });

    const cleaned = await request(socketPath, { op: 'cleanup' });
    assert.deepEqual(cleaned, { ok: true, cleaned: true });
    assert.equal(await waitForExit(broker), 0, stderr);
    assert.equal(fs.existsSync(socketPath), false);
    assert.equal(fs.existsSync(cliPrefix), false);
  } finally {
    if (broker.exitCode === null) broker.kill('SIGTERM');
    await waitForExit(broker).catch(() => {});
    fs.rmSync(brokerDir, { recursive: true, force: true });
    fs.rmSync(cliPrefix, { recursive: true, force: true });
  }
});

test('il TTL del broker è idle e non scade mentre la coda riceve richieste', async () => {
  const brokerDir = tempBrokerDir();
  const cliPrefix = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-haiku-codex-cli.'));
  const socketPath = path.join(brokerDir, 'auth.sock');
  const cliPath = path.join(cliPrefix, 'codex');
  const fakeCli = `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('codex 0.153.4'); process.exit(0); }
const output = args[args.indexOf('--output-last-message') + 1];
if (!output) process.exit(2);
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { prompt += chunk; });
process.stdin.on('end', () => fs.writeFileSync(output, JSON.stringify({ prompt }), 'utf8'));
`;
  fs.writeFileSync(cliPath, fakeCli, { mode: 0o700 });
  fs.chmodSync(cliPath, 0o700);
  const cliSha256 = crypto.createHash('sha256').update(fs.readFileSync(cliPath)).digest('hex');
  const broker = spawn(process.execPath, [
    BROKER,
    '--socket', socketPath,
    '--ttl-ms', '300',
    '--max-requests', '3',
    '--codex-bin', cliPath,
    '--codex-realpath', cliPath,
    '--codex-sha256', cliSha256,
    '--codex-prefix', cliPrefix,
  ], {
    cwd: ROOT,
    stdio: ['pipe', 'ignore', 'pipe'],
  });
  let stderr = '';
  broker.stderr.setEncoding('utf8');
  broker.stderr.on('data', (chunk) => { stderr += chunk; });
  broker.stdin.end('{"access_token":"test"}');

  try {
    await waitForSocket(socketPath, broker, 5000, () => stderr).catch((error) => {
      throw new Error(`${error.message}: ${stderr}`);
    });
    const first = await request(socketPath, { op: 'exec', prompt: 'first', timeoutMs: 5000 });
    assert.equal(first.ok, true);
    await delay(180);
    const second = await request(socketPath, { op: 'exec', prompt: 'second', timeoutMs: 5000 });
    assert.equal(second.ok, true);
    await delay(180);
    const third = await request(socketPath, { op: 'exec', prompt: 'third', timeoutMs: 5000 });
    assert.equal(third.ok, true);
    const cleaned = await request(socketPath, { op: 'cleanup' });
    assert.deepEqual(cleaned, { ok: true, cleaned: true });
    assert.equal(await waitForExit(broker), 0);
  } finally {
    if (broker.exitCode === null) broker.kill('SIGTERM');
    await waitForExit(broker).catch(() => {});
    fs.rmSync(brokerDir, { recursive: true, force: true });
    fs.rmSync(cliPrefix, { recursive: true, force: true });
  }
});

test('una richiesta cancellata prima dell esecuzione non consuma la quota', async () => {
  const brokerDir = tempBrokerDir();
  const cliPrefix = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-haiku-codex-cli.'));
  const socketPath = path.join(brokerDir, 'auth.sock');
  const cliPath = path.join(cliPrefix, 'codex');
  const fakeCli = `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('codex 0.153.4'); process.exit(0); }
const output = args[args.indexOf('--output-last-message') + 1];
if (!output) process.exit(2);
await new Promise((resolve) => setTimeout(resolve, 400));
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { prompt += chunk; });
process.stdin.on('end', () => fs.writeFileSync(output, JSON.stringify({ prompt }), 'utf8'));
`;
  fs.writeFileSync(cliPath, fakeCli, { mode: 0o700 });
  fs.chmodSync(cliPath, 0o700);
  const cliSha256 = crypto.createHash('sha256').update(fs.readFileSync(cliPath)).digest('hex');
  const broker = spawn(process.execPath, [
    BROKER,
    '--socket', socketPath,
    '--ttl-ms', '60000',
    '--max-requests', '2',
    '--codex-bin', cliPath,
    '--codex-realpath', cliPath,
    '--codex-sha256', cliSha256,
    '--codex-prefix', cliPrefix,
  ], {
    cwd: ROOT,
    stdio: ['pipe', 'ignore', 'pipe'],
  });
  let stderr = '';
  broker.stderr.setEncoding('utf8');
  broker.stderr.on('data', (chunk) => { stderr += chunk; });
  broker.stdin.end('{"access_token":"test"}');

  try {
    await waitForSocket(socketPath, broker, 5000, () => stderr);
    const firstHold = openRequest(socketPath, { op: 'exec', prompt: 'first', timeoutMs: 5000 });
    await delay(40);
    const cancelled = await openRequest(socketPath, { op: 'exec', prompt: 'cancelled', timeoutMs: 5000 });
    await delay(40);
    cancelled.destroy();
    await delay(40);
    const [first, replacement] = await Promise.all([
      firstHold.then((client) => new Promise((resolve, reject) => {
        let response = '';
        client.setEncoding('utf8');
        client.on('data', (chunk) => {
          response += chunk;
          if (response.startsWith('\0')) response = response.slice(1);
          const newline = response.indexOf('\n');
          if (newline < 0) return;
          try {
            resolve(JSON.parse(response.slice(0, newline)));
          } catch (error) {
            reject(error);
          }
        });
        client.on('error', reject);
      })),
      request(socketPath, { op: 'exec', prompt: 'replacement', timeoutMs: 5000 }),
    ]);
    assert.equal(first.ok, true, stderr);
    assert.equal(replacement.ok, true, stderr);
    const exhausted = await request(socketPath, { op: 'exec', prompt: 'fourth', timeoutMs: 5000 });
    assert.deepEqual(exhausted, { ok: false, error: 'request limit exhausted' });
    const cleaned = await request(socketPath, { op: 'cleanup' });
    assert.deepEqual(cleaned, { ok: true, cleaned: true });
    assert.equal(await waitForExit(broker), 0, stderr);
  } finally {
    if (broker.exitCode === null) broker.kill('SIGTERM');
    await waitForExit(broker).catch(() => {});
    fs.rmSync(brokerDir, { recursive: true, force: true });
    fs.rmSync(cliPrefix, { recursive: true, force: true });
  }
});

// Run 36001495484: ogni chiamata Codex usciva con code 1 prima del modello.
// Il profilo negava ":slash_tmp", ma il broker costruisce workspace, CODEX_HOME
// e TMPDIR sotto os.tmpdir(), cioè /tmp: il deny copriva il workspace stesso.
// Il codex finto qui registra dove il broker lo lancia e quale profilo gli
// scrive, così il contratto si verifica sui percorsi reali e non sul testo.
test('il profilo sandbox del broker non nega il workspace in cui lancia Codex', async () => {
  const brokerDir = tempBrokerDir();
  const cliPrefix = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-haiku-codex-cli.'));
  const socketPath = path.join(brokerDir, 'auth.sock');
  const cliPath = path.join(cliPrefix, 'codex');
  const fakeCli = `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('codex 0.153.4'); process.exit(0); }
const output = args[args.indexOf('--output-last-message') + 1];
if (!output) process.exit(2);
process.stdin.resume();
process.stdin.on('end', () => fs.writeFileSync(output, JSON.stringify({
  cwd: process.cwd(),
  cd: args[args.indexOf('--cd') + 1],
  tmpdir: process.env.TMPDIR,
  codexHome: process.env.CODEX_HOME,
  config: fs.readFileSync(path.join(process.env.CODEX_HOME, 'config.toml'), 'utf8'),
}), 'utf8'));
`;
  fs.writeFileSync(cliPath, fakeCli, { mode: 0o700 });
  fs.chmodSync(cliPath, 0o700);
  const cliSha256 = crypto.createHash('sha256').update(fs.readFileSync(cliPath)).digest('hex');
  // Come la setup action: `env -i PATH=...`, quindi nessun TMPDIR ereditato.
  const broker = spawn(process.execPath, [
    BROKER,
    '--socket', socketPath,
    '--ttl-ms', '60000',
    '--max-requests', '1',
    '--codex-bin', cliPath,
    '--codex-realpath', cliPath,
    '--codex-sha256', cliSha256,
    '--codex-prefix', cliPrefix,
  ], {
    cwd: ROOT,
    env: { PATH: process.env.PATH },
    stdio: ['pipe', 'ignore', 'pipe'],
  });
  let stderr = '';
  broker.stderr.setEncoding('utf8');
  broker.stderr.on('data', (chunk) => { stderr += chunk; });
  broker.stdin.end('{"access_token":"test"}');

  try {
    await waitForSocket(socketPath, broker, 5000, () => stderr);
    const response = await request(socketPath, { op: 'exec', prompt: 'profile', timeoutMs: 5000 });
    assert.equal(response.ok, true, stderr);
    const seen = JSON.parse(response.result);
    assert.equal(
      normalizeTempPath(seen.cd),
      normalizeTempPath(seen.cwd),
      'Codex deve girare nel workspace che riceve con --cd',
    );

    const filesystem = {};
    let inFilesystem = false;
    for (const line of seen.config.split('\n')) {
      const header = line.match(/^\[(.+)\]\s*$/);
      if (header) {
        inFilesystem = /^permissions\.[^.]+\.filesystem$/.test(header[1]);
        continue;
      }
      const entry = inFilesystem && line.match(/^"([^"]+)"\s*=\s*"([^"]+)"\s*$/);
      if (entry) filesystem[entry[1]] = entry[2];
    }
    // ":root" resta il muro che nasconde auth.json: il workspace lo scavalca
    // per costruzione, ogni altro deny no.
    assert.equal(filesystem[':root'], 'deny', 'senza ":root" deny auth.json diventerebbe leggibile');
    const special = { ':slash_tmp': '/tmp', ':tmpdir': seen.tmpdir };
    const real = (target) => {
      try { return fs.realpathSync(target); } catch { return path.resolve(target); }
    };
    const workspace = real(seen.cwd);
    for (const [rule, access] of Object.entries(filesystem)) {
      if (access !== 'deny' || rule === ':root') continue;
      const target = special[rule] ?? (path.isAbsolute(rule) ? rule : null);
      assert.ok(target, `regola deny non risolvibile dal test: ${rule}`);
      const relative = path.relative(real(target), workspace);
      const coversWorkspace = relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
      assert.equal(coversWorkspace, false, `${rule} = "deny" copre il workspace ${workspace}`);
    }
    const homeInWorkspace = path.relative(workspace, real(seen.codexHome));
    assert.ok(
      homeInWorkspace.startsWith('..') || path.isAbsolute(homeInWorkspace),
      'CODEX_HOME (auth.json) non deve stare dentro il workspace leggibile',
    );

    const cleaned = await request(socketPath, { op: 'cleanup' });
    assert.deepEqual(cleaned, { ok: true, cleaned: true });
    assert.equal(await waitForExit(broker), 0, stderr);
  } finally {
    if (broker.exitCode === null) broker.kill('SIGTERM');
    await waitForExit(broker).catch(() => {});
    fs.rmSync(brokerDir, { recursive: true, force: true });
    fs.rmSync(cliPrefix, { recursive: true, force: true });
  }
});

test('un Codex che esce con errore restituisce la causa, senza token', async () => {
  const brokerDir = tempBrokerDir();
  const cliPrefix = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-haiku-codex-cli.'));
  const socketPath = path.join(brokerDir, 'auth.sock');
  const cliPath = path.join(cliPrefix, 'codex');
  const token = `eyJ${'a'.repeat(40)}.${'b'.repeat(40)}.${'c'.repeat(40)}`;
  const fakeCli = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('codex 0.153.4'); process.exit(0); }
process.stdin.resume();
process.stdin.on('end', () => {
  process.stderr.write('\\x1b[31m2026-09-24T13:59:26Z ERROR codex_models_manager: 401 with ${token}\\x1b[0m\\n');
  process.stderr.write('Error: thread/start failed: ' + 'error creating thread: '.repeat(15) + 'session ${token}: bwrap: Can\\'t mkdir parents for /tmp/w/tmp: Read-only file system (code -32603)\\n');
  process.exit(1);
});
`;
  fs.writeFileSync(cliPath, fakeCli, { mode: 0o700 });
  fs.chmodSync(cliPath, 0o700);
  const cliSha256 = crypto.createHash('sha256').update(fs.readFileSync(cliPath)).digest('hex');
  const broker = spawn(process.execPath, [
    BROKER,
    '--socket', socketPath,
    '--ttl-ms', '60000',
    '--max-requests', '1',
    '--codex-bin', cliPath,
    '--codex-realpath', cliPath,
    '--codex-sha256', cliSha256,
    '--codex-prefix', cliPrefix,
  ], {
    cwd: ROOT,
    stdio: ['pipe', 'ignore', 'pipe'],
  });
  let stderr = '';
  broker.stderr.setEncoding('utf8');
  broker.stderr.on('data', (chunk) => { stderr += chunk; });
  broker.stdin.end('{"access_token":"test"}');

  try {
    await waitForSocket(socketPath, broker, 5000, () => stderr);
    const response = await request(socketPath, { op: 'exec', prompt: 'fail', timeoutMs: 5000 });
    assert.equal(response.ok, false, stderr);
    assert.match(response.error, /^Codex CLI exited with code 1: …/);
    assert.match(response.error, /bwrap: Can't mkdir parents for \/tmp\/w\/tmp: Read-only file system \(code -32603\)$/);
    assert.ok(response.error.length <= 300, response.error);
    assert.match(response.error, /\[redacted\]/, 'il token nella riga scelta va oscurato');
    assert.doesNotMatch(response.error, /eyJ|[abc]{32,}|\x1b/);

    const cleaned = await request(socketPath, { op: 'cleanup' });
    assert.deepEqual(cleaned, { ok: true, cleaned: true });
    assert.equal(await waitForExit(broker), 0, stderr);
  } finally {
    if (broker.exitCode === null) broker.kill('SIGTERM');
    await waitForExit(broker).catch(() => {});
    fs.rmSync(brokerDir, { recursive: true, force: true });
    fs.rmSync(cliPrefix, { recursive: true, force: true });
  }
});

// Il refresh token del login ChatGPT e' monouso e Codex riscrive il login
// rinnovato in CODEX_HOME/auth.json. Con una home nuova per richiesta quella
// scrittura si perdeva, e ogni chiamata successiva dello stesso job rigiocava
// il token speso («refresh token already used»). Il Codex finto fa il refresh
// a ogni chiamata: la successiva deve partire dal login rinnovato.
test('una sola CODEX_HOME per job: il login rinnovato dalla chiamata N serve la N+1', async () => {
  const brokerDir = tempBrokerDir();
  const cliPrefix = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-haiku-codex-cli.'));
  const socketPath = path.join(brokerDir, 'auth.sock');
  const cliPath = path.join(cliPrefix, 'codex');
  const fakeCli = `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('codex 0.153.4'); process.exit(0); }
const output = args[args.indexOf('--output-last-message') + 1];
const workspace = args[args.indexOf('--cd') + 1];
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { prompt += chunk; });
process.stdin.on('end', () => {
  const authPath = path.join(process.env.CODEX_HOME, 'auth.json');
  const seen = fs.readFileSync(authPath, 'utf8');
  const login = JSON.parse(seen);
  if (prompt.includes('corrupt')) fs.writeFileSync(authPath, '{"refresh_token":');
  else fs.writeFileSync(authPath, JSON.stringify({ ...login, refresh_token: 'rt-' + (login.generation + 1), generation: login.generation + 1 }));
  fs.writeFileSync(output, JSON.stringify({
    seen: JSON.parse(seen),
    home: process.env.CODEX_HOME,
    homeMode: fs.statSync(process.env.CODEX_HOME).mode & 0o777,
    authMode: fs.statSync(authPath).mode & 0o777,
    workspace,
  }));
});
`;
  fs.writeFileSync(cliPath, fakeCli, { mode: 0o700 });
  fs.chmodSync(cliPath, 0o700);
  const cliSha256 = crypto.createHash('sha256').update(fs.readFileSync(cliPath)).digest('hex');
  const broker = spawn(process.execPath, [
    BROKER,
    '--socket', socketPath,
    '--ttl-ms', '60000',
    '--max-requests', '4',
    '--codex-bin', cliPath,
    '--codex-realpath', cliPath,
    '--codex-sha256', cliSha256,
    '--codex-prefix', cliPrefix,
  ], {
    cwd: ROOT,
    env: { PATH: process.env.PATH },
    stdio: ['pipe', 'ignore', 'pipe'],
  });
  let stderr = '';
  broker.stderr.setEncoding('utf8');
  broker.stderr.on('data', (chunk) => { stderr += chunk; });
  broker.stdin.end('{"refresh_token":"rt-0","generation":0}');

  const exec = async (prompt) => {
    const response = await request(socketPath, { op: 'exec', prompt, timeoutMs: 5000 });
    assert.equal(response.ok, true, `${JSON.stringify(response)} ${stderr}`);
    return JSON.parse(response.result);
  };
  try {
    await waitForSocket(socketPath, broker, 5000, () => stderr);
    const first = await exec('first');
    const second = await exec('second');
    assert.deepEqual(first.seen, { refresh_token: 'rt-0', generation: 0 });
    assert.deepEqual(second.seen, { refresh_token: 'rt-1', generation: 1 }, 'la seconda chiamata ha rigiocato il login iniziale');
    assert.equal(second.home, first.home, 'CODEX_HOME deve essere una sola per job');
    assert.equal(first.homeMode, 0o700);
    assert.equal(first.authMode, 0o600);
    const relative = path.relative(path.resolve(first.workspace), path.resolve(first.home));
    assert.ok(relative.startsWith('..') || path.isAbsolute(relative), 'la home del login non deve stare nel workspace');
    assert.equal(fs.existsSync(first.workspace), false, 'il workspace resta per-richiesta');

    // Codex ucciso a meta' riscrittura: la richiesta dopo riparte dall'ultimo
    // login buono, non dal secret iniziale.
    const corrupting = await exec('corrupt');
    assert.deepEqual(corrupting.seen, { refresh_token: 'rt-2', generation: 2 });
    const afterCorruption = await exec('after');
    assert.deepEqual(afterCorruption.seen, { refresh_token: 'rt-2', generation: 2 });

    assert.equal(fs.existsSync(first.home), true);
    const cleaned = await request(socketPath, { op: 'cleanup' });
    assert.deepEqual(cleaned, { ok: true, cleaned: true });
    assert.equal(await waitForExit(broker), 0, stderr);
    assert.equal(fs.existsSync(first.home), false, 'la home del login deve sparire con il broker');
  } finally {
    if (broker.exitCode === null) broker.kill('SIGTERM');
    await waitForExit(broker).catch(() => {});
    fs.rmSync(brokerDir, { recursive: true, force: true });
    fs.rmSync(cliPrefix, { recursive: true, force: true });
  }
});

test('un errore API stampato come JSON restituisce anche il suo "message"', async () => {
  const brokerDir = tempBrokerDir();
  const cliPrefix = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-haiku-codex-cli.'));
  const socketPath = path.join(brokerDir, 'auth.sock');
  const cliPath = path.join(cliPrefix, 'codex');
  const fakeCli = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('codex 0.153.4'); process.exit(0); }
process.stdin.resume();
process.stdin.on('end', () => {
  process.stderr.write('ERROR: unexpected status 400 Bad Request: {\\n  "error": {\\n    "message": "Invalid schema for response_format: \\'additionalProperties\\' is required to be supplied and to be false.",\\n    "type": "invalid_request_error",\\n    "param": "text.format.schema",\\n    "code": "invalid_json_schema"\\n  }\\n}\\n');
  process.exit(1);
});
`;
  fs.writeFileSync(cliPath, fakeCli, { mode: 0o700 });
  fs.chmodSync(cliPath, 0o700);
  const cliSha256 = crypto.createHash('sha256').update(fs.readFileSync(cliPath)).digest('hex');
  const broker = spawn(process.execPath, [
    BROKER,
    '--socket', socketPath,
    '--ttl-ms', '60000',
    '--max-requests', '1',
    '--codex-bin', cliPath,
    '--codex-realpath', cliPath,
    '--codex-sha256', cliSha256,
    '--codex-prefix', cliPrefix,
  ], {
    cwd: ROOT,
    stdio: ['pipe', 'ignore', 'pipe'],
  });
  let stderr = '';
  broker.stderr.setEncoding('utf8');
  broker.stderr.on('data', (chunk) => { stderr += chunk; });
  broker.stdin.end('{"access_token":"test"}');

  try {
    await waitForSocket(socketPath, broker, 5000, () => stderr);
    const response = await request(socketPath, { op: 'exec', prompt: 'fail', timeoutMs: 5000 });
    assert.equal(response.ok, false, stderr);
    assert.match(response.error, /invalid_request_error/);
    assert.match(response.error, /additionalProperties' is required to be supplied and to be false/);
    assert.ok(response.error.length <= 300, response.error);

    const cleaned = await request(socketPath, { op: 'cleanup' });
    assert.deepEqual(cleaned, { ok: true, cleaned: true });
    assert.equal(await waitForExit(broker), 0, stderr);
  } finally {
    if (broker.exitCode === null) broker.kill('SIGTERM');
    await waitForExit(broker).catch(() => {});
    fs.rmSync(brokerDir, { recursive: true, force: true });
    fs.rmSync(cliPrefix, { recursive: true, force: true });
  }
});

// Il file del socket compare al bind(), un attimo prima del listen(): chi
// aspetta che il path esista (lo step di setup, questi test) poteva connettersi
// nel mezzo e ricevere ECONNREFUSED (PR 1773, run 36038787680). Il broker ora
// ascolta su un nome temporaneo nella stessa directory 0700 e lo rinomina solo
// quando accetta connessioni: «il socket esiste» vuol dire «pronto».
test('il socket compare solo quando il broker accetta gia\' connessioni', async () => {
  const brokerDir = tempBrokerDir();
  const cliPrefix = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-haiku-codex-cli.'));
  const socketPath = path.join(brokerDir, 'auth.sock');
  const cliPath = path.join(cliPrefix, 'codex');
  fs.writeFileSync(cliPath, "#!/usr/bin/env node\nif (process.argv.includes('--version')) { console.log('codex 0.153.4'); process.exit(0); }\n", { mode: 0o700 });
  fs.chmodSync(cliPath, 0o700);
  const cliSha256 = crypto.createHash('sha256').update(fs.readFileSync(cliPath)).digest('hex');
  const broker = spawn(process.execPath, [
    BROKER,
    '--socket', socketPath,
    '--ttl-ms', '60000',
    '--max-requests', '1',
    '--codex-bin', cliPath,
    '--codex-realpath', cliPath,
    '--codex-sha256', cliSha256,
    '--codex-prefix', cliPrefix,
  ], { cwd: ROOT, stdio: ['pipe', 'ignore', 'pipe'] });
  let stderr = '';
  broker.stderr.setEncoding('utf8');
  broker.stderr.on('data', (chunk) => { stderr += chunk; });
  broker.stdin.end('{"access_token":"test"}');
  try {
    await waitForSocket(socketPath, broker, 5000, () => stderr);
    assert.equal(fs.statSync(socketPath).mode & 0o777, 0o600, stderr);
    assert.deepEqual(
      fs.readdirSync(brokerDir).filter((name) => name.endsWith('.listening')),
      [],
      'il nome temporaneo di ascolto non deve restare accanto al socket',
    );
    // La prima connessione dopo che il path esiste va accettata subito.
    const cleaned = await request(socketPath, { op: 'cleanup' });
    assert.deepEqual(cleaned, { ok: true, cleaned: true });
    assert.equal(await waitForExit(broker), 0, stderr);
    assert.equal(fs.existsSync(socketPath), false);
  } finally {
    if (broker.exitCode === null) broker.kill('SIGTERM');
    await waitForExit(broker).catch(() => {});
    fs.rmSync(brokerDir, { recursive: true, force: true });
    fs.rmSync(cliPrefix, { recursive: true, force: true });
  }
});

// Codex finto che dorme `sleep:<ms>` preso dal prompt prima di rispondere.
const SLEEPING_CLI = `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('codex 0.153.4'); process.exit(0); }
const output = args[args.indexOf('--output-last-message') + 1];
if (!output) process.exit(2);
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { prompt += chunk; });
process.stdin.on('end', () => {
  const wait = Number(prompt.match(/sleep:(\\d+)/)?.[1] || 0);
  setTimeout(() => fs.writeFileSync(output, JSON.stringify({ prompt }), 'utf8'), wait);
});
`;

async function withSleepingBroker(ttlMs, body) {
  const brokerDir = tempBrokerDir();
  const cliPrefix = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-haiku-codex-cli.'));
  const socketPath = path.join(brokerDir, 'auth.sock');
  const cliPath = path.join(cliPrefix, 'codex');
  fs.writeFileSync(cliPath, SLEEPING_CLI, { mode: 0o700 });
  fs.chmodSync(cliPath, 0o700);
  const cliSha256 = crypto.createHash('sha256').update(fs.readFileSync(cliPath)).digest('hex');
  const broker = spawn(process.execPath, [
    BROKER,
    '--socket', socketPath,
    '--ttl-ms', String(ttlMs),
    '--max-requests', '16',
    '--codex-bin', cliPath,
    '--codex-realpath', cliPath,
    '--codex-sha256', cliSha256,
    '--codex-prefix', cliPrefix,
  ], {
    cwd: ROOT,
    stdio: ['pipe', 'ignore', 'pipe'],
  });
  let stderr = '';
  broker.stderr.setEncoding('utf8');
  broker.stderr.on('data', (chunk) => { stderr += chunk; });
  broker.stdin.end('{"access_token":"test"}');
  try {
    await waitForSocket(socketPath, broker).catch((error) => {
      throw new Error(`${error.message}: ${stderr}`);
    });
    await body({ broker, socketPath, stderr: () => stderr });
  } finally {
    if (broker.exitCode === null) broker.kill('SIGTERM');
    await waitForExit(broker).catch(() => {});
    fs.rmSync(brokerDir, { recursive: true, force: true });
    fs.rmSync(cliPrefix, { recursive: true, force: true });
  }
}

/** Scambio grezzo con timestamp: mostra i byte di controllo prima della riga JSON. */
function rawRequest(socketPath, payload) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const client = net.createConnection(socketPath);
    client.setEncoding('utf8');
    client.setTimeout(10_000, () => reject(new Error('broker request timed out')));
    client.on('error', reject);
    client.on('data', (chunk) => chunks.push({ at: Date.now(), data: String(chunk) }));
    client.on('end', () => resolve({ raw: chunks.map((c) => c.data).join(''), chunks }));
    client.on('connect', () => client.end(`${JSON.stringify(payload)}\n`));
  });
}

const jsonLine = (raw) => JSON.parse(raw.replace(/^[\0\x01]+/, ''));

// Il timer di SIGKILL parte sull'evento 'spawn', come il segnale al client:
// deve comunque scattare e rispondere, anche per un Codex che non esce mai.
test('un Codex che non risponde viene ucciso al budget contato dallo spawn', async () => {
  await withSleepingBroker(60_000, async ({ socketPath, stderr }) => {
    const startedAt = Date.now();
    const hung = await rawRequest(socketPath, { op: 'exec', prompt: 'sleep:60000', timeoutMs: 400, notifyStart: true });
    const elapsed = Date.now() - startedAt;
    assert.ok(hung.raw.includes('\x01'), 'il segnale di avvio precede la risposta');
    assert.deepEqual(jsonLine(hung.raw), { ok: false, error: 'Codex CLI timed out after 400ms' }, stderr());
    assert.ok(elapsed >= 400, `ucciso dopo ${elapsed}ms, prima del budget`);
    const next = await rawRequest(socketPath, { op: 'exec', prompt: 'sleep:10', timeoutMs: 5000 });
    assert.equal(jsonLine(next.raw).ok, true, 'la coda riparte dopo il SIGKILL');
  });
});

test('una richiesta più lunga del TTL completa: il broker scade solo da inattivo', async () => {
  await withSleepingBroker(300, async ({ broker, socketPath, stderr }) => {
    const long = await rawRequest(socketPath, { op: 'exec', prompt: 'sleep:900', timeoutMs: 5000 });
    assert.equal(jsonLine(long.raw).ok, true, stderr());
    assert.equal(await waitForExit(broker, 3000), 0, stderr());
    assert.equal(fs.existsSync(socketPath), false);
  });
});

test('il segnale di avvio arriva quando la richiesta esce dalla coda, e solo a chi lo chiede', async () => {
  await withSleepingBroker(60_000, async ({ socketPath, stderr }) => {
    const first = rawRequest(socketPath, { op: 'exec', prompt: 'sleep:600', timeoutMs: 5000, notifyStart: true });
    await delay(100);
    const queued = rawRequest(socketPath, { op: 'exec', prompt: 'sleep:10', timeoutMs: 5000, notifyStart: true });
    const legacy = rawRequest(socketPath, { op: 'exec', prompt: 'sleep:10', timeoutMs: 5000 });
    const [a, b, c] = await Promise.all([first, queued, legacy]);

    assert.ok(a.raw.startsWith('\x01') || a.raw.startsWith('\0\x01'), JSON.stringify(a.raw.slice(0, 4)));
    assert.equal(jsonLine(a.raw).ok, true, stderr());
    assert.equal(jsonLine(b.raw).ok, true, stderr());
    const firstAnswered = a.chunks.find((chunk) => chunk.data.includes('{')).at;
    const queuedStarted = b.chunks.find((chunk) => chunk.data.includes('\x01')).at;
    assert.ok(queuedStarted >= firstAnswered, 'la richiesta in coda parte dopo la risposta alla precedente');
    assert.equal(c.raw.includes('\x01'), false, 'senza notifyStart il protocollo resta quello di prima');
    assert.equal(jsonLine(c.raw).ok, true, stderr());
  });
});
