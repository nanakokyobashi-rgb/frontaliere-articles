import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ackSuccessfulPublisherSections,
  drainCoverPublishers,
  groupPublisherOutbox,
  publisherStatusIsComplete,
  selectActivePublisherRun,
  selectNewRunId,
  validatePublisherStatus,
  watchPublisherRun,
} from '../../scripts/ci/cover-publisher-drain.mjs';

function outbox(items) {
  return { schema: 1, items };
}

test('il dispatch usa l outbox preesistente per sezione e avvia tutto prima delle attese', async () => {
  const pending = outbox([
    { articleId: 'ag-1', section: 'canton-ag' },
    { articleId: 'ag-2', section: 'canton-ag' },
    { articleId: 'front-1', section: 'frontaliere' },
  ]);
  const groups = groupPublisherOutbox(pending);
  const events = [];
  const status = await drainCoverPublishers({
    outbox: pending,
    repo: 'nanakokyobashi-rgb/frontaliere-articles',
    deadlineAt: 10_000,
    now: () => 0,
    dispatch: async ({ section, articleIds, workflow }) => {
      events.push(`dispatch:${section}`);
      assert.deepEqual(articleIds, groups.find((group) => group.section === section).articleIds);
      assert.equal(workflow, section === 'frontaliere' ? 'fast-publish-article.yml' : 'fast-publish-section.yml');
      return { runId: `run-${section}` };
    },
    watch: async ({ section }) => {
      events.push(`watch:${section}`);
      return { status: 'success' };
    },
  });

  assert.deepEqual(events.slice(0, 2), ['dispatch:canton-ag', 'dispatch:frontaliere']);
  assert.deepEqual(events.slice(2).sort(), ['watch:canton-ag', 'watch:frontaliere']);
  assert.deepEqual(status.counts, { started: 2, succeeded: 2, failed: 0, inProgress: 0, notStarted: 0 });
});

test('alla scadenza lascia i publisher avviati in corso e non ne attende altri', async () => {
  let nowCalls = 0;
  let watchCalls = 0;
  const status = await drainCoverPublishers({
    outbox: outbox([{ articleId: 'svizzera-1', section: 'svizzera' }]),
    repo: 'nanakokyobashi-rgb/frontaliere-articles',
    deadlineAt: 1,
    now: () => (nowCalls++ === 0 ? 0 : 2),
    dispatch: async () => ({ runId: 'run-svizzera' }),
    watch: async () => {
      watchCalls += 1;
      return { status: 'success' };
    },
  });

  assert.equal(watchCalls, 0);
  assert.equal(status.sections[0].status, 'in-progress');
  assert.deepEqual(status.counts, { started: 1, succeeded: 0, failed: 0, inProgress: 1, notStarted: 0 });
});

test('un publisher fallito non acka la sua sezione e non trattiene quella riuscita', async () => {
  const pending = outbox([
    { articleId: 'ag-1', section: 'canton-ag' },
    { articleId: 'front-1', section: 'frontaliere' },
  ]);
  const status = await drainCoverPublishers({
    outbox: pending,
    repo: 'nanakokyobashi-rgb/frontaliere-articles',
    deadlineAt: 10_000,
    now: () => 0,
    dispatch: async ({ section }) => ({ runId: `run-${section}` }),
    watch: async ({ section }) => section === 'canton-ag'
      ? { status: 'failed', error: 'R2 publish failed' }
      : { status: 'success' },
  });

  assert.deepEqual(status.counts, { started: 2, succeeded: 1, failed: 1, inProgress: 0, notStarted: 0 });
  const acknowledged = ackSuccessfulPublisherSections(pending, status);
  assert.deepEqual(acknowledged.acknowledgedSections, ['frontaliere']);
  assert.deepEqual(acknowledged.outbox.items, [{ articleId: 'ag-1', section: 'canton-ag' }]);
});

test('un ack parziale conserva tutte le voci delle sezioni fallite o ancora in corso', () => {
  const pending = outbox([
    { articleId: 'ag-1', section: 'canton-ag' },
    { articleId: 'ag-2', section: 'canton-ag' },
    { articleId: 'front-1', section: 'frontaliere' },
    { articleId: 'zh-1', section: 'canton-zh' },
  ]);
  const acknowledged = ackSuccessfulPublisherSections(pending, {
    sections: [
      { section: 'canton-ag', status: 'success' },
      { section: 'frontaliere', status: 'failed' },
      { section: 'canton-zh', status: 'in-progress' },
    ],
  });

  assert.deepEqual(acknowledged.acknowledgedSections, ['canton-ag']);
  assert.deepEqual(acknowledged.outbox.items, [
    { articleId: 'front-1', section: 'frontaliere' },
    { articleId: 'zh-1', section: 'canton-zh' },
  ]);
});

test('un esito parziale resta non riuscito per il codice del drain, anche con ack parziale', () => {
  assert.equal(publisherStatusIsComplete({ sections: [{ section: 'canton-ag', status: 'success' }] }), true);
  assert.equal(publisherStatusIsComplete({ sections: [{ section: 'canton-ag', status: 'in-progress' }] }), false);
  assert.equal(publisherStatusIsComplete({ sections: [{ section: 'canton-ag', status: 'failed' }] }), false);
  assert.equal(publisherStatusIsComplete({ sections: [] }), false);
});

