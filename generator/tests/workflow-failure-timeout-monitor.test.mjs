import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isTimeoutScannerOwnedFailure,
  partitionFailedJobsByOwner,
} from '../../scripts/ci/scan-failed-runs.mjs';
import { scopedTitle } from '../../scripts/ci/scan-job-timeouts.mjs';
import { searchSafePrefix } from '../../scripts/lib/github-issue-creator.mjs';
import { workflowSteps as steps } from './lib/workflow-steps.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKFLOW_PATH = path.join(ROOT, '.github', 'workflows', 'workflow-failure-issues.yml');
const WORKFLOW = readFileSync(WORKFLOW_PATH, 'utf8');
const TIMEOUT_SCANNER_PATH = path.join(ROOT, 'scripts', 'ci', 'scan-job-timeouts.mjs');
const TIMEOUT_SCANNER = readFileSync(TIMEOUT_SCANNER_PATH, 'utf8');
const FAILED_RUNS_SCANNER = readFileSync(
  path.join(ROOT, 'scripts', 'ci', 'scan-failed-runs.mjs'),
  'utf8',
);

// Il confine dello step era «fino al prossimo `- name:`»: uno step senza nome
// dopo di questo ci finiva dentro, e una assert lo leggeva come se fosse suo
// (#935 item 1).
function workflowStep(name) {
  const step = steps(WORKFLOW).find((s) => s.name === name);
  assert.ok(step, `step mancante: ${name}`);
  return step.text;
}

const hostKilledJob = {
  name: 'crawl-group-07',
  conclusion: 'failure',
  status: 'completed',
  completed_at: '2026-08-31T10:00:00Z',
  steps: [
    { name: 'Run crawler', status: 'in_progress', conclusion: null },
    { name: 'Report failure', status: 'pending', conclusion: null },
  ],
};

const ordinaryFailureJob = {
  name: 'crawl-group-08',
  conclusion: 'failure',
  status: 'completed',
  completed_at: '2026-08-31T10:00:00Z',
  steps: [
    { name: 'Run crawler', status: 'completed', conclusion: 'failure' },
    { name: 'Report failure', status: 'completed', conclusion: 'success' },
  ],
};

