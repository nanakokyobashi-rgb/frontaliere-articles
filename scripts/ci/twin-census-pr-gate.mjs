#!/usr/bin/env node
/**
 * twin-census-pr-gate.mjs — il censimento dei gemelli, ristretto ai file che
 * la PR AGGIUNGE, eseguito sulla PR invece che al cron successivo (issue 1610).
 *
 * ## Il buco che chiude
 *
 * Il censimento di rete (`LOOP_TWIN_CENSUS=1` in
 * `generator/tests/loop-sync-manifest-scope.test.mjs`) cerca file di questo
 * repo byte-identici a un file del sito e non dichiarati nel manifest. Gira
 * solo sullo schedule di `loop-drift-check.yml`, e quel workflow sulle PR e'
 * per giunta path-scoped (`scripts/ci/**`, `scripts/lib/**`, workflow). Cosi'
 * la PR 2096 (`data/evergreen-verifications.json`) e la PR 2097 (il fixture
 * `generator/tests/fixtures/followup-mint/closed-bullets-10258-10289.json`,
 * copia del sito) sono passate verdi, e il rosso e' comparso su `main` giorni
 * dopo (run 37205308197), in una issue di workflow che nessuno dei due autori
 * stava guardando.
 *
 * La domanda «questo file nuovo e' un gemello?» ha una risposta nel momento in
 * cui il file entra: qui, nel check che governa il merge.
 *
 * ## Costo
 *
 * Zero rete per la PR che non aggiunge file, o che aggiunge solo file gia'
 * coperti dal manifest (`files`, `scope.roots`, `scope.outOfScope`): il caso
 * di gran lunga piu' frequente, per esempio le PR di contenuto sotto
 * `content/`. Altrimenti una chiamata `git/trees?recursive=1` al sito, con il
 * token del job; se GitHub segnala `truncated`, il gate rileggerebbe il tree
 * non ricorsivo un sotto-albero alla volta. Lo sha del blob dei file aggiunti
 * si legge dall'albero di HEAD (`git ls-tree`), che il checkout `blob:none` ha
 * sempre: niente download.
 *
 * ## Fail-closed
 *
 * Un tree del sito non leggibile, o una pagina della lettura paginata non
 * leggibile, non e' un «nessun gemello»: il gate esce 1 dicendo perche', come
 * il censimento dello schedule. Un `truncated` ricorsivo e' recuperabile solo
 * quando il tree root e tutte le sue pagine non ricorsive sono leggibili.
 *
 * Rimedio quando fallisce: registra il file in `scripts/ci/loop-sync-manifest.json`
 * (`identical` con `sitePath` e baseline dei due lati, oppure `adapted`), o
 * dichiaralo in `scope.outOfScope` con la ragione scritta.
 *
 * Env:
 *   BASE_SHA   base della PR (default `origin/main`).
 *   HEAD_SHA   head della PR (default `HEAD`).
 *   SITE_REPO  default `valerielinc-ops/frontaliere-si-o-no`.
 *   SITE_REF   default `main`, il ref di produzione del sito (come `SITE_REF` di
 *              `loop-drift-check.yml`).
 *   GH_TOKEN / GITHUB_TOKEN
 */

import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MANIFEST_REL = 'scripts/ci/loop-sync-manifest.json';

/**
 * La regola di copertura del manifest, UNICA per i due censimenti: quello
 * dello schedule (`loop-sync-manifest-scope.test.mjs`) la importa da qui, cosi'
 * il gate della PR e il cron non possono dare verdetti diversi sullo stesso
 * path.
 *
 * @returns {(rel: string) => boolean}
 */
export function coveredByManifest(manifest) {
  const byPath = new Set((manifest?.files || []).map((f) => f.path));
  const roots = (manifest?.scope?.roots || []).map((r) => r.path);
  const outOfScope = (manifest?.scope?.outOfScope || []).map((x) => x.prefix);
  return (rel) =>
    byPath.has(rel) ||
    roots.some((r) => rel.startsWith(`${r}/`)) ||
    outOfScope.some((x) => rel.startsWith(x));
}

