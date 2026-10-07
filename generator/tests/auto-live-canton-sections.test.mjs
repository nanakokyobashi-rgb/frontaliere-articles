/**
 * Contratto offline del rollout automatico D22.
 *
 * Il test usa un checkout temporaneo per provare la transizione del registro:
 * nessun test scrive sections/registry.json del worktree e nessuna rete e'
 * necessaria. La fetch iniettata emula il CDN R2 con le cinque alternate
 * canoniche che il publisher deve avere gia' caricato.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import '../../host/cantonSectionsBootstrap.mjs';
import {
  applyRegistryTransitions,
  expectedSectionPages,
  planSections,
  probeSectionPages,
} from '../../scripts/ci/auto-live-canton-sections.mjs';
import { CORPUS_ROUTE_OWNER_META_TAG } from '../../engine/shared/corpusRouteOwner.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const WORKFLOW = fs.readFileSync(path.join(ROOT, '.github/workflows/auto-live-canton-sections.yml'), 'utf8');
const TOPICS = ['carburanti', 'fisco', 'mobilita', 'eventi', 'pensioni', 'servizi'];
const LOCALES = ['it', 'en', 'de', 'fr'];

function identity(page) {
  return [page.kind, page.topic || '', page.id || ''].join('|');
}

function alternateHtml(page, pages, { wrongRouteOwner = false } = {}) {
  const targets = pages.filter((candidate) => identity(candidate) === identity(page));
  const byLocale = new Map(targets.map((candidate) => [candidate.locale, candidate.path]));
  const links = [...LOCALES.map((locale) => [locale, byLocale.get(locale)]), ['x-default', byLocale.get('it')]]
    .map(([locale, target]) => `<link rel="alternate" hreflang="${locale}" href="https://frontaliereticino.ch${target}">`)
    .join('');
  return [
    `<link rel="canonical" href="https://frontaliereticino.ch${page.path}">`,
    links,
    '<meta name="robots" content="index,follow">',
    wrongRouteOwner ? '<meta name="ft-route-owner" content="canton-section">' : CORPUS_ROUTE_OWNER_META_TAG,
  ].join('');
}

function mockCdnFetch(pages, { badPath = null, wrongRouteOwner = false, calls = null } = {}) {
  return async (url, options = {}) => {
    calls?.push({ url, headers: options.headers });
    const pagePath = new URL(url).pathname
      .replace(/^\/edge\/sections/u, '')
      .replace(/index\.html$/u, '');
    const page = pages.find((candidate) => candidate.path === pagePath);
    assert.ok(page, `pagina CDN non prevista: ${pagePath}`);
    if (page.path === badPath) {
      return { status: 200, text: async () => `${alternateHtml(page, pages, { wrongRouteOwner })}<meta name="robots" content="noindex">` };
    }
    return { status: 200, text: async () => alternateHtml(page, pages, { wrongRouteOwner }) };
  };
}

function fixtureRoot({ status = 'draft', invalidHub = null, extraMetaCount = 0, extraSlugCount = 0, malformedSlugs = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'frontaliere-auto-live-'));
  fs.mkdirSync(path.join(root, 'sections'), { recursive: true });
  fs.mkdirSync(path.join(root, 'content/cantons/canton-lu'), { recursive: true });
  fs.mkdirSync(path.join(root, 'content/blog-body-canton-lu'), { recursive: true });

  const registryDocument = JSON.parse(fs.readFileSync(path.join(ROOT, 'sections/registry.json'), 'utf8'));
  registryDocument.sections['canton-lu'].status = status;
  fs.writeFileSync(path.join(root, 'sections/registry.json'), `${JSON.stringify(registryDocument, null, 2)}\n`);
  fs.writeFileSync(path.join(root, 'content/cantons/canton-lu/registry.ts'), `export const CANTON_ARTICLES = [
  { id: 'auto-live-fixture', category: 'pratico', date: '2026-10-07', image: '', hasCalculator: false, articleType: 'news' },
];\n`);
  fs.writeFileSync(path.join(root, 'content/cantons/canton-lu/slugs.ts'), `const CANTON_SLUGS = {
  'auto-live-fixture': { it: 'auto-live-fixture-it', en: 'auto-live-fixture-en', de: 'auto-live-fixture-de', fr: 'auto-live-fixture-fr' },
};\n`);
  if (extraSlugCount > 0) {
    const extra = Array.from({ length: extraSlugCount }, (_, index) =>
      `  'auto-live-slug-only-${index}': { it: 'auto-live-slug-only-${index}-it', en: 'auto-live-slug-only-${index}-en', de: 'auto-live-slug-only-${index}-de', fr: 'auto-live-slug-only-${index}-fr' },\n`).join('');
    fs.writeFileSync(path.join(root, 'content/cantons/canton-lu/slugs.ts'), `const CANTON_SLUGS = {\n  'auto-live-fixture': { it: 'auto-live-fixture-it', en: 'auto-live-fixture-en', de: 'auto-live-fixture-de', fr: 'auto-live-fixture-fr' },\n${extra}};\n`);
  }
  if (extraMetaCount > 0) {
    fs.mkdirSync(path.join(root, 'content'), { recursive: true });
    const extra = Array.from({ length: extraMetaCount }, (_, index) =>
      `  'blog.article.auto-live-extra-${index}.title': 'Extra ${index}',\\n`).join('');
    fs.writeFileSync(path.join(root, 'content/blog-meta-canton-lu-it.ts'), `export default {\\n${extra}};\\n`);
  }
  if (malformedSlugs) fs.writeFileSync(path.join(root, 'content/cantons/canton-lu/slugs.ts'), 'const CANTON_SLUGS = {;\\n');
  for (const locale of LOCALES) {
    fs.mkdirSync(path.join(root, `content/blog-body-canton-lu/${locale}`), { recursive: true });
    fs.writeFileSync(path.join(root, `content/blog-body-canton-lu/${locale}/auto-live-fixture.ts`), 'export default {};\n');
  }
  for (const topic of TOPICS) {
    const target = path.join(root, `content/cantons/canton-lu/hubs/${topic}.json`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const source = path.join(ROOT, `content/cantons/canton-lu/hubs/${topic}.json`);
    fs.copyFileSync(source, target);
    if (topic === invalidHub) fs.writeFileSync(target, '{"schemaVersion":1}\n');
  }
  return root;
}

test('il piano conta le superfici canoniche per tutte le locali e l articolo proprio', () => {
  const root = fixtureRoot();
  const pages = expectedSectionPages('canton-lu', { root });
  assert.equal(pages.length, 36);
  assert.equal(pages.filter((page) => page.kind === 'landing').length, 4);
  assert.equal(pages.filter((page) => page.kind === 'hub').length, 24);
  assert.equal(pages.filter((page) => page.kind === 'archive').length, 4);
  assert.equal(pages.filter((page) => page.kind === 'article').length, 4);
  assert.ok(pages.some((page) => page.path === '/articoli-lucerna/auto-live-fixture-it/'));
});

test('il piano include tutte le pagine archivio paginate del renderer', () => {
  const root = fixtureRoot({ extraMetaCount: 99, extraSlugCount: 2 });
  const pages = expectedSectionPages('canton-lu', { root });
  assert.equal(pages.length, 40);
  assert.equal(pages.filter((page) => page.kind === 'archive').length, 8);
  assert.ok(pages.some((page) => page.path === '/articoli-lucerna/tutti/page-2/' && page.page === 2));
});

test('la verifica CDN richiede 200, canonical, hreflang reciproci, route owner e niente noindex', async () => {
  const root = fixtureRoot();
  const pages = expectedSectionPages('canton-lu', { root });
  const calls = [];
  const good = await probeSectionPages('canton-lu', { root, fetchImpl: mockCdnFetch(pages, { calls }), retryDelayMs: 0 });
  assert.equal(good.checked, 36);
  assert.deepEqual(good.missing, []);
  assert.deepEqual(good.bad, []);
  assert.equal(calls.length, 72);
  assert.ok(calls.some((call) => /_auto_live=/u.test(call.url) && !call.headers?.Origin));
  assert.ok(calls.some((call) => /_auto_live=/u.test(call.url) && call.headers?.Origin === 'https://frontaliereticino.ch'));

  const bad = await probeSectionPages('canton-lu', {
    root,
    fetchImpl: mockCdnFetch(pages, { badPath: '/articoli-lucerna/' }),
    retryDelayMs: 0,
  });
  assert.deepEqual(bad.missing, []);
  assert.deepEqual(bad.bad, [{ path: '/articoli-lucerna/', problems: ['noindex'] }]);

  const wrongOwner = await probeSectionPages('canton-lu', {
    root,
    fetchImpl: mockCdnFetch(pages, { wrongRouteOwner: true }),
    retryDelayMs: 0,
  });
  assert.deepEqual(wrongOwner.missing, []);
  assert.equal(wrongOwner.bad.length, 36);
  assert.ok(wrongOwner.bad.every((entry) => entry.problems.includes('ft-route-owner')));
});

test('hub mancante/corrotto non passa il gate e il flip pronto e\' idempotente', async () => {
  const incomplete = fixtureRoot({ invalidHub: 'fisco' });
  const report = await planSections(incomplete, {
    mode: 'promote',
    sections: ['canton-lu'],
    probe: false,
  });
  assert.equal(report.sections[0].reason, 'hubs-invalid');
  assert.deepEqual(report.readySections, []);

  const root = fixtureRoot();
  const pages = expectedSectionPages('canton-lu', { root });
  const fetchImpl = mockCdnFetch(pages);
  const promoted = await applyRegistryTransitions(root, {
    mode: 'promote',
    sections: ['canton-lu'],
    requireReady: true,
    fetchImpl,
    retryDelayMs: 0,
  });
  assert.deepEqual(promoted.changed, ['canton-lu']);
  const second = await applyRegistryTransitions(root, {
    mode: 'promote',
    sections: ['canton-lu'],
    requireReady: true,
    fetchImpl,
  });
  assert.deepEqual(second.changed, []);
  const rolledBack = await applyRegistryTransitions(root, {
    mode: 'rollback',
    sections: ['canton-lu'],
    requireReady: true,
  });
  assert.deepEqual(rolledBack.changed, ['canton-lu']);
});

test('il rollback live e\' indipendente da una mappa slug corrotta', async () => {
  const root = fixtureRoot({ status: 'live', malformedSlugs: true });
  const plan = await planSections(root, { mode: 'rollback', sections: ['canton-lu'], probe: true });
  assert.deepEqual(plan.readySections, ['canton-lu']);
  assert.equal(plan.sections[0].reason, null);
});

test('workflow D22 usa cron/dispatch, lancia refresh e bootstrap, crea solo PR e supporta rollback', () => {
  assert.match(WORKFLOW, /cron: '37 9 \* \* \*'/u);
  assert.match(WORKFLOW, /workflow_dispatch:/u);
  assert.match(WORKFLOW, /workflow_run:/u);
  assert.match(WORKFLOW, /gh workflow run refresh-canton-hubs\.yml/u);
  assert.match(WORKFLOW, /gh workflow run fast-publish-section\.yml/u);
  assert.match(WORKFLOW, /node scripts\/ci\/auto-live-canton-sections\.mjs "\$\{args\[@\]\}"/u);
  assert.match(WORKFLOW, /node scripts\/ci\/auto-live-canton-sections\.mjs apply/u);
  assert.match(WORKFLOW, /gh pr create/u);
  assert.match(WORKFLOW, /gh pr merge [^\n]*--auto --squash/u);
  assert.match(WORKFLOW, /mode:\s*\n[\s\S]*options: \[promote, rollback\]/u);
  assert.match(WORKFLOW, /## Implementato/u);
  assert.match(WORKFLOW, /## Non implementato \(ancora\)/u);
  assert.match(WORKFLOW, /git push origin "HEAD:\$branch"/u);
  assert.doesNotMatch(WORKFLOW, /HEAD:main|git push --force|git push -f/u);
});
