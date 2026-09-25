/**
 * actions-details-url-canonical.test.mjs — il `details_url` di un check-run e'
 * l'identita' workflow-run/job con cui il sweep dell'auto-merge ordina le
 * generazioni (issue #1784).
 *
 * FU-2026-09-22-002 (valerielinc-ops/frontaliere-si-o-no#9508): `new URL`
 * normalizza PRIMA che il path venga letto. `runs/1/%2e%2e/12/job/34` diventa
 * `runs/12/job/34`, un tab o un a-capo dentro il numero spariscono, userinfo e
 * porta passano. Il run id letto poteva quindi essere diverso dal testo che
 * GitHub ha salvato: una variante non correlabile trattata come identita'.
 * Ora solo la forma grezza canonica produce un'identita'; query e fragment
 * reali (`?attempt=1#summary`, `?pr=N`) restano accettati.
 *
 * La stessa tabella gira contro `workflowRunIdentity` (via
 * `exactCheckRunSnapshot`, forma REST senza timestamp) e contro il gemello
 * `parseActionsJobUrl` di native-automerge-gate.mjs: la regola ha due copie,
 * e questo test e' il loro legame (AGENTS.md #6).
 *
 * FU-2026-09-22-003: a parita' di timestamp, un record correlato a un
 * workflow-run e uno senza identita' venivano ordinati per `run_attempt`.
 * L'identita' parziale ora e' un deny, come l'attempt parziale.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exactCheckRunSnapshot } from '../../scripts/ci/native-automerge-sweep-policy.mjs';
import { parseActionsJobUrl } from '../../scripts/ci/native-automerge-gate.mjs';

const REPO = 'nanakokyobashi-rgb/frontaliere-articles';
const HEAD = 'a'.repeat(40);
const BASE = `https://github.com/${REPO}/actions/runs/12/job/34`;

const ACCEPTED = [
  BASE,
  `${BASE}?attempt=1#summary`,
  `${BASE}?pr=1784`,
  `${BASE}#step:3:1`,
];

const REJECTED = [
  // dot-segment, anche codificato: il parser lo risolve su un altro run
  `https://github.com/${REPO}/actions/runs/1/../12/job/34`,
  `https://github.com/${REPO}/actions/runs/1/%2e%2e/12/job/34`,
  // whitespace rimosso dal parser dentro il numero
  `https://github.com/${REPO}/actions/runs/1\n2/job/34`,
  `https://github.com/${REPO}/actions/runs/12\t/job/34`,
  ` ${BASE}`,
  // userinfo, porta, host non canonico
  `https://x@github.com/${REPO}/actions/runs/12/job/34`,
  `https://github.com:443/${REPO}/actions/runs/12/job/34`,
  `https://GITHUB.com/${REPO}/actions/runs/12/job/34`,
  // segmenti percent-encoded
  `https://github.com/${REPO}/actions/runs/%31%32/job/34`,
  `https://github.com/${REPO.replace('articles', '%61rticles')}/actions/runs/12/job/34`,
  `https://github.com/${REPO}/%61ctions/runs/12/job/34`,
  `https://github.com/${REPO}/actions/runs/12%2Fjob%2F99/job/34`,
  // slash vuoti o finali, zero iniziali
  `https://github.com//${REPO}/actions/runs/12/job/34`,
  `${BASE}/`,
  `https://github.com/${REPO}/actions/runs/012/job/34`,
  // altro repository
  `https://github.com/other/repo/actions/runs/12/job/34`,
];

function apiShapeRun(id, detailsUrl) {
  return {
    id,
    name: 'tests (node --test)',
    head_sha: HEAD,
    status: 'completed',
    conclusion: 'success',
    created_at: null,
    completed_at: '2026-09-24T10:00:00Z',
    check_suite: { id },
    external_id: `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`,
    details_url: detailsUrl,
  };
}

function snapshot(...runs) {
  return exactCheckRunSnapshot([{ total_count: runs.length, check_runs: runs }], HEAD, REPO);
}

test('forma canonica, con o senza query/fragment: identità workflow presente in entrambe le copie', () => {
  for (const url of ACCEPTED) {
    assert.equal(snapshot(apiShapeRun(1, url)).allow, true, `sweep: ${url}`);
    assert.deepEqual(parseActionsJobUrl(url, REPO), { runId: 12, jobId: 34 }, `gate: ${url}`);
  }
});

test('ogni variante non canonica resta senza identità: fail-closed in entrambe le copie (FU-002)', () => {
  for (const url of REJECTED) {
    const decision = snapshot(apiShapeRun(1, url));
    assert.equal(decision.allow, false, `sweep ha accettato ${JSON.stringify(url)}`);
    assert.match(decision.reason, /senza generazione\/stato verificabile/);
    assert.equal(parseActionsJobUrl(url, REPO), null, `gate ha accettato ${JSON.stringify(url)}`);
  }
});

function timestampedRun(id, conclusion, { runAttempt, detailsUrl } = {}) {
  const run = {
    id,
    name: 'tests (node --test)',
    head_sha: HEAD,
    status: 'completed',
    conclusion,
    created_at: '2026-09-24T09:00:00Z',
    completed_at: '2026-09-24T09:05:00Z',
  };
  if (runAttempt !== undefined) run.run_attempt = runAttempt;
  if (detailsUrl !== undefined) run.details_url = detailsUrl;
  return run;
}

test('pari timestamp con identità workflow-run parziale: deny, anche se gli attempt differiscono (FU-003)', () => {
  const partial = snapshot(
    timestampedRun(700, 'failure', {
      runAttempt: 1,
      detailsUrl: `https://github.com/${REPO}/actions/runs/500/job/700?attempt=1#summary`,
    }),
    timestampedRun(701, 'success', { runAttempt: 2 }),
  );
  assert.equal(partial.allow, false, 'attempt 2 senza identità non deve vincere su un record correlato');
  assert.match(partial.reason, /identità workflow-run timestamped parziale/);

  // Una variante non canonica non e' un'identita': stesso caso parziale,
  // non un ordinamento per il run id che il parser avrebbe normalizzato.
  const normalizedAway = snapshot(
    timestampedRun(702, 'failure', {
      runAttempt: 1,
      detailsUrl: `https://github.com/${REPO}/actions/runs/500/job/702`,
    }),
    timestampedRun(703, 'success', {
      runAttempt: 2,
      detailsUrl: `https://github.com/${REPO}/actions/runs/1/%2e%2e/501/job/703`,
    }),
  );
  assert.equal(normalizedAway.allow, false);
  assert.match(normalizedAway.reason, /identità workflow-run timestamped parziale/);
});

test('pari timestamp e identità simmetrica: gli ordinamenti esistenti restano', () => {
  const bothMissing = snapshot(
    timestampedRun(710, 'failure', { runAttempt: 1 }),
    timestampedRun(711, 'success', { runAttempt: 2 }),
  );
  assert.equal(bothMissing.allow, true);
  assert.equal(bothMissing.checks[0].state, 'SUCCESS');

  const bothCorrelated = snapshot(
    timestampedRun(712, 'failure', {
      runAttempt: 1,
      detailsUrl: `https://github.com/${REPO}/actions/runs/502/job/712?attempt=1#summary`,
    }),
    timestampedRun(713, 'success', {
      runAttempt: 2,
      detailsUrl: `https://github.com/${REPO}/actions/runs/502/job/713?attempt=2#summary`,
    }),
  );
  assert.equal(bothCorrelated.allow, true);
  assert.equal(bothCorrelated.checks[0].state, 'SUCCESS');
});
