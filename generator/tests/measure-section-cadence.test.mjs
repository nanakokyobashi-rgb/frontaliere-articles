import test from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateM1BySection,
  buildArticleRecords,
  buildM6ArticleRecords,
  buildM6RuntimeLogCoverage,
  countCorpusArticlesBySection,
  commitTouchedSections,
  countCronOccurrences,
  extractCanonical,
  extractDatePublished,
  countPushFiveAttemptExhaustions,
  createM6InputSnapshot,
  generationJobWasAdmitted,
  hasCompleteM5Coverage,
  m6ZeroIsDateIndependent,
  makeDateWindow,
  m4MetricsAvailability,
  m6MetricIsAvailable,
  nearDuplicateThresholdForPair,
  parseGenerationAttempts,
  parseGenerationMarkers,
  parseLlmMetricMarkers,
  parseDedupStoreMarkers,
  percentiles,
  recordGenerationOutcome,
  resolveThresholdCorpusSize,
  sectionFromGeneration,
  summarizeDedupRuntimeEvidence,
  computePolicyThresholdFromParameters,
  summarizeM1IndexCoverage,
  verifyM6InputSnapshot,
} from '../../scripts/ci/measure-section-cadence.mjs';
import { ARTICLE_SECTION_CORE_ALL } from '../../engine/shared/articleSectionCore.mjs';

test('date windows use inclusive Zurich calendar dates across the CET offset', () => {
  const window = makeDateWindow('2026-11-25', '2026-11-25');
  assert.equal(window.start.toISOString(), '2026-11-24T23:00:00.000Z');
  assert.equal(window.endExclusive.toISOString(), '2026-11-25T23:00:00.000Z');
  assert.equal(countCronOccurrences('7 * * * *', window.start, window.endExclusive), 24);
  assert.equal(countCronOccurrences('16 0,6,12,18 * * *', window.start, window.endExclusive), 4);
  const springDstDay = makeDateWindow('2026-03-29', '2026-03-29');
  assert.equal((springDstDay.endExclusive - springDstDay.start) / 3_600_000, 23);
  assert.equal(countCronOccurrences('7 * * * *', springDstDay.start, springDstDay.endExclusive), 23);
});

test('generation markers ignore unresolved workflow source lines and keep resolved outcomes', () => {
  const log = [
    'job\tstep\t2026-11-25T10:00:00Z\tRun echo "GENERATION_OUTCOME kind=skipped reason=admit-body-maintenance section=unknown"',
    'job\tstep\t2026-11-25T10:00:00Z\techo "GENERATION_OUTCOME kind=$outcome_kind reason=$outcome_reason section=$outcome_section"',
    'job\tstep\t2026-11-25T10:00:00Z\t\u001b[36;1mecho "GENERATION_OUTCOME kind=$outcome_kind reason=$outcome_reason section=$outcome_section"\u001b[0m',
    'job\tstep\t2026-11-25T10:01:00Z\t\u001b[36;1mGENERATION_OUTCOME kind=no-article reason=declared section=frontaliere\u001b[0m',
    'job\tstep\t2026-11-25T10:00:00Z\tGENERATION_OUTCOME kind=skipped reason=admit-in-flight section=unknown',
    'job\tstep\t2026-11-25T10:00:00Z\tGENERATION_OUTCOME kind=generated reason=article section=canton-ti',
  ].join('\n');
  assert.deepEqual(parseGenerationMarkers(log), [
    { kind: 'no-article', reason: 'declared', section: 'frontaliere' },
    { kind: 'skipped', reason: 'admit-in-flight', section: 'unknown' },
    { kind: 'generated', reason: 'article', section: 'canton-ti' },
  ]);
  assert.equal(sectionFromGeneration({ section: null }, {}, parseGenerationMarkers(log), log), 'canton-ti');
  const eventLog = 'job\tstep\t2026-11-25T10:02:00Z\t\u001b[36;1mevent=push chain=true chain_link=false → section=frontaliere dry_run=false\u001b[0m';
  assert.equal(sectionFromGeneration({ section: null }, {}, [], eventLog), 'frontaliere');
});

