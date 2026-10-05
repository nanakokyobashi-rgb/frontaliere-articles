// The generator must never write an article canonicalPath without the final
// slash. The frontaliere section did until 2026-10-03 (#2060 fixed the template,
// without a check), and the site review flagged the no-slash entries of
// seo-blog-5.ts on two corpus syncs (site PRs 10987 and 11114): the class that
// kept the site's `canonical-sitemap` lessons bucket escalating (site issue 10112).
// validateStructuredData() runs after every modifySeoService() write, so it is
// the gate: these tests execute the real function on an in-memory entry.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../scripts/create-article.mjs', import.meta.url), 'utf8');
const start = source.indexOf('function validateStructuredData(data) {');
const end = source.indexOf('function updateSitemapIndexLastmod(', start);
assert.ok(start >= 0 && end > start);

function validateCanonical(canonicalPath) {
  const entry = `{
    title: 'A real headline', description: 'A real description',
    canonicalPath: '${canonicalPath}',
    "image": { "creator": { "@type": "Organization", "@id": "https://frontaliereticino.ch/#organization" } }
  }`;
  const validate = new Function(
    'SECTION', 'BASE_URL', 'read', 'findSeoEntryMatches', 'corpusPath', 'console',
    `${source.slice(start, end)}\nreturn validateStructuredData;`,
  )(
    { seoFile: 'memory.ts' }, 'https://frontaliereticino.ch', () => entry,
    () => [{ index: 0, closeIdx: entry.length - 1 }], (p) => p, { error() {} },
  );
  return validate({ id: 'example', image: 'example.webp' });
}

test('validator accepts the slash-terminated canonicalPath of both sections', () => {
  assert.doesNotThrow(() => validateCanonical('/articoli-frontaliere/guasto-treno-s50-busto-arsizio-2026/'));
  assert.doesNotThrow(() => validateCanonical('/articoli-svizzera/guida-3a-fisco-vaud/'));
});

test('validator rejects the no-slash canonicalPath the site review flagged', () => {
  for (const cp of [
    '/articoli-frontaliere/guasto-treno-s50-busto-arsizio-2026',
    '/articoli-frontaliere/a2-coldrerio-incidente-camion',
    'articoli-frontaliere/relative-path/',
  ]) {
    assert.throws(() => validateCanonical(cp), /canonicalPath .* must start and end with "\/"/);
  }
});
