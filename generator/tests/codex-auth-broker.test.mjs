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

function waitForSocket(socketPath, child, timeoutMs = 5000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (fs.existsSync(socketPath)) {
        resolve();
        return;
      }
      if (child.exitCode !== null) {
        reject(new Error(`broker exited before becoming ready (${child.exitCode})`));
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
  const brokerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-broker-test.'));
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
    await waitForSocket(socketPath, broker);
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
  const brokerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-broker-idle-test.'));
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
    await waitForSocket(socketPath, broker).catch((error) => {
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
