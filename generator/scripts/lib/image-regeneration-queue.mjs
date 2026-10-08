import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from './atomic-write-json.mjs';

export const IMAGE_REGENERATION_QUEUE_REL = 'data/image-regeneration-queue.json';
export const IMAGE_REGENERATION_QUEUE_LOCK_REL = 'data/image-regeneration-queue-in-progress.json';
export const IMAGE_REGENERATION_QUEUE_PENDING_REL = 'data/image-regeneration-queue-pending.jsonl';
export const IMAGE_REGENERATION_QUEUE_SCHEMA = 1;

let lockSequence = 0;
let pendingDrainSequence = 0;

function queuePath(root) {
  return path.join(root, IMAGE_REGENERATION_QUEUE_REL);
}

function queueLockPath(root) {
  return path.join(root, IMAGE_REGENERATION_QUEUE_LOCK_REL);
}

function pendingQueuePath(root) {
  return path.join(root, IMAGE_REGENERATION_QUEUE_PENDING_REL);
}

function emptyQueue() {
  return { schema: IMAGE_REGENERATION_QUEUE_SCHEMA, items: [] };
}

function normalizeReason(value) {
  return String(value || 'engine-failed').replace(/\s+/g, ' ').trim().slice(0, 240) || 'engine-failed';
}

function assertQueue(queue) {
  if (queue?.schema !== IMAGE_REGENERATION_QUEUE_SCHEMA || !Array.isArray(queue.items)) {
    throw new Error(`Invalid image regeneration queue: expected schema ${IMAGE_REGENERATION_QUEUE_SCHEMA} and items[]`);
  }
}

function readQueue(root) {
  const file = queuePath(root);
  if (!fs.existsSync(file)) return emptyQueue();
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  assertQueue(parsed);
  return parsed;
}

function writeQueue(root, queue) {
  assertQueue(queue);
  writeJsonAtomic(queuePath(root), queue);
}

function queueItemFromRequest({
  articleId,
  title,
  fallbackImage,
  reason,
  requestedAt = new Date().toISOString(),
} = {}) {
  if (!articleId) return null;
  return {
    articleId: String(articleId),
    title: String(title || '').trim().slice(0, 240),
    fallbackImage: String(fallbackImage || ''),
    reason: normalizeReason(reason),
    status: 'queued',
    failureCount: 0,
    requestedAt: String(requestedAt),
    lastFailureAt: String(requestedAt),
  };
}

function mergeQueueItem(queue, request) {
  const item = queueItemFromRequest(request);
  if (!item) return false;
  const existing = queue.items.find((entry) => entry?.articleId === item.articleId);
  if (existing) {
    Object.assign(existing, item, {
      failureCount: Number.isInteger(existing.failureCount) && existing.failureCount >= 0 ? existing.failureCount : 0,
      // A fresh enqueue is a new request. The drainer changes only failure
      // metadata and deliberately leaves requestedAt untouched.
      requestedAt: item.requestedAt,
    });
  } else {
    queue.items.push(item);
  }
  return true;
}

function appendQueue(root, request) {
  const queue = readQueue(root);
  if (!mergeQueueItem(queue, request)) return false;
  writeQueue(root, queue);
  return true;
}

