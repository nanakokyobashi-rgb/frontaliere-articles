#!/usr/bin/env node
/**
 * needs-human-prepass.mjs — la metà deterministica dello sweep `needs-human`.
 *
 * Adattamento corpus del gemello del sito (manifest: `adapted`). La FORMA è
 * quella di `frontaliere-si-o-no/scripts/ci/needs-human-prepass.mjs`; il
 * CONTENUTO — le famiglie riconosciute — non è copiabile, perché i titoli li
 * scrivono i monitor di QUESTO repo e sono altri (vedi sotto).
 *
 * ## Il difetto, misurato qui
 *
 * `needs-human` è uno stato ASSORBENTE su questo repo: nessun workflow lo
 * riprende in mano. Il sito ha chiuso il buco il 2026-08-21 con
 * `needs-human-sweep.yml` + questo pre-pass; il corpus non ha mai ricevuto né
 * l'uno né l'altro — verificato il 2026-08-25: zero workflow che nominano
 * `needs-human` o `vision` sotto `.github/workflows/`.
 *
 * Cosa costa, misurato il 2026-08-25:
 *   - **17 issue aperte in `needs-human`**, la più ferma dal 2026-08-18;
 *   - e nello stesso momento la coda del ciclo è **VUOTA**: `agent:fix-queued`
 *     0, `agent:decompose-queued` 0, `agent:fix` 0, PR aperte 0, con ~105 PR
 *     mergiate negli ultimi 7 giorni (≈15/giorno).
 *
 * Cioè: il fixer autonomo gira a vuoto mentre 17 issue sono parcheggiate in uno
 * stato da cui nessuno le tira fuori. Non è una coda satura, è un'uscita che non
 * esiste.
 *
 * ## Perché una ALLOWLIST e non una denylist
 *
 * La direzione dell'errore non è simmetrica. Ri-accodare per sbaglio una
 * decisione del proprietario significa far implementare al fixer una scelta che
 * non gli spetta. Lasciare per sbaglio una tecnica al run Claude costa invece
 * una sola azione del suo cap.
 *
 * Quindi si riconoscono POSITIVAMENTE le famiglie generate dai NOSTRI monitor, e
 * tutto il resto resta dov'è. Una famiglia nuova non viene drenata finché
 * qualcuno non la aggiunge qui — che è il modo giusto di sbagliare, perché il run
 * Claude la prende comunque.
 *
 * ## Cosa NON è copiabile dal sito
 *
 * 1. **Le famiglie.** Il sito riconosce `[crawler-health]`, `App Error:`,
 *    `PostHog Exception:`, `CWV regression` — monitor che qui non esistono. I
 *    monitor di questo repo sono altri e i titoli stanno nei loro sorgenti
 *    (citati uno per uno accanto a ogni pattern), non in una lista inventata.
 * 2. **La famiglia PAT, che qui è OWNER-ONLY.** Il sito instrada la sua
 *    identità con una GitHub App; qui il ciclo dipende da `GITHUB_PAT_NANAKO` in
 *    Remote Config, e `alert-pat-down.mjs` / `gh-pat-expiry-monitor.yml` aprono
 *    issue che **solo il proprietario può chiudere** (una rotazione di
 *    credenziale non è codice). Peggio: quando quell'alert è acceso il fixer
 *    stesso non ha il PAT, quindi ri-accodarla è futile per costruzione — e la
 *    rotazione è già stata **declinata dal proprietario il 2026-08-18**. È
 *    l'unica classe che questo file esclude in modo esplicito invece di lasciarla
 *    cadere nel default.
 * 3. **Il rilevatore di aggregati.** Il sito ne tiene uno suo
 *    (`AGGREGATE_TITLE_RE`). Qui ne esiste già uno esportato e testato,
 *    `isAggregate()` in `check-issue-already-resolved.mjs`, e la issue #568 dice
 *    che i rilevatori multi-item di questo repo hanno già una copertura
 *    incompleta. Aggiungerne un terzo divergente sarebbe esattamente il difetto
 *    che #568 descrive, e violerebbe il vincolo «una regex duplicata in ≥2 file
 *    va estratta in UN modulo» (AGENTS.md). Quindi si IMPORTA quello che c'è: se
 *    #568 lo migliora, questo pre-pass migliora con lui, gratis.
 */
