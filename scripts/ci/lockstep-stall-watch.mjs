#!/usr/bin/env node
/**
 * lockstep-stall-watch.mjs — l'allarme che il manifest dichiarava di volere e
 * che non era mai stato costruito (issue #217).
 *
 * ## Perché esiste
 *
 * `scripts/ci/loop-sync-manifest.json` tiene i file sotto `engine/` in
 * `scope.outOfScope`, e la ragione scritta lì è che quel canale ha già una
 * discesa AUTOMATICA — la PR `engine-lockstep-auto` che il mirror del sito apre
 * qui — quindi registrarli produrrebbe un `site-ahead` per tutta la durata di
 * ogni PR di mirror, cioè rumore su un canale che funziona. La stessa voce
 * chiude dicendo che se quel canale si rompe «il segnale giusto è un allarme sul
 * mirror, non un drift check giornaliero».
 *
 * Quell'allarme non esisteva. È il difetto per intero: il manifest ha SCELTO di
 * non sorvegliare `engine/` appoggiandosi a una guardia che nessuno aveva
 * scritto, e la scelta è restata ragionevole finché il canale non si è rotto.
 *
 * ## La misura che lo motiva
 *
 * La PR #205 (`🔗 Lockstep engine/ with the site`, un solo file, +2/-9) è rimasta
 * bloccata ~4 ore in un deadlock PERMANENTE, non lenta: la lockstep avrebbe
 * regredito il fix corpus-side di #162/#182, il test `rss-feed-guid` la
 * ributtava indietro, e ogni push sull'engine del sito rigenerava la stessa
 * lockstep con la stessa regressione. Nessun tick di nessun workflow poteva
 * romperlo, e nessun gate lo segnalava. Le 8 lockstep precedenti (#136, #134,
 * #130, #72, #61, #26, #14, #8) avevano mergiato in minuti.
 *
 * Il costo non è cosmetico: finché quella PR è ferma, nessuna modifica
 * all'engine del sito scende sul corpus — ed è il corpus a renderizzare le
 * pagine articolo. È la stessa classe di incidente già pagata una volta
 * (articoli pubblicati da un engine pre-fix, visibile solo come
 * `audit:footer-root-presence` da 23 a 3608 offender).
 *
 * ## La soglia, e perché 3 ore
 *
 * Non è un numero tondo scelto a sentimento: è la più piccola soglia che rende
 * la diagnosi CERTA invece che probabile.
 *
 * `auto-merge-engine-lockstep.yml` ha come rete di sicurezza un cron al minuto
 * 17 di ogni seconda ora — un tentativo di merge schedulato ogni due ore, oltre
 * al `check_suite: completed`. Una PR aperta da meno di due ore può quindi essere
 * semplicemente in attesa del proprio turno: chiamarla «incagliata» sarebbe un
 * falso allarme sul canale che si vuole proteggere, e un allarme che grida
 * troppo presto viene spento.
 *
 * Oltre le due ore, invece, almeno uno slot schedulato è PASSATO senza chiudere
 * la PR. La terza ora è il margine per il ritardo dello scheduler di GitHub, che
 * su questo repo è misurato e non teorico (sei slot consecutivi persi il
 * 2026-08-03, vedi l'intestazione di `generate-article.yml`). Sopra le 3h,
 * quindi: un tentativo c'è stato, ha fallito, e non è un problema di cadenza.
 *
 * Sul caso reale la soglia sarebbe scattata con un'ora di margine sulle 4h in
 * cui #205 è rimasta ferma — cioè prima che il difetto venisse notato a mano.
 *
 * ## Perché NON guarda solo il rosso
 *
 * La #217 descrive il sintomo come «PR aperta e con i check rossi da > N ore», e
 * #205 era rossa. Ma il predicato che conta è «il mirror non chiude»: una
 * lockstep verde e non mergiata è già una forma nota di incaglio su questo repo
 * (una PR verde ferma 9 ore in attesa di una mano umana è la ragione per cui
 * `auto-merge-engine-lockstep.yml` esiste), e costa esattamente lo stesso —
 * l'engine non scende comunque. Il colore finisce nel BODY, dove serve a
 * diagnosticare; non nella condizione, dove restringerebbe la guardia a metà
 * della classe.
 *
 * ## Apertura e chiusura sono la stessa passata
 *
 * È il punto su cui la #45 ha già fatto male: `alert-pat-down.mjs` è arrivato
 * qui dichiarando che `gh-pat-expiry-monitor.yml` era «l'unico punto di
 * chiusura» del suo alert, e quel workflow non esisteva — la issue
 * `priority:urgent` che apriva non poteva essere chiusa da niente, e col dedup
 * sul titolo sarebbe restata accesa per sempre. Qui non c'è un chiuditore
 * altrove da citare: la stessa passata che apre richiude, via
 * `resolveGithubIssue`, appena non c'è più una lockstep oltre soglia. Il titolo
 * è COSTANTE — il branch `engine-lockstep-auto` è uno solo, quindi non serve
 * nessun discriminante — e quindi dedup e chiusura matchano sempre la stessa
 * issue canonica.
 *
 * ## Uso
 *
 *   node scripts/ci/lockstep-stall-watch.mjs [--dry-run] [--threshold-hours N]
 */
