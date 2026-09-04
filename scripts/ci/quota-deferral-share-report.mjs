#!/usr/bin/env node
/**
 * quota-deferral-share-report.mjs — lo share transient/total non era una
 * misura, era il numero che nessuno aveva mai letto su una run vera.
 *
 * ## Cosa manca, e perche' e' costoso (issue #804, padre #787)
 *
 * `QUOTA_DEFERRAL_MIN_TRANSIENT_SHARE = 0.5` e' stata tarata su due run di
 * agosto (31817957722 e 31823202761), riclassificate A MANO scaricando i log e
 * ricontando i 106 errori del messaggio aggregato. Da allora #767 ha spostato
 * i ~12 id GitHub fratelli dal vocabolario transitorio (`cooling down
 * (rate-limited)`) a quello persistente (`unreachable (...), non-retryable`), e
 * #805 li ha tolti dal denominatore quando sono echi di un solo guasto.
 *
 * Due cambi di aritmetica, zero misure dopo. `quotaDeferralShare()` produce il
 * numero azionabile a ogni cascata, ma nessuno lo AGGREGA: esce solo dentro
 * righe di log sparse in run da 300-500 KB, e solo quando la run arriva al
 * catch di primo livello — le cascate riassorbite da un retry di sezione non
 * lasciano nemmeno quella. Finche' la misura costa un pomeriggio di `gh run
 * view`, ogni ricalibrazione della soglia (e ogni discussione sul denominatore)
 * e' una congettura.
 *
 * Questo modulo e' quella misura, con la stessa forma di
 * `exhaustion-reason-report.mjs`: zero rete, zero Claude, zero quota, solo
 * builtin Node — legge testo di log gia' prodotto.
 *
 * ## Da dove viene il numero, e perche' proprio da li'
 *
 * Dal messaggio aggregato di `callLLM`, che e' l'UNICO posto dove la lista
 * `errors` sopravvive intera:
 *
 *   `All AI models failed. Chain: [a → b → …]. Errors: e1 | e2 | … [| Prompt budget: …]`
 *
 * Ricomposta la lista, il tally NON viene ricalcolato qui: lo fa
 * `classifyExhaustionCause` (ai-models.mjs) e il quoziente lo prende
 * `quotaDeferralShare` (exhaustion-disposition.mjs), cioe' le stesse due
 * funzioni che decidono in produzione. E' AGENTS.md #6 applicato alla lettera:
 * una copia locale delle due regex direbbe «share 0,53» accanto a una run
 * uscita rossa, e una metrica che spiega un verdetto diverso da quello preso
 * smette di essere letta. `exhaustion-reason-report.mjs` ridichiara la sua
 * regex perche' la riga che legge non ha un riconoscitore esportato; qui ce
 * l'ha, quindi si importa.
 *
 * ## Cosa questo modulo dichiara e non deduce
 *
 * La FORMA del messaggio (`CASCADE_RE`) e' l'unica cosa scritta a mano, ed e'
 * deliberatamente stretta. Una riga che dice `All AI models failed` senza
 * combaciare viene contata come `formato non riconosciuto` invece di essere
 * ignorata: il modo in cui questa misura muore in silenzio e' una
 * riformulazione del messaggio che fa restituire «0 cascate» a un parser che
 * continua a uscire 0. Un vocabolario cambiato deve essere VISIBILE — e' la
 * stessa lezione di #767, dove a cambiare era stata una frase di skip.
 *
 * Uso:
 *   gh run view <id> --log | node scripts/ci/quota-deferral-share-report.mjs --stdin
 *   node scripts/ci/quota-deferral-share-report.mjs --runs 20
 */

import { execFileSync } from 'node:child_process';
import { classifyExhaustionCause } from '../../generator/scripts/lib/ai-models.mjs';
import {
  isInputCapDeferralVeto,
  isLegitimateQuotaDeferral,
  quotaDeferralShare,
} from '../../generator/scripts/lib/exhaustion-disposition.mjs';

