/**
 * Regressioni per i due gate distruttivi di recycle-stale-prs.yml (#1273).
 *
 * Il workflow interroga GitHub dentro uno script shell; queste asserzioni
 * tengono ancorati i due contratti che una fixture di dati non può esercitare:
 * la data più recente non dipende dall'ordine dell'array e il DELETE è
 * preceduto dal confronto della SHA del ref con quella della PR chiusa.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKFLOW = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'recycle-stale-prs.yml'), 'utf8');

test('il gate di inattività usa il massimo delle date, non l\'ultimo elemento', () => {
  assert.match(WORKFLOW, /--json commits,headRefName,headRefOid/);
  assert.match(WORKFLOW, /\[\.commits\[\]\?\.committedDate\s*\|\s*select\(type == "string" and length > 0\)\]\s*\|\s*max/);
  assert.doesNotMatch(WORKFLOW, /\.commits\[-1\]\.committedDate/);
});

test('il fallback DELETE confronta REF_SHA e HEADSHA prima di cancellare', () => {
  const deleteAt = WORKFLOW.indexOf('gh api -X DELETE "repos/${REPO}/git/refs/heads/${HEADREF}"');
  assert.ok(deleteAt >= 0, 'il fallback DELETE deve restare esplicito e verificabile');

  const beforeDelete = WORKFLOW.slice(Math.max(0, deleteAt - 1800), deleteAt);
  assert.match(beforeDelete, /REF_SHA=.*gh api/);
  assert.match(beforeDelete, /HEADSHA/);
  assert.match(beforeDelete, /\[\s*"\$REF_SHA"\s+!=\s+"\$HEADSHA"\s*\]/);
  assert.match(beforeDelete, /diverso dalla head chiusa.*skip DELETE/);
});
