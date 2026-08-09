/**
 * followup-marker-backstop.mjs — il marker di idempotenza del triage post-merge
 * non puo' dipendere dal fatto che un modello rispetti un OBBLIGATORIO scritto
 * nel prompt.
 *
 * ## Il difetto, misurato (2026-08-09)
 *
 * `post-merge-followup.yml` dichiara nel prompt, in grassetto e maiuscolo, che
 * Claude DEVE postare un commento `## Post-merge follow-up triage` su ogni PR
 * del batch, anche a zero candidate. Quel commento non e' decorativo: e' il
 * MARKER DI IDEMPOTENZA che `scripts/ci/collect-followup-batch.mjs` legge per
 * decidere quali PR triagiare —
 *
 *     if (commentsRaw && hasTriageComment(commentsRaw)) { … skip (idempotent) }
 *
 * — e nient'altro, in tutto il workflow, verificava che fosse stato scritto.
 * Dopo lo step Claude c'era solo `scripts/ci/claude-usage-summary.mjs`, che
 * conta token e non guarda l'esito.
 *
 * Misura sul repo: 19 run fra il 7 e il 9 agosto, 17 con `conclusion: success`;
 * su 18 PR mergiate esaminate una per una, ZERO portano il commento marker;
 * zero issue `follow-up` esistono. La run resta verde e non produce niente.
 *
 * ## La causa vera NON e' «il modello salta un obbligo»
 *
 * Scaricando i log delle run verdi, la sessione Claude risulta strutturalmente
 * incapace di parlare con GitHub: OGNI invocazione del tool Bash — anche `pwd`
 * e `echo` — muore all'inizializzazione del sandbox con
 *
 *     Exit code 1
 *     bwrap: Can't create file at /home/.mcp.json: Permission denied
 *
 * Sulla run 31307620545: 9 `tool_use` Bash, 9 `tool_result` con
 * `is_error: true`, ZERO riusciti. Il modello si e' comportato correttamente —
 * ha rifiutato di fabbricare un esito e ha scritto per esteso che la run andava
 * trattata come fallita, «so a retry doesn't get skipped by the idempotency
 * marker». Ma il messaggio finale ha `subtype: "success"` e `is_error: false`,
 * quindi la run esce VERDE.
 *
 * Questo cambia la forma della riparazione, ed e' il motivo per cui questo file
 * non e' il backstop ingenuo che sembrava servire. Un backstop che, trovando il
 * marker assente, lo scrivesse SEMPRE, avrebbe timbrato «zero outstanding
 * items» su ogni PR di ogni finestra rotta: da difetto visibile-se-lo-cerchi a
 * perdita silenziosa e IRREVERSIBILE, perche' il collector non ha modo di
 * distinguere un marker vero da uno fabbricato. Sarebbe stato un peggioramento.
 *
 * ## La regola: si scrive un marker solo se la sessione ha CONSEGNATO
 *
 * «Consegnato» non e' il colore dello step (verde anche quando Claude non ha
 * eseguito nulla). Sono tre segnali indipendenti in OR — stessa forma di
 * `detectClaudeRateLimit` in `scripts/ci/claude-rate-limit.mjs`, e per la stessa
 * ragione: un solo segnale e' fragile.
 *
 *   1. almeno un `tool_result` Bash NON in errore nell'execution file (la
 *      sessione ha eseguito almeno un comando: poteva chiamare `gh`);
 *   2. almeno una PR del batch porta GIA' il marker (ha parlato con GitHub, e
 *      allora sulle altre l'assenza e' un obbligo davvero saltato);
 *   3. esiste almeno una issue `follow-up(#<PR>)` per una PR del batch.
 *
 * Se nessuno regge, il marker NON viene scritto e lo step esce 1. Non e' una
 * scelta nuova: e' esattamente la logica che lo step «Skip on exhausted quota
 * (no false green — watermark must hold)» applica gia' in questo stesso
 * workflow. Il watermark di `scripts/ci/collect-followup-batch.mjs` avanza sulle
 * sole run di SUCCESSO, quindi uscire verdi qui farebbe scorrere la finestra e
 * perderebbe per sempre le PR non triagiate; fallire la lascia indietro e la
 * run successiva (<=3h) ri-copre tutto.
 *
 * ## Perche' i commenti si leggono con `gh pr view --json comments`
 *
 * E' la stessa chiamata del collector. Non e' pigrizia: il marker esiste solo in
 * funzione di chi lo legge, quindi backstop e collector devono vedere la stessa
 * lista. Se un giorno quella query smettesse di vedere un commento, e' meglio
 * che i due sbaglino insieme che non che divergano —
 * `generator/tests/followup-marker-backstop.test.mjs` lega le due funzioni su
 * una matrice di fixture proprio per questo.
 *
 * Modello imitato: il backstop deterministico `FIX_OUTCOME` di
 * `.github/workflows/issue-fix.yml`, che pure esiste perche' «prompt-emitted
 * markers are unreliable».
 *
 * Uso:  node scripts/ci/followup-marker-backstop.mjs
 * Env:  BATCH_PRS (csv, obbligatorio), GH_REPO|GITHUB_REPOSITORY, EXEC_FILE,
 *       CLAUDE_STEP_OUTCOME, RUN_URL, GITHUB_STEP_SUMMARY (opz),
 *       FOLLOWUP_BACKSTOP_DRY_RUN=true (opz: decide e stampa, non scrive nulla).
 *       Richiede `gh` in PATH.
 */
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseExecutionMessages } from './claude-rate-limit.mjs';

