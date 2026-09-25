/**
 * corpus-floors-history-revision-precedence.test.mjs — la base storica del
 * floor su una PR non puo' essere quella del ramo push (issue #1784).
 *
 * FU-2026-09-22-009 (valerielinc-ops/frontaliere-si-o-no#9508): in
 * generator-ci.yml `PREFLIGHT_PUSH_BASE_REVISION` vale `github.sha` quando
 * `github.ref_name == 'engine-lockstep-auto'`, e l'env e' a livello di job,
 * quindi e' valorizzata anche nelle run `pull_request`. La domanda della
 * review era se le due variabili potessero interferire. Non possono, ma
 * nessun test lo diceva: `blog-body-syntax-gate.test.mjs` passa una sola
 * variabile per evento. Qui le si passano entrambe, con i valori che il
 * workflow produrrebbe davvero.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { historyRevisionFromEnv } from '../../scripts/lib/corpus-floors.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PR_BASE = '1'.repeat(40);
const LOCKSTEP_SHA = '2'.repeat(40);

test('pull_request: vince la base della PR anche con la base push valorizzata', () => {
  assert.equal(
    historyRevisionFromEnv({
      PREFLIGHT_EVENT_NAME: 'pull_request',
      PREFLIGHT_PR_BASE_REVISION: PR_BASE,
      PREFLIGHT_PUSH_BASE_REVISION: LOCKSTEP_SHA,
      PREFLIGHT_BASE_REVISION: LOCKSTEP_SHA,
    }),
    PR_BASE,
  );
});

test('pull_request senza base PR: fail-closed, non ricade sulla base push', () => {
  for (const missing of ['', '0'.repeat(40)]) {
    assert.equal(
      historyRevisionFromEnv({
        PREFLIGHT_EVENT_NAME: 'pull_request',
        PREFLIGHT_PR_BASE_REVISION: missing,
        PREFLIGHT_PUSH_BASE_REVISION: LOCKSTEP_SHA,
      }),
      null,
      `base PR ${JSON.stringify(missing)} non deve diventare ${LOCKSTEP_SHA}`,
    );
  }
});

test('push sul branch del mirror: vince la base push anche con la base PR valorizzata', () => {
  assert.equal(
    historyRevisionFromEnv({
      PREFLIGHT_EVENT_NAME: 'push',
      PREFLIGHT_PR_BASE_REVISION: PR_BASE,
      PREFLIGHT_PUSH_BASE_REVISION: LOCKSTEP_SHA,
    }),
    LOCKSTEP_SHA,
  );
});

test('generator-ci.yml: l\'espressione engine-lockstep-auto alimenta solo la base push', () => {
  const yml = fs.readFileSync(path.join(ROOT, '.github/workflows/generator-ci.yml'), 'utf8');
  const lockstepLines = yml.split('\n').filter((line) => line.includes("'engine-lockstep-auto'") && /PREFLIGHT_\w+:/.test(line));
  assert.equal(lockstepLines.length, 1, 'una sola variabile PREFLIGHT_* dipende dal branch del mirror');
  assert.match(lockstepLines[0], /^\s*PREFLIGHT_PUSH_BASE_REVISION:/);
  assert.match(yml, /PREFLIGHT_PR_BASE_REVISION:\s*\$\{\{\s*github\.event\.pull_request\.base\.sha\s*\}\}/);
});
