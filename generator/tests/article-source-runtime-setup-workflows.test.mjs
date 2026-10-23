import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (relativePath) => readFileSync(path.join(ROOT, relativePath), 'utf8');
const WORKFLOW_PATHS = [
  '.github/workflows/auto-live-canton-sections.yml',
  '.github/workflows/batch-faq-articles.yml',
  '.github/workflows/bonifica-blocking-bodies.yml',
  '.github/workflows/bing-seo-loop.yml',
  '.github/workflows/content-gates-main.yml',
  '.github/workflows/fast-publish-article.yml',
  '.github/workflows/fast-publish-section.yml',
  '.github/workflows/generate-article-core.yml',
  '.github/workflows/generate-article.yml',
  '.github/workflows/generate-border-wait-ranking-weekly.yml',
  '.github/workflows/generate-daily-brief.yml',
  '.github/workflows/generation-health-watchdog.yml',
  '.github/workflows/generator-ci.yml',
  '.github/workflows/publish-api.yml',
  '.github/workflows/publish-journalist-articles.yml',
  '.github/workflows/reconcile-article-shards.yml',
  '.github/workflows/refresh-canton-hubs.yml',
  '.github/workflows/refresh-events-digest.yml',
  '.github/workflows/regenerate-queued-covers.yml',
  '.github/workflows/republish-dirty-content.yml',
  '.github/workflows/tests.yml',
];
const PARSER_JOBS = {
  '.github/workflows/auto-live-canton-sections.yml': ['reconcile'],
  '.github/workflows/batch-faq-articles.yml': ['generate-faq'],
  '.github/workflows/bonifica-blocking-bodies.yml': ['bonifica'],
  '.github/workflows/bing-seo-loop.yml': ['audit'],
  '.github/workflows/content-gates-main.yml': ['gates'],
  '.github/workflows/fast-publish-article.yml': ['resolve', 'publish'],
  '.github/workflows/fast-publish-section.yml': ['resolve', 'publish'],
  '.github/workflows/generate-article-core.yml': ['generate'],
  '.github/workflows/generate-article.yml': ['generate'],
  '.github/workflows/generate-border-wait-ranking-weekly.yml': ['refresh'],
  '.github/workflows/generate-daily-brief.yml': ['edition'],
  '.github/workflows/generation-health-watchdog.yml': ['watch'],
  '.github/workflows/generator-ci.yml': ['test', 'dry-run'],
  '.github/workflows/publish-api.yml': ['publish'],
  '.github/workflows/publish-journalist-articles.yml': ['publish'],
  '.github/workflows/reconcile-article-shards.yml': ['reconcile'],
  '.github/workflows/refresh-canton-hubs.yml': ['refresh'],
  '.github/workflows/refresh-events-digest.yml': ['refresh'],
  '.github/workflows/regenerate-queued-covers.yml': ['drain'],
  '.github/workflows/republish-dirty-content.yml': ['republish'],
  '.github/workflows/tests.yml': ['tests'],
};
const RUNTIME_ACTION_PATHS = {
  '.github/workflows/fast-publish-section.yml': {
    resolve: './.replay-dispatcher-source/.github/actions/setup-article-source-runtime',
    publish: './.replay-dispatcher-source/.github/actions/setup-article-source-runtime',
  },
  '.github/workflows/publish-api.yml': {
    publish: './.article-source-runtime/.github/actions/setup-article-source-runtime',
  },
};

function getJobBlock(workflow, jobName) {
  const jobsStart = workflow.indexOf('\njobs:');
  assert.ok(jobsStart >= 0, 'workflow must declare jobs');
  const jobs = workflow.slice(jobsStart + '\njobs:'.length);
  const starts = [...jobs.matchAll(/^  ([\w-]+):/gm)];
  const index = starts.findIndex((match) => match[1] === jobName);
  assert.ok(index >= 0, `workflow job ${jobName} must exist`);
  return jobs.slice(starts[index].index, starts[index + 1]?.index ?? jobs.length);
}

