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
import {
  assertRunAgeHorizon,
  scanLookbackMinutes,
  scopedTitle,
} from '../../scripts/ci/scan-job-timeouts.mjs';
import { searchSafePrefix } from '../../scripts/lib/github-issue-creator.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKFLOW_PATH = path.join(ROOT, '.github', 'workflows', 'workflow-failure-issues.yml');
const WORKFLOW = readFileSync(WORKFLOW_PATH, 'utf8');
const TIMEOUT_SCANNER_PATH = path.join(ROOT, 'scripts', 'ci', 'scan-job-timeouts.mjs');
const TIMEOUT_SCANNER = readFileSync(TIMEOUT_SCANNER_PATH, 'utf8');
const FAILED_RUNS_SCANNER = readFileSync(
  path.join(ROOT, 'scripts', 'ci', 'scan-failed-runs.mjs'),
  'utf8',
);

function workflowStep(name) {
  const marker = `      - name: ${name}`;
  const start = WORKFLOW.indexOf(marker);
  assert.notEqual(start, -1, `step mancante: ${name}`);
  const next = WORKFLOW.indexOf('\n      - name:', start + marker.length);
  return WORKFLOW.slice(start, next === -1 ? undefined : next);
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
  // La finestra non è più la costante 40: si deriva dall'ultima scansione
  // riuscita (`resolveLookbackMin`) perché il cron non è onorato. L'invariante
  // pinnata resta la stessa — il monitor INOLTRA la finestra invece di averne
  // una propria — cambia solo da dove arriva il valore, e si risolve nella
  // SHELL: una scrittura in GITHUB_ENV non alimenta in modo affidabile il
  // context `env.*` del passo successivo (stessa trappola del PAT, review #1568).
  assert.match(step, /TIMEOUT_SCAN_LOOKBACK_INPUT: \$\{\{ github\.event\.inputs\.lookback_min \}\}/);
  assert.match(step, /export TIMEOUT_SCAN_LOOKBACK_MINUTES="\$\{TIMEOUT_SCAN_LOOKBACK_INPUT:-\$\{SCAN_RESOLVED_LOOKBACK_MIN:-40\}\}"/);
  assert.match(step, /TIMEOUT_SCAN_ALLOW_TRUNCATED_CREATED_HORIZON: 'true'/);
  assert.match(step, /HOST_KILL_SETTLE_MS: '120000'/);
  assert.match(step, /if \[ "\$\{\{ github\.event\.inputs\.dry_run \}\}" = "true" \]; then/);
});

test('orizzonte created fail-closed e lookback derivato realmente cappato a 12 ore', () => {
  assert.throws(
    () => assertRunAgeHorizon({ maxRunAgeMinutes: 3 * 24 * 60, allowTruncated: false }),
    /truncates the 35-day run retention/,
  );
  assert.doesNotThrow(
    () => assertRunAgeHorizon({ maxRunAgeMinutes: 3 * 24 * 60, allowTruncated: true }),
  );
  assert.doesNotThrow(
    () => assertRunAgeHorizon({ maxRunAgeMinutes: 35 * 24 * 60, allowTruncated: false }),
  );

  const nowMs = Date.parse('2026-09-28T19:34:00Z');
  assert.deepEqual(scanLookbackMinutes({
    nowMs,
    previousScanStartedMs: nowMs - 30 * 60_000,
    baseMinutes: 31 * 60,
    maxMinutes: 12 * 60,
  }), { minutes: 720, neededMinutes: 45, truncated: true });
  assert.deepEqual(scanLookbackMinutes({
    nowMs,
    previousScanStartedMs: Number.NaN,
    baseMinutes: 31 * 60,
    maxMinutes: 12 * 60,
  }), { minutes: 720, neededMinutes: null, truncated: true });
});

