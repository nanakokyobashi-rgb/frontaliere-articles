#!/usr/bin/env node
/**
 * Unisce il conflitto della coda delle copertine da rigenerare.
 *
 * La coda e' un documento JSON riscritto per intero da due producer diversi.
 * Durante un rebase lo stage 2 e' la copia upstream e lo stage 3 e' il commit
 * rigiocato. Lo stage 1 e' lo snapshot comune all'avvio del drain: se il drain
 * ha rimosso una voce, la copia upstream con lo stesso requestedAt e' stale,
 * anche quando nel frattempo ha cambiato solo failureCount/lastFailureAt, e
 * non va reintrodotta. Un requestedAt successivo identifica invece una nuova
 * richiesta, che resta in coda; le aggiunte senza uno stage 1 restano sempre.
 * Per lo stesso articolo la metadata della richiesta segue il requestedAt piu'
 * recente; a parita' di richiesta vince il fallimento piu' recente. I contatori
 * di fallimento vengono fusi separatamente, cosi' un tentativo stale non puo'
 * cambiare lo stato di una nuova richiesta.
 */
import { execFileSync } from 'node:child_process';
import { realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const IMAGE_REGENERATION_QUEUE = 'data/image-regeneration-queue.json';
export const IMAGE_REGENERATION_QUEUE_SCHEMA = 1;

function missingStageError(stderr) {
  return /path .* (?:is in the index, but not at stage \d+|does not exist in (?:the )?index|exists on disk, but not in the index)/i.test(stderr);
}

export function readStage(stage, file) {
  try {
    return execFileSync('git', ['show', ':' + stage + ':' + file], {
    encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const stderr = String(error.stderr || '').trim();
    if (missingStageError(stderr)) return null;
    throw new Error('git show :' + stage + ':' + file + ' failed: ' + (stderr || error.message));
  }
}

function parseQueue(text, label) {
  if (text == null) return { schema: IMAGE_REGENERATION_QUEUE_SCHEMA, items: [] };
  let queue;
  try {
    queue = JSON.parse(text);
  } catch (error) {
    throw new Error(`${label}: JSON illeggibile (${error.message})`);
  }
  if (!queue || queue.schema !== IMAGE_REGENERATION_QUEUE_SCHEMA || !Array.isArray(queue.items)) {
    throw new Error(`${label}: atteso schema ${IMAGE_REGENERATION_QUEUE_SCHEMA} con items[]`);
  }
  for (const [index, item] of queue.items.entries()) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || !String(item.articleId || '').trim()) {
      throw new Error(`${label}: items[${index}] senza articleId valido`);
    }
  }
  return queue;
}

function timeOf(value) {
  const time = Date.parse(String(value || ''));
  return Number.isFinite(time) ? time : null;
}

function latest(a, b) {
  const left = timeOf(a);
  const right = timeOf(b);
  if (left == null) return b || a;
  if (right == null) return a || b;
  return left >= right ? a : b;
}

function comparable(value) {
  if (Array.isArray(value)) return value.map(comparable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, comparable(value[key])]));
  }
  return value;
}

function sameItem(left, right) {
  return left != null && right != null
    && JSON.stringify(comparable(left)) === JSON.stringify(comparable(right));
}

function requestWinner(existing, candidate) {
  const existingRequestedAt = timeOf(existing.requestedAt);
  const candidateRequestedAt = timeOf(candidate.requestedAt);
  if (existingRequestedAt != null || candidateRequestedAt != null) {
    if (existingRequestedAt == null) return candidate;
    if (candidateRequestedAt == null) return existing;
    if (candidateRequestedAt !== existingRequestedAt) {
      return candidateRequestedAt > existingRequestedAt ? candidate : existing;
    }
  }

  const existingFailureAt = timeOf(existing.lastFailureAt) ?? -Infinity;
  const candidateFailureAt = timeOf(candidate.lastFailureAt) ?? -Infinity;
  // A tie deliberately prefers the replayed commit: it is the article commit
  // currently being kept alive by the retry, matching the registry resolver.
  return candidateFailureAt >= existingFailureAt ? candidate : existing;
}