/**
 * Il verdetto, PURO.
 *
 * @param {object} a
 * @param {Array<{path: string, sha: string}>} a.added  file aggiunti, con lo sha del blob git.
 * @param {Set<string>|null} a.siteShas  sha dei blob del sito; null = non ancora letti.
 * @param {object} a.manifest
 * @returns {{candidates: Array<{path: string, sha: string}>, undeclared: string[], needsSite: boolean}}
 */
export function twinCensusVerdict({ added, siteShas, manifest }) {
  const covered = coveredByManifest(manifest);
  const candidates = (added || []).filter((e) => !covered(e.path));
  if (!siteShas) return { candidates, undeclared: [], needsSite: candidates.length > 0 };
  const undeclared = candidates.filter((e) => siteShas.has(e.sha)).map((e) => e.path);
  return { candidates, undeclared, needsSite: false };
}

/**
 * I file AGGIUNTI fra la merge-base di `base` e `head`, con lo sha del blob
 * nell'albero di `head`. `--no-renames`: un file rinominato e' un path nuovo
 * quanto uno creato, e il manifest lo conosce per path.
 *
 * @returns {Array<{path: string, sha: string}>}
 */
export function addedFiles({ base, head, cwd = ROOT }) {
  const git = (args) =>
    execFileSync('git', ['-c', 'core.quotePath=false', ...args], { cwd, maxBuffer: 1 << 28 }).toString();
  const paths = git(['diff', '--no-renames', '--diff-filter=A', '--name-only', '-z', `${base}...${head}`])
    .split('\0')
    .filter(Boolean);
  if (paths.length === 0) return [];
  const sha = new Map();
  for (const record of git(['ls-tree', '-r', '-z', head, '--', ...paths]).split('\0')) {
    const tab = record.indexOf('\t');
    if (tab < 0) continue;
    const [, type, oid] = record.slice(0, tab).split(' ');
    if (type === 'blob') sha.set(record.slice(tab + 1), oid);
  }
  return paths.filter((p) => sha.has(p)).map((p) => ({ path: p, sha: sha.get(p) }));
}

const TREE_API = 'https://api.github.com/repos';

function treeUrl(repo, treeSha, recursive = false) {
  return `${TREE_API}/${repo}/git/trees/${treeSha}${recursive ? '?recursive=1' : ''}`;
}

