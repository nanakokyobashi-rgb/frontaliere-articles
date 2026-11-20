import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FirestoreReadTimeoutError,
  withFirestoreReadTimeout,
} from '../scripts/lib/firestore-read-timeout.mjs';

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
    ['scripts/create-article.mjs', "doc('bfs_stats').get()"],
    ['scripts/create-article.mjs', "doc('astra_vehicle_stats').get()"],
    ['scripts/publish-journalist-article.mjs', "where('status', '==', 'queued').get()"],
    ['scripts/lib/journalist-publish-recovery.mjs', 'doc.docRef.get()'],
  ];

  for (const [relative, readExpression] of targets) {
    const source = readFileSync(join(ROOT, relative), 'utf8');
    assert.match(source, /withFirestoreReadTimeout/u, `${relative} must import the shared helper`);
    assert.match(
      source,
      new RegExp(`withFirestoreReadTimeout\\([\\s\\S]{0,260}${readExpression.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}`, 'u'),
      `${relative} must bound ${readExpression}`,
    );
  }
});
