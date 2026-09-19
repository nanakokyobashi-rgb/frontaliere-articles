/**
 * collect-followup-batch.mjs — produce the FINAL batch of merged PRs to triage in
 * ONE scheduled Claude session (zero-Claude, deterministico).
 *
 * `post-merge-followup.yml` was triggered `pull_request:[closed]` → UNA run Claude
 * (sonnet, ~20 turni) per OGNI PR mergiata dall'owner. Il ~60-80% di quelle run
 * creava ZERO issue (i due gate per-PR `is-followup-fix-pr.mjs` /
 * `followup-has-candidates.mjs` arrivavano dopo aver già speso una run, oppure il
 * triage girava a vuoto). Sulla quota Max OAuth CONDIVISA con la sessione interattiva
 * owner (AGENTS.md § frugalità) è il #2 consumatore. Questo script converte il modello
 * a SCHEDULED-BATCH: una sola sessione ogni ~3h triagia tutte le PR mergiate dalla
 * finestra precedente.
 *
 * SICUREZZA > VELOCITÀ — mai perdere un follow-up:
 *  - **Il cursore durevole è il marker per-PR, non il watermark.** Ogni PR
 *    processata riceve il commento `## Post-merge follow-up triage`, e
 *    l'idempotenza scarta cio' che è già fatto. La finestra di raccolta serve
 *    quindi solo a limitare il costo della query, ed è un **lookback fisso**
 *    (`MAX_WINDOW_HOURS`, default 48h) indipendente dall'esito delle run.
 *    Il vecchio «watermark = ultima run di SUCCESSO» non si correggeva con un
 *    semplice tetto, perché sbaglia in ENTRAMBI i versi: se una run troncata
 *    dal cap esce VERDE il watermark avanza e le PR oltre il prefisso non
 *    rientrano più in nessuna finestra (perdita silenziosa); se resta ROSSA la
 *    finestra cresce senza limite e il verde è irraggiungibile (misurato il
 *    2026-09-18 sul sito: watermark fermo al 2026-09-10T13:13:51Z, finestra
 *    8,0 giorni, 737 candidate, 35 run rosse, 161,6 h). Con un lookback fisso
 *    nessuna delle due derive è possibile.
 *  - **Ordine FIFO.** Il cap taglia la coda, quindi l'ordine decide CHI viene
 *    rinviato: i candidati sono ordinati dal più VECCHIO, così ogni run drena
 *    dalla testa e il residuo avanza. Dal più recente (l'ordine naturale della
 *    Search API) la coda vecchia resterebbe indietro a ogni giro.
 *  - **Il limite dichiarato** è di capacità, non di cursore: una PR non
 *    triagiata entro `MAX_WINDOW_HOURS` esce dalla finestra. Si legge in
 *    `deferred_count`, che va guardato insieme al throughput.
 *  - **Idempotenza:** scarta le PR che hanno GIÀ un commento
 *    `## Post-merge follow-up triage` (il marker che Claude posta su OGNI PR
 *    processata) → niente doppio-triage sulla finestra di overlap.
 *    Una PR di fix daily con `Addresses` + `Follow-up item: FU-...` è l'unica
 *    eccezione al grandchild gate: passa per cercare finding nuovi nel bucket padre.
 *  - **Gate per-PR riusati BYTE-PER-BYTE:** ogni candidato passa per i due gate
 *    deterministici esistenti, invocati come subprocess (`is-followup-fix-pr.mjs`
 *    grandchild-suppression + `followup-has-candidates.mjs` no-op), così il risparmio
 *    dei gate è preservato anche nel modello batch. Tieni solo le PR che passano
 *    ENTRAMBI (mirror esatto dell'`if:` che il workflow aveva sullo step Claude).
 *  - **PROCEED-SAFE per i gate per-PR:** un gate inconcludente lascia la PR nel
 *    batch (mai persa). Le sorgenti della raccolta — watermark, elenco paginato e
 *    commenti — invece falliscono chiuse: un output vuoto non può mascherare un
 *    errore e far avanzare il watermark.
 *
 * Output (GITHUB_OUTPUT): `collection_ok=true|false` (le SORGENTI erano
 *   leggibili — non «la finestra è stata drenata»), `batch_prs=<csv di numeri>`,
 *   `batch_count=<n>`, `deferred_count=<n>` (PR rimaste fuori dal cap di
 *   sessione), `max_turns=<n>` e `daily_key=YYYY-MM-DD` (giorno di triage
 *   riuscito in Zurich).
 *
 * Uso:  node scripts/ci/collect-followup-batch.mjs
 * Env:  GH_REPO|GITHUB_REPOSITORY, GITHUB_OUTPUT/GITHUB_STEP_SUMMARY (opz),
 *       MAX_WINDOW_HOURS (opz, default 48).
 *       Richiede `gh` in PATH.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// The collector is also copied into an isolated gate-fault sandbox by the
// corpus tests. Prefer the shared parser in a real checkout, but keep this
// small bootstrap fallback so a missing sibling is reported by the collector
// itself rather than preventing any output before the watermark guard runs.
let dailyBucketInfo;
let dailyKeyZurich;
try {
  ({ dailyBucketInfo, dailyKeyZurich } = await import('./followup-resolution-match.mjs'));
} catch {
  dailyKeyZurich = (nowMs = Date.now()) => new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Zurich', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(nowMs));
  dailyBucketInfo = (title = '') => {
    const m = /^follow-up\(daily:(\d{4}-\d{2}-\d{2})\):\s+(\d+)\s+items?\b/i.exec(String(title));
    return m ? { dailyKey: m[1], count: Number(m[2]) } : null;
  };
}

const TRIAGE_COMMENT_PREFIX = '## Post-merge follow-up triage';
// Tetto duro della finestra di raccolta. Non è un'ottimizzazione: è ciò che
// impedisce al watermark «ultima run di SUCCESSO» di diventare un ratchet
// irreversibile (vedi l'intestazione). 48h = due giorni di triage, cioè il
// doppio dell'unità di processo dichiarata (il bucket giornaliero), quindi una
// giornata intera di run rosse viene ancora ri-coperta per intero.
const MAX_WINDOW_HOURS = positiveHours(process.env.MAX_WINDOW_HOURS, 48);

/**
 * Un override malformato non deve poter spostare la finestra nel futuro.
 * `Number(x) || d` accettava negativi e Infinity: il primo produce un confine
 * futuro (zero candidati, follow-up persi in silenzio), il secondo rompe la
 * serializzazione della data. Qui tutto cio' che non e' un numero finito e
 * positivo torna al default.
 */