test('il monitor centrale ha permessi check e inoltra dry-run/lookback senza cambiare il settle', () => {
  assert.match(WORKFLOW, /^  checks: read # leggere l'annotation che prova un vero timeout$/m);

  const step = workflowStep('Scan timed out and host-killed jobs');
  assert.match(step, /node scripts\/ci\/scan-job-timeouts\.mjs --dry-run/);
  assert.match(step, /else\n\s+node scripts\/ci\/scan-job-timeouts\.mjs\n\s+fi/);
  assert.match(step, /TIMEOUT_SCAN_LOOKBACK_MINUTES: \$\{\{ github\.event\.inputs\.lookback_min \|\| '40' \}\}/);
  assert.match(step, /HOST_KILL_SETTLE_MS: '120000'/);
  assert.match(step, /if \[ "\$\{\{ github\.event\.inputs\.dry_run \}\}" = "true" \]; then/);
});

test('scanner generico e specializzato condividono finestra e clock di completamento', () => {
  const generic = workflowStep('Scan failed runs and open issues');
  const specialized = workflowStep('Scan timed out and host-killed jobs');
  const lookback = /github\.event\.inputs\.lookback_min \|\| '40'/g;

  assert.equal((generic.match(lookback) || []).length, 1);
  assert.equal((specialized.match(lookback) || []).length, 1);
  assert.match(FAILED_RUNS_SCANNER, /\(r\.updatedAt \|\| r\.createdAt\) >= since/);
  assert.match(TIMEOUT_SCANNER, /run\.updated_at \|\| run\.created_at \|\| ''/);
  assert.doesNotMatch(TIMEOUT_SCANNER, /Date\.parse\(run\.created_at\) < cutoffMs/);
});

test('un timeout iniziato 350 minuti fa ma appena concluso resta osservabile', () => {
  const binDir = mkdtempSync(path.join(os.tmpdir(), 'timeout-updated-at-gh-'));
  const ghPath = path.join(binDir, 'gh');
  const now = Date.now();
  const run = {
    id: 456,
    name: 'Translate pending articles',
    conclusion: 'cancelled',
    event: 'schedule',
    head_branch: 'main',
    created_at: new Date(now - 350 * 60_000).toISOString(),
    updated_at: new Date(now - 60_000).toISOString(),
    html_url: 'https://github.com/o/r/actions/runs/456',
  };
  const job = {
    id: 789,
    name: 'translate',
    conclusion: 'cancelled',
    status: 'completed',
    check_run_url: 'repos/o/r/check-runs/789',
  };
  writeFileSync(ghPath, `#!/bin/sh
case "$2" in
  *"actions/runs?status=cancelled"*)
    printf '%s' '${JSON.stringify({ workflow_runs: [run] })}' ;;
  *"actions/runs?status=failure"*)
    printf '%s' '{"workflow_runs":[]}' ;;
  "repos/o/r/actions/runs/456/jobs?per_page=100")
    printf '%s' '${JSON.stringify({ jobs: [job] })}' ;;
  "repos/o/r/check-runs/789/annotations")
    printf '%s' '[{"message":"The job exceeded the maximum execution time"}]' ;;
  *)
    printf '%s' '[]' ;;
esac
`);
  chmodSync(ghPath, 0o755);

  try {
    const result = spawnSync(process.execPath, [TIMEOUT_SCANNER_PATH, '--dry-run'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        GH_REPO: 'o/r',
        TIMEOUT_SCAN_LOOKBACK_MINUTES: '40',
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /1 cancelled \+ 0 failed run\(s\)/);
    assert.match(result.stdout, /\(dry-run\) would report "CI Failure: Translate pending articles"/);
  } finally {
    rmSync(binDir, { recursive: true, force: true });
  }
});

test('la deduplica persistente usa la run URL senza sopprimere recidive diverse', () => {
  assert.match(TIMEOUT_SCANNER, /function findIssueReportingRun\(title, runUrl\)/);
  assert.match(TIMEOUT_SCANNER, /'issue', 'view'.*'body,comments'/s);
  assert.match(TIMEOUT_SCANNER, /text\.includes\(runUrl\)/);
  assert.match(TIMEOUT_SCANNER, /already\?\.persistedRunUrl === runUrl/);
});

test('search lag e multi-job sono chiusi con listing sempre unito e un write atomico per run', () => {
  assert.match(TIMEOUT_SCANNER, /const candidates = \[\.\.\.searched, \.\.\.listed\]/);
  assert.match(TIMEOUT_SCANNER, /findIndex\(\(candidate\) => candidate\?\.number === issue\?\.number\)/);
  assert.match(TIMEOUT_SCANNER, /jobCount: hits\.length/);
  assert.match(TIMEOUT_SCANNER, /jobCount: kills\.length/);
  assert.match(TIMEOUT_SCANNER, /const jobBlocks = hits\.flatMap/);
  assert.match(TIMEOUT_SCANNER, /const jobBlocks = kills\.flatMap/);
});

test('issue chiuse e titoli lunghi passano dal reopener senza dedup instabile', () => {
  const longTitle = 'CI Failure: Crawler Group Very Long Name (Dedicated Regional Nightly Sequence)';
  assert.equal(searchSafePrefix(longTitle), 'CI Failure: Crawler Group Very Long Name');
  assert.match(TIMEOUT_SCANNER, /const titlePrefix = searchSafePrefix\(title\)/);
  assert.doesNotMatch(TIMEOUT_SCANNER, /title\.slice\(0,\s*60\)/);
  assert.match(TIMEOUT_SCANNER, /'--json', 'number,title,state'/);
  assert.match(TIMEOUT_SCANNER, /already && already\.state !== 'CLOSED'/);
});

test('una write fallita resta retryable e rende rosso il monitor', () => {
  assert.match(TIMEOUT_SCANNER, /const commented = commentOnGithubIssue/);
  assert.match(TIMEOUT_SCANNER, /if \(!commented\) \{\s*throw new Error/s);
  assert.match(TIMEOUT_SCANNER, /issue\.persisted !== true/);
  assert.doesNotMatch(TIMEOUT_SCANNER, /issue \|\| \{ number: null \}/);
  assert.match(TIMEOUT_SCANNER, /\.catch\(\(err\) => \{[\s\S]*process\.exit\(1\)/);
});

test('tutti i 24 standalone restano coperti dal monitor senza allowlist fragile', () => {
  const standalone = [
    ...Array.from({ length: 23 }, (_, i) => `crawler-group-${String(i + 1).padStart(2, '0')}.yml`),
    'translate-pending.yml',
  ];
  for (const filename of standalone) {
    assert.equal(existsSync(path.join(ROOT, '.github', 'workflows', filename)), true, filename);
  }

  const step = workflowStep('Scan timed out and host-killed jobs');
  assert.doesNotMatch(step, /IGNORE_WORKFLOWS|TIMEOUT_SCAN_WORKFLOWS|--workflow/);
});

test('solo failure/completed con step in_progress appartiene allo scanner specializzato', () => {
  assert.equal(isTimeoutScannerOwnedFailure(hostKilledJob), true);
  assert.equal(isTimeoutScannerOwnedFailure(ordinaryFailureJob), false);
  assert.equal(isTimeoutScannerOwnedFailure({ ...hostKilledJob, conclusion: 'cancelled' }), false);
  assert.equal(isTimeoutScannerOwnedFailure({ ...hostKilledJob, status: 'in_progress' }), false);
  assert.equal(
    isTimeoutScannerOwnedFailure({
      ...hostKilledJob,
      steps: [{ name: 'Queued cleanup', status: 'pending', conclusion: null }],
    }),
    false,
  );
});

test('una run mista conserva il failure ordinario ma cede host-kill una sola volta', () => {
  assert.deepEqual(partitionFailedJobsByOwner([hostKilledJob]), {
    ordinary: [],
    timeoutScanner: [hostKilledJob],
  });
  assert.deepEqual(partitionFailedJobsByOwner([hostKilledJob, ordinaryFailureJob]), {
    ordinary: [ordinaryFailureJob],
    timeoutScanner: [hostKilledJob],
  });
});

test('host-kill only: il CLI ordinario non raggiunge createGithubIssue né il ledger #25', () => {
  const binDir = mkdtempSync(path.join(os.tmpdir(), 'timeout-owner-gh-'));
  const ghPath = path.join(binDir, 'gh');
  const run = {
    databaseId: 123,
    workflowName: 'Crawler Group 07',
    conclusion: 'failure',
    event: 'schedule',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    headBranch: 'main',
    url: 'https://github.com/o/r/actions/runs/123',
  };
  writeFileSync(ghPath, `#!/bin/sh
if [ "$1" = "run" ] && [ "$2" = "list" ]; then
  printf '%s' '${JSON.stringify([run])}'
elif [ "$1" = "api" ] && [ "$2" = "repos/o/r/actions/runs/123/jobs" ]; then
  printf '%s' '${JSON.stringify([hostKilledJob])}'
else
  printf '%s' '[]'
fi
`);
  chmodSync(ghPath, 0o755);

  try {
    const result = spawnSync(
      process.execPath,
      [path.join(ROOT, 'scripts', 'ci', 'scan-failed-runs.mjs'), '--dry-run', '--lookback-min', '40'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH}`,
          GITHUB_REPOSITORY: 'o/r',
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /ceduto a scan-job-timeouts\.mjs/);
    assert.doesNotMatch(result.stdout, /\(dry-run\) aprirei|github-issue-creator|rolling ledger/);
  } finally {
    rmSync(binDir, { recursive: true, force: true });
  }
});

test('il percorso timeout usa titoli CI non gated e non può contare nel ledger #25', () => {
  const title = scopedTitle({ head_branch: 'main', name: 'Crawler group 07', event: 'schedule' });
  assert.equal(title, 'CI Failure: Crawler group 07');
  assert.doesNotMatch(title, /^Crawler Failure:/);

  assert.doesNotMatch(TIMEOUT_SCANNER, /consecutiveGate\s*:/);
  assert.doesNotMatch(WORKFLOW, /gh issue close\s+25|issues\/25|Crawler transient failures \(rolling ledger\)/);
});