/**
 * Prefisso del marker. DEVE restare identico a `TRIAGE_COMMENT_PREFIX` di
 * `scripts/ci/collect-followup-batch.mjs`: il collector fa `startsWith` su
 * quello, quindi un prefisso diverso qui produrrebbe un commento che il
 * collector non riconosce — cioe' un backstop che crede di aver chiuso
 * l'idempotenza mentre non l'ha chiusa. Il test lo verifica importando la
 * costante dall'altro modulo invece di ricopiarla.
 */
export const MARKER_PREFIX = '## Post-merge follow-up triage';

/** Titolo canonico della issue aggregata (FOLLOWUP.md § Output). */
const ISSUE_TITLE_RE = /^follow-up\(#(\d+)\)/;

/**
 * Firma del sandbox che non parte. Deliberatamente STRETTA: `Permission denied`
 * da solo comparirebbe anche in un legittimo errore di `gh`, e classificare
 * quello come «sessione morta» renderebbe rosse run sane.
 */
const SANDBOX_BROKEN_RE = /\bbwrap\b|\/home\/\.mcp\.json/i;

// ── Helper puri (nessun I/O) → unit-testabili ───────────────────────

/**
 * CSV di numeri PR → array di interi. Totale: scarta i token non numerici
 * invece di lanciare (l'input arriva da un `workflow_dispatch` scritto a mano).
 * @param {string} csv
 * @returns {number[]}
 */
export function parseBatch(csv) {
  return String(csv || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^\d+$/.test(s))
    .map(Number);
}

/**
 * True se la PR porta gia' un commento che inizia col prefisso marker.
 * Semantica volutamente IDENTICA a `hasTriageComment` del collector, incluso il
 * `trimStart()` e il parse error → false.
 * @param {string} commentsJson  output di `gh pr view N --json comments`
 * @param {string} [prefix]
 * @returns {boolean}
 */
export function hasTriageMarker(commentsJson, prefix = MARKER_PREFIX) {
  let data;
  try {
    data = JSON.parse(commentsJson || '');
  } catch {
    return false;
  }
  const comments = Array.isArray(data) ? data : data && Array.isArray(data.comments) ? data.comments : [];
  return comments.some((c) => typeof c?.body === 'string' && c.body.trimStart().startsWith(prefix));
}

/** Testo di un `tool_result`, che puo' essere una stringa o blocchi tipizzati. */
function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((b) => (typeof b === 'string' ? b : b?.text || '')).join('\n');
  }
  return '';
}

