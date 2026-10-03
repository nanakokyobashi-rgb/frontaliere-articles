#!/usr/bin/env node
/**
 * realign-adapted-baseline.mjs — riallinea da solo la baseline di un gemello
 * `adapted` quando la meta' del sito dichiarata e' mergiata (issue #1997).
 *
 * ## Il buco che chiude
 *
 * Per i gemelli `identical` il riallineamento dopo il merge e' automatico
 * (`transport-identical-twins-realign.yml`). Per gli `adapted` esisteva solo il
 * comando manuale `loop-drift-check.mjs --init --only <path>`: ogni PR del sito
 * che toccava un gemello adattato lasciava un bullet «re-baseline nel manifest
 * — blocked: serve l'hash del sito dopo il merge», qualcuno lo eseguiva a mano
 * e alla PR successiva la baseline era di nuovo scaduta.
 *
 * ## La dichiarazione vive nel body della PR, non nel manifest
 *
 * La PR del corpus che porta la meta' adattata scrive nel proprio body, una
 * riga per file (a inizio riga, anche come bullet, path anche fra backtick):
 *
 *   Realign-adapted: <path> site-prs=#N[,#M…]
 *
 * `<path>` e' il `path` della voce del manifest; i numeri sono le PR del SITO
 * di cui quella PR porta l'adattamento. Nessuna PR deve toccare il JSON del
 * manifest per dichiarare un riallineamento. Una riga che comincia con
 * `Realign-adapted:` ma non rispetta la forma viene ignorata con un warning.
 * Piu' PR del corpus che dichiarano lo stesso path nella finestra si sommano:
 * l'elenco delle PR del sito e' l'unione, la prova sul corpus e' quella della
 * dichiarante piu' recente.
 *
 * ## Le tre prove (tutte, o nessuna scrittura)
 *
 *   1. ogni PR del sito dichiarata e' mergiata su `main`;
 *   2. TUTTI i commit del sito che toccano il file dopo la baseline registrata
 *      appartengono a PR dichiarate. La storia si legge dal piu' recente fino
 *      al commit il cui contenuto ha l'hash di `baseline.site`, per al massimo
 *      `REALIGN_SITE_HISTORY_CAP` commit: oltre il tetto, o senza ritrovare la
 *      baseline, non si scrive. La forma a ELENCO serve alle catene (piu' PR
 *      del sito sullo stesso file fra una baseline e l'altra);
 *   3. il file del corpus su `main` ha ancora l'hash che aveva al merge della
 *      PR dichiarante: nessuno l'ha mosso dopo.
 *
 * Se una prova cade la voce resta in drift per una persona, col motivo
 * stampato. Con tutte vere si esegue il percorso ESISTENTE
 * `loop-drift-check.mjs --init --only <path> --force` come processo figlio:
 * lettura dal `main` del sito e attestazione contro l'albero restano le sue,
 * non sono duplicate qui. `--force` e' giustificato dalle tre prove: e'
 * l'affermazione «questo drift lo sto chiudendo io», resa verificabile.
 *
 * Dopo il figlio si rilegge il manifest: la baseline scritta deve essere
 * ESATTAMENTE la coppia di hash su cui le prove sono state valutate. Se il sito
 * si e' mosso fra la valutazione e la scrittura, la voce torna com'era.
 *
 * ## PR del sito SENZA meta' corpus
 *
 * Una modifica al gemello del sito che non richiede nulla qui non ha una PR del
 * corpus in cui dichiararsi. Chi la mergia lancia:
 *
 *   gh workflow run transport-identical-twins-realign.yml -f paths=<path> -f site_prs=<N>
 *
 * Le tre prove valgono uguali; la terza diventa «il file del corpus ha ancora
 * l'hash di `baseline.corpus`».
 *
 * ## Cosa NON fa
 *
 * Non riallinea il drift GIA' esistente e non dichiarato: quello richiede la
 * lettura della diff file per file. Non allenta `--init` (la lettura resta dal
 * `main` del sito, issue #148). Non apre PR e non tocca altro che il manifest.
 *
 * Uso:
 *   node scripts/ci/realign-adapted-baseline.mjs                 # PR del corpus mergiate nella finestra
 *   node scripts/ci/realign-adapted-baseline.mjs --dry-run       # decide e stampa, non scrive
 *   node scripts/ci/realign-adapted-baseline.mjs --paths=<a>[,<b>] --site-prs=<N>[,<M>]
 *
 * Exit: 0 anche con voci trattenute (e' l'esito previsto); 1 se una lettura e'
 * fallita o l'elenco delle PR e' incompleto; 2 per un errore d'uso.
 *
 * Env:
 *   GH_TOKEN                   token per le API GitHub (PR del corpus, storia del sito)
 *   GITHUB_REPOSITORY          default `nanakokyobashi-rgb/frontaliere-articles`
 *   SITE_REPO                  default `valerielinc-ops/frontaliere-si-o-no`
 *   REALIGN_SITE_HISTORY_CAP   default 30: commit del sito letti per file
 *   REALIGN_WINDOW_DAYS        default 14: finestra delle PR dichiaranti
 *   REALIGN_STALE_DAYS         default 7: eta' oltre cui una dichiarazione trattenuta e' un warning
 *   GITHUB_STEP_SUMMARY        se presente, riceve il riepilogo
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRawFetcher } from '../lib/cross-repo-raw-fetch.mjs';
import { parsePositiveNum } from '../lib/parse-positive-num.mjs';
import { sha256, siteFile } from './loop-drift-check.mjs';
import { MANIFEST_PATH } from './transport-realign-body.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TOOL = 'realign-adapted-baseline';
const SITE_MAIN = 'main';
const DAY_MS = 24 * 60 * 60 * 1000;

/** Titolo dell'allarme quando una dichiarazione resta trattenuta troppo a lungo. */
export const STALE_DECLARATION_TITLE = 'Mirror: gemello `adapted` con riallineamento dichiarato e mai avvenuto';

