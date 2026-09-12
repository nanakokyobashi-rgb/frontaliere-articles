/**
 * Il verdetto di aggregazione è preso sul corpo CORRENTE della issue (#926).
 *
 * `isAggregate` / `isAggregateTitle` leggono il body al momento della run, e
 * `reconcile-followups.mjs` ne ricava una decisione IRREVERSIBILE
 * (`closeEligible = … && !isAggregate` → auto-chiusura). Se uno stadio del ciclo
 * riscrivesse il corpo di una `follow-up` dopo la creazione, la stessa issue
 * risulterebbe aggregata a una run e single-item a quella dopo, e l'auto-chiusura
 * cadrebbe su uno stato instabile.
 *
 * Misurato il 2026-09-06 su tutto `scripts/ci/**` e `.github/workflows/**`:
 * NESSUNO stadio che gestisce le `follow-up` riscrive il corpo di una issue.
 * L'unica eccezione ammessa è il digest `needs-human` di
 * `recycle-stale-prs.yml`, che deve riallineare il body alla fotografia
 * corrente dopo una recurrence/reopen (#1004). Ogni altro `gh issue edit` del
 * ciclo è solo `--add-label` / `--remove-label`; le uniche PATCH sono su
 * `repos/…/issues/comments/…` (`pr-body-contract.mjs`, `lib/prComments.mjs`), che
 * sono COMMENTI, non il body. Il verdetto è quindi stabile per costruzione, e
 * congelarlo sarebbe stato un meccanismo senza causa.
 *
 * Questo test è ciò che rende quella misura durevole: il giorno in cui uno stadio
 * inizia a riscrivere un body, diventa rosso QUI invece di far auto-chiudere un
 * aggregato parziale in silenzio. Le continuazioni shell con `\\` vengono
 * ricomposte prima dello scan, così il controllo vede anche un `gh issue edit`
 * spezzato su più righe (#1073 item 7).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Tutti i file sotto `dir` con una delle estensioni date, ricorsivo. */
function walk(dir, exts) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p, exts));
    else if (exts.some((e) => name.endsWith(e))) out.push(p);
  }
  return out;
}

const FILES = [
  ...walk(path.join(ROOT, 'scripts/ci'), ['.mjs']),
  ...walk(path.join(ROOT, '.github/workflows'), ['.yml', '.yaml']),
];

const BODY_REWRITE_EXCEPTIONS = new Map([
  ['gh issue edit "$DEDUP_NUMBER" --body "$DESC"', '.github/workflows/recycle-stale-prs.yml'],
]);

/** Ricompone una continuazione shell mantenendo gli a capo reali delle altre righe. */
function joinShellContinuations(source) {
  return String(source).replace(/\\[ \t]*\r?\n/g, ' ');
}

test('il guard ricompone un gh issue edit spezzato da una continuazione shell (#1073 item 7)', () => {
  const source = 'gh issue edit 123 \\\n  --body-file /tmp/body.md';
  const [line] = joinShellContinuations(source).split('\n');

  assert.match(line, /\bissue\s+edit\b/);
  assert.match(line, /--body-file\b/);
});

test('nessuno stadio del ciclo riscrive il CORPO di una issue (#926)', () => {
  const offenders = [];
  for (const file of FILES) {
    const rel = path.relative(ROOT, file);
    const lines = joinShellContinuations(readFileSync(file, 'utf8')).split('\n');
    lines.forEach((line, i) => {
      const where = `${rel}:${i + 1}`;
      // `gh issue edit … --body` / `--body-file`: riscrittura diretta del corpo.
      // L'eccezione è una singola riga, sul digest needs-human, non una deroga
      // all'intero workflow o a una forma di comando.
      if (
        /\bissue\s+edit\b/.test(line) &&
        /--body(-file)?\b/.test(line) &&
        BODY_REWRITE_EXCEPTIONS.get(line.trim()) !== rel
      ) offenders.push(where);
      // PATCH sull'oggetto issue. `issues/comments/<id>` è un COMMENTO: consentito.
      if (/PATCH/.test(line) && /issues\//.test(line) && !/issues\/comments\//.test(line)) {
        offenders.push(where);
      }
      // GraphQL equivalente.
      if (/updateIssue\s*\(/.test(line)) offenders.push(where);
    });
  }
  assert.deepEqual(offenders, [],
    'un body riscritto rende instabile il verdetto di aggregazione su cui reconcile ' +
    'auto-chiude: congelare il verdetto alla creazione, o rifiutare l\'auto-chiusura ' +
    'quando il body è cambiato dopo la creazione (#926 item 3)');
});

test('il riallineamento del digest non apre una deroga per le follow-up (#1004)', () => {
  const workflow = readFileSync(path.join(ROOT, '.github/workflows/recycle-stale-prs.yml'), 'utf8');
  const line = 'gh issue edit "$DEDUP_NUMBER" --body "$DESC"';
  assert.equal(BODY_REWRITE_EXCEPTIONS.get(line), '.github/workflows/recycle-stale-prs.yml');
  assert.match(workflow, new RegExp(line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(
    workflow,
    /publish-needs-human-digest\.mjs[\s\S]{0,260}--label automation/,
    'il digest deve restare nel canale automation, separato dalle follow-up',
  );

  const reconcile = readFileSync(path.join(ROOT, 'scripts/ci/reconcile-followups.mjs'), 'utf8');
  assert.match(reconcile, /issue', 'list', '--label', 'follow-up'/);
});
