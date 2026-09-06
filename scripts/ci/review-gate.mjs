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
 * `## LGTM` e NESSUN finding `🔴 Important` (stessa `REDFLAG_IMPORTANT_RE` che
 * usa il redflag-fixer — una sola regex, nessun drift). Deve stare sulla head
 * corrente; se sta su un commit precedente vale il CARRY-FORWARD: se il
 * fingerprint del contributo (3-dot vs merge-base, code-only) e' identico fra i
 * due commit, la PR non ha cambiato il proprio codice — tipicamente un rebase
 * di solo main-merge — e la review resta valida. E' la stessa funzione che
 * usava `auto-merge-eval.mjs`, importata e non riscritta.
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
 * Env:  GH_TOKEN, GITHUB_REPOSITORY, PR_NUMBER, HEAD_SHA, RUN_URL (opzionale)
 * Exit: 0 approvato · 1 non approvato (il check-run diventa rosso)
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  prContributionFingerprint,
  isReviewWorkflowDriftPR,
  isTrustedDriftAuthor,
  prBodyContractOk,
} from './auto-merge-eval.mjs';
import { REDFLAG_IMPORTANT_RE, REVIEWER_BOT_LOGIN_RE } from './lib/constants.mjs';

const REPO = process.env.GITHUB_REPOSITORY || '';
const PR = process.env.PR_NUMBER || '';
const HEAD_SHA = process.env.HEAD_SHA || '';
const RUN_URL = process.env.RUN_URL || '';
const MARKER = '<!-- REVIEW_GATE_NO_LGTM -->';

function gh(args, { json = true } = {}) {
  const out = execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return json ? JSON.parse(out) : out;
}

function fingerprint(sha) {
  const fp = prContributionFingerprint(sha);
  return fp == null ? null : createHash('sha256').update(fp).digest('hex');
}

/**
 * Ultima review del reviewer bot, qualunque sia il suo esito. Serve sia per il
 * verdetto sia per distinguere «review che si applica alla head» da «review
 * mai postata / review stantia». Il drift-fallback si apre solo nel secondo.
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
    console.log(`review-gate: impossibile leggere le review (${String(e).slice(0, 160)}).`);
    return undefined; // undefined = incertezza, diverso da null = nessuna review
  }
  const bots = reviews.filter(
    (r) => r.user?.type === 'Bot' && REVIEWER_BOT_LOGIN_RE.test(r.user?.login || ''),
  );
  return bots.length ? bots[bots.length - 1] : null;
}

/**
 * Drift-fallback: la PR modifica `tests.yml`, quindi Claude non puo' postare
 * sulla head (401 workflow-validation, skip con exit 0). Gate deterministici
 * al posto del `## LGTM`. Un 🔴 che SI APPLICA alla head resta bloccante.
 */
function driftFallbackApproves() {
  let files;
  try {
    files = gh(['api', `repos/${REPO}/pulls/${PR}/files`, '--paginate', '--jq', '.[].filename'], {
      json: false,
    })
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  } catch (e) {
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
  return Boolean(headFp && revFp && headFp === revFp);
}

function main() {
  if (!REPO || !PR || !HEAD_SHA) {
    console.log('::error::review-gate: GITHUB_REPOSITORY, PR_NUMBER e HEAD_SHA sono obbligatori.');
    process.exit(1);
  }
  const last = lastBotReview();

  if (last) {
    const body = last.body || '';
    const approving = body.includes('## LGTM') && !REDFLAG_IMPORTANT_RE.test(body);
    const applies = reviewAppliesToHead(last);
    if (approving && applies) {
      if (last.commit_id === HEAD_SHA) {
        console.log(`review-gate: review approvante sulla head ${HEAD_SHA}.`);
      } else {
        console.log(
          `review-gate: carry-forward — contributo invariato fra ${last.commit_id} e ${HEAD_SHA} (fingerprint ${fingerprint(HEAD_SHA)}).`,
        );
      }
      process.exit(0);
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
      if (driftFallbackApproves()) process.exit(0);
    }
  } else if (last === null) {
    console.log("review-gate: nessuna review del bot reviewer su questa PR.");
    if (driftFallbackApproves()) process.exit(0);
  }

  commentOnce(
    `${MARKER}\n⚠️ **Review gate bloccato** — sulla head \`${HEAD_SHA}\` non c'e' una review Claude con \`## LGTM\` e senza \`🔴 Important\`. Il merge resta bloccato finche' non ne arriva una.${RUN_URL ? `\n\nRun: ${RUN_URL}` : ''}`,
  );
  console.log(
    "::error::Nessuna review Claude approvante sulla head: manca '## LGTM' oppure e' presente un finding 🔴 Important.",
  );
  process.exit(1);
}

main();
