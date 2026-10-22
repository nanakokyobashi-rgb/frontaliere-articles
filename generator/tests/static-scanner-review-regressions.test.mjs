import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  loadArticleRouteRedirects,
  scanRedirectSource,
} from '../../engine/shared/articleRouteOwnership.mjs';
import {
  findAllSeoEntryMatches,
} from '../../engine/shared/seo-entry.mjs';
import {
  decodeStaticStringLiteral,
} from '../../engine/shared/ts-literals.mjs';
import { readTsStringMap } from '../scripts/lib/ts-string-map.mjs';
import {
  computedPropertyKeyEnd,
  unsupportedObjectMemberAt,
} from '../../scripts/lib/typescript-expression-scanner.mjs';

test('articleRouteOwnership scarta la mappa legacy dopo un commento troncato', () => {
  const files = new Map([
    ['data.json', JSON.stringify({ '/data/': '/target/' })],
    ['legacy.ts', "const redirects = { '/legacy/': '/target-legacy/' /* troncato"],
  ]);
  const fs = { readFileSync: file => files.get(file) };

  assert.deepEqual(loadArticleRouteRedirects(fs, 'data.json', 'legacy.ts'), {
    '/data/': '/target/',
  });
  assert.deepEqual(scanRedirectSource(files.get('legacy.ts')).entries, {});
});

test('seo-entry riconosce tutti i terminatori di riga nei commenti lineari', () => {
  for (const lineTerminator of ['\r', '\u2028', '\u2029']) {
    const source = `// voce ignorata${lineTerminator}'blog-live': { value: 1 }`;
    assert.deepEqual(
      findAllSeoEntryMatches(source, `seo-${JSON.stringify(lineTerminator)}`).map(({ id }) => id),
      ['live'],
      JSON.stringify(lineTerminator),
    );
  }
});

test('seo-entry tratta il bang dopo ASI come prefisso regex', () => {
  const source = "'blog-live': { value!\n!/foo}/\n}";
  const [match] = findAllSeoEntryMatches(source, 'seo-asi');
  assert.ok(match);
  assert.equal(match.closeIdx, source.lastIndexOf('}'));
});

test('il decoder TS rimuove anche la continuazione \u005cr con newlineAs', () => {
  assert.equal(
    decodeStaticStringLiteral('prima\\rseconda', "'", { newlineAs: ' ' }),
    'primaseconda',
  );
});

test('ts-string-map riconosce U+2028 e U+2029 prima del corpo successivo', () => {
  for (const lineTerminator of ['\u2028', '\u2029']) {
    const source = `function render(): { value: string } // commento${lineTerminator}{ ['blog.article.dynamic']: 'x' };`;
    assert.throws(
      () => readTsStringMap(source),
      /Computed article map keys are not supported/u,
      lineTerminator,
    );
  }
});

test('ts-string-map attraversa un commento Unicode dentro un generics lookahead', () => {
  const source = `const render = identity<Result // commento\u2028
    >({ 'blog.article.runtime': 'runtime' });`;
  assert.equal(readTsStringMap(source).get('blog.article.runtime'), 'runtime');
});

test('lo scanner non tratta una parentesi di controllo preceduta da commento come parametri', () => {
  const source = 'if /* commento */ (condition ? 1 : { [key in value]: "x" })';
  const offset = source.indexOf('[', source.indexOf('{'));
  const member = unsupportedObjectMemberAt(source, offset);
  assert.equal(member?.kind, 'computed');
  assert.equal(member?.keyEnd, computedPropertyKeyEnd(source, offset));
});

test('lo scanner mantiene il contesto TypeScript nei mapped type annidati', () => {
  const sources = [
    'const f = (arg: T extends U ? { [K in keyof T]: V } : never) => arg;',
    'const f = (arg: T | { [K in keyof T]: V }) => arg;',
    'const f = (arg: ({ [K in keyof T]: V })) => arg;',
  ];

  for (const source of sources) {
    const offset = source.indexOf('[', source.indexOf('{'));
    assert.equal(unsupportedObjectMemberAt(source, offset), null, source);
  }
});

test('lo scanner chiude il contesto di tipo prima di un initializer di parametro', () => {
  const source = 'function f(options: any = () => ({ [key in runtime]: 1 })) {}';
  const offset = source.indexOf('[', source.indexOf('{'));
  assert.equal(unsupportedObjectMemberAt(source, offset)?.kind, 'computed');
  assert.equal(unsupportedObjectMemberAt(source, offset)?.keyEnd, computedPropertyKeyEnd(source, offset));
});

test('lo scanner mantiene runtime gli object literal condizionali nei default dei parametri', () => {
  const source = 'function f(options: any = condition ? value : { [key in runtime]: 1 }) {}';
  const offset = source.indexOf('[', source.indexOf('{'));
  assert.equal(unsupportedObjectMemberAt(source, offset)?.kind, 'computed');
  assert.equal(unsupportedObjectMemberAt(source, offset)?.keyEnd, computedPropertyKeyEnd(source, offset));
});

test('lo scanner riattiva le annotazioni dopo il separatore del parametro', () => {
  const source = 'function f(first: any = { [key in runtime]: 1 }, second: { [key in keyof T]: V }) {}';
  const runtimeOffset = source.indexOf('[', source.indexOf('{'));
  const mappedOffset = source.indexOf('[', runtimeOffset + 1);
  assert.equal(unsupportedObjectMemberAt(source, runtimeOffset)?.kind, 'computed');
  assert.equal(unsupportedObjectMemberAt(source, mappedOffset), null);
});

test('lo scanner ignora le parentesi dentro regex dopo keyword prefix', () => {
  for (const keyword of ['default', 'break', 'continue', 'debugger']) {
    const source = `[${keyword} /foo]/u]`;
    assert.equal(
      computedPropertyKeyEnd(source, 0),
      source.length,
      `${keyword}: la regex non deve chiudere la computed property`,
    );
  }
});

test('lo scanner tratta i private name come proprietà membro prima di una divisione', () => {
  const source = '[this.#default / /\\]/.test(value), [key]: value]';
  assert.equal(computedPropertyKeyEnd(source, 0), source.length);
});
