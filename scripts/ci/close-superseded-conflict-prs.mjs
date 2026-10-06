#!/usr/bin/env node
/**
 * close-superseded-conflict-prs.mjs — chiude le PR del ciclo in conflitto con
 * `main` che non hanno più niente da consegnare (zero-Claude).
 *
 * ## Il buco che chiude
 *
 * Una PR in conflitto non riceve più eventi `pull_request`: nessun test, nessuna
 * review, nessun fixer, e l'auto-merge nativo non la prende. `pr-autorebase.mjs`
 * la etichetta `has-conflicts` e, dopo un `## LGTM`, apre l'hand-off
 * «Conflitto con main dopo LGTM: riapplicare la PR #N su main» per issue-fix.
 * `reconcile-conflict-handoffs.mjs` chiude poi le ISSUE di hand-off il cui
 * lavoro è fatto. Nessuno dei due chiude la PR, e ci sono due esiti in cui la
 * PR resta aperta senza un proprietario:
 *
 *   1. `reapply-origin-merged` — la PR è essa stessa una riapplicazione
 *      (`fix/issue-<K>`, con #K hand-off della PR di origine #N) e #N nel
 *      frattempo ha mergiato: il contributo è su `main` dal ramo originale.
 *      Misurato il 2026-10-06: #2205 riapplicava #2201, mergiata alle 15:44;
 *      #2205 è rimasta aperta 13 ore, in conflitto, con l'auto-merge armato, e
 *      pr-autorebase le ha aperto un SECONDO hand-off (#2209).
 *
 *   2. `handoff-already-fixed` — il fixer ha lavorato l'hand-off della PR e ha
 *      chiuso con `FIX_OUTCOME: already-fixed`: il contenuto era già su `main`
 *      per un'altra via, quindi non apre nessuna PR sostitutiva. Il testo
 *      dell'hand-off prevede «apri la PR con Supersedes e chiudi #N» oppure
 *      «il conflitto è rientrato, chiudi senza PR»; questo terzo esito non lo
 *      prevedeva nessuno. Misurato lo stesso giorno: #2246 (hand-off #2250,
 *      verdetto alle 00:18 — «i 24 caller sono byte-identici tra main e il
 *      branch approvato») ancora aperta e in conflitto alle 03:30.
 *
 *   3. `source-issues-delivered` — la PR dichiara `Closes #X`, ogni issue che
 *      dichiara di chiudere è già CHIUSA e per ognuna un'ALTRA PR mergiata
 *      dichiara di chiuderla. `recycle-stale-prs` ricicla solo con
 *      la issue sorgente ancora OPEN (deve ri-accodarla), quindi una PR in
 *      conflitto con la sorgente chiusa non la riprende nessuno, mai. È la
 *      fine attesa dei duplicati: il 2026-10-05 una sola causa ha aperto una
 *      issue per caller cantonale e sei PR sugli stessi 26 file (#2245 e
 *      #2248 mergiate, #2246 #2247 #2249 #2251 #2255 in conflitto). Una
 *      issue chiusa a mano, `not planned` o dal solo ritorno al verde del
 *      workflow NON basta: lì la PR può essere l'unica consegna rimasta.
 *
 * In tutti e tre i casi la PR non può più mergiare e nessuno la riprenderà:
 * `recycle-stale-prs` vuole `stale-review` da oltre 24 ore e la sorgente OPEN.
 *
 * ## Cosa NON fa
 *
 * Non tocca le PR umane (solo `agent:autofix` o branch `fix/*`, la stessa prova
 * di provenienza di `stale-pr-rescuer.yml`), le draft, le `needs-human` e le
 * `keep-open`. Non cancella il branch: una chiusura sbagliata si annulla con
 * `gh pr reopen`. Non chiude issue — l'hand-off resta a
 * `reconcile-conflict-handoffs.mjs`, che dopo la grazia sull'origine chiusa
 * decide da sé, e la issue sorgente della PR resta al suo ciclo.
 *
 * Il caso 2 si fida di un verdetto del fixer, non di una prova byte a byte
 * (`originContentOnMain` del riconciliatore fallirebbe proprio sul residuo di
 * sola prosa che il fixer ha giudicato equivalente). Per questo è stretto: il
 * verdetto deve essere l'ULTIMO dell'hand-off, successivo alla sua apertura,
 * scritto da un'identità con accesso in scrittura, e l'hand-off deve riferirsi
 * alla HEAD che la PR ha adesso. Una HEAD nuova è un contributo nuovo.
 *
 * Qualunque lettura fallita → la PR resta com'è.
 *
 * Uso:  node scripts/ci/close-superseded-conflict-prs.mjs
 * Env:  GH_TOKEN (pull-requests: write, issues: read), GH_REPO o
 *       GITHUB_REPOSITORY, DRY_RUN=1|true (solo log), CI_JOB_DEADLINE_EPOCH.
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HANDOFF_CONFLICT_LABEL,
  conflictHandoffExpectedHead,
  conflictHandoffOriginPr,
} from './check-issue-already-resolved.mjs';
import { lastFixOutcome } from './close-recovered-failure-issues.mjs';
import { closedIssueRefs, closingMergedPr } from './followup-resolution-match.mjs';
import { runBudgetFromEnv } from './lib/run-budget.mjs';
import { reapplyInFlight } from './reconcile-conflict-handoffs.mjs';
import { CLAIM_LABEL } from './stale-claim-detector.mjs';

const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';
const REPO = process.env.GH_REPO || process.env.GITHUB_REPOSITORY || '';

export const SUPERSEDED_MARKER = '<!-- SUPERSEDED_CONFLICT_PR -->';
// Bound per run (AGENTS.md no-silent-cap): le eccedenze sono loggate e restano
// al tick successivo di pr-autorebase.yml.
export const MAX_CLOSES_PER_RUN = 10;
// Le PR aperte lette in una passata. Oltre questa soglia la lista è troncata e
// la ricerca di una riapplicazione in volo non è più affidabile: fail-closed.
export const OPEN_PR_LIMIT = 200;
// Gli hand-off letti per PR: uno per HEAD andata in conflitto, quindi pochi.
// Una lista piena puo' avere tagliato il piu' recente: fail-closed.
export const HANDOFF_SEARCH_LIMIT = 100;
// Le PR mergiate lette per il caso 3, stessa finestra del riconciliatore.
export const MERGED_PR_WINDOW = 200;
// Costo stimato di una PR: fino a sei letture `gh` ripetute due volte e una scrittura.
const PER_PR_BUDGET_MS = 40_000;

export const AUTOFIX_LABEL = 'agent:autofix';
// Label con cui una PR è dichiarata fuori dal ciclo automatico.
export const HANDS_OFF_LABELS = Object.freeze(['needs-human', 'keep-open']);
// Chi può scrivere un verdetto: il fixer commenta con l'identità del
// proprietario o con `github-actions[bot]`. Su un repo pubblico chiunque può
// commentare una issue, e un marker incollato da fuori non deve chiudere una PR.
export const TRUSTED_ASSOCIATIONS = Object.freeze(['OWNER', 'MEMBER', 'COLLABORATOR']);
export const TRUSTED_BOT_LOGINS = Object.freeze(['github-actions[bot]', 'frontaliere-automation[bot]']);
export const SUPERSEDING_OUTCOME = 'already-fixed';

const FIXER_BRANCH_RE = /^fix\/issue-(\d+)$/;

const labelNames = (item) => (item?.labels || [])
  .map((label) => (typeof label === 'string' ? label : label?.name))
  .filter(Boolean);

/**
 * Coda comune ai due titoli di hand-off («Conflitto con main[ dopo LGTM]:
 * riapplicare la PR #N su main»): è la chiave di ricerca, mentre
 * l'appartenenza la decide `conflictHandoffOriginPr`, che ha la regex. Pura.
 */
