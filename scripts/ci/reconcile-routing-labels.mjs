#!/usr/bin/env node
/**
 * reconcile-routing-labels.mjs — collassa il doppio instradamento di una issue
 * (`agent:fix` **e** `agent:fix-queued` insieme) a una sola label di routing.
 *
 * ## La finestra che questo gate chiude (#918, item 2)
 *
 * Da quando `issue-triage.yml` serializza su una chiave PER-issue (#908,
 * `issue-triage-${{ github.event.issue.number || 'sweep' }}`), la run
 * event-driven (`issues:[opened]`) e la run schedulata (`schedule`, gruppo
 * `sweep`) non condividono piu' alcun gruppo di concorrenza: girano insieme.
 * Il secondo passaggio dello sweep (`triage-sweep.mjs`, «triaged-but-not-
 * routed») lavora esattamente lo stato transitorio che la run event-driven
 * lascia sulla issue fra `--add-label agent:triaged` (GITHUB_TOKEN) e la label
 * di routing (PAT) — due `gh` distinti, quindi una finestra reale.
 *
 * Nella finestra le due strade classificano lo STESSO input con lo STESSO
 * `classifyIssue(title, labels)`, quindi di norma la seconda label e' un
 * `--add-label` idempotente. Diverge in un punto solo: il clamp del budget
 * diretto dello sweep (`crawlerToQueue`, `route === 'fix' && routedFix >=
 * directFixBudget`) accoda dove l'event-driven instrada a fix diretto. Esito:
 * una issue con ENTRAMBE le label.
 *
 * Perche' non e' cosmetico: `agent:fix` ha gia' fatto partire il fixer, e
 * `agent:fix-queued` rimette la stessa issue fra i candidati del drainer
 * (`followup-drainer.mjs`, `listIssues(LBL_QUEUED)`), che la promuovera' una
 * seconda volta — una seconda run del fixer sulla quota condivisa col sito, su
 * lavoro gia' in corso.
 *
 * ## Perche' qui e non in `triage-sweep.mjs`
 *
 * Quel file e' `mode: identical` nel `loop-sync-manifest.json`: una modifica
 * viene sovrascritta al mirror successivo e fa scattare `loop-drift-check`.
 * Stessa ragione, e stessa forma, di `check-stale-issue-dispatch.mjs` (item 3):
 * il gate sta ACCANTO allo script mirrorato, invocato dagli YAML `adapted`.
 *
 * ## La regola: vince la label ATTIVA, si rimuove quella di coda
 *
 * `agent:fix` e' gia' stato consumato come token di dispatch — toglierlo non
 * richiama la run partita, e lascerebbe un fixer in volo su una issue che
 * nessuna label descrive. E' anche esattamente cio' che fa il drainer quando
 * promuove (`edit(n, { add: [LBL_FIX], remove: [LBL_QUEUED] })`), quindi la
 * riconciliazione non introduce una semantica nuova: ripristina l'unica che il
 * ciclo ha sempre avuto.
 *
 * `fu-prio:*` NON si tocca: e' inerte fuori dalla coda e serve intatta se la
 * issue ci rientra (il re-queue del drainer non la riscrive).
 *
 * ## Il guard di eta', e perche' non e' una precauzione generica
 *
 * Ogni scrittore legittimo passa da `gh issue edit --add-label <attiva>
 * --remove-label <coda>`, che sull'API sono DUE chiamate: c'e' un istante in cui
 * entrambe le label esistono (promozione del drainer, ri-accodamento per quota
 * in `check-quota-backoff.mjs`). Riconciliare li' dentro disferebbe l'edit a
 * meta'. Si agisce solo su un conflitto FERMO da `MIN_AGE_SEC` (default 120s),
 * che nessun edit atomico puo' produrre.
 *
 * Direzione dell'errore: non toccare nulla su qualunque dubbio. Input mancante,
 * `gh` illeggibile, JSON malformato, timestamp assente → si salta la issue e
 * si esce 0. Per l'eta' si preferisce l'ultimo evento di label, quando
 * disponibile; la funzione pura ricade su `updatedAt` per le risposte legacy,
 * mentre il percorso runtime salta in modo fail-safe se la timeline non e'
 * leggibile.
 * Un conflitto lasciato in piedi costa una run in piu' al giro successivo; una
 * rimozione sbagliata cancella l'instradamento di una issue.
 *
 * Env:
 *   GH_TOKEN     richiesto. Deliberatamente il GITHUB_TOKEN e non il PAT: qui
 *                si RIMUOVE una label, e nessun workflow ascolta `unlabeled`.
 *                Non serve svegliare niente — anzi, non deve.
 *   GH_REPO      opzionale `owner/repo` (o `GITHUB_REPOSITORY`).
 *   MIN_AGE_SEC  eta' minima del conflitto perche' sia considerato fermo.
 *   DRY_RUN      "1"/"true" → rileva e stampa, nessuna scrittura.
 *
 * CLI:
 *   node scripts/ci/reconcile-routing-labels.mjs            # tutte le aperte
 *   node scripts/ci/reconcile-routing-labels.mjs --issue 42 # solo la #42
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lastLabelEventAt } from './followup-drainer.mjs';

/**
 * Le coppie attiva/coda del ciclo. Una issue non deve MAI portarle entrambe:
 * ogni stadio che le muove lo fa con un solo `gh issue edit` add+remove.
 * `agent:decompose` e' incluso per classe: `issue-decompose.yml` ri-accoda su
 * `agent:decompose-queued` mentre `agent:decompose` e' ancora addosso alla run
 * (`QUOTA_LBL_REQUEUE`), quindi la stessa forma di conflitto e' possibile li'.
 */
