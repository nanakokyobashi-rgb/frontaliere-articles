import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectHistory, parseArgs } from '../../scripts/ci/old-history-guard.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
test('la guardia accetta la storia remota verificata senza imporre un clone completo', () => {
  const commits = new Map([
    ['origin/main^{commit}', 'base-sha'],
    ['HEAD^{commit}', 'candidate-sha'],
  ]);
  const result = inspectHistory({
    cwd: ROOT,
    gitImpl(args) {
      if (args[1] === '--is-inside-work-tree') return 'true';
      if (args[1] === '--is-shallow-repository') return 'true';
      return commits.get(args.at(-1));
    },
    ancestorImpl: (baseSha, candidateSha) => baseSha === 'base-sha' && candidateSha === 'candidate-sha',
  });
  assert.deepEqual(result, {
    baseRef: 'origin/main',
    baseSha: 'base-sha',
    candidate: 'HEAD',
    candidateSha: 'candidate-sha',
    shallow: true,
  });
});

test('la guardia rifiuta una storia vecchia o scollegata prima del push', () => {
  assert.throws(
    () => inspectHistory({
      cwd: ROOT,
      gitImpl(args) {
        if (args[1] === '--is-inside-work-tree') return 'true';
        if (args[1] === '--is-shallow-repository') return 'false';
        return args.at(-1).startsWith('origin/') ? 'new-base' : 'old-candidate';
      },
      ancestorImpl: () => false,
    }),
    /OLD_HISTORY_GUARD: candidate old-candidate does not descend from origin\/main \(new-base\)/u,
  );
});

test('il modulo importato non avvia la CLI e il contratto del retry la invoca', () => {
  assert.deepEqual(parseArgs(['--remote', 'origin', '--branch', 'main', '--candidate', 'HEAD']), {
    remote: 'origin',
    branch: 'main',
    candidate: 'HEAD',
    base: null,
    cwd: process.cwd(),
    help: false,
  });
  const helper = readFileSync(path.join(ROOT, 'scripts/lib/git-push-with-retry.sh'), 'utf8');
  assert.match(helper, /run_old_history_guard\(\)/u);
  assert.match(helper, /old-history-guard\.mjs/u);
  assert.match(helper, /if \[ "\$OLD_HISTORY_GUARD_FAILED" = "1" \]/u);
});
