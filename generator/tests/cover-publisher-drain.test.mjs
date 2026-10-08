import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ackSuccessfulPublisherSections,
  drainCoverPublishers,
  groupPublisherOutbox,
  publisherStatusIsComplete,
  selectNewRunId,
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
});

test('correla la run nuova con il nonce, ignorando una dispatch concorrente della stessa workflow', () => {
  const selected = selectNewRunId([
    { databaseId: 41, createdAt: '2026-10-08T05:00:02Z', displayTitle: 'cover-publish-section / canton-zh / nonce=other' },
    { databaseId: 42, createdAt: '2026-10-08T05:00:01Z', displayTitle: 'cover-publish-section / canton-ag / nonce=target' },
  ], {
    startedAt: '2026-10-08T05:00:00Z',
    beforeIds: new Set(['40']),
    dispatchNonce: 'target',
  });

  assert.equal(selected?.databaseId, 42);
});