export function handoffTitleQuery(prNumber) {
  return `riapplicare la PR #${Number(prNumber)} su main`;
}

/** Numero della issue lavorata dal branch del fixer (`fix/issue-<K>`), o null. Pura. */
export function fixerIssueOfBranch(branch) {
  const match = FIXER_BRANCH_RE.exec(String(branch || ''));
  return match ? Number(match[1]) : null;
}

/**
 * La PR è un candidato dello sweep? Solo PR del ciclo, in conflitto secondo
 * merge-tree (`has-conflicts`), non draft e non dichiarate fuori dal ciclo.
 * La label da sola non basta: e' una fotografia del tick precedente, e questo
 * sweep gira anche quando l'autorebase che la ricalcola e' fallito. Serve la
 * conferma indipendente di GitHub, `mergeable === 'CONFLICTING'`; `UNKNOWN`
 * (la risposta tipica subito dopo un push su main) o un campo assente sono
 * letture non verificabili e rimandano al tick dopo. Pura.
 *
 * @returns {{ candidate: boolean, reason: string }}
 */
export function isSweepCandidate(pr) {
  const labels = labelNames(pr);
  if (!labels.includes(HANDOFF_CONFLICT_LABEL)) return { candidate: false, reason: 'no-conflict-label' };
  if (pr?.isDraft) return { candidate: false, reason: 'draft' };
  const loopPr = labels.includes(AUTOFIX_LABEL) || String(pr?.headRefName || '').startsWith('fix/');
  if (!loopPr) return { candidate: false, reason: 'not-loop-pr' };
  if (labels.some((name) => HANDS_OFF_LABELS.includes(name))) return { candidate: false, reason: 'hands-off-label' };
  const mergeable = String(pr?.mergeable || '').toUpperCase();
  if (mergeable === 'MERGEABLE') return { candidate: false, reason: 'mergeable-now' };
  if (mergeable !== 'CONFLICTING') return { candidate: false, reason: 'conflict-unconfirmed' };
  return { candidate: true, reason: 'conflicted-loop-pr' };
}