/** Una riga che VUOLE essere una dichiarazione (anche se poi e' malformata). */
const DECLARATION_PREFIX_RE = /^\s*(?:[-*]\s+)?Realign-adapted:/;
/** Gruppo 2: path del manifest; gruppo 3: elenco `#N,#M` delle PR del sito. */
const DECLARATION_RE = /^\s*(?:[-*]\s+)?Realign-adapted:\s+(`?)([^\s`]+)\1\s+site-prs=(#\d+(?:,#\d+)*)\s*$/;

/** Riga di dichiarazione per un path: la forma che `parseRealignDeclarations` rilegge. */
export function realignDeclarationLine({ path: filePath, sitePrs }) {
  return `Realign-adapted: ${filePath} site-prs=${sitePrs.map((n) => `#${n}`).join(',')}`;
}

/**
 * Le dichiarazioni di un body. Una riga col prefisso giusto ma la forma
 * sbagliata finisce in `malformed`: ignorata, mai interpretata a meta'.
 * @returns {{ declarations: {path: string, sitePrs: number[]}[], malformed: string[] }}
 */
export function parseRealignDeclarations(body) {
  const declarations = [];
  const malformed = [];
  for (const line of String(body || '').split(/\r?\n/)) {
    if (!DECLARATION_PREFIX_RE.test(line)) continue;
    const match = DECLARATION_RE.exec(line);
    if (!match) {
      malformed.push(line.trim());
      continue;
    }
    const sitePrs = [...new Set(match[3].split(',').map((token) => Number(token.slice(1))))];
    declarations.push({ path: match[2], sitePrs });
  }
  return { declarations, malformed };
}

/**
 * Somma le dichiarazioni delle PR del corpus per path. `sources` e' ordinato
 * dalla dichiarante piu' recente: e' lei a fissare l'hash atteso del corpus.
 * @param {{number: number, mergedAt: string, mergeCommitSha: string, body: string}[]} prs
 */
export function collectDeclarations(prs) {
  const byPath = new Map();
  const malformed = [];
  for (const pr of prs) {
    const parsed = parseRealignDeclarations(pr.body);
    for (const line of parsed.malformed) malformed.push({ pr: pr.number, line });
    for (const declaration of parsed.declarations) {
      const merged = byPath.get(declaration.path) || { path: declaration.path, sitePrs: [], sources: [] };
      merged.sitePrs = [...new Set([...merged.sitePrs, ...declaration.sitePrs])].sort((a, b) => a - b);
      if (!merged.sources.some((source) => source.number === pr.number)) {
        merged.sources.push({ kind: 'pr', number: pr.number, mergedAt: pr.mergedAt, mergeCommitSha: pr.mergeCommitSha });
      }
      byPath.set(declaration.path, merged);
    }
  }
  for (const merged of byPath.values()) {
    merged.sources.sort((a, b) => Date.parse(b.mergedAt) - Date.parse(a.mergedAt));
  }
  return { declarations: [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path)), malformed };
}

