import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import '../../host/cantonSectionsBootstrap.mjs';
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
  collectM6Supplement,
  createM6InputSnapshot,
  currentGenerateQueueWaitMinutes,
  generationJob,
  generationJobIsQueued,
  generationJobWasAdmitted,
  hasCompleteM5Coverage,
  isNoopFastPublishRun,
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
  publishRunDurationMinutes,
  countPublishLiveAssignments,
  publishSectionsFromJobs,
  publishLiveSectionsFromRun,
  recordGenerationOutcome,
  resolveThresholdCorpusSize,
  sectionFromGeneration,
  summarizeDedupRuntimeEvidence,
  computePolicyThresholdFromParameters,
  summarizeM1IndexCoverage,
  verifyM6InputSnapshot,
} from '../../scripts/ci/measure-section-cadence.mjs';
import { ARTICLE_SECTION_CORE_ALL, ARTICLE_SECTION_CORE_LIST } from '../../engine/shared/articleSectionCore.mjs';
import {
  articlePublishPlanForRange,
  r2PublishPlan,
  r2PublishPlanForRange,
} from '../../scripts/ci/fast-publish-section.mjs';
import { setEmbedderForTests } from '../scripts/lib/evidence/embeddingClient.mjs';

function fastPublishPushPathPatterns() {
  const workflow = readFileSync(new URL('../../.github/workflows/fast-publish-section.yml', import.meta.url), 'utf8');
  const lines = workflow.split(/\r?\n/u);
  const pushStart = lines.findIndex((line) => line === '  push:');
  const dispatchStart = lines.findIndex((line, index) => index > pushStart && line === '  workflow_dispatch:');
  assert.ok(pushStart >= 0 && dispatchStart > pushStart, 'workflow Fast Publish espone on.push e workflow_dispatch');
  return lines.slice(pushStart, dispatchStart)
    .map((line) => line.match(/^\s+-\s+'([^']+)'/u)?.[1])
    .filter(Boolean);
}

function gitFixture(root, ...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function writeGitFixtureFile(root, relativePath, contents) {
  const fullPath = path.join(root, relativePath);
  mkdirSync(path.dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, contents);
}

function commitGitFixture(root, message) {
  gitFixture(root, 'add', '--all');
  gitFixture(root, 'commit', '--quiet', '-m', message);
  return gitFixture(root, 'rev-parse', 'HEAD');
}

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
    cantons: [{ id: 'news-three', datePublished: '2026-11-25T23:30:00Z', section: 'canton-ti' }],
    slugs: {
      blog: { 'news-one': { it: 'notizia-uno' } },
      swiss: { 'news-two': { it: 'notizia-due' } },
      cantons: { 'canton-ti': { 'news-three': { it: 'notizia-tre' } } },
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
    cantons: [
      { id: 'same-canton', date: '2026-11-25', section: 'canton-ti' },
      { id: 'same-slug-be', date: '2026-11-25', section: 'canton-be' },
    ],
    slugs: {
      blog: { 'same-national': { it: 'same-slug' }, 'duplicate-national': { it: 'same-slug' } },
      swiss: {},
      cantons: {
        'canton-ti': { 'same-canton': { it: 'same-slug' } },
        'canton-be': { 'same-slug-be': { it: 'same-slug' } },
      },
    },
    meta: { frontaliere: {}, svizzera: {}, canton: {} },
  };
  const result = buildArticleRecords(api);
  assert.deepEqual(result.articles.map(({ section, slug }) => `${section}:${slug}`), [
    'frontaliere:same-slug',
    'canton-ti:same-slug',
    'canton-be:same-slug',
  ]);
  assert.deepEqual(result.duplicateSlugsBySection, { frontaliere: 1 });
  assert.equal(result.missingRecordCount, 1);
});

