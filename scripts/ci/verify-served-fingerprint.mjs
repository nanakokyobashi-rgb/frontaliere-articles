import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const TSV_HEADER = ['url', 'path', 'sha', 'origin', 'locale', 'shard'].join('\t');
const PUSH_STATE_HEADER = ['shard', 'locale', 'status'].join('\t');
const DEFAULT_TIMEOUT_SECONDS = 12 * 60;
const DEFAULT_POLL_SECONDS = 15;
const DEFAULT_PROBE_TIMEOUT_MS = 30 * 1000;
const MAX_BODY_PREVIEW_CHARS = 300;
const EDGE_BLOCKED_STATUSES = new Set([403, 429, 503]);
// The curl transport deliberately uses curl's built-in user agent. Keep this
// value for the fetch fallback and the injectable fetch contract used by tests.
const PUBLISH_PROBE_USER_AGENT = 'frontaliere-fast-publish/1.0 (+https://frontaliereticino.ch/)';

/**
 * Normalizza i byte HTML che il publisher ha scritto e che Pages deve servire.
 * Il fast path dei shard è statico: confrontiamo il documento intero, senza
 * aggiungere marker all'HTML e senza ignorare titolo, head o dati strutturati.
 */
export function normalizeHtml(html) {
  if (typeof html !== 'string') throw new TypeError('HTML must be a string');
  return html
    .replace(/\r\n?/gu, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/u, ''))
    .join('\n');
}

/**
 * Cloudflare's edge may append its JavaScript-detection probe immediately
 * before </body>. The probe is not part of the static document published to
 * the shard, so remove only that exact, trailing edge-owned script before
 * comparing fingerprints. Any other script, marker, or placement remains a
 * real byte mismatch.
 */
export function stripCloudflareBotFightScript(html) {
  if (typeof html !== 'string') throw new TypeError('HTML must be a string');
  const bodyClose = html.lastIndexOf('</body>');
  if (bodyClose < 0) return html;

  const beforeBody = html.slice(0, bodyClose);
  const scriptStart = beforeBody.lastIndexOf('<script>');
  if (scriptStart < 0) return html;
  const candidateWithWhitespace = beforeBody.slice(scriptStart);
  const trailingWhitespace = candidateWithWhitespace.match(/[ \t\r\n]*$/u)?.[0] || '';
  const candidate = trailingWhitespace
    ? candidateWithWhitespace.slice(0, -trailingWhitespace.length)
    : candidateWithWhitespace;
  if (!candidate.endsWith('</script>')
    || !candidate.includes('window.__CF$cv$params=')
    || !candidate.includes("a.src='/cdn-cgi/challenge-platform/scripts/jsd/main.js'")) {
    return html;
  }

  return `${beforeBody.slice(0, scriptStart)}${trailingWhitespace}${html.slice(bodyClose)}`;
}

export function fingerprintHtml(html) {
  return crypto.createHash('sha256').update(normalizeHtml(html), 'utf8').digest('hex');
}

export class FingerprintMismatchError extends Error {
  constructor(stage, failures) {
    const details = failures.map(formatFailure).join('\n');
    super(`${stage}: ${failures.length} URL did not serve the expected fingerprint\n${details}`);
    this.name = 'FingerprintMismatchError';
    this.stage = stage;
    this.failures = failures;
  }
}

export class EdgeBlockedError extends Error {
  constructor(stage, failures) {
    const statuses = [...new Set(failures.map(({ observation }) => observation.status))]
      .filter((status) => status > 0)
      .sort((left, right) => left - right);
    const details = failures.map(formatBlockedFailure).join('\n');
    super(
      `${stage}: probe bloccata dall'edge; blocked=${failures.length} URL; `
      + `status=${statuses.join(', ') || 'unknown'}; cf-cache-status=absent\n${details}`,
    );
    this.name = 'EdgeBlockedError';
    this.code = 'EDGE_PROBE_BLOCKED';
    this.exitCode = 2;
    this.stage = stage;
    this.failures = failures;
    this.blockedCount = failures.length;
    this.statuses = statuses;
  }
}

