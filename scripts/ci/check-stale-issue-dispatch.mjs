#!/usr/bin/env node
/**
 * check-stale-issue-dispatch.mjs — pre-flight zero-Claude contro la SECONDA run
 * sulla stessa issue, quella che parte con un payload catturato prima.
 *
 * ## La finestra che questo gate chiude (#918, item 3)
 *
 * Da quando `issue-fix.yml` / `issue-decompose.yml` serializzano su una chiave
 * PER-issue (#908), due eventi `labeled` sulla STESSA issue non si sfrattano
 * piu' a vicenda: il secondo aspetta il primo e poi **parte davvero**. Prima
 * moriva `cancelled`; ora esegue. Ed esegue su un payload congelato all'istante
 * dell'evento: `if: github.event.label.name == 'agent:fix'` resta vero anche se
 * nel frattempo la prima run ha aperto la PR, e `agent:decompose` resta vero
 * anche se la prima run ha gia' creato le sub-issue e messo `decomposed:1`.
 *
 * Le difese esistenti non coprono il caso:
 *  - il mutex `agent:in-progress` (`claim-issue-in-flight.mjs`) viene RILASCIATO
 *    a fine run (`if: always()`), quindi la seconda run lo trova libero — e' la
 *    serializzazione stessa a garantire che non si sovrappongano;
 *  - il ramo in-flight di `check-issue-already-resolved.mjs` fa esplicitamente
 *    **PROCEED** quando una PR aperta cita la issue, e ha ragione nel suo
 *    dominio: «PR aperta» significa lavoro in corso, cioe' NON gia' risolta.
 *    Risponde a un'altra domanda;
 *  - resta l'istruzione di prompt del fixer («PR gia' in volo: skip»), cioe'
 *    guida prompt-only — non load-bearing per costruzione, e che costa comunque
 *    una run Claude intera sulla quota condivisa col sito per scoprire una cosa
 *    che si legge con due chiamate `gh`.
 *
 * ## I due segnali, entrambi deterministici
 *
 * 1. **La label di dispatch non c'e' piu'** (tutte le fasi). La label E' il
 *    token di dispatch: se la prima run l'ha consumata, l'evento in mano alla
 *    seconda descrive uno stato che non esiste piu'.
 * 2. **Il lavoro e' gia' stato consegnato**, in una forma specifica per fase:
 *    - `fix`: esiste una PR APERTA con head ESATTAMENTE `fix/issue-<N>`, cioe'
 *      il branch che il fixer si da' per contratto. Solo quel branch: una PR
 *      organica che cita `#<N>` non basta, perche' li' un falso positivo
 *      lascerebbe cadere un bug vero (stesso criterio di SIGNAL 1b in
 *      `check-issue-already-resolved.mjs`).
 *    - `decompose`: la issue porta gia' `decomposed:1`, che la prima run mette
 *      come ultimo passo. Ri-decomporre significa un secondo set di sub-issue
 *      duplicate, che nessuno stadio a valle sa riconciliare.
 *
 * ## Direzione dell'errore: PROCEED su qualunque dubbio
 *
 * Un falso corto-circuito lascia cadere un fix vero; una run in piu' costa
 * quota. Quindi: input mancante, fase sconosciuta, `gh` illeggibile o JSON
 * malformato → `stale_dispatch=false` e la run prosegue identica a oggi.
 *
 * Effetti collaterali sul corto-circuito: UN commento con il marker di
 * telemetria della fase, e NIENTE label toccate. E' di proposito — e' lo stesso
 * stato che l'agent produceva a mano con «PR gia' in volo: skip», quindi il
 * rescue del drainer continua a vederlo come lo vedeva prima (`pr-already-open`
 * e' gia' classificato transiente-ritentabile in `followup-drainer.mjs`: la PR
 * bloccante puo' mergiare). Il commento e' idempotente: se l'ultimo commento
 * porta gia' il marker di questo gate, non se ne aggiunge un altro.
 *
 * Env:
 *   GH_TOKEN        richiesto per le letture/scritture `gh`.
 *   GH_REPO         opzionale `owner/repo`.
 *   ISSUE_NUMBER    richiesto.
 *   DISPATCH_LABEL  la label dell'evento (`github.event.label.name`).
 *   STAGE           `fix` | `decompose`.
 *   DRY_RUN         "1" → rileva e stampa, nessuna scrittura.
 *   GITHUB_OUTPUT   opzionale, file degli output dello step.
 *
 * Output: `stale_dispatch=true|false`.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Marker di questo gate: rende il commento idempotente fra run ripetute. */
export const GATE_MARKER = '<!-- stale-dispatch-gate -->';

/**
 * Telemetria per fase. `fix` parla il vocabolario `FIX_OUTCOME` del drainer, e
 * `pr-already-open` e' esattamente il codice che l'agent avrebbe scritto a mano
 * in questo caso (ISSUES.md → «Telemetria degli esiti»). `decompose` parla
 * quello di `issue-decompose.yml`, dove `already-resolved` e' gia' fra i
 * verdetti che lo step «Classify outcome» conta come lavoro fatto → job verde.
 */
export const STAGE_TELEMETRY = {
  fix: '<!-- FIX_OUTCOME: pr-already-open -->',
  decompose: '<!-- DECOMPOSE_OUTCOME: already-resolved -->',
};

