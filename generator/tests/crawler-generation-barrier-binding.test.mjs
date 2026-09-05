/**
 * Rete sul legame token-bound del sotto-documento `barrier` (issue #728).
 *
 * La catena crawler-generation trasporta TRE documenti digestati: il sentinel,
 * il report dell'observer e la barriera. I primi due venivano ri-verificati in
 * lettura; la barriera no — bastava che non fosse `null`. Il suo digest non
 * colma il buco: prova che la barriera e' coerente con SE STESSA, non che
 * appartenga a questa generazione.
 *
 * Le forme qui sotto NON sono inventate: sono quelle che
 * `evaluateCrawlerGenerationBarrier()` produce sul sito
 * (`scripts/lib/crawler-generation-contract.mjs`), da cui il legame
 * `cycleId === generationToken` (il sito la costruisce con
 * `cycleId: sentinel.generationToken`).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { digestDocument } from '../../scripts/ci/lib/canonical-json-digest.mjs';
import {
  createCrawlerGenerationObserverReport,
  validateCrawlerGenerationObserverReport,
} from '../../scripts/ci/lib/crawler-generation-observer-report.mjs';
import { validateSentinelDocument } from '../../scripts/ci/crawler-generation-observer-selector.mjs';

const GROUP_IDS = Array.from({ length: 23 }, (_, index) => String(index + 1).padStart(2, '0'));
const TOKEN = '7-3';
const COMMIT = 'a'.repeat(40);
const SOURCE_COMMIT = 'b'.repeat(40);
const EVALUATED_AT = '2026-09-05T10:00:00.000Z';

function digested(payload) {
  return { ...payload, digest: digestDocument(payload) };
}

function groupReport(state) {
  return {
    state,
    callerRepository: 'nanakokyobashi-rgb/frontaliere-articles',
    callerRunId: '12345',
    status: 'completed',
    conclusion: 'success',
    manifestDigest: digestDocument({ group: 'manifest' }),
    remoteCommit: SOURCE_COMMIT,
    reasons: [],
  };
}

/** La barriera come la scrive il sito, con il digest ricalcolato sul contenuto. */
function makeBarrier({ status = 'ready', cycleId = TOKEN, groupState = null } = {}) {
  const ready = status === 'ready';
  return digested({
    schemaVersion: 1,
    cycleId,
    expectedGroups: GROUP_IDS.length,
    groups: Object.fromEntries(GROUP_IDS.map((group) => [group, groupReport(groupState ?? status)])),
    barrier: {
      status,
      readyAt: ready ? EVALUATED_AT : null,
      sourceCommit: SOURCE_COMMIT,
    },
    translation: { mode: 'shadow', wouldDispatch: ready, dispatched: false },
  });
}

function makeReport({ barrier = makeBarrier(), status = 'ready', reasons = [] } = {}) {
  return createCrawlerGenerationObserverReport({
    evaluatedAt: EVALUATED_AT,
    generationToken: TOKEN,
    siteCodeCommit: COMMIT,
    corpusCodeCommit: COMMIT,
    sentinelDigest: digestDocument({ sentinel: 1 }),
    sentinelSetDigest: digestDocument({ set: 1 }),
    sentinelReplayCount: 1,
    dispatchDiagnostics: Object.fromEntries(
      GROUP_IDS.map((group) => [group, { status: 'direct', runId: '999' }]),
    ),
    evidenceDigest: digestDocument({ evidence: 1 }),
    status,
    reasons,
    barrier,
  });
}

/** Ri-digesta un report dopo averlo mutato: senza, fallirebbe per il digest e non per la barriera. */
function resealed(report) {
  const { digest, ...rest } = report;
  return digested(rest);
}

test('un report `ready` con la barriera della propria generazione resta valido', () => {
  const result = validateCrawlerGenerationObserverReport(makeReport());
  assert.deepEqual(result, { valid: true, errors: [] });
});

test('una barriera legittima di UN ALTRA generazione viene rifiutata', () => {
  // Il caso che il digest non poteva vedere: documento integro, generazione sbagliata.
  const report = makeReport({ barrier: makeBarrier({ cycleId: '9-1' }) });
  const result = validateCrawlerGenerationObserverReport(report);
  assert.equal(result.valid, false);
  assert.ok(result.errors.includes('invalid_barrier'));
});

test('una barriera col digest che non torna viene rifiutata', () => {
  const barrier = { ...makeBarrier(), digest: `sha256:${'0'.repeat(64)}` };
  const result = validateCrawlerGenerationObserverReport(makeReport({ barrier }));
  assert.equal(result.valid, false);
  assert.ok(result.errors.includes('invalid_barrier'));
});

test('una barriera scalare non passa piu\' per il solo fatto di non essere null', () => {
  // Il buco esatto pre-fix: `barrier` non-null + una `translation` scritta a mano
  // bastavano a far dichiarare `ready` una generazione senza alcuna barriera.
  const report = resealed({ ...makeReport(), barrier: 42 });
  const result = validateCrawlerGenerationObserverReport(report);
  assert.equal(result.valid, false);
  assert.ok(result.errors.includes('invalid_barrier'));
});