import { execFileSync } from 'node:child_process';
import { isAggregate } from './check-issue-already-resolved.mjs';

const REPO = process.env.GH_REPO || process.env.GITHUB_REPOSITORY || '';
const DRY = process.argv.includes('--dry-run');

/**
 * Cap volutamente BASSO, e tarato sulla portata a valle, non sulla dimensione
 * della coda.
 *
 * Misurato il 2026-08-25 su questo repo: 105 PR mergiate in 7 giorni (≈15 al
 * giorno), la stessa portata del sito — quindi vale lo stesso numero, per la
 * stessa ragione: immettere più di ~10 issue al giorno riempirebbe la coda più
 * in fretta di quanto la si svuota, e sopra ~5 PR aperte i merge rallentano da
 * soli. Con 17 `needs-human` e la coda oggi a zero, 10/giorno le fa rientrare
 * tutte in due giorni.
 */
const MAX_PER_RUN = Number(process.env.PREPASS_MAX_PER_RUN || 10);

/**
 * Le famiglie di issue APERTE DA UN MONITOR DI QUESTO REPO, riconosciute sul
 * titolo.
 *
 * Ognuna è un titolo che scrive un nostro script, non una persona: il prefisso è
 * parte del contratto di dedup di chi le apre (il taglio a 60 caratteri sul
 * titolo canonico, `DEDUP_TITLE_PREFIX_LEN` in `scripts/lib/github-issue-creator.mjs`),
 * quindi è stabile e non è un'euristica sul linguaggio.
 *
 * La sorgente di ogni pattern è citata accanto: se un monitor cambia titolo, è
 * lì che si va a guardare.
 */
