#!/usr/bin/env node
/**
 * orphan-max-turns-work.mjs — un `max-turns` che ha COMMITTATO non è rumore.
 *
 * ## Il difetto, misurato
 *
 * `mark-claude-terminal-outcome.mjs` posta `<!-- FIX_OUTCOME: max-turns -->`
 * quando la run del fixer muore con `error_max_turns`. Da lì in poi il marker è
 * l'unica cosa che sopravvive della run: il branch che la run può aver pushato
 * non è nominato da nessuna parte, e nessuno strato del ciclo lo guarda.
 *
 * `harvest-agent-lessons.mjs` (`isAvoidableMaxTurns`) decide se quel marker vale
 * un'escalation, e la sua UNICA prova di «lavoro consegnato» è un marker
 * `pr-created` sulla stessa issue. Una run che ha committato e pushato ma è
 * morta PRIMA di aprire la PR non ha quel marker: viene contata come burn
 * evitabile, e — questo è il punto — il suo lavoro non compare in nessun altro
 * canale. Gli strati che raccolgono il lavoro fermo raccolgono PR
 * (`stale-pr-rescuer`, `recycle-stale-prs`, `pr-autorebase`): un branch senza PR
 * non è visibile a nessuno di loro.
 *
 * Misurato il 2026-08-13 su questo repo, confrontando i branch remoti con `main`
 * via `repos/.../compare`:
 *
 *   fix/issue-101  ahead=1  PR: nessuna        fix/issue-204  ahead=1  PR: nessuna
 *   fix/issue-148  ahead=1  PR: nessuna        fix/issue-220  ahead=1  PR: nessuna
 *   fix/issue-166  ahead=2  PR: nessuna        fix/issue-222  ahead=2  PR: nessuna
 *   fix/issue-188  ahead=1  PR: nessuna        fix/issue-234  ahead=2  PR: nessuna
 *   fix/issue-190  ahead=1  PR: nessuna        fix/issue-266  ahead=1  PR: nessuna
 *
 * Dieci branch, 12 commit, zero PR mai aperte. Otto delle dieci issue portano un
 * marker `max-turns`. Non è lavoro perso per scelta: è lavoro che nessuno ha mai
 * saputo esistesse, perché l'unico osservatore in grado di accorgersene guarda
 * il posto sbagliato.
 *
 * ## Perché il rilevatore vive QUI e non nell'harvester
 *
 * `scripts/ci/harvest-agent-lessons.mjs` e `scripts/ci/mark-claude-terminal-outcome.mjs`
 * sono `mode: identical` in `loop-sync-manifest.json`: devono restare byte-identici
 * al sito, e una modifica va fatta là (vedi l'intestazione del manifest). Insegnare
 * a `isAvoidableMaxTurns` a distinguere «morto a mani vuote» da «morto col lavoro
 * in mano» è quindi lavoro del sito, e questo file NON lo fa.
 *
 * Quello che fa è la metà che manca da entrambi i lati e che nessuno dei due
 * possiede: OSSERVARE i branch orfani e dirlo. È una domanda sul repo, non sulla
 * regola — e la risposta è diversa nei due repo, perché i branch sono diversi.
 * `classifyMaxTurnsRun` qui sotto è la forma pura del predicato che al sito
 * servirà: se e quando `isAvoidableMaxTurns` imparerà a leggerlo, la semantica è
 * già scritta e testata (`generator/tests/harvest-escalation-rules.test.mjs`).
 *
 * ## Zero Claude, zero quota
 *
 * Solo `gh api` in lettura. Non genera niente, non chiama nessun modello, e in
 * assenza di `--apply` non scrive nemmeno un commento.
 *
 * Uso:
 *   node scripts/ci/orphan-max-turns-work.mjs                # report, sola lettura
 *   node scripts/ci/orphan-max-turns-work.mjs --window 30    # finestra in giorni
 *   node scripts/ci/orphan-max-turns-work.mjs --apply        # + commento sulle issue
 *
 * Env: GH_REPO (`owner/repo`, opzionale — altrimenti gh inferisce dal remote).
 */

import { execFileSync } from 'node:child_process';

