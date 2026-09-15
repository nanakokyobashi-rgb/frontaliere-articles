import test from 'node:test';
import assert from 'node:assert/strict';

import {
  auditLive,
  checkSource,
} from '../../scripts/seo/bing-seo-loop.mjs';
import {
  BING_TITLE_FIXES,
  BING_TITLE_MAX_CHARS,
} from '../../scripts/seo/bing-seo-policy.mjs';

test('Bing title policy is bounded and source-aligned', () => {
  const result = checkSource();
  assert.equal(result.ok, true, JSON.stringify(result.findings));
  assert.equal(BING_TITLE_FIXES.length, 16);
  assert.ok(BING_TITLE_FIXES.every((fix) => fix.title.length <= BING_TITLE_MAX_CHARS));
  assert.equal(new Set(BING_TITLE_FIXES.map((fix) => fix.url)).size, 16);
});

test('live audit accepts the brand suffix when the approved title is its prefix', async () => {
  const htmlByUrl = new Map(BING_TITLE_FIXES.map((fix) => [
    fix.url,
    '<title>' + fix.title + (fix.title.length + ' | Frontaliere Ticino'.length <= BING_TITLE_MAX_CHARS
      ? ' | Frontaliere Ticino'
      : '') + '</title>' +
      '<link rel="canonical" href="' + fix.url + '">',
  ]));
  const result = await auditLive({
    fetchImpl: async (url) => ({
      status: 200,
      url,
      text: async () => htmlByUrl.get(url),
    }),
  });
  assert.deepEqual(result.findings, []);
});

test('live audit accepts canonical attributes in either order and numeric entities', async () => {
  const htmlByUrl = new Map(BING_TITLE_FIXES.map((fix) => [
    fix.url,
    '<title>' + fix.title.replace('?', '&#63;') + '</title>'
      + '<link href="' + fix.url + '" rel="alternate canonical">',
  ]));
  const result = await auditLive({
    fetchImpl: async (url) => ({
      status: 200,
      url,
      text: async () => htmlByUrl.get(url),
    }),
  });
  assert.deepEqual(result.findings, []);
});
