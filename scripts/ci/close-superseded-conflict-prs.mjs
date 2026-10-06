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
 *      per un'altra via, quindi non apre nessuna PR sostitutiva. Il verdetto
 *      conta solo se è un commento del fixer con identità trusted e senza la
 *      firma del preflight zero-Claude, e se arriva dopo l'ultima rilevazione
 *      corrente di `has-conflicts`; i preflight che emettono lo stesso marker
 *      non bastano. Il
 *      testo dell'hand-off prevede «apri la PR con Supersedes e chiudi #N»
 *      oppure «il conflitto è rientrato, chiudi senza PR»; questo terzo esito
 *      non lo prevedeva nessuno. Misurato lo stesso giorno: #2246 (hand-off
 *      #2250, verdetto alle 00:18 — «i 24 caller sono byte-identici tra main e
 *      il branch approvato») ancora aperta e in conflitto alle 03:30.
 *
 * Non esiste un terzo caso «le issue sorgente sono chiuse»: che un'altra PR
 * abbia chiuso la stessa issue non prova che abbia consegnato QUESTO
 * contenuto (due fix parziali o diversi chiudono la stessa issue), e lì questa
 * PR può essere l'unica consegna rimasta. Quelle PR restano alla classe F del
 * rescuer e a `recycle-stale-prs`.
 *
 * In entrambi i casi la PR non può più mergiare e nessuno la riprenderà:
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

import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HANDOFF_CONFLICT_LABEL,
  conflictHandoffExpectedHead,
  conflictHandoffOriginPr,
} from './check-issue-already-resolved.mjs';
import { FIX_OUTCOME_RE, lastFixOutcome } from './close-recovered-failure-issues.mjs';
import { runBudgetFromEnv } from './lib/run-budget.mjs';
import { classifyMergeTreeStatus } from './pr-autorebase.mjs';
import { handoffRouted, originContentOnMain, reapplyInFlight } from './reconcile-conflict-handoffs.mjs';
import { hasClaimLabel } from './stale-claim-detector.mjs';

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
// Costo stimato di una PR: fino a sette letture `gh` ripetute due volte e una scrittura.
const PER_PR_BUDGET_MS = 40_000;
const GH_TIMEOUT_MS = 30_000;
const GIT_TIMEOUT_MS = 60_000;

export const AUTOFIX_LABEL = 'agent:autofix';
// Lo sweep ragiona su «il contenuto è già su main»: vale solo per le PR verso main.
export const BASE_BRANCH = 'main';
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
 * letture non verificabili e rimandano al tick dopo. Anche `CONFLICTING` è
 * una cache: la candidatura apre solo la strada, e la chiusura esige in più
 * `mergeTreeAllowsClose`, cioè `git merge-tree` ricalcolato sulla HEAD.
 *
 * `allowUnknown` serve SOLO alla prima scrematura della lista: GitHub calcola
 * `mergeable` su richiesta e lo azzera a ogni push su main, e qui main riceve
 * un commit di articolo ogni pochi minuti, quindi la lista risponde quasi
 * sempre `UNKNOWN`. Con `allowUnknown` quella PR passa come «da verificare» e
 * viene riletta da sola (`rereadLivePr`, sempre stretta): senza, lo sweep
 * resterebbe inerte. Nessuna chiusura avviene mai su `UNKNOWN`. Pura.
 *
 * @param {object} pr
 * @param {{allowUnknown?: boolean}} [opts]
 * @returns {{ candidate: boolean, reason: string }}
 */
export function isSweepCandidate(pr, { allowUnknown = false } = {}) {
  const labels = labelNames(pr);
  if (!labels.includes(HANDOFF_CONFLICT_LABEL)) return { candidate: false, reason: 'no-conflict-label' };
  if (pr?.isDraft) return { candidate: false, reason: 'draft' };
  const loopPr = labels.includes(AUTOFIX_LABEL) || String(pr?.headRefName || '').startsWith('fix/');
  if (!loopPr) return { candidate: false, reason: 'not-loop-pr' };
  if (String(pr?.baseRefName || '') !== BASE_BRANCH) return { candidate: false, reason: 'base-not-main' };
  if (labels.some((name) => HANDS_OFF_LABELS.includes(name))) return { candidate: false, reason: 'hands-off-label' };
  const mergeable = String(pr?.mergeable || '').toUpperCase();
  if (mergeable === 'MERGEABLE') return { candidate: false, reason: 'mergeable-now' };
  if (mergeable === 'CONFLICTING') return { candidate: true, reason: 'conflicted-loop-pr' };
  if (allowUnknown && mergeable === 'UNKNOWN') return { candidate: true, reason: 'conflict-to-verify' };
  return { candidate: false, reason: 'conflict-unconfirmed' };
}

