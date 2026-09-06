#!/usr/bin/env node
/**
 * check-fixer-slot.mjs — zero-Claude pre-flight: MUTUA ESCLUSIONE FRA ISSUE.
 *
 * Il gemello mancante di `claim-issue-in-flight.mjs`. Quello impedisce a due
 * agenti di lavorare la STESSA issue; questo impedisce a due fixer di girare
 * insieme su ISSUE DIVERSE, che è l'invariante che #908 ha rimosso senza
 * volerlo spostando la chiave di `concurrency` da costante a per-issue (il
 * perché, e perché quello spostamento era comunque giusto, sta in
 * `scripts/lib/fixer-slot.mjs`).
 *
 * Perché conta. La quota Claude non è per-run né per-repo: è per ACCOUNT, ed è
 * condivisa col ciclo di `frontaliereticino.ch`, verso cui questo repo ha
 * precedenza inferiore per costruzione (AGENTS.md). `check-quota-backoff.mjs`
 * la difende con un beacon che chiude la porta DOPO che un 429 è stato
 * osservato: con un fixer alla volta si perde una run, con N se ne perdono N,
 * tutte con `num_turns: 1` e `total_cost_usd: 0`. E la coda
 * `agent:fix-queued` — il drainer che promuove "una alla volta, solo a slot
 * libero" — descrive uno slot che nessuno stava più facendo rispettare a chi
 * non passa dal drainer: una label `agent:fix` manuale, o l'instradamento
 * diretto di `issue-triage` per la categoria `publish`.
 *
 * Non ripristina la `concurrency` costante — quella sfrattava le pending e
 * l'evento `issues: [labeled]` è one-shot, quindi una run sfrattata perdeva la
 * issue per sempre. Qui la run parte, scopre lo slot occupato e RI-ACCODA la
 * sua issue senza consumarle un tentativo: la coda la ripromuove appena lo
 * slot si libera, che è precisamente il contratto della coda.
 *
 * Tie-break deadlock-free: si cede solo alle run con `databaseId` STRETTAMENTE
 * minore. La run più vecchia non cede a nessuno, quindi c'è sempre esattamente
 * un fixer che lavora (dettaglio in `precedingRunIds`).
 *
 * Come è cablato. Il gate NON aggiunge un sesto booleano alle sedici catene
 * `if:` di `issue-fix.yml`: è composto dentro `check-quota-backoff.mjs`
 * (`QUOTA_SLOT_MUTEX=1`), che già possiede l'unico output — `quota_blocked` —
 * su cui ogni step a valle è condizionato. La ragione è la stessa dei due
 * gate: la quota Claude condivisa non va spesa da questa run. Sedici catene da
 * tenere allineate a mano sarebbero una fonte di divergenza silenziosa, e la
 * prima che qualcuno dimenticasse di aggiornare farebbe girare Claude proprio
 * nel caso che il gate deve prendere. La logica però vive qui, non lì: il gate
 * di quota compone, non implementa.
 *
 * Resta invocabile da solo (`node scripts/ci/check-fixer-slot.mjs`), e in quel
 * caso emette `slot_busy=true|false` + `holder=<run id|''>`.
 *
 * PROCEED-SAFE, come ogni pre-flight di questo ciclo
 * (`check-quota-backoff.mjs` / `check-issue-already-resolved.mjs` /
 * `claim-issue-in-flight.mjs`): qualunque errore gh/API/parse →
 * `slot_busy=false`, exit 0. Un gate rotto non deve MAI congelare la coda; al
 * massimo si torna al comportamento di oggi (due fixer concorrenti).
 * Attenzione al corollario: senza `actions: read` sul workflow chiamante,
 * `gh run list` dà 403 e questo gate è inerte in silenzio — il permesso fa
 * parte del fix, non è contorno.
 *
 * Env:
 *   GH_TOKEN              necessario per gh (Actions GITHUB_TOKEN + `actions: read`).
 *   GH_REPO               opzionale `owner/repo`.
 *   ISSUE_NUMBER          la issue di questa run, da ri-accodare.
 *   GITHUB_RUN_ID         id della run corrente (Actions lo imposta da sé).
 *   GITHUB_WORKFLOW_REF   ref del workflow corrente (idem) → quale slot guardare.
 *   SLOT_WORKFLOW         override esplicito del file di workflow (test/manuale).
 *   SLOT_LBL_ACTIVE       label in volo, default `agent:fix`.
 *   SLOT_LBL_REQUEUE      label di coda, default `agent:fix-queued`.
 *   DRY_RUN               "1" → nessuna scrittura, output comunque emesso.
 *   GITHUB_OUTPUT         file di output dello step Actions.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  IN_FLIGHT_STATUSES,
  FIX_WORKFLOW_FILE,
  precedingRunIds,
  workflowFileFromRef,
} from '../lib/fixer-slot.mjs';

const DRY_RUN = process.env.DRY_RUN === '1';
const ISSUE = process.env.ISSUE_NUMBER;
const LBL_ACTIVE = process.env.SLOT_LBL_ACTIVE || 'agent:fix';
const LBL_REQUEUE = process.env.SLOT_LBL_REQUEUE || 'agent:fix-queued';
const WORKFLOW =
  process.env.SLOT_WORKFLOW ||
  workflowFileFromRef(process.env.GITHUB_WORKFLOW_REF) ||
  FIX_WORKFLOW_FILE;
const SELF_RUN_ID = Number(process.env.GITHUB_RUN_ID);

const repoArgs = process.env.GH_REPO ? ['--repo', process.env.GH_REPO] : [];

function gh(args, { allowFail = true } = {}) {
  try {
    return execFileSync('gh', args, { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    if (allowFail) return '';
    throw e;
  }
}

function setOutput(busy, holder) {
  console.log(`slot_busy=${busy} holder=${holder || ''}`);
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(
      process.env.GITHUB_OUTPUT,
      `slot_busy=${busy}\nholder=${holder || ''}\n`
    );
  }
}

function runsInFlight(workflowFile, scope = repoArgs) {
  const rows = [];
  for (const status of IN_FLIGHT_STATUSES) {
    const raw = gh([
      'run', 'list', ...scope, '--workflow', workflowFile,
      '--status', status, '--json', 'databaseId', '--limit', '20',
    ]);
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) rows.push(...parsed);
    } catch {
      // parse fault → proceed-safe: si conta ciò che si è capito.
    }
  }
  return rows;
}

/**
 * Valuta lo slot e, se occupato, RI-ACCODA la issue (commento + swap di label).
 * Esportata perché `check-quota-backoff.mjs` la compone: vedi l'header.
 *
 * @param {{issue?:string, dryRun?:boolean, repoArgs?:string[], workflow?:string, selfRunId?:number}} [opts]
 * @returns {{busy:boolean, holder:number|null, preceding:number[]}}
 */
