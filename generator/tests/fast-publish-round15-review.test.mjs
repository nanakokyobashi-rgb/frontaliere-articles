// Round 15 di F1: nei dispatch API-only `push_after` e' vuoto e la release e'
// identificata da `api_wait_commit`. Il range delle sezioni nuove deve partire
// da `api_baseline`, non da PUSH_AFTER. Il test gira sul coordinator vero.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { publishRunDurationMinutes, publishSectionsFromJobs } from '../../scripts/ci/measure-section-cadence.mjs';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const coordinate = path.join(repoRoot, 'scripts/ci/fast-publish-section-coordinate.sh');

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function commit(cwd, file, content) {
  writeFileSync(path.join(cwd, file), content);
  git(cwd, 'add', file);
  git(cwd, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', file);
  return git(cwd, 'rev-parse', 'HEAD');
}

function run(env) {
  const root = mkdtempSync(path.join(tmpdir(), 'f1-r15-'));
  try {
    const fixture = path.join(root, 'corpus');
    mkdirSync(path.join(fixture, 'scripts/ci'), { recursive: true });
    git(fixture, 'init', '-q');
    const base = commit(fixture, 'a.txt', '1\n');
    const latest = commit(fixture, 'a.txt', '2\n');
    const calls = path.join(root, 'calls.log');
    writeFileSync(path.join(fixture, 'scripts/ci/read-main-head.sh'), `#!/usr/bin/env bash\necho ${latest}\n`);
    writeFileSync(path.join(fixture, 'scripts/ci/section-source-unaffected.sh'), '#!/usr/bin/env bash\nexit 1\n');
    const realModule = path.join(repoRoot, 'scripts/ci/fast-publish-section.mjs');
    writeFileSync(path.join(fixture, 'scripts/ci/fast-publish-section.mjs'), `
import { appendFileSync, readFileSync } from 'node:fs';
const mod = await import(${JSON.stringify(realModule)});
const [cmd, ...args] = process.argv.slice(2);
const input = () => JSON.parse(readFileSync(0, 'utf8'));
appendFileSync(${JSON.stringify(calls)}, [cmd, ...args].join(' ') + '\\n');
if (cmd === 'r2-api-stage-barrier') console.log(JSON.stringify(mod.r2ApiStageBarrierDecision(input())));
else if (cmd === 'r2-api-wait-defer') console.log(String(mod.r2ShouldDeferApiReadinessToFinalize(input())));
else if (cmd === 'r2-api-data-range') console.log('true');
else if (cmd === 'r2-api-stage-plan-range') {
  if (!args[0]) { console.error('r2-api-stage-plan-range richiede before e after'); process.exit(1); }
  console.log(JSON.stringify([{ section: 'canton-ti' }]));
}
else process.exit(2);
`);
    const output = path.join(root, 'output');
    writeFileSync(output, '');
    const artifacts = path.join(root, 'artifacts');
    mkdirSync(artifacts);
    const result = spawnSync('bash', [coordinate], {
      cwd: fixture,
      encoding: 'utf8',
      env: {
        ...process.env,
        STAGE_MATRIX: '[]',
        FINAL_MATRIX: '[]',
        GITHUB_OUTPUT: output,
        ARTIFACTS_DIR: artifacts,
        ...env({ base, latest }),
      },
    });
    const outputs = Object.fromEntries(readFileSync(output, 'utf8').split('\n').filter(Boolean).map((line) => {
      const index = line.indexOf('=');
      return [line.slice(0, index), line.slice(index + 1)];
    }));
    const log = readFileSync(calls, 'utf8').split('\n').filter(Boolean);
    return { result, outputs, log, base, latest };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('dispatch API-only con push_after vuoto: il range delle sezioni nuove parte da api_wait_commit', () => {
  const { result, outputs, log, base, latest } = run(({ base: b }) => ({
    API_ACTION: 'wait',
    EVENT_NAME: 'workflow_dispatch',
    PUSH_AFTER: '',
    API_WAIT_COMMIT: b,
  }));
  assert.equal(result.status, 0, result.stderr);
  const ranges = log.filter((line) => line.startsWith('r2-api-stage-plan-range'));
  assert.ok(ranges.length >= 1, 'il piano delle sezioni nuove deve essere calcolato');
  for (const line of ranges) assert.equal(line, `r2-api-stage-plan-range ${base} ${latest}`);
  assert.equal(outputs.api_baseline, base);
  assert.equal(outputs.api_commit, latest);
  assert.match(outputs.sections_json, /canton-ti/u, 'la sezione col nuovo input API entra nel finalize');
});

test('release non-push (workflow_run) con push_after vuoto: stesso inizio del range', () => {
  const { result, log, base, latest } = run(({ base: b }) => ({
    API_ACTION: 'wait',
    EVENT_NAME: 'workflow_run',
    PUSH_AFTER: '',
    API_WAIT_COMMIT: b,
  }));
  assert.equal(result.status, 0, result.stderr);
  assert.ok(log.includes(`r2-api-stage-plan-range ${base} ${latest}`));
});

test('evento push: il range parte ancora da PUSH_AFTER (comportamento invariato)', () => {
  const { result, log, base, latest } = run(({ base: b }) => ({
    API_ACTION: 'dispatch',
    EVENT_NAME: 'push',
    PUSH_AFTER: b,
  }));
  assert.ok(log.includes(`r2-api-stage-plan-range ${base} ${latest}`), result.stderr);
});

test('il coordinator non usa piu PUSH_AFTER come inizio del range API', () => {
  const source = readFileSync(coordinate, 'utf8');
  assert.doesNotMatch(source, /r2-api-stage-plan-range "\$PUSH_AFTER"/u);
  assert.equal((source.match(/r2-api-stage-plan-range "\$api_baseline" "\$latest"/gu) ?? []).length, 2);
});

// ───────── Il nome dei job matrix e' un contratto col misuratore ─────────

const workflow = readFileSync(path.join(repoRoot, '.github/workflows/fast-publish-section.yml'), 'utf8');

function jobNameTemplate(jobId) {
  const lines = workflow.split('\n');
  const start = lines.indexOf(`  ${jobId}:`);
  assert.ok(start >= 0, `job ${jobId} assente`);
  for (let i = start + 1; i < lines.length && !/^ {2}\S/u.test(lines[i]); i += 1) {
    const match = lines[i].match(/^ {4}name: (.+)$/u);
    if (match) return match[1].trim();
  }
  assert.fail(`name: del job ${jobId} assente`);
}

test('i nomi dei job stage/finalize del workflow sono quelli che il misuratore sa leggere', () => {
  for (const jobId of ['stage', 'finalize']) {
    const template = jobNameTemplate(jobId);
    assert.equal(template, `${jobId} (\${{ matrix.target.section }})`, `formato del nome di ${jobId} cambiato`);
    // Rende il nome come farebbe Actions e lo passa al parser vero.
    const name = template.replace('${{ matrix.target.section }}', 'canton-ti');
    assert.equal(name, `${jobId} (canton-ti)`);
    assert.deepEqual(publishSectionsFromJobs([{ name, status: 'in_progress' }], { liveOnly: true }), ['canton-ti']);
  }
});

test('stati live dell API Jobs: solo i non terminali contano come sezione occupata', () => {
  // Enum documentato dell API Jobs: queued, in_progress, completed, waiting, requested, pending.
  for (const status of ['queued', 'in_progress', 'waiting', 'pending', 'requested']) {
    assert.deepEqual(publishSectionsFromJobs([{ name: 'finalize (canton-ti)', status }], { liveOnly: true }), ['canton-ti'], status);
  }
  assert.deepEqual(publishSectionsFromJobs([{ name: 'finalize (canton-ti)', status: 'completed' }], { liveOnly: true }), []);
});

test('updatedAt vale come fine run solo a run completata, mai prima dell inizio', () => {
  const startedAt = '2026-11-28T10:00:00Z';
  assert.equal(publishRunDurationMinutes({ status: 'completed', startedAt, updatedAt: '2026-11-28T10:30:00Z' }), 30);
  assert.equal(publishRunDurationMinutes({ status: 'in_progress', startedAt, updatedAt: '2026-11-28T10:30:00Z' }), null);
  assert.equal(publishRunDurationMinutes({ status: 'completed', startedAt, updatedAt: '2026-11-28T09:00:00Z' }), null);
});