const hold = (status, reason) => ({ realign: false, held: true, status, reason });

/** Rifiuti che dipendono solo dalla voce e dalla dichiarazione: nessuna rete. */
function entryHold(entry, declaration) {
  if (!entry) return hold('unknown-path', 'il path dichiarato non e\' una voce del manifest');
  if (entry.mode !== 'adapted') {
    return hold('not-adapted', `la voce e' \`${entry.mode}\`: questo percorso riallinea solo i gemelli \`adapted\``);
  }
  if (!entry.baseline?.site || !entry.baseline?.corpus) {
    return hold('no-baseline', 'la voce non ha una baseline completa da cui misurare cosa si e\' mosso');
  }
  if (!declaration.sitePrs.length) return hold('no-site-prs', 'nessuna PR del sito dichiarata');
  return null;
}

/** Prova 1: ogni PR del sito dichiarata e' mergiata su `main`. */
function sitePrHold(declaration, sitePrs) {
  const byNumber = new Map((sitePrs || []).map((pr) => [pr.number, pr]));
  const notMerged = declaration.sitePrs.filter((number) => {
    const pr = byNumber.get(number);
    return !(pr && pr.merged === true && pr.baseRef === SITE_MAIN);
  });
  if (!notMerged.length) return null;
  return hold('site-pr-not-merged', `PR del sito non mergiate su \`${SITE_MAIN}\`: ${notMerged.map((n) => `#${n}`).join(', ')}`);
}

/**
 * La decisione, PURA: prende i fatti gia' raccolti e non fa rete.
 *
 * @param {object} a
 * @param {object|null} a.entry        voce del manifest per il path dichiarato.
 * @param {{path: string, sitePrs: number[]}} a.declaration
 * @param {{number: number, merged: boolean, baseRef: string|null}[]} a.sitePrs
 *        stato letto per ogni PR del sito dichiarata.
 * @param {object} a.siteCommits
 *        `commits`: i commit del sito che toccano il file DOPO la baseline, dal
 *        piu' recente, ciascuno con `prs` (numeri delle PR mergiate su `main`
 *        a cui appartiene); `baselineFound`: la storia letta arriva al commit
 *        con l'hash di `baseline.site`; `headHash`: hash del file al commit
 *        piu' recente; `cap`: tetto di commit letti.
 * @param {string|null} a.corpusHashAtMerge hash del file del corpus al merge
 *        della dichiarante (o `baseline.corpus` senza meta' corpus).
 * @param {string|null} a.corpusHashNow     hash del file del corpus su `main`.
 * @returns {{realign: boolean, held: boolean, status: string, reason: string, expected?: {site: string, corpus: string}}}
 */
export function realignDecision({ entry, declaration, sitePrs, siteCommits, corpusHashAtMerge, corpusHashNow }) {
  const early = entryHold(entry, declaration) || sitePrHold(declaration, sitePrs);
  if (early) return early;
  const baseline = entry.baseline;

  if (!siteCommits.baselineFound) {
    return hold(
      'site-history-unresolved',
      `la baseline del sito \`${baseline.site}\` non e' stata ritrovata negli ultimi ${siteCommits.cap} commit del file: ` +
        'non si puo\' dire quali commit sono venuti dopo',
    );
  }
  if (!siteCommits.headHash) return hold('site-file-missing', 'il file non e\' leggibile sul `main` del sito');

  if (!siteCommits.commits.length) {
    if (corpusHashNow === baseline.corpus) {
      return { realign: false, held: false, status: 'already-aligned', reason: 'baseline gia\' allineata ai due lati' };
    }
    return hold(
      'site-not-moved',
      'il sito non ha toccato il file dopo la baseline: le PR dichiarate non lo hanno modificato, riallineare seppellirebbe una modifica del solo corpus',
    );
  }

  const declared = new Set(declaration.sitePrs);
  const uncovered = siteCommits.commits.filter((commit) => !(commit.prs || []).some((number) => declared.has(number)));
  if (uncovered.length) {
    return hold(
      'site-commit-uncovered',
      `commit del sito sul file non coperti da PR dichiarate: ${uncovered.map((commit) => String(commit.sha).slice(0, 12)).join(', ')}`,
    );
  }

  if (!corpusHashAtMerge || !corpusHashNow) {
    return hold('corpus-hash-unknown', 'l\'hash del file del corpus al merge della dichiarante o su `main` non e\' leggibile');
  }
  if (corpusHashNow !== corpusHashAtMerge) {
    return hold(
      'corpus-moved',
      `il file del corpus si e' mosso dopo la dichiarazione (\`${corpusHashAtMerge}\` → \`${corpusHashNow}\`)`,
    );
  }

  return {
    realign: true,
    held: false,
    status: 'realign',
    reason: `${siteCommits.commits.length} commit del sito, tutti di PR dichiarate; corpus fermo a \`${corpusHashNow}\``,
    expected: { site: siteCommits.headHash, corpus: corpusHashNow },
  };
}

/**
 * La baseline e' stata riscritta DOPO la dichiarazione? Allora la dichiarazione
 * e' gia' stata onorata (o superata da un allineamento a mano): se la voce e'
 * di nuovo in drift e' un drift NUOVO, non un riallineamento mai avvenuto.
 */
export function baselineNewerThanDeclaration(entry, mergedAt) {
  const mergedMs = Date.parse(mergedAt || '');
  if (!Number.isFinite(mergedMs)) return false;
  const baseline = entry?.baseline || {};
  const forcedMs = Date.parse(baseline.forcedAt || '');
  if (Number.isFinite(forcedMs) && forcedMs > mergedMs) return true;
  // `alignedAt` ha la granularita' del giorno: vale solo se il giorno e' dopo.
  return typeof baseline.alignedAt === 'string' && baseline.alignedAt > new Date(mergedMs).toISOString().slice(0, 10);
}

/** Una dichiarazione trattenuta da piu' di `staleDays` e mai onorata. */
export function isStaleDeclaration({ decision, entry, source, nowMs, staleDays }) {
  if (!decision.held || source?.kind !== 'pr') return false;
  const mergedMs = Date.parse(source.mergedAt || '');
  if (!Number.isFinite(mergedMs) || nowMs - mergedMs <= staleDays * DAY_MS) return false;
  return !baselineNewerThanDeclaration(entry, source.mergedAt);
}

/**
 * Dopo `--init --only --force`: la baseline scritta e' la coppia su cui le
 * prove sono state valutate? Se no la voce va riportata com'era.
 */
export function verifyInitResult({ before, after, expected }) {
  const was = before?.baseline || {};
  const now = after?.baseline || {};
  if (now.site === was.site && now.corpus === was.corpus && now.alignedAt === was.alignedAt && now.forcedAt === was.forcedAt) {
    return { ok: false, revert: false, status: 'init-refused', reason: '`--init` non ha riscritto la voce (attestazione o lettura rifiutata: vedi il log qui sopra)' };
  }
  if (now.site !== expected.site || now.corpus !== expected.corpus) {
    return {
      ok: false,
      revert: true,
      status: 'moved-during-init',
      reason: `un lato si e' mosso fra la valutazione e la scrittura (atteso sito \`${expected.site}\` corpus \`${expected.corpus}\`, letto sito \`${now.site}\` corpus \`${now.corpus}\`)`,
    };
  }
  return { ok: true, revert: false, status: 'realigned', reason: '' };
}

/** Raccoglie la storia del sito per un file, fermandosi alla baseline. */
export async function gatherSiteCommits({ sitePath, baselineSite, cap, io }) {
  const history = await io.siteHistory(sitePath, cap);
  const after = [];
  let headHash = null;
  let baselineFound = false;
  for (let index = 0; index < history.length; index += 1) {
    const hash = await io.siteHashAt(sitePath, history[index].sha);
    if (index === 0) headHash = hash;
    if (hash !== null && hash === baselineSite) {
      baselineFound = true;
      break;
    }
    after.push({ sha: history[index].sha, hash });
  }
  if (!baselineFound) return { commits: after, baselineFound, headHash, cap };
  const commits = [];
  for (const commit of after) commits.push({ ...commit, prs: await io.commitPrs(commit.sha) });
  return { commits, baselineFound, headHash, cap };
}

/** Valuta una dichiarazione: raccoglie i fatti con `io` e li passa a `realignDecision`. */
export async function evaluateDeclaration({ entry, declaration, io, cap }) {
  // Le voci che nessun fatto di rete puo' salvare non pagano una richiesta.
  const refused = entryHold(entry, declaration);
  if (refused) return refused;
  const sitePrs = [];
  for (const number of declaration.sitePrs) sitePrs.push(await io.sitePr(number));
  const pending = sitePrHold(declaration, sitePrs);
  if (pending) return pending;

  const siteCommits = await gatherSiteCommits({
    sitePath: entry.sitePath || entry.path,
    baselineSite: entry.baseline.site,
    cap,
    io,
  });
  const source = declaration.sources?.[0] || { kind: 'dispatch' };
  const corpusHashAtMerge = source.kind === 'pr'
    ? io.corpusHashAt(source.mergeCommitSha, entry.path)
    : entry.baseline.corpus;
  const corpusHashNow = io.corpusHashAt('HEAD', entry.path);
  return realignDecision({ entry, declaration, sitePrs, siteCommits, corpusHashAtMerge, corpusHashNow });
}

// ───────────────────────────── I/O ─────────────────────────────

function createIo({ siteRepo, api }) {
  const getJson = async (url) => {
    const res = await api(url, { Accept: 'application/vnd.github+json' });
    if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`);
    return res.json();
  };
  return {
    async sitePr(number) {
      const res = await api(`https://api.github.com/repos/${siteRepo}/pulls/${number}`, { Accept: 'application/vnd.github+json' });
      if (res.status === 404) return { number, merged: false, baseRef: null };
      if (!res.ok) throw new Error(`GET pulls/${number} del sito → HTTP ${res.status}`);
      const pr = await res.json();
      return { number, merged: pr.merged === true, baseRef: pr.base?.ref || null };
    },
    async siteHistory(sitePath, cap) {
      const commits = await getJson(
        `https://api.github.com/repos/${siteRepo}/commits?path=${encodeURIComponent(sitePath)}&sha=${SITE_MAIN}&per_page=${Math.min(cap, 100)}`,
      );
      return commits.slice(0, cap).map((commit) => ({ sha: commit.sha }));
    },
    async siteHashAt(sitePath, sha) {
      const bytes = await siteFile(sitePath, sha);
      return bytes === null ? null : sha256(bytes);
    },
    async commitPrs(sha) {
      const pulls = await getJson(`https://api.github.com/repos/${siteRepo}/commits/${sha}/pulls?per_page=100`);
      return pulls.filter((pr) => pr.merged_at && pr.base?.ref === SITE_MAIN).map((pr) => pr.number);
    },
    corpusHashAt(ref, rel) {
      try {
        return sha256(execFileSync('git', ['show', `${ref}:${rel}`], { cwd: ROOT, maxBuffer: 10 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }));
      } catch {
        return null;
      }
    },
  };
}

