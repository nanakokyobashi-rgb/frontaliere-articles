#!/usr/bin/env node
/**
 * Read-only observer for the two Pages article publishers.
 *
 * It samples only Italian article pages whose body changed recently on corpus
 * main. Publication lag is measured with dateModified versus the registry's
 * updatedAt; image degradation is a separate signal based on og:image versus
 * the registry image. The network loop is deliberately sequential and
 * rate-limited because this is a courtesy check, not a crawler.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { declaredImageIsOwn, extractOgImage, isGenericOgImage } from '../lib/article-image-postcondition.mjs';

export const OBSERVER_ISSUE_TITLE = 'Article publication lag (corpus → site)';
export const DEFAULT_LOOKBACK_DAYS = 7;
export const DEFAULT_STALE_MINUTES = 60;
export const DEFAULT_MAX_PAGES = 300;
export const DEFAULT_MIN_INTERVAL_MS = 500;
export const SITE_BASE_URL = 'https://frontaliereticino.ch';
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

export function buildObserverTargets({ changedBodies, registrySources, slugSources, baseUrl = SITE_BASE_URL }) {
  const targets = [];
  const skipped = [];
  for (const change of changedBodies) {
    const registry = parseRegistryRecord(registrySources[change.section] || '', change.articleId);
    const slug = parseItalianSlug(slugSources[change.section] || '', change.articleId);
    if (!registry || !slug) {
      skipped.push({ ...change, reason: !registry ? 'registro non trovato' : 'slug italiano non trovato' });
      continue;
    }
    targets.push({
      ...change,
      url: `${String(baseUrl).replace(/\/+$/, '')}/${change.section === 'svizzera' ? 'articoli-svizzera' : 'articoli-frontaliere'}/${slug}/`,
      sourceCommit: change.commit,
      sourceUpdatedAt: registry.updatedAt,
      registryDate: registry.date,
      registryImage: registry.image,
    });
  }
  return { targets, skipped };
}

function parseAttrs(tag) {
  const attrs = {};
  for (const match of String(tag).matchAll(/([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    attrs[String(match[1]).toLowerCase()] = match[2] ?? match[3] ?? '';
  }
  return attrs;
}

export function parsePageObservation(html, status = 200) {
  let modifiedAt = null;
  for (const match of String(html).matchAll(/<meta\b[^>]*\/?\s*>/gi)) {
    const attrs = parseAttrs(match[0]);
    const name = String(attrs.name || '').toLowerCase();
    const property = String(attrs.property || '').toLowerCase();
    const content = String(attrs.content || '');
    if (name === 'datemodified' || property === 'article:modified_time') modifiedAt ||= content;
  }
  modifiedAt ||= String(html).match(/"dateModified"\s*:\s*"([^"]+)"/)?.[1] || null;
  return { status, modifiedAt, ogImage: extractOgImage(html), rawHtml: String(html) };
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
 * A date-only registry value is rendered as local midnight (measured:
 * `2026-09-25` → `2026-09-25T00:00:00+01:00`), so the page is current from the
 * earliest instant that day starts in Europe/Zurich. A full timestamp is
 * written by the renderer in whole seconds (`03:49:10.833Z` → `03:49:11`).
 */
export function pageHasCaughtUp(pageModifiedAt, registryDate) {
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

  const reference = registryReferenceDate(target);
  if (!reference) {
    // Nothing to compare with is not a lag: the page answered and the image
    // signal above still applies.
    return { lagging: false, degraded, reason: 'registro senza data: confronto saltato', degradationReason };
  }
  if (!page.modifiedAt) {
    return { lagging: true, degraded, reason: 'pagina senza dateModified', degradationReason };
  }
  const caughtUp = pageHasCaughtUp(page.modifiedAt, reference);
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

function parseArgs(argv) {
  const daysArg = argv.indexOf('--days');
  const days = daysArg >= 0 ? Number(argv[daysArg + 1]) : DEFAULT_LOOKBACK_DAYS;
  if (!Number.isFinite(days) || days <= 0 || days > 31) throw new Error('--days deve essere tra 1 e 31');
  return { days };
}

export async function runObserver({ rootDir = ROOT, days = DEFAULT_LOOKBACK_DAYS, nowMs = Date.now() } = {}) {
  const since = new Date(nowMs - days * 24 * 60 * 60 * 1000).toISOString();
  const log = gitText([
    'log', '--first-parent', `--since=${since}`, '--format=commit %H %ct', '--name-only', '--diff-filter=AM', '--',
    'content/blog-body', 'content/blog-body-ch',
  ], rootDir);
  const changedBodies = parseChangedBodyLog(log);
  const sources = loadSources(rootDir);
  const prepared = buildObserverTargets({ changedBodies, ...sources });
  const report = await observePublicationLag({ targets: prepared.targets, nowMs });
  const description = formatObserverReport(report, { nowMs, skipped: prepared.skipped });

  const { createGithubIssue, resolveGithubIssue } = await import('../lib/github-issue-creator.mjs');
  if (report.lagging.length > 0 || report.degraded.length > 0) {
    const issue = await createGithubIssue({
      title: OBSERVER_ISSUE_TITLE,
      description,
      priority: 2,
      labels: ['bug', 'article-publication-lag'],
      workflow: 'article-publication-observer',
      exactTitle: true,
    });
    if (!issue || issue.persisted === false) throw new Error('issue observer non scritta');
    return { ...report, issue, changedBodies, skipped: prepared.skipped };
  }
  const resolved = resolveGithubIssue(OBSERVER_ISSUE_TITLE, {
    workflow: 'article-publication-observer',
    exactTitle: true,
  });
  return { ...report, resolved, changedBodies, skipped: prepared.skipped };
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
