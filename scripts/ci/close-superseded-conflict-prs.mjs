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
 * lavoro è fatto. Nessuno dei due chiude la PR, e c'è un esito in cui la PR
 * resta aperta senza un proprietario:
 *
 *   `handoff-already-fixed` — il fixer ha lavorato l'hand-off della PR e ha
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
 * Due casi provati in review NON ci sono, di proposito:
 *   - «le issue sorgente sono chiuse»: che un'altra PR abbia chiuso la stessa
 *     issue non prova che abbia consegnato QUESTO contenuto (due fix parziali
 *     o diversi chiudono la stessa issue);
 *   - «la PR riapplica un'origine che ha mergiato»: l'origine può aver
 *     mergiato una HEAD diversa, o essere stata revertita. Il caso che lo
 *     aveva motivato lo smentisce: #2205 riapplicava #2201 (mergiata), ma il
 *     suo contenuto non era su main riga per riga, e qualcuno ne ha risolto il
 *     conflitto e l'ha MERGIATA alle 07:57 del 2026-10-06. Chiuderla sarebbe
 *     stato un errore, e una prova di contenuto abbastanza stretta da
 *     evitarlo (hunk per hunk, senza rimozioni, file completi, main fissato)
 *     costa più di quanto rende.
 * In entrambi la PR può essere l'unica consegna rimasta: restano alla classe
 * F del rescuer, al loro hand-off e a `recycle-stale-prs`.
 *
 * Nel caso coperto la PR non può più mergiare e nessuno la riprenderà:
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
 * Il caso coperto si fida di un verdetto del fixer, non di una prova byte a byte
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
import { classifyMergeTreeStatus, parseMergeTreeConflicts } from './pr-autorebase.mjs';
import { handoffRouted, reapplyInFlight } from './reconcile-conflict-handoffs.mjs';
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
 * `allowUnknown`: GitHub calcola `mergeable` su richiesta e lo azzera a
 * ogni push su main, e qui main riceve un commit di articolo ogni pochi
 * minuti, quindi la risposta è quasi sempre `UNKNOWN`. Con `allowUnknown`
 * quella PR passa come «da verificare»: lo usano la scrematura della lista e
 * le riletture delle invarianti, che non decidono il conflitto. A deciderlo
 * è sempre e solo `mergeTreeAllowsClose` sulla HEAD corrente: nessuna
 * chiusura avviene mai senza un merge-tree `conflicted` appena calcolato. Pura.
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