test('actual three-field Actions TSV logs preserve runtime payload after timestamp and ANSI', () => {
  // Sanitized fixture from run 45717129749: `gh run view --log` emits job, step,
  // then a timestamp-prefixed payload in the third TSV field.
  const log = [
    'generate\tRun generation\t2026-11-25T22:58:50.0998773Z Run echo "GENERATION_OUTCOME kind=no-article reason=declared section=frontaliere"',
    'generate\tResolve section\t2026-11-25T22:58:51.1234567Z \u001b[36;1mevent=push chain=true chain_link=false → section=frontaliere dry_run=false\u001b[0m',
    'generate\tEmit outcome\t2026-11-25T22:58:52.0000000Z \u001b[36;1mGENERATION_OUTCOME kind=no-article reason=declared section=frontaliere\u001b[0m',
    'generate\tAttempt\t2026-11-25T22:58:53.0000000Z GENERATION_ATTEMPT attempt=2 section=canton-ti',
    'generate\tLLM metrics\t2026-11-25T22:58:54.0000000Z GENERATION_LLM_CALLS {"schemaVersion":1,"generationAttempt":2,"section":"canton-ti","providerRequestsByStage":{"selection":1,"generation":2,"factCheck":0,"translation":3,"unclassified":0}}',
    'generate\tPush failure\t2026-11-25T22:58:55.0000000Z ::error::push failed after 5 attempts\t— the article is registered locally but not pushed',
  ].join('\n');
  assert.deepEqual(parseGenerationMarkers(log), [
    { kind: 'no-article', reason: 'declared', section: 'frontaliere' },
  ]);
  assert.equal(sectionFromGeneration({ section: null }, {}, parseGenerationMarkers(log), log), 'frontaliere');
  assert.deepEqual(parseGenerationAttempts(log), [{ attempt: 2, section: 'canton-ti' }]);
  assert.deepEqual(parseLlmMetricMarkers(log).map(({ attempt, section }) => ({ attempt, section })), [
    { attempt: 2, section: 'canton-ti' },
  ]);
  assert.equal(countPushFiveAttemptExhaustions(log), 1);
});

test('attempt parser accepts only resolved runtime markers', () => {
  const log = [
    'job\tstep\t2026-11-25T10:00:00Z\tRun echo "GENERATION_ATTEMPT attempt=$tried section=$sec"',
    'job\tstep\t2026-11-25T10:00:00Z\tGENERATION_ATTEMPT attempt=2 section=canton-ti',
    'job\tstep\t2026-11-25T10:00:00Z\tGENERATION_ATTEMPT attempt=$tried section=$sec',
  ].join('\n');
  assert.deepEqual(parseGenerationAttempts(log), [{ attempt: 2, section: 'canton-ti' }]);
});

test('structured provider request metrics parser ignores source templates and keeps attempt identity', () => {
  const log = [
    'job\tstep\t2026-11-25T10:00:00Z\tRun echo "GENERATION_LLM_CALLS ${JSON.stringify(payload)}"',
    'job\tstep\t2026-11-25T10:00:00Z\tGENERATION_LLM_CALLS {"schemaVersion":1,"generationAttempt":2,"section":"canton-ti","providerRequestsByStage":{"selection":2,"generation":3,"factCheck":1,"translation":4,"unclassified":0}}',
    'job\tstep\t2026-11-25T10:05:00Z\tGENERATION_LLM_CALLS {"schemaVersion":1,"generationAttempt":3,"section":"canton-ti","providerRequestsByStage":{"selection":1,"generation":5,"factCheck":0,"translation":4,"unclassified":0}}',
    'job\tstep\t2026-11-25T10:00:00Z\tGENERATION_LLM_CALLS {"schemaVersion":1,"generationAttempt":2,"section":"canton-ti","providerRequestsByStage":{"selection":-1}}',
  ].join('\n');
  assert.deepEqual(parseLlmMetricMarkers(log), [
    {
      attempt: 2,
      section: 'canton-ti',
      providerRequestsByStage: { selection: 2, generation: 3, factCheck: 1, translation: 4, unclassified: 0 },
    },
    {
      attempt: 3,
      section: 'canton-ti',
      providerRequestsByStage: { selection: 1, generation: 5, factCheck: 0, translation: 4, unclassified: 0 },
    },
  ]);
});

