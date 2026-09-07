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

/**
 * UNICA eccezione, e con obbligo di prova (#1004).
 *
 * L'invariante di questo gate non è «nessun corpo si riscrive mai»: è «il
 * verdetto di aggregazione resta stabile». Quel verdetto lo calcola
 * `reconcile-followups.mjs`, che guarda ESCLUSIVAMENTE le issue con label
 * `follow-up` (`--label follow-up` nella sua query, l'unico perimetro che
 * legge). Una riscrittura di corpo su un oggetto che non può entrare in quel
 * perimetro non può destabilizzare niente.
 *
 * Il digest `needs-human` di `recycle-stale-prs.yml` è quell'oggetto: nasce
 * con `automation`, il suo corpo È l'elenco del run corrente, e sul percorso di
 * dedup/riapertura `createGithubIssue` lo lascia com'era — cioè fermo alle
 * liste di prima della chiusura, mentre quelle vere stanno solo nell'ultimo
 * commento. Su un'issue letta da un umano, quella è la sorgente che si legge
 * per prima ed è la falsa.
 *
 * L'eccezione è per RIGA ESATTA, non per file: qualunque altra riscrittura di
 * corpo — anche nello stesso workflow — resta un'infrazione. E le condizioni
 * che la rendono vera sono verificate dal test sotto, non solo dichiarate qui:
 * il giorno in cui il digest nascesse `follow-up`, o `reconcile` allargasse il
 * suo perimetro, l'eccezione diventa rossa da sé.
 */
const BODY_REWRITE_EXCEPTIONS = new Map([
  [
    'gh issue edit "$DEDUP_NUMBER" --body "$DESC"',
    '.github/workflows/recycle-stale-prs.yml',
  ],
]);

test('nessuno stadio del ciclo riscrive il CORPO di una issue (#926)', () => {
  const offenders = [];
  for (const file of FILES) {
    const rel = path.relative(ROOT, file);
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      const where = `${rel}:${i + 1}`;
      if (BODY_REWRITE_EXCEPTIONS.get(line.trim()) === rel) return;
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

/**
 * L'eccezione qui sopra vale solo finché valgono le sue premesse. Questo test le
 * misura invece di fidarsi del commento: sono le due estremità del ragionamento
 * — chi riscrive il corpo sta fuori dal perimetro di `reconcile`, e quel
 * perimetro è ancora quello che credevamo.
 */
test('l unica riscrittura di corpo consentita resta fuori dal perimetro di reconcile', () => {
  for (const [line, rel] of BODY_REWRITE_EXCEPTIONS) {
    const text = readFileSync(path.join(ROOT, rel), 'utf8');
    assert.ok(
      text.split('\n').some((l) => l.trim() === line),
      `${rel}: l eccezione e dichiarata ma la riga non esiste piu — va rimossa dall allowlist`,
    );
  }

  // Estremità 1 — il digest nasce `automation`, non `follow-up`: `reconcile`
  // non lo vede, quindi il suo corpo non entra in nessun verdetto.
  const workflow = readFileSync(path.join(ROOT, '.github/workflows/recycle-stale-prs.yml'), 'utf8');
  const create = /node scripts\/lib\/github-issue-creator\.mjs[\s\S]*?--title "\$DEDUP_TITLE"[\s\S]*?--workflow "Recycle stale PRs"/.exec(workflow);
  assert.ok(create, 'create/reopen del digest non trovata: l eccezione non e piu verificabile');
  assert.match(create[0], /--label automation/, 'il digest deve nascere `automation`');
  assert.doesNotMatch(create[0], /--label follow-up/, 'un digest `follow-up` entrerebbe nel verdetto di reconcile: l eccezione cadrebbe');

  // Estremità 2 — `reconcile` guarda ancora solo le `follow-up`. Se allargasse
  // il perimetro, la riscrittura tornerebbe a poter destabilizzare il verdetto.
  const reconcile = readFileSync(path.join(ROOT, 'scripts/ci/reconcile-followups.mjs'), 'utf8');
  assert.match(
    reconcile,
    /'--label', 'follow-up'/,
    'reconcile non seleziona piu per `follow-up`: il perimetro su cui poggia l eccezione e cambiato',
  );
});
