import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from './atomic-write-json.mjs';

export const IMAGE_REGENERATION_QUEUE_REL = 'data/image-regeneration-queue.json';
export const IMAGE_REGENERATION_QUEUE_LOCK_REL = 'data/image-regeneration-queue-in-progress.json';
export const IMAGE_REGENERATION_QUEUE_SCHEMA = 1;

let lockSequence = 0;

function queuePath(root) {
  return path.join(root, IMAGE_REGENERATION_QUEUE_REL);
}

function queueLockPath(root) {
  return path.join(root, IMAGE_REGENERATION_QUEUE_LOCK_REL);
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

function appendQueue(root, {
  articleId,
  title,
  fallbackImage,
  reason,
  requestedAt = new Date().toISOString(),
} = {}) {
  if (!articleId) return false;
  const queue = readQueue(root);
  const item = {
    articleId: String(articleId),
    title: String(title || '').trim().slice(0, 240),
    fallbackImage: String(fallbackImage || ''),
    reason: normalizeReason(reason),
    status: 'queued',
    failureCount: 0,
    requestedAt: String(requestedAt),
    lastFailureAt: String(requestedAt),
  };
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
  writeQueue(root, queue);
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
      throw new Error(`image regeneration queue lock already exists at ${IMAGE_REGENERATION_QUEUE_LOCK_REL}; inspect the active or interrupted queue writer`);
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
  };
}

/** Run synchronous queue read/modify/write work under the shared writer lock. */
export function withImageRegenerationQueueLock(root, callback) {
  if (typeof callback !== 'function') throw new TypeError('queue lock callback is required');
  acquireQueueLock(root);
  try {
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
    console.warn(`  ⚠️  Coda rigenerazione copertina non aggiornata: ${error.message}`);
    return false;
  }
}
