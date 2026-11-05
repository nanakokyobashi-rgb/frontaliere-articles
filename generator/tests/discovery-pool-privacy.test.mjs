import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  fetchAll,
  safeDiscoveryErrorType,
  scoreCandidates,
} from '../scripts/lib/discovery/discoveryPool.mjs';
import { fetchNewsRssDiscoveryCandidates } from '../scripts/lib/discovery/sources/googleNewsRssSource.mjs';
import { fetchSuggestDiscoveryCandidates } from '../scripts/lib/discovery/sources/googleSuggestSource.mjs';
import { fetchTrendsDiscoveryCandidates } from '../scripts/lib/discovery/sources/googleTrendsSource.mjs';
import { ARTICLE_SIGNAL_LOG_HELPERS } from './lib/article-signal-log-harness.mjs';

const SENTINEL = 'private-trends-topic-sentinel';
const FREE_FORM_ERROR = `provider failure echoed ${SENTINEL}`;
const CREATE_ARTICLE = readFileSync(new URL('../scripts/create-article.mjs', import.meta.url), 'utf8');
const THUMBNAIL_GENERATOR = readFileSync(new URL('../../scripts/generate-image-thumbnails.mjs', import.meta.url), 'utf8');

async function captureWarnings(run) {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    await run();
  } finally {
    console.warn = originalWarn;
  }
  return warnings.join('\n');
}

test('discovery scoring failures do not log candidate headlines or free-form errors', async () => {
  const output = await captureWarnings(async () => {
    assert.deepEqual(scoreCandidates([{
      headline: SENTINEL,
      source: 'suggest',
      url: null,
      meta: {},
    }], {}), []);
  });

  assert.match(output, /candidate_index=1/);
  assert.match(output, /error_type=Error/);
  assert.doesNotMatch(output, new RegExp(SENTINEL));
  assert.doesNotMatch(output, /lacks a Ticino\/frontalieri anchor token/);
});

