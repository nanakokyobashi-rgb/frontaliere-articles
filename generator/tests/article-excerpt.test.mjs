import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertPlainExcerpt,
  findExcerptMarkdownDefects,
  normalizeExcerpt,
  stripExcerptMarkdown,
} from '../scripts/lib/article-excerpt.mjs';
import { buildMetaBlockLines } from '../scripts/lib/article-meta-block.mjs';

test('normalizza l intestazione In breve in una sola frase utile', () => {
  const raw = '## In breve - L’USTRA ha pubblicato il progetto A2 tra Mendrisio e Melano. - I lavori inizieranno dopo il 2031.';
  assert.equal(
    normalizeExcerpt(raw),
    'L’USTRA ha pubblicato il progetto A2 tra Mendrisio e Melano.',
  );
});

test('strip deterministico rimuove heading, elenco, grassetto, link e tabella', () => {
  const raw = [
    '## In short',
    '- **First fact** from [the source](https://example.test).',
    '| field | value |',
    '| --- | --- |',
    '| source | verified |',
  ].join('\n');
  assert.equal(
    stripExcerptMarkdown(raw),
    'First fact from the source. field value source verified',
  );
  assert.deepEqual(findExcerptMarkdownDefects(raw), ['heading', 'list', 'bold', 'link', 'table', 'label']);
});

test('il gate accetta testo semplice e rifiuta Markdown nei campi descrittivi', () => {
  assert.doesNotThrow(() => assertPlainExcerpt('Il progetto è stato pubblicato oggi.', {
    field: 'excerpt',
    id: 'a2-test',
    locale: 'it',
  }));
  assert.throws(
    () => assertPlainExcerpt('En bref - **texte**.', { field: 'excerpt', id: 'a2-test', locale: 'fr' }),
    /excerpt-plain.*bold.*label/,
  );
  assert.throws(
    () => buildMetaBlockLines({
      id: 'a2-test',
      content: { it: { title: 'Titolo', excerpt: '## In breve - Testo.' } },
    }, 'it'),
    /excerpt-plain.*heading/,
  );
  assert.throws(
    () => buildMetaBlockLines({
      id: 'a2-test',
      content: {
        it: {
          title: 'Titolo',
          excerpt: 'Testo semplice.',
          seoDescription: '## SERP contaminata',
        },
      },
    }, 'it'),
    /excerpt-plain.*seoDescription.*heading/,
  );
});