function optionalHeader(response, name) {
  const value = response?.headers?.get?.(name);
  if (value !== undefined && value !== null && value !== '') return String(value);
  const plain = response?.headers?.[name] ?? response?.headers?.[name.toLowerCase()];
  return plain === undefined || plain === '' ? null : String(plain);
}

function header(response, name) {
  return optionalHeader(response, name) || 'unknown';
}

function isEdgeBlocked({ record, probeUrl, observation }) {
  if (!probeUrl || typeof record?.url !== 'string') return false;
  let isApexProbe = false;
  try {
    isApexProbe = new URL(probeUrl).hostname === new URL(record.url).hostname;
  } catch {
    return false;
  }
  return isApexProbe
    && EDGE_BLOCKED_STATUSES.has(observation.status)
    && observation.hasCfCacheStatus === false;
}

function formatHeader(name, value) {
  return value ? `${name}=${value}` : null;
}

function formatFailure({ record, probeUrl, observation, freshProbe }) {
  const edgeBlocked = isEdgeBlocked({ record, probeUrl, observation })
    || (freshProbe && isEdgeBlocked({
      record,
      probeUrl: freshProbe.probeUrl,
      observation: freshProbe.observation,
    }));
  return [
    `URL ${record.url}`,
    `expected=${record.sha}`,
    `served=${observation.sha || 'unavailable'}`,
    `status=${observation.status || 'network-error'}`,
    `cf-cache-status=${observation.cfCacheStatus}`,
    `age=${observation.age}`,
    `last-modified=${observation.lastModified}`,
    edgeBlocked ? "classification=probe bloccata dall'edge" : null,
    freshProbe?.cacheLagConfirmed ? 'classification=cache-lag' : null,
    freshProbe ? `fresh-probe-status=${freshProbe.observation.status || 'network-error'}` : null,
    freshProbe ? `fresh-probe-served=${freshProbe.observation.sha || 'unavailable'}` : null,
    freshProbe ? `fresh-probe-cf-cache-status=${freshProbe.observation.cfCacheStatus}` : null,
    freshProbe ? `fresh-probe-age=${freshProbe.observation.age}` : null,
    edgeBlocked ? `body-preview=${JSON.stringify(freshProbe?.observation.bodyPreview || observation.bodyPreview || '')}` : null,
    edgeBlocked ? formatHeader('server', freshProbe?.observation.server || observation.server) : null,
    edgeBlocked ? formatHeader('cf-ray', freshProbe?.observation.cfRay || observation.cfRay) : null,
    edgeBlocked ? formatHeader('cf-mitigated', freshProbe?.observation.cfMitigated || observation.cfMitigated) : null,
    observation.error ? `error=${observation.error}` : null,
    freshProbe?.observation.error ? `fresh-probe-error=${freshProbe.observation.error}` : null,
  ].filter(Boolean).join('; ');
}

function formatBlockedFailure({ record, observation }) {
  return [
    `URL ${record.url}`,
    `status=${observation.status}`,
    "classification=probe bloccata dall'edge",
    `body-preview=${JSON.stringify(observation.bodyPreview || '')}`,
    formatHeader('server', observation.server),
    formatHeader('cf-ray', observation.cfRay),
    formatHeader('cf-mitigated', observation.cfMitigated),
  ].filter(Boolean).join('; ');
}

function validSha(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}

function validateRecord(record) {
  if (!record || typeof record !== 'object') throw new TypeError('invalid fingerprint record');
  for (const field of ['url', 'path']) {
    if (typeof record[field] !== 'string' || record[field] === '') {
      throw new TypeError(`fingerprint record has no ${field}`);
    }
  }
  if (!validSha(record.sha)) throw new TypeError(`invalid fingerprint for ${record.url}`);
  return record;
}

function routePath(relPath) {
  const clean = String(relPath).replace(/^\/+/, '');
  return clean.endsWith('/index.html') ? clean.slice(0, -'index.html'.length) : clean;
}

function apexUrl(relPath) {
  return new URL(routePath(relPath), 'https://frontaliereticino.ch/').toString();
}

