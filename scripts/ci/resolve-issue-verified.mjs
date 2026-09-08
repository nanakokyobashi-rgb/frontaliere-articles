#!/usr/bin/env node
/**
 * resolve-issue-verified.mjs — chiudere un'issue e VERIFICARE che sia chiusa.
 *
 * ## Il difetto che ripara (issue #1005, item 3 di #920)
 *
 * Ogni chiuditore di questo repo e' best-effort, e i tre strati si coprono a
 * vicenda:
 *
 *   · `resolveGithubIssue` chiama `gh issue close` con `allowFailure: true`
 *     (`scripts/lib/github-issue-creator.mjs`), quindi un rifiuto — permessi,
 *     rate-limit, 5xx — diventa una riga su stderr;
 *   · il ramo CLI `--resolve` fa `process.exit(0)` SEMPRE;
 *   · il valore di ritorno `null` significa insieme «non c'era niente da
 *     chiudere» e «la chiusura e' stata respinta»: chi lo legge non puo'
 *     distinguerli.
 *
 * Gli step che chiamano quel percorso girano sotto `continue-on-error: true` o
 * senza `set -e`. La somma e' la classe «non si rompe, non fa»: la run resta
 * VERDE, non c'e' ritentativo, e l'issue resta aperta con un elenco ormai falso
 * fino a un prossimo run che ritrovi la stessa condizione — che puo' non
 * arrivare presto.
 *
 * ## La cura: la POST-CONDIZIONE, non l'exit code del chiuditore
 *
 * Questo wrapper non si fida di chi chiude. Dopo il tentativo RILEGGE lo stato
 * dell'issue, ritenta una volta, e se e' ancora aperta emette `::error::` ed
 * esce non-zero. Lo step diventa rosso con annotazione; dove serve, il
 * `continue-on-error: true` del chiamante tiene il JOB verde esattamente come
 * oggi — il segnale compare, l'esito del job non cambia e nessuna Workflow
 * Failure viene fabbricata.
 *
 * Due asimmetrie deliberate:
 *
 *   · uno stato NON LEGGIBILE conta come «ancora aperta», mai come «chiusa».
 *     E' la stessa direzione del guard sulle query in `recycle-stale-prs.yml`
 *     (#981): una lista vuota per un errore non e' «nessun residuo».
 *   · la verifica legge la REST list / l'issue per NUMERO, mai
 *     `search/issues`: l'indice di ricerca e' in ritardo e direbbe «ancora
 *     aperta» proprio subito dopo una chiusura riuscita — un falso rosso
 *     ricorrente, che e' il modo piu' rapido per far ignorare un'annotazione.
 *
 * ## Uso
 *
 *   node scripts/ci/resolve-issue-verified.mjs --number 123 [--comment "..."]
 *   node scripts/ci/resolve-issue-verified.mjs --title "..." [--workflow W] [--run-url U]
 *
 * `--number` per il chiamante che il numero ce l'ha gia' (il digest di
 * `recycle-stale-prs.yml` lo risolve da se' con l'uguaglianza esatta sul
 * titolo, #1003). `--title` per i chiamanti che passavano da `--resolve`: la
 * ricerca resta quella di `resolveGithubIssue` (match per PREFISSO
 * sanitizzato), perche' cambiarla qui cambierebbe QUALE issue viene chiusa —
 * un'altra modifica, non questa. La verifica riusa `searchSafePrefix`, cioe'
 * la stessa sorgente della chiave (AGENTS.md #6), e non una seconda copia.
 *
 * Solo builtin Node piu' la lib del repo: `scripts/ci/**` gira senza `npm ci`.
 */
import { spawnSync } from 'node:child_process';

import { resolveGithubIssue, searchSafePrefix } from '../lib/github-issue-creator.mjs';
import { pinnedBy } from './manifest-pinned-issues.mjs';

const REPO = process.env.GH_REPO || process.env.GITHUB_REPOSITORY || '';