import { execFileSync } from 'node:child_process';
import { createGithubIssue, resolveGithubIssue } from '../lib/github-issue-creator.mjs';

/** Il branch che il mirror del sito possiede in esclusiva e force-pusha. */
export const LOCKSTEP_BRANCH = 'engine-lockstep-auto';

/**
 * Titolo canonico, COSTANTE. `github-issue-creator` deduplica sui primi 60
 * caratteri e `resolveGithubIssue` richiude sulla stessa chiave: un titolo che
 * portasse il numero di PR o le ore aprirebbe una issue nuova a ogni passata e
 * non ne richiuderebbe mai nessuna. Sotto i 60 caratteri non c'è nemmeno il
 * taglio a metà parola da temere.
 */
export const STALL_ISSUE_TITLE = 'Lockstep engine incagliata: il mirror non chiude';

/** Vedi l'intestazione: 2h è il periodo del cron di auto-merge, +1h di margine. */
export const DEFAULT_THRESHOLD_HOURS = 3;

/**
 * La decisione, PURA e senza rete, così il test può esercitarla per intero.
 *
 * @param {{prs: Array<{number:number,createdAt:string,url?:string,title?:string,checks?:string}>, now: Date|number, thresholdHours: number}} input
 * @returns {{stalled: Array<{number:number,ageHours:number,url?:string,title?:string,checks?:string}>, oldestAgeHours: number|null}}
 */
export function findStalledLockstep({ prs = [], now = Date.now(), thresholdHours = DEFAULT_THRESHOLD_HOURS } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const stalled = [];
  let oldestAgeHours = null;
  for (const pr of prs) {
    const createdMs = Date.parse(pr.createdAt);
    // Una data illeggibile NON diventa un allarme: fabbricherebbe un incaglio
    // dal proprio bug di parsing, che è il modo più rapido di far spegnere una
    // guardia.
    if (!Number.isFinite(createdMs)) continue;
    const ageHours = (nowMs - createdMs) / 3_600_000;
    if (oldestAgeHours === null || ageHours > oldestAgeHours) oldestAgeHours = ageHours;
    if (ageHours >= thresholdHours) stalled.push({ ...pr, ageHours });
  }
  stalled.sort((a, b) => b.ageHours - a.ageHours);
  return { stalled, oldestAgeHours };
}

/**
 * Il body. Sta qui e non nel workflow perché è la metà che RISPARMIA il tempo di
 * chi arriva: senza «la fix va a monte» il primo istinto è correggere l'engine
 * qui, che è esattamente la mossa che il mirror successivo cancella.
 */
export function buildStallBody({ stalled, thresholdHours, runUrl }) {
  const lines = [
    `La PR di lockstep dell'engine è aperta da oltre **${thresholdHours}h** e non si è chiusa.`,
    '',
    'Il canale `engine/` non ha un drift check: `scripts/ci/loop-sync-manifest.json` lo tiene',
    'in `scope.outOfScope` proprio perché questa PR è la sua discesa automatica. Finché resta',
    'aperta, **nessuna modifica all\'engine del sito scende sul corpus** — ed è il corpus a',
    'renderizzare le pagine articolo, quindi ogni articolo pubblicato nel frattempo esce da un',
    'engine vecchio. È già successo: si è visto solo come `audit:footer-root-presence` passato',
    'da 23 a 3608 offender, senza nessuna CI rossa.',
    '',
    '## Le PR ferme',
    '',
  ];
  for (const pr of stalled) {
    lines.push(`- **#${pr.number}** — aperta da ${pr.ageHours.toFixed(1)}h${pr.title ? ` — ${pr.title}` : ''}`);
    if (pr.url) lines.push(`  - ${pr.url}`);
    if (pr.checks) lines.push(`  - check: ${pr.checks}`);
  }
  lines.push(
    '',
    '## Dove si ripara',
    '',
    'Quasi mai qui. Il branch `' + LOCKSTEP_BRANCH + '` è generato e force-pushato dal mirror',
    'del sito a ogni giro: una correzione fatta su questo repo viene sovrascritta al mirror',
    'successivo. Se i check sono rossi perché la lockstep REGREDISCE un fix corpus-side (è la',
    'forma della #205: `rss-feed-guid` che ributtava indietro il fix di #162/#182), il difetto',
    'è che l\'engine del sito è rimasto alla forma pre-fix — e va portato a monte, sul repo del',
    'sito, come è stato fatto con `valerielinc-ops/frontaliere-si-o-no#5584`.',
    '',
    'Da controllare in ordine:',
    '',
    '1. i check rossi della PR: se è un test di QUESTO repo a fallire, la verità sta qui e la',
    '   fix va sul sito;',
    '2. se i check sono verdi, il guasto è nel merge — vedi le run di',
    '   `.github/workflows/auto-merge-engine-lockstep.yml` (il merge vuole `GITHUB_PAT_NANAKO`,',
    '   non `GITHUB_TOKEN`: un merge con quest\'ultimo non farebbe partire `publish-api.yml` e',
    '   la superficie dati non verrebbe rigenerata).',
    '',
    'Questa issue si richiude da sola alla prima passata in cui non c\'è più una lockstep oltre',
    'soglia.',
  );
  if (runUrl) lines.push('', `Run che l'ha aperta: ${runUrl}`);
  return lines.join('\n');
}

