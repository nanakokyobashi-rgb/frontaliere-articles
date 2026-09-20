#!/usr/bin/env node
/**
 * body-rereview-admission.mjs — un body corretto sulla STESSA HEAD dopo un
 * verdetto non approvante ammette UNA review `minimal` sul solo body.
 *
 * ## Il costo che chiude
 *
 * Il re-review guard di `tests.yml` lega ogni verdetto alla revisione del body
 * (`REVIEW_INPUT_REVISION`): e' quello che impedisce a un rerun di riusare un
 * LGTM emesso su un body diverso. L'effetto collaterale e' che dopo una
 * correzione del body NESSUNA review porta piu' la revisione corrente, il
 * guard cade sul ramo «nessuna review terminale precedente» e compra una
 * review PIENA — tier `high` se la PR tocca `generator/`, `engine/`, `host/` o
 * i workflow, cioe' quasi sempre su una PR di ciclo.
 *
 * Ma dopo un body edit il CODICE e' identico per costruzione: la HEAD non e'
 * cambiata. Rigiudicare l'intero contributo per una riga di prosa e' il giro
 * di review piu' caro che questo repo paga, ed e' anche il piu' frequente,
 * perche' il 🔴 sul contratto del body e' il finding piu' comune.
 *
 * ## Perche' `minimal` e non «salta»
 *
 * Saltare sarebbe sbagliato nella direzione opposta: il body corretto NON e'
 * stato giudicato da nessuno, e il verdetto precedente era un no. Serve un
 * giudizio nuovo, ma solo sul body — e i 🔴 di codice ancora aperti vanno
 * riportati identici, non chiusi per silenzio. E' esattamente il tier
 * `minimal`, con la sezione `## Code contribution unchanged` nel bundle.
 *
 * ## I tre confini
 *
 * - Un LGTM pulito sulla HEAD resta STICKY: un body edit dopo un si' non
 *   compra una seconda review (e' la classe che il guard esiste per chiudere).
 * - Il numero di verdetti su una singola HEAD e' limitato: un loop di body
 *   edit non puo' comprare review illimitate.
 * - Se una review sulla HEAD porta gia' la revisione corrente, quel body e'
 *   gia' stato giudicato: non si ammette niente.
 * - Se il verdetto precedente porta anche UN SOLO 🔴 Important di CODICE, la
 *   corsia body-only non si apre affatto. Questo confine e' deterministico e
 *   sostituisce una promessa: il prompt puo' chiedere al modello di riportare
 *   i finding di codice, ma una review `minimal` che li dimentica chiude il
 *   gate e il 🔴 sparisce — e un contributo di codice invariato resterebbe
 *   approvato senza che nessuno lo abbia riparato. Se ci sono finding di
 *   codice aperti, correggere il body non basta e la review piena e' giusta.
 *
 * Uso:
 *   gh api .../reviews --paginate --slurp \
 *     | node scripts/ci/body-rereview-admission.mjs \
 *         --head <sha> --revision <body:sha256> --body-edited-at <iso>
 *
 * Stampa su stdout `body_rereview=true|false` (forma GITHUB_OUTPUT).
 */
import { REST_REVIEWER_BOT_LOGIN_RE } from './lib/constants.mjs';
import { importantFindings } from './review-scope.mjs';

/** Raggiunto questo numero di verdetti sulla stessa HEAD non si ammette altro. */
export const MAX_BODY_REREVIEWS_PER_HEAD = 3;

const REVISION_LINE_RE = /^<!-- REVIEW_INPUT_REVISION: (body:[0-9a-f]{64}) -->$/i;
const LGTM_RE = /^[ \t]{0,3}##[ \t]+LGTM[ \t]*$/;
const IMPORTANT_RE = /🔴[ \t]*\*{0,2}[ \t]*Important[ \t]*\*{0,2}[ \t]*[:—-]/;

/** Le pagine di `--slurp` sono array annidati; `--paginate` da solo no. */
export function flattenReviewPages(reviews) {
  if (!Array.isArray(reviews)) return [];
  return reviews.flatMap((entry) => (Array.isArray(entry) ? entry : [entry]))
    .filter((review) => review && typeof review === 'object');
}

function isManagedBotReview(review) {
  const login = String(review?.user?.login || '');
  if (REST_REVIEWER_BOT_LOGIN_RE.test(login)) return true;
  return /^github-actions\[bot\]$/i.test(login)
    && String(review?.body || '').includes('<!-- CODEX_FALLBACK_REVIEW -->');
}

function isTerminal(review) {
  const state = String(review?.state || '');
  return state !== '' && state !== 'PENDING' && state !== 'DISMISSED';
}

/** Revisioni body dichiarate da una review; piu' di una = marker ambiguo. */
export function reviewRevisions(body) {
  const found = new Set();
  for (const line of String(body || '').split(/\r?\n/)) {
    const match = line.replace(/\r$/, '').match(REVISION_LINE_RE);
    if (match) found.add(match[1].toLowerCase());
  }
  return [...found];
}

/** Un verdetto approvante: `## LGTM` come riga propria e nessun 🔴 Important. */
export function reviewIsApproving(body) {
  const text = String(body || '');
  if (!text.split(/\r?\n/).some((line) => LGTM_RE.test(line))) return false;
  return !IMPORTANT_RE.test(text);
}

function reviewId(review) {
  const id = Number(review?.id);
  return Number.isFinite(id) ? id : 0;
}

