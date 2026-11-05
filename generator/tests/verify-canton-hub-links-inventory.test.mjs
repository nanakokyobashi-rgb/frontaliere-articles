import '../../host/cantonSectionsBootstrap.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CANTON_HUB_TOPIC_KEYS } from '../../engine/shared/cantonArticleSectionCore.generated.mjs';
import { buildHubLinks, jobsPagePath } from '../scripts/lib/canton-hubs/links.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const origin = 'https://hub-inventory.example';
const locales = ['it', 'en', 'de', 'fr'];
const catalogue = JSON.parse(readFileSync(new URL('../data/canton-hub-links.json', import.meta.url), 'utf8'));
const cantonUrlSlugs = JSON.parse(readFileSync(new URL('../data/canton-url-slugs.json', import.meta.url), 'utf8'));
const jobs = locales.map((locale) => jobsPagePath('TI', locale, cantonUrlSlugs));
const paths = [...new Set(CANTON_HUB_TOPIC_KEYS.flatMap((topic) => locales.flatMap((locale) =>
  buildHubLinks({ canton: 'TI', topic, locale, catalogue, cantonUrlSlugs }).map((link) => link.url),
)))];
const locs = (urls) => urls.map((url) => `<loc>${origin}${url}</loc>`).join('');

function verify(missingJob = null) {
  // Exercise the real CLI with a sitemap inventory shaped like the producer:
  // the four TI job roots live only in sitemap-jobs.xml. No network is used.
  const documents = {
    [`${origin}/sitemap.xml`]: `<sitemapindex>${locs(['/sitemap-pages.xml', '/sitemap-jobs.xml'])}</sitemapindex>`,
    [`${origin}/sitemap-pages.xml`]: `<urlset>${locs(paths.filter((path) => !jobs.includes(path)))}</urlset>`,
    [`${origin}/sitemap-jobs.xml`]: `<urlset>${locs(jobs.filter((path) => path !== missingJob))}</urlset>`,
  };
  const script = `
    import fs from 'node:fs';
    import path from 'node:path';
    import { sectionSourceSurfaces } from './scripts/lib/corpus-sections.mjs';
    const source = sectionSourceSurfaces('frontaliere');
    const files = new Map([
      [source.registryFile, "export const ARTICLES = [\\n  {\\n    id: 'fixture-news',\\n    date: '2026-11-01',\\n  },\\n];"],
      [source.slugFile, "const " + source.slugExport + " = { 'fixture-news': { it: 'fixture-news', en: 'fixture-news', de: 'fixture-news', fr: 'fixture-news' } };"],
      ...${JSON.stringify(locales)}.map(locale => [source.metaFile(locale), "const meta = { 'blog.article.fixture-news.title': 'Fixture news' }; export default meta;"]),
    ].map(([file, text]) => [path.resolve(file), text]));
    const read = fs.readFileSync;
    fs.readFileSync = (file, ...args) => files.has(String(file)) ? files.get(String(file)) : read(file, ...args);
    const documents = ${JSON.stringify(documents)};
    globalThis.fetch = async (url) => {
      const body = documents[String(url)];
      return new Response(body ?? '<html>SPA fallback</html>', { status: 200 });
    };
    process.argv = ['node', 'verify-canton-hub-links.mjs', '--section', 'canton-ti', '--soft-network'];
    await import('./generator/scripts/verify-canton-hub-links.mjs');
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: root,
    env: { ...process.env, SITE_ORIGIN: origin },
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.ifError(result.error);
  return { status: result.status, output: result.stdout + result.stderr };
}

test('il verificatore trova i quattro hub lavoro TI nella sitemap principale (#2264)', () => {
  const result = verify();
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /0 mancanti/);
});

test('un hub lavoro davvero assente resta un errore anche con soft-network e fallback 200', () => {
  for (const job of jobs) {
    const result = verify(job);
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /1 mancanti/);
    assert.ok(result.output.includes(`non in sitemap: canton-ti/servizi/${locales[jobs.indexOf(job)]}: ${job}`), result.output);
  }
});
