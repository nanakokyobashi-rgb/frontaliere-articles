#!/usr/bin/env node

/**
 * Deterministic title fixer and live verifier for the corpus repository.
 *
 * Editorial copy is never invented by this loop. The policy contains the
 * approved replacement for each observed Bing finding, the source edit is
 * fail-closed, and the live audit requires the resulting title to start with
 * the approved source text (the site may append its brand when it fits).
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BING_TITLE_AUDIT_URLS,
  BING_TITLE_FIXES,
  BING_TITLE_MAX_CHARS,
} from './bing-seo-policy.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const USER_AGENT = 'frontaliere-bing-seo-corpus-loop/1.0 (+https://frontaliereticino.ch/)';
const REGEX_SPECIAL = /[\^$.*+?()[\]{}|]/g;

function escapeRegex(value) {
  return String(value).replace(REGEX_SPECIAL, '\\$&');
}

function escapeTsSingleQuote(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function decodeTsSingleQuote(value) {
  return String(value).replace(/\\([\\'])/g, '$1');
}

function decodeHtmlEntities(value) {
  return String(value || '')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(x[\da-f]+|\d+);/gi, (whole, rawCodePoint) => {
      const codePoint = rawCodePoint[0].toLowerCase() === 'x'
        ? Number.parseInt(rawCodePoint.slice(1), 16)
        : Number.parseInt(rawCodePoint, 10);
      return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : whole;
    });
}

function stripTags(value) {
  return decodeHtmlEntities(String(value || '').replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeUrl(value) {
  try {
    const url = new URL(value);
    url.hash = '';
    url.pathname = url.pathname.replace(/\/+/g, '/') || '/';
    if (url.pathname !== '/' && !url.pathname.endsWith('/')) url.pathname += '/';
    return url.toString();
  } catch {
    return String(value || '').trim();
  }
}

function extractHtmlContract(html) {
  const source = String(html || '');
  const title = stripTags(source.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '');
  let canonical = '';
  for (const match of source.matchAll(/<link\b[^>]*>/gi)) {
    const tag = match[0];
    const rel = tag.match(/\brel=["']([^"']+)["']/i)?.[1] || '';
    if (!rel.split(/\s+/).some((token) => token.toLowerCase() === 'canonical')) continue;
    canonical = tag.match(/\bhref=["']([^"']+)["']/i)?.[1] || '';
    if (canonical) break;
  }
  return { title, canonical };
}

function articleBlock(source, articleId) {
  const marker = "  '" + articleId + "': {";
  const start = source.indexOf(marker);
  if (start < 0) throw new Error('Entry non trovato: ' + articleId);
  const next = source.indexOf("\n  'blog-", start + marker.length);
  return {
    start,
    end: next < 0 ? source.length : next,
    text: source.slice(start, next < 0 ? source.length : next),
  };
}

function replaceSingleQuotedProperty(block, property, title) {
  const pattern = new RegExp(
    "(\\n\\s*" + property + ":\\s*)'((?:\\\\.|[^'])*)'",
    'm',
  );
  if (!pattern.test(block)) throw new Error('Proprietà non trovata: ' + property);
  return block.replace(pattern, (_match, prefix) => prefix + "'" + escapeTsSingleQuote(title) + "'");
}

function replaceHeadline(block, title) {
  const pattern = /(\n\s*"headline":\s*)"((?:\\.|[^"])*)"/m;
  if (!pattern.test(block)) throw new Error('Structured headline non trovato');
  return block.replace(pattern, (_match, prefix) => prefix + JSON.stringify(title));
}

function replaceSeoEntry(source, fix) {
  const block = articleBlock(source, fix.articleId);
  let nextBlock = block.text;
  nextBlock = replaceSingleQuotedProperty(nextBlock, 'title', fix.title);
  nextBlock = replaceSingleQuotedProperty(nextBlock, 'ogTitle', fix.title);
  nextBlock = replaceHeadline(nextBlock, fix.title);
  return source.slice(0, block.start) + nextBlock + source.slice(block.end);
}

function replaceMetaEntry(source, fix) {
  const key = escapeRegex(fix.metadataKey);
  const pattern = new RegExp(
    "(['\"]" + key + "['\"]:\\s*)'((?:\\\\.|[^'])*)'",
  );
  if (!pattern.test(source)) throw new Error('Metadata key non trovato: ' + fix.metadataKey);
  return source.replace(pattern, (_match, prefix) => prefix + "'" + escapeTsSingleQuote(fix.title) + "'");
}

function applyFixToSource(source, fix) {
  return fix.kind === 'seo'
    ? replaceSeoEntry(source, fix)
    : replaceMetaEntry(source, fix);
}

export function applyFixes({ repoRoot = REPO_ROOT } = {}) {
  const changedFiles = new Set();
  for (const fix of BING_TITLE_FIXES) {
    const absolutePath = resolve(repoRoot, fix.source);
    const source = readFileSync(absolutePath, 'utf8');
    const next = applyFixToSource(source, fix);
    if (next !== source) {
      writeFileSync(absolutePath, next);
      changedFiles.add(fix.source);
    }
  }
  return { changed: changedFiles.size > 0, files: [...changedFiles] };
}

function hasSeoTitle(block, title) {
  const escaped = escapeTsSingleQuote(title);
  return block.includes("title: '" + escaped + "'")
    && block.includes("ogTitle: '" + escaped + "'")
    && block.includes('"headline": ' + JSON.stringify(title));
}

export function checkSource({ repoRoot = REPO_ROOT } = {}) {
  const findings = [];
  const seenUrls = new Set();
  for (const fix of BING_TITLE_FIXES) {
    if (seenUrls.has(fix.url)) findings.push({ code: 'duplicate-url', url: fix.url });
    seenUrls.add(fix.url);
    if (fix.title.length > BING_TITLE_MAX_CHARS) {
      findings.push({
        code: 'policy-title-too-long',
        url: fix.url,
        detail: fix.title.length + ' > ' + BING_TITLE_MAX_CHARS,
      });
    }

    const absolutePath = resolve(repoRoot, fix.source);
    let source;
    try {
      source = readFileSync(absolutePath, 'utf8');
    } catch (error) {
      findings.push({ code: 'source-missing', file: fix.source, detail: error.message });
      continue;
    }

    try {
      if (fix.kind === 'seo') {
        if (!hasSeoTitle(articleBlock(source, fix.articleId).text, fix.title)) {
          findings.push({ code: 'source-title-drift', file: fix.source, url: fix.url });
        }
      } else {
        const expected = new RegExp(
          "['\"]" + escapeRegex(fix.metadataKey) + "['\"]:\\s*'((?:\\\\.|[^'])*)'",
        );
        const match = source.match(expected);
        if (!match || decodeTsSingleQuote(match[1]) !== fix.title) {
          findings.push({ code: 'source-title-drift', file: fix.source, url: fix.url });
        }
      }
    } catch (error) {
      findings.push({ code: 'source-entry-missing', file: fix.source, detail: error.message });
    }
  }
  return { ok: findings.length === 0, findings };
}

function finding(code, url, detail) {
  return { code, url, detail };
}

export async function auditLive({
  fetchImpl = globalThis.fetch,
  urls = BING_TITLE_AUDIT_URLS,
} = {}) {
  const byUrl = new Map(BING_TITLE_FIXES.map((fix) => [fix.url, fix]));
  const pages = [];
  const findings = [];

  for (const url of urls) {
    const fix = byUrl.get(url);
    try {
      const response = await fetchImpl(url, {
        headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml' },
        redirect: 'follow',
        signal: AbortSignal.timeout(30_000),
      });
      const html = await response.text();
      const contract = extractHtmlContract(html);
      const finalUrl = response.url || url;
      pages.push({
        url,
        status: response.status,
        finalUrl,
        title: contract.title,
        titleLength: contract.title.length,
        canonical: contract.canonical,
      });
      if (response.status !== 200) findings.push(finding('http-status', url, 'HTTP ' + response.status));
      if (!contract.title) findings.push(finding('title-missing', url, 'Manca il title'));
      if (contract.title.length > BING_TITLE_MAX_CHARS) {
        findings.push(finding(
          'title-too-long',
          url,
          contract.title.length + ' caratteri; limite ' + BING_TITLE_MAX_CHARS,
        ));
      }
      if (fix && !contract.title.startsWith(fix.title)) {
        findings.push(finding(
          'title-source-drift',
          url,
          'Title live non inizia con il valore approvato: ' + fix.title,
        ));
      }
      if (!contract.canonical) {
        findings.push(finding('canonical-missing', url, 'Manca il canonical'));
      } else if (normalizeUrl(contract.canonical) !== normalizeUrl(finalUrl)) {
        findings.push(finding('canonical-drift', url, contract.canonical + ' (URL finale: ' + finalUrl + ')'));
      }
    } catch (error) {
      pages.push({ url, status: 0, error: error?.message || String(error) });
      findings.push(finding('fetch-error', url, error?.message || String(error)));
    }
  }

  return {
    checkedAt: new Date().toISOString(),
    pages,
    findings,
    summary: {
      checked: pages.length,
      findings: findings.length,
      titlePages: urls.length,
    },
  };
}

function parseArg(name, args) {
  const prefix = '--' + name + '=';
  const inline = args.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = args.indexOf('--' + name);
  return index >= 0 ? args[index + 1] : '';
}

async function main() {
  const args = process.argv.slice(2);
  const reportPath = parseArg('report', args);
  const results = [];

  if (args.includes('--apply-fixes')) {
    results.push({ mode: 'apply-fixes', ...applyFixes() });
    const sourceCheck = checkSource();
    results.push({ mode: 'check-source', ...sourceCheck });
    if (!sourceCheck.ok) process.exitCode = 1;
  }

  if (args.includes('--check-source') && !args.includes('--apply-fixes')) {
    const sourceCheck = checkSource();
    results.push({ mode: 'check-source', ...sourceCheck });
    if (!sourceCheck.ok) process.exitCode = 1;
  }

  if (args.includes('--audit-live')) {
    const live = await auditLive();
    results.push({ mode: 'audit-live', ...live });
    if (reportPath) {
      mkdirSync(dirname(resolve(reportPath)), { recursive: true });
      writeFileSync(resolve(reportPath), JSON.stringify(live, null, 2) + '\n');
    }
    if (live.findings.length > 0) process.exitCode = 1;
  }

  if (results.length === 0) {
    console.error('Uso: node scripts/seo/bing-seo-loop.mjs --check-source | --apply-fixes | --audit-live [--report file]');
    process.exitCode = 2;
  } else {
    console.log(JSON.stringify(results, null, 2));
  }
}

const invokedDirectly = process.argv[1]
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) await main();