export function positiveHours(raw, fallback) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
const SEARCH_PAGE_SIZE = 100;
// Capacity evidence: run 34602892494 reached the provider's 32-minute ceiling
// while processing a 36-PR window. Four is therefore a conservative operational
// cap, not a promise of measured per-PR capacity.
//
// Una finestra più larga del cap NON è un errore di raccolta: è un rinvio
// PIANIFICATO. Il troncamento viene dichiarato in `deferred_count`, mentre
// `collection_ok` continua a descrivere l'unica cosa che sa descrivere — se le
// SORGENTI (watermark, elenco paginato, commenti) erano leggibili. Prima erano
// lo stesso bit, e le due condizioni hanno esiti opposti: un errore di sorgente
// deve tenere il watermark indietro, un rinvio pianificato deve lasciarlo
// avanzare, altrimenti il residuo non si drena mai. Confuse, producevano il
// ratchet documentato sopra (34 run rosse consecutive, 157,7 h).
export const FOLLOWUP_SESSION_BATCH_LIMIT = 4;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const GATE_DIRECTORY_SENTINELS = [
  'followup-resolution-match.mjs',
  'is-followup-fix-pr.mjs',
  'followup-has-candidates.mjs',
];

const REPO = process.env.GH_REPO || process.env.GITHUB_REPOSITORY || '';
const repoArgs = REPO
  ? ['--repo', REPO]
  : [];

/**
 * Un item del corpus puo' avere come target un file del sito: in quel caso il
 * bucket giornaliero nasce NEL SITO, e il marker della PR corpus lo cita col
 * suo numero. Leggere il bucket solo in `GH_REPO` faceva rispondere a `gh`
 * «Could not resolve to an issue with the number 8944» — cioe' `null`, cioe'
 * «lettura indisponibile» — su OGNI bucket cross-repo: 4 delle 11 PR bloccate
 * nella run 35430183038 sono esattamente questo caso.
 *
 * ponytail: entrambi i repo sono PUBBLICI, quindi il `GITHUB_TOKEN` del job
 * basta per la lettura cross-repo e non serve anticipare il caricamento dei PAT.
 * Se uno dei due diventasse privato, questa lettura va spostata dopo lo step
 * «Load cross-repo follow-up credentials» e deve usare `GITHUB_PAT_SITE`.
 */
const BUCKET_REPOS = [...new Set([
  REPO,
  process.env.FOLLOWUP_SITE_REPO || 'valerielinc-ops/frontaliere-si-o-no',
  process.env.FOLLOWUP_CORPUS_REPO || 'nanakokyobashi-rgb/frontaliere-articles',
].filter(Boolean))];

function gh(args, token = '', quiet = false) {
  try {
    const env = token ? { ...process.env, GH_TOKEN: token } : process.env;
    return execFileSync('gh', args, {
      encoding: 'utf-8',
      maxBuffer: 32 * 1024 * 1024,
      env,
      // `quiet`: un bucket assente dal primo repository e' l'esito ATTESO della
      // ricerca cross-repo, non un guasto. Lasciar passare il
      // «GraphQL: Could not resolve to an issue» di `gh` mette nel log della run
      // una riga che sembra la causa del rosso: e' esattamente il genere di
      // rumore che ha reso illeggibili le otto run rosse di questa finestra.
      stdio: quiet ? ['ignore', 'pipe', 'ignore'] : undefined,
    });
  } catch {
    return null;
  }
}

/**
 * Credenziale esplicita per repository, senza fallback implicito.
 *
 * Lo step `Verify complete follow-up triage` gira DOPO «Load cross-repo
 * follow-up credentials», quindi i PAT ci sono; lo step `Collect follow-up
 * batch` gira PRIMA e non li ha. La catena e' percio' dichiarata e degrada in
 * modo morbido sul token del job: entrambi i repository sono pubblici, e una
 * lettura di sola issue riesce comunque. Se uno dei due diventasse privato, la
 * lettura del collector va spostata dopo il caricamento dei PAT — non allargata
 * qui con un fallback silenzioso.
 */
export function bucketRepoToken(repo, env = process.env) {
  const site = env.FOLLOWUP_SITE_REPO || 'valerielinc-ops/frontaliere-si-o-no';
  const corpus = env.FOLLOWUP_CORPUS_REPO || 'nanakokyobashi-rgb/frontaliere-articles';
  if (repo === site) return env.GITHUB_PAT_SITE || env.GITHUB_PAT || env.GH_TOKEN || '';
  if (repo === corpus) return env.GITHUB_PAT_NANAKO || env.GITHUB_PAT || env.GH_TOKEN || '';
  return env.GH_TOKEN || env.GITHUB_PAT || '';
}

// ── Pure helpers (no I/O) → unit-testable ───────────────────────────

/**
 * Eligible PR authors. The `pull_request` trigger filtered on the REST
 * `user.login` form (`valerielinc-ops` / `frontaliere-automation[bot]`); the batch
 * model reads authors via `gh pr list --json author`, whose GraphQL form prefixes
 * apps with `app/` and drops `[bot]` (e.g. `app/frontaliere-automation`). We
 * canonicalise both forms to a bare login so the allowlist matches regardless of
 * source — same author SCOPE as the original trigger, no expansion.
 */
/**
 * Corpus authors differ from the site mirror. Keep the adaptation local while
 * allowing tests/workflows to override the set explicitly.
 */
const ELIGIBLE_AUTHORS = new Set(
  (process.env.FOLLOWUP_ELIGIBLE_AUTHORS || 'nanakokyobashi-rgb,valerielinc-ops,claude,github-actions')
    .split(',')
    .map((s) => canonicalLogin(s))
    .filter(Boolean),
);

