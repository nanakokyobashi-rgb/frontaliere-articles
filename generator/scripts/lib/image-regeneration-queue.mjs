import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from './atomic-write-json.mjs';

export const IMAGE_REGENERATION_QUEUE_REL = 'data/image-regeneration-queue.json';
export const IMAGE_REGENERATION_QUEUE_SCHEMA = 1;

function queuePath(root) {
  return path.join(root, IMAGE_REGENERATION_QUEUE_REL);
}
function emptyQueue() {
  return { schema: IMAGE_REGENERATION_QUEUE_SCHEMA, items: [] };
}

function normalizeReason(value) {
  return String(value || 'engine-failed').replace(/\s+/g, ' ').trim().slice(0, 240) || 'engine-failed';
}

function readQueue(root) {
  const file = queuePath(root);
  if (!fs.existsSync(file)) return emptyQueue();
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (parsed?.schema !== IMAGE_REGENERATION_QUEUE_SCHEMA || !Array.isArray(parsed.items)) {
    throw new Error(`${IMAGE_REGENERATION_QUEUE_REL} must contain schema 1 and an items array`);
  }
  return parsed;
}

export function readImageRegenerationQueue(root) {
  return readQueue(root);
}

export function writeImageRegenerationQueue(root, queue) {
  if (queue?.schema !== IMAGE_REGENERATION_QUEUE_SCHEMA || !Array.isArray(queue.items)) {
    throw new Error(`Invalid image regeneration queue: expected schema ${IMAGE_REGENERATION_QUEUE_SCHEMA} and items[]`);
  }
  writeJsonAtomic(queuePath(root), queue);
}

/**
 * Add one failed-engine cover to the versioned regeneration queue.
 *
 * Queue persistence is deliberately best-effort: a broken queue must never
 * turn a usable catalog fallback into a rejected article.
 */
export function appendImageRegenerationQueue(root, {
  articleId,
  title,
  fallbackImage,
  reason,
  imagePrompt,
  requestedAt = new Date().toISOString(),
} = {}) {
  if (!articleId) return false;
  try {
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
    const normalizedImagePrompt = String(imagePrompt || '').replace(/\s+/g, ' ').trim().slice(0, 500);
    if (normalizedImagePrompt) item.imagePrompt = normalizedImagePrompt;
    const existing = queue.items.find((entry) => entry?.articleId === item.articleId);
    if (existing) {
      Object.assign(existing, item, {
        failureCount: Number.isInteger(existing.failureCount) && existing.failureCount >= 0 ? existing.failureCount : 0,
        requestedAt: existing.requestedAt || item.requestedAt,
      });
    } else {
      queue.items.push(item);
    }
    writeJsonAtomic(queuePath(root), queue);
    return true;
  } catch (error) {
    console.warn(`  ⚠️  Coda rigenerazione copertina non aggiornata: ${error.message}`);
    return false;
  }
}
