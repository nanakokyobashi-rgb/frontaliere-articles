#!/usr/bin/env node
/**
 * Unisce il conflitto della coda delle copertine da rigenerare.
 *
 * La coda e' un documento JSON riscritto per intero da due producer diversi.
 * Durante un rebase lo stage 2 e' la copia upstream e lo stage 3 e' il commit
 * rigiocato: si conservano tutti gli item e si deduplicano per articleId.
 * Per lo stesso articolo vince il fallimento piu' recente; requestedAt resta
 * il primo avvistamento, cosi' la coda non dimentica da quanto aspetta.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

export const IMAGE_REGENERATION_QUEUE = 'data/image-regeneration-queue.json';
export const IMAGE_REGENERATION_QUEUE_SCHEMA = 1;

function readStage(stage, file) {
  let indexPath;
  try {
    indexPath = execFileSync('git', ['rev-parse', '--git-path', 'index'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch (error) {
    throw new Error(`impossibile individuare l'indice Git: ${error.message}`);
  }
  if (!indexPath || !existsSync(resolvePath(indexPath))) {
    throw new Error(`impossibile leggere l'indice Git: file assente (${indexPath || '<sconosciuto>'})`);
  }

  let indexText;
  try {
    indexText = execFileSync('git', ['ls-files', '--stage', '--', file], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (error) {
    throw new Error(`impossibile leggere l'indice Git per lo stage ${stage}: ${error.message}`);
  }

  const stageEntry = indexText
    .split('\n')
    .map((line) => line.match(/^\d+\s+([0-9a-f]+)\s+(\d)\t(.+)$/))
    .find((match) => match && match[2] === String(stage) && match[3] === file);
  if (!stageEntry) {
    // The path is genuinely absent from this stage (for example, an add/delete
    // conflict). That is different from a failed object/index read.
    return null;
  }

  try {
    return execFileSync('git', ['show', `:${stage}:${file}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (error) {
    throw new Error(`impossibile leggere ${file} dallo stage ${stage}: ${error.message}`);
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

function earliest(a, b) {
  const left = timeOf(a);
  const right = timeOf(b);
  if (left == null) return b || a;
  if (right == null) return a || b;
  return left <= right ? a : b;
}

function latest(a, b) {
  const left = timeOf(a);
  const right = timeOf(b);
  if (left == null) return b || a;
  if (right == null) return a || b;
  return left >= right ? a : b;
}

function mergeItem(existing, candidate) {
  const existingTime = timeOf(existing.lastFailureAt) ?? timeOf(existing.requestedAt) ?? -Infinity;
  const candidateTime = timeOf(candidate.lastFailureAt) ?? timeOf(candidate.requestedAt) ?? -Infinity;
  // A tie deliberately prefers the replayed commit: it is the article commit
  // currently being kept alive by the retry, matching the registry resolver.
  const winner = candidateTime >= existingTime ? candidate : existing;
  return {
    ...winner,
    articleId: String(existing.articleId),
    requestedAt: earliest(existing.requestedAt, candidate.requestedAt),
    lastFailureAt: latest(existing.lastFailureAt, candidate.lastFailureAt),
  };
}

/** Pure merge used by the conflict resolver and its tests. */
export function mergeImageRegenerationQueues(upstream, replayed) {
  const byArticle = new Map();
  for (const item of [...upstream.items, ...replayed.items]) {
    const articleId = String(item.articleId);
    const previous = byArticle.get(articleId);
    byArticle.set(articleId, previous ? mergeItem(previous, item) : { ...item, articleId });
  }
  return {
    schema: IMAGE_REGENERATION_QUEUE_SCHEMA,
    items: [...byArticle.values()],
  };
}

function resolveFile(file) {
  const upstream = parseQueue(readStage(2, file), 'upstream');
  const replayed = parseQueue(readStage(3, file), 'commit rigiocato');
  const merged = mergeImageRegenerationQueues(upstream, replayed);
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
