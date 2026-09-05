#!/usr/bin/env node
/**
 * refund-fix-round.mjs — zero-Claude: restituisce il ROUND consumato da una run
 * dei fixer di PR in cui Claude non ha mai eseguito (HTTP 429, quota).
 *
 * ## Perché esiste (misurato 2026-09-05, run 33969361751)
 *
 * `pr-redcheck-fixer.yml` e `pr-redflag-fixer.yml` contano i round con un
 * marker nascosto sulla PR (`REDCHECK_FIX_ROUND` / `REDFLAG_FIX_ROUND`) e lo
 * postano **prima** di invocare Claude, di proposito: se la run muore, il round
 * è comunque contato e l'anti-loop tiene. È la scelta giusta per un crash — ma
 * non per un 429, dove Claude non è mai partito (`num_turns: 1`,
 * `total_cost_usd: 0`, l'agente non ha nemmeno letto la PR).
 *
 * Al cap (`MAX_ROUNDS=2`) i fixer mettono `needs-human` sulla PR, e su questo
 * repo `needs-human` è un filtro di ESCLUSIONE da ogni coda automatica (#733):
 * due 429 consecutivi bastavano quindi a togliere una PR dal ciclo autonomo
 * **per non essere mai stata guardata**. È la stessa catena assorbente
 * documentata in `claude-rate-limit.mjs` per le issue — dove è già chiusa da
 * `check-quota-backoff.mjs` + il marker `rate-limited` («la issue non consuma
 * un tentativo») — lasciata aperta sul lato PR, che di quel meccanismo non
 * aveva nulla.
 *
 * ## Cosa fa
 *
 * Legge l'execution file della `claude-code-action`; se e solo se descrive un
 * rate-limit (riconoscimento in `claude-rate-limit.mjs`, unica sorgente),
 * CANCELLA il commento del marker di round postato da questa run e lascia al
 * suo posto una spiegazione col beacon `QUOTA_RESETS_AT`. Il contatore torna
 * quindi al valore che aveva prima della run: il prossimo trigger reale riparte
 * con il budget intero.
 *
 * ## Il marker di round ha DUE lettori, non uno
 *
 * Oltre al contatore (`grep -oE '<MARKER>: [0-9]+'`), la PRESENZA di
 * `<!-- REDFLAG_FIX_ROUND:` sul thread e' il segnale su cui la classe B di
 * `stale-pr-rescuer.yml` decide il rerun di `tests` — cioe' l'unico modo in cui
 * il 🔴-fixer riparte senza un commit umano (la review vive dentro `tests.yml`
 * e un rerun ri-emette `pull_request_review`). Cancellare il marker rimborsa il
 * round ma disarmerebbe anche quel re-trigger: dopo un 429 la PR resterebbe
 * ferma con il budget intero e nessuno a spenderlo.
 *
 * Per questo il commento di rimborso porta un handle SEPARATO,
 * `<!-- <PREFIX>_FIX_REFUNDED: N -->` (`refundMarkerName`), che il rescuer
 * accetta accanto a quello di round: non fa match sul grep del contatore
 * (`_FIX_ROUND` != `_FIX_REFUNDED`), quindi ri-arma il re-trigger senza
 * ri-armare il round.
 *
 * Cancellare è l'operazione giusta e non una scorciatoia: il contatore È il
 * numero di marker presenti (`grep -oE '<MARKER>: [0-9]+' | sort -rn | head -1`),
 * quindi non esiste modo di "decrementarlo" se non togliendo il marker che non
 * andava scritto. Il round rimborsato resta comunque tracciato dal commento di
 * spiegazione, che non contiene il marker di round.
 *
 * Env:
 *   GH_TOKEN     necessario per gh.
 *   GH_REPO      opzionale `owner/repo`.
 *   PR           numero della PR.
 *   MARKER       nome del marker di round (es. `REDCHECK_FIX_ROUND`).
 *   ROUND        valore N postato da questa run.
 *   EXEC_FILE    path dell'execution file della claude-code-action.
 *   RUN_URL      opzionale, link alla run.
 *   WORKFLOW     opzionale, nome del workflow chiamante.
 *   DRY_RUN      "1" → stampa e basta.
 *
 * Best-effort: non fa MAI fallire il job (exit 0 sempre). Un rimborso mancato
 * riporta al comportamento di prima, che è il peggio possibile e non peggiora.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

import { detectClaudeRateLimit } from './claude-rate-limit.mjs';

const DRY_RUN = process.env.DRY_RUN === '1';
const PR = process.env.PR;
const MARKER = process.env.MARKER || '';
const ROUND = process.env.ROUND || '';
const EXEC_FILE = process.env.EXEC_FILE;
const RUN_URL = process.env.RUN_URL || '';
const WORKFLOW = process.env.WORKFLOW || 'pr-fixer';

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
 * Regex del marker di round, ancorata al commento HTML che i fixer postano.
 * Unica sorgente: la costruisce chi cancella e chi spiega. Puro.
 * @param {string} marker
 * @param {string|number} round
 */