test('scanner generico e specializzato condividono finestra e clock di completamento', () => {
  const generic = workflowStep('Scan failed runs and open issues');
  const specialized = workflowStep('Scan timed out and host-killed jobs');

  // La finestra CONDIVISA resta l'invariante; la sua sorgente non è più il
  // letterale `|| '40'` in entrambi i passi — che era una costante duplicata,
  // cioè esattamente ciò che AGENTS.md §6 vieta — ma un valore risolto una
  // volta dallo scanner generico ed esportato in GITHUB_ENV.
  //
  // Lo scanner generico non deve ricevere un lookback fisso: passarne sempre
  // uno rendeva la derivazione codice morto sulle run da `schedule`.
  assert.doesNotMatch(generic, /--lookback-min "\$\{\{ github\.event\.inputs\.lookback_min \|\| '40' \}\}"/);
  assert.match(generic, /if \[ -n "\$\{\{ github\.event\.inputs\.lookback_min \}\}" \]/);
  // Lo specializzato deve LEGGERE quella finestra, non calcolarne una propria.
  assert.match(specialized, /env\.SCAN_RESOLVED_LOOKBACK_MIN/);
  assert.match(
    FAILED_RUNS_SCANNER,
    /appendFileSync\(process\.env\.GITHUB_ENV, `SCAN_RESOLVED_LOOKBACK_MIN=\$\{lookbackCache\}\\n`\)/,
    'la finestra risolta va esportata, o il gemello ricade sul default e il buco torna',
  );
  assert.match(FAILED_RUNS_SCANNER, /\(r\.updatedAt \|\| r\.createdAt\) >= since/);
  assert.match(TIMEOUT_SCANNER, /run\.updated_at \|\| run\.created_at \|\| ''/);
  assert.doesNotMatch(TIMEOUT_SCANNER, /Date\.parse\(run\.created_at\) < cutoffMs/);
});

test('il deep scan osserva una run creata oltre 3 giorni fa ma aggiornata nel cutoff', () => {
  const binDir = mkdtempSync(path.join(os.tmpdir(), 'timeout-updated-at-gh-'));
  const ghPath = path.join(binDir, 'gh');
  const argsLog = path.join(binDir, 'args.log');
  const now = Date.now();
  const run = {
    id: 456,
    name: 'Translate pending articles',
    conclusion: 'cancelled',
    event: 'schedule',
    head_branch: 'main',
    created_at: new Date(now - 4 * 24 * 60 * 60_000).toISOString(),
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
printf '%s\n' "$*" >> "$ARGS_LOG"
case "$2" in
  *"actions/runs?status=cancelled"*)
    printf '%s' '${JSON.stringify({ workflow_runs: [run] })}' ;;
  *"actions/runs?status=failure"*)
    printf '%s' '{"workflow_runs":[]}' ;;
  "repos/o/r/actions/runs/456/jobs?per_page=100")
    printf '%s' '${JSON.stringify({ jobs: [job] })}' ;;
  "repos/o/r/check-runs/789/annotations")
    printf '%s' '[[{"message":"The job exceeded the maximum execution time"}]]' ;;
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
        ARGS_LOG: argsLog,
        GH_REPO: 'o/r',
        TIMEOUT_SCAN_LOOKBACK_MINUTES: '40',
        TIMEOUT_SCAN_MAX_RUN_AGE_MINUTES: String(35 * 24 * 60),
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /1 cancelled \+ 0 failed run\(s\)/);
    assert.match(result.stdout, /\(dry-run\) would report "CI Failure: Translate pending articles"/);

    const cancelledListing = readFileSync(argsLog, 'utf8')
      .split('\n')
      .find((line) => line.includes('actions/runs?status=cancelled'));
    assert.ok(cancelledListing, 'listing cancelled non osservato');
    const created = new URLSearchParams(cancelledListing.split('?')[1]).get('created');
    assert.ok(created?.includes('..'), 'range created mancante');
    const [oldest] = created.split('..');
    const expectedHorizonMs = (35 * 24 * 60 + 40) * 60_000;
    const observedHorizonMs = now - Date.parse(oldest);
    assert.ok(observedHorizonMs >= expectedHorizonMs - 1_000, `${observedHorizonMs}ms`);
    assert.ok(observedHorizonMs < expectedHorizonMs + 60_000, `${observedHorizonMs}ms`);
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
  assert.match(TIMEOUT_SCANNER, /already && normalizedIssueState\(already\) === 'OPEN'/);
  assert.match(TIMEOUT_SCANNER, /state: normalizedIssueState\(issue\)/);
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