/**
 * Il messaggio aggregato di `callLLM`, ancorato su tutte e tre le sue parti
 * fisse. Non `/Errors: (.*)/` : quel prefisso comparirebbe in qualunque altra
 * riga che elenchi errori, e un parser che raccoglie righe altrui produce uno
 * share sbagliato invece di nessuno share — l'unico esito peggiore.
 */
export const CASCADE_RE = /All AI models failed\. Chain: \[[^\]]*\]\. Errors: (.+)$/;

/** La spia di un messaggio aggregato che `CASCADE_RE` NON sa piu' leggere. */
export const CASCADE_MARKER = 'All AI models failed';

/**
 * La coda che `callLLM` appende quando ≥1 modello ha rifiutato sulla TAGLIA.
 * Non e' un elemento di `errors` — e' prosa per il chiamante — quindi va tolta
 * prima dello split, o gonfia il totale di uno e sposta lo share.
 * Il conteggio dei rifiuti che cattura e' `inputCapReport.count`, cioe' l'unico
 * campo che serve a rieseguire `isInputCapDeferralVeto`.
 */
export const PROMPT_BUDGET_TAIL_RE = /\s*\|\s*Prompt budget: (\d+) model\(s\) refused/;

/** Il separatore che `errors.join(' | ')` mette fra due motivi. */
const ENTRY_SEPARATOR = ' | ';

