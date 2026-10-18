import fs from 'node:fs';
import path from 'node:path';
import { writeTextAtomic } from './atomic-write-text.mjs';
import { writeJsonAtomic } from './atomic-write-json.mjs';

export const IMAGE_REGENERATION_QUEUE_REL = 'data/image-regeneration-queue.json';
export const IMAGE_REGENERATION_QUEUE_LOCK_REL = 'data/image-regeneration-queue-in-progress.json';
export const IMAGE_REGENERATION_QUEUE_PENDING_REL = 'data/image-regeneration-queue-pending.jsonl';
export const IMAGE_REGENERATION_QUEUE_SCHEMA = 1;
export const IMAGE_REGENERATION_TERMINAL_STATUS = 'terminal';
export const IMAGE_REGENERATION_TERMINAL_VISION_REASON = 'vision-safety-rejection';

const HOUR_MS = 3_600_000;

export function imageRegenerationTimestamp(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * A text/logo rejection is adaptable: the drainer adds a stricter no-text
 * hint before trying the governed provider chain again. Other pure vision
 * rejections would replay the same provider/prompt sequence, so a complete
 * structured failure made only of those rejections is terminal.
 */
export function isVisualTextFailure(reason) {
  // Vision notes routinely state a satisfied constraint before naming the
  // real rejection (for example "no visible text or logos; recognizable
  // foreground person"). Remove those negative clauses before looking for an
  // adaptable text/logo violation, otherwise a face rejection loops forever.
  const cue = '(?:text|letter(?:ing)?|sign(?:age)?|watermarks?|signatures?|writing|logos?|emblems?|marks?|words?|numbers?|captions?|labels?|banners?|inscriptions?|posters?|typograph(?:y|ic)?|brands?|trademarks?)';
  const negativeCue = new RegExp(
    `\\b(?:no|without|lacks?)\\s+(?:(?:visible|readable|discernible|legible|recognizable)\\s+)*${cue}(?:\\s*(?:,|and|or)\\s*(?:(?:visible|readable|discernible|legible|recognizable)\\s+)*${cue})*`,
    'gi',
  );
  const normalized = String(reason || '')
    // Structured vision ledgers are authoritative for these fields. Without
    // removing explicit false values, the field names themselves look like a
    // positive text/logo cue and a face-only rejection becomes retryable.
    .replace(/\bcontains[_ ](?:text|logo)\s*[:=]\s*false\b/gi, '')
    .replace(negativeCue, '');
  return /vision gate rejected image/i.test(normalized)
    && /(?:text|letter(?:ing)?|sign(?:age)?|watermark|signature|writing|logo|emblem|mark(?:ing)?s?|word|number|caption|label|banner|inscription|poster|typograph|brand|trademark|contains[_ ]text\s*[:=]\s*true|cartell|segnaletica|scritte?|parol[ae]|numer[io]|beschriftung|schrift|texte?|forbidden content)/i.test(normalized);
}

const VISION_BOOLEAN_FIELDS = Object.freeze([
  'contains_text',
  'contains_logo',
  'contains_recognizable_face',
  'contains_recognizable_foreground_person',
  'looks_like_specific_real_event',
  'is_photograph',
  'is_topic_relevant',
]);

function visionFlagsAreMalformed(failure) {
  if (!Object.hasOwn(failure || {}, 'vision')) return false;
  if (!failure.vision || typeof failure.vision !== 'object' || Array.isArray(failure.vision)) return true;
  return VISION_BOOLEAN_FIELDS.some((field) => (
    Object.hasOwn(failure.vision, field) && typeof failure.vision[field] !== 'boolean'
  ));
}

function isStructuredVisualTextFailure(failure) {
  return failure?.vision?.contains_text === true || failure?.vision?.contains_logo === true;
}

function isClearlyTerminalVisionFailure(failure) {
  if (failure?.vision?.contains_recognizable_face === true
    || failure?.vision?.contains_recognizable_foreground_person === true
    || failure?.vision?.looks_like_specific_real_event === true) return true;
  const normalized = String(failure?.reason || '');
  return /(?:recognizable|identifiable)\s+(?:(?:foreground|human)\s+)*(?:face|person|people|figure|individual)|contains_recognizable_(?:face|foreground_person)\s*[:=]\s*true|(?:specific real event|looks_like_specific_real_event\s*[:=]\s*true)/i.test(normalized);
}

export function classifyImageRegenerationFailure(error) {
  const ledger = error?.imageProviderLedger;
  const expectedProviders = Array.isArray(ledger?.expectedProviders)
    ? ledger.expectedProviders.map((provider) => String(provider || '').trim())
    : [];
  const attemptedProviders = Array.isArray(ledger?.attemptedProviders)
    ? ledger.attemptedProviders.map((provider) => String(provider || '').trim())
    : [];
  const rawFailures = Array.isArray(error?.failures) ? error.failures : [];
  const structuredFailures = rawFailures.map((failure) => ({
    provider: String(failure?.provider || '').trim(),
    reason: String(failure?.reason || '').trim(),
    ...(Object.hasOwn(failure || {}, 'vision') ? { vision: failure.vision } : {}),
  }));
  const expectedProviderSet = new Set(expectedProviders);
  const failureProviderIndexes = structuredFailures
    .map(({ provider }) => expectedProviders.indexOf(provider));
  // Terminality requires the engine's explicit proof that its entire chain was
  // exhausted. Legacy ledgers, malformed entries and deadline-truncated
  // prefixes remain retryable even when their surviving notes look terminal.
  const completeLedger = ledger?.schema === 1
    && ledger?.complete === true
    && expectedProviders.length > 0
    && expectedProviderSet.size === expectedProviders.length
    && expectedProviders.every(Boolean)
    && attemptedProviders.length === expectedProviders.length
    && attemptedProviders.every((provider, index) => provider === expectedProviders[index])
    && structuredFailures.length >= expectedProviders.length
    && structuredFailures.every(({ provider, reason }) => expectedProviderSet.has(provider) && reason.length > 0)
    && expectedProviders.every((provider) => structuredFailures.some((failure) => failure.provider === provider))
    && failureProviderIndexes.every((providerIndex, index) => (
      providerIndex >= 0 && (index === 0 || providerIndex >= failureProviderIndexes[index - 1])
    ));
  const adaptable = structuredFailures.some((failure) => (
    isStructuredVisualTextFailure(failure) || isVisualTextFailure(failure.reason)
  ));
  const terminal = completeLedger
    && structuredFailures.every(({ reason }) => /^vision gate rejected image:/i.test(reason))
    && !structuredFailures.some(visionFlagsAreMalformed)
    && structuredFailures.every(isClearlyTerminalVisionFailure)
    && !adaptable;
  return terminal
    ? { retryable: false, reason: IMAGE_REGENERATION_TERMINAL_VISION_REASON }
    : {
        retryable: true,
        reason: 'transient-or-adaptable',
        ...(adaptable ? { retryHint: 'no-text' } : {}),
      };
}

/**
 * A failed cover is retryable only after the caller's explicit cooldown.
 * Keeping this predicate beside the queue schema prevents the drainer and
 * watchdog from disagreeing about whether a failed item is actionable.
 */
export function failedImageRegenerationRetryIsEligible(item, nowMs, retryAfterHours) {
  if (String(item?.status || '') === IMAGE_REGENERATION_TERMINAL_STATUS) return false;
  if (retryAfterHours === null) return true;
  const retryHours = Number(retryAfterHours);
  const lastFailureAt = Date.parse(String(item?.lastFailureAt || ''));
  return Number.isFinite(nowMs)
    && Number.isFinite(retryHours)
    && retryHours > 0
    && Number.isFinite(lastFailureAt)
    && nowMs - lastFailureAt >= retryHours * HOUR_MS;
}

/**
 * Return the timestamp from which a queue item counts as actionable.
 *
 * A queued item is actionable from its request. A failed item is actionable
 * only after the cooldown that starts at its last failure; using requestedAt
 * after that point makes an old failure look like an old ready retry and lets
 * the watchdog fire immediately when the cooldown ends. Missing failure
 * metadata falls back to requestedAt so diagnostics remain fail-open, while
 * the drainer's stricter retry predicate remains fail-closed.
 */
export function imageRegenerationActionableAt(item, retryAfterHours) {
  const requestedAt = Date.parse(String(item?.requestedAt || ''));
  if (!Number.isFinite(requestedAt)) return null;
  if (String(item?.status || '') === IMAGE_REGENERATION_TERMINAL_STATUS) return null;
  if (String(item?.status || 'unknown') !== 'failed' || retryAfterHours === null) {
    return requestedAt;
  }

  const retryHours = Number(retryAfterHours);
  const lastFailureAt = Date.parse(String(item?.lastFailureAt || ''));
  if (!Number.isFinite(retryHours) || retryHours <= 0 || !Number.isFinite(lastFailureAt)) {
    return requestedAt;
  }
  return Math.max(requestedAt, lastFailureAt + retryHours * HOUR_MS);
}

let lockSequence = 0;
let pendingDrainSequence = 0;
let pendingAppendSequence = 0;

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
  retryDisposition,
  status,
  terminalAt,
  terminalReason,
  retryHint,
  requestedAt = new Date().toISOString(),
} = {}) {
  if (!articleId) return null;
  // Pending records are already normalized queue items, while direct callers
  // provide retryDisposition. Accept both forms so taking the busy-lock path
  // cannot silently revive a terminal rejection as queued work.
  const terminal = retryDisposition === 'terminal'
    || status === IMAGE_REGENERATION_TERMINAL_STATUS;
  return {
    articleId: String(articleId),
    title: String(title || '').trim().slice(0, 240),
    fallbackImage: String(fallbackImage || ''),
    reason: normalizeReason(reason),
    status: terminal ? IMAGE_REGENERATION_TERMINAL_STATUS : 'queued',
    failureCount: 0,
    requestedAt: String(requestedAt),
    lastFailureAt: String(requestedAt),
    ...(terminal ? {
      terminalAt: String(terminalAt || requestedAt),
      terminalReason: String(terminalReason || IMAGE_REGENERATION_TERMINAL_VISION_REASON),
    } : retryHint === 'no-text' ? { retryHint: 'no-text' } : {}),
  };
}

