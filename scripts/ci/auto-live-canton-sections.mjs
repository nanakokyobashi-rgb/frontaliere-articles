#!/usr/bin/env node
/**
 * auto-live-canton-sections.mjs — piano idempotente del primo articolo.
 * Il modulo è deliberatamente privo di mutazioni GitHub e di credenziali.
 *
 * La workflow schedulata usa questo modulo per controllare le sezioni cantonali
 * ancora `draft`, chiedere refresh/bootstrap quando una superficie manca e
 * modificare il registro soltanto su un branch PR. Il modulo non conosce
 * credenziali e non pusha mai: le mutazioni GitHub restano nella workflow.
 */
import '../../host/cantonSectionsBootstrap.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ARTICLE_SECTION_CORE_ALL } from '../../engine/shared/articleSectionCore.mjs';
import { CANTON_HUB_TOPIC_KEYS } from '../../engine/shared/cantonArticleSectionCore.generated.mjs';
import { CANTON_ARCHIVE_ALL_SLUG } from '../../engine/shared/cantonSectionCopy.mjs';
import { parseArticleUrlSlugs } from '../../engine/shared/articleReaderSource.mjs';
import { cantonSectionPaths, cantonSectionProfile } from '../../generator/scripts/lib/canton-section-profile.mjs';
import { corpusPath } from '../../generator/scripts/lib/corpus-paths.mjs';
import { readRegistryEntries } from '../../generator/scripts/lib/registry-article-type.mjs';
import { cantonHubDataFile, readCantonHubData } from '../../scripts/lib/canton-hub-data.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const LOCALES = Object.freeze(['it', 'en', 'de', 'fr']);
const SITE_BASE = 'https://frontaliereticino.ch';
const CDN_BASE = 'https://cdn.frontaliereticino.ch/edge/sections';
const MODES = new Set(['promote', 'rollback']);

const readJson = (root, rel) => JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
const exists = (root, rel) => fs.existsSync(path.join(root, rel));

function normalizeBase(value, fallback) {
  const raw = String(value || fallback).trim();
  return raw.replace(/\/+$/u, '');
}

export function normalizeSections(raw) {
  return [...new Set(String(raw || '')
    .split(/[\s,;]+/u)
    .map((item) => item.trim())
    .filter(Boolean))];
}

function registryDocument(root) {
  const doc = readJson(root, 'sections/registry.json');
  if (!doc || typeof doc !== 'object' || !doc.sections || typeof doc.sections !== 'object') {
    throw new Error('sections/registry.json: documento senza sections');
  }
  return doc;
}

function sectionEntry(root, section) {
  const core = ARTICLE_SECTION_CORE_ALL[section];
  if (!core || core.kind !== 'canton') throw new Error(`sezione cantonale sconosciuta: ${section}`);
  const entry = registryDocument(root).sections[section];
  if (!entry) throw new Error(`sections/registry.json: manca ${section}`);
  return { core, entry, profile: cantonSectionProfile(section) };
}

function ownArticleData(root, section) {
  const surfaces = cantonSectionPaths(section);
  const registryFile = corpusPath(surfaces.registryFile);
  const slugFile = corpusPath(surfaces.slugDataFile);
  const registrySource = exists(root, registryFile) ? fs.readFileSync(path.join(root, registryFile), 'utf8') : '';
  const entries = readRegistryEntries(registrySource);
  const slugSource = exists(root, slugFile) ? fs.readFileSync(path.join(root, slugFile), 'utf8') : '';
  let slugs = {};
  if (slugSource) {
    try {
      slugs = parseArticleUrlSlugs(slugSource, 'CANTON_SLUGS');
    } catch (error) {
      throw new Error(`${slugFile}: mappa slug illeggibile: ${error.message}`);
    }
  }
  const articleIds = [...new Set(entries.map((entry) => entry.id).filter(Boolean))];
  const missingSlugs = articleIds.filter((id) => !slugs[id] || LOCALES.some((locale) => !slugs[id][locale]));
  const bodyDir = corpusPath(`services/locales/${surfaces.bodyDir}`);
  const missingBodies = articleIds.flatMap((id) => LOCALES
    .filter((locale) => !exists(root, `${bodyDir}/${locale}/${id}.ts`))
    .map((locale) => `${bodyDir}/${locale}/${id}.ts`));
  return { registryFile, slugFile, bodyDir, articleIds, slugs, missingSlugs, missingBodies };
}

function sectionPrefix(core, locale) {
  return locale === 'it' ? `/${core.indexSlug.it}` : `/${locale}/${core.indexSlug[locale]}`;
}

function pageIdentity(page) {
  return [page.kind, page.topic || '', page.id || ''].join('|');
}

