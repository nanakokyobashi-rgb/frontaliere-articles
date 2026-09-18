/**
 * review-gate.mjs — il verdetto della Claude review, come STEP del check-run
 * richiesto (zero-Claude).
 *
 * ## Perche' esiste
 *
 * Fino al 2026-09-03 il merge lo decideva un workflow dedicato, che leggeva
 * la review e chiamava `gh pr merge` da se'. Con l'auto-merge NATIVO di GitHub
 * quella decisione non e' piu' nostra: e' il ruleset su `main` a dire quali
 * check devono essere verdi, e GitHub mergia quando lo sono. Un contratto che
 * vive in un workflow separato diventa quindi invisibile al ruleset — la PR
 * mergerebbe con la review rossa, o senza review affatto.
 *
 * Questo script riporta quel contratto DENTRO il check-run richiesto: gira come
 * ultimo step del job `tests`, ed esce != 0 quando non esiste una review Claude
 * approvante sulla head. Il ruleset richiede quel check, quindi l'auto-merge
 * nativo non puo' scavalcare il giudizio del reviewer.
 *
 * ## Cosa conta come «approvante»
 *
 * L'ULTIMA review di un bot reviewer (`claude`/`claude[bot]` o
 * `frontaliere-automation[bot]`), che contenga
 * `## LGTM` e NESSUN finding `🔴 Important`, oppure solo finding su file fuori
 * dal diff corrente già raccolti in una issue follow-up (stessa
 * `REDFLAG_IMPORTANT_RE` che usa il redflag-fixer — una sola regex, nessun
 * drift). Deve portare la revisione del body corrente. Su un commit precedente
 * vale il CARRY-FORWARD se il fingerprint del contributo (3-dot vs merge-base,
 * code-only) e' identico fra i due commit, la PR non ha cambiato il proprio
 * codice — tipicamente un rebase di solo main-merge — e la review resta valida.
 * Un edit del body cambia l'input fidato della review anche sulla stessa HEAD:
 * il guard deve quindi riarmare una review nuova e questo gate non può riusare
 * il verdetto legato al body precedente.
 * E' la stessa funzione che usava `auto-merge-eval.mjs`, importata e non
 * riscritta.
 *
 * ## Il drift-fallback
 *
 * `claude-code-action` pretende che il workflow in esecuzione sia byte-identico
 * alla versione su `main`, altrimenti risponde `401 Workflow validation failed`
 * e esce 0 SENZA postare (execution_file vuoto). Da quando la review vive
 * dentro `tests.yml`, una PR che MODIFICA `tests.yml` non puo' quindi avere
 * una review nuova. Il fallback deterministico (autore fidato + completeness
 * contract del body) e' quello gia' scritto e testato in `auto-merge-eval.mjs`.
 *
 * Si apre in due casi, entrambi «il reviewer non ha potuto parlare DELLA HEAD»:
 * nessuna review del bot, oppure l'ultima review NON si applica piu' (SHA
 * diverso E fingerprint del contributo cambiato). Un 🔴 sulla HEAD, o su un
 * commit precedente col contributo invariato, resta bloccante: quello e' un
 * verdetto ancora vivo, non un 401.
 *
 * Uso:  node scripts/ci/review-gate.mjs
 * Env:  GH_TOKEN, GITHUB_REPOSITORY, PR_NUMBER, HEAD_SHA, REVIEW_REVISION,
 *       RUN_URL (opzionale)
 * Exit: 0 approvato · 1 non approvato (il check-run diventa rosso)
 */
import {
  findTestOnlyApproval,
  normalizeReviewInputRevision,
  reviewInputContextFromPullRequest,
  reviewInputContextMatches,
  reviewHasInputRevision,
} from './review-test-policy.mjs';
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { parseCodexFallbackEvidence, FALLBACK_STATUS } from './claude-codex-fallback.mjs';
import { createHash } from 'node:crypto';
import {
  prContributionFingerprint,
  isReviewWorkflowDriftPR,
  isTrustedDriftAuthor,
  prBodyContractOk,
} from './auto-merge-eval.mjs';
import {
  isCodexFallbackReview,
  isManagedReview,
  REDFLAG_IMPORTANT_RE,
  VITEST_CHECK_NAME,
} from './lib/constants.mjs';
import { classifyAndMintReview } from './review-scope.mjs';

