import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CORPUS_REPOSITORY,
  isMutatingGhArgs,
  resolveGhScope,
  validateGhArgs,
} from '../../.github/actions/claude-codex-fallback/gh-bridge-server.mjs';
import { isMutatingGitArgs } from '../../.github/actions/claude-codex-fallback/git-bridge-server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const action = fs.readFileSync(path.join(ROOT, '.github/actions/claude-codex-fallback/action.yml'), 'utf8');
const mintGate = fs.readFileSync(path.join(ROOT, 'scripts/ci/gate-minted-followups.mjs'), 'utf8');
const lessonsWorkflow = fs.readFileSync(path.join(ROOT, '.github/workflows/lessons-harvester.yml'), 'utf8');
const followupWorkflow = fs.readFileSync(path.join(ROOT, '.github/workflows/post-merge-followup.yml'), 'utf8');
const issueDecomposeWorkflow = fs.readFileSync(path.join(ROOT, '.github/workflows/issue-decompose.yml'), 'utf8');
const needsHumanWorkflow = fs.readFileSync(path.join(ROOT, '.github/workflows/needs-human-sweep.yml'), 'utf8');
const testsWorkflow = fs.readFileSync(path.join(ROOT, '.github/workflows/tests.yml'), 'utf8');

function workflowStep(source, name) {
  const start = source.indexOf(`      - name: ${name}`);
  assert.notEqual(start, -1, `workflow step «${name}» non trovato`);
  const rest = source.slice(start + 1);
  const next = rest.indexOf('\n      - name: ');
  return next === -1 ? rest : rest.slice(0, next);
}

test('the GitHub bridge marks only state-changing gh operations', () => {
  assert.equal(isMutatingGhArgs(['--repo', 'owner/repo', 'pr', 'comment', '--body-file', 'body.md']), true);
  assert.equal(isMutatingGhArgs(['issue', 'edit', '--repo', 'owner/repo', '1']), true);
  assert.equal(isMutatingGhArgs(['--repo', 'owner/repo', 'pr', 'view', '1']), false);
  assert.equal(isMutatingGhArgs(['api', 'repos/owner/repo', '--method', 'GET']), false);
});

test('the corpus bridge permits read-only API metadata without permitting mutations', () => {
  const scope = resolveGhScope(
    ['api', `repos/${CORPUS_REPOSITORY}/issues`, '--repo', CORPUS_REPOSITORY, '--method', 'GET'],
    {
      repository: 'valerielinc-ops/frontaliere-si-o-no',
      host: 'github.com',
      siteRepository: 'valerielinc-ops/frontaliere-si-o-no',
      siteToken: 'site-token',
      corpusToken: 'corpus-token',
    },
  );
  assert.equal(scope.kind, 'corpus');
  assert.equal(scope.allowedCommandSet.has('api'), true);
  assert.equal(
    scope.allowedCommandSet.has('issue'),
    true,
  );

  const context = {
    cwd: ROOT,
    workspaceRoot: ROOT,
    scratchRoot: ROOT,
    host: 'github.com',
    repository: scope.repository,
    allowedCommandSet: scope.allowedCommandSet,
    allowedSubcommandMap: scope.allowedSubcommandMap,
  };
  assert.equal(
    validateGhArgs(
      ['api', `repos/${CORPUS_REPOSITORY}/issues`, '--method', 'GET', '--jq', '.content'],
      context,
    ),
    '',
  );
  assert.match(
    validateGhArgs(
      ['issue', 'view', '1403', '--repo', CORPUS_REPOSITORY, '--jq', '.body'],
      context,
    ),
    /only permitted for read-only gh api requests/,
  );
  assert.match(
    validateGhArgs(
      ['api', `repos/${CORPUS_REPOSITORY}/issues`, '--method', 'POST'],
      context,
    ),
    /mutations/,
  );
});

