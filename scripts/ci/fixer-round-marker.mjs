/**
 * Persist and verify a PR fixer round marker.
 *
 * A round is a budget claim, not prose: the fixer must not invoke the model
 * unless the marker was written and can be read back against the same PR
 * HEAD and PR-body revision.  The GitHub CLI is deliberately the only API
 * transport here; callers inherit the workspace coordinator through `gh`.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SHA_RE = /^[a-f0-9]{40}$/i;
const MARKER_RE = /^[A-Z][A-Z0-9_]{2,80}$/;
const TRUSTED_MARKER_ACTOR = 'github-actions[bot]';
export const MAX_ROUND = 2;

export function canonicalBody(body) {
  if (body === null || body === undefined) return '\n';
  if (typeof body !== 'string') throw new TypeError('PR body must be a string');
  // GitHub's `gh api --jq` body projection is the established review fence in
  // this corpus: jq emits the exact body followed by one LF. Do not trim CR,
  // trailing spaces, or that terminal LF; the marker must match REVIEW_INPUT_REVISION.
  return `${body}\n`;
}

export function bodyRevision(body) {
  return createHash('sha256').update(canonicalBody(body)).digest('hex');
}

export function markerTokens({ marker, round, headSha, bodySha }) {
  return [
    `<!-- ${marker}: ${round} -->`,
    `<!-- ${marker}_HEAD: ${headSha} -->`,
    `<!-- ${marker}_BODY: ${bodySha} -->`,
  ];
}

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new Error(`argomento inatteso: ${arg}`);
    const key = arg.slice(2);
    if (key === 'help' || key === 'verify-current' || key === 'current-round' || key === 'delete-verified'
      || key === 'refund-superseded') {
      if (key === 'help') result.help = true;
      else result[key] = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`valore mancante per --${key}`);
    }
    result[key] = value;
    i += 1;
  }
  return result;
}

function usage() {
  return 'uso: fixer-round-marker.mjs --repo owner/repo --pr N --marker NAME --round N --expected-head SHA --message TEXT --expected-author github-actions[bot] | --current-round --expected-author github-actions[bot] | --verify-current --marker NAME --round N --comment-id ID --expected-head SHA --expected-body-revision SHA --expected-author github-actions[bot] | --delete-verified --marker NAME --round N --comment-id ID --expected-head SHA --expected-body-revision SHA --expected-author github-actions[bot] | --refund-superseded --marker NAME --round N --comment-id ID --expected-head SHA --expected-body-revision SHA --expected-author github-actions[bot]';
}

function runGh(args, label) {
  const result = spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = String(result.stderr || '').trim().replace(/\s+/g, ' ').slice(0, 240);
    throw new Error(`${label}: gh exit ${result.status}${detail ? ` (${detail})` : ''}`);
  }
  return String(result.stdout || '');
}

function runGhJson(args, label) {
  const raw = runGh(args, label);
  if (!raw.trim()) throw new Error(`${label}: risposta vuota`);
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`${label}: JSON illeggibile (${error.message})`);
  }
}

function validateInputs(args) {
  const repo = String(args.repo || '');
  const pr = String(args.pr || '');
  const marker = String(args.marker || '');
  const round = Number(args.round);
  const expectedHead = String(args['expected-head'] || '').toLowerCase();
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) throw new Error('repo non valido');
  if (!/^[1-9][0-9]*$/.test(pr)) throw new Error('numero PR non valido');
  if (!MARKER_RE.test(marker)) throw new Error('nome marker non valido');
  if (!Number.isSafeInteger(round) || round < 1 || round > MAX_ROUND || String(args.round) !== String(round)) {
    throw new Error('round non valido');
  }
  if (!SHA_RE.test(expectedHead)) throw new Error('HEAD attesa non valida');
  if (typeof args.message !== 'string') throw new Error('messaggio marker mancante');
  return {
    repo, pr, marker, round, expectedHead, message: args.message,
    expectedAuthor: validateExpectedAuthor(args['expected-author']),
  };
}

function validateExpectedAuthor(value) {
  const author = String(value || TRUSTED_MARKER_ACTOR);
  if (author !== TRUSTED_MARKER_ACTOR) {
    throw new Error(`autore marker non consentito: atteso ${TRUSTED_MARKER_ACTOR}`);
  }
  return author;
}

function readPr(repo, pr) {
  const value = runGhJson(['api', `repos/${repo}/pulls/${pr}`], 'lettura PR');
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('lettura PR: risposta non-oggetto');
  }
  const headSha = String(value.head?.sha || '').toLowerCase();
  if (!SHA_RE.test(headSha)) throw new Error('lettura PR: HEAD non valida');
  if (value.body !== null && typeof value.body !== 'string') {
    throw new Error('lettura PR: body non stringa/null');
  }
  return { headSha, bodySha: bodyRevision(value.body ?? '') };
}

function readComments(repo, pr) {
  // `--paginate --slurp` is intentional: a corpus PR can exceed the first
  // 100 comments, and a first-page-only read could falsely report success.
  const value = runGhJson(
    ['api', '--paginate', '--slurp', `repos/${repo}/issues/${pr}/comments?per_page=100`],
    'lettura commenti paginata',
  );
  if (!Array.isArray(value)) throw new Error('lettura commenti paginata: risposta non-array');
  if (value.length > 0 && !value.every(Array.isArray)) {
    throw new Error('lettura commenti paginata: risposta non e\' un array di pagine');
  }
  const comments = value.flat();
  if (!comments.every((comment) => comment && typeof comment === 'object' && !Array.isArray(comment)
    && Number.isSafeInteger(Number(comment.id)) && Number(comment.id) > 0
    && typeof comment.body === 'string'
    && comment.user && typeof comment.user === 'object' && !Array.isArray(comment.user)
    && typeof comment.user.login === 'string' && comment.user.login.length > 0)) {
    throw new Error('lettura commenti paginata: commento malformato o incompleto');
  }
  return comments;
}

export function verifyPersistedMarker({ comments, marker, round, headSha, bodySha }) {
  const tokens = markerTokens({ marker, round, headSha, bodySha });
  const match = comments.find((comment) => {
    const body = typeof comment.body === 'string' ? comment.body : '';
    return tokens.every((token) => body.includes(token));
  });
  return match ? { commentId: match.id ?? null, tokens } : null;
}

/**
 * Prove the exact marker comment before a cleanup DELETE. This deliberately
 * does not require the PR to still point at the marker's HEAD: SUPERSEDED
 * cleanup runs after another writer has advanced the branch. The trusted
 * actor, comment ID, and complete snapshot-bound marker tokens are still
 * required, so a body-only preseed or a neighboring concurrent comment can
 * never be selected for deletion.
 */