/** Strip the `app/` prefix (gh GraphQL bot form) and `[bot]` suffix (REST form). */
export function canonicalLogin(login) {
  return String(login || '').trim().replace(/^app\//, '').replace(/\[bot\]$/, '');
}

/**
 * Inizio della finestra di raccolta: un lookback FISSO, non un cursore.
 *
 * Prima era l'inizio dell'ultima run di SUCCESSO. Quella definizione porta un
 * difetto che non si chiude con un tetto: se una run troncata dal cap esce
 * VERDE, il watermark avanza al suo inizio e le PR oltre il prefisso di
 * `FOLLOWUP_SESSION_BATCH_LIMIT` non rientrano piu' in nessuna finestra — si
 * perdono in silenzio, e `deferred_count` sarebbe solo telemetria di un
 * ammanco. Se invece resta rossa, il watermark non avanza ma la finestra
 * cresce senza limite e il verde diventa irraggiungibile (35 run rosse, 161,6 h
 * misurate il 2026-09-18).
 *
 * Il cursore durevole per-PR esiste gia' ed e' il commento marker
 * `## Post-merge follow-up triage`: l'idempotenza scarta cio' che e' fatto. Al
 * watermark non serve quindi garantire la ri-copertura, solo LIMITARE il costo
 * della query. Un lookback fisso fa esattamente quello e non dipende
 * dall'esito delle run, quindi nessuna delle due derive e' piu' possibile: ogni
 * run ri-copre le stesse `MAX_WINDOW_HOURS`, salta le PR gia' commentate e
 * lavora le piu' vecchie rimaste.
 *
 * Il limite dichiarato: una PR non triagiata entro `MAX_WINDOW_HOURS` esce
 * dalla finestra. E' un vincolo di CAPACITA' (ingresso > throughput), non un
 * difetto del cursore, e va letto insieme a `deferred_count`.
 *
 * @param {number} [nowMs]
 * @param {number} [maxWindowHours]
 * @returns {string} ISO8601
 */
export function collectionWindowStartISO(nowMs = Date.now(), maxWindowHours = MAX_WINDOW_HOURS) {
  const hours = positiveHours(maxWindowHours, 48);
  return new Date(nowMs - hours * 3600_000).toISOString();
}

/**
 * Parse one complete `gh api --paginate --slurp search/issues` response. Search API
 * caps a query at 1,000 results; a short page set or `incomplete_results` is therefore
 * an error, not an empty collection. The caller must keep the watermark unchanged.
 *
 * @param {string} searchPagesJson
 * @returns {Array<{number:number,title?:string,author?:{login:string},mergedAt?:string,headRefName?:string}>|null}
 */
export function parseMergedPRPages(searchPagesJson) {
  let pages;
  try {
    pages = JSON.parse(searchPagesJson || '');
  } catch {
    return null;
  }
  if (!Array.isArray(pages) || !pages.length) return null;
  const records = [];
  const seen = new Set();
  let totalCount = null;
  for (const page of pages) {
    if (!page || typeof page !== 'object' || Array.isArray(page)
        || page.incomplete_results !== false || !Array.isArray(page.items)) return null;
    const pageTotal = Number(page.total_count);
    if (!Number.isInteger(pageTotal) || pageTotal < 0) return null;
    if (totalCount === null) totalCount = pageTotal;
    if (pageTotal !== totalCount) return null;
    for (const item of page.items) {
      const number = Number(item?.number);
      const login = item?.user?.login;
      const mergedAt = item?.pull_request?.merged_at;
      if (!Number.isInteger(number) || number <= 0 || typeof login !== 'string' || !login.trim()
          || typeof mergedAt !== 'string' || Number.isNaN(Date.parse(mergedAt))) return null;
      if (seen.has(number)) return null;
      seen.add(number);
      records.push({
        number,
        title: item.title,
        author: { login },
        mergedAt,
        headRefName: item?.head?.ref || '',
      });
    }
  }
  return totalCount === records.length ? records : null;
}

/**
 * Parse a legacy `gh pr list --json number,title,author,mergedAt,headRefName` payload
 * and keep only eligible-author PRs. This pure compatibility helper remains lenient;
 * the CLI uses `parseMergedPRPages()` above and fails closed before calling it.
 * @param {string} prListJson
 * @returns {Array<{number:number, title?:string, headRefName?:string}>}
 */
export function parseMergedPRs(prListJson) {
  let prs = [];
  try {
    prs = JSON.parse(prListJson || '[]');
  } catch {
    return [];
  }
  if (!Array.isArray(prs)) return [];
  return prs.filter((pr) => pr && pr.author && ELIGIBLE_AUTHORS.has(canonicalLogin(pr.author.login)));
}

/**
 * True if the PR already carries a `## Post-merge follow-up triage` comment (any
 * variant: the normal summary, "zero outstanding items", "(backfill skipped)"). The
 * comment is the idempotency marker Claude posts on EVERY processed PR.
 * Proceed-safe: parse error → false (NOT deduped → PR stays a candidate).
 * @param {string} commentsJson  output of `gh pr view N --json comments`
 * @param {string} [prefix]
 * @returns {boolean}
 */
export function hasTriageComment(commentsJson, prefix = TRIAGE_COMMENT_PREFIX) {
  let data;
  try {
    data = JSON.parse(commentsJson || '');
  } catch {
    return false;
  }
  const comments = Array.isArray(data) ? data : data && Array.isArray(data.comments) ? data.comments : [];
  return comments.some((c) => typeof c?.body === 'string' && c.body.trimStart().startsWith(prefix));
}

/** Return the latest follow-up marker body, or null when comments are unreadable. */
export function latestTriageCommentBody(commentsJson, prefix = TRIAGE_COMMENT_PREFIX) {
  let data;
  try {
    data = JSON.parse(commentsJson || '');
  } catch {
    return null;
  }
  const comments = Array.isArray(data)
    ? data
    : data && Array.isArray(data.comments) ? data.comments : null;
  if (!comments) return null;
  const bodies = comments
    .map((comment) => typeof comment?.body === 'string' ? comment.body : '')
    .filter((body) => body.trimStart().startsWith(prefix));
  return bodies.length ? bodies[bodies.length - 1] : null;
}

/**
 * Extract the persistence claim from a marker.
 *
 * ## Perche' qui non c'e' piu' nessuna formula ammessa
 *
 * Il prompt NON impone un formato al corpo del marker, quindi la riga di claim
 * e' prosa generata da un modello. Ogni versione precedente di questo parser
 * era un ELENCO di formule (`Created:`, `Created/updated:`, `Daily bucket:`), ed
 * e' stata superata dalla variante successiva quattro volte:
 *
 *   2026-09-17  `- Daily bucket: #8944 (...)`       aggiunta al parser
 *   2026-09-18  `Created/updated: 0 item; ...`      aggiunto il claim a zero
 *   2026-09-18  `Bucket daily: #9102 — ...`         NON riconosciuta
 *   2026-09-19  `- Daily bucket: nessuno.`          NON riconosciuta
 *
 * Misurato sulla run 35430183038 (schedule, 07:45Z): le ULTIME DUE varianti
 * hanno fermato tutte le 11 PR triagiate della finestra — `deferred_count=17`,
 * le stesse 4 PR piu' vecchie ri-triagiate ogni 3 ore come no-op, sei run rosse
 * consecutive. Un allowlist di sinonimi non e' un cursore durevole: e' un
 * contratto che una delle due parti non ha mai firmato.
 *
 * Il discriminante ora e' STRUTTURALE e non nomina nessun verbo:
 *  - un ITEM dichiarato e' una riga `Follow-up item: FU-YYYY-MM-DD-NNN`. Quel
 *    formato e' l'unica cosa che il prompt impone davvero al marker, ed e' lo
 *    stesso ID che compare nel corpo del bucket;
 *  - un BUCKET citato e' un `#N` su una riga che dice «bucket», in qualunque
 *    ordine e con qualunque punteggiatura.
 *
 * Niente dichiarato = niente da verificare. Per tutto il resto decide
 * `verifyTriageMarkerPersistence` leggendo le issue vere.
 */
export function triageMarkerPersistenceExpectation(markerBody) {
  const body = String(markerBody || '');
  const items = [...body.matchAll(/Follow-up\s+item\s*:\s*(FU-\d{4}-\d{2}-\d{2}-\d{3})\b/gi)]
    .map((match) => match[1].toUpperCase());
  // Il `#N` deve stare su una riga che parla di bucket: cosi' un `PR concatenata
  // #9050` citato fra i drop non diventa un candidato. Le righe di prosa che
  // citano un bucket storico restano invece ammesse come candidati, perche' la
  // verifica sotto e' ESISTENZIALE: un riferimento che non prova nulla non puo'
  // piu' far cadere un marker che ne porta un altro valido.
  const buckets = body.split(/\r?\n/)
    .filter((line) => /\bbucket\b/i.test(line))
    .flatMap((line) => [...line.matchAll(/#([1-9]\d*)\b/g)].map((match) => Number(match[1])));
  return {
    items: [...new Set(items)],
    buckets: [...new Set(buckets)],
    requiresBucket: items.length > 0 || buckets.length > 0,
  };
}

/**
 * Prove the deterministic mint gate preserved this PR's dropped item.
 *
 * The gate may remove every item sourced by a PR when none has a falsifiable
 * acceptance condition. It keeps the complete item in a comment on the source
 * PR, so the daily bucket no longer contains Sources: PR #N even though the
 * triage result is durable. The bucket number is part of that comment to keep
 * an old demotion from satisfying a newer marker.
 */
export function gatePreservedFollowupMatches(commentsJson, bucketNumber, prNumber) {
  let data;
  try {
    data = JSON.parse(commentsJson || '');
  } catch {
    return false;
  }
  const comments = Array.isArray(data)
    ? data
    : data && Array.isArray(data.comments) ? data.comments : [];
  const bucket = String(Number(bucketNumber));
  const pr = String(Number(prNumber));
  const bucketPattern = new RegExp('(?:^|\\n).*\\bIssue\\s+#' + bucket + '\\b', 'i');
  const sourcePattern = new RegExp('^\\s*-\\s+Sources?\\s*:[^\\n]*\\bPR\\s+#' + pr + '\\b', 'im');
  return comments.some((comment) => {
    const body = typeof comment?.body === 'string' ? comment.body : '';
    return body.includes('<!-- followup-mint-gate -->')
      && bucketPattern.test(body)
      && sourcePattern.test(body);
  });
}

/** Prove one persisted daily bucket contains a live item sourced by this PR. */
export function persistedBucketIssueMatches(issue, prNumber, prComments = '') {
  const info = dailyBucketInfo(issue?.title || '');
  const body = String(issue?.body || '');
  const pr = String(Number(prNumber));
  if (!info) return false;
  const directEvidence = /^###\s+FU-\d{4}-\d{2}-\d{2}-\d{3}\b/m.test(body)
    && new RegExp('^\\s*-\\s+Sources?\\s*:[^\\n]*\\bPR\\s+#' + pr + '\\b', 'im').test(body);
  return directEvidence || gatePreservedFollowupMatches(prComments, issue.number, prNumber);
}

/**
 * Read one candidate daily bucket from any repository that can hold it.
 *
 * Returns the issue, `false` when no repository has that number (a reference
 * that proves nothing, not a fault), or `null` when a read was unavailable.
 */
export function readBucketIssue(bucket, run = gh, repos = BUCKET_REPOS) {
  let unreadable = false;
  for (const repo of repos) {
    const raw = run(
      ['issue', 'view', String(bucket), '--repo', repo, '--json', 'number,title,body'],
      bucketRepoToken(repo),
      true,
    );
    if (raw === null) { unreadable = true; continue; }
    try {
      const issue = JSON.parse(raw);
      // I due repository numerano le proprie issue in modo INDIPENDENTE, quindi
      // lo stesso numero puo' esistere in entrambi: fermarsi al primo JSON
      // valido restituirebbe una issue omonima e qualunque scorrere del
      // contatore la renderebbe la risposta sbagliata a un bucket reale.
      // Oggi il corpus e' a #1594 e il sito a #9217 — i bucket del sito citati
      // dai marker del corpus (#8944, #9102, #9182) sono ancora fuori portata,
      // ma la collisione ha una data d'arrivo, non una probabilita'. Il filtro
      // e' il titolo canonico del bucket giornaliero, lo stesso oracolo che
      // `persistedBucketIssueMatches` applica subito dopo.
      if (issue && typeof issue === 'object' && !Array.isArray(issue)
        && dailyBucketInfo(issue.title || '')) return issue;
    } catch { /* not this repository's issue */ }
  }
  return unreadable ? null : false;
}

/**
 * Check marker idempotency against durable bucket/item evidence.
 *
 * `readIssue` returns an issue object, `false` for a bucket that is not in any
 * reachable repository, and `null` for an unavailable read. Unknown stays
 * `null`, so a transient API failure keeps the PR in the next batch instead of
 * skipping it forever.
 *
 * La verifica e' ESISTENZIALE: basta UN riferimento provato. Prima era
 * universale, e con un parser che non sa distinguere il bucket del giorno da
 * uno citato per contesto l'universale trasforma ogni riga di prosa in un modo
 * di far cadere un marker giusto. Il verso sicuro e' l'opposto: un marker senza
 * NESSUNA prova durevole resta non provato e la PR torna nel batch.
 */
export function verifyTriageMarkerPersistence(markerBody, prNumber, readIssue, prComments = '') {
  const expectation = triageMarkerPersistenceExpectation(markerBody);
  if (!expectation.requiresBucket) return true;
  if (!expectation.buckets.length || typeof readIssue !== 'function') return false;
  let unreadable = false;
  for (const number of expectation.buckets) {
    const issue = readIssue(number);
    if (issue === null || issue === undefined) { unreadable = true; continue; }
    if (issue === false) continue;
    if (Number(issue.number) === number
      && persistedBucketIssueMatches(issue, prNumber, prComments)) return true;
  }
  // Nessuna prova trovata: `null` solo se una lettura era indisponibile, cosi'
  // un guasto API non viene mai letto come «il triage non e' persistito».
  return unreadable ? null : false;
}

/**
 * Turni Claude proporzionati al batch: min(26 + 8*n, 80), floor 26 (mai abbassare).
 * Era min(20+6n,60) — bump fleet-wide 2026-07-17 (owner) di tutti i cap max-turns
 * Claude dopo l'ennesimo error_max_turns (cap = anti-runaway, non budget di lavoro).
 */
export function maxTurnsFor(batchCount) {
  return Math.min(26 + 8 * Math.max(0, Number(batchCount) || 0), 240);
}

/**
 * Ordina i candidati dal più VECCHIO. È la metà che rende vero il "rinvio":
 * il cap taglia la CODA della lista, quindi con l'ordine naturale della Search
 * API (dal più recente) le PR vecchie sarebbero sempre quelle tagliate, a ogni
 * giro, e non verrebbero mai lavorate finché non escono dalla finestra. Dal più
 * vecchio, ogni run drena dalla testa e il residuo scala davvero.
 */
export function orderCandidatesFifo(candidates) {
  if (!Array.isArray(candidates)) return [];
  return candidates
    .slice()
    .sort((a, b) => {
      const ta = Date.parse(a?.mergedAt ?? '');
      const tb = Date.parse(b?.mergedAt ?? '');
      // Una data illeggibile non deve riordinare il resto: resta dov'è.
      if (Number.isNaN(ta) || Number.isNaN(tb)) return 0;
      return ta - tb;
    });
}

/** Select one bounded provider session; il residuo è rinviato, non perso. */
export function selectFollowupSessionBatch(batch) {
  return Array.isArray(batch) ? batch.slice(0, FOLLOWUP_SESSION_BATCH_LIMIT) : [];
}

/**
 * Quante PR il cap ha rinviato. È un CONTEGGIO dichiarato, non un verdetto: il
 * gate finale non ci si appoggia (non si appoggia un gate a un numero prodotto
 * da chi viene giudicato), lo usano solo il summary e la telemetria di capacità.
 */
export function deferredCount(batch, sessionBatch) {
  if (!Array.isArray(batch) || !Array.isArray(sessionBatch)) return 0;
  return Math.max(0, batch.length - sessionBatch.length);
}

/**
 * The bucket key belongs to the triage run, not to an individual merge event. An
 * explicit value is accepted for workflow retries/tests, while the default is the
 * current successful triage day in Europe/Zurich.
 */
export function triageDailyKey(nowMs = Date.now()) {
  return process.env.TRIAGE_DAILY_KEY || dailyKeyZurich(nowMs);
}

/**
 * Keep ordinary follow-up fixes out of the batch, but let a marker-complete daily
 * partial fix reach the parent-bucket triage path. Unknown gate results stay fail-open.
 */
export function shouldTriageAfterFixGate({ isFollowupFix, followupPartial } = {}) {
  return isFollowupFix !== true || followupPartial === true;
}

/**
 * A marker-complete daily partial fix must still reach Claude even when the
 * source PR has no ordinary `## Non implementato`/reviewer candidate. Its
 * purpose is to inspect the fix PR for genuinely new findings and append them
 * to the parent bucket; the no-op gate cannot see that parent-bucket contract.
 */
export function shouldTriageAfterCandidateGate({ hasCandidates, followupPartial } = {}) {
  return hasCandidates !== false || followupPartial === true;
}

// ── I/O helpers ─────────────────────────────────────────────────────

// Gate failures are configuration faults, not inconclusive verdicts. Keep the
// proceed-safe batch behavior while surfacing missing/unloadable gates loudly.
// A sparse/partial checkout is different: when none of the known gate siblings
// is materialized, the missing files cannot prove a broken configuration.
const gateFaults = new Map();
const gateWindowStats = new Map();
const MODULE_LOAD_ERROR =
  /ERR_MODULE_NOT_FOUND|ERR_UNSUPPORTED_DIR_IMPORT|ERR_UNKNOWN_FILE_EXTENSION|ERR_REQUIRE_ESM|Cannot find (?:module|package)|does not provide an export named/;
const LOAD_TIME_SYNTAX_ERROR =
  /\bat (?:compileSourceTextModule|ModuleLoader\.(?:moduleStrategy|loadAndTranslate)|internalCompileFunction)\b/;
const LOAD_TIME_MODULE_CONTEXT =
  /Require stack:|imported from\b|The requested module\b|(?:Error|[A-Z][A-Za-z]*Error) \[ERR_(?:MODULE_NOT_FOUND|UNSUPPORTED_DIR_IMPORT|UNKNOWN_FILE_EXTENSION|REQUIRE_ESM)\]/;
const LOAD_TIME_INSTANTIATE_FRAME =
  /\bat (?:#asyncInstantiate|ModuleJob\._instantiate)\b/;
const GATE_VERDICT =
  /(?:^|\n)(?:is_followup_fix|followup_partial|has_candidates)=(?:true|false)(?:\n|$)/;
const ERROR_DETAIL_LINE =
  /^\s*(?:Uncaught\s+)?(?:[A-Za-z_$][\w$]*\.)?(?:Error|[A-Z][A-Za-z]*Error)(?:\s+\[[^\]]+\])?:\s*/;

function firstNonEmptyLine(text) {
  return String(text || '').split('\n').find((line) => line.trim()) || '';
}

function firstMatchingLine(text, predicate) {
  return String(text || '').split('\n').find((line) => predicate(line)) || '';
}

function firstErrorLineBeforeNodeFrame(text) {
  const lines = String(text || '').split('\n');
  const firstFrame = lines.findIndex((line) => /^\s*at\s+/.test(line));
  const prelude = firstFrame >= 0 ? lines.slice(0, firstFrame) : lines;
  return prelude.find((line) => ERROR_DETAIL_LINE.test(line)) || '';
}

function isModuleLoadError(stderr, gatePath) {
  const text = String(stderr || '');
  if (!text || !MODULE_LOAD_ERROR.test(text)) return false;
  const gateName = path.basename(gatePath);
  const namesGate = text.includes(gatePath) || text.includes(gateName);
  // This predicate deliberately receives stderr only. A runtime Error.message
  // can repeat a module-looking phrase, but Node's load diagnostics carry an
  // explicit module context (or the compile-time stack for a syntax failure).
  return namesGate && (
    LOAD_TIME_SYNTAX_ERROR.test(text) ||
    /Require stack:|imported from\b/.test(text) ||
    (LOAD_TIME_MODULE_CONTEXT.test(text) && LOAD_TIME_INSTANTIATE_FRAME.test(text))
  );
}

function recordGateFault(gate, kind, detail) {
  const key = `${gate}|${kind}`;
  const existing = gateFaults.get(key);
  if (existing) {
    existing.count += 1;
    return;
  }
  gateFaults.set(key, { gate, kind, detail, count: 1 });
  console.log(
    `::error title=Gate del follow-up ${kind}::${gate} — ${detail}. ` +
    'Il gate non ha consegnato un verdetto: il triage procede senza di lui (proceed-safe), ma questo è un guasto di configurazione.',
  );
}

function gateDirectoryIsMaterialized() {
  return GATE_DIRECTORY_SENTINELS.some((name) => fs.existsSync(path.join(HERE, name)));
}

function reportGateFaults() {
  if (!gateFaults.size) return;
  const rows = [...gateFaults.values()].map(
    (fault) => `- \`${fault.gate}\` — **${fault.kind}** — ${fault.detail} (su ${fault.count} PR)`,
  );
  console.log(`Gate NON eseguiti in questa run: ${gateFaults.size}.`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      '## ⚠️ Gate del follow-up NON eseguiti\n\n' +
      rows.join('\n') + '\n\n' +
      'Questi gate non hanno girato: il batch resta proceed-safe, ma la configurazione va riparata.\n',
    );
  }
  const missing = [...gateFaults.values()].some((fault) => fault.kind === 'assente');
  if (missing) {
    console.log('::error title=Gate del follow-up assente::un gate invocato non esiste: watermark invariato.');
    process.exitCode = 1;
  }
}

function recordGateWindowResult(gate, reason) {
  const stats = gateWindowStats.get(gate) || { total: 0, inconclusive: 0 };
  stats.total += 1;
  if (reason === 'inconclusive') stats.inconclusive += 1;
  gateWindowStats.set(gate, stats);
}

function reportGateWindowInconclusive() {
  const alarms = [...gateWindowStats.entries()]
    .filter(([, stats]) => stats.total >= 1 && stats.inconclusive === stats.total);
  if (!alarms.length) return;

  const rows = alarms.map(([gate, stats]) =>
    `- \`${gate}\` — inconclusive su ${stats.total}/${stats.total} PR della finestra`);
  console.log(
    `::warning title=Gate del follow-up sempre inconclusive::${alarms
      .map(([gate]) => gate).join(', ')} non ha prodotto un verdetto in tutta la finestra.`,
  );
  console.log(
    `Gate sempre inconclusive in questa run: ${alarms.map(([gate]) => gate).join(', ')}.`,
  );
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      '## ⚠️ Gate del follow-up inconclusive per tutta la finestra\n\n' +
      rows.join('\n') + '\n\n' +
      'Il batch resta proceed-safe, ma il gate va riparato o la finestra continuerà a passare senza soppressioni.\n',
    );
  }
}

/**
 * Invoke an existing per-PR gate script as a subprocess. GITHUB_OUTPUT/STEP_SUMMARY
 * are blanked for the child so it only prints to stdout (no pollution of OUR outputs).
 * @returns {{output:string|null, reason:null|'gate-missing'|'gate-error'}}
 */
function runGateOutput(scriptName, prNumber) {
  const gatePath = path.join(HERE, scriptName);
  if (!fs.existsSync(gatePath)) {
    const kind = gateDirectoryIsMaterialized() ? 'assente' : 'non materializzata';
    recordGateFault(scriptName, kind, `nessun file in ${gatePath}`);
    return { output: null, reason: 'gate-missing' };
  }
  try {
    return {
      output: execFileSync('node', [gatePath], {
        encoding: 'utf-8',
        maxBuffer: 32 * 1024 * 1024,
        env: { ...process.env, PR_NUMBER: String(prNumber), GITHUB_OUTPUT: '', GITHUB_STEP_SUMMARY: '' },
      }),
      reason: null,
    };
  } catch (error) {
    // A gate can publish its verdict and then fail while flushing an output or
    // during cleanup. Preserve that real verdict before classifying the exit.
    const stdout = String(error?.stdout || '');
    if (GATE_VERDICT.test(stdout)) return { output: stdout, reason: null };

    const stderr = String(error?.stderr || '');
    // On some Node versions execFileSync puts the captured diagnostic only in
    // error.message. Search both surfaces for the detail, but classify module
    // loading from stderr alone: a runtime SyntaxError/message must not become
    // a false MODULE_LOAD_ERROR.
    const diagnostic = [stderr, String(error?.message || '')].filter(Boolean).join('\n');
    if (isModuleLoadError(stderr, gatePath)) {
      const line = (
        firstErrorLineBeforeNodeFrame(diagnostic) ||
        firstMatchingLine(stderr, (candidate) => MODULE_LOAD_ERROR.test(candidate)) ||
        firstNonEmptyLine(stderr || diagnostic)
      );
      recordGateFault(scriptName, 'non caricabile', line.trim().slice(0, 200));
    } else {
      const detail = (
        firstErrorLineBeforeNodeFrame(diagnostic) ||
        firstNonEmptyLine(stderr) ||
        firstNonEmptyLine(String(error?.message || '')) ||
        error?.message ||
        `uscita non-zero (${error?.status ?? error?.code ?? 'sconosciuta'})`
      ).trim().slice(0, 200);
      recordGateFault(scriptName, 'non eseguibile', detail);
    }
    return { output: null, reason: 'gate-error' };
  }
}

function gateBoolean(output, outputKey) {
  if (output === null) return null;
  const m = new RegExp(`(?:^|\\n)${outputKey}=(true|false)(?:\\n|$)`).exec(output);
  return m ? m[1] === 'true' : null;
}

function runGate(scriptName, prNumber, outputKey) {
  const result = runGateOutput(scriptName, prNumber);
  const verdict = result.reason ? null : gateBoolean(result.output, outputKey);
  const reason = result.reason || (verdict === null ? 'inconclusive' : null);
  recordGateWindowResult(scriptName, reason);
  return { verdict, reason, output: result.output };
}

function logGateNoVerdict(label, result, prNumber) {
  if (result.verdict !== null) return;
  if (result.reason === 'inconclusive') {
    console.log(`PR #${prNumber}: ${label} gate inconclusive — PROCEED-SAFE (keep).`);
  } else if (result.reason === 'gate-missing') {
    console.log(`PR #${prNumber}: ${label} gate MISSING — PROCEED-SAFE (keep); la configurazione è già stata segnalata.`);
  } else {
    console.log(`PR #${prNumber}: ${label} gate non eseguibile — PROCEED-SAFE (keep); il guasto è già stato segnalato.`);
  }
}

function emit(batch, dailyKey = triageDailyKey(), { collectionOk = true, deferred = 0 } = {}) {
  reportGateFaults();
  reportGateWindowInconclusive();
  const csv = batch.join(',');
  const count = batch.length;
  const ok = collectionOk === true;
  const deferredN = Math.max(0, Number(deferred) || 0);
  const maxTurns = maxTurnsFor(count);
  console.log(`collection_ok=${ok}`);
  console.log(`batch_count=${count}`);
  console.log(`batch_prs=${csv}`);
  console.log(`deferred_count=${deferredN}`);
  console.log(`max_turns=${maxTurns}`);
  console.log(`daily_key=${dailyKey}`);
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(
      process.env.GITHUB_OUTPUT,
      `collection_ok=${ok}\nbatch_prs=${csv}\nbatch_count=${count}\n`
      + `deferred_count=${deferredN}\nmax_turns=${maxTurns}\ndaily_key=${dailyKey}\n`,
    );
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `## Follow-up batch collected: ${count} PR\nDaily key: ${dailyKey} (Europe/Zurich).\n` +
      (count ? `PR: ${csv} — max-turns ${maxTurns}.\n` : `Nessuna PR da triagiare in questa finestra.\n`) +
      (deferredN
        ? `Rinviate al prossimo giro: ${deferredN} PR (cap di sessione ${FOLLOWUP_SESSION_BATCH_LIMIT}).\n`
        : ''),
    );
  }
}

