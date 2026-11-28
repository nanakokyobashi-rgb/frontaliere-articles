import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { apiTriggerInputsDifferBetween } from '../../scripts/lib/publish-api-input-range.mjs';
import {
  hasCompleteCantonHubRefreshCoverage,
  isArticlePublicationPath,
  parseCantonHubRefreshMarker,
  parsePublishApiRange,
  resolvePublisherArtifactState,
  resolveCantonTargetSections,
  resolveRefreshMode,
  shouldWaitForArticlePublication,
} from '../scripts/lib/canton-hubs/publish-gate.mjs';
import {
  createCantonHubRefreshReceipt,
  verifyCantonHubRefreshReceipt,
} from '../scripts/lib/canton-hubs/refresh-receipt.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('publish API run-name range parser is strict and preserves multi-commit bounds', () => {
  assert.deepEqual(parsePublishApiRange(
    'Publish article data API (automatic) / range=0123456789abcdef0123456789abcdef01234567..89abcdef0123456789abcdef0123456789abcdef',
  ), {
    before: '0123456789abcdef0123456789abcdef01234567',
    after: '89abcdef0123456789abcdef0123456789abcdef',
  });
  assert.equal(parsePublishApiRange('Publish article data API (automatic)'), null);
  assert.equal(parsePublishApiRange('range=short..89abcdef0123456789abcdef0123456789abcdef'), null);
});

test('hub refresh marker parser accepts only a complete final trailer block', () => {
  const sourceCommit = '0123456789abcdef0123456789abcdef01234567';
  const runId = '8123456789';
  const runAttempt = '2';
  assert.deepEqual(parseCantonHubRefreshMarker(
    `Refresh canton hubs\n\nCanton-Hub-Source-Commit: ${sourceCommit}\nCanton-Hub-Source-Verified: true\nCanton-Hub-Receipt-Run-Id: ${runId}\nCanton-Hub-Receipt-Run-Attempt: ${runAttempt}\nCanton-Hub-Sections: canton-gr,canton-ti`,
  ), {
    sourceCommit,
    sourceVerified: true,
    receiptRunId: runId,
    receiptRunAttempt: runAttempt,
    sections: ['canton-gr', 'canton-ti'],
  });
  assert.deepEqual(parseCantonHubRefreshMarker(
    `Refresh canton hubs\n\nCanton-Hub-Source-Commit: ${sourceCommit}\nCanton-Hub-Source-Verified: false\nCanton-Hub-Receipt-Run-Id: ${runId}\nCanton-Hub-Receipt-Run-Attempt: ${runAttempt}\nCanton-Hub-Sections: canton-ti`,
  ), { sourceCommit, sourceVerified: false, receiptRunId: runId, receiptRunAttempt: runAttempt, sections: ['canton-ti'] });
  for (const invalid of [
    `Canton-Hub-Source-Commit: ${sourceCommit}\nCanton-Hub-Sections: canton-ti`,
    `subject\n\nCanton-Hub-Source-Commit: short\nCanton-Hub-Source-Verified: true\nCanton-Hub-Receipt-Run-Id: ${runId}\nCanton-Hub-Receipt-Run-Attempt: ${runAttempt}\nCanton-Hub-Sections: canton-ti`,
    `subject\n\nCanton-Hub-Source-Commit: ${sourceCommit}\nCanton-Hub-Source-Verified: true\nCanton-Hub-Receipt-Run-Id: ${runId}\nCanton-Hub-Receipt-Run-Attempt: ${runAttempt}\nCanton-Hub-Sections: canton-ti,canton-ti`,
    `subject\n\nCanton-Hub-Source-Commit: ${sourceCommit}\nCanton-Hub-Source-Verified: maybe\nCanton-Hub-Receipt-Run-Id: ${runId}\nCanton-Hub-Receipt-Run-Attempt: ${runAttempt}\nCanton-Hub-Sections: canton-ti`,
    `subject\n\nCanton-Hub-Source-Commit: ${sourceCommit}\nCanton-Hub-Source-Verified: true\nCanton-Hub-Receipt-Run-Id: ${runId}\nCanton-Hub-Receipt-Run-Attempt: ${runAttempt}\nCanton-Hub-Sections: canton-ti\nExtra: value`,
  ]) assert.equal(parseCantonHubRefreshMarker(invalid), null);
});

test('article publication paths wait for the API, while hub outputs do not self-trigger', () => {
  assert.equal(isArticlePublicationPath('content/blog-body-canton-ti/it/example.ts'), true);
  assert.equal(isArticlePublicationPath('content/cantons/canton-ti/registry.ts'), true);
  assert.equal(isArticlePublicationPath('data/blog-articles/example.json'), true);
  assert.equal(isArticlePublicationPath('content/cantons/canton-ti/hubs/eventi.json'), false);
  assert.equal(isArticlePublicationPath('data/article-source-urls.json'), false);
  assert.equal(shouldWaitForArticlePublication([
    'generator/scripts/generate-canton-hubs.mjs',
    'content/cantons/canton-ti/hubs/eventi.json',
  ]), false);
  assert.equal(shouldWaitForArticlePublication([
    'content/cantons/canton-ti/hubs/eventi.json',
    'content/blog-body-canton-ti/it/example.ts',
  ]), true);
});

