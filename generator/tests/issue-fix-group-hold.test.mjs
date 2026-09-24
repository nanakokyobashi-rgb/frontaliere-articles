/**
 * issue-fix-group-hold.test.mjs — FU-2026-09-20-012 (reviewer di PR #1605,
 * bucket del sito valerielinc-ops/frontaliere-si-o-no#9321).
 *
 * Lo step `Apply production-proof hold ...` di `issue-fix.yml` mette
 * `awaiting-production-proof` su ogni membro di un gruppo B19. Usciva al primo
 * membro non etichettato: i membri successivi restavano senza hold, cioe' un
 * gruppo misto in cui il drainer poteva riaccodare un membro della stessa PR.
 *
 * Il test ESEGUE la coda reale dello step (dalla riga `TARGET_ISSUES=` alla
 * fine del `run:`) con un `gh` finto, invece di cercarne il testo: cio' che
 * conta e' quali edit partono, non come sono scritte.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = fs.readFileSync(path.join(ROOT, '.github/workflows/issue-fix.yml'), 'utf8');
const STEP = 'Apply production-proof hold for runtime workflow fixes (zero-Claude)';

/** La coda del `run:` dello step, de-indentata, da `TARGET_ISSUES=` in poi. */
function holdTail() {
  const start = SRC.indexOf(`      - name: ${STEP}`);
  assert.ok(start > 0, 'step del hold non trovato');
  const rest = SRC.slice(start + 1);
  const block = rest.slice(0, rest.indexOf('\n      - name: '));
  const runAt = block.indexOf('        run: |\n');
  assert.ok(runAt > 0, 'run: dello step non trovato');
  const lines = block.slice(runAt + '        run: |\n'.length).split('\n');
  const from = lines.findIndex((line) => line.trim().startsWith('TARGET_ISSUES='));
  assert.ok(from >= 0, 'TARGET_ISSUES= non trovato nello step');
  return lines.slice(from).map((line) => line.replace(/^ {10}/, '')).join('\n');
}

/** Esegue la coda con un `gh` che fallisce sempre sulle issue in `failFor`. */
function runHold({ issue = '11', group = 'true', numbers, failFor = [] }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-fix-hold-'));
  const log = path.join(dir, 'gh.log');
  const script = [
    'set -uo pipefail',
    'sleep() { :; }',
    `gh() { echo "$*" >> ${JSON.stringify(log)}; case " ${failFor.join(' ')} " in *" $3 "*) return 1;; esac; return 0; }`,
    holdTail(),
  ].join('\n');
  try {
    const res = spawnSync('bash', ['-c', script], {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        REPO: 'nanakokyobashi-rgb/frontaliere-articles',
        ISSUE: issue,
        ISSUE_GROUP: group,
        ISSUE_GROUP_NUMBERS: numbers,
        PR_NUMBER: '900',
      },
    });
    const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [];
    const edited = [...new Set(calls.map((c) => c.split(' ')[2]))];
    return { status: res.status, out: res.stdout + res.stderr, edited };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('012: un membro fallito non lascia i successivi senza hold', () => {
  const r = runHold({ numbers: '11,12,13', failFor: ['12'] });
  assert.deepEqual(r.edited, ['11', '12', '13'], 'ogni membro va tentato');
  assert.equal(r.status, 1, 'lo step resta rosso');
  assert.match(r.out, /membri senza hold: 12\b/);
  assert.match(r.out, /issue #13 sospesa per PR #900/);
});

test('012: una lista malformata non produce nessuna edit', () => {
  const r = runHold({ numbers: '11,x,13' });
  assert.deepEqual(r.edited, []);
  assert.equal(r.status, 1);
  assert.match(r.out, /membro issue non valido: x/);
});

test('012: gruppo integro → tutti sospesi, step verde', () => {
  const r = runHold({ numbers: '11, 12,13' });
  assert.deepEqual(r.edited, ['11', '12', '13']);
  assert.equal(r.status, 0);
});

test('012: issue singola e gruppo senza membri restano come prima', () => {
  const single = runHold({ issue: '42', group: 'false', numbers: '' });
  assert.deepEqual(single.edited, ['42']);
  assert.equal(single.status, 0);
  const empty = runHold({ group: 'true', numbers: '' });
  assert.deepEqual(empty.edited, []);
  assert.equal(empty.status, 1);
});