function flushPendingQueue(root) {
  const file = pendingQueuePath(root);
  const directory = path.dirname(file);
  if (!fs.existsSync(directory)) return 0;

  const processingPrefix = `${path.basename(file)}.`;
  const processing = fs.readdirSync(directory)
    .filter((name) => name.startsWith(processingPrefix) && name.endsWith('.processing'))
    .map((name) => path.join(directory, name));
  if (fs.existsSync(file)) {
    // Rotate the log before reading it. An append racing this rename creates
    // the next log and can never be removed by this flush.
    const rotated = `${file}.${process.pid}.${Date.now()}.${pendingDrainSequence++}.processing`;
    fs.renameSync(file, rotated);
    processing.push(rotated);
  }
  if (processing.length === 0) return 0;

  const pending = [];
  for (const processingFile of processing) {
    const requests = fs.readFileSync(processingFile, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    pending.push(...requests);
  }
  if (pending.length === 0) {
    for (const processingFile of processing) fs.rmSync(processingFile, { force: true });
    return 0;
  }

  const queue = readQueue(root);
  for (const request of pending) {
    if (!mergeQueueItem(queue, request)) {
      throw new Error(`Invalid pending image regeneration request in ${IMAGE_REGENERATION_QUEUE_PENDING_REL}`);
    }
  }
  writeQueue(root, queue);
  for (const processingFile of processing) fs.rmSync(processingFile);
  return pending.length;
}

function appendPendingQueue(root, request) {
  const item = queueItemFromRequest(request);
  if (!item) return false;
  const file = pendingQueuePath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(item)}\n`, 'utf8');
  return true;
}

function acquireQueueLock(root) {
  const file = queueLockPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let fd;
  let claimed = false;
  try {
    fd = fs.openSync(file, 'wx', 0o600);
    claimed = true;
    fs.writeFileSync(fd, `${JSON.stringify({
      schema: 1,
      kind: 'image-regeneration-queue',
      startedAt: new Date().toISOString(),
      pid: process.pid,
      sequence: lockSequence++,
    })}\n`, 'utf8');
    fs.fsyncSync(fd);
  } catch (error) {
    if (claimed) fs.rmSync(file, { force: true });
    if (error?.code === 'EEXIST') {
      const busy = new Error(`image regeneration queue lock already exists at ${IMAGE_REGENERATION_QUEUE_LOCK_REL}; inspect the active or interrupted queue writer`);
      busy.code = 'EIMAGE_REGENERATION_QUEUE_LOCK_BUSY';
      throw busy;
    }
    throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function releaseQueueLock(root) {
  try {
    fs.unlinkSync(queueLockPath(root));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

function queueOperations(root) {
  return {
    read: () => readQueue(root),
    write: (queue) => writeQueue(root, queue),
    append: (request) => appendQueue(root, request),
    flushPending: () => flushPendingQueue(root),
  };
}

/** Run synchronous queue read/modify/write work under the shared writer lock. */
export function withImageRegenerationQueueLock(root, callback) {
  if (typeof callback !== 'function') throw new TypeError('queue lock callback is required');
  acquireQueueLock(root);
  try {
    flushPendingQueue(root);
    return callback(queueOperations(root));
  } finally {
    releaseQueueLock(root);
  }
}

/** Hold the same shared writer lock across asynchronous cover draining. */
export async function withImageRegenerationQueueLockAsync(root, callback) {
  if (typeof callback !== 'function') throw new TypeError('queue lock callback is required');
  acquireQueueLock(root);
  try {
    flushPendingQueue(root);
    return await callback(queueOperations(root));
  } finally {
    releaseQueueLock(root);
  }
}

export function readImageRegenerationQueue(root) {
  return readQueue(root);
}

export function writeImageRegenerationQueue(root, queue) {
  return withImageRegenerationQueueLock(root, ({ write }) => write(queue));
}

/**
 * Add one failed-engine cover to the versioned regeneration queue.
 *
 * Queue persistence is deliberately best-effort: a broken or busy queue must
 * never turn a usable catalog fallback into a rejected article.
 */
export function appendImageRegenerationQueue(root, request) {
  if (!request?.articleId) return false;
  try {
    return withImageRegenerationQueueLock(root, ({ append }) => append(request));
  } catch (error) {
    if (error?.code === 'EIMAGE_REGENERATION_QUEUE_LOCK_BUSY') {
      try {
        // The article is already published by this point. Keep the request in
        // an append-only side log while the async drainer owns the queue lock;
        // the next lock holder folds it into the canonical queue before work.
        return appendPendingQueue(root, request);
      } catch (pendingError) {
        console.warn(`  ⚠️  Coda rigenerazione copertina non aggiornata: ${pendingError.message}`);
        return false;
      }
    }
    console.warn(`  ⚠️  Coda rigenerazione copertina non aggiornata: ${error.message}`);
    return false;
  }
}
