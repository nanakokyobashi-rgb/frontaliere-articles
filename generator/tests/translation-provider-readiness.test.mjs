import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  formatCredentialAlert,
  planCredentialAlerts,
  probeAzure,
  providerRecovered,
  rejectedProviders,
} from '../../scripts/translation-provider-readiness.mjs';
import { codexReserveCoverage } from '../../scripts/lib/codex-reserve-report.mjs';

function fetcherFrom(reply) {
  return async (url, init = {}) => {
    const { status, body = {} } = reply(String(url), init);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  };
}

test('Azure 401001 resta una credenziale rifiutata, mentre 429 e 200 hanno verdetti distinti', async () => {
  const rejected = await probeAzure('AZURE_TRANSLATOR_KEY', 'test-key', {
    fetcher: fetcherFrom(() => ({ status: 401, body: { error: { code: 401001 } } })),
  });
  assert.deepEqual(rejected, {
    provider: 'azure',
    credential: 'AZURE_TRANSLATOR_KEY',
    verdict: 'auth-failed',
    detail: 'HTTP 401 (401001), region=westeurope',
  });

  const exhausted = await probeAzure('AZURE_TRANSLATOR_KEY', 'test-key', {
    fetcher: fetcherFrom(() => ({ status: 429 })),
  });
  assert.equal(exhausted.verdict, 'quota-exhausted');

  const ready = await probeAzure('AZURE_TRANSLATOR_KEY', 'test-key', {
    fetcher: fetcherFrom(() => ({ status: 200, body: [] })),
  });
  assert.equal(ready.verdict, 'ok');
});

test('il provider Azure è rifiutato solo quando tutte le credenziali configurate falliscono auth', () => {
  const bothRejected = [
    { provider: 'azure', credential: 'AZURE_TRANSLATOR_KEY', verdict: 'auth-failed' },
    { provider: 'azure', credential: 'AZURE_TRANSLATOR_KEY_2', verdict: 'auth-failed' },
  ];
  assert.deepEqual(rejectedProviders(bothRejected), ['azure']);
  assert.equal(providerRecovered('azure', bothRejected), false);

  const oneRecovered = [
    ...bothRejected,
    { provider: 'azure', credential: 'AZURE_TRANSLATOR_KEY_2', verdict: 'ok' },
  ];
  assert.deepEqual(rejectedProviders(oneRecovered), []);
  assert.equal(providerRecovered('azure', oneRecovered), true);
});

test('la scheda conserva la metrica falsificabile e il comando canonico di rientro', () => {
  const body = formatCredentialAlert('azure', [
    {
      provider: 'azure',
      credential: 'AZURE_TRANSLATOR_KEY',
      verdict: 'auth-failed',
      detail: 'HTTP 401 (401001), region=westeurope',
    },
    {
      provider: 'azure',
      credential: 'AZURE_TRANSLATOR_KEY_2',
      verdict: 'auth-failed',
      detail: 'HTTP 401 (401001), region=westeurope',
    },
  ]);
  assert.match(body, /METRICA: prima=2 credential\(s\) rejected atteso=0/);
  assert.match(body, /COMANDO: `node scripts\/translation-provider-readiness\.mjs`/);
  assert.match(body, /AZURE_TRANSLATOR_KEY.*AZURE_TRANSLATOR_KEY_2/);
});

test('la riserva Codex non cancella la misura del provider', () => {
  const results = [
    { provider: 'azure', credential: 'AZURE_TRANSLATOR_KEY', verdict: 'auth-failed' },
    { provider: 'azure', credential: 'AZURE_TRANSLATOR_KEY_2', verdict: 'auth-failed' },
  ];
  assert.deepEqual(planCredentialAlerts(results, { verdict: 'covered', detail: 'ready' }), [
    { provider: 'azure', action: 'covered' },
  ]);
  assert.deepEqual(planCredentialAlerts(results, { verdict: 'codex-failed', detail: 'failed' }), [
    { provider: 'azure', action: 'alert' },
  ]);
});

test('il ramo alert può classificare i report della riserva Codex', () => {
  assert.deepEqual(codexReserveCoverage([{
    version: 1,
    phase: '2b-cascade',
    position: 'primary',
    lanePresent: true,
    calls: 1,
    maxCalls: 10,
    accepted: 1,
    rejected: 0,
    cascadeCalls: 1,
  }]), {
    verdict: 'covered',
    detail: '2b-cascade: ready, 1 translated / 0 rejected in 1/10 calls',
  });
});

test('translate-pending esegue il probe subito dopo Remote Config e usa il risultato per l alert', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/translate-pending.yml', import.meta.url), 'utf8');
  const loadAt = workflow.indexOf('- name: Load RC secrets');
  const probeAt = workflow.indexOf('- name: Probe translation provider readiness');
  const alertAt = workflow.indexOf('- name: Alert on rejected translation credentials');
  assert.ok(loadAt >= 0);
  assert.ok(probeAt > loadAt);
  assert.ok(alertAt > probeAt);
  assert.match(workflow.slice(probeAt, alertAt), /node scripts\/translation-provider-readiness\.mjs --summary --json/);
  assert.match(workflow.slice(alertAt), /steps\.provider_readiness\.outcome == 'success'/);
});

test('il contratto cross-repo include il probe ripristinato', () => {
  const contract = JSON.parse(readFileSync(new URL('../data/crawler-cross-repo-contract.json', import.meta.url), 'utf8'));
  assert.ok(contract.siteRuntimePaths.includes('scripts/translation-provider-readiness.mjs'));
});
