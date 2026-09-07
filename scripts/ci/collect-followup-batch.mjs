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
 *  - **Watermark = ultima run di SUCCESSO** di questo workflow (non l'ultima run).
 *    Una run fallita NON avanza il watermark → la finestra viene ri-coperta dalla
 *    run schedulata successiva = nessuna perdita (at-least-once by-construction).
 *    Fallback se nessun successo storico: now − 6h (2× la cadenza cron = margine).
 *  - **Idempotenza:** scarta le PR che hanno GIÀ un commento
 *    `## Post-merge follow-up triage` (il marker che Claude posta su OGNI PR
 *    processata) → niente doppio-triage sulla finestra di overlap.
 *  - **Gate per-PR riusati BYTE-PER-BYTE:** ogni candidato passa per i due gate
 *    deterministici esistenti, invocati come subprocess (`is-followup-fix-pr.mjs`
 *    grandchild-suppression + `followup-has-candidates.mjs` no-op), così il risparmio
 *    dei gate è preservato anche nel modello batch. Tieni solo le PR che passano
 *    ENTRAMBI (mirror esatto dell'`if:` che il workflow aveva sullo step Claude).
 *  - **PROCEED-SAFE:** errore di query/parse su una singola PR (lista, commenti,
 *    gate inconcludente) → la PR viene INCLUSA nel batch (mai escludere per dubbio),
 *    con motivo loggato. Meglio una run Claude in più che perdere un follow-up.
 *
 * Output (GITHUB_OUTPUT): `batch_prs=<csv di numeri>`, `batch_count=<n>`,
 *   `max_turns=<n>` (min(26 + 8*batch_count, 240); MAI < 26 — AGENTS.md vieta di
 *   abbassare i turni di post-merge-followup, qui li alza in proporzione al batch).
 *
 * Uso:  node scripts/ci/collect-followup-batch.mjs
 * Env:  GH_REPO|GITHUB_REPOSITORY, GITHUB_OUTPUT/GITHUB_STEP_SUMMARY (opz),
 *       FALLBACK_HOURS (opz, default 6), PR_LIMIT (opz, default 100).
 *       Richiede `gh` in PATH.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const WORKFLOW = 'post-merge-followup.yml';
const TRIAGE_COMMENT_PREFIX = '## Post-merge follow-up triage';
const FALLBACK_HOURS = Number(process.env.FALLBACK_HOURS) || 6;
const PR_LIMIT = Number(process.env.PR_LIMIT) || 100;
const HERE = path.dirname(fileURLToPath(import.meta.url));

const repoArgs = (process.env.GH_REPO || process.env.GITHUB_REPOSITORY)
  ? ['--repo', process.env.GH_REPO || process.env.GITHUB_REPOSITORY]
  : [];

function gh(args) {
  try {
    return execFileSync('gh', args, { encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024 });
  } catch {
    return ''; // proceed-safe: any gh fault → caller treats as "can't confirm".
  }
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
 * ── ADATTAMENTO DICHIARATO (manifest: `collect-followup-batch`) ───────────
 *
 * Sul sito questa lista è una costante letterale con gli account DI QUEL repo.
 * Lasciata così qui filtrerebbe via ogni PR: gli autori del corpus sono altri
 * (`nanakokyobashi-rgb`, e `claude` / `github-actions` per le PR aperte dal
 * fixer e dal mirror dell'engine). Il risultato sarebbe un batch sempre vuoto —
 * il triage post-merge girerebbe ogni tre ore per non trovare mai nulla, senza
 * un errore che lo dica.
 *
 * L'override via env tiene il file valido su ENTRAMBI i lati: il sito non
 * imposta la variabile e ottiene esattamente il comportamento di prima.
 * I nomi vanno nella forma canonica (`canonicalLogin` toglie il prefisso
 * `app/` e il suffisso `[bot]`).
 */
const ELIGIBLE_AUTHORS = new Set(
  (process.env.FOLLOWUP_ELIGIBLE_AUTHORS || 'valerielinc-ops,frontaliere-automation')
    .split(',')
    .map((s) => canonicalLogin(s))
    .filter(Boolean),
);

/** Strip the `app/` prefix (gh GraphQL bot form) and `[bot]` suffix (REST form). */
export function canonicalLogin(login) {
  return String(login || '').trim().replace(/^app\//, '').replace(/\[bot\]$/, '');
}

/**
 * Watermark = start of the LAST SUCCESSFUL run of this workflow. A failed run does
 * NOT advance it → the window is re-covered next time (no follow-up lost). Prefers
 * `startedAt`, falls back to `createdAt`, then to now − FALLBACK_HOURS.
 * @param {string} runListJson  output of `gh run list ... --json createdAt,startedAt`
 * @param {number} [nowMs]
 * @param {number} [fallbackHours]
 * @returns {string} ISO8601
 */
export function computeWatermarkISO(runListJson, nowMs = Date.now(), fallbackHours = FALLBACK_HOURS) {
  let runs = [];
  try {
    runs = JSON.parse(runListJson || '[]');
  } catch {
    runs = [];
  }
  const r = Array.isArray(runs) && runs.length ? runs[0] : null;
  const ts = r && (r.startedAt || r.createdAt);
  if (ts && !Number.isNaN(Date.parse(ts))) return new Date(ts).toISOString();
  return new Date(nowMs - fallbackHours * 3600_000).toISOString();
}

/**
 * Parse `gh pr list --json number,title,author,mergedAt,headRefName` and keep only
 * eligible-author PRs. Proceed-safe: unparseable list → [] (the run logs it; the
 * next scheduled run re-covers the window since the watermark didn't advance).
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

/**
 * Turni Claude proporzionati al batch: min(26 + 8*n, 240), floor 26 (mai
 * abbassare). Era min(26+8n,80) — bump 2026-08-10 (issue #170): il tetto a 80
 * si attivava già a batch_count=7 (26+8*7=82>80), e da quel punto in poi
 * `--max-turns` restava fisso a 80 QUALUNQUE fosse n — mentre il lavoro reale
 * scala linearmente con n. La run 31380568598 (batch_count=11) ha consegnato
 * TUTTE le 11 PR triagiate con successo in 113 turni (misurato via
 * `CLAUDE_USAGE`), quasi esattamente i 114 previsti dalla formula non
 * troncata (26+8*11) — ma il tetto a 80 l'ha comunque marcata `error_max_turns`
 * / step failure, perché l'action confronta i turni REALI col cap configurato
 * a posteriori, non con la stima. Il tetto a 80 quindi si autosabotava proprio
 * sui batch grandi che il floor 26 dovrebbe coprire: dopo un backlog (quota
 * esaurita, bwrap rotto) il batch cresce oltre 7 PR ed entra sistematicamente
 * in questo fallimento, che a sua volta non avanza il watermark e fa
 * ricrescere il prossimo batch (misurato: 2→10→21→21→24→24→30 su run
 * consecutive tutte fallite per questa causa).
 * 240 mantiene comunque un margine ampio sotto il `timeout-minutes: 40` del
 * job: 240 turni ≈ 29 min al ritmo osservato (~7.35s/turno sulla run da 113
 * turni/830s), contro un budget di 2400s. Resta un tetto anti-runaway (non un
 * budget di lavoro), non "nessun limite": un batch anomalo (30+) può ancora
 * saturarlo, ma a quel punto il recupero via watermark+idempotenza (vedi i
 * commenti in `followup-marker-backstop.mjs`) è il comportamento corretto,
 * non un difetto da correggere qui.
 */
export function maxTurnsFor(batchCount) {
  return Math.min(26 + 8 * Math.max(0, Number(batchCount) || 0), 240);
}

// ── I/O helpers ─────────────────────────────────────────────────────

/**
 * Guasti di CONFIGURAZIONE raccolti da `runGate` durante la run: un gate che non
 * esiste, o che esiste ma non si carica. NON contiene gli inconclusive
 * legittimi, che restano silenziosi per costruzione.
 * Chiave: `<gate>|<kind>` — un gate rotto vale una riga sola, non una per PR.
 * @type {Map<string, {gate:string, kind:string, detail:string, count:number}>}
 */
const gateFaults = new Map();

/**
 * Firma di un fallimento di CARICAMENTO del modulo, letta su stderr del figlio.
 * Distingue «il gate non si carica» (guasto: import rotto, export inesistente,
 * sintassi invalida) da «il gate è crashato mentre girava» (incertezza: rientra
 * nel proceed-safe silenzioso).
 * ponytail: match testuale su stderr, non un codice d'uscita dedicato — Node non
 * ne espone uno che separi load-time da run-time. Se un giorno un errore di
 * caricamento sfuggisse alla lista, il caso degrada nel ramo inconclusive, cioè
 * nel comportamento di prima: mai peggio del precedente.
 */
const MODULE_LOAD_ERROR =
  /ERR_MODULE_NOT_FOUND|ERR_UNSUPPORTED_DIR_IMPORT|ERR_UNKNOWN_FILE_EXTENSION|ERR_REQUIRE_ESM|SyntaxError|Cannot find (?:module|package)|does not provide an export named/;

/**
 * Registra un guasto e lo URLA subito nel log come annotation GitHub Actions
 * (`::error::`), che compare nella pagina della run senza aprire i log. La
 * deduplica è sulla coppia gate+tipo: la prima occorrenza annota, le successive
 * incrementano solo il contatore che finisce nel run summary.
 */
function recordGateFault(gate, kind, detail) {
  const key = `${gate}|${kind}`;
  const seen = gateFaults.get(key);
  if (seen) {
    seen.count += 1;
    return;
  }
  gateFaults.set(key, { gate, kind, detail, count: 1 });
  console.log(
    `::error title=Gate del follow-up ${kind}::${gate} — ${detail}. ` +
    'Il gate NON ha girato: il triage procede senza di lui (proceed-safe), ' +
    'ma questo è un guasto di configurazione, non un caso incerto.',
  );
}

/**
 * Invoke an existing per-PR gate script as a subprocess and parse its
 * `key=value` stdout line. Reuses the gate logic byte-per-byte (no modification →
 * no risk to its tests / proceed-safe semantics). GITHUB_OUTPUT/STEP_SUMMARY are
 * blanked for the child so it only prints to stdout (no pollution of OUR outputs).
 *
 * ## Tre esiti, non due
 *
 * Il verso del proceed-safe non cambia: qualunque cosa vada storta, la funzione
 * restituisce `null` e il chiamante TIENE la PR. Perdere una follow-up di una PR
 * organica costa più che triagiarne una di troppo (FOLLOWUP.md). Quello che
 * cambia è il SILENZIO, che fino a oggi copriva tre condizioni opposte:
 *
 *  1. **gate assente** — nessun file al path risolto. Guasto di configurazione:
 *     il gate non è incerto, non esiste. Misurato il 2026-09-07: i due gate
 *     mancavano da sempre in questo repo, quindi «inconclusive» non era raro,
 *     era il 100% (46 PR su 46 in tre run, zero soppressioni in assoluto).
 *     → RUMOROSO.
 *  2. **gate presente ma non caricabile** — import che non risolve, export che
 *     non esiste, sintassi invalida. Stesso guasto, altra forma. → RUMOROSO.
 *  3. **gate girato e inconclusive** — ha risposto qualcosa che non si parsa, o
 *     è crashato a metà. Questa è incertezza vera, ed è il proceed-safe
 *     legittimo. → silenzioso, come prima.
 *
 * L'invariante di CI — «ogni gate invocato per nome esiste e si carica» — vive
 * altrove, in `generator/tests/rungate-targets-exist.test.mjs`, ed è statico.
 * Qui l'invariante è di RUNTIME: in produzione HERE può non essere il checkout
 * che la CI ha controllato. Sono due invarianti diversi, deliberatamente non
 * condivisi.
 *
 * @returns {boolean|null} parsed boolean, or null when inconclusive (proceed-safe).
 */
function runGate(scriptName, prNumber, outputKey) {
  const gatePath = path.join(HERE, scriptName);

  // Esito 1: il file non c'è. Controllato PRIMA dello spawn perché lanciamo
  // `node <path>`, non il file: l'assenza non arriva come ENOENT dello spawn ma
  // come uscita non-zero di node, indistinguibile da un crash del gate.
  if (!fs.existsSync(gatePath)) {
    recordGateFault(scriptName, 'assente', `nessun file in ${gatePath}`);
    return null;
  }

  try {
    const out = execFileSync('node', [gatePath], {
      encoding: 'utf-8',
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, PR_NUMBER: String(prNumber), GITHUB_OUTPUT: '', GITHUB_STEP_SUMMARY: '' },
    });
    const m = new RegExp(`${outputKey}=(true|false)`).exec(out);
    return m ? m[1] === 'true' : null; // esito 3: girato, output non parsabile.
  } catch (e) {
    const stderr = String(e?.stderr || '');
    // Esito 2: il modulo non si carica.
    if (MODULE_LOAD_ERROR.test(stderr)) {
      const line = stderr.split('\n').find((l) => MODULE_LOAD_ERROR.test(l)) || stderr;
      recordGateFault(scriptName, 'non caricabile', line.trim().slice(0, 200));
      return null;
    }
    return null; // esito 3: proceed-safe — gate crash → inconclusive → keep the PR.
  }
}

/**
 * Scrive i guasti raccolti nel `$GITHUB_STEP_SUMMARY`, cioè dove un umano che
 * apre la run li vede senza scorrere i log. Le annotation `::error::` le ha già
 * emesse `recordGateFault` al momento del guasto; qui si aggiunge il conteggio,
 * che è l'informazione che dice se il gate è saltato una volta o sempre.
 *
 * ## PORTA APERTA: «fatale» non è deciso qui
 *
 * Se il proprietario decide che un gate assente deve FERMARE il ciclo invece di
 * lasciarlo procedere urlando, la modifica è una riga in fondo a questa
 * funzione: `process.exitCode = 1;` (eventualmente solo per
 * `kind === 'assente'`). Non è stata presa perché il ciclo del corpus alimenta
 * la generazione degli articoli e fermarlo ha un costo di prodotto che non
 * spetta a questo script valutare. Nota che l'uscita non-zero renderebbe
 * fallita la run, quindi il watermark non avanzerebbe e la finestra sarebbe
 * ri-coperta dalla run successiva: nessuna follow-up persa, ma nessun triage
 * finché il guasto non è riparato.
 */
function reportGateFaults() {
  if (!gateFaults.size) return;
  const rows = [...gateFaults.values()].map(
    (f) => `- \`${f.gate}\` — **${f.kind}** — ${f.detail} (su ${f.count} PR)`,
  );
  console.log(`Gate NON eseguiti in questa run: ${gateFaults.size}.`);
  for (const r of rows) console.log(r);
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      '## ⚠️ Gate del follow-up NON eseguiti\n\n' +
      rows.join('\n') + '\n\n' +
      'Questi gate non hanno girato: e\' un guasto di configurazione, non un ' +
      'esito incerto. Il batch e\' stato costruito SENZA la loro soppressione, ' +
      'quindi puo\' contenere PR che avrebbero dovuto essere scartate.\n',
    );
  }
}

function emit(batch) {
  reportGateFaults();
  const csv = batch.join(',');
  const count = batch.length;
  const maxTurns = maxTurnsFor(count);
  console.log(`batch_count=${count}`);
  console.log(`batch_prs=${csv}`);
  console.log(`max_turns=${maxTurns}`);
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(
      process.env.GITHUB_OUTPUT,
      `batch_prs=${csv}\nbatch_count=${count}\nmax_turns=${maxTurns}\n`,
    );
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `## Follow-up batch collected: ${count} PR\n` +
      (count ? `PR: ${csv} — max-turns ${maxTurns}.\n` : `Nessuna PR da triagiare in questa finestra.\n`),
    );
  }
}