/**
 * Il conflitto è confermato ADESSO da `git merge-tree origin/main <HEAD>`?
 * Solo `conflicted` autorizza: `clean` (conflitto rientrato) e `unknown`
 * (oggetto mancante, fetch fallito) lasciano la PR aperta. Pura.
 */
export function mergeTreeAllowsClose(state) {
  return state === 'conflicted';
}

/** Il commento viene da un'identità che può scrivere un verdetto del fixer? Pura. */
export function isTrustedComment(comment) {
  const association = String(comment?.author_association ?? comment?.authorAssociation ?? '').toUpperCase();
  if (TRUSTED_ASSOCIATIONS.includes(association)) return true;
  const login = String(comment?.user?.login ?? comment?.author?.login ?? '');
  return TRUSTED_BOT_LOGINS.includes(login);
}

/**
 * Un `FIX_OUTCOME` è una prova del fixer solo quando la sua provenienza è
 * compatibile con issue-fix. Il preflight `check-issue-already-resolved.mjs`
 * usa il bot trusted e scrive anch'esso `already-fixed`, ma non ha eseguito il
 * fixer: per quello specifico esito scartiamo il suo marker
 * `reconcile-bot`/`Pre-flight`, mentre un commento del bot trusted senza quella
 * firma resta un verdetto del fixer. Gli altri esiti possono invece provenire
 * dal backstop deterministico del workflow e restano leggibili anche quando
 * l'autore è un bot trusted.
 * Pura.
 */
export function isTrustedFixerOutcome(comment) {
  if (!isTrustedComment(comment)) return false;
  const match = FIX_OUTCOME_RE.exec(String(comment?.body || ''));
  if (!match) return false;
  if (match[1].toLowerCase() !== SUPERSEDING_OUTCOME) return true;
  const body = String(comment?.body || '');
  if (/<!--\s*reconcile-bot\s*-->/i.test(body)) return false;
  if (/Pre-flight\s*\(auto,\s*zero-Claude\)/i.test(body)) return false;
  return true;
}

/**
 * Timestamp dell'ultima transizione della label `has-conflicts`, oppure null
 * se gli eventi non sono leggibili. Un `labeled` corrente è la prova che la
 * label non è un residuo di una rilevazione precedente: un `unlabeled` più
 * recente o nessun evento rendono il caso non chiudibile. Pura.
 */
export function latestConflictLabelEventAt(events) {
  if (!Array.isArray(events)) return null;
  let latest = null;
  for (const event of events) {
    const label = typeof event?.label === 'string' ? event.label : event?.label?.name;
    if (label !== HANDOFF_CONFLICT_LABEL) continue;
    if (event?.event !== 'labeled' && event?.event !== 'unlabeled') continue;
    const at = Date.parse(String(event?.created_at ?? event?.createdAt ?? ''));
    if (!Number.isFinite(at)) continue;
    if (!latest || at >= latest.at) latest = { event: event.event, at };
  }
  return latest?.event === 'labeled' ? latest.at : null;
}

/**
 * Caso 1: la PR riapplica una PR di origine che ha già mergiato.
 *
 * @param {object} p
 * @param {object} p.pr            la PR candidata (`headRefName`)
 * @param {object|null} p.fixerIssue  la issue del branch `fix/issue-<K>` (`title`), o null
 * @param {object|null} p.origin   la PR di origine dell'hand-off (`state`), o null
 * @param {{proven: boolean, reason?: string}|null} p.contentProof  `originContentOnMain` sui file di QUESTA PR, o null se illeggibile
 * @returns {{ close: boolean, reason: string, origin?: number, handoff?: number, detail?: string }}
 */
