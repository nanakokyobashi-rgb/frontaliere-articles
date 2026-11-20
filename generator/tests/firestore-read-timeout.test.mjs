import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FirestoreReadTimeoutError,
  withFirestoreReadTimeout,
} from '../scripts/lib/firestore-read-timeout.mjs';
import {
  JournalistRequeueError,
  requeuePublishedDocuments,
} from '../scripts/lib/journalist-publish-recovery.mjs';

const ROOT = join(fileURLToPath(new URL('..', import.meta.url)));

test('withFirestoreReadTimeout returns a completed read and forwards ordinary errors', async () => {
  assert.deepEqual(
    await withFirestoreReadTimeout(async () => ({ exists: true }), 100),
    { exists: true },
  );

  await assert.rejects(
    () => withFirestoreReadTimeout(async () => { throw new Error('Firestore unavailable'); }, 100),
    /Firestore unavailable/u,
  );
});

test('withFirestoreReadTimeout bounds a hung read and observes late rejection', async () => {
  let cleanupCalls = 0;
  const started = Date.now();
  const lateFailure = new Promise((_, reject) => {
    setTimeout(() => reject(new Error('late Firestore RPC failure')), 80);
  });

  await assert.rejects(
    () => withFirestoreReadTimeout(
      () => lateFailure,
      { timeoutMs: 20, label: 'journalist rollback read', onTimeout: () => { cleanupCalls += 1; } },
    ),
    (error) => error instanceof FirestoreReadTimeoutError
      && error.code === 'FIRESTORE_READ_TIMEOUT'
      && error.message === 'journalist rollback read timed out after 20ms',
  );

  assert.equal(cleanupCalls, 1);
  assert.ok(Date.now() - started < 250, 'a hung Firestore read must not hold the caller open');
  await new Promise((resolve) => setTimeout(resolve, 100));
});

test('all producer and recovery Firestore reads use the shared deadline helper', () => {
  const targets = [
    ['scripts/create-article.mjs', "'bfs_stats',\n      'BFS stats Firestore read'"],
    ['scripts/create-article.mjs', "'astra_vehicle_stats',\n      'ASTRA stats Firestore read'"],
    ['scripts/publish-journalist-article.mjs', "where('status', '==', 'queued').get()"],
    ['scripts/lib/journalist-publish-recovery.mjs', 'doc.docRef.get()'],
  ];

  for (const [relative, readExpression] of targets) {
    const source = readFileSync(join(ROOT, relative), 'utf8');
    assert.match(source, /withFirestoreReadTimeout/u, `${relative} must import the shared helper`);
    const readAt = source.indexOf(readExpression);
    assert.notEqual(readAt, -1, `${relative} must retain ${readExpression}`);
    assert.ok(
      source.lastIndexOf('withFirestoreReadTimeout(', readAt) !== -1,
      `${relative} must bound ${readExpression}`,
    );
  }
});

test('journalist reconciliation is concurrent, globally bounded, and reports every unresolved ID', async () => {
  const documents = Array.from({ length: 10 }, (_, index) => ({
    id: `doc-${index}`,
    docRef: {
      get() {
        return new Promise((resolve) => {
          const lateTimer = setTimeout(() => resolve({ exists: true, get: () => 'published' }), 100);
          lateTimer.unref?.();
        });
      },
    },
  }));
  let commits = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  for (const { docRef } of documents) {
    const get = docRef.get;
    docRef.get = () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const result = get();
      result.finally(() => { inFlight -= 1; });
      return result;
    };
  }
  const db = {
    batch() {
      return {
        update() {},
        async commit() {
          commits += 1;
          throw new Error('ack perso');
        },
      };
    },
  };
  const requeuedIds = [];
  const started = Date.now();

  await assert.rejects(
    () => requeuePublishedDocuments({
      db,
      FieldValue: { delete: () => ({}) },
      publishedDocs: documents,
      requeuedIds,
      reconciliationConcurrency: 2,
      reconciliationDeadlineMs: 30,
      reconciliationReadTimeoutMs: 1000,
    }),
    (error) => error instanceof JournalistRequeueError
      && error.unresolvedIds.length === documents.length
      && error.unresolvedIds[0] === 'doc-0'
      && error.unresolvedIds.at(-1) === 'doc-9',
  );

  assert.equal(commits, 1, 'la deadline globale deve chiudere prima del retry');
  assert.equal(maxInFlight, 2, 'la riconciliazione deve rispettare il cap di concorrenza');
  assert.ok(Date.now() - started < 250, 'la riconciliazione non deve moltiplicare il timeout per documento');
});

test('le letture sintetiche usano app nominate usa-e-getta e non il client default', () => {
  const source = readFileSync(join(ROOT, 'scripts/create-article.mjs'), 'utf8');
  const helperStart = source.indexOf('async function readSyntheticStatsDocument');
  const helperEnd = source.indexOf('async function buildStatsBfsPromptContent', helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, 'helper Firestore sintetico mancante');
  const helper = source.slice(helperStart, helperEnd);
  assert.match(helper, /deleteApp\(app\)/u);
  assert.match(helper, /initializeApp\([\s\S]*, `create-article-stats-/u);
  assert.match(helper, /getFirestore\(app\)/u);
  assert.match(helper, /finally/u);
  assert.doesNotMatch(helper, /getApps\(\)/u);
});