test('il contratto dello status rifiuta sezioni vuote, inattese, duplicate o con stato sconosciuto', () => {
  const pending = outbox([
    { articleId: 'ag-1', section: 'canton-ag' },
    { articleId: 'front-1', section: 'frontaliere' },
  ]);
  const valid = {
    sections: [
      { section: 'canton-ag', status: 'in-progress' },
      { section: 'frontaliere', status: 'not-started' },
    ],
  };

  assert.equal(validatePublisherStatus(pending, valid), valid);
  for (const status of [
    { sections: [] },
    { sections: [{ section: 'canton-ag', status: 'success' }] },
    { sections: [{ section: 'canton-ag', status: 'success' }, { section: 'other', status: 'success' }] },
    { sections: [{ section: 'canton-ag', status: 'success' }, { section: 'canton-ag', status: 'success' }] },
    { sections: [{ section: 'canton-ag', status: 'unknown' }, { section: 'frontaliere', status: 'success' }] },
    { sections: [{ section: 'canton-ag' }, { section: 'frontaliere', status: 'success' }] },
  ]) {
    assert.throws(() => validatePublisherStatus(pending, status));
  }
});

test('il watcher ritenta una lettura transitoria prima di classificare la run', async () => {
  let nowMs = 0;
  let observations = 0;
  const sleeps = [];
  const result = await watchPublisherRun({
    repo: 'nanakokyobashi-rgb/frontaliere-articles',
    runId: '123',
    deadlineAt: 10_000,
    now: () => nowMs,
    readRun: async () => {
      observations += 1;
      if (observations === 1) throw new Error('jobs are not visible yet');
      if (observations === 2) return { status: 'queued', conclusion: null };
      return { status: 'completed', conclusion: 'success' };
    },
    sleepFor: async (ms) => {
      sleeps.push(ms);
      nowMs += ms;
    },
    intervalMs: 2_000,
  });

  assert.deepEqual(result, { status: 'success' });
  assert.equal(observations, 3);
  assert.deepEqual(sleeps, [2_000, 2_000]);
});

test('il watcher lascia una finestra di scrittura prima della deadline', async () => {
  let observations = 0;
  const result = await watchPublisherRun({
    repo: 'nanakokyobashi-rgb/frontaliere-articles',
    runId: '123',
    deadlineAt: 4_000,
    now: () => 0,
    readRun: async () => {
      observations += 1;
      return { status: 'completed', conclusion: 'success' };
    },
    sleepFor: async () => assert.fail('non deve avviare una lettura senza margine'),
  });

  assert.equal(observations, 0);
  assert.deepEqual(result, {
    status: 'in-progress',
    error: 'deadline reached while watching run 123',
  });
});

test('il watcher segnala solo una conclusione terminale negativa come fallimento', async () => {
  const result = await watchPublisherRun({
    repo: 'nanakokyobashi-rgb/frontaliere-articles',
    runId: '123',
    deadlineAt: 10_000,
    now: () => 0,
    readRun: async () => ({ status: 'completed', conclusion: 'failure' }),
    sleepFor: async () => assert.fail('non deve attendere una run già conclusa'),
  });

  assert.deepEqual(result, {
    status: 'failed',
    error: 'publisher run 123 concluded failure',
  });
});

test('correla la run nuova con il nonce, ignorando una dispatch concorrente della stessa workflow', () => {
  const selected = selectNewRunId([
    { databaseId: 41, createdAt: '2026-10-08T05:00:02Z', displayTitle: 'cover-publish-section / canton-zh / nonce=other' },
    { databaseId: 42, createdAt: '2026-10-08T05:00:01Z', displayTitle: 'cover-publish-section / canton-ag / nonce=target' },
  ], {
    beforeIds: new Set(['40']),
    dispatchNonce: 'target',
  });

  assert.equal(selected?.databaseId, 42);
});

test('riusa la run cover attiva e non seleziona publisher manuali o conclusi', () => {
  const selected = selectActivePublisherRun([
    {
      databaseId: 40,
      createdAt: '2026-10-08T05:00:01Z',
      displayTitle: 'cover-publish-article / frontaliere / nonce=cover-frontaliere-old',
      status: 'queued',
    },
    {
      databaseId: 41,
      createdAt: '2026-10-08T05:00:03Z',
      displayTitle: 'cover-publish-article / frontaliere / nonce=manual-replay',
      status: 'in_progress',
    },
    {
      databaseId: 42,
      createdAt: '2026-10-08T05:00:02Z',
      displayTitle: 'cover-publish-article / frontaliere / nonce=cover-frontaliere-current',
      status: 'in_progress',
    },
    {
      databaseId: 43,
      createdAt: '2026-10-08T05:00:04Z',
      displayTitle: 'cover-publish-article / frontaliere / nonce=cover-frontaliere-done',
      status: 'completed',
    },
  ], { workflow: 'fast-publish-article.yml', section: 'frontaliere' });

  assert.equal(selected?.databaseId, 42);
  assert.equal(
    selectActivePublisherRun([
      {
        databaseId: 44,
        createdAt: '2026-10-08T05:00:05Z',
        displayTitle: 'cover-publish-section / canton-ag / nonce=cover-canton-ag-current',
        status: 'in_progress',
      },
    ], { workflow: 'fast-publish-article.yml', section: 'frontaliere' }),
    null,
  );
});
