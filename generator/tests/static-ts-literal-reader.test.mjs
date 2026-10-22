import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  decodeStaticStringLiteral,
  readStaticObjectEntries,
  readStaticStringLiteral,
} from '../../scripts/lib/ts-literals.mjs';
import { metaFieldRegex, metaFieldRegexFragment } from '../scripts/lib/meta-field-regex.mjs';

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
  assert.deepEqual(
    readStaticObjectEntries("'blog.article.tail.title': 'ultimo'\n", 'fragment.ts', {
      allowTerminalFragment: true,
    }),
    [{
      key: 'blog.article.tail.title',
      value: 'ultimo',
      keyQuote: "'",
      valueQuote: "'",
    }],
  );
  assert.throws(
    () => readStaticObjectEntries("'blog.article.tail.title': 'ultimo'\n", 'full-map.ts'),
    /must end with/u,
  );
  assert.throws(
    () => readStaticObjectEntries("const x = { 'blog.article.fake.title': 'valore' + suffix };", 'fixture.ts'),
    /must end with/u,
  );
  assert.throws(
    () => readStaticObjectEntries("'blog.article.tail.title': 'ultimo',", 'fixture.ts'),
    /dangling comma/u,
  );
  assert.throws(
    () => readStaticObjectEntries("const x = { 'blog.article.fake.title': `prefix ${value}` };", 'fixture.ts'),
    /Interpolated template literal/u,
  );
});

test('il reader gestisce commenti CR-only e continuazioni CRLF', () => {
  const source = "// 'blog.article.fake.title': 'commento'\r'blog.article.reale.title': 'prima\\\r\nsecond' }";
  assert.deepEqual(readStaticObjectEntries(source, 'fixture.ts', { allowTerminalFragment: true }), [
    {
      key: 'blog.article.reale.title',
      value: 'primasecond',
      keyQuote: "'",
      valueQuote: "'",
    },
  ]);
});

test('il reader ignora regex literal anche dopo divisioni e parentesi di controllo', () => {
  const source = [
    String.raw`const pattern = /["']blog\.article\.fake\.literal["']:\s*["']fake["']/u;`,
    String.raw`if (condition) /["']blog\.article\.fake\.body["']:\s*["']fake["']/u;`,
    "let n = 1; n++ / /'blog.article.fake.postfix': 'fake',/ / /x/;",
    "const meta = { 'blog.article.reale.title': 'attuale' };",
  ].join('\n');

  assert.deepEqual(
    readStaticObjectEntries(source, 'fixture.ts').map(({ key, value }) => [key, value]),
    [['blog.article.reale.title', 'attuale']],
  );
});

test('il reader richiede la chiusura dell oggetto completo e può appiattire i metadata', () => {
  assert.throws(
    () => readStaticObjectEntries("const meta = { 'blog.article.reale.title': 'titolo',", 'truncated.ts'),
    /not closed|dangling comma/u,
  );
  const entries = readStaticObjectEntries(
    "const meta = { 'blog.article.reale.title': 'prima\\nseconda' };",
    'meta.ts',
    { newlineAs: ' ' },
  );
  assert.equal(entries[0].value, 'prima seconda');
});

test('il reader fallisce chiuso su commenti e stringhe troncati dopo entry valide', () => {
  assert.throws(
    () => readStaticObjectEntries(
      "const meta = { 'blog.article.reale.title': 'valido', /* troncato",
      'truncated-comment.ts',
    ),
    /Unterminated comment/u,
  );
  assert.throws(
    () => readStaticObjectEntries(
      "const meta = { 'blog.article.reale.title': 'valido', 'blog.article.alt.title",
      'truncated-string.ts',
    ),
    /Unterminated string literal/u,
  );
});

test('metaFieldRegex conserva la superficie RegExp senza scansionare commenti e prosa', () => {
  const source = [
    "// 'blog.article.fake.title': 'commento'",
    'const prose = "testo con \'blog.article.fake.title\': \'prosa\'";',
    "const meta = { 'blog.article.reale.title': 'L\\'incontro' };",
  ].join('\n');
  const matches = [...source.matchAll(metaFieldRegex('title'))];
  assert.equal(matches.length, 1);
  assert.equal(matches[0][1], 'reale');
  assert.equal(matches[0][2], "L\\'incontro");
});

test('metaFieldRegex rifiuta una mappa troncata mentre l adapter accetta solo il frammento esplicito', () => {
  const fragment = "'blog.article.reale.title': 'L\\'incontro',";
  assert.throws(
    () => [...fragment.matchAll(metaFieldRegex('title'))],
    /not closed|dangling comma/u,
  );
  assert.equal([...fragment.matchAll(metaFieldRegexFragment('title'))][0][1], 'reale');
});

test('metaFieldRegex tratta una sezione metadata assente come zero match', () => {
  assert.deepEqual([...''.matchAll(metaFieldRegex('title'))], []);
  assert.equal(metaFieldRegex('title').exec(''), null);
});

test('metaFieldRegex conserva gli offset raw e gli id che contengono punti', () => {
  const source = "const meta = {\n  \"blog.article.id.con.punti.title\" : \"Titolo\\nraw\",\n};";
  const match = [...source.matchAll(metaFieldRegex('title'))][0];
  assert.equal(match[1], 'id.con.punti');
  assert.equal(match[2], 'Titolo\\nraw');
  assert.equal(match[0], source.slice(match.index, match.index + match[0].length));
  assert.ok(match[0].includes('"blog.article.id.con.punti.title"'));
  assert.ok(match[0].includes('Titolo\\nraw'));
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