export function decideReapplyOfMergedOrigin({ pr, fixerIssue, origin, contentProof }) {
  const issueNumber = fixerIssueOfBranch(pr?.headRefName);
  if (issueNumber === null) return { close: false, reason: 'not-a-fixer-branch' };
  if (!fixerIssue) return { close: false, reason: 'fixer-issue-unreadable' };
  const originNumber = conflictHandoffOriginPr(fixerIssue.title);
  if (originNumber === null) return { close: false, reason: 'fixer-issue-not-a-handoff' };
  if (Number(originNumber) === Number(pr?.number)) return { close: false, reason: 'handoff-of-itself' };
  if (!origin) return { close: false, reason: 'origin-unreadable' };
  if (String(origin.state || '').toUpperCase() !== 'MERGED') return { close: false, reason: 'origin-not-merged' };
  // «L'origine ha mergiato» non basta: può aver mergiato una HEAD diversa da
  // quella dell'hand-off (force-push), o il merge può essere stato revertito,
  // e allora questa riapplicazione è l'unica consegna rimasta. La prova è sul
  // contenuto: ogni hunk di QUESTA PR deve essere già su main adesso
  // (`originContentOnMain`, la stessa del riconciliatore).
  if (!contentProof) return { close: false, reason: 'content-proof-unreadable' };
  if (contentProof.proven !== true) {
    return { close: false, reason: 'content-not-on-main', detail: String(contentProof.reason || '') };
  }
  return { close: true, reason: 'reapply-origin-merged', origin: originNumber, handoff: issueNumber };
}

/**
 * Caso 2: l'hand-off della PR è stato lavorato dal fixer e chiuso con
 * `already-fixed`, e NESSUN hand-off aperto della stessa PR è ancora attivo.
 * «Attivo» si legge sull'intera famiglia (`siblings`), non solo sul più
 * recente: pr-autorebase può aprire più hand-off per la stessa PR (una HEAD
 * nuova, due run concorrenti), e un duplicato più vecchio con un claim, in
 * coda al fixer o con una riapplicazione in volo sta ancora portando il
 * contributo. Il claim è quello del predicato condiviso `hasClaimLabel`
 * (`agent:in-progress`, ma anche `agent:local`/`agent:remote` rimaste da una
 * scrittura parziale); il routing è `handoffRouted` del riconciliatore.
 *
 * @param {object} p
 * @param {object} p.pr            la PR candidata (`number`, `headRefOid`)
 * @param {object|null} p.handoff  l'hand-off più recente della PR (`number`, `title`, `body`, `labels`, `createdAt`), o null
 * @param {Array|null} p.comments  i commenti dell'hand-off (REST), o null se illeggibili
 * @param {Array|null} p.openPrs   le PR aperte, o null se la lista è illeggibile o troncata
 * @param {Array} [p.siblings]     tutti gli hand-off della PR (`number`, `labels`, `state`); default: il solo `handoff`
 * @param {number|string|null} p.conflictDetectedAt ultima applicazione corrente di `has-conflicts`
 * @returns {{ close: boolean, reason: string, handoff?: number, active?: number }}
 */
export function decideHandoffAlreadyFixed({ pr, handoff, comments, openPrs, siblings, conflictDetectedAt }) {
  if (!handoff) return { close: false, reason: 'no-handoff' };
  if (conflictHandoffOriginPr(handoff.title) !== Number(pr?.number)) return { close: false, reason: 'handoff-of-another-pr' };
  const expectedHead = conflictHandoffExpectedHead(handoff.body);
  const head = String(pr?.headRefOid || '').toLowerCase();
  if (!expectedHead || !head || !head.startsWith(expectedHead)) return { close: false, reason: 'handoff-head-mismatch' };
  const conflictAt = typeof conflictDetectedAt === 'number'
    ? conflictDetectedAt
    : Date.parse(String(conflictDetectedAt || ''));
  if (!Number.isFinite(conflictAt)) return { close: false, reason: 'conflict-detection-unreadable' };
  if (!Array.isArray(comments)) return { close: false, reason: 'handoff-comments-unreadable' };
  if (!Array.isArray(openPrs)) return { close: false, reason: 'open-prs-unreadable' };
  const family = Array.isArray(siblings) && siblings.length ? siblings : [handoff];
  for (const member of family) {
    // Un hand-off CHIUSO ha già avuto il suo esito; conta chi è ancora aperto,
    // più quello che si sta giudicando qualunque sia il suo stato.
    const open = String(member?.state || 'OPEN').toUpperCase() === 'OPEN' || Number(member?.number) === Number(handoff.number);
    if (!open) continue;
    const active = Number(member.number);
    if (hasClaimLabel(member.labels)) return { close: false, reason: 'handoff-in-progress', active };
    if (handoffRouted(member)) return { close: false, reason: 'handoff-routed', active };
    if (reapplyInFlight(openPrs, { issueNumber: member.number, originNumber: pr.number }) !== null) {
      return { close: false, reason: 'reapply-in-flight', active };
    }
  }
  const outcome = lastFixOutcome(comments.filter(isTrustedFixerOutcome));
  if (!outcome) return { close: false, reason: 'no-trusted-verdict' };
  if (outcome.code !== SUPERSEDING_OUTCOME) return { close: false, reason: `verdict-${outcome.code}` };
  const openedAt = Date.parse(handoff.createdAt ?? handoff.created_at ?? '');
  if (!Number.isFinite(openedAt) || outcome.at === null || outcome.at <= openedAt) {
    return { close: false, reason: 'verdict-not-after-handoff' };
  }
  if (outcome.at <= conflictAt) return { close: false, reason: 'verdict-before-current-conflict' };
  return { close: true, reason: 'handoff-already-fixed', handoff: Number(handoff.number) };
}