const REPO = process.env.GITHUB_REPOSITORY || '';
const PR = process.env.PR_NUMBER || '';
const HEAD_SHA = process.env.HEAD_SHA || '';
const RUN_URL = process.env.RUN_URL || '';
const REVIEW_REVISION = normalizeReviewInputRevision(process.env.REVIEW_REVISION || '');
const MARKER = '<!-- REVIEW_GATE_NO_LGTM -->';
let gateFailureKind = 'verdict';

/**
 * Il check richiesto deve restare rosso anche quando l'API è degradata, ma il
 * consumer dell'autorebase deve distinguere quel rosso da un verdetto negativo.
 * Gli step della Jobs API espongono la conclusion, non le output del processo:
 * il workflow aggiunge quindi un classificatore che legge questo output.
 */
function markTransientFailure() {
  gateFailureKind = 'transient';
}

function writeFailureKind() {
  const output = process.env.GITHUB_OUTPUT;
  if (!output) return;
  try {
    appendFileSync(output, `failure_kind=${gateFailureKind}\n`);
  } catch (error) {
    console.log(`review-gate: impossibile scrivere failure_kind (${String(error).slice(0, 120)}).`);
  }
}

/** Persist a successful deterministic fallback for the claim finalizer. */
function writeGateOutput(name, value) {
  const output = process.env.GITHUB_OUTPUT;
  if (!output) return false;
  try {
    appendFileSync(output, `${name}=${value}\n`);
    return true;
  } catch (error) {
    console.log(`review-gate: impossibile scrivere ${name} (${String(error).slice(0, 120)}).`);
    return false;
  }
}

function gh(args, { json = true } = {}) {
  const out = execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return json ? JSON.parse(out) : out;
}

function fingerprint(sha) {
  const fp = prContributionFingerprint(sha);
  return fp == null ? null : createHash('sha256').update(fp).digest('hex');
}

/** Read the trusted PR HEAD and body revision as one review-input snapshot. */
function currentReviewInputContext() {
  let payload;
  try {
    payload = gh(['api', `repos/${REPO}/pulls/${PR}`]);
  } catch (error) {
    markTransientFailure();
    throw new Error(`contesto PR illeggibile: ${String(error).slice(0, 160)}`);
  }
  const context = reviewInputContextFromPullRequest(payload);
  if (!context) {
    markTransientFailure();
    throw new Error('contesto PR malformato: HEAD o body non verificabili');
  }
  return context;
}

/**
 * The review-input snapshot is a TOCTOU fence, not only an input selector.
 * Re-read HEAD and body immediately before any approving exit so a push or
 * body edit during review cannot make an older verdict satisfy the check.
 */
function reviewInputContextStillCurrent() {
  let current;
  try {
    current = currentReviewInputContext();
  } catch (error) {
    markTransientFailure();
    console.error(`::error::review-gate: impossibile rileggere HEAD + hash body PR prima dell'approvazione (${String(error).slice(0, 160)}).`);
    return false;
  }
  if (reviewInputContextMatches(current, {
    headSha: HEAD_SHA,
    reviewRevision: REVIEW_REVISION,
  })) return true;
  markTransientFailure();
  console.error(
    `::error::review-gate: HEAD o body PR sono cambiati durante la valutazione (attesa head=${HEAD_SHA} revision=${REVIEW_REVISION}, corrente head=${current?.headSha || '<unreadable>'} revision=${current?.reviewRevision || '<unreadable>'}); nessun verdetto può essere riusato.`,
  );
  return false;
}

function isTerminalReview(review) {
  return ['COMMENTED', 'APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(
    String(review?.state || '').toUpperCase(),
  );
}

