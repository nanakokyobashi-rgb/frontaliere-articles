import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseStaticArticleTranslationEntries,
} from '../../engine/shared/articleStaticSource.mjs';
import {
  readStaticMetaFields,
  metaFieldRegex,
  unescapeTsValue,
} from '../scripts/lib/meta-field-regex.mjs';

const source = String.raw`const metadata: Record<string, string> = {
  'blog.article.mirror-contract.title': 'L\'iniziativa',
  'blog.article.mirror-contract.excerpt': 'Parser condiviso',
};
export default metadata;`;

test('the corpus mirror keeps parser and line-aware readers on one contract', () => {
  const entries = parseStaticArticleTranslationEntries(source, 'blog-meta-it.ts');
  assert.deepEqual(
    entries.map(({ articleId, field, value }) => ({ articleId, field, value })),
    [
      { articleId: 'mirror-contract', field: 'title', value: "L'iniziativa" },
      { articleId: 'mirror-contract', field: 'excerpt', value: 'Parser condiviso' },
    ],
  );

  assert.deepEqual(
    readStaticMetaFields({ source, sourcePath: 'blog-meta-it.ts' }, ['title']),
    { title: [{ id: 'mirror-contract', value: "L'iniziativa" }] },
  );

  const [match] = [...source.matchAll(metaFieldRegex('title'))];
  assert.equal(match[1], 'mirror-contract');
  assert.equal(unescapeTsValue(match[2]), "L'iniziativa");
});