export function verifyMarkerComment({ comments, marker, round, headSha, bodySha, expectedCommentId, expectedAuthor }) {
  if (!Number.isSafeInteger(Number(expectedCommentId)) || Number(expectedCommentId) <= 0) {
    throw new Error('ID marker persistito mancante o non valido per il cleanup');
  }
  if (!expectedAuthor) throw new Error('autore marker mancante per il cleanup');
  const tokens = markerTokens({ marker, round, headSha, bodySha });
  const match = comments.find((comment) => Number(comment?.id) === Number(expectedCommentId)
    && comment?.user?.login === expectedAuthor
    && typeof comment.body === 'string'
    && tokens.every((token) => comment.body.includes(token)));
  return match ? { commentId: Number(match.id), author: expectedAuthor, body: match.body, tokens } : null;
}

function readMarkerActor(expectedAuthor = TRUSTED_MARKER_ACTOR) {
  // GITHUB_TOKEN is an installation token: `/user` is not a supported identity
  // endpoint for it. These workflows post as the fixed Actions bot, so the
  // actor is an explicit trusted contract and every comment is checked against
  // it. Never infer the actor from a comment or an attacker-controlled env var.
  return validateExpectedAuthor(expectedAuthor);
}

function exactPostedComment(comments, body, author) {
  const matches = comments.filter((comment) =>
    Number.isSafeInteger(Number(comment?.id))
      && Number(comment.id) > 0
      && comment?.body === body
      && comment?.user?.login === author,
  );
  return matches.sort((left, right) => Number(left.id) - Number(right.id)).at(-1) || null;
}

