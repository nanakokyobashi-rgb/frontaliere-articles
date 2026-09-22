/**
 * pr-autorebase.mjs — rebase reale delle PR a un passo dal merge (zero-Claude).
 *
 * stale-pr-rescuer.yml oggi LABELLA + commenta "fai git merge origin/main", ma
 * nessuno lo esegue → le PR restano ferme. Qui lo automatizziamo, ma con
 * FRUGALITÀ (zero Claude): dopo il rebase NON ri-eseguiamo la review — ri-
 * eseguiamo SOLO vitest (dispatch di tests.yml) e lasciamo che auto-merge-eval
 * porti avanti l'`## LGTM` esistente (il contributo proprio della PR è invariato
 * su un rebase di solo main-merge). RIPARIAMO solo le PR "near-merge"; la
 * RILEVAZIONE dei conflitti con main gira invece su tutte (vedi
 * `reportMainConflict`), perché costa un `git merge-tree` e perché la classe
 * fuori dal gate — PR in revisione, con un 🔴 e senza label — è proprio quella
 * che sta in volo più a lungo e che nessun altro segnale copriva.
 *
 * NB sul trigger: il push del rebase si autentica via App/PAT (x-access-token) e
 * RI-TRIGGERA i workflow `pull_request` — incluso `pr-review-loop`, che con
 * `cancel-in-progress` cancella la review in corso. Per NON bruciare quota Claude
 * né innescare un livelock, (a) dispatchiamo comunque tests.yml esplicitamente
 * (più affidabile di affidarsi al push per il solo vitest) e (b) **defer del
 * rebase finché una review è in volo** (vedi reviewInProgress): rebasare mentre la
 * review gira la cancella, e con main caldo non concluderebbe mai (la PR
 * collision-risk va behind a ogni tick) → niente `## LGTM`, niente merge.
 * Stessa forma, un giro prima: **defer del rebase finché un run di `tests.yml` è
 * in volo sulla head ATTUALE** (vedi testsRunInFlightOnHead) — il push cancella
 * il `tests` in corso, e `pr-review-loop` parte SOLO su `workflow_run[tests]`
 * con `conclusion == success`, quindi cancellarlo cancella anche la review che
 * non è ancora partita (#6037, 2026-08-18: 5 `tests` cancellati di fila, zero
 * `success`).
 * (Storico: il claim "push PAT non ri-triggera pull_request" su #1587/#1526 era
 * uno zero-check-run da rebase pre-#1597 che non dispatchava, non l'assenza di
 * trigger; il push autenticato App/PAT ri-triggera, osservato su #3038.)
 *
 * Per ogni PR OPEN non-draft:
 *   GATE (frugalità): procedi solo se "near-merge" =
 *     - ha una review claude-bot con `## LGTM` su un qualche commit, OPPURE
 *     - porta label `collision-risk` o `stale-review`.
 *     Altrimenti skip.
 *   - behind = commit di origin/main non nella head. behind==0 (già allineata):
 *     di norma skip, MA si HEAL-dispatcha tests.yml (no rebase) in due casi così
 *     auto-merge-eval può gattare+mergiare, senza i quali la PR near-merge resta
 *     stuck per sempre: (a) head "orfana" (0 check-run `vitest`, lasciata da un
 *     push PAT che non ri-triggera `pull_request` o da un rebase pre-#1597 che
 *     non dispatchava) — #1595/#1526; (b) verdetto vitest rosso da CANCELLAZIONE
 *     da concurrency (transient, non test rotti) e senza run fresco pendente:
 *     `cancelled` sul check stesso con il job singolo di oggi, oppure `failure`
 *     collassato dagli shard nella vecchia matrice — #2438 (vedi
 *     vitestVerdictIsTransientCancellation). Un `failure` REALE → skip
 *     (niente re-run gratis: AGENTS #5 + frugalità CI).
 *   - mergeable (gh pr view --json mergeable; UNKNOWN → poll una volta dopo una
 *     breve attesa; se ancora UNKNOWN → skip questo run).
 *   - MERGEABLE → fetch + checkout branch + `git merge origin/main` (identity
 *     canonica). Clean → push via PAT + dispatch tests.yml sul branch (vitest
 *     sull'head; LGTM portato avanti da auto-merge-eval). Log.
 *   - CONFLITTO (CONFLICTING o merge nonzero) → `git merge --abort`; assicura
 *     label `stale-review` (così rescuer/recycle gestiscono); commenta UNA volta
 *     (dedup via marker `<!-- AUTOREBASE_CONFLICT -->`). Niente loop.
 *   Cap: ~10 PR/run; logga le skippate per cap (AGENTS.md no-silent-cap).
 *
 * Uso:  node scripts/ci/pr-autorebase.mjs [--dry-run]
 * Env:  GH_TOKEN (PAT, per push + dispatch tests.yml; serve scope actions:write),
 *       GITHUB_REPOSITORY. Richiede `gh` + `git` in un checkout full-history.
 */
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import {
  VITEST_CHECK_NAME,
  VITEST_EXECUTION_JOB_NAME,
  isManagedReview,
} from './lib/constants.mjs';
import {
  latestCompletedVitestConclusion,
  latestCompletedVitestExecutionRun,
  vitestVerdictIsTransientCancellation,
  vitestFailureIsNotAttributableToPr,
  vitestFailureIsReviewGate,
  reviewSkippedByGuard,
  reviewAbortedWithoutVerdict,
  reviewStepIsInFlight,
  jobRefFromCheckRun,
  currentAttemptJobSteps,
  pollUntil,
  vitestCheckNeedsPolling,
  vitestJobIsConcluded,
} from './lib/vitestCheck.mjs';
import { hasCommentMarker as hasCommentMarkerShared, upsertStickyComment,
  countPaginatedLines, lastPaginatedJsonLine } from './lib/prComments.mjs';
import { runBudgetFromEnv, rotateForFairness } from './lib/run-budget.mjs';
import { parseCollisionPeers, collisionGateDecision } from './auto-merge-eval.mjs';
import {
  REOPEN_BUDGET_MARKER,
  BREAKER_LABEL,
  DEFAULT_MAX_REOPENS,
  reopenFingerprint,
  parseReopenBudget,
  decideReopen,
  decideNeedsHumanPass,
  renderReopenBudget,
} from './lib/reopen-breaker.mjs';
import { intFromEnv, positiveIntFromEnv } from '../lib/int-from-env.mjs';
import {
  reviewInputContextFromPullRequest,
  reviewInputContextMatches,
  reviewHasInputRevision,
} from './review-test-policy.mjs';

const DRY = process.argv.includes('--dry-run');
const REPO = process.env.GITHUB_REPOSITORY || '';
const TOKEN = process.env.GH_TOKEN || '';
export const MAX_PER_RUN = 10;
// Costo tipico di una PR nel loop, misurato sui run reali (fase di lavoro
// 19-114s per 1-10 PR): ~30s copre il caso normale con margine. È una STIMA per
// decidere se COMINCIARE, non un timer: nessuna PR viene interrotta a metà.
const PR_COST_MS = intFromEnv('AUTOREBASE_PR_COST_MS', 30_000);
// Sezione critica NON atomica: `gh pr close` + `gh pr reopen`. Se il job muore
// fra le due la PR resta CHIUSA e nessuno la riapre (vedi reopenToRetrigger).
// Non si entra senza il tempo di uscirne — con margine largo rispetto a due
// chiamate API che nel caso peggiore ritentano.
/** Tentativi di reopen e pausa fra uno e l'altro — vedi reopenToRetrigger. */
const REOPEN_ATTEMPTS = Math.max(4, intFromEnv('AUTOREBASE_REOPEN_ATTEMPTS', 4));
const REOPEN_RETRY_SLEEP_S = intFromEnv('AUTOREBASE_REOPEN_RETRY_SLEEP_S', 5);
/**
 * DERIVATO dai due sopra, non scritto a mano: il guard vale solo se il tempo
 * riservato copre davvero il peggior caso della sezione critica. Con un numero
 * fisso, alzare i tentativi o la pausa lo renderebbe silenziosamente
 * insufficiente — e un budget che sottostima è esattamente il modo in cui il
 * job muore fra `close` e `reopen` lasciando la PR chiusa.
 * close + N chiamate reopen (≈3s l'una, generoso su un'API degradata) + le pause.
 */
const REOPEN_COST_MS = positiveIntFromEnv('AUTOREBASE_REOPEN_COST_MS', 3_000 + REOPEN_ATTEMPTS * 3_000 + (REOPEN_ATTEMPTS - 1) * REOPEN_RETRY_SLEEP_S * 1_000);
/**
 * Etichetta che dice al worktree-branch-janitor di NON cancellare l'head ref di
 * questa PR. Si applica solo quando la coppia close+reopen si è rotta a metà:
 * la chiusura si recupera a mano, la perdita del branch no.
 */
const REOPEN_FAILED_LABEL = 'autorebase-reopen-failed';
/** Tetto di riaperture sullo STESSO stato — vedi lib/reopen-breaker.mjs. */
const MAX_REOPENS = intFromEnv('AUTOREBASE_MAX_REOPENS', DEFAULT_MAX_REOPENS);

const budget = runBudgetFromEnv();
const CONFLICT_MARKER = '<!-- AUTOREBASE_CONFLICT -->';

// ── Rilevazione conflitti con main su TUTTE le PR aperte ─────────────────────
//
// Il gate near-merge sotto esiste per frugalità e va benissimo per la parte
// COSTOSA (merge, push, dispatch di tests.yml). Ma lasciava senza alcun segnale
// la classe di PR che sta in volo più a lungo — quelle sotto revisione, con un
// 🔴 e senza LGTM: nessuna label, nessun LGTM, quindi fuori dal gate. Una di
// quelle può restare CONFLICTING per ore senza che niente lo dica.
//
// Osservato su #6330: aperta MERGEABLE, 58 commit dopo era in conflitto su
// cinque file, e chi la seguiva stava facendo polling di `state` e `reviews` —
// che restano OPEN e invariati mentre il conflitto nasce.
//
// La rilevazione è a costo quasi zero (un `git merge-tree`, nessuna scrittura,
// nessun push, zero Claude), quindi gira su OGNI PR aperta non-draft. La
// riparazione resta near-merge-only.
const MAIN_CONFLICT_MARKER = '<!-- MAIN_CONFLICT -->';
const MAIN_CONFLICT_LABEL = 'has-conflicts';
// One-shot per PR: `vitestFailureIsNotAttributableToPr` è pura e ri-risponderebbe
// `true` a ogni tick finché l'head resta rosso. Il marker rende il rescue
// irripetibile: una PR ri-testata contro main verde che torna ROSSA è rotta per
// conto suo e non va ri-rebasata all'infinito (frugalità CI + niente rebase-thrash,
// la stessa classe di livelock di #2415). Da lì la prendono recycle-stale-prs /
// un umano.
const STUCK_RED_MARKER = '<!-- AUTOREBASE_STUCK_RED_RESCUE -->';
// Backstop `stale` di vitestFailureIsNotAttributableToPr: un vitest rosso più
// vecchio di N ore va ri-verificato una volta anche senza prova di main-rosso
// (copre i fallimenti INFRA, es. #5019: `RPC failed; curl 56` + runner shutdown
// durante il checkout, zero test eseguiti, con main verde in quel momento).
const STUCK_RED_STALE_H = intFromEnv('AUTOREBASE_STUCK_RED_STALE_H', 24);
// Re-trigger one-shot per il rosso da REVIEW GATE (#7429). Dall'unificazione
// tests+review del 2026-08-26 il job `vitest (unit + integration)` è rosso anche
// quando i test passano e a fallire è lo step `Require approving Claude review`:
// quel rosso NON dice «la review non può partire» — dice che è già partita e il
// verdetto manca o è negativo, quindi il riciclo è esattamente ciò che ne produce
// uno nuovo. One-shot per PR, e per la stessa ragione dello stuck-red: il
// fingerprint del breaker include il NUMERO di review, che un reopen incrementa,
// quindi il solo contatore si azzererebbe a ogni giro e il breaker non
// scatterebbe mai (il livelock misurato su #5896/#5906). Il flag vive nello
// STATO dello sticky del budget (`reviewGate`), non in un secondo commento: un
// solo canale di segnalazione. Un 🔴 reale si chiude con un commit, non con un
// re-trigger — una volta sola è la dose giusta.
// Activity-guard: don't rebase-push a branch whose head was pushed in the last
// N minutes — a contributor/agent is likely mid-flight (still pushing fixes on
// top of an LGTM'd PR). Rebasing then races their push: ours lands first, their
// non-fast-forward push is rejected, and they must fetch+reset+cherry-pick to
// recover (observed on #1616 this session). The rebase isn't urgent — main is
// always seconds-fresh — so deferring one tick (~30m) is free. 0 disables.
const ACTIVITY_GUARD_MIN = intFromEnv('AUTOREBASE_ACTIVITY_GUARD_MIN', 6);
const VITEST_POLL_ATTEMPTS = 3;
const VITEST_POLL_DELAY_MS = 1_000;

function sleepSync(ms) {
  if (ms > 0) execFileSync('sleep', [String(ms / 1_000)], { stdio: 'ignore' });
}

function gh(args, { json = true, allowFail = false } = {}) {
  try {
    const out = execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    return json ? JSON.parse(out) : out;
  } catch (e) {
    if (allowFail) return json ? null : '';
    throw e;
  }
}

const PR_HEAD_SHA_RE = /^[0-9a-f]{40}$/i;

/**
 * Normalizza e valida il payload di `gh api --paginate --slurp` per le PR.
 *
 * `--slurp` restituisce un array di pagine, non una pagina concatenata. Una
 * pagina o una PR malformata è un errore di discovery: non può diventare una
 * lista vuota che farebbe apparire il run verde senza aver scansionato nulla.
 *
 * @param {unknown} payload
 * @returns {Array<{number: number, headRefName: string, headRefOid: string,
 *   isDraft: boolean, labels: Array<{name: string}>}>}
 */