export function expectedSectionPages(section, { root = process.cwd(), includeArticles = true } = {}) {
  const { core } = sectionEntry(root, section);
  const own = ownArticleData(root, section);
  const pages = [];
  for (const locale of LOCALES) {
    const prefix = sectionPrefix(core, locale);
    pages.push({ kind: 'landing', locale, path: `${prefix}/` });
    for (const topic of CANTON_HUB_TOPIC_KEYS) {
      pages.push({ kind: 'hub', topic, locale, path: `${prefix}/${core.topicHubs[topic][locale]}/` });
    }
    pages.push({ kind: 'archive', locale, path: `${prefix}/${CANTON_ARCHIVE_ALL_SLUG[locale]}/` });
    if (includeArticles) {
      for (const id of own.articleIds) {
        const slug = own.slugs[id]?.[locale];
        if (slug) pages.push({ kind: 'article', id, locale, path: `${prefix}/${slug}/` });
      }
    }
  }
  return pages;
}

function htmlAttribute(tag, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const match = new RegExp(`\\b${escaped}\\s*=\\s*["']([^"']*)["']`, 'iu').exec(tag);
  return match?.[1] ?? null;
}

export function htmlPageProblems(html, page, siteBase, pagesByIdentity = new Map()) {
  const problems = [];
  const tags = [...String(html).matchAll(/<link\b[^>]*>/giu)].map((match) => match[0]);
  const canonical = tags
    .filter((tag) => htmlAttribute(tag, 'rel')?.toLowerCase() === 'canonical')
    .map((tag) => htmlAttribute(tag, 'href'))
    .find(Boolean);
  const expectedCanonical = `${siteBase}${page.path}`;
  if (canonical !== expectedCanonical) problems.push('canonical');
  const alternates = tags
    .filter((tag) => htmlAttribute(tag, 'rel')?.toLowerCase() === 'alternate' && htmlAttribute(tag, 'hreflang'))
    .map((tag) => ({
      locale: htmlAttribute(tag, 'hreflang'),
      href: htmlAttribute(tag, 'href'),
    }));
  const alternateByLocale = new Map(alternates.map((alternate) => [alternate.locale, alternate.href]));
  const alternateTargets = new Map(
    (pagesByIdentity.get(pageIdentity(page)) || []).map((target) => [target.locale, `${siteBase}${target.path}`]),
  );
  alternateTargets.set('x-default', alternateTargets.get('it'));
  for (const locale of [...LOCALES, 'x-default']) {
    if (!alternateByLocale.has(locale) || alternateByLocale.get(locale) !== alternateTargets.get(locale)) {
      problems.push(`hreflang:${locale}`);
    }
  }
  if (!/ft-route-owner/iu.test(html)) problems.push('ft-route-owner');
  if (/<meta\b[^>]*(?:name\s*=\s*["']robots["'][^>]*content\s*=\s*["'][^"']*noindex|content\s*=\s*["'][^"']*noindex[^"']*["'][^>]*name\s*=\s*["']robots["'])/iu.test(html)) {
    problems.push('noindex');
  }
  return problems;
}

function cdnPageUrl(pagePath, cdnBase) {
  const clean = pagePath.replace(/^\/+|\/+$/gu, '');
  return `${cdnBase}/${clean}/index.html`;
}

export async function probeSectionPages(section, {
  root = process.cwd(),
  siteBase = SITE_BASE,
  cdnBase = CDN_BASE,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch non disponibile per la verifica R2');
  const pages = expectedSectionPages(section, { root });
  const pagesByIdentity = new Map();
  for (const page of pages) {
    const key = pageIdentity(page);
    if (!pagesByIdentity.has(key)) pagesByIdentity.set(key, []);
    pagesByIdentity.get(key).push(page);
  }
  const results = await Promise.all(pages.map(async (page) => {
    const url = cdnPageUrl(page.path, normalizeBase(cdnBase, CDN_BASE));
    try {
      const response = await fetchImpl(url, { redirect: 'manual' });
      const html = await response.text();
      const problems = response.status === 200
        ? htmlPageProblems(html, page, normalizeBase(siteBase, SITE_BASE), pagesByIdentity)
        : [`http:${response.status}`];
      return { ...page, url, status: response.status, problems };
    } catch (error) {
      return { ...page, url, status: 0, problems: [`fetch:${error.message}`] };
    }
  }));
  return {
    state: 'ready',
    checked: results.length,
    missing: results.filter((result) => result.status !== 200).map((result) => result.path),
    bad: results.filter((result) => result.status === 200 && result.problems.length > 0)
      .map((result) => ({ path: result.path, problems: result.problems })),
  };
}

function hubCoverage(root, section) {
  const missing = [];
  const invalid = [];
  for (const topic of CANTON_HUB_TOPIC_KEYS) {
    const rel = cantonHubDataFile(section, topic);
    try {
      if (!readCantonHubData(root, section, topic)) missing.push(rel);
    } catch (error) {
      invalid.push(`${rel}: ${error.message}`);
    }
  }
  return { missing, invalid };
}

function initialReport(root, section, mode) {
  const { core, entry, profile } = sectionEntry(root, section);
  const own = ownArticleData(root, section);
  const hubs = hubCoverage(root, section);
  const status = entry.status;
  const enabled = profile.enabled === true;
  const report = {
    section,
    canton: core.canton,
    enabled,
    status,
    ownArticleIds: own.articleIds,
    missingSlugs: own.missingSlugs,
    missingBodies: own.missingBodies,
    hubs: { required: CANTON_HUB_TOPIC_KEYS.length, ...hubs },
    r2: { state: 'not-probed', checked: 0, missing: [], bad: [] },
    ready: false,
    reason: null,
  };
  if (!enabled) report.reason = 'profile-disabled';
  else if (mode === 'promote' && status !== 'draft') report.reason = `status-${status}`;
  else if (mode === 'rollback' && status !== 'live') report.reason = `status-${status}`;
  else if (mode === 'promote' && own.articleIds.length === 0) report.reason = 'no-own-article';
  else if (mode === 'promote' && own.missingSlugs.length > 0) report.reason = 'article-slug-missing';
  else if (mode === 'promote' && own.missingBodies.length > 0) report.reason = 'article-body-missing';
  else if (mode === 'promote' && hubs.missing.length > 0) report.reason = 'hubs-missing';
  else if (mode === 'promote' && hubs.invalid.length > 0) report.reason = 'hubs-invalid';
  return report;
}

export async function planSections(root = process.cwd(), {
  mode = 'promote',
  sections = [],
  siteBase = SITE_BASE,
  cdnBase = CDN_BASE,
  probe = true,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!MODES.has(mode)) throw new Error(`mode non valido: ${mode}`);
  const doc = registryDocument(root);
  const requested = normalizeSections(sections);
  const ids = requested.length > 0
    ? requested
    : Object.keys(doc.sections).filter((id) => ARTICLE_SECTION_CORE_ALL[id]?.kind === 'canton');
  const reports = [];
  for (const section of ids) {
    const report = initialReport(root, section, mode);
    if (mode === 'rollback') {
      report.ready = report.reason === null;
      reports.push(report);
      continue;
    }
    if (report.reason === null && probe) {
      report.r2 = await probeSectionPages(section, { root, siteBase, cdnBase, fetchImpl });
      if (report.r2.missing.length > 0) report.reason = 'r2-pages-missing';
      else if (report.r2.bad.length > 0) report.reason = 'r2-pages-invalid';
      else report.ready = true;
    }
    reports.push(report);
  }
  return { mode, sections: reports, readySections: reports.filter((report) => report.ready).map((report) => report.section) };
}

export async function applyRegistryTransitions(root = process.cwd(), {
  mode = 'promote',
  sections = [],
  requireReady = false,
  siteBase = SITE_BASE,
  cdnBase = CDN_BASE,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!MODES.has(mode)) throw new Error(`mode non valido: ${mode}`);
  const ids = normalizeSections(sections).filter(Boolean);
  if (ids.length === 0) return { changed: [], plan: { mode, sections: [], readySections: [] } };
  const file = path.join(root, 'sections/registry.json');
  const doc = registryDocument(root);
  const expected = mode === 'promote' ? 'draft' : 'live';
  const next = mode === 'promote' ? 'live' : 'draft';
  const toChange = [];
  for (const section of ids) {
    const entry = doc.sections[section];
    if (!entry || ARTICLE_SECTION_CORE_ALL[section]?.kind !== 'canton') throw new Error(`sezione non presente nel registro: ${section}`);
    if (entry.status === next) continue;
    if (entry.status !== expected) throw new Error(`${section}: atteso status ${expected}, trovato ${entry.status}`);
    toChange.push(section);
  }
  const plan = requireReady && toChange.length > 0
    ? await planSections(root, { mode, sections: toChange, siteBase, cdnBase, probe: mode === 'promote', fetchImpl })
    : null;
  if (requireReady && toChange.length > 0 && plan.readySections.length !== toChange.length) {
    throw new Error(`transizione non pronta: ${plan.sections.filter((report) => !report.ready).map((report) => `${report.section}:${report.reason}`).join(', ')}`);
  }
  const changed = [];
  for (const section of toChange) {
    const entry = doc.sections[section];
    entry.status = next;
    changed.push(section);
  }
  if (changed.length > 0) fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
  return { changed, plan };
}

function parseArgs(argv) {
  const [command = 'plan', ...rest] = argv;
  const options = { command, mode: 'promote', sections: [], probe: true, json: false, requireReady: false };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '--mode') options.mode = rest[++i];
    else if (arg === '--sections') options.sections = normalizeSections(rest[++i]);
    else if (arg === '--site-base') options.siteBase = rest[++i];
    else if (arg === '--cdn-base') options.cdnBase = rest[++i];
    else if (arg === '--no-probe') options.probe = false;
    else if (arg === '--require-ready') options.requireReady = true;
    else if (arg === '--json') options.json = true;
    else throw new Error(`argomento sconosciuto: ${arg}`);
  }
  if (!['plan', 'apply'].includes(options.command)) throw new Error('uso: auto-live-canton-sections.mjs plan|apply');
  return options;
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.command === 'plan') {
    const result = await planSections(process.cwd(), options);
    console.log(options.json ? JSON.stringify(result) : JSON.stringify(result, null, 2));
    return;
  }
  const result = await applyRegistryTransitions(process.cwd(), options);
  console.log(options.json ? JSON.stringify(result) : JSON.stringify(result, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`::error::auto-live-canton-sections: ${error.message}`);
    process.exitCode = 1;
  });
}