function originUrl(shard, locale, relPath) {
  return new URL(
    routePath(relPath),
    `https://origin-${shard}-${locale}.frontaliereticino.ch/`,
  ).toString();
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function addRecord(records, seen, record) {
  validateRecord(record);
  const key = `${record.locale || ''}\t${record.path}`;
  if (seen.has(key)) return;
  seen.add(key);
  records.push(record);
}

/**
 * Costruisce le impronte dai byte finali in fast-dist, dopo l'offload degli
 * asset. `hubSummary` copre le landing che il publisher aggiunge al push ma
 * che non fanno parte di fast-summary.json.
 */
export function recordsFromSummary({ summary, hubSummary = null, distDir, shard }) {
  if (!summary || !Array.isArray(summary.shards)) throw new TypeError('summary.shards must be an array');
  if (typeof distDir !== 'string' || !distDir) throw new TypeError('distDir is required');
  if (typeof shard !== 'string' || !shard) throw new TypeError('shard is required');

  const records = [];
  const seen = new Set();
  for (const shardSummary of summary.shards) {
    const locale = shardSummary?.locale;
    if (!['it', 'en', 'de', 'fr'].includes(locale)) throw new TypeError(`invalid shard locale: ${locale}`);
    const articlePaths = Array.isArray(shardSummary.articlePaths) ? shardSummary.articlePaths : [];
    const urls = Array.isArray(shardSummary.urls) ? shardSummary.urls : [];
    const paths = Array.isArray(shardSummary.paths) ? [...new Set(shardSummary.paths)] : [];
    for (const relPath of paths) {
      const absolutePath = path.join(distDir, relPath);
      const html = fs.readFileSync(absolutePath, 'utf8');
      const articleIndex = articlePaths.indexOf(relPath);
      addRecord(records, seen, {
        url: articleIndex >= 0 && typeof urls[articleIndex] === 'string'
          ? urls[articleIndex]
          : apexUrl(relPath),
        path: relPath,
        sha: fingerprintHtml(html),
        origin: originUrl(shard, locale, relPath),
        locale,
        shard,
      });
    }
  }

  if (hubSummary?.pages && Array.isArray(hubSummary.pages)) {
    for (const page of hubSummary.pages) {
      const locale = page?.locale;
      const relPath = page?.path;
      if (!['it', 'en', 'de', 'fr'].includes(locale) || typeof relPath !== 'string' || !relPath) {
        throw new TypeError('invalid hub landing entry');
      }
      const html = fs.readFileSync(path.join(distDir, relPath), 'utf8');
      addRecord(records, seen, {
        url: apexUrl(relPath),
        path: relPath,
        sha: fingerprintHtml(html),
        origin: originUrl(shard, locale, relPath),
        locale,
        shard,
      });
    }
  }

  return records.sort((a, b) => a.path.localeCompare(b.path));
}

function tsvField(value) {
  const stringValue = String(value ?? '');
  if (/[\t\r\n]/u.test(stringValue)) throw new TypeError('fingerprint TSV field contains a control separator');
  return stringValue;
}

export function writeFingerprintFile(file, records) {
  if (!Array.isArray(records)) throw new TypeError('records must be an array');
  const lines = [TSV_HEADER];
  for (const record of records) {
    validateRecord(record);
    lines.push([
      record.url,
      record.path,
      record.sha,
      record.origin || '',
      record.locale || '',
      record.shard || '',
    ].map(tsvField).join('\t'));
  }
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
}

export function readFingerprintFile(file) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/u).filter(Boolean);
  if (lines.length === 0 || lines[0] !== TSV_HEADER) throw new TypeError(`${file} has no fingerprint TSV header`);
  return lines.slice(1).map((line, index) => {
    const [url, recordPath, sha, origin = '', locale = '', shard = ''] = line.split('\t');
    try {
      return validateRecord({ url, path: recordPath, sha, origin, locale, shard });
    } catch (error) {
      throw new TypeError(`${file}:${index + 2}: ${error.message}`);
    }
  });
}

