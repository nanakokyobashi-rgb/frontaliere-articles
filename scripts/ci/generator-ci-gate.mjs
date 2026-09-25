/**
 * generator-ci-gate.mjs — porta il verdetto di `generator-ci.yml` DENTRO il
 * check-run richiesto dal ruleset (zero-Claude).
 *
 * ## Perche' serve esattamente ora
 *
 * Finche' il merge lo decideva il workflow dell'auto-merge su LGTM, quello leggeva
 * DUE check: `tests` e — solo per le PR che toccano i path di `generator-ci` —
 * il check-run `test` di quel workflow. Con l'auto-merge NATIVO il ruleset puo'
 * richiedere solo contesti che esistono su OGNI PR: mettere `test` fra i
 * required bloccherebbe per sempre ogni PR che non tocca `generator/`, perche'
 * quel check non verrebbe mai prodotto (e' lo stesso modo di rompersi che ha
 * fatto nascere `tests.yml`: «no checks reported», la PR non fallisce, resta
 * ferma).
 *
 * Quindi il gate condizionale torna dov'era la decisione: uno step del job che
 * PRODUCE il check richiesto. Se la PR non tocca quei path, esce 0 senza
 * leggere nulla; se li tocca, aspetta che `generator-ci` concluda e pretende
 * `success`.
 *
 * ## Perche' aspetta invece di leggere e basta
 *
 * I due workflow partono insieme. `tests` contiene la review Claude e finisce
 * quasi sempre dopo, ma «quasi sempre» non e' un invariante: su una PR con la
 * review saltata dal carry-forward questo job dura un minuto. Leggere e basta
 * significherebbe leggere `pending` e — per non bloccare — lasciar passare, che
 * e' esattamente il buco che questo gate esiste per chiudere. Si aspetta, con
 * un tetto.
 *
 * Il tetto SCADUTO e' rosso, non verde: un `generator-ci` che non conclude in
 * mezz'ora e' un problema, e il merge non deve avvenire su un ignoto.
 *
 * Gate sul solo job `test` (`GENERATOR_CI_JOB_NAME`), come faceva
 * `auto-merge-eval.mjs`: il job `dry-run` fa rete (CDN, WAF) ed e' storicamente
 * il piu' rumoroso: promuoverlo a bloccante e' una decisione separata da questa
 * migrazione, non un effetto collaterale.
 *
 * ## Perche' un `cancelled` non e' un verdetto (e non deve essere rosso)
 *
 * Un SHA porta piu' check-run con lo stesso nome `test`: `generator-ci.yml` ha
 * `concurrency: cancel-in-progress`, quindi una push ravvicinata lascia sullo
 * STESSO commit un run cancellato dopo pochi secondi PIU' il run rimpiazzo che
 * lo sostituisce. Osservato su PR #1275: `test` cancelled alle 02:42:19 (1s di
 * vita) e `test` success alle 02:45:10, entrambi sulla head. Questo gate girava
 * alle 02:44, quando l'unico check-run COMPLETATO era la cancellazione: la
 * leggeva come conclusion non-success e usciva 1 subito, senza mai arrivare al
 * verdetto vero che stava per atterrare 80 secondi dopo.
 *
 * Il ramo `cancelled` di `vitestCheck.mjs` documenta gia' la ragione di fondo:
 * un run cancellato «non ha prodotto NESSUN verdetto sul codice». Trattarlo
 * come fallimento non e' severita', e' un falso rosso — e per un gate il cui
 * mestiere e' ATTENDERE un verdetto, la risposta giusta a «verdetto non ancora
 * prodotto» e' continuare ad attendere, non concludere.
 *
 * Il gate NON si indebolisce: `failure`/`timed_out`/`action_required` restano
 * rossi immediati, e se dalla head non arriva mai altro che cancellazioni il
 * tetto scade e il verdetto e' comunque ROSSO (nessun merge su uno stato
 * ignoto). L'unica cosa che smette di accadere e' scambiare il rumore della
 * concurrency per un contratto rotto.
 *
 * ## Quanto costa aspettare (2026-09-25)
 *
 * Ogni lettura dei check-run spende una richiesta del bucket REST del
 * `GITHUB_TOKEN`, 1.000 l'ora per TUTTO il repo. Il polling a 20 s costava fino
 * a 90 letture per run nei 30 minuti del tetto, ed e' uno dei consumatori che il
 * 2026-09-25 hanno esaurito il bucket (06:58-07:10 UTC, gate rossi su PR
 * sane). Ora la prima lettura e' immediata e le successive distano 60 s,
 * crescendo di 1,5x fino a 120 s (`pollDelayMs`): al massimo ~17 letture nel
 * tetto. L'ultima attesa e' tagliata sulla scadenza, quindi il verdetto finale
 * si legge ancora esattamente alla scadenza: la semantica del tetto non cambia.
 *
 * Le letture passano da `lib/gh-rate-limit.mjs`: un 403 da rate limit primario
 * attende il reset (entro 15 min e mai oltre la scadenza del gate) e riprova una
 * volta; altrimenti il gate esce ROSSO nominando il rate limit e il reset,
 * invece di scambiarlo per «file illeggibili» o per un `generator-ci` lento.
 *
 * Uso:  node scripts/ci/generator-ci-gate.mjs
 * Env:  GH_TOKEN, GITHUB_REPOSITORY, PR_NUMBER, HEAD_SHA,
 *       GENERATOR_CI_GATE_TIMEOUT_MS (opzionale, default 30 min)
 * Exit: 0 non applicabile o success · 1 fallito/pending oltre il tetto
 */
