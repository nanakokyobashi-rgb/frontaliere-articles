#!/usr/bin/env node

import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { ARTICLE_SECTION_CORE_ALL, ARTICLE_SECTION_CORE_LIST } from '../../engine/shared/articleSectionCore.mjs';
import {
  EMBEDDING_NEAR_DUP_CORPUS_BASELINE,
  EMBEDDING_NEAR_DUP_CORPUS_SCALE_K,
  EMBEDDING_NEAR_DUP_COSINE,
  EMBEDDING_NEAR_DUP_COSINE_CEILING,
  computeAdaptiveNearDupCosine,
} from '../../generator/scripts/lib/scoring/constants.mjs';
import { cosineSimilarity } from '../../generator/scripts/lib/scoring/embeddingMatcher.mjs';
import { buildDedupText } from '../../generator/scripts/lib/scoring/semanticDedup.mjs';
import { EMBEDDING_DIM, EMBEDDING_MODEL } from '../../generator/scripts/lib/evidence/constants.mjs';
import { cantonSectionPaths } from '../../generator/scripts/lib/canton-section-profile.mjs';
import { r2PublishPlan, r2PublishPlanForRange } from './fast-publish-section.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '../..');
const execFileAsync = promisify(execFile);
const GH_FRONTALIERE = (() => {
  let directory = REPO_ROOT;
  while (true) {
    const candidate = path.join(directory, 'bin', 'gh-frontaliere');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(directory);
    if (parent === directory) return candidate;
    directory = parent;
  }
})();
const GH_REPO = 'nanakokyobashi-rgb/frontaliere-articles';
const API_BASE = process.env.SECTION_CADENCE_API_BASE || 'https://nanakokyobashi-rgb.github.io/frontaliere-articles';
const SITE_BASE = process.env.SECTION_CADENCE_SITE_BASE || 'https://frontaliereticino.ch';
const TIME_ZONE = 'Europe/Zurich';
const PAGE_USER_AGENT = 'Mozilla/5.0 (compatible; SectionCadence/1.0; +https://frontaliereticino.ch)';
const RUN_FIELDS = [
  'databaseId', 'displayTitle', 'event', 'status', 'conclusion', 'createdAt', 'updatedAt',
  'headSha', 'headBranch', 'workflowName', 'attempt', 'startedAt',
].join(',');
const VIEW_FIELDS = 'databaseId,displayTitle,status,conclusion,createdAt,updatedAt,headSha,workflowName,jobs';
const INVALID_DATE = '0001-01-01T00:00:00Z';

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8'));
}

function formatDatePartsInZurich(date) {
  const parts = new Intl.DateTimeFormat('en-CA-u-hc-h23', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function dateOnlyInZurich(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : formatDatePartsInZurich(parsed);
}

function offsetAtUtcMillis(instantMs) {
  const formatter = new Intl.DateTimeFormat('en-CA-u-hc-h23', {
    timeZone: TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const values = Object.fromEntries(formatter.formatToParts(new Date(instantMs)).map(({ type, value }) => [type, value]));
  const representedAsUtc = Date.UTC(
    Number(values.year), Number(values.month) - 1, Number(values.day),
    Number(values.hour), Number(values.minute), Number(values.second),
  );
  return representedAsUtc - Math.floor(instantMs / 1000) * 1000;
}

function zonedMidnightToUtc(dateText) {
  const [year, month, day] = dateText.split('-').map(Number);
  const targetUtcLike = Date.UTC(year, month - 1, day);
  let instant = targetUtcLike;
  for (let i = 0; i < 4; i += 1) instant = targetUtcLike - offsetAtUtcMillis(instant);
  return new Date(instant);
}

function nextDate(dateText) {
  const [year, month, day] = dateText.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
}

export function makeDateWindow(from, to) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    throw new Error('--from e --to devono avere formato YYYY-MM-DD (Europe/Zurich)');
  }
  if (from > to) throw new Error('--from deve essere uguale o precedente a --to');
  const start = zonedMidnightToUtc(from);
  const endExclusive = zonedMidnightToUtc(nextDate(to));
  return { from, to, start, endExclusive };
}

export function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--help' || flag === '-h') return { help: true };
    if (!['--from', '--to', '--output'].includes(flag)) throw new Error(`Opzione sconosciuta: ${flag}`);
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) throw new Error(`${flag} richiede un valore`);
    args[flag.slice(2)] = value;
    i += 1;
  }
  if (!args.from || !args.to) throw new Error('Uso: node scripts/ci/measure-section-cadence.mjs --from YYYY-MM-DD --to YYYY-MM-DD [--output file.json]');
  makeDateWindow(args.from, args.to);
  return args;
}

export function countCronOccurrences(cron, start, endExclusive) {
  const fields = String(cron).trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`Cron non supportato: ${cron}`);
  const [minuteField, hourField, dayField, monthField, weekdayField] = fields;
  if (dayField !== '*' || monthField !== '*' || weekdayField !== '*') {
    throw new Error(`Cron limitato non supportato dalla misura: ${cron}`);
  }
  const minutes = new Set(minuteField === '*' ? Array.from({ length: 60 }, (_, i) => i) : minuteField.split(',').map(Number));
  const hours = new Set(hourField === '*' ? Array.from({ length: 24 }, (_, i) => i) : hourField.split(',').map(Number));
  if ([...minutes].some((n) => !Number.isInteger(n) || n < 0 || n > 59)
    || [...hours].some((n) => !Number.isInteger(n) || n < 0 || n > 23)) {
    throw new Error(`Cron con minuto/ora non valido: ${cron}`);
  }
  let count = 0;
  const cursor = new Date(start);
  cursor.setUTCSeconds(0, 0);
  if (cursor < start) cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  for (; cursor < endExclusive; cursor.setUTCMinutes(cursor.getUTCMinutes() + 1)) {
    if (minutes.has(cursor.getUTCMinutes()) && hours.has(cursor.getUTCHours())) count += 1;
  }
  return count;
}

export function mapLimit(items, limit, mapper) {
  const output = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      output[index] = await mapper(items[index], index);
    }
  });
  return Promise.all(workers).then(() => output);
}

function runtimeLogPayloads(logText) {
  return String(logText || '').split(/\r?\n/).map((line) => {
    const normalized = line.replace(/\u001b\[[0-9;]*m/g, '');
    const fields = normalized.split('\t');
    const timestampPrefix = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z(?:\s+|$)/;
    const thirdFieldIsTimestampedPayload = fields.length >= 3 && timestampPrefix.test(fields[2]);
    let payload = thirdFieldIsTimestampedPayload
      ? [fields[2].replace(timestampPrefix, ''), ...fields.slice(3)].join('\t')
      : fields.length >= 4
        ? fields.slice(3).join('\t')
        : normalized;
    payload = payload.trim();
    if (!payload || /^(?:Run\s+|\+\s*)?(?:echo|printf)\b/i.test(payload)) return null;
    return payload;
  }).filter(Boolean);
}

export function parseGenerationMarkers(logText) {
  const markers = [];
  const pattern = /^GENERATION_OUTCOME\s+kind=([^\s]+)\s+reason=([^\s]+)\s+section=([^\s]+)$/;
  for (const payload of runtimeLogPayloads(logText)) {
    const match = payload.match(pattern);
    if (!match) continue;
    const [, kind, reason, section] = match;
    if ([kind, reason, section].some((value) => value.includes('$'))) continue;
    if (!/^[A-Za-z0-9_-]+$/.test(kind) || !/^[A-Za-z0-9_-]+$/.test(reason) || !/^[A-Za-z0-9_-]+$/.test(section)) continue;
    markers.push({ kind, reason, section });
  }
  return markers;
}

export function parseGenerationAttempts(logText) {
  const attempts = [];
  const pattern = /^GENERATION_ATTEMPT\s+attempt=(\d+)\s+section=([A-Za-z0-9_-]+)$/;
  for (const payload of runtimeLogPayloads(logText)) {
    const match = payload.match(pattern);
    if (!match) continue;
    const attempt = Number(match[1]);
    const section = match[2];
    if (Number.isInteger(attempt) && attempt > 0 && ARTICLE_SECTION_CORE_ALL[section]) attempts.push({ attempt, section });
  }
  return attempts;
}

export function parseLlmMetricMarkers(logText) {
  const metrics = [];
  for (const line of runtimeLogPayloads(logText)) {
    const prefix = 'GENERATION_LLM_CALLS ';
    if (!line.startsWith(prefix)) continue;
    const payloadText = line.slice(prefix.length).trim();
    try {
      const payload = JSON.parse(payloadText);
      const stages = payload?.providerRequestsByStage;
      if (payload?.schemaVersion !== 1 || !stages || typeof stages !== 'object') continue;
      const valid = ['selection', 'generation', 'factCheck', 'translation', 'unclassified']
        .every((stage) => Number.isInteger(stages[stage]) && stages[stage] >= 0);
      const attempt = payload.generationAttempt;
      const section = payload.section;
      if (valid && Number.isInteger(attempt) && attempt > 0 && ARTICLE_SECTION_CORE_ALL[section]) {
        metrics.push({ attempt, section, providerRequestsByStage: stages });
      }
    } catch {
      // Source lines and truncated log fragments are not structured records.
    }
  }
  return metrics;
}

export function parseDedupStoreMarkers(logText) {
  const observations = [];
  const prefix = 'GENERATION_DEDUP_STORE ';
  const validStatuses = new Set([
    'store_missing', 'empty_input', 'embedding_failed', 'embedding_empty',
    'dimension_mismatch', 'model_mismatch', 'compared', 'compared_model_unverified', 'duplicate_rejected',
  ]);
  const nullableNumber = (value) => value === null || (Number.isFinite(value) && value >= 0 && value <= 1);
  for (const line of runtimeLogPayloads(logText)) {
    if (!line.startsWith(prefix)) continue;
    try {
      const payload = JSON.parse(line.slice(prefix.length));
      const parameters = payload?.policyParameters;
      const validPolicyParameters = parameters
        && Number.isFinite(parameters.baseThreshold) && parameters.baseThreshold >= 0 && parameters.baseThreshold <= 1
        && Number.isFinite(parameters.ceiling) && parameters.ceiling >= parameters.baseThreshold && parameters.ceiling <= 1
        && Number.isInteger(parameters.corpusBaseline) && parameters.corpusBaseline > 0
        && Number.isFinite(parameters.corpusScaleK) && parameters.corpusScaleK >= 0;
      const validAttempt = payload?.generationAttempt === null
        || (Number.isInteger(payload?.generationAttempt) && payload.generationAttempt > 0);
      const validStoreCount = payload?.storeCount === null
        || (Number.isInteger(payload?.storeCount) && payload.storeCount >= 0);
      const validStoreDimension = payload?.storeDimension === null
        || (Number.isInteger(payload?.storeDimension) && payload.storeDimension > 0);
      const validNullableString = (value) => value === null || typeof value === 'string';
      const validObservationTime = typeof payload?.observedAt === 'string' && Number.isFinite(Date.parse(payload.observedAt));
      const validThresholdSource = payload?.thresholdSource === null
        || ['explicit_override', 'runtime_store_count'].includes(payload.thresholdSource);
      if (payload?.schemaVersion !== 1 || !ARTICLE_SECTION_CORE_ALL[payload.section]
        || !validStatuses.has(payload.status) || !validObservationTime || !validPolicyParameters
        || !validAttempt || !validStoreCount || !validStoreDimension || !validThresholdSource
        || typeof payload.storePresent !== 'boolean' || typeof payload.metaPresent !== 'boolean'
        || typeof payload.gateApplied !== 'boolean'
        || !validNullableString(payload.metaModel) || !validNullableString(payload.queryModel)
        || !validNullableString(payload.candidateId)
        || !Number.isInteger(payload.expectedDimension) || payload.expectedDimension <= 0
        || !validNullableString(payload.expectedModel)
        || !nullableNumber(payload.policyThreshold) || !nullableNumber(payload.effectiveThreshold)
        || (payload.gateApplied && (!payload.storePresent || payload.storeCount === null || payload.effectiveThreshold === null))
        || (!payload.gateApplied && payload.effectiveThreshold !== null)) continue;
      observations.push({
        section: payload.section,
        observedAt: payload.observedAt,
        generationAttempt: payload.generationAttempt,
        candidateId: payload.candidateId,
        status: payload.status,
        storePresent: payload.storePresent,
        storeCount: payload.storeCount,
        storeDimension: payload.storeDimension,
        metaPresent: payload.metaPresent,
        metaCount: Number.isInteger(payload.metaCount) && payload.metaCount >= 0 ? payload.metaCount : null,
        metaDimension: Number.isInteger(payload.metaDimension) && payload.metaDimension > 0 ? payload.metaDimension : null,
        metaMappedCount: Number.isInteger(payload.metaMappedCount) && payload.metaMappedCount >= 0 ? payload.metaMappedCount : null,
        metaModel: payload.metaModel,
        expectedModel: payload.expectedModel,
        expectedDimension: payload.expectedDimension,
        queryModel: payload.queryModel,
        gateApplied: payload.gateApplied,
        policyThreshold: payload.policyThreshold,
        policyParameters: parameters,
        effectiveThreshold: payload.effectiveThreshold,
        thresholdSource: payload.thresholdSource,
        // Dal fix M6 il gate di produzione e' fail-closed: un'osservazione
        // senza confronto con failClosed=true ha fermato il run, non ha
        // pubblicato senza dedup, e non conta come fail-open.
        failClosed: payload.failClosed === true && payload.gateApplied === false,
      });
    } catch {
      // Source lines and truncated workflow-log fragments are not runtime evidence.
    }
  }
  return observations;
}

export function summarizeDedupRuntimeEvidence(observations, sections) {
  return Object.fromEntries(sections.map((section) => {
    const sectionObservations = observations.filter((observation) => observation.section === section)
      .sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt));
    const latest = sectionObservations.at(-1) || null;
    const statusCounts = {};
    for (const observation of sectionObservations) {
      statusCounts[observation.status] = (statusCounts[observation.status] || 0) + 1;
    }
    const modelAndThresholdVerified = (observation) => observation?.gateApplied === true
      && observation.storePresent === true
      && Number.isInteger(observation.storeCount)
      && Number.isFinite(observation.effectiveThreshold)
      && typeof observation.metaModel === 'string' && observation.metaModel.length > 0
      && typeof observation.queryModel === 'string' && observation.queryModel.length > 0
      && observation.metaModel === EMBEDDING_MODEL
      && observation.queryModel === EMBEDDING_MODEL
      && observation.expectedModel === EMBEDDING_MODEL
      && observation.expectedDimension === EMBEDDING_DIM
      && observation.metaCount === observation.storeCount
      && observation.metaDimension === observation.storeDimension
      && observation.metaMappedCount === observation.storeCount
      && observation.metaModel === observation.queryModel
      && observation.storeDimension === EMBEDDING_DIM;
    const verifiedThresholds = sectionObservations.filter(modelAndThresholdVerified);
    const minimumVerifiedObservation = verifiedThresholds.reduce((minimum, observation) => (
      !minimum || observation.effectiveThreshold < minimum.effectiveThreshold
        || (observation.effectiveThreshold === minimum.effectiveThreshold && observation.storeCount < minimum.storeCount)
        ? observation : minimum
    ), null);
    const failClosedObservations = sectionObservations.filter((observation) => observation.failClosed === true).length;
    const failOpenObservations = sectionObservations.filter((observation) => !observation.gateApplied
      && observation.status !== 'empty_input' && observation.failClosed !== true).length;
    const latestGateStatus = !latest ? 'unobserved'
      : latest.failClosed === true ? `fail_closed:${latest.status}`
        : !latest.gateApplied ? `fail_open:${latest.status}`
        : modelAndThresholdVerified(latest) ? 'active_verified' : 'active_model_or_threshold_unverified';
    const windowGateStatus = failOpenObservations > 0 ? 'fail_open_observed_in_window'
      : sectionObservations.some((observation) => observation.gateApplied)
        ? sectionObservations.every((observation) => modelAndThresholdVerified(observation) || observation.status === 'empty_input')
          ? 'active_verified_in_observed_markers' : 'active_model_or_threshold_unverified_in_observed_markers'
        // Finestra con sole osservazioni fail-closed: il gate non ha mai confrontato
        // (store/modello non disponibili) ma il run si e' fermato senza pubblicare.
        // Non e' fail-open ne' un gate verificato: M6 resta non misurato.
        : sectionObservations.length > 0 && failClosedObservations === sectionObservations
          .filter((observation) => observation.status !== 'empty_input').length
          && failClosedObservations > 0 ? 'fail_closed_only_in_window'
          : sectionObservations.length ? 'no_comparable_candidate_observed' : 'unobserved';
    return [section, {
      observationCount: sectionObservations.length,
      failOpenObservations,
      failClosedObservations,
      statusCounts,
      latestGateStatus,
      windowGateStatus,
      minimumVerifiedEffectiveThreshold: minimumVerifiedObservation?.effectiveThreshold ?? null,
      minimumVerifiedStoreCount: minimumVerifiedObservation?.storeCount ?? null,
      verifiedThresholdObservationCount: verifiedThresholds.length,
      verifiedThresholdsStable: verifiedThresholds.length > 0
        && new Set(verifiedThresholds.map((observation) => observation.effectiveThreshold)).size === 1,
      latest,
    }];
  }));
}