/** Return only complete, trusted markers bound to the current PR snapshot. */
export function verifiedCurrentRound({ comments, marker, headSha, bodySha, expectedAuthor }) {
  if (!SHA_RE.test(headSha) || !/^[a-f0-9]{64}$/.test(bodySha)) {
    throw new Error('stato PR non valido per il cap round');
  }
  if (!expectedAuthor) throw new Error('autore marker mancante per il cap round');
  let round = 0;
  for (const comment of comments) {
    if (comment?.user?.login !== expectedAuthor || typeof comment.body !== 'string') continue;
    const match = comment.body.match(new RegExp(`<!-- ${marker}: ([0-9]+) -->`));
    if (!match) continue;
    const candidate = Number(match[1]);
    if (!Number.isSafeInteger(candidate) || candidate < 1 || candidate > MAX_ROUND) {
      throw new Error(`round marker fuori intervallo 1..${MAX_ROUND}`);
    }
    const hasHeadBinding = comment.body.includes(`<!-- ${marker}_HEAD:`);
    const hasBodyBinding = comment.body.includes(`<!-- ${marker}_BODY:`);
    if (!hasHeadBinding || !hasBodyBinding) {
      throw new Error(`marker ${marker}:${candidate} legacy/incompleto: binding HEAD/body assente`);
    }
    const persisted = verifyPersistedMarker({
      comments: [comment], marker, round: candidate, headSha, bodySha,
    });
    if (persisted) round = Math.max(round, candidate);
  }
  if (!Number.isSafeInteger(round) || round < 0 || round > MAX_ROUND) {
    throw new Error(`round corrente fuori intervallo 0..${MAX_ROUND}`);
  }
  return { round, headSha, bodyRevision: bodySha, author: expectedAuthor };
}

export function readVerifiedCurrentRound({ repo, pr, marker, expectedAuthor = TRUSTED_MARKER_ACTOR }) {
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) throw new Error('repo non valido');
  if (!/^[1-9][0-9]*$/.test(String(pr))) throw new Error('numero PR non valido');
  if (!MARKER_RE.test(marker)) throw new Error('nome marker non valido');
  const current = readPr(repo, pr);
  const comments = readComments(repo, pr);
  // The PR snapshot can change while paginated comments are being read. A
  // marker valid for the first snapshot must never authorize a newer HEAD or
  // body, so require the same snapshot on both sides of the read.
  const afterComments = readPr(repo, pr);
  if (afterComments.headSha !== current.headSha || afterComments.bodySha !== current.bodySha) {
    throw new Error('PR HEAD/body cambiati durante la lettura paginata dei marker');
  }
  return {
    marker,
    ...verifiedCurrentRound({
      comments,
      marker,
      headSha: afterComments.headSha,
      bodySha: afterComments.bodySha,
      expectedAuthor: readMarkerActor(expectedAuthor),
    }),
  };
}

function verifyPostedComment(comment, body, expectedAuthor) {
  if (!comment || typeof comment !== 'object' || Array.isArray(comment)) {
    throw new Error('risposta POST commento malformata');
  }
  if (!Number.isSafeInteger(Number(comment.id)) || Number(comment.id) <= 0) {
    throw new Error('risposta POST commento senza ID valido');
  }
  if (comment.body !== body) throw new Error('risposta POST commento con body diverso');
  if (!expectedAuthor || comment.user?.login !== expectedAuthor) {
    throw new Error('risposta POST commento senza autore verificabile');
  }
  return { id: Number(comment.id), author: expectedAuthor, body };
}

