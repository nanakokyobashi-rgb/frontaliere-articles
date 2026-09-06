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
 * NESSUNO stadio riscrive il corpo di una issue. Ogni `gh issue edit` del ciclo è
 * solo `--add-label` / `--remove-label`; le uniche PATCH sono su
 * `repos/…/issues/comments/…` (`pr-body-contract.mjs`, `lib/prComments.mjs`), che
 * sono COMMENTI, non il body. Il verdetto è quindi stabile per costruzione, e
 * congelarlo sarebbe stato un meccanismo senza causa.
 *
 * Questo test è ciò che rende quella misura durevole: il giorno in cui uno stadio
 * inizia a riscrivere un body, diventa rosso QUI invece di far auto-chiudere un
 * aggregato parziale in silenzio.
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

test('nessuno stadio del ciclo riscrive il CORPO di una issue (#926)', () => {
  const offenders = [];
  for (const file of FILES) {
    const rel = path.relative(ROOT, file);
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      const where = `${rel}:${i + 1}`;
      // `gh issue edit … --body` / `--body-file`: riscrittura diretta del corpo.
      if (/\bissue\s+edit\b/.test(line) && /--body(-file)?\b/.test(line)) offenders.push(where);
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