import { touchesGeneratorCiPaths } from './auto-merge-eval.mjs';
import { GENERATOR_CI_JOB_NAME } from './lib/constants.mjs';
import { latestCompletedConclusionByName } from './lib/vitestCheck.mjs';
import {
  GitHubRateLimitError,
  ghWithRateLimitRetry,
  RATE_LIMIT_MAX_WAIT_MS,
} from './lib/gh-rate-limit.mjs';

/**
 * Conclusion che NON sono un verdetto sul codice, ma l'assenza di un verdetto.
 *
 * Solo `cancelled`, di proposito: e' l'unica che GitHub produce senza aver
 * eseguito il contratto (concurrency `cancel-in-progress`, runner shutdown).
 * `failure`, `timed_out`, `action_required` e `stale` restano verdetti rossi —
 * `vitestCheck.mjs` elenca proprio quelle quattro come «failure reali».
 */
export const NON_VERDICT_CONCLUSIONS = new Set(['cancelled']);

/**
 * Il verdetto di `generator-ci` sulla head: come
 * `latestCompletedConclusionByName`, ma una conclusione che non porta un
 * verdetto (`NON_VERDICT_CONCLUSIONS`) viene restituita come attesa. La run
 * cancellata PARTECIPA alla selezione della generazione: scartarla prima
 * permetterebbe a un `success` stantio di vincere sul replacement più recente.
 *
 * Il selettore generazionale decide prima quale run è corrente. Solo dopo la
 * selezione una cancellazione viene convertita in `''`: un `cancelled` che
 * arriva dopo un `success` non può quindi riutilizzare il verdetto vecchio, e
 * un `cancelled` che arriva prima non anticipa un verdetto che deve ancora
 * concludere.
 *
 * @param {Array<{name?: string, status?: string, conclusion?: string, completed_at?: string}>} checkRuns
 * @param {string} name
 * @returns {string} la conclusion piu' fresca fra quelle che sono un verdetto,
 *   o '' se nessun verdetto e' ancora atterrato (il chiamante attende).
 */
export function generatorCiVerdict(checkRuns, name) {
  const conclusion = latestCompletedConclusionByName(checkRuns, name);
  if (!NON_VERDICT_CONCLUSIONS.has(conclusion)) return conclusion;

  // Una cancellazione rende stantio un success precedente, ma non deve
  // mascherare una failure gia' osservata: mantenere il rosso conserva il
  // comportamento fail-closed del gate mentre si attende un replacement.
  const previousConclusion = latestCompletedConclusionByName(
    Array.isArray(checkRuns)
      ? checkRuns.filter((checkRun) => !NON_VERDICT_CONCLUSIONS.has(checkRun?.conclusion))
      : [],
    name,
  );
  return previousConclusion && previousConclusion !== 'success' ? previousConclusion : '';
}

/** Prima attesa fra due letture dei check-run, poi backoff fino al tetto. */
export const POLL_BASE_MS = 60_000;
export const POLL_MAX_MS = 120_000;
const POLL_FACTOR = 1.5;

/**
 * Attesa prima della lettura `attempt + 1` (0 = dopo la prima lettura),
 * tagliata sulla scadenza: l'ultima lettura cade esattamente sul tetto, come
 * con il polling fisso. Pura.
 */
export function pollDelayMs(attempt, { nowMs, deadlineMs } = {}) {
  const step = Math.min(POLL_MAX_MS, Math.round(POLL_BASE_MS * POLL_FACTOR ** Math.max(0, attempt)));
  if (!Number.isFinite(nowMs) || !Number.isFinite(deadlineMs)) return step;
  return Math.max(0, Math.min(step, deadlineMs - nowMs));
}

