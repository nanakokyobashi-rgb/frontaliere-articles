/**
 * Recovery for journalist documents stamped `published` before the calling
 * workflow can commit the shared registration files.
 *
 * Firestore batch commits are atomic, but a rejected promise can still have
 * an unknown outcome from the caller's point of view. Reconcile each chunk
 * after a failed commit and retry only documents that are still published.
 * The caller receives the IDs actually observed as queued, even when a later
 * chunk remains unresolved and the recovery must rethrow.
 */

import {
  DEFAULT_FIRESTORE_READ_TIMEOUT_MS,
  withFirestoreReadTimeout,
} from './firestore-read-timeout.mjs';

export const JOURNALIST_REQUEUE_BATCH_LIMIT = 500;
export const JOURNALIST_REQUEUE_MAX_ATTEMPTS = 3;
// A rejected batch can leave up to 500 documents to reconcile. Keep the
// reads parallel, but never turn a Firestore outage into an unbounded fan-out.
export const JOURNALIST_REQUEUE_RECONCILIATION_CONCURRENCY = 32;
export const JOURNALIST_REQUEUE_RECONCILIATION_DEADLINE_MS = 5 * 60_000;

export class JournalistRequeueError extends Error {
  constructor(message, { requeuedIds = [], unresolvedIds = [], cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'JournalistRequeueError';
    this.requeuedIds = requeuedIds;
    this.unresolvedIds = unresolvedIds;
  }
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

function wasRequeued(snapshot) {
  return snapshot?.exists === true
    && typeof snapshot.get === 'function'
    && snapshot.get('status') === 'queued';
}

function reconciliationDeadlineError() {
  const error = new Error('journalist rollback reconciliation deadline exceeded');
  error.code = 'JOURNALIST_REQUEUE_DEADLINE_EXCEEDED';
  return error;
}

/**
 * Reconcile one uncertain batch without serially multiplying the per-read
 * timeout. Every worker claims a fixed slot, and each read receives only the
 * time still available in the call-wide deadline. Documents that never get a
 * slot, or whose read is still uncertain at the deadline, remain unresolved.
 */
async function reconcilePendingDocuments(
  pending,
  { deadlineAt, concurrency, readTimeoutMs, markRequeued },
) {
  const outcomes = new Array(pending.length);
  let nextIndex = 0;
  const worker = async () => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= pending.length) return;

      const remainingMs = deadlineAt - Date.now();
      if (remainingMs <= 0) {
        outcomes[index] = { error: reconciliationDeadlineError() };
        continue;
      }

      const doc = pending[index];
      try {
        const snapshot = await withFirestoreReadTimeout(
          () => doc.docRef.get(),
          {
            timeoutMs: Math.min(readTimeoutMs, Math.max(1, remainingMs)),
            label: `journalist rollback read ${doc.id}`,
          },
        );
        if (wasRequeued(snapshot)) {
          markRequeued([doc]);
          outcomes[index] = { requeued: true };
        } else {
          outcomes[index] = { pending: true };
        }
      } catch (reconcileError) {
        outcomes[index] = { pending: true, error: reconcileError };
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, pending.length) }, worker),
  );

  return {
    stillPublished: pending.filter((_, index) => outcomes[index]?.requeued !== true),
    errors: outcomes.map((outcome) => outcome?.error).filter(Boolean),
    deadlineExceeded: Date.now() >= deadlineAt,
  };
}

/**
 * Put completed journalist documents back in the queue before a fatal
 * producer error is rethrown.
 *
 * @param {{
 *   db: { batch: () => { update: Function, commit: Function } },
 *   FieldValue: { delete: Function },
 *   publishedDocs: Array<{ docRef: { get: Function }, id: string }>,
 *   requeuedIds?: string[],
 *   maxAttempts?: number,
 *   reconciliationConcurrency?: number,
 *   reconciliationDeadlineMs?: number,
 *   reconciliationReadTimeoutMs?: number,
 * }} args
 * @returns {Promise<string[]>} the same accumulator, containing only IDs
 * actually known to be queued
 * @throws {JournalistRequeueError} when a chunk remains unresolved
 */