export function readPushStateFile(file) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/u).filter(Boolean);
  if (lines.length === 0 || lines[0] !== PUSH_STATE_HEADER) {
    throw new TypeError(`${file} has no push-state TSV header`);
  }
  const states = new Map();
  for (const [index, line] of lines.slice(1).entries()) {
    const fields = line.split('\t');
    if (fields.length !== 3) throw new TypeError(`${file}:${index + 2}: invalid push-state row`);
    const [shard, locale, status] = fields;
    if (!shard || !['it', 'en', 'de', 'fr'].includes(locale)) {
      throw new TypeError(`${file}:${index + 2}: invalid push-state shard or locale`);
    }
    if (!['pushed', 'clean-no-op'].includes(status)) {
      throw new TypeError(`${file}:${index + 2}: invalid push-state status ${status}`);
    }
    const key = `${shard}\t${locale}`;
    if (states.has(key)) throw new TypeError(`${file}:${index + 2}: duplicate push-state ${key}`);
    states.set(key, status);
  }
  return states;
}

function sampleKey(record) {
  return `${record.shard || 'unknown-shard'}\t${record.locale || 'unknown-locale'}`;
}

/** Un URL stabile per ogni combinazione shard/lingua, ordinato per path. */
export function selectOriginSamples(records) {
  const samples = new Map();
  for (const record of [...records].sort((a, b) => a.path.localeCompare(b.path))) {
    const key = sampleKey(record);
    if (!samples.has(key)) samples.set(key, record);
  }
  return [...samples.values()];
}

function probeUrl(url, runKey, sequence) {
  const parsed = new URL(url);
  parsed.searchParams.set('_fpcb', `${runKey}.${sequence}`);
  return parsed.toString();
}

function defaultApexRunKey() {
  const runId = process.env.GITHUB_RUN_ID || 'local';
  const runAttempt = process.env.GITHUB_RUN_ATTEMPT || '1';
  return `${runId}.${runAttempt}.${crypto.randomUUID()}`;
}

function parseCurlHeaders(rawHeaders) {
  const blocks = String(rawHeaders)
    .split(/\r?\n\r?\n/u)
    .filter((block) => /^HTTP\/\S+\s+\d{3}\b/iu.test(block.trim()));
  const finalBlock = blocks.at(-1) || '';
  const headers = {};
  for (const line of finalBlock.split(/\r?\n/u).slice(1)) {
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    headers[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim();
  }
  return headers;
}

function curlTimeoutSeconds(timeoutMs) {
  return String(timeoutMs / 1000);
}

export function createCurlFetch({ fallbackFetch = globalThis.fetch, execFileImpl = execFileAsync } = {}) {
  if (typeof fallbackFetch !== 'function') throw new TypeError('fallback fetch implementation is required');
  if (typeof execFileImpl !== 'function') throw new TypeError('curl executor is required');
  let curlAvailable = true;
  return async function curlFetch(url, options = {}) {
    if (!curlAvailable) return fallbackFetch(url, options);
    const requestedTimeoutMs = Number(options.timeoutMs);
    const boundedTimeoutMs = Number.isFinite(requestedTimeoutMs) && requestedTimeoutMs > 0
      ? Math.max(1, Math.ceil(requestedTimeoutMs))
      : DEFAULT_PROBE_TIMEOUT_MS;
    let temporaryDir = null;
    try {
      temporaryDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'served-fingerprint-curl-'));
      const headersFile = path.join(temporaryDir, 'headers.txt');
      const bodyFile = path.join(temporaryDir, 'body.html');
      const { stdout } = await execFileImpl('curl', [
        '-s',
        '-L',
        '--max-time',
        curlTimeoutSeconds(boundedTimeoutMs),
        '-H',
        'Cache-Control: no-cache',
        '-D',
        headersFile,
        '-o',
        bodyFile,
        '-w',
        '%{http_code}',
        String(url),
      ], {
        shell: false,
        signal: options.signal,
        maxBuffer: 1024 * 1024,
      });
      const [rawHeaders, body] = await Promise.all([
        fs.promises.readFile(headersFile, 'utf8'),
        fs.promises.readFile(bodyFile, 'utf8'),
      ]);
      return {
        status: Number(String(stdout).trim()) || 0,
        headers: parseCurlHeaders(rawHeaders),
        text: async () => body,
      };
    } catch (error) {
      if (error?.code === 'ENOENT') {
        curlAvailable = false;
        return fallbackFetch(url, options);
      }
      throw error;
    } finally {
      if (temporaryDir) {
        await fs.promises.rm(temporaryDir, { recursive: true, force: true }).catch(() => {});
      }
    }
  };
}