const REPO = process.env.GITHUB_REPOSITORY || '';
const PR = process.env.PR_NUMBER || '';
const HEAD_SHA = process.env.HEAD_SHA || '';
const TIMEOUT_MS = Number(process.env.GENERATOR_CI_GATE_TIMEOUT_MS || 30 * 60 * 1000);

function gh(args, { json = true, maxWaitMs = RATE_LIMIT_MAX_WAIT_MS } = {}) {
  const out = ghWithRateLimitRetry(args, { context: 'generator-ci-gate', maxWaitMs });
  return json ? JSON.parse(out) : out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!REPO || !PR || !HEAD_SHA) {
    console.log('::error::generator-ci-gate: GITHUB_REPOSITORY, PR_NUMBER e HEAD_SHA sono obbligatori.');
    process.exit(1);
  }
  let files;
  try {
    files = gh(['api', `repos/${REPO}/pulls/${PR}/files`, '--paginate', '--jq', '.[].filename'], {
      json: false,
    })
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  } catch (e) {
    // Conservativo: senza la lista file non so se il gate si applica, e non
    // posso escluderlo. Rosso, non verde per default. Un rate limit ha gia'
    // la sua annotation (causa + reset) scritta dall'helper.
    const cause = e instanceof GitHubRateLimitError ? 'rate limit del token' : String(e).slice(0, 160);
    console.log(`::error::generator-ci-gate: file della PR illeggibili (${cause}).`);
    process.exit(1);
  }
  if (!touchesGeneratorCiPaths(files)) {
    console.log("generator-ci-gate: la PR non tocca i path di generator-ci.yml — gate non applicabile.");
    process.exit(0);
  }
  console.log(
    `generator-ci-gate: la PR tocca i path di generator-ci.yml — attendo il check-run '${GENERATOR_CI_JOB_NAME}' sulla head ${HEAD_SHA}.`,
  );

  const deadline = Date.now() + TIMEOUT_MS;
  let last = '';
  for (let attempt = 0; ; attempt += 1) {
    let checkRuns = [];
    try {
      // Stessa forma di `auto-merge-eval.mjs`: la risposta e' un oggetto con
      // `check_runs`, non un array. `--paginate` + `--jq` qui non servono (100
      // check-run per commit sono un tetto che questo repo non avvicina) e
      // cambierebbero la forma della risposta sotto ai lettori.
      // L'attesa di un reset non puo' superare la scadenza del gate: oltre,
      // il rosso nomina il rate limit e il rescuer rilancia dopo il reset.
      const cr = gh(['api', `repos/${REPO}/commits/${HEAD_SHA}/check-runs?per_page=100`], {
        maxWaitMs: Math.max(0, Math.min(RATE_LIMIT_MAX_WAIT_MS, deadline - Date.now())),
      });
      checkRuns = (cr && cr.check_runs) || [];
    } catch (e) {
      if (e instanceof GitHubRateLimitError) {
        console.log(`::error::generator-ci-gate: check-run di '${GENERATOR_CI_JOB_NAME}' illeggibili per rate limit del token — nessun merge su uno stato ignoto.`);
        process.exit(1);
      }
      console.log(`generator-ci-gate: check-runs illeggibili (${String(e).slice(0, 120)}) — riprovo.`);
    }
    const conclusion = generatorCiVerdict(checkRuns, GENERATOR_CI_JOB_NAME);
    if (conclusion === 'success') {
      console.log(`generator-ci-gate: '${GENERATOR_CI_JOB_NAME}' = success ✔`);
      process.exit(0);
    }
    if (conclusion && conclusion !== 'success') {
      console.log(
        `::error::generator-ci-gate: '${GENERATOR_CI_JOB_NAME}' = ${conclusion} sulla head ${HEAD_SHA} — la PR tocca engine/host/generator e quel contratto non regge.`,
      );
      process.exit(1);
    }
    if (Date.now() >= deadline) {
      console.log(
        `::error::generator-ci-gate: '${GENERATOR_CI_JOB_NAME}' non ha concluso entro ${Math.round(TIMEOUT_MS / 60000)} minuti (ultimo stato: ${last || 'nessun check-run'}) — nessun merge su uno stato ignoto.`,
      );
      process.exit(1);
    }
    last = checkRuns
      .filter((c) => c?.name === GENERATOR_CI_JOB_NAME)
      .map((c) => `${c.status}/${c.conclusion ?? '-'}`)
      .join(',');
    const delay = pollDelayMs(attempt, { nowMs: Date.now(), deadlineMs: deadline });
    console.log(`generator-ci-gate: ancora in corso (${last || 'nessun check-run'}) — ricontrollo fra ${Math.round(delay / 1000)}s.`);
    await sleep(delay);
  }
}

if (process.argv[1]?.endsWith('generator-ci-gate.mjs')) {
  main();
}