export function main() {
  const dailyKey = triageDailyKey();
  if (!REPO) throw new Error('GH_REPO/GITHUB_REPOSITORY mancante: raccolta non verificabile');
  console.log(`Daily key (successful triage day, Europe/Zurich): ${dailyKey}`);
  // 1. Finestra di raccolta = lookback FISSO di `MAX_WINDOW_HOURS`, non piu' il
  // confine della storia delle run.
  const watermark = collectionWindowStartISO();
  console.log(`Collection window start (lookback fisso di ${MAX_WINDOW_HOURS}h, indipendente dall'esito delle run): ${watermark}`);

  // 2. Merged PRs nella finestra, solo autori eleggibili.
  // Search API pagination has an explicit total_count, unlike `gh pr list --limit`
  // which silently truncated the batch at 100 results and advanced the watermark.
  const query = `repo:${REPO} is:pr is:merged merged:>=${watermark}`;
  const prListRaw = gh([
    'api', `search/issues?q=${encodeURIComponent(query)}&per_page=${SEARCH_PAGE_SIZE}`,
    '--paginate', '--slurp',
  ]);
  if (prListRaw === null) throw new Error('gh api search PR non riuscita: elenco incompleto');
  const mergedPages = parseMergedPRPages(prListRaw);
  if (!mergedPages) throw new Error('risposta paginata PR incompleta/non verificabile');
  const candidates = orderCandidatesFifo(parseMergedPRs(JSON.stringify(mergedPages)));
  console.log(`Merged PRs nella finestra (autori eleggibili, dal piu' vecchio): ${candidates.length}`);

  const batch = [];
  for (const pr of candidates) {
    const n = pr.number;

    // Idempotency: already triaged?
    const commentsRaw = gh(['pr', 'view', String(n), ...repoArgs, '--json', 'comments']);
    if (commentsRaw === null) throw new Error(`commenti PR #${n} non leggibili: raccolta incompleta`);
    let commentsPayload;
    try { commentsPayload = JSON.parse(commentsRaw); } catch { commentsPayload = null; }
    if (!Array.isArray(commentsPayload)
        && !(commentsPayload && Array.isArray(commentsPayload.comments))) {
      throw new Error(`commenti PR #${n} non parsabili: raccolta incompleta`);
    }
    if (hasTriageComment(commentsRaw)) {
      const markerBody = latestTriageCommentBody(commentsRaw);
      const persistence = verifyTriageMarkerPersistence(markerBody, n, readBucketIssue, commentsRaw);
      if (persistence === true) {
        console.log(`PR #${n}: already has '${TRIAGE_COMMENT_PREFIX}' plus persisted bucket/item evidence → skip (idempotent).`);
        continue;
      }
      console.log(`PR #${n}: marker presente ma bucket/item non provato (${persistence === null ? 'lettura indisponibile' : 'evidenza assente/invalida'}) → resta nel batch per retry.`);
    }

    // Gate 1: grandchild-suppression. true → it's a follow-up fix → skip.
    const fixGate = runGate('is-followup-fix-pr.mjs', n, 'is_followup_fix');
    const isFix = fixGate.verdict;
    const isPartialDailyFix = gateBoolean(fixGate.output, 'followup_partial');
    if (!shouldTriageAfterFixGate({ isFollowupFix: isFix, followupPartial: isPartialDailyFix })) {
      console.log(`PR #${n}: follow-up FIX (grandchild-suppression) → skip.`);
      continue;
    }
    if (isFix === null) logGateNoVerdict('grandchild', fixGate, n);
    if (isFix === true && isPartialDailyFix === true) {
      console.log(`PR #${n}: partial daily follow-up FIX → keep for parent-bucket triage; no grandchild issue.`);
    }

    // Gate 2: no-op candidate pre-gate. false → nothing to triage → skip.
    const candidateGate = runGate('followup-has-candidates.mjs', n, 'has_candidates');
    const hasCand = candidateGate.verdict;
    if (!shouldTriageAfterCandidateGate({ hasCandidates: hasCand, followupPartial: isPartialDailyFix })) {
      console.log(`PR #${n}: no plausible candidate (no-op gate) → skip.`);
      continue;
    }
    if (hasCand === false && isPartialDailyFix === true) {
      console.log(`PR #${n}: partial daily follow-up FIX has no ordinary candidate → keep to inspect parent bucket for new findings.`);
    }
    if (hasCand === null) logGateNoVerdict('candidate', candidateGate, n);

    batch.push(n);
    console.log(`PR #${n}: passes both gates → added to batch.`);
  }

  const sessionBatch = selectFollowupSessionBatch(batch);
  const deferred = deferredCount(batch, sessionBatch);
  if (deferred) {
    // Arrivare qui significa che TUTTE le sorgenti sono state lette: il
    // troncamento è una decisione di capacità presa da noi, non un guasto.
    // Quindi `collection_ok` resta true e il watermark avanza sul lavoro
    // effettivamente consegnato; il residuo rientra nella finestra successiva.
    console.log(`Sessione limitata a ${sessionBatch.length} PR; ${deferred} PR rinviate alla prossima finestra. collection_ok resta true: il troncamento è un rinvio pianificato, non un errore di raccolta.`);
  }
  emit(sessionBatch, dailyKey, { collectionOk: true, deferred });
}