export function main() {
  // 1. Watermark = start of the last SUCCESSFUL run (failed run → re-covered later).
  const runListRaw = gh([
    'run', 'list', `--workflow=${WORKFLOW}`, '--status', 'success',
    '--json', 'createdAt,startedAt', '--limit', '1', ...repoArgs,
  ]);
  const watermark = computeWatermarkISO(runListRaw);
  console.log(`Watermark (last successful run start, fallback now-${FALLBACK_HOURS}h): ${watermark}`);

  // 2. Merged PRs since the watermark, eligible authors only.
  const prListRaw = gh([
    'pr', 'list', '--state', 'merged', '--search', `merged:>=${watermark}`,
    '--json', 'number,title,author,mergedAt,headRefName', '--limit', String(PR_LIMIT), ...repoArgs,
  ]);
  const candidates = parseMergedPRs(prListRaw);
  console.log(`Merged PRs since watermark (eligible authors): ${candidates.length}`);

  const batch = [];
  for (const pr of candidates) {
    const n = pr.number;

    // Idempotency: already triaged?
    const commentsRaw = gh(['pr', 'view', String(n), ...repoArgs, '--json', 'comments']);
    if (commentsRaw && hasTriageComment(commentsRaw)) {
      console.log(`PR #${n}: already has '${TRIAGE_COMMENT_PREFIX}' comment → skip (idempotent).`);
      continue;
    }
    if (!commentsRaw) {
      console.log(`PR #${n}: comments unreadable — PROCEED-SAFE (treat as not-yet-triaged).`);
    }

    // Gate 1: grandchild-suppression. true → it's a follow-up fix → skip.
    const isFix = runGate('is-followup-fix-pr.mjs', n, 'is_followup_fix');
    if (isFix === true) {
      console.log(`PR #${n}: follow-up FIX (grandchild-suppression) → skip.`);
      continue;
    }
    if (isFix === null) console.log(`PR #${n}: grandchild gate inconclusive — PROCEED-SAFE (keep).`);

    // Gate 2: no-op candidate pre-gate. false → nothing to triage → skip.
    const hasCand = runGate('followup-has-candidates.mjs', n, 'has_candidates');
    if (hasCand === false) {
      console.log(`PR #${n}: no plausible candidate (no-op gate) → skip.`);
      continue;
    }
    if (hasCand === null) console.log(`PR #${n}: candidate gate inconclusive — PROCEED-SAFE (keep).`);

    batch.push(n);
    console.log(`PR #${n}: passes both gates → added to batch.`);
  }

  emit(batch);
}

// CLI entrypoint only (importing for tests must not invoke gh). Proceed-safe: any
// uncaught error → emit an empty batch (no run; the watermark holds → next
// scheduled run re-covers the window, nothing lost).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (e) {
    console.log(`collect-followup-batch: unexpected error (${e?.message || e}) — emitting empty batch (window re-covered next run).`);
    emit([]);
  }
}