/** La ref scaricata è proprio la HEAD giudicata? Confronto sull'OID intero. Pura. */
export function mergeTreeRefMatches(fetchedOid, expectedHead) {
  const fetched = String(fetchedOid || '').trim().toLowerCase();
  const expected = String(expectedHead || '').trim().toLowerCase();
  return /^[0-9a-f]{40}$/.test(fetched) && fetched === expected;
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
export function decideHandoffAlreadyFixed({ pr, handoff, comments, openPrs, siblings, conflictDetectedAt, conflictFiles }) {
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
  // Prova fresca: i file in conflitto ADESSO (merge-tree di questa passata)
  // devono essere fra quelli dell'hand-off che il fixer ha lavorato.
  if (!conflictMatchesHandoff(conflictFiles, handoffConflictFiles(handoff.body))) {
    return { close: false, reason: 'conflict-differs-from-handoff' };
  }
  return { close: true, reason: 'handoff-already-fixed', handoff: Number(handoff.number) };
}

/**
 * I file in conflitto elencati nel corpo dell'hand-off da pr-autorebase
 * (`buildConflictHandoffIssue`: la sezione «File in conflitto:», una voce
 * `- \`path\`` per riga), o null se la sezione manca o è il segnaposto
 * «elenco non disponibile». Pura.
 */
export function handoffConflictFiles(body) {
  const text = String(body || '');
  const at = text.indexOf('File in conflitto:');
  if (at < 0) return null;
  const files = [];
  for (const line of text.slice(at).split('\n').slice(1)) {
    const match = /^- `([^`]+)`$/.exec(line.trim());
    if (match) files.push(match[1]);
    else if (line.trim() !== '' && files.length > 0) break;
    else if (line.trim() !== '') return null;
  }
  return files.length > 0 ? files : null;
}

/**
 * Il conflitto di ADESSO è quello che il fixer ha giudicato? La label
 * `has-conflicts` non lo dice: pr-autorebase non la riscrive quando c'è già,
 * quindi può venire da un conflitto precedente — rientrato senza che nessuno
 * lo vedesse e poi tornato diverso, su un main che nel frattempo ha cambiato
 * proprio il contenuto giudicato «già su main». La prova fresca è il
 * merge-tree di questa passata: ogni file oggi in conflitto deve essere fra
 * quelli che l'hand-off elencava. Un file NUOVO in conflitto è un conflitto
 * che il fixer non ha mai visto. Pura.
 */
export function conflictMatchesHandoff(currentFiles, handoffFiles) {
  if (!Array.isArray(currentFiles) || currentFiles.length === 0) return false;
  if (!Array.isArray(handoffFiles) || handoffFiles.length === 0) return false;
  const known = new Set(handoffFiles);
  return currentFiles.every((file) => known.has(file));
}

/** Fra gli hand-off della PR (una delle due forme del titolo), il più recente. Pura. */
export function latestHandoffOf(prNumber, issues) {
  return (issues || [])
    .filter((issue) => conflictHandoffOriginPr(issue?.title) === Number(prNumber))
    .sort((a, b) => Date.parse(b?.createdAt ?? '') - Date.parse(a?.createdAt ?? ''))[0] || null;
}

const CLOSING_REASONS = Object.freeze({
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
 *
 * Qui si rileggono le INVARIANTI (aperta, HEAD, base, ciclo, label, non
 * draft), non il conflitto: `mergeable=UNKNOWN` passa, perché GitHub lo
 * azzera a ogni push su main — cioè ogni pochi minuti, e pretendere
 * `CONFLICTING` a ogni rilettura lascerebbe lo sweep inerte. `MERGEABLE`
 * invece scarta. La prova del conflitto è `mergeTreeProof`, che ogni
 * chiamante esegue accanto a questa rilettura, sulla stessa HEAD.
 */
function rereadLivePr(pr) {
  const live = ghJson(['pr', 'view', String(pr.number), '--repo', REPO, '--json', `state,${PR_FIELDS}`]);
  if (!live || String(live.state || '').toUpperCase() !== 'OPEN') return null;
  if (Number(live.number) !== Number(pr.number)) return null;
  if (String(live.headRefOid || '') !== String(pr.headRefOid || '')) return null;
  return isSweepCandidate(live, { allowUnknown: true }).candidate ? live : null;
}

/**
 * Ricalcola il conflitto sulla HEAD della PR, senza fidarsi di label e cache:
 * fetch di `main` e della ref della PR, poi `git merge-tree`. Stesso oracolo
 * di pr-autorebase (`classifyMergeTreeStatus`). Qualunque errore → `unknown`.
 */
function mergeTreeProof(pr) {
  const unknown = { state: 'unknown', files: [] };
  const git = (args) => spawnSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: GIT_TIMEOUT_MS });
  const head = String(pr.headRefOid || '').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(head)) return unknown;
  // Ref temporanea e non lo SHA dello snapshot: dopo un push il clone può
  // avere ancora l'oggetto VECCHIO, e fondere quello darebbe la prova di una
  // HEAD che non è più la PR. Si fonde ciò che il fetch ha portato adesso, e
  // solo se è proprio la HEAD giudicata.
  const ref = `refs/sweep/pr-${Number(pr.number)}-head`;
  const fetched = git(['fetch', '--quiet', '--no-tags', 'origin',
    `+refs/heads/${BASE_BRANCH}:refs/remotes/origin/${BASE_BRANCH}`, `+refs/pull/${Number(pr.number)}/head:${ref}`]);
  if (fetched.status !== 0) return unknown;
  const resolved = git(['rev-parse', '--verify', '--quiet', ref]);
  if (resolved.status !== 0 || !mergeTreeRefMatches(resolved.stdout, head)) return unknown;
  const merged = git(['merge-tree', '--write-tree', `refs/remotes/origin/${BASE_BRANCH}`, ref]);
  const state = classifyMergeTreeStatus(merged.status);
  return { state, files: state === 'conflicted' ? parseMergeTreeConflicts(String(merged.stdout || '')) : [] };
}

function decide(pr, openPrs, conflictFiles) {
  const handoffs = readHandoffs(pr.number);
  if (!Array.isArray(handoffs)) return { close: false, reason: 'handoffs-unreadable' };
  if (handoffs.length >= HANDOFF_SEARCH_LIMIT) return { close: false, reason: 'handoffs-truncated' };
  const handoff = latestHandoffOf(pr.number, handoffs);
  const conflictDetectedAt = readConflictLabelEventAt(pr.number);
  if (conflictDetectedAt === null) return { close: false, reason: 'conflict-detection-unreadable' };
  const comments = handoff ? readIssueComments(handoff.number) : null;
  const siblings = handoffs.filter((issue) => conflictHandoffOriginPr(issue?.title) === Number(pr.number));
  return decideHandoffAlreadyFixed({ pr, handoff, comments, openPrs, siblings, conflictDetectedAt, conflictFiles });
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
    // Rilettura delle invarianti: stessa HEAD della lista, ancora una PR del
    // ciclo aperta verso main. Il ciclo prosegue sull'oggetto riletto; il
    // conflitto lo prova il merge-tree qui sotto.
    const pr = rereadLivePr(listed);
    if (!pr) {
      console.log(`PR #${listed.number}: cambiata o non più candidata alla rilettura → resta aperta.`);
      continue;
    }
    const proof = mergeTreeProof(pr);
    const treeState = proof.state;
    if (!mergeTreeAllowsClose(treeState)) {
      console.log(`PR #${pr.number}: merge-tree ${treeState} sulla HEAD corrente → conflitto non confermato, resta aperta.`);
      continue;
    }
    const decision = decide(pr, openPrs, proof.files);
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
    const liveProof = live ? mergeTreeProof(live) : null;
    const freshOpenPrs = liveProof && mergeTreeAllowsClose(liveProof.state) ? listOpenPrs() : null;
    const confirmed = freshOpenPrs ? decide(live, freshOpenPrs, liveProof.files) : null;
    if (!confirmed?.close || confirmed.reason !== decision.reason) {
      console.log(`PR #${pr.number}: stato cambiato fra la decisione e la chiusura (${confirmed?.reason || 'PR non più candidata'}) → resta aperta.`);
      continue;
    }
    // Commento e chiusura in UNA chiamata, senza `--delete-branch`: una close
    // fallita non lascia un commento che il tick successivo ripeterebbe.
    // ── Guardia finale ───────────────────────────────────────────────────
    // La conferma qui sopra ha rifatto TUTTE le prove sull'oggetto riletto
    // (rilettura della PR, merge-tree, hand-off, verdetto, contenuto), ma
    // `decide` fa letture anche lunghe: mentre giravano main può essersi
    // mosso e la HEAD può essere cambiata. Quindi, nell'ordine:
    //   1. merge-tree un'altra volta, contro il main di ADESSO, tenendo anche
    //      i FILE: se main si è mosso e un file nuovo è entrato in conflitto,
    //      lo stato resta `conflicted` ma non è più il conflitto che la
    //      conferma ha giudicato. I file di adesso devono essere fra quelli
    //      della conferma, che a loro volta erano fra quelli dell'hand-off;
    //   2. per ULTIMA la rilettura della PR — stessa HEAD, ancora candidata
    //      stretta — e subito dopo la close, senza nient'altro in mezzo.
    //
    // FINESTRA RESIDUA, per costruzione: `gh pr close` non accetta una HEAD
    // attesa né altre precondizioni, quindi un confronto-e-scambio atomico
    // non esiste. Fra la rilettura del punto 2 e la close resta il tempo di
    // UNA chiamata API; un claim o un hand-off nato dopo la conferma resta
    // invisibile, e rifare `decide` qui allargherebbe la finestra invece di
    // chiuderla (è la lettura lunga da cui questa guardia protegge). Il costo
    // di perdere quella corsa è limitato dal disegno: il branch non viene
    // cancellato, la chiusura lascia un commento con la ragione, e
    // `gh pr reopen` la annulla.
    const finalProof = mergeTreeProof(live);
    if (!mergeTreeAllowsClose(finalProof.state)
      || !conflictMatchesHandoff(finalProof.files, liveProof.files)
      || !rereadLivePr(live)) {
      console.log(`PR #${pr.number}: main, HEAD o stato cambiati durante la conferma → resta aperta.`);
      continue;
    }
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
