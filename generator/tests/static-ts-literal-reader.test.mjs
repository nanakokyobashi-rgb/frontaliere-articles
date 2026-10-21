import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  decodeStaticStringLiteral,
  readStaticObjectEntries,
  readStaticStringLiteral,
} from '../../scripts/lib/ts-literals.mjs';

const ROOT = resolve(new URL('../..', import.meta.url).pathname);

test('il reader statico ignora commenti e prosa che imitano una chiave meta', () => {
  const source = [
    "// 'blog.article.fake.title': 'commento'",
    'const prose = "testo con \'blog.article.fake.title\': \'prosa\'";',
    'export default {',
    "  'blog.article.reale.title': 'L\\'incontro',",
    "  'blog.article.reale.excerpt': `Use \\`code\\``,",
    '};',
  ].join('\n');

  assert.deepEqual(readStaticObjectEntries(source, 'fixture.ts'), [
    {
      key: 'blog.article.reale.title',
      value: "L'incontro",
      keyQuote: "'",
      valueQuote: "'",
    },
    {
      key: 'blog.article.reale.excerpt',
      value: 'Use `code`',
      keyQuote: "'",
      valueQuote: '`',
    },
  ]);
});

test('il reader richiede il delimitatore dopo il valore e rifiuta interpolazioni', () => {
  assert.throws(
    () => readStaticObjectEntries("const x = { 'blog.article.fake.title': 'valore' + suffix };", 'fixture.ts'),
    /must end with/u,
  );
  assert.throws(
    () => readStaticObjectEntries("const x = { 'blog.article.fake.title': `prefix ${value}` };", 'fixture.ts'),
    /Interpolated template literal/u,
  );
});

test('il decoder conserva Unicode e newline senza ri-scansionare il risultato', () => {
  assert.equal(decodeStaticStringLiteral('line\\n\\u00e8 \\\\n', "'"), 'line\nè \\n');
  assert.deepEqual(readStaticStringLiteral('`Use \\`code\\``', 0, 'fixture.ts'), {
    quote: '`',
    value: 'Use \\`code\\`',
    end: 14,
  });
});

test('gli emitter usano il reader condiviso e non una regex raw duplicata', () => {
  for (const file of ['scripts/build-blog-index.mjs', 'scripts/refresh-hub-landing.mjs']) {
    const source = readFileSync(resolve(ROOT, file), 'utf8');
    assert.match(source, /readStaticObjectEntries/u, `${file}: reader condiviso assente`);
    assert.doesNotMatch(source, /blog\\\.article\\\.\(\[\^'\]\+\?\\\)/u, `${file}: regex raw ancora presente`);
  }
});