test('M6 runtime parser rejects source echoes and preserves effective and fail-open evidence', () => {
  const policyParameters = { baseThreshold: 0.86, ceiling: 0.95, corpusBaseline: 300, corpusScaleK: 0.08 };
  const active = {
    schemaVersion: 1,
    observedAt: '2026-11-25T10:00:00.000Z',
    section: 'canton-ti',
    generationAttempt: 2,
    candidateId: 'article-one',
    status: 'compared',
    storePresent: true,
    storeCount: 300,
    storeDimension: 384,
    metaPresent: true,
    metaCount: 300,
    metaDimension: 384,
    metaMappedCount: 300,
    metaModel: 'Xenova/multilingual-e5-small',
    expectedModel: 'Xenova/multilingual-e5-small',
    expectedDimension: 384,
    queryModel: 'Xenova/multilingual-e5-small',
    gateApplied: true,
    policyThreshold: 0.86,
    policyParameters,
    effectiveThreshold: 0.86,
    thresholdSource: 'runtime_store_count',
  };
  const failOpen = {
    ...active,
    observedAt: '2026-11-25T11:00:00.000Z',
    status: 'model_mismatch',
    metaModel: 'old-model',
    gateApplied: false,
    effectiveThreshold: null,
  };
  const log = [
    `job\tstep\t2026-11-25T09:59:00Z\tRun echo "GENERATION_DEDUP_STORE ${JSON.stringify(active)}"`,
    `job\tstep\t2026-11-25T10:00:00Z\tGENERATION_DEDUP_STORE ${JSON.stringify(active)}`,
    `job\tstep\t2026-11-25T11:00:00Z\tGENERATION_DEDUP_STORE ${JSON.stringify(failOpen)}`,
  ].join('\n');
  const parsed = parseDedupStoreMarkers(log);
  assert.deepEqual(parsed.map(({ status }) => status), ['compared', 'model_mismatch']);
  assert.equal(parsed[0].effectiveThreshold, 0.86);
  assert.equal(parsed[1].policyThreshold, 0.86);
  assert.equal(parsed[1].effectiveThreshold, null);
  assert.equal(summarizeDedupRuntimeEvidence(parsed.slice(0, 1), ['canton-ti'])['canton-ti'].latestGateStatus, 'active_verified');
  const unknownModel = {
    ...active,
    metaModel: null,
    queryModel: null,
    expectedModel: null,
    storeDimension: 768,
    expectedDimension: 768,
  };
  assert.equal(summarizeDedupRuntimeEvidence([{ ...parsed[0], ...unknownModel }], ['canton-ti'])['canton-ti'].latestGateStatus, 'active_model_or_threshold_unverified');
  const summary = summarizeDedupRuntimeEvidence(parsed, ['canton-ti']);
  assert.equal(summary['canton-ti'].latestGateStatus, 'fail_open:model_mismatch');
  assert.equal(summary['canton-ti'].windowGateStatus, 'fail_open_observed_in_window');
  assert.equal(summary['canton-ti'].observationCount, 2);
  assert.equal(summary['canton-ti'].minimumVerifiedEffectiveThreshold, 0.86);
  assert.equal(summary['canton-ti'].minimumVerifiedStoreCount, 300);

  const higherThreshold = {
    ...active,
    observedAt: '2026-11-25T12:00:00.000Z',
    storeCount: 1000,
    metaCount: 1000,
    metaMappedCount: 1000,
    effectiveThreshold: 0.91,
  };
  const changingThresholds = summarizeDedupRuntimeEvidence([active, higherThreshold], ['canton-ti'])['canton-ti'];
  assert.equal(changingThresholds.minimumVerifiedEffectiveThreshold, 0.86);
  assert.equal(changingThresholds.verifiedThresholdsStable, false);
});

test('M6 policy reconstruction uses the runtime formula parameters when the store is absent', () => {
  const parameters = { baseThreshold: 0.86, ceiling: 0.95, corpusBaseline: 300, corpusScaleK: 0.08 };
  assert.equal(computePolicyThresholdFromParameters(300, parameters), 0.86);
  assert.ok(Math.abs(computePolicyThresholdFromParameters(3000, parameters) - 0.94) < 1e-12);
  assert.equal(computePolicyThresholdFromParameters(300, { ...parameters, corpusBaseline: 0 }), null);
});