/** Fra gli hand-off della PR (una delle due forme del titolo), il più recente. Pura. */
export function latestHandoffOf(prNumber, issues) {
  return (issues || [])
    .filter((issue) => conflictHandoffOriginPr(issue?.title) === Number(prNumber))
    .sort((a, b) => Date.parse(b?.createdAt ?? '') - Date.parse(a?.createdAt ?? ''))[0] || null;
}

const CLOSING_REASONS = Object.freeze({
  'reapply-origin-merged': ({ origin, handoff }) => `questa PR riapplicava la PR di origine **#${origin}** (hand-off #${handoff}), che nel frattempo è stata mergiata, e ogni hunk di questa PR risulta già presente su \`main\`: qui non resta niente da consegnare.`,
  'handoff-already-fixed': ({ handoff }) => `il fixer ha lavorato l'hand-off **#${handoff}** di questa PR e ha chiuso con \`FIX_OUTCOME: ${SUPERSEDING_OUTCOME}\` — il contenuto approvato era già su \`main\` per un'altra via, quindi non esiste una PR sostitutiva. La verifica del fixer è nei commenti di #${handoff}.`,
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
      // Una lettura appesa non deve consumare la deadline del passo.
      timeout: GH_TIMEOUT_MS,
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

const PR_FIELDS = 'number,title,body,baseRefName,headRefName,headRefOid,labels,isDraft,mergeable';

function listOpenPrs() {
  const prs = ghJson(['pr', 'list', '--repo', REPO, '--state', 'open', '--limit', String(OPEN_PR_LIMIT),
    '--json', PR_FIELDS]);
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

/** I file della PR con la loro patch, o null se la lettura fallisce. */
function readPrFiles(prNumber) {
  const raw = gh(['api', '--paginate', '--slurp', `repos/${REPO}/pulls/${Number(prNumber)}/files?per_page=100`]);
  if (raw === null) return null;
  try {
    const pages = JSON.parse(raw);
    return Array.isArray(pages) && pages.every(Array.isArray) ? pages.flat() : null;
  } catch {
    return null;
  }
}

/** Un file com'è su main adesso, o null. Stessa lettura del riconciliatore. */
function readMainFile(filePath) {
  const encoded = String(filePath).split('/').map(encodeURIComponent).join('/');
  return gh(['api', '-H', 'Accept: application/vnd.github.raw+json', `repos/${REPO}/contents/${encoded}?ref=${BASE_BRANCH}`]);
}

function readConflictLabelEventAt(number) {
  const raw = gh(['api', '--paginate', '--slurp', `repos/${REPO}/issues/${Number(number)}/events?per_page=100`]);
  if (raw === null) return null;
  try {
    const pages = JSON.parse(raw);
    if (!Array.isArray(pages) || !pages.every(Array.isArray)) return null;
    return latestConflictLabelEventAt(pages.flat());
  } catch {
    return null;
  }
}

/**
 * La PR com'è ADESSO, se è ancora quella giudicata (aperta, stessa HEAD,
 * ancora candidata), altrimenti null. Rende l'oggetto riletto per intero:
 * la conferma deve decidere su titolo, body e label correnti, non sullo
 * snapshot iniziale.
 */
function rereadLivePr(pr) {
  const live = ghJson(['pr', 'view', String(pr.number), '--repo', REPO, '--json', `state,${PR_FIELDS}`]);
  if (!live || String(live.state || '').toUpperCase() !== 'OPEN') return null;
  if (Number(live.number) !== Number(pr.number)) return null;
  if (String(live.headRefOid || '') !== String(pr.headRefOid || '')) return null;
  return isSweepCandidate(live).candidate ? live : null;
}

/**
 * Ricalcola il conflitto sulla HEAD della PR, senza fidarsi di label e cache:
 * fetch di `main` e della ref della PR, poi `git merge-tree`. Stesso oracolo
 * di pr-autorebase (`classifyMergeTreeStatus`). Qualunque errore → `unknown`.
 */
function mergeTreeState(pr) {
  const git = (args) => spawnSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: GIT_TIMEOUT_MS });
  const fetched = git(['fetch', '--quiet', 'origin', BASE_BRANCH, `refs/pull/${Number(pr.number)}/head`]);
  if (fetched.status !== 0) return 'unknown';
  const head = String(pr.headRefOid || '');
  if (!/^[0-9a-f]{40}$/i.test(head)) return 'unknown';
  return classifyMergeTreeStatus(git(['merge-tree', '--write-tree', `origin/${BASE_BRANCH}`, head]).status);
}

function decide(pr, openPrs) {
  const fixerIssueNumber = fixerIssueOfBranch(pr.headRefName);
  if (fixerIssueNumber !== null) {
    const fixerIssue = readFixerIssue(fixerIssueNumber);
    const originNumber = fixerIssue ? conflictHandoffOriginPr(fixerIssue.title) : null;
    const origin = originNumber !== null && originNumber !== Number(pr.number) ? readPrState(originNumber) : null;
    // La prova di contenuto costa una lettura per file: solo se l'origine è mergiata.
    const files = String(origin?.state || '').toUpperCase() === 'MERGED' ? readPrFiles(pr.number) : null;
    const contentProof = files ? originContentOnMain(files, readMainFile) : null;
    const reapply = decideReapplyOfMergedOrigin({ pr, fixerIssue, origin, contentProof });
    if (reapply.close) return reapply;
  }
  const handoffs = readHandoffs(pr.number);
  if (!Array.isArray(handoffs)) return { close: false, reason: 'handoffs-unreadable' };
  if (handoffs.length >= HANDOFF_SEARCH_LIMIT) return { close: false, reason: 'handoffs-truncated' };
  const handoff = latestHandoffOf(pr.number, handoffs);
  const conflictDetectedAt = readConflictLabelEventAt(pr.number);
  if (conflictDetectedAt === null) return { close: false, reason: 'conflict-detection-unreadable' };
  const comments = handoff ? readIssueComments(handoff.number) : null;
  const siblings = handoffs.filter((issue) => conflictHandoffOriginPr(issue?.title) === Number(pr.number));
  return decideHandoffAlreadyFixed({ pr, handoff, comments, openPrs, siblings, conflictDetectedAt });
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
  // Scrematura larga (`UNKNOWN` ammesso), verifica stretta per ogni PR sotto.
  const candidates = openPrs.filter((pr) => isSweepCandidate(pr, { allowUnknown: true }).candidate);
  const budget = runBudgetFromEnv();
  const closed = [];
  let examined = 0;
  for (const listed of candidates) {
    if (closed.length >= MAX_CLOSES_PER_RUN) {
      console.log(`::warning::close-superseded-conflict-prs: cap di ${MAX_CLOSES_PER_RUN} chiusure raggiunto — ${candidates.length - examined} PR rimandate al prossimo tick.`);
      break;
    }
    if (!budget.canAfford(PER_PR_BUDGET_MS)) {
      console.log(`::warning::close-superseded-conflict-prs: budget del job esaurito — ${candidates.length - examined} PR rimandate al prossimo tick.`);
      break;
    }
    examined += 1;
    // La lettura singola è quella che conta: stessa HEAD della lista e
    // `CONFLICTING` confermato adesso. Il ciclo prosegue sull'oggetto riletto.
    const pr = rereadLivePr(listed);
    if (!pr) {
      console.log(`PR #${listed.number}: conflitto non confermato da GitHub alla rilettura (o PR cambiata) → resta aperta.`);
      continue;
    }
    const treeState = mergeTreeState(pr);
    if (!mergeTreeAllowsClose(treeState)) {
      console.log(`PR #${pr.number}: merge-tree ${treeState} sulla HEAD corrente → conflitto non confermato, resta aperta.`);
      continue;
    }
    const decision = decide(pr, openPrs);
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
    // La conferma lavora sull'oggetto RILETTO (titolo, body, label, base di
    // adesso) e ricalcola anche merge-tree: main può essersi mosso.
    const live = rereadLivePr(pr);
    const freshOpenPrs = live && mergeTreeAllowsClose(mergeTreeState(live)) ? listOpenPrs() : null;
    const confirmed = freshOpenPrs ? decide(live, freshOpenPrs) : null;
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