export function computePolicyThresholdFromParameters(corpusSize, parameters) {
  const base = parameters?.baseThreshold;
  const ceiling = parameters?.ceiling;
  const baseline = parameters?.corpusBaseline;
  const scaleK = parameters?.corpusScaleK;
  if (!Number.isFinite(base) || !Number.isFinite(ceiling) || !Number.isInteger(baseline)
    || baseline <= 0 || !Number.isFinite(scaleK) || scaleK < 0) return null;
  const n = Number.isFinite(corpusSize) && corpusSize > 0 ? corpusSize : baseline;
  const scaled = base + scaleK * Math.log10(n / baseline);
  return Math.min(Math.max(ceiling, base), Math.max(base, scaled));
}

export function percentiles(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return { count: 0, p50: null, p90: null, max: null };
  const at = (p) => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
  return { count: sorted.length, p50: at(0.5), p90: at(0.9), max: sorted.at(-1) };
}

function dateMs(value) {
  if (typeof value !== 'string' || value === INVALID_DATE) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function publishRunDurationMinutes(run) {
  // `updatedAt` e' un proxy del completamento solo a run chiusa: su una run in
  // coda o in corso e' l'ultimo aggiornamento e darebbe una durata fasulla.
  if (typeof run?.status === 'string' && run.status.toLowerCase() !== 'completed') return null;
  const startedAt = dateMs(run?.startedAt) ?? dateMs(run?.createdAt);
  const finishedAt = dateMs(run?.updatedAt);
  if (startedAt === null || finishedAt === null || finishedAt < startedAt) return null;
  return (finishedAt - startedAt) / 60_000;
}

export function isNoopFastPublishRun(run, commit) {
  const event = String(run?.event || '').toLowerCase();
  return Boolean(commit)
    && Array.isArray(commit.touchedSections)
    && commit.touchedSections.length === 0
    && (!event || event === 'push');
}

function shellFreeGit(args, options = {}) {
  return execFileSync('git', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
}

function github(args, { maxBuffer = 64 * 1024 * 1024 } = {}) {
  if (!fs.existsSync(GH_FRONTALIERE)) throw new Error(`Coordinatore GitHub non trovato: ${GH_FRONTALIERE}`);
  return execFileAsync(GH_FRONTALIERE, ['--identity', 'nanako', ...args, '--repo', GH_REPO], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer,
    timeout: 180_000,
    windowsHide: true,
  }).then(({ stdout }) => stdout).catch((error) => {
    throw new Error(`lettura GitHub fallita per '${args.slice(0, 3).join(' ')}' (exit ${error.code || error.signal || 'unknown'})`);
  });
}

function ghDateRange(window) {
  const lastIncluded = new Date(window.endExclusive.getTime() - 1000);
  return `${window.start.toISOString()}..${lastIncluded.toISOString()}`;
}

async function fetchTextWithRetry(url, { headers = {}, attempts = 3, timeoutMs = 20_000 } = {}) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { headers, signal: controller.signal, redirect: 'follow' });
      const body = await response.text();
      if ((response.status === 429 || response.status >= 500) && attempt + 1 < attempts) {
        await new Promise((resolve) => setTimeout(resolve, 250 * (2 ** attempt)));
        continue;
      }
      return { response, body };
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, 250 * (2 ** attempt)));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError || new Error(`fetch failed: ${url}`);
}

async function fetchJson(url) {
  const { response, body } = await fetchTextWithRetry(url, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`${url} returned invalid JSON`);
  }
}

async function readPublishedApi() {
  const files = [
    'manifest.json', 'articles.json', 'swiss-articles.json', 'canton-articles.json',
    'slugs.json', 'meta-it.json', 'meta-ch-it.json', 'meta-canton-it.json',
  ];
  const values = await mapLimit(files, 8, async (name) => [name, await fetchJson(`${API_BASE}/${name}`)]);
  const api = Object.fromEntries(values);
  const manifest = api['manifest.json'];
  const national = api['articles.json'];
  const swiss = api['swiss-articles.json'];
  const cantons = api['canton-articles.json'];
  const slugs = api['slugs.json'];
  if (!manifest?.commit || !manifest?.counts || !Array.isArray(national) || !Array.isArray(swiss) || !Array.isArray(cantons)) {
    throw new Error('manifest o indici pubblici non hanno lo schema atteso');
  }
  if (manifest.counts.articles !== national.length
    || manifest.counts.swissArticles !== swiss.length
    || manifest.counts.cantonArticles !== cantons.length
    || slugs?.commit !== manifest.commit) {
    throw new Error('commit/count del manifest non corrispondono agli indici pubblicati');
  }
  const manifestBySection = manifest.counts.bySection;
  if (!manifestBySection || typeof manifestBySection !== 'object') {
    throw new Error('manifest senza conteggi articolo per sezione: M6 non può ricostruire soglie di produzione');
  }
  const sectionArticleCounts = Object.fromEntries(Object.keys(ARTICLE_SECTION_CORE_ALL).map((section) => [section, 0]));
  for (const article of national) sectionArticleCounts.frontaliere += 1;
  for (const article of swiss) sectionArticleCounts.svizzera += 1;
  for (const article of cantons) {
    if (!Object.hasOwn(sectionArticleCounts, article?.section)) {
      throw new Error(`indice cantonale contiene una sezione non riconosciuta: ${article?.section || '(assente)'}`);
    }
    sectionArticleCounts[article.section] += 1;
  }
  for (const [section, count] of Object.entries(sectionArticleCounts)) {
    const manifestCount = manifestBySection[section]?.articles;
    if (!Number.isInteger(manifestCount) || manifestCount !== count) {
      throw new Error(`manifest/index bySection non corrispondono per ${section}`);
    }
  }
  return {
    manifest,
    national,
    swiss,
    cantons,
    slugs,
    sectionArticleCounts,
    meta: {
      frontaliere: api['meta-it.json'],
      svizzera: api['meta-ch-it.json'],
      canton: api['meta-canton-it.json'],
    },
  };
}

function sectionSlugMap(section, slugs) {
  if (section === 'frontaliere') return slugs.blog;
  if (section === 'svizzera') return slugs.swiss;
  return slugs.cantons?.[section];
}

function sectionMeta(section, meta) {
  if (section === 'frontaliere') return meta.frontaliere;
  if (section === 'svizzera') return meta.svizzera;
  return meta.canton;
}

export function buildArticleRecords(api) {
  const rows = [
    ...api.national.map((article) => [article, 'frontaliere']),
    ...api.swiss.map((article) => [article, 'svizzera']),
    ...api.cantons.map((article) => [article, article.section]),
  ];
  const seenSlugs = new Set();
  const articles = [];
  const skippedRecords = [];
  const duplicateSlugsBySection = {};
  for (const [article, section] of rows) {
    const id = article?.id;
    const core = ARTICLE_SECTION_CORE_ALL[section];
    const localeSlug = sectionSlugMap(section, api.slugs)?.[id]?.it;
    const sourceDate = article?.date ?? article?.datePublished;
    const publishedDate = dateOnlyInZurich(sourceDate);
    const missing = [];
    if (!id) missing.push('id');
    if (!core) missing.push('section');
    if (!localeSlug) missing.push('slug');
    if (!publishedDate) missing.push('date');
    if (missing.length) {
      skippedRecords.push({ section: core ? section : 'unknown', id: id || null, slug: localeSlug || null, publishedDate, reasons: missing });
      continue;
    }
    const slugKey = `${section}:${localeSlug}`;
    if (seenSlugs.has(slugKey)) {
      duplicateSlugsBySection[section] = (duplicateSlugsBySection[section] || 0) + 1;
      skippedRecords.push({ section, id, slug: localeSlug, publishedDate, reasons: ['duplicate-section-slug'] });
      continue;
    }
    seenSlugs.add(slugKey);
    const metadata = sectionMeta(section, api.meta);
    const prefix = `blog.article.${id}.`;
    articles.push({
      id,
      section,
      kind: core.kind,
      slug: localeSlug,
      publishedDate,
      date: sourceDate,
      url: `${SITE_BASE}/${core.indexSlug.it}/${localeSlug}/`,
      title: typeof metadata?.[`${prefix}title`] === 'string' ? metadata[`${prefix}title`] : '',
      excerpt: typeof metadata?.[`${prefix}excerpt`] === 'string' ? metadata[`${prefix}excerpt`] : '',
      apiCommit: article.commit || null,
    });
  }
  return {
    articles,
    skippedRecords,
    duplicateSlugsBySection,
    indexRecordCount: rows.length,
    mappedRecordCount: articles.length,
    missingRecordCount: skippedRecords.length,
  };
}

export function summarizeM1IndexCoverage(api, normalized, from, to, sections = Object.keys(ARTICLE_SECTION_CORE_ALL)) {
  const rawRows = [
    ...api.national.map((article) => [article, 'frontaliere']),
    ...api.swiss.map((article) => [article, 'svizzera']),
    ...api.cantons.map((article) => [article, article.section]),
  ];
  const rowsInWindowBySection = Object.fromEntries(sections.map((section) => [section, 0]));
  let rowsWithUnknownSectionInWindow = 0;
  let rowsWithUnknownDate = 0;
  let rowsWithUnknownSection = 0;
  let rowsWithUnknownSectionAndDate = 0;
  const unknownDateRowsBySection = Object.fromEntries(sections.map((section) => [section, 0]));
  for (const [article, section] of rawRows) {
    const publishedDate = dateOnlyInZurich(article?.date ?? article?.datePublished);
    const sectionKnown = Object.hasOwn(rowsInWindowBySection, section);
    if (!sectionKnown) rowsWithUnknownSection += 1;
    if (!publishedDate) {
      rowsWithUnknownDate += 1;
      if (sectionKnown) unknownDateRowsBySection[section] += 1;
      else rowsWithUnknownSectionAndDate += 1;
      continue;
    }
    if (publishedDate < from || publishedDate > to) continue;
    if (sectionKnown) rowsInWindowBySection[section] += 1;
    else rowsWithUnknownSectionInWindow += 1;
  }
  const output = Object.fromEntries(sections.map((section) => {
    const mapped = normalized.articles.filter((article) => article.section === section
      && article.publishedDate >= from && article.publishedDate <= to);
    const skips = normalized.skippedRecords.filter((record) => record.section === section);
    const missingCandidates = skips.filter((record) => record.publishedDate >= from && record.publishedDate <= to
      && !record.reasons.includes('duplicate-section-slug'));
    const duplicateSlugs = skips.filter((record) => record.publishedDate >= from && record.publishedDate <= to
      && record.reasons.includes('duplicate-section-slug'));
    const unknownDateRecords = skips.filter((record) => !record.publishedDate).length;
    const skippedByReason = {};
    for (const record of [...missingCandidates, ...duplicateSlugs]) {
      for (const reason of record.reasons) skippedByReason[reason] = (skippedByReason[reason] || 0) + 1;
    }
    return [section, {
      apiRowsInWindow: rowsInWindowBySection[section],
      mappedDistinctCandidatesInWindow: mapped.length,
      missingCandidateMappingsInWindow: missingCandidates.length,
      duplicateSlugsCollapsedInWindow: duplicateSlugs.length,
      recordsWithUnknownDate: unknownDateRecords,
      skippedByReason,
      coverageComplete: missingCandidates.length === 0
        && (unknownDateRowsBySection[section] || unknownDateRecords) === 0
        && rowsWithUnknownSectionInWindow === 0
        && rowsWithUnknownSectionAndDate === 0,
    }];
  }));
  const unassignedSkippedCandidates = normalized.skippedRecords.filter((record) => record.section === 'unknown'
    && record.publishedDate >= from && record.publishedDate <= to).length;
  const unassignedUnknownDateSkippedCandidates = normalized.skippedRecords.filter((record) => record.section === 'unknown'
    && !record.publishedDate).length;
  if (unassignedSkippedCandidates > 0 || unassignedUnknownDateSkippedCandidates > 0 || rowsWithUnknownSectionInWindow > 0) {
    for (const section of sections) output[section].coverageComplete = false;
  }
  const coverageComplete = Object.values(output).every((section) => section.coverageComplete);
  return {
    coverageComplete,
    sections: output,
    rowsWithUnknownSectionInWindow,
    rowsWithUnknownDate,
    rowsWithUnknownSection,
    rowsWithUnknownSectionAndDate,
    unassignedSkippedCandidates,
    unassignedUnknownDateSkippedCandidates,
  };
}

export function buildM6ArticleRecords(api, cutoffDate, endDate) {
  const rows = [
    ...api.national.map((article) => [article, 'frontaliere']),
    ...api.swiss.map((article) => [article, 'svizzera']),
    ...api.cantons.map((article) => [article, article.section]),
  ];
  const articles = [];
  const skippedRecords = [];
  const unknownDateRecords = [];
  const dateUncertainArticles = [];
  const seenIds = new Set();
  const countsBySection = Object.fromEntries(Object.keys(ARTICLE_SECTION_CORE_ALL).map((section) => [section, 0]));
  for (const [article, section] of rows) {
    const id = typeof article?.id === 'string' && article.id.trim() ? article.id : null;
    const core = ARTICLE_SECTION_CORE_ALL[section];
    const indexDate = dateOnlyInZurich(article?.date) || dateOnlyInZurich(article?.datePublished);
    if (!indexDate) {
      const metadata = core ? sectionMeta(section, api.meta) : null;
      const prefix = id ? `blog.article.${id}.` : null;
      const title = prefix && typeof metadata?.[`${prefix}title`] === 'string' ? metadata[`${prefix}title`] : '';
      const excerpt = prefix && typeof metadata?.[`${prefix}excerpt`] === 'string' ? metadata[`${prefix}excerpt`] : '';
      const missing = [];
      if (!id) missing.push('id');
      if (!core) missing.push('section');
      if (!title.trim()) missing.push('title');
      if (!excerpt.trim()) missing.push('excerpt');
      unknownDateRecords.push({ section: core ? section : 'unknown', id, missing });
      if (missing.length === 0) {
        dateUncertainArticles.push({
          id,
          section,
          kind: core.kind,
          publishedDate: null,
          date: article.date ?? article.datePublished ?? null,
          title,
          excerpt,
          dateStatus: 'unknown_in_published_index',
        });
      }
      continue;
    }
    const publishedDate = indexDate;
    if (publishedDate < cutoffDate || publishedDate > endDate) continue;
    const missing = [];
    if (!id) missing.push('id');
    if (!core) missing.push('section');
    if (missing.length) {
      skippedRecords.push({ section: core ? section : 'unknown', id, publishedDate, reasons: missing });
      continue;
    }
    const key = `${section}:${id}`;
    if (seenIds.has(key)) {
      skippedRecords.push({ section, id, publishedDate, reasons: ['duplicate-section-id'] });
      continue;
    }
    seenIds.add(key);
    const metadata = sectionMeta(section, api.meta);
    const prefix = `blog.article.${id}.`;
    articles.push({
      id,
      section,
      kind: core.kind,
      publishedDate,
      date: article.date ?? article.datePublished,
      title: typeof metadata?.[`${prefix}title`] === 'string' ? metadata[`${prefix}title`] : '',
      excerpt: typeof metadata?.[`${prefix}excerpt`] === 'string' ? metadata[`${prefix}excerpt`] : '',
    });
    countsBySection[section] += 1;
  }
  const skippedByReason = {};
  for (const skipped of skippedRecords) {
    for (const reason of skipped.reasons) skippedByReason[reason] = (skippedByReason[reason] || 0) + 1;
  }
  return {
    articles,
    indexRowCount: rows.length,
    candidateRecordCount: articles.length + skippedRecords.length + unknownDateRecords.length,
    skippedRecords,
    skippedByReason,
    unknownDateRecords,
    dateUncertainArticles,
    countsBySection,
    upperBoundCoverageComplete: skippedRecords.length === 0
      && unknownDateRecords.length === dateUncertainArticles.length,
    coverageComplete: skippedRecords.length === 0 && unknownDateRecords.length === 0,
  };
}