test('M6 date-unknown candidates establish zero only at observed production thresholds', () => {
  const observed = {
    latestGateStatus: 'active_verified',
    windowGateStatus: 'active_verified_in_observed_markers',
    runtimeLogCoverage: { complete: true },
    thresholdSource: 'runtime_observed_min_verified_effective_threshold',
  };
  assert.equal(m6ZeroIsDateIndependent({
    candidateWindowComplete: false,
    upperBoundCoverageComplete: true,
    upperBoundPairCount: 0,
    activeSections: ['frontaliere'],
    sectionStoreStatus: { frontaliere: observed },
  }), true);
  assert.equal(m6ZeroIsDateIndependent({
    candidateWindowComplete: false,
    upperBoundCoverageComplete: true,
    upperBoundPairCount: 0,
    activeSections: ['frontaliere'],
    sectionStoreStatus: { frontaliere: { ...observed, thresholdSource: 'local_policy_with_manifest_count_reconstruction_runtime_unobserved' } },
  }), false);
  assert.equal(m6ZeroIsDateIndependent({
    candidateWindowComplete: false,
    upperBoundCoverageComplete: true,
    upperBoundPairCount: 1,
    activeSections: ['frontaliere'],
    sectionStoreStatus: { frontaliere: observed },
  }), false);
});

test('push exhaustion counter ignores workflow source and counts emitted runtime errors', () => {
  assert.equal(countPushFiveAttemptExhaustions([
    'job\tstep\t2026-11-25T10:00:00Z\tRun echo "::error::push failed after 5 attempts — ..."',
    'job\tstep\t2026-11-25T10:00:01Z\t::error::push failed after 5 attempts — the article is registered locally but not pushed',
  ].join('\n')), 1);
});

test('public API records join ID, section slug and localized metadata', () => {
  const api = {
    national: [{ id: 'news-one', date: '2026-11-25', section: undefined, commit: 'abc' }],
    swiss: [{ id: 'news-two', date: '2026-11-25T00:00:00+01:00' }],
    cantons: [{ id: 'news-three', date: '2026-11-25T23:30:00Z', section: 'canton-ti' }],
    slugs: {
      blog: { 'news-one': { it: 'notizia-uno' } },
      swiss: { 'news-two': { it: 'notizia-due' } },
      cantons: { 'news-three': { it: 'notizia-tre' } },
    },
    meta: {
      frontaliere: { 'blog.article.news-one.title': 'Uno', 'blog.article.news-one.excerpt': 'Estratto uno' },
      svizzera: { 'blog.article.news-two.title': 'Due', 'blog.article.news-two.excerpt': 'Estratto due' },
      canton: { 'blog.article.news-three.title': 'Tre', 'blog.article.news-three.excerpt': 'Estratto tre' },
    },
  };
  const result = buildArticleRecords(api);
  assert.equal(result.indexRecordCount, 3);
  assert.equal(result.articles.length, 3);
  assert.equal(result.articles[0].url, 'https://frontaliereticino.ch/articoli-frontaliere/notizia-uno/');
  assert.equal(result.articles[1].section, 'svizzera');
  assert.equal(result.articles[2].publishedDate, '2026-11-26');
  assert.equal(result.articles[2].title, 'Tre');

  const m6 = buildM6ArticleRecords({ ...api, slugs: {} }, '2026-11-25', '2026-11-26');
  assert.equal(m6.coverageComplete, true);
  assert.equal(m6.skippedRecords.length, 0);
  assert.equal(m6.articles.length, 3);
  assert.equal(m6.countsBySection.frontaliere, 1);
  assert.equal(m6.countsBySection.svizzera, 1);
  assert.equal(m6.countsBySection['canton-ti'], 1);

  const incompleteApi = {
    ...api,
    slugs: { ...api.slugs, blog: {} },
  };
  const incomplete = buildArticleRecords(incompleteApi);
  const coverage = summarizeM1IndexCoverage(incompleteApi, incomplete, '2026-11-25', '2026-11-25');
  assert.equal(coverage.sections.frontaliere.missingCandidateMappingsInWindow, 1);
  assert.equal(coverage.sections.frontaliere.coverageComplete, false);
});