export async function requeuePublishedDocuments({
  db,
  FieldValue,
  publishedDocs,
  requeuedIds = [],
  maxAttempts = JOURNALIST_REQUEUE_MAX_ATTEMPTS,
  reconciliationConcurrency = JOURNALIST_REQUEUE_RECONCILIATION_CONCURRENCY,
  reconciliationDeadlineMs = JOURNALIST_REQUEUE_RECONCILIATION_DEADLINE_MS,
  reconciliationReadTimeoutMs = DEFAULT_FIRESTORE_READ_TIMEOUT_MS,
}) {
  if (!Array.isArray(publishedDocs) || !Array.isArray(requeuedIds)) {
    throw new TypeError('journalist requeue requires publishedDocs and requeuedIds arrays');
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new TypeError(`journalist requeue maxAttempts must be a positive integer (got ${maxAttempts})`);
  }
  if (!Number.isInteger(reconciliationConcurrency)
    || reconciliationConcurrency < 1
    || reconciliationConcurrency > JOURNALIST_REQUEUE_RECONCILIATION_CONCURRENCY) {
    throw new TypeError(
      `journalist requeue reconciliationConcurrency must be an integer from 1 to `
        + `${JOURNALIST_REQUEUE_RECONCILIATION_CONCURRENCY} (got ${reconciliationConcurrency})`,
    );
  }
  if (!Number.isInteger(reconciliationDeadlineMs) || reconciliationDeadlineMs < 1) {
    throw new TypeError(
      `journalist requeue reconciliationDeadlineMs must be a positive integer (got ${reconciliationDeadlineMs})`,
    );
  }
  if (!Number.isInteger(reconciliationReadTimeoutMs) || reconciliationReadTimeoutMs < 1) {
    throw new TypeError(
      `journalist requeue reconciliationReadTimeoutMs must be a positive integer (got ${reconciliationReadTimeoutMs})`,
    );
  }

  const knownRequeued = new Set(requeuedIds);
  const deadlineAt = Date.now() + reconciliationDeadlineMs;
  const unresolvedIds = () => {
    const seen = new Set();
    return publishedDocs
      .filter(({ id }) => !knownRequeued.has(id) && !seen.has(id))
      .map(({ id }) => {
        seen.add(id);
        return id;
      });
  };
  const throwDeadlineError = (errors = []) => {
    if (Date.now() < deadlineAt) return;
    const unresolved = unresolvedIds();
    if (unresolved.length === 0) return;
    const lastError = errors.at(-1) || reconciliationDeadlineError();
    throw new JournalistRequeueError(
      `journalist rollback deadline exceeded after ${reconciliationDeadlineMs}ms; `
        + `${unresolved.length} document(s) remain unresolved `
        + `(${unresolved.join(', ')}) (${errorText(lastError)})`,
      {
        requeuedIds: [...requeuedIds],
        unresolvedIds: unresolved,
        cause: lastError,
      },
    );
  };
  const markRequeued = (docs) => {
    for (const { id } of docs) {
      if (knownRequeued.has(id)) continue;
      knownRequeued.add(id);
      requeuedIds.push(id);
    }
  };

  for (let offset = 0; offset < publishedDocs.length; offset += JOURNALIST_REQUEUE_BATCH_LIMIT) {
    throwDeadlineError();
    let pending = publishedDocs.slice(offset, offset + JOURNALIST_REQUEUE_BATCH_LIMIT);
    const errors = [];

    for (let attempt = 1; attempt <= maxAttempts && pending.length > 0; attempt += 1) {
      throwDeadlineError(errors);
      const batch = db.batch();
      for (const { docRef } of pending) {
        batch.update(docRef, {
          status: 'queued',
          publishedAt: FieldValue.delete(),
          slugs: FieldValue.delete(),
          publishedUrls: FieldValue.delete(),
          liveVerifiedAt: FieldValue.delete(),
          errorMessage: null,
        });
      }

      try {
        await batch.commit();
        markRequeued(pending);
        pending = [];
      } catch (commitError) {
        errors.push(commitError);
        // A rejected commit has an uncertain outcome to this process. Read
        // every document before retrying so a successful write is recorded
        // and never reported again as an orphan. The reads are bounded in
        // parallel; serially multiplying the 15s read timeout by 500 would
        // outlive the workflow before the first retry.
        const reconciliation = await reconcilePendingDocuments(pending, {
          deadlineAt,
          concurrency: reconciliationConcurrency,
          readTimeoutMs: reconciliationReadTimeoutMs,
          markRequeued,
        });
        errors.push(...reconciliation.errors);
        pending = reconciliation.stillPublished;
        if (reconciliation.deadlineExceeded) throwDeadlineError(errors);
      }
    }

    if (pending.length > 0) {
      const lastError = errors.at(-1);
      throw new JournalistRequeueError(
        `journalist rollback left ${pending.length} document(s) unresolved in batch `
          + `${Math.floor(offset / JOURNALIST_REQUEUE_BATCH_LIMIT) + 1}: `
          + `${pending.map(({ id }) => id).join(', ')} (${lastError ? errorText(lastError) : 'unknown error'})`,
        {
          requeuedIds: [...requeuedIds],
          unresolvedIds: pending.map(({ id }) => id),
          cause: lastError,
        },
      );
    }
  }

  return requeuedIds;
}

/**
 * Requeue IDs emitted by the producer when a later workflow guard rejects the
 * working tree.  The guard has only the document IDs in `GITHUB_OUTPUT`, not
 * the DocumentSnapshot references retained by the producer, so resolve the
 * same collection references here and use the identical idempotent rollback.
 *
 * @param {{
 *   db: { collection: (name: string) => { doc: (id: string) => object } },
 *   FieldValue: { delete: Function },
 *   ids: string[],
 *   requeuedIds?: string[],
 *   maxAttempts?: number,
 * }} args
 * @returns {Promise<string[]>} IDs confirmed queued by the helper
 */
export async function requeuePublishedDocumentIds({
  db,
  FieldValue,
  ids,
  requeuedIds = [],
  maxAttempts = JOURNALIST_REQUEUE_MAX_ATTEMPTS,
}) {
  if (!db || typeof db.collection !== 'function') {
    throw new TypeError('journalist requeue IDs require a Firestore database');
  }
  if (!Array.isArray(ids)) {
    throw new TypeError('journalist requeue IDs require an ids array');
  }
  const uniqueIds = [...new Set(ids.map((id) => String(id).trim()).filter(Boolean))];
  const collection = db.collection('journalist_articles');
  const publishedDocs = uniqueIds.map((id) => ({
    docRef: collection.doc(id),
    id,
  }));
  return requeuePublishedDocuments({
    db,
    FieldValue,
    publishedDocs,
    requeuedIds,
    maxAttempts,
  });
}
