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
import { readCanonicalPath } from '../../scripts/lib/seo-canonical-path.mjs';
import { decodeStaticStringLiteral } from '../../scripts/lib/ts-literals.mjs';

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
    'SECTION', 'BASE_URL', 'read', 'findSeoEntryMatches', 'readCanonicalPath', 'corpusPath', 'console',
    'decodeStaticStringLiteral',
    `${source.slice(start, end)}\nreturn validateStructuredData;`,
  )(
    { seoFile: 'memory.ts' }, 'https://frontaliereticino.ch', () => entry,
    () => [{ index: 0, closeIdx: entry.length - 1 }], readCanonicalPath, (p) => p, { error() {} },
    decodeStaticStringLiteral,
  );
  return validate({ id: 'example', image: 'example.webp' });
}

function validateCanonicalExpression(expression) {
  const canonicalField = expression === null ? '' : '    canonicalPath: ' + expression + ',';
  const entry = [
    '{',
    "    title: 'A real headline', description: 'A real description',",
    canonicalField,
    '    "image": { "creator": { "@type": "Organization", "@id": "https://frontaliereticino.ch/#organization" } }',
    '}',
  ].join('\n');
  const validate = new Function(
    'SECTION', 'BASE_URL', 'read', 'findSeoEntryMatches', 'readCanonicalPath', 'corpusPath', 'console',
    'decodeStaticStringLiteral',
    source.slice(start, end) + '\nreturn validateStructuredData;',
  )(
    { seoFile: 'memory.ts' }, 'https://frontaliereticino.ch', () => entry,
    () => [{ index: 0, closeIdx: entry.length - 1 }], readCanonicalPath, (p) => p, { error() {} },
    decodeStaticStringLiteral,
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

test('canonicalPath reader accepts the single-quoted value emitted by the SEO writer', () => {
  assert.match(source, /canonicalPath:\s*'\$\{itHubPath\}',/);
  const expected = '/articoli-frontaliere/example/';
  const expression = "'" + expected + "'";
  const entry = '{\n    canonicalPath: ' + expression + ',\n}';
  assert.deepEqual(readCanonicalPath(entry), { kind: 'resolved', value: expected });
  assert.doesNotThrow(() => validateCanonicalExpression(expression));
  const nestedOnly = '{\n    structuredData: {\n      canonicalPath: \"' + expected + '\"\n    },\n}';
  assert.deepEqual(readCanonicalPath(nestedOnly), { kind: 'missing' });
  const nestedBeforeTopLevel = '{\n    structuredData: {\n      canonicalPath: \"/wrong/\"\n    },\n'
    + '    canonicalPath: ' + expression + ',\n}';
  assert.deepEqual(readCanonicalPath(nestedBeforeTopLevel), { kind: 'resolved', value: expected });
});

test('canonicalPath reader rejects forms the writer does not emit', () => {
  const expected = '/articoli-frontaliere/example/';
  const templateQuote = String.fromCharCode(96);
  const expressions = [
    '"' + expected + '"',
    templateQuote + expected + templateQuote,
    "('/articoli-frontaliere/' + 'example/')",
  ];
  for (const expression of expressions) {
    const entry = '{\n    canonicalPath: ' + expression + ',\n}';
    assert.deepEqual(readCanonicalPath(entry), { kind: 'unresolved', expression }, expression);
    assert.throws(
      () => validateCanonicalExpression(expression),
      /Cannot resolve canonicalPath expression/,
      expression,
    );
  }
});

test('canonicalPath reader distinguishes missing and unresolved computed values', () => {
  assert.deepEqual(readCanonicalPath('{\n    title: "A title",\n}'), { kind: 'missing' });
  const expression = 'buildCanonicalPath(articleSlug)';
  const entry = '{\n    canonicalPath: ' + expression + ',\n}';
  assert.deepEqual(readCanonicalPath(entry), { kind: 'unresolved', expression });
  assert.throws(() => validateCanonicalExpression(null), /Empty canonicalPath/);
  assert.throws(
    () => validateCanonicalExpression(expression),
    /Cannot resolve canonicalPath expression.*buildCanonicalPath/,
  );
});

test('refresh hub landing uses the same canonicalPath grammar', () => {
  const refreshSource = readFileSync(new URL('../../scripts/refresh-hub-landing.mjs', import.meta.url), 'utf8');
  assert.match(refreshSource, /import \{ readCanonicalPath \} from '\.\/lib\/seo-canonical-path\.mjs';/);
  assert.doesNotMatch(refreshSource, /block\.match\(\/canonicalPath/);
});

test('unsupported double-quoted canonicalPath is rejected before URL validation', () => {
  assert.throws(
    () => validateCanonicalExpression('"/articoli-frontaliere/example"'),
    /Cannot resolve canonicalPath expression/,
  );
});
