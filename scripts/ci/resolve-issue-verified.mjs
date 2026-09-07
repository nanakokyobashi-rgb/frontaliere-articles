#!/usr/bin/env node
/**
 * resolve-issue-verified.mjs — chiude un'issue canonica per TITOLO e poi
 * verifica che si sia davvero chiusa.
 *
 * ## Il difetto che chiude (issue #1005)
 *
 * `node scripts/lib/github-issue-creator.mjs --resolve` e' best-effort per
 * costruzione, in tre strati sovrapposti:
 *
 *   · `resolveGithubIssue` chiama `gh issue close` con `allowFailure: true`
 *     (`scripts/lib/github-issue-creator.mjs`), quindi un rifiuto —permessi,
 *     rate-limit, 5xx— torna `null` invece di lanciare;
 *   · il ramo `--resolve` della CLI fa `process.exit(0)` SEMPRE, quindi quel
 *     `null` non arriva mai allo shell;
 *   · `null` significa DUE cose opposte —«non c'era niente da chiudere» e «la
 *     chiusura e' stata respinta»— e nessuna delle due e' distinguibile
 *     dall'altra dal solo valore di ritorno.
 *
 * Il risultato e' la classe «non si rompe, non fa»: la run resta VERDE con una
 * riga su stderr, non c'e' ritentativo, e l'issue resta aperta con un elenco
 * ormai falso fino al prossimo run che ritrovi la stessa condizione — che puo'
 * non arrivare presto. Sul digest `needs-human` di `recycle-stale-prs.yml`
 * quell'issue e' l'unico canale che gli umani leggono.
 *
 * `github-issue-creator.mjs` NON e' il posto dove ripararlo: e' `identical` nel
 * manifest (una fix li' si fa sul SITO), ed e' comunque legittimo che una
 * libreria best-effort resti best-effort. Il posto giusto e' il CHIAMANTE, che
 * sa se la chiusura era un obbligo o un no-op — ed e' quello che fa questo
 * wrapper.
 *
 * ## Come lo verifica
 *
 * Non guardando l'exit code del chiuditore, ma la POST-CONDIZIONE:
 *
 *   1. prima del tentativo, elenca le issue APERTE con quel titolo ESATTO
 *      (REST autoritativa e paginata, non `search/issues`: l'indice di ricerca
 *      e' in ritardo di secondi e direbbe «ancora aperta» su una chiusura
 *      appena andata a buon fine);
 *   2. se non ce n'e' nessuna, non c'e' niente da chiudere → esce 0;
 *   3. altrimenti chiama `resolveGithubIssue` e RILEGGE lo stato di ogni
 *      candidata per numero;
 *   4. se qualcuna e' ancora aperta, ritenta UNA volta;
 *   5. se resta aperta anche dopo, emette `::error::` ed esce NON-ZERO.
 *
 * Uno stato non leggibile (query fallita) conta come «ancora aperta», non come
 * «chiusa»: e' la stessa asimmetria del guard sulle query dello step chiamante
 * — sconosciuto non e' vuoto.
 *
 * Anche la query PRE fallita e' un errore, non un «niente da chiudere»:
 * altrimenti il fallimento piu' probabile (token/rate-limit, che rompe query e
 * close insieme) tornerebbe a uscire 0 in silenzio, cioe' esattamente il
 * difetto che questo file esiste per rimuovere.
 *
 * ## Uso
 *
 *   node scripts/ci/resolve-issue-verified.mjs \
 *     --title "<titolo canonico>" [--workflow "<nome>"] [--run-url "<url>"]
 *
 * Il repo viene da `GH_REPO` o `GITHUB_REPOSITORY`. Exit 0 = l'issue non
 * esisteva o e' CHIUSA, verificato. Exit 1 = e' rimasta aperta.
 */
import { execFileSync } from 'node:child_process';

import { resolveGithubIssue } from '../lib/github-issue-creator.mjs';

/** Un solo ritentativo: il secondo `gh issue close` costa un commento in piu'. */
export const MAX_ATTEMPTS = 2;

function repoSlug() {
  return process.env.GH_REPO || process.env.GITHUB_REPOSITORY || '';
}

