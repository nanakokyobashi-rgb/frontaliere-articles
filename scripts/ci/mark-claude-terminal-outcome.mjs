#!/usr/bin/env node
/**
 * mark-claude-terminal-outcome.mjs — telemetria granulare, zero-Claude, per le
 * run del fixer che muoiono PRIMA di poter postare il proprio verdetto.
 *
 * Sostituisce il blob node inline che stava in `issue-fix.yml` (step «Mark
 * error_max_turns»). Due motivi, entrambi vincolanti:
 *
 * 1. **Copriva un solo subtype.** Riconosceva `error_max_turns` e nient'altro.
 *    Misurato il 2026-08-05 su TUTTE le 61 run fallite della finestra 7gg
 *    2026-07-29 → 2026-08-05: `error_max_turns` = **0 occorrenze**, HTTP 429
 *    (quota) = **60**. Il caso davvero dominante non emetteva alcun marker
 *    granulare, quindi il backstop deterministico postava `no-pr-unspecified`,
 *    che `followup-drainer.mjs` scarta di proposito (BACKSTOP_MARKER) → outcome
 *    `null` → la issue veniva classificata «run morta, ri-tentabile» e
 *    ri-accodata tre volte contro la stessa quota esaurita, fino al park. Vedi
 *    `claude-rate-limit.mjs` per la catena assorbente completa.
 *
 * 2. **Duplicava il parsing dell'execution file** già necessario altrove
 *    (AGENTS.md #6: una logica duplicata letteralmente va estratta in un modulo
 *    condiviso, così il drift è impossibile by-construction). Ora il parsing e
 *    il riconoscimento del 429 vivono in `claude-rate-limit.mjs`.
 *
 * Precedenza: `max-turns` PRIMA di `rate-limited`. Sono mutuamente esclusivi nei
 * payload osservati, ma se mai coesistessero il budget di turni esaurito è il
 * verdetto più informativo (indica una issue too-large, che il drainer parka
 * subito con `needs-human`), mentre il 429 è una condizione ambientale
 * transitoria. Stessa precedenza che `pr-review-loop.yml` applica già nel suo
 * ramo bash.
 *
 * Nessun marker viene postato per gli altri failure (5xx transienti, crash
 * infra): restano senza verdetto e quindi legittimamente ri-tentabili dal
 * rescue del drainer. Nessuna falsa escalation.
 *
 * Env:
 *   GH_TOKEN     necessario per gh.
 *   GH_REPO      opzionale `owner/repo`.
 *   ISSUE        numero issue su cui postare.
 *   EXEC_FILE    path dell'execution file della claude-code-action.
 *   RUN_URL      opzionale, link alla run per il commento.
 *   WORKFLOW     opzionale, nome del workflow chiamante (default `issue-fix`).
 *   DRY_RUN      "1" → stampa e basta.
 *
 * Best-effort: non fa MAI fallire il job (exit 0 sempre).
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  detectClaudeRateLimit,
  formatRateLimitComment,
  parseExecutionMessages,
} from './claude-rate-limit.mjs';
// Il predicato «qual e' il verdetto vigente» e' quello del drainer, importato e non
// riscritto (AGENTS.md #6): last-wins su `createdAt`, fallback dei backstop esclusi.
// Un secondo lettore con regole proprie e' esattamente il drift che rende il dedup
// qui sotto incoerente con chi il verdetto lo legge davvero.
import { lastLabelEventAt, latestFixOutcomeEntryFromComments } from './followup-drainer.mjs';

const DRY_RUN = process.env.DRY_RUN === '1';
const ISSUE = process.env.ISSUE;
const EXEC_FILE = process.env.EXEC_FILE;
const RUN_URL = process.env.RUN_URL || '';
const WORKFLOW = process.env.WORKFLOW || 'issue-fix';

const repoArgs = process.env.GH_REPO ? ['--repo', process.env.GH_REPO] : [];

function gh(args) {
  try {
    return execFileSync('gh', args, { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    console.log(`gh fallita (non bloccante): ${e && e.message ? e.message : e}`);
    return '';
  }
}

/**
 * Il subtype del messaggio `result` più recente, o ''. Puro → testabile.
 * @param {string} raw
 */