test('la `translation` di primo livello deve combaciare con quella della barriera', () => {
  // `createCrawlerGenerationObserverReport` la COPIA dalla barriera e non la
  // rilegge piu': un report scritto a mano poteva dichiarare `wouldDispatch`
  // che la barriera non giustifica.
  const report = resealed({
    ...makeReport({ barrier: makeBarrier({ status: 'waiting' }), status: 'waiting', reasons: ['waiting'] }),
    translation: { mode: 'shadow', wouldDispatch: true, dispatched: false },
  });
  const result = validateCrawlerGenerationObserverReport(report);
  assert.equal(result.valid, false);
  assert.ok(result.errors.includes('invalid_barrier'));
});

test('lo stato dell\'observer deve derivare dallo stato della barriera', () => {
  const report = resealed({
    ...makeReport({ status: 'blocked', reasons: ['blocked_timeout'] }),
    barrier: makeBarrier({ status: 'ready' }),
  });
  const result = validateCrawlerGenerationObserverReport(report);
  assert.equal(result.valid, false);
  assert.ok(result.errors.includes('barrier_status_mismatch'));
});

test('lo stato bloccante della barriera deve comparire nelle `reasons`', () => {
  const report = makeReport({
    barrier: makeBarrier({ status: 'blocked_timeout' }),
    status: 'blocked',
    reasons: ['github_api_failed'],
  });
  const result = validateCrawlerGenerationObserverReport(report);
  assert.equal(result.valid, false);
  assert.ok(result.errors.includes('barrier_reason_missing'));
});

test('ogni stato bloccante della barriera e\' un `reason` accettato dal report', () => {
  // AGENTS.md #6: il produttore travasa lo stato in `observer.reasons`, ma i due
  // insiemi vivono in repo diversi e non possono importarsi. Il legame e' qui.
  for (const status of [
    'blocked_dispatch_missing', 'blocked_group_cancelled', 'blocked_group_failed',
    'blocked_group_timed_out', 'blocked_manifest_invalid', 'blocked_manifest_missing',
    'blocked_timeout', 'waiting',
  ]) {
    const report = makeReport({
      barrier: makeBarrier({ status }),
      status: status === 'waiting' ? 'waiting' : 'blocked',
      reasons: [status],
    });
    assert.deepEqual(
      validateCrawlerGenerationObserverReport(report),
      { valid: true, errors: [] },
      `stato ${status} rifiutato`,
    );
  }
});

test('una barriera `ready` senza `sourceCommit` non e\' producibile e viene rifiutata', () => {
  const base = makeBarrier();
  const barrier = digested({
    ...Object.fromEntries(Object.entries(base).filter(([key]) => key !== 'digest')),
    barrier: { status: 'ready', readyAt: EVALUATED_AT, sourceCommit: null },
  });
  const result = validateCrawlerGenerationObserverReport(makeReport({ barrier }));
  assert.equal(result.valid, false);
  assert.ok(result.errors.includes('invalid_barrier'));
});

test('un report senza barriera resta valido: e\' il caso normale dei blocchi a monte', () => {
  const report = makeReport({ barrier: null, status: 'blocked', reasons: ['sentinel_missing'] });
  assert.deepEqual(validateCrawlerGenerationObserverReport(report), { valid: true, errors: [] });
});

/* --- il gemello della stessa classe, nel selettore --- */

function makeSentinel({ generationToken = TOKEN } = {}) {
  return digested({
    schemaVersion: 1,
    generationToken,
    siteCodeCommit: COMMIT,
    corpusCodeCommit: SOURCE_COMMIT,
    callerRepository: 'nanakokyobashi-rgb/frontaliere-articles',
    groups: Object.fromEntries(GROUP_IDS.map((group) => [group, {
      workflowFile: `crawler-group-${group}.yml`,
      workflowName: `Crawler Group ${group} (sparse cross-repo execution)`,
      runId: '4242',
      runName: `crawler-generation-${generationToken}-group-${group}`,
      artifactName: `crawler-group-${group}-terminal-4242`,
      corpusCodeCommit: SOURCE_COMMIT,
    }])),
  });
}

test('un sentinel della propria generazione resta valido', () => {
  assert.equal(validateSentinelDocument(makeSentinel(), TOKEN), true);
});

test('un sentinel integro di UN ALTRA generazione viene rifiutato dal selettore', () => {
  // Stessa classe della barriera: il documento e' valido e il digest torna, ma
  // la run che lo pubblica appartiene a un'altra generazione. Senza il
  // confronto, i suoi commit finivano nell'`expected` del token sbagliato.
  const sentinel = makeSentinel({ generationToken: '9-1' });
  assert.equal(validateSentinelDocument(sentinel, '9-1'), true);
  assert.equal(validateSentinelDocument(sentinel, TOKEN), false);
});