/** Il commento viene da un'identità che può scrivere un verdetto del fixer? Pura. */
export function isTrustedComment(comment) {
  const association = String(comment?.author_association ?? comment?.authorAssociation ?? '').toUpperCase();
  if (TRUSTED_ASSOCIATIONS.includes(association)) return true;
  const login = String(comment?.user?.login ?? comment?.author?.login ?? '');
  return TRUSTED_BOT_LOGINS.includes(login);
}

/**
 * Caso 1: la PR riapplica una PR di origine che ha già mergiato.
 *
 * @param {object} p
 * @param {object} p.pr            la PR candidata (`headRefName`)
 * @param {object|null} p.fixerIssue  la issue del branch `fix/issue-<K>` (`title`), o null
 * @param {object|null} p.origin   la PR di origine dell'hand-off (`state`), o null
 * @returns {{ close: boolean, reason: string, origin?: number, handoff?: number }}
 */
export function decideReapplyOfMergedOrigin({ pr, fixerIssue, origin }) {
  const issueNumber = fixerIssueOfBranch(pr?.headRefName);
  if (issueNumber === null) return { close: false, reason: 'not-a-fixer-branch' };
  if (!fixerIssue) return { close: false, reason: 'fixer-issue-unreadable' };
  const originNumber = conflictHandoffOriginPr(fixerIssue.title);
  if (originNumber === null) return { close: false, reason: 'fixer-issue-not-a-handoff' };
  if (Number(originNumber) === Number(pr?.number)) return { close: false, reason: 'handoff-of-itself' };
  if (!origin) return { close: false, reason: 'origin-unreadable' };
  if (String(origin.state || '').toUpperCase() !== 'MERGED') return { close: false, reason: 'origin-not-merged' };
  return { close: true, reason: 'reapply-origin-merged', origin: originNumber, handoff: issueNumber };
}

/**
 * Caso 2: l'hand-off della PR è stato lavorato dal fixer e chiuso con
 * `already-fixed`, senza una riapplicazione in volo.
 *
 * @param {object} p
 * @param {object} p.pr            la PR candidata (`number`, `headRefOid`)
 * @param {object|null} p.handoff  l'hand-off più recente della PR (`number`, `title`, `body`, `labels`, `createdAt`), o null
 * @param {Array|null} p.comments  i commenti dell'hand-off (REST), o null se illeggibili
 * @param {Array|null} p.openPrs   le PR aperte, o null se la lista è illeggibile o troncata
 * @returns {{ close: boolean, reason: string, handoff?: number }}
 */