/** `gh` con l'esito ESPLICITO: chi chiama qui deve poter distinguere. */
export function runGh(args, { run = defaultRun, env } = {}) {
  const res = run(args, env);
  return { ok: res.status === 0, stdout: (res.stdout || '').trim(), stderr: (res.stderr || '').trim() };
}

function defaultRun(args, env) {
  return spawnSync('gh', args, { encoding: 'utf8', env: env || process.env });
}

function repoArgs() {
  return REPO ? ['--repo', REPO] : [];
}

/**
 * Lo stato di un'issue, letta per NUMERO: `'open'` | `'closed'` | `null`
 * (non leggibile). Il `null` NON e' «chiusa», ed e' il chiamante a saperlo.
 */
export function readIssueState(number, deps = {}) {
  const { ok, stdout } = runGh(['issue', 'view', String(number), '--json', 'state', '--jq', '.state', ...repoArgs()], deps);
  if (!ok) return null;
  const state = stdout.toLowerCase();
  return state === 'open' || state === 'closed' ? state : null;
}

/**
 * I numeri delle issue APERTE il cui titolo comincia con `prefix`.
 * `null` quando la query non e' leggibile — di nuovo, non «nessuna».
 *
 * REST list e non `search/issues` (indice in ritardo) e non `gh issue list
 * --limit N`, che TRONCA IN SILENZIO: un troncamento qui direbbe «nessuna
 * residua» su un backlog che ne ha, cioe' esattamente la bugia che il wrapper
 * esiste per impedire.
 */
export function findOpenByPrefix(prefix, deps = {}) {
  const { ok, stdout } = runGh([
    'api', '--paginate', `repos/${REPO}/issues?state=open&per_page=100`,
    '--jq', '.[] | select(.pull_request | not) | select(.title | startswith(env.RESOLVE_PREFIX)) | .number',
  ], { ...deps, env: { ...process.env, RESOLVE_PREFIX: prefix } });
  if (!ok) return null;
  return stdout.split('\n').map((l) => l.trim()).filter(Boolean).map(Number);
}

/**
 * Le issue che il manifest tiene aperte APPOSTA: il `trackingIssue` di una
 * voce `corpus-only-pending` e' il promemoria che il gemello sul sito non c'e'
 * ancora, e chiuderlo cancellerebbe l'unica traccia di lavoro mancante. Un
 * chiuditore corpus-owned deve consultarli (guard in
 * generator/tests/manifest-pinned-issues.test.mjs); qui il pin non e' un
 * guasto, e' un «non si chiude» — quindi non produce annotazione.
 */
function pinOf(number, deps) {
  if (deps.pinnedBy) return deps.pinnedBy(number, REPO);
  return pinnedBy(number, REPO);
}

/** Chiude un numero preciso. Usata sia dal ramo `--number` sia dal fallback. */
function closeNumber(number, comment, deps) {
  const args = ['issue', 'close', String(number), ...(comment ? ['--comment', comment] : []), ...repoArgs()];
  const { ok, stderr } = runGh(args, deps);
  if (!ok && stderr) console.error(stderr);
}

/** Il ramo `--number`: chiudi, poi rileggi lo stato di QUEL numero. */
function numberMode({ number, comment }, deps) {
  const attempt = () => closeNumber(number, comment, deps);
  const verify = () => {
    const state = readIssueState(number, deps);
    // Non leggibile => trattata come aperta: il rosso su uno stato ignoto
    // costa un'annotazione, il verde su uno stato ignoto costa il segnale.
    return { done: state === 'closed', detail: state === null ? 'stato non leggibile' : `stato=${state}` };
  };
  return { attempt, verify, subject: `#${number}` };
}