export function roundMarkerRe(marker, round) {
  const esc = String(marker).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`<!--\\s*${esc}:\\s*${Number(round)}\\s*-->`);
}

/**
 * L'id del commento che porta il marker di QUESTO round, o null. Se per qualche
 * ragione ce ne fosse più d'uno, vince il più recente — è quello che questa run
 * ha appena scritto. Puro → testabile.
 * @param {Array<{id?: number, body?: string, user?: {login?: string}}>} comments
 * @param {string} marker
 * @param {string|number} round
 * @returns {number|null}
 */
export function pickRoundCommentId(comments, marker, round) {
  if (!marker || !Number.isFinite(Number(round)) || Number(round) <= 0) return null;
  const re = roundMarkerRe(marker, round);
  const hit = (Array.isArray(comments) ? comments : [])
    .filter((c) => c && Number.isFinite(Number(c.id)) && re.test(String(c.body || '')))
    .pop();
  return hit ? Number(hit.id) : null;
}

/**
 * Il nome dell'handle di re-trigger derivato dal marker di round. Unica
 * sorgente del nome (lo YAML del pre-flight e il rescuer lo ripetono in bash e
 * non possono importarlo: il legame è coperto da un test, AGENTS.md #6). Puro.
 * @param {string} marker
 * @returns {string}
 */
export function refundMarkerName(marker) {
  return String(marker || '').replace(/_ROUND$/, '') + '_REFUNDED';
}

/**
 * Il commento che sostituisce il marker rimborsato. Puro → testabile.
 * NB: NON contiene il marker di round (verrebbe ri-contato) e NON contiene un
 * `FIX_OUTCOME`, che è telemetria delle issue e qui confonderebbe il drainer.
 * Porta invece l'handle `<PREFIX>_FIX_REFUNDED`, che tiene armata la classe B
 * di `stale-pr-rescuer.yml` (l'unico re-trigger del fixer senza commit umano)
 * senza toccare il contatore. Il beacon `QUOTA_RESETS_AT` c'è per lo stesso
 * motivo: è il dato che rende la finestra osservabile a chi legge la PR.
 * @param {{ round: string|number, workflow: string, resetsAt: number|null,
 *           rateLimitType: string|null, runUrl: string, marker?: string }} o
 */
export function formatRefundComment({ round, workflow, resetsAt, rateLimitType, runUrl, marker }) {
  const when = Number.isFinite(Number(resetsAt)) && Number(resetsAt) > 0
    ? new Date(Number(resetsAt) * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
    : null;
  return [
    marker ? `<!-- ${refundMarkerName(marker)}: ${round} -->` : null,
    resetsAt ? `<!-- QUOTA_RESETS_AT: ${Math.round(Number(resetsAt))} -->` : null,
    `⏳ **Quota Claude esaurita${rateLimitType ? ` (\`${rateLimitType}\`)` : ''}** — \`${workflow}\` è uscito su HTTP 429:`,
    'Claude **non ha letto questa PR** e non ha speso token (0 turni, $0).',
    '',
    `Il round **${round}** è stato **rimborsato** (marker rimosso): non è stato consumato da questa run,`,
    'quindi il cap anti-loop non avvicina la PR a `needs-human` per un muro di quota.',
    when ? `La quota torna disponibile alle **${when}**.` : null,
    runUrl ? `\nRun: ${runUrl}` : null,
  ].filter((l) => l !== null).join('\n');
}

function main() {
  if (!PR || !MARKER || !ROUND) {
    console.log('PR/MARKER/ROUND non impostati → niente da rimborsare.');
    return;
  }
  if (!EXEC_FILE || !fs.existsSync(EXEC_FILE)) {
    console.log('Nessun execution file → impossibile distinguere un 429 da un crash: nessun rimborso.');
    return;
  }

  const { rateLimited, resetsAt, rateLimitType } = detectClaudeRateLimit(
    fs.readFileSync(EXEC_FILE, 'utf-8')
  );
  if (!rateLimited) {
    console.log('La run NON è morta di quota → il round resta consumato (anti-loop invariato).');
    return;
  }

  const repo = process.env.GH_REPO || '{owner}/{repo}';
  const raw = gh(['api', `repos/${repo}/issues/${PR}/comments`, '--paginate']);
  let comments = [];
  try {
    comments = JSON.parse(raw || '[]');
  } catch {
    comments = [];
  }
  const id = pickRoundCommentId(comments, MARKER, ROUND);
  if (!id) {
    console.log(`Marker \`${MARKER}: ${ROUND}\` non trovato sulla PR #${PR} → niente da cancellare.`);
    return;
  }

  const body = formatRefundComment({
    round: ROUND, workflow: WORKFLOW, resetsAt, rateLimitType, runUrl: RUN_URL, marker: MARKER,
  });
  console.log(`429 rilevato → rimborso del round ${ROUND} (commento ${id}) sulla PR #${PR}.`);
  if (DRY_RUN) {
    console.log(body);
    return;
  }
  gh(['api', '-X', 'DELETE', `repos/${repo}/issues/comments/${id}`]);
  gh(['pr', 'comment', String(PR), ...repoArgs, '--body', body]);
}

main();