test('M1 datePublished aliases map, while unassigned rows with unknown dates block section coverage', () => {
  const api = {
    national: [{ id: 'national-date-published', datePublished: '2026-11-25' }],
    swiss: [],
    cantons: [{ id: 'unknown-canton-date', section: 'canton-not-configured', date: '' }],
    slugs: {
      blog: { 'national-date-published': { it: 'nazionale-data-pubblicata' } },
      swiss: {},
      cantons: {},
    },
    meta: { frontaliere: {}, svizzera: {}, canton: {} },
  };
  const normalized = buildArticleRecords(api);
  assert.equal(normalized.articles.length, 1);
  assert.equal(normalized.articles[0].publishedDate, '2026-11-25');
  const coverage = summarizeM1IndexCoverage(api, normalized, '2026-11-25', '2026-11-25');
  assert.equal(coverage.rowsWithUnknownDate, 1);
  assert.equal(coverage.rowsWithUnknownSection, 1);
  assert.equal(coverage.rowsWithUnknownSectionAndDate, 1);
  assert.equal(coverage.unassignedUnknownDateSkippedCandidates, 1);
  assert.equal(coverage.coverageComplete, false);
  assert.equal(Object.values(coverage.sections).every((section) => !section.coverageComplete), true);
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
  assert.equal(generationJobWasAdmitted({ status: 'pending', conclusion: null, startedAt: null }), true);
  assert.equal(generationJobIsQueued({ status: 'pending' }), true);
  assert.equal(generationJobIsQueued({ status: 'in_progress' }), false);
  const now = Date.parse('2026-11-27T23:50:00Z');
  assert.equal(currentGenerateQueueWaitMinutes({ status: 'pending' }, now - 120_000, now), 2);
  assert.equal(currentGenerateQueueWaitMinutes({ status: 'completed' }, now - 120_000, now), null);
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

test('generation job selection ignores admission and section gate jobs', () => {
  const jobs = [
    { name: 'generate / admit', status: 'completed', conclusion: 'success', startedAt: '2026-11-27T22:35:13Z' },
    { name: 'generate / section_gate', status: 'completed', conclusion: 'success', startedAt: '2026-11-27T22:35:41Z' },
    { name: 'generate / generate production', status: 'completed', conclusion: 'skipped' },
  ];
  const selected = generationJob(jobs);
  assert.equal(selected, jobs[2]);
  assert.equal(generationJobWasAdmitted(selected), false);
  assert.equal(generationJob([{ name: 'generate / generate production', status: 'completed', startedAt: '2026-11-27T22:36:16Z' }])?.status, 'completed');
  assert.equal(generationJob([{ name: 'generate / generate dry run', status: 'completed', startedAt: '2026-11-27T22:36:16Z' }]), null);
  assert.equal(generationJob([{ name: 'generate / section_gate', status: 'completed', startedAt: '2026-11-27T22:35:41Z' }]), null);
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

test('M6 embeds all candidates and compares them with production cosine without claiming an unobserved gate', async () => {
  const endDate = '2026-11-26';
  const sections = Object.keys(ARTICLE_SECTION_CORE_ALL);
  const counts = Object.fromEntries(sections.map((section) => [section, 0]));
  counts.frontaliere = 2;
  const snapshot = createM6InputSnapshot({
    articles: [
      {
        id: 'synthetic-m6-a', section: 'frontaliere', kind: ARTICLE_SECTION_CORE_ALL.frontaliere.kind,
        publishedDate: '2026-11-25', title: 'Synthetic fixture A', excerpt: 'Synthetic excerpt for an isolated M6 test.',
      },
      {
        id: 'synthetic-m6-b', section: 'frontaliere', kind: ARTICLE_SECTION_CORE_ALL.frontaliere.kind,
        publishedDate: '2026-11-26', title: 'Synthetic fixture B', excerpt: 'Another synthetic excerpt for an isolated M6 test.',
      },
    ],
    dateUncertainArticles: [],
    indexRowCount: 2,
    candidateRecordCount: 2,
    countsBySection: counts,
    coverageComplete: true,
    upperBoundCoverageComplete: true,
  }, 'ffffffffffffffffffffffffffffffffffffffff', counts, {
    cutoffDate: '2026-08-29',
    untilDate: endDate,
    skippedCandidateRecords: 0,
    skippedByReason: {},
    recordsWithUnknownDate: 0,
  });

  setEmbedderForTests(async (inputs) => inputs.map(() => [1, ...Array(383).fill(0)]));
  try {
    const { metric } = await collectM6Supplement(endDate, { candidateSnapshot: snapshot });
    assert.equal(metric.embeddedArticles, 2);
    assert.equal(metric.comparedPairs, 1);
    assert.equal(metric.policyThresholdProxyPairCount, 1);
    assert.equal(metric.available, false);
    assert.equal(metric.nearDuplicatePairCount, null);
    assert.equal(metric.productionGateMeasured, false);
  } finally {
    setEmbedderForTests(null);
  }
});

test('M3 touched-section mapping follows canonical article write surfaces', () => {
  assert.deepEqual(commitTouchedSections(['content/blog-body-canton-ti/it/example.ts']), ['canton-ti']);
  assert.deepEqual(commitTouchedSections(['README.md']), []);
});

test('M3 classifica un push senza target come no-op e ne misura la durata', () => {
  assert.equal(isNoopFastPublishRun(
    { event: 'push', touchedSections: [] },
    { touchedSections: [] },
  ), true);
  assert.equal(isNoopFastPublishRun(
    { event: 'workflow_dispatch' },
    { touchedSections: [] },
  ), false, 'un dispatch manuale non è il no-op del push che ha aperto il workflow');
  assert.equal(publishRunDurationMinutes({
    startedAt: '2026-11-28T10:00:00.000Z',
    updatedAt: '2026-11-28T10:02:30.000Z',
  }), 2.5);
  assert.equal(publishRunDurationMinutes({
    createdAt: '2026-11-28T10:00:00.000Z',
    updatedAt: '2026-11-28T10:02:30.000Z',
  }), 2.5, 'createdAt è il fallback per una run non ancora materializzata con startedAt');
  assert.equal(publishRunDurationMinutes({
    startedAt: '2026-11-28T10:03:00.000Z',
    updatedAt: '2026-11-28T10:02:30.000Z',
  }), null);
});

test('M3 shared canton configs conservatively touch every active canton target', () => {
  const activeCantons = ARTICLE_SECTION_CORE_LIST
    .filter((entry) => entry.kind === 'canton' && entry.shardKey === null)
    .map((entry) => entry.section)
    .sort();
  for (const changedPath of [
    'generator/data/canton-sections.json',
    'generator/data/canton-url-slugs.json',
  ]) {
    assert.deepEqual(commitTouchedSections([changedPath], ARTICLE_SECTION_CORE_LIST.map((entry) => entry.section)), activeCantons,
      `${changedPath} può fan-outare a ciascuna sezione cantonale attiva`);
  }
});

test('M3 shared publisher code maps to the emitted active R2 matrix only once per section', () => {
  const activeSections = ARTICLE_SECTION_CORE_LIST.map((entry) => entry.section);
  const activeR2Sections = ARTICLE_SECTION_CORE_LIST
    .filter((entry) => entry.kind === 'canton' && !entry.shardKey)
    .map((entry) => entry.section)
    .sort();
  const paths = [
    'scripts/ci/fast-publish-section.mjs',
    'scripts/lib/article-render-pipeline.mjs',
    '.github/workflows/fast-publish-section.yml',
  ];

  for (const path of paths) {
    const emittedSections = r2PublishPlan([path], ARTICLE_SECTION_CORE_LIST).map(({ section }) => section);
    const touchedSections = commitTouchedSections([path], activeSections);
    const fastPublishRunsForCommit = 1;
    const replaysBySection = new Map();
    for (const section of emittedSections) replaysBySection.set(section, (replaysBySection.get(section) || 0) + 1);

    assert.deepEqual(touchedSections, activeR2Sections,
      `${path}: il conteggio segue i target R2 attivi, senza shard nazionali o sezioni non attive`);
    assert.ok(emittedSections.every((section) => touchedSections.includes(section)),
      `${path}: ogni target della matrix è nel set M3 misurato`);
    assert.ok([...replaysBySection.values()].every((count) => count <= 1),
      `${path}: il planner emette al massimo un replay per sezione`);
    assert.ok(fastPublishRunsForCommit <= touchedSections.length,
      `${path}: una run diretta di questo commit non supera il numero di sezioni misurate`);
    if (path !== '.github/workflows/fast-publish-section.yml') {
      assert.deepEqual(emittedSections, activeR2Sections,
        `${path}: il planner risveglia l’intera matrix cantonale attiva una sola volta`);
    }
  }

  const simulatedRetiredSection = activeR2Sections[0];
  const simulatedActiveSections = activeSections.filter((section) => section !== simulatedRetiredSection);
  assert.deepEqual(
    commitTouchedSections(['scripts/ci/fast-publish-section.mjs'], simulatedActiveSections),
    activeR2Sections.filter((section) => section !== simulatedRetiredSection),
    'il mapper usa l’inventario attivo fornito dal core e non riaggiunge una sezione disattivata',
  );
});

test('M3 covers every non-content Fast Publish push trigger emitted by the workflow', () => {
  const patterns = fastPublishPushPathPatterns();
  const nonContentPatterns = patterns.filter((pattern) => (
    !pattern.startsWith('content/')
      && !pattern.startsWith('sections/')
      && !pattern.startsWith('public/images/')
  ));
  const exactPaths = nonContentPatterns.filter((pattern) => !/[?*\[\]{}]/u.test(pattern));
  assert.equal(exactPaths.length, 67, 'il contract copre tutti i 67 push.paths non-content esatti');
  assert.equal(nonContentPatterns.length, 69, 'engine/** e host/** sono inclusi oltre ai 67 path esatti');

  const activeSections = ARTICLE_SECTION_CORE_LIST.map((entry) => entry.section);
  const activeR2Sections = ARTICLE_SECTION_CORE_LIST
    .filter((entry) => entry.kind === 'canton' && !entry.shardKey)
    .map((entry) => entry.section)
    .sort();
  const globSamples = {
    'engine/**': 'engine/shared/articleSectionCore.mjs',
    'host/**': 'host/cantonSectionsBootstrap.mjs',
  };

  for (const pattern of nonContentPatterns) {
    const path = pattern.includes('*') ? globSamples[pattern] : pattern;
    assert.ok(path, `${pattern}: il path trigger non-content ha una fixture concreta`);
    const emittedSections = r2PublishPlan([path], ARTICLE_SECTION_CORE_LIST).map(({ section }) => section);
    const touchedSections = commitTouchedSections([path], activeSections);
    const replaysBySection = new Map();
    for (const section of emittedSections) replaysBySection.set(section, (replaysBySection.get(section) || 0) + 1);

    assert.ok(emittedSections.length > 0, `${pattern}: il trigger emette target Fast Publish`);
    assert.deepEqual([...emittedSections].sort(), touchedSections,
      `${pattern}: M3 misura gli stessi target che emette il planner`);
    assert.deepEqual([...emittedSections].sort(), activeR2Sections,
      `${pattern}: un trigger di codice ripubblica solo la matrix cantonale R2 attiva`);
    assert.ok([...replaysBySection.values()].every((count) => count <= 1),
      `${pattern}: al massimo un replay per target`);
    assert.ok(1 <= touchedSections.length,
      `${pattern}: una run Fast Publish diretta non supera le sezioni misurate`);
  }
});

test('M3 confronta col planner R2 anche content, registry, exclusions e immagini', () => {
  const patterns = fastPublishPushPathPatterns();
  const samples = new Map([
    ['content/cantons/**', 'content/cantons/canton-ti/hubs/fisco.json'],
    ['content/article-index-exclusions.json', 'content/article-index-exclusions.json'],
    ['content/blog-body-canton-*/**', 'content/blog-body-canton-ti/it/example.ts'],
    ['content/blog-meta-canton-*', 'content/blog-meta-canton-ti-it.ts'],
    ['sections/registry.json', 'sections/registry.json'],
    ['public/images/**', 'public/images/cadence-unowned-review.png'],
  ]);
  const activeSections = ARTICLE_SECTION_CORE_LIST.map((entry) => entry.section);
  for (const [pattern, path] of samples) {
    assert.ok(patterns.includes(pattern), `${pattern}: il sample deve corrispondere a un push.path del workflow`);
    if (path === 'sections/registry.json'
      || path === 'content/article-index-exclusions.json'
      || path.startsWith('public/images/')) {
      assert.throws(
        () => commitTouchedSections([path], activeSections),
        /M3 richiede il range before\.\.after/,
        `${pattern}: M3 non deve inventare target senza il range del push`,
      );
      continue;
    }
    const runtimeTargets = r2PublishPlan([path], ARTICLE_SECTION_CORE_LIST).map(({ section }) => section).sort();
    const measuredTargets = commitTouchedSections([path], activeSections);
    assert.deepEqual(measuredTargets, runtimeTargets, `${pattern}: M3 deve misurare il piano R2 senza una mappa parallela`);
  }
});

test('M3 e runtime condividono il piano before/after per registry, exclusions e immagini', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'm3-r2-plan-range-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  gitFixture(root, 'init', '--quiet', '--object-format=sha1');
  gitFixture(root, 'config', 'user.name', 'Test');
  gitFixture(root, 'config', 'user.email', 'test@example.invalid');
  writeGitFixtureFile(root, 'sections/registry.json', JSON.stringify({
    schema: 1,
    sections: { 'canton-ti': { status: 'draft' } },
  }));
  writeGitFixtureFile(root, 'content/cantons/canton-ti/registry.ts',
    "export const CANTON_ARTICLES = [{ id: 'ti-article', image: '/images/blog/owned.webp' }];\n");
  writeGitFixtureFile(root, 'content/article-index-exclusions.json', '{"excluded":[]}\n');
  const base = commitGitFixture(root, 'fixture base');
  const measureUrl = new URL('../../scripts/ci/measure-section-cadence.mjs', import.meta.url).href;
  const plannerUrl = new URL('../../scripts/ci/fast-publish-section.mjs', import.meta.url).href;
  const coreUrl = new URL('../../engine/shared/articleSectionCore.mjs', import.meta.url).href;
  const comparePlans = (before, after, changedPath) => JSON.parse(execFileSync(process.execPath, [
    '--input-type=module', '-e', `
      import { ARTICLE_SECTION_CORE_LIST } from ${JSON.stringify(coreUrl)};
      import { commitTouchedSections } from ${JSON.stringify(measureUrl)};
      import { r2PublishPlanForRange } from ${JSON.stringify(plannerUrl)};
      const before = process.env.M3_BEFORE;
      const after = process.env.M3_AFTER;
      const changedPath = process.env.M3_PATH;
      const runtime = r2PublishPlanForRange(before, after, ARTICLE_SECTION_CORE_LIST).map(({ section }) => section).sort();
      const measured = commitTouchedSections([changedPath], ARTICLE_SECTION_CORE_LIST.map(({ section }) => section), { before, after });
      process.stdout.write(JSON.stringify({ runtime, measured }));
    `,
  ], {
    cwd: root,
    env: {
      ...process.env,
      M3_BEFORE: before,
      M3_AFTER: after,
      M3_PATH: changedPath,
    },
    encoding: 'utf8',
  }));

  const cases = [
    {
      message: 'owned image',
      path: 'public/images/blog/owned.webp',
      write: () => writeGitFixtureFile(root, 'public/images/blog/owned.webp', 'owned'),
      expected: ['canton-ti'],
    },
    {
      message: 'unowned image',
      path: 'public/images/cadence-unowned-review.png',
      write: () => writeGitFixtureFile(root, 'public/images/cadence-unowned-review.png', 'unowned'),
      expected: [],
    },
    {
      message: 'registry transition',
      path: 'sections/registry.json',
      write: () => writeGitFixtureFile(root, 'sections/registry.json', JSON.stringify({
        schema: 1,
        sections: { 'canton-ti': { status: 'live' } },
      })),
      expected: ['canton-ti'],
    },
    {
      message: 'index exclusion for a non-R2 section',
      path: 'content/article-index-exclusions.json',
      write: () => writeGitFixtureFile(root, 'content/article-index-exclusions.json',
        '{"excluded":[{"section":"frontaliere","id":"a"}]}\n'),
      expected: [],
    },
  ];
  let before = base;
  for (const currentCase of cases) {
    currentCase.write();
    const after = commitGitFixture(root, currentCase.message);
    const plans = comparePlans(before, after, currentCase.path);
    assert.deepEqual(plans.runtime, currentCase.expected, `${currentCase.message}: runtime`);
    assert.deepEqual(plans.measured, plans.runtime, `${currentCase.message}: M3 deve usare lo stesso before/after planner`);
    before = after;
  }
});

test('M3 counts matrix jobs by section and keeps a coordinator-only barrier globally visible', () => {
  const section = 'canton-ti';
  const duringCoordinator = [
    {
      id: 'C0',
      status: 'in_progress',
      jobs: [{ name: 'finalize (canton-ti)', status: 'in_progress' }],
    },
    {
      id: 'C1',
      status: 'in_progress',
      jobs: [
        { name: 'stage (canton-ti)', status: 'completed' },
        { name: 'coordinate_api_release', status: 'in_progress' },
      ],
    },
    {
      id: 'C2',
      status: 'in_progress',
      jobs: [{ name: 'stage (canton-ti)', status: 'pending' }],
    },
  ];
  const liveStatuses = new Set(['queued', 'in_progress', 'waiting', 'pending', 'requested']);
  const liveRuns = duringCoordinator.filter((run) => liveStatuses.has(run.status));
  const resolvedRuns = liveRuns.map((run) => ({
    ...run,
    sections: publishLiveSectionsFromRun({ displayTitle: 'cover-publish-section / auto / nonce=none' }, { jobs: run.jobs }),
  }));
  const assignments = countPublishLiveAssignments(resolvedRuns, [section]);
  assert.equal(liveRuns.length, 3, 'tutti i workflow vivi restano nel conteggio aggregato');
  assert.deepEqual(assignments, { bySection: { [section]: 2 }, unscoped: 1 },
    'C0 finalize + C2 stage sono i due target TI; C1 ha solo il coordinator durante la barriera');
  assert.deepEqual(publishSectionsFromJobs(duringCoordinator[1].jobs, { liveOnly: true }), [],
    'il coordinator resta globale e non dichiara una finalize matrix prima del suo output');
  assert.deepEqual(publishSectionsFromJobs(duringCoordinator[2].jobs, { liveOnly: true }), [section],
    'lo stage pending C2 è attribuito al target mentre attende il concurrency group');

  // Once the coordinator output becomes available, Actions materializes C1's
  // finalize matrix. queue:single atomically replaces the older pending C2
  // stage, leaving C0 running plus exactly one TI waiter.
  const afterCoordinator = [
    { id: 'C0', status: 'in_progress', jobs: [{ name: 'finalize (canton-ti)', status: 'in_progress' }] },
    { id: 'C1', status: 'in_progress', jobs: [{ name: 'finalize (canton-ti)', status: 'pending' }] },
    { id: 'C2', status: 'completed', conclusion: 'cancelled', jobs: [{ name: 'stage (canton-ti)', status: 'completed' }] },
  ];
  const afterAssignments = countPublishLiveAssignments(afterCoordinator
    .filter((run) => liveStatuses.has(run.status))
    .map((run) => ({ ...run, sections: publishLiveSectionsFromRun({}, { jobs: run.jobs }) })), [section]);
  assert.deepEqual(afterAssignments, { bySection: { [section]: 2 }, unscoped: 0 },
    'dopo l’espansione finalize sostituisce C2 nello stesso queue:single group');

  const resolvingWorkflow = [
    { name: 'resolve', status: 'in_progress' },
    { name: 'stage (canton-ti)', status: 'pending' },
  ];
  assert.deepEqual(publishSectionsFromJobs(resolvingWorkflow, { liveOnly: true }), [section],
    'una matrix pending è attribuita anche se resolve non è terminale');
  assert.deepEqual(publishSectionsFromJobs([
    { name: 'coordinate_api_release', status: 'in_progress' },
  ], { liveOnly: true }), [],
  'un coordinator privo di matrix target resta unscoped ma continua a essere contato nel totale workflow');
  assert.deepEqual(publishLiveSectionsFromRun(
    { displayTitle: 'cover-publish-section / canton-ti / nonce=manual' },
    { jobsReadable: false },
  ), [section], 'se il Jobs API non è leggibile un run manuale targettato resta attribuito conservativamente');
  assert.deepEqual(publishLiveSectionsFromRun(
    { displayTitle: 'cover-publish-section / auto / nonce=none' },
    { jobsReadable: false },
  ), [], 'una push auto senza Jobs API resta nel contatore unscoped, non sparisce');
  assert.deepEqual(publishSectionsFromJobs([
    { name: 'stage (canton-ti)' },
    { name: 'finalize (canton-ti)' },
    { name: 'finalize (canton-gr)' },
    { name: 'coordinate_api_release' },
  ]), ['canton-gr', 'canton-ti'], 'matrici multi-target vengono assegnate a ogni sezione una sola volta');

  const actualActionsNames = [
    { name: 'publish (canton-ow, false, false, false)', status: 'in_progress' },
    { name: 'stage (canton-ti)', status: 'pending' },
    { name: 'finalize (canton-gr)', status: 'queued' },
  ];
  assert.deepEqual(publishSectionsFromJobs(actualActionsNames), ['canton-gr', 'canton-ow', 'canton-ti'],
    'i nomi effettivi Actions con matrix object mantengono la sezione nel primo campo');
  assert.deepEqual(publishSectionsFromJobs(actualActionsNames, { liveOnly: true }), ['canton-gr', 'canton-ow', 'canton-ti'],
    'running, pending e queued sono attribuiti alla sezione anche col nome matrix legacy');
});

test('M3 attribuisce il titolo dispatch esplicito quando Jobs API mostra solo resolve', () => {
  const explicitTarget = { displayTitle: 'cover-publish-section / canton-ti / nonce=manual' };
  const resolveOnly = [{ name: 'resolve', status: 'in_progress' }];
  assert.deepEqual(publishLiveSectionsFromRun(explicitTarget, { jobs: resolveOnly, jobsReadable: true }), ['canton-ti'],
    'il target resta misurabile prima che Actions materializzi la matrix');
  assert.deepEqual(publishLiveSectionsFromRun(
    { displayTitle: 'cover-publish-section / auto / nonce=none' },
    { jobs: resolveOnly, jobsReadable: true },
  ), [], 'una push automatica senza target matrix resta unscoped durante resolve');
  assert.deepEqual(publishLiveSectionsFromRun(explicitTarget, {
    jobs: [{ name: 'stage (canton-gr)', status: 'pending' }],
    jobsReadable: true,
  }), ['canton-gr'], 'la matrix canonica prevale sul titolo del run quando identifica target live');
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