/** PR del corpus mergiate su `main` nella finestra, con una riga di dichiarazione. */
async function listDeclaringPrs({ repo, sinceMs, api, maxPages = 10 }) {
  const prs = [];
  let truncated = true;
  for (let page = 1; page <= maxPages; page += 1) {
    const res = await api(
      `https://api.github.com/repos/${repo}/pulls?state=closed&base=main&sort=updated&direction=desc&per_page=100&page=${page}`,
      { Accept: 'application/vnd.github+json' },
    );
    if (!res.ok) throw new Error(`GET pulls del corpus (pagina ${page}) → HTTP ${res.status}`);
    const batch = await res.json();
    for (const pr of batch) {
      if (!pr.merged_at || Date.parse(pr.merged_at) < sinceMs) continue;
      if (!String(pr.body || '').split(/\r?\n/).some((line) => DECLARATION_PREFIX_RE.test(line))) continue;
      prs.push({ number: pr.number, mergedAt: pr.merged_at, mergeCommitSha: pr.merge_commit_sha, body: pr.body });
    }
    const last = batch[batch.length - 1];
    if (batch.length < 100 || (last && Date.parse(last.updated_at) < sinceMs)) {
      truncated = false;
      break;
    }
  }
  return { prs, truncated };
}

function argValue(argv, name) {
  const prefix = `--${name}=`;
  const hit = argv.find((arg) => arg.startsWith(prefix));
  return hit === undefined ? null : hit.slice(prefix.length);
}

