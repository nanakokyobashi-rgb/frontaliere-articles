#!/usr/bin/env node
/**
 * Provider preflight for article-producing workflows.
 *
 * This checks the roster before the first inference call. It deliberately
 * never spends inference quota: providers with a stable /v1/models catalog
 * are queried there, while endpoints without a catalog are DNS-checked only.
 * The report distinguishes missing/rejected credentials, network failures and
 * quota/rate-limit responses, so "no provider" is an actionable red result.
 */
import dns from 'node:dns/promises';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  AI_MODELS,
  DEFAULT_CHAIN,
  getApiKeyForProvider,
  getGhModelsPats,
  getProviderForModel,
  GH_MODELS_CATALOG_URL,
} from './ai-models.mjs';

export const PROVIDER_PREFLIGHT_TIMEOUT_MS = 8_000;

const DISCOVERY_ENDPOINTS = Object.freeze({
  openrouter: 'https://openrouter.ai/api/v1/models',
  groq: 'https://api.groq.com/openai/v1/models',
  cerebras: 'https://api.cerebras.ai/v1/models',
  mistral: 'https://api.mistral.ai/v1/models',
});

// These endpoints are intentionally not inferred from model ids in the
// workflow. ai-models.mjs remains the source of truth for provider selection
// and credentials; this table only describes the cheapest safe probe.
const PROVIDER_PROBES = {
  // The runtime chat route is POST-only. Probe the observed catalog instead,
  // so a healthy endpoint cannot be misreported as unavailable on GET 405.
  github: { url: GH_MODELS_CATALOG_URL, mode: 'catalog' },
  gemini: { url: 'https://generativelanguage.googleapis.com/v1beta/models', mode: 'catalog', auth: 'query' },
  together: { url: 'https://api.together.xyz/v1/models', mode: 'catalog' },
  fireworks: { url: 'https://api.fireworks.ai/inference/v1/models', mode: 'catalog' },
  nvidia: { url: 'https://integrate.api.nvidia.com/v1/models', mode: 'catalog' },
  huggingface: { url: 'https://router.huggingface.co/v1/models', mode: 'catalog' },
  sambanova: { url: 'https://api.sambanova.ai/v1/models', mode: 'catalog' },
  cohere: { url: 'https://api.cohere.com/v1/models', mode: 'catalog' },
  cloudflare: { url: 'https://api.cloudflare.com/client/v4/', mode: 'dns' },
  codestral: { url: 'https://codestral.mistral.ai/v1/chat/completions', mode: 'dns' },
  chutes: { url: 'https://llm.chutes.ai/v1/models', mode: 'catalog' },
  zai: { url: 'https://api.z.ai/api/paas/v4/models', mode: 'catalog' },
  local: { url: process.env.LOCAL_LLM_URL || 'http://127.0.0.1:8080/v1/models', mode: 'catalog' },
  omniroute: { url: process.env.OMNIROUTE_URL || 'http://127.0.0.1:20128/v1/models', mode: 'catalog' },
  codex_cli: { url: null, mode: 'local' },
  claude_cli: { url: null, mode: 'local' },
};

for (const [provider, url] of Object.entries(DISCOVERY_ENDPOINTS)) {
  PROVIDER_PROBES[provider] = { url, mode: 'catalog' };
}
Object.freeze(PROVIDER_PROBES);

function providerGroups(models) {
  const groups = new Map();
  for (const model of models) {
    const provider = getProviderForModel(model);
    const group = groups.get(provider) || { provider, modelCount: 0 };
    group.modelCount += 1;
    groups.set(provider, group);
  }
  return [...groups.values()];
}