test('M6 keeps unknown-date text in a conservative candidate upper bound', () => {
  const api = {
    national: [{ id: 'legacy-article', date: '' }],
    swiss: [],
    cantons: [],
    meta: {
      frontaliere: {
        'blog.article.legacy-article.title': 'Articolo storico',
        'blog.article.legacy-article.excerpt': 'Contesto e dettagli dell’articolo storico.',
      },
      svizzera: {},
      canton: {},
    },
  };

  const completeText = buildM6ArticleRecords(api, '2026-08-28', '2026-11-25');
  assert.equal(completeText.coverageComplete, false);
  assert.equal(completeText.upperBoundCoverageComplete, true);
  assert.deepEqual(completeText.unknownDateRecords.map(({ id }) => id), ['legacy-article']);
  assert.deepEqual(completeText.dateUncertainArticles.map(({ id, section, dateStatus }) => ({ id, section, dateStatus })), [
    { id: 'legacy-article', section: 'frontaliere', dateStatus: 'unknown_in_published_index' },
  ]);
  assert.equal(completeText.candidateRecordCount, 1);

  const missingText = buildM6ArticleRecords({
    ...api,
    meta: { ...api.meta, frontaliere: { 'blog.article.legacy-article.title': 'Articolo storico' } },
  }, '2026-08-28', '2026-11-25');
  assert.equal(missingText.dateUncertainArticles.length, 0);
  assert.equal(missingText.upperBoundCoverageComplete, false);
});

test('slug deduplication is scoped to section and skipped records remain explicit', () => {
  const api = {
    national: [
      { id: 'same-national', date: '2026-11-25' },
      { id: 'duplicate-national', date: '2026-11-25' },
    ],
    swiss: [],
    cantons: [{ id: 'same-canton', date: '2026-11-25', section: 'canton-ti' }],
    slugs: {
      blog: { 'same-national': { it: 'same-slug' }, 'duplicate-national': { it: 'same-slug' } },
      swiss: {},
      cantons: { 'same-canton': { it: 'same-slug' } },
    },
    meta: { frontaliere: {}, svizzera: {}, canton: {} },
  };
  const result = buildArticleRecords(api);
  assert.deepEqual(result.articles.map(({ section, slug }) => `${section}:${slug}`), [
    'frontaliere:same-slug',
    'canton-ti:same-slug',
  ]);
  assert.deepEqual(result.duplicateSlugsBySection, { frontaliere: 1 });
  assert.equal(result.missingRecordCount, 1);
});

test('M1 verified totals are bucketed by the verified Zurich datePublished day', () => {
  const candidates = [
    { section: 'frontaliere', id: 'one', publishedDate: '2026-11-25' },
    { section: 'frontaliere', id: 'two', publishedDate: '2026-11-25' },
    { section: 'frontaliere', id: 'three', publishedDate: '2026-11-26' },
  ];
  const pageResults = [
    { article: candidates[0], m1Verified: true, publishedDate: '2026-11-25' },
    { article: candidates[1], m1Verified: true, publishedDate: '2026-11-26' },
    { article: candidates[2], m1Verified: false, publishedDate: null },
  ];
  const report = aggregateM1BySection(['frontaliere'], candidates, pageResults, '2026-11-25', '2026-11-26');
  assert.equal(report.frontaliere.verifiedArticles, 2);
  assert.deepEqual(report.frontaliere.byZurichDate, {
    '2026-11-25': { indexedCandidates: 2, verifiedArticles: 1, unverifiedCandidates: 1 },
    '2026-11-26': { indexedCandidates: 1, verifiedArticles: 1, unverifiedCandidates: 1 },
  });
  const withUnmapped = aggregateM1BySection(['frontaliere'], candidates, pageResults, '2026-11-25', '2026-11-26', [
    { section: 'frontaliere', id: null, publishedDate: '2026-11-25' },
  ]);
  assert.equal(withUnmapped.frontaliere.indexedCandidates, 4);
  assert.equal(withUnmapped.frontaliere.unverifiedCandidates, 3);
});