function sha256Json(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function createM6InputSnapshot(corpus, manifestCommit, sectionArticleCounts, indexCoverage) {
  if (!/^[a-f0-9]{40}$/i.test(manifestCommit || '')) throw new Error('M6 snapshot requires a validated manifest commit');
  const sections = Object.keys(ARTICLE_SECTION_CORE_ALL).sort();
  const countMaps = [sectionArticleCounts, corpus.countsBySection];
  for (const counts of countMaps) {
    if (!counts || Object.keys(counts).sort().join('\0') !== sections.join('\0')
      || Object.values(counts).some((count) => !Number.isInteger(count) || count < 0)) {
      throw new Error('M6 snapshot requires complete nonnegative per-section counts');
    }
  }
  if (!Number.isInteger(corpus.indexRowCount) || corpus.indexRowCount < 0
    || !Number.isInteger(corpus.candidateRecordCount) || corpus.candidateRecordCount < 0
    || !Number.isInteger(indexCoverage.skippedCandidateRecords) || indexCoverage.skippedCandidateRecords < 0
    || !Number.isInteger(indexCoverage.recordsWithUnknownDate) || indexCoverage.recordsWithUnknownDate < 0) {
    throw new Error('M6 snapshot requires complete nonnegative index coverage counts');
  }
  const records = [...corpus.articles, ...corpus.dateUncertainArticles]
    .map((article) => ({
      id: article.id,
      section: article.section,
      kind: article.kind,
      publishedDate: article.publishedDate || null,
      dateStatus: article.dateStatus || 'known',
      title: article.title,
      excerpt: article.excerpt,
    }))
    .sort((left, right) => left.section.localeCompare(right.section) || left.id.localeCompare(right.id));
  const payload = {
    schemaVersion: 1,
    manifestCommit: manifestCommit.toLowerCase(),
    sectionArticleCounts,
    cutoffDate: indexCoverage.cutoffDate,
    untilDate: indexCoverage.untilDate,
    indexRows: corpus.indexRowCount,
    candidateRecords: corpus.candidateRecordCount,
    mappedCandidateRecords: records.length,
    skippedCandidateRecords: indexCoverage.skippedCandidateRecords,
    skippedByReason: indexCoverage.skippedByReason,
    recordsWithUnknownDate: indexCoverage.recordsWithUnknownDate,
    coverageComplete: corpus.coverageComplete,
    upperBoundCoverageComplete: corpus.upperBoundCoverageComplete,
    candidateCountsBySection: corpus.countsBySection,
    records,
  };
  return { ...payload, checksum: sha256Json(payload) };
}

export function verifyM6InputSnapshot(snapshot, endDate) {
  if (!snapshot || snapshot.schemaVersion !== 1 || !Array.isArray(snapshot.records)) {
    throw new Error('M6 input snapshot has an unsupported or incomplete schema');
  }
  const { checksum, ...payload } = snapshot;
  if (!/^[a-f0-9]{64}$/i.test(checksum || '') || sha256Json(payload) !== checksum) {
    throw new Error('M6 input snapshot checksum mismatch');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(endDate || '')
    || new Date(`${endDate}T00:00:00Z`).toISOString().slice(0, 10) !== endDate) {
    throw new Error('M6 input snapshot requires a valid end date');
  }
  const [year, month, day] = endDate.split('-').map(Number);
  const expectedCutoff = new Date(Date.UTC(year, month - 1, day - 89));
  const cutoffDate = expectedCutoff.toISOString().slice(0, 10);
  const expectedSections = Object.keys(ARTICLE_SECTION_CORE_ALL).sort();
  const manifestCounts = snapshot.sectionArticleCounts || {};
  const candidateCounts = snapshot.candidateCountsBySection || {};
  const hasExactSectionCounts = [manifestCounts, candidateCounts].every((counts) => (
    Object.keys(counts).sort().join('\0') === expectedSections.join('\0')
      && Object.values(counts).every((count) => Number.isInteger(count) && count >= 0)
  ));
  if (snapshot.untilDate !== endDate || snapshot.cutoffDate !== cutoffDate
    || !/^[a-f0-9]{40}$/i.test(snapshot.manifestCommit || '')
    || !Number.isInteger(snapshot.indexRows) || snapshot.indexRows < 0
    || !Number.isInteger(snapshot.candidateRecords) || snapshot.candidateRecords < 0
    || snapshot.mappedCandidateRecords !== snapshot.records.length
    || !Number.isInteger(snapshot.skippedCandidateRecords) || snapshot.skippedCandidateRecords < 0
    || !Number.isInteger(snapshot.recordsWithUnknownDate) || snapshot.recordsWithUnknownDate < 0
    || snapshot.candidateRecords !== snapshot.mappedCandidateRecords + snapshot.skippedCandidateRecords
    || typeof snapshot.coverageComplete !== 'boolean'
    || typeof snapshot.upperBoundCoverageComplete !== 'boolean'
    || !hasExactSectionCounts
    || !snapshot.skippedByReason || typeof snapshot.skippedByReason !== 'object' || Array.isArray(snapshot.skippedByReason)
    || Object.values(snapshot.skippedByReason).some((count) => !Number.isInteger(count) || count < 0)) {
    throw new Error('M6 input snapshot metadata does not match the requested window or counts');
  }
  const seen = new Set();
  const knownCandidatesBySection = Object.fromEntries(expectedSections.map((section) => [section, 0]));
  let includedUnknownDateRecords = 0;
  for (const record of snapshot.records) {
    if (!record || typeof record.id !== 'string' || !record.id.trim()
      || !ARTICLE_SECTION_CORE_ALL[record.section]
      || record.kind !== ARTICLE_SECTION_CORE_ALL[record.section].kind
      || typeof record.title !== 'string' || !record.title.trim()
      || typeof record.excerpt !== 'string' || !record.excerpt.trim()) {
      throw new Error('M6 input snapshot contains an incomplete candidate record');
    }
    const key = `${record.section}:${record.id}`;
    if (seen.has(key)) throw new Error(`M6 input snapshot contains duplicate candidate ${key}`);
    seen.add(key);
    if (record.dateStatus === 'unknown_in_published_index') {
      if (record.publishedDate !== null) throw new Error(`unknown-date candidate ${key} unexpectedly has a date`);
      includedUnknownDateRecords += 1;
    } else if (record.dateStatus === 'known') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(record.publishedDate || '')
        || new Date(`${record.publishedDate}T00:00:00Z`).toISOString().slice(0, 10) !== record.publishedDate
        || record.publishedDate < snapshot.cutoffDate || record.publishedDate > snapshot.untilDate) {
        throw new Error(`M6 input snapshot candidate ${key} is outside the requested date window`);
      }
      knownCandidatesBySection[record.section] += 1;
    } else throw new Error(`M6 input snapshot candidate ${key} has an unknown date status`);
  }
  if (includedUnknownDateRecords > snapshot.recordsWithUnknownDate
    || expectedSections.some((section) => candidateCounts[section] !== knownCandidatesBySection[section])
    || snapshot.indexRows < snapshot.candidateRecords
    || snapshot.coverageComplete !== (snapshot.skippedCandidateRecords === 0 && snapshot.recordsWithUnknownDate === 0)
    || snapshot.upperBoundCoverageComplete !== (snapshot.skippedCandidateRecords === 0
      && includedUnknownDateRecords === snapshot.recordsWithUnknownDate)) {
    throw new Error('M6 input snapshot candidate records do not match its coverage counts');
  }
  return snapshot;
}

export function countCorpusArticlesBySection(articles, sections = Object.keys(ARTICLE_SECTION_CORE_ALL)) {
  const counts = Object.fromEntries(sections.map((section) => [section, 0]));
  for (const article of articles) {
    if (!Object.hasOwn(counts, article.section)) throw new Error(`articolo mappato a sezione sconosciuta: ${article.section}`);
    counts[article.section] += 1;
  }
  return counts;
}

export function resolveThresholdCorpusSize({ storeCount, storeFileMissing, publishedIndexCount }) {
  if (Number.isInteger(storeCount) && storeCount >= 0) return { count: storeCount, source: 'production_embedding_store' };
  if (storeFileMissing && Number.isInteger(publishedIndexCount) && publishedIndexCount >= 0) {
    return { count: publishedIndexCount, source: 'reconstructed_complete_published_index' };
  }
  return { count: null, source: 'unavailable' };
}