export function resultSubtype(raw) {
  const msgs = parseExecutionMessages(raw);
  const r = [...msgs].reverse().find((m) => m && m.type === 'result');
  return String((r && r.subtype) || '');
}

// --- Lavoro recuperabile lasciato sul branch --------------------------------
// Il prompt di issue-fix.yml (passo 4, anti-100%-loss #4337) committa e pusha un
// checkpoint WIP su `fix/issue-<N>` appena la modifica è applicata, proprio perché una
// morte al cap dei turni non porti via il diff col container. Chi legge la telemetria a
// valle, però, cercava una sola prova di consegna — un marker `pr-created` — quindi un
// branch con commit veri e nessuna PR risultava identico a una run che non ha prodotto
// niente. Misurato sul corpus su 31 morti `max-turns`: consegnate 0, RECUPERABILI 11,
// vuote 20; due di quelle undici sono state riaperte a mano e mergiate (#5767 → PR #5774,
// corpus #166 → PR #293).
//
// Il posto giusto per rilevarlo è qui: siamo dentro il job che ha appena pushato il
// branch, l'informazione costa una chiamata sola e resta scritta accanto al marker anche
// se il branch verrà cancellato da un merge. `harvest-agent-lessons.mjs` legge questo
// stamp senza spendere API, e ricade su `compare` solo quando manca.

/**
 * Riga machine-readable da appendere al marker `max-turns`, o '' se non c'è lavoro da
 * recuperare. Pura → testabile.
 * @param {{branch?: string, aheadBy?: number}} work
 */
export function formatRecoverableBranchStamp(work) {
  const branch = String((work && work.branch) || '');
  const aheadBy = Number(work && work.aheadBy);
  if (!branch || !Number.isFinite(aheadBy) || aheadBy <= 0) return '';
  return `\n<!-- RECOVERABLE_BRANCH: ${branch} ahead=${aheadBy} -->\n` +
    `♻️ La run ha lasciato **${aheadBy} commit** su \`${branch}\`, avanti a \`main\`, senza aprire la PR ` +
    `(checkpoint WIP del passo 4). Non è una run a vuoto: il retry riprende da lì (resume-aware), ` +
    `oppure la PR si apre a mano da quel branch.`;
}

/**
 * Quanti commit ha `fix/issue-<N>` avanti a `main`, o null. Impura (gh) e FAIL-SAFE:
 * qualunque errore / branch assente → null, cioè il comportamento di prima.
 * @param {string|number} issue
 */
export function recoverableBranchWork(issue) {
  const branch = `fix/issue-${issue}`;
  const repo = process.env.GH_REPO ? process.env.GH_REPO : '{owner}/{repo}';
  const raw = gh(['api', `repos/${repo}/compare/main...${branch}`, '--jq', '.ahead_by']).trim();
  const aheadBy = Number(raw);
  return Number.isFinite(aheadBy) && aheadBy > 0 ? { branch, aheadBy } : null;
}

// --- Consegna avvenuta nonostante il cap dei turni --------------------------
// `error_max_turns` è il subtype della CLI, non l'esito del lavoro: la morte al
// cap arriva spessissimo DOPO `gh pr create`, perché la coda del flusso (gate
// sibling, riscrittura del body, watch della PR) è proprio dove i turni si
// esauriscono. Misurato sul sito il 2026-09-05, finestra 5 giorni: 124 issue
// distinte con marker `max-turns`, di cui **74 avevano una PR da
// `fix/issue-<N>` e tutte e 74 erano già MERGED**; 10 di quelle risultano
// comunque parcheggiate `needs-human`/`agent:decompose`.
//
// Il danno non è il marker sbagliato in sé, è dove finisce: `max-turns` sta in
// `PREPASS_VERDICT_BEATS_FAMILY` di `followup-drainer.mjs`, quindi al primo
// tentativo manda la issue in `fu-parked` + `needs-human` (stato assorbente) o
// nella coda di decomposizione — su una issue il cui fix è già in `main`.
//
// Il predicato è quello che lo step «Classify outcome» di `issue-fix.yml` usa
// già per decidere il colore del job («colore = work-done, non CLI exit»); qui
// arriva prima, così il verdetto letto dal drainer dice la stessa cosa del
// verdetto letto dall'umano che guarda il run.