test('create-article discovery catches log only a safe error type', () => {
  const failure = new Error(FREE_FORM_ERROR);
  assert.equal(safeDiscoveryErrorType(failure), 'Error');
  assert.equal(safeDiscoveryErrorType(FREE_FORM_ERROR), 'string');
  assert.doesNotMatch(safeDiscoveryErrorType(failure), new RegExp(SENTINEL));

  const catchMessages = CREATE_ARTICLE.match(/(?:Discovery pool build failed|Google-News injection into proven pool failed|Cross-pool fallback \(proven→discovery\) failed)[^\n]*/g) || [];
  assert.equal(catchMessages.length, 3);
  assert.ok(catchMessages.every((message) => message.includes('safeDiscoveryErrorType(err)')));
  assert.ok(catchMessages.every((message) => !message.includes('err?.message')));
  assert.doesNotMatch(CREATE_ARTICLE, /console\.error\(formatIssues\(/);
  assert.match(CREATE_ARTICLE, /Validazione fallita: \$\{safeSignalDiagnosticTextForLog\(validationErr\.message\)\}/);
  assert.doesNotMatch(CREATE_ARTICLE, /Immagine generata: \$\{imagePath\}/);
  assert.match(CREATE_ARTICLE, /Provenienza immagine governata rifiutata: \$\{safeSignalDiagnosticTextForLog\(error\.message, null\)\}/);
  assert.match(CREATE_ARTICLE, /const imageUrlLabel = safeSignalTextForLog\(\s*result\.record\.imageUrl,\s*null,\s*'\[signal image path redacted\]'/);
  assert.doesNotMatch(CREATE_ARTICLE, /Copertina governata: \$\{result\.record\.imageUrl\}/);
  assert.match(CREATE_ARTICLE, /discardedHeadlineSamples\.map\(\(sample\) => projectDiscardedHeadlineSample\(sample, selectedFromSignalPool\)\)/);
  assert.match(CREATE_ARTICLE, /const shouldRedactExistingId = redactExistingId \|\| sample\.signalDriven === true;/);
  assert.match(CREATE_ARTICLE, /signalDriven: isSignalDrivenTopicCandidate\(h\)/);
  assert.match(CREATE_ARTICLE, /safeSignalDiagnosticTextForLog\(String\(bodyData\.reason \|\| ''\)\.slice\(0, 200\), sourceContext\)/);
  assert.match(CREATE_ARTICLE, /safeSignalDiagnosticTextForLog\(describeRawForDiagnostics\(itRaw\), sourceContext\)/);
  assert.match(CREATE_ARTICLE, /safeSignalDiagnosticTextForLog\(describeJsonParseError\(itRepaired, parseErr\), sourceContext\)/);
  assert.match(CREATE_ARTICLE, /safeSignalTextForLog\(check\.articleId, h, '\[signal existing article id redacted\]'\)/);
  assert.match(CREATE_ARTICLE, /safeSignalTextForLog\(check\.existingId, h, '\[signal existing article id redacted\]'\)/);
  assert.match(THUMBNAIL_GENERATOR, /GITHUB_ACTIONS === 'true'[\s\S]*?thumbnail failed; source details withheld/);
  assert.doesNotMatch(THUMBNAIL_GENERATOR, /::error file=\$\{shown\}/);
});

test('generator log helpers redact signal headlines and provider diagnostics', () => {
  const candidate = { headline: SENTINEL, _discoveryCandidate: { source: 'trends' } };
  assert.equal(
    ARTICLE_SIGNAL_LOG_HELPERS.safeTopicSelectionLogLabel(candidate),
    '[signal topic redacted]',
  );
  assert.equal(
    ARTICLE_SIGNAL_LOG_HELPERS.safeSignalTextForLog(SENTINEL, candidate, '[signal topic redacted]'),
    '[signal topic redacted]',
  );
  assert.equal(
    ARTICLE_SIGNAL_LOG_HELPERS.safeSignalDiagnosticTextForLog(FREE_FORM_ERROR, candidate),
    '[signal-related diagnostic redacted]',
  );
});

test('trend-seeded evidence-search failures do not log trend queries or free-form errors', async () => {
  const output = await captureWarnings(async () => {
    await fetchAll({}, {
      orphanFn: () => [],
      suggestFn: async () => [],
      newsFn: async (_evidence, opts = {}) => {
        if (Array.isArray(opts.seeds)) throw new Error(FREE_FORM_ERROR);
        return [];
      },
      trendsFn: async () => [{
        headline: SENTINEL,
        source: 'trends',
        meta: { score: 100 },
      }],
    });
  });

  assert.match(output, /\[discovery\/trends\] evidence search failed error_type=Error/);
  assert.doesNotMatch(output, new RegExp(SENTINEL));
  assert.doesNotMatch(output, /provider failure echoed/);
});

test('Trends, Suggest, and News source errors do not log query seeds or free-form errors', async () => {
  const output = await captureWarnings(async () => {
    await fetchTrendsDiscoveryCandidates({}, {
      trendsFn: async () => { throw new Error(FREE_FORM_ERROR); },
    });
    await fetchSuggestDiscoveryCandidates({}, {
      seeds: [SENTINEL],
      suggestFn: async ({ seeds }) => { throw new Error(`Suggest failed for ${seeds[0]}`); },
    });
    await fetchNewsRssDiscoveryCandidates({}, {
      seeds: [SENTINEL],
      newsFn: async ({ seeds }) => { throw new Error(`News failed for ${seeds[0]}`); },
    });
  });

  assert.match(output, /\[discovery\/trends\] fetcher threw error_type=Error/);
  assert.match(output, /\[discovery\/suggest\] fetcher threw error_type=Error/);
  assert.match(output, /\[discovery\/news\] fetcher threw error_type=Error/);
  assert.doesNotMatch(output, new RegExp(SENTINEL));
  assert.doesNotMatch(output, /provider failure echoed|Suggest failed for|News failed for/);
});