function reconcileMalformedPost({ repo, pr, body, author }) {
  let lastError;
  for (const delay of [0, 1, 2, 4]) {
    if (delay) sleep(delay);
    try {
      const exact = exactPostedComment(readComments(repo, pr), body, author);
      if (exact) return Number(exact.id);
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) throw lastError;
  return null;
}

function postComment(repo, pr, body, { refundOnDelete = null, expectedAuthor = TRUSTED_MARKER_ACTOR } = {}) {
  const trustedAuthor = readMarkerActor(expectedAuthor);
  try {
    const comment = runGhJson([
      'api', '--method', 'POST', `repos/${repo}/issues/${pr}/comments`,
      '--raw-field', `body=${body}`,
    ], 'scrittura marker round');
    return verifyPostedComment(comment, body, trustedAuthor);
  } catch (postError) {
    let reconciledId;
    try {
      reconciledId = reconcileMalformedPost({ repo, pr, body, author: trustedAuthor });
    } catch (reconcileError) {
      throw new Error(`${postError.message}; riconciliazione POST marker fallita: ${reconcileError.message}`);
    }
    if (reconciledId === null) {
      throw new Error(`${postError.message}; POST marker non riconciliata dopo read-back bounded`);
    }
    try {
      deleteComment(repo, reconciledId);
    } catch (deleteError) {
      throw new Error(`${postError.message}; rimborso marker riconciliato ${reconciledId} fallito: ${deleteError.message}`);
    }
    if (refundOnDelete) {
      try {
        publishRefundHandle(repo, pr, refundOnDelete.marker, refundOnDelete.round, trustedAuthor);
      } catch (refundError) {
        throw new Error(`${postError.message}; commento ${reconciledId} rimborsato ma handle refund non pubblicato: ${refundError.message}`);
      }
    }
    throw new Error(`${postError.message}; commento ${reconciledId} rimborsato dopo risposta POST malformata`);
  }
}

function deleteComment(repo, commentId) {
  runGh(['api', '--method', 'DELETE', `repos/${repo}/issues/comments/${commentId}`], 'rimborso marker round');
}

export function deleteVerifiedMarker({ repo, pr, marker, round, expectedHead, expectedBodySha, expectedCommentId, expectedAuthor = TRUSTED_MARKER_ACTOR }) {
  const comments = readComments(repo, pr);
  const author = readMarkerActor(expectedAuthor);
  const verified = verifyMarkerComment({
    comments, marker, round, headSha: expectedHead, bodySha: expectedBodySha,
    expectedCommentId, expectedAuthor: author,
  });
  if (!verified) {
    throw new Error('marker persistito non verificabile con stesso ID/autore/body prima del cleanup');
  }
  deleteComment(repo, verified.commentId);
  return { ...verified, deletedCommentId: verified.commentId };
}

function refundMarkerName(marker) {
  if (!marker.endsWith('_ROUND')) throw new Error(`marker non rimborsabile: ${marker}`);
  return `${marker.slice(0, -'_ROUND'.length)}_REFUNDED`;
}

function publishRefundHandle(repo, pr, marker, round, expectedAuthor = TRUSTED_MARKER_ACTOR) {
  const refundMarker = refundMarkerName(marker);
  const body = `<!-- ${refundMarker}: ${round} -->\n_Round rimborsato: marker non verificabile; nessun round consumato._`;
  return postComment(repo, pr, body, { expectedAuthor });
}

function deleteAndRefund({ repo, pr, commentId, marker, round, cause, expectedAuthor = TRUSTED_MARKER_ACTOR }) {
  deleteComment(repo, commentId);
  try {
    publishRefundHandle(repo, pr, marker, round, expectedAuthor);
  } catch (error) {
    throw new Error(`${cause}; rimborso commento ${commentId} eseguito ma handle refund non pubblicato: ${error.message}`);
  }
}

/**
 * Bodies of the two SUPERSEDED refund comments. Both carry the ID of the
 * round marker they refund: the `_REFUNDED: N` handle alone is per round, and
 * a PR can legitimately re-open round N after an earlier refund, so an
 * unbound handle cannot prove *this* marker was already refunded. The
 * `<PREFIX>_REFUNDED: N` token stays the first line, unchanged, because the
 * stale-PR rescuer matches exactly that prefix.
 */
export function supersededRefundBodies({ marker, round, commentId }) {
  const refundMarker = refundMarkerName(marker);
  const prefix = refundMarker.slice(0, -'_REFUNDED'.length);
  const binding = `<!-- ${prefix}_REFUND_FOR: ${Number(commentId)} -->`;
  return {
    refundMarker,
    attempt: `<!-- ${prefix}_REFUND_ATTEMPT: ${round} -->\n${binding}\n`
      + '_Rimborso preparato; DELETE trusted in corso. Il round non è ancora rimborsato._',
    refunded: `<!-- ${refundMarker}: ${round} -->\n${binding}\n`
      + '_Round rimborsato: run SUPERSEDED; nessun round consumato._',
  };
}

function exactTrustedIds(comments, body, author) {
  return comments
    .filter((comment) => comment?.user?.login === author && comment?.body === body
      && Number.isSafeInteger(Number(comment?.id)) && Number(comment.id) > 0)
    .map((comment) => Number(comment.id))
    .sort((left, right) => left - right);
}

/**
 * Pure classification of the SUPERSEDED refund state. It never guesses: a
 * marker comment that still exists but no longer proves the snapshot, or a
 * vanished marker without our bound attempt, is an error rather than a state
 * to paper over.
 */
export function classifySupersededRefund({
  comments, marker, round, headSha, bodySha, expectedCommentId, expectedAuthor,
}) {
  const commentId = Number(expectedCommentId);
  if (!Number.isSafeInteger(commentId) || commentId <= 0) {
    throw new Error('ID marker persistito mancante o non valido per il rimborso');
  }
  const author = validateExpectedAuthor(expectedAuthor);
  const bodies = supersededRefundBodies({ marker, round, commentId });
  const markerComment = comments.find((comment) => Number(comment?.id) === commentId) || null;
  if (markerComment && !verifyMarkerComment({
    comments: [markerComment], marker, round, headSha, bodySha,
    expectedCommentId: commentId, expectedAuthor: author,
  })) {
    throw new Error(`commento ${commentId} presente ma non e' il marker ${marker}:${round} atteso (ID/autore/snapshot)`);
  }
  return {
    ...bodies,
    commentId,
    author,
    markerPresent: Boolean(markerComment),
    attemptIds: exactTrustedIds(comments, bodies.attempt, author),
    handleIds: exactTrustedIds(comments, bodies.refunded, author),
  };
}

function readCommentsWithRetry(repo, pr, accept) {
  let lastError;
  let comments = [];
  for (const delay of [0, 1, 2, 4]) {
    if (delay) sleep(delay);
    try {
      comments = readComments(repo, pr);
      lastError = null;
      if (accept(comments)) return comments;
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) throw lastError;
  return comments;
}

function deleteIfPresent(repo, pr, commentId, label) {
  try {
    deleteComment(repo, commentId);
    return true;
  } catch (deleteError) {
    // A concurrent finalizer may have deleted the same comment first (404).
    // That is convergence only if a fresh read proves the comment is gone.
    const comments = readCommentsWithRetry(repo, pr,
      (rows) => !rows.some((comment) => Number(comment?.id) === Number(commentId)));
    if (comments.some((comment) => Number(comment?.id) === Number(commentId))) {
      throw new Error(`${label}: DELETE del commento ${commentId} fallita e commento ancora presente (${deleteError.message})`);
    }
    return false;
  }
}

/**
 * Make exactly one trusted comment with `body` exist. Idempotent: an existing
 * copy is reused, a POST whose response is lost is recovered by read-back,
 * and duplicates from a concurrent writer collapse onto the lowest ID (every
 * writer applies the same rule, so any interleaving converges).
 */
function ensureSingleComment({ repo, pr, body, author, label }) {
  let ids = exactTrustedIds(readComments(repo, pr), body, author);
  let posted = false;
  if (ids.length === 0) {
    let postError = null;
    try {
      runGh(['api', '--method', 'POST', `repos/${repo}/issues/${pr}/comments`, '--raw-field', `body=${body}`], label);
    } catch (error) {
      postError = error;
    }
    ids = exactTrustedIds(
      readCommentsWithRetry(repo, pr, (rows) => exactTrustedIds(rows, body, author).length > 0),
      body, author,
    );
    if (ids.length === 0) {
      throw new Error(`${label}: commento non persistito dopo read-back bounded${postError ? ` (${postError.message})` : ''}`);
    }
    posted = true;
  }
  const [keep, ...duplicates] = ids;
  let removed = 0;
  for (const duplicate of duplicates) {
    if (deleteIfPresent(repo, pr, duplicate, `${label} (duplicato)`)) removed += 1;
  }
  return { id: keep, posted, duplicatesRemoved: removed };
}

/**
 * SUPERSEDED refund of a pre-model round marker, as one retryable state
 * machine instead of three independent side effects:
 *
 *   marker present, no handle → bound attempt → verified DELETE → bound handle
 *   marker gone, attempt present, no handle (interrupted after DELETE) → handle
 *   marker gone, handle present (already refunded) → no write
 *
 * Every step is re-entrant, so a rerun or a concurrent finalizer converges on
 * the same end state: marker absent, exactly one bound `_REFUNDED` handle.
 * Any state that cannot be proven throws: the caller must turn it red.
 */
export function refundSupersededMarker({
  repo, pr, marker, round, expectedHead, expectedBodySha, expectedCommentId,
  expectedAuthor = TRUSTED_MARKER_ACTOR,
}) {
  const classify = (comments) => classifySupersededRefund({
    comments, marker, round, headSha: expectedHead, bodySha: expectedBodySha,
    expectedCommentId, expectedAuthor,
  });
  const initial = classify(readComments(repo, pr));
  const alreadyRefunded = !initial.markerPresent && initial.handleIds.length > 0;
  let markerDeleted = false;
  let attempt = null;

  if (initial.markerPresent) {
    if (initial.handleIds.length === 0) {
      // Persist the intent before the irreversible DELETE: after an
      // interruption the bound attempt is the proof that lets a retry
      // publish the handle for a marker that is already gone.
      attempt = ensureSingleComment({
        repo, pr, body: initial.attempt, author: initial.author, label: 'tentativo rimborso',
      });
    }
    markerDeleted = deleteIfPresent(repo, pr, initial.commentId, 'rimborso marker round');
  } else if (initial.handleIds.length === 0 && initial.attemptIds.length === 0) {
    throw new Error(`marker ${initial.commentId} assente senza tentativo di rimborso vincolato: rimborso non dimostrabile`);
  }

  const handle = ensureSingleComment({
    repo, pr, body: initial.refunded, author: initial.author, label: 'handle rimborso',
  });
  const final = classify(readCommentsWithRetry(repo, pr, (rows) => {
    const state = classify(rows);
    return !state.markerPresent && state.handleIds.length === 1;
  }));
  if (final.markerPresent || final.handleIds.length !== 1) {
    throw new Error(`rimborso non convergente: marker ${final.markerPresent ? 'presente' : 'assente'}, handle ${final.handleIds.length}`);
  }
  return {
    outcome: alreadyRefunded ? 'already-refunded' : 'refunded',
    marker,
    refundMarker: final.refundMarker,
    round: Number(round),
    commentId: final.commentId,
    markerPresent: false,
    markerDeleted,
    attemptId: attempt?.id ?? final.attemptIds[0] ?? null,
    handleId: final.handleIds[0],
    handlePosted: handle.posted,
    duplicatesRemoved: (attempt?.duplicatesRemoved || 0) + handle.duplicatesRemoved,
  };
}

function readBackPostedComment({ repo, pr, posted, marker, round, headSha, bodySha, body }) {
  const comments = readComments(repo, pr);
  const exact = comments.find((comment) => Number(comment?.id) === posted.id
    && exactPostedComment([comment], body, posted.author));
  if (!exact) throw new Error('commento marker POST non trovato con stesso ID/autore/body');
  return verifyRoundMarker({
    pr: readPr(repo, pr), comments: [exact], marker, round,
    expectedHead: headSha, expectedBodySha: bodySha,
  });
}

function sleep(seconds) {
  spawnSync('sleep', [String(seconds)]);
}

export function verifyRoundMarker({ pr, comments, marker, round, expectedHead, expectedBodySha }) {
  if (pr.headSha !== expectedHead) {
    throw new Error(`HEAD cambiata durante il marker (${pr.headSha} != ${expectedHead})`);
  }
  if (pr.bodySha !== expectedBodySha) {
    throw new Error(`body revision cambiata durante il marker (${pr.bodySha} != ${expectedBodySha})`);
  }
  const persisted = verifyPersistedMarker({
    comments,
    marker,
    round,
    headSha: expectedHead,
    bodySha: expectedBodySha,
  });
  if (!persisted) throw new Error('marker round/HEAD/body revision non trovato');
  return { ...persisted, headSha: expectedHead, bodySha: expectedBodySha };
}

export function postAndVerifyRoundMarker(args) {
  const input = validateInputs(args);
  const before = readPr(input.repo, input.pr);
  if (before.headSha !== input.expectedHead) {
    throw new Error(`HEAD gia' cambiata prima del marker (${before.headSha} != ${input.expectedHead})`);
  }
  const tokens = markerTokens({
    marker: input.marker,
    round: input.round,
    headSha: input.expectedHead,
    bodySha: before.bodySha,
  });
  const commentBody = `${tokens.join('\n')}\n${input.message}`;
  const posted = postComment(input.repo, input.pr, commentBody, {
    refundOnDelete: { marker: input.marker, round: input.round },
    expectedAuthor: input.expectedAuthor,
  });
  let lastError;
  // GitHub comment reads are eventually consistent. Keep the retry bounded;
  // if all attempts fail, remove exactly the POST response we created so this
  // failed attempt does not consume a round.
  for (const delay of [0, 1, 2, 4]) {
    if (delay) sleep(delay);
    try {
      const persisted = readBackPostedComment({
        repo: input.repo, pr: input.pr, posted, marker: input.marker,
        round: input.round, headSha: input.expectedHead, bodySha: before.bodySha,
        body: commentBody,
      });
      return {
        ...persisted,
        marker: input.marker,
        round: input.round,
        bodyRevision: before.bodySha,
        postedCommentId: posted.id,
        postedCommentAuthor: posted.author,
      };
    } catch (error) {
      lastError = error;
    }
  }
  try {
    deleteAndRefund({
      repo: input.repo,
      pr: input.pr,
      commentId: posted.id,
      marker: input.marker,
      round: input.round,
      cause: lastError?.message || 'read-back marker fallita',
      expectedAuthor: input.expectedAuthor,
    });
  } catch (error) {
    throw new Error(`${lastError?.message || 'read-back marker fallita'}; ${error.message}`);
  }
  throw new Error(`${lastError?.message || 'read-back marker fallita'}; commento ${posted.id} rimborsato`);
}

export function verifyCurrentRoundBaseline({ repo, pr, expectedHead, expectedBodySha }) {
  const current = readPr(repo, pr);
  if (current.headSha !== String(expectedHead).toLowerCase()) {
    throw new Error(`HEAD cambiata subito prima del modello (${current.headSha} != ${expectedHead})`);
  }
  if (current.bodySha !== expectedBodySha) {
    throw new Error(`body revision cambiata subito prima del modello (${current.bodySha} != ${expectedBodySha})`);
  }
  return { headSha: current.headSha, bodyRevision: current.bodySha };
}

export function verifyCurrentMarker({
  repo, pr, marker, round, expectedHead, expectedBodySha, expectedCommentId,
  expectedAuthor = TRUSTED_MARKER_ACTOR,
}) {
  const current = readPr(repo, pr);
  if (current.headSha !== String(expectedHead).toLowerCase()) {
    throw new Error(`HEAD cambiata subito prima del modello (${current.headSha} != ${expectedHead})`);
  }
  if (current.bodySha !== expectedBodySha) {
    throw new Error(`body revision cambiata subito prima del modello (${current.bodySha} != ${expectedBodySha})`);
  }
  if (!Number.isSafeInteger(Number(expectedCommentId)) || Number(expectedCommentId) <= 0) {
    throw new Error('ID marker persistito mancante o non valido subito prima del modello');
  }
  if (!Number.isSafeInteger(Number(round)) || Number(round) < 1 || Number(round) > MAX_ROUND) {
    throw new Error('round marker non valido subito prima del modello');
  }
  const comments = readComments(repo, pr);
  const author = readMarkerActor(expectedAuthor);
  const afterComments = readPr(repo, pr);
  if (afterComments.headSha !== current.headSha || afterComments.bodySha !== current.bodySha) {
    throw new Error('PR HEAD/body cambiati durante la verifica finale del marker');
  }
  const exact = comments.find((comment) => Number(comment?.id) === Number(expectedCommentId)
    && comment?.user?.login === author
    && typeof comment.body === 'string'
    && verifyPersistedMarker({
      comments: [comment], marker, round: Number(round),
      headSha: afterComments.headSha, bodySha: afterComments.bodySha,
    }));
  if (!exact) {
    throw new Error('marker persistito non verificabile con stesso ID/autore/body subito prima del modello');
  }
  return {
    headSha: afterComments.headSha,
    bodyRevision: afterComments.bodySha,
    commentId: Number(expectedCommentId),
    author,
    marker,
    round: Number(round),
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  if (args['current-round']) {
    console.log(JSON.stringify(readVerifiedCurrentRound({
      repo: String(args.repo || ''), pr: String(args.pr || ''), marker: String(args.marker || ''),
      expectedAuthor: validateExpectedAuthor(args['expected-author']),
    })));
  } else if (args['verify-current']) {
    const expectedHead = String(args['expected-head'] || '').toLowerCase();
    const expectedBodySha = String(args['expected-body-revision'] || '').toLowerCase();
    const marker = String(args.marker || '');
    const round = Number(args.round);
    const commentId = Number(args['comment-id']);
    if (!SHA_RE.test(expectedHead) || !/^[a-f0-9]{64}$/.test(expectedBodySha)
      || !MARKER_RE.test(marker) || !Number.isSafeInteger(round) || round < 1 || round > MAX_ROUND
      || !Number.isSafeInteger(commentId) || commentId <= 0) {
      throw new Error('HEAD/body revision attese non valide');
    }
    console.log(JSON.stringify(verifyCurrentMarker({
      repo: String(args.repo || ''), pr: String(args.pr || ''), marker, round,
      expectedHead, expectedBodySha, expectedCommentId: commentId,
      expectedAuthor: validateExpectedAuthor(args['expected-author']),
    })));
  } else if (args['refund-superseded']) {
    const expectedHead = String(args['expected-head'] || '').toLowerCase();
    const expectedBodySha = String(args['expected-body-revision'] || '').toLowerCase();
    const marker = String(args.marker || '');
    const round = Number(args.round);
    const commentId = Number(args['comment-id']);
    if (!/^[^/\s]+\/[^/\s]+$/.test(String(args.repo || '')) || !/^[1-9][0-9]*$/.test(String(args.pr || ''))
      || !SHA_RE.test(expectedHead) || !/^[a-f0-9]{64}$/.test(expectedBodySha)
      || !MARKER_RE.test(marker) || !marker.endsWith('_ROUND')
      || !Number.isSafeInteger(round) || round < 1 || round > MAX_ROUND
      || !Number.isSafeInteger(commentId) || commentId <= 0) {
      throw new Error('input rimborso SUPERSEDED non validi (repo/PR/marker/round/ID/HEAD/body revision)');
    }
    console.log(JSON.stringify(refundSupersededMarker({
      repo: String(args.repo), pr: String(args.pr), marker, round,
      expectedHead, expectedBodySha, expectedCommentId: commentId,
      expectedAuthor: validateExpectedAuthor(args['expected-author']),
    })));
  } else if (args['delete-verified']) {
    const expectedHead = String(args['expected-head'] || '').toLowerCase();
    const expectedBodySha = String(args['expected-body-revision'] || '').toLowerCase();
    const marker = String(args.marker || '');
    const round = Number(args.round);
    const commentId = Number(args['comment-id']);
    if (!SHA_RE.test(expectedHead) || !/^[a-f0-9]{64}$/.test(expectedBodySha)
      || !MARKER_RE.test(marker) || !Number.isSafeInteger(round) || round < 1 || round > MAX_ROUND
      || !Number.isSafeInteger(commentId) || commentId <= 0) {
      throw new Error('HEAD/body revision attese non valide');
    }
    console.log(JSON.stringify(deleteVerifiedMarker({
      repo: String(args.repo || ''), pr: String(args.pr || ''), marker, round,
      expectedHead, expectedBodySha, expectedCommentId: commentId,
      expectedAuthor: validateExpectedAuthor(args['expected-author']),
    })));
  } else {
    console.log(JSON.stringify(postAndVerifyRoundMarker(args)));
  }
}

function invokedAsThisModule() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedAsThisModule()) {
  try {
    main();
  } catch (error) {
    console.error(`::error::fixer-round-marker: ${error.message || error}`);
    console.error(usage());
    process.exitCode = 1;
  }
}
