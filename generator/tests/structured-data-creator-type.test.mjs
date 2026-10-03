import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../scripts/create-article.mjs', import.meta.url), 'utf8');
const start = source.indexOf('function validateStructuredData(data) {');
const end = source.indexOf('function updateSitemapIndexLastmod(', start);
assert.ok(start >= 0 && end > start);

// Execute the real validation function with a read-only in-memory SEO entry.
// The entry resolver is tested separately; this isolates the field Google rejects.
function validateCreator(type, id = 'https://frontaliereticino.ch/#organization') {
  const entry = `{
    title: 'A real headline', description: 'A real description',
    canonicalPath: '/articoli-frontaliere/example/',
    "image": { "creator": { "@type": "${type}", "@id": "${id}" } }
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

test('generated SEO template uses the creator type accepted by Google', () => {
  assert.match(source, /"creator":\s*\{\s*"@type":\s*"Organization",\s*"@id":\s*"https:\/\/frontaliereticino\.ch\/#organization"/);
  assert.doesNotMatch(source, /["']@type["']\s*:\s*["']NewsMediaOrganization["']/);
});

test('validator accepts canonical Organization and rejects the reported invalid subtype', () => {
  assert.doesNotThrow(() => validateCreator('Organization'));
  for (const type of ['NewsMediaOrganization', 'Thing', '']) {
    assert.throws(() => validateCreator(type), /image\.creator.*Organization/);
  }
  assert.throws(() => validateCreator('Organization', 'https://example.com/#other'), /image\.creator/);
});
