#!/usr/bin/env node
/**
 * Chiude un'issue e verifica la post-condizione.
 *
 * `github-issue-creator.mjs --resolve` e' deliberatamente best-effort: il
 * close puo' essere rifiutato e la CLI esce comunque 0. Questo wrapper vive
 * dal lato del chiamante, dove si sa se la chiusura era necessaria, e rende
 * visibile un close che lascia l'issue aperta: rilegge lo stato, ritenta una
 * volta e poi emette un'annotazione `::error::` con exit non-zero.
 *
 * La verifica usa la REST list paginata per i call-site che conoscono solo un
 * titolo e `gh issue view` per numero per il digest, evitando l'indice di
 * ricerca eventualmente in ritardo. Uno stato non leggibile e' sempre
 * trattato come non verificato.
 */
import { spawnSync } from 'node:child_process';

import { resolveGithubIssue, searchSafePrefix } from '../lib/github-issue-creator.mjs';
import { pinnedBy } from './manifest-pinned-issues.mjs';

const REPO = process.env.GH_REPO || process.env.GITHUB_REPOSITORY || '';

/** Esegue `gh` conservando esplicitamente l'esito per chi deve verificarlo. */
export function runGh(args, { run = defaultRun, env } = {}) {
  const result = run(args, env);
  return {
    ok: result.status === 0,
    stdout: String(result.stdout || '').trim(),
    stderr: String(result.stderr || '').trim(),
  };
}

function defaultRun(args, env) {
  return spawnSync('gh', args, { encoding: 'utf8', env: env || process.env });
}

function repoArgs() {
  return REPO ? ['--repo', REPO] : [];
}

/**
 * Legge lo stato di un numero preciso. `null` significa «non osservabile», non
 * «chiuso».
 */
export function readIssueState(number, deps = {}) {
  const result = runGh(
    ['issue', 'view', String(number), '--json', 'state', ...repoArgs()],
    deps,
  );
  if (!result.ok) return null;

  let state = result.stdout;
  try {
    state = JSON.parse(result.stdout)?.state;
  } catch {
    // I test e alcune versioni di gh possono restituire il valore nudo.
  }
  state = String(state || '').toLowerCase();
  return state === 'open' || state === 'closed' ? state : null;
}

/**
 * Elenca tutte le issue aperte (non PR) il cui titolo inizia col prefisso usato
 * dal chiuditore condiviso. `null` indica una query non leggibile.
 */
export function findOpenByPrefix(prefix, deps = {}) {
  const result = runGh(
    [
      'api',
      '--paginate',
      `repos/${REPO}/issues?state=open&per_page=100`,
      '--jq',
      '.[] | select(.pull_request | not) | select(.title | startswith(env.RESOLVE_PREFIX)) | .number',
    ],
    {
      ...deps,
      env: { ...process.env, RESOLVE_PREFIX: prefix },
    },
  );
  if (!result.ok) return null;
  return result.stdout
    .split('\n')
    .map((line) => Number(line.trim()))
    .filter((number) => Number.isInteger(number) && number > 0);
}

function pinOf(number, deps) {
  return deps.pinnedBy ? deps.pinnedBy(number, REPO) : pinnedBy(number, REPO);
}

function closeNumber(number, comment, deps) {
  const args = ['issue', 'close', String(number)];
  if (comment) args.push('--comment', comment);
  args.push(...repoArgs());
  const result = runGh(args, deps);
  if (!result.ok && result.stderr) console.error(result.stderr);
}

function numberMode({ number, comment }, deps) {
  return {
    subject: `#${number}`,
    attempt: () => closeNumber(number, comment, deps),
    verify: () => {
      const state = readIssueState(number, deps);
      return {
        done: state === 'closed',
        detail: state === null ? 'stato non leggibile' : `stato=${state}`,
      };
    },
  };
}

function titleMode({ title, workflow, runUrl }, deps) {
  const prefix = searchSafePrefix(title);
  const close = deps.resolve || resolveGithubIssue;

  return {
    subject: `titolo "${prefix}"`,
    attempt: () => {
      const open = findOpenByPrefix(prefix, deps);
      // Non chiudere alla cieca se il preflight non e' osservabile: la verifica
      // successiva produrra' il rosso, oppure il retry potra' recuperare un 5xx.
      if (open === null) return;

      const unpinned = open.filter((number) => !pinOf(number, deps));
      if (unpinned.length === 0) return;
      if (open.length === unpinned.length) {
        close(title, { workflow, runUrl });
        return;
      }
      // `resolveGithubIssue` sceglierebbe il primo match, che potrebbe essere
      // il pin. In presenza di un pin chiudiamo solo i numeri dimostrati liberi.
      for (const number of unpinned) closeNumber(number, undefined, deps);
    },
    verify: () => {
      const open = findOpenByPrefix(prefix, deps);
      if (open === null) return { done: false, detail: 'query di verifica non leggibile' };
      const residual = open.filter((number) => !pinOf(number, deps));
      return {
        done: residual.length === 0,
        detail: `ancora aperte: ${residual.map((number) => `#${number}`).join(', ')}`,
      };
    },
  };
}

/**
 * Esegue al massimo due tentativi. La chiusura e' riuscita solo quando la
 * post-condizione osservata e' vera.
 */
export function resolveVerified(options, deps = {}) {
  if (options.number && pinOf(options.number, deps)) {
    console.log(`[resolve-verified] #${options.number} e' pinnata dal manifest: non la chiudo.`);
    return 0;
  }

  const mode = options.number ? numberMode(options, deps) : titleMode(options, deps);
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    mode.attempt();
    const result = mode.verify();
    if (result.done) {
      console.log(`[resolve-verified] ${mode.subject}: chiusura verificata (tentativo ${attempt}).`);
      return 0;
    }
    if (attempt === 1) {
      console.log(`[resolve-verified] ${mode.subject}: ${result.detail} — ritento una volta.`);
    } else {
      console.error(
        `::error::Chiusura NON verificata per ${mode.subject} (${result.detail}). ` +
        "Il close e' stato respinto o non e' osservabile: l'issue resta aperta.",
      );
    }
  }
  return 1;
}

function parseArgs(argv) {
  const value = (flag) => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  return {
    number: value('--number'),
    comment: value('--comment'),
    title: value('--title'),
    workflow: value('--workflow'),
    runUrl: value('--run-url'),
  };
}

if (process.argv[1]?.endsWith('resolve-issue-verified.mjs')) {
  const options = parseArgs(process.argv.slice(2));
  if (!options.number && !options.title) {
    console.error('::error::resolve-issue-verified: serve --number <n> oppure --title "..."');
    process.exit(1);
  }
  process.exit(resolveVerified(options));
}
