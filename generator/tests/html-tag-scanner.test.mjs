import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { nextHtmlTag, readHtmlTagAt } from '../scripts/lib/html-tag-scanner.mjs';

function instrumentHtml(value) {
  let characterReads = 0;
  let indexOfCalls = 0;
  const input = new Proxy(new String(value), {
    get(target, property) {
      if (property === 'length') return value.length;
      if (property === 'indexOf') {
        return (needle, position) => {
          indexOfCalls += 1;
          return value.indexOf(needle, position);
        };
      }
      if (property === 'startsWith') return (needle, position) => value.startsWith(needle, position);
      if (property === 'slice') return (...args) => value.slice(...args);
      if (typeof property === 'string' && /^(?:0|[1-9]\d*)$/u.test(property)) {
        characterReads += 1;
        return value[Number(property)];
      }
      const member = Reflect.get(target, property, target);
      return typeof member === 'function' ? member.bind(target) : member;
    },
  });
  return {
    input,
    counts: () => ({ characterReads, indexOfCalls }),
  };
}

test('readHtmlTagAt distinguishes an unterminated valid tag from EOF', () => {
  const malformed = `<section title='unfinished ${'<x '.repeat(256)}`;

  assert.deepEqual(readHtmlTagAt(malformed, 0), { status: 'malformed' });
  assert.equal(readHtmlTagAt('plain text', 0), null);
  assert.equal(nextHtmlTag('plain text'), null);
});

test('nextHtmlTag stops at the first malformed tag within one linear scan', () => {
  const malformed = `<section title='unfinished ${'<x '.repeat(256)}`;
  const { input, counts } = instrumentHtml(malformed);

  assert.equal(nextHtmlTag(input), null);
  const measured = counts();
  assert.equal(measured.indexOfCalls, 1, 'non deve ripartire dal successivo `<`');
  assert.ok(
    measured.characterReads <= malformed.length + 16,
    `la scansione deve restare lineare: ${measured.characterReads} letture per ${malformed.length} caratteri`,
  );
});

test('a stray quote cannot trap the self-closing attribute scan on an inner `>`', () => {
  const malformed = '<button class="mod_navigation__main--search"'
    + ' title="Suche öffnen" aria-label="Suche öffnen""'
    + ' data-trigger-search><svg class="svg-icon" viewBox="0 0 24 24">';
  const scannerUrl = new URL('../scripts/lib/html-tag-scanner.mjs', import.meta.url).href;
  const childSource = [
    `const { readHtmlTagAt } = await import(${JSON.stringify(scannerUrl)});`,
    `const result = readHtmlTagAt(${JSON.stringify(malformed)}, 0);`,
    'process.stdout.write(JSON.stringify(result));',
  ].join('\n');
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', childSource], {
    encoding: 'utf8',
    timeout: 1000,
  });

  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { status: 'malformed' });
});

test('the inline source scanner used by create-article fails closed on the SVZ shape', () => {
  const malformed = '<meta name=""msapplication-TileColor" content="">';
  const createArticle = readFileSync(new URL('../scripts/create-article.mjs', import.meta.url), 'utf8');
  const blockStart = createArticle.indexOf('const SOURCE_HTML_VOID_ELEMENTS = new Set([');
  const blockEnd = createArticle.indexOf('function sourceSkipComment', blockStart);
  assert.notEqual(blockStart, -1, 'source scanner delimitatore iniziale sparito');
  assert.notEqual(blockEnd, -1, 'source scanner delimitatore finale sparito');
  const childSource = [
    createArticle.slice(blockStart, blockEnd),
    `const result = sourceReadTag(${JSON.stringify(malformed)}, 0);`,
    'process.stdout.write(JSON.stringify(result));',
  ].join('\n');
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', childSource], {
    encoding: 'utf8',
    timeout: 1000,
  });

  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { malformed: true });
});