export function classifyProviderProbe({
  configured = false,
  mode = 'catalog',
  dnsError = null,
  networkError = null,
  provider = null,
  httpStatus = null,
} = {}) {
  if (!configured) {
    return { status: 'credential_missing', reason: 'credential_missing', quota: 'unknown' };
  }
  if (mode === 'local') {
    return { status: 'ready', reason: 'local_transport_ready', quota: 'not-applicable' };
  }
  if (dnsError) {
    return { status: 'network_unresolved', reason: 'network_unresolved', quota: 'unknown' };
  }
  if (networkError) {
    return {
      status: 'network_unreachable',
      reason: typeof networkError === 'string' ? networkError : 'network_unreachable',
      quota: 'unknown',
    };
  }
  if (httpStatus === null || httpStatus === undefined) {
    return { status: 'ready', reason: 'dns_resolved_quota_unprobed', quota: 'unprobed' };
  }
  if (provider === 'github' && httpStatus === 410) {
    return { status: 'provider_unavailable', reason: 'github_models_retirement_brownout', quota: 'unknown' };
  }
  if (httpStatus === 401 || httpStatus === 403) {
    return { status: 'credential_rejected', reason: 'credential_rejected', quota: 'unknown' };
  }
  if (httpStatus === 402 || httpStatus === 429) {
    return { status: 'quota_or_rate_limited', reason: 'quota_or_rate_limited', quota: 'blocked' };
  }
  if (httpStatus >= 500) {
    return { status: 'provider_unavailable', reason: 'provider_unavailable', quota: 'unknown' };
  }
  if (httpStatus >= 200 && httpStatus < 300) {
    return { status: 'ready', reason: 'catalog_reachable', quota: 'available' };
  }
  return { status: 'provider_unavailable', reason: 'provider_unavailable', quota: 'unknown' };
}