/**
 * Il giudizio, puro e testabile: questo dispatch descrive uno stato superato?
 *
 * @param {object} o
 * @param {'fix'|'decompose'} o.stage        fase chiamante
 * @param {string|number} o.issueNumber      numero della issue
 * @param {string} [o.dispatchLabel]         `github.event.label.name`
 * @param {string[]|null} [o.labels]         label ATTUALI (null = illeggibili)
 * @param {Array<{headRefName?: string}>|null} [o.openPrs] PR aperte (null = illeggibili)
 * @returns {{code: string, detail: string}|null} null = procedi
 */
export function staleDispatchReason({ stage, issueNumber, dispatchLabel, labels, openPrs }) {
  if (stage !== 'fix' && stage !== 'decompose') return null; // fase sconosciuta → procedi
  const n = String(issueNumber || '').trim();
  if (!n) return null;

  // Segnale 1 — il token di dispatch e' stato consumato dalla run precedente.
  // Solo con label ATTUALI leggibili: `null` significa "non lo so", non "assente".
  if (dispatchLabel && Array.isArray(labels) && !labels.includes(dispatchLabel)) {
    return {
      code: 'dispatch-label-gone',
      detail: `la label \`${dispatchLabel}\` che ha innescato questa run non e' piu' sulla issue`,
    };
  }

  // Segnale 2 — il lavoro e' gia' stato consegnato.
  if (stage === 'fix' && Array.isArray(openPrs)) {
    const head = `fix/issue-${n}`;
    const pr = openPrs.find((p) => (p && p.headRefName) === head);
    if (pr) {
      return {
        code: 'pr-in-flight',
        detail: `la PR **#${pr.number}** e' APERTA sul branch del fixer \`${head}\``,
      };
    }
  }
  if (stage === 'decompose' && Array.isArray(labels) && labels.includes('decomposed:1')) {
    return {
      code: 'already-decomposed',
      detail: 'la issue porta gia\' `decomposed:1`: le sub-issue esistono, ri-decomporre le duplicherebbe',
    };
  }
  return null;
}

const DRY_RUN = process.env.DRY_RUN === '1';
const ISSUE = process.env.ISSUE_NUMBER;
const STAGE = process.env.STAGE;
const repoArgs = process.env.GH_REPO ? ['--repo', process.env.GH_REPO] : [];

function gh(args) {
  try {
    return execFileSync('gh', args, { encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024 });
  } catch {
    return '';
  }
}

function setOutput(stale) {
  console.log(`stale_dispatch=${stale}`);
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `stale_dispatch=${stale}\n`);
  }
}

function main() {
  if (!ISSUE || (STAGE !== 'fix' && STAGE !== 'decompose')) {
    console.log('ISSUE_NUMBER o STAGE mancanti/ignoti — procedo (nessun gate).');
    setOutput(false);
    return;
  }

  let iss = null;
  try {
    iss = JSON.parse(gh(['issue', 'view', ISSUE, ...repoArgs, '--json', 'number,labels,comments']) || 'null');
  } catch { iss = null; }
  const labels = iss && Array.isArray(iss.labels) ? iss.labels.map((l) => l.name) : null;

  let openPrs = null;
  if (STAGE === 'fix') {
    try {
      openPrs = JSON.parse(
        gh(['pr', 'list', '--state', 'open', '--head', `fix/issue-${ISSUE}`, ...repoArgs,
            '--json', 'number,headRefName', '--limit', '10']) || 'null',
      );
    } catch { openPrs = null; }
  }

  const reason = staleDispatchReason({
    stage: STAGE,
    issueNumber: ISSUE,
    dispatchLabel: process.env.DISPATCH_LABEL,
    labels,
    openPrs,
  });

  if (!reason) {
    console.log('Dispatch attuale (o stato illeggibile) — procedo: la run gira identica.');
    setOutput(false);
    return;
  }

  console.log(`Issue #${ISSUE}: dispatch STANTIO (${reason.code}) — ${reason.detail} → corto-circuito, zero Claude.`);

  // Idempotenza: se l'ULTIMO commento e' gia' di questo gate, non se ne aggiunge
  // un altro (una raffica di eventi stantii non deve diventare una raffica di
  // commenti, che bumperebbe `updatedAt` e sposterebbe il rescue del drainer).
  const comments = iss && Array.isArray(iss.comments) ? iss.comments : [];
  const last = comments.length ? String(comments[comments.length - 1].body || '') : '';
  if (!DRY_RUN && !last.includes(GATE_MARKER)) {
    const body = `${GATE_MARKER}
⏭️ **Pre-flight (auto, zero-Claude)**: questa run e' partita da un evento ormai **stantio** — ${reason.detail}. Con la chiave di concorrenza per-issue (#908) il secondo evento sulla stessa issue non muore piu' sfrattato: aspetta il primo e poi **esegue**, con il payload catturato prima. Salto il run Claude per non ri-fare (o disfare) lavoro gia' consegnato sulla quota condivisa.

${STAGE_TELEMETRY[STAGE]}`;
    gh(['issue', 'comment', ISSUE, ...repoArgs, '--body', body]);
  }

  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `## Pre-flight stale-dispatch: issue #${ISSUE} corto-circuitata (${reason.code})\n- ${reason.detail}\n`,
    );
  }
  setOutput(true);
}

// Come gli altri pre-flight: importabile dai test senza eseguire il gate, e un
// throw non deve MAI lasciare la issue etichettata-ma-non-dispacciata → si
// procede (comportamento di oggi) invece di fallire il job.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (e) {
    console.error('Pre-flight stale-dispatch error — procedo:', e && e.message ? e.message : e);
    setOutput(false);
    process.exit(0);
  }
}
