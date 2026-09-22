import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_WEBHOOK_URL,
  REQUIRED_EVENTS,
  githubHooksArgs,
  inspectWebhookRegistration,
} from '../../scripts/ci/verify-github-webhook-registration.mjs';

function hook(overrides = {}) {
  return {
    id: 42,
    name: 'web',
    active: true,
    events: [...REQUIRED_EVENTS],
    config: {
      url: DEFAULT_WEBHOOK_URL,
      content_type: 'json',
      insecure_ssl: '0',
    },
    last_response: { code: 204, status: 'ok', message: 'OK' },
    ...overrides,
  };
}

test('accetta una registrazione attiva, TLS, JSON e con ultima delivery verde', () => {
  const result = inspectWebhookRegistration([hook()]);
  assert.equal(result.ok, true);
  assert.equal(result.reason, 'registered');
  assert.deepEqual(result.missingEvents, []);
});

test('accetta il wildcard GitHub come copertura degli eventi richiesti', () => {
  assert.equal(inspectWebhookRegistration([hook({ events: ['*'] })]).ok, true);
});

test('fallisce chiuso se la registrazione manca o e duplicata', () => {
  assert.deepEqual(inspectWebhookRegistration([]), {
    ok: false,
    reason: 'registration_missing',
    matchingHooks: 0,
  });
  assert.equal(inspectWebhookRegistration([hook(), hook({ id: 43 })]).reason, 'registration_ambiguous');
});

test('rifiuta hook inattivi, TLS disabilitato, eventi incompleti o delivery rossa', () => {
  const scenarios = [
    hook({ active: false }),
    hook({ config: { url: DEFAULT_WEBHOOK_URL, content_type: 'json', insecure_ssl: '1' } }),
    hook({ events: REQUIRED_EVENTS.filter((event) => event !== 'workflow_run') }),
    hook({ last_response: { code: 500, status: 'misconfigured', message: 'failed' } }),
  ];
  for (const candidate of scenarios) {
    assert.equal(inspectWebhookRegistration([candidate]).ok, false);
  }
});

test('la query GitHub nomina esplicitamente owner e repository', () => {
  assert.deepEqual(
    githubHooksArgs('nanakokyobashi-rgb/frontaliere-articles'),
    ['api', 'repos/nanakokyobashi-rgb/frontaliere-articles/hooks', '--paginate'],
  );
  assert.throws(() => githubHooksArgs('frontaliere-articles'), /repository_invalid/);
});
