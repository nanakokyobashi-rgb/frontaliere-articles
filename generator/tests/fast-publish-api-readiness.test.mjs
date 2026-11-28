import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  fastPublishReadiness,
  probeFastPublishApiReadiness,
  waitForFastPublishApiReadiness,
} from '../../scripts/ci/wait-fast-publish-api-readiness.mjs';

const COMMIT = 'a'.repeat(40);
const SECTION = 'canton-ti';

function report({
  apiCommit = COMMIT,
  edgeCommit = COMMIT,
  pendingEdgeFlip = false,
  status = 'live',
  section = SECTION,
  missingPages = [],
  missingIds = [],
  leftover = [],
  unknown = [],
  pageManifest = 'ok',
  dispatch = false,
} = {}) {
  return {
    skipped: null,
    apiCommit,
    edgeCommit,
    pendingEdgeFlip,
    sectionStatuses: { [SECTION]: status },
    sections: status === 'live' ? [{
      section,
      expectedMissingPagePaths: missingPages,
      missingIds,
      leftover,
      unknown,
      pageManifest,
      dispatch,
    }] : [],
  };
}

test('fast-publish readiness richiede manifest, flip e copertura della sitemap della sezione', () => {
  assert.deepEqual(
    fastPublishReadiness(report(), { section: SECTION, expectedCommit: COMMIT }),
    { ready: true, reason: `release API e pagine ${SECTION} verificate` },
  );
  assert.equal(fastPublishReadiness(report({ apiCommit: 'b'.repeat(40) }), {
    section: SECTION,
    expectedCommit: COMMIT,
  }).ready, false);
  assert.equal(fastPublishReadiness(report({ edgeCommit: 'b'.repeat(40) }), {
    section: SECTION,
    expectedCommit: COMMIT,
  }).ready, false);
  assert.equal(fastPublishReadiness(report({ pendingEdgeFlip: true }), {
    section: SECTION,
    expectedCommit: COMMIT,
  }).ready, false);
  assert.equal(fastPublishReadiness(report({ missingPages: ['/articoli-ticino/esempio/'] }), {
    section: SECTION,
    expectedCommit: COMMIT,
  }).ready, false);
  assert.equal(fastPublishReadiness(report({ pageManifest: 'unknown' }), {
    section: SECTION,
    expectedCommit: COMMIT,
  }).ready, false);
  assert.equal(fastPublishReadiness(report({ unknown: ['/articoli-ticino/esempio/'] }), {
    section: SECTION,
    expectedCommit: COMMIT,
  }).ready, false);
});

test('fast-publish readiness accetta una sezione draft dopo la verifica della release API', () => {
  assert.deepEqual(
    fastPublishReadiness(report({ status: 'draft' }), { section: SECTION, expectedCommit: COMMIT }),
    { ready: true, reason: 'sezione draft sulla release verificata' },
  );
  assert.equal(fastPublishReadiness(report({ status: 'draft', edgeCommit: 'b'.repeat(40) }), {
    section: SECTION,
    expectedCommit: COMMIT,
  }).ready, false);
});

test('fast-publish readiness accetta cleanup-only retired verificando comunque API ed edge commit', () => {
  assert.deepEqual(
    fastPublishReadiness(report({ status: 'retired' }), { section: SECTION, expectedCommit: COMMIT }),
    {
      ready: true,
      reason: `release API verificata; la superficie ritirata ${SECTION} non richiede copertura pagine`,
    },
  );
  assert.equal(fastPublishReadiness(report({ status: 'retired', apiCommit: 'b'.repeat(40) }), {
    section: SECTION,
    expectedCommit: COMMIT,
  }).ready, false, 'il commit API resta un gate anche per cleanup-only');
  assert.equal(fastPublishReadiness(report({ status: 'retired', edgeCommit: 'b'.repeat(40) }), {
    section: SECTION,
    expectedCommit: COMMIT,
  }).ready, false, 'il commit edge resta un gate anche per cleanup-only');
});

test('fast-publish readiness verifica tutte le sezioni target del barrier nello stesso report HTTP', () => {
  const other = 'canton-gr';
  const multi = {
    ...report(),
    sectionStatuses: { [SECTION]: 'live', [other]: 'live' },
    sections: [SECTION, other].map((section) => ({
      section,
      expectedMissingPagePaths: [],
      missingIds: [],
      leftover: [],
      unknown: [],
      pageManifest: 'ok',
      dispatch: false,
    })),
  };
  assert.equal(fastPublishReadiness(multi, {
    sections: [SECTION, other],
    expectedCommit: COMMIT,
  }).ready, true);
  multi.sections[1].missingIds = ['article-not-staged'];
  assert.equal(fastPublishReadiness(multi, {
    sections: [SECTION, other],
    expectedCommit: COMMIT,
  }).ready, false);

  const liveAndRetired = {
    ...report(),
    sectionStatuses: { [SECTION]: 'live', [other]: 'retired' },
    sections: [report().sections[0]],
  };
  assert.equal(fastPublishReadiness(liveAndRetired, {
    sections: [SECTION, other],
    expectedCommit: COMMIT,
  }).ready, true, 'la coverage live viene verificata e il cleanup retired non attende pagine');
});

test('probe readiness singolo distingue API pronta da release mancante senza dispatch preventivo', async () => {
  assert.deepEqual(await probeFastPublishApiReadiness({
    sections: [SECTION],
    expectedCommit: COMMIT,
    reconcileImpl: async () => report(),
  }), { ready: true, reason: `release API e pagine ${SECTION} verificate` });
  assert.deepEqual(await probeFastPublishApiReadiness({
    sections: [SECTION],
    expectedCommit: COMMIT,
    isDescendant: () => false,
    reconcileImpl: async () => report({ apiCommit: 'b'.repeat(40) }),
  }), { ready: false, reason: `manifest API non ancora sul commit ${COMMIT} o su un suo discendente (osservato ${'b'.repeat(40)})` });
  await assert.rejects(() => probeFastPublishApiReadiness({
    sections: [SECTION],
    expectedCommit: COMMIT,
    reconcileImpl: async () => { throw new Error('HTTP indisponibile'); },
  }), /HTTP indisponibile/u);
});

test('wait HTTP ritenta finche manifest e copertura target diventano coerenti', async () => {
  let now = 0;
  let attempts = 0;
  const result = await waitForFastPublishApiReadiness({
    section: SECTION,
    expectedCommit: COMMIT,
    waitMs: 1_000,
    attemptBudgetMs: 250,
    retryDelayMs: 100,
    now: () => now,
    sleepImpl: async (delay) => { now += delay; },
    log: () => {},
    reconcileImpl: async () => {
      attempts += 1;
      return attempts === 1 ? report({ apiCommit: 'b'.repeat(40) }) : report();
    },
  });
  assert.equal(result.ready, true);
  assert.equal(result.attempts, 2);
  assert.equal(attempts, 2);
});

test('wait HTTP scade entro il budget e resta fail-closed', async () => {
  let now = 0;
  await assert.rejects(() => waitForFastPublishApiReadiness({
    section: SECTION,
    expectedCommit: COMMIT,
    waitMs: 500,
    attemptBudgetMs: 100,
    retryDelayMs: 200,
    now: () => now,
    sleepImpl: async (delay) => { now += delay; },
    log: () => {},
    isDescendant: () => false,
    reconcileImpl: async () => report({ edgeCommit: 'b'.repeat(40) }),
  }), /esito=readiness-timeout: readiness API Fast Publish non verificata entro 500ms/u);
  assert.equal(now, 500);
});