// Anchor `PR body:L<n>` in POSIZIONE, cioe' come prefisso della prima riga del
// finding — la stessa forma con cui il reviewer ancora un finding a un file.
// Cercarlo ovunque nel testo era sbagliato nella direzione peggiore: un
// Important di CODICE senza citazione che menziona di sfuggita «vedi PR
// body:L5» sarebbe passato per body-only, avrebbe aperto la corsia `minimal`
// e sarebbe sparito dal verdetto.
//
// Volutamente LOCALE e non importato da `review-scope.mjs`: il gemello la'
// arriva in una PR concatenata, e legare questo modulo a un export che su
// `main` non esiste ancora romperebbe il guard su ogni PR nel frattempo.
const PR_BODY_ANCHOR_RE = /^\s*(?:[-*]\s*)?`?PR body[:#]L?[1-9]\d*(?:\s*[-–]\s*L?[1-9]\d*)?(?=$|[`:\s])/iu;

/**
 * Vero se il verdetto porta almeno un 🔴 Important che NON e' ancorato al solo
 * body: un finding che cita un file, o che non porta nessun anchor `PR
 * body:L<n>`, e' lavoro di codice aperto e la correzione del body non lo tocca.
 */
export function hasOpenCodeImportant(body) {
  let findings;
  try {
    findings = importantFindings(String(body || ''));
  } catch {
    // Parser in errore: si assume il caso peggiore e la corsia resta chiusa.
    return true;
  }
  return findings.some((finding) => finding.citations.length > 0
    // Solo la PRIMA riga: e' li' che vive l'anchor di posizione.
    || !PR_BODY_ANCHOR_RE.test(String(finding.text || '').split(/\r?\n/)[0] || ''));
}

function submittedAt(review) {
  const raw = review?.submitted_at || review?.submittedAt || review?.created_at || '';
  const at = Date.parse(String(raw));
  // Un timestamp illeggibile non deve far sembrare l'edit PIU' RECENTE di una
  // review che non sappiamo datare: si assume il futuro, cioe' nega.
  return Number.isFinite(at) ? at : Number.MAX_SAFE_INTEGER;
}

/**
 * @param {{headSha?: string, revision?: string, reviews?: unknown, bodyEditedAt?: string}} input
 * @returns {boolean} vero se ammettere UNA review `minimal` sul solo body.
 */
export function shouldAdmitBodyReReview({ headSha, revision, reviews, bodyEditedAt } = {}) {
  if (!/^[0-9a-f]{40}$/i.test(String(headSha || ''))) return false;
  const onHead = flattenReviewPages(reviews)
    .filter((review) => isManagedBotReview(review) && isTerminal(review)
      && String(review.commit_id || '') === String(headSha));
  if (onHead.length === 0) return false;
  if (onHead.length >= MAX_BODY_REREVIEWS_PER_HEAD) return false;
  const wanted = String(revision || '').toLowerCase();
  if (wanted) {
    // Il body corrente e' gia' stato giudicato su questa HEAD: non c'e'
    // niente di nuovo da rigiudicare, e il guard normale decide.
    const alreadyJudged = onHead.some((review) => reviewRevisions(review.body).includes(wanted));
    if (alreadyJudged) return false;
  }
  // Ordinamento per timestamp E per id: due review inviate nello stesso
  // istante hanno lo stesso `submitted_at`, e senza il secondo criterio
  // «l'ultima» sarebbe quella che l'ordinamento capita a mettere in fondo.
  const ordered = [...onHead].sort((a, b) => (submittedAt(a) - submittedAt(b))
    || (reviewId(a) - reviewId(b)));
  const latest = ordered[ordered.length - 1];
  // Un LGTM pulito resta sticky: un body edit dopo un si' non compra nulla.
  if (reviewIsApproving(latest?.body)) return false;
  // Un 🔴 di CODICE aperto chiude la corsia: vedi il docblock.
  if (hasOpenCodeImportant(latest?.body)) return false;
  const editedAt = Date.parse(String(bodyEditedAt || ''));
  if (!Number.isFinite(editedAt)) return false;
  return editedAt > submittedAt(latest);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    out[arg.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : 'true';
  }
  return out;
}

export function admissionCli(argv, stdinText) {
  const opts = parseArgs(argv);
  let reviews = [];
  try {
    reviews = JSON.parse(String(stdinText || '[]'));
  } catch {
    // Input illeggibile: non si AMMETTE niente. Il guard normale decide, e il
    // percorso caro (review piena) e' il fallback sicuro, non quello economico.
    process.stderr.write('body-rereview-admission: JSON delle review illeggibile → nessuna ammissione.\n');
    process.stdout.write('body_rereview=false\n');
    return 0;
  }
  const admit = shouldAdmitBodyReReview({
    headSha: opts.head,
    revision: opts.revision,
    reviews,
    bodyEditedAt: opts['body-edited-at'],
  });
  process.stdout.write(`body_rereview=${admit ? 'true' : 'false'}\n`);
  if (admit) {
    process.stderr.write(
      `Verdetto non approvante sulla HEAD ${opts.head} e body modificato dopo di esso → review minimal sul solo body.\n`,
    );
  }
  return 0;
}

const invokedDirectly = process.argv[1]
  && process.argv[1].endsWith('body-rereview-admission.mjs');
if (invokedDirectly) {
  const chunks = [];
  process.stdin.on('data', (chunk) => chunks.push(chunk));
  process.stdin.on('end', () => {
    process.exit(admissionCli(process.argv.slice(2), Buffer.concat(chunks).toString('utf8')));
  });
}
