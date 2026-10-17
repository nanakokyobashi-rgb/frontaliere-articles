import { test } from 'node:test';
import assert from 'node:assert/strict';

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
