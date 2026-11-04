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
  assert.match(createArticleSource, /function isTrendBackedDiscoveryCandidate\(candidate\)/);
  assert.match(createArticleSource, /candidate\?\.source === 'trends'/);
  assert.match(createArticleSource, /function isSecureHttpsUrl\(rawUrl\)/);
  assert.match(createArticleSource, /Trend signal skipped: no secure Google News evidence URL/);
  assert.match(createArticleSource, /const evidenceUrl = isSecureHttpsUrl\(meta\.evidenceUrl\)/);
  assert.match(createArticleSource, /if \(isTrendBackedDiscoveryCandidate\(discoveryCandidate\)\)/);
  assert.match(createArticleSource, /signalProvider: meta\.signalProvider === 'google-trends' \? meta\.signalProvider : 'google-trends'/);
  assert.match(createArticleSource, /signalHeadline: typeof signalHeadline === 'string'/);
  assert.match(createArticleSource, /signalCollectedAt: normalizeOptionalIsoTimestamp\(meta\.signalCollectedAt\)/);
  assert.match(createArticleSource, /evidenceProvider: typeof meta\.evidenceProvider === 'string'/);
  assert.match(createArticleSource, /evidencePublisher,/);
  assert.match(createArticleSource, /evidencePublishedAt: normalizeOptionalIsoTimestamp\(/);
  assert.match(createArticleSource, /resolvedSourceUrl: null/);
  assert.match(createArticleSource, /_discovery_attribution: RUN_REPORT\.discoveryAttribution/);
  assert.match(createArticleSource, /RUN_REPORT\.discoveryAttribution\.resolvedSourceUrl = url/);
  assert.match(createArticleSource, /RUN_REPORT\.selectedSource = 'evergreen';\s+RUN_REPORT\.discoveryAttribution = null;/);
  assert.match(createArticleSource, /RUN_REPORT\.status !== 'generated' \|\| !RUN_REPORT\.article\?\.id/);
  assert.match(createArticleSource, /DISCOVERY_POOL_BUILD_FALLBACK[^\n]*trendSignals=/);
  assert.match(createArticleSource, /Trend-backed source rejected: resolved publisher URL is not HTTPS/);
});