/**
 * Numero della PR consegnata per la issue (`fix/issue-<N>`, stato OPEN o
 * MERGED), o null. Impura (gh) e FAIL-SAFE: qualunque errore → null, cioè il
 * comportamento di prima (marker `max-turns`).
 * @param {string|number} issue
 */
export function deliveredPrNumber(issue) {
  // `sort_by(.createdAt) | last`, non `.[0]`: su un branch `fix/issue-<N>` RIUSATO
  // dopo un merge — il caso normale su una issue ri-accodata — la lista contiene la
  // PR vecchia insieme alla nuova, in un ordine che `gh` non documenta. Il marker
  // resterebbe giusto, ma il numero che l'umano legge nel commento punterebbe al
  // lavoro sbagliato. La più recente è l'unica che questo run può aver consegnato.
  const raw = gh(['pr', 'list', '--head', `fix/issue-${issue}`, '--state', 'all', ...repoArgs,
    '--json', 'number,state,createdAt',
    '--jq', '[.[] | select(.state=="OPEN" or .state=="MERGED")] | sort_by(.createdAt) | last | .number // empty']).trim();
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// --- Idempotenza del commento di consegna -----------------------------------
// Il drainer ri-accoda la stessa issue fino a tre volte, e ogni run che rientra in
// questo ramo posterebbe un `pr-created` identico al precedente. Non sarebbe solo
// rumore: un commento di bot alza `updatedAt`, e su questo repo è proprio quello che
// affama le uscite della coda — il cooldown del parked-retry e l'age-out chiedono
// quiete, e le issue più sorvegliate non la raggiungono mai (misurato il 2026-08-24:
// 30 candidate nel pool, 2 oltre il cooldown). È la stessa ragione per cui
// `orphan-max-turns-work.mjs` ha `ORPHAN_NOTE_MARKER`.
//
// Il dedup è sul marker di QUESTO step, come `ORPHAN_NOTE_MARKER`, ma con DUE
// condizioni in più che `ORPHAN_NOTE_MARKER` non ha bisogno di avere. La nota orfana è
// un'annotazione informativa e ripeterla non aggiunge nulla; questa nota invece PORTA
// un `FIX_OUTCOME`, cioè il verdetto su cui il drainer instrada — sopprimerla non è
// «un commento in meno», è un verdetto in meno. Vale quindi solo se la nota già presente
// dice ESATTAMENTE quello che questa run direbbe (vedi `capHitNoteSupersedesThisRun`):
//
//  1. stessa PR. Su un branch `fix/issue-<N>` riusato — il caso che `deliveredPrNumber()`
//     assume come normale — la nota vecchia cita la PR della consegna PRECEDENTE, che
//     può essere stata chiusa senza merge: dedupare lì lascia in vigore un `pr-created`
//     che punta a lavoro mai atterrato, e l'umano legge il numero sbagliato.
//  2. stessa run. `isDeliveredThisRun` (`followup-drainer.mjs`) scopa il ramo DELIVERED
//     alla run corrente e pretende `outcomeAt >= promotedAt` (l'evento label `agent:fix`
//     che apre la run): una nota più vecchia della promozione NON è il verdetto di
//     questa run, e dedupare su di lei congela il timestamp alla prima consegna → la
//     issue ricade sul ramo a tentativo consumato benché consegnata di nuovo.
//
// Resta anche il vincolo del giro 1 — la nota dev'essere il VERDETTO VIGENTE, cioè
// nessun `FIX_OUTCOME` più recente l'ha scavalcata: un `max-turns` posteriore sta in
// `PREPASS_VERDICT_BEATS_FAMILY` e parcheggerebbe `needs-human` una issue consegnata.
// Le tre condizioni insieme lasciano al dedup ESATTAMENTE il caso per cui esiste: lo
// stesso step che rigira dentro la stessa promozione sulla stessa PR. Non è dedupata
// contro il `pr-created` che l'agente posta da sé, perché quel commento non dice «sono
// morto al cap dopo aver consegnato» — è proprio il dato che si perderebbe.
// Gli altri due rami NON sono dedupati, di proposito: il commento `rate-limited` È il
// beacon di quota, e `check-quota-backoff.mjs` cerca il più RECENTE per leggerne
// `QUOTA_RESETS_AT` — deduparlo lo congelerebbe su una finestra scaduta; il marker
// `max-turns` porta lo stamp del branch recuperabile, che cresce fra un tentativo e
// l'altro.

/**
 * Marker informativo del fenomeno «morte al cap DOPO la consegna». Non è un
 * `FIX_OUTCOME` — il verdetto resta `pr-created` — ma senza di lui il fenomeno
 * smette di essere contabile: prima del ramo di consegna queste run finivano nel
 * bucket `max-turns`, e chi ne misura la quota vedrebbe il calo per costruzione,
 * non perché il fenomeno sia cambiato.
 */
export const CAP_HIT_AFTER_DELIVERY_MARKER = '<!-- CAP_HIT_AFTER_DELIVERY -->';

/**
 * Stamp machine-readable della PR citata dalla nota, accanto al marker. Serve al dedup,
 * che deve poter distinguere «la nota di QUESTA consegna» da «la nota della consegna
 * precedente su un branch riusato» senza leggere la prosa del commento. Una nota vecchia
 * senza stamp rende `null` → il dedup non si applica → si posta (fail-safe benigno).
 */
const CAP_HIT_AFTER_DELIVERY_PR_RE = /<!--\s*CAP_HIT_AFTER_DELIVERY_PR:\s*(\d+)\s*-->/;

/** Numero di PR stampato nella nota, o null. Puro → testabile. @param {string} body */
export function capHitNotePrNumber(body) {
  const m = CAP_HIT_AFTER_DELIVERY_PR_RE.exec(String(body || ''));
  return m ? Number(m[1]) : null;
}

// La label che apre la run del fixer: stessa stringa che il drainer legge come
// `promotedAt` in `isDeliveredThisRun`. Literal locale come in `check-quota-backoff.mjs`
// — il drainer non la esporta e l'idioma del repo è già questo.
const LBL_FIX = 'agent:fix';

/**
 * Vero se la nota di questo step è già sulla issue. Pura → testabile.
 * @param {Array<string|{body?: string}>} comments corpi dei commenti, o oggetti `{body}`
 */
export function hasCapHitAfterDeliveryNote(comments) {
  return (comments || []).some((c) => (typeof c === 'string' ? c : String((c && c.body) || ''))
    .includes(CAP_HIT_AFTER_DELIVERY_MARKER));
}

/**
 * Vero se la nota già sulla issue dice esattamente quello che questa run direbbe —
 * stessa PR, emessa dentro questa promozione, e ancora il verdetto vigente — cioè
 * l'unico caso in cui ometterla non toglie niente a chi legge. Pura → testabile.
 *
 * Le tre condizioni, e cosa rompe ciascuna se manca (vedi il commento del blocco):
 *
 *  - **stessa PR** — su un branch riusato la nota vecchia cita la consegna precedente,
 *    che può essere stata chiusa senza merge: dedupare lì lascia in vigore un
 *    `pr-created` che punta a lavoro mai atterrato.
 *  - **dentro questa promozione** — `isDeliveredThisRun` pretende `outcomeAt >=
 *    promotedAt`; una nota anteriore all'ultimo evento label `agent:fix` non è il
 *    verdetto di questa run, e dedupare congela il timestamp alla prima consegna.
 *  - **verdetto vigente** — un `FIX_OUTCOME` più recente (tipicamente `max-turns`, da
 *    una run in cui `deliveredPrNumber()` è caduta sul fail-safe) l'ha scavalcata:
 *    `max-turns` sta in `PREPASS_VERDICT_BEATS_FAMILY` del drainer, quindi la issue
 *    verrebbe parcheggiata `needs-human` benché consegnata — la regressione silenziosa
 *    che questo ramo esiste per eliminare. Ripetere la nota è lì tutto il suo mestiere.
 *
 * Ogni dato mancante o illeggibile (nessuno stamp di PR, `createdAt` non parsabile,
 * timeline eventi assente) rende false: il dedup non si applica e si posta, che è il
 * comportamento pre-esistente e la direzione benigna del fallimento.
 *
 * @param {{comments?: Array<{body?: string, createdAt?: string, created_at?: string}>,
 *          events?: Array<object>, prNumber?: number|null}} args
 */
export function capHitNoteSupersedesThisRun({ comments, events, prNumber } = {}) {
  const pr = Number(prNumber);
  if (!Number.isFinite(pr) || pr <= 0) return false;
  const promotedAt = lastLabelEventAt(events || [], LBL_FIX);
  if (!Number.isFinite(promotedAt)) return false;
  const { at: latestAt } = latestFixOutcomeEntryFromComments(comments || []);
  if (latestAt === null) return false;
  let mineAt = -Infinity;
  for (const c of comments || []) {
    const body = String((c && c.body) || '');
    if (!body.includes(CAP_HIT_AFTER_DELIVERY_MARKER)) continue;
    if (capHitNotePrNumber(body) !== pr) continue;
    const at = Date.parse(c?.createdAt ?? c?.created_at);
    if (!Number.isNaN(at) && at > mineAt) mineAt = at;
  }
  return mineAt >= latestAt && mineAt >= promotedAt;
}

/**
 * Vero se la issue porta già la nota di questa consegna, dentro questa promozione e
 * ancora vigente. Impura (gh) e FAIL-SAFE: qualunque errore → false, cioè il
 * comportamento di prima (posta comunque).
 * @param {string|number} issue
 * @param {number} prNumber
 */
export function capHitNoteSupersedesThisRunOnIssue(issue, prNumber) {
  const raw = gh(['issue', 'view', String(issue), ...repoArgs, '--json', 'comments',
    '--jq', '[.comments[] | {body, createdAt}]']).trim();
  if (!raw) return false;
  const repo = process.env.GH_REPO ? process.env.GH_REPO : '{owner}/{repo}';
  const rawEvents = gh(['api', `repos/${repo}/issues/${issue}/events?per_page=100`, '--paginate']).trim();
  if (!rawEvents) return false;
  try {
    const comments = JSON.parse(raw);
    // Niente `--jq` sugli eventi: con `--paginate` gh fonde le pagine in UN array solo
    // finché l'output resta JSON, mentre un `--jq` per pagina lo spezza. Stessa lettura
    // di `fixPromotedAt` nel drainer, `per_page=100 --paginate` incluso: la promozione
    // più recente è in fondo a una timeline che supera facilmente le 30 voci.
    const events = JSON.parse(rawEvents);
    return Array.isArray(comments) && Array.isArray(events)
      && capHitNoteSupersedesThisRun({ comments, events, prNumber });
  } catch {
    return false;
  }
}

/**
 * Corpo del marker da postare quando la CLI è morta al cap DOPO aver
 * consegnato. Puro → testabile.
 * @param {number} prNumber
 */
export function formatDeliveredDespiteMaxTurnsComment(prNumber) {
  return '<!-- FIX_OUTCOME: pr-created -->\n' +
    `${CAP_HIT_AFTER_DELIVERY_MARKER}\n` +
    `<!-- CAP_HIT_AFTER_DELIVERY_PR: ${prNumber} -->\n` +
    `_La CLI è uscita \`error_max_turns\`, ma la PR #${prNumber} per questa issue esiste (open/merged): il lavoro è stato consegnato._\n` +
    '_Il verdetto segue il lavoro, non l\'exit della CLI — stessa regola dello step «Classify outcome» di `issue-fix.yml`. ' +
    'Senza questa riga il drainer leggerebbe `max-turns` e parcheggerebbe in `needs-human` una issue già risolta._';
}

function main() {
  if (!ISSUE) {
    console.log('ISSUE non impostata → niente telemetria da postare.');
    return;
  }
  if (!EXEC_FILE || !fs.existsSync(EXEC_FILE)) {
    console.log('Nessun execution file → skip (il backstop deterministico coprirà il caso).');
    return;
  }

  const raw = fs.readFileSync(EXEC_FILE, 'utf-8');
  const subtype = resultSubtype(raw);
  console.log(`claude result subtype: '${subtype || '<none>'}'`);

  // --- max-turns (precedenza, vedi docstring) --------------------------------
  if (subtype === 'error_max_turns') {
    const deliveredPr = deliveredPrNumber(ISSUE);
    if (deliveredPr) {
      console.log(`Terminal outcome: error_max_turns MA la PR #${deliveredPr} esiste (open/merged) → marker \`pr-created\`, non \`max-turns\`.`);
      if (capHitNoteSupersedesThisRunOnIssue(ISSUE, deliveredPr)) {
        console.log(`Nota già presente per la PR #${deliveredPr}, dentro questa promozione e ancora verdetto vigente → skip (dedup: un commento in più alza \`updatedAt\` e affama il cooldown del parked-retry).`);
        return;
      }
      if (DRY_RUN) return;
      gh(['issue', 'comment', ISSUE, ...repoArgs, '--body',
        formatDeliveredDespiteMaxTurnsComment(deliveredPr)]);
      return;
    }
    console.log('Terminal outcome: error_max_turns → marker granulare `max-turns`.');
    const work = recoverableBranchWork(ISSUE);
    if (work) console.log(`Lavoro recuperabile: ${work.branch} è ${work.aheadBy} commit avanti a main (PR mai aperta).`);
    if (DRY_RUN) return;
    // Marker SENZA la stringa BACKSTOP_MARKER ('post-step deterministico') così
    // `latestFixOutcomeFromComments` del drainer lo legge come verdetto vero.
    gh(['issue', 'comment', ISSUE, ...repoArgs, '--body',
      '<!-- FIX_OUTCOME: max-turns -->\n_Run terminata error_max_turns (turn budget esaurito) — telemetria granulare per il drainer._' +
      formatRecoverableBranchStamp(work)]);
    return;
  }

  // --- quota / 429 -----------------------------------------------------------
  const { rateLimited, resetsAt, rateLimitType } = detectClaudeRateLimit(raw);
  if (rateLimited) {
    console.log(`Terminal outcome: rate limit (429, type=${rateLimitType || '?'}, resetsAt=${resetsAt || '?'}) → marker granulare \`rate-limited\` + beacon di backoff.`);
    if (DRY_RUN) return;
    gh(['issue', 'comment', ISSUE, ...repoArgs, '--body',
      formatRateLimitComment({ resetsAt, rateLimitType, runUrl: RUN_URL, workflow: WORKFLOW })]);
    return;
  }

  console.log('Nessun terminal outcome noto (5xx transiente / crash infra) → nessun marker: la issue resta ri-tentabile dal rescue.');
}

// Best-effort assoluto: la telemetria non deve mai far fallire il job.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (e) {
    console.error('mark-claude-terminal-outcome error (non bloccante):', e && e.message ? e.message : e);
  }
  process.exit(0);
}