function treeHeaders(token) {
  const headers = { 'User-Agent': 'twin-census-pr-gate', Accept: 'application/vnd.github+json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/** Legge una pagina tree con lo stesso retry conservativo del gate originario. */
async function fetchTreePage({ url, repo, treeSha, headers, fetchImpl, attempts, sleep }) {
  let lastError;
  const maxAttempts = Math.max(1, Number.isInteger(attempts) ? attempts : 3);
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (attempt > 1) await sleep(2000 * (attempt - 1));
    let res;
    try {
      res = await fetchImpl(url, { headers });
    } catch (error) {
      lastError = error; // rete: si ritenta.
      continue;
    }
    if (res.ok) {
      try {
        return await res.json();
      } catch (error) {
        throw new Error(`GET tree ${repo}@${treeSha} → JSON illeggibile: ${error?.message || error}`);
      }
    }
    lastError = new Error(`GET tree ${repo}@${treeSha} → HTTP ${res.status}`);
    // Un 4xx non migliora ritentando (permessi, ref inesistente); 429 e 5xx si'.
    if (res.status < 500 && res.status !== 429) throw lastError;
  }
  throw lastError || new Error(`GET tree ${repo}@${treeSha} → nessuna risposta leggibile`);
}

function readableTreeEntries(body, { repo, treeSha }) {
  // Un albero troncato darebbe un verdetto costruito su meta' dei dati.
  if (body?.truncated !== false) {
    throw new Error(`l'albero di ${repo}@${treeSha} e' troncato: il censimento non e' affidabile`);
  }
  // Un 200 senza `tree` e' una risposta che non si sa leggere, non un sito
  // senza file: un Set vuoto renderebbe pulito ogni candidato.
  if (!Array.isArray(body?.tree)) {
    throw new Error(`l'albero di ${repo}@${treeSha} non ha un campo \`tree\` leggibile`);
  }
  return body.tree;
}

function blobShasFromRecursiveTree(entries, { repo, treeSha }) {
  const shas = new Set();
  for (const entry of entries) {
    if (!entry || !['blob', 'tree', 'commit'].includes(entry.type)) {
      throw new Error(`l'albero di ${repo}@${treeSha} contiene una voce con tipo illeggibile`);
    }
    if (entry.type === 'tree') {
      if (typeof entry.sha !== 'string' || entry.sha.length === 0) {
        throw new Error(`l'albero di ${repo}@${treeSha} contiene un sotto-albero senza SHA leggibile`);
      }
      continue;
    }
    if (entry.type !== 'blob') continue;
    if (typeof entry.sha !== 'string' || entry.sha.length === 0) {
      throw new Error(`l'albero di ${repo}@${treeSha} contiene un blob senza SHA leggibile`);
    }
    shas.add(entry.sha);
  }
  return shas;
}

/**
 * Recupera tutti gli sha dei blob senza il limite dell'albero ricorsivo.
 *
 * GitHub non pagina `recursive=1`: quando quel payload e' `truncated`, la via
 * supportata e' leggere il root e ogni sotto-albero senza `recursive`, uno per
 * pagina. La coda evita la ricorsione JS e `seenTrees` impedisce richieste
 * duplicate se una risposta non valida riusa un tree SHA.
 */
export async function siteBlobShasPagination({ repo, ref, token, fetchImpl = fetch, attempts = 3, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const headers = treeHeaders(token);
  const pending = [ref];
  let nextTree = 0;
  const seenTrees = new Set();
  const shas = new Set();
  while (nextTree < pending.length) {
    const treeSha = pending[nextTree++];
    if (seenTrees.has(treeSha)) continue;
    seenTrees.add(treeSha);
    const body = await fetchTreePage({
      url: treeUrl(repo, treeSha),
      repo,
      treeSha,
      headers,
      fetchImpl,
      attempts,
      sleep,
    });
    const entries = readableTreeEntries(body, { repo, treeSha });
    for (const entry of entries) {
      if (!entry || !['blob', 'tree', 'commit'].includes(entry.type)) {
        throw new Error(`l'albero di ${repo}@${treeSha} contiene una voce con tipo illeggibile`);
      }
      if (entry.type === 'blob') {
        if (typeof entry.sha !== 'string' || entry.sha.length === 0) {
          throw new Error(`l'albero di ${repo}@${treeSha} contiene un blob senza SHA leggibile`);
        }
        shas.add(entry.sha);
      } else if (entry.type === 'tree') {
        if (typeof entry.sha !== 'string' || entry.sha.length === 0) {
          throw new Error(`l'albero di ${repo}@${treeSha} contiene un sotto-albero senza SHA leggibile`);
        }
        pending.push(entry.sha);
      }
    }
  }
  return shas;
}

/** Gli sha di tutti i blob del sito; recupera per sotto-alberi se il tree e' troncato. */
export async function siteBlobShas({ repo, ref, token, fetchImpl = fetch, attempts = 3, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const headers = treeHeaders(token);
  const body = await fetchTreePage({
    url: treeUrl(repo, ref, true),
    repo,
    treeSha: ref,
    headers,
    fetchImpl,
    attempts,
    sleep,
  });
  if (body?.truncated === true) {
    // Il tree SHA e' necessario per non mischiare due revisioni se il ref si
    // muove fra la risposta ricorsiva e il recupero paginato.
    if (typeof body.sha !== 'string' || body.sha.length === 0) {
      throw new Error(`l'albero di ${repo}@${ref} e' troncato e non espone uno SHA root recuperabile`);
    }
    return siteBlobShasPagination({
      repo,
      ref: body.sha,
      token,
      fetchImpl,
      attempts,
      sleep,
    });
  }
  return blobShasFromRecursiveTree(readableTreeEntries(body, { repo, treeSha: ref }), { repo, treeSha: ref });
}

/**
 * La head da misurare deve essere un commit LOCALE. In un dispatch di recovery
 * (`inputs.head_sha`) il checkout resta sul ref del dispatch, e la head di una
 * PR da fork non e' fra i branch scaricati: si chiede quella SHA a `origin`
 * (GitHub serve i commit raggiungibili, anche da `refs/pull/*`). Se non arriva
 * il gate resta rosso: niente verdetto su una head che non si e' letta.
 */
export function ensureLocalCommit(head, { cwd = ROOT } = {}) {
  const has = () => {
    try {
      execFileSync('git', ['cat-file', '-e', `${head}^{commit}`], { cwd, stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  };
  if (has()) return;
  try {
    execFileSync('git', ['fetch', '--no-tags', '--filter=blob:none', 'origin', head], { cwd, stdio: ['ignore', 'ignore', 'inherit'] });
  } catch {
    // il verdetto sotto lo dice meglio di un errore di fetch.
  }
  if (!has()) throw new Error(`la head ${head} non e' un commit leggibile in questo checkout`);
}

/**
 * Il manifest della HEAD misurata, non quello del checkout: in un dispatch di
 * recovery il checkout puo' essere il branch base, e combinare i file aggiunti
 * dalla PR col manifest di un altro albero darebbe un verdetto su nessuna delle
 * due revisioni.
 */
export function manifestAt(head, { cwd = ROOT } = {}) {
  return JSON.parse(execFileSync('git', ['show', `${head}:${MANIFEST_REL}`], { cwd, maxBuffer: 1 << 28 }).toString());
}

async function main() {
  const base = process.env.BASE_SHA || process.env.BASE_REF || 'origin/main';
  const head = process.env.HEAD_SHA || 'HEAD';
  ensureLocalCommit(head);
  const manifest = manifestAt(head);
  const added = addedFiles({ base, head });
  let verdict = twinCensusVerdict({ added, siteShas: null, manifest });
  if (!verdict.needsSite) {
    console.log(
      `Censimento dei gemelli aggiunti: ${added.length} file aggiunti, nessuno fuori dal manifest — nessuna lettura del sito.`,
    );
    return;
  }
  let siteShas;
  try {
    siteShas = await siteBlobShas({
      repo: process.env.SITE_REPO || 'valerielinc-ops/frontaliere-si-o-no',
      ref: process.env.SITE_REF || 'main',
      token: process.env.GH_TOKEN || process.env.GITHUB_TOKEN,
    });
  } catch (error) {
    console.error(
      `❌ Censimento dei gemelli aggiunti non concluso: ${error?.message || error}. ` +
        `${verdict.candidates.length} file aggiunti fuori dal manifest restano da verificare; nessun verde senza l'albero del sito.`,
    );
    process.exit(1);
  }
  verdict = twinCensusVerdict({ added, siteShas, manifest });
  if (verdict.undeclared.length === 0) {
    console.log(
      `Censimento dei gemelli aggiunti: ${verdict.candidates.length} file aggiunti fuori dal manifest, nessuno byte-identico a un file del sito.`,
    );
    return;
  }
  console.error(
    `❌ ${verdict.undeclared.length} file aggiunti da questa PR sono byte-identici a un file del sito e non sono ` +
      "ne' registrati, ne' sotto un albero censito, ne' dichiarati fuori scope. Ognuno e' un canale di " +
      `discesa che nessuno sorveglia:\n  ${verdict.undeclared.join('\n  ')}\n` +
      `Rimedio: registralo in ${MANIFEST_REL} (\`identical\` con \`sitePath\` e baseline dei due lati, ` +
      "oppure `adapted`), o dichiaralo in `scope.outOfScope` con la ragione scritta.",
  );
  process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`❌ twin-census-pr-gate: ${error?.stack || error}`);
    process.exit(1);
  });
}