// CLI entrypoint only (importing for tests must not invoke gh). Proceed-safe: any
// An uncaught collection error emits an explicit failed output and exits nonzero;
// the workflow verifier then fails the job, so the success watermark cannot advance.
/**
 * `--verify-persistence <pr>...` — la STESSA verifica usata per l'idempotenza,
 * esposta allo step `Verify complete follow-up triage` del workflow.
 *
 * Lo step aveva una RISCRITTURA in bash dello stesso predicato. Le due copie
 * sono divergute in entrambi i versi contemporaneamente: la bash leggeva il
 * bucket cross-repo ma non conosceva la prova per gli item demoti dal gate,
 * il JS conosceva la prova ma leggeva solo `GH_REPO`. Risultato: nella run
 * 35430183038 ciascuna copia bocciava le PR che l'altra avrebbe promosso.
 * Un solo predicato, un solo chiamante: la divergenza non e' piu' esprimibile.
 */
function verifyPersistenceCli(prNumbers) {
  let incomplete = false;
  for (const raw of prNumbers) {
    const pr = Number(raw);
    if (!Number.isInteger(pr) || pr <= 0) {
      console.log(`triage incompleta: PR '${raw}' non numerica`);
      incomplete = true;
      continue;
    }
    const comments = gh(['pr', 'view', String(pr), ...repoArgs, '--json', 'comments']);
    if (comments === null || !hasTriageComment(comments)) {
      console.log(`triage incompleta: PR #${pr} senza marker di triage leggibile`);
      incomplete = true;
      continue;
    }
    const marker = latestTriageCommentBody(comments);
    const verdict = verifyTriageMarkerPersistence(marker, pr, readBucketIssue, comments);
    const expectation = triageMarkerPersistenceExpectation(marker);
    if (verdict === true) {
      console.log(`PR #${pr}: persistenza provata (item=${expectation.items.length}, bucket=[${expectation.buckets.join(',') || '-'}]).`);
      continue;
    }
    console.log(`triage incompleta: PR #${pr} ${verdict === null ? 'bucket non leggibile' : 'senza item/Source persistito'} (item=${expectation.items.length}, bucket=[${expectation.buckets.join(',') || '-'}]).`);
    incomplete = true;
  }
  return !incomplete;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === '--verify-persistence') {
    const prs = process.argv.slice(3).flatMap((arg) => arg.split(',')).map((s) => s.trim()).filter(Boolean);
    process.exitCode = verifyPersistenceCli(prs) ? 0 : 1;
  } else {
  try {
    main();
  } catch (e) {
    console.error(`collect-followup-batch: unexpected error (${e?.message || e}) — collection_ok=false, watermark invariato.`);
    try { emit([], triageDailyKey(), { collectionOk: false }); } catch (emitError) {
      console.error(`collect-followup-batch: impossibile scrivere gli output di errore (${emitError?.message || emitError}).`);
    }
    process.exitCode = 1;
  }
  }
}
