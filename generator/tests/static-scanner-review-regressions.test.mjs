import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readTsStringMap } from '../scripts/lib/ts-string-map.mjs';
import {
  computedPropertyKeyEnd,
  unsupportedObjectMemberAt,
} from '../../scripts/lib/typescript-expression-scanner.mjs';

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
