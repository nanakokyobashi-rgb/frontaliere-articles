// `workflow_run.workflows` confronta il `name:` del workflow sorgente, non il
// file. Un rename del sorgente non rompe niente in modo visibile: il consumer
// smette semplicemente di partire. E' successo con il passaggio Claude → Codex
// Luna Max di issue-fix.yml / issue-decompose.yml: review-quota-rescuer.yml
// aspettava ancora `Issue fix (Claude → PR)` e `Issue decompose (Claude →
// sub-issues)`, e scan-failed-runs.mjs confrontava lo stesso nome vecchio, cosi'
// la soppressione di #1025 non scattava piu'. Questo test lega ogni nome citato
// a un workflow che esiste davvero.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ISSUE_FIX_WORKFLOW_NAME,
  ISSUE_FIX_NON_DELIVERY_RE,
} from '../../scripts/ci/scan-failed-runs.mjs';
import {
  DELIVERY_STATUS,
  classifyWorkflowOutcome,
} from '../../scripts/ci/lib/pr-delivery-evidence.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WF_DIR = path.join(ROOT, '.github/workflows');
const files = fs.readdirSync(WF_DIR).filter((f) => /\.ya?ml$/.test(f));
const sources = new Map(files.map((f) => [f, fs.readFileSync(path.join(WF_DIR, f), 'utf8')]));

const unquote = (s) => s.trim().replace(/^(['"])(.*)\1$/, '$2');

function workflowName(src) {
  const m = src.match(/^name:\s*(.+)$/m);
  return m ? unquote(m[1]) : null;
}

/** Names listed under `on.workflow_run.workflows`, inline or block form. */
function workflowRunSources(src) {
  const on = src.indexOf('\non:\n');
  if (on < 0) return [];
  const start = src.indexOf('\n  workflow_run:\n', on);
  if (start < 0) return [];
  const block = src.slice(start + 1).split('\n');
  const names = [];
  for (let i = 1; i < block.length; i += 1) {
    const line = block[i];
    if (/^ {0,2}\S/.test(line)) break; // next trigger or top-level key
    const inline = line.match(/^ {4}workflows:\s*\[(.*)\]\s*$/);
    if (inline) {
      names.push(...inline[1].split(',').map(unquote).filter(Boolean));
      continue;
    }
    if (/^ {4}workflows:\s*$/.test(line)) {
      for (let j = i + 1; j < block.length && /^ {6}- /.test(block[j]); j += 1) {
        names.push(unquote(block[j].replace(/^ {6}- /, '')));
      }
    }
  }
  return names;
}

const known = new Set([...sources.values()].map(workflowName).filter(Boolean));

test('ogni sorgente workflow_run nomina un workflow esistente', () => {
  const dangling = [];
  const unread = [];
  for (const [file, src] of sources) {
    const names = workflowRunSources(src);
    // Un file che dichiara il trigger ma da cui il parser non legge nomi e'
    // un buco del test, non un file conforme.
    if (/^ {2}workflow_run:\s*$/m.test(src) && names.length === 0) unread.push(file);
    for (const name of names) {
      if (!known.has(name)) dangling.push(`${file}: '${name}'`);
    }
  }
  assert.deepEqual(unread, [], 'workflow_run dichiarato ma nessuna sorgente letta');
  assert.deepEqual(dangling, []);
});

test('ISSUE_FIX_WORKFLOW_NAME coincide con il name: di issue-fix.yml', () => {
  assert.equal(ISSUE_FIX_WORKFLOW_NAME, workflowName(sources.get('issue-fix.yml')));
});

// La firma runtime di #1025 e il produttore vivono in due file che non si
// importano: il legame lo tiene questo test, sull'output vero del classificatore.
test('#1025: la firma riconosce la non-consegna stampata dal classificatore vero', () => {
  const delivery = { status: DELIVERY_STATUS.NONE, reason: 'no-current-delivery-evidence', prNumber: null };
  const nonDelivery = classifyWorkflowOutcome({ actionOutcome: 'failure', delivery });
  assert.equal(nonDelivery.classification, 'non-delivery');
  assert.equal(ISSUE_FIX_NON_DELIVERY_RE.test(`fix\t2026-09-24T10:00:00Z ${JSON.stringify(nonDelivery)}`), true);

  const unknown = classifyWorkflowOutcome({
    actionOutcome: 'failure',
    delivery: { ...delivery, status: DELIVERY_STATUS.UNAVAILABLE },
  });
  assert.equal(unknown.classification, 'unknown');
  assert.equal(ISSUE_FIX_NON_DELIVERY_RE.test(JSON.stringify(unknown)), false);
});