test('the corpus checkout keeps current calls on the runner and routes explicit cross-repo targets', () => {
  const corpus = resolveGhScope(
    ['--repo', CORPUS_REPOSITORY, 'issue', 'create'],
    {
      repository: 'valerielinc-ops/frontaliere-si-o-no',
      host: 'github.com',
      siteRepository: 'valerielinc-ops/frontaliere-si-o-no',
      siteToken: 'site-token',
      corpusToken: 'corpus-token',
    },
  );
  assert.equal(corpus.kind, 'corpus');
  assert.equal(corpus.repository, CORPUS_REPOSITORY);
  assert.equal(corpus.token, 'corpus-token');

  const currentCorpus = resolveGhScope(
    ['issue', 'list'],
    {
      repository: CORPUS_REPOSITORY,
      siteRepository: 'valerielinc-ops/frontaliere-si-o-no',
      host: 'github.com',
      siteToken: 'site-token',
      corpusToken: 'corpus-token',
    },
  );
  assert.equal(currentCorpus.kind, 'site');
  assert.equal(currentCorpus.repository, CORPUS_REPOSITORY);
  assert.equal(currentCorpus.token, 'site-token');
  assert.equal(currentCorpus.allowedCommandSet.has('pr'), true);

  const currentCorpusExplicit = resolveGhScope(
    ['search', 'issues', '--repo', CORPUS_REPOSITORY],
    {
      repository: CORPUS_REPOSITORY,
      siteRepository: 'valerielinc-ops/frontaliere-si-o-no',
      host: 'github.com',
      currentToken: 'current-corpus-token',
      siteToken: 'site-token',
      corpusToken: 'corpus-token',
    },
  );
  assert.equal(currentCorpusExplicit.repository, CORPUS_REPOSITORY);
  assert.equal(currentCorpusExplicit.kind, 'corpus');
  assert.equal(currentCorpusExplicit.token, 'corpus-token');
  assert.equal(currentCorpusExplicit.allowedCommandSet.has('search'), true);
  assert.equal(
    validateGhArgs(
      ['search', 'issues', '--repo', CORPUS_REPOSITORY],
      {
        cwd: ROOT,
        workspaceRoot: ROOT,
        scratchRoot: ROOT,
        host: 'github.com',
        repository: currentCorpusExplicit.repository,
        allowedCommandSet: currentCorpusExplicit.allowedCommandSet,
        allowedSubcommandMap: currentCorpusExplicit.allowedSubcommandMap,
      },
    ),
    '',
  );

  const currentCorpusApi = resolveGhScope(
    ['api', `repos/${CORPUS_REPOSITORY}/pulls/1403`, '--method', 'GET'],
    {
      repository: CORPUS_REPOSITORY,
      siteRepository: 'valerielinc-ops/frontaliere-si-o-no',
      host: 'github.com',
      currentToken: 'current-corpus-token',
      siteToken: 'site-token',
      corpusToken: 'corpus-token',
    },
  );
  assert.equal(currentCorpusApi.kind, 'site');
  assert.equal(currentCorpusApi.repository, CORPUS_REPOSITORY);
  assert.equal(currentCorpusApi.token, 'current-corpus-token');
  assert.equal(
    validateGhArgs(
      ['api', `repos/${CORPUS_REPOSITORY}/pulls/1403`, '--method', 'GET'],
      {
        cwd: ROOT,
        workspaceRoot: ROOT,
        scratchRoot: ROOT,
        host: 'github.com',
        repository: currentCorpusApi.repository,
        allowedCommandSet: currentCorpusApi.allowedCommandSet,
        allowedSubcommandMap: currentCorpusApi.allowedSubcommandMap,
      },
    ),
    '',
  );

  const site = resolveGhScope(
    ['--repo', 'valerielinc-ops/frontaliere-si-o-no', 'issue', 'create'],
    {
      repository: CORPUS_REPOSITORY,
      siteRepository: 'valerielinc-ops/frontaliere-si-o-no',
      host: 'github.com',
      currentToken: 'current-corpus-token',
      siteToken: 'site-token',
      corpusToken: 'corpus-token',
    },
  );
  assert.equal(site.kind, 'site');
  assert.equal(site.repository, 'valerielinc-ops/frontaliere-si-o-no');
  assert.equal(site.token, 'site-token');
  assert.equal(site.allowedCommandSet.has('issue'), true);
});

test('the Git bridge marks delivery and local-state-changing operations', () => {
  assert.equal(isMutatingGitArgs(['push', 'origin', 'HEAD']), true);
  assert.equal(isMutatingGitArgs(['fetch', 'origin', '--prune']), true);
  assert.equal(isMutatingGitArgs(['pull', 'origin', 'main']), true);
  assert.equal(isMutatingGitArgs(['ls-remote', 'origin', 'HEAD']), false);
});