/**
 * Legge l'execution file di claude-code-action e risponde a UNA domanda: la
 * sessione ha eseguito almeno un comando di shell riuscito? Se no, non puo'
 * aver chiamato `gh`, quindi l'assenza del marker non e' un obbligo saltato ma
 * una sessione che non ha consegnato.
 *
 * I `tool_result` non portano il nome del tool: si ricostruisce dalla mappa
 * `tool_use_id` → `name` dei messaggi assistant.
 *
 * @param {string} raw  contenuto dell'execution file (array JSON o ndjson)
 * @returns {{parsed:boolean, toolUses:number, bashUses:number, bashOk:number,
 *   bashErr:number, sandboxBroken:boolean, sandboxError:(string|null),
 *   shellCapable:boolean}}
 */
export function analyzeSession(raw) {
  const msgs = parseExecutionMessages(raw);
  const nameById = new Map();
  let toolUses = 0;
  let bashUses = 0;
  let bashOk = 0;
  let bashErr = 0;
  let sandboxError = null;

  for (const m of msgs) {
    const content = m?.message?.content ?? m?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type === 'tool_use') {
        toolUses += 1;
        const name = String(block.name || '');
        if (block.id) nameById.set(block.id, name);
        if (name === 'Bash') bashUses += 1;
      } else if (block?.type === 'tool_result') {
        const name = nameById.get(block.tool_use_id) || '';
        const isErr = block.is_error === true;
        if (name === 'Bash') {
          if (isErr) bashErr += 1;
          else bashOk += 1;
        }
        if (isErr && sandboxError === null) {
          const text = resultText(block.content);
          if (SANDBOX_BROKEN_RE.test(text)) sandboxError = text.replace(/\s+/g, ' ').trim().slice(0, 180);
        }
      }
    }
  }

  return {
    parsed: msgs.length > 0,
    toolUses,
    bashUses,
    bashOk,
    bashErr,
    // Ogni Bash tentato e' fallito → il guscio non parte.
    sandboxBroken: bashUses > 0 && bashOk === 0,
    sandboxError,
    shellCapable: bashOk > 0,
  };
}

/**
 * Numeri delle issue `follow-up(#<pr>)` gia' esistenti per una PR.
 * @param {string} issueListJson  output di `gh issue list --label follow-up --json number,title`
 * @param {number} pr
 * @returns {number[]}
 */