function mergeItem(existing, candidate) {
  const winner = requestWinner(existing, candidate);
  return {
    ...winner,
    articleId: String(existing.articleId),
    lastFailureAt: latest(existing.lastFailureAt, candidate.lastFailureAt),
    failureCount: Math.max(
      Number.isInteger(existing.failureCount) && existing.failureCount >= 0 ? existing.failureCount : 0,
      Number.isInteger(candidate.failureCount) && candidate.failureCount >= 0 ? candidate.failureCount : 0,
    ),
  };
}

function indexItems(items) {
  const indexed = new Map();
  for (const item of items) {
    const articleId = String(item.articleId);
    const existing = indexed.get(articleId);
    indexed.set(articleId, existing ? mergeItem(existing, item) : { ...item, articleId });
  }
  return indexed;
}

function isNewRequestAfterDrainStart(baseItem, candidate) {
  const baseRequestedAt = timeOf(baseItem.requestedAt);
  const candidateRequestedAt = timeOf(candidate.requestedAt);
  return candidateRequestedAt != null
    && (baseRequestedAt == null || candidateRequestedAt > baseRequestedAt);
}

/** Pure three-way merge used by the conflict resolver and its tests. */
export function mergeImageRegenerationQueues(upstream, replayed, base = { items: [] }) {
  const baseByArticle = indexItems(base.items);
  const upstreamByArticle = indexItems(upstream.items);
  const replayedByArticle = indexItems(replayed.items);
  const byArticle = new Map();
  const articleIds = [...new Set([...upstream.items, ...replayed.items].map((item) => String(item.articleId)))];

  for (const articleId of articleIds) {
    const baseItem = baseByArticle.get(articleId);
    const upstreamItem = upstreamByArticle.get(articleId);
    const replayedItem = replayedByArticle.get(articleId);

    // A side that is absent deleted the item. When the drain side removed it,
    // an upstream copy with the old requestedAt is stale: failure counters and
    // lastFailureAt are progress metadata, not a new request. Only a later
    // requestedAt can revive the article after the drain started.
    if (baseItem && !replayedItem) {
      if (!upstreamItem || !isNewRequestAfterDrainStart(baseItem, upstreamItem)) continue;
      byArticle.set(articleId, { ...upstreamItem, articleId });
      continue;
    }

    // The upstream side can independently delete an item. If the replayed
    // side is unchanged, its copy is stale and the deletion wins.
    if (baseItem && !upstreamItem && replayedItem && sameItem(replayedItem, baseItem)) continue;

    if (upstreamItem && replayedItem) {
      if (baseItem && sameItem(upstreamItem, baseItem) && !sameItem(replayedItem, baseItem)) {
        byArticle.set(articleId, {...replayedItem, articleId});
      } else if (baseItem && sameItem(replayedItem, baseItem) && !sameItem(upstreamItem, baseItem)) {
        byArticle.set(articleId, {...upstreamItem, articleId});
      } else {
        byArticle.set(articleId, mergeItem(upstreamItem, replayedItem));
      }
    } else {
      const item = upstreamItem || replayedItem;
      if (item) byArticle.set(articleId, {...item, articleId});
    }
  }
  return {
    schema: IMAGE_REGENERATION_QUEUE_SCHEMA,
    items: [...byArticle.values()],
  };
}

export function canonicalizeImageRegenerationQueue(queue) {
  return {
    schema: IMAGE_REGENERATION_QUEUE_SCHEMA,
    items: [...indexItems(queue.items).values()],
  };
}

function resolveFile(file) {
  const base = parseQueue(readStage(1, file), 'base comune');
  const upstream = parseQueue(readStage(2, file), 'upstream');
  const replayed = parseQueue(readStage(3, file), 'commit rigiocato');
  const merged = mergeImageRegenerationQueues(upstream, replayed, base);
  writeFileSync(file, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  console.log(`merge coda copertine: ${file} (${merged.items.length} articleId distinti)`);
}

function main(argv) {
  if (argv.length === 0 || argv.some((file) => file !== IMAGE_REGENERATION_QUEUE)) {
    console.error(`uso: merge-image-regeneration-queue.mjs ${IMAGE_REGENERATION_QUEUE}`);
    return 2;
  }
  try {
    for (const file of argv) resolveFile(file);
    return 0;
  } catch (error) {
    console.error(`::warning::conflitto coda copertine non dimostrabile — ${error.message}`);
    return 1;
  }
}

const invokedDirectly = (() => {
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1] || '');
  } catch {
    return false;
  }
})();

if (invokedDirectly) process.exit(main(process.argv.slice(2)));
