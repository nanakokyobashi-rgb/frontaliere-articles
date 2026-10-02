#!/usr/bin/env node
/**
 * Roll back journalist documents stamped `published` when a post-producer
 * workflow guard rejects the files before the commit step.
 *
 * The producer exposes only the JSON ID list through GITHUB_OUTPUT.  This
 * command resolves those IDs in Firestore and uses the same bounded,
 * idempotent recovery as a fatal producer failure.
 */

import { applicationDefault, getApps, initializeApp } from 'firebase-admin/app';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import {
  requeuePublishedDocumentIds,
} from './lib/journalist-publish-recovery.mjs';

function parseIds(raw) {
  if (raw == null || raw === '') return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`PUBLISHED_IDS non e' JSON valido: ${error.message}`);
  }
  if (!Array.isArray(parsed) || parsed.some((id) => typeof id !== 'string')) {
    throw new Error('PUBLISHED_IDS deve essere un array JSON di stringhe');
  }
  return [...new Set(parsed.map((id) => id.trim()).filter(Boolean))];
}

async function main() {
  const ids = parseIds(process.env.PUBLISHED_IDS || '[]');
  if (ids.length === 0) {
    console.log('[journalist-requeue] nessun documento da rimettere in coda');
    return;
  }

  if (!getApps().length) {
    initializeApp({
      credential: applicationDefault(),
      projectId: process.env.GCLOUD_PROJECT
        || process.env.GOOGLE_CLOUD_PROJECT
        || 'frontaliere-ticino',
    });
  }

  const requeuedIds = [];
  try {
    await requeuePublishedDocumentIds({
      db: getFirestore(),
      FieldValue,
      ids,
      requeuedIds,
    });
    console.log(`[journalist-requeue] rimessi in coda ${requeuedIds.length}/${ids.length} documenti`);
  } catch (error) {
    const unresolvedIds = error?.unresolvedIds || ids.filter((id) => !requeuedIds.includes(id));
    console.error(
      `[journalist-requeue] rollback incompleto: ${requeuedIds.length}/${ids.length} rimessi in coda; `
        + `${unresolvedIds.length} ancora published (${unresolvedIds.join(', ') || 'nessun id'}) — `
        + `${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`[journalist-requeue] FATAL: ${error instanceof Error ? error.stack : String(error)}`);
  process.exitCode = 1;
});
