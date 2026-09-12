#!/usr/bin/env node
/**
 * check-quota-backoff.mjs — zero-Claude PRE-FLIGHT gate per issue-fix.yml.
 *
 * STRUCTURAL fix per la classe misurata il 2026-08-05 sul tracker #1951: nella
 * finestra 7gg 2026-07-29 → 2026-08-05, `issue-fix.yml` ha registrato 61 run
 * fallite su 117 reali (52%) e **60 di quelle 61 sono HTTP 429** (quota Max
 * settimanale esaurita), con `num_turns: 1` e `total_cost_usd: 0` — cioè Claude
 * non ha mai eseguito. Zero `error_max_turns`, zero fallimenti di push/PR, zero
 * timeout. Rationale completo + catena assorbente in `claude-rate-limit.mjs`.
 *
 * Il punto che questo gate risolve: **49 delle 61 run fallite (80%) sono
 * avvenute dentro una finestra di rate-limit GIÀ APERTA da un fallimento
 * precedente**. Erano deterministicamente prevedibili — il payload del 429
 * dichiara `resetsAt`, l'epoch esatto in cui la quota torna — eppure il loop
 * continuava a promuovere una issue dopo l'altra ogni ~5 minuti contro un muro
 * noto, ognuna bruciando lo slot serializzato `concurrency: issue-fix` e
 * ritardando tutta la coda.
 *
 * ## Come funziona il beacon (nessuno store esterno)
 *
 * Non serve una variabile di repo né un file committato: la finestra vive già
 * sulle issue. Quando una run muore di 429, il fixer posta sulla issue
 * `<!-- FIX_OUTCOME: rate-limited -->` + `<!-- QUOTA_RESETS_AT: <epoch> -->`.
 * Quel commento È il beacon. Questo gate cerca il beacon più recente fra le
 * issue attualmente in lavorazione/coda (`agent:fix` / `agent:fix-queued`) e, se
 * la scadenza non è passata, corto-circuita la run PRIMA dello step Claude.
 *
 * La ricerca è bounded per costo: solo issue toccate nelle ultime
 * `QUOTA_BEACON_LOOKBACK_H` ore (un beacon è fresco per definizione), ordinate
 * dalla più recente, cap `QUOTA_BEACON_MAX_ISSUES` letture dei commenti. Il
 * gate guarda sia issue sia PR: il rimborso dei fixer di PR scrive il beacon
 * sull'issue/PR GitHub della PR, che `gh issue list` non restituisce. In regime
 * normale la coda tiene 1-2 issue/PR con quelle label, quindi il gate resta
 * bounded.
 *
 * Output (GITHUB_OUTPUT): `quota_blocked=true|false`, `resets_at=<epoch|''>`.
 *   - true  → finestra aperta: la issue viene RI-ACCODATA (`agent:fix` →
 *             `agent:fix-queued`) e il workflow salta ogni step Claude. Nessun
 *             tentativo consumato: la run non ha letto la issue, non è un
 *             fallimento del fixer.
 *   - false → nessuna finestra attiva → il fixer gira invariato.
 *
 * PROCEED-SAFE (stesso contratto di check-issue-already-resolved.mjs /
 * check-workflows-scope.mjs / claim-issue-in-flight.mjs): qualunque errore
 * gh/API/parse → `quota_blocked=false`. Un gate rotto non deve MAI congelare la
 * coda; al massimo si torna al comportamento pre-fix (una run sprecata).
 *
 * Env:
 *   GH_TOKEN                  necessario per gh (Actions GITHUB_TOKEN basta).
 *   GH_REPO                   opzionale `owner/repo`.
 *   ISSUE_NUMBER              opzionale: la issue di questa run, da ri-accodare.
 *   QUOTA_BEACON_LOOKBACK_H   default 24.
 *   QUOTA_BEACON_MAX_ISSUES   default 12.
 *   QUOTA_BEACON_PEER_REPO    opzionale `owner/repo` il cui beacon viene
 *                             ONORATO (mai scritto). Impostato solo su questo
 *                             repo → precedenza a senso unico verso il sito.
 *                             Vedi il blocco su PEER_REPO piu' sotto.
 *   DRY_RUN                   "1" → nessuna scrittura, output comunque emesso.
 *   GITHUB_OUTPUT             file di output dello step Actions.
 */

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isBackoffActive, maxQuotaResetsAt } from './claude-rate-limit.mjs';