test('M2 admission excludes completed skipped jobs, and M6 uses section-local thresholds', () => {
  assert.equal(generationJobWasAdmitted({ status: 'completed', conclusion: 'skipped', startedAt: null }), false);
  assert.equal(generationJobWasAdmitted({ status: 'completed', conclusion: 'failure', startedAt: '2026-11-25T10:00:00Z' }), true);
  assert.equal(generationJobWasAdmitted({ status: 'queued', conclusion: null, startedAt: null }), true);
  const thresholds = { 'canton-ti': 0.94, 'canton-be': 0.92 };
  assert.equal(nearDuplicateThresholdForPair({ section: 'canton-ti' }, { section: 'canton-ti' }, thresholds), 0.94);
  assert.equal(nearDuplicateThresholdForPair({ section: 'canton-ti' }, { section: 'canton-be' }, thresholds), 0.92);
  assert.deepEqual(countCorpusArticlesBySection([
    { section: 'frontaliere' }, { section: 'canton-ti' }, { section: 'canton-ti' },
  ], ['frontaliere', 'canton-ti']), { frontaliere: 1, 'canton-ti': 2 });
  assert.deepEqual(resolveThresholdCorpusSize({ storeCount: 42, storeFileMissing: false, publishedIndexCount: 40 }), {
    count: 42, source: 'production_embedding_store',
  });
  assert.deepEqual(resolveThresholdCorpusSize({ storeCount: null, storeFileMissing: true, publishedIndexCount: 40 }), {
    count: 40, source: 'reconstructed_complete_published_index',
  });
  assert.deepEqual(resolveThresholdCorpusSize({ storeCount: null, storeFileMissing: false, publishedIndexCount: 40 }), {
    count: null, source: 'unavailable',
  });
});

test('terminal M2 runs without a resolved marker remain visible as unobservable', () => {
  const bucket = { outcomes: {}, admissionSkipped: {}, unresolvedRunOutcomes: 0, terminalRunsWithoutOutcome: 0 };
  recordGenerationOutcome(bucket, null, 'completed');
  recordGenerationOutcome(bucket, { kind: 'skipped', reason: 'admit-in-flight', section: 'canton-ti' }, 'completed');
  assert.equal(bucket.terminalRunsWithoutOutcome, 1);
  assert.deepEqual(bucket.outcomes, { 'unobservable-terminal': 1, 'admit-in-flight': 1 });
  assert.deepEqual(bucket.admissionSkipped, { 'admit-in-flight': 1 });
});

test('M4 historical gaps and unassigned run evidence cannot become available zeros', () => {
  assert.equal(m4MetricsAvailability({
    missingCounters: 3, structuredMarkers: 0, historicalWindow: true, missingLogs: 0, unassignedRuns: 0, observedRuns: 0,
  }), 'unavailable_pre_instrumentation_historical_window');
  assert.equal(m4MetricsAvailability({
    missingCounters: 0, structuredMarkers: 2, historicalWindow: false, missingLogs: 0, unassignedRuns: 1, observedRuns: 4,
  }), 'partial_unassigned_generation_runs');
  assert.equal(hasCompleteM5Coverage({ missingLogs: 0, unassignedStartedRuns: 1 }), false);
});

test('M6 runner coverage is complete only when every admitted run log is assigned and readable', () => {
  const report = {
    unassigned: { m4EligibleRuns: 0 },
    metrics: {
      frontaliere: { llmExpectedAttempts: 2, m4RunsWithReadableLogs: 2, m4RunsWithoutLogs: 0 },
    },
  };
  const coverage = buildM6RuntimeLogCoverage(report);
  assert.deepEqual(coverage.frontaliere, {
    expectedGenerationAttempts: 2,
    readableRuns: 2,
    missingLogs: 0,
    unassignedEligibleRuns: 0,
    complete: true,
  });
  assert.deepEqual(buildM6RuntimeLogCoverage({ generationEvidence: report }).frontaliere, coverage.frontaliere);
  assert.equal(coverage.svizzera.complete, false);
  assert.equal(buildM6RuntimeLogCoverage({
    ...report,
    unassigned: { m4EligibleRuns: 1 },
  }).frontaliere.complete, false);
  assert.equal(buildM6RuntimeLogCoverage({
    ...report,
    metrics: { frontaliere: { llmExpectedAttempts: 1, m4RunsWithReadableLogs: 0, m4RunsWithoutLogs: 0 } },
  }).frontaliere.complete, false);
  assert.equal(buildM6RuntimeLogCoverage({
    ...report,
    metrics: { frontaliere: { llmExpectedAttempts: 1, m4RunsWithReadableLogs: -1, m4RunsWithoutLogs: 0 } },
  }).frontaliere.complete, false);
});