export function parsePaginatedPullRequests(payload) {
  if (!Array.isArray(payload)) {
    throw new TypeError('pr-autorebase: pull request payload must be an array of pages');
  }

  const pullRequests = [];
  const seenNumbers = new Set();
  for (const [pageIndex, page] of payload.entries()) {
    if (!Array.isArray(page)) {
      throw new TypeError(`pr-autorebase: pull request page ${pageIndex + 1} is not an array`);
    }
    for (const [itemIndex, pullRequest] of page.entries()) {
      if (!pullRequest || Array.isArray(pullRequest) || typeof pullRequest !== 'object') {
        throw new TypeError(`pr-autorebase: pull request ${pageIndex + 1}/${itemIndex + 1} is not an object`);
      }
      const number = pullRequest.number;
      const head = pullRequest.head;
      const labels = pullRequest.labels;
      if (!Number.isSafeInteger(number) || number <= 0) {
        throw new TypeError(`pr-autorebase: pull request ${pageIndex + 1}/${itemIndex + 1} has an invalid number`);
      }
      if (seenNumbers.has(number)) {
        throw new TypeError(`pr-autorebase: pull request #${number} appears more than once in the paginated payload`);
      }
      if (!head || Array.isArray(head) || typeof head !== 'object'
          || typeof head.ref !== 'string' || head.ref.length === 0
          || typeof head.sha !== 'string' || !PR_HEAD_SHA_RE.test(head.sha)) {
        throw new TypeError(`pr-autorebase: pull request #${number} has an invalid head`);
      }
      if (typeof pullRequest.draft !== 'boolean') {
        throw new TypeError(`pr-autorebase: pull request #${number} has an invalid draft flag`);
      }
      if (!Array.isArray(labels) || labels.some((label) => (
        !label || Array.isArray(label) || typeof label !== 'object'
          || typeof label.name !== 'string'
      ))) {
        throw new TypeError(`pr-autorebase: pull request #${number} has invalid labels`);
      }
      seenNumbers.add(number);
      pullRequests.push({
        number,
        headRefName: head.ref,
        headRefOid: head.sha,
        isDraft: pullRequest.draft,
        labels: labels.map(({ name }) => ({ name })),
      });
    }
  }
  return pullRequests;
}

/** Read the complete open-PR pool through the paginated GitHub API. */
export function discoverOpenPullRequests(read = gh, repo = REPO) {
  const payload = read([
    'api', '--paginate', '--slurp',
    `repos/${repo}/pulls?state=open&per_page=100`,
  ]);
  return parsePaginatedPullRequests(payload);
}

/** Filter drafts, then rotate the complete pool before the per-run cap. */
export function preparePullRequestSweep(pullRequests, runNumber) {
  if (!Array.isArray(pullRequests)) {
    throw new TypeError('pr-autorebase: pull request pool must be an array');
  }
  return rotateForFairness(
    pullRequests.filter((pullRequest) => !pullRequest.isDraft),
    runNumber,
  );
}

/** Read the trusted PR HEAD and body revision as one review-input snapshot. */
function currentReviewInputContext(num) {
  try {
    return reviewInputContextFromPullRequest(gh(['api', `repos/${REPO}/pulls/${num}`]));
  } catch {
    return null;
  }
}

/** Backward-compatible body-only accessor for review selection defaults. */
function currentReviewInputRevision(num) {
  return currentReviewInputContext(num)?.reviewRevision || null;
}

/** Re-read HEAD and body immediately before a review-dependent mutation. */
function reviewInputContextStillCurrent(num, expectedHead, expectedRevision) {
  const current = currentReviewInputContext(num);
  if (reviewInputContextMatches(current, {
    headSha: expectedHead,
    reviewRevision: expectedRevision,
  })) return true;
  console.log(
    `PR #${num}: HEAD o body PR cambiati durante lo sweep (attesa head=${expectedHead} revision=${expectedRevision}, corrente head=${current?.headSha || '<unreadable>'} revision=${current?.reviewRevision || '<unreadable>'}) — skip azione review-dipendente questo tick.`,
  );
  return false;
}

/**
 * `git merge-tree --write-tree` fra `origin/main` e una head, che è l'ORACOLO
 * giusto per «questa PR è in conflitto?».
 *
 * Non `gh pr view --json mergeable`: quel campo è una cache che GitHub calcola
 * in modo asincrono e che risponde `UNKNOWN` proprio quando serve — subito dopo
 * un push su main, cioè esattamente il momento in cui i conflitti nascono.
 * `mergeableOf()` qui sopra fa un solo re-poll dopo 4 s e poi si arrende;
 * merge-tree invece calcola il merge davvero, senza toccare il working tree.
 *
 * @returns {{ state: 'clean'|'conflicted'|'unknown', conflicted: boolean, files: string[] }}
 */
