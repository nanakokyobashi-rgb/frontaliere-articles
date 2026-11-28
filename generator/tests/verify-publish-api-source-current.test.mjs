import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const HELPER = resolve(ROOT, 'scripts/ci/verify-publish-api-source-current.sh');
const SOURCE = 'a'.repeat(40);
const CURRENT = 'b'.repeat(40);

function runHelper({
  apiInputChanged = false,
  ancestor = true,
  fetchedMain = CURRENT,
  fetchedAtLeastAuthoritative = true,
  githubEnv = true,
  restUnavailable = false,
  remoteRef = CURRENT + "\trefs/heads/main",
  advancePolicy,
} = {}) {
  const dir = mkdtempSync(resolve(tmpdir(), 'verify-publish-api-source-'));
  const envFile = resolve(dir, 'github-env');
  const fakeBin = resolve(dir, 'bin');
  mkdirSync(fakeBin);
  const writeExecutable = (name, body) => {
    const file = resolve(fakeBin, name);
    writeFileSync(file, body);
    chmodSync(file, 0o755);
  };
  try {
    writeFileSync(envFile, '');
    writeExecutable('gh', '#!/bin/sh\n[ "$FAKE_REST_UNAVAILABLE" != true ] || exit 1\nprintf "%s\n" "' + CURRENT + '"\n');
    writeExecutable('timeout', '#!/bin/sh\nshift 2\nexec "$@"\n');
    writeExecutable(
      'node',
      '#!/bin/sh\nif [ "${CURRENT_MAIN:-}" != "$FAKE_FETCHED_MAIN" ]; then printf "true\n"; else printf "%s\n" "$FAKE_API_INPUT"; fi\n',
    );
    writeExecutable(
      'git',
      '#!/bin/sh\ncase "$1" in\n  ls-remote) printf "%s\\n" "$FAKE_REMOTE_REF" ;;\n  fetch) exit 0 ;;\n  rev-parse) printf "%s\\n" "$FAKE_FETCHED_MAIN" ;;\n  merge-base) if [ "$3" = "$FAKE_AUTHORITATIVE_MAIN" ]; then [ "$FAKE_FETCHED_AT_LEAST" = "true" ] && exit 0 || exit 1; else [ "$FAKE_ANCESTOR" = "true" ] && exit 0 || exit 1; fi ;;\n  *) exit 0 ;;\nesac\n',
    );
    const env = {
      ...process.env,
      PATH: fakeBin + ':' + process.env.PATH,
      RUNNER_TEMP: dir,
      GH_TOKEN: 'test-token',
      REPOSITORY: 'nanakokyobashi-rgb/frontaliere-articles',
      PUBLISH_API_SOURCE_COMMIT: SOURCE,
      VERIFY_CONTEXT: 'test',
      FAKE_REST_UNAVAILABLE: String(restUnavailable),
      FAKE_REMOTE_REF: remoteRef,
      FAKE_API_INPUT: String(apiInputChanged),
      FAKE_ANCESTOR: String(ancestor),
      FAKE_FETCHED_MAIN: fetchedMain,
      FAKE_AUTHORITATIVE_MAIN: CURRENT,
      FAKE_FETCHED_AT_LEAST: String(fetchedAtLeastAuthoritative),
    };
    if (advancePolicy) env.VERIFY_API_ADVANCE = advancePolicy;
    if (githubEnv) env.GITHUB_ENV = envFile;
    else delete env.GITHUB_ENV;
    try {
      const stdout = execFileSync('bash', [HELPER], {
        cwd: ROOT,
        env,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { status: 0, output: stdout + readFileSync(envFile, 'utf8') };
    } catch (error) {
      return {
        status: error.status ?? 1,
        output: String(error.stdout ?? '') + String(error.stderr ?? ''),
      };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('freshness helper autorizza un avanzamento non-API senza mutare il commit dell artifact', () => {
  const result = runHelper({ apiInputChanged: false });
  assert.equal(result.status, 0);
  assert.match(result.output, /con gli input API invariati/u);
  assert.match(result.output, new RegExp('source=' + SOURCE));
  assert.doesNotMatch(result.output, new RegExp('PUBLISH_API_SOURCE_COMMIT=' + CURRENT));
});

test('freshness helper classifica la snapshot di main restituita dal fetch', () => {
  const fetchedMain = 'c'.repeat(40);
  const result = runHelper({ apiInputChanged: false, fetchedMain });
  assert.equal(result.status, 0);
  assert.match(result.output, new RegExp('main=' + fetchedMain));
  assert.match(result.output, /con gli input API invariati/u);
});

test('freshness helper rifiuta un fetch piu vecchio della HEAD autorevole', () => {
  const result = runHelper({ fetchedMain: SOURCE, fetchedAtLeastAuthoritative: false });
  assert.equal(result.status, 1);
  assert.match(result.output, /piu' vecchia o non riconciliabile/u);
  assert.match(result.output, new RegExp('autorevole=' + CURRENT));
  assert.match(result.output, new RegExp('fetch=' + SOURCE));
});

test('freshness helper disattiva le fasi successive quando main contiene input API nuovi', () => {
  const result = runHelper({ apiInputChanged: true });
  assert.equal(result.status, 0);
  assert.match(result.output, /publish-api saltato prima di test: main=.*contiene input API piu' recenti/u);
  assert.match(result.output, /PUBLISH_API_SKIP=true/u);
  assert.doesNotMatch(result.output, new RegExp('PUBLISH_API_SOURCE_COMMIT=' + CURRENT));

  const outsideActions = runHelper({ apiInputChanged: true, githubEnv: false });
  assert.equal(outsideActions.status, 1, 'senza il meccanismo che salta le fasi successive il gate resta fail-closed');
  assert.match(outsideActions.output, /contiene input API piu' recenti/u);
});

test('freshness helper resta fail-closed se la storia non è riconciliabile', () => {
  const result = runHelper({ ancestor: false });
  assert.equal(result.status, 1);
  assert.match(result.output, /avanzamento non riconciliabile/u);
});

test('freshness helper verifies the remote Git ref when REST is unavailable', () => {
  const result = runHelper({ restUnavailable: true, apiInputChanged: true });
  assert.equal(result.status, 0);
  assert.match(result.output, /PUBLISH_API_SKIP=true/u);
});

test('freshness helper fails closed when neither transport verifies main', () => {
  const result = runHelper({ restUnavailable: true, remoteRef: SOURCE + '\trefs/heads/other' });
  assert.equal(result.status, 1);
  assert.match(result.output, /impossibile verificare la HEAD corrente/u);
});

test('freshness helper in modalita adopt prosegue con la sorgente costruita quando main ha input API nuovi', () => {
  const result = runHelper({ apiInputChanged: true, advancePolicy: 'adopt' });
  assert.equal(result.status, 0);
  assert.match(result.output, /publish-api prosegue prima di test/u);
  assert.match(result.output, /pubblichera' il delta/u);
  assert.doesNotMatch(result.output, /PUBLISH_API_SKIP=true/u, 'nessun marker di skip: le fasi successive girano');
  assert.doesNotMatch(result.output, new RegExp('PUBLISH_API_SOURCE_COMMIT=' + CURRENT));

  const outsideActions = runHelper({ apiInputChanged: true, advancePolicy: 'adopt', githubEnv: false });
  assert.equal(outsideActions.status, 0);
});

test('freshness helper in modalita adopt resta fail-closed su storia non riconciliabile o fetch vecchio', () => {
  assert.equal(runHelper({ ancestor: false, advancePolicy: 'adopt' }).status, 1);
  assert.equal(
    runHelper({ fetchedMain: SOURCE, fetchedAtLeastAuthoritative: false, advancePolicy: 'adopt' }).status,
    1,
  );
});

test('freshness helper con policy skip esplicita mantiene il comportamento dei replay bounded', () => {
  const result = runHelper({ apiInputChanged: true, advancePolicy: 'skip' });
  assert.match(result.output, /PUBLISH_API_SKIP=true/u);
});
