#!/usr/bin/env node
/**
 * detect-aggregate.mjs — la QUARTA copia del rilevatore di aggregati, quella in
 * shell dentro `issue-fix.yml`, non decide piu' da sola (issue #986).
 *
 * ## Il difetto, misurato
 *
 * Il rilevatore di aggregati multi-item vive in Node in tre copie tenute
 * identiche da `generator/tests/aggregate-detectors-agree.test.mjs`
 * (`check-issue-already-resolved.mjs`, `reconcile-followups.mjs`,
 * `harvest-agent-lessons.mjs`). `issue-fix.yml` ne aveva una QUARTA, in shell,
 * con una regola tutta sua:
 *
 *     agg_count=$(printf '%s' "$body" | grep -cE '^[[:space:]]*[-*][[:space:]]+')
 *     [ "$agg_count" -ge 4 ] && is_agg=true
 *
 * Cioe': conta OGNI riga di lista del corpo e chiama aggregata la issue a
 * quattro. Non e' un'approssimazione della regola condivisa, e' un'altra regola,
 * e sbaglia in tutti e due i versi:
 *
 *   - **falso negativo** (il verso pericoloso) su un aggregato nella forma
 *     `- **Titolo.**` x2/x3 — quella di #466, che `hasEnumeratedItems` copre dal
 *     #568: tre item, tre bullet, `3 < 4`, `is_aggregate=false`. Il fixer scrive
 *     allora `Closes #N` e al merge il tracker si chiude **con dentro gli item
 *     appena deferiti in `## Non implementato`**: non resta niente da
 *     ri-accodare e il ciclo non converge. E' esattamente la protezione che
 *     `reconcile-followups.mjs` implementa (`closeEligible = ... &&
 *     !isAggregate`) e che la keyword nel body bypassa;
 *   - **falso positivo** su una issue di UN solo item il cui corpo elenca
 *     quattro path, quattro misure o quattro righe di prosa puntata. Li' il
 *     circuit-breaker fa consegnare un item su uno e poi mette `Refs`, quindi la
 *     issue resta aperta e ripaga un giro intero di quota per scoprire che non
 *     c'era altro da fare.
 *
 * ## Perche' un modulo e non una riga di shell in meno
 *
 * AGENTS.md #6: un valore condiviso ha UNA sorgente, e niente regex duplicate
 * fra uno script e lo YAML che lo invoca. Il verdetto qui e' `isAggregate()`
 * IMPORTATA — non reimplementata, non approssimata: se le tre copie Node si
 * muovono, il workflow si muove con loro senza che nessuno se ne ricordi.
 *
 * `agg_count` non sopravvive al passaggio, ed e' voluto. Non era un conteggio di
 * item: era il numero di righe di lista del corpo, e finiva nel prompt come
 * «(item=N)». Su #986 — un item, zero bullet — il prompt leggeva `item=0`, e su
 * una issue con prosa puntata legge un numero qualunque. Il rilevatore
 * condiviso non ha un conteggio da dare (`hasEnumeratedItems` e' un predicato,
 * e la soglia sta dentro), e inventarne uno qui sarebbe ricreare la quarta copia
 * sotto un altro nome. Un numero sbagliato informa peggio di nessun numero.
 *
 * ## La direzione dell'errore, quando la lettura fallisce
 *
 * Se `gh` non risponde non si sa niente della issue, e le due risposte non si
 * equivalgono: `false` fa scrivere `Closes` e la chiusura di un tracker con gli
 * item dentro e' irreversibile; `true` fa consegnare un item e mette `Refs`,
 * che al massimo costa un giro. Quindi si esce `is_aggregate=true` con un
 * `::warning::`, non si fallisce lo step e non si tira a indovinare.
 *
 * Uso:
 *   ISSUE_NUMBER=986 REPO=owner/repo node scripts/ci/detect-aggregate.mjs
 *
 * Scrive `is_aggregate=<true|false>` su `$GITHUB_OUTPUT` (e su stdout, per
 * l'uso a mano). Env: `GH_TOKEN`, `REPO`/`GITHUB_REPOSITORY`, `ISSUE_NUMBER`.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
// La regola condivisa, importata dalla copia che gia' la esporta. Le altre due
// (`reconcile-followups.mjs`, `harvest-agent-lessons.mjs`) sono tenute identiche
// a questa da `generator/tests/aggregate-detectors-agree.test.mjs`: importarne
// una qualunque e' importarle tutte. Il modulo ha la guardia `argv` sul proprio
// `main`, quindi importarlo non fa ne' rete ne' scritture.
import { isAggregate } from './check-issue-already-resolved.mjs';

/**
 * Il verdetto, piu' la ragione per cui e' quello.
 *
 * @param {{title?: string, body?: string, readable?: boolean}} issue
 *   `readable: false` quando la lettura della issue e' fallita.
 * @returns {{aggregate: boolean, fallback: boolean}}
 */
export function detectAggregate({ title = '', body = '', readable = true } = {}) {
  if (!readable) return { aggregate: true, fallback: true };
  return { aggregate: isAggregate(title, body), fallback: false };
}

/** Legge titolo e corpo della issue; `readable: false` se `gh` non risponde. */
function readIssue(repo, issue) {
  try {
    const out = execFileSync(
      'gh',
      ['issue', 'view', String(issue), '--repo', repo, '--json', 'title,body'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const parsed = JSON.parse(out);
    return { title: parsed.title || '', body: parsed.body || '', readable: true };
  } catch (err) {
    return { readable: false, error: err?.message || String(err) };
  }
}

function main() {
  const repo = process.env.REPO || process.env.GH_REPO || process.env.GITHUB_REPOSITORY || '';
  const issue = process.env.ISSUE_NUMBER || '';
  if (!repo || !issue) {
    console.error('detect-aggregate: REPO e ISSUE_NUMBER sono obbligatori');
    process.exit(2);
  }
  const read = readIssue(repo, issue);
  const { aggregate, fallback } = detectAggregate(read);
  if (fallback) {
    console.log(
      `::warning::detect-aggregate: issue #${issue} non leggibile (${read.error}) — ` +
        'is_aggregate=true per prudenza (un falso `false` fa chiudere il tracker con gli item dentro).',
    );
  }
  console.log(`is_aggregate=${aggregate}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `is_aggregate=${aggregate}\n`);
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) main();