export function evaluateFixerSlot({
  issue = ISSUE,
  dryRun = DRY_RUN,
  repoArgs: scope = repoArgs,
  workflow = WORKFLOW,
  selfRunId = SELF_RUN_ID,
  // Il chiamante composto (`check-quota-backoff.mjs`) dichiara con QUALI label
  // è in volo: lo stadio di decomposizione usa la coppia `agent:decompose*`.
  // Il default preserva il comportamento di `issue-fix.yml`.
  lblActive = LBL_ACTIVE,
  lblRequeue = LBL_REQUEUE,
} = {}) {
  // Senza un id di run non esiste un tie-break, e senza tie-break due run che
  // si vedono a vicenda si ri-accodano entrambe. Meglio procedere.
  if (!Number.isFinite(selfRunId)) {
    console.log('GITHUB_RUN_ID assente o non numerico → nessun tie-break possibile, procedo.');
    return { busy: false, holder: null, preceding: [] };
  }

  const preceding = precedingRunIds(runsInFlight(workflow, scope), selfRunId);
  if (preceding.length === 0) {
    console.log(`Nessuna run \`${workflow}\` più vecchia in volo → slot del fixer libero, procedo.`);
    return { busy: false, holder: null, preceding };
  }

  const holder = preceding[0];
  console.log(`::warning::Slot del fixer occupato: ${preceding.length} run \`${workflow}\` più vecchie in volo (la prima è ${holder}) — ri-accodo invece di spendere la quota Claude condivisa in parallelo.`);

  if (issue && !dryRun) {
    gh(['issue', 'comment', String(issue), ...scope, '--body', requeueBody(holder, preceding.length, lblRequeue)]);
    gh(['issue', 'edit', String(issue), ...scope, '--add-label', lblRequeue, '--remove-label', lblActive]);
  }

  return { busy: true, holder, preceding };
}

/** Il commento di ri-accodamento. Il marker `slot-busy` è ZERO_WORK per il
 * drainer (`followup-drainer.mjs`), gemello esatto di `rate-limited`: la run è
 * morta prima di leggere la issue, quindi **nessun tentativo consumato**. */
export function requeueBody(holder, count = 1, lblRequeue = LBL_REQUEUE) {
  return [
    '<!-- FIX_OUTCOME: slot-busy -->',
    '',
    `🔁 **Pre-flight slot (zero-Claude)**: un altro fixer è già in volo (run \`${holder}\`${count > 1 ? `, e altre ${count - 1} più vecchie` : ''}).`,
    'La quota Claude è per account ed è condivisa col ciclo del sito: due fixer in',
    'parallelo la bruciano insieme, ed è esattamente ciò che la coda',
    `\`${lblRequeue}\` esiste per evitare.`,
    '',
    '**Nessun tentativo consumato** (`fu-attempt` invariato): la issue torna in',
    `\`${lblRequeue}\` e il drainer la ripromuove appena lo slot si libera.`,
  ].join('\n');
}

function main() {
  const { busy, holder } = evaluateFixerSlot();
  setOutput(busy, holder);
}

// TOTAL / PROCEED-SAFE: un throw non gestito non deve mai congelare la coda.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (e) {
    console.error('Fixer slot gate error — procedo (fixer normale):', e && e.message ? e.message : e);
    setOutput(false, '');
    process.exit(0);
  }
}