// L'ESC iniziale non e' opzionale: senza, la classe divorerebbe il `[a → b]`
// della catena — cioe' l'ancora su cui CASCADE_RE si regge.
const ANSI_RE = /\u001B\[[0-9;]*[A-Za-z]/g;

/** Toglie le sequenze ANSI e il `\r` che `gh run view --log` lascia in coda. */
function cleanLine(line) {
  return String(line || '').replace(ANSI_RE, '').replace(/\r$/, '');
}

/**
 * Le cascate esaurite in un testo di log. Pura → testabile.
 *
 * DEDUPLICATE sul payload, e il conteggio grezzo resta esposto: lo stesso
 * oggetto errore viene stampato piu' volte (il catch di primo livello lo
 * riemette dentro «Differito …» e dentro «NON differibile …», e il report di
 * run lo ricopia nelle note), quindi contare le RIGHE conterebbe due o tre
 * volte la stessa cascata e falserebbe qualunque totale per run. Due cascate
 * davvero distinte con la stessa identica lista di errori — stesso ordine,
 * stessi 200 caratteri di messaggio per ogni modello — collassano in una:
 * l'alternativa e' contare gli echi di log come guasti, che e' esattamente il
 * difetto che #805 ha appena tolto dal denominatore.
 *
 * @param {string} text
 * @returns {{cascades: Array<{errors: string[], inputCapRefusals: number}>, lines: number, unrecognised: number}}
 */
export function parseCascades(text) {
  const cascades = [];
  const seen = new Set();
  let lines = 0;
  let unrecognised = 0;
  for (const raw of String(text || '').split('\n')) {
    const line = cleanLine(raw);
    if (!line.includes(CASCADE_MARKER)) continue;
    const m = CASCADE_RE.exec(line);
    if (!m) { unrecognised += 1; continue; }
    lines += 1;
    // La stessa cascata compare anche INCASSATA in una stringa JSON (le note
    // del report di run), dove la riga finisce con la chiusura delle
    // virgolette: senza normalizzare la coda, quel terzo eco avrebbe una
    // chiave diversa e verrebbe contato come una seconda cascata — cioe' il
    // doppio conteggio che questa deduplicazione esiste per togliere.
    const payload = m[1].replace(/[\s",]+$/, '');
    if (seen.has(payload)) continue;
    seen.add(payload);
    const cut = PROMPT_BUDGET_TAIL_RE.exec(payload);
    const body = cut ? payload.slice(0, cut.index) : payload;
    const errors = body.split(ENTRY_SEPARATOR).map((e) => e.trim()).filter(Boolean);
    cascades.push({ errors, inputCapRefusals: cut ? Number(cut[1]) || 0 : 0 });
  }
  return { cascades, lines, unrecognised };
}

/**
 * L'errore che `callLLM` avrebbe lanciato per questa cascata, nella sola forma
 * che i due predicati leggono. Ricostruito e non simulato: e' cio' che permette
 * di far girare il codice di produzione sul log, invece di riscriverne la
 * logica qui dentro.
 * @param {{errors: string[], inputCapRefusals: number}} cascade
 */
export function cascadeToError(cascade) {
  const errors = Array.isArray(cascade && cascade.errors) ? cascade.errors : [];
  const refusals = Number(cascade && cascade.inputCapRefusals) || 0;
  return {
    code: 'ALL_MODELS_EXHAUSTED',
    exhaustionBreakdown: classifyExhaustionCause(errors),
    inputCapReport: refusals > 0 ? { count: refusals } : null,
  };
}

/**
 * La misura che la issue chiede, per una cascata. Lordo e netto insieme: il
 * lordo e' il numero che le due run di agosto avevano contato a mano, il netto
 * e' quello su cui il predicato decide da #805, e lo scarto fra i due E' la
 * grandezza in discussione. Riportarne uno solo renderebbe la misura inutile
 * proprio per la domanda che l'ha generata.
 *
 * `deferral` e' il verdetto di `isLegitimateQuotaDeferral`; `inputCapVeto` dice
 * se il gate PRECEDENTE (`isInputCapDeferralVeto`, exit 3) avrebbe comunque
 * squalificato il differimento — senza, il report annuncerebbe «differimento»
 * su una run uscita rossa per un'altra ragione.
 *
 * Pura → testabile.
 */
export function analyseCascade(cascade) {
  const err = cascadeToError(cascade);
  const gross = err.exhaustionBreakdown;
  const net = quotaDeferralShare(err);
  return {
    gross: {
      transient: gross.transient,
      persistent: gross.persistent,
      ambiguous: Math.max(0, gross.total - gross.transient - gross.persistent),
      total: gross.total,
      share: gross.total > 0 ? gross.transient / gross.total : 0,
    },
    net,
    providerCooldownSkips: gross.providerCooldownSkips,
    inputCapRefusals: Number(cascade && cascade.inputCapRefusals) || 0,
    inputCapVeto: isInputCapDeferralVeto(err),
    deferral: isLegitimateQuotaDeferral(err),
  };
}

/** Somma dei secchi LORDI su piu' cascate — il campione di una run. Pura. */
export function summariseRun(analyses) {
  const list = Array.isArray(analyses) ? analyses : [];
  const totals = { transient: 0, persistent: 0, ambiguous: 0, total: 0, echoes: 0 };
  for (const a of list) {
    totals.transient += a.gross.transient;
    totals.persistent += a.gross.persistent;
    totals.ambiguous += a.gross.ambiguous;
    totals.total += a.gross.total;
    totals.echoes += a.providerCooldownSkips.total;
  }
  return {
    ...totals,
    cascades: list.length,
    share: totals.total > 0 ? totals.transient / totals.total : 0,
    // Il verdetto della run e' quello dell'ULTIMA cascata: le precedenti sono
    // state riassorbite da un retry di sezione e non hanno mai raggiunto il
    // catch di primo livello, quindi non hanno deciso niente.
    deferral: list.length > 0 ? list[list.length - 1].deferral : null,
  };
}

const pct = (x) => `${(x * 100).toFixed(1)}%`;

/** Riga per una singola cascata. Pura → testabile. */
export function formatCascadeLine(index, a) {
  const echo = a.providerCooldownSkips.total;
  const verdict = a.inputCapVeto
    ? 'VETO input-cap (exit 3)'
    : (a.deferral ? 'DIFFERIMENTO' : 'RIFIUTO');
  const netPart = echo > 0
    ? `  netto ${a.net.transient}/${a.net.total} = ${pct(a.net.share)} (echi ${echo})`
    : '';
  return `  #${index}  lordo t=${a.gross.transient} p=${a.gross.persistent} a=${a.gross.ambiguous} tot=${a.gross.total}`
    + ` = ${pct(a.gross.share)}${netPart}  soglia ${pct(a.net.required)} → ${verdict}`;
}

/** Riga di intestazione per una run. Pura → testabile. */
export function formatRunLine(runId, parsed, summary) {
  if (summary.cascades === 0) {
    const tail = parsed.unrecognised > 0
      ? `  ⚠️  ${parsed.unrecognised} riga/e 'All AI models failed' NON riconosciute (formato cambiato?)`
      : '';
    return `run ${runId}  nessuna cascata esaurita${tail}`;
  }
  const dup = parsed.lines - summary.cascades;
  const dupPart = dup > 0 ? ` (righe=${parsed.lines}, ${dup} echi di log)` : '';
  const unrec = parsed.unrecognised > 0 ? `  ⚠️  ${parsed.unrecognised} non riconosciute` : '';
  return `run ${runId}  cascate=${summary.cascades}${dupPart}  lordo ${summary.transient}/${summary.total}`
    + ` = ${pct(summary.share)}  echi=${summary.echoes}  verdetto finale: ${summary.deferral ? 'DIFFERIMENTO' : 'RIFIUTO'}${unrec}`;
}

// ── CLI (sola lettura) ───────────────────────────────────────────────────────

const repoArgs = process.env.GH_REPO ? ['--repo', process.env.GH_REPO] : [];

function gh(args) {
  try {
    return execFileSync('gh', args, { encoding: 'utf-8', maxBuffer: 128 * 1024 * 1024 });
  } catch (e) {
    process.stderr.write(`gh fallita: ${e && e.message ? e.message : e}\n`);
    return '';
  }
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf-8');
}

function reportOne(runId, text) {
  const parsed = parseCascades(text);
  const analyses = parsed.cascades.map(analyseCascade);
  const summary = summariseRun(analyses);
  console.log(formatRunLine(runId, parsed, summary));
  analyses.forEach((a, i) => console.log(formatCascadeLine(i + 1, a)));
  return summary;
}

async function main() {
  const argv = process.argv.slice(2);

  if (argv.includes('--stdin')) {
    reportOne('<stdin>', await readStdin());
    return;
  }

  const rIdx = argv.indexOf('--runs');
  const limit = rIdx >= 0 ? Number(argv[rIdx + 1]) || 20 : 20;
  const raw = gh(['run', 'list', ...repoArgs, '--workflow=generate-article.yml',
    '--limit', String(limit), '--json', 'databaseId,conclusion']);
  let runs = [];
  try { runs = JSON.parse(raw || '[]'); } catch { runs = []; }
  if (runs.length === 0) {
    console.log('Nessuna run leggibile → niente da riportare.');
    return;
  }

  const summaries = [];
  for (const r of runs) {
    const log = gh(['run', 'view', String(r.databaseId), ...repoArgs, '--log']);
    summaries.push(reportOne(r.databaseId, log));
  }

  const measured = summaries.filter((s) => s.total > 0);
  const t = measured.reduce((n, s) => n + s.transient, 0);
  const tot = measured.reduce((n, s) => n + s.total, 0);
  const echoes = measured.reduce((n, s) => n + s.echoes, 0);
  console.log(`\nTOTALE — run con almeno una cascata: ${measured.length}/${summaries.length}`);
  console.log(`lordo ${t}/${tot} = ${tot > 0 ? pct(t / tot) : '—'} · echi di cooldown: ${echoes}`);
}

if (process.argv[1] && process.argv[1].endsWith('quota-deferral-share-report.mjs')) main();