export function issuesForPr(issueListJson, pr) {
  let data;
  try {
    data = JSON.parse(issueListJson || '');
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  return data
    .filter((i) => {
      const m = ISSUE_TITLE_RE.exec(String(i?.title || '').trim());
      return m && Number(m[1]) === Number(pr);
    })
    .map((i) => Number(i.number))
    .filter((n) => Number.isFinite(n));
}

/**
 * Decisione per UNA PR. Nessun I/O: prende lo stato gia' misurato e restituisce
 * l'azione, il livello di annotazione e il testo.
 *
 * @param {{pr:number, markerPresent:(boolean|null), issueNumbers?:number[],
 *   delivered:boolean, runUrl?:string, prefix?:string}} state
 *   `markerPresent === null` = commenti illeggibili (query `gh` a vuoto).
 * @returns {{pr:number, action:'noop'|'post'|'abstain'|'unknown', level:'none'|'warning'|'error',
 *   code:string, message:string, body:(string|null)}}
 */
export function decide({ pr, markerPresent, issueNumbers = [], delivered, runUrl = '', prefix = MARKER_PREFIX }) {
  if (markerPresent === null || markerPresent === undefined) {
    return {
      pr,
      action: 'unknown',
      level: 'warning',
      code: 'comments-unreadable',
      message:
        `PR #${pr}: impossibile leggere i commenti (query gh a vuoto) — nessun marker scritto e nessun rosso. ` +
        `Lo stato reale e' ignoto: scrivere un marker su un dubbio e' l'unica mossa irreversibile qui.`,
      body: null,
    };
  }

  if (markerPresent === true) {
    return {
      pr,
      action: 'noop',
      level: 'none',
      code: 'marker-present',
      message: `PR #${pr}: marker gia' presente — il backstop non interviene.`,
      body: null,
    };
  }

  if (!delivered) {
    return {
      pr,
      action: 'abstain',
      level: 'error',
      code: 'undelivered-session',
      message:
        `PR #${pr}: marker assente E nessuna prova che la sessione Claude abbia parlato con GitHub ` +
        `(zero comandi di shell riusciti, zero marker sul batch, zero issue follow-up). ` +
        `NON scrivo il marker: sarebbe un falso "zero outstanding items" definitivo. ` +
        `La run fallisce apposta, cosi' il watermark non avanza e la finestra viene ri-coperta.`,
      body: null,
    };
  }

  if (issueNumbers.length > 0) {
    const list = issueNumbers.map((n) => `- #${n}`).join('\n');
    return {
      pr,
      action: 'post',
      level: 'warning',
      code: 'marker-missing-with-issues',
      message:
        `PR #${pr}: INCOERENZA — la sessione ha creato ${issueNumbers.length} issue follow-up ` +
        `(${issueNumbers.map((n) => `#${n}`).join(', ')}) ma non ha lasciato il commento marker. ` +
        `Il triage e' avvenuto: il backstop scrive il marker citando le issue, non un "zero outstanding items".`,
      body:
        `${prefix}: marker ricostruito dal backstop deterministico.\n` +
        `<!-- FOLLOWUP_MARKER: backstop-with-issues -->\n\n` +
        `La sessione di triage ha creato le issue qui sotto ma non ha lasciato il commento ` +
        `obbligatorio su questa PR. Il backstop lo scrive perche' l'idempotenza di ` +
        `\`collect-followup-batch.mjs\` regga: senza, la prossima run schedulata ri-triagerebbe ` +
        `questa PR e potrebbe duplicare le issue.\n\n` +
        `${list}\n\n` +
        (runUrl ? `Run: ${runUrl}\n` : ''),
    };
  }

  return {
    pr,
    action: 'post',
    level: 'warning',
    code: 'marker-missing',
    message:
      `PR #${pr}: la sessione Claude ha girato davvero ma ha saltato il commento marker ` +
      `dichiarato OBBLIGATORIO nel prompt. Il backstop lo scrive. ` +
      `Un obbligo saltato e' un segnale da vedere, non da nascondere.`,
    body:
      `${prefix}: zero outstanding items.\n` +
      `<!-- FOLLOWUP_MARKER: backstop -->\n\n` +
      `Marker scritto dal backstop deterministico di \`post-merge-followup.yml\`: la sessione di ` +
      `triage ha eseguito comandi con successo su questa run ma non ha lasciato il commento ` +
      `obbligatorio su questa PR. Il marker serve all'idempotenza di ` +
      `\`collect-followup-batch.mjs\`; senza, la finestra verrebbe ri-triagiata a ogni giro.\n\n` +
      (runUrl ? `Run: ${runUrl}\n` : ''),
  };
}

// ── I/O ─────────────────────────────────────────────────────────────

function realGh(args, opts = {}) {
  try {
    return execFileSync('gh', args, { encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024, ...opts });
  } catch {
    return ''; // il chiamante tratta la stringa vuota come «non confermabile».
  }
}

/**
 * Il corpo del backstop, con `gh` INIETTABILE: i test esercitano le stesse
 * diramazioni senza toccare la rete. `gh` riceve gli argv e ritorna stdout (o
 * stringa vuota in caso di guasto), come `realGh`.
 *
 * @param {{batch:number[], repo:string, execRaw?:string, stepOutcome?:string,
 *   runUrl?:string, gh?:Function, log?:Function, dryRun?:boolean}} o
 * @returns {{decisions:Array, posted:number[], session:object, delivered:boolean,
 *   deliveredBy:string[], exitCode:number}}
 */
export function runBackstop({
  batch,
  repo,
  execRaw = '',
  stepOutcome = '',
  runUrl = '',
  gh = realGh,
  log = console.log,
  dryRun = false,
}) {
  const repoArgs = repo ? ['--repo', repo] : [];
  const session = analyzeSession(execRaw);

  log(
    `[backstop] batch=${batch.join(',') || '(vuoto)'} claude_step=${stepOutcome || 'n/d'} ` +
    `exec_parsed=${session.parsed} tool_uses=${session.toolUses} bash=${session.bashUses} ` +
    `bash_ok=${session.bashOk} bash_err=${session.bashErr}`,
  );
  if (session.sandboxBroken) {
    log(
      `[backstop] ogni comando di shell della sessione e' fallito` +
      (session.sandboxError ? ` — firma: ${session.sandboxError}` : '') +
      `. La sessione non poteva chiamare gh.`,
    );
  }

  // Passata 1 — misura. Nessuna scrittura finche' non e' noto se la sessione
  // ha consegnato: la prova puo' arrivare da una PR diversa da quella in esame.
  const issueListRaw = gh([
    'issue', 'list', '--label', 'follow-up', '--state', 'all',
    '--json', 'number,title', '--limit', '100', ...repoArgs,
  ]);
  const observed = batch.map((pr) => {
    const commentsRaw = gh(['pr', 'view', String(pr), ...repoArgs, '--json', 'comments']);
    return {
      pr,
      markerPresent: commentsRaw ? hasTriageMarker(commentsRaw) : null,
      issueNumbers: issuesForPr(issueListRaw, pr),
    };
  });

  // La consegna la decide l'ESITO DELLO STEP, non un'euristica sui suoi
  // effetti collaterali. Il marker e' un'affermazione PER-PR («questa PR e'
  // stata triagiata»), ma i tre segnali che stavano qui erano misurati una
  // volta per SESSIONE e poi applicati a ogni PR del batch. Su una sessione
  // morta a meta' — `error_max_turns` su un batch grande, che e' la norma
  // (batch misurati: 64,63,61,60,59,57,56,55) — il backstop timbrava
  // «zero outstanding items» sulle PR che la sessione non aveva MAI
  // raggiunto, e il collector le salta per sempre. Cioe' proprio la perdita
  // irreversibile che questo file esiste per impedire.
  //
  // Peggio: il workflow DOCUMENTA quel recupero («error_max_turns → il
  // watermark non avanza → l'idempotenza salta le PR gia' commentate e
  // riprende le restanti»), e il backstop cancellava esattamente le
  // «restanti». Sui dati reali la sovrapposizione fra due run consecutive
  // mostra sette PR ri-coperte dopo un fallimento: con l'euristica attiva
  // sarebbero state marcate a vuoto.
  //
  // Gli altri due segnali erano anche piu' deboli: una issue `follow-up`
  // di QUALUNQUE epoca per una qualsiasi PR del batch ribaltava `delivered`
  // a true per tutto il batch — anche con execution file vuoto, cioe' con
  // Claude che non aveva girato affatto. Ed era innocuo solo finche' il repo
  // aveva zero issue `follow-up`: una guardia sicura soltanto finche' la fix
  // che deve proteggere non funziona.
  //
  // `CLAUDE_STEP_OUTCOME` era gia' cablato nel workflow, gia' letto qui, e
  // usato SOLO dentro una stringa di log. Era il segnale giusto, inerte.
  // Due condizioni, entrambe necessarie:
  //  - lo step Claude e' arrivato in fondo (`success`): senza, le PR non
  //    raggiunte NON vanno timbrate, o si cancella il recupero;
  //  - il sandbox funzionava: se `bwrap` e' rotto Claude non ha potuto
  //    parlare con GitHub affatto, e uno step `success` con zero comandi
  //    riusciti descrive una sessione che non ha fatto niente.
  const delivered = stepOutcome === 'success' && !session.sandboxBroken;
  const deliveredBy = [];
  if (session.shellCapable) deliveredBy.push(`${session.bashOk} comandi di shell riusciti`);
  if (observed.some((o) => o.markerPresent === true)) deliveredBy.push('marker gia\' presente su una PR del batch');
  if (observed.some((o) => o.issueNumbers.length > 0)) deliveredBy.push('issue follow-up esistenti per il batch');

  log(
    `[backstop] step Claude = ${stepOutcome || '(ignoto)'} -> sessione ` +
    `${delivered ? 'CONSEGNATA' : 'NON consegnata'}` +
    (deliveredBy.length ? ` [indizi collaterali, NON decisivi: ${deliveredBy.join('; ')}]` : ''),
  );
  if (!delivered) {
    log('[backstop] lo step non e\' riuscito: NON timbro nulla. Le PR non marcate ' +
        'restano nella finestra e la run successiva le riprende — e\' il recupero ' +
        'che il workflow documenta, e timbrarle qui lo cancellerebbe.');
  }

  // Passata 2 — decide e agisce.
  const decisions = [];
  const posted = [];
  const failedPosts = [];
  for (const o of observed) {
    const d = decide({ ...o, delivered, runUrl });
    decisions.push(d);
    if (d.level === 'error') console.log(`::error::followup-marker-backstop: ${d.message}`);
    else if (d.level === 'warning') console.log(`::warning::followup-marker-backstop: ${d.message}`);
    else log(`[backstop] ${d.message}`);

    if (d.action === 'post' && d.body) {
      if (dryRun) {
        log(`[backstop] DRY_RUN: non posto su #${o.pr}. Corpo:\n${d.body}`);
      } else {
        // Il ritorno va CONTROLLATO: `realGh` inghiotte l'errore e torna ''.
        // Contare un commento fallito come marker scritto lascia una PR con
        // issue e senza marker — cioe' esattamente lo stato che al giro dopo
        // faceva scattare il falso segnale «issue esistenti = consegnato».
        const out = gh(['pr', 'comment', String(o.pr), ...repoArgs, '--body-file', '-'], { input: d.body });
        if (out && String(out).trim()) {
          posted.push(o.pr);
        } else {
          failedPosts.push(o.pr);
          console.log(`::error::followup-marker-backstop: il commento su #${o.pr} NON e' atterrato ` +
                      '(gh ha fallito). Il marker non esiste: la PR resta da triagiare.');
        }
      }
    }
  }

  const abstained = decisions.filter((d) => d.action === 'abstain').map((d) => d.pr);
  return {
    decisions,
    posted,
    session,
    delivered,
    deliveredBy,
    exitCode: abstained.length > 0 ? 1 : 0,
  };
}

export function main() {
  const repo = process.env.GH_REPO || process.env.GITHUB_REPOSITORY || '';
  const batch = parseBatch(process.env.BATCH_PRS);
  const runUrl = process.env.RUN_URL || '';
  const stepOutcome = process.env.CLAUDE_STEP_OUTCOME || '';
  const dryRun = process.env.FOLLOWUP_BACKSTOP_DRY_RUN === 'true';

  if (batch.length === 0) {
    console.log('[backstop] BATCH_PRS vuoto — niente da verificare.');
    return 0;
  }

  let execRaw = '';
  const execFile = process.env.EXEC_FILE || '';
  try {
    if (execFile && fs.existsSync(execFile)) execRaw = fs.readFileSync(execFile, 'utf8');
  } catch (e) {
    console.log(`[backstop] execution file illeggibile (${String(e).slice(0, 120)}) — resta il segnale marker/issue.`);
  }

  const r = runBackstop({ batch, repo, execRaw, stepOutcome, runUrl, dryRun });

  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) {
    const rows = r.decisions.map((d) => `| #${d.pr} | \`${d.code}\` | ${d.action} |`).join('\n');
    try {
      fs.appendFileSync(
        summary,
        `### Follow-up marker backstop\n\n` +
        `Sessione ${r.delivered ? '**consegnata**' : '**NON consegnata**'}` +
        `${r.deliveredBy.length ? ` (${r.deliveredBy.join('; ')})` : ''}. ` +
        `Marker scritti dal backstop: ${r.posted.length ? r.posted.map((n) => `#${n}`).join(', ') : 'nessuno'}.\n\n` +
        `| PR | esito | azione |\n|---|---|---|\n${rows}\n\n`,
      );
    } catch { /* best effort */ }
  }

  return r.exitCode;
}

// Entrypoint CLI soltanto: importare il modulo dai test non deve invocare `gh`.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (e) {
    // Un guasto DI QUESTO script non deve inventare un marker ne' seppellire il
    // problema: rumore massimo, exit 1, watermark fermo.
    console.log(`::error::followup-marker-backstop: errore inatteso (${e?.message || e}) — nessun marker scritto.`);
    process.exitCode = 1;
  }
}
