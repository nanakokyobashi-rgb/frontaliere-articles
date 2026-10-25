import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isRelevantCantonHubSitemap } from '../scripts/lib/canton-hub-sitemaps.mjs';
import { isIntentionalNoindexPharmacyPage } from '../scripts/lib/canton-hub-published-route.mjs';

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

test('il gate include anche la sitemap plate-auctions non shardizzata', () => {
  assert.equal(
    isRelevantCantonHubSitemap('https://frontaliereticino.ch/sitemap-plate-auctions.xml'),
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

test('il verifier accetta soltanto una pagina farmacia noindex intenzionale e canonica', () => {
  const html = `
    <meta name=robots content=noindex,follow>
    <link rel="canonical" href="https://frontaliereticino.ch/farmacie-di-turno/">
    <!--PHARMACY_NOINDEX_TARGET-->
  `;
  assert.equal(
    isIntentionalNoindexPharmacyPage(html, 'https://frontaliereticino.ch/farmacie-di-turno/'),
    true,
  );
});

test('il verifier non trasforma un fallback SPA o un canonical diverso in un link valido', () => {
  const marker = '<!--PHARMACY_NOINDEX_TARGET-->';
  assert.equal(
    isIntentionalNoindexPharmacyPage(
      `<meta name="robots" content="noindex,follow"><link rel="canonical" href="https://frontaliereticino.ch/">${marker}`,
      'https://frontaliereticino.ch/farmacie-di-turno/',
    ),
    false,
  );
  assert.equal(
    isIntentionalNoindexPharmacyPage(
      '<meta name="robots" content="noindex,follow"><link rel="canonical" href="https://frontaliereticino.ch/farmacie-di-turno/">',
      'https://frontaliereticino.ch/farmacie-di-turno/',
    ),
    false,
  );
});
