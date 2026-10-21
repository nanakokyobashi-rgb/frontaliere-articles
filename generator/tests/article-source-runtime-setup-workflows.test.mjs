import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (relativePath) => readFileSync(path.join(ROOT, relativePath), 'utf8');
const WORKFLOW_PATHS = [
  '.github/workflows/auto-live-canton-sections.yml',
  '.github/workflows/bonifica-blocking-bodies.yml',
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
  '.github/workflows/bonifica-blocking-bodies.yml': ['bonifica'],
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

test('article-source runtime is isolated, pinned, and installed in every parser workflow', () => {
  const pkg = JSON.parse(read('scripts/ci/article-source-runtime/package.json'));
  const lock = JSON.parse(read('scripts/ci/article-source-runtime/package-lock.json'));
  assert.deepEqual(pkg.dependencies, { typescript: '5.8.3' });
  assert.equal(lock.packages[''].dependencies.typescript, '5.8.3');
  assert.equal(lock.packages['node_modules/typescript'].version, '5.8.3');
  assert.equal(lock.packages['node_modules/typescript'].resolved, 'https://registry.npmjs.org/typescript/-/typescript-5.8.3.tgz');
  assert.ok(!JSON.stringify(lock).includes('file:'), 'lock must not point at a temporary local package');

  const action = read('.github/actions/setup-article-source-runtime/action.yml');
  assert.match(action, /npm ci --ignore-scripts --no-audit --no-fund/);
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

  for (const workflowPath of ['.github/workflows/fast-publish-article.yml', '.github/workflows/fast-publish-section.yml']) {
    const workflow = read(workflowPath);
    const resolveJob = getJobBlock(workflow, 'resolve');
    const preflight = resolveJob.indexOf('node scripts/ci/check-blog-body-links.mjs');
    assert.ok(preflight >= 0, `${workflowPath}/resolve: expected link preflight`);
    assert.ok(resolveJob.indexOf('Setup isolated article source runtime') < preflight, `${workflowPath}/resolve: parser runtime must be ready before link preflight`);
  }

  const fastSection = read('.github/workflows/fast-publish-section.yml');
  for (const jobName of ['resolve', 'publish']) {
    const job = getJobBlock(fastSection, jobName);
    assert.match(job, /ref: \$\{\{ github\.sha \}\}[\s\S]*?path: \.replay-dispatcher-source[\s\S]*?sparse-checkout:\s*\|[\s\S]*?\.github\/actions\/setup-article-source-runtime\/action\.yml[\s\S]*?scripts\/ci\/article-source-runtime\/package-lock\.json[\s\S]*?scripts\/ci\/check-article-source-runtime\.mjs/);
    assert.match(job, /uses: \.\/\.replay-dispatcher-source\/\.github\/actions\/setup-article-source-runtime/);
  }

  const publishApi = getJobBlock(read('.github/workflows/publish-api.yml'), 'publish');
  assert.match(publishApi, /ref: \$\{\{ github\.sha \}\}[\s\S]*?path: \.article-source-runtime[\s\S]*?sparse-checkout:\s*\|[\s\S]*?\.github\/actions\/setup-article-source-runtime\/action\.yml[\s\S]*?scripts\/ci\/article-source-runtime\/package-lock\.json[\s\S]*?scripts\/ci\/check-article-source-runtime\.mjs/);
  assert.match(publishApi, /uses: \.\/\.article-source-runtime\/\.github\/actions\/setup-article-source-runtime/);
  assert.ok(publishApi.indexOf('Setup isolated article source runtime') < publishApi.indexOf('Verify bounded replay source is still main'), 'publish-api must install parser runtime before the historical-source guard runs');

  assert.match(getJobBlock(read('.github/workflows/fast-publish-article.yml'), 'publish'), /Setup isolated article source runtime\n        if: needs\.resolve\.outputs\.skip != 'true'/);
  assert.match(getJobBlock(read('.github/workflows/fast-publish-section.yml'), 'publish'), /Setup isolated article source runtime\n        if: steps\.replay_freshness\.outputs\.fresh == 'true'/);

  const generatorCi = read('.github/workflows/generator-ci.yml');
  for (const pattern of [
    "'.github/actions/setup-article-source-runtime/**'",
    "'scripts/ci/article-source-runtime/**'",
    "'scripts/ci/check-article-source-runtime.mjs'",
  ]) {
    assert.equal(generatorCi.split(pattern).length - 1, 2, `${pattern}: both push and pull_request filters`);
  }
});