export const MONITOR_TITLE_PATTERNS = [
  /^Workflow Failure:/i, //           scripts/ci/scan-failed-runs.mjs, .github/workflows/lessons-harvester.yml
  /^CI Failure:/i, //                 famiglia coperta da scripts/ci/close-recovered-failure-issues.mjs
  /^Crawler Failure:/i, //            CRAWLER_FAILURE_TITLE_PREFIX in scripts/lib/github-issue-creator.mjs
  /^follow-up\(#\d+\):/i, //          .github/workflows/post-merge-followup.yml
  /^Watchdog generazione\b/i, //      scripts/ci/scan-generation-health.mjs (globali + per-sezione)
  /^Watchdog news-ticker:/i, //       TITLE in scripts/ci/ticker-shadow-alert.mjs
  /^Roster LLM invecchiato:/i, //     scripts/ci/scan-generation-health.mjs
  /^Loop drift:/i, //                 scripts/ci/loop-drift-check.mjs
  /^gate content su main:/i, //       TITLE in scripts/ci/content-gates-main.mjs
  /^Lockstep engine incagliata:/i, // STALL_ISSUE_TITLE in scripts/ci/lockstep-stall-watch.mjs
];

/**
 * Le famiglie che un monitor apre ma che il ciclo NON può chiudere: rotazione di
 * credenziali. Restano `needs-human` per costruzione, non per omissione.
 *
 * Non basta lasciarle cadere nel default `keep`: sono aperte da un nostro
 * monitor con un prefisso stabile, quindi un domani qualcuno le aggiungerebbe
 * all'allowlist qui sopra ragionando «è un nostro script, quindi è tecnica». Il
 * fatto che il ciclo non possa agirci va scritto, non dedotto.
 */
export const OWNER_ONLY_TITLE_PATTERNS = [
  /^Agent loop down: GITHUB_PAT/i, // PAT_DOWN_TITLE in scripts/ci/alert-pat-down.mjs
  /^GH_PAT expiry warning:/i, //      .github/workflows/gh-pat-expiry-monitor.yml
];

/**
 * Verdetti che il 2026-08-24 hanno smesso di essere blocchi di capacità.
 *
 * `blocked-secrets`: il proprietario ha autorizzato in modo permanente l'uso dei
 * secret (registro in `VISION.md` del sito), e qui `issue-fix.yml` carica Remote
 * Config prima del run Claude (step «Load secrets from Remote Config» →
 * `generator/scripts/load-rc-env.mjs`). Un verdetto emesso prima di quella data
 * descrive una configurazione che non esiste più, quindi la issue è lavoro
 * normale.
 *
 * `blocked-workflows-scope` NON è qui: dipende dal fatto che
 * `GITHUB_PAT_NANAKO` sia stato caricato in QUEL run, che è una condizione
 * runtime e non una decisione superata. Lo valuta il run Claude.
 */
export const STALE_BLOCK_VERDICTS = new Set(['blocked-secrets']);

const FIX_OUTCOME_RE = /<!--\s*FIX_OUTCOME:\s*([a-z0-9-]+)\s*-->/i;

/** Ultimo verdetto da una lista di commenti (forma REST o GraphQL). Pura. */
export function latestVerdict(comments) {
  let latest = null;
  let at = -Infinity;
  for (const c of comments || []) {
    const m = FIX_OUTCOME_RE.exec(String(c?.body || ''));
    if (!m) continue;
    const t = Date.parse(c?.created_at ?? c?.createdAt);
    if (!Number.isNaN(t) && t >= at) { at = t; latest = m[1].toLowerCase(); }
  }
  return latest;
}

/**
 * La decisione, dal solo titolo + labels + ultimo verdetto. Pura → testabile.
 *
 * `keep` è il default e non un ramo di errore: significa «non so dirlo senza
 * giudizio», e il run Claude dello sweep è il posto dove quel giudizio si dà.
 *
 * Il body NON è un input, deliberatamente: vedi la nota su `isAggregate` più
 * sotto. La decisione si prende su ciò che è contrattuale (titolo, label,
 * marker di verdetto), non sulla prosa.
 *
 * @param {{title?: string, labels?: string[], verdict?: string|null}} iss
 * @returns {{action: 'requeue'|'decompose'|'keep', reason: string}}
 */
export function prepassDecision({ title = '', labels = [], verdict = null } = {}) {
  // Un tracker permanente è aperto per scelta: non si accoda e non si scorpora.
  if (labels.includes('agent:no-age-out')) return { action: 'keep', reason: 'tracker permanente' };
  // Già in volo da qualche parte: non si tocca.
  for (const l of ['agent:fix', 'agent:fix-queued', 'agent:decompose', 'agent:decompose-queued', 'agent:in-progress']) {
    if (labels.includes(l)) return { action: 'keep', reason: `già in lavorazione (${l})` };
  }

  // PRIMA del verdetto: una rotazione di credenziale resta del proprietario
  // qualunque cosa un fixer abbia registrato passando di lì.
  const ownerOnly = OWNER_ONLY_TITLE_PATTERNS.find((re) => re.test(title));
  if (ownerOnly) {
    return { action: 'keep', reason: 'famiglia credenziali: la chiude solo il proprietario (rotazione declinata il 2026-08-18)' };
  }

  if (verdict && STALE_BLOCK_VERDICTS.has(verdict)) {
    return { action: 'requeue', reason: `verdetto \`${verdict}\` superato dalla decisione del 2026-08-24 sui secret` };
  }

  const monitor = MONITOR_TITLE_PATTERNS.find((re) => re.test(title));
  if (!monitor) return { action: 'keep', reason: 'famiglia non riconosciuta: la valuta il run Claude' };

  // Un container con più target si scorpora: ri-accodarlo intero è il modo
  // documentato di rifare `max-turns`. Il rilevatore è quello CONDIVISO di
  // `check-issue-already-resolved.mjs` — vedi l'intestazione, punto 3.
  //
  // Gli si passa il SOLO TITOLO, e non è un dettaglio: il suo fallback a parole
  // chiave (`sweep|batch|bulk`) esiste per gli aggregati che non dichiarano un
  // conteggio *nel titolo* («Sweep: ~30 crawlers»), e su un body lungo diventa
  // un falso positivo. Misurato il 2026-08-25 sulle 17 `needs-human` di questo
  // repo: passando anche il body, TRE issue finivano in `decompose` per la sola
  // parola «batch» capitata nel testo — #170 «Workflow Failure: Post-merge
  // follow-up triage» (662 caratteri, un singolo guasto), #407 e #403 (~4.700
  // caratteri l'una). Nessuna delle tre dichiarava un conteggio di item.
  //
  // Col titolo soltanto quelle tre tornano `requeue`, ed è la direzione giusta
  // dell'errore: un aggregato non riconosciuto viene semplicemente lavorato dal
  // fixer normale, mentre uno scorporo inventato brucia un run di decomposizione
  // e crea sub-issue che non corrispondono a niente. Che i titoli multi-item di
  // QUESTO repo («A + B + C») sfuggano al rilevatore è noto ed è precisamente
  // l'oggetto della issue #568: quando quella si chiude, questo pre-pass ne
  // eredita il miglioramento senza modifiche, ed è il motivo per cui il
  // rilevatore è importato invece che riscritto.
  if (isAggregate(title, '')) {
    return { action: 'decompose', reason: 'container multi-item generato da un monitor' };
  }
  return { action: 'requeue', reason: `famiglia di monitor riconosciuta (${monitor})` };
}

function gh(args, { json = true } = {}) {
  const out = execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return json ? JSON.parse(out) : out;
}

function main() {
  if (!REPO) { console.log('needs-human-prepass: nessun repo risolvibile → niente da fare.'); return; }
  let issues = [];
  try {
    issues = gh(['issue', 'list', '--repo', REPO, '--state', 'open', '--label', 'needs-human',
      '--json', 'number,title,labels,updatedAt', '--limit', '300']);
  } catch (e) {
    console.log(`::warning::needs-human-prepass: elenco non leggibile (${String(e).slice(0, 100)}) → nessuna azione.`);
    return;
  }
  console.log(`needs-human-prepass — repo ${REPO}, ${issues.length} issue \`needs-human\`${DRY ? ' [DRY-RUN]' : ''}`);

  // Le più stantie prima: sono quelle che aspettano da più tempo, e il cap non
  // deve tagliarle sempre. `gh issue list` ordina dalla più recente.
  const ordered = [...issues].sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt));

  const counts = { requeue: 0, decompose: 0, keep: 0 };
  let acted = 0;
  for (const iss of ordered) {
    const labels = (iss.labels || []).map((l) => l.name);
    // Il verdetto costa una lettura: si paga SOLO quando il titolo non basta,
    // cioè quando la famiglia non è riconosciuta e la issue finirebbe in `keep`.
    let verdict = null;
    if (!MONITOR_TITLE_PATTERNS.some((re) => re.test(iss.title))) {
      try {
        const cs = gh(['api', `repos/${REPO}/issues/${iss.number}/comments?per_page=100`, '--paginate']);
        verdict = latestVerdict(Array.isArray(cs) ? cs : []);
      } catch { verdict = null; }
    }
    const d = prepassDecision({ title: iss.title, labels, verdict });
    counts[d.action]++;
    if (d.action === 'keep') continue;

    if (acted >= MAX_PER_RUN) {
      console.log(`needs-human-prepass: cap ${MAX_PER_RUN}/run raggiunto → il resto al prossimo giro (no silent cap).`);
      break;
    }
    acted++;
    const add = d.action === 'requeue' ? 'agent:fix-queued' : 'agent:decompose-queued';
    if (DRY) { console.log(`[dry] #${iss.number} → ${add} (${d.reason}) — "${iss.title.slice(0, 60)}"`); continue; }
    const note = `🔁 **Pre-pass deterministico dello sweep (zero-Claude)**: ${d.reason}. Questa issue non contiene una decisione del proprietario — i driver di decisione stanno in \`VISION.md\` del sito (\`valerielinc-ops/frontaliere-si-o-no\`, sorgente unica) — quindi torna nel ciclo autonomo invece di occupare un'azione del cap del run Claude.`;
    try {
      gh(['issue', 'comment', String(iss.number), '--repo', REPO, '--body', note], { json: false });
      gh(['issue', 'edit', String(iss.number), '--repo', REPO,
        '--add-label', add, '--remove-label', 'needs-human', '--remove-label', 'fu-parked'], { json: false });
      console.log(`PREPASS #${iss.number} → ${add} (${d.reason})`);
    } catch (e) {
      console.log(`::warning::needs-human-prepass: #${iss.number} non instradata (${String(e).slice(0, 100)}).`);
    }
  }
  console.log(`needs-human-prepass: requeue=${counts.requeue} decompose=${counts.decompose} keep=${counts.keep} (azioni eseguite: ${acted}).`);
}

if (process.argv[1] && process.argv[1].endsWith('needs-human-prepass.mjs')) main();