// ── Contratto dei marker (ISSUES.md «Telemetria degli esiti») ────────────────
/** L'esito che dice «budget di turni esaurito». */
export const MAX_TURNS_CODE = 'max-turns';

/**
 * Marker del commento che questo script posta con `--apply`.
 *
 * Serve al dedup, e il dedup e' cio' che rende lo script COLLEGABILE a uno
 * schedule: senza, `--apply` commenta la stessa issue a ogni giro. Non sarebbe
 * solo rumore — un commento di bot alza `updatedAt`, e su questo repo e' proprio
 * quello che affama le uscite della coda: il cooldown del parked-retry e
 * l'age-out chiedono quiete, e le issue piu' sorvegliate non la raggiungono mai
 * (misurato il 2026-08-24: 30 candidate nel pool, 2 oltre il cooldown). Un
 * rilevatore che si ri-annuncia ogni notte diventa la causa del blocco che
 * dovrebbe aiutare a diagnosticare.
 */
export const ORPHAN_NOTE_MARKER = '<!-- orphan-max-turns-work -->';

/**
 * Vero se questa issue porta gia' l'annotazione di lavoro orfano. Pura.
 * @param {Array<{body?: string}>} comments
 */
export function hasOrphanNote(comments) {
  return (comments || []).some((c) => String(c?.body || '').includes(ORPHAN_NOTE_MARKER));
}
/** L'unico esito che oggi prova una consegna, e l'unico che l'harvester legge. */
export const DELIVERY_CODE = 'pr-created';

/**
 * Il branch che `issue-fix.yml` usa per la issue `n`. Convenzione osservata su
 * tutti e dieci i branch orfani misurati sopra. Pura → testabile.
 * @param {number|string} n
 * @returns {string}
 */
export function branchNameForIssue(n) {
  return `fix/issue-${n}`;
}

/**
 * Estrae il codice FIX_OUTCOME da un corpo di commento, o null.
 * Stessa regex non ancorata del drainer (ISSUES.md: la posizione non conta).
 * Pura → testabile.
 * @param {string} body
 * @returns {string|null}
 */
export function fixOutcomeCode(body) {
  const m = String(body || '').match(/<!--\s*FIX_OUTCOME:\s*([a-z0-9-]+)\s*-->/i);
  return m ? m[1].toLowerCase() : null;
}

/**
 * LA DISTINZIONE CHE MANCA. Tre esiti, non due:
 *
 *   `delivered`    — la run ha aperto una PR (marker `pr-created`, oppure il
 *                    branch ha già una PR associata). Il lavoro è nel ciclo, che
 *                    da qui in poi lo gestisce da solo. Nessun recupero da fare.
 *   `recoverable`  — nessuna PR, ma il branch esiste ed è AVANTI rispetto a main:
 *                    la run ha committato e pushato prima di morire. È il caso
 *                    che oggi sparisce: contato come burn dall'harvester e
 *                    invisibile a ogni strato che raccoglie PR.
 *   `empty`        — nessuna PR e nessun commit. Solo qui «max-turns» significa
 *                    davvero «niente da salvare».
 *
 * Il default è `empty` e non `recoverable`: senza prova di un commit non si
 * inventa lavoro da recuperare. L'errore opposto — segnalare un recupero che non
 * esiste — costerebbe un giro di attenzione umana su un branch vuoto, che è il
 * modo più veloce per far ignorare questo segnale.
 *
 * `branch === null` significa «branch assente», non «non guardato»: chi chiama
 * deve aver interrogato il remote. Un errore di rete va trattato passando
 * `branch: undefined`, che è `empty` per la stessa ragione conservativa.
 *
 * Pura (niente gh) → testabile senza mock.
 *
 * @param {{hasDeliveredPr?: boolean, branch?: {aheadBy?: number, prNumbers?: number[]}|null}} input
 * @returns {'delivered'|'recoverable'|'empty'}
 */
export function classifyMaxTurnsRun({ hasDeliveredPr = false, branch = null } = {}) {
  if (hasDeliveredPr) return 'delivered';
  if (!branch) return 'empty';
  const prs = Array.isArray(branch.prNumbers) ? branch.prNumbers : [];
  if (prs.length > 0) return 'delivered';
  return Number(branch.aheadBy) > 0 ? 'recoverable' : 'empty';
}