const DRY_RUN = process.env.DRY_RUN === '1';
const CODEX_FALLBACK_MODE = process.env.CODEX_FALLBACK_MODE === '1';
const ISSUE = process.env.ISSUE_NUMBER;
const LOOKBACK_H = Number(process.env.QUOTA_BEACON_LOOKBACK_H || 24);
const MAX_ISSUES = Number(process.env.QUOTA_BEACON_MAX_ISSUES || 12);
const LBL_FIX = 'agent:fix';
const LBL_QUEUED = 'agent:fix-queued';
// Stadio di decomposizione (2026-08-21): stesso gate, label diverse. Il
// chiamante (`issue-decompose.yml`) dichiara con QUALI label questa run è in
// volo e in quale coda va ri-accodata; il default preserva il comportamento
// di `issue-fix.yml`. La SCANSIONE del beacon copre sempre entrambe le
// famiglie: la quota è una sola. Una label inesistente costa una lista
// fallita → vuota (allowFail).
const LBL_ACTIVE = process.env.QUOTA_LBL_ACTIVE || LBL_FIX;
const LBL_REQUEUE = process.env.QUOTA_LBL_REQUEUE || LBL_QUEUED;
const LBL_DECOMP = 'agent:decompose';
const LBL_DECOMP_QUEUED = 'agent:decompose-queued';

const repoArgs = process.env.GH_REPO ? ['--repo', process.env.GH_REPO] : [];

// ── Shared zero-Claude lease (#8365) ─────────────────────────────────────────
//
// The quota beacon answers "is the provider currently rate-limited?".  It does
// not answer the more important admission question: which one of the local
// Claude consumers owns the next attempt?  The lease is deliberately stored in
// the same durable, already-observable surface as the beacon — issue/PR
// comments — so no repository variable, secret, issue tracker or manifest
// rewrite is needed.  A lease is an append-only event stream keyed by token;
// the latest event for a token is its state.  Expiry is part of every event and
// therefore releases a dead runner without a cleanup workflow.
export const QUOTA_LEASE_MARKER = '<!-- CLAUDE_QUOTA_LEASE:';
const QUOTA_LEASE_STATES = new Set(['reserved', 'active', 'consumed', 'released']);
const QUOTA_LEASE_LIVE_STATES = new Set(['reserved', 'active', 'consumed']);
const QUOTA_LEASE_TARGET_TYPES = new Set(['issue', 'pr']);
const QUOTA_LEASE_TRUSTED_ACTOR_RE = /^(?:github-actions\[bot\]|frontaliere-automation(?:\[bot\])?|claude(?:\[bot\])?|nanakokyobashi-rgb|valerielinc-ops)$/i;
const QUOTA_LEASE_RE = /<!-- CLAUDE_QUOTA_LEASE:\s*(\{[\s\S]*?\})\s*-->/;
const QUOTA_LEASE_DEFAULT_TTL_SEC = 60 * 60;
const QUOTA_LEASE_DEFAULT_SCAN_MAX = 20;

function validLeaseTarget(targetType, target) {
  return QUOTA_LEASE_TARGET_TYPES.has(targetType)
    && /^[1-9][0-9]*$/.test(String(target || ''));
}

/** Parse one signed-by-shape lease event from a GitHub comment. Pure. */
export function parseQuotaLeaseMarker(body) {
  const match = String(body || '').match(QUOTA_LEASE_RE);
  if (!match) return null;
  let event;
  try { event = JSON.parse(match[1]); } catch { return null; }
  if (!event || event.version !== 1 || typeof event.token !== 'string' || !event.token
      || typeof event.role !== 'string' || !event.role
      || !QUOTA_LEASE_STATES.has(event.state)
      || !validLeaseTarget(event.targetType, event.target)
      || !Number.isFinite(Number(event.issuedAt))
      || !Number.isFinite(Number(event.expiresAt))) return null;
  return {
    ...event,
    target: String(event.target),
    issuedAt: Number(event.issuedAt),
    expiresAt: Number(event.expiresAt),
  };
}

/**
 * Extract lease events in comment order. A comment with an unknown author is
 * ignored; comments without author metadata are accepted for offline fixtures.
 * The latter keeps the pure contract testable while the live REST response
 * always carries `user.login`.
 */
export function quotaLeaseEvents(comments = []) {
  return (comments || []).map((comment, index) => {
    const login = String(comment?.user?.login || comment?.author?.login || '');
    if (login && !QUOTA_LEASE_TRUSTED_ACTOR_RE.test(login)) return null;
    const event = parseQuotaLeaseMarker(comment?.body);
    if (!event) return null;
    const at = Date.parse(comment?.created_at ?? comment?.createdAt ?? '');
    return {
      ...event,
      commentId: Number(comment?.id) || index,
      commentAt: Number.isFinite(at) ? Math.floor(at / 1000) : event.issuedAt,
      commentOrder: index,
    };
  }).filter(Boolean);
}

