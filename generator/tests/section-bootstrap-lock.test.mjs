import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  clearBootstrapLockOwnerStatusCache,
  classifyBootstrapLockOwnerRun,
  parseBootstrapLockOwner,
  readBootstrapLockOwnerRun,
} from '../../scripts/lib/section-bootstrap-lock.mjs';

const CLI = readFileSync(new URL('../../scripts/ci/section-bootstrap-lock.mjs', import.meta.url), 'utf8');
const FAST_WORKFLOW = readFileSync(new URL('../../.github/workflows/fast-publish-section.yml', import.meta.url), 'utf8');
const API_WORKFLOW = readFileSync(new URL('../../.github/workflows/publish-api.yml', import.meta.url), 'utf8');

test('bootstrap lock: l’owner identifica repository, run e attempt senza accettare forme ambigue', () => {
  assert.deepEqual(parseBootstrapLockOwner('nanakokyobashi-rgb/frontaliere-articles:40367509462:1'), {
    repository: 'nanakokyobashi-rgb/frontaliere-articles',
    runId: '40367509462',
    attempt: '1',
  });
  assert.equal(parseBootstrapLockOwner('test/bootstrap'), null);
  assert.deepEqual(classifyBootstrapLockOwnerRun({ status: 'in_progress' }), { state: 'active', status: 'in_progress' });
  assert.deepEqual(classifyBootstrapLockOwnerRun({ status: 'completed', conclusion: 'cancelled' }), {
    state: 'terminal',
    status: 'completed',
    conclusion: 'cancelled',
  });
  assert.equal(classifyBootstrapLockOwnerRun({ status: 'unknown' }).state, 'unknown');
});

test('bootstrap lock: legge lo stato dell attempt esatto e riusa una risposta breve in cache', async () => {
  clearBootstrapLockOwnerStatusCache();
  const owner = 'nanakokyobashi-rgb/frontaliere-articles:40367509462:1';
  const calls = [];
  let now = 1_000_000;
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ status: calls.length === 1 ? 'in_progress' : 'completed', conclusion: 'cancelled' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const active = await readBootstrapLockOwnerRun(owner, {
    env: { GH_TOKEN: 'read-token' },
    apiBase: 'https://api.example.test',
    fetchImpl,
    now: () => now,
  });
  assert.deepEqual(active, { state: 'active', status: 'in_progress' });
  const cached = await readBootstrapLockOwnerRun(owner, {
    env: { GH_TOKEN: 'read-token' },
    apiBase: 'https://api.example.test',
    fetchImpl,
    now: () => now + 30_000,
  });
  assert.deepEqual(cached, active);
  assert.equal(calls.length, 1);

  now += 60_001;
  const terminal = await readBootstrapLockOwnerRun(owner, {
    env: { GH_TOKEN: 'read-token' },
    apiBase: 'https://api.example.test',
    fetchImpl,
    now: () => now,
  });
  assert.deepEqual(terminal, { state: 'terminal', status: 'completed', conclusion: 'cancelled' });
  assert.equal(calls.length, 2);
  assert.equal(
    calls[0].url,
    'https://api.example.test/repos/nanakokyobashi-rgb/frontaliere-articles/actions/runs/40367509462/attempts/1',
  );
  assert.equal(calls[0].options.headers.authorization, 'Bearer read-token');
});

test('bootstrap lock: owner non verificabile resta fail-closed', async () => {
  assert.deepEqual(await readBootstrapLockOwnerRun('test/bootstrap', { env: { GH_TOKEN: 'read-token' } }), {
    state: 'unknown',
    reason: 'owner non associato a un attempt GitHub',
  });
  assert.deepEqual(await readBootstrapLockOwnerRun(
    'nanakokyobashi-rgb/frontaliere-articles:40367509462:1',
    { env: {} },
  ), { state: 'unknown', reason: 'token GitHub assente' });
});

test('bootstrap lock: un attempt terminato viene sostituito atomically con If-Match e i publisher ricevono il token di lettura', () => {
  assert.match(CLI, /readBootstrapLockOwnerRun\(existing\.doc\.owner\)/u);
  assert.match(CLI, /ownerRun\.state !== 'terminal'/u);
  assert.match(CLI, /takeoverEtag = existing\.etag/u);
  assert.match(CLI, /condition = `If-Match: \$\{etag\}`/u);

  const acquire = FAST_WORKFLOW.slice(
    FAST_WORKFLOW.indexOf('- name: Acquire bootstrap R2 gate'),
    FAST_WORKFLOW.indexOf('- name: Render, validate and publish the section pages'),
  );
  assert.match(acquire, /GH_TOKEN: \$\{\{ github\.token \}\}/u);

  const edge = API_WORKFLOW.slice(
    API_WORKFLOW.indexOf('- name: Publish the canton sections release to the edge'),
    API_WORKFLOW.indexOf('# Tell the site the surface moved after the edge flip'),
  );
  assert.match(edge, /GH_TOKEN: \$\{\{ github\.token \}\}/u);
});
