/**
 * Il bridge GitHub del fallback Codex deve riconoscere l'endpoint di una
 * richiesta `gh api` read-only qualunque sia l'ordine dei flag, con query e
 * separatore `--`, senza allargare gli endpoint consentiti
 * (follow-up sito #8334, FU-2026-09-12-003). Fissa anche il routing senza
 * `--repo`: un target non esplicito resta sul checkout corrente e non riceve
 * mai il PAT corpus (FU-2026-09-12-002).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CORPUS_REPOSITORY,
  resolveGhScope,
  validateGhArgs,
} from '../../.github/actions/claude-codex-fallback/gh-bridge-server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SITE = 'valerielinc-ops/frontaliere-si-o-no';

function contextFor(repository) {
  return { cwd: ROOT, workspaceRoot: ROOT, scratchRoot: ROOT, host: 'github.com', repository };
}

const R = CORPUS_REPOSITORY;

test('gh api read-only: l endpoint si trova con qualunque ordine dei flag (FU-2026-09-12-003)', () => {
  const accepted = [
    ['api', '--jq', '.[].number', `repos/${R}/issues`],
    ['api', '-q', '.[] | .title', `repos/${R}/issues?state=open&per_page=100`],
    ['api', '--paginate', '--jq', '.[].name', `repos/${R}/labels`],
    ['api', '-t', '{{.title}}', `repos/${R}/issues/1`],
    ['api', '--template', '{{.title}}', `repos/${R}/issues/1`],
    ['api', '--cache', '1h', `repos/${R}/pulls/1/files`],
    ['api', '-p', 'mercy', `repos/${R}/issues/1`],
    ['api', '--preview', 'mercy', `repos/${R}/issues/1`],
    ['api', '-H', 'Accept: application/vnd.github+json', '--jq', '.body', `repos/${R}/issues/1`],
    ['api', '-X', 'GET', '-f', 'per_page=100', '--jq', '.[].number', `repos/${R}/issues`],
    ['api', '--jq', '.[].number', '--', `repos/${R}/issues`],
    ['api', `repos/${R}/issues`, '--jq', '.[].number'],
    ['api', '--jq=.[].number', `repos/${R}/issues`],
  ];
  for (const args of accepted) {
    assert.equal(validateGhArgs(args, contextFor(R)), '', args.join(' '));
  }
});

test('gh api: il riordino dei flag non allarga endpoint ne metodi', () => {
  const rejected = [
    [['api', '--jq', '.x', `repos/${SITE}/issues`], /restricted to the current repository/],
    [['api', '-q', '.x', '--', 'repos/other/repo/issues'], /restricted to the current repository/],
    [['api', '--cache', '1h', 'https://api.github.com/repos/x/y'], /relative endpoint|positional URLs/],
    [['api', '--jq', '.x', `repos/${R}/issues`, '-X', 'POST'], /mutations/],
    [['api', '-q', '.x', '-f', 'title=t', `repos/${R}/issues`], /explicit GET/],
    [['api', '--jq', '.x', `repos/${R}/actions/secrets`], /not permitted/],
  ];
  for (const [args, message] of rejected) {
    assert.match(validateGhArgs(args, contextFor(R)), message, args.join(' '));
  }
});

test('senza --repo il target resta il checkout corrente e non riceve il PAT corpus (FU-2026-09-12-002)', () => {
  const options = {
    repository: SITE,
    siteRepository: SITE,
    host: 'github.com',
    siteToken: 'site-token',
    corpusToken: 'corpus-token',
  };
  for (const args of [
    ['issue', 'comment', '5', '--body', 'x'],
    ['pr', 'comment', '5', '--body', 'x'],
    ['api', `repos/${R}/issues`, '--method', 'GET'],
  ]) {
    const scope = resolveGhScope(args, options);
    assert.equal(scope.repository, SITE, args.join(' '));
    assert.notEqual(scope.token, 'corpus-token', args.join(' '));
  }
  // Un endpoint corpus senza --repo dal checkout del sito resta fail-closed:
  // lo scope e' il sito, quindi il validatore rifiuta l'endpoint.
  const scope = resolveGhScope(['api', `repos/${R}/issues`, '--method', 'GET'], options);
  assert.match(
    validateGhArgs(['api', `repos/${R}/issues`, '--method', 'GET'], {
      ...contextFor(scope.repository),
      allowedCommandSet: scope.allowedCommandSet,
      allowedSubcommandMap: scope.allowedSubcommandMap,
    }),
    /restricted to the current repository/,
  );
  assert.match(
    resolveGhScope(['--repo', R, 'issue', 'comment', '5', '--repo', SITE], options).error,
    /multiple repositories/,
  );
});