export function normalizeTimeoutMs(raw, fallback = PROVIDER_PREFLIGHT_TIMEOUT_MS) {
  const value = raw === undefined || raw === null || raw === '' ? fallback : Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function safeErrorReason(error) {
  if (error?.name === 'AbortError' || error?.code === 'UND_ERR_CONNECT_TIMEOUT') return 'network_timeout';
  return 'network_error';
}

async function probeProvider(group, {
  fetchImpl = globalThis.fetch,
  lookup = dns.lookup,
  timeoutMs = PROVIDER_PREFLIGHT_TIMEOUT_MS,
} = {}) {
  let apiKeys = [];
  try {
    apiKeys = group.provider === 'github'
      ? getGhModelsPats()
      : [getApiKeyForProvider(group.provider)].filter(Boolean);
  } catch {
    return { ...group, status: 'credential_rejected', reason: 'credential_config_invalid', quota: 'unknown' };
  }
  const configured = apiKeys.length > 0;

  const probe = PROVIDER_PROBES[group.provider] || { url: null, mode: 'local' };
  const base = {
    ...group,
    configured,
    probe: probe.mode,
    endpoint: probe.url ? new URL(probe.url).hostname : null,
  };
  if (!configured) return { ...base, ...classifyProviderProbe({ provider: group.provider, configured, mode: probe.mode }) };
  if (probe.mode === 'local') return { ...base, ...classifyProviderProbe({ provider: group.provider, configured, mode: probe.mode }) };

  const endpoint = new URL(probe.url);
  try {
    await lookup(endpoint.hostname);
  } catch (error) {
    return { ...base, ...classifyProviderProbe({ provider: group.provider, configured, mode: probe.mode, dnsError: error }), error: safeErrorReason(error) };
  }
  if (probe.mode === 'dns') {
    return { ...base, ...classifyProviderProbe({ provider: group.provider, configured, mode: probe.mode }) };
  }
  if (typeof fetchImpl !== 'function') {
    return {
      ...base,
      ...classifyProviderProbe({ provider: group.provider, configured, mode: probe.mode, networkError: 'fetch_unavailable' }),
      error: 'fetch_unavailable',
    };
  }

  let lastResult = null;
  for (const apiKey of apiKeys) {
    const headers = {
      Accept: 'application/json',
      Authorization: 'Bearer ' + apiKey,
    };
    let url = probe.url;
    if (probe.auth === 'query') {
      const query = new URL(url);
      query.searchParams.set('key', apiKey);
      url = query.toString();
      delete headers.Authorization;
    }
    try {
      const response = await fetchImpl(url, {
        method: 'GET',
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(normalizeTimeoutMs(timeoutMs)),
      });
      lastResult = {
        ...base,
        ...classifyProviderProbe({ provider: group.provider, configured, mode: probe.mode, httpStatus: response.status }),
        httpStatus: response.status,
      };
      // One usable account is enough to keep GitHub in the generation pool;
      // the runtime rotates the same PAT set for the actual request.
      if (lastResult.status === 'ready') return lastResult;
    } catch (error) {
      const reason = safeErrorReason(error);
      lastResult = {
        ...base,
        ...classifyProviderProbe({ provider: group.provider, configured, mode: probe.mode, networkError: reason }),
        error: reason,
      };
    }
  }
  return lastResult || { ...base, ...classifyProviderProbe({ provider: group.provider, configured, mode: probe.mode }) };
}

export function summarizeProviderPreflight(providers, generatedAt = new Date().toISOString()) {
  const ready = providers.filter((provider) => provider.status === 'ready');
  const blocked = providers.filter((provider) => provider.status !== 'ready');
  return {
    generatedAt,
    ready: ready.length > 0,
    readyProviders: ready.map(({ provider }) => provider),
    blockedProviders: blocked.map(({ provider, status, reason }) => ({ provider, status, reason })),
    providers,
  };
}

function defaultPreflightModels() {
  const models = [...DEFAULT_CHAIN];
  // Codex is deliberately absent from DEFAULT_CHAIN because it is reserved
  // for the article-body path. Generate Blog activates it through the
  // action-owned broker, so include that lane only when the action handed this
  // step a broker socket. FAQ and other callers without the socket retain the
  // normal shared roster.
  if (String(process.env.CODEX_AUTH_BROKER_SOCKET || '').trim()) {
    models.push(AI_MODELS.CODEX_CLI_PRIMARY);
  }
  return models;
}

export async function runProviderPreflight({
  models = defaultPreflightModels(),
  fetchImpl = globalThis.fetch,
  lookup = dns.lookup,
  timeoutMs = PROVIDER_PREFLIGHT_TIMEOUT_MS,
  now = () => new Date().toISOString(),
} = {}) {
  const groups = providerGroups(models);
  const providers = await Promise.all(groups.map((group) => probeProvider(group, { fetchImpl, lookup, timeoutMs })));
  return summarizeProviderPreflight(providers, now());
}

function outputPath() {
  return process.env.PROVIDER_PREFLIGHT_OUTPUT
    || (process.env.RUNNER_TEMP ? path.join(process.env.RUNNER_TEMP, 'provider-preflight.json') : path.join('/tmp', 'provider-preflight.json'));
}

function writeReport(report) {
  const target = outputPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(report, null, 2) + '\n');
  return target;
}

function appendSummary(report) {
  const target = process.env.GITHUB_STEP_SUMMARY;
  if (!target) return;
  const lines = ['### Provider preflight', '', `Esito: **${report.ready ? 'ready' : 'blocked'}**`, ''];
  for (const provider of report.providers) {
    lines.push('- `' + provider.provider + '`: **' + provider.status + '** (' + provider.reason + ')');
  }
  lines.push('');
  fs.appendFileSync(target, lines.join('\n'));
}

export async function main() {
  const report = await runProviderPreflight({
    timeoutMs: normalizeTimeoutMs(process.env.PROVIDER_PREFLIGHT_TIMEOUT_MS),
  });
  const target = writeReport(report);
  appendSummary(report);
  console.log(JSON.stringify({
    ready: report.ready,
    readyProviders: report.readyProviders,
    blockedProviders: report.blockedProviders,
    report: target,
  }));
  if (!report.ready) process.exitCode = 1;
  return report;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  await main();
}
