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

export const JOURNALIST_REQUEUE_BATCH_LIMIT = 500;
export const JOURNALIST_REQUEUE_MAX_ATTEMPTS = 3;

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
}) {
  if (!Array.isArray(publishedDocs) || !Array.isArray(requeuedIds)) {
    throw new TypeError('journalist requeue requires publishedDocs and requeuedIds arrays');
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new TypeError(`journalist requeue maxAttempts must be a positive integer (got ${maxAttempts})`);
  }

  const knownRequeued = new Set(requeuedIds);
  const markRequeued = (docs) => {
    for (const { id } of docs) {
      if (knownRequeued.has(id)) continue;
      knownRequeued.add(id);
      requeuedIds.push(id);
    }
  };

  for (let offset = 0; offset < publishedDocs.length; offset += JOURNALIST_REQUEUE_BATCH_LIMIT) {
    let pending = publishedDocs.slice(offset, offset + JOURNALIST_REQUEUE_BATCH_LIMIT);
    const errors = [];

    for (let attempt = 1; attempt <= maxAttempts && pending.length > 0; attempt += 1) {
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
        // and never reported again as an orphan.
        const stillPublished = [];
        for (const doc of pending) {
          try {
            const snapshot = await doc.docRef.get();
            if (wasRequeued(snapshot)) markRequeued([doc]);
            else stillPublished.push(doc);
          } catch (reconcileError) {
            errors.push(reconcileError);
            stillPublished.push(doc);
          }
        }
        pending = stillPublished;
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