const splitList = (value) => String(value || '').split(',').map((item) => item.trim()).filter(Boolean);

function readManifest() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, MANIFEST_PATH), 'utf8'));
}

async function main(argv) {
  const dryRun = argv.includes('--dry-run');
  const paths = splitList(argValue(argv, 'paths'));
  const sitePrTokens = splitList(argValue(argv, 'site-prs'));
  if (Boolean(paths.length) !== Boolean(sitePrTokens.length)) {
    console.error('`--paths` e `--site-prs` vanno dati insieme: un path senza PR del sito non ha prove da verificare, e viceversa.');
    return 2;
  }
  const dispatchSitePrs = sitePrTokens.map((token) => Number(token.replace(/^#/, '')));
  if (dispatchSitePrs.some((number) => !Number.isInteger(number) || number <= 0)) {
    console.error(`\`--site-prs\` accetta solo numeri di PR: ${sitePrTokens.join(',')}`);
    return 2;
  }
  const cap = parsePositiveNum(process.env.REALIGN_SITE_HISTORY_CAP, 30, { label: 'REALIGN_SITE_HISTORY_CAP', tool: TOOL, integer: true });
  const windowDays = parsePositiveNum(process.env.REALIGN_WINDOW_DAYS, 14, { label: 'REALIGN_WINDOW_DAYS', tool: TOOL });
  const staleDays = parsePositiveNum(process.env.REALIGN_STALE_DAYS, 7, { label: 'REALIGN_STALE_DAYS', tool: TOOL });
  const corpusRepo = process.env.GITHUB_REPOSITORY || 'nanakokyobashi-rgb/frontaliere-articles';
  const siteRepo = process.env.SITE_REPO || 'valerielinc-ops/frontaliere-si-o-no';
  const api = createRawFetcher({ userAgent: TOOL, token: process.env.GH_TOKEN });
  const io = createIo({ siteRepo, api });
  const nowMs = Date.now();
  let failed = false;

  let declarations;
  let malformed = [];
  if (paths.length) {
    declarations = [...new Set(paths)].map((rel) => ({ path: rel, sitePrs: [...new Set(dispatchSitePrs)], sources: [{ kind: 'dispatch' }] }));
  } else {
    const listed = await listDeclaringPrs({ repo: corpusRepo, sinceMs: nowMs - windowDays * DAY_MS, api });
    if (listed.truncated) {
      failed = true;
      console.log(`::warning::${TOOL}: l'elenco delle PR del corpus e' stato troncato prima di coprire ${windowDays} giorni: alcune dichiarazioni possono non essere state lette.`);
    }
    ({ declarations, malformed } = collectDeclarations(listed.prs));
  }
  for (const item of malformed) {
    console.log(`::warning::${TOOL}: riga \`Realign-adapted:\` malformata nella PR #${item.pr}, ignorata: ${item.line}`);
  }

  const manifestBytes = fs.readFileSync(path.join(ROOT, MANIFEST_PATH));
  const before = JSON.parse(manifestBytes.toString('utf8'));
  const entryOf = (manifest, rel) => manifest.files.find((entry) => entry.path === rel) || null;
  const rows = [];
  for (const declaration of declarations) {
    const entry = entryOf(before, declaration.path);
    let decision;
    try {
      decision = await evaluateDeclaration({ entry, declaration, io, cap });
    } catch (error) {
      failed = true;
      decision = hold('lookup-failed', `lettura fallita: ${String(error?.message || error).slice(0, 160)}`);
    }
    rows.push({ declaration, entry, decision });
  }

  const toInit = rows.filter((row) => row.decision.realign);
  if (toInit.length && !dryRun) {
    const child = spawnSync(
      process.execPath,
      ['scripts/ci/loop-drift-check.mjs', '--init', '--only', toInit.map((row) => row.declaration.path).join(','), '--force'],
      { cwd: ROOT, stdio: 'inherit' },
    );
    if (child.error) throw child.error;
    const after = readManifest();
    let reverted = false;
    for (const row of toInit) {
      const afterEntry = entryOf(after, row.declaration.path);
      const verdict = verifyInitResult({ before: row.entry, after: afterEntry || row.entry, expected: row.decision.expected });
      if (verdict.ok) {
        row.decision = { ...row.decision, status: 'realigned' };
        continue;
      }
      if (verdict.revert) {
        afterEntry.baseline = row.entry.baseline;
        reverted = true;
      }
      row.decision = hold(verdict.status, verdict.reason);
    }
    if (!rows.some((row) => row.decision.status === 'realigned')) {
      // Nessuna voce certificata: il manifest torna byte per byte com'era.
      fs.writeFileSync(path.join(ROOT, MANIFEST_PATH), manifestBytes);
    } else if (reverted) {
      fs.writeFileSync(path.join(ROOT, MANIFEST_PATH), `${JSON.stringify(after, null, 2)}\n`);
    }
  }

  const describe = (row) => {
    const source = row.declaration.sources[0];
    const origin = source.kind === 'pr' ? `PR #${source.number} del ${String(source.mergedAt).slice(0, 10)}` : 'dispatch manuale';
    return `\`${row.declaration.path}\` (${origin}; sito ${row.declaration.sitePrs.map((n) => `#${n}`).join(', ')})`;
  };
  const realigned = rows.filter((row) => row.decision.status === 'realigned' || row.decision.status === 'realign');
  const held = rows.filter((row) => row.decision.held);
  const settled = rows.filter((row) => row.decision.status === 'already-aligned');
  const stale = held.filter((row) => isStaleDeclaration({ decision: row.decision, entry: row.entry, source: row.declaration.sources[0], nowMs, staleDays }));
  const lines = [
    `## Riallineamento baseline \`adapted\`${dryRun ? ' (dry-run: nessuna scrittura)' : ''}`,
    '',
    `Dichiarazioni lette: ${rows.length}. Riallineate: ${realigned.length}. Trattenute: ${held.length}. Gia' allineate: ${settled.length}.`,
    '',
    ...(realigned.length ? [dryRun ? '### Da riallineare' : '### Riallineate', ...realigned.map((row) => `- ${describe(row)} — ${row.decision.reason}`), ''] : []),
    ...(held.length ? ['### Trattenute (restano in drift per una persona)', ...held.map((row) => `- ${describe(row)} — \`${row.decision.status}\`: ${row.decision.reason}`), ''] : []),
    ...(stale.length ? [`### Dichiarate da piu' di ${staleDays} giorni e mai riallineate`, ...stale.map((row) => `- ${describe(row)}`), ''] : []),
    ...(malformed.length ? ['### Righe malformate, ignorate', ...malformed.map((item) => `- PR #${item.pr}: \`${item.line.replace(/`/g, "'")}\``), ''] : []),
  ];
  const summary = lines.join('\n');
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  for (const row of stale) {
    console.log(`::warning title=${STALE_DECLARATION_TITLE}::${row.declaration.path} — ${row.decision.status}: ${row.decision.reason}`);
  }
  return failed ? 1 : 0;
}

const isDirectRun = (() => {
  try {
    return path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(`${TOOL} fallito: ${error && error.stack ? error.stack : error}`);
      process.exit(1);
    },
  );
}
