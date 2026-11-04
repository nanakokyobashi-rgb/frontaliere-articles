import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const createArticleSource = readFileSync(
  new URL('../scripts/create-article.mjs', import.meta.url),
  'utf8',
);

test('selected signal-led discovery attribution reaches the run report and article sidecar', () => {
  assert.match(createArticleSource, /discoveryAttribution: null/);
  assert.match(createArticleSource, /RUN_REPORT\.discoveryAttribution = null;/);
  assert.match(createArticleSource, /chosen\?\._discoveryCandidate\?\.meta\?\.signalProvider/);
  assert.match(createArticleSource, /signalProvider: meta\.signalProvider/);
  assert.match(createArticleSource, /signalHeadline: meta\.signalHeadline/);
  assert.match(createArticleSource, /signalCollectedAt: meta\.signalCollectedAt/);
  assert.match(createArticleSource, /evidenceProvider: meta\.evidenceProvider/);
  assert.match(createArticleSource, /evidencePublisher: meta\.evidencePublisher/);
  assert.match(createArticleSource, /resolvedSourceUrl: null/);
  assert.match(createArticleSource, /_discovery_attribution: RUN_REPORT\.discoveryAttribution/);
  assert.match(createArticleSource, /RUN_REPORT\.discoveryAttribution\.resolvedSourceUrl = url/);
  assert.match(createArticleSource, /RUN_REPORT\.selectedSource = 'evergreen';\s+RUN_REPORT\.discoveryAttribution = null;/);
  assert.match(createArticleSource, /Trend-backed source rejected: resolved publisher URL is not HTTPS/);
});
