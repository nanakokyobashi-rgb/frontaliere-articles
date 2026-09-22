#!/usr/bin/env node
/**
 * Verifica fail-closed della registrazione webhook usata dal coordinatore
 * event-driven del corpus. Non legge né stampa il secret del webhook.
 */
import { execFileSync } from 'node:child_process';

export const DEFAULT_REPOSITORY = 'nanakokyobashi-rgb/frontaliere-articles';
export const DEFAULT_WEBHOOK_URL = 'https://gh-nanako.frontaliereticino.ch/github/webhook';
export const REQUIRED_EVENTS = Object.freeze([
  // `deployment_status` contiene anche il deployment associato ed è il
  // segnale terminale atteso dal broker; l'evento iniziale `deployment` non è
  // necessario per concludere un'attesa su success/failure.
  'deployment_status',
  'issue_comment',
  'pull_request',
  'pull_request_review',
  'pull_request_review_comment',
  'workflow_run',
]);

function normalizedUrl(value) {
  try {
    const url = new URL(String(value || ''));
    url.hash = '';
    url.search = '';
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    return url.toString();
  } catch {
    return '';
  }
}

function secureSsl(config) {
  return !['1', 1, true].includes(config?.insecure_ssl);
}

function coveredEvents(events) {
  const configured = new Set(Array.isArray(events) ? events : []);
  if (configured.has('*')) return [];
  return REQUIRED_EVENTS.filter((event) => !configured.has(event));
}

export function inspectWebhookRegistration(hooks, {
  expectedUrl = DEFAULT_WEBHOOK_URL,
} = {}) {
  const expected = normalizedUrl(expectedUrl);
  const candidates = (Array.isArray(hooks) ? hooks : [])
    .filter((hook) => hook?.name === 'web' && normalizedUrl(hook?.config?.url) === expected);

  if (candidates.length !== 1) {
    return {
      ok: false,
      reason: candidates.length === 0 ? 'registration_missing' : 'registration_ambiguous',
      matchingHooks: candidates.length,
    };
  }

  const hook = candidates[0];
  const missingEvents = coveredEvents(hook.events);
  const lastCode = Number(hook?.last_response?.code || 0);
  const checks = {
    active: hook.active === true,
    jsonContentType: hook?.config?.content_type === 'json',
    tlsVerification: secureSsl(hook.config),
    requiredEvents: missingEvents.length === 0,
    deliveredSuccessfully: lastCode >= 200 && lastCode < 300,
  };
  const failedChecks = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);

  return {
    ok: failedChecks.length === 0,
    reason: failedChecks.length === 0 ? 'registered' : 'registration_invalid',
    hookId: hook.id ?? null,
    checks,
    missingEvents,
    lastResponseCode: lastCode || null,
  };
}

export function githubHooksArgs(repository) {
  const repo = String(repository || '').trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error('repository_invalid');
  return ['api', `repos/${repo}/hooks`, '--paginate'];
}

function main() {
  const repository = process.env.GITHUB_REPOSITORY || DEFAULT_REPOSITORY;
  const expectedUrl = process.env.FRONTALIERE_GH_WEBHOOK_URL || DEFAULT_WEBHOOK_URL;
  let hooks;
  try {
    hooks = JSON.parse(execFileSync('gh', githubHooksArgs(repository), {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    }));
  } catch (error) {
    process.stderr.write(`verify-github-webhook-registration: GitHub hooks non leggibili (${error.status ?? 'errore'}); serve un token owner/admin.\n`);
    process.exitCode = 1;
    return;
  }

  const result = inspectWebhookRegistration(hooks, { expectedUrl });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) main();
