import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const createArticleSource = readFileSync(
  new URL('../scripts/create-article.mjs', import.meta.url),
  'utf8',
);
const generateArticleWorkflow = readFileSync(
  new URL('../../.github/workflows/generate-article.yml', import.meta.url),
  'utf8',
);
const generateArticleCoreWorkflow = readFileSync(
  new URL('../../.github/workflows/generate-article-core.yml', import.meta.url),
  'utf8',
);
function cutFunction(name) {
  const anchor = `function ${name}(`;
  const start = createArticleSource.indexOf(anchor);
  assert.notEqual(start, -1, `${anchor} missing from create-article.mjs`);
  const end = createArticleSource.indexOf('\n}\n', start);
  assert.ok(end > start, `closing brace for ${name} not found`);
  return createArticleSource.slice(start, end + 2);
}

function makePostRebaseReportProjector(signalTopicTerms) {
  return new Function(
    'SIGNAL_TOPIC_TERMS',
    `${cutFunction('isSignalDrivenRunReport')}\n`
      + `${cutFunction('projectRunReportForPostRebaseUniqueness')}\n`
      + 'return projectRunReportForPostRebaseUniqueness;',
  )(new Set(signalTopicTerms));
}

test('remembered signal terms do not classify a proven fallback as signal-driven', () => {
  const project = makePostRebaseReportProjector(['previous trend topic']);
  const projected = project({
    pool: 'proven',
    selectedTier: 'proven',
    discoveryAttribution: null,
    topicCandidateAttribution: null,
  });

  assert.equal(projected.signalDriven, false);
});

test('the selected discovery outcome remains signal-driven without remembered terms', () => {
  const project = makePostRebaseReportProjector([]);
  const projected = project({
    pool: 'discovery',
    selectedTier: 'proven',
    discoveryAttribution: null,
    topicCandidateAttribution: null,
  });

  assert.equal(projected.signalDriven, true);
});