function eventRank(event) {
  return [Number(event?.commentAt) || 0, Number(event?.commentId) || 0, Number(event?.commentOrder) || 0];
}

function laterEvent(a, b) {
  const ar = eventRank(a);
  const br = eventRank(b);
  for (let i = 0; i < ar.length; i += 1) {
    if (ar[i] !== br[i]) return ar[i] > br[i] ? a : b;
  }
  return b;
}

/** Latest event for every token, pure and deterministic. */
export function latestQuotaLeaseEvents(events = []) {
  const latest = new Map();
  for (const event of events || []) {
    if (!event?.token) continue;
    const previous = latest.get(event.token);
    latest.set(event.token, previous ? laterEvent(previous, event) : event);
  }
  return [...latest.values()];
}

/** Live leases only; expired leases are harmless and can be replaced. Pure. */
export function activeQuotaLeases(events = [], { nowSec = Math.floor(Date.now() / 1000) } = {}) {
  return latestQuotaLeaseEvents(events).filter((event) =>
    QUOTA_LEASE_LIVE_STATES.has(event.state)
    && Number.isFinite(Number(event.expiresAt))
    && Number(event.expiresAt) > Number(nowSec),
  );
}

/**
 * Admission policy for the shared lease. The only consumer allowed to cross a
 * pending issue-fix floor is issue-fix itself; all other consumers wait until
 * the drainer has either reserved a slot or the issue queue is empty.
 */
export function quotaLeaseDecision({
  action = 'acquire',
  role = 'consumer',
  targetType = '',
  target = '',
  activeLeases = [],
  queueDepth = 0,
  nowSec = Math.floor(Date.now() / 1000),
} = {}) {
  if (!validLeaseTarget(targetType, target)) {
    return { allowed: false, error: true, reason: 'invalid-lease-target' };
  }
  const live = (activeLeases || []).filter((lease) =>
    QUOTA_LEASE_LIVE_STATES.has(lease?.state)
    && Number(lease?.expiresAt) > Number(nowSec),
  );
  if (action === 'release') return { allowed: true, release: true, reason: 'release-request' };

  if (action === 'consume') {
    const reservedForTarget = live.find((lease) =>
      lease.role === role
      && lease.targetType === targetType
      && String(lease.target) === String(target),
    );
    if (reservedForTarget) {
      return {
        allowed: true,
        existing: true,
        token: reservedForTarget.token,
        state: reservedForTarget.state,
        reason: 'issue-fix-slot-reserved-for-target',
      };
    }
    if (live.length) return { allowed: false, error: false, reason: 'shared-quota-lease-active' };
    // Direct agent:fix routes are legitimate issue-fix work even when the
    // queued follow-up pool is non-empty; they claim the same single slot and
    // are therefore visible to every other consumer.
    if (role === 'issue-fix') return { allowed: true, existing: false, state: 'active', reason: 'direct-issue-fix-slot' };
    if (role === 'issue-decompose' && Number(queueDepth) === 0) {
      return { allowed: true, existing: false, state: 'active', reason: 'direct-issue-decompose-slot' };
    }
    return { allowed: false, error: false, reason: 'issue-fix-floor-unreserved' };
  }

  if (live.length) {
    return {
      allowed: false,
      error: false,
      reason: live.some((lease) => lease.role === 'issue-fix')
        ? 'issue-fix-slot-active'
        : 'shared-quota-lease-active',
    };
  }
  if (role !== 'issue-fix' && Number(queueDepth) > 0) {
    return { allowed: false, error: false, reason: 'issue-fix-floor-unreserved' };
  }
  return {
    allowed: true,
    existing: false,
    state: action === 'reserve' ? 'reserved' : 'active',
    reason: action === 'reserve' ? 'issue-fix-slot-reserved' : 'residual-quota-slot',
  };
}

