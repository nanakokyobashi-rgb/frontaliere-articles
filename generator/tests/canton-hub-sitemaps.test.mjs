import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isRelevantCantonHubSitemap } from '../scripts/lib/canton-hub-sitemaps.mjs';

test('il gate degli hub include gli shard sitemap delle varianti locali', () => {
  assert.equal(
    isRelevantCantonHubSitemap('https://frontaliereticino.ch/sitemap-locale-variants-001.xml'),
    true,
  );
  assert.equal(
    isRelevantCantonHubSitemap('https://frontaliereticino.ch/sitemap-locale-variants-12.xml'),
    true,
  );
});

test('il gate continua a ignorare le sitemap che non descrivono link di hub', () => {
  assert.equal(
    isRelevantCantonHubSitemap('https://frontaliereticino.ch/sitemap-articles-archive.xml'),
    false,
  );
  assert.equal(
    isRelevantCantonHubSitemap('https://frontaliereticino.ch/sitemap-search-clusters-001.xml'),
    false,
  );
});