test('selected signal-led discovery attribution reaches the run report and article sidecar', () => {
  assert.match(createArticleSource, /discoveryAttribution: null/);
  assert.match(createArticleSource, /topicCandidateAttribution: null/);
  assert.match(createArticleSource, /RUN_REPORT\.discoveryAttribution = null;/);
  assert.match(createArticleSource, /RUN_REPORT\.topicCandidateAttribution = null;/);
  assert.match(createArticleSource, /function isTrendBackedDiscoveryCandidate\(candidate\)/);
  assert.match(createArticleSource, /candidate\?\.source === 'trends'/);
  assert.match(createArticleSource, /attachTrendEvidenceToCandidates\(candidates, headlineSimilarity\)/);
  assert.match(createArticleSource, /Number\(pool\.perSource\?\.trends\)/);
  assert.match(createArticleSource, /Number\(pool\.perSource\?\.trendSignals\)/);
  assert.equal((createArticleSource.match(/trends=\$\{trendsWithEvidence\} trendSignals=\$\{trendSignals\}/gu) || []).length, 2);
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
  assert.match(createArticleSource, /projectTopicCandidateAttribution\(\s*_picked\._experimentalCandidate,\s*_experimentalCandidates\?\.generatedAt,/);
  assert.match(createArticleSource, /_topic_candidate_attribution: RUN_REPORT\.topicCandidateAttribution/);
  assert.match(createArticleSource, /RUN_REPORT\.discoveryAttribution\.resolvedSourceUrl = url/);
  assert.match(createArticleSource, /function isSignalDrivenTopicCandidate\(candidate\)/);
  assert.match(createArticleSource, /function safeTopicSelectionLogLabel\(candidate\)/);
  assert.match(createArticleSource, /if \(isSignalDrivenRunSelection\(candidate\)\) return '\[signal topic redacted\]';/);
  assert.match(createArticleSource, /const duplicateLabel = isSignalDrivenTopicCandidate\(chosen\)/);
  assert.match(createArticleSource, /const signalSelectionRedacted = isSignalDrivenTopicCandidate\(chosen\);/);
  assert.ok(createArticleSource.includes("headline: signalSelectionRedacted ? '[signal topic redacted]' : chosen.headline || ''"));
  assert.ok(createArticleSource.includes("url: signalSelectionRedacted ? null : chosen.url || ''"));
  assert.match(createArticleSource, /safeTopicSelectionLogLabel\(chosen\)/);
  assert.ok(createArticleSource.includes("signalSelectionRedacted ? '[url redacted]' : chosen.url || ''"));
  assert.ok(createArticleSource.includes("signalSelectionRedacted ? '[signal selection]' : selection.reason"));
  assert.ok(createArticleSource.includes('RUN_REPORT.selectedUrl = chosen?.url || null;'));
  assert.ok(createArticleSource.includes('RUN_REPORT.selectedUrl = null;'));
  assert.match(createArticleSource, /function projectRunReportForDiagnostics\(report\)/);
  assert.match(createArticleSource, /JSON\.stringify\(projectRunReportForDiagnostics\(RUN_REPORT\), null, 2\)/);
  assert.match(createArticleSource, /report\?\.pool === 'discovery'[\s\S]*?report\?\.selectedTier === 'experimental'/);
  assert.match(createArticleSource, /article: selectedFromSignalPool && report\?\.article[\s\S]*?sourceDomain: null,[\s\S]*?title: null/);
  assert.match(createArticleSource, /function projectDiscardedHeadlineSample\(sample, redactOptions = false\)/);
  assert.match(createArticleSource, /const shouldRedactExistingId = redactExistingId \|\| sample\.signalDriven === true;/);
  assert.match(createArticleSource, /projected\.classifierReason = '\[classifier reason redacted\]'/);
  assert.match(createArticleSource, /function redactSignalDrivenReportNote\(note\)/);
  assert.ok(createArticleSource.includes("return safe.replace(/[a-z][a-z0-9+.-]*:\\/\\/[^\\s]+/giu, '[signal URL redacted]')"));
  assert.match(createArticleSource, /report\.notes\.map\(\(note\) => \(selectedFromSignalPool \|\| SIGNAL_TOPIC_TERMS\.size > 0\)/);
  assert.match(createArticleSource, /function safeSignalSourceUrlForLog\(url, candidate\)/);
  assert.ok(createArticleSource.includes('safeSignalSourceUrlForLog(resolved.url, resolved)'));
  assert.match(createArticleSource, /logArticleId: safeSignalTextForLog\(data\.id, null, '\[signal_article_id_redacted\]'\)/);
  assert.equal((createArticleSource.match(/logArticleId: safeSignalTextForLog\(data\.id, null, '\[signal_article_id_redacted\]'\)/g) || []).length, 2);
  assert.match(createArticleSource, /logReason: safeSignalDiagnosticTextForLog\(fallbackReason\)/);
  assert.match(createArticleSource, /could not write pool sidecar: \$\{safeSignalDiagnosticTextForLog\(e\?\.message \|\| e\)\}/);
  assert.match(createArticleSource, /console\.error\('RANKER_ERROR fallback=llm_selector'\)/);
  assert.doesNotMatch(createArticleSource, /Ranker error[^\n]*rankerErr\?\.message/);
  assert.match(createArticleSource, /headline=\$\{signalDriven \? '\[signal_topic_redacted\]' : encodeURIComponent/);
  assert.match(createArticleSource, /const headlineLabel = f\.signalDriven \? '\[signal topic redacted\]'/);
  assert.match(createArticleSource, /function rememberSignalTopicCandidate\(candidate\)/);
  assert.match(createArticleSource, /function projectRunReportForPostRebaseUniqueness\(report\)/);
  assert.match(createArticleSource, /JSON\.stringify\(projectRunReportForPostRebaseUniqueness\(RUN_REPORT\), null, 2\)/);
  assert.match(createArticleSource, /signalDriven: isSignalDrivenRunReport\(report\)/);
  assert.match(createArticleSource, /function isSignalDrivenRunReport\(report\)/);
  assert.match(createArticleSource, /console\.error\('  ✅ Immagine generata'\)/);
  assert.match(createArticleSource, /headline: '\[signal headline redacted\]'/);
  for (const key of ['signalHeadline', 'evidenceUrl', 'resolvedSourceUrl', 'evidenceHeadline']) {
    assert.ok(createArticleSource.includes(`${key}: null`));
  }
  assert.ok(createArticleSource.includes('candidateId: null'));
  assert.ok(createArticleSource.includes('redditPermalink: null'));
  for (const workflow of [generateArticleWorkflow, generateArticleCoreWorkflow]) {
    assert.match(workflow, /CREATE_ARTICLE_POST_REBASE_REPORT_FILE="\$attempt_post_rebase_handoff"/);
    assert.match(workflow, /--run-report "\$POST_REBASE_RUN_REPORT"/);
    assert.match(workflow, /jq -e '\.signalDriven == false' "\$private_report"/);
    assert.match(workflow, /echo "article body added"/);
    assert.ok(workflow.includes('La riga \\`article body added\\` conferma'));
    assert.doesNotMatch(workflow, /article body added: \$body/);
    assert.doesNotMatch(workflow, /^\s+git commit (?!\-\-quiet)/m);
    assert.match(workflow, /check-blog-locale-completeness\.mjs --changed-paths --redact-paths/);
  }
  assert.match(
    createArticleSource,
    /RUN_REPORT\.selectedSource = 'evergreen';\s+RUN_REPORT\.selectedUrl = `evergreen:\/\/[^`]+`;\s+RUN_REPORT\.discoveryAttribution = null;\s+RUN_REPORT\.topicCandidateAttribution = null;/,
  );
  assert.match(createArticleSource, /RUN_REPORT\.status !== 'generated' \|\| !RUN_REPORT\.article\?\.id/);
  assert.match(createArticleSource, /DISCOVERY_POOL_BUILD_FALLBACK[^\n]*trendSignals=/);
  assert.match(createArticleSource, /Trend-backed source rejected: resolved publisher URL is not HTTPS/);
});
