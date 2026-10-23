import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  HISTORICAL_SEO_DESCRIPTION_POLICY,
  SEO_DESCRIPTION_MAX,
  SEO_OG_DESCRIPTION_MAX,
  assertHistoricalSeoDescriptionsMigrated,
} from '../scripts/lib/seo-description-contract.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const repeat = (prefix, length) => `${prefix} ${'testo storico '.repeat(length)}`.slice(0, length);

test('historical SEO policy preserves storage while accepting bounded public projections', () => {
  const description = repeat('Descrizione storica', SEO_DESCRIPTION_MAX + 40);
  const ogDescription = repeat('Card sociale storica', SEO_OG_DESCRIPTION_MAX + 40);
  const result = assertHistoricalSeoDescriptionsMigrated(
    [{ id: 'historical-1', description, ogDescription }],
    {
      projectDescription: (value) => value.slice(0, SEO_DESCRIPTION_MAX),
      projectOgDescription: (value) => value.slice(0, SEO_OG_DESCRIPTION_MAX),
    },
  );

  assert.deepEqual(result, {
    records: 1,
    historicalDescriptions: 1,
    historicalOgDescriptions: 1,
  });
  assert.equal(HISTORICAL_SEO_DESCRIPTION_POLICY.storage, 'preserve');
  assert.equal(HISTORICAL_SEO_DESCRIPTION_POLICY.publicSurface, 'clamp');
  assert.equal(description.length, SEO_DESCRIPTION_MAX + 40);
  assert.equal(ogDescription.length, SEO_OG_DESCRIPTION_MAX + 40);
});

test('historical SEO policy fails closed when an over-budget value has no bounded projection', () => {
  const description = repeat('Descrizione storica', SEO_DESCRIPTION_MAX + 1);
  assert.throws(
    () => assertHistoricalSeoDescriptionsMigrated([{ id: 'unbounded', description }]),
    /unbounded\.description stores/,
  );
  assert.throws(
    () => assertHistoricalSeoDescriptionsMigrated(
      [{ id: 'too-short', description }],
      { projectDescription: () => 'Core' },
    ),
    /too-short\.description stores .*\(min 80/,
  );
});

test('historical SEO policy ignores absent optional fields and rejects malformed values', () => {
  assert.deepEqual(
    assertHistoricalSeoDescriptionsMigrated([{ id: 'short', description: 'short' }, { id: 'absent' }]),
    { records: 2, historicalDescriptions: 0, historicalOgDescriptions: 0 },
  );
  assert.throws(
    () => assertHistoricalSeoDescriptionsMigrated([{ id: 'bad', description: 42 }]),
    /bad\.description is not a string/,
  );
});

test('build-api keeps the RSS summary floor separate from the SERP description floor', () => {
  const build = readFileSync(path.join(ROOT, 'scripts/build-api.mjs'), 'utf8');

  assert.match(build, /const repairRssSnippet = \(text\) => \{/);
  assert.match(build, /RSS_DESCRIPTION_MAX_CHARS/);
  assert.doesNotMatch(build, /RSS_SERP_DESCRIPTION_MAX_CHARS/);
  assert.match(build, /repairSerpSnippet: repairRssSnippet,/);
  assert.match(build, /projectDescription: repairSerpSnippet,/);
});