test('missing Pages artifact skips only a stale publisher range with a newer trigger owner', () => {
  const eventHead = '89abcdef0123456789abcdef0123456789abcdef';
  const currentMain = 'fedcba9876543210fedcba9876543210fedcba98';
  assert.deepEqual(resolvePublisherArtifactState({
    artifactAvailable: false,
    workflowHeadSha: eventHead,
    mainHeadSha: currentMain,
    newerPublisherInputs: true,
  }), {
    status: 'skipped',
    sourceCommit: '',
    reason: 'newer-publisher-run-queued',
  });
  assert.deepEqual(resolveRefreshMode({
    eventName: 'workflow_run',
    upstreamEvent: 'push',
    upstreamBranch: 'main',
    upstreamConclusion: 'success',
    upstreamTitle: `Publish article data API / range=0123456789abcdef0123456789abcdef01234567..${eventHead}`,
    upstreamHeadSha: eventHead,
    publisherStatus: 'skipped',
    changedPaths: ['content/blog-body-canton-ti/it/draft-article.ts'],
  }).run, false, 'il draft range stale non fa push: la run FIFO successiva e owner');
  assert.throws(() => resolvePublisherArtifactState({
    artifactAvailable: false,
    workflowHeadSha: eventHead,
    mainHeadSha: eventHead,
    newerPublisherInputs: false,
  }), /senza una run piu/);
  assert.throws(() => resolvePublisherArtifactState({
    artifactAvailable: false,
    workflowHeadSha: eventHead,
    mainHeadSha: currentMain,
    newerPublisherInputs: false,
  }), /senza una run piu/);
});

test('refresh mode sends every artifact-backed publisher run to the coverage resolver', () => {
  const contentPath = ['content/blog-body-canton-ti/it/nuovo-articolo.ts'];
  assert.deepEqual(resolveRefreshMode({ eventName: 'push', pushBefore: 'before', changedPaths: contentPath }), {
    run: false,
    dry: true,
    before: 'before',
    after: '',
    reason: 'await-publisher',
  });
  assert.equal(resolveRefreshMode({
    eventName: 'workflow_run',
    upstreamEvent: 'push',
    upstreamBranch: 'main',
    upstreamConclusion: 'failure',
    changedPaths: contentPath,
  }).run, false);
  assert.deepEqual(resolveRefreshMode({
    eventName: 'workflow_run',
    upstreamEvent: 'push',
    upstreamBranch: 'main',
    upstreamConclusion: 'success',
    upstreamTitle: 'Publish article data API (automatic) / range=0123456789abcdef0123456789abcdef01234567..89abcdef0123456789abcdef0123456789abcdef',
    upstreamHeadSha: '89abcdef0123456789abcdef0123456789abcdef',
    changedPaths: ['content/cantons/canton-ti/hubs/eventi.json'],
  }), {
    run: true,
    dry: false,
    before: '0123456789abcdef0123456789abcdef01234567',
    after: '89abcdef0123456789abcdef0123456789abcdef',
    reason: 'published-api-artifact',
  }, 'la prova di copertura e il loop si decidono dopo aver letto il receipt e le sezioni attive');
  assert.deepEqual(resolveRefreshMode({
    eventName: 'workflow_run',
    upstreamEvent: 'push',
    upstreamBranch: 'main',
    upstreamConclusion: 'success',
    upstreamTitle: 'Publish article data API (automatic) / range=0123456789abcdef0123456789abcdef01234567..89abcdef0123456789abcdef0123456789abcdef',
    upstreamHeadSha: '89abcdef0123456789abcdef0123456789abcdef',
    publisherStatus: 'published',
    publisherSourceCommit: '89abcdef0123456789abcdef0123456789abcdef',
    changedPaths: contentPath,
  }), {
    run: true,
    dry: false,
    before: '0123456789abcdef0123456789abcdef01234567',
    after: '89abcdef0123456789abcdef0123456789abcdef',
    reason: 'published-api-artifact',
  });
  assert.throws(() => resolveRefreshMode({
    eventName: 'workflow_run',
    upstreamEvent: 'push',
    upstreamBranch: 'main',
    upstreamConclusion: 'success',
    upstreamTitle: 'Publish article data API / range=0123456789abcdef0123456789abcdef01234567..89abcdef0123456789abcdef0123456789abcdef',
    upstreamHeadSha: 'ffffffffffffffffffffffffffffffffffffffff',
    changedPaths: contentPath,
  }), /range after diverso da head SHA/);
});