test('article-source runtime is isolated, pinned, retried, and limited to parser paths', () => {
  const pkg = JSON.parse(read('scripts/ci/article-source-runtime/package.json'));
  const lock = JSON.parse(read('scripts/ci/article-source-runtime/package-lock.json'));
  assert.deepEqual(pkg.dependencies, { typescript: '5.8.3' });
  assert.equal(lock.packages[''].dependencies.typescript, '5.8.3');
  assert.equal(lock.packages['node_modules/typescript'].version, '5.8.3');
  assert.equal(lock.packages['node_modules/typescript'].resolved, 'https://registry.npmjs.org/typescript/-/typescript-5.8.3.tgz');
  assert.ok(!JSON.stringify(lock).includes('file:'), 'lock must not point at a temporary local package');

  const action = read('.github/actions/setup-article-source-runtime/action.yml');
  assert.match(action, /bash "\$action_root\/scripts\/lib\/npm-ci-retry\.sh" --ignore-scripts --no-audit --no-fund/);
  const npmCiRetry = read('scripts/lib/npm-ci-retry.sh');
  assert.match(npmCiRetry, /ATTEMPTS="\$\{NPM_CI_RETRY_ATTEMPTS:-3\}"/);
  assert.match(npmCiRetry, /BACKOFF_STEP="\$\{NPM_CI_RETRY_BACKOFF:-10\}"/);
  assert.match(npmCiRetry, /if \[ "\$attempt" -ge "\$ATTEMPTS" \]; then/);
  assert.match(action, /ACTION_PATH: \$\{\{ github\.action_path \}\}/);
  assert.match(action, /action_root="\$\(cd "\$ACTION_PATH\/\.\.\/\.\.\/\.\." && pwd\)"/);
  assert.doesNotMatch(action, /GITHUB_WORKSPACE\/scripts\/ci\//, 'action assets must be resolved relative to the action checkout');
  assert.match(action, /printf 'ARTICLE_SOURCE_TYPESCRIPT=%s\\n' "\$compiler_entry" >> "\$GITHUB_ENV"/);
  assert.match(action, /check-article-source-runtime\.mjs/);
  assert.match(read('scripts/ci/check-article-source-runtime.mjs'), /expectedVersion = '5\.8\.3'/);

  for (const workflowPath of WORKFLOW_PATHS) {
    const workflow = read(workflowPath);
    const expectedJobs = PARSER_JOBS[workflowPath];
    const setupCount = workflow.match(/^      - name: Setup isolated article source runtime$/gm)?.length ?? 0;
    assert.equal(setupCount, expectedJobs.length, `${workflowPath}: expected one runtime setup per parser job`);
    for (const jobName of expectedJobs) {
      const job = getJobBlock(workflow, jobName);
      const runtimeSetup = job.indexOf('      - name: Setup isolated article source runtime');
      assert.ok(runtimeSetup >= 0, `${workflowPath}/${jobName}: runtime action must be installed in this job`);
      const runtimeBlock = job.slice(runtimeSetup).split('\n      - ')[0];
      const expectedActionPath = RUNTIME_ACTION_PATHS[workflowPath]?.[jobName]
        ?? './.github/actions/setup-article-source-runtime';
      assert.ok(runtimeBlock.includes(`        uses: ${expectedActionPath}`), `${workflowPath}/${jobName}: runtime action path`);
      const nodeSetup = job.indexOf('uses: actions/setup-node@');
      assert.ok(nodeSetup >= 0 && nodeSetup < runtimeSetup, `${workflowPath}/${jobName}: runtime setup must follow setup-node in the same job`);
    }
  }

  const fastArticle = read('.github/workflows/fast-publish-article.yml');
  const fastArticleResolve = getJobBlock(fastArticle, 'resolve');
  const articlePlan = fastArticleResolve.indexOf('Resolve mode, article ids and section');
  const articleRuntime = fastArticleResolve.indexOf('Setup isolated article source runtime');
  const articlePreflight = fastArticleResolve.indexOf('node scripts/ci/check-blog-body-links.mjs');
  assert.ok(articlePlan >= 0 && articlePlan < articleRuntime && articleRuntime < articlePreflight,
    'fast-publish-article must decide no-op with builtin Node before installing the parser, then run the real preflight');
  const articleRuntimeStep = fastArticleResolve.slice(articleRuntime).split('\n      - ')[0];
  const articlePreflightStep = fastArticleResolve.slice(fastArticleResolve.lastIndexOf('      - name: Preflight', articlePreflight), articlePreflight);
  assert.match(articleRuntimeStep, /if: steps\.mode\.outputs\.skip != 'true'/);
  assert.match(articlePreflightStep, /if: steps\.mode\.outputs\.skip != 'true'/);

  const fastSection = read('.github/workflows/fast-publish-section.yml');
  const fastSectionResolve = getJobBlock(fastSection, 'resolve');
  const sectionPlan = fastSectionResolve.indexOf('Resolve sections and article ids');
  const sectionRuntime = fastSectionResolve.indexOf('Setup isolated article source runtime');
  const sectionPreflight = fastSectionResolve.indexOf('node scripts/ci/check-blog-body-links.mjs');
  assert.ok(sectionPlan >= 0 && sectionPlan < sectionRuntime && sectionRuntime < sectionPreflight,
    'fast-publish-section must decide no-op with builtin Node before installing the parser, then run the real preflight');
  const sectionRuntimeStep = fastSectionResolve.slice(sectionRuntime).split('\n      - ')[0];
  const sectionPreflightStep = fastSectionResolve.slice(fastSectionResolve.lastIndexOf('      - name: Preflight', sectionPreflight), sectionPreflight);
  assert.match(sectionRuntimeStep, /if: steps\.plan\.outputs\.any == 'true'/);
  assert.match(sectionPreflightStep, /if: steps\.plan\.outputs\.any == 'true'/);

  for (const [workflowPath, jobName, detectCommand] of [
    ['.github/workflows/reconcile-article-shards.yml', 'reconcile', 'node scripts/reconcile-article-shards.mjs'],
    ['.github/workflows/republish-dirty-content.yml', 'republish', 'node scripts/find-dirty-content-ids.mjs'],
  ]) {
    const job = getJobBlock(read(workflowPath), jobName);
    assert.ok(job.includes(detectCommand), `${workflowPath}/${jobName}: expected detection command`);
    assert.match(job, /Setup isolated article source runtime/,
      `${workflowPath}/${jobName}: detection must initialize the shared parser runtime`);
  }

  for (const jobName of ['resolve', 'publish']) {
    const job = getJobBlock(fastSection, jobName);
    assert.match(job, /ref: \$\{\{ github\.sha \}\}[\s\S]*?path: \.replay-dispatcher-source[\s\S]*?sparse-checkout:\s*\|[\s\S]*?\.github\/actions\/setup-article-source-runtime\/action\.yml[\s\S]*?scripts\/ci\/article-source-runtime\/package-lock\.json[\s\S]*?scripts\/ci\/check-article-source-runtime\.mjs[\s\S]*?scripts\/lib\/npm-ci-retry\.sh/);
    assert.match(job, /uses: \.\/\.replay-dispatcher-source\/\.github\/actions\/setup-article-source-runtime/);
  }

  const publishApiWorkflow = read('.github/workflows/publish-api.yml');
  const publishApi = getJobBlock(publishApiWorkflow, 'publish');
  assert.match(publishApi, /ref: \$\{\{ github\.sha \}\}[\s\S]*?path: \.article-source-runtime[\s\S]*?sparse-checkout:\s*\|[\s\S]*?\.github\/actions\/setup-article-source-runtime\/action\.yml[\s\S]*?scripts\/ci\/article-source-runtime\/package-lock\.json[\s\S]*?scripts\/ci\/check-article-source-runtime\.mjs[\s\S]*?scripts\/lib\/npm-ci-retry\.sh/);
  assert.match(publishApi, /uses: \.\/\.article-source-runtime\/\.github\/actions\/setup-article-source-runtime/);
  assert.ok(publishApi.indexOf('Setup isolated article source runtime') < publishApi.indexOf('Verify bounded replay source is still main'), 'publish-api must install parser runtime before the historical-source guard runs');
  const publishApiPushPaths = publishApiWorkflow.slice(publishApiWorkflow.indexOf('on:'), publishApiWorkflow.indexOf('permissions:'));
  assert.ok(publishApiPushPaths.includes("'scripts/lib/npm-ci-retry.sh'"), 'changing the action retry helper must rerun publish-api');

  assert.match(getJobBlock(read('.github/workflows/fast-publish-article.yml'), 'publish'), /Setup isolated article source runtime\n        if: needs\.resolve\.outputs\.skip != 'true'/);
  assert.match(getJobBlock(read('.github/workflows/fast-publish-section.yml'), 'publish'), /Setup isolated article source runtime\n        if: steps\.replay_freshness\.outputs\.fresh == 'true'/);

  const batchFaqWorkflow = read('.github/workflows/batch-faq-articles.yml');
  const batchFaqPushPaths = batchFaqWorkflow.slice(batchFaqWorkflow.indexOf('on:'), batchFaqWorkflow.indexOf('permissions:'));
  for (const pattern of [
    "'.github/actions/setup-article-source-runtime/**'",
    "'scripts/ci/article-source-runtime/**'",
    "'scripts/ci/check-article-source-runtime.mjs'",
    "'scripts/lib/npm-ci-retry.sh'",
  ]) {
    assert.ok(batchFaqPushPaths.includes(pattern), `batch-faq-articles: changing ${pattern} must rerun its self-test`);
  }

  const bingSeoWorkflow = read('.github/workflows/bing-seo-loop.yml');
  assert.match(bingSeoWorkflow, /sparse-checkout:\s*\|[\s\S]*\.github\/actions\/setup-article-source-runtime\/action\.yml/);

  const generatorCi = read('.github/workflows/generator-ci.yml');
  for (const pattern of [
    "'.github/actions/setup-article-source-runtime/**'",
    "'scripts/ci/article-source-runtime/**'",
    "'scripts/ci/check-article-source-runtime.mjs'",
    "'scripts/lib/npm-ci-retry.sh'",
  ]) {
    assert.equal(generatorCi.split(pattern).length - 1, 2, `${pattern}: both push and pull_request filters`);
  }
});
