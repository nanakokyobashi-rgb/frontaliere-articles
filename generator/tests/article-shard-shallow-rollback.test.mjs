import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const source = readFileSync(new URL('../../scripts/lib/push-article-shard-incremental.sh', import.meta.url), 'utf8');
const rollback = source.slice(source.indexOf('rollback_serialized_publications() {'), source.indexOf('\nreconcile_failed_publication() {'));
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();

for (const scenario of ['single', 'batch', 'body-header', 'foreign-head', 'merge']) {
  test(`rollback shallow verifica i parent reali: ${scenario} (#2390)`, () => {
    const root = mkdtempSync(join(tmpdir(), 'shallow-rollback-'));
    try {
      git(root, 'init', '-q', '--initial-branch=main');
      git(root, 'config', 'user.name', 'rollback-test');
      git(root, 'config', 'user.email', 'rollback-test@example.invalid');
      const commit = (text) => {
        writeFileSync(join(root, 'article.html'), text);
        git(root, 'add', 'article.html');
        git(root, 'commit', '-qm', text);
        return git(root, 'rev-parse', 'HEAD');
      };
      const base = commit('base');
      const candidates = [commit('article update')];
      if (scenario === 'batch') candidates.push(commit('second batch'));
      if (scenario === 'body-header') {
        git(root, 'commit', '--amend', '-qm', `article update\n\nparent ${base}\n${'message text\n'.repeat(2_000)}`);
        candidates[0] = git(root, 'rev-parse', 'HEAD');
      }
      if (scenario === 'foreign-head') commit('another publisher');
      if (scenario === 'merge') {
        const tree = git(root, 'rev-parse', 'HEAD^{tree}');
        const merged = git(root, 'commit-tree', tree, '-p', candidates[0], '-p', base, '-m', 'merge');
        git(root, 'update-ref', 'refs/heads/main', merged);
        candidates[0] = merged;
      }
      const initialHead = git(root, 'rev-parse', 'HEAD');
      // file:// makes --depth effective, unlike a plain local clone path.
      const remote = `file://${root}`;
      git(root, 'config', 'receive.denyCurrentBranch', 'ignore');
      const program = `
        set -euo pipefail
        ${rollback}
        shard_push_token_for_repo() { printf ''; }
        wait_for_pages_build() { return 0; }
        GIT_PAT_OPTS=()
        SHARD_REPO="$1"
        section=fixture
        loc=it
        article_content_revision=''
        article_push_pages_wait_seconds=1
        rollback_serialized_publications "$2" "$3" "\${@:4}"
      `;
      const result = spawnSync('bash', ['-c', program, 'rollback-test', remote, join(root, 'scratch'), base, ...candidates], {
        encoding: 'utf8', timeout: 20_000,
      });
      assert.ifError(result.error);
      const output = result.stdout + result.stderr;
      if (scenario === 'foreign-head' || scenario === 'merge') {
        assert.equal(result.status, 1, output);
        assert.equal(git(root, 'rev-parse', 'HEAD'), initialHead);
        assert.match(output, /outside the recorded batch commit chain|does not directly follow/);
      } else {
        assert.equal(result.status, 0, output);
        assert.match(output, /reconciled failed serialized push/);
        assert.equal(git(root, 'rev-parse', 'HEAD^{tree}'), git(root, 'rev-parse', `${base}^{tree}`));
        assert.equal(git(root, 'rev-parse', 'HEAD^'), initialHead);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