function unavailableObservation(error) {
  return {
    status: 0,
    sha: null,
    cfCacheStatus: 'unknown',
    hasCfCacheStatus: false,
    age: 'unknown',
    lastModified: 'unknown',
    bodyPreview: null,
    server: null,
    cfRay: null,
    cfMitigated: null,
    error,
  };
}

function probeTimeoutError(url, timeoutMs) {
  const error = new Error(`probe timed out after ${timeoutMs}ms for ${url}`);
  error.code = 'PROBE_TIMEOUT';
  return error;
}

async function fetchFingerprint(record, {
  fetchImpl,
  url,
  cacheBust,
  runKey,
  sequence,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
}) {
  const requestUrl = cacheBust ? probeUrl(url, runKey, sequence) : url;
  const boundedTimeoutMs = Math.max(1, Math.ceil(Number(timeoutMs)));
  const controller = new AbortController();
  let timer;
  const request = (async () => {
    const response = await fetchImpl(requestUrl, {
      signal: controller.signal,
      redirect: 'follow',
      headers: cacheBust
        ? {
          Accept: 'text/html',
          'Cache-Control': 'no-cache',
          'User-Agent': PUBLISH_PROBE_USER_AGENT,
        }
        : {
          Accept: 'text/html',
          'User-Agent': PUBLISH_PROBE_USER_AGENT,
        },
      timeoutMs: boundedTimeoutMs,
    });
    const body = await response.text();
    const cfCacheStatus = optionalHeader(response, 'cf-cache-status');
    return {
      status: Number(response.status) || 0,
      sha: fingerprintHtml(stripCloudflareBotFightScript(body)),
      cfCacheStatus: cfCacheStatus || 'unknown',
      hasCfCacheStatus: cfCacheStatus !== null,
      age: header(response, 'age'),
      lastModified: header(response, 'last-modified'),
      bodyPreview: body.slice(0, MAX_BODY_PREVIEW_CHARS),
      server: optionalHeader(response, 'server'),
      cfRay: optionalHeader(response, 'cf-ray'),
      cfMitigated: optionalHeader(response, 'cf-mitigated'),
    };
  })();
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(probeTimeoutError(url, boundedTimeoutMs));
    }, boundedTimeoutMs);
  });
  try {
    return await Promise.race([request, timeout]);
  } catch (error) {
    return unavailableObservation(error?.message || String(error));
  } finally {
    clearTimeout(timer);
    if (!controller.signal.aborted) controller.abort();
  }
}

function matches(record, observation) {
  return observation.status === 200 && observation.sha === record.sha;
}