function writeLeaseOutputs(result, { writeOutput = true } = {}) {
  const fields = {
    lease_allowed: result.allowed === true,
    lease_acquired: result.acquired === true,
    lease_consumed: result.consumed === true,
    lease_released: result.released === true,
    lease_error: result.error === true,
    lease_token: result.token || '',
    lease_state: result.state || '',
    lease_expires_at: result.expiresAt || '',
    lease_reason: result.reason || '',
  };
  const lines = Object.entries(fields).map(([key, value]) => `${key}=${String(value).replace(/[\r\n]/g, ' ')}`);
  console.log(lines.join(' '));
  if (writeOutput && process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
  return { ...result, ...fields };
}

function leaseGh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function leaseJson(args, label) {
  const raw = leaseGh(args);
  let parsed;
  try { parsed = JSON.parse(raw); } catch (error) { throw new Error(`${label}: JSON non valido (${error.message})`); }
  return parsed;
}

function leaseRows(value, label) {
  if (!Array.isArray(value) || !value.every((row) => row && typeof row === 'object' && !Array.isArray(row))) {
    throw new Error(`${label}: risposta non e' un array di oggetti`);
  }
  return value;
}

function leaseComments(repo, targetType, target) {
  const pages = leaseJson([
    'api', '--paginate', '--slurp', `repos/${repo}/issues/${target}/comments?per_page=100`,
  ], `commenti ${targetType} #${target}`);
  if (!Array.isArray(pages) || !pages.every((page) => Array.isArray(page))) {
    throw new Error(`commenti ${targetType} #${target}: risposta non e' un array di pagine`);
  }
  const comments = pages.flat();
  if (!comments.every((comment) => comment && typeof comment === 'object')) {
    throw new Error(`commenti ${targetType} #${target}: pagina malformata`);
  }
  return comments;
}

function leaseIssueRows(repo, label, max) {
  return leaseRows(leaseJson([
    'issue', 'list', '--repo', repo, '--state', 'open', '--label', label,
    '--json', 'number,updatedAt', '--limit', String(max),
  ], `issue ${label}`), `issue ${label}`);
}

function leasePrRows(repo, max) {
  return leaseRows(leaseJson([
    'pr', 'list', '--repo', repo, '--state', 'open',
    '--json', 'number,updatedAt', '--limit', String(max),
  ], 'PR aperte'), 'PR aperte');
}

function leaseCommentBody(event) {
  return `${QUOTA_LEASE_MARKER} ${JSON.stringify(event)} -->\n`
    + `_Quota lease ${event.state} · ruolo ${event.role} · target ${event.targetType} #${event.target} · `
    + `scade ${new Date(event.expiresAt * 1000).toISOString()}._`;
}

function postLeaseEvent(repo, event) {
  const command = event.targetType === 'issue' ? 'issue' : 'pr';
  leaseGh([command, 'comment', String(event.target), '--repo', repo, '--body', leaseCommentBody(event)]);
}

function leaseTargetRefs(repo, targetType, target, max) {
  const refs = new Map();
  const add = (type, number) => {
    const key = `${type}:${number}`;
    if (validLeaseTarget(type, number) && !refs.has(key)) refs.set(key, { type, number: String(number) });
  };
  add(targetType, target);
  for (const label of ['agent:fix', 'agent:fix-queued', 'agent:decompose', 'agent:decompose-queued']) {
    for (const row of leaseIssueRows(repo, label, max)) add('issue', row.number);
  }
  for (const row of leasePrRows(repo, max)) add('pr', row.number);
  return [...refs.values()];
}

function scanQuotaLeases(repo, targetType, target, max, nowSec) {
  const events = [];
  const commentsByTarget = new Map();
  for (const ref of leaseTargetRefs(repo, targetType, target, max)) {
    const comments = leaseComments(repo, ref.type, ref.number);
    commentsByTarget.set(`${ref.type}:${ref.number}`, comments);
    events.push(...quotaLeaseEvents(comments));
  }
  return {
    events,
    active: activeQuotaLeases(events, { nowSec }),
    commentsByTarget,
  };
}

function leaseToken({ role, owner, runId }) {
  const stem = String(runId || process.env.GITHUB_RUN_ID || process.pid || 'local')
    .replace(/[^A-Za-z0-9._-]/g, '-');
  return `quota-${role}-${owner}-${stem}-${Date.now()}-${randomUUID().slice(0, 8)}`;
}

function latestLeaseForToken(events, token) {
  return latestQuotaLeaseEvents(events).find((event) => event.token === token) || null;
}

/**
 * Acquire/consume/release the shared lease. All live API and parser failures
 * are returned as `error=true` and `allowed=false`: callers must gate the
 * Claude action on this output instead of treating a broken probe as a green
 * skip. `writeOutput:false` is used by the drainer's in-process reservation.
 */
export function runQuotaLease({
  action = process.env.QUOTA_LEASE_ACTION || '',
  role = process.env.QUOTA_LEASE_ROLE || 'consumer',
  owner = process.env.QUOTA_LEASE_OWNER || role,
  targetType = process.env.QUOTA_LEASE_TARGET_TYPE || (process.env.ISSUE_NUMBER ? 'issue' : 'pr'),
  target = process.env.QUOTA_LEASE_TARGET || process.env.ISSUE_NUMBER || process.env.PR_NUMBER || '',
  token = process.env.QUOTA_LEASE_TOKEN || '',
  ttlSec = Number(process.env.QUOTA_LEASE_TTL_SEC || QUOTA_LEASE_DEFAULT_TTL_SEC),
  scanMax = Number(process.env.QUOTA_LEASE_SCAN_MAX || QUOTA_LEASE_DEFAULT_SCAN_MAX),
  runId = process.env.GITHUB_RUN_ID || '',
  writeOutput = true,
  dryRun = process.env.DRY_RUN === '1',
} = {}) {
  if (!action) return writeLeaseOutputs({ enabled: false, allowed: true, reason: 'lease-not-requested' }, { writeOutput });
  if (!['acquire', 'reserve', 'consume', 'release'].includes(action)) {
    return writeLeaseOutputs({ allowed: false, error: true, reason: 'invalid-lease-action' }, { writeOutput });
  }
  const repo = process.env.GH_REPO || process.env.GITHUB_REPOSITORY || '';
  const nowSec = Math.floor(Date.now() / 1000);
  const ttl = Number.isFinite(ttlSec) && ttlSec > 0 ? Math.floor(ttlSec) : QUOTA_LEASE_DEFAULT_TTL_SEC;
  const max = Number.isFinite(scanMax) && scanMax > 0 ? Math.floor(scanMax) : QUOTA_LEASE_DEFAULT_SCAN_MAX;
  if (!repo || !validLeaseTarget(targetType, target)) {
    return writeLeaseOutputs({ allowed: false, error: true, reason: 'invalid-lease-context' }, { writeOutput });
  }
  if (dryRun && action !== 'release') {
    const dryToken = token || `dry-${role}-${target}`;
    return writeLeaseOutputs({
      allowed: true, acquired: true, consumed: action === 'consume', token: dryToken,
      state: action === 'reserve' ? 'reserved' : 'active', expiresAt: nowSec + ttl, reason: 'dry-run',
    }, { writeOutput });
  }
  try {
    if (action === 'release') {
      if (!token) return writeLeaseOutputs({ allowed: false, error: true, reason: 'release-token-missing' }, { writeOutput });
      const comments = leaseComments(repo, targetType, target);
      const events = quotaLeaseEvents(comments);
      const current = latestLeaseForToken(events, token);
      if (!current) return writeLeaseOutputs({ allowed: true, released: false, token, reason: 'lease-already-absent' }, { writeOutput });
      const released = {
        ...current, role, owner, state: 'released', issuedAt: nowSec, expiresAt: Math.max(nowSec, Number(current.expiresAt)),
        runId: String(runId || process.env.GITHUB_RUN_ID || ''),
      };
      if (current.state !== 'released') postLeaseEvent(repo, released);
      const after = quotaLeaseEvents(leaseComments(repo, targetType, target));
      const verified = latestLeaseForToken(after, token);
      if (!verified || verified.state !== 'released') throw new Error('rilascio non verificabile');
      return writeLeaseOutputs({ allowed: true, released: true, token, state: 'released', expiresAt: verified.expiresAt, reason: 'lease-released' }, { writeOutput });
    }

    const scan = scanQuotaLeases(repo, targetType, target, max, nowSec);
    const queueDepth = leaseIssueRows(repo, 'agent:fix-queued', max).length;
    const decision = quotaLeaseDecision({ action, role, targetType, target, activeLeases: scan.active, queueDepth, nowSec });
    if (!decision.allowed) return writeLeaseOutputs({ allowed: false, error: decision.error, reason: decision.reason }, { writeOutput });

    const chosenToken = decision.token || token || leaseToken({ role, owner, runId });
    const existing = decision.existing === true;
    const state = action === 'reserve' ? 'reserved' : (action === 'consume' ? 'consumed' : 'active');
    if (!existing || (action === 'consume' && decision.state !== 'consumed')) {
      const event = {
        version: 1,
        token: chosenToken,
        role,
        owner,
        targetType,
        target: String(target),
        state,
        issuedAt: nowSec,
        expiresAt: nowSec + ttl,
        runId: String(runId || process.env.GITHUB_RUN_ID || ''),
      };
      postLeaseEvent(repo, event);
    }

    // A write is not an admission until the marker is visible again.  The
    // second bounded scan also detects a concurrent writer: both contenders
    // then fail closed instead of both spending Claude.
    const after = scanQuotaLeases(repo, targetType, target, max, nowSec);
    const own = latestLeaseForToken(after.events, chosenToken);
    const liveAfter = after.active;
    if (!own || !QUOTA_LEASE_LIVE_STATES.has(own.state)
        || !liveAfter.some((lease) => lease.token === chosenToken)) {
      throw new Error('lease scritto ma non rileggibile');
    }
    if (!existing && liveAfter.length !== 1) {
      postLeaseEvent(repo, {
        ...own, state: 'released', owner, role, issuedAt: nowSec,
        expiresAt: Math.max(nowSec, Number(own.expiresAt)),
      });
      throw new Error(`contesa lease: ${liveAfter.length} lease attivi`);
    }
    return writeLeaseOutputs({
      allowed: true,
      acquired: !existing,
      consumed: action === 'consume',
      token: chosenToken,
      state: own.state,
      expiresAt: own.expiresAt,
      reason: decision.reason,
    }, { writeOutput });
  } catch (error) {
    console.log(`::error::quota lease fail-closed: ${String(error?.message || error).slice(0, 240)}`);
    return writeLeaseOutputs({ allowed: false, error: true, reason: 'lease-api-or-parse-error' }, { writeOutput });
  }
}

/**
 * ── Beacon CROSS-REPO, deliberatamente ASIMMETRICO ────────────────────────
 *
 * La quota Claude non è per-repo: è per-ACCOUNT. Un 429 `seven_day` visto dal
 * ciclo del sito descrive esattamente il muro contro cui sta per andare a
 * sbattere anche questo repo. Ma il beacon vive sulle issue del repo che lo ha
 * osservato, quindi un gate che guarda solo in casa propria è cieco proprio
 * sull'evento che lo riguarda di più.
 *
 * `QUOTA_BEACON_PEER_REPO` aggiunge un repo il cui beacon viene ONORATO, mai
 * scritto. Impostandolo SOLO qui (il sito non lo imposta) si ottiene una
 * precedenza a senso unico: questo repo cede quando il sito è in rate-limit,
 * il sito non cede mai per questo repo. La garanzia "il ciclo del corpus non
 * affama quello del sito" smette così di dipendere dalla cadenza dei cron e
 * diventa una proprietà strutturale.
 *
 * Che la variabile sia opzionale non è un dettaglio: il file resta valido
 * identico su entrambi i lati, quindi il giorno in cui il sito volesse la
 * stessa logica non c'è niente da riscrivere — basta non impostarla, ed è già
 * il comportamento di prima.
 *
 * Costo: al più due `gh issue list` + qualche `view` in più, e solo quando il
 * beacon locale NON è già attivo (se lo è, la decisione è già presa).
 */
const PEER_REPO = process.env.QUOTA_BEACON_PEER_REPO || '';

function gh(args, { allowFail = true } = {}) {
  try {
    return execFileSync('gh', args, { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    if (allowFail) return '';
    throw e;
  }
}

function setOutput(blocked, resetsAt, codexFallback = false) {
  console.log(`quota_blocked=${blocked} codex_fallback=${codexFallback} resets_at=${resetsAt || ''}`);
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(
      process.env.GITHUB_OUTPUT,
      `quota_blocked=${blocked}\ncodex_fallback=${codexFallback}\nresets_at=${resetsAt || ''}\n`
    );
  }
}

/**
 * Le issue candidate a portare il beacon, deduplicate e ordinate dalla più
 * recentemente aggiornata. Pura rispetto a gh (prende le liste già lette) →
 * testabile.
 * @param {Array<Array<{number:number,updatedAt?:string}>>} lists
 * @param {{ now:number, lookbackH:number, max:number }} opts
 */
export function beaconCandidates(lists, { now, lookbackH, max }) {
  const seen = new Map();
  for (const list of lists) {
    for (const iss of list || []) {
      if (!iss || typeof iss.number !== 'number') continue;
      const t = Date.parse(iss.updatedAt || '');
      if (Number.isNaN(t)) continue;
      if (now - t > lookbackH * 3_600_000) continue;
      const prev = seen.get(iss.number);
      if (!prev || t > prev.t) seen.set(iss.number, { number: iss.number, t });
    }
  }
  return [...seen.values()].sort((a, b) => b.t - a.t).slice(0, max).map((x) => x.number);
}

/**
 * Un candidato PR resta osservabile anche quando la coda issue riempie il
 * tetto. I beacon dei fixer PR sono la sola fonte del quota window per un
 * round già passato al review/fixer, quindi una lista di issue non può
 * renderli tutti invisibili.
 */
export function mergeBeaconCandidates(issueCandidates = [], prCandidates = [], max = MAX_ISSUES) {
  const limit = Math.max(0, Number(max) || 0);
  const issues = [...new Set((issueCandidates || []).filter((n) => Number.isInteger(n)))];
  const prs = [...new Set((prCandidates || []).filter((n) => Number.isInteger(n)))];
  if (!limit || !prs.length) return issues.slice(0, limit);

  const reservedPr = prs.find((number) => !issues.includes(number));
  if (reservedPr === undefined) return [...issues, ...prs].slice(0, limit);

  const withoutReserved = issues.filter((number) => number !== reservedPr);
  return [
    ...withoutReserved.slice(0, Math.max(0, limit - 1)),
    reservedPr,
    ...prs.filter((number) => number !== reservedPr),
  ].slice(0, limit);
}

/** Project an active beacon onto either the legacy backoff or Codex fallback. */
export function quotaFallbackDecision({ resetsAt = null, nowSec, codexFallbackMode = false } = {}) {
  const active = Number.isFinite(Number(resetsAt))
    && isBackoffActive(Number(resetsAt), Number(nowSec));
  return {
    active,
    quotaBlocked: active && !codexFallbackMode,
    codexFallback: active && codexFallbackMode,
  };
}

// Stesso tetto dichiarato di `followup-drainer.mjs`, e per lo stesso motivo:
// `gh issue list` ordina dalle piu' RECENTI, quindi un limite raggiunto non
// campiona — taglia via le issue piu' VECCHIE, in silenzio. Sul drainer e'
// successo davvero (107 `fu-parked` contro `--limit 100`: 7 issue invisibili a
// ogni passo). Qui le label sono stati di routing che il ciclo tiene
// serializzati, quindi il tetto non morde oggi; ma e' lo stesso costrutto, e
// una coda che si gonfia mentre il drain e' fermo e' esattamente lo scenario in
// cui questo file viene consultato.
const ISSUE_LIST_LIMIT = Number(process.env.FOLLOWUP_ISSUE_LIST_LIMIT || 300);

function listIssues(label, scope = repoArgs) {
  const raw = gh([
    'issue', 'list', ...scope, '--state', 'open', '--label', label,
    '--json', 'number,updatedAt', '--limit', String(ISSUE_LIST_LIMIT),
  ]);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    const rows = Array.isArray(parsed) ? parsed : [];
    if (rows.length >= ISSUE_LIST_LIMIT) {
      console.log(`::warning::listing \`${label}\` al tetto di ${ISSUE_LIST_LIMIT}: vista PARZIALE, taglia le issue piu' vecchie (no silent cap).`);
    }
    return rows;
  } catch {
    return [];
  }
}

function repoFromScope(scope) {
  const i = Array.isArray(scope) ? scope.indexOf('--repo') : -1;
  return i >= 0 ? scope[i + 1] : process.env.GH_REPO || process.env.GITHUB_REPOSITORY || '';
}

function listPullRequests(scope = repoArgs) {
  const raw = gh([
    'pr', 'list', ...scope, '--state', 'all',
    '--json', 'number,updatedAt', '--limit', String(ISSUE_LIST_LIMIT),
  ]);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    const rows = Array.isArray(parsed) ? parsed : [];
    if (rows.length >= ISSUE_LIST_LIMIT) {
      console.log(`::warning::listing PR al tetto di ${ISSUE_LIST_LIMIT}: vista PARZIALE, taglia le PR piu' vecchie (no silent cap).`);
    }
    return rows;
  } catch {
    return [];
  }
}

