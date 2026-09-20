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

const SHA_RE = /^[a-f0-9]{40}$/i;
const MARKER_RE = /^[A-Z][A-Z0-9_]{2,80}$/;
export const MAX_ROUND = 2;

export function canonicalBody(body) {
  return String(body ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n');
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
    if (key === 'help' || key === 'verify-current') {
      if (key === 'help') result.help = true;
      else result['verify-current'] = true;
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
  return 'uso: fixer-round-marker.mjs --repo owner/repo --pr N --marker NAME --round N --expected-head SHA --message TEXT';
}

function runGh(args, label) {
  const result = spawnSync('gh', args, { encoding: 'utf8' });
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
  return { repo, pr, marker, round, expectedHead, message: args.message };
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
  const comments = value.length === 0
    ? []
    : value.every(Array.isArray)
      ? value.flat()
      : value;
  if (!comments.every((comment) => comment && typeof comment === 'object' && !Array.isArray(comment))) {
    throw new Error('lettura commenti paginata: pagina malformata');
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

function postComment(repo, pr, body) {
  const actor = runGhJson(['api', 'user'], 'lettura autore marker');
  const expectedAuthor = String(actor?.login || '');
  if (!expectedAuthor) throw new Error('lettura autore marker: login assente');
  const comment = runGhJson([
    'api', '--method', 'POST', `repos/${repo}/issues/${pr}/comments`,
    '--raw-field', `body=${body}`,
  ], 'scrittura marker round');
  return verifyPostedComment(comment, body, expectedAuthor);
}

function deleteComment(repo, commentId) {
  runGh(['api', '--method', 'DELETE', `repos/${repo}/issues/comments/${commentId}`], 'rimborso marker round');
}

function readBackPostedComment({ repo, pr, posted, marker, round, headSha, bodySha, body }) {
  const comments = readComments(repo, pr);
  const exact = comments.find((comment) =>
    Number(comment?.id) === posted.id
      && comment?.body === body
      && comment?.user?.login === posted.author,
  );
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
  const posted = postComment(input.repo, input.pr, commentBody);
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
    deleteComment(input.repo, posted.id);
  } catch (error) {
    throw new Error(`${lastError?.message || 'read-back marker fallita'}; rimborso commento ${posted.id} fallito: ${error.message}`);
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

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  if (args['verify-current']) {
    const expectedHead = String(args['expected-head'] || '').toLowerCase();
    const expectedBodySha = String(args['expected-body-revision'] || '').toLowerCase();
    if (!SHA_RE.test(expectedHead) || !/^[a-f0-9]{64}$/.test(expectedBodySha)) {
      throw new Error('HEAD/body revision attese non valide');
    }
    console.log(JSON.stringify(verifyCurrentRoundBaseline({
      repo: String(args.repo || ''), pr: String(args.pr || ''),
      expectedHead, expectedBodySha,
    })));
  } else {
    console.log(JSON.stringify(postAndVerifyRoundMarker(args)));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (error) {
    console.error(`::error::fixer-round-marker: ${error.message || error}`);
    console.error(usage());
    process.exitCode = 1;
  }
}