test('hub-only publisher skip requires verified source, exact active scope, and hub-only source delta', () => {
  const sourceCommit = '0123456789abcdef0123456789abcdef01234567';
  const publisherSourceCommit = '89abcdef0123456789abcdef0123456789abcdef';
  const hubPaths = ['content/cantons/canton-ti/hubs/eventi.json'];
  const message = `Refresh canton hubs\n\nCanton-Hub-Source-Commit: ${sourceCommit}\nCanton-Hub-Source-Verified: true\nCanton-Hub-Receipt-Run-Id: 8123456789\nCanton-Hub-Receipt-Run-Attempt: 2\nCanton-Hub-Sections: canton-gr,canton-ti`;
  const proof = {
    enabledSections: ['canton-ti', 'canton-gr'],
    publisherChangedPaths: hubPaths,
    publisherSourceCommit,
    commitMessage: message,
    receiptSourceCommit: sourceCommit,
    receiptAuthenticated: true,
    sourceCommitIsAncestor: true,
    sourceChangedPaths: ['content/cantons/canton-gr/hubs/eventi.json'],
  };
  assert.equal(hasCompleteCantonHubRefreshCoverage(proof), true);
  assert.equal(hasCompleteCantonHubRefreshCoverage({ ...proof, enabledSections: ['canton-ti', 'canton-gr', 'canton-be'] }), false);
  assert.equal(hasCompleteCantonHubRefreshCoverage({ ...proof, commitMessage: message.replace('Verified: true', 'Verified: false') }), false);
  assert.equal(hasCompleteCantonHubRefreshCoverage({ ...proof, sourceCommitIsAncestor: false }), false);
  assert.equal(hasCompleteCantonHubRefreshCoverage({ ...proof, sourceChangedPaths: ['scripts/lib/build-sitemap.mjs'] }), false);
});

