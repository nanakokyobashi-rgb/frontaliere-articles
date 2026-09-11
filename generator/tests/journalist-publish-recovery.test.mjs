/** Regressions for the journalist rollback before a marker-only checkpoint. */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  JournalistRequeueError,
  requeuePublishedDocuments,
} from '../scripts/lib/journalist-publish-recovery.mjs';

const FieldValue = { delete: () => ({ __delete: true }) };

function documentRecord(id) {
  let status = 'published';
  const docRef = {
    async get() {
      return {
        exists: true,
        get(field) {
          return field === 'status' ? status : undefined;
        },
      };
    },
    apply(update) {
      status = update.status;
    },
    currentStatus() {
      return status;
    },
  };
  return { docRef, id };
}

function fakeDb(commit) {
  return {
    batch() {
      const operations = [];
      return {
        update(docRef, update) {
          operations.push({ docRef, update });
        },
        commit: () => commit(operations),
      };
    },
  };
}

test('conserva i chunk gia riusciti e riconcilia un commit con esito incerto', async () => {
  const documents = Array.from({ length: 501 }, (_, index) => documentRecord(`doc-${index}`));
  let commits = 0;
  const db = fakeDb(async (operations) => {
    commits += 1;
    for (const { docRef, update } of operations) {
      docRef.apply(update);
    }
    if (commits === 2) throw new Error('ack perso dopo il commit');
  });
  const requeuedIds = [];

  const result = await requeuePublishedDocuments({
    db,
    FieldValue,
    publishedDocs: documents,
    requeuedIds,
  });

  assert.equal(commits, 2, 'il chunk con esito incerto viene riconciliato senza doppio retry');
  assert.equal(result, requeuedIds);
  assert.equal(requeuedIds.length, documents.length);
  assert.equal(new Set(requeuedIds).size, documents.length);
  assert.ok(documents.every(({ docRef }) => docRef.currentStatus() === 'queued'));
});

test('un chunk irrisolto rilancia ma conserva gli ID dei chunk rimessi in coda', async () => {
  const documents = Array.from({ length: 501 }, (_, index) => documentRecord(`doc-${index}`));
  let commits = 0;
  const db = fakeDb(async (operations) => {
    commits += 1;
    if (commits === 1) {
      for (const { docRef, update } of operations) docRef.apply(update);
      return;
    }
    throw new Error('servizio Firestore irraggiungibile');
  });
  const requeuedIds = [];

  await assert.rejects(
    requeuePublishedDocuments({
      db,
      FieldValue,
      publishedDocs: documents,
      requeuedIds,
    }),
    (error) => error instanceof JournalistRequeueError
      && error.requeuedIds.length === 500
      && error.unresolvedIds.length === 1
      && error.unresolvedIds[0] === 'doc-500',
  );

  assert.equal(commits, 4, 'il chunk incerto viene ritentato prima di restare bloccante');
  assert.equal(requeuedIds.length, 500, 'gli ID del primo chunk non si perdono nel reject successivo');
  assert.ok(documents.slice(0, 500).every(({ docRef }) => docRef.currentStatus() === 'queued'));
  assert.equal(documents[500].docRef.currentStatus(), 'published');
});