/* c8 ignore start — da qui in giù è I/O: `gh` e la rete. */

function gh(args) {
  try {
    return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (err) {
    console.error(`[lockstep-stall-watch] gh ${args.slice(0, 3).join(' ')} → ${err.message}`);
    return null;
  }
}

function fetchLockstepPrs() {
  const repoFlag = process.env.GH_REPO ? ['--repo', process.env.GH_REPO] : [];
  const out = gh([
    'pr', 'list', ...repoFlag,
    '--head', LOCKSTEP_BRANCH,
    '--state', 'open',
    '--json', 'number,createdAt,url,title,statusCheckRollup',
  ]);
  if (out === null) return null; // errore ≠ «nessuna PR»: vedi main()
  let parsed;
  try {
    parsed = JSON.parse(out || '[]');
  } catch {
    return null;
  }
  return parsed.map((pr) => {
    const rollup = Array.isArray(pr.statusCheckRollup) ? pr.statusCheckRollup : [];
    const failed = rollup
      .filter((c) => ['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'ERROR'].includes(c.conclusion || c.state))
      .map((c) => c.name || c.context)
      .filter(Boolean);
    const pending = rollup.filter((c) => !c.conclusion && !c.state).length;
    const checks = failed.length
      ? `${failed.length} rossi → ${failed.slice(0, 6).join(', ')}`
      : pending
        ? `${pending} ancora in corso`
        : `${rollup.length} verdi (incaglio a check verdi: guarda l'auto-merge)`;
    return { number: pr.number, createdAt: pr.createdAt, url: pr.url, title: pr.title, checks };
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const thIdx = argv.indexOf('--threshold-hours');
  const thresholdHours =
    thIdx !== -1 && argv[thIdx + 1]
      ? Number(argv[thIdx + 1])
      : Number(process.env.LOCKSTEP_STALL_HOURS || DEFAULT_THRESHOLD_HOURS);
  if (!Number.isFinite(thresholdHours) || thresholdHours <= 0) {
    console.error(`[lockstep-stall-watch] soglia non valida: ${thresholdHours}`);
    process.exit(1);
  }

  const prs = fetchLockstepPrs();
  // FAIL-OPEN, e in modo asimmetrico: su errore di `gh` non si apre NIENTE (un
  // allarme fabbricato da un glitch API è peggio del silenzio, perché insegna a
  // ignorarlo) e soprattutto non si CHIUDE niente, perché «nessuna PR» e «non
  // sono riuscito a chiedere» sono indistinguibili da qui e la seconda
  // spegnerebbe un allarme ancora valido.
  if (prs === null) {
    console.error('[lockstep-stall-watch] impossibile leggere le PR di lockstep — nessuna azione.');
    process.exit(0);
  }

  const { stalled, oldestAgeHours } = findStalledLockstep({ prs, now: Date.now(), thresholdHours });
  const runUrl =
    process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
      ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : undefined;

  console.log(
    `[lockstep-stall-watch] PR aperte su ${LOCKSTEP_BRANCH}: ${prs.length}` +
      (oldestAgeHours === null ? '' : ` — la più vecchia da ${oldestAgeHours.toFixed(1)}h`) +
      ` — soglia ${thresholdHours}h → ${stalled.length} oltre soglia`,
  );

  if (!stalled.length) {
    if (dryRun) {
      console.log('[lockstep-stall-watch] dry-run: richiuderei l\'allarme, se aperto.');
      return;
    }
    resolveGithubIssue(STALL_ISSUE_TITLE, { workflow: 'lockstep-stall-watchdog', runUrl });
    return;
  }

  const body = buildStallBody({ stalled, thresholdHours, runUrl });
  if (dryRun) {
    console.log(`[lockstep-stall-watch] dry-run: aprirei "${STALL_ISSUE_TITLE}"\n\n${body}`);
    return;
  }
  await createGithubIssue({
    title: STALL_ISSUE_TITLE,
    description: body,
    priority: 2,
    labels: ['bug', 'automation'],
    workflow: 'lockstep-stall-watchdog',
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`[lockstep-stall-watch] ${err?.stack || err}`);
    process.exit(1);
  });
}
/* c8 ignore stop */
