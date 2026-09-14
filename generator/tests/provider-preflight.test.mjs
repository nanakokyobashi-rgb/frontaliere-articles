import test from 'node:test';
import assert from 'node:assert/strict';
import { AI_MODELS } from '../scripts/lib/ai-models.mjs';
import {
  classifyProviderProbe,
  normalizeTimeoutMs,
  runProviderPreflight,
  summarizeProviderPreflight,
} from '../scripts/lib/provider-preflight.mjs';

test('provider preflight distingue credenziali mancanti, rete e quota', () => {
  assert.equal(classifyProviderProbe({ configured: false }).status, 'credential_missing');
  assert.equal(classifyProviderProbe({ configured: true, dnsError: new Error('ENOTFOUND') }).status, 'network_unresolved');
  assert.equal(classifyProviderProbe({ configured: true, networkError: 'network_timeout' }).status, 'network_unreachable');
  assert.equal(classifyProviderProbe({ configured: true, networkError: 'network_timeout' }).reason, 'network_timeout');
  assert.equal(classifyProviderProbe({ configured: true, httpStatus: 429 }).status, 'quota_or_rate_limited');
  assert.equal(classifyProviderProbe({ configured: true, httpStatus: 401 }).status, 'credential_rejected');
  assert.equal(classifyProviderProbe({ configured: true, httpStatus: 503 }).status, 'provider_unavailable');
  assert.equal(classifyProviderProbe({ configured: true, httpStatus: 200 }).status, 'ready');
});

test('il timeout configurato non può introdurre un AbortSignal invalido', () => {
  assert.equal(normalizeTimeoutMs('bad'), 8_000);
  assert.equal(normalizeTimeoutMs('0'), 8_000);
  assert.equal(normalizeTimeoutMs('1200'), 1_200);
});

test('una lane pronta rende il roster utilizzabile anche con altre lane bloccate', () => {
  const report = summarizeProviderPreflight([
    { provider: 'github', status: 'quota_or_rate_limited', reason: 'quota_or_rate_limited' },
    { provider: 'gemini', status: 'ready', reason: 'catalog_reachable' },
  ], '2026-09-14T12:00:00.000Z');
  assert.equal(report.ready, true);
  assert.deepEqual(report.readyProviders, ['gemini']);
  assert.deepEqual(report.blockedProviders, [{ provider: 'github', status: 'quota_or_rate_limited', reason: 'quota_or_rate_limited' }]);
});

test('il report resta bloccato quando nessun provider è utilizzabile', () => {
  const report = summarizeProviderPreflight([
    { provider: 'github', status: 'credential_missing', reason: 'credential_missing' },
    { provider: 'gemini', status: 'network_unresolved', reason: 'network_unresolved' },
  ]);
  assert.equal(report.ready, false);
  assert.equal(report.readyProviders.length, 0);
  assert.equal(report.blockedProviders.length, 2);
});

test('il preflight include il Codex action-owned quando il broker è pronto', async () => {
  const names = ['HAIKU_FALLBACK_GATE', 'ENABLE_CODEX_ARTICLE_FALLBACK', 'CODEX_AUTH_BROKER_SOCKET'];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  process.env.HAIKU_FALLBACK_GATE = '1';
  process.env.ENABLE_CODEX_ARTICLE_FALLBACK = '1';
  process.env.CODEX_AUTH_BROKER_SOCKET = '/tmp/codex-preflight-test.sock';
  try {
    const report = await runProviderPreflight({
      lookup: async () => [],
      fetchImpl: async () => ({ status: 200 }),
      now: () => '2026-09-14T12:00:00.000Z',
    });
    assert.ok(report.readyProviders.includes('codex_cli'));
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});