function commentsOf(num, scope = repoArgs) {
  const repo = repoFromScope(scope);
  if (!repo) return [];
  const raw = gh(['api', '--paginate', '--slurp', `repos/${repo}/issues/${num}/comments?per_page=100`]);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.flatMap((page) => Array.isArray(page) ? page : [])
      : [];
  } catch {
    return [];
  }
}

/**
 * Cerca un beacon ATTIVO fra le issue in lavorazione/coda di uno scope.
 * @returns {{resetsAt:number, issue:number}|null}
 */
function activeBeaconIn(scope, nowMs, nowSec) {
  // Le issue con label di coda sono la fonte primaria: le PR vengono solo
  // aggiunte nello spazio rimasto, altrimenti una raffica di PR aggiornate può
  // occupare tutti i MAX_ISSUES e rendere cieco il pre-flight ai beacon reali.
  const opts = { now: nowMs, lookbackH: LOOKBACK_H, max: MAX_ISSUES };
  const issueCandidates = beaconCandidates([
    listIssues(LBL_FIX, scope),
    listIssues(LBL_QUEUED, scope),
    listIssues(LBL_DECOMP, scope),
    listIssues(LBL_DECOMP_QUEUED, scope),
  ], opts);
  const prCandidates = beaconCandidates([listPullRequests(scope)], opts);
  const candidates = mergeBeaconCandidates(issueCandidates, prCandidates, MAX_ISSUES);
  for (const num of candidates) {
    const r = maxQuotaResetsAt(commentsOf(num, scope));
    if (r !== null && isBackoffActive(r, nowSec)) return { resetsAt: r, issue: num };
  }
  return null;
}

