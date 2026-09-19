// Il fast publisher legge `.shard-filecount` da un clone `--filter=blob:none`:
// un fetch su richiesta fallito non deve diventare un conteggio 0 che riparte
// da capo. La presenza si prova dal tree, la lettura fallita e' un errore.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const src = fs.readFileSync(new URL('../../scripts/lib/push-article-shard-incremental.sh', import.meta.url), 'utf8');

test('push-article-shard-incremental: .shard-filecount letto con presenza dal tree e senza `|| echo 0`', () => {
  assert.doesNotMatch(src, /show HEAD:\.shard-filecount[^\n]*\|\| echo 0/);
  const at = src.indexOf('ls-tree --name-only HEAD -- .shard-filecount');
  assert.ok(at > 0, 'presenza dal tree assente');
  const block = src.slice(at, src.indexOf('[[ "$prev_n" =~', at));
  assert.match(block, /show HEAD:\.shard-filecount\)" \|\| \{/);
  assert.match(block, /return 1/);
});

test("l'idioma distingue davvero il blob illeggibile dal file assente", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shard-filecount-'));
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  const read = () => {
    try {
      return execFileSync('bash', ['-c', `
        stage="$1"
        if [ -n "$(git -C "$stage" ls-tree --name-only HEAD -- .shard-filecount 2>/dev/null)" ]; then
          prev_n="$(git -C "$stage" show HEAD:.shard-filecount 2>/dev/null)" || exit 3
        else
          prev_n=0
        fi
        printf '%s' "$prev_n"`, '_', dir], { encoding: 'utf8' });
    } catch (error) { return `exit:${error.status}`; }
  };
  try {
    git('init', '-q');
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'user.name', 'test');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
    git('add', 'a.txt'); git('commit', '-qm', 'no marker');
    assert.equal(read(), '0');
    fs.writeFileSync(path.join(dir, '.shard-filecount'), '41');
    git('add', '.shard-filecount'); git('commit', '-qm', 'marker');
    assert.equal(read(), '41');
    const blob = git('rev-parse', 'HEAD:.shard-filecount');
    fs.rmSync(path.join(dir, '.git', 'objects', blob.slice(0, 2), blob.slice(2)));
    assert.equal(read(), 'exit:3');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