/**
 * `true` se la run ha lasciato lavoro che nessuno sta guardando. È la forma che
 * `isAvoidableMaxTurns` (sul sito) dovrebbe consultare prima di dichiarare
 * evitabile un `max-turns`: un esito con lavoro recuperabile non è burn da
 * sopprimere, è un recupero da fare.
 * @param {Parameters<typeof classifyMaxTurnsRun>[0]} input
 */
export function hasRecoverableWork(input) {
  return classifyMaxTurnsRun(input) === 'recoverable';
}

/**
 * Le issue con lavoro orfano, dato lo stato già raccolto. Pura → testabile.
 * @param {Array<{number:number, outcomes:string[]}>} issues
 * @param {Map<number, {aheadBy:number, prNumbers:number[]}|null>} branchByIssue
 * @returns {Array<{issue:number, branch:string, aheadBy:number}>}
 */
export function selectRecoverableWork(issues, branchByIssue) {
  const out = [];
  for (const it of issues || []) {
    const outcomes = Array.isArray(it.outcomes) ? it.outcomes : [];
    if (!outcomes.includes(MAX_TURNS_CODE)) continue;
    const branch = branchByIssue instanceof Map ? branchByIssue.get(it.number) : null;
    const verdict = classifyMaxTurnsRun({
      hasDeliveredPr: outcomes.includes(DELIVERY_CODE),
      branch,
    });
    if (verdict === 'recoverable') {
      out.push({ issue: it.number, branch: branchNameForIssue(it.number), aheadBy: branch.aheadBy });
    }
  }
  return out;
}

// ── CLI (sola lettura salvo --apply) ─────────────────────────────────────────

const repoArgs = process.env.GH_REPO ? ['--repo', process.env.GH_REPO] : [];
const apiRepo = process.env.GH_REPO || null;

