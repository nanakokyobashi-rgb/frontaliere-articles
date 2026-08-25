/**
 * GitHub Actions fetching cdn.frontaliereticino.ch gets HTTP 403
 * (Cloudflare WAF). --check must not fail the PR; a non-CI 403 still fails.
 * Drives the shipped refresh-border-wait-window.mjs via spawn.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isCiWafBlock, REWIRE_FETCH_HEADERS } from '../scripts/lib/rewire-fetch.mjs';

const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../scripts/refresh-border-wait-window.mjs',
);

function listen403() {
  return new Promise((resolve) => {
    const seen = { ua: null };
    const server = http.createServer((req, res) => {
      seen.ua = req.headers['user-agent'] || '';
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end('blocked');
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}/window.json`, seen });
    });
  });
}

function runScript(env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, '--check'], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

test('isCiWafBlock is true only on GITHUB_ACTIONS + HTTP 403', () => {
  const errors403 = ['https://cdn.example/x: HTTP 403', 'https://origin.example/x: HTTP 403'];
  assert.equal(isCiWafBlock(errors403, { GITHUB_ACTIONS: 'true' }), true);
  assert.equal(isCiWafBlock(['https://cdn.example/x: HTTP 404'], { GITHUB_ACTIONS: 'true' }), false);
  assert.equal(isCiWafBlock(errors403, {}), false);
});

test('REWIRE_FETCH_HEADERS sends a named UA, not the default Node one', () => {
  assert.match(REWIRE_FETCH_HEADERS['user-agent'], /frontaliere-articles-rewire/);
  assert.doesNotMatch(REWIRE_FETCH_HEADERS['user-agent'], /^node$/i);
});

test('--check against HTTP 403 fails outside Actions', async () => {
  const { server, url } = await listen403();
  try {
    const r = await runScript({ BORDER_WAIT_WINDOW_URL: url, GITHUB_ACTIONS: '' });
    assert.equal(r.code, 1);
    assert.match(r.err, /no source reachable/);
    assert.match(r.err, /HTTP 403/);
  } finally {
    server.close();
  }
});

test('--check against HTTP 403 exits 0 inside GitHub Actions', async () => {
  const { server, url, seen } = await listen403();
  try {
    const r = await runScript({
      BORDER_WAIT_WINDOW_URL: url,
      GITHUB_ACTIONS: 'true',
    });
    assert.equal(r.code, 0, r.err || r.out);
    assert.match(r.out, /unreachable from CI/);
    assert.match(seen.ua, /frontaliere-articles-rewire/);
  } finally {
    server.close();
  }
});