function mergeQueueItem(queue, request) {
  const item = queueItemFromRequest(request);
  if (!item) return false;
  const existing = queue.items.find((entry) => entry?.articleId === item.articleId);
  if (existing) {
    const existingRequestedAt = imageRegenerationTimestamp(existing.requestedAt);
    const incomingRequestedAt = imageRegenerationTimestamp(item.requestedAt);
    const sameRequest = existingRequestedAt !== null
      && incomingRequestedAt !== null
      && existingRequestedAt === incomingRequestedAt;
    // A pending/direct record is allowed to replace an existing item only
    // when it proves a strictly newer request. A stale writer must not revive
    // a terminal verdict or replace a newer retryable request. A terminal
    // result at the exact same timestamp is retained as the safer outcome.
    if (incomingRequestedAt === null
      || (existingRequestedAt !== null && incomingRequestedAt < existingRequestedAt)
      || (sameRequest && (
        item.status !== IMAGE_REGENERATION_TERMINAL_STATUS
        || existing.status === IMAGE_REGENERATION_TERMINAL_STATUS
      ))) {
      return true;
    }
    Object.assign(existing, item, {
      failureCount: Number.isInteger(existing.failureCount) && existing.failureCount >= 0 ? existing.failureCount : 0,
      // A fresh enqueue is a new request. The drainer changes only failure
      // metadata and deliberately leaves requestedAt untouched.
      requestedAt: item.requestedAt,
    });
    if (item.status !== IMAGE_REGENERATION_TERMINAL_STATUS) {
      delete existing.terminalAt;
      delete existing.terminalReason;
    }
    if (item.retryHint !== 'no-text') delete existing.retryHint;
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
  const directoryEntries = fs.readdirSync(directory).sort();
  const pendingFiles = directoryEntries
    .filter((name) => name.startsWith(processingPrefix) && name.endsWith('.pending'))
    .map((name) => path.join(directory, name));
  const processing = directoryEntries
    .filter((name) => name.startsWith(processingPrefix) && name.endsWith('.processing'))
    .map((name) => path.join(directory, name));
  if (fs.existsSync(file)) {
    // Rotate the log before reading it. An append racing this rename creates
    // the next log and can never be removed by this flush.
    const rotated = `${file}.${process.pid}.${Date.now()}.${pendingDrainSequence++}.processing`;
    fs.renameSync(file, rotated);
    processing.push(rotated);
  }
  // New appends are one complete record per file. A producer publishes the
  // `.pending` name only after the JSON and newline have been written, so a
  // drain can never read a partially-written JSONL record. Files published
  // after this directory scan remain for the next lock holder.
  processing.push(...pendingFiles);
  processing.sort();
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
  const pendingFile = `${file}.${process.pid}.${Date.now()}.${pendingAppendSequence++}.pending`;
  writeTextAtomic(pendingFile, `${JSON.stringify(item)}\n`);
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