test('Claude fallback is suppressed when Codex side effects are possible', () => {
  assert.match(action, /steps\.codex\.outcome == 'failure'/);
  assert.match(action, /steps\.codex\.outputs\.side_effect_detected == 'false'/);
  assert.match(action, /Prepare host-side GitHub bridge for Claude fallback/);
  assert.match(action, /steps\.claude_bridge\.outcome == 'success'/);
  assert.match(action, /cp -- "\$action_path\/gh-bridge\.sh" "\$bridge_root\/gh"/);
  assert.match(action, /resolved_gh="\$\(PATH="\$bridge_path" command -v gh/);
  assert.match(action, /echo "\$bridge_root" >> "\$GITHUB_PATH"/);
  const fallbackStart = action.indexOf('    - name: Run Claude fallback');
  const cleanupStart = action.indexOf('    - name: Cleanup Claude fallback GitHub bridge', fallbackStart);
  assert.notEqual(fallbackStart, -1);
  assert.notEqual(cleanupStart, -1);
  const fallback = action.slice(fallbackStart, cleanupStart);
  assert.match(fallback, /      env:\n        GITHUB_PAT: ''\n        GITHUB_PAT_NANAKO: ''\n        GITHUB_PAT_SITE: ''/);
  assert.doesNotMatch(action, /echo 'GITHUB_PAT='/);
  assert.doesNotMatch(action, /echo 'GITHUB_PAT_NANAKO='/);
  assert.doesNotMatch(action, /echo 'GITHUB_PAT_SITE='/);
  assert.match(action, /Cleanup Claude fallback GitHub bridge/);
  assert.match(action, /restore_sanitized_git_config/);
  const stopGhStart = action.indexOf('        stop_gh_bridge() {');
  const stopGhEnd = action.indexOf('        trap stop_gh_bridge EXIT', stopGhStart);
  assert.notEqual(stopGhStart, -1);
  assert.match(action.slice(stopGhStart, stopGhEnd), /restore_sanitized_git_config \|\| true/);
  assert.match(action, /cmp -s -- \"\$codex_state_before\" \"\$codex_state_after\"/);
});

test('il bridge corpus resta host-side anche quando il PAT arriva da GITHUB_ENV', () => {
  assert.ok(
    action.includes('codex_corpus_github_auth="${CODEX_CORPUS_GH_AUTH:-${GITHUB_PAT_NANAKO:-${GITHUB_PAT:-}}}"'),
    'il bridge deve usare il PAT caricato dal runtime se l input statico è vuoto',
  );
  assert.ok(
    action.includes('codex_site_github_auth="${CODEX_SITE_GH_AUTH:-${GITHUB_PAT_SITE:-${GITHUB_PAT:-}}}"'),
    'il bridge deve poter usare il PAT Valerie host-side per un target sito dal checkout corpus',
  );
  assert.match(action, /unset CODEX_GH_AUTH CODEX_CORPUS_GH_AUTH CODEX_SITE_GH_AUTH GITHUB_PAT_NANAKO GITHUB_PAT GITHUB_PAT_SITE/);

  const start = followupWorkflow.indexOf('Per Valerie usa SEMPRE');
  const end = followupWorkflow.indexOf('Parse PR body', start);
  assert.ok(start >= 0 && end > start, 'blocco di routing corpus non trovato');
  const routing = followupWorkflow.slice(start, end);
  assert.match(routing, /gh issue create --repo valerielinc-ops\/frontaliere-si-o-no/);
  assert.match(routing, /gh issue create --repo nanakokyobashi-rgb\/frontaliere-articles/);
  assert.doesNotMatch(routing, /GH_TOKEN=\"\$GITHUB_PAT\"/,
    'Codex deve usare il wrapper gh del bridge, non una variabile che il sandbox non riceve');
});

test('the corpus review loads its host-side PAT before invoking Codex', () => {
  const reviewStep = workflowStep(testsWorkflow, 'Run Claude review');
  const followupStep = workflowStep(followupWorkflow, 'Run Claude follow-up triage (batch)');
  const firebaseStep = workflowStep(followupWorkflow, 'Prepare Firebase credentials for follow-up routing');
  const credentialsStep = workflowStep(followupWorkflow, 'Load cross-repo follow-up credentials');
  assert.match(firebaseStep, /if: always\(\)/,
    'il recovery dei gate deve poter ripristinare il routing anche con batch_count=0');
  assert.match(credentialsStep, /if: always\(\)/,
    'il PAT cross-repo deve essere disponibile anche nel percorso di recovery');
  assert.match(testsWorkflow, /Prepare Firebase credentials for Codex review/);
  assert.match(testsWorkflow, /Load cross-repo Codex credentials/);
  assert.match(testsWorkflow, /node generator\/scripts\/load-rc-env\.mjs/);
  assert.match(reviewStep, /codex_corpus_github_token: \$\{\{ env\.GITHUB_PAT_NANAKO \|\| env\.GITHUB_PAT \}\}/);
  assert.doesNotMatch(reviewStep, /GITHUB_PAT:\s*\$\{\{ env\.GITHUB_PAT \}\}/);
  assert.match(followupStep, /codex_corpus_github_token: \$\{\{ env\.GITHUB_PAT_NANAKO \|\| env\.GITHUB_PAT \}\}/);
  assert.match(followupStep, /codex_site_github_token: \$\{\{ env\.GITHUB_PAT \}\}/);
  assert.doesNotMatch(followupStep, /GITHUB_PAT:\s*\$\{\{ env\.GITHUB_PAT \}\}/);
  assert.match(followupWorkflow, /SITE_REPO: valerielinc-ops\/frontaliere-si-o-no/);
  assert.match(followupWorkflow, /target_token="\$\{GITHUB_PAT_SITE:-\$\{GITHUB_PAT:-\$\{GH_TOKEN:-\}\}\}"/);
  assert.match(followupWorkflow, /Gate sul conio — sito \(zero-Claude\)/);
  assert.match(followupWorkflow, /Checkout site gate implementation/);
  assert.match(followupWorkflow, /repository: valerielinc-ops\/frontaliere-si-o-no/);
  assert.match(followupWorkflow, /sparse-checkout:\s*\|\n\s+\.github\/workflows\n\s+scripts\/ci/);
  assert.match(followupWorkflow, /cd \.site-gate/);
  assert.match(followupWorkflow, /GATE_PR_TOKEN="\$corpus_token"/);
  assert.match(followupWorkflow, /gh issue list --repo nanakokyobashi-rgb\/frontaliere-articles/);
  assert.match(followupWorkflow, /gh issue list --repo valerielinc-ops\/frontaliere-si-o-no/);
  assert.doesNotMatch(followupWorkflow, /GITHUB_PAT_NANAKO:\s*\$\{\{ env\.GITHUB_PAT_NANAKO/);
  assert.match(issueDecomposeWorkflow, /codex_site_github_token: \$\{\{ env\.GITHUB_PAT \}\}/);
  assert.match(issueDecomposeWorkflow, /gh api --repo valerielinc-ops\/frontaliere-si-o-no repos\/valerielinc-ops\/frontaliere-si-o-no\/contents\/VISION\.md/);
  assert.match(needsHumanWorkflow, /codex_site_github_token: \$\{\{ env\.GITHUB_PAT \}\}/);
  assert.match(needsHumanWorkflow, /gh api --repo valerielinc-ops\/frontaliere-si-o-no repos\/valerielinc-ops\/frontaliere-si-o-no\/contents\/VISION\.md/);
  assert.match(mintGate, /GATE_PR_TOKEN/);
  assert.match(mintGate, /function ghPr\(/);
  assert.match(mintGate, /ghPr\(\['pr', 'comment'/);
});

test('#1312: Lessons harvester non blocca Codex quando la quota Claude e\u0027 esaurita', () => {
  const quota = workflowStep(lessonsWorkflow, 'Pre-flight — Claude quota telemetry (Codex primary)');
  const draft = workflowStep(lessonsWorkflow, 'Draft doc-rule proposal (Claude — only if NOVEL patterns)');

  assert.match(quota, /continue-on-error: true/,
    'la telemetria quota non deve trasformare un 429 in un workflow failure');
  assert.match(draft, /uses: \.\/\.github\/actions\/claude-codex-fallback/,
    'il Lessons harvester deve usare l’action provider-neutral con Codex primario');
  assert.match(draft, /codex_auth_json: \$\{\{ secrets\.CODEX_AUTH_JSON \}\}/,
    'il workflow deve fornire l’autenticazione subscription al provider primario');
  assert.match(draft, /codex_github_token: \$\{\{ secrets\.GITHUB_TOKEN \}\}/,
    'il provider primario deve avere il token GitHub esplicito per il bridge');
  assert.doesNotMatch(draft, /steps\.quota\.outputs\.quota_blocked/,
    'un beacon Claude attivo non deve saltare il tentativo Codex primario');
});
