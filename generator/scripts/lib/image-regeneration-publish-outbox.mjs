import fs from 'node:fs';
import path from 'node:path';

import { writeJsonAtomic } from './atomic-write-json.mjs';

export const IMAGE_REGENERATION_PUBLISH_OUTBOX_REL = 'data/image-regeneration-publish-outbox.json';
export const IMAGE_REGENERATION_PUBLISH_OUTBOX_SCHEMA = 1;

function outboxPath(root) {
  return path.join(root, IMAGE_REGENERATION_PUBLISH_OUTBOX_REL);
}

function emptyOutbox() {
  return { schema: IMAGE_REGENERATION_PUBLISH_OUTBOX_SCHEMA, items: [] };
}

function parseOutbox(value) {
  if (!value || value.schema !== IMAGE_REGENERATION_PUBLISH_OUTBOX_SCHEMA || !Array.isArray(value.items)) {
    throw new Error(`${IMAGE_REGENERATION_PUBLISH_OUTBOX_REL} must contain schema 1 and an items array`);
  }
  for (const [index, item] of value.items.entries()) {
    if (!item || typeof item !== 'object' || Array.isArray(item)
      || !String(item.articleId || '').trim() || !String(item.section || '').trim()) {
      throw new Error(`${IMAGE_REGENERATION_PUBLISH_OUTBOX_REL} items[${index}] must contain articleId and section`);
    }
  }
  return value;
}

export function readImageRegenerationPublishOutbox(root) {
  const file = outboxPath(root);
  if (!fs.existsSync(file)) return emptyOutbox();
  return parseOutbox(JSON.parse(fs.readFileSync(file, 'utf8')));
}

export function writeImageRegenerationPublishOutbox(root, outbox) {
  writeJsonAtomic(outboxPath(root), parseOutbox(outbox));
}

/** Add one article to the durable publisher handoff, once per section/id. */
export function appendImageRegenerationPublishOutbox(root, { articleId, section } = {}) {
  const normalizedArticleId = String(articleId || '').trim();
  const normalizedSection = String(section || '').trim();
  if (!normalizedArticleId || !normalizedSection) {
    throw new Error('publish outbox entry requires articleId and section');
  }

  const outbox = readImageRegenerationPublishOutbox(root);
  if (outbox.items.some((item) => item.articleId === normalizedArticleId && item.section === normalizedSection)) {
    return false;
  }
  outbox.items.push({ articleId: normalizedArticleId, section: normalizedSection });
  writeImageRegenerationPublishOutbox(root, outbox);
  return true;
}