test('M6 input snapshot binds candidate text and counts to a checksum-validated manifest window', () => {
  const sectionArticleCounts = Object.fromEntries(Object.keys(ARTICLE_SECTION_CORE_ALL).map((section) => [section, 0]));
  const candidateCountsBySection = { ...sectionArticleCounts, frontaliere: 1 };
  const snapshot = createM6InputSnapshot({
    articles: [{
      id: 'candidate-1', section: 'frontaliere', kind: ARTICLE_SECTION_CORE_ALL.frontaliere.kind,
      publishedDate: '2026-11-25', title: 'Public title', excerpt: 'Public excerpt',
    }],
    dateUncertainArticles: [{
      id: 'candidate-2', section: 'frontaliere', kind: ARTICLE_SECTION_CORE_ALL.frontaliere.kind,
      publishedDate: null, dateStatus: 'unknown_in_published_index', title: 'Undated title', excerpt: 'Undated excerpt',
    }],
    indexRowCount: 2,
    candidateRecordCount: 2,
    countsBySection: candidateCountsBySection,
    coverageComplete: false,
    upperBoundCoverageComplete: true,
  }, '86a364f1d224d8002e2df83d9dcdb3e61609f364', sectionArticleCounts, {
    cutoffDate: '2026-08-28',
    untilDate: '2026-11-25',
    skippedCandidateRecords: 0,
    skippedByReason: {},
    recordsWithUnknownDate: 1,
  });
  assert.equal(verifyM6InputSnapshot(snapshot, '2026-11-25').records.length, 2);
  assert.equal(snapshot.upperBoundCoverageComplete, true);
  assert.throws(() => verifyM6InputSnapshot({ ...snapshot, records: snapshot.records.slice(0, 1) }, '2026-11-25'), /checksum mismatch/);
  assert.throws(() => verifyM6InputSnapshot(snapshot, '2026-11-24'), /checksum mismatch|metadata/);
});

test('M6 availability requires observed production gate evidence unless zero is date-independent', () => {
  assert.equal(m6MetricIsAvailable({
    candidateWindowComplete: true,
    dateIndependentZero: false,
    productionGateUnmeasuredSections: ['canton-ti'],
  }), false);
  assert.equal(m6MetricIsAvailable({
    candidateWindowComplete: true,
    dateIndependentZero: false,
    productionGateUnmeasuredSections: [],
  }), true);
  assert.equal(m6MetricIsAvailable({
    candidateWindowComplete: false,
    dateIndependentZero: true,
    productionGateUnmeasuredSections: [],
  }), true);
});

test('M3 touched-section mapping follows canonical article write surfaces', () => {
  assert.deepEqual(commitTouchedSections(['content/blog-body-canton-ti/it/example.ts']), ['canton-ti']);
  assert.deepEqual(commitTouchedSections(['README.md']), []);
});

test('page verifier helpers extract canonical URL and JSON-LD datePublished', () => {
  const html = '<link href="https://frontaliereticino.ch/a/b/" rel="canonical">'
    + '<script type="application/ld+json">{"@type":"NewsArticle","datePublished":"2026-11-25T11:00:00+01:00"}</script>';
  assert.equal(extractCanonical(html), 'https://frontaliereticino.ch/a/b/');
  assert.equal(extractDatePublished(html), '2026-11-25T11:00:00+01:00');
});

test('percentiles expose upper nearest-rank p50, p90 and max without inventing empty values', () => {
  assert.deepEqual(percentiles([5, 1, 4, 2, 3]), { count: 5, p50: 3, p90: 5, max: 5 });
  assert.deepEqual(percentiles([]), { count: 0, p50: null, p90: null, max: null });
});