/** Il ramo `--title`: chiudi via `resolveGithubIssue`, poi rileggi la LISTA. */
function titleMode({ title, workflow, runUrl }, deps) {
  const prefix = searchSafePrefix(title);
  // Il chiuditore e' iniettabile per lo stesso motivo di `run`: un test deve
  // poter esercitare i rami «respinto» e «no-op» senza una rete.
  const close = deps.resolve || resolveGithubIssue;
  const attempt = () => {
    // `resolveGithubIssue` sceglie da se' QUALE issue chiudere (primo match per
    // prefisso) e non sa niente dei pin. Finche' nessun candidato e' pinnato la
    // delega e' esatta e la semantica di ricerca resta quella di sempre; se un
    // candidato e' pinnato si chiude per NUMERO, che e' l'unico modo di essere
    // certi di non toccare proprio quello.
    const open = findOpenByPrefix(prefix, deps) || [];
    const pinned = open.filter((n) => pinOf(n, deps));
    if (pinned.length === 0) { close(title, { workflow, runUrl }); return; }
    for (const n of pinned) console.log(`[resolve-verified] #${n} e' pinnata dal manifest (${pinOf(n, deps)}): non la chiudo.`);
    for (const n of open.filter((n) => !pinOf(n, deps))) closeNumber(n, undefined, deps);
  };
  const verify = () => {
    const open = findOpenByPrefix(prefix, deps);
    if (open === null) return { done: false, detail: 'query di verifica non leggibile' };
    // Una pinnata non e' un residuo: resta aperta per costruzione, e contarla
    // come tale darebbe un rosso a ogni run — cioe' un'annotazione che si
    // impara a ignorare.
    const residual = open.filter((n) => !pinOf(n, deps));
    // Vuota = post-condizione soddisfatta, e copre ANCHE il no-op legittimo
    // («non c'era niente da chiudere»): il `null` ambiguo di resolveGithubIssue
    // qui e' gia' stato disambiguato dallo stato reale del repo.
    return { done: residual.length === 0, detail: `ancora aperte: ${residual.map((n) => `#${n}`).join(', ')}` };
  };
  return { attempt, verify, subject: `titolo "${prefix}"` };
}

export function resolveVerified(opts, deps = {}) {
  if (opts.number) {
    const pin = pinOf(opts.number, deps);
    if (pin) {
      console.log(`[resolve-verified] #${opts.number} e' pinnata dal manifest (${pin}): non la chiudo, e non e' un guasto.`);
      return 0;
    }
  }
  const mode = opts.number ? numberMode(opts, deps) : titleMode(opts, deps);
  // Un solo ritentativo, non un ciclo: il guasto che questo wrapper deve
  // rendere visibile e' quello PERSISTENTE (permessi, token). Un ciclo lungo
  // trasformerebbe un rifiuto strutturale in minuti di attesa e poi nello
  // stesso rosso, e su un 5xx passeggero un secondo tentativo basta.
  for (let attemptNo = 1; attemptNo <= 2; attemptNo += 1) {
    mode.attempt();
    const { done, detail } = mode.verify();
    if (done) {
      console.log(`[resolve-verified] ${mode.subject}: chiusura verificata (tentativo ${attemptNo}).`);
      return 0;
    }
    if (attemptNo === 1) console.log(`[resolve-verified] ${mode.subject}: ${detail} — ritento una volta.`);
    else console.error(`::error::Chiusura NON verificata per ${mode.subject} (${detail}). Il close e stato respinto o non e osservabile: l'issue resta aperta con un contenuto ormai falso.`);
  }
  return 1;
}

function parseArgs(argv) {
  const get = (flag) => {
    const at = argv.indexOf(flag);
    return at === -1 ? undefined : argv[at + 1];
  };
  return {
    number: get('--number'),
    comment: get('--comment'),
    title: get('--title'),
    workflow: get('--workflow'),
    runUrl: get('--run-url'),
  };
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith('resolve-issue-verified.mjs');
if (invokedDirectly) {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.number && !opts.title) {
    console.error('::error::resolve-issue-verified: serve --number <n> oppure --title "..."');
    process.exit(1);
  }
  process.exit(resolveVerified(opts));
}