export function decideHandoffAlreadyFixed({ pr, handoff, comments, openPrs }) {
  if (!handoff) return { close: false, reason: 'no-handoff' };
  if (conflictHandoffOriginPr(handoff.title) !== Number(pr?.number)) return { close: false, reason: 'handoff-of-another-pr' };
  const expectedHead = conflictHandoffExpectedHead(handoff.body);
  const head = String(pr?.headRefOid || '').toLowerCase();
  if (!expectedHead || !head || !head.startsWith(expectedHead)) return { close: false, reason: 'handoff-head-mismatch' };
  if (labelNames(handoff).includes(CLAIM_LABEL)) return { close: false, reason: 'handoff-in-progress' };
  if (!Array.isArray(comments)) return { close: false, reason: 'handoff-comments-unreadable' };
  if (!Array.isArray(openPrs)) return { close: false, reason: 'open-prs-unreadable' };
  if (reapplyInFlight(openPrs, { issueNumber: handoff.number, originNumber: pr.number }) !== null) {
    return { close: false, reason: 'reapply-in-flight' };
  }
  const outcome = lastFixOutcome(comments.filter(isTrustedComment));
  if (!outcome) return { close: false, reason: 'no-trusted-verdict' };
  if (outcome.code !== SUPERSEDING_OUTCOME) return { close: false, reason: `verdict-${outcome.code}` };
  const openedAt = Date.parse(handoff.createdAt ?? handoff.created_at ?? '');
  if (!Number.isFinite(openedAt) || outcome.at === null || outcome.at <= openedAt) {
    return { close: false, reason: 'verdict-not-after-handoff' };
  }
  return { close: true, reason: 'handoff-already-fixed', handoff: Number(handoff.number) };
}

/** Fra gli hand-off della PR (una delle due forme del titolo), il più recente. Pura. */
export function latestHandoffOf(prNumber, issues) {
  return (issues || [])
    .filter((issue) => conflictHandoffOriginPr(issue?.title) === Number(prNumber))
    .sort((a, b) => Date.parse(b?.createdAt ?? '') - Date.parse(a?.createdAt ?? ''))[0] || null;
}

/**
 * Caso 3: ogni issue che la PR dichiara di chiudere è già chiusa E per ognuna
 * esiste un'ALTRA PR mergiata che dichiara di chiuderla. La sola chiusura non
 * basta: una issue si chiude anche a mano o come `not planned`, e lì questa PR
 * può essere l'unico percorso di consegna rimasto. La PR mergiata è la prova
 * che il lavoro è arrivato su `main` per un'altra via. Senza nessuna keyword
 * di chiusura non c'è una sorgente da cui dedurre niente.
 *
 * @param {object} p
 * @param {object} p.pr  la PR candidata (`number`, `title`, `body`)
 * @param {(n: number) => ({state?: string}|null)} p.readIssue  lettura di una issue, `null` se illeggibile
 * @param {Array<{number: number, title?: string, body?: string}>|null} p.mergedPrs  le PR mergiate recenti, o null se illeggibili
 * @returns {{ close: boolean, reason: string, issues?: number[], deliveredBy?: number[] }}
 */
export function decideSourceIssuesClosed({ pr, readIssue, mergedPrs }) {
  const refs = closedIssueRefs(`${pr?.title || ''}\n${pr?.body || ''}`);
  if (!refs.length) return { close: false, reason: 'no-closing-keyword' };
  if (!Array.isArray(mergedPrs)) return { close: false, reason: 'merged-prs-unreadable' };
  const others = mergedPrs.filter((merged) => Number(merged?.number) !== Number(pr?.number));
  const deliveredBy = [];
  for (const number of refs) {
    const issue = readIssue(number);
    if (!issue) return { close: false, reason: 'source-issue-unreadable' };
    if (String(issue.state || '').toUpperCase() !== 'CLOSED') return { close: false, reason: 'source-issue-open' };
    const delivered = closingMergedPr(number, others);
    if (delivered === null) return { close: false, reason: 'source-issue-not-delivered' };
    deliveredBy.push(Number(delivered));
  }
  return { close: true, reason: 'source-issues-delivered', issues: refs, deliveredBy: [...new Set(deliveredBy)] };
}

const CLOSING_REASONS = Object.freeze({
  'reapply-origin-merged': ({ origin, handoff }) => `questa PR riapplicava la PR di origine **#${origin}** (hand-off #${handoff}), che nel frattempo è stata mergiata: il contributo è su \`main\` dal ramo originale e qui non resta niente da consegnare.`,
  'handoff-already-fixed': ({ handoff }) => `il fixer ha lavorato l'hand-off **#${handoff}** di questa PR e ha chiuso con \`FIX_OUTCOME: ${SUPERSEDING_OUTCOME}\` — il contenuto approvato era già su \`main\` per un'altra via, quindi non esiste una PR sostitutiva. La verifica del fixer è nei commenti di #${handoff}.`,
  'source-issues-delivered': ({ issues, deliveredBy }) => `ogni issue che dichiara di chiudere (${(issues || []).map((n) => `#${n}`).join(', ')}) è già chiusa da un'altra PR mergiata (${(deliveredBy || []).map((n) => `#${n}`).join(', ')}): il lavoro è su \`main\` per un'altra via, e \`recycle-stale-prs\` non può riciclarla perché ri-accoda solo una sorgente ancora aperta.`,
});

