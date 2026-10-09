#!/usr/bin/env node
/**
 * Observer and bounded repairer for the two Pages article publishers.
 *
 * It samples only Italian article pages whose body changed recently on corpus
 * main. Publication lag is measured with dateModified versus the registry's
 * updatedAt (or the publication day when updatedAt is absent); Event pages
 * are exempt because their renderer intentionally omits dateModified. Image
 * degradation is a separate signal based on og:image versus the registry
 * image. The network loop is deliberately sequential and rate-limited because
 * this is a courtesy check, not a crawler. Degraded articles are kept in the
 * observer issue body until a live read is sane; at most three proven image
 * repairs are dispatched per run.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { declaredImageIsOwn, extractOgImage, isGenericOgImage, normalizeImagePath } from '../lib/article-image-postcondition.mjs';
import { fetchDeclaredImage } from '../lib/declared-image-fetch.mjs';
import {
  DEFAULT_REPAIR_CAP,
  applyDispatchOutcomes,
  groupRepairCandidates,
  ledgerKey,
  markDispatched,
  markLedgerItemsAbsent,
  mergeDegradedItems,
  parseDegradationLedger,
  retainDegradationLedger,
  removeHealthyItems,
  repairCandidates,
  upsertDegradationLedger,
} from '../lib/article-image-degradation-ledger.mjs';

export const OBSERVER_ISSUE_TITLE = 'Article publication lag (corpus → site)';
export const DEFAULT_LOOKBACK_DAYS = 7;
export const DEFAULT_STALE_MINUTES = 60;
export const DEFAULT_MAX_PAGES = 300;
export const DEFAULT_MIN_INTERVAL_MS = 500;
export const DEFAULT_LEDGER_RETENTION_DAYS = 90;
export const DEFAULT_TERMINAL_RETENTION_DAYS = 14;
export const SITE_BASE_URL = 'https://frontaliereticino.ch';
export const DEFAULT_REPAIR_WORKFLOW = 'fast-publish-article.yml';
// The apex answers 403 to the default User-Agent of Node's fetch (measured on
// 2026-10-07): without a name of its own the observer would report every page
// as lagging with "HTTP 403".
export const OBSERVER_USER_AGENT = 'frontaliere-publication-observer/1 (+https://frontaliereticino.ch)';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function bodyPathInfo(rel) {
  const match = String(rel).replaceAll('\\', '/').match(
    /^content\/(blog-body|blog-body-ch)\/(it|en|de|fr)\/([^/]+)\.ts$/,
  );
  if (!match) return null;
  return {
    section: match[1] === 'blog-body-ch' ? 'svizzera' : 'frontaliere',
    locale: match[2],
    articleId: match[3],
  };
}

/** Parse `git log --format="commit <sha> <epoch>" --name-only` output. */
export function parseChangedBodyLog(log) {
  const latest = new Map();
  let current = null;
  for (const line of String(log).split(/\r?\n/)) {
    const commit = line.match(/^commit ([0-9a-f]{40}) ([0-9]+)$/i);
    if (commit) {
      current = { commit: commit[1], changedAt: Number(commit[2]) * 1000 };
      continue;
    }
    const info = bodyPathInfo(line.trim());
    if (!current || !info || latest.has(`${info.section}:${info.articleId}`)) continue;
    latest.set(`${info.section}:${info.articleId}`, { ...info, ...current });
  }
  // Most recent first: the page cap must cut the oldest changes, not the end of
  // the alphabet (an alphabetical order would read the same pages every day).
  return [...latest.values()].sort((a, b) => b.changedAt - a.changedAt || a.articleId.localeCompare(b.articleId));
}

function sourceBlock(source, articleId) {
  const id = escapeRegExp(articleId);
  return String(source).match(new RegExp(`\\{\\s*id:\\s*['"]${id}['"][\\s\\S]*?\\},`))?.[0] || '';
}