function reviewStateAllowsApproval(review) {
  return ['COMMENTED', 'APPROVED'].includes(String(review?.state || '').toUpperCase());
}

/** Order terminal review verdicts independently of the REST page order. */
function reviewOrderTimestamp(review) {
  const timestamps = [review?.submitted_at, review?.submittedAt, review?.created_at, review?.createdAt]
    .map((value) => Date.parse(value || ''))
    .filter(Number.isFinite);
  return timestamps.length > 0 ? Math.max(...timestamps) : Number.NEGATIVE_INFINITY;
}

function compareReviewOrder(left, right) {
  return reviewOrderTimestamp(left) - reviewOrderTimestamp(right)
    || (Number(left?.id || 0) || 0) - (Number(right?.id || 0) || 0);
}

/**
 * A drift fallback cannot erase a non-approving review merely because the old
 * verdict is from another body revision (or predates revision markers). A
 * review on a different HEAD is also still live: the current body marker does
 * not prove that the review was re-evaluated after the code changed. If either
 * the HEAD or the body revision is stale, require a fresh approving verdict
 * instead of approving from the PR-body contract alone.
 */
function historicalNonApprovingBlocksDriftFallback() {
  let reviews;
  try {
    reviews = gh(['api', `repos/${REPO}/pulls/${PR}/reviews`, '--paginate']) || [];
  } catch (error) {
    markTransientFailure();
    console.log(`drift-fallback: impossibile verificare i finding storici (${String(error).slice(0, 160)}) — no fallback.`);
    return true;
  }
  const blockers = reviews.flat().filter((review) => {
    const reviewer = isManagedReview(review);
    const staleHead = String(review.commit_id || '') !== HEAD_SHA;
    const staleRevision = !reviewHasInputRevision(review.body, REVIEW_REVISION);
    const body = String(review.body || '');
    return reviewer
      && review.state !== 'PENDING'
      // A body edit on the same HEAD has a separate carry-forward path in
      // `lastBotReview`; the deterministic fallback must still never replace
      // a verdict that is stale by revision or by HEAD when that path is
      // unavailable.
      && (staleRevision || staleHead);
  });
  if (blockers.length) {
    console.log(
      `drift-fallback: ${blockers.length} review non approvante storica senza verdetto per ${REVIEW_REVISION} — no fallback.`,
    );
    return true;
  }
  return false;
}

/**
 * A Codex review has no durable evidence file: that file belongs to the
 * runner attempt that posted the review and disappears before the next run.
 * Accept a positive Codex review without a fresh file only when the same
 * commit already passed the required tests check. That successful check is
 * the durable proof that the review gate accepted the review with its
 * validated evidence; a marker in untrusted prose alone is never enough.
 */
function codexReviewWasPreviouslyAccepted(review) {
  const commit = String(review?.commit_id || '');
  if (!/^[0-9a-f]{40}$/i.test(commit)) return false;
  try {
    const payload = gh([
      // GitHub's default `latest` view replaces a successful earlier attempt
      // when the same required check is rerun. Carry-forward needs the
      // durable history, not only the currently failing attempt.
      'api', '--paginate', '--slurp',
      `repos/${REPO}/commits/${commit}/check-runs?per_page=100&filter=all`,
    ]);
    const pages = Array.isArray(payload) ? payload : [payload];
    const checks = pages.flatMap((page) => (
      Array.isArray(page?.check_runs) ? page.check_runs : []
    ));
    return checks.some((check) => check?.name === VITEST_CHECK_NAME
      && check?.status === 'completed'
      && check?.conclusion === 'success');
  } catch (error) {
    markTransientFailure();
    console.log(`review-gate: check precedente del Codex illeggibile (${String(error).slice(0, 160)}).`);
    return false;
  }
}

