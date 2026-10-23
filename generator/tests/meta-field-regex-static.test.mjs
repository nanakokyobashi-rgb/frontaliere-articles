import assert from 'node:assert/strict';
import test from 'node:test';

import {
  metaFieldRegex,
  metaFieldRegexFragment,
  readStaticMetaFieldEntries,
  readStaticMetaFields,
  unescapeTsValue,
} from '../scripts/lib/meta-field-regex.mjs';

function metadataModule(binding, properties) {
  return [
    `const ${binding}: Record<string, string> = {`,
    ...properties.map((property) => `  ${property}`),
    '};',
    `export default ${binding};`,
  ].join('\n');
}

test('static metadata reader preserves module/property order and projects fields together', () => {
  const italian = metadataModule('blogMetaIt', [
    "'blog.article.alpha.title': 'L\\'articolo',",
    "'blog.article.alpha.excerpt': 'Prima\\nseconda',",
    "'blog.article.beta.title': `Secondo`,",
    "'blog.article.ignored.body1': 'body text',",
  ]);
  const english = metadataModule('blogMetaEn', [
    "'blog.article.alpha.title': \"English title\",",
    "'blog.article.alpha.excerpt': 'English excerpt',",
  ]);

  const fields = readStaticMetaFields([
    { source: italian, sourcePath: 'content/blog-meta-it.ts' },
    { source: english, sourcePath: 'content/blog-meta-en.ts' },
  ], ['title', 'excerpt']);

  assert.deepEqual(fields.title, [
    { id: 'alpha', value: "L'articolo" },
    { id: 'beta', value: 'Secondo' },
    { id: 'alpha', value: 'English title' },
  ]);
  assert.deepEqual(fields.excerpt, [
    { id: 'alpha', value: 'Prima\nseconda' },
    { id: 'alpha', value: 'English excerpt' },
  ]);
  assert.deepEqual(
    readStaticMetaFieldEntries({ source: italian, sourcePath: 'content/blog-meta-it.ts' }, 'title'),
    fields.title.slice(0, 2),
  );
});

test('a malformed later module rejects the complete read instead of returning earlier fields', () => {
  const valid = metadataModule('validMeta', ["'blog.article.alpha.title': 'Known title',"]);
  const malformed = [
    'const invalidMeta: Record<string, string> = {',
    "  'blog.article.fake.title': `value ${injected}`,",
    '};',
    'export default invalidMeta;',
  ].join('\n');

  assert.throws(() => readStaticMetaFields([
    { source: valid, sourcePath: 'content/blog-meta-it.ts' },
    { source: malformed, sourcePath: 'content/blog-meta-en.ts' },
  ], ['title']), /static string literal value/u);
});

test('static metadata reader validates field and module inputs', () => {
  const valid = metadataModule('validMeta', ["'blog.article.alpha.title': 'Known title',"]);
  const module = { source: valid, sourcePath: 'content/blog-meta-it.ts' };

  assert.throws(() => readStaticMetaFields(module, []), /fields must be a non-empty array/u);
  assert.throws(() => readStaticMetaFields(module, ['title', 'title']), /fields must not contain duplicates/u);
  assert.throws(() => readStaticMetaFields(module, ['title.bad']), /simple identifier/u);
  assert.throws(() => readStaticMetaFields({ source: valid, sourcePath: '' }, ['title']), /non-empty sourcePath/u);
  assert.deepEqual(readStaticMetaFields([], ['title']), { title: [] });
});

test('legacy RegExp and source-span exports remain available for existing writers', () => {
  assert.equal(typeof metaFieldRegex, 'function');
  assert.equal(typeof metaFieldRegexFragment, 'function');
  assert.equal(typeof unescapeTsValue, 'function');
});