function mergeTreeVerdict(headSha) {
  const res = spawnSync('git', ['merge-tree', '--write-tree', 'origin/main', headSha], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  // 0 = merge pulito, 1 = conflitti, >1 = non ha potuto calcolare (oggetto
  // mancante, storia shallow). Il terzo caso NON è «pulito»: non sappiamo, e
  // quindi nessuna label/commento può essere ricalcolata.
  const state = classifyMergeTreeStatus(res.status);
  if (state === 'unknown') {
    console.log(`  merge-tree non calcolabile (status=${res.status}): ${(res.stderr || '').trim().slice(0, 200)}`);
    return { state, conflicted: false, files: [] };
  }
  if (state === 'clean') return { state, conflicted: false, files: [] };
  return { state, conflicted: true, files: parseMergeTreeConflicts(res.stdout || '') };
}

/** Map merge-tree's process status to a fail-closed scan state. */
export function classifyMergeTreeStatus(status) {
  if (status === 0) return 'clean';
  if (status === 1) return 'conflicted';
  return 'unknown';
}

/**
 * I path in conflitto dall'output di `git merge-tree --write-tree`.
 *
 * Il formato è: prima riga l'OID dell'albero, poi una riga di stage per ogni
 * lato di ogni file in conflitto (`<mode> <oid> <stage>\t<path>`), poi le righe
 * informative `CONFLICT (...)`. Si leggono le righe di stage e non le righe
 * `CONFLICT`, perché quelle ultime hanno una forma libera e localizzabile
 * mentre le prime sono formato di plumbing.
 *
 * Esportata perché è l'unica parte pura: il resto spawna git.
 */
export function parseMergeTreeConflicts(stdout) {
  return [
    ...new Set(
      stdout
        .split('\n')
        .map((l) => /^[0-7]{6} [0-9a-f]{40} [123]\t(.+)$/.exec(l)?.[1])
        .filter(Boolean),
    ),
  ];
}

/**
 * Cosa fare della label, dato il verdetto e lo stato attuale.
 *
 * Separata perché è la parte che sbaglia in silenzio: una label appesa a una PR
 * già rebasata manda il prossimo agente a cercare un conflitto che non c'è.
 */
export function decideConflictLabel({ conflicted, hasLabel }) {
  if (conflicted && !hasLabel) return 'add';
  if (!conflicted && hasLabel) return 'remove';
  return 'none';
}

/**
 * Pure conflict-scan decision. Fetch failure and an uncomputable merge-tree
 * result are both `unknown`: neither authorizes a label mutation.
 */
export function decideConflictScan({ fetchOk, mergeTreeState, hasLabel }) {
  const state = fetchOk ? mergeTreeState : 'unknown';
  if (state === 'unknown') return { state, action: 'none' };
  if (state !== 'clean' && state !== 'conflicted') {
    throw new TypeError(`pr-autorebase: invalid merge-tree state ${String(state)}`);
  }
  return {
    state,
    action: decideConflictLabel({ conflicted: state === 'conflicted', hasLabel }),
  };
}

function git(args, { allowFail = false } = {}) {
  try {
    return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    if (allowFail) return null;
    throw e;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function authedUrl() {
  // Push via PAT così review + vitest ri-partono (anti-ricorsione GITHUB_TOKEN).
  return `https://x-access-token:${TOKEN}@github.com/${REPO}.git`;
}

// Push del branch forzando l'identità del TOKEN (App → `<app>[bot]`, fallback PAT
// → valerielinc-ops). `actions/checkout` (persist-credentials:true) persiste
// `http.https://github.com/.extraheader = AUTHORIZATION: basic <GITHUB_TOKEN>`,
// header che viaggia su OGNI push verso github.com e SOVRASCRIVE lo
// `x-access-token:<App/PAT>` embeddato in authedUrl() → il push si autentica come
// `github-actions[bot]`, e GitHub mette ogni workflow PR risultante in
// `action_required` (approvazione manuale, anti-ricorsione) — che non si
// auto-sblocca mai e si accumula. Azzerare l'extraheader per il SOLO push (`-c
// http.https://github.com/.extraheader=`) neutralizza l'override: vince il token
// in URL → i check ri-partono da soli, niente più approvazioni manuali. Se il
// TOKEN è invalido il push FALLISCE in modo visibile (niente fallback silenzioso
// a github-actions[bot]).
function pushBranch(branch) {
  return git(
    ['-c', 'http.https://github.com/.extraheader=', 'push', authedUrl(), `${branch}:${branch}`],
    { allowFail: true },
  );
}

/** Una review gestita con `## LGTM` sulla revisione body corrente? */
function hasLgtmReview(num, reviewRevision = currentReviewInputRevision(num)) {
  if (!reviewRevision) return false;
  const reviews = gh(['api', `repos/${REPO}/pulls/${num}/reviews`, '--paginate'], { allowFail: true });
  if (!Array.isArray(reviews)) return false;
  return reviews.some(
    (r) => isManagedReview(r)
      && reviewHasInputRevision(r.body, reviewRevision)
      && (r.body || '').includes('## LGTM')
  );
}

/** Esiste ALMENO una review gestita della revisione body corrente (LGTM o 🔴,
 * qualunque esito)? Serve a
 * distinguere la classe-A "review mai postata" (workflow-validation drift 401:
 * run review fallita, body vuoto) da "review postata con 🔴" (gestita dal
 * redflag-fixer, NON va ri-triggerata qui). */
function hasAnyManagedReview(num, reviewRevision = currentReviewInputRevision(num)) {
  if (!reviewRevision) return true; // API body illeggibile: non aprire/retriggerare alla cieca
  const reviews = gh(['api', `repos/${REPO}/pulls/${num}/reviews`, '--paginate'], { allowFail: true });
  if (!Array.isArray(reviews)) return true; // fail-safe: su errore API assumi review esistente (no reopen)
  return reviews.some((r) => isManagedReview(r) && reviewHasInputRevision(r.body, reviewRevision));
}

/** Re-trigger DETERMINISTICO di review+tests per una PR classe-A: il push PAT
 * non ri-triggera `pull_request` in modo affidabile e pr-review-loop non ha
 * workflow_dispatch — ma un close+reopen via PAT emette `reopened`, che
 * triggera SIA pr-review-loop SIA tests.yml. Senza questo, una PR rebasata ma
 * senza review resta senza LGTM fino al recycle 24h (finestra morta ~22h
 * osservata, dead-end #4 della mappa loop 2026-06-12). */
function reopenToRetrigger(num) {
  if (DRY) { console.log(`[dry] close+reopen #${num} (re-trigger review+tests)`); return true; }
  // BUDGET GUARD (#5145/#5144). Questa è la sola sezione NON ATOMICA dello
  // script: fra `close` e `reopen` la PR è CHIUSA. I guard sotto coprono il
  // fallimento dell'API, non il job UCCISO dal `timeout-minutes` — in quel caso
  // il processo sparisce fra le due chiamate e la PR resta chiusa senza che
  // nessuno la riapra (danno reale e duraturo, l'opposto di un run rosso
  // innocuo). Se non c'è il tempo di completare la coppia NON si comincia: la
  // PR resta intatta e il prossimo tick rifà la stessa valutazione.
  if (!budget.canAfford(REOPEN_COST_MS)) {
    console.log(`PR #${num}: budget di run insufficiente per la coppia close+reopen — NON la tocco (una chiusura senza riapertura lascerebbe la PR chiusa). Rimandata al prossimo tick.`);
    budget.defer(`#${num} (close+reopen)`);
    return false;
  }
  // NIENTE allowFail qui: con `json:false` allowFail ritorna '' sia su successo
  // (gh pr close/reopen confermano su stderr, stdout vuoto) sia su fallimento —
  // l'unico segnale affidabile è l'eccezione (🔴 review #1930: i guard ===null
  // non scattavano mai → rischio PR lasciata CHIUSA con falso successo).
  try {
    gh(['pr', 'close', String(num), '--repo', REPO], { json: false });
  } catch (e) {
    console.log(`PR #${num}: close fallito (${String(e).slice(0, 120)}) — skip reopen, PR intatta.`);
    return false;
  }
  // Da qui la PR È CHIUSA: mai uscire senza riaprirla. Retry con pausa, poi
  // ::error forte — invariante "mai lasciare la PR chiusa".
  //
  // La pausa non è cosmetica. Il 2026-08-06, durante un `major_outage` di
  // GitHub Actions, entrambi i tentativi immediati sono falliti sulla stessa
  // API degradata (`Could not open the pull request`) e #5269 è rimasta chiusa.
  // Due chiamate a distanza di millisecondi campionano lo stesso istante di
  // un'API che sta fallendo: distanziarle è ciò che le rende due tentativi.
  for (let attempt = 1; attempt <= REOPEN_ATTEMPTS; attempt++) {
    try {
      gh(['pr', 'reopen', String(num), '--repo', REPO], { json: false });
      return true;
    } catch (e) {
      if (attempt < REOPEN_ATTEMPTS) {
        try { execFileSync('sleep', [String(REOPEN_RETRY_SLEEP_S)]); } catch { /* best effort */ }
        continue;
      }
      // Esauriti i tentativi. L'`::error::` da solo non basta: nel run è
      // visibile a chi lo apre, e nel frattempo `delete-closed-unmerged` del
      // worktree-branch-janitor vede una PR closed-unmerged e CANCELLA il
      // branch — 8 secondi dopo, il 2026-08-06. Da lì il lavoro non è piu'
      // raggiungibile da remoto e la PR non è nemmeno riapribile (GitHub
      // rifiuta il reopen di una PR il cui head ref non esiste piu').
      //
      // La chiusura è recuperabile a mano; la cancellazione del branch no. La
      // label è il segnale che ferma proprio quella: il janitor la legge e
      // risparmia l'head ref. Vedi .github/workflows/worktree-branch-janitor.yml.
      gh(['pr', 'edit', String(num), '--repo', REPO, '--add-label', REOPEN_FAILED_LABEL],
        { json: false, allowFail: true });
      console.log(`::error::PR #${num} chiusa ma reopen FALLITO ${REOPEN_ATTEMPTS} volte (${String(e).slice(0, 120)}) — etichettata \`${REOPEN_FAILED_LABEL}\` per salvarne il branch; riaprire a mano.`);
      return false;
    }
  }
  return false;
}

/**
 * Impronta dello stato della PR per il breaker. Vedi il razionale completo in
 * lib/reopen-breaker.mjs: NIENTE head OID e NIENTE conteggio commit, perché
 * questo stesso script pusha un merge commit di main a ogni tick e li
 * cambierebbe SEMPRE, azzerando il contatore a ogni giro.
 */
function reopenStateFingerprint(num, vitestConclusion) {
  const d = gh(['pr', 'view', String(num), '--repo', REPO, '--json',
    'additions,deletions,changedFiles'], { allowFail: true }) || {};
  // `--jq 'length'` sotto `--paginate` conta PER PAGINA ("30\n30\n7"): il
  // conteggio si fa element-wise, una riga per review su tutte le pagine.
  const reviews = gh(['api', `repos/${REPO}/pulls/${num}/reviews?per_page=100`, '--paginate',
    '--jq', '.[].id'], { json: false, allowFail: true });
  return reopenFingerprint({
    additions: d.additions,
    deletions: d.deletions,
    changedFiles: d.changedFiles,
    vitestConclusion,
    reviewCount: countPaginatedLines(reviews),
  });
}

/** Ultimo verdetto vitest sull'head, NORMALIZZATO: una cancellazione da
 * concurrency non è un verdetto sul codice e non deve valere come `failure`
 * per la precondizione (altrimenti bloccherebbe PR sane). */
function normalizedVitestConclusion(head) {
  const runs = checkRunsOf(head);
  if (vitestVerdictIsTransientCancellation(runs)) return 'transient';
  return latestCompletedVitestConclusion(runs) || '';
}

/**
 * `reopenToRetrigger` con precondizione + circuit breaker davanti.
 *
 * TUTTE le riaperture passano di qui: chiamare `reopenToRetrigger` direttamente
 * rimetterebbe in piedi il loop misurato su #5896/#5906 (12 e 10 riaperture,
 * 55% di tutta la CI del repo in 8h). Il breaker non è un extra: il close+reopen
 * emette `reopened`, e `tests.yml` ha `on: pull_request` senza `types:` →
 * eredita `[opened, synchronize, reopened]`, quindi OGNI giro sbagliato costa
 * una vitest intera (~18min) su una coda serializzata.
 *
 * `stuckRedReason`: la reason di `stuckRedRescueReason(head)` quando la PR è
 * nel flusso come rescue STUCK-RED — cioè quando questo stesso run ha PROVATO
 * che il `failure` sull'head non è della PR (red-main/stale). In quel caso la
 * precondizione non deve scattare: il reopen È la ri-esecuzione promessa dal
 * commento STUCK_RED, e negarlo lascerebbe la PR (senza label near-merge, col
 * marker one-shot già consumato) in uno stato assorbente se il push-trigger
 * non parte — la stessa classe «zero archi uscenti» che lo stuck-red chiude.
 */
function guardedReopen(num, head, { stuckRedReason = '' } = {}) {
  const vitestConclusion = normalizedVitestConclusion(head);
  const fingerprint = reopenStateFingerprint(num, vitestConclusion);
  const body = readReopenBudgetBody(num);
  const prior = parseReopenBudget(body);
  // Rosso da review gate: causa del messaggio SEMPRE (anche a one-shot già
  // speso, altrimenti il commento tornerebbe a dire «far passare i test» a una
  // PR i cui test sono verdi), ma esenzione dalla precondizione una volta sola.
  const steps = vitestConclusion === 'failure' ? vitestJobSteps(head) : [];
  const reviewGateRed = vitestFailureIsReviewGate(steps);
  const reviewSkipped = reviewGateRed && reviewSkippedByGuard(steps);
  const reviewAborted = reviewGateRed && reviewAbortedWithoutVerdict(steps);
  const reviewGateReason = reviewGateRed && !reviewSkipped && !(prior && prior.reviewGateUsed)
    ? 'review-gate' : '';
  const reviewGateUsed = Boolean((prior && prior.reviewGateUsed) || reviewGateReason);
  const d = decideReopen({
    vitestConclusion, fingerprint, prior, max: MAX_REOPENS,
    failureNotAttributable: stuckRedReason || reviewGateReason,
    reviewGateFailure: reviewGateRed,
    reviewSkippedByGuard: reviewSkipped,
    reviewAborted,
  });

  if (d.action !== 'reopen') {
    // Segnalazione UNA SOLA: commento STICKY riscritto in place (non un
    // commento nuovo a ogni giro, non una issue nuova a ogni giro). Se il body
    // è già identico non si riscrive nemmeno quello — N tick = 0 notifiche in
    // più. Una segnalazione ripetuta sarebbe lo stesso difetto in altra forma.
    const next = renderReopenBudget({
      count: d.count, max: MAX_REOPENS, fingerprint, action: d.action, reason: d.reason,
      cause: d.cause, reviewGateUsed,
    });
    console.log(`PR #${num}: NO reopen (${d.action}) — ${d.reason}`);
    if (!DRY && !labelsOf(num).includes(BREAKER_LABEL)) {
      gh(['pr', 'edit', String(num), '--repo', REPO, '--add-label', BREAKER_LABEL],
        { json: false, allowFail: true });
    }
    if (body !== next) {
      upsertStickyComment(gh, REPO, num, REOPEN_BUDGET_MARKER, next, { dry: DRY });
    }
    return false;
  }

  // Il contatore si scrive PRIMA della coppia close+reopen: se il job muore in
  // mezzo il tentativo è comunque contato. Contarlo dopo renderebbe il breaker
  // cieco proprio ai giri che falliscono, cioè quelli che contano di più.
  const next = renderReopenBudget({
    count: d.count, max: MAX_REOPENS, fingerprint, action: d.action, reason: d.reason,
    cause: d.cause, reviewGateUsed,
  });
  if (body !== next) {
    upsertStickyComment(gh, REPO, num, REOPEN_BUDGET_MARKER, next, { dry: DRY });
  }
  console.log(`PR #${num}: reopen consentito — ${d.reason}`);
  return reopenToRetrigger(num);
}

/** Body del commento sticky del budget, o '' se non c'è. */
function readReopenBudgetBody(num) {
  // Element-wise + `@json` (un body per riga, escapato): un aggregato come
  // `| last` girerebbe PER PAGINA sotto `--paginate` e concatenerebbe l'ultimo
  // match di OGNI pagina, restituendo due body incollati invece di uno.
  const raw = gh(['api', `repos/${REPO}/issues/${num}/comments?per_page=100`, '--paginate',
    '--jq', `.[] | select(.body // "" | contains("${REOPEN_BUDGET_MARKER}")) | .body | @json`],
  { json: false, allowFail: true });
  return lastPaginatedJsonLine(raw);
}

/** Label correnti della PR (rilette: il breaker può averle appena cambiate). */
function labelsOf(num) {
  const raw = gh(['pr', 'view', String(num), '--repo', REPO, '--json', 'labels',
    '--jq', '[.labels[].name] | join(",")'], { json: false, allowFail: true });
  return (raw || '').trim().split(',').filter(Boolean);
}

/** behind_by: commit di main non nella head. */
function behindMain(head) {
  const out = gh(['api', `repos/${REPO}/compare/main...${head}`, '--jq', '.behind_by // 0'],
    { json: false, allowFail: true });
  return parseInt((out || '0').trim(), 10) || 0;
}

/** Minuti dall'ultimo push sull'head = committer date del commit head. Serve
 * all'activity-guard: un head appena pushato = contributor/agent mid-flight. */
function headPushedMinutesAgo(head) {
  const iso = gh(['api', `repos/${REPO}/commits/${head}`, '--jq', '.commit.committer.date'],
    { json: false, allowFail: true });
  const t = Date.parse((iso || '').trim());
  if (Number.isNaN(t)) return Infinity; // sconosciuto → non bloccare il rebase
  return (Date.now() - t) / 60000;
}

/** I check-run di un head, fetchati UNA volta e memoizzati per head.
 *
 * Quattro funzioni qui sotto (`headHasVitestCheck`, `vitestConclusion`,
 * `vitestVerdictIsTransient`, `stuckRedRescueReason`) ponevano quattro domande
 * diverse allo STESSO identico endpoint, e dal 2026-08-22 la stuck-red si
 * valuta per ogni PR con vitest rosso (non più solo per le non-near-merge):
 * senza memoizzazione quel cambio avrebbe moltiplicato le chiamate invece di
 * lasciarle invariate. La cache è per-head e vive quanto il processo — un run
 * dell'autorebase dura secondi e un head è immutabile, quindi non può servire
 * un dato stantio per il codice che sta esaminando. */
const _checkRuns = new Map();
function checkRunsOf(head) {
  if (_checkRuns.has(head)) return _checkRuns.get(head);
  const out = pollUntil({
    read: () => gh(['api', `repos/${REPO}/commits/${head}/check-runs?per_page=100`]),
    ready: (response) => !vitestCheckNeedsPolling(response?.check_runs),
    attempts: VITEST_POLL_ATTEMPTS,
    delayMs: VITEST_POLL_DELAY_MS,
    sleep: sleepSync,
  });
  const runs = Array.isArray(out?.check_runs) ? out.check_runs : [];
  _checkRuns.set(head, runs);
  return runs;
}

/** Esiste già un check-run `vitest (unit + integration)` sull'head (qualunque
 * stato: queued/in_progress/completed)? Serve a (a) non ri-dispatchare se vitest
 * sta già girando o è concluso, e (b) rilevare gli head "orfani" a 0 check-run
 * lasciati da un push PAT che non ha ri-triggerato `pull_request` o da un
 * autorebase pre-#1597 che pushava senza dispatchare. */
function headHasVitestCheck(head) {
  return checkRunsOf(head).some((c) => c && c.name === VITEST_CHECK_NAME);
}

/** Conclusion del check-run `vitest (unit + integration)` sull'head (''
 * se assente/pending). Diverso da headHasVitestCheck (sola presenza): serve a
 * NON skippare il rebase quando vitest=`failure` — una PR behind+LGTM con vitest
 * rosso NON è mergeable-as-is (auto-merge-eval esige conclusion==success), quindi
 * va rebasata per ereditare eventuali fix lato main invece di restare stuck
 * (autorebase skippa, auto-merge rifiuta → loop). Prende l'ultimo check-run
 * vitest COMPLETATO (per completed_at), non un `[0]` arbitrario, così un
 * workflow_dispatch manuale cancellato sullo stesso SHA non avvelena il verdetto
 * (stessa classe del bug #2394). Vedi lib/vitestCheck.mjs. */
function vitestConclusion(head) {
  return latestCompletedVitestConclusion(checkRunsOf(head));
}

/** Il verdetto vitest rosso sull'head è una cancellazione transient da
 * concurrency e NON un test rotto? Due topologie: job singolo (post-de-shard
 * #2882) → il check-run stesso è `cancelled`; matrice a shard (#2438) →
 * l'aggregatore collassa cancelled→failure e il helper riapre gli shard. Serve
 * al ramo behind===0: senza, una PR LGTM+behind=0 con un rosso transient restava
 * ferma (heal solo su check ASSENTE). Vedi lib/vitestCheck.mjs. */
function vitestVerdictIsTransient(head) {
  return vitestVerdictIsTransientCancellation(checkRunsOf(head));
}

/** Ultimi run COMPLETATI di `tests.yml` sul branch main, per stabilire se main è
 * tornato verde DOPO che una PR è stata testata (vedi
 * `vitestFailureIsNotAttributableToPr`). Fetchato UNA volta per run
 * dell'autorebase e memoizzato: è lo stesso identico dato per tutte le PR, e la
 * finestra di 50 run copre abbondantemente sia una giornata di main caldo sia i
 * ~3 giorni della finestra rossa 2026-08-02→04. */
let _mainTestsRuns = null;
function mainTestsRuns() {
  if (_mainTestsRuns) return _mainTestsRuns;
  const out = gh(
    ['api', `repos/${REPO}/actions/workflows/tests.yml/runs?branch=main&status=completed&per_page=50`]);
  _mainTestsRuns = (out && out.workflow_runs) || [];
  return _mainTestsRuns;
}

/** Gli step del job che ha prodotto l'ultimo check-run vitest COMPLETATO
 * sull'head. Il job id si ricava dal `details_url` del check-run
 * (`.../runs/<run_id>/job/<job_id>`), che è l'unico riferimento che la
 * check-runs API dà al job di Actions. Accetta solo il job del tentativo
 * corrente con lo stesso head e verdetto: un rerun può lasciare link vecchi.
 * `[]` se il link non è parsabile, il job è superato o resta non concluso dopo
 * il polling → `vitestFailureIsReviewGate` risponde `false` e vale la
 * precondizione normale (fail-CLOSED: nel dubbio non si ricicla). Gli errori
 * HTTP non vengono convertiti in `[]`. */
const _vitestJobSteps = new Map();
function vitestJobSteps(head) {
  if (_vitestJobSteps.has(head)) return _vitestJobSteps.get(head);
  const checks = checkRunsOf(head);
  if (vitestCheckNeedsPolling(checks)) {
    _vitestJobSteps.set(head, []);
    return [];
  }
  const last = latestCompletedVitestExecutionRun(checks);
  const ref = jobRefFromCheckRun(last);
  if (!ref) {
    _vitestJobSteps.set(head, []);
    return [];
  }
  const out = pollUntil({
    read: () => gh(['api', `repos/${REPO}/actions/runs/${ref.runId}/jobs?filter=latest&per_page=100`, '--paginate', '--jq', '.jobs']),
    ready: (jobs) => Array.isArray(jobs) && jobs.some(
      (job) => String(job?.id) === ref.jobId && vitestJobIsConcluded(job),
    ),
    attempts: VITEST_POLL_ATTEMPTS,
    delayMs: VITEST_POLL_DELAY_MS,
    sleep: sleepSync,
  });
  const steps = currentAttemptJobSteps({
    checkRun: last,
    jobId: ref.jobId,
    jobs: Array.isArray(out) ? out : [],
  });
  _vitestJobSteps.set(head, steps);
  return steps;
}

/** Il vitest rosso sull'head NON è attribuibile alla PR (main rosso al momento
 * del test e poi tornato verde, oppure rosso stantio da >24h = infra)? Ritorna
 * la `reason` (`'red-main'`/`'stale'`) o '' . Vedi lib/vitestCheck.mjs. */
function stuckRedRescueReason(head) {
  const { rescue, reason } = vitestFailureIsNotAttributableToPr({
    checkRuns: checkRunsOf(head),
    mainTestsRuns: mainTestsRuns(),
    staleHours: STUCK_RED_STALE_H,
  });
  return rescue ? reason : '';
}

/** Un commento della PR contiene già `marker`? Dedup condivisa fra il comment di
 * conflitto e il rescue one-shot dello stuck-red. */
function hasCommentMarker(num, marker) {
  return hasCommentMarkerShared(gh, REPO, num, marker);
}

/** C'è una review Claude ANCORA in volo sull'head (Jobs API: lo step `Run Claude
 * review` è `queued`/`in_progress`)? Dal 2026-08-26 la review vive dentro il
 * job `vitest (unit + integration)`: cercare un check-run chiamato `review`
 * è quindi un segnale morto. Il push del rebase si autentica via
 * App/PAT (x-access-token) e quindi RI-TRIGGERA `pull_request` → `pr-review-loop`
 * ha `cancel-in-progress: true` → il nostro push CANCELLA la review in corso e ne
 * avvia un'altra. Con main caldo (commit ogni pochi minuti) e una review da
 * ~8-11min, una PR collision-risk va `behind>0` a metà review, l'autorebase la
 * rebasa, il push cancella la review, che riparte → LIVELOCK: la review non
 * conclude mai, l'`## LGTM` non viene mai postato, niente merge (e quota Claude
 * bruciata a ogni restart). Difesa: se una review è in volo, DEFER il rebase di un
 * tick (come ACTIVITY_GUARD). Il rebase non è urgente (main è sempre fresco); la
 * review conclude, posta il verdetto, e auto-merge-eval porta avanti l'LGTM. */
function reviewInProgress(head) {
  const checks = checkRunsOf(head);
  const activeVitest = checks.filter(
    (check) => check?.name === VITEST_EXECUTION_JOB_NAME &&
      ['queued', 'in_progress'].includes(String(check.status || '')),
  );
  for (const check of activeVitest) {
    const jobId = /\/job\/(\d+)(?:[/?#]|$)/.exec(check.details_url || '')?.[1];
    // An active check with no job link is still an unknown review state. Do
    // not rebase into that gap: the push could cancel a review whose Jobs API
    // record has not been materialized yet.
    if (!jobId) return true;
    const job = pollUntil({
      read: () => gh(['api', `repos/${REPO}/actions/jobs/${jobId}`]),
      ready: (response) => vitestJobIsConcluded(response)
        && Array.isArray(response.steps) && response.steps.length > 0,
      attempts: VITEST_POLL_ATTEMPTS,
      delayMs: VITEST_POLL_DELAY_MS,
      sleep: sleepSync,
    });
    // During startup GitHub can return the job with `steps: []` or without a
    // terminal conclusion; neither is a negative answer, it is the short
    // window before the review step appears/finishes.
    if (!vitestJobIsConcluded(job) || !Array.isArray(job.steps) || job.steps.length === 0) return true;
    if (reviewStepIsInFlight(job?.steps)) return true;
  }
  return false;
}

/** Statuti NON terminali di un workflow-run GitHub: il run sta ancora
 * occupando (o sta per occupare) uno slot di concurrency, quindi un push sulla
 * stessa ref lo CANCELLA. `completed` è l'unico terminale. */
const RUN_STATUS_IN_FLIGHT = new Set(['queued', 'in_progress', 'waiting', 'requested', 'pending']);

/**
 * C'è un run di `tests.yml` ancora IN VOLO esattamente sulla head SHA corrente
 * della PR? Puro → testabile senza rete (la lista run arriva dal chiamante).
 *
 * Livelock misurato il 2026-08-18 su #6037 (branch `fix/unsub-window-and-channel`):
 * la suite `tests` dura 16-21 min, e in giornata attiva i merge su main arrivano
 * ogni pochi minuti. `pr-autorebase.yml` scatta a OGNI merge (`pull_request:
 * closed` + cron + `pull_request_review`), rebasa, pusha — e il push CANCELLA il
 * `tests` in corso (`19:09 cancelled · 19:11 cancelled · 19:25 cancelled · 19:25
 * cancelled · 19:33 cancelled`, mai un `success`). Siccome `pr-review-loop` parte
 * SOLO su `workflow_run` di `tests` con `conclusion == success`, la review non
 * arriva mai → la PR resta `stale-review` → l'autorebase ricomincia. Il budget di
 * riaperture non salva: i merge commit dell'autorebase contano come «stato
 * cambiato» e azzerano il contatore.
 *
 * Il confronto con `head` è la parte che rende la guardia CORRETTA e non un
 * semplice «esiste un run in corso»: un run rimasto in volo su una head VECCHIA
 * (PR ripushata nel frattempo) non produrrà mai il segnale che serve — il suo
 * `workflow_run` porta il SHA sbagliato e `pr-review-loop` non gatterà la head
 * attuale. Deferire per lui sarebbe uno stallo gratuito, quindi NON si salta.
 *
 * @param {{runs: Array<{id?: number, status?: string, head_sha?: string}>, head: string}} s
 * @returns {{id: number|null, status: string}|null} il run che blocca, o null.
 */
export function testsRunInFlightOnHead({ runs, head }) {
  if (!head || !Array.isArray(runs)) return null;
  for (const r of runs) {
    if (!r || r.head_sha !== head) continue;
    const status = String(r.status || '');
    if (!RUN_STATUS_IN_FLIGHT.has(status)) continue;
    return { id: typeof r.id === 'number' ? r.id : null, status };
  }
  return null;
}

/** Run di `tests.yml` sul branch della PR (qualunque stato, ultimi 20): la
 * selezione per head SHA + stato la fa `testsRunInFlightOnHead` (pura). Gli
 * errori API attraversano `gh`, invece di sembrare una lista vuota. */
function testsRunsForBranch(branch) {
  const out = gh(
    ['api', `repos/${REPO}/actions/workflows/tests.yml/runs?branch=${encodeURIComponent(branch)}&per_page=20`]);
  return (out && Array.isArray(out.workflow_runs)) ? out.workflow_runs : [];
}

/**
 * Decisione rebase per una PR near-merge che è behind>0 (valutata DOPO il check
 * CONFLITTO). Pura → testabile; il razionale del livelock è al call-site.
 * @param {{lgtm: boolean, collisionBlocked: boolean, vitestConclusion: string, hasVitestCheck: boolean}} s
 * @returns {'rebase'|'skip'|'heal'}
 *   'rebase' = la PR va rebasata (collisionBlocked: il gate collisione preciso
 *              di auto-merge-eval bloccherebbe il merge, #6039 — non più la
 *              sola presenza della label, vedi collisionGateBlocks al call-site,
 *              OPPURE vitest=failure va rebasato per ereditare i fix di main,
 *              OPPURE non-LGTM → non near-merge-as-is).
 *   'skip'   = LGTM, non-collision, vitest non-failure, check vitest PRESENTE →
 *              non rebasare (main è non-strict, auto-merge la mergia behind);
 *              rebasare orfanizzerebbe l'head (LIVELOCK).
 *   'heal'   = come 'skip' MA head orfana (nessun check vitest) → dispatch tests
 *              invece di rebasare, così il vitest atterra su head stabile.
 */
export function rebaseActionForLgtmPr({ lgtm, collisionBlocked, vitestConclusion, hasVitestCheck }) {
  if (!lgtm || collisionBlocked || vitestConclusion === 'failure') return 'rebase';
  return hasVitestCheck ? 'skip' : 'heal';
}

/**
 * `collision-risk` da sola NON forza più il rebase (#6039): auto-merge-eval è
 * stato indurito da #2424 a un gate PRECISO (collisionGateDecision) che blocca
 * il merge SOLO se un peer collidente già MERGIATO non è ancora incluso in
 * head — non per il semplice fatto che la PR sia dietro main. Prima di questo
 * fix le due funzioni applicavano regole diverse alla stessa label: qui si
 * forzava sempre 'rebase', il gate di merge no → una PR verde restava behind
 * indefinitamente, e il rebase inutile (push PAT) ri-triggerava `tests.yml`
 * cancellando la review vera nello stesso slot di concurrency (#6023: run
 * 32157777892 cancellato da run gemelli, PR verde 40min senza review).
 * Replica ESATTAMENTE la stessa query (peer dai marker `<!-- COLLISION:N -->`,
 * ancestry via compare API) e riusa `collisionGateDecision` — stessa funzione
 * pura importata da auto-merge-eval.mjs, zero drift possibile fra le due.
 * Conservativo su errore API (comments/peer/compare irraggiungibili): blocca
 * (rebase), mai un salto silenzioso su dati incompleti.
 */
function collisionGateBlocks(num, head, behind) {
  if (behind <= 0) return false;
  const comments = gh(['api', `repos/${REPO}/issues/${num}/comments`, '--paginate',
    '--jq', '[.[].body] | join("\\n")'], { json: false, allowFail: true });
  if (!comments) return true;
  const peers = parseCollisionPeers(comments);
  const mergedPeers = [];
  for (const peer of peers) {
    const pv = gh(['pr', 'view', String(peer), '--repo', REPO, '--json', 'state,mergeCommit'], { allowFail: true });
    if (pv === null) {
      mergedPeers.push({ number: peer, includedInHead: false });
      continue;
    }
    if (pv.state !== 'MERGED' || !pv.mergeCommit?.oid) continue;
    const status = gh(['api', `repos/${REPO}/compare/${pv.mergeCommit.oid}...${head}`, '--jq', '.status'],
      { json: false, allowFail: true });
    const included = status !== null && (status.trim() === 'ahead' || status.trim() === 'identical');
    mergedPeers.push({ number: peer, includedInHead: included });
  }
  return !collisionGateDecision({ behind, mergedPeers }).allow;
}

/** Dispatcha tests.yml sul branch → il check-run vitest atterra sull'head e il
 * suo `workflow_run: completed` ri-valuta auto-merge-on-lgtm (LGTM portato avanti
 * da auto-merge-eval). Best-effort: serve PAT con scope actions:write. */
function dispatchTests(num, branch) {
  if (DRY) { console.log(`[dry] dispatch tests.yml --ref ${branch} (#${num})`); return true; }
  // `gh workflow run` stampa l'URL del run SOLO "if available" (spesso vuoto
  // anche a successo, per propagazione API) → lo stesso sentinel ambiguo di
  // gh(json:false) qui non basta a distinguere successo da errore (vedi fix
  // di collisionGateBlocks sopra). Rileva il fallimento reale via eccezione
  // (exit code), non via contenuto di stdout.
  try {
    execFileSync('gh', ['workflow', 'run', 'tests.yml', '--ref', branch],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    return true;
  } catch {
    console.log(`::warning::PR #${num}: 'gh workflow run tests.yml --ref ${branch}' fallito — vitest potrebbe non ripartire sull'head; verifica scope actions:write del PAT.`);
    return false;
  }
}

/** mergeable con un poll su UNKNOWN. */
async function mergeableState(num) {
  let m = gh(['pr', 'view', String(num), '--repo', REPO, '--json', 'mergeable',
    '--jq', '.mergeable'], { json: false, allowFail: true });
  m = (m || '').trim();
  if (m === 'UNKNOWN' || m === '') {
    await sleep(4000); // GitHub calcola la mergeability in async
    m = gh(['pr', 'view', String(num), '--repo', REPO, '--json', 'mergeable',
      '--jq', '.mergeable'], { json: false, allowFail: true });
    m = (m || '').trim();
  }
  return m;
}

function ensureStaleLabel(num) {
  if (DRY) { console.log(`[dry] +label stale-review #${num}`); return; }
  gh(['pr', 'edit', String(num), '--repo', REPO, '--add-label', 'stale-review'],
    { json: false, allowFail: true });
}

/**
 * Consuma la label di rescue dopo che il suo rebase/ri-trigger è riuscito.
 * Lasciarla appesa riattiva il ramo stale a ogni evento e può riproporre un
 * autorebase già completato; se l'azione successiva fallisce, invece, la
 * label resta per il prossimo rescue.
 */
function clearStaleReviewLabel(num) {
  if (DRY) { console.log(`[dry] -label stale-review #${num}`); return; }
  gh(['pr', 'edit', String(num), '--repo', REPO, '--remove-label', 'stale-review'],
    { json: false, allowFail: true });
}

/**
 * Pass di sola RILEVAZIONE: dice se la PR è in conflitto con main, e lo dice
 * sulla PR. Non tocca il branch, non pusha, non dispatcha, zero Claude.
 *
 * Etichetta dedicata `has-conflicts` e NON `stale-review`: quest'ultima ha
 * effetti collaterali sul ciclo di review (l'autorebase la consuma e la review
 * viene rifatta a ogni giro), quindi usarla per un segnale informativo
 * costerebbe una review Claude per ogni PR in conflitto, a ogni tick.
 *
 * Il commento è one-shot (marker), la label invece è ricalcolata a ogni run:
 * appena il conflitto rientra la label sparisce, così non resta appesa a una PR
 * che qualcuno ha già rebasato a mano.
 */
function reportMainConflict(num, branch, head, labels) {
  const fetched = git(['fetch', 'origin', branch, 'main'], { allowFail: true });
  if (fetched === null) {
    console.log(`PR #${num}: fetch di ${branch}/main fallito → conflitto non verificabile; preservo label/commento esistenti.`);
    return null;
  }
  const verdict = mergeTreeVerdict(head);
  const hasLabel = labels.includes(MAIN_CONFLICT_LABEL);
  const scan = decideConflictScan({ fetchOk: true, mergeTreeState: verdict.state, hasLabel });

  if (scan.state === 'unknown') {
    console.log(`PR #${num}: merge-tree non verificabile → preservo label/commento esistenti.`);
    return null;
  }

  if (scan.state === 'clean') {
    if (scan.action === 'remove') {
      console.log(`PR #${num}: conflitto rientrato → -label ${MAIN_CONFLICT_LABEL}.`);
      if (!DRY) {
        gh(['pr', 'edit', String(num), '--repo', REPO, '--remove-label', MAIN_CONFLICT_LABEL],
          { json: false, allowFail: true });
      }
    }
    return false;
  }

  console.log(`PR #${num}: CONFLITTO con main su ${verdict.files.length} file — ${verdict.files.slice(0, 5).join(', ')}`);
  if (DRY) { console.log(`[dry] +label ${MAIN_CONFLICT_LABEL} #${num}`); return true; }

  if (scan.action === 'add') {
    // La label può non esistere ancora nel repo: creala best-effort, come fa
    // `ensureLabelsExist` in github-issue-creator.
    gh(['label', 'create', MAIN_CONFLICT_LABEL, '--repo', REPO,
      '--color', 'B60205', '--description', 'La PR è in conflitto con main (rilevato da pr-autorebase)'],
      { json: false, allowFail: true });
    gh(['pr', 'edit', String(num), '--repo', REPO, '--add-label', MAIN_CONFLICT_LABEL],
      { json: false, allowFail: true });
  }

  if (hasCommentMarker(num, MAIN_CONFLICT_MARKER)) return true;
  const list = verdict.files.slice(0, 20).map((f) => `- \`${f}\``).join('\n');
  const more = verdict.files.length > 20 ? `\n\n…e altri ${verdict.files.length - 20} file.` : '';
  const body = `${MAIN_CONFLICT_MARKER}\n⚠️ **Questa PR è in conflitto con \`main\`.**

File in conflitto (\`git merge-tree --write-tree origin/main ${head.slice(0, 8)}\`):

${list}${more}

\`\`\`bash
git fetch origin main && git merge origin/main
# risolvi, poi:
git add -A && git commit && git push
\`\`\`

Nota per chi automatizza: \`gh pr view --json mergeable\` **non** è l'oracolo — è una cache asincrona che risponde \`UNKNOWN\` proprio subito dopo un push su main, cioè quando i conflitti nascono. Quello sopra lo è.

_Segnale deterministico da pr-autorebase.yml (zero-Claude). La label sparisce da sola quando il conflitto rientra._`;
  gh(['pr', 'comment', String(num), '--repo', REPO, '--body', body], { json: false, allowFail: true });
  return true;
}

// --- HAND-OFF di un conflitto DOPO il LGTM (2026-09-19) ---------------------
// Un conflitto non risolvibile dalle classi additive sicure si ferma qui:
// abort, `stale-review`, un
// commento. Su una PR gia' approvata e' il punto in cui il ciclo perde la PR:
// nessun fixer risolve conflitti (redcheck-fixer vuole un check rosso,
// redflag-fixer un 🔴), il rescuer aspetta 2 h di silenzio e il recycle 24 h.
// #9260 sul sito: LGTM alle 14:04, ripresa a mano alle 16:13; qui #1597:
// AUTOREBASE_CONFLICT alle 13:44, nessuna ripresa per 3 h. Il rimedio esistente che risolve un conflitto e' un agente con
// il contesto della PR, e il ciclo ne avvia uno solo da una issue `agent:fix`:
// (corpus: stesso blocco del sito, #9293; qui GH_TOKEN e' il PAT nanako, che
// il sender gate di issue-fix ammette).
// la issue qui sotto lo avvia subito, con la PR, la HEAD e i file in
// conflitto gia' scritti, invece di attendere che qualcuno legga la label.
//
// Solo con LGTM: senza, la PR non e' pronta al merge e il conflitto resta un
// dettaglio del lavoro in corso del suo autore. One-shot per HEAD (marker nel
// commento della PR): una HEAD nuova e' un conflitto nuovo.
export const CONFLICT_HANDOFF_MARKER_PREFIX = '<!-- AUTOREBASE_CONFLICT_HANDOFF';

export function conflictHandoffMarker(head) {
  return `${CONFLICT_HANDOFF_MARKER_PREFIX} head=${String(head).slice(0, 12)} -->`;
}

/** Il conflitto merita un agente adesso? Puro: niente rete. */
export function shouldHandOffConflict({ lgtm, alreadyHandedOff }) {
  return Boolean(lgtm) && !alreadyHandedOff;
}

/** Titolo stabile e body della issue di hand-off. Puro: niente rete. */
export function buildConflictHandoffIssue({ num, branch, head, files }) {
  const list = (files || []).slice(0, 30).map((f) => `- \`${f}\``).join('\n') || '- (elenco non disponibile: ricalcolalo con il comando sotto)';
  const title = `Conflitto con main dopo LGTM: riapplicare la PR #${num} su main`;
  const body = [
    `La PR #${num} (branch \`${branch}\`, HEAD \`${String(head).slice(0, 12)}\`) aveva un \`## LGTM\` ed e' entrata in conflitto con \`main\`. L'autorebase deterministico ha provato \`git merge origin/main\` e l'unione degli import, poi ha abortito: il conflitto tocca codice, non solo import.`,
    '',
    'File in conflitto:',
    '',
    list,
    '',
    'Da fare:',
    '',
    `1. \`git fetch origin main ${branch}\` e \`git diff $(git merge-base origin/main origin/${branch}) origin/${branch}\`: e' il contributo della PR, gia' approvato.`,
    '2. Riapplicalo su `origin/main` nel branch di questa issue risolvendo i conflitti: conserva il comportamento arrivato su `main` E quello della PR. Nessuna modifica oltre a quella gia\' approvata.',
    `3. Apri la PR con \`Supersedes #${num}\` e \`Closes\` di questa issue, poi chiudi #${num} con un commento che rimanda alla nuova PR.`,
    '',
    'Se il conflitto e\' gia\' stato risolto sul branch originale (la PR torna mergeable), chiudi questa issue senza PR.',
    '',
    '_Aperta da pr-autorebase (zero-Claude) al primo conflitto non auto-risolvibile dopo il LGTM._',
  ].join('\n');
  return { title, body };
}

/** `gh` con esito binario: true solo se il comando e' uscito 0. */
function ghOk(args) {
  try {
    execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return true;
  } catch {
    return false;
  }
}

function handOffConflictToFixer(num, branch, head, lgtm) {
  const marker = conflictHandoffMarker(head);
  if (!shouldHandOffConflict({ lgtm, alreadyHandedOff: lgtm && hasCommentMarker(num, marker) })) return;
  // Il ramo chiamante puo' essersi basato su `mergeable=CONFLICTING`, che e'
  // una cache: l'hand-off parte solo se merge-tree conferma ADESSO un
  // conflitto. `clean` o `unknown` → nessuna issue (fail-closed).
  const verdict = mergeTreeVerdict(head);
  if (verdict.state !== 'conflicted') {
    console.log(`PR #${num}: merge-tree ${verdict.state} al momento dell'hand-off → nessuna issue.`);
    return;
  }
  const { title, body } = buildConflictHandoffIssue({ num, branch, head, files: verdict.files });
  if (DRY) { console.log(`[dry] #${num} conflitto dopo LGTM → issue agent:fix «${title}»`); return; }
  // Il titolo e' stabile: una issue gia' aperta da un tick precedente (routing
  // fallito, marker non scritto) viene riusata invece di duplicata.
  const existing = gh(['issue', 'list', '--repo', REPO, '--state', 'open', '--search', `"${title}" in:title`,
    '--json', 'number,title'], { allowFail: true });
  if (existing === null) {
    console.log(`::warning::PR #${num}: elenco issue illeggibile → hand-off rinviato al prossimo tick.`);
    return;
  }
  let issue = String((existing || []).find((i) => i.title === title)?.number || '');
  if (!issue) {
    // `agent:triaged` alla creazione: il triage la manderebbe comunque in coda
    // (`agent:fix-queued`), cioe' ore invece di minuti. `agent:fix` arriva con
    // un edit separato, perche' e' l'evento `labeled` a far partire issue-fix,
    // e l'identita' di GH_TOKEN e' quella ammessa dal suo sender gate.
    const url = String(gh(['issue', 'create', '--repo', REPO, '--title', title, '--body', body,
      '--label', 'agent:triaged'], { json: false, allowFail: true }) || '').trim();
    issue = /\/issues\/(\d+)/.exec(url)?.[1] || '';
  }
  if (!issue) {
    console.log(`::warning::PR #${num}: issue di hand-off del conflitto non creata — resta la label stale-review.`);
    return;
  }
  // Esito dall'exit status, non dallo stdout: senza routing confermato il
  // marker NON si scrive, cosi' il prossimo tick riprova sulla stessa issue.
  if (!ghOk(['issue', 'edit', issue, '--repo', REPO, '--add-label', 'agent:fix'])) {
    console.log(`::warning::issue #${issue}: agent:fix non applicata — marker non scritto, ritento al prossimo tick.`);
    return;
  }
  gh(['pr', 'comment', String(num), '--repo', REPO, '--body',
    `${marker}\n♻️ **autorebase / conflitto dopo LGTM**: affidato a issue-fix con #${issue}, che riapplica il contributo approvato su \`main\` in una PR nuova. _Segnale deterministico da pr-autorebase (zero-Claude)._`],
  { json: false, allowFail: true });
  console.log(`PR #${num}: conflitto dopo LGTM → hand-off a issue-fix con #${issue}.`);
}

function commentConflictOnce(num, branch) {
  // Dedup: salta se il marker è già presente in un commento.
  if (hasCommentMarker(num, CONFLICT_MARKER)) {
    console.log(`PR #${num}: marker conflitto già presente — no comment.`);
    return;
  }
  const body = `${CONFLICT_MARKER}\n♻️ **autorebase**: \`git merge origin/main\` su \`${branch}\` ha prodotto un CONFLITTO — abort eseguito, branch invariato. Etichettata \`stale-review\`: il branch è dietro main e va rebasato a mano (o verrà riciclato da recycle-stale-prs se resta fermo). _Segnale deterministico da pr-autorebase.yml (zero-Claude)._`;
  if (DRY) { console.log(`[dry] comment conflict #${num}`); return; }
  gh(['pr', 'comment', String(num), '--repo', REPO, '--body', body], { json: false, allowFail: true });
}

// --- AUTO-RESOLVE conflitti testuali dimostrabilmente additivi ----------------
// Quando due PR toccano gli `import` dello stesso file, `git merge origin/main`
// produce un conflitto di SOLE righe import (entrambi i lati aggiungono import
// DISTINTI). È risolvibile in modo sicuro per UNIONE (tieni entrambi). Osservato
// #2057: `import {FX_HREF,...} from './comparatorHref'` (PR) vs `import
// {cantonGrossSalaryBand} from './cantonSalaryIndex'` (main) → stuck CONFLICTING
// finché un umano non l'ha risolto a mano. Questo automatizza ESATTAMENTE quel
// caso. #606 aggiunge la seconda classe ratificata: hunk diff3 in cui ENTRAMBI
// i lati conservano il base byte-per-byte e aggiungono soltanto entry monoriga
// terminate da virgola (array/mappe). È il caso concreto di #601: due PR
// aggiungevano stringhe adiacenti agli stessi array di test. Qualunque modifica,
// cancellazione, statement libero, collisione di chiave o marker ambiguo resta
// non-sicuro → abort + stale-review/handoff. Il push post-resolve passa comunque
// dal gate tests+review di auto-merge-eval.

function parseConflictHunk(lines, start) {
  const ours = [];
  const base = [];
  const theirs = [];
  let phase = 'ours';
  let hasBase = false;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('<<<<<<<')) return null;
    if (line.startsWith('|||||||')) {
      if (phase !== 'ours') return null;
      hasBase = true;
      phase = 'base';
      continue;
    }
    if (line.startsWith('=======')) {
      if (phase !== 'ours' && phase !== 'base') return null;
      phase = 'theirs';
      continue;
    }
    if (line.startsWith('>>>>>>>')) {
      if (phase !== 'theirs') return null;
      return { ours, base: hasBase ? base : null, theirs, end: i };
    }
    if (phase === 'ours') ours.push(line);
    else if (phase === 'base') base.push(line);
    else if (phase === 'theirs') theirs.push(line);
    else return null;
  }
  return null;
}

const isImportOnlyBlock = (block) => block.every((line) => (
  line.trim() === ''
  || /^\s*import\s/.test(line)
  || /^\s*\/\//.test(line)
  || /^\s*\*/.test(line)
));

function resolveImportBlock(base, ours, theirs, importedBindings) {
  if (!isImportOnlyBlock(ours) || !isImportOnlyBlock(theirs)) return null;
  // A diff3 hunk is safe only when both sides retain the exact base sequence.
  // Otherwise one side may have deleted/replaced an import while the other
  // merely added one; unioning them would silently resurrect removed code.
  // Two-way hunks have no base evidence and retain the historical import-only
  // path.
  if (base !== null && (!additionsAroundBase(base, ours) || !additionsAroundBase(base, theirs))) return null;
  const seenLines = new Set();
  const union = [];
  for (const line of [...ours, ...theirs]) {
    const key = line.trim();
    if (!key || seenLines.has(key)) continue;
    const match = /import\s+(?:type\s+)?\{([^}]*)\}/.exec(line);
    if (match) {
      for (const binding of match[1].split(',').map((part) => part.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean)) {
        if (importedBindings.has(binding)) return null;
        importedBindings.add(binding);
      }
    }
    seenLines.add(key);
    union.push(line);
  }
  return union;
}

function additionsAroundBase(base, side) {
  const gaps = Array.from({ length: base.length + 1 }, () => []);
  let cursor = 0;
  for (let anchor = 0; anchor < base.length; anchor++) {
    while (cursor < side.length && side[cursor] !== base[anchor]) {
      gaps[anchor].push(side[cursor++]);
    }
    if (cursor >= side.length) return null;
    cursor += 1;
  }
  gaps[base.length].push(...side.slice(cursor));
  return gaps;
}

function decodeJsStringKey(token) {
  const quote = token[0];
  const body = token.slice(1, -1);
  if (quote === '`' && body.includes('${')) return null;
  let value = '';
  for (let i = 0; i < body.length; i += 1) {
    if (body[i] !== '\\') {
      value += body[i];
      continue;
    }
    const escaped = body[++i];
    if (escaped === undefined) return null;
    if (escaped === 'x' && /^[0-9a-f]{2}$/i.test(body.slice(i + 1, i + 3))) {
      value += String.fromCharCode(Number.parseInt(body.slice(i + 1, i + 3), 16));
      i += 2;
    } else if (escaped === 'u' && /^[0-9a-f]{4}$/i.test(body.slice(i + 1, i + 5))) {
      value += String.fromCharCode(Number.parseInt(body.slice(i + 1, i + 5), 16));
      i += 4;
    } else if (escaped === 'n') value += '\n';
    else if (escaped === 'r') value += '\r';
    else if (escaped === 't') value += '\t';
    else if (escaped === 'b') value += '\b';
    else if (escaped === 'f') value += '\f';
    else if (escaped === 'v') value += '\v';
    else if (escaped === '\n') continue;
    else value += escaped;
  }
  return value;
}

function normalizeJsPropertyKey(token) {
  const trimmed = token.trim();
  if (/^[A-Za-z_$][\w$]*$/.test(trimmed)) return trimmed;
  if (/^(?:'|"|`)/.test(trimmed) && trimmed.at(-1) === trimmed[0]) {
    return decodeJsStringKey(trimmed);
  }
  return null;
}

/** Return the only top-level comma when the line contains one entry. */
function singleTopLevelEntryComma(source) {
  const commas = [];
  let quote = null;
  let escaped = false;
  let paren = 0;
  let bracket = 0;
  let brace = 0;
  for (let i = 0; i < source.length; i += 1) {
    const character = source[i];
    const next = source[i + 1];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '\'' || character === '"' || character === '`') {
      quote = character;
      continue;
    }
    if (character === '/' && next === '/') break;
    if (character === '(') paren += 1;
    else if (character === ')' && paren > 0) paren -= 1;
    else if (character === '[') bracket += 1;
    else if (character === ']' && bracket > 0) bracket -= 1;
    else if (character === '{') brace += 1;
    else if (character === '}' && brace > 0) brace -= 1;
    else if (character === ',' && paren === 0 && bracket === 0 && brace === 0) commas.push(i);
  }
  if (commas.length !== 1) return -1;
  const tail = source.slice(commas[0] + 1).trim();
  return tail === '' || tail.startsWith('//') ? commas[0] : -1;
}

function additiveEntryIdentity(line) {
  const trimmed = line.trim();
  if (!trimmed || /^\/\//.test(trimmed) || /^\/\*/.test(trimmed)
      || /^\*/.test(trimmed) || /^\*\//.test(trimmed)) return '';
  const comma = singleTopLevelEntryComma(trimmed);
  if (comma < 0) return null;
  const entry = trimmed.slice(0, comma).trim();
  if (/^(?:'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`)$/.test(entry)) {
    return `value:${decodeJsStringKey(entry)}`;
  }
  const bare = /^([A-Za-z_$][\w$]*)$/.exec(entry);
  if (bare) return `value:${bare[1]}`;
  const property = /^((?:[A-Za-z_$][\w$]*|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`))\s*:\s*.+$/s.exec(entry);
  if (property) {
    const key = normalizeJsPropertyKey(property[1]);
    return key === null ? null : `key:${key}`;
  }
  return null;
}

function seedBaseEntryIdentities(base, identities) {
  for (const line of base) {
    const identity = additiveEntryIdentity(line);
    if (!identity) continue;
    if (identities.has(identity)) return false;
    identities.set(identity, { base: true, normalized: line.trim(), gap: -1 });
  }
  return true;
}

function resolveAdditiveEntryBlock(base, ours, theirs) {
  if (base === null) return null;
  const oursGaps = additionsAroundBase(base, ours);
  const theirsGaps = additionsAroundBase(base, theirs);
  if (!oursGaps || !theirsGaps) return null;

  const identities = new Map();
  if (!seedBaseEntryIdentities(base, identities)) return null;
  const merged = [];
  for (let gap = 0; gap < oursGaps.length; gap++) {
    const seenLines = new Set();
    for (const line of [...oursGaps[gap], ...theirsGaps[gap]]) {
      const normalized = line.trim();
      const identity = additiveEntryIdentity(line);
      if (identity === null) return null;
      if (identity) {
        const prior = identities.get(identity);
        if (prior?.base) return null;
        if (prior && (prior.normalized !== normalized || prior.gap !== gap)) return null;
        if (prior) continue;
        identities.set(identity, { normalized, gap });
      } else if (seenLines.has(normalized)) {
        continue;
      }
      seenLines.add(normalized);
      merged.push(line);
    }
    if (gap < base.length) merged.push(base[gap]);
  }
  return merged;
}

function resolveConflictsInText(text, { allowAdditiveEntries }) {
  const lines = text.split('\n');
  const out = [];
  const importedBindings = new Set();
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('<<<<<<<')) {
      out.push(lines[i]);
      continue;
    }
    const hunk = parseConflictHunk(lines, i);
    if (!hunk) return null;
    let resolved = resolveImportBlock(hunk.base, hunk.ours, hunk.theirs, importedBindings);
    if (resolved === null && allowAdditiveEntries) {
      resolved = resolveAdditiveEntryBlock(hunk.base, hunk.ours, hunk.theirs);
    }
    if (resolved === null) return null;
    out.push(...resolved);
    i = hunk.end;
  }
  return out.join('\n');
}

/** Risolve i conflitti import-only nel testo di UN file. Ritorna il testo
 * risolto, o null se un hunk NON è import-only (→ non sicuro da auto-risolvere).
 * Un lato "import-only" = ogni riga è `import ...`, commento, o vuota. */
export function resolveImportConflictsInText(text) {
  return resolveConflictsInText(text, { allowAdditiveEntries: false });
}

export function resolveSafeTextConflictsInText(text) {
  return resolveConflictsInText(text, { allowAdditiveEntries: true });
}

/** Applica il resolver stretto a tutti i file in conflitto. true se TUTTI
 * risolti in modo sicuro (import o entry additive) + `git add`-ati; false se uno non è
 * auto-risolvibile (il chiamante deve `git merge --abort`). */
function resolveSafeTextConflicts() {
  const raw = git(['diff', '--name-only', '--diff-filter=U'], { allowFail: true }) || '';
  const files = raw.split('\n').map((s) => s.trim()).filter(Boolean);
  if (!files.length) return false;
  for (const f of files) {
    let resolved;
    try { resolved = resolveSafeTextConflictsInText(readFileSync(f, 'utf8')); }
    catch { return false; }
    if (resolved === null) { console.log(`  conflitto non additivo sicuro in ${f} → non auto-risolvibile`); return false; }
    try { writeFileSync(f, resolved); } catch { return false; }
    git(['add', f], { allowFail: true });
  }
  console.log(`auto-resolve: ${files.length} file con conflitti additivi sicuri risolti per unione`);
  return true;
}

async function processPR(pr) {
  const num = pr.number;
  const branch = pr.headRefName;
  const head = pr.headRefOid;
  const labels = (pr.labels || []).map((l) => l.name);

  // `behind` serve allo stuck-red, al gate `needs-human` e al flusso normale:
  // memoizzato per non pagare tre volte la compare API.
  let _behind = null;
  const behindOf = () => (_behind ??= behindMain(head));

  // ── STUCK-RED: si valuta PRIMA di ogni gate, e per QUALUNQUE label ─────────
  //
  // Un vitest rosso EREDITATO da main non è un verdetto sulla PR, e il solo
  // rimedio è `merge origin/main` + ri-test (AGENTS.md → «main rosso blocca a
  // cascata: ogni branch lo eredita finché non fa merge origin/main»). Questa
  // valutazione stava DUE gate più in basso, dietro `!nearMerge`, e dopo il
  // `return` di `skip-idle` del ramo `needs-human`. Entrambi la rendevano
  // irraggiungibile proprio per le PR che ne avevano bisogno:
  //
  //  - dietro `!nearMerge`: `stale-pr-rescuer` etichetta `stale-review` una PR
  //    ferma >2h e le PROMETTE nel commento che «pr-autorebase ora la considera
  //    near-merge e la rebasa». Quella label la rendeva near-merge, e near-merge
  //    escludeva lo stuck-red. Il segnale di stallo disattivava il rimedio allo
  //    stallo, e i due meccanismi si contraddicevano nero su bianco.
  //  - dietro il `return` di `needs-human`: l'impronta che decide «lo stato è
  //    cambiato?» (additions/deletions/changedFiles/vitest/review) è fatta di
  //    soli fatti INTERNI alla PR. Quando il rosso viene dalla base, nessuno dei
  //    cinque si muove — e il vitest non può tornare verde da sé, perché il
  //    check è pinnato all'ultimo run sull'head. Stato assorbente: la PR non
  //    rientra MAI.
  //
  // Misurato il 2026-08-22 su #6253/#6254/#6255: tre PR con diff disgiunti,
  // tutte rosse sullo stesso test estraneo (`pre-flight-headline-check`, che
  // leggeva il registro VIVO degli articoli), tutte `needs-human`, ferme ~12h.
  // main era stato riparato alle 20:58 del giorno prima. Un `gh pr update-branch`
  // a mano le ha portate verdi tutte e tre e il ciclo le ha mergiate da solo in
  // ~2 minuti: il lavoro era già fatto, mancava solo chi rimettesse in coda.
  //
  // La frugalità che il gate `needs-human` protegge resta intatta: il rescue è
  // ONE-SHOT per PR via `STUCK_RED_MARKER`, quindi costa al massimo UNA vitest,
  // non una per tick. Se dopo il rebase è ancora rossa, il rosso è suo.
  let stuckRedReason = '';
  if (behindOf() > 0) {
    stuckRedReason = stuckRedRescueReason(head);
    if (stuckRedReason && hasCommentMarker(num, STUCK_RED_MARKER)) {
      console.log(`PR #${num} stuck-red (${stuckRedReason}) ma GIÀ ri-testata una volta (marker) — skip: il rosso è suo.`);
      stuckRedReason = '';
    }
  }

  // Conflict discovery is the fail-closed boundary for the whole PR tick.
  // Keep it before the needs-human ledger below: that ledger may write a
  // sticky comment, so checking only at the later near-merge gate would leave
  // a mutation path alive while fetch/merge-tree is unknown.
  const conflictScan = reportMainConflict(num, branch, head, labels);
  if (conflictScan === null) {
    console.log(`PR #${num}: conflitto non verificabile → rinvio ogni azione questo tick.`);
    return;
  }

  // GATE `needs-human`: una passata SOLO se lo stato è cambiato.
  //
  // Deve stare QUI — subito dopo il solo stuck-red, e prima di tutto il resto —
  // e non sul `dispatchTests` del ramo needs-human più sotto. Quel ramo viene DOPO `pushBranch`, e il push del
  // rebase — autenticato App/PAT — ri-triggera da sé i workflow `pull_request`
  // (#3038, vedi header): togliere il solo dispatch lascerebbe in piedi sia la
  // vitest sia `pr-review-loop`, cioè quota Claude, su una PR che aspetta una
  // persona. Il lavoro da non fare è la passata intera.
  //
  // Costo evitato: cron `*/30` = 48 tick/giorno × ~18 min di vitest ≈ 14,4 h di
  // CI al giorno per UNA PR ferma. La coda è serializzata: le pagano le altre.
  //
  // Le tre chiamate API dell'impronta costano ~1s e sostituiscono ~18 min di CI.
  if (labels.includes('needs-human')) {
    const vc = normalizedVitestConclusion(head);
    const fp = reopenStateFingerprint(num, vc);
    const body = readReopenBudgetBody(num);
    const prior = parseReopenBudget(body);
    const d = decideNeedsHumanPass({ fingerprint: fp, prior });
    // Lo stuck-red BATTE `skip-idle`, e deve: l'impronta è cieca alla base
    // (vedi il blocco sopra), quindi qui «stato invariato» significa solo
    // «nulla è cambiato DENTRO la PR» — che è vero e irrilevante quando il
    // rosso viene da fuori. Senza questa riga il rescue resta irraggiungibile
    // per ogni PR `needs-human`, cioè per tutte quelle che il breaker ha già
    // escalato. Resta one-shot: al giro dopo il marker lo spegne.
    if (d.action === 'skip-idle' && !stuckRedReason) {
      console.log(`PR #${num}: ${d.reason}`);
      return;
    }
    // Stato cambiato → si prosegue con UNA passata piena (rebase + dispatch dal
    // ramo needs-human più sotto). L'impronta si registra ORA: se la passata
    // muore a metà non si ripete comunque a raffica, e l'umano che arriva vede
    // perché. `count: 0` è coerente — il breaker riparte da zero su uno stato
    // nuovo, esattamente come nel reset normale.
    const next = renderReopenBudget({
      count: 0, max: MAX_REOPENS, fingerprint: fp, action: 'needs-human-pass', reason: d.reason,
      // Il one-shot del review gate NON si azzera qui: è appaiato alla PR, non
      // all'impronta (vedi parseReopenBudget). Riscriverlo a false lo
      // renderebbe rinnovabile a ogni cambio di stato, cioè non più one-shot.
      reviewGateUsed: Boolean(prior && prior.reviewGateUsed),
    });
    if (body !== next) {
      upsertStickyComment(gh, REPO, num, REOPEN_BUDGET_MARKER, next, { dry: DRY });
    }
    console.log(`PR #${num}: ${d.reason}`);
  }

  // GATE frugalità: solo near-merge. Tutte le decisioni sul verdetto usano la
  // stessa revisione del body; un LGTM del body precedente non rende la PR
  // near-merge e non può scegliere il ramo di solo dispatch.
  const reviewContext = currentReviewInputContext(num);
  if (!reviewContext || reviewContext.headSha !== String(head || '').toLowerCase()) {
    console.log(`PR #${num}: HEAD o body della PR non verificabili prima della selezione review — skip questo tick.`);
    return;
  }
  const reviewRevision = reviewContext.reviewRevision;
  const lgtm = hasLgtmReview(num, reviewRevision);
  let nearMerge =
    labels.includes('collision-risk') ||
    labels.includes('stale-review') ||
    lgtm;

  // ── QUARTA classe near-merge: STUCK-RED (2026-08-05) ───────────────────────
  // Le prime tre classi presuppongono che una PR bloccata abbia GIÀ un segnale:
  // un `## LGTM`, o una label messa da qualcun altro. Una PR il cui vitest è
  // rosso non ne ha NESSUNO, e non può acquisirne, perché ogni produttore di
  // segnale è a valle del vitest verde:
  //   la review Claude gira DENTRO il job vitest, ma dopo i test: se questi
  //     falliscono il job si ferma prima ⇒ niente review, niente LGTM, niente
  //     label (prima del 2026-08-26 era nel vecchio `pr-review-loop`, gattato su
  //     `workflow_run[tests] == success`: stessa implicazione, altro wiring);
  //   stale-pr-rescuer.yml classe A esige `tests == success`, classe B esige una
  //     review con 🔴 → cade nell'`else` ⇒ non mette nemmeno `stale-review`;
  //   e qui il gate sopra la skippa.
  // Il grafo non ha archi uscenti: la PR resta rossa PER SEMPRE, anche dopo che
  // main è tornato verde. Misurato su 8 PR (#5019 #5067 #5068 #5070 #5072 #5073
  // #5074 #5085), ferme 1-4 giorni con `vitest (unit + integration)` come UNICO
  // check rosso (`detect` e `contract` verdi su tutte, mergeable=MERGEABLE: non
  // erano conflitti né il body-contract).
  // Il verdetto è calcolato IN CIMA alla funzione (vedi il blocco STUCK-RED):
  // deve precedere sia questo gate sia il `return` di `needs-human`, che
  // altrimenti lo rendono irraggiungibile. Qui resta solo l'effetto: un rescue
  // valido rende la PR near-merge anche senza LGTM né label.
  if (stuckRedReason) nearMerge = true;

  if (!nearMerge) {
    console.log(`PR #${num} non near-merge (no LGTM/collision-risk/stale-review/stuck-red) — skip del rebase.`);
    return;
  }

  const behind = behindOf();

  if (stuckRedReason) {
    console.log(`PR #${num} STUCK-RED (${stuckRedReason}): vitest rosso non attribuibile alla PR, ${behind} dietro main → rescue one-shot (rebase + re-test).`);
    if (!DRY) {
      const why = stuckRedReason === 'red-main'
        ? 'il suo `vitest` è stato eseguito sul merge ref mentre `main` era ROSSO, ed è tornato verde dopo'
        : 'il suo `vitest` è rosso da oltre ' + STUCK_RED_STALE_H + 'h senza che nulla possa ri-eseguirlo (probabile fallimento infrastrutturale)';
      gh(['pr', 'comment', String(num), '--repo', REPO, '--body',
        `${STUCK_RED_MARKER}\n♻️ **autorebase / stuck-red**: questa PR è ferma perché ${why}.\n\nCon i test rossi il job si ferma prima della review Claude (che dal 2026-08-26 gira dentro lo stesso \`tests.yml\`), quindi la PR non può ottenere né \`## LGTM\` né una label — e senza quelli nessun workflow la ri-testa: stato assorbente. Rebase su \`origin/main\` + ri-esecuzione dei test, **una sola volta**. Se torna rossa, il fallimento è della PR.\n\n_Segnale deterministico da pr-autorebase.yml (zero-Claude)._`],
        { json: false, allowFail: true });
    }
  }

  if (behind === 0) {
    // Già allineata a main, ma l'head può essere "orfano" (0 check-run vitest):
    // rebasato da un push PAT che non ha ri-triggerato `pull_request`, o da un
    // autorebase pre-#1597 che pushava senza dispatchare. In quel caso
    // auto-merge-eval resta in attesa per sempre (gate vitest==success mai
    // soddisfatto) → PR near-merge bloccata (osservato #1595/#1526). HEAL: se
    // manca del tutto il check vitest, dispatchiamo tests.yml. Idempotente:
    // appena un run è queued, headHasVitestCheck torna true → niente
    // ri-dispatch. Nessun rebase, nessuna review Claude.
    if (!headHasVitestCheck(head)) {
      if (!lgtm && !hasAnyManagedReview(num, reviewRevision)) {
        // Classe-A: nemmeno la review esiste (drift 401) — il solo vitest non
        // sblocca (auto-merge esige LGTM). Reopen = review+tests insieme.
        console.log(`PR #${num} 0 dietro main, NESSUNA review claude e niente vitest → close+reopen (re-trigger review+tests).`);
        if (reviewInputContextStillCurrent(num, head, reviewRevision)
          && guardedReopen(num, head)) clearStaleReviewLabel(num);
      } else {
        console.log(`PR #${num} 0 dietro main ma head ${head.slice(0, 8)} SENZA check-run vitest → dispatch tests.yml (heal, no rebase).`);
        if (reviewInputContextStillCurrent(num, head, reviewRevision)
          && dispatchTests(num, branch)) clearStaleReviewLabel(num);
      }
    } else if (vitestVerdictIsTransient(head)) {
      // Il check vitest ESISTE ma il suo verdetto rosso è una CANCELLAZIONE da
      // concurrency, non un test rotto, e nessun run fresco è già pendente:
      // `cancelled` sul check stesso (job singolo, post-de-shard #2882) o
      // `failure` collassato da shard cancellati (vecchia matrice, #2438).
      // L'head resterebbe ferma (l'heal sopra scatta solo su check ASSENTE;
      // auto-merge esige `success`) finché un evento esterno non ri-dispatcha.
      // Ri-dispatch tests.yml (heal), NESSUN rebase. Un `failure` REALE non passa
      // di qui → niente re-run gratis (AGENTS #5 + frugalità CI).
      console.log(`PR #${num} 0 dietro main, vitest rosso da CANCELLAZIONE (transient, nessun verdetto sul codice) → dispatch tests.yml (heal, no rebase).`);
      if (reviewInputContextStillCurrent(num, head, reviewRevision)
        && dispatchTests(num, branch)) clearStaleReviewLabel(num);
    } else {
      console.log(`PR #${num} 0 dietro main, vitest già presente sull'head — skip.`);
    }
    return;
  }
  // CONFLITTO con main: va gestito PRIMA dello skip wave-11. Senza questo, una
  // PR lgtm+verde+CONFLICTING veniva skippata (lo skip presume "auto-merge la
  // mergia così com'è" — ma auto-merge NON mergia un conflitto) → restava stuck
  // senza stale-review, quindi nemmeno recycle la prendeva (gap #2057, ferma
  // 2.5h, label vuote). Qui: TENTA l'auto-resolve delle classi additive sicure
  // (import distinti oppure entry monoriga su un base diff3 intatto); se non
  // auto-risolvibile → stale-review (recycle).
  // Solo behind>0 può confliggere (behind===0 già gestito sopra).
  {
    const mc = await mergeableState(num);
    if (mc === 'CONFLICTING') {
      if (DRY) { console.log(`[dry] #${num} CONFLICTING → tenta auto-resolve additivo sicuro, else stale-review`); return; }
      let done = false;
      git(['fetch', 'origin', branch, 'main'], { allowFail: true });
      const co = git(['checkout', '-B', branch, `origin/${branch}`], { allowFail: true });
      if (co !== null) {
        git(['config', 'user.name', 'Valerie Linc']);
        git(['config', 'user.email', 'valerielinc@gmail.com']);
        const mg = git(['-c', 'merge.conflictstyle=diff3', 'merge', '--no-edit', 'origin/main'], { allowFail: true });
        if (mg === null && resolveSafeTextConflicts() && git(['commit', '--no-edit'], { allowFail: true }) !== null) {
          if (!reviewInputContextStillCurrent(num, head, reviewRevision)) return;
          const pushed = pushBranch(branch);
          if (pushed !== null) {
            const pushedContext = currentReviewInputContext(num);
            // Push OK: la PR è ora mergeable. Dispatch tests (gate vitest di
            // auto-merge-eval valida la risoluzione: se l'unione fosse errata i
            // test falliscono e non si mergia). LGTM carry-forward.
            console.log(`✅ PR #${num}: conflitto additivo sicuro AUTO-RISOLTO + pushato → mergeable; dispatch tests.`);
            if (pushedContext?.reviewRevision === reviewRevision
              && reviewInputContextStillCurrent(num, pushedContext.headSha, reviewRevision)
              && dispatchTests(num, branch)) clearStaleReviewLabel(num);
            done = true;
          }
        }
        if (!done) git(['merge', '--abort'], { allowFail: true });
      }
      if (!done) {
        console.log(`PR #${num} CONFLICTING non auto-risolvibile in sicurezza → stale-review + comment (recycle).`);
        ensureStaleLabel(num);
        commentConflictOnce(num, branch);
        handOffConflictToFixer(num, branch, head, lgtm);
      }
      return;
    }
  }

  // SKIP rebase delle PR già pronte al merge (2026-06-15): main NON richiede
  // branch up-to-date (branch protection `strict=false`, required_checks=[]),
  // quindi una PR LGTM'd + vitest verde sull'head viene squash-mergiata da
  // auto-merge ANCHE se dietro main — il rebase è inutile e DANNOSO: il merge
  // di origin/main crea un nuovo head, il synchronize del push-PAT va
  // `action_required`/non ricrea il check-run, il vitest verde sparisce e
  // auto-merge-eval (gate vitest==success) si blocca per sempre (circolo vizioso
  // osservato 00:30Z: #2026/#2028/#855 LGTM'd rebasati → action_required → stuck;
  // più la PR aspetta, più l'autorebase la rompe). Tocchiamo solo le PR che il
  // rebase serve DAVVERO: collision-risk SOLO quando collisionGateBlocks rileva
  // un peer collidente già mergiato non ancora incluso in head (#6039: prima
  // la label da sola forzava sempre 'rebase', mentre auto-merge-eval dal #2424
  // blocca il merge solo su quell'hazard preciso — il disallineamento faceva
  // ri-rebasare a ogni movimento di main una PR che il gate di merge avrebbe
  // già lasciato passare, e il push del rebase cancellava la review in corso)
  // e stale-review (drift/conflitto). Una LGTM'd+verde senza collisione REALE →
  // lasciala ad auto-merge.
  // NB: vitest deve essere non-`failure`. Su failure va rebasata per ereditare
  // eventuali fix lato main (una PR behind+LGTM con vitest=failure NON è
  // mergeable-as-is: auto-merge-eval esige conclusion==success).
  // NON gattare lo skip su headHasVitestCheck(head): era la race che innescava
  // il LIVELOCK. Appena un rebase orfanizza l'head, headHasVitestCheck torna
  // false → lo skip NON scattava → si ri-rebasava → nuova head orfana → loop
  // (osservato 2026-06-17 su main caldo: #2415 rebasata 3× in 15min, vitest
  // sempre queued/cancelled, mai verde, mai mergiata). Per una LGTM'd
  // non-collision NON si rebasa MAI (main è non-strict → auto-merge la mergia
  // behind così com'è); se l'head è orfana (nessun check vitest) lo SKIP da solo
  // la lascerebbe stuck (gate 3 mai success) → la SANIAMO dispatchando tests
  // (orphan-heal esteso a behind>0, prima solo behind===0), senza rebasare: il
  // check vitest atterra su una head STABILE e auto-merge la mergia behind.
  const collisionRisk = labels.includes('collision-risk');
  const action = rebaseActionForLgtmPr({
    lgtm,
    collisionBlocked: collisionRisk && collisionGateBlocks(num, head, behind),
    vitestConclusion: vitestConclusion(head),
    hasVitestCheck: headHasVitestCheck(head),
  });
  if (action === 'heal') {
    console.log(`PR #${num} LGTM non-collision, ${behind} dietro main, head ${head.slice(0, 8)} SENZA check-run vitest → dispatch tests (heal, NO rebase: main non-strict, auto-merge la mergia behind).`);
    if (reviewInputContextStillCurrent(num, head, reviewRevision)
      && dispatchTests(num, branch)) clearStaleReviewLabel(num);
    return;
  }
  if (action === 'skip') {
    console.log(`PR #${num} LGTM + vitest non-failure sull'head, no collision, ${behind} dietro main → SKIP rebase (main non-strict: auto-merge la mergia così com'è; rebasarla orfanizzerebbe l'head).`);
    return;
  }
  console.log(`PR #${num} (${branch}) è ${behind} dietro main, near-merge → valuto rebase.`);

  // Review-in-flight guard: NON rebasare mentre una review Claude è in volo
  // sull'head. Il push del rebase (App/PAT) ri-triggera pr-review-loop, che con
  // cancel-in-progress CANCELLA la review in corso e la riavvia → con main caldo
  // la review non conclude mai (livelock; quota bruciata). Defer di un tick: la
  // review conclude, posta il verdetto, auto-merge-eval porta avanti l'LGTM. Il
  // rebase non è urgente (main è sempre fresco). NB: l'orphan-heal sopra dispatcha
  // solo tests (no push), quindi non è soggetto a questa race.
  if (reviewInProgress(head)) {
    console.log(`PR #${num}: review Claude in volo sull'head ${head.slice(0, 8)} — skip rebase questo tick (un push ora la cancellerebbe; defer finché conclude).`);
    return;
  }

  // Tests-in-flight guard (#6037, 2026-08-18): NON rebasare mentre un run di
  // `tests.yml` è ancora in volo sulla head ATTUALE. Ribasare adesso
  // cancellerebbe proprio il run che sta per produrre il segnale (`tests:
  // success`) di cui la PR ha bisogno per avanzare — `pr-review-loop` parte solo
  // su `workflow_run` di `tests` con `conclusion == success`, quindi cancellarlo
  // significa cancellare la review, e senza review la PR resta `stale-review`,
  // che è la label che rimette in moto l'autorebase: il ciclo si autoalimenta
  // (misurato: 5 `tests` cancellati di fila su `fix/unsub-window-and-channel`,
  // zero `success`). La PR non scappa: la ripresa avviene al trigger successivo
  // (cron, prossimo merge su main, o l'arrivo della review) — a quel punto o il
  // run è concluso, o la sua head non è più quella attuale e la guardia non
  // scatta più.
  //
  // Perché il caso CONFLICTING non è in stallo: una PR `CONFLICTING` non arriva
  // MAI qui — è intercettata e chiusa (auto-resolve additivo sicuro, altrimenti
  // `stale-review` + comment) diverse decine di righe più su, prima di questo
  // punto, e quel ramo fa `return`. È corretto che sia esente: lì il rebase è
  // RIMEDIALE (auto-merge non mergia un conflitto, quindi nessun `tests: success`
  // farebbe avanzare la PR — il run in volo è già inutile), mentre qui il rebase
  // è solo di ALLINEAMENTO (main è non-strict: auto-merge mergia anche behind),
  // e il run in volo è esattamente ciò che serve. Fail-open: se l'API dei run
  // fallisce, `testsRunsForBranch` torna `[]` e non si salta niente.
  const inFlight = testsRunInFlightOnHead({ runs: testsRunsForBranch(branch), head });
  if (inFlight) {
    console.log(`PR #${num} (${branch}): run tests.yml ${inFlight.id ?? '?'} ${inFlight.status} sulla head ATTUALE ${head.slice(0, 8)} — skip rebase questo tick (il push lo cancellerebbe, ed è il run che deve produrre il 'tests: success' da cui dipende la review; riprendo al prossimo trigger).`);
    return;
  }

  // Activity-guard: se l'head è stato pushato pochi minuti fa, un contributor/
  // agent è probabilmente mid-flight (sta ancora pushando fix su una PR LGTM'd).
  // Rebasare ora racerebbe il suo push → skip, riprova al prossimo tick (il
  // rebase non è urgente: main è sempre fresco). Non tocca l'orphan-heal sopra
  // (quello dispatcha solo tests, nessuna race di push).
  if (ACTIVITY_GUARD_MIN > 0) {
    const mins = headPushedMinutesAgo(head);
    if (mins < ACTIVITY_GUARD_MIN) {
      console.log(`PR #${num}: head pushato ${mins.toFixed(1)}min fa (< ${ACTIVITY_GUARD_MIN}min) — contributor mid-flight, skip rebase questo tick.`);
      return;
    }
  }

  const m = await mergeableState(num);
  if (m === 'UNKNOWN' || m === '') {
    console.log(`PR #${num} mergeable=UNKNOWN dopo poll — skip questo run (riprova al prossimo tick).`);
    return;
  }

  if (m === 'CONFLICTING') {
    console.log(`PR #${num} mergeable=CONFLICTING → label stale-review + comment once.`);
    ensureStaleLabel(num);
    commentConflictOnce(num, branch);
    handOffConflictToFixer(num, branch, head, lgtm);
    return;
  }

  if (m !== 'MERGEABLE') {
    console.log(`PR #${num} mergeable=${m} (non MERGEABLE/CONFLICTING) — skip.`);
    return;
  }

  // MERGEABLE → tenta il merge di origin/main nel branch.
  if (DRY) { console.log(`[dry] rebase #${num}: fetch + merge origin/main + push ${branch}`); return; }

  git(['fetch', 'origin', branch, 'main'], { allowFail: true });
  // checkout del branch sull'head remoto (worktree CI pulito).
  const co = git(['checkout', '-B', branch, `origin/${branch}`], { allowFail: true });
  if (co === null) { console.log(`PR #${num}: checkout di ${branch} fallito — skip.`); return; }
  git(['config', 'user.name', 'Valerie Linc']);
  git(['config', 'user.email', 'valerielinc@gmail.com']);

  const merged = git(['-c', 'merge.conflictstyle=diff3', 'merge', '--no-edit', 'origin/main'], { allowFail: true });
  if (merged === null) {
    // Conflitto a runtime (mergeable era ottimista o è cambiato tra check e
    // merge). Tenta l'auto-resolve additivo sicuro come nel path CONFLICTING;
    // se ambiguo → abort + stale-review.
    if (resolveSafeTextConflicts() && git(['commit', '--no-edit'], { allowFail: true }) !== null) {
      console.log(`PR #${num}: conflitto runtime AUTO-RISOLTO (additivo sicuro) → proseguo col push.`);
    } else {
      console.log(`PR #${num}: merge origin/main ha conflitto non auto-risolvibile → abort + stale-review + comment.`);
      git(['merge', '--abort'], { allowFail: true });
      ensureStaleLabel(num);
      commentConflictOnce(num, branch);
      handOffConflictToFixer(num, branch, head, lgtm);
      return;
    }
  }

  // Push via PAT. TOCTOU: tra mergeable-check e push un nuovo commit potrebbe
  // essere arrivato → push non-fast-forward fallisce (no --force): skip, il
  // prossimo tick ricalcola.
  if (!reviewInputContextStillCurrent(num, head, reviewRevision)) return;
  const pushed = pushBranch(branch);
  if (pushed === null) {
    console.log(`PR #${num}: push fallito (probabile non-fast-forward / TOCTOU) — skip, riprova al prossimo tick.`);
    return;
  }
  const pushedContext = currentReviewInputContext(num);
  if (!pushedContext || pushedContext.reviewRevision !== reviewRevision) {
    console.log(`PR #${num}: body PR cambiato o HEAD post-push illeggibile — skip azione successiva questo tick.`);
    return;
  }

  // Ri-esegui SOLO i test sull'head rebasato — NON la review Claude (frugalità
  // quota). Un push PAT su un branch PR NON ri-triggera in modo affidabile i
  // workflow `pull_request` (osservato: head rebasati di #1587/#1526 con ZERO
  // check-run), quindi dispatchiamo esplicitamente `tests.yml` sul branch: il
  // check-run `vitest (unit + integration)` atterra sull'head (= gate 3 di
  // auto-merge-eval) e il suo `workflow_run: completed` ri-valuta
  // auto-merge-on-lgtm. L'LGTM esistente viene portato avanti da
  // auto-merge-eval (contributo PR invariato su un rebase di solo main-merge),
  // quindi NESSUNA review Opus/Sonnet gira di nuovo. Best-effort: se il
  // dispatch fallisce (PAT senza scope actions:write) lo logghiamo soltanto.
  // !lgtm dopo un rebase = la PR NON è pronta al merge (manca l'LGTM): o non ha
  // mai avuto review (classe-A, drift 401), o ne ha una con 🔴/❓ non chiuso. In
  // ENTRAMBI i casi il rebase ha appena allineato i workflow a main (drift
  // workflow-validation risolto), ma serve ri-triggerare review+redflag: un
  // semplice dispatch tests NON rilancia pr-review-loop/redflag-fixer (triggerano
  // su review submitted), quindi il 🔴+drift resterebbe stuck fino al recycle
  // 24h. close+reopen emette `reopened` → review gira drift-free → (se 🔴)
  // redflag-fixer riparte. ECCEZIONE needs-human: già escalata (round-cap),
  // reopen riavvierebbe review inutilmente → skip (il round-cap marker persiste,
  // niente loop, ma evitiamo la review-quota su una PR che aspetta un umano).
  if (!lgtm) {
    if (labels.includes('needs-human')) {
      console.log(`PR #${num}: rebasata ma needs-human (round-cap) → no reopen (attende umano); solo dispatch tests.`);
      if (reviewInputContextStillCurrent(num, pushedContext.headSha, reviewRevision)
        && dispatchTests(num, branch)) clearStaleReviewLabel(num);
      return;
    }
    const why = hasAnyManagedReview(num, reviewRevision) ? '🔴/❓ non chiuso + drift sanato' : 'classe-A senza review';
    // Il reopen passa dal breaker: è QUESTO call-site che ha prodotto le 12+10
    // riaperture di #5896/#5906. `!lgtm` con i TEST rossi è una condizione che
    // il reopen non può cambiare (il job si ferma prima della review), quindi
    // senza guardia si ripete a ogni tick per sempre. Diverso il rosso da
    // REVIEW GATE, che il breaker riconosce e ricicla una volta (#7429).
    // ECCEZIONE: se la PR è qui come rescue STUCK-RED, il `failure` sull'head
    // è appena stato PROVATO non attribuibile (red-main/stale) e il reopen è
    // esattamente la ri-esecuzione promessa — `stuckRedReason` disattiva la
    // sola precondizione (il budget del breaker conta comunque).
    if (reviewInputContextStillCurrent(num, pushedContext.headSha, reviewRevision)
      && guardedReopen(num, pushedContext.headSha, { stuckRedReason })) {
      clearStaleReviewLabel(num);
      console.log(`✅ PR #${num}: rebasata, pushata e ri-aperta (${why}) → review+redflag ri-triggerati drift-free.`);
    }
    return;
  }
  if (reviewInputContextStillCurrent(num, pushedContext.headSha, reviewRevision)
    && dispatchTests(num, branch)) {
    clearStaleReviewLabel(num);
    console.log(`✅ PR #${num}: rebasata su origin/main, pushata (${branch}) e dispatchato tests.yml → vitest sull'head; LGTM carry-forward, zero Claude.`);
  }
}

async function main() {
  if (!REPO) { console.error('GITHUB_REPOSITORY mancante'); process.exit(1); }
  if (!TOKEN) { console.error('::warning::GH_TOKEN (PAT) assente → autorebase inerte (serve per push + dispatch tests.yml).'); process.exit(0); }
  console.log(`pr-autorebase${DRY ? ' [DRY-RUN]' : ''} repo=${REPO}`);

  let prs;
  try {
    prs = discoverOpenPullRequests();
  } catch (e) {
    console.error(`discovery PR fallita: ${String(e).slice(0, 160)}`);
    process.exitCode = 1;
    return;
  }
  // Rotazione anti-starvation (#5145/#5144 punto 3): il cap `MAX_PER_RUN` e il
  // budget di run tagliano entrambi la CODA della lista. Partendo sempre dalla
  // stessa testa, una PR lenta in posizione 1 non consuma solo il proprio turno:
  // rende irraggiungibili tutte quelle dietro, a ogni run. Ruotando su
  // GITHUB_RUN_NUMBER ogni PR passa dalla testa nell'arco di pochi tick.
  const open = preparePullRequestSweep(prs, process.env.GITHUB_RUN_NUMBER);
  console.log(`PR open non-draft: ${open.length}${open.length > 1 ? ` (ordine ruotato su run #${process.env.GITHUB_RUN_NUMBER || '?'} — anti-starvation)` : ''}`);
  if (budget.enabled) {
    console.log(`budget di run: ${Math.round(budget.remainingMs() / 1000)}s utilizzabili prima della deadline del job.`);
  }

  let processed = 0;
  let cappedSkipped = 0;
  for (const pr of open) {
    if (processed >= MAX_PER_RUN) {
      cappedSkipped++;
      continue;
    }
    // BUDGET GUARD: fermarsi PRIMA di cominciare una PR che non si farebbe in
    // tempo a finire. Le PR non valutate restano esattamente com'erano — non
    // c'è nessuno stato da ripulire — e il prossimo tick le rivaluta da zero
    // (il loop è già interamente idempotente: ogni decisione è ricalcolata da
    // GitHub, niente è memorizzato fra un run e l'altro).
    if (!budget.take(`#${pr.number}`, PR_COST_MS)) {
      continue;
    }
    processed++;
    try {
      await processPR(pr);
    } catch (e) {
      console.log(`::warning::PR #${pr.number} errore in processPR: ${String(e).slice(0, 160)}`);
    }
  }
  if (cappedSkipped > 0) {
    console.log(`::warning::cap raggiunto (${MAX_PER_RUN}/run): ${cappedSkipped} PR non valutate questo run (verranno valutate al prossimo tick).`);
  }
  budget.report();
  console.log(`autorebase scan completo (${processed} PR valutate).`);
}

// Esegui solo come CLI (non quando importato dai test → resolver dei conflitti
// testabile in isolamento, come classify-issue.mjs / alert-pat-down.mjs).
if (process.argv[1] && process.argv[1].endsWith('pr-autorebase.mjs')) {
  main();
}