test('H1 TI without artifact is covered by the first H2 code-only publisher artifact', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'canton-hub-stale-code-publisher-'));
  try {
    const git = (args) => execFileSync('git', args, {
      cwd: fixture,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    git(['init', '--quiet', '-b', 'main']);
    git(['config', 'user.name', 'Workflow Fixture']);
    git(['config', 'user.email', 'workflow-fixture@example.invalid']);
    fs.writeFileSync(path.join(fixture, 'README.md'), 'base\n');
    git(['add', 'README.md']);
    git(['commit', '--quiet', '-m', 'base']);
    const base = git(['rev-parse', 'HEAD']);

    const tiPath = 'content/blog-body-canton-ti/it/ti-article.ts';
    fs.mkdirSync(path.dirname(path.join(fixture, tiPath)), { recursive: true });
    fs.writeFileSync(path.join(fixture, tiPath), 'export const article = "TI";\n');
    git(['add', tiPath]);
    git(['commit', '--quiet', '-m', 'H1 article TI']);
    const h1 = git(['rev-parse', 'HEAD']);
    const h1Paths = git(['diff', '--name-only', base, h1]).split('\n').filter(Boolean);

    const codePath = 'scripts/lib/build-sitemap.mjs';
    fs.mkdirSync(path.dirname(path.join(fixture, codePath)), { recursive: true });
    fs.writeFileSync(path.join(fixture, codePath), 'export const changed = true;\n');
    git(['add', codePath]);
    git(['commit', '--quiet', '-m', 'H2 publisher code change']);
    const h2 = git(['rev-parse', 'HEAD']);
    const h2Paths = git(['diff', '--name-only', h1, h2]).split('\n').filter(Boolean);
    const fixtureGit = (file, args, options) => {
      assert.equal(file, 'git');
      assert.deepEqual(args.slice(0, 2), ['-C', ROOT]);
      return execFileSync(file, args.slice(2), { ...options, cwd: fixture });
    };
    const newerPublisherInputs = apiTriggerInputsDifferBetween(
      { before: h1, after: h2 },
      { execFileSyncImpl: fixtureGit },
    );
    assert.equal(newerPublisherInputs, true, 'la modifica al generatore e\u0300 un input API publisher');

    const stale = resolvePublisherArtifactState({
      artifactAvailable: false,
      workflowHeadSha: h1,
      mainHeadSha: h2,
      newerPublisherInputs,
    });
    assert.equal(stale.status, 'skipped');
    assert.equal(resolveRefreshMode({
      eventName: 'workflow_run',
      upstreamEvent: 'push',
      upstreamBranch: 'main',
      upstreamConclusion: 'success',
      upstreamTitle: `Publish article data API / range=${base}..${h1}`,
      upstreamHeadSha: h1,
      publisherStatus: stale.status,
      changedPaths: h1Paths,
    }).run, false);

    assert.deepEqual(h1Paths, [tiPath]);
    assert.deepEqual(h2Paths, [codePath]);
    assert.equal(shouldWaitForArticlePublication(h2Paths), false, 'H2 e\u0300 publisher code-only');
    const h2Mode = resolveRefreshMode({
      eventName: 'workflow_run',
      upstreamEvent: 'push',
      upstreamBranch: 'main',
      upstreamConclusion: 'success',
      upstreamTitle: `Publish article data API / range=${h1}..${h2}`,
      upstreamHeadSha: h2,
      publisherStatus: 'published',
      publisherSourceCommit: h2,
      changedPaths: h2Paths,
    });
    assert.equal(h2Mode.run, true);
    assert.equal(h2Mode.reason, 'published-api-artifact');
    assert.deepEqual(
      resolveCantonTargetSections(['canton-ti', 'canton-gr', 'canton-be'], h2Paths, { includeAll: true }),
      ['canton-ti', 'canton-gr', 'canton-be'],
    );
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test('direct push targeting retains a canton-only diff scope', () => {
  const enabled = ['canton-ti', 'canton-gr', 'canton-be'];
  const changedPaths = ['data/sections/canton-ti/articles/nuovo-articolo.json'];
  const mode = resolveRefreshMode({
    eventName: 'push',
    changedPaths,
  });
  assert.equal(mode.run, true);
  assert.deepEqual(resolveCantonTargetSections(enabled, changedPaths), ['canton-ti']);

  const cliOutput = execFileSync(process.execPath, [
    path.join(ROOT, 'generator/scripts/resolve-canton-hub-target-sections.mjs'),
  ], {
    input: `${changedPaths.join('\n')}\n`,
    env: { ...process.env, EVENT_NAME: 'push', ENABLED_SECTIONS: enabled.join('\n') },
    encoding: 'utf8',
  });
  assert.equal(cliOutput.trim(), 'canton-ti', 'un push diretto cantonale resta bounded nella CLI del workflow');
  assert.deepEqual(resolveCantonTargetSections(enabled, [
    'content/blog-body-canton-ti/it/nuovo-articolo.ts',
    'content/blog-body-canton-gr/it/altro.ts',
  ]), ['canton-ti', 'canton-gr']);
  assert.deepEqual(resolveCantonTargetSections(enabled, ['content/blog-body/it/frontaliere.ts']), enabled);
});

test('H1 TI without artifact cannot lose its target when H2 GR publishes', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'canton-hub-stale-publisher-scope-'));
  try {
    const git = (args) => execFileSync('git', args, {
      cwd: fixture,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    git(['init', '--quiet', '-b', 'main']);
    git(['config', 'user.name', 'Workflow Fixture']);
    git(['config', 'user.email', 'workflow-fixture@example.invalid']);
    fs.writeFileSync(path.join(fixture, 'README.md'), 'base\n');
    git(['add', 'README.md']);
    git(['commit', '--quiet', '-m', 'base']);
    const base = git(['rev-parse', 'HEAD']);

    const tiPath = 'content/blog-body-canton-ti/it/ti-article.ts';
    fs.mkdirSync(path.dirname(path.join(fixture, tiPath)), { recursive: true });
    fs.writeFileSync(path.join(fixture, tiPath), 'export const article = "TI";\n');
    git(['add', tiPath]);
    git(['commit', '--quiet', '-m', 'H1 article TI']);
    const h1 = git(['rev-parse', 'HEAD']);
    const h1Paths = git(['diff', '--name-only', base, h1]).split('\n').filter(Boolean);

    const grPath = 'content/blog-body-canton-gr/it/gr-article.ts';
    fs.mkdirSync(path.dirname(path.join(fixture, grPath)), { recursive: true });
    fs.writeFileSync(path.join(fixture, grPath), 'export const article = "GR";\n');
    git(['add', grPath]);
    git(['commit', '--quiet', '-m', 'H2 article GR']);
    const h2 = git(['rev-parse', 'HEAD']);
    const h2Paths = git(['diff', '--name-only', h1, h2]).split('\n').filter(Boolean);
    const fixtureGit = (file, args, options) => {
      assert.equal(file, 'git');
      assert.deepEqual(args.slice(0, 2), ['-C', ROOT]);
      return execFileSync(file, args.slice(2), { ...options, cwd: fixture });
    };
    const newerPublisherInputs = apiTriggerInputsDifferBetween(
      { before: h1, after: h2 },
      { execFileSyncImpl: fixtureGit },
    );
    assert.equal(newerPublisherInputs, true, 'il range successivo contiene un nuovo input API GR');

    const stale = resolvePublisherArtifactState({
      artifactAvailable: false,
      workflowHeadSha: h1,
      mainHeadSha: h2,
      newerPublisherInputs,
    });
    assert.equal(stale.status, 'skipped');
    assert.equal(resolveRefreshMode({
      eventName: 'workflow_run',
      upstreamEvent: 'push',
      upstreamBranch: 'main',
      upstreamConclusion: 'success',
      upstreamTitle: `Publish article data API / range=${base}..${h1}`,
      upstreamHeadSha: h1,
      publisherStatus: stale.status,
      changedPaths: h1Paths,
    }).run, false, 'H1 senza artifact lascia ownership alla pubblicazione successiva');

    assert.deepEqual(h1Paths, [tiPath]);
    assert.deepEqual(h2Paths, [grPath], 'il range H2 parte da H1 e quindi non contiene TI');
    const h2Mode = resolveRefreshMode({
      eventName: 'workflow_run',
      upstreamEvent: 'push',
      upstreamBranch: 'main',
      upstreamConclusion: 'success',
      upstreamTitle: `Publish article data API / range=${h1}..${h2}`,
      upstreamHeadSha: h2,
      publisherStatus: 'published',
      publisherSourceCommit: h2,
      changedPaths: h2Paths,
    });
    assert.equal(h2Mode.run, true);
    assert.deepEqual(resolveCantonTargetSections(['canton-ti', 'canton-gr', 'canton-be'], h2Paths), ['canton-gr']);
    assert.deepEqual(
      resolveCantonTargetSections(['canton-ti', 'canton-gr', 'canton-be'], h2Paths, { includeAll: true }),
      ['canton-ti', 'canton-gr', 'canton-be'],
      'H2 allarga al set attivo per coprire scope che un run senza artifact non ha persistito',
    );

    const cliOutput = execFileSync(process.execPath, [
      path.join(ROOT, 'generator/scripts/resolve-canton-hub-target-sections.mjs'),
    ], {
      cwd: fixture,
      input: `${h2Paths.join('\n')}\n`,
      env: {
        ...process.env,
        EVENT_NAME: 'workflow_run',
        ENABLED_SECTIONS: 'canton-ti\ncanton-gr\ncanton-be',
      },
      encoding: 'utf8',
    });
    assert.equal(cliOutput.trim(), 'canton-ti,canton-gr,canton-be');
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test('H1 TI missing artifact, H2 GR hub-only receipt recovers TI, then H3 full receipt stops the loop', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'canton-hub-receipt-recovery-'));
  const enabled = ['canton-ti', 'canton-gr', 'canton-be'];
  const targetResolver = path.join(ROOT, 'generator/scripts/resolve-canton-hub-target-sections.mjs');
  try {
    const git = (args) => execFileSync('git', args, {
      cwd: fixture,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    git(['init', '--quiet', '-b', 'main']);
    git(['config', 'user.name', 'Workflow Fixture']);
    git(['config', 'user.email', 'workflow-fixture@example.invalid']);
    fs.writeFileSync(path.join(fixture, 'README.md'), 'base\n');
    git(['add', 'README.md']);
    git(['commit', '--quiet', '-m', 'base']);
    const base = git(['rev-parse', 'HEAD']);

    const tiArticle = 'content/blog-body-canton-ti/it/ti-article.ts';
    fs.mkdirSync(path.dirname(path.join(fixture, tiArticle)), { recursive: true });
    fs.writeFileSync(path.join(fixture, tiArticle), 'export const article = "TI";\n');
    git(['add', tiArticle]);
    git(['commit', '--quiet', '-m', 'H1 article TI']);
    const h1 = git(['rev-parse', 'HEAD']);
    const h1Paths = git(['diff', '--name-only', base, h1]).split('\n').filter(Boolean);

    const h2Hub = 'content/cantons/canton-gr/hubs/eventi.json';
    fs.mkdirSync(path.dirname(path.join(fixture, h2Hub)), { recursive: true });
    fs.writeFileSync(path.join(fixture, h2Hub), '{"schemaVersion":1,"section":"canton-gr"}\n');
    git(['add', h2Hub]);
    git(['commit', '--quiet', '-m', 'Refresh canton hubs', '-m', `Canton-Hub-Source-Commit: ${h1}\nCanton-Hub-Source-Verified: true\nCanton-Hub-Receipt-Run-Id: 71001\nCanton-Hub-Receipt-Run-Attempt: 1\nCanton-Hub-Sections: canton-gr`]);
    const h2 = git(['rev-parse', 'HEAD']);
    const h2Paths = git(['diff', '--name-only', h1, h2]).split('\n').filter(Boolean);
    const fixtureGit = (file, args, options) => {
      assert.equal(file, 'git');
      assert.deepEqual(args.slice(0, 2), ['-C', ROOT]);
      return execFileSync(file, args.slice(2), { ...options, cwd: fixture });
    };
    const h2IsNewPublisherInput = apiTriggerInputsDifferBetween(
      { before: h1, after: h2 },
      { execFileSyncImpl: fixtureGit },
    );
    assert.equal(h2IsNewPublisherInput, true, 'l’output hub H2 avvia il publisher');

    const stale = resolvePublisherArtifactState({
      artifactAvailable: false,
      workflowHeadSha: h1,
      mainHeadSha: h2,
      newerPublisherInputs: h2IsNewPublisherInput,
    });
    assert.equal(stale.status, 'skipped');
    assert.equal(resolveRefreshMode({
      eventName: 'workflow_run',
      upstreamEvent: 'push',
      upstreamBranch: 'main',
      upstreamConclusion: 'success',
      upstreamTitle: `Publish article data API / range=${base}..${h1}`,
      upstreamHeadSha: h1,
      publisherStatus: stale.status,
      changedPaths: h1Paths,
    }).run, false, 'H1 resta ownerless finche\u0301 non arriva una pubblicazione verificata');

    assert.deepEqual(h2Paths, [h2Hub], 'il range H2 contiene solo l’output GR');
    const h2Mode = resolveRefreshMode({
      eventName: 'workflow_run',
      upstreamEvent: 'push',
      upstreamBranch: 'main',
      upstreamConclusion: 'success',
      upstreamTitle: `Publish article data API / range=${h1}..${h2}`,
      upstreamHeadSha: h2,
      publisherStatus: 'published',
      publisherSourceCommit: h2,
      changedPaths: h2Paths,
    });
    assert.equal(h2Mode.run, true, 'anche il publisher hub-only passa al resolver del receipt');

    const resolveTargets = (sourceCommit, paths, receiptVerified = false) => execFileSync(process.execPath, [targetResolver], {
      cwd: fixture,
      input: `${paths.join('\n')}\n`,
      env: {
        ...process.env,
        EVENT_NAME: 'workflow_run',
        ENABLED_SECTIONS: enabled.join('\n'),
        PUBLISHER_SOURCE_COMMIT: sourceCommit,
        HUB_RECEIPT_VERIFIED: String(receiptVerified),
      },
      encoding: 'utf8',
    }).trim();

    const h2Message = git(['show', '-s', '--format=%B', h2]);
    const h2Verification = verifyCantonHubRefreshReceipt({
      receipt: null,
      runMetadata: null,
      repository: 'owner/repository',
      runId: '71001',
      runAttempt: '1',
      publisherSourceCommit: h2,
      commitMessage: h2Message,
      publisherChangedPaths: h2Paths,
    });
    assert.equal(h2Verification.verified, false, 'il trailer forgiato senza artifact e metadata non autentica il run');
    const proofResolver = path.join(ROOT, 'generator/scripts/resolve-canton-hub-refresh-proof.mjs');
    const h2ProofOutput = path.join(fixture, 'h2-proof-output.txt');
    execFileSync(process.execPath, [proofResolver, 'verify'], {
      cwd: fixture,
      input: `${h2Paths.join('\n')}\n`,
      env: {
        ...process.env,
        GITHUB_REPOSITORY: 'owner/repository',
        RECEIPT_PATH: path.join(fixture, 'missing-artifact', 'receipt.json'),
        RUN_METADATA_PATH: path.join(fixture, 'missing-artifact', 'github-run.json'),
        RECEIPT_RUN_ID: '71001',
        RECEIPT_RUN_ATTEMPT: '1',
        PUBLISHER_SOURCE_COMMIT: h2,
        GITHUB_OUTPUT: h2ProofOutput,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const h2ProofOutputText = fs.readFileSync(h2ProofOutput, 'utf8');
    assert.match(h2ProofOutputText, /verified=false/);
    const h2Targets = resolveTargets(h2, h2Paths, h2ProofOutputText.includes('verified=true'));
    assert.equal(h2Targets, enabled.join(','), 'marker forgiato: il resolver recupera tutte le sezioni');
    const h2Marker = parseCantonHubRefreshMarker(git(['show', '-s', '--format=%B', h2]));
    assert.deepEqual(h2Marker, {
      sourceCommit: h1,
      sourceVerified: true,
      receiptRunId: '71001',
      receiptRunAttempt: '1',
      sections: ['canton-gr'],
    });
    assert.equal(hasCompleteCantonHubRefreshCoverage({
      enabledSections: enabled,
      publisherChangedPaths: h2Paths,
      publisherSourceCommit: h2,
      commitMessage: h2Message,
      receiptSourceCommit: h1,
      receiptAuthenticated: h2Verification.verified,
      sourceCommitIsAncestor: true,
      sourceChangedPaths: h2Paths,
    }), false, 'un receipt parziale non prova copertura completa');

    const h3Paths = [];
    for (const section of enabled) {
      const hubPath = `content/cantons/${section}/hubs/eventi.json`;
      fs.mkdirSync(path.dirname(path.join(fixture, hubPath)), { recursive: true });
      fs.writeFileSync(path.join(fixture, hubPath), JSON.stringify({ schemaVersion: 1, section, refreshed: true }) + '\n');
      h3Paths.push(hubPath);
    }
    git(['add', ...h3Paths]);
    git(['commit', '--quiet', '-m', 'Refresh canton hubs', '-m', `Canton-Hub-Source-Commit: ${h2}\nCanton-Hub-Source-Verified: true\nCanton-Hub-Receipt-Run-Id: 71002\nCanton-Hub-Receipt-Run-Attempt: 2\nCanton-Hub-Sections: ${enabled.join(',')}`]);
    const h3 = git(['rev-parse', 'HEAD']);
    const actualH3Paths = git(['diff', '--name-only', h2, h3]).split('\n').filter(Boolean);
    assert.deepEqual(actualH3Paths, [...h3Paths].sort());
    assert.deepEqual(parseCantonHubRefreshMarker(git(['show', '-s', '--format=%B', h3])), {
      sourceCommit: h2,
      sourceVerified: true,
      receiptRunId: '71002',
      receiptRunAttempt: '2',
      sections: enabled,
    });
    const h3Message = git(['show', '-s', '--format=%B', h3]);
    const receipt = createCantonHubRefreshReceipt({
      repository: 'owner/repository',
      eventName: 'workflow_run',
      runId: '71002',
      runAttempt: '2',
      sourceCommit: h2,
      hubCommit: h3,
      sections: enabled,
      sourceVerified: true,
    });
    const metadata = {
      id: 71002,
      run_attempt: 2,
      name: 'Refresh Canton Hubs',
      path: '.github/workflows/refresh-canton-hubs.yml@main',
      event: 'workflow_run',
      head_branch: 'main',
      conclusion: 'success',
      repository: { full_name: 'owner/repository' },
    };
    const h3Verification = verifyCantonHubRefreshReceipt({
      receipt,
      runMetadata: metadata,
      repository: 'owner/repository',
      runId: '71002',
      runAttempt: '2',
      publisherSourceCommit: h3,
      commitMessage: h3Message,
      publisherChangedPaths: actualH3Paths,
    });
    assert.deepEqual(h3Verification, { verified: true, reason: 'authenticated-run-artifact-and-commit' });
    const h3ArtifactDir = path.join(fixture, 'downloaded-proof-artifact');
    fs.mkdirSync(h3ArtifactDir, { recursive: true });
    fs.writeFileSync(path.join(h3ArtifactDir, 'receipt.json'), `${JSON.stringify(receipt)}\n`);
    const h3MetadataPath = path.join(h3ArtifactDir, 'github-run.json');
    fs.writeFileSync(h3MetadataPath, `${JSON.stringify(metadata)}\n`);
    const h3ProofOutput = path.join(fixture, 'h3-proof-output.txt');
    execFileSync(process.execPath, [proofResolver, 'verify'], {
      cwd: fixture,
      input: `${actualH3Paths.join('\n')}\n`,
      env: {
        ...process.env,
        GITHUB_REPOSITORY: 'owner/repository',
        RECEIPT_PATH: path.join(h3ArtifactDir, 'receipt.json'),
        RUN_METADATA_PATH: h3MetadataPath,
        RECEIPT_RUN_ID: '71002',
        RECEIPT_RUN_ATTEMPT: '2',
        PUBLISHER_SOURCE_COMMIT: h3,
        GITHUB_OUTPUT: h3ProofOutput,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const h3ProofOutputText = fs.readFileSync(h3ProofOutput, 'utf8');
    assert.match(h3ProofOutputText, /verified=true/);
    const forgedReceiptVerification = verifyCantonHubRefreshReceipt({
      receipt: { ...receipt, hubCommit: h2 },
      runMetadata: metadata,
      repository: 'owner/repository',
      runId: '71002',
      runAttempt: '2',
      publisherSourceCommit: h3,
      commitMessage: h3Message,
      publisherChangedPaths: actualH3Paths,
    });
    assert.equal(forgedReceiptVerification.verified, false, 'artifact riferito a un commit differente non autentica il marker');
    assert.equal(resolveRefreshMode({
      eventName: 'workflow_run',
      upstreamEvent: 'push',
      upstreamBranch: 'main',
      upstreamConclusion: 'success',
      upstreamTitle: `Publish article data API / range=${h2}..${h3}`,
      upstreamHeadSha: h3,
      publisherStatus: 'published',
      publisherSourceCommit: h3,
      changedPaths: actualH3Paths,
    }).run, true, 'il run H3 raggiunge il resolver della copertura');
    assert.equal(resolveTargets(h3, actualH3Paths, h3ProofOutputText.includes('verified=true')), '', 'receipt full-scope e diff hub-only consentono lo skip anti-loop');
    assert.equal(hasCompleteCantonHubRefreshCoverage({
      enabledSections: enabled,
      publisherChangedPaths: actualH3Paths,
      publisherSourceCommit: h3,
      commitMessage: h3Message,
      receiptSourceCommit: h2,
      receiptAuthenticated: h3Verification.verified,
      sourceCommitIsAncestor: true,
      sourceChangedPaths: actualH3Paths,
    }), true);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test('workflow resolver works from a clean checkout fixture', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'canton-hub-runner-checkout-'));
  try {
    const git = (args) => execFileSync('git', args, { cwd: fixture, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git(['init', '--quiet', '-b', 'main']);
    git(['config', 'user.name', 'Workflow Fixture']);
    git(['config', 'user.email', 'workflow-fixture@example.invalid']);
    const bodyPath = path.join(fixture, 'content/blog-body-canton-ti/it/example.ts');
    fs.mkdirSync(path.dirname(bodyPath), { recursive: true });
    fs.writeFileSync(bodyPath, 'export const body = "prima";\n');
    git(['add', 'content/blog-body-canton-ti/it/example.ts']);
    git(['commit', '--quiet', '-m', 'base']);
    const before = git(['rev-parse', 'HEAD']);
    fs.writeFileSync(bodyPath, 'export const body = "dopo";\n');
    git(['commit', '--quiet', '-am', 'article update']);
    const after = git(['rev-parse', 'HEAD']);
    const output = path.join(fixture, 'github-output.txt');
    const resolver = path.join(ROOT, 'generator/scripts/resolve-canton-hub-refresh-mode.mjs');
    const artifactDir = path.join(fixture, 'publisher-artifact');
    fs.mkdirSync(artifactDir);
    fs.writeFileSync(path.join(artifactDir, 'manifest.json'), JSON.stringify({ commit: after }));

    execFileSync(process.execPath, [resolver], {
      cwd: fixture,
      env: {
        ...process.env,
        EVENT_NAME: 'workflow_run',
        UPSTREAM_EVENT: 'push',
        UPSTREAM_BRANCH: 'main',
        UPSTREAM_CONCLUSION: 'success',
        UPSTREAM_TITLE: `Publish article data API (automatic) / range=${before}..${after}`,
        UPSTREAM_HEAD_SHA: after,
        PUBLISH_API_ARTIFACT_STATE: 'available',
        PUBLISH_API_ARTIFACT_DIR: artifactDir,
        GITHUB_OUTPUT: output,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const result = fs.readFileSync(output, 'utf8');
    assert.match(result, /run=true/);
    assert.match(result, /dry=false/);
    assert.ok(result.includes(`before=${before}\n`));
    assert.ok(result.includes(`after=${after}\n`));
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test('refresh workflow waits for successful article publication without losing independent triggers', () => {
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/refresh-canton-hubs.yml'), 'utf8');
  const pushPaths = workflow.split(/\n  workflow_run:/)[0].split(/\n  push:/)[1];
  const steps = [...workflow.matchAll(/^      - name: (.+)$/gm)].map((match) => ({ name: match[1], index: match.index }));
  const stepIndex = (name) => steps.find((step) => step.name === name)?.index ?? -1;
  assert.match(workflow, /workflows: \['Publish article data API'\]/);
  assert.match(workflow, /types: \[completed\]/);
  assert.match(workflow, /workflow_run\.conclusion == 'success'/);
  assert.match(workflow, /workflow_run\.head_branch == 'main'/);
  assert.match(workflow, /actions\/download-artifact@v7/);
  assert.ok(workflow.indexOf('- name: Download publisher Pages artifact') < workflow.indexOf('- name: Checkout'));
  assert.ok(stepIndex('Checkout') < stepIndex('Setup Node.js'));
  assert.ok(stepIndex('Setup Node.js') < stepIndex('Extract publisher Pages artifact safely'));
  assert.ok(stepIndex('Extract publisher Pages artifact safely') < stepIndex('Resolve publisher artifact state'));
  assert.ok(stepIndex('Resolve publisher artifact state') < stepIndex('Checkout publisher artifact source'));
  assert.ok(stepIndex('Checkout publisher artifact source') < stepIndex('Resolve run mode'), 'checkout e Node devono precedere git diff e gli import sul runner pulito');
  assert.match(workflow, /ref: \$\{\{ github\.event_name == 'workflow_run' && 'main' \|\| github\.sha \}\}/);
  assert.match(workflow, /run: git checkout --detach "\$SOURCE_COMMIT"/);
  assert.match(workflow, /resolve-canton-hub-refresh-mode\.mjs/);
  assert.match(workflow, /push\|workflow_run/);
  assert.match(workflow, /resolve-canton-hub-target-sections\.mjs/);
  assert.match(workflow, /PUBLISHER_SOURCE_COMMIT: \$\{\{ steps\.mode\.outputs\.after \}\}/);
  assert.match(workflow, /HUB_REFRESH_SOURCE_COMMIT: \$\{\{ steps\.mode\.outputs\.after \}\}/);
  assert.match(workflow, /HUB_REFRESH_SOURCE_VERIFIED: \$\{\{ steps\.mode\.outputs\.event == 'workflow_run' \}\}/);
  assert.match(workflow, /HUB_REFRESH_SECTIONS: \$\{\{ steps\.sections\.outputs\.list \}\}/);
  assert.match(workflow, /Canton-Hub-Source-Commit: %s\\nCanton-Hub-Source-Verified: %s\\nCanton-Hub-Receipt-Run-Id: %s\\nCanton-Hub-Receipt-Run-Attempt: %s\\nCanton-Hub-Sections: %s/);
  assert.match(workflow, /git commit -m "Refresh canton hubs" -m "\$TRAILERS"/);
  assert.match(workflow, /github\.event\.workflow_run\.run_attempt/);
  assert.match(workflow, /Wait for the published sitemap links/);
  assert.match(workflow, /steps\.mode\.outputs\.event == 'workflow_run'/);
  assert.match(workflow, /wait-canton-hub-sitemap-ready\.mjs --section "\$SECTIONS" --timeout-seconds 600/);
  assert.match(workflow, /PUBLISH_API_ARTIFACT_DIR: \$\{\{ runner\.temp \}\}\/publish-api-staged/);
  assert.match(workflow, /steps\.sitemap\.outputs\.live-count != '0'/);
  assert.doesNotMatch(pushPaths, /- 'content\//);
  assert.doesNotMatch(pushPaths, /- 'data\/(blog-articles|swiss-articles)\//);
  for (const independentInput of [
    "- 'generator/scripts/generate-canton-hubs.mjs'",
    "- 'generator/data/canton-hub-links.json'",
    "- 'data/article-source-urls.json'",
  ]) assert.ok(pushPaths.includes(independentInput), `${independentInput} deve restare un trigger diretto`);
  assert.match(workflow, /schedule:/);
  assert.match(workflow, /workflow_dispatch:/);
});