function decodeHtmlAttribute(value) {
  return String(value).replace(/&amp;/g, '&').replace(/&#x2f;/gi, '/').replace(/&#47;/g, '/').trim();
}

export function extractCanonical(html) {
  for (const match of String(html).matchAll(/<link\b[^>]*>/gi)) {
    const tag = match[0];
    const rel = tag.match(/\brel\s*=\s*(["'])(.*?)\1/i)?.[2];
    const href = tag.match(/\bhref\s*=\s*(["'])(.*?)\1/i)?.[2];
    if (rel?.toLowerCase().split(/\s+/).includes('canonical') && href) return decodeHtmlAttribute(href);
  }
  return null;
}

function findDatePublished(value) {
  if (!value || typeof value !== 'object') return null;
  if (typeof value.datePublished === 'string') return value.datePublished;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const result = findDatePublished(entry);
      if (result) return result;
    }
    return null;
  }
  for (const child of Object.values(value)) {
    const result = findDatePublished(child);
    if (result) return result;
  }
  return null;
}

export function extractDatePublished(html) {
  for (const match of String(html).matchAll(/<script\b[^>]*type\s*=\s*(["'])application\/ld\+json\1[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const date = findDatePublished(JSON.parse(match[2]));
      if (date) return date;
    } catch {
      // Continue to the next structured-data block.
    }
  }
  return String(html).match(/"datePublished"\s*:\s*"([^"]+)"/i)?.[1] || null;
}

async function verifyArticlePage(article) {
  try {
    const { response, body } = await fetchTextWithRetry(article.url, {
      headers: { 'user-agent': PAGE_USER_AGENT, accept: 'text/html' },
    });
    const canonical = extractCanonical(body);
    const datePublished = extractDatePublished(body);
    const publishedDate = dateOnlyInZurich(datePublished);
    return {
      article,
      httpStatus: response.status,
      canonical,
      datePublished,
      publishedDate,
      verified: response.status === 200 && canonical === article.url && !!publishedDate,
      m1Verified: response.status === 200 && canonical === article.url && !!publishedDate,
      failure: response.status !== 200 ? `http-${response.status}`
        : canonical !== article.url ? 'canonical-mismatch'
          : !publishedDate ? 'missing-datePublished' : null,
      checkedAt: new Date().toISOString(),
    };
  } catch (error) {
    return {
      article,
      httpStatus: null,
      canonical: null,
      datePublished: null,
      publishedDate: null,
      verified: false,
      m1Verified: false,
      failure: `fetch-error:${error.name || 'Error'}`,
      checkedAt: new Date().toISOString(),
    };
  }
}

function percentileBySection(items, getSection, getValue) {
  const grouped = {};
  for (const item of items) {
    const section = getSection(item);
    const value = getValue(item);
    if (!section || !Number.isFinite(value)) continue;
    (grouped[section] ||= []).push(value);
  }
  return Object.fromEntries(Object.entries(grouped).map(([section, values]) => [section, percentiles(values)]));
}

async function runRows(workflow, window, { limit = 1000, status = null, liveOnly = false } = {}) {
  const args = ['run', 'list', '--workflow', workflow];
  if (status) args.push('--status', status);
  if (!liveOnly) args.push('--created', ghDateRange(window));
  args.push('--limit', String(limit), '--json', RUN_FIELDS);
  const rows = JSON.parse(await github(args));
  if (!Array.isArray(rows)) throw new Error(`run list ${workflow} non ha restituito un array`);
  return rows;
}

async function listWorkflowRuns(workflow, window, { limit = 1000, liveOnly = false } = {}) {
  const interval = (start, endExclusive) => {
    const part = { ...window, start, endExclusive };
    return runRows(workflow, part, { limit }).then(async (rows) => {
      if (rows.length < limit || endExclusive - start <= 60_000) return rows;
      const middle = new Date(Math.floor((start.getTime() + endExclusive.getTime()) / 2));
      middle.setUTCMilliseconds(0);
      const leftEnd = new Date(middle.getTime() - 1000);
      return [
        ...await interval(start, new Date(leftEnd.getTime() + 1000)),
        ...await interval(middle, endExclusive),
      ];
    });
  };
  let all;
  if (liveOnly) {
    const statuses = ['queued', 'in_progress', 'waiting', 'pending', 'requested'];
    const pages = await mapLimit(statuses, 2, async (status) => runRows(workflow, window, { limit, status, liveOnly: true }));
    all = pages.flat().filter((run) => ['queued', 'waiting', 'in_progress', 'pending', 'requested'].includes(String(run.status).toLowerCase()));
  } else {
    all = await interval(window.start, window.endExclusive);
  }
  const unique = new Map(all.map((run) => [`${run.databaseId}:${run.attempt || 1}`, run]));
  return [...unique.values()];
}

async function viewRun(run, withLogs) {
  const attemptArgs = Number.isInteger(run.attempt) && run.attempt > 0 ? ['--attempt', String(run.attempt)] : [];
  const json = JSON.parse(await github([
    'run', 'view', String(run.databaseId), ...attemptArgs, '--json', VIEW_FIELDS,
  ]));
  let logs = '';
  if (withLogs && !['queued', 'waiting', 'pending'].includes(String(json.status).toLowerCase())) {
    try {
      logs = await github(['run', 'view', String(run.databaseId), ...attemptArgs, '--log'], { maxBuffer: 96 * 1024 * 1024 });
    } catch (error) {
      // A log may expire or an active run may not have produced one yet.
      json.logReadError = error.code || 'unavailable';
    }
  }
  return { json, logs };
}

function generationWorkflowSpecs() {
  const slots = readJson('generator/data/canton-generation-slots.json').entries;
  return [
    { workflow: 'generate-article.yml', section: null, cronBySection: { frontaliere: '7 * * * *', svizzera: '37 * * * *' } },
    ...slots.map((entry) => ({ workflow: entry.workflow, section: entry.section, cron: entry.cron })),
  ];
}

export function sectionFromGeneration(spec, run, markers, logText, attempts = [], llmMetrics = [], dedupMarkers = [], jobs = []) {
  if (spec.section) return spec.section;
  const markerSection = [...markers].reverse().find((marker) => marker.section !== 'unknown')?.section;
  if (markerSection && ARTICLE_SECTION_CORE_ALL[markerSection]) return markerSection;
  const attemptSection = [...attempts].reverse().find((marker) => marker.section !== 'unknown')?.section;
  if (attemptSection && ARTICLE_SECTION_CORE_ALL[attemptSection]) return attemptSection;
  const llmSection = [...llmMetrics].reverse().find((marker) => marker.section !== 'unknown')?.section;
  if (llmSection && ARTICLE_SECTION_CORE_ALL[llmSection]) return llmSection;
  const dedupSection = [...dedupMarkers].reverse().find((marker) => marker.section !== 'unknown')?.section;
  if (dedupSection && ARTICLE_SECTION_CORE_ALL[dedupSection]) return dedupSection;
  const jobSection = jobs.map((job) => String(job.name || '').match(/^generate\s*\(([^)]+)\)$/i)?.[1])
    .find((section) => section && ARTICLE_SECTION_CORE_ALL[section]);
  if (jobSection) return jobSection;
  const eventSection = runtimeLogPayloads(logText).map((line) => line.match(/^event=[^\s]+[^\n]*?section=([a-z0-9-]+)/i)?.[1]).find(Boolean);
  if (eventSection && ARTICLE_SECTION_CORE_ALL[eventSection]) return eventSection;
  const slotSection = run.displayTitle?.match(/generation-slot\s+generate-article\/([^/]+)\//)?.[1];
  return slotSection && ARTICLE_SECTION_CORE_ALL[slotSection] ? slotSection : 'unknown';
}

export function generationJob(jobs = []) {
  return jobs.find((job) => {
    const nameParts = String(job?.name || '').split('/');
    const leafName = nameParts.at(-1)?.trim() || '';
    return /^generate production$/i.test(leafName);
  }) || null;
}

function initSectionMetrics(section, expectedSlots) {
  return {
    expectedSlots,
    runsCreated: 0,
    admitted: 0,
    admissionSkipped: {},
    outcomes: {},
    unresolvedRunOutcomes: 0,
    terminalRunsWithoutOutcome: 0,
    generateQueueWaitMinutes: [],
    currentGenerateQueueWaitMinutes: [],
    generateDurationMinutes: [],
    providerRequestsByStage: { selection: 0, generation: 0, factCheck: 0, translation: 0, unclassified: 0 },
    llmRunsWithCounters: 0,
    llmRunsWithoutCounters: 0,
    llmExpectedAttempts: 0,
    llmObservedAttempts: 0,
    llmMissingAttempts: 0,
    m4RunsWithReadableLogs: 0,
    m4RunsWithoutLogs: 0,
    pushFiveAttemptExhaustionCount: 0,
    m5EligibleRuns: 0,
    m5ReadableRuns: 0,
    m5RunsWithoutLogs: 0,
  };
}

function addCounter(target, source) {
  for (const key of Object.keys(target)) target[key] += Number(source?.[key] || 0);
}

function resolvedAdmissionSkip(outcome) {
  return !!outcome && (outcome.reason.startsWith('admit-') || outcome.reason === 'chain-hour-cap');
}

export function recordGenerationOutcome(bucket, outcome, runStatus) {
  const status = String(runStatus || '').toLowerCase();
  if (outcome) {
    bucket.outcomes[outcome.reason] = (bucket.outcomes[outcome.reason] || 0) + 1;
    if (resolvedAdmissionSkip(outcome)) {
      bucket.admissionSkipped[outcome.reason] = (bucket.admissionSkipped[outcome.reason] || 0) + 1;
    }
  } else if (['in_progress', 'queued', 'waiting'].includes(status)) {
    bucket.unresolvedRunOutcomes += 1;
  } else if (status === 'completed') {
    bucket.terminalRunsWithoutOutcome += 1;
    bucket.outcomes['unobservable-terminal'] = (bucket.outcomes['unobservable-terminal'] || 0) + 1;
  }
}

export function m4MetricsAvailability({ missingCounters, structuredMarkers, historicalWindow, missingLogs, unassignedRuns, observedRuns }) {
  if (missingCounters > 0) {
    return structuredMarkers === 0 && historicalWindow && missingLogs === 0
      ? 'unavailable_pre_instrumentation_historical_window'
      : 'partial_missing_generation_attempt_counters';
  }
  if (unassignedRuns > 0) return 'partial_unassigned_generation_runs';
  return observedRuns === 0 ? 'no_generation_attempts_in_window' : 'available';
}

export function hasCompleteM5Coverage({ missingLogs, unassignedStartedRuns }) {
  return missingLogs === 0 && unassignedStartedRuns === 0;
}

export function buildM6RuntimeLogCoverage(generationReport) {
  const evidence = generationReport?.generationEvidence || generationReport;
  const metrics = evidence?.metrics;
  const unassignedEligibleRuns = evidence?.unassigned?.m4EligibleRuns;
  if (!metrics || typeof metrics !== 'object' || !Number.isInteger(unassignedEligibleRuns) || unassignedEligibleRuns < 0) {
    throw new Error('generation report must include metrics and unassigned.m4EligibleRuns');
  }
  return Object.fromEntries(Object.keys(ARTICLE_SECTION_CORE_ALL).map((section) => {
    const metric = metrics[section];
    const expectedGenerationAttempts = metric?.llmExpectedAttempts;
    const readableRuns = metric?.m4RunsWithReadableLogs;
    const missingLogs = metric?.m4RunsWithoutLogs;
    const validCounts = [expectedGenerationAttempts, readableRuns, missingLogs]
      .every((count) => Number.isInteger(count) && count >= 0);
    return [section, {
      expectedGenerationAttempts: Number.isInteger(expectedGenerationAttempts) && expectedGenerationAttempts >= 0 ? expectedGenerationAttempts : 0,
      readableRuns: Number.isInteger(readableRuns) && readableRuns >= 0 ? readableRuns : 0,
      missingLogs: Number.isInteger(missingLogs) && missingLogs >= 0 ? missingLogs : 0,
      unassignedEligibleRuns,
      complete: validCounts && expectedGenerationAttempts > 0 && readableRuns > 0
        && missingLogs === 0 && unassignedEligibleRuns === 0,
    }];
  }));
}

function normalizedJobStatus(job) {
  return String(job?.status || '').toLowerCase();
}

export function generationJobWasAdmitted(job) {
  if (!job) return false;
  const status = normalizedJobStatus(job);
  const conclusion = String(job.conclusion || '').toLowerCase();
  if (['skipped', 'cancelled'].includes(conclusion) || ['skipped', 'cancelled'].includes(status)) return false;
  if (status === 'completed') return dateMs(job.startedAt) !== null;
  return generationJobIsQueued(job) || status === 'in_progress';
}

export function generationJobIsQueued(job) {
  return ['queued', 'waiting', 'pending'].includes(normalizedJobStatus(job));
}

export function currentGenerateQueueWaitMinutes(job, createdAt, now = Date.now()) {
  if (!Number.isFinite(createdAt) || !generationJobIsQueued(job)) return null;
  return Math.max(0, now - createdAt) / 60_000;
}

export async function collectGenerationMetrics(window, sections, { workflowNames = null } = {}) {
  const allSpecs = generationWorkflowSpecs();
  const uniqueWorkflowNames = workflowNames ? new Set(workflowNames) : null;
  const specs = workflowNames
    ? allSpecs.filter((spec) => workflowNames.includes(spec.workflow))
    : allSpecs;
  if (workflowNames && (specs.length !== uniqueWorkflowNames.size || workflowNames.length !== uniqueWorkflowNames.size)) {
    throw new Error('workflowNames contiene un workflow non riconosciuto o duplicato');
  }
  const specsWithRuns = await mapLimit(specs, 2, async (spec) => {
    const [runs, liveRuns] = await Promise.all([
      listWorkflowRuns(spec.workflow, window),
      listWorkflowRuns(spec.workflow, window, { liveOnly: true }),
    ]);
    const keyed = new Map();
    for (const run of runs) keyed.set(`${run.databaseId}:${run.attempt || 1}`, { run, inWindow: true });
    for (const run of liveRuns) {
      const key = `${run.databaseId}:${run.attempt || 1}`;
      if (!keyed.has(key)) keyed.set(key, { run, inWindow: false });
    }
    return { spec, entries: [...keyed.values()] };
  });
  const now = Date.now();
  const allWorkflowRuns = specsWithRuns.flatMap(({ spec, entries }) => entries.map((entry) => ({ spec, ...entry })));

  const metrics = Object.fromEntries(sections.map((section) => {
    const expected = section === 'frontaliere' ? countCronOccurrences('7 * * * *', window.start, window.endExclusive)
      : section === 'svizzera' ? countCronOccurrences('37 * * * *', window.start, window.endExclusive)
        : countCronOccurrences(specs.find((spec) => spec.section === section)?.cron || '', window.start, window.endExclusive);
    return [section, initSectionMetrics(section, expected)];
  }));
  const workflowCoverage = Object.fromEntries(specsWithRuns.map(({ spec, entries }) => {
    const expectedSlots = spec.section
      ? countCronOccurrences(spec.cron, window.start, window.endExclusive)
      : countCronOccurrences('7 * * * *', window.start, window.endExclusive)
        + countCronOccurrences('37 * * * *', window.start, window.endExclusive);
    return [spec.workflow, {
      section: spec.section,
      expectedSlots,
      listedRunsInWindow: entries.filter((entry) => entry.inWindow).length,
      liveRunsOutsideWindow: entries.filter((entry) => !entry.inWindow).length,
      assignedRunsInWindow: 0,
      assignedRunsBySection: {},
      unassignedRunsInWindow: 0,
      unassignedTerminalRunsWithoutOutcome: 0,
      unassignedOutcomeCounts: {},
      statuses: {},
      conclusions: {},
      unassignedSamples: [],
    }];
  }));
  const queueIntervals = [];
  let unknownRunCount = 0;
  let unknownTerminalRunsWithoutOutcome = 0;
  const unknownOutcomeCounts = {};
  const unscopedQueueWaitMinutes = [];
  const unscopedCurrentQueueWaitMinutes = [];
  let structuredMetricMarkerCount = 0;
  const dedupStoreMarkers = [];
  let unassignedM4EligibleRuns = 0;
  let unassignedM5StartedRuns = 0;
  let unassignedM5RunsWithoutLogs = 0;
  let unassignedM5Exhaustions = 0;
  const batchSize = 2;
  for (let offset = 0; offset < allWorkflowRuns.length; offset += batchSize) {
    const runBatch = allWorkflowRuns.slice(offset, offset + batchSize);
    const detailRows = await mapLimit(runBatch, batchSize, async ({ spec, run, inWindow }) => ({
      spec, run, inWindow, ...await viewRun(run, inWindow),
    }));
    for (const { spec, run, inWindow, json, logs } of detailRows) {
      const markers = parseGenerationMarkers(logs);
      const attempts = parseGenerationAttempts(logs);
      const llmMetrics = parseLlmMetricMarkers(logs);
      const dedupMarkers = parseDedupStoreMarkers(logs);
      dedupStoreMarkers.push(...dedupMarkers);
      structuredMetricMarkerCount += llmMetrics.length;
      const section = sectionFromGeneration(spec, run, markers, logs, attempts, llmMetrics, dedupMarkers, json.jobs);
      const outcome = [...markers].reverse().find((marker) => marker.section === section)
        || [...markers].reverse().find((marker) => marker.section === 'unknown')
        || null;
      const job = generationJob(json.jobs);
      const workflowBucket = workflowCoverage[spec.workflow];
      if (inWindow) {
        const runStatus = String(run.status || 'unknown').toLowerCase();
        const conclusion = String(run.conclusion || 'none').toLowerCase();
        workflowBucket.statuses[runStatus] = (workflowBucket.statuses[runStatus] || 0) + 1;
        workflowBucket.conclusions[conclusion] = (workflowBucket.conclusions[conclusion] || 0) + 1;
      }
      if (section === 'unknown' || !metrics[section]) {
        unknownRunCount += 1;
        if (inWindow) {
          workflowBucket.unassignedRunsInWindow += 1;
          if (outcome) {
            unknownOutcomeCounts[outcome.reason] = (unknownOutcomeCounts[outcome.reason] || 0) + 1;
            workflowBucket.unassignedOutcomeCounts[outcome.reason] = (workflowBucket.unassignedOutcomeCounts[outcome.reason] || 0) + 1;
          } else if (String(run.status).toLowerCase() === 'completed') {
            unknownTerminalRunsWithoutOutcome += 1;
            workflowBucket.unassignedTerminalRunsWithoutOutcome += 1;
          }
          if (workflowBucket.unassignedSamples.length < 4) {
            workflowBucket.unassignedSamples.push({
              displayTitle: run.displayTitle || null,
              event: run.event || null,
              status: run.status || null,
              conclusion: run.conclusion || null,
              createdAt: run.createdAt || null,
              generationJob: job ? {
                status: job.status || null,
                conclusion: job.conclusion || null,
                startedAt: job.startedAt || null,
              } : null,
              outcome: outcome ? { kind: outcome.kind, reason: outcome.reason, section: outcome.section } : null,
            });
          }
        }
        const admittedUnknown = generationJobWasAdmitted(job);
        const startedUnknown = dateMs(job?.startedAt) !== null;
        const createdAt = dateMs(run.createdAt);
        const startedAt = dateMs(job?.startedAt);
        const completedAt = dateMs(job?.completedAt);
        if (inWindow && createdAt !== null && startedAt !== null) {
          unscopedQueueWaitMinutes.push(Math.max(0, startedAt - createdAt) / 60_000);
          queueIntervals.push({
            start: startedAt,
            end: completedAt || (String(run.status).toLowerCase() === 'in_progress' ? now : startedAt),
            section: 'unknown',
          });
        } else {
          const currentQueueWait = currentGenerateQueueWaitMinutes(job, createdAt, now);
          if (currentQueueWait !== null) unscopedCurrentQueueWaitMinutes.push(currentQueueWait);
        }
        if (inWindow && (attempts.length > 0 || (admittedUnknown && startedUnknown))) unassignedM4EligibleRuns += 1;
        if (inWindow && admittedUnknown && startedUnknown) {
          unassignedM5StartedRuns += 1;
          if (json.logReadError) unassignedM5RunsWithoutLogs += 1;
          else unassignedM5Exhaustions += countPushFiveAttemptExhaustions(logs);
        }
        continue;
      }
      if (inWindow) {
        workflowBucket.assignedRunsInWindow += 1;
        workflowBucket.assignedRunsBySection[section] = (workflowBucket.assignedRunsBySection[section] || 0) + 1;
      }
      const bucket = metrics[section];
      if (inWindow) bucket.runsCreated += 1;
      const admitted = generationJobWasAdmitted(job);
      if (inWindow && admitted) bucket.admitted += 1;
      const resolvedOutcome = outcome
        ? { ...outcome, section: outcome.section === 'unknown' ? section : outcome.section }
        : null;
      if (inWindow) recordGenerationOutcome(bucket, resolvedOutcome, run.status);

      const sectionAttempts = attempts.filter((marker) => marker.section === section);
      const sectionMetrics = llmMetrics.filter((marker) => marker.section === section);
      const metricByAttempt = new Map(sectionMetrics.map((marker) => [marker.attempt, marker]));
      const needsLlmCoverage = inWindow && !resolvedAdmissionSkip(resolvedOutcome)
        && (sectionAttempts.length > 0 || (admitted && dateMs(job?.startedAt) !== null));
      if (needsLlmCoverage) {
        if (json.logReadError) bucket.m4RunsWithoutLogs += 1;
        else bucket.m4RunsWithReadableLogs += 1;
      }
      const expectedAttempts = sectionAttempts.length || (needsLlmCoverage && dateMs(job?.startedAt) !== null ? 1 : 0);
      let missingAttemptCount = 0;
      for (let index = 0; index < expectedAttempts; index += 1) {
        const attemptMarker = sectionAttempts[index];
        const metric = attemptMarker ? metricByAttempt.get(attemptMarker.attempt) : null;
        bucket.llmExpectedAttempts += 1;
        if (!metric) {
          missingAttemptCount += 1;
          bucket.llmMissingAttempts += 1;
          continue;
        }
        addCounter(bucket.providerRequestsByStage, metric.providerRequestsByStage);
        bucket.llmObservedAttempts += 1;
      }
      if (bucket.llmExpectedAttempts > 0 && missingAttemptCount === 0 && expectedAttempts > 0) bucket.llmRunsWithCounters += 1;
      else if (missingAttemptCount > 0 || (needsLlmCoverage && expectedAttempts === 0)) bucket.llmRunsWithoutCounters += 1;
      if (inWindow && admitted && dateMs(job?.startedAt) !== null) {
        bucket.m5EligibleRuns += 1;
        if (json.logReadError) bucket.m5RunsWithoutLogs += 1;
        else {
          bucket.m5ReadableRuns += 1;
          bucket.pushFiveAttemptExhaustionCount += countPushFiveAttemptExhaustions(logs);
        }
      }

      const createdAt = dateMs(run.createdAt);
      const startedAt = dateMs(job?.startedAt);
      const completedAt = dateMs(job?.completedAt);
      if (inWindow && createdAt !== null && startedAt !== null) {
        const queueWaitMs = Math.max(0, startedAt - createdAt);
        bucket.generateQueueWaitMinutes.push(queueWaitMs / 60_000);
        queueIntervals.push({ start: startedAt, end: completedAt || (String(run.status).toLowerCase() === 'in_progress' ? now : startedAt), section });
      } else {
        const currentQueueWait = currentGenerateQueueWaitMinutes(job, createdAt, now);
        if (currentQueueWait !== null) bucket.currentGenerateQueueWaitMinutes.push(currentQueueWait);
      }
      if (startedAt !== null && completedAt !== null) bucket.generateDurationMinutes.push(Math.max(0, completedAt - startedAt) / 60_000);
    }
  }
  for (const bucket of Object.values(metrics)) {
    bucket.generateQueueWait = percentiles(bucket.generateQueueWaitMinutes);
    bucket.generateDuration = percentiles(bucket.generateDurationMinutes);
    bucket.currentQueuedJobs = bucket.currentGenerateQueueWaitMinutes.length;
    bucket.oldestCurrentQueueWaitMinutes = bucket.currentGenerateQueueWaitMinutes.length
      ? Math.max(...bucket.currentGenerateQueueWaitMinutes) : null;
    delete bucket.generateQueueWaitMinutes;
    delete bucket.generateDurationMinutes;
    delete bucket.currentGenerateQueueWaitMinutes;
    bucket.m4Coverage = {
      expectedGenerationAttempts: bucket.llmExpectedAttempts,
      observedStructuredCounters: bucket.llmObservedAttempts,
      missingStructuredCounters: bucket.llmMissingAttempts,
      status: bucket.llmExpectedAttempts === 0 ? 'unavailable_pre_instrumentation_or_no_attempts'
        : bucket.llmMissingAttempts > 0 ? 'partial' : 'available',
      unassignedEligibleRuns: unassignedM4EligibleRuns,
    };
    bucket.m5LogCoverage = {
      eligibleStartedRuns: bucket.m5EligibleRuns,
      readableLogs: bucket.m5ReadableRuns,
      missingLogs: bucket.m5RunsWithoutLogs,
      unassignedStartedRuns: unassignedM5StartedRuns,
      unassignedMissingLogs: unassignedM5RunsWithoutLogs,
      unassignedExhaustions: unassignedM5Exhaustions,
      complete: hasCompleteM5Coverage({
        missingLogs: bucket.m5RunsWithoutLogs,
        unassignedStartedRuns: unassignedM5StartedRuns,
      }),
    };
  }
  return {
    metrics,
    workflowScope: {
      included: specs.map((spec) => spec.workflow),
      excluded: allSpecs.filter((spec) => !specs.includes(spec)).map((spec) => spec.workflow),
    },
    queueIntervals,
    detailCount: allWorkflowRuns.filter(({ inWindow }) => inWindow).length,
    unknownRunCount,
    unknownTerminalRunsWithoutOutcome,
    unknownOutcomeCounts,
    unscopedQueueWait: percentiles(unscopedQueueWaitMinutes),
    unscopedCurrentQueuedJobs: unscopedCurrentQueueWaitMinutes.length,
    unscopedOldestCurrentQueueWaitMinutes: unscopedCurrentQueueWaitMinutes.length
      ? Math.max(...unscopedCurrentQueueWaitMinutes) : null,
    workflowCoverage,
    structuredMetricMarkerCount,
    unassignedM4EligibleRuns,
    unassignedM5StartedRuns,
    unassignedM5RunsWithoutLogs,
    unassignedM5Exhaustions,
    dedupStoreMarkerCount: dedupStoreMarkers.length,
    dedupRuntimeEvidenceBySection: summarizeDedupRuntimeEvidence(dedupStoreMarkers, sections),
  };
}

function parseArticleAdditions(window) {
  const args = [
    'log', 'origin/main', '--first-parent', '--diff-filter=A',
    `--since=${window.start.toISOString()}`, `--until=${new Date(window.endExclusive.getTime() - 1).toISOString()}`,
    '--format=%H%x09%ct', '--name-only', '--', 'content/blog-body-*/it/*.ts',
  ];
  const output = shellFreeGit(args);
  const coreByBodyDir = new Map(Object.values(ARTICLE_SECTION_CORE_ALL).map((entry) => [entry.bodyDir, entry.section]));
  const additions = [];
  let current = null;
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const header = line.match(/^([0-9a-f]{40})\t(\d+)$/);
    if (header) {
      current = { commit: header[1], commitAt: Number(header[2]) * 1000 };
      continue;
    }
    const match = line.match(/^content\/([^/]+)\/it\/([^/]+)\.ts$/);
    if (!match || !current) continue;
    const section = coreByBodyDir.get(match[1]);
    if (!section) continue;
    additions.push({ ...current, section, id: match[2], path: line });
  }
  const unique = new Map(additions.map((entry) => [`${entry.commit}:${entry.section}:${entry.id}`, entry]));
  return [...unique.values()];
}

export function countPushFiveAttemptExhaustions(logText) {
  return runtimeLogPayloads(logText).filter((line) => /^(?:::error::|##\[error\])push failed after 5 attempts\b/i.test(line)
    || /^Error:\s*push failed after 5 attempts\b/i.test(line)).length;
}

function parseMainCommits(window) {
  const output = shellFreeGit([
    'log', 'origin/main', '--first-parent', `--since=${window.start.toISOString()}`,
    `--until=${new Date(window.endExclusive.getTime() - 1).toISOString()}`, '--format=%H%x09%P%x09%ct', '--name-only',
  ]);
  const commits = [];
  let current = null;
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const header = line.match(/^([0-9a-f]{40})\t([0-9a-f ]*)\t(\d+)$/);
    if (header) {
      current = {
        sha: header[1],
        parent: header[2].trim().split(/\s+/u)[0] || null,
        commitAt: Number(header[3]) * 1000,
        changedPaths: [],
      };
      commits.push(current);
    } else if (current) current.changedPaths.push(line.trim());
  }
  return commits;
}

function sectionFromPublishTitle(run) {
  const value = String(run.displayTitle || '').match(/^cover-publish-section\s*\/\s*([^/]+)\s*\//i)?.[1]?.trim();
  return value && ARTICLE_SECTION_CORE_ALL[value] ? value : 'unknown';
}

/**
 * Map live per-section concurrency jobs to their sections.
 *
 * Count every live matrix job regardless of whether it is waiting on a
 * dependency or a section concurrency group. Resolve and API-coordinator jobs
 * have no section assignment; an explicit workflow_dispatch target is used
 * when no live matrix job exists yet, while automatic runs remain unscoped.
 */
export function publishSectionsFromJobs(jobs = [], { liveOnly = false } = {}) {
  if (!Array.isArray(jobs)) return [];
  // Explicit stage/finalize names are `stage (canton-ti)`. Also accept the
  // actual default Actions matrix spelling from older runs, e.g.
  // `publish (canton-ow, false, false, false)`, where the section is first.
  const sectionForJob = (job) => String(job?.name || '')
    .match(/^(?:publish|stage|finalize)\s*\(([^,)]+)(?:,[^)]*)?\)$/i)?.[1]?.trim();
  const knownSections = jobs.map(sectionForJob)
    .filter((section) => section && ARTICLE_SECTION_CORE_ALL[section]);
  if (!liveOnly) return [...new Set(knownSections)].sort();

  const liveStatuses = new Set(['queued', 'in_progress', 'waiting', 'pending', 'requested']);
  const activeSections = jobs
    .filter((job) => liveStatuses.has(String(job?.status || '').toLowerCase()))
    .map(sectionForJob)
    .filter((section) => section && ARTICLE_SECTION_CORE_ALL[section]);
  return [...new Set(activeSections)].sort();
}

/** Keep target attribution conservative when the jobs endpoint cannot be read. */
export function publishLiveSectionsFromRun(run, { jobs = [], jobsReadable = true } = {}) {
  if (jobsReadable) {
    const matrixSections = publishSectionsFromJobs(jobs, { liveOnly: true });
    if (matrixSections.length > 0) return matrixSections;
  }
  const titledSection = sectionFromPublishTitle(run);
  return titledSection === 'unknown' ? [] : [titledSection];
}

/** Count section-held runs and preserve barrier/resolve runs as unscoped. */
export function countPublishLiveAssignments(liveRuns = [], sections = []) {
  const bySection = Object.fromEntries(sections.map((section) => [section, 0]));
  let unscoped = 0;
  for (const run of liveRuns) {
    const targets = Array.isArray(run?.sections) ? run.sections : [];
    if (targets.length === 0) {
      unscoped += 1;
      continue;
    }
    for (const section of targets) {
      if (bySection[section] !== undefined) bySection[section] += 1;
    }
  }
  return { bySection, unscoped };
}

export function commitTouchedSections(
  changedPaths,
  activeSections = Object.keys(ARTICLE_SECTION_CORE_ALL),
  { before, after } = {},
) {
  const activeCore = ARTICLE_SECTION_CORE_LIST.filter((entry) => activeSections.includes(entry.section));
  const rangeSensitive = changedPaths.some((changedPath) => (
    changedPath === 'sections/registry.json'
      || changedPath === 'content/article-index-exclusions.json'
      || changedPath.startsWith('public/images/')
  ));
  if (rangeSensitive && (!before || !after)) {
    throw new Error('M3 richiede il range before..after per registry, exclusions e immagini');
  }
  // The workflow resolves every push through this same R2 planner. Keep the
  // range-aware path for commits whose ownership depends on before/after and
  // fail closed when a caller omits that range.
  const r2Targets = (before && after
    ? r2PublishPlanForRange(before, after, activeCore)
    : r2PublishPlan(changedPaths, activeCore)).map((target) => target.section);
  return [...new Set(r2Targets)].sort();
}

async function resolvePublishLiveSections(run) {
  try {
    const { json } = await viewRun(run, false);
    return publishLiveSectionsFromRun(run, { jobs: json.jobs || [] });
  } catch {
    // Without a live matrix target, preserve an explicit workflow_dispatch
    // target conservatively; auto-titled push runs stay unscoped.
    return publishLiveSectionsFromRun(run, { jobsReadable: false });
  }
}

function intervalMaximum(intervals) {
  const events = [];
  for (const interval of intervals) {
    if (!Number.isFinite(interval.start) || !Number.isFinite(interval.end) || interval.end <= interval.start) continue;
    events.push([interval.start, 1], [interval.end, -1]);
  }
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let active = 0;
  let max = 0;
  for (const [, delta] of events) {
    active += delta;
    max = Math.max(max, active);
  }
  return max;
}

export function nearDuplicateThresholdForPair(left, right, thresholdsBySection) {
  if (left.section === right.section) return thresholdsBySection[left.section];
  return Math.min(thresholdsBySection[left.section], thresholdsBySection[right.section]);
}

export function m6ZeroIsDateIndependent({
  candidateWindowComplete,
  upperBoundCoverageComplete,
  upperBoundPairCount,
  activeSections,
  sectionStoreStatus,
}) {
  if (candidateWindowComplete) return false;
  if (!upperBoundCoverageComplete || upperBoundPairCount !== 0 || activeSections.length === 0) return false;
  return activeSections.every((section) => {
    const status = sectionStoreStatus[section];
    return status?.latestGateStatus === 'active_verified'
      && status?.windowGateStatus === 'active_verified_in_observed_markers'
      && status?.runtimeLogCoverage?.complete === true
      && status?.thresholdSource === 'runtime_observed_min_verified_effective_threshold';
  });
}

export function m6MetricIsAvailable({
  candidateWindowComplete,
  dateIndependentZero,
  productionGateUnmeasuredSections,
}) {
  return dateIndependentZero
    || (candidateWindowComplete && productionGateUnmeasuredSections.length === 0);
}

async function collectPublishMetrics(window, sections, articleRecords, pageResults) {
  const [runs, liveRuns] = await Promise.all([
    listWorkflowRuns('fast-publish-section.yml', window),
    listWorkflowRuns('fast-publish-section.yml', window, { liveOnly: true }),
  ]);
  const mappedRuns = runs.map((run) => ({ ...run, section: sectionFromPublishTitle(run) }));
  const resolvedLiveRuns = await mapLimit(liveRuns, 4, async (run) => ({ ...run, sections: await resolvePublishLiveSections(run) }));
  const liveAssignment = countPublishLiveAssignments(resolvedLiveRuns, sections);

  const mainCommits = parseMainCommits(window);
  const commitsBySha = Object.fromEntries(mainCommits.map((commit) => [commit.sha, {
    ...commit,
    touchedSections: commitTouchedSections(commit.changedPaths, sections, {
      before: commit.parent,
      after: commit.sha,
    }),
    publishRuns: 0,
    noopRuns: 0,
    noopRunDurationsMinutes: [],
  }]));
  const runsByCommitAndSection = {};
  for (const run of mappedRuns) {
    const commit = commitsBySha[run.headSha];
    if (commit && isNoopFastPublishRun(run, commit)) {
      commit.noopRuns += 1;
      const durationMinutes = publishRunDurationMinutes(run);
      if (durationMinutes !== null) commit.noopRunDurationsMinutes.push(durationMinutes);
    } else if (commit) {
      commit.publishRuns += 1;
    }
    if (commit && run.section !== 'unknown') {
      const key = `${run.headSha}:${run.section}`;
      runsByCommitAndSection[key] = (runsByCommitAndSection[key] || 0) + 1;
    }
  }

  const additions = parseArticleAdditions(window);
  const recordByKey = new Map(articleRecords.map((article) => [`${article.section}:${article.id}`, article]));
  const pageByKey = new Map(pageResults.map((page) => [`${page.article.section}:${page.article.id}`, page]));
  const publishLatencies = [];
  const contentCommitRunCounts = Object.fromEntries(sections.map((section) => [section, new Map()]));
  const observedPageLatencies = [];
  let verifiedContentCommits = 0;
  let missingPublishedPages = 0;

  for (const addition of additions) {
    const record = recordByKey.get(`${addition.section}:${addition.id}`);
    if (!record) {
      missingPublishedPages += 1;
      continue;
    }
    const page = pageByKey.get(`${addition.section}:${addition.id}`);
    if (!page?.verified) {
      missingPublishedPages += 1;
      continue;
    }
    verifiedContentCommits += 1;
    contentCommitRunCounts[addition.section]?.set(
      addition.commit,
      runsByCommitAndSection[`${addition.commit}:${addition.section}`] || 0,
    );
    const observedAt = dateMs(page.checkedAt);
    if (observedAt !== null && observedAt >= addition.commitAt) {
      observedPageLatencies.push({ section: addition.section, minutes: (observedAt - addition.commitAt) / 60_000, observedAt: page.checkedAt });
    }
    const matching = mappedRuns
      .filter((run) => run.section === addition.section
        && run.conclusion === 'success'
        && dateMs(run.createdAt) !== null
        && dateMs(run.createdAt) >= addition.commitAt)
      .sort((a, b) => dateMs(a.updatedAt) - dateMs(b.updatedAt));
    const publishRun = matching.find((run) => {
      if (!run.headSha) return false;
      try {
        shellFreeGit(['merge-base', '--is-ancestor', addition.commit, run.headSha], { stdio: 'ignore' });
        return true;
      } catch {
        return false;
      }
    });
    const doneAt = publishRun ? dateMs(publishRun.updatedAt) : null;
    if (doneAt !== null && doneAt >= addition.commitAt) {
      publishLatencies.push({ section: addition.section, minutes: (doneAt - addition.commitAt) / 60_000 });
    }
  }

  const metrics = Object.fromEntries(sections.map((section) => {
    const sectionRuns = mappedRuns.filter((run) => run.section === section);
    const runsWithPage = publishLatencies.filter((latency) => latency.section === section).map((latency) => latency.minutes);
    const observedRunsWithPage = observedPageLatencies.filter((latency) => latency.section === section).map((latency) => latency.minutes);
    return [section, {
      fastPublishRunsCreated: sectionRuns.length,
      liveRuns: liveAssignment.bySection[section],
      articleCommitRunFanout: percentiles([...(contentCommitRunCounts[section]?.values() || [])]),
      commitToVerifiedPageObservationMinutes: percentiles(observedRunsWithPage),
      commitToSuccessfulPublishRunCompletionProxyMinutes: percentiles(runsWithPage),
    }];
  }));

  const commitFanoutRows = Object.values(commitsBySha).map((commit) => ({
    sha: commit.sha,
    touchedSections: commit.touchedSections,
    publishRuns: commit.publishRuns,
    noopRuns: commit.noopRuns,
    noopRunDurationsMinutes: percentiles(commit.noopRunDurationsMinutes),
    violation: commit.publishRuns > commit.touchedSections.length,
  }));
  const commitFanout = commitFanoutRows.map((commit) => commit.publishRuns);
  const noopRunDurations = Object.values(commitsBySha)
    .flatMap((commit) => commit.noopRunDurationsMinutes.filter(Number.isFinite));
  const allLatencyValues = publishLatencies.map((latency) => latency.minutes);
  const allObservationValues = observedPageLatencies.map((latency) => latency.minutes);
  const violatedCommits = commitFanoutRows.filter((commit) => commit.violation);
  const noopRunViolations = commitFanoutRows.filter((commit) => commit.noopRuns > 1);
  return {
    metrics,
    runCount: runs.length,
    liveRunsCount: resolvedLiveRuns.length,
    liveUnscopedRuns: liveAssignment.unscoped,
    noopRuns: commitFanoutRows.reduce((total, commit) => total + commit.noopRuns, 0),
    noopRunDurationsMinutes: percentiles(noopRunDurations),
    noopRunViolations: noopRunViolations.length,
    commitRunFanout: percentiles(commitFanout),
    commitRunFanoutWithRuns: commitFanout.filter((count) => count > 0).length,
    commitRunFanoutViolations: violatedCommits.length,
    commitRunFanoutByCommit: commitFanoutRows,
    mainCommitCount: mainCommits.length,
    verifiedContentCommits,
    contentCommitsMissingPage: missingPublishedPages,
    commitToObservedPage200Minutes: percentiles(allObservationValues),
    commitToSuccessfulPublishRunCompletionProxyMinutes: percentiles(allLatencyValues),
    pageObservationProvenance: {
      source: 'direct HTTP verification of the public article URL during this report run',
      observedAt: pageResults.length ? pageResults.reduce((latest, page) => page.checkedAt > latest ? page.checkedAt : latest, '') : null,
      limitation: 'single observation time is an upper-bound proxy, not the historical first-HTTP-200 instant',
    },
    latencyMethod: 'commit-to-page200-observation is an upper bound from the commit timestamp to the report-run HTTP check; commit-to-successful-publish-run-completion is separately labeled proxy',
  };
}

async function collectNearDuplicates(articles, endDate, {
  indexCoverageComplete = true,
  upperBoundCoverageComplete = indexCoverageComplete,
  dateUncertainArticles = [],
  unmappedIndexRecords = 0,
  indexCoverage = null,
  sectionCorpusCounts = {},
  manifestSectionCounts = {},
  runtimeDedupEvidenceBySection = {},
  runtimeLogCoverageBySection = {},
} = {}) {
  const [year, month, day] = endDate.split('-').map(Number);
  const cutoffDate = new Date(Date.UTC(year, month - 1, day - 89)).toISOString().slice(0, 10);
  const recent = articles.filter((article) => article.publishedDate >= cutoffDate && article.publishedDate <= endDate);
  const conservativeCandidates = [...recent, ...dateUncertainArticles];
  if (!upperBoundCoverageComplete) {
    return {
      available: false,
      conservativeUpperBoundAvailable: false,
      reason: 'one or more unresolved candidate records have no complete ID, section, title or excerpt; even a conservative M6 upper bound would be incomplete',
      cutoffDate,
      untilDate: endDate,
      indexedArticles: recent.length + dateUncertainArticles.length,
      embeddedArticles: 0,
      unmappedIndexRecords,
      indexCoverage,
    };
  }
  const withText = conservativeCandidates.filter((article) => article.title.trim() && article.excerpt.trim());
  const missingMetadata = conservativeCandidates.length - withText.length;
  const sectionStores = {};
  const sectionThresholds = {};
  const sectionStoreCounts = {};
  const sectionThresholdSources = {};
  const sectionThresholdCountSources = {};
  const sectionStoreStatus = {};
  const unavailableStoreSections = [];
  const activeSections = [...new Set(withText.map((article) => article.section))];
  if (missingMetadata > 0) {
    return {
      available: false,
      conservativeUpperBoundAvailable: false,
      reason: 'title/excerpt metadata incomplete for part of the 90-day index; no zero-result inference allowed',
      cutoffDate,
      untilDate: endDate,
      indexedArticles: conservativeCandidates.length,
      embeddedArticles: 0,
      missingMetadata,
      indexCoverage,
      missingMetadataBySection: Object.fromEntries(Object.keys(ARTICLE_SECTION_CORE_ALL).map((section) => [
        section,
        recent.filter((article) => article.section === section && (!article.title.trim() || !article.excerpt.trim())).length,
      ]).filter(([, count]) => count > 0)),
      thresholdCoverage: { sectionsAvailable: 0, sectionsExpected: activeSections.length },
    };
  }
  if (withText.length === 0) {
    return {
      available: true,
      conservativeUpperBoundAvailable: true,
      candidateWindowComplete: indexCoverageComplete,
      productionGateMeasured: false,
      productionGateUnmeasuredSections: [],
      activeGateRuntimeStatus: 'no articles with text in the inclusive 90-day candidate window; no runtime gate claim is made',
      reason: null,
      cutoffDate,
      untilDate: endDate,
      indexedArticles: conservativeCandidates.length,
      embeddedArticles: 0,
      missingMetadata: 0,
      comparedPairs: 0,
      sectionStoreCounts,
      thresholdsBySection: sectionThresholds,
      thresholdRule: 'no indexed articles in the inclusive 90-day window, so no pair can cross the production threshold',
      thresholdSource: 'not needed for an empty candidate set',
      nearDuplicatePairCount: 0,
      conservativeUpperBoundNearDuplicatePairCount: 0,
      knownDateLowerBoundPairCount: 0,
      pairsCappedAt: 200,
      sameSectionPairsBySection: Object.fromEntries(Object.keys(ARTICLE_SECTION_CORE_ALL).map((section) => [section, 0])),
      crossCantonPairsBySectionInvolved: Object.fromEntries(Object.keys(ARTICLE_SECTION_CORE_ALL).map((section) => [section, 0])),
      thresholdCoverage: { sectionsMeasured: 0, sectionsExpected: 0 },
      pairs: [],
    };
  }
  for (const section of activeSections) {
    const relativePath = section === 'frontaliere' ? 'data/article-embeddings.bin'
      : section === 'svizzera' ? 'data/swiss-article-embeddings.bin'
        : cantonSectionPaths(section).embeddingsBinPath;
    const publishedIndexCount = sectionCorpusCounts[section];
    if (publishedIndexCount !== manifestSectionCounts[section]) {
      unavailableStoreSections.push({ section, path: relativePath, reason: 'mapped article count differs from validated manifest count' });
      sectionStoreStatus[section] = { path: relativePath, status: 'index-count-mismatch' };
      continue;
    }
    const runtime = runtimeDedupEvidenceBySection[section] || {
      observationCount: 0,
      failOpenObservations: 0,
      statusCounts: {},
      latestGateStatus: 'unobserved',
      windowGateStatus: 'unobserved',
      latest: null,
    };
    const runtimeLogCoverage = runtimeLogCoverageBySection[section] || {
      expectedGenerationAttempts: 0,
      readableRuns: 0,
      missingLogs: 0,
      unassignedEligibleRuns: 0,
      complete: false,
    };
    const latest = runtime.latest;
    const observedPolicyThreshold = Number.isFinite(latest?.policyThreshold) ? latest.policyThreshold : null;
    const reconstructedPolicyThreshold = computePolicyThresholdFromParameters(publishedIndexCount, latest?.policyParameters)
      ?? computeAdaptiveNearDupCosine(publishedIndexCount);
    const runtimeEffectiveThreshold = Number.isFinite(runtime.minimumVerifiedEffectiveThreshold)
      ? runtime.minimumVerifiedEffectiveThreshold : null;
    const threshold = runtimeEffectiveThreshold
      ?? observedPolicyThreshold
      ?? reconstructedPolicyThreshold;
    const thresholdSource = runtimeEffectiveThreshold !== null
      ? 'runtime_observed_min_verified_effective_threshold'
      : observedPolicyThreshold !== null
        ? 'runtime_observed_policy_threshold_gate_fail_open'
        : latest?.policyParameters
          ? 'runtime_policy_parameters_with_manifest_count_reconstruction'
          : 'local_policy_with_manifest_count_reconstruction_runtime_unobserved';
    const thresholdCorpusCount = Number.isInteger(runtime.minimumVerifiedStoreCount)
      ? runtime.minimumVerifiedStoreCount
      : Number.isInteger(latest?.storeCount) ? latest.storeCount : publishedIndexCount;
    sectionStores[section] = true;
    sectionStoreCounts[section] = thresholdCorpusCount;
    sectionThresholds[section] = threshold;
    sectionThresholdSources[section] = thresholdSource;
    sectionThresholdCountSources[section] = Number.isInteger(latest?.storeCount)
      ? 'runtime_observed_store_count'
      : 'manifest_matched_public_index_count_not_runtime_proof';
    sectionStoreStatus[section] = {
      path: relativePath,
      latestGateStatus: runtime.latestGateStatus,
      windowGateStatus: runtime.windowGateStatus,
      observationCount: runtime.observationCount,
      failOpenObservations: runtime.failOpenObservations,
      statusCounts: runtime.statusCounts,
      runtimeLogCoverage,
      runtimeStorePresent: latest?.storePresent ?? null,
      runtimeStoreCount: latest?.storeCount ?? null,
      runtimeStoreDimension: latest?.storeDimension ?? null,
      runtimeMetaModel: latest?.metaModel ?? null,
      runtimeQueryModel: latest?.queryModel ?? null,
      runtimeExpectedModel: latest?.expectedModel ?? null,
      runtimeEffectiveThreshold,
      runtimeMinimumVerifiedEffectiveThreshold: runtime.minimumVerifiedEffectiveThreshold ?? null,
      verifiedThresholdObservationCount: runtime.verifiedThresholdObservationCount ?? 0,
      verifiedThresholdsStable: runtime.verifiedThresholdsStable ?? false,
      runtimePolicyThreshold: observedPolicyThreshold,
      runtimePolicyParameters: latest?.policyParameters ?? null,
      publishedIndexCount,
      runtimeStoreCountMatchesPublishedIndex: Number.isInteger(latest?.storeCount)
        ? latest.storeCount === publishedIndexCount : null,
      reconstructedPolicyThreshold,
      thresholdUsedForPairMetric: threshold,
      thresholdSource,
    };
  }
  if (unavailableStoreSections.length > 0) {
    return {
      available: false,
      conservativeUpperBoundAvailable: false,
      reason: 'could not reproduce the section threshold corpus size from a readable binary or complete manifest-matched index',
      cutoffDate,
      untilDate: endDate,
      indexedArticles: conservativeCandidates.length,
      embeddedArticles: 0,
      unavailableStoreSections,
      thresholdCoverage: { sectionsMeasured: Object.keys(sectionStores).length, sectionsExpected: activeSections.length },
    };
  }

  const { embedBatch, lastUsedEmbeddingModel } = await import('../../generator/scripts/lib/evidence/embeddingClient.mjs');
  const vectors = [];
  for (let i = 0; i < withText.length; i += 16) {
    const batch = withText.slice(i, i + 16);
    vectors.push(...await embedBatch({ inputs: batch.map((article) => buildDedupText(article.title, article.excerpt)) }));
  }
  const dimensions = new Set(vectors.map((vector) => vector?.length));
  if (vectors.length !== withText.length || vectors.some((vector) => !(vector instanceof Float32Array)) || dimensions.size !== 1) {
    return {
      available: false,
      reason: 'embedding coverage/dimensions do not match the complete 90-day article set',
      cutoffDate,
      untilDate: endDate,
      indexedArticles: conservativeCandidates.length,
      embeddedArticles: vectors.length,
      expectedEmbeddingCount: withText.length,
      embeddingDimensions: [...dimensions],
      sectionStoreStatus,
      thresholdCoverage: { sectionsMeasured: Object.keys(sectionStores).length, sectionsExpected: activeSections.length },
    };
  }

  const pairsBySection = Object.fromEntries(Object.keys(ARTICLE_SECTION_CORE_ALL).map((section) => [section, 0]));
  const crossCantonBySection = Object.fromEntries(Object.keys(ARTICLE_SECTION_CORE_ALL).map((section) => [section, 0]));
  const knownDatePairsBySection = Object.fromEntries(Object.keys(ARTICLE_SECTION_CORE_ALL).map((section) => [section, 0]));
  const knownDateCrossCantonBySection = Object.fromEntries(Object.keys(ARTICLE_SECTION_CORE_ALL).map((section) => [section, 0]));
  const nearDuplicatePairs = [];
  let nearDuplicatePairCount = 0;
  let knownDatePairCount = 0;
  let eligiblePairs = 0;
  for (let i = 0; i < withText.length; i += 1) {
    for (let j = i + 1; j < withText.length; j += 1) {
      const left = withText[i];
      const right = withText[j];
      const sameSection = left.section === right.section;
      const crossCanton = left.kind === 'canton' && right.kind === 'canton' && left.section !== right.section;
      if (!sameSection && !crossCanton) continue;
      const threshold = nearDuplicateThresholdForPair(left, right, sectionThresholds);
      eligiblePairs += 1;
      const cosine = cosineSimilarity(vectors[i], vectors[j]);
      if (cosine < threshold) continue;
      nearDuplicatePairCount += 1;
      const bothDatesKnown = left.dateStatus !== 'unknown_in_published_index'
        && right.dateStatus !== 'unknown_in_published_index';
      if (bothDatesKnown) knownDatePairCount += 1;
      if (sameSection) pairsBySection[left.section] += 1;
      else {
        crossCantonBySection[left.section] += 1;
        crossCantonBySection[right.section] += 1;
      }
      if (bothDatesKnown && sameSection) knownDatePairsBySection[left.section] += 1;
      else if (bothDatesKnown) {
        knownDateCrossCantonBySection[left.section] += 1;
        knownDateCrossCantonBySection[right.section] += 1;
      }
      if (nearDuplicatePairs.length < 200) {
        nearDuplicatePairs.push({
          left: { section: left.section, id: left.id, date: left.publishedDate, dateStatus: left.dateStatus || 'known' },
          right: { section: right.section, id: right.id, date: right.publishedDate, dateStatus: right.dateStatus || 'known' },
          cosine: Number(cosine.toFixed(6)),
          threshold,
          thresholdBySection: { [left.section]: sectionThresholds[left.section], [right.section]: sectionThresholds[right.section] },
        });
      }
    }
  }
  const productionGateUnmeasuredSections = activeSections.filter((section) => (
    sectionStoreStatus[section]?.latestGateStatus !== 'active_verified'
    || sectionStoreStatus[section]?.windowGateStatus !== 'active_verified_in_observed_markers'
    || sectionStoreStatus[section]?.runtimeLogCoverage?.complete !== true
  ));
  const dateIndependentZero = m6ZeroIsDateIndependent({
    candidateWindowComplete: indexCoverageComplete,
    upperBoundCoverageComplete,
    upperBoundPairCount: nearDuplicatePairCount,
    activeSections,
    sectionStoreStatus,
  });
  const productionGateMeasured = productionGateUnmeasuredSections.length === 0;
  const exactMetricAvailable = m6MetricIsAvailable({
    candidateWindowComplete: indexCoverageComplete,
    dateIndependentZero,
    productionGateUnmeasuredSections,
  });
  return {
    available: exactMetricAvailable,
    conservativeUpperBoundAvailable: productionGateMeasured,
    policyThresholdProxyAvailable: true,
    candidateWindowComplete: indexCoverageComplete,
    dateIndependentZero,
    reason: exactMetricAvailable ? null : productionGateMeasured
      ? 'date-unknown candidates were included; the pair count is an upper bound, not an exact 90-day count'
      : 'runtime store and effective-threshold evidence is incomplete; only the explicitly labeled policy-threshold proxy is available',
    productionGateMeasured: productionGateMeasured && activeSections.length > 0,
    productionGateUnmeasuredSections,
    model: lastUsedEmbeddingModel(),
    expectedModel: EMBEDDING_MODEL,
    expectedDimension: EMBEDDING_DIM,
    indexCoverage,
    cutoffDate,
    untilDate: endDate,
    indexedArticles: conservativeCandidates.length,
    embeddedArticles: withText.length,
    missingMetadata: 0,
    comparedPairs: eligiblePairs,
    sectionStoreCounts,
    thresholdsBySection: sectionThresholds,
    thresholdCorpusCountSourceBySection: sectionThresholdSources,
    thresholdCountSourceBySection: sectionThresholdCountSources,
    sectionStoreStatus,
    thresholdRule: 'same-section uses the minimum verified runtime effective threshold across the measurement window; when runtime evidence is unavailable the reported policy-threshold proxy uses an explicitly labeled threshold reconstructed from the public index count and policy parameters. Cross-canton unordered pairs use min(left threshold, right threshold), equivalent to exceedance in either direction.',
    thresholdSource: 'runtime markers report store.count, model compatibility and effective threshold; when unavailable, policy threshold is reconstructed from the validated public index count and runtime policy parameters when present',
    productionStoreAvailability: Object.values(sectionStoreStatus).every((entry) => entry.latestGateStatus === 'active_verified')
      ? 'all active sections have a runtime observation with the exact model and dimension, plus complete eligible-run log coverage'
      : 'runtime evidence is incomplete or records a fail-open; local files and public binary URLs are not treated as proof of the production store',
    activeGateRuntimeStatus: Object.values(sectionStoreStatus).some((entry) => entry.windowGateStatus === 'fail_open_observed_in_window')
      ? 'a fail-open outcome was observed in the measurement window; M6 also reports the intended policy threshold separately'
      : Object.values(sectionStoreStatus).every((entry) => entry.latestGateStatus === 'active_verified')
        ? 'runtime active status and effective thresholds were observed for every section in the candidate corpus'
        : 'runtime active status is unobserved or not fully model-verified for one or more sections',
    nearDuplicatePairCount: exactMetricAvailable ? nearDuplicatePairCount : null,
    conservativeUpperBoundNearDuplicatePairCount: productionGateMeasured ? nearDuplicatePairCount : null,
    policyThresholdProxyPairCount: nearDuplicatePairCount,
    knownDateLowerBoundPairCount: knownDatePairCount,
    pairsCappedAt: 200,
    sameSectionPairsBySection: pairsBySection,
    crossCantonPairsBySectionInvolved: crossCantonBySection,
    knownDateSameSectionPairsBySection: knownDatePairsBySection,
    knownDateCrossCantonPairsBySectionInvolved: knownDateCrossCantonBySection,
    thresholdCoverage: { sectionsMeasured: Object.keys(sectionStores).length, sectionsExpected: activeSections.length },
    pairs: nearDuplicatePairs,
  };
}

export async function collectM6Supplement(endDate, {
  api: apiOverride = null,
  candidateSnapshot = null,
  runtimeDedupEvidenceBySection = {},
  runtimeLogCoverageBySection = {},
} = {}) {
  const api = candidateSnapshot ? null : (apiOverride || await readPublishedApi());
  const [year, month, day] = endDate.split('-').map(Number);
  const cutoffDate = new Date(Date.UTC(year, month - 1, day - 89)).toISOString().slice(0, 10);
  let corpus;
  let indexCoverage;
  let source;
  if (candidateSnapshot) {
    const snapshot = verifyM6InputSnapshot(candidateSnapshot, endDate);
    corpus = {
      articles: snapshot.records.filter((record) => record.dateStatus === 'known'),
      dateUncertainArticles: snapshot.records.filter((record) => record.dateStatus === 'unknown_in_published_index'),
      indexRowCount: snapshot.indexRows,
      candidateRecordCount: snapshot.candidateRecords,
      skippedCandidateRecords: snapshot.skippedCandidateRecords,
      skippedByReason: snapshot.skippedByReason,
      unknownDateRecordCount: snapshot.recordsWithUnknownDate,
      countsBySection: snapshot.candidateCountsBySection,
      upperBoundCoverageComplete: snapshot.upperBoundCoverageComplete,
      coverageComplete: snapshot.coverageComplete,
      sectionArticleCounts: snapshot.sectionArticleCounts,
    };
    indexCoverage = {
      cutoffDate: snapshot.cutoffDate,
      untilDate: snapshot.untilDate,
      indexRows: snapshot.indexRows,
      candidateRecords: snapshot.candidateRecords,
      mappedCandidateRecords: snapshot.mappedCandidateRecords,
      skippedCandidateRecords: snapshot.skippedCandidateRecords,
      skippedByReason: snapshot.skippedByReason,
      recordsWithUnknownDate: snapshot.recordsWithUnknownDate,
      dateUnknownCandidatesIncludedInUpperBound: corpus.dateUncertainArticles.map(({ section, id }) => ({ section, id })),
      upperBoundComplete: snapshot.upperBoundCoverageComplete,
      candidateCountsBySection: snapshot.candidateCountsBySection,
      complete: snapshot.coverageComplete,
    };
    source = {
      manifestCommit: snapshot.manifestCommit,
      sectionArticleCounts: snapshot.sectionArticleCounts,
      indexRows: snapshot.indexRows,
      m6InputSnapshotChecksum: snapshot.checksum,
    };
  } else {
    corpus = buildM6ArticleRecords(api, cutoffDate, endDate);
    indexCoverage = {
      cutoffDate,
      untilDate: endDate,
      indexRows: corpus.indexRowCount,
      candidateRecords: corpus.candidateRecordCount,
      mappedCandidateRecords: corpus.articles.length + corpus.dateUncertainArticles.length,
      skippedCandidateRecords: corpus.skippedRecords.length
        + corpus.unknownDateRecords.length - corpus.dateUncertainArticles.length,
      skippedByReason: corpus.skippedByReason,
      recordsWithUnknownDate: corpus.unknownDateRecords.length,
      dateUnknownCandidatesIncludedInUpperBound: corpus.dateUncertainArticles.map(({ section, id }) => ({ section, id })),
      upperBoundComplete: corpus.upperBoundCoverageComplete,
      candidateCountsBySection: corpus.countsBySection,
      complete: corpus.coverageComplete,
    };
    source = {
      manifestCommit: api.manifest.commit,
      manifestGeneratedAt: api.manifest.generatedAt,
      sectionArticleCounts: api.sectionArticleCounts,
      indexRows: corpus.indexRowCount,
    };
  }
  const dateUncertainArticles = corpus.dateUncertainArticles;
  const unmappedIndexRecords = indexCoverage.skippedCandidateRecords + corpus.unknownDateRecordCount;
  let metric;
  try {
    metric = await collectNearDuplicates(corpus.articles, endDate, {
      indexCoverageComplete: corpus.coverageComplete,
      upperBoundCoverageComplete: corpus.upperBoundCoverageComplete,
      dateUncertainArticles,
      unmappedIndexRecords,
      indexCoverage,
      sectionCorpusCounts: corpus.sectionArticleCounts || api.sectionArticleCounts,
      manifestSectionCounts: corpus.sectionArticleCounts || api.sectionArticleCounts,
      runtimeDedupEvidenceBySection,
      runtimeLogCoverageBySection,
    });
  } catch (error) {
    metric = {
      available: false,
      conservativeUpperBoundAvailable: false,
      reason: `local embedding unavailable: ${error.code || error.name || 'Error'}`,
      cutoffDate,
      untilDate: endDate,
      indexedArticles: corpus.articles.length + dateUncertainArticles.length,
      embeddedArticles: 0,
      unmappedIndexRecords,
      indexCoverage,
      embeddingFailureCode: error.code || error.name || 'Error',
    };
  }
  return {
    source,
    metric,
  };
}

function pilotSections() {
  const profile = readJson('generator/data/canton-sections.json');
  return profile.cantons
    .map((section) => {
      const sources = Array.isArray(section.newsSources) ? section.newsSources : [];
      const items7d = sources.reduce((sum, source) => sum + (Number.isFinite(source.items7d) ? source.items7d : 0), 0);
      return {
        section: `canton-${String(section.code).toLowerCase()}`,
        items7d,
        sources: sources.length,
        sourcesMissingItems7d: sources.filter((source) => !Number.isFinite(source.items7d)).length,
      };
    })
    .sort((a, b) => b.items7d - a.items7d || a.section.localeCompare(b.section))
    .slice(0, 3);
}

function sweptMaxConcurrency(intervals) {
  return intervalMaximum(intervals.map(({ start, end }) => ({ start, end })));
}

function topFailures(pages) {
  const byReason = {};
  for (const page of pages) {
    if (page.m1Verified) continue;
    const reason = page.failure || 'unknown';
    byReason[reason] = (byReason[reason] || 0) + 1;
  }
  return byReason;
}

export function aggregateM1BySection(sections, candidates, pageResults, from, to, missingCandidates = []) {
  const days = [];
  for (let cursor = from; cursor <= to; cursor = nextDate(cursor)) days.push(cursor);
  const m1BySection = Object.fromEntries(sections.map((section) => [section, {
    indexedCandidates: 0,
    verifiedArticles: 0,
    unverifiedCandidates: 0,
    byZurichDate: Object.fromEntries(days.map((date) => [date, { indexedCandidates: 0, verifiedArticles: 0, unverifiedCandidates: 0 }])),
  }]));
  const pageByKey = new Map(pageResults.map((page) => [`${page.article.section}:${page.article.id}`, page]));
  for (const candidate of candidates) {
    const row = m1BySection[candidate.section];
    const indexedDay = row?.byZurichDate[candidate.publishedDate];
    if (!indexedDay) continue;
    row.indexedCandidates += 1;
    indexedDay.indexedCandidates += 1;
    const page = pageByKey.get(`${candidate.section}:${candidate.id}`);
    const actualDay = page?.m1Verified && page.publishedDate >= from && page.publishedDate <= to
      ? row.byZurichDate[page.publishedDate]
      : null;
    if (actualDay) {
      actualDay.verifiedArticles += 1;
      row.verifiedArticles += 1;
      if (page.publishedDate !== candidate.publishedDate) {
        indexedDay.unverifiedCandidates += 1;
        row.unverifiedCandidates += 1;
      }
    } else {
      indexedDay.unverifiedCandidates += 1;
      row.unverifiedCandidates += 1;
    }
  }
  for (const candidate of missingCandidates) {
    const row = m1BySection[candidate.section];
    const indexedDay = row?.byZurichDate[candidate.publishedDate];
    if (!indexedDay) continue;
    row.indexedCandidates += 1;
    row.unverifiedCandidates += 1;
    indexedDay.indexedCandidates += 1;
    indexedDay.unverifiedCandidates += 1;
  }
  return m1BySection;
}

async function collectBaseline(args) {
  const window = makeDateWindow(args.from, args.to);
  const sections = Object.keys(ARTICLE_SECTION_CORE_ALL);
  const api = await readPublishedApi();
  const normalized = buildArticleRecords(api);
  const m1IndexCoverage = summarizeM1IndexCoverage(api, normalized, args.from, args.to, sections);
  const articleAdditions = parseArticleAdditions(window);
  const recordByKey = new Map(normalized.articles.map((article) => [`${article.section}:${article.id}`, article]));
  const m1Candidates = normalized.articles.filter((article) => article.publishedDate >= args.from && article.publishedDate <= args.to);
  const m1MissingCandidates = normalized.skippedRecords.filter((record) => record.section !== 'unknown'
    && record.publishedDate >= args.from && record.publishedDate <= args.to
    && !record.reasons.includes('duplicate-section-slug'));
  const verificationRecords = new Map();
  for (const article of m1Candidates) verificationRecords.set(`${article.section}:${article.id}`, article);
  for (const addition of articleAdditions) {
    const article = recordByKey.get(`${addition.section}:${addition.id}`);
    if (article) verificationRecords.set(`${article.section}:${article.id}`, article);
  }
  const pageResults = await mapLimit([...verificationRecords.values()], 8, verifyArticlePage);
  const pageByKey = new Map(pageResults.map((page) => [`${page.article.section}:${page.article.id}`, page]));
  const m1BySection = aggregateM1BySection(sections, m1Candidates, pageResults, args.from, args.to, m1MissingCandidates);
  const skippedBySection = {};
  let skippedUnknownSection = 0;
  for (const skipped of normalized.skippedRecords) {
    if (!ARTICLE_SECTION_CORE_ALL[skipped.section]) skippedUnknownSection += 1;
    else skippedBySection[skipped.section] = (skippedBySection[skipped.section] || 0) + 1;
  }
  const generation = await collectGenerationMetrics(window, sections);
  const publish = await collectPublishMetrics(window, sections, normalized.articles, pageResults);
  const [m6Year, m6Month, m6Day] = args.to.split('-').map(Number);
  const m6CutoffDate = new Date(Date.UTC(m6Year, m6Month - 1, m6Day - 89)).toISOString().slice(0, 10);
  const m6Corpus = buildM6ArticleRecords(api, m6CutoffDate, args.to);
  const m6CandidateIndexCoverage = {
    cutoffDate: m6CutoffDate,
    untilDate: args.to,
    indexRows: m6Corpus.indexRowCount,
    candidateRecords: m6Corpus.candidateRecordCount,
    mappedCandidateRecords: m6Corpus.articles.length + m6Corpus.dateUncertainArticles.length,
    skippedCandidateRecords: m6Corpus.skippedRecords.length
      + m6Corpus.unknownDateRecords.length - m6Corpus.dateUncertainArticles.length,
    skippedByReason: m6Corpus.skippedByReason,
    recordsWithUnknownDate: m6Corpus.unknownDateRecords.length,
    dateUnknownCandidatesIncludedInUpperBound: m6Corpus.dateUncertainArticles.map(({ section, id }) => ({ section, id })),
    upperBoundComplete: m6Corpus.upperBoundCoverageComplete,
    candidateCountsBySection: m6Corpus.countsBySection,
    complete: m6Corpus.coverageComplete,
  };
  const m6InputSnapshot = createM6InputSnapshot(
    m6Corpus,
    api.manifest.commit,
    api.sectionArticleCounts,
    m6CandidateIndexCoverage,
  );
  const m6RuntimeLogCoverageBySection = Object.fromEntries(sections.map((section) => {
    const metrics = generation.metrics[section];
    return [section, {
      expectedGenerationAttempts: metrics.llmExpectedAttempts,
      readableRuns: metrics.m4RunsWithReadableLogs,
      missingLogs: metrics.m4RunsWithoutLogs,
      unassignedEligibleRuns: generation.unassignedM4EligibleRuns,
      complete: metrics.llmExpectedAttempts > 0
        && metrics.m4RunsWithoutLogs === 0
        && generation.unassignedM4EligibleRuns === 0,
    }];
  }));
  let duplicates;
  try {
    duplicates = await collectNearDuplicates(m6Corpus.articles, args.to, {
      indexCoverageComplete: m6Corpus.coverageComplete,
      upperBoundCoverageComplete: m6Corpus.upperBoundCoverageComplete,
      dateUncertainArticles: m6Corpus.dateUncertainArticles,
      unmappedIndexRecords: m6CandidateIndexCoverage.skippedCandidateRecords + m6Corpus.dateUncertainArticles.length,
      indexCoverage: m6CandidateIndexCoverage,
      sectionCorpusCounts: api.sectionArticleCounts,
      manifestSectionCounts: api.sectionArticleCounts,
      runtimeDedupEvidenceBySection: generation.dedupRuntimeEvidenceBySection,
      runtimeLogCoverageBySection: m6RuntimeLogCoverageBySection,
    });
  } catch (error) {
    const [year, month, day] = args.to.split('-').map(Number);
    duplicates = {
      available: false,
      reason: `local embedding unavailable: ${error.name || 'Error'}`,
      cutoffDate: new Date(Date.UTC(year, month - 1, day - 89)).toISOString().slice(0, 10),
      untilDate: args.to,
      indexedArticles: null,
      embeddedArticles: null,
      indexCoverage: m6CandidateIndexCoverage,
    };
  }
  const historicalWindow = args.to < formatDatePartsInZurich(new Date());
  for (const section of sections) {
    const sectionDuplicates = duplicates.available || duplicates.conservativeUpperBoundAvailable
      ? (duplicates.sameSectionPairsBySection[section] || 0) + (duplicates.crossCantonPairsBySectionInvolved[section] || 0)
      : null;
    const sectionM4 = generation.metrics[section];
    sectionM4.llmMetricsAvailability = m4MetricsAvailability({
      missingCounters: sectionM4.llmRunsWithoutCounters,
      structuredMarkers: generation.structuredMetricMarkerCount,
      historicalWindow,
      missingLogs: sectionM4.m4RunsWithoutLogs,
      unassignedRuns: generation.unassignedM4EligibleRuns,
      observedRuns: sectionM4.llmRunsWithCounters,
    });
    sectionM4.publishedArticlesInWindow = m1BySection[section].verifiedArticles;
    sectionM4.callsPerVerifiedArticleByStage = sectionM4.llmMetricsAvailability === 'available' && sectionM4.publishedArticlesInWindow > 0
      ? Object.fromEntries(Object.entries(sectionM4.providerRequestsByStage).map(([stage, count]) => [stage, Number((count / sectionM4.publishedArticlesInWindow).toFixed(3))]))
      : null;
    sectionM4.m6NearDuplicatePairs = sectionDuplicates;
  }

  const capacity = {
    accountActionsJobLimit: null,
    accountActionsJobLimitSource: 'not readable through the configured GitHub coordinator identity',
    observedMaxConcurrentGenerateJobs: sweptMaxConcurrency(generation.queueIntervals),
    generationWorkflowsSampled: generation.detailCount,
    generationWorkflowCoverage: generation.workflowCoverage,
    currentQueuedGenerateJobs: Object.values(generation.metrics).reduce((sum, item) => sum + item.currentQueuedJobs, 0)
      + generation.unscopedCurrentQueuedJobs,
    unscopedGenerationRuns: generation.unknownRunCount,
    unscopedTerminalRunsWithoutOutcome: generation.unknownTerminalRunsWithoutOutcome,
    unscopedGenerationOutcomeCounts: generation.unknownOutcomeCounts,
    unscopedGenerateQueueWait: generation.unscopedQueueWait,
    oldestUnscopedCurrentGenerateQueueWaitMinutes: generation.unscopedOldestCurrentQueueWaitMinutes,
    oldestCurrentGenerateQueueWaitMinutes: Math.max(generation.unscopedOldestCurrentQueueWaitMinutes || 0, ...Object.values(generation.metrics).map((item) => item.oldestCurrentQueueWaitMinutes || 0)),
    maximumObservedGenerateQueueWaitMinutes: Math.max(generation.unscopedQueueWait.max || 0, ...Object.values(generation.metrics).map((item) => item.generateQueueWait.max || 0)),
    configuredCantonGlobalAdmissionLimit: 8,
    configuredFastPublishMatrixMaxParallel: 4,
  };

  const sectionsReport = Object.fromEntries(sections.map((section) => {
    const {
      providerRequestsByStage,
      llmRunsWithCounters,
      llmRunsWithoutCounters,
      llmExpectedAttempts,
      llmObservedAttempts,
      llmMissingAttempts,
      m4RunsWithReadableLogs,
      m4RunsWithoutLogs,
      llmMetricsAvailability,
      publishedArticlesInWindow,
      callsPerVerifiedArticleByStage,
      m6NearDuplicatePairs,
      pushFiveAttemptExhaustionCount,
      m5EligibleRuns,
      m5ReadableRuns,
      m5RunsWithoutLogs,
      m5LogCoverage,
      m4Coverage,
      ...m2Metrics
    } = generation.metrics[section];
    const indexRowsMissing = skippedBySection[section] || 0;
    return [section, {
    M1: {
      ...m1BySection[section],
      indexCoverage: {
        ...m1IndexCoverage.sections[section],
        skippedMappingsForSection: indexRowsMissing,
        coverageComplete: m1IndexCoverage.sections[section].coverageComplete,
        skippedUnknownSectionRecords: skippedUnknownSection,
        duplicateSlugRecordsSkipped: normalized.duplicateSlugsBySection[section] || 0,
      },
    },
    M2: m2Metrics,
    M3: publish.metrics[section],
    M4: {
      available: llmMetricsAvailability === 'available',
      availability: llmMetricsAvailability,
      unavailabilityReason: llmMetricsAvailability === 'unavailable_pre_instrumentation_historical_window'
        ? 'historical workflow logs predate merged request instrumentation; no zero is imputed and the post-merge window must be measured separately'
        : null,
      providerRequestsByStage: llmMetricsAvailability === 'available' ? providerRequestsByStage : null,
      observedProviderRequestsByStage: providerRequestsByStage,
      coverage: {
        expectedAttempts: llmExpectedAttempts,
        observedCounters: llmObservedAttempts,
        missingCounters: llmMissingAttempts,
        readableLogs: m4RunsWithReadableLogs,
        missingLogs: m4RunsWithoutLogs,
        unassignedEligibleRuns: m4Coverage.unassignedEligibleRuns,
      },
      runsWithCounters: llmRunsWithCounters,
      runsWithoutCounters: llmRunsWithoutCounters,
      verifiedPublishedArticles: publishedArticlesInWindow,
      callsPerVerifiedArticleByStage,
    },
    M5: {
      available: m5LogCoverage.complete,
      pushFiveAttemptExhaustions: m5LogCoverage.complete ? pushFiveAttemptExhaustionCount : null,
      observedCountFromReadableLogs: pushFiveAttemptExhaustionCount,
      logCoverage: {
        eligibleStartedRuns: m5EligibleRuns,
        readableLogs: m5ReadableRuns,
        missingLogs: m5RunsWithoutLogs,
        unassignedStartedRuns: m5LogCoverage.unassignedStartedRuns,
        unassignedMissingLogs: m5LogCoverage.unassignedMissingLogs,
        unassignedExhaustions: m5LogCoverage.unassignedExhaustions,
      },
    },
      M6: {
        available: duplicates.available,
        reason: duplicates.available ? null : duplicates.reason,
        nearDuplicatePairs: duplicates.available ? sectionDuplicatesForReport(duplicates, section).exact : null,
        conservativeUpperBoundAvailable: duplicates.conservativeUpperBoundAvailable ?? false,
        conservativeUpperBoundNearDuplicatePairs: duplicates.conservativeUpperBoundAvailable
          ? sectionDuplicatesForReport(duplicates, section).conservativeUpperBound : null,
        knownDateLowerBoundNearDuplicatePairs: duplicates.conservativeUpperBoundAvailable
          ? sectionDuplicatesForReport(duplicates, section).knownDateLowerBound : null,
        threshold: duplicates.conservativeUpperBoundAvailable ? duplicates.thresholdsBySection?.[section] ?? null : null,
        thresholdRule: duplicates.conservativeUpperBoundAvailable ? duplicates.thresholdRule : null,
        thresholdSource: duplicates.conservativeUpperBoundAvailable ? duplicates.thresholdCorpusCountSourceBySection?.[section] ?? null : null,
        thresholdCountSource: duplicates.conservativeUpperBoundAvailable ? duplicates.thresholdCountSourceBySection?.[section] ?? null : null,
        storeStatus: duplicates.conservativeUpperBoundAvailable ? duplicates.sectionStoreStatus?.[section] ?? null : null,
        runtimeEvidence: generation.dedupRuntimeEvidenceBySection?.[section] ?? null,
        effectiveThresholdObserved: duplicates.sectionStoreStatus?.[section]?.runtimeEffectiveThreshold
        ?? generation.dedupRuntimeEvidenceBySection?.[section]?.latest?.effectiveThreshold ?? null,
      policyThresholdObserved: duplicates.sectionStoreStatus?.[section]?.runtimePolicyThreshold
        ?? generation.dedupRuntimeEvidenceBySection?.[section]?.latest?.policyThreshold ?? null,
      reconstructedPolicyThreshold: duplicates.sectionStoreStatus?.[section]?.reconstructedPolicyThreshold ?? null,
        productionGateMeasured: duplicates.available
          && duplicates.sectionStoreStatus?.[section]?.latestGateStatus === 'active_verified'
          && duplicates.sectionStoreStatus?.[section]?.windowGateStatus === 'active_verified_in_observed_markers'
          && duplicates.sectionStoreStatus?.[section]?.runtimeLogCoverage?.complete === true,
        productionGateStatus: duplicates.sectionStoreStatus?.[section]?.latestGateStatus
          ?? generation.dedupRuntimeEvidenceBySection?.[section]?.latestGateStatus ?? 'unobserved',
      productionGateLogCoverage: duplicates.sectionStoreStatus?.[section]?.runtimeLogCoverage
        ?? m6RuntimeLogCoverageBySection[section],
    },
  }];
  }));

  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    timeZone: TIME_ZONE,
    window: {
      fromDateInclusive: args.from,
      toDateInclusive: args.to,
      startUtc: window.start.toISOString(),
      endExclusiveUtc: window.endExclusive.toISOString(),
      hours: (window.endExclusive.getTime() - window.start.getTime()) / 3_600_000,
    },
    source: {
      repository: GH_REPO,
      manifestCommit: api.manifest.commit,
      manifestGeneratedAt: api.manifest.generatedAt,
      sectionArticleCounts: api.sectionArticleCounts,
      indexSource: API_BASE,
      indexRecords: normalized.indexRecordCount,
      indexMappingsSkipped: normalized.missingRecordCount,
      duplicateSlugRecordsSkippedBySection: normalized.duplicateSlugsBySection,
      indexMappingCoverageComplete: normalized.missingRecordCount === 0,
      indexMappingSkipsBySection: skippedBySection,
      indexMappingSkipsUnknownSection: skippedUnknownSection,
      m1CandidateIndexCoverage: {
        from: args.from,
        to: args.to,
        rowsWithUnknownSectionInWindow: m1IndexCoverage.rowsWithUnknownSectionInWindow,
        rowsWithUnknownDate: m1IndexCoverage.rowsWithUnknownDate,
        rowsWithUnknownSection: m1IndexCoverage.rowsWithUnknownSection,
        rowsWithUnknownSectionAndDate: m1IndexCoverage.rowsWithUnknownSectionAndDate,
        unassignedSkippedCandidates: m1IndexCoverage.unassignedSkippedCandidates,
        unassignedUnknownDateSkippedCandidates: m1IndexCoverage.unassignedUnknownDateSkippedCandidates,
        coverageComplete: m1IndexCoverage.coverageComplete,
        sections: m1IndexCoverage.sections,
      },
      m6CandidateIndexCoverage: {
        ...m6CandidateIndexCoverage,
      },
      m6InputSnapshotChecksum: m6InputSnapshot.checksum,
      m6DedupRuntimeLogCoverage: m6RuntimeLogCoverageBySection,
      pageVerificationFailures: topFailures(pageResults),
    },
    pilots: pilotSections(),
    actionsCapacity: capacity,
    M3Summary: {
      fastPublishRunsCreated: publish.runCount,
      liveFastPublishRuns: publish.liveRunsCount,
      liveUnscopedFastPublishRuns: publish.liveUnscopedRuns,
      liveRunAttribution: 'Per-section liveRuns count every live publish/stage/finalize matrix job, including queued or pending jobs behind workflow dependencies or section concurrency. An explicit workflow_dispatch section from the run title is used when the Jobs API is unavailable or has no live matrix target (for example, while resolve runs); auto-titled runs without a target remain in liveFastPublishRuns and liveUnscopedFastPublishRuns.',
      noopRuns: publish.noopRuns,
      noopRunDurationsMinutes: publish.noopRunDurationsMinutes,
      noopRunViolations: publish.noopRunViolations,
      maxRunsPerMainCommit: publish.commitRunFanout.max,
      commitRunFanout: publish.commitRunFanout,
      mainCommitsInWindow: publish.mainCommitCount,
      mainCommitsWithFastPublishRuns: publish.commitRunFanoutWithRuns,
      contentCommitsVerified: publish.verifiedContentCommits,
      contentCommitsMissingPage: publish.contentCommitsMissingPage,
      commitRunFanoutViolations: publish.commitRunFanoutViolations,
      commitRunFanoutByCommit: publish.commitRunFanoutByCommit,
      commitToObservedPage200Minutes: publish.commitToObservedPage200Minutes,
      commitToSuccessfulPublishRunCompletionProxyMinutes: publish.commitToSuccessfulPublishRunCompletionProxyMinutes,
      pageObservationProvenance: publish.pageObservationProvenance,
      historicalFirstHttp200LatencyAvailable: false,
      firstHttp200GateRequiresPostChangeObservation: true,
      latencyMethod: publish.latencyMethod,
    },
    M6Summary: duplicates,
    m6InputSnapshot,
    generationEvidence: {
      workflowScope: generation.workflowScope,
      workflowCoverage: generation.workflowCoverage,
      metrics: generation.metrics,
      unassigned: {
        runsInWindow: Object.values(generation.workflowCoverage).reduce((sum, workflow) => sum + workflow.unassignedRunsInWindow, 0),
        runCountIncludingLiveOutsideWindow: generation.unknownRunCount,
        terminalRunsWithoutOutcome: generation.unknownTerminalRunsWithoutOutcome,
        outcomeCounts: generation.unknownOutcomeCounts,
        m4EligibleRuns: generation.unassignedM4EligibleRuns,
        m5StartedRuns: generation.unassignedM5StartedRuns,
        m5MissingLogs: generation.unassignedM5RunsWithoutLogs,
        m5Exhaustions: generation.unassignedM5Exhaustions,
      },
      llmRequestMarkers: {
        observedCount: generation.structuredMetricMarkerCount,
        dedupStoreMarkers: generation.dedupStoreMarkerCount,
        dedupEvidenceBySection: generation.dedupRuntimeEvidenceBySection,
      },
    },
    sections: sectionsReport,
  };
  return report;
}

function sectionDuplicatesForReport(duplicates, section) {
  if (!duplicates.available && !duplicates.conservativeUpperBoundAvailable) return null;
  return {
    exact: duplicates.available ? {
      sameSection: duplicates.sameSectionPairsBySection[section] || 0,
      crossCantonPairsInvolving: duplicates.crossCantonPairsBySectionInvolved[section] || 0,
    } : null,
    conservativeUpperBound: duplicates.conservativeUpperBoundAvailable ? {
      sameSection: duplicates.sameSectionPairsBySection[section] || 0,
      crossCantonPairsInvolving: duplicates.crossCantonPairsBySectionInvolved[section] || 0,
    } : null,
    knownDateLowerBound: duplicates.conservativeUpperBoundAvailable ? {
      sameSection: duplicates.knownDateSameSectionPairsBySection[section] || 0,
      crossCantonPairsInvolving: duplicates.knownDateCrossCantonPairsBySectionInvolved[section] || 0,
    } : null,
  };
}

function printHelp() {
  console.log('Uso: node scripts/ci/measure-section-cadence.mjs --from YYYY-MM-DD --to YYYY-MM-DD [--output file.json]');
  console.log('Le date sono inclusive e interpretate in Europe/Zurich. Il report include M1–M6 per le 26 sezioni.');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return printHelp();
  const report = await collectBaseline(args);
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (args.output) {
    const out = path.resolve(REPO_ROOT, args.output);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, json);
    console.log(`Report scritto: ${path.relative(REPO_ROOT, out)}`);
  } else process.stdout.write(json);
  const counts = Object.values(report.sections).reduce((total, section) => {
    total.m1 += section.M1.verifiedArticles;
    total.m2Runs += section.M2.runsCreated;
    return total;
  }, { m1: 0, m2Runs: 0 });
  console.log(`M1=${counts.m1} articoli verificati; run generazione=${counts.m2Runs}; baseline ${report.window.hours}h (${report.window.fromDateInclusive}–${report.window.toDateInclusive} Europe/Zurich).`);
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  main().catch((error) => {
    console.error(`measure-section-cadence: ${error.message}`);
    process.exitCode = 1;
  });
}