/**
 * Ultima review del reviewer bot, qualunque sia il suo esito. Una review con
 * la revisione body corrente vale anche su una HEAD diversa per il normale
 * fingerprint carry-forward. Una review legata a una revisione body vecchia
 * non vale nemmeno se e' ancorata alla HEAD corrente: un body edit richiede
 * una review del nuovo input.
 */
function lastBotReview() {
  let reviews;
  try {
    // Stessa forma di `auto-merge-eval.mjs`: su un endpoint che ritorna un
    // array, `--paginate` da solo concatena le pagine in UN array. Con
    // `--slurp` sarebbero pagine annidate, e un `.filter` diretto leggerebbe
    // zero review su ogni PR con piu' di una pagina — cioe' un gate che
    // approva o blocca su un insieme vuoto senza dirlo.
    reviews = gh(['api', `repos/${REPO}/pulls/${PR}/reviews`, '--paginate']) || [];
  } catch (e) {
    markTransientFailure();
    console.log(`review-gate: impossibile leggere le review (${String(e).slice(0, 160)}).`);
    return undefined; // undefined = incertezza, diverso da null = nessuna review
  }
  const automatic = findTestOnlyApproval(reviews, HEAD_SHA, {
    ghFn: gh,
    repo: REPO,
    pr: PR,
    reviewRevision: REVIEW_REVISION,
  });
  if (automatic) return automatic;
  if (process.env.CODEX_FALLBACK_EVIDENCE_FILE) {
    // Evidence comes from this run, never from the review's untrusted prose.
    const evidence = parseCodexFallbackEvidence(readFileSync(process.env.CODEX_FALLBACK_EVIDENCE_FILE, 'utf8'));
    if (evidence?.status !== FALLBACK_STATUS.SUCCESS) throw new Error('Evidenza Codex non valida o fallita');
    const codex = reviews.filter((r) => isCodexFallbackReview(r)
      && isTerminalReview(r)
      && r.commit_id === HEAD_SHA
      && reviewHasInputRevision(r.body, REVIEW_REVISION));
    // Missing/stale Codex review must not fall through to the workflow drift exemption.
    if (!codex.length) throw new Error('Nessuna review Codex marcata sulla HEAD');
    return codex[codex.length - 1];
  }
  const bots = reviews.filter((r) => isManagedReview(r) && isTerminalReview(r));
  const eligible = bots
    .filter((review) => reviewHasInputRevision(review.body, REVIEW_REVISION))
    .sort(compareReviewOrder);
  return eligible.length ? eligible[eligible.length - 1] : null;
}

/**
 * Drift-fallback: la PR modifica `tests.yml`, quindi Claude non puo' postare
 * sulla head (401 workflow-validation, skip con exit 0). Gate deterministici
 * al posto del `## LGTM`. Un 🔴 che SI APPLICA alla head resta bloccante.
 */
function driftFallbackApproves() {
  if (historicalNonApprovingBlocksDriftFallback()) return false;
  let files;
  try {
    files = gh(['api', `repos/${REPO}/pulls/${PR}/files`, '--paginate', '--jq', '.[].filename'], {
      json: false,
    })
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  } catch (e) {
    markTransientFailure();
    console.log(`drift-fallback: file della PR illeggibili (${String(e).slice(0, 160)}) — no fallback.`);
    return false;
  }
  if (!isReviewWorkflowDriftPR(files)) {
    console.log(
      'drift-fallback: la PR non tocca il workflow che ospita la review — no fallback; un push nuovo la fara\' ripartire.',
    );
    return false;
  }
  let meta;
  try {
    meta = gh([
      'api',
      `repos/${REPO}/pulls/${PR}`,
      '--jq',
      '{assoc: .author_association, login: .user.login, type: .user.type, body: (.body // "")}',
    ]);
  } catch (e) {
    markTransientFailure();
    console.log(`drift-fallback: meta della PR illeggibile (${String(e).slice(0, 160)}) — no fallback.`);
    return false;
  }
  if (!isTrustedDriftAuthor(meta)) {
    console.log(
      `drift-fallback: autore NON fidato (assoc=${meta.assoc}, login=${meta.login}, type=${meta.type}) — no fallback.`,
    );
    return false;
  }
  if (!prBodyContractOk(meta.body)) {
    console.log('drift-fallback: il body NON soddisfa il completeness contract — no fallback.');
    return false;
  }
  console.log(
    `drift-fallback: APPROVATO — la PR modifica ${files.filter(isDriftFile).join(', ')}, autore fidato, body conforme.`,
  );
  return true;
}