export const ROUTE_CONFLICTS = Object.freeze([
  Object.freeze({ active: 'agent:fix', queued: 'agent:fix-queued' }),
  Object.freeze({ active: 'agent:decompose', queued: 'agent:decompose-queued' }),
]);

const labelNames = (iss) => (iss?.labels || []).map((l) => (typeof l === 'string' ? l : l?.name)).filter(Boolean);

/**
 * Le riconciliazioni dovute per un insieme di issue.
 *
 * Pura: nessun `gh`, nessun orologio implicito — `nowMs` e' un parametro.
 *
 * @param {Array<{number:number, labels?:Array<{name:string}|string>, updatedAt?:string, lastLabelEventAt?:string}>} issues
 * @param {{nowMs?: number, minAgeSec?: number}} [opts]
 * @returns {Array<{number:number, active:string, remove:string, ageSec:number}>}
 */
export function reconciliations(issues, opts = {}) {
  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  const minAgeSec = Number.isFinite(opts.minAgeSec) ? opts.minAgeSec : 120;
  const out = [];
  for (const iss of Array.isArray(issues) ? issues : []) {
    const n = Number(iss?.number);
    if (!Number.isInteger(n) || n <= 0) continue;
    const names = labelNames(iss);
    for (const { active, queued } of ROUTE_CONFLICTS) {
      if (!names.includes(active) || !names.includes(queued)) continue;
      // Se disponibile, l'evento di label evita di usare una modifica al body
      // come falso segnale di freschezza del conflitto; altrimenti `updatedAt`
      // mantiene compatibilita' con le risposte GitHub standard.
      const t = Date.parse(iss?.lastLabelEventAt ?? iss?.updatedAt ?? '');
      if (!Number.isFinite(t)) continue;
      const ageSec = Math.floor((nowMs - t) / 1000);
      if (ageSec < minAgeSec) continue;
      out.push({ number: n, active, remove: queued, ageSec });
    }
  }
  return out;
}

const repoName = () => process.env.GH_REPO || process.env.GITHUB_REPOSITORY || '';

const repoArgs = () => {
  const repo = repoName();
  return repo ? ['--repo', repo] : [];
};

function gh(args, { json = true } = {}) {
  const out = execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return json ? JSON.parse(out || '[]') : out;
}