/** `gh` che torna `null` sul fallimento invece di lanciare. */
function gh(args) {
  try {
    return execFileSync('gh', args, {
      encoding: 'utf8',
      maxBuffer: 50 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'inherit'],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Le issue APERTE (non PR) con questo titolo ESATTO.
 *
 * `--paginate` e non `gh issue list --limit N`: quel sottocomando tronca in
 * silenzio, e una candidata tagliata via sarebbe un'issue che resta aperta
 * senza che nessuno lo dica — lo stesso difetto, un passo piu' in la'.
 *
 * @returns {Array<{number: number, title: string}>|null} `null` = query fallita
 *          (stato SCONOSCIUTO, che non e' «nessuna»).
 */
export function findOpenByExactTitle(title, run = gh, repo = repoSlug()) {
  const out = run([
    'api',
    '--paginate',
    `repos/${repo}/issues?state=open&per_page=100`,
    '--jq',
    '.[] | select(.pull_request | not) | "\\(.number)\\t\\(.title)"',
  ]);
  if (out === null) return null;
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const tab = line.indexOf('\t');
      return { number: Number(line.slice(0, tab)), title: line.slice(tab + 1) };
    })
    .filter((issue) => issue.title === title);
}

/**
 * Lo stato di UNA issue, letta per numero.
 *
 * Per numero e non per ricerca: e' l'endpoint autoritativo e non passa
 * dall'indice, che e' l'unico modo di non leggere «open» su una chiusura
 * appena andata a buon fine.
 *
 * @returns {'open'|'closed'|null} `null` = non leggibile.
 */
export function issueState(number, run = gh, repo = repoSlug()) {
  const out = run(['api', `repos/${repo}/issues/${number}`, '--jq', '.state']);
  return out === 'open' || out === 'closed' ? out : null;
}

/**
 * Il cuore, isolato dall'I/O per essere testabile: tenta la chiusura e
 * riverifica, fino a `MAX_ATTEMPTS`.
 *
 * @param {object} a
 * @param {Array<{number: number}>} a.candidates  le issue aperte da chiudere
 * @param {() => void} a.attemptClose             il tentativo di chiusura
 * @param {(n: number) => ('open'|'closed'|null)} a.readState
 * @returns {{closed: number[], stillOpen: number[], attempts: number}}
 */
export function closeAndVerify({ candidates, attemptClose, readState, maxAttempts = MAX_ATTEMPTS }) {
  // Una candidata per tentativo piu' un ritentativo: `resolveGithubIssue`
  // chiude UNA issue per chiamata (cerca da se' la prima con quel titolo),
  // quindi con N duplicati servono N passate perche' la post-condizione «zero
  // aperte con questo titolo» sia raggiungibile.
  const budget = candidates.length + maxAttempts - 1;
  let remaining = candidates.slice();
  const closed = [];
  let attempts = 0;
  while (remaining.length > 0 && attempts < budget) {
    attempts++;
    attemptClose();
    const stillOpen = [];
    for (const issue of remaining) {
      // Stato non leggibile → resta fra le «ancora aperte»: sconosciuto non e'
      // chiuso, ed e' l'asimmetria che tiene onesto tutto il resto.
      if (readState(issue.number) === 'closed') closed.push(issue.number);
      else stillOpen.push(issue);
    }
    remaining = stillOpen;
  }
  return { closed, stillOpen: remaining.map((i) => i.number), attempts };
}

function main() {
  const args = process.argv.slice(2);
  const get = (flag) => {
    const idx = args.indexOf(flag);
    return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
  };
  const title = get('--title');
  if (!title) {
    console.error('Usage: node resolve-issue-verified.mjs --title "..." [--workflow "..."] [--run-url "..."]');
    process.exit(1);
  }
  const workflow = get('--workflow');
  const runUrl = get('--run-url');
  const repo = repoSlug();

  const candidates = findOpenByExactTitle(title, gh, repo);
  if (candidates === null) {
    console.log(`::error::Impossibile elencare le issue aperte di ${repo || '(repo non impostato)'}: lo stato di «${title}» e' SCONOSCIUTO, non «gia' chiusa». Non dichiaro una chiusura che non ho potuto verificare.`);
    process.exit(1);
  }
  if (candidates.length === 0) {
    console.log(`[resolve-issue-verified] nessuna issue aperta con titolo «${title}» — niente da chiudere.`);
    process.exit(0);
  }

  const { closed, stillOpen, attempts } = closeAndVerify({
    candidates,
    attemptClose: () => resolveGithubIssue(title, { workflow, runUrl }),
    readState: (n) => issueState(n, gh, repo),
  });

  for (const n of closed) console.log(`[resolve-issue-verified] #${n} chiusa e verificata.`);
  if (stillOpen.length === 0) {
    if (attempts > 1) {
      console.log(`::warning::La chiusura di «${title}» ha richiesto ${attempts} tentativi: il primo e' stato respinto.`);
    }
    process.exit(0);
  }
  const list = stillOpen.map((n) => `#${n}`).join(', ');
  console.log(`::error::Chiusura respinta: ${list} (titolo «${title}») risulta ancora APERTA dopo ${attempts} tentativi. L'issue continuera' a mostrare un elenco ormai falso finche' qualcuno non la chiude: e' un guasto, non un no-op.`);
  process.exit(1);
}

if (process.argv[1]?.endsWith('resolve-issue-verified.mjs')) main();