function isDriftFile(f) {
  return isReviewWorkflowDriftPR([f]);
}

/** Commenta UNA sola volta perche' non si accumuli un avviso a ogni push. */
function commentOnce(body) {
  let existing = '';
  try {
    existing = gh(['api', `repos/${REPO}/issues/${PR}/comments`, '--paginate', '--jq', '.[].body'], {
      json: false,
    });
  } catch {
    /* best-effort */
  }
  if (existing.includes(MARKER)) return;
  try {
    execFileSync('gh', ['pr', 'comment', PR, '--repo', REPO, '--body', body], { stdio: 'inherit' });
  } catch {
    console.log('::warning::commento del review gate non pubblicato (non bloccante).');
  }
}

/** True se l'ultima review descrive ancora il contributo della head. */
function reviewAppliesToHead(last) {
  if (last.commit_id === HEAD_SHA) return true;
  const headFp = fingerprint(HEAD_SHA);
  const revFp = fingerprint(last.commit_id);
  if (!headFp || !revFp) markTransientFailure();
  return Boolean(headFp && revFp && headFp === revFp);
}

async function main() {
  if (!REPO || !PR || !HEAD_SHA) {
    console.log('::error::review-gate: GITHUB_REPOSITORY, PR_NUMBER e HEAD_SHA sono obbligatori.');
    process.exit(1);
  }
  if (!REVIEW_REVISION) {
    markTransientFailure();
    writeFailureKind();
    console.error('::error::review-gate: REVIEW_REVISION mancante o non valida; nessun verdetto precedente può essere riusato.');
    process.exit(1);
  }
  let currentContext;
  try {
    currentContext = currentReviewInputContext();
  } catch (error) {
    markTransientFailure();
    writeFailureKind();
    console.error(`::error::review-gate: impossibile verificare HEAD + REVIEW_REVISION del body PR (${String(error).slice(0, 160)}).`);
    process.exit(1);
  }
  if (!reviewInputContextMatches(currentContext, {
    headSha: HEAD_SHA,
    reviewRevision: REVIEW_REVISION,
  })) {
    markTransientFailure();
    writeFailureKind();
    console.error(
      `::error::review-gate: HEAD o REVIEW_REVISION non corrispondono alla PR corrente (attesa head=${HEAD_SHA} revision=${REVIEW_REVISION}, corrente head=${currentContext?.headSha || '<unreadable>'} revision=${currentContext?.reviewRevision || '<unreadable>'}); nessun verdetto precedente può essere riusato.`,
    );
    process.exit(1);
  }
  const last = lastBotReview();
  const isCodexReview = isCodexFallbackReview(last);
  const hasFreshCodexEvidence = Boolean(process.env.CODEX_FALLBACK_EVIDENCE_FILE);

  if (last) {
    const body = last.body || '';
    const applies = reviewAppliesToHead(last);
    const hasRedflag = REDFLAG_IMPORTANT_RE.test(body);
    let scope = null;
    if (applies && hasRedflag) {
      if (!reviewInputContextStillCurrent()) {
        writeFailureKind();
        process.exit(1);
      }
      try {
        scope = await classifyAndMintReview(body, {
          repo: REPO,
          pr: PR,
          prUrl: `https://github.com/${REPO}/pull/${PR}`,
        });
        if (scope.outside.length > 0 && scope.minted) {
          console.log(
            `review-gate: ${scope.outside.length} finding Important fuori dal diff → follow-up ${scope.followup?.number || scope.followup?.url || 'coniato'}.`,
          );
        }
        if (scope.blocking) {
          console.log(
            `review-gate: scope conservativo — ${scope.inScope.length} finding nel diff, ${scope.unresolved.length} non risolvibili → resta bloccante.`,
          );
        }
      } catch (error) {
        markTransientFailure();
        console.log(
          `review-gate: classificazione scope fallita (${String(error).slice(0, 180)}) → finding bloccante per sicurezza.`,
        );
      }
    }
    const outsideOnlyApproved = Boolean(applies && hasRedflag && scope?.outsideOnly && scope?.minted);
    const approving = reviewStateAllowsApproval(last)
      && ((body.includes('## LGTM') && !hasRedflag) || outsideOnlyApproved);
    // The evidence file is ephemeral. On a rerun where the re-review guard
    // correctly skips Claude, require the durable successful required-check
    // proof before carrying a positive Codex review forward.
    const codexCarryApproved = !isCodexReview
      || hasFreshCodexEvidence
      || codexReviewWasPreviouslyAccepted(last);
    if (approving && applies && codexCarryApproved) {
      if (!reviewInputContextStillCurrent()) {
        writeFailureKind();
        process.exit(1);
      }
      if (last.commit_id === HEAD_SHA) {
        console.log(`review-gate: review approvante sulla head ${HEAD_SHA}.`);
      } else {
        console.log(
          `review-gate: carry-forward — contributo invariato fra ${last.commit_id} e ${HEAD_SHA} (fingerprint ${fingerprint(HEAD_SHA)}).`,
        );
      }
      process.exit(0);
    }
    if (approving && isCodexReview && !codexCarryApproved) {
      console.log(`review-gate: review Codex approvante su ${last.commit_id}, ma senza evidenza della run corrente o di un check richiesto verde precedente → resta bloccante.`);
    }
    if (!approving) {
      console.log(
        `review-gate: l'ultima review del bot (${last.commit_id}) non e' approvante — manca '## LGTM' oppure contiene un 🔴 Important.`,
      );
    } else {
      const headFp = fingerprint(HEAD_SHA);
      const revFp = fingerprint(last.commit_id);
      console.log(
        `review-gate: la review approvante e' su ${last.commit_id}, non sulla head ${HEAD_SHA}, e il contributo e' cambiato (head=${headFp} review=${revFp}).`,
      );
    }
    if (!applies) {
      // Review stantia: Claude non puo' sostituirla se tests.yml e' nel diff
      // (401 workflow-validation). Il fallback copre quel buco; un 🔴 vivo no.
      console.log(
        `review-gate: la review non si applica alla head ${HEAD_SHA} — tento il drift-fallback.`,
      );
      if (driftFallbackApproves()
        && reviewInputContextStillCurrent()
        && writeGateOutput('fallback_approved', 'true')) {
        process.exit(0);
      }
    }
  } else if (last === null) {
    console.log("review-gate: nessuna review del bot reviewer su questa PR.");
    if (driftFallbackApproves()
      && reviewInputContextStillCurrent()
      && writeGateOutput('fallback_approved', 'true')) {
      process.exit(0);
    }
  }

  commentOnce(
    `${MARKER}\n⚠️ **Review gate bloccato** — sulla head \`${HEAD_SHA}\` non c'e' una review Claude approvante per la revisione \`${REVIEW_REVISION}\`, con \`## LGTM\` e senza \`🔴 Important\`. Il merge resta bloccato finche' non ne arriva una.${RUN_URL ? `\n\nRun: ${RUN_URL}` : ''}`,
  );
  writeFailureKind();
  console.log(
    `::error::Nessuna review Claude approvante sulla head per ${REVIEW_REVISION}: manca '## LGTM', il marker di revisione oppure e' presente un finding 🔴 Important.`,
  );
  process.exit(1);
}

main().catch((error) => {
  markTransientFailure();
  writeFailureKind();
  console.error(`review-gate: errore non gestito (${String(error).slice(0, 240)}).`);
  process.exit(1);
});
