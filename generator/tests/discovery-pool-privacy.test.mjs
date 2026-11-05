import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

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
  assert.match(CREATE_ARTICLE, /Provenienza immagine governata rifiutata: \$\{safeSignalDiagnosticTextForLog\(error\?\.message \|\| error, RUN_REPORT\)\}/);
  assert.match(CREATE_ARTICLE, /safeSignalTextForLog\(result\.record\.imageUrl, RUN_REPORT, '\[signal image path redacted\]'\)/);
  assert.doesNotMatch(CREATE_ARTICLE, /Copertina governata: \$\{result\.record\.imageUrl\}/);
  assert.match(CREATE_ARTICLE, /discardedHeadlineSamples\.map\(\(sample\) => projectDiscardedHeadlineSample\(sample, \{/);
  assert.match(CREATE_ARTICLE, /function projectDiscardedHeadlineSample\(sample, redactOptions = false\)/);
  assert.match(CREATE_ARTICLE, /const shouldRedactExistingId = redactExistingId \|\| sample\.signalDriven === true;/);
  assert.match(CREATE_ARTICLE, /candidate: h/);
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

test('signal-driven generation diagnostics redact model reasons and article identifiers', () => {
  assert.match(CREATE_ARTICLE, /safeSignalDiagnosticTextForLog\(String\(bodyData\.reason \|\| ''\)\.slice\(0, 200\), sourceContext\)/);
  assert.match(CREATE_ARTICLE, /safeSignalDiagnosticTextForLog\(String\(itData\.reason \|\| ''\)\.slice\(0, 200\), sourceContext\)/);
  assert.match(CREATE_ARTICLE, /RUN_REPORT\.lastTopicGateAbortReason = safeReason/);
  assert.match(CREATE_ARTICLE, /safeSignalTextForLog\(data\?\.id \|\| '\(id mancante\)', RUN_REPORT, '\[signal article id redacted\]'\)/);
  assert.match(CREATE_ARTICLE, /safeSignalTextForLog\(data\.id, RUN_REPORT, '\[signal article id redacted\]'\)/);
  assert.match(CREATE_ARTICLE, /safeSignalTextForLog\(result\.record\.imageUrl, RUN_REPORT, '\[signal image path redacted\]'\)/);
  assert.match(CREATE_ARTICLE, /safeSignalDiagnosticTextForLog\(e\.message, RUN_REPORT\)/);
  assert.doesNotMatch(CREATE_ARTICLE, /reason: "\$\{String\(bodyData\.reason/);
  assert.doesNotMatch(CREATE_ARTICLE, /reason given: "\$\{String\((?:bodyData|itData)\.reason/);
  assert.doesNotMatch(CREATE_ARTICLE, /\[source-copy\] article=\$\{data\.id\}/);
  assert.doesNotMatch(CREATE_ARTICLE, /Copertina governata: \$\{result\.record\.imageUrl\}/);
  assert.doesNotMatch(CREATE_ARTICLE, /FAQ for \$\{locale\}\/\$\{id\} dropped/);
});

test('diagnostic report omits existing article IDs beside signal-driven candidates', () => {
  assert.match(CREATE_ARTICLE, /projectDiscardedHeadlineSample\(sample, \{[\s\S]{0,150}redactExistingId: sample\?\.signalDriven === true \|\| selectedFromSignalPool \|\| SIGNAL_TOPIC_TERMS\.size > 0/);
  assert.match(CREATE_ARTICLE, /function projectDiscardedHeadlineSample\(sample, redactOptions = false\)/);
  assert.match(CREATE_ARTICLE, /const redactExistingId = typeof redactOptions === 'boolean'[\s\S]{0,120}redactOptions\?\.redactExistingId === true/);
  assert.match(CREATE_ARTICLE, /if \(!shouldRedactExistingId && sample\.existingId !== undefined\) projected\.existingId = sample\.existingId/);
  assert.doesNotMatch(CREATE_ARTICLE, /for \(const key of \['reason', 'existingId', 'existingSection'/);
  assert.match(CREATE_ARTICLE, /topicCandidateAttribution: topicCandidateAttribution[\s\S]{0,150}candidateId: null/);
});

test('pre-classification signal filters redact existing article IDs per candidate', () => {
  assert.match(CREATE_ARTICLE, /safeSignalTextForLog\(check\.articleId, h, '\[signal existing article id redacted\]'\)/);
  assert.match(CREATE_ARTICLE, /safeSignalTextForLog\(check\.existingId, h, '\[signal existing article id redacted\]'\)/);
  assert.match(CREATE_ARTICLE, /candidate: h,/);
  assert.match(CREATE_ARTICLE, /signalDriven: f\.signalDriven === true/);
  assert.match(CREATE_ARTICLE, /const \{ candidate = null, \.\.\.sample \} = entry/);
  assert.match(CREATE_ARTICLE, /const signalDriven = entry\.signalDriven === true \|\| isSignalDrivenTopicCandidate\(candidate\)/);
  assert.match(CREATE_ARTICLE, /RUN_REPORT\.discardedHeadlineSamples\.push\(\{ \.\.\.sample, signalDriven \}\)/);
});

test('model parse, retry, rebracket, and translation snippets fail closed for signal runs', () => {
  assert.equal((CREATE_ARTICLE.match(/safeSignalDiagnosticTextForLog\(describeJsonParseError\(/g) || []).length, 3);
  assert.equal((CREATE_ARTICLE.match(/safeSignalDiagnosticTextForLog\(describeRawForDiagnostics\(/g) || []).length, 3);
  assert.equal((CREATE_ARTICLE.match(/safeSignalDiagnosticTextForLog\(\s*describePayloadRejection\(/g) || []).length, 2);
  assert.match(CREATE_ARTICLE, /if \(itContent\) \{\s+console\.error\(`  🧪 rigetto: \$\{safeSignalDiagnosticTextForLog\([\s\S]{0,200}RUN_REPORT/);
  assert.doesNotMatch(CREATE_ARTICLE, /console\.error\(`  🧪 rigetto: \$\{describePayloadRejection/);
  assert.match(CREATE_ARTICLE, /safeSignalDiagnosticTextForLog\(e2\.message, sourceContext\)/);
  assert.match(CREATE_ARTICLE, /safeSignalDiagnosticTextForLog\(retryErr\.message, sourceContext\)/);
  assert.match(CREATE_ARTICLE, /safeSignalDiagnosticTextForLog\(retry2Err\.message, RUN_REPORT\)/);
  assert.doesNotMatch(CREATE_ARTICLE, /console\.error\([^\n]*\$\{(?:parseErr|retryErr|retry2Err|e2)\.message\s*\}/);
});

test('provider errors echoed by translation retries are redacted at every catch sink', () => {
  assert.match(CREATE_ARTICLE, /FAQ translation failed for \$\{targetLang\}: \$\{safeSignalDiagnosticTextForLog\(err\?\.message \|\| err, RUN_REPORT\)\}/);
  assert.match(CREATE_ARTICLE, /const onTranslateFail = \(label\) => \(err\) => \{[\s\S]{0,220}safeSignalDiagnosticTextForLog\(err\?\.message \|\| err, RUN_REPORT\)/);
  assert.match(CREATE_ARTICLE, /translation aborted \(\$\{safeSignalDiagnosticTextForLog\(err\?\.message \|\| err, RUN_REPORT\)\}\)/);

  const loggerSource = CREATE_ARTICLE.match(/function safeSignalDiagnosticTextForLog\(value, candidate\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(loggerSource, 'the production signal-safe diagnostic formatter is present');
  const safeDiagnostic = runInNewContext(`(${loggerSource})`, {
    isSignalDrivenRunSelection: (candidate) => candidate?.pool === 'discovery',
    SIGNAL_TOPIC_TERMS: new Set([SENTINEL]),
    redactSignalDrivenReportNote: (value) => value,
  });
  const providerError = new Error(`provider retry failed while translating ${SENTINEL}`);
  const rendered = safeDiagnostic(providerError?.message || providerError, { pool: 'discovery' });

  assert.equal(rendered, '[signal-related diagnostic redacted]');
  assert.doesNotMatch(rendered, new RegExp(SENTINEL));
});

test('generation and free-MT catch logs redact provider errors that echo the topic', () => {
  const sinks = [
    ['excerpt generation', /generateExcerpt fallito, uso fallback troncato: \$\{safeSignalDiagnosticTextForLog\(err\?\.message \|\| err, RUN_REPORT\)\}/],
    ['body splitting', /splitBodyIntoSections tentativo \$\{attempt\} fallito: \$\{safeSignalDiagnosticTextForLog\(err\?\.message \|\| err, RUN_REPORT\)\}/],
    ['body expansion', /\$\{field\}: espansione fallita: \$\{safeSignalDiagnosticTextForLog\(e\?\.message \|\| e, RUN_REPORT\)\}/],
    ['free-MT FAQ', /free-MT \$\{targetLang\}:faq fallita \(\$\{safeSignalDiagnosticTextForLog\(err\?\.message \|\| err, RUN_REPORT\)\}\)/],
    ['early body expansion', /Espansione fallita: \$\{safeSignalDiagnosticTextForLog\(expandErr\?\.message \|\| expandErr, RUN_REPORT\)\}/],
    ['image provenance', /Provenienza immagine governata rifiutata: \$\{safeSignalDiagnosticTextForLog\(error\?\.message \|\| error, RUN_REPORT\)\}/],
  ];
  for (const [label, pattern] of sinks) assert.match(CREATE_ARTICLE, pattern, label);

  const loggerSource = CREATE_ARTICLE.match(/function safeSignalDiagnosticTextForLog\(value, candidate\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(loggerSource, 'the production signal-safe diagnostic formatter is present');
  const safeDiagnostic = runInNewContext(`(${loggerSource})`, {
    isSignalDrivenRunSelection: (candidate) => candidate?.pool === 'discovery',
    SIGNAL_TOPIC_TERMS: new Set([SENTINEL]),
    redactSignalDrivenReportNote: (value) => value,
  });
  const providerError = new Error(`provider response echoed the private topic ${SENTINEL}`);
  const rendered = safeDiagnostic(providerError?.message || providerError, { pool: 'discovery' });

  assert.equal(rendered, '[signal-related diagnostic redacted]');
  assert.doesNotMatch(rendered, new RegExp(SENTINEL));
});

test('signal-driven YMYL and factuality gates redact rejection payloads and excerpts', () => {
  const gates = [
    ['YMYL', /\$\{safeSignalDiagnosticTextForLog\(ymylErr\?\.message \|\| ymylErr, RUN_REPORT\)\}/],
    ['fabricated references', /\$\{safeSignalDiagnosticTextForLog\(fabErr\?\.message \|\| fabErr, RUN_REPORT\)\}/],
    ['fabricated norm acronyms', /\$\{safeSignalDiagnosticTextForLog\(normErr\?\.message \|\| normErr, RUN_REPORT\)\}/],
  ];
  for (const [label, pattern] of gates) assert.match(CREATE_ARTICLE, pattern, label);
  for (const errName of ['ymylErr', 'fabErr', 'normErr']) {
    assert.doesNotMatch(CREATE_ARTICLE, new RegExp(`console\\.error\\([^\\n]*\\$\\{${errName}\\.message\\}`));
  }
});

test('signal-driven fact-check false-positive logs redact the dropped claim', () => {
  assert.match(CREATE_ARTICLE, /Falso positivo scartato \(\$\{r\.model\}\): "\$\{safeSignalDiagnosticTextForLog\(\(d\.claim \|\| ''\)\.slice\(0, 70\), RUN_REPORT\)\}"/);
  assert.doesNotMatch(CREATE_ARTICLE, /Falso positivo scartato[^\n]*\$\{\(d\.claim \|\| ''\)\.slice\(0, 70\)\}/);
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