function gh(args, { quiet = false } = {}) {
  try {
    return execFileSync('gh', args, { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024, stdio: quiet ? ['ignore', 'pipe', 'ignore'] : undefined });
  } catch (e) {
    if (!quiet) process.stderr.write(`gh ${args.slice(0, 3).join(' ')} fallita: ${e && e.message ? e.message : e}\n`);
    return '';
  }
}
function ghJson(args, opts) {
  const raw = gh(args, opts).trim();
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

/** `owner/repo` per le chiamate `gh api`, dal remote se GH_REPO non è impostata. */
function resolveRepo() {
  if (apiRepo) return apiRepo;
  const v = ghJson(['repo', 'view', '--json', 'nameWithOwner']);
  return v && v.nameWithOwner ? v.nameWithOwner : null;
}

/**
 * Stato del branch rispetto a main, o null se il branch non esiste.
 * @param {string} repo
 * @param {string} branch
 */
function branchState(repo, branch) {
  // `quiet`: un 404 qui è il caso NORMALE («il branch non esiste»), non un
  // errore. Lasciarlo urlare su stderr insegnerebbe a ignorare l'output proprio
  // quando riporta un recupero vero.
  const cmp = ghJson(['api', `repos/${repo}/compare/main...${encodeURIComponent(branch)}`,
    '--jq', '{aheadBy: .ahead_by}'], { quiet: true });
  if (!cmp) return null;
  const prs = ghJson(['pr', 'list', ...repoArgs, '--state', 'all', '--head', branch,
    '--json', 'number']) || [];
  return { aheadBy: Number(cmp.aheadBy) || 0, prNumbers: prs.map((p) => p.number) };
}

function main() {
  const argv = process.argv.slice(2);
  const APPLY = argv.includes('--apply');
  const wIdx = argv.indexOf('--window');
  const windowDays = wIdx >= 0 ? Number(argv[wIdx + 1]) || 14 : 14;
  const sinceDay = new Date(Date.now() - windowDays * 86_400_000).toISOString().slice(0, 10);

  const repo = resolveRepo();
  if (!repo) {
    console.log('Repo non risolvibile (né GH_REPO né remote) → niente da fare.');
    return;
  }
  console.log(`orphan-max-turns-work — repo ${repo}, finestra ${windowDays}gg (dal ${sinceDay})`);

  const issues = ghJson(['issue', 'list', ...repoArgs, '--search',
    `label:agent:triaged updated:>=${sinceDay}`, '--state', 'all', '--limit', '120',
    '--json', 'number,title']) || [];

  const collected = [];
  for (const it of issues) {
    const data = ghJson(['issue', 'view', String(it.number), ...repoArgs, '--json', 'comments']);
    const outcomes = [];
    for (const c of (data && data.comments) || []) {
      const code = fixOutcomeCode(c.body);
      if (code && !outcomes.includes(code)) outcomes.push(code);
    }
    if (outcomes.includes(MAX_TURNS_CODE)) {
      // `annotated` viene calcolato QUI e non nel ramo `--apply`: i commenti sono
      // gia' in mano da questa `issue view`, quindi il dedup e' gratis. Rileggerli
      // dopo sarebbe una seconda chiamata per issue a ogni giro.
      collected.push({
        number: it.number, title: it.title, outcomes,
        annotated: hasOrphanNote((data && data.comments) || []),
      });
    }
  }
  console.log(`issue con un marker \`${MAX_TURNS_CODE}\`: ${collected.length}`);

  const branchByIssue = new Map();
  for (const it of collected) branchByIssue.set(it.number, branchState(repo, branchNameForIssue(it.number)));

  const recoverable = selectRecoverableWork(collected, branchByIssue);
  const byVerdict = { delivered: 0, recoverable: 0, empty: 0 };
  for (const it of collected) {
    byVerdict[classifyMaxTurnsRun({
      hasDeliveredPr: it.outcomes.includes(DELIVERY_CODE),
      branch: branchByIssue.get(it.number),
    })]++;
  }
  console.log(`verdetti — delivered=${byVerdict.delivered} recoverable=${byVerdict.recoverable} empty=${byVerdict.empty}`);

  if (recoverable.length === 0) {
    console.log('Nessun lavoro orfano: ogni `max-turns` è morto a mani vuote o ha consegnato.');
    return;
  }
  for (const r of recoverable) {
    console.log(`RECUPERABILE #${r.issue} → \`${r.branch}\` (${r.aheadBy} commit avanti a main, nessuna PR)`);
  }
  if (!APPLY) {
    console.log('(sola lettura: passa --apply per annotare le issue)');
    return;
  }
  const annotatedByIssue = new Map(collected.map((it) => [it.number, it.annotated]));
  let posted = 0;
  let already = 0;
  for (const r of recoverable) {
    if (annotatedByIssue.get(r.issue)) { already++; continue; }
    const note = `♻️ **Lavoro orfano rilevato (auto, zero-Claude)**: la run del fixer è morta ` +
      `\`${MAX_TURNS_CODE}\` ma aveva già pushato \`${r.branch}\` — **${r.aheadBy}** commit avanti a ` +
      `\`main\`, senza nessuna PR. Nessuno strato del ciclo lo guarda: \`stale-pr-rescuer\` e ` +
      `\`recycle-stale-prs\` raccolgono PR, e questo branch non ne ha mai avuta una. Prima di ` +
      `ri-tentare da zero, verifica se il commit è recuperabile.\n\n${ORPHAN_NOTE_MARKER}`;
    try {
      gh(['issue', 'comment', String(r.issue), ...repoArgs, '--body', note]);
      posted++;
      console.log(`annotata #${r.issue}`);
    } catch (e) {
      console.log(`::warning::annotazione di #${r.issue} fallita: ${String(e).slice(0, 120)}`);
    }
  }
  // Il conteggio delle GIA' annotate va stampato: e' la prova che il dedup morde,
  // e su uno schedule notturno e' la riga che distingue «niente di nuovo» da
  // «lo script non gira».
  console.log(`annotazioni — nuove=${posted} gia'-annotate=${already} su ${recoverable.length} recuperabili.`);
}

// Esegui solo come CLI (stessa guardia di followup-drainer.mjs): importarlo dai
// test non deve lanciare gh.
if (process.argv[1] && process.argv[1].endsWith('orphan-max-turns-work.mjs')) main();