/** Usa la timeline REST per non confondere un commento con un evento di label. */
function withLastRoutingLabelEvent(issues) {
  const repo = repoName();
  if (!repo) return issues;
  return issues.map((iss) => {
    try {
      const pages = gh([
        'api',
        'repos/' + repo + '/issues/' + iss.number + '/events',
        '--paginate',
        '--slurp',
      ]);
      const events = Array.isArray(pages) ? pages.flat() : [];
      const times = ROUTE_CONFLICTS.flatMap(({ active, queued }) => [
        lastLabelEventAt(events, active),
        lastLabelEventAt(events, queued),
      ]).filter((t) => Number.isFinite(t));
      const latest = times.length > 0 ? Math.max(...times) : null;
      // Stringa vuota deliberata: se la timeline fallisce o non contiene un
      // evento leggibile, reconciliations() non deve ripiegare su updatedAt
      // e rischiare una rimozione basata su un timestamp sbagliato.
      return { ...iss, lastLabelEventAt: latest === null ? '' : new Date(latest).toISOString() };
    } catch (e) {
      console.log('::warning::timeline label di #' + iss.number + ' illeggibile ('
        + String(e).slice(0, 120) + ') → salto.');
      return { ...iss, lastLabelEventAt: '' };
    }
  });
}

/** Le issue candidate: solo quelle che portano gia' una label ATTIVA. */
function fetchCandidates(only) {
  if (only) {
    try {
      const iss = gh(['issue', 'view', String(only), ...repoArgs(), '--json', 'number,labels,updatedAt,state']);
      return iss?.state && String(iss.state).toUpperCase() !== 'OPEN' ? [] : withLastRoutingLabelEvent([iss]);
    } catch (e) {
      console.log(`::warning::#${only} illeggibile (${String(e).slice(0, 120)}) → nessuna riconciliazione.`);
      return [];
    }
  }
  const byNumber = new Map();
  for (const { active } of ROUTE_CONFLICTS) {
    try {
      for (const iss of gh(['issue', 'list', ...repoArgs(), '--state', 'open', '--label', active,
        '--limit', '1000', '--json', 'number,labels,updatedAt'])) {
        byNumber.set(iss.number, iss);
      }
    } catch (e) {
      // Label inesistente o `gh` in errore: lista vuota, mai fatale.
      console.log(`::warning::lista per ${active} fallita (${String(e).slice(0, 120)}) → salto.`);
    }
  }
  return withLastRoutingLabelEvent([...byNumber.values()]);
}

function main() {
  const argv = process.argv.slice(2);
  const iOnly = argv.indexOf('--issue');
  const only = iOnly >= 0 ? Number(argv[iOnly + 1]) : 0;
  const dry = ['1', 'true'].includes(String(process.env.DRY_RUN || '').toLowerCase());
  const minAgeSec = Number(process.env.MIN_AGE_SEC || 120);

  if (iOnly >= 0 && (!Number.isInteger(only) || only <= 0)) {
    console.error('::error::--issue richiede un numero intero positivo → nessuna riconciliazione.');
    process.exitCode = 1;
    return;
  }

  const todo = reconciliations(fetchCandidates(only), {
    minAgeSec: Number.isFinite(minAgeSec) ? minAgeSec : 120,
  });
  if (!todo.length) {
    console.log('Nessun doppio instradamento fermo. ✅');
    return;
  }

  let reconciled = 0;
  let failed = 0;
  for (const r of todo) {
    const why = `#${r.number} porta ${r.active} + ${r.remove} da ${r.ageSec}s → rimuovo ${r.remove} (vince la label attiva).`;
    if (dry) { console.log(`[dry] ${why}`); continue; }
    try {
      gh(['issue', 'edit', String(r.number), ...repoArgs(), '--remove-label', r.remove], { json: false });
      reconciled++;
      console.log(why);
    } catch (e) {
      failed++;
      console.log(`::warning::#${r.number} rimozione ${r.remove} fallita: ${String(e).slice(0, 120)}`);
    }
  }
  console.log(`Riconciliazioni: ${reconciled}${dry ? ' (dry-run)' : ''}.`);
  if (failed > 0) console.log(`::warning::reconcile: ${failed} falliti su ${todo.length}.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