export function parseRegistryRecord(source, articleId) {
  const block = sourceBlock(source, articleId);
  if (!block) return null;
  const updatedAt = block.match(/\bupdatedAt:\s*['"]([^'"]+)['"]/)?.[1] || null;
  const date = block.match(/\bdate:\s*['"]([^'"]*)['"]/)?.[1] || null;
  const image = block.match(/\bimage:\s*['"]([^'"]+)['"]/)?.[1] || null;
  return { articleId, updatedAt, date, image };
}

export function parseItalianSlug(source, articleId) {
  const entries = /['"]([^'"]+)['"]\s*:\s*\{\s*it:\s*['"]([^'"]+)['"]/g;
  for (const match of String(source).matchAll(entries)) {
    if (match[1] === articleId) return match[2];
  }
  return null;
}

export function buildObserverTargets({ changedBodies = [], ledgerItems = [], registrySources, slugSources, baseUrl = SITE_BASE_URL }) {
  const targets = [];
  const skipped = [];
  const durableChanges = ledgerItems
    .filter((item) => item.status !== 'retired' && item.status !== 'exhausted')
    .map((item) => ({
    section: item.section,
    articleId: item.articleId,
    changedAt: Number.isFinite(Date.parse(item.firstSeenAt ?? '')) ? Date.parse(item.firstSeenAt) : 0,
    commit: item.sourceCommit || '0'.repeat(40),
    durable: true,
    }));
  // Recent corpus changes get the first slots in the bounded page window. The
  // ledger is still durable, but an old unresolved row must not sit in front
  // of a new article on every run.
  const orderedChanges = [...changedBodies.map((change) => ({ ...change, durable: false })), ...durableChanges]
    .sort((a, b) => b.changedAt - a.changedAt || a.articleId.localeCompare(b.articleId));
  const changesByKey = new Map();
  for (const change of orderedChanges) {
    const key = ledgerKey(change);
    const previous = changesByKey.get(key);
    if (!previous) {
      changesByKey.set(key, change);
      continue;
    }
    changesByKey.set(key, {
      ...previous,
      durable: Boolean(previous.durable || change.durable),
      changedAt: Math.max(previous.changedAt, change.changedAt),
      commit: previous.changedAt >= change.changedAt ? previous.commit : change.commit,
    });
  }
  const seen = new Set();
  const missingLedgerKeys = [];
  for (const change of changesByKey.values()) {
    const key = ledgerKey(change);
    if (seen.has(key)) continue;
    seen.add(key);
    const registry = parseRegistryRecord(registrySources[change.section] || '', change.articleId);
    const slug = parseItalianSlug(slugSources[change.section] || '', change.articleId);
    if (!registry || !slug) {
      skipped.push({ ...change, reason: !registry ? 'registro non trovato' : 'slug italiano non trovato' });
      if (change.durable) missingLedgerKeys.push(key);
      continue;
    }
    targets.push({
      ...change,
      url: `${String(baseUrl).replace(/\/+$/, '')}/${change.section === 'svizzera' ? 'articoli-svizzera' : 'articoli-frontaliere'}/${slug}/`,
      sourceCommit: change.commit,
      sourceUpdatedAt: registry.updatedAt,
      registryDate: registry.date,
      registryImage: registry.image,
      durable: Boolean(change.durable),
    });
  }
  return { targets, skipped, missingLedgerKeys };
}

function parseAttrs(tag) {
  const attrs = {};
  for (const match of String(tag).matchAll(/([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    attrs[String(match[1]).toLowerCase()] = match[2] ?? match[3] ?? '';
  }
  return attrs;
}

function collectJsonLdTypes(value, types) {
  if (Array.isArray(value)) {
    for (const item of value) collectJsonLdTypes(item, types);
    return;
  }
  if (!value || typeof value !== 'object') return;
  const type = value['@type'];
  if (typeof type === 'string') types.add(type);
  if (Array.isArray(type)) for (const item of type) if (typeof item === 'string') types.add(item);
  for (const child of Object.values(value)) collectJsonLdTypes(child, types);
}

function parseJsonLdTypes(html) {
  const types = new Set();
  const scripts = String(html).matchAll(
    /<script\b[^>]*\btype\s*=\s*(['"])application\/ld\+json\1[^>]*>([\s\S]*?)<\/script\s*>/gi,
  );
  for (const match of scripts) {
    try {
      collectJsonLdTypes(JSON.parse(match[2]), types);
    } catch {
      // One malformed JSON-LD block must not discard the other page signals.
    }
  }
  return [...types];
}

export function parsePageObservation(html, status = 200) {
  const rawHtml = String(html);
  let modifiedAt = null;
  for (const match of rawHtml.matchAll(/<meta\b[^>]*\/?\s*>/gi)) {
    const attrs = parseAttrs(match[0]);
    const name = String(attrs.name || '').toLowerCase();
    const property = String(attrs.property || '').toLowerCase();
    const content = String(attrs.content || '');
    if (name === 'datemodified' || property === 'article:modified_time') modifiedAt ||= content;
  }
  modifiedAt ||= rawHtml.match(/"dateModified"\s*:\s*"([^"]+)"/)?.[1] || null;
  return { status, modifiedAt, ogImage: extractOgImage(rawHtml), schemaTypes: parseJsonLdTypes(rawHtml), rawHtml };
}

/**
 * The registry date a published page has to have caught up with: `updatedAt`
 * when the article was revised, its publication `date` otherwise. Only 311 of
 * the 4,209 frontaliere entries carry `updatedAt` (measured 2026-10-07), so an
 * entry without it is compared through `date`, never reported as lagging.
 */
export function registryReferenceDate(target) {
  return target?.sourceUpdatedAt || target?.registryDate || null;
}

/**
 * true/false when the two dates can be compared, null when they cannot.
 * `granularity: 'day'` is used for the publication-date fallback: the site's
 * sitemap intentionally emits `date` as a day, so an ISO timestamp in the
 * registry must not make a same-day page look stale.
 * A date-only registry value is rendered as local midnight (measured:
 * `2026-09-25` → `2026-09-25T00:00:00+01:00`), so the page is current from the
 * earliest instant that day starts in Europe/Zurich. A full timestamp is
 * written by the renderer in whole seconds (`03:49:10.833Z` → `03:49:11`).
 */
export function pageHasCaughtUp(pageModifiedAt, registryDate, { granularity = 'instant' } = {}) {
  if (granularity === 'day') {
    const pageDay = String(pageModifiedAt ?? '').match(/^(\d{4}-\d{2}-\d{2})/)?.[1] || null;
    const registryDay = String(registryDate ?? '').match(/^(\d{4}-\d{2}-\d{2})/)?.[1] || null;
    if (!pageDay || !registryDay) return null;
    return pageDay >= registryDay;
  }
  const pageMs = Date.parse(String(pageModifiedAt ?? ''));
  if (!Number.isFinite(pageMs) || !registryDate) return null;
  const registry = String(registryDate);
  if (/^\d{4}-\d{2}-\d{2}$/.test(registry)) {
    const dayStartMs = Date.parse(`${registry}T00:00:00+01:00`);
    return Number.isFinite(dayStartMs) ? pageMs >= dayStartMs : null;
  }
  const registryMs = Date.parse(registry);
  return Number.isFinite(registryMs) ? pageMs >= Math.floor(registryMs / 1000) * 1000 : null;
}

export function classifyPublicationLag({ target, page, nowMs, staleMinutes = DEFAULT_STALE_MINUTES }) {
  const ageMs = nowMs - target.changedAt;
  const degraded = declaredImageIsOwn(target.registryImage) && isGenericOgImage(page.rawHtml || '');
  const degradationReason = degraded ? `og:image generico mentre il registro dichiara ${target.registryImage}` : null;
  if (ageMs <= staleMinutes * 60 * 1000) {
    return { lagging: false, degraded, reason: 'grace window', degradationReason };
  }
  if (page.status !== 200) {
    return { lagging: true, degraded: false, reason: `HTTP ${page.status}` };
  }

  if (page.schemaTypes?.includes('Event')) {
    return { lagging: false, degraded, reason: 'schema Event: dateModified non applicabile', degradationReason };
  }

  const reference = registryReferenceDate(target);
  if (!reference) {
    // Nothing to compare with is not a lag: the page answered and the image
    // signal above still applies.
    return { lagging: false, degraded, reason: 'registro senza data: confronto saltato', degradationReason };
  }
  if (!page.modifiedAt) {
    return { lagging: true, degraded, reason: 'pagina senza dateModified', degradationReason };
  }
  const caughtUp = pageHasCaughtUp(page.modifiedAt, reference, {
    granularity: target.sourceUpdatedAt ? 'instant' : 'day',
  });
  if (caughtUp === null) {
    return { lagging: false, degraded, reason: `date non confrontabili (${page.modifiedAt} / ${reference})`, degradationReason };
  }
  const field = target.sourceUpdatedAt ? 'updatedAt' : 'date';
  return {
    lagging: !caughtUp,
    degraded,
    reason: caughtUp ? 'dateModified current' : `dateModified ${page.modifiedAt} < ${field} ${reference}`,
    degradationReason,
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function observePublicationLag({
  targets,
  fetchImpl = globalThis.fetch,
  nowMs = Date.now(),
  staleMinutes = DEFAULT_STALE_MINUTES,
  maxPages = DEFAULT_MAX_PAGES,
  minIntervalMs = DEFAULT_MIN_INTERVAL_MS,
  sleepImpl = sleep,
  clock = () => Date.now(),
}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch non disponibile');
  const checked = [];
  let lastRequestAt = null;
  for (const target of targets.slice(0, maxPages)) {
    const before = clock();
    if (lastRequestAt !== null) {
      const waitMs = minIntervalMs - (before - lastRequestAt);
      if (waitMs > 0) await sleepImpl(waitMs);
    }
    lastRequestAt = clock();
    let page;
    try {
      const response = await fetchImpl(target.url, {
        headers: { accept: 'text/html', 'user-agent': OBSERVER_USER_AGENT },
        redirect: 'follow',
      });
      if (!response.ok) {
        page = parsePageObservation('', response.status);
      } else {
        const rawHtml = await response.text();
        page = { ...parsePageObservation(rawHtml, response.status), rawHtml };
      }
    } catch (error) {
      page = { status: 0, modifiedAt: null, ogImage: null, rawHtml: '', error: error?.message || String(error) };
    }
    const verdict = classifyPublicationLag({ target, page, nowMs, staleMinutes });
    checked.push({ target, page, ...verdict });
  }
  return {
    checked,
    lagging: checked.filter((entry) => entry.lagging),
    degraded: checked.filter((entry) => entry.degraded),
    capped: targets.length > maxPages,
    unread: Math.max(0, targets.length - maxPages),
  };
}

export function formatObserverReport(report, { nowMs = Date.now(), skipped = [] } = {}) {
  const lines = [
    `Osservatore pubblicazione articoli — ${new Date(nowMs).toISOString()}`,
    `Controllate: ${report.checked.length}; in ritardo: ${report.lagging.length}; immagini degradate: ${report.degraded.length}; limite: ${DEFAULT_MAX_PAGES}.`,
  ];
  if (report.capped) lines.push(`⚠️ Lette le ${report.checked.length} pagine cambiate più di recente; ${report.unread ?? 'altre'} più vecchie nella finestra non sono state lette in questo giro.`);
  for (const item of report.lagging) {
    const page = item.page.modifiedAt || `HTTP ${item.page.status}`;
    lines.push(`- Ritardo \`${item.target.articleId}\` (${item.target.section}) — commit corpus ${item.target.sourceCommit}; pagina ${page}; ${item.reason}; ${item.target.url}`);
  }
  for (const item of report.degraded) {
    lines.push(`- Immagine \`${item.target.articleId}\` (${item.target.section}) — ${item.degradationReason}; ${item.target.url}`);
  }
  for (const item of skipped) lines.push(`- Saltato \`${item.articleId}\` (${item.section}): ${item.reason}.`);
  return lines.join('\n');
}

function gitText(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function loadSources(rootDir) {
  return {
    registrySources: {
      frontaliere: fs.readFileSync(path.join(rootDir, 'content/blog-articles-data.ts'), 'utf8'),
      svizzera: fs.readFileSync(path.join(rootDir, 'content/swiss-articles-data.ts'), 'utf8'),
    },
    slugSources: {
      frontaliere: fs.readFileSync(path.join(rootDir, 'content/routerBlogData.ts'), 'utf8'),
      svizzera: fs.readFileSync(path.join(rootDir, 'content/routerSwissData.ts'), 'utf8'),
    },
  };
}

export function hasLocalDeclaredImage(rootDir, imagePath) {
  const normalized = normalizeImagePath(imagePath)?.split(/[?#]/, 1)[0] || '';
  if (!normalized.startsWith('/images/') || normalized.includes('..')) return false;
  return fs.existsSync(path.join(rootDir, 'public', normalized.slice(1)));
}

/**
 * The repairer may dispatch only after a live generic page and a fresh image
 * proof agree. Checkout files count immediately; otherwise use the exact CDN
 * fetch contract used by the renderer, without writing the response.
 */
export async function proveDeclaredImage({ rootDir, imagePath, fetchImpl = globalThis.fetch, fetchDeclaredImageImpl = fetchDeclaredImage } = {}) {
  const normalized = normalizeImagePath(imagePath)?.split(/[?#]/, 1)[0] || '';
  if (!normalized.startsWith('/images/') || normalized.includes('..')) return { available: false, reason: 'immagine dichiarata non interna' };
  if (hasLocalDeclaredImage(rootDir, normalized)) return { available: true, source: 'checkout' };
  try {
    await fetchDeclaredImageImpl({ imagePath: normalized, destination: null, fetchImpl });
    return { available: true, source: 'cdn' };
  } catch (error) {
    return { available: false, reason: error?.message || String(error) };
  }
}

function ghRepoArgs() {
  return process.env.GH_REPO ? ['--repo', process.env.GH_REPO] : [];
}

function ghJson(args) {
  const output = execFileSync('gh', [...args, ...ghRepoArgs()], { encoding: 'utf8' });
  return JSON.parse(output || 'null');
}

function defaultGithubClient() {
  return {
    async findOpenIssue() {
      const issues = ghJson(['issue', 'list', '--state', 'open', '--limit', '100', '--json', 'number,title,body,url']);
      return (Array.isArray(issues) ? issues : []).find((issue) => issue.title === OBSERVER_ISSUE_TITLE) || null;
    },
    async createIssue(description) {
      const { createGithubIssue } = await import('../lib/github-issue-creator.mjs');
      const created = await createGithubIssue({
        title: OBSERVER_ISSUE_TITLE,
        description,
        priority: 2,
        labels: ['bug', 'article-publication-lag'],
        workflow: 'article-publication-observer',
        exactTitle: true,
      });
      if (!created || created.persisted === false) throw new Error('issue observer non scritta');
      return this.findOpenIssue();
    },
    async editIssue(number, body) {
      execFileSync('gh', ['issue', 'edit', String(number), '--body', body, ...ghRepoArgs()], { encoding: 'utf8' });
    },
    async resolveIssue() {
      const { resolveGithubIssue } = await import('../lib/github-issue-creator.mjs');
      return resolveGithubIssue(OBSERVER_ISSUE_TITLE, {
        workflow: 'article-publication-observer',
        exactTitle: true,
      });
    },
    async getRun(runId) {
      return ghJson(['api', `repos/${process.env.GH_REPO}/actions/runs/${runId}`]);
    },
    async dispatch({ section, ids }) {
      const dispatchedAt = Date.now();
      const dispatchNonce = `observer-${randomUUID()}`;
      const runsBefore = ghJson([
        'run', 'list', '--workflow', DEFAULT_REPAIR_WORKFLOW, '--limit', '30',
        '--json', 'databaseId,status,conclusion,createdAt,event,headBranch,displayTitle',
      ]);
      const previousRunIds = new Set((Array.isArray(runsBefore) ? runsBefore : []).map((item) => String(item.databaseId)));
      const idsJson = JSON.stringify(ids);
      execFileSync('gh', [
        'workflow', 'run', DEFAULT_REPAIR_WORKFLOW,
        '-f', `article_ids=${idsJson}`,
        '-f', `section=${section}`,
        '-f', 'dry_run=false',
        '-f', `dispatch_nonce=${dispatchNonce}`,
        '--ref', 'main',
        ...ghRepoArgs(),
      ], { encoding: 'utf8' });
      // `gh workflow run` returns before the run is visible in Actions. The
      // unique run-name nonce is the identity fence; the pre-dispatch snapshot
      // prevents an old matching run from ever being selected. If Actions does
      // not expose an identifiable run, return null and leave the ledger
      // pending rather than guessing a concurrent dispatch.
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const runs = ghJson([
          'run', 'list', '--workflow', DEFAULT_REPAIR_WORKFLOW, '--limit', '30',
          '--json', 'databaseId,status,conclusion,createdAt,event,headBranch,displayTitle',
        ]);
        const run = (Array.isArray(runs) ? runs : [])
          .filter((item) => !previousRunIds.has(String(item.databaseId)))
          .filter((item) => item.event === 'workflow_dispatch' && item.headBranch === 'main')
          .filter((item) => String(item.displayTitle || '').includes(dispatchNonce))
          .filter((item) => Number.isFinite(Date.parse(item.createdAt)) && Date.parse(item.createdAt) >= dispatchedAt - 10_000)
          .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
        if (run?.databaseId) {
          return {
            runId: run.databaseId,
            dispatchNonce,
            dispatchedAt: new Date(dispatchedAt).toISOString(),
          };
        }
        await sleep(500);
      }
      return { runId: null, dispatchNonce, dispatchedAt: new Date(dispatchedAt).toISOString() };
    },
  };
}

async function reconcileDispatches(items, github) {
  if (typeof github.getRun !== 'function') return { items, handledKeys: new Set() };
  const runIds = new Set(items.filter((item) => item.status === 'in-flight' && item.runId).map((item) => item.runId));
  const outcomes = {};
  for (const runId of runIds) {
    const run = await github.getRun(runId);
    if (run?.status === 'completed') {
      for (const item of items) if (item.status === 'in-flight' && item.runId === String(runId)) {
        outcomes[ledgerKey(item)] = { status: 'completed', conclusion: run.conclusion };
      }
    }
  }
  return applyDispatchOutcomes(items, outcomes);
}

function saneLiveImage(entry) {
  const liveImage = normalizeImagePath(entry?.page?.ogImage);
  const registryImage = normalizeImagePath(entry?.target?.registryImage);
  return entry?.page?.status === 200
    && declaredImageIsOwn(entry.target.registryImage)
    && Boolean(liveImage && registryImage && liveImage === registryImage)
    && !isGenericOgImage(entry.page.rawHtml || '');
}

async function persistLedger(issue, items, github) {
  const body = upsertDegradationLedger(issue.body || '', items);
  if (body !== issue.body) {
    await github.editIssue(issue.number, body);
    issue.body = body;
  }
  return issue;
}

function parseArgs(argv) {
  const daysArg = argv.indexOf('--days');
  const days = daysArg >= 0 ? Number(argv[daysArg + 1]) : DEFAULT_LOOKBACK_DAYS;
  if (!Number.isFinite(days) || days <= 0 || days > 31) throw new Error('--days deve essere tra 1 e 31');
  return { days };
}

export async function runObserver({
  rootDir = ROOT,
  days = DEFAULT_LOOKBACK_DAYS,
  nowMs = Date.now(),
  fetchImpl = globalThis.fetch,
  fetchDeclaredImageImpl = fetchDeclaredImage,
  githubClient = null,
  repairCap = DEFAULT_REPAIR_CAP,
  gitLogImpl = gitText,
} = {}) {
  const since = new Date(nowMs - days * 24 * 60 * 60 * 1000).toISOString();
  const log = gitLogImpl([
    'log', '--first-parent', `--since=${since}`, '--format=commit %H %ct', '--name-only', '--diff-filter=AM', '--',
    'content/blog-body', 'content/blog-body-ch',
  ], rootDir);
  const changedBodies = parseChangedBodyLog(log);
  const sources = loadSources(rootDir);
  const github = githubClient || defaultGithubClient();
  let issue = await github.findOpenIssue();
  let ledger = issue ? parseDegradationLedger(issue.body || '').items : [];
  ledger = retainDegradationLedger(ledger, {
    nowMs,
    retentionDays: DEFAULT_LEDGER_RETENTION_DAYS,
    terminalRetentionDays: DEFAULT_TERMINAL_RETENTION_DAYS,
  });
  const prepared = buildObserverTargets({ changedBodies, ledgerItems: ledger, ...sources });
  const report = await observePublicationLag({ targets: prepared.targets, nowMs, fetchImpl });
  const description = formatObserverReport(report, { nowMs, skipped: prepared.skipped });
  const reconciled = await reconcileDispatches(ledger, github);
  ledger = reconciled.items;
  ledger = markLedgerItemsAbsent(ledger, prepared.missingLedgerKeys, new Date(nowMs).toISOString());
  ledger = retainDegradationLedger(ledger, {
    nowMs,
    retentionDays: DEFAULT_LEDGER_RETENTION_DAYS,
    terminalRetentionDays: DEFAULT_TERMINAL_RETENTION_DAYS,
  });
  const healthyKeys = report.checked.filter((entry) => entry.target.durable && saneLiveImage(entry)).map((entry) => ledgerKey(entry.target));
  ledger = removeHealthyItems(ledger, healthyKeys);
  ledger = mergeDegradedItems(
    ledger,
    report.degraded.map((entry) => ({
      section: entry.target.section,
      articleId: entry.target.articleId,
      url: entry.target.url,
      registryImage: entry.target.registryImage,
      firstSeenAt: new Date(entry.target.changedAt || nowMs).toISOString(),
    })),
    new Date(nowMs).toISOString(),
  );

  const readyKeys = new Set();
  for (const entry of report.degraded) {
    const key = ledgerKey(entry.target);
    const proof = await proveDeclaredImage({
      rootDir,
      imagePath: entry.target.registryImage,
      fetchImpl,
      fetchDeclaredImageImpl,
    });
    if (proof.available) readyKeys.add(key);
  }

  const actionable = report.lagging.length > 0 || report.degraded.length > 0 || ledger.length > 0;
  if (actionable && !issue) {
    issue = await github.createIssue(description);
    if (!issue) throw new Error('issue observer non trovata dopo la creazione');
    if (!issue.body) issue.body = description;
  }
  if (issue) await persistLedger(issue, ledger, github);

  const candidates = repairCandidates(ledger, {
    readyKeys,
    excludeKeys: reconciled.handledKeys,
    cap: repairCap,
  });
  const dispatched = [];
  if (issue && candidates.length > 0) {
    for (const group of groupRepairCandidates(candidates)) {
      const result = await github.dispatch({ section: group.section, ids: group.ids, issueNumber: issue.number });
      ledger = markDispatched(ledger, group.items.map((item) => ({
        key: ledgerKey(item),
        runId: result?.runId ?? null,
        dispatchedAt: result?.dispatchedAt,
      })));
      dispatched.push({ section: group.section, ids: group.ids, runId: result?.runId ?? null });
      await persistLedger(issue, ledger, github);
    }
  }

  let resolved = null;
  if (!report.lagging.length && !report.degraded.length && ledger.length === 0 && issue) {
    resolved = await github.resolveIssue();
  }
  return { ...report, issue, resolved, dispatched, ledger, changedBodies, skipped: prepared.skipped, description };
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  runObserver({ days: parseArgs(process.argv.slice(2)).days })
    .then((result) => {
      console.log(formatObserverReport(result, { skipped: result.skipped }));
      if (result.lagging.length === 0 && result.degraded.length === 0) console.log('Nessun ritardo o degrado oltre la finestra di grazia.');
    })
    .catch((error) => {
      console.error(`[article-publication-observer] fatal: ${error.message || error}`);
      process.exit(1);
    });
}