/** Commento lasciato sulla PR alla chiusura. Pura. */
export function closingComment(decision) {
  const why = CLOSING_REASONS[decision?.reason]?.(decision);
  if (!why) throw new Error(`ragione di chiusura sconosciuta: ${decision?.reason}`);
  return [
    SUPERSEDED_MARKER,
    `♻️ **PR superata, chiusa in automatico**: è in conflitto con \`main\` (nessun workflow \`pull_request\` può più partire, l'auto-merge non la prenderà) e ${why}`,
    '',
    'Il branch NON è stato cancellato. Se la chiusura è sbagliata: `gh pr reopen` e risolvi il conflitto sul branch.',
    '',
    '_Segnale deterministico da `scripts/ci/close-superseded-conflict-prs.mjs` (zero-Claude)._',
  ].join('\n');
}

function gh(args) {
  try {
    return execFileSync('gh', args, {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return null;
  }
}

function ghJson(args) {
  const raw = gh(args);
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function listOpenPrs() {
  const prs = ghJson(['pr', 'list', '--repo', REPO, '--state', 'open', '--limit', String(OPEN_PR_LIMIT),
    '--json', 'number,title,body,headRefName,headRefOid,labels,isDraft,mergeable']);
  if (!Array.isArray(prs)) return null;
  if (prs.length >= OPEN_PR_LIMIT) {
    console.log(`::warning::close-superseded-conflict-prs: ${prs.length} PR aperte, lista forse troncata → nessuna chiusura.`);
    return null;
  }
  return prs;
}

function readFixerIssue(number) {
  return ghJson(['issue', 'view', String(number), '--repo', REPO, '--json', 'number,title,state']);
}

function readPrState(number) {
  return ghJson(['pr', 'view', String(number), '--repo', REPO, '--json', 'number,state,mergedAt']);
}

function readHandoffs(prNumber) {
  return ghJson(['issue', 'list', '--repo', REPO, '--state', 'all', '--limit', String(HANDOFF_SEARCH_LIMIT),
    '--search', `"${handoffTitleQuery(prNumber)}" in:title`,
    '--json', 'number,title,body,labels,createdAt,state']);
}

function readIssueComments(number) {
  const raw = gh(['api', '--paginate', '--slurp', `repos/${REPO}/issues/${Number(number)}/comments?per_page=100`]);
  if (raw === null) return null;
  try {
    const pages = JSON.parse(raw);
    return Array.isArray(pages) && pages.every(Array.isArray) ? pages.flat() : null;
  } catch {
    return null;
  }
}

/** La PR è ancora quella che è stata giudicata? Rilettura subito prima di chiudere. */
function stillSameOpenPr(pr) {
  const live = ghJson(['pr', 'view', String(pr.number), '--repo', REPO, '--json', 'state,headRefOid,labels,isDraft,mergeable,headRefName']);
  if (!live || String(live.state || '').toUpperCase() !== 'OPEN') return false;
  if (String(live.headRefOid || '') !== String(pr.headRefOid || '')) return false;
  return isSweepCandidate({ ...live, number: pr.number }).candidate;
}

function listMergedPrs(memo) {
  if (!memo.read) {
    memo.read = true;
    memo.value = ghJson(['pr', 'list', '--repo', REPO, '--state', 'merged',
      '--limit', String(MERGED_PR_WINDOW), '--json', 'number,title,body']);
  }
  return Array.isArray(memo.value) ? memo.value : null;
}

function decide(pr, openPrs, mergedMemo) {
  const fixerIssueNumber = fixerIssueOfBranch(pr.headRefName);
  if (fixerIssueNumber !== null) {
    const fixerIssue = readFixerIssue(fixerIssueNumber);
    const originNumber = fixerIssue ? conflictHandoffOriginPr(fixerIssue.title) : null;
    const origin = originNumber !== null && originNumber !== Number(pr.number) ? readPrState(originNumber) : null;
    const reapply = decideReapplyOfMergedOrigin({ pr, fixerIssue, origin });
    if (reapply.close) return reapply;
  }
  const handoffs = readHandoffs(pr.number);
  if (!Array.isArray(handoffs)) return { close: false, reason: 'handoffs-unreadable' };
  if (handoffs.length >= HANDOFF_SEARCH_LIMIT) return { close: false, reason: 'handoffs-truncated' };
  const handoff = latestHandoffOf(pr.number, handoffs);
  const comments = handoff ? readIssueComments(handoff.number) : null;
  const alreadyFixed = decideHandoffAlreadyFixed({ pr, handoff, comments, openPrs });
  if (alreadyFixed.close) return alreadyFixed;
  // Un hand-off in lavorazione o una riapplicazione in volo hanno la
  // precedenza anche sul caso 3: c'è qualcuno che sta portando il contributo.
  if (['handoff-in-progress', 'reapply-in-flight'].includes(alreadyFixed.reason)) return alreadyFixed;
  const sourceClosed = decideSourceIssuesClosed({ pr, readIssue: readFixerIssue, mergedPrs: listMergedPrs(mergedMemo) });
  return sourceClosed.close ? sourceClosed : alreadyFixed;
}

function main() {
  if (!REPO) {
    console.log('::warning::close-superseded-conflict-prs: GH_REPO/GITHUB_REPOSITORY non impostato → nessuna modifica.');
    return;
  }
  const openPrs = listOpenPrs();
  if (openPrs === null) {
    console.log('::warning::close-superseded-conflict-prs: PR aperte illeggibili → nessuna modifica.');
    return;
  }
  const candidates = openPrs.filter((pr) => isSweepCandidate(pr).candidate);
  const budget = runBudgetFromEnv();
  const closed = [];
  const mergedMemo = {};
  let examined = 0;
  for (const pr of candidates) {
    if (closed.length >= MAX_CLOSES_PER_RUN) {
      console.log(`::warning::close-superseded-conflict-prs: cap di ${MAX_CLOSES_PER_RUN} chiusure raggiunto — ${candidates.length - examined} PR rimandate al prossimo tick.`);
      break;
    }
    if (!budget.canAfford(PER_PR_BUDGET_MS)) {
      console.log(`::warning::close-superseded-conflict-prs: budget del job esaurito — ${candidates.length - examined} PR rimandate al prossimo tick.`);
      break;
    }
    examined += 1;
    const decision = decide(pr, openPrs, mergedMemo);
    if (!decision.close) {
      console.log(`PR #${pr.number}: in conflitto, resta aperta (${decision.reason}).`);
      continue;
    }
    if (DRY_RUN) {
      console.log(`[dry] chiuderei PR #${pr.number} (${decision.reason}).`);
      closed.push({ pr, decision });
      continue;
    }
    // Fra la decisione e la chiusura possono cambiare la PR (HEAD, label,
    // mergeability) ma anche le sue prove: un claim sull'hand-off, una
    // riapplicazione appena aperta, una issue sorgente riaperta. Si rilegge
    // TUTTO e si chiude solo se la stessa ragione regge ancora.
    const freshOpenPrs = stillSameOpenPr(pr) ? listOpenPrs() : null;
    const confirmed = freshOpenPrs ? decide(pr, freshOpenPrs, mergedMemo) : null;
    if (!confirmed?.close || confirmed.reason !== decision.reason) {
      console.log(`PR #${pr.number}: stato cambiato fra la decisione e la chiusura (${confirmed?.reason || 'PR non più candidata'}) → resta aperta.`);
      continue;
    }
    // Commento e chiusura in UNA chiamata, senza `--delete-branch`: una close
    // fallita non lascia un commento che il tick successivo ripeterebbe.
    if (gh(['pr', 'close', String(pr.number), '--repo', REPO, '--comment', closingComment(decision)]) === null) {
      console.log(`::warning::PR #${pr.number}: chiusura fallita (${decision.reason}) → ritento al prossimo tick.`);
      continue;
    }
    closed.push({ pr, decision });
    console.log(`PR #${pr.number}: chiusa come superata (${decision.reason}).`);
  }
  console.log(`PR del ciclo in conflitto: ${candidates.length} candidate, ${closed.length} chiuse${DRY_RUN ? ' (dry-run)' : ''}.`);
}

// Best-effort: un errore non deve far fallire il job di pr-autorebase.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.log(`::warning::close-superseded-conflict-prs: ${error?.message || error} → nessuna modifica ulteriore.`);
  }
}