function main() {
  if (process.env.QUOTA_LEASE_ACTION) {
    runQuotaLease();
    return;
  }
  const nowMs = Date.now();
  const nowSec = Math.floor(nowMs / 1000);

  // Prima il beacon locale: se è già attivo la decisione è presa e interrogare
  // il peer sarebbe lavoro sprecato.
  let found = activeBeaconIn(repoArgs, nowMs, nowSec);
  let source = 'questo repo';

  // Poi quello del peer (tipicamente il ciclo del sito). Il 429 è per-account:
  // un limite osservato là vale anche qui. Best-effort — se il peer non è
  // leggibile si procede come prima, senza mai bloccare per un errore di
  // lettura altrui.
  if (!found && PEER_REPO) {
    try {
      found = activeBeaconIn(['--repo', PEER_REPO], nowMs, nowSec);
      if (found) source = PEER_REPO;
    } catch (e) {
      console.log(`Beacon del peer ${PEER_REPO} non leggibile (${String(e && e.message).slice(0, 80)}) — procedo col solo beacon locale.`);
    }
  }

  if (!found) {
    console.log(`Nessun beacon di quota attivo${PEER_REPO ? ` (né qui né su ${PEER_REPO})` : ''} → procedo.`);
    setOutput(false, '');
    return;
  }

  const resetsAt = found.resetsAt;
  console.log(`Beacon di quota attivo su #${found.issue} (${source}): resetsAt=${resetsAt} (${new Date(resetsAt * 1000).toISOString()}).`);

  const when = new Date(resetsAt * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  const minutes = Math.max(1, Math.round((resetsAt - nowSec) / 60));
  console.log(`::warning::Quota Claude esaurita fino alle ${when} (~${minutes} min) — salto il fixer PRIMA di spendere la chiamata Claude.`);

  const projection = quotaFallbackDecision({
    resetsAt,
    nowSec,
    codexFallbackMode: CODEX_FALLBACK_MODE,
  });
  if (projection.codexFallback) {
    console.log('Fallback Codex abilitato: nessuna ri-accodatura, l’action provider-neutral tenterà una sola esecuzione.');
    setOutput(false, resetsAt, true);
    return;
  }

  // Ri-accoda questa issue senza consumare un tentativo: la run non ha letto la
  // issue, non è un fallimento dell'agente. Label attiva → label di coda (per
  // default `agent:fix` → `agent:fix-queued`; per lo stadio di decomposizione
  // il chiamante passa la coppia `agent:decompose*`) così il drainer la
  // ripromuove appena la finestra si chiude.
  if (ISSUE && !DRY_RUN) {
    const body = [
      '<!-- FIX_OUTCOME: rate-limited -->',
      `<!-- QUOTA_RESETS_AT: ${resetsAt} -->`,
      '',
      `⏳ **Pre-flight quota (zero-Claude)**: la quota Claude condivisa è esaurita fino alle **${when}**.`,
      'Non lancio la run Claude: morirebbe su HTTP 429 al primo turno senza leggere',
      'la issue (0 turni, $0), occupando lo slot serializzato e ritardando la coda.',
      '',
      '**Nessun tentativo consumato** (`fu-attempt` invariato): la issue torna in',
      `\`${LBL_REQUEUE}\` e riparte da sola appena la finestra si chiude.`,
    ].join('\n');
    gh(['issue', 'comment', ISSUE, ...repoArgs, '--body', body]);
    gh(['issue', 'edit', ISSUE, ...repoArgs, '--add-label', LBL_REQUEUE, '--remove-label', LBL_ACTIVE]);
  }

  setOutput(true, resetsAt, false);
}

// TOTAL / PROCEED-SAFE: un throw non gestito non deve mai lasciare la issue
// bloccata né congelare la coda → quota_blocked=false, exit 0 → il fixer gira
// invariato (comportamento identico a prima che questo gate esistesse).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (e) {
    console.error('Quota backoff gate error — procedo (fixer normale):', e && e.message ? e.message : e);
    setOutput(false, '');
    process.exit(0);
  }
}