function isCacheHitMismatch(observation) {
  return observation.status === 200 && observation.cfCacheStatus.toUpperCase() === 'HIT';
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function elapsedSince(startedAt, wallStartedAt, now) {
  return Math.max(0, now() - startedAt, Date.now() - wallStartedAt);
}

function mismatch(stage, pending) {
  return new FingerprintMismatchError(stage, [...pending].map(([record, observation]) => ({ record, observation })));
}

/**
 * Classifica il log del controllo apex per il consumer shell del workflow.
 * Solo un mismatch HTTP 200 esplicitamente marcato `cache-lag` può essere
 * degradato a warning; una risposta di route, un errore operativo o un blocco
 * dell'edge resta fail-closed.
 */
export function classifyApexFailureLog(rawLog) {
  const log = String(rawLog ?? '');
  if (log.includes("probe bloccata dall'edge")) return 'edge-blocked';

  const urlLines = log.split(/\r?\n/u).filter((line) => line.startsWith('URL '));
  if (!log.includes('did not serve the expected fingerprint') || urlLines.length === 0) {
    return 'operational';
  }

  let operational = false;
  let invalid = false;
  for (const line of urlLines) {
    const fields = new Map();
    for (const part of line.split('; ')) {
      const separator = part.indexOf('=');
      if (separator > 0) fields.set(part.slice(0, separator), part.slice(separator + 1));
    }
    const status = fields.get('status') || '';
    const expected = fields.get('expected') || '';
    const served = fields.get('served') || '';
    const classification = fields.get('classification') || '';
    if (status === 'network-error' || status === '') {
      operational = true;
    } else if (
      status !== '200'
      || expected === ''
      || served === ''
      || expected === served
      || classification !== 'cache-lag'
    ) {
      invalid = true;
    }
  }
  if (operational) return 'operational';
  return invalid ? 'hard' : 'lag';
}

export function apexFailureDecision(rawLog, { phase, verifyExitCode } = {}) {
  const kind = classifyApexFailureLog(rawLog);
  const exitCode = Number.isInteger(verifyExitCode) && verifyExitCode > 0 ? verifyExitCode : 1;
  if (kind === 'lag') return { kind, exitCode: 0, message: null, githubOutput: null };
  if (kind === 'edge-blocked') {
    return {
      kind,
      exitCode: 2,
      message: `::error::edge probe blocked (${phase}; verifier exit ${exitCode}) — skipping the post-verification backstop purge`,
      githubOutput: 'edge_probe_blocked=true',
    };
  }
  if (kind === 'operational') {
    return {
      kind,
      exitCode,
      message: `::error::apex fingerprint verifier failed operationally (${phase}); refusing to downgrade it to a warning`,
      githubOutput: null,
    };
  }
  if (kind === 'hard' && phase === 'before retry') {
    return {
      kind,
      exitCode: 0,
      message: '::warning::apex returned a non-lag fingerprint result; repeating once but it remains fail-closed if it persists',
      githubOutput: null,
    };
  }
  return {
    kind,
    exitCode,
    message: kind === 'hard'
      ? `::error::apex returned a non-lag fingerprint result (${phase}); refusing to downgrade it to a warning`
      : `::error::apex fingerprint verifier returned an unknown classification (${phase}); refusing to downgrade it to a warning`,
    githubOutput: null,
  };
}

function allEdgeBlocked(stage, observations) {
  if (observations.length === 0 || !observations.every(isEdgeBlocked)) {
    return null;
  }
  return new EdgeBlockedError(stage, observations);
}

export async function waitForOrigin({
  records,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_SECONDS * 1000,
  pollIntervalMs = DEFAULT_POLL_SECONDS * 1000,
  now = Date.now,
  sleep = defaultSleep,
  runKey = process.env.GITHUB_RUN_ID || 'local',
  replayNoop = false,
  pushState = null,
  probeTimeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
  onObservation = null,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch implementation is required');
  const samples = selectOriginSamples(records || []);
  if (samples.length === 0) return { checked: 0, attempts: 0, waitedMs: 0, immediate: true };
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('timeoutMs must be positive');
  if (!Number.isFinite(probeTimeoutMs) || probeTimeoutMs <= 0) throw new TypeError('probeTimeoutMs must be positive');

  const startedAt = now();
  const wallStartedAt = Date.now();
  const pending = new Map(samples.map((record) => [record, null]));
  let attempts = 0;
  let sequence = 0;
  while (pending.size > 0) {
    attempts += 1;
    const replayFailures = new Map();
    const roundObservations = [];
    for (const record of [...pending.keys()]) {
      sequence += 1;
      const url = record.origin || record.url;
      const remainingBeforeProbe = timeoutMs - elapsedSince(startedAt, wallStartedAt, now);
      const observation = remainingBeforeProbe > 0
        ? await fetchFingerprint(record, {
          fetchImpl,
          url,
          cacheBust: true,
          runKey,
          sequence,
          timeoutMs: Math.min(probeTimeoutMs, Math.max(1, remainingBeforeProbe)),
        })
        : unavailableObservation(`probe budget exhausted for ${url}`);
      pending.set(record, observation);
      roundObservations.push({ record, probeUrl: url, observation });
      if (onObservation) onObservation({ record, observation, attempts });
      if (matches(record, observation)) {
        pending.delete(record);
      } else if (replayNoop === true || pushState?.get?.(sampleKey(record)) === 'clean-no-op') {
        replayFailures.set(record, observation);
      }
    }
    const blocked = allEdgeBlocked('Origin served-content verification failed', roundObservations);
    if (blocked) throw blocked;
    if (replayFailures.size > 0) {
      throw mismatch('Origin replay no-op did not already match', replayFailures);
    }
    if (pending.size === 0) {
      return {
        checked: samples.length,
        attempts,
        waitedMs: elapsedSince(startedAt, wallStartedAt, now),
        immediate: attempts === 1,
      };
    }
    if (replayNoop) throw mismatch('Origin replay no-op did not already match', pending);
    const remaining = timeoutMs - elapsedSince(startedAt, wallStartedAt, now);
    if (remaining <= 0) throw mismatch('Timed out waiting for GitHub Pages origin', pending);
    await sleep(Math.min(Math.max(1, pollIntervalMs), remaining));
  }
  return { checked: samples.length, attempts, waitedMs: 0, immediate: true };
}

export async function verifyApex({
  records,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_SECONDS * 1000,
  probeTimeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
  now = Date.now,
  runKey = defaultApexRunKey(),
  onObservation = null,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch implementation is required');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('timeoutMs must be positive');
  if (!Number.isFinite(probeTimeoutMs) || probeTimeoutMs <= 0) throw new TypeError('probeTimeoutMs must be positive');
  const failures = [];
  const observations = [];
  let checked = 0;
  const startedAt = now();
  const wallStartedAt = Date.now();
  for (const record of records || []) {
    checked += 1;
    const remainingBeforeProbe = timeoutMs - elapsedSince(startedAt, wallStartedAt, now);
    const observation = remainingBeforeProbe > 0
      ? await fetchFingerprint(record, {
        fetchImpl,
        url: record.url,
        cacheBust: false,
        runKey,
        sequence: checked,
        timeoutMs: Math.min(probeTimeoutMs, Math.max(1, remainingBeforeProbe)),
      })
      : unavailableObservation(`probe budget exhausted for ${record.url}`);
    observations.push({ record, probeUrl: record.url, observation });
    if (onObservation) onObservation({ record, observation, checked });
    if (!matches(record, observation)) {
      let freshProbe;
      if (isCacheHitMismatch(observation)) {
        const remainingBeforeConfirmation = timeoutMs - elapsedSince(startedAt, wallStartedAt, now);
        const freshObservation = remainingBeforeConfirmation > 0
          ? await fetchFingerprint(record, {
            fetchImpl,
            url: record.url,
            cacheBust: true,
            runKey,
            sequence: checked,
            timeoutMs: Math.min(probeTimeoutMs, Math.max(1, remainingBeforeConfirmation)),
          })
          : unavailableObservation(`probe budget exhausted for cache confirmation ${record.url}`);
        freshProbe = {
          probeUrl: record.url,
          observation: freshObservation,
          cacheLagConfirmed: matches(record, freshObservation),
        };
        if (onObservation) {
          onObservation({
            record,
            observation: freshObservation,
            checked,
            confirmation: true,
          });
        }
      }
      failures.push({ record, probeUrl: record.url, observation, freshProbe });
    }
  }
  const blocked = allEdgeBlocked('CDN served-content verification failed', observations);
  if (blocked) throw blocked;
  if (failures.length > 0) throw new FingerprintMismatchError('CDN served-content verification failed', failures);
  return { checked, repurges: 0 };
}

export async function verifyAfterPurge({
  records,
  fetchImpl = globalThis.fetch,
  purge,
  maxRepurges = 1,
  timeoutMs = DEFAULT_TIMEOUT_SECONDS * 1000,
  probeTimeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
  now = Date.now,
  onObservation = null,
} = {}) {
  let repurges = 0;
  while (true) {
    try {
      const result = await verifyApex({
        records,
        fetchImpl,
        timeoutMs,
        probeTimeoutMs,
        now,
        onObservation,
      });
      return { ...result, repurges };
    } catch (error) {
      if (!(error instanceof FingerprintMismatchError) || repurges >= maxRepurges || typeof purge !== 'function') {
        throw error;
      }
      repurges += 1;
      await purge({ error, attempt: repurges });
    }
  }
}

function flag(args, name, fallback = null) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

function requiredFlag(args, name) {
  const value = flag(args, name);
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

function positiveSeconds(value, name) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error(`${name} must be a positive number`);
  return seconds;
}

async function main(argv) {
  const [command, ...args] = argv;
  if (!command || !['write', 'wait-origin', 'verify-apex', 'classify-apex-failure', 'handle-apex-failure'].includes(command)) {
    throw new Error('usage: verify-served-fingerprint.mjs <write|wait-origin|verify-apex|classify-apex-failure|handle-apex-failure> ...');
  }

  if (command === 'classify-apex-failure') {
    console.log(classifyApexFailureLog(fs.readFileSync(requiredFlag(args, '--log'), 'utf8')));
    return;
  }

  if (command === 'handle-apex-failure') {
    const decision = apexFailureDecision(fs.readFileSync(requiredFlag(args, '--log'), 'utf8'), {
      phase: requiredFlag(args, '--phase'),
      verifyExitCode: Number(requiredFlag(args, '--verify-exit-code')),
    });
    if (decision.githubOutput) {
      fs.appendFileSync(requiredFlag(args, '--github-output'), `${decision.githubOutput}\n`);
    }
    if (decision.message) console.log(decision.message);
    process.exitCode = decision.exitCode;
    return;
  }

  if (command === 'write') {
    const summary = readJson(requiredFlag(args, '--summary'));
    const hubFile = flag(args, '--hub-summary');
    const records = recordsFromSummary({
      summary,
      hubSummary: hubFile && fs.existsSync(hubFile) ? readJson(hubFile) : null,
      distDir: requiredFlag(args, '--dist'),
      shard: requiredFlag(args, '--shard'),
    });
    writeFingerprintFile(requiredFlag(args, '--output'), records);
    console.log(`wrote ${records.length} published HTML fingerprint(s)`);
    return;
  }

  const records = readFingerprintFile(requiredFlag(args, '--fingerprints'));
  const timeoutSeconds = positiveSeconds(
    flag(args, '--timeout-seconds', String(DEFAULT_TIMEOUT_SECONDS)),
    '--timeout-seconds',
  );
  const probeTimeoutSeconds = positiveSeconds(
    flag(args, '--probe-timeout-seconds', String(DEFAULT_PROBE_TIMEOUT_MS / 1000)),
    '--probe-timeout-seconds',
  );
  const fetchImpl = createCurlFetch();
  if (command === 'wait-origin') {
    const pollSeconds = positiveSeconds(
      flag(args, '--poll-seconds', String(DEFAULT_POLL_SECONDS)),
      '--poll-seconds',
    );
    const result = await waitForOrigin({
      records,
      fetchImpl,
      timeoutMs: timeoutSeconds * 1000,
      pollIntervalMs: pollSeconds * 1000,
      probeTimeoutMs: probeTimeoutSeconds * 1000,
      runKey: flag(args, '--run-key', process.env.GITHUB_RUN_ID || 'local'),
      replayNoop: args.includes('--replay-noop'),
      pushState: (() => {
        const file = flag(args, '--push-state');
        return file ? readPushStateFile(file) : null;
      })(),
      onObservation: ({ record, observation }) => {
        console.log(`[origin] ${record.locale || 'unknown'} ${record.path}: ${observation.status || 'network-error'} ${observation.sha || 'unavailable'}`);
      },
    });
    console.log(`[origin] fingerprints match; checked=${result.checked} attempts=${result.attempts} waited=${Math.round(result.waitedMs / 1000)}s`);
    return;
  }

  const result = await verifyApex({
    records,
    fetchImpl,
    timeoutMs: timeoutSeconds * 1000,
    probeTimeoutMs: probeTimeoutSeconds * 1000,
    runKey: flag(args, '--run-key') || defaultApexRunKey(),
    onObservation: ({ record, observation }) => {
      console.log(`[cdn] ${record.url}: ${observation.status || 'network-error'} ${observation.sha || 'unavailable'} cf-cache-status=${observation.cfCacheStatus} age=${observation.age}`);
    },
  });
  console.log(`[cdn] fingerprints match; checked=${result.checked}`);
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`::error::${error.message}`);
    process.exitCode = error instanceof EdgeBlockedError ? error.exitCode : 1;
  });
}
